// เส้นทาง: สำรอง & กู้คืนข้อมูล (backup-database, backup-kpi-data, clear-kpi-data, /backup/*)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const crypto = require('crypto');
const db = require('../db');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { BACKUP_DIR, MYSQLDUMP_BIN, MYSQL_BIN, bangkokTimestamp, bkEncrypt, buildConnectArgs, cleanStderr, deleteFileFromDrive, getBackupConnection, getDriveSettings, isValidIdent, notifyBackupResult, resetDriveClientCache, runBackupJob, runRestoreJob, runScheduledBackup, testDriveConnection, uploadFileToDrive, verifyBackupPrivileges } = require('../services/backup');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { google } = require('googleapis');
const { port } = require('../core/env');
const { spawn } = require('child_process');

// === Database Backup (super_admin เท่านั้น) ===
apiRouter.get('/backup-database', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const tables = [
            'users', 'departments', 'kpi_indicators', 'kpi_main_indicators', 'main_yut',
            'kpi_results', 'chospital', 'co_district', 'system_settings', 'notifications',
            'kpi_rejection_comments', 'kpi_form_schemas', 'kpi_form_fields',
            'target_edit_requests', 'login_logs', 'system_logs'
        ];
        const backup = {};
        for (const table of tables) {
            try {
                const [rows] = await db.query(`SELECT * FROM \`${table}\``);
                backup[table] = { count: rows.length, data: rows };
            } catch (e) { backup[table] = { count: 0, data: [], error: e.message }; }
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `khups_kpi_backup_${timestamp}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json({ backup_date: new Date().toISOString(), db_name: process.env.DB_NAME, tables: backup });

        try {
            await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
                [req.user.userId, 'BACKUP', 'ALL', JSON.stringify({ tables: tables.length, filename }), req.ip]);
        } catch (_) {}
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /backup-kpi-data — สำรองเฉพาะข้อมูลผลงาน (kpi_results + form_ tables)
apiRouter.get('/backup-kpi-data', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const backup = {};
        const [kpiRows] = await db.query('SELECT * FROM kpi_results');
        backup['kpi_results'] = { count: kpiRows.length, data: kpiRows };
        const [formTables] = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'form_%'");
        for (const t of formTables) {
            try {
                const [rows] = await db.query(`SELECT * FROM \`${t.table_name}\``);
                backup[t.table_name] = { count: rows.length, data: rows };
            } catch (e) { backup[t.table_name] = { count: 0, data: [], error: e.message }; }
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="kpi_data_backup_${timestamp}.json"`);
        res.json({ backup_date: new Date().toISOString(), tables: backup });
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_KPI_DATA', 'kpi_results', JSON.stringify({ tables: Object.keys(backup).length }), req.ip]); } catch (_) {}
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /clear-kpi-data — ล้างข้อมูลผลงานทั้งหมด (kpi_results + form_ data)
apiRouter.post('/clear-kpi-data', authenticateToken, isSuperAdmin, async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [kpiResult] = await connection.query('DELETE FROM kpi_results');
        const [formTables] = await connection.query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'form_%'");
        let formCleared = 0;
        for (const t of formTables) {
            try { await connection.query(`DELETE FROM \`${t.table_name}\``); formCleared++; } catch (_) {}
        }
        await connection.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'CLEAR_KPI_DATA', 'kpi_results', JSON.stringify({ kpi_results_deleted: kpiResult.affectedRows, form_tables_cleared: formCleared }), req.ip]);
        await connection.commit();
        res.json({ success: true, message: `ลบข้อมูลสำเร็จ — kpi_results: ${kpiResult.affectedRows} rows, form tables: ${formCleared} ตาราง` });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally { connection.release(); }
});

// ========================================================================
// ========== Database Backup & Restore Module (Phase 1) =================
// ========================================================================
// รองรับ: Manual backup/restore, Multi-DB Connection Manager, mysqldump streaming + gzip
// ผ่าน super_admin เท่านั้น
// ========================================================================


// Debug: ตรวจสอบ env + binary + timezone
apiRouter.get('/backup/system-info', authenticateToken, isSuperAdmin, async (req, res) => {
    const _now = new Date();
    const _bkkFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
    });
    const bkkParts = _bkkFmt.formatToParts(_now);
    const bkkTime = bkkParts.map(p => p.type === 'literal' ? p.value : p.value).join('');
    res.json({
        success: true,
        platform: process.platform,
        node_version: process.version,
        cwd: process.cwd(),
        backup_dir: BACKUP_DIR,
        backup_dir_exists: fs.existsSync(BACKUP_DIR),
        mysql_bin: MYSQL_BIN,
        mysql_bin_exists: fs.existsSync(MYSQL_BIN),
        mysqldump_bin: MYSQLDUMP_BIN,
        mysqldump_bin_exists: fs.existsSync(MYSQLDUMP_BIN),
        env_NODE_ENV: process.env.NODE_ENV || '(unset)',
        // === Timezone diagnostics ===
        timezone: {
            env_TZ: process.env.TZ || '(unset)',
            getTimezoneOffset_min: _now.getTimezoneOffset(),
            utc_offset_hours: -_now.getTimezoneOffset() / 60,
            local_time: _now.toString(),
            local_iso: _now.toISOString(),
            bangkok_time: bkkTime,
            using_bangkok_explicit: true,
            note: 'Scheduler ใช้ Intl.DateTimeFormat กับ Asia/Bangkok เสมอ — ไม่ขึ้นกับ process timezone'
        }
    });
});

// ========== Connection Manager ==========
apiRouter.get('/backup/connections', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, name, host, port, db_user, db_name, description, is_default, created_at, updated_at
             FROM backup_connections ORDER BY is_default DESC, id ASC`
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/connections', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { name, host, port, db_user, db_password, db_name, description, is_default } = req.body || {};
        if (!name || !host || !db_user || !db_name) {
            return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ (name/host/db_user/db_name)' });
        }
        const pwEnc = bkEncrypt(db_password || '');
        if (is_default) await db.query('UPDATE backup_connections SET is_default = 0');
        const [r] = await db.query(
            `INSERT INTO backup_connections (name, host, port, db_user, db_password_enc, db_name, description, is_default, created_by)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [name, host, Number(port) || 3306, db_user, pwEnc, db_name, description || null, is_default ? 1 : 0, req.user.userId]
        );
        res.json({ success: true, id: r.insertId, message: 'เพิ่ม connection สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/backup/connections/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { name, host, port, db_user, db_password, db_name, description, is_default } = req.body || {};
        const cur = await getBackupConnection(id);
        if (!cur) return res.status(404).json({ success: false, message: 'ไม่พบ connection' });
        // ถ้าไม่ส่ง password มาให้คงของเดิม
        const pwEnc = (db_password !== undefined && db_password !== null && db_password !== '')
            ? bkEncrypt(db_password) : cur.db_password_enc;
        if (is_default) await db.query('UPDATE backup_connections SET is_default = 0');
        await db.query(
            `UPDATE backup_connections SET name=?, host=?, port=?, db_user=?, db_password_enc=?, db_name=?, description=?, is_default=? WHERE id=?`,
            [name || cur.name, host || cur.host, Number(port) || cur.port, db_user || cur.db_user, pwEnc,
             db_name || cur.db_name, description ?? cur.description, is_default ? 1 : 0, id]
        );
        res.json({ success: true, message: 'แก้ไข connection สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/backup/connections/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [files] = await db.query('SELECT COUNT(*) AS c FROM backup_files WHERE connection_id = ?', [id]);
        if (files[0].c > 0) {
            return res.status(400).json({ success: false, message: `ลบไม่ได้ — มี backup files ${files[0].c} ไฟล์ผูกอยู่` });
        }
        await db.query('DELETE FROM backup_connections WHERE id = ? AND is_default = 0', [id]);
        res.json({ success: true, message: 'ลบ connection สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /backup/connections/:id/test — ทดสอบเชื่อมต่อ (ใช้ mysql client)
apiRouter.post('/backup/connections/:id/test', authenticateToken, isSuperAdmin, async (req, res) => {
    let responded = false;
    const safeJson = (status, body) => { if (responded) return; responded = true; res.status(status).json(body); };
    try {
        const id = Number(req.params.id);
        const conn = await getBackupConnection(id);
        if (!conn) return safeJson(404, { success: false, message: 'ไม่พบ connection' });
        const args = [
            ...buildConnectArgs(conn),
            `-e`,
            `SELECT 1 AS ok, VERSION() AS version, NOW() AS server_time`,
            conn.db_name,
            '--connect-timeout=8',
            '--silent'
        ];
        const env = { ...process.env };
        if (conn.db_password) env.MYSQL_PWD = conn.db_password;
        let proc;
        try {
            proc = spawn(MYSQL_BIN, args, { env });
        } catch (e) {
            return safeJson(500, { success: false, message: `ไม่สามารถเรียก mysql client ('${MYSQL_BIN}') — ตั้งค่า ENV MYSQL_BIN เป็น path เต็ม (เช่น C:\\xampp\\mysql\\bin\\mysql.exe)`, error: e.message });
        }
        let out = '', err = '';
        proc.stdout.on('data', (d) => out += d.toString());
        proc.stderr.on('data', (d) => err += d.toString());
        const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} safeJson(408, { success: false, message: 'timeout' }); }, 12000);
        proc.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) safeJson(200, { success: true, message: 'เชื่อมต่อสำเร็จ', output: out.trim() });
            else safeJson(400, { success: false, message: 'เชื่อมต่อล้มเหลว', error: cleanStderr(err), exit_code: code });
        });
        proc.on('error', (e) => {
            clearTimeout(timeout);
            safeJson(500, { success: false, message: `ไม่สามารถเรียก mysql client ('${MYSQL_BIN}') — ตั้งค่า ENV MYSQL_BIN เป็น path เต็ม (Windows dev: เช่น C:\\xampp\\mysql\\bin\\mysql.exe)`, error: e.message });
        });
    } catch (e) { safeJson(500, { success: false, message: e.message }); }
});

// POST /backup/connections/:id/verify-privileges — ตรวจสอบสิทธิ์ user ก่อน backup
apiRouter.post('/backup/connections/:id/verify-privileges', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const conn = await getBackupConnection(Number(req.params.id));
        if (!conn) return res.status(404).json({ success: false, message: 'ไม่พบ connection' });
        const result = await verifyBackupPrivileges(conn);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== Manual Backup ==========
// POST /backup/run  body: { connection_id, compress?:true, skip_privilege_check?:false }
// Response (immediate): { success, job_id }  — frontend polls GET /backup/jobs/:id
apiRouter.post('/backup/run', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { connection_id, compress = true, trigger_type = 'manual', skip_privilege_check = false } = req.body || {};
        const conn = await getBackupConnection(Number(connection_id));
        if (!conn) return res.status(404).json({ success: false, message: 'ไม่พบ connection' });

        // === ตรวจ privilege ก่อน — ถ้า user ขาดสิทธิ์ขัด backup ตั้งแต่ต้น ===
        if (!skip_privilege_check) {
            const priv = await verifyBackupPrivileges(conn);
            if (!priv.ok) {
                return res.status(400).json({
                    success: false,
                    code: 'PRIVILEGE_CHECK_FAILED',
                    message: priv.error,
                    hint: 'แก้ไข Connection ให้ใช้ user ที่มีสิทธิ์ SELECT บน DB นี้ (เช่น root) หรือกด "ข้ามการตรวจ" เพื่อ backup เลย'
                });
            }
        }

        // สร้าง job record
        const [r] = await db.query(
            `INSERT INTO backup_jobs (connection_id, connection_name, db_name, status, trigger_type, started_at, created_by)
             VALUES (?,?,?, 'running', ?, NOW(), ?)`,
            [conn.id, conn.name, conn.db_name, trigger_type, req.user.userId]
        );
        const jobId = r.insertId;
        const userId = req.user.userId;
        const reqIp = req.ip;

        // ตอบ jobId กลับทันที — work ทำใน background
        res.json({ success: true, job_id: jobId, message: 'เริ่ม backup แล้ว — poll /backup/jobs/:id เพื่อดู progress' });

        // === Background work ===
        runBackupJob(jobId, conn, compress, trigger_type, userId, reqIp).catch((e) => {
            console.error(`[Backup] job ${jobId} failed:`, e.message);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== Files ==========
apiRouter.get('/backup/files', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { connection_id, limit = 100 } = req.query;
        const params = [];
        let where = 'WHERE 1=1';
        if (connection_id) { where += ' AND connection_id = ?'; params.push(Number(connection_id)); }
        params.push(Math.min(Number(limit) || 100, 500));
        const [rows] = await db.query(
            `SELECT id, connection_id, connection_name, db_name, file_name, size_bytes, compressed, checksum_sha256,
                    trigger_type, created_by, created_at,
                    (log_path IS NOT NULL) AS has_log,
                    cloud_provider, cloud_url, cloud_uploaded_at, cloud_size_bytes
             FROM backup_files ${where} ORDER BY created_at DESC LIMIT ?`,
            params
        );
        // ตรวจ disk usage
        let diskInfo = null;
        try {
            const stats = await fsp.statfs(BACKUP_DIR);
            diskInfo = {
                total_bytes: stats.blocks * stats.bsize,
                free_bytes: stats.bfree * stats.bsize,
                available_bytes: stats.bavail * stats.bsize
            };
        } catch (e) { /* statfs not available on all platforms */ }
        res.json({ success: true, data: rows, backup_dir: BACKUP_DIR, disk: diskInfo });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /backup/jobs/:id — สำหรับ frontend polling progress
apiRouter.get('/backup/jobs/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM backup_jobs WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ job' });
        const j = rows[0];
        let elapsed_ms = null;
        if (j.started_at) {
            elapsed_ms = (j.finished_at ? new Date(j.finished_at) : new Date()).getTime() - new Date(j.started_at).getTime();
        }
        res.json({ success: true, data: { ...j, elapsed_ms } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/backup/jobs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const [rows] = await db.query(
            `SELECT id, connection_id, connection_name, db_name, status, trigger_type, file_id,
                    started_at, finished_at, duration_ms, size_bytes, error_msg, created_by, created_at
             FROM backup_jobs ORDER BY id DESC LIMIT ?`,
            [Math.min(Number(limit) || 50, 200)]
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Download backup file (stream)
apiRouter.get('/backup/files/:id/download', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        if (!fs.existsSync(f.file_path)) return res.status(404).json({ success: false, message: 'ไฟล์หายไปจากดิสก์' });
        res.setHeader('Content-Type', f.compressed ? 'application/gzip' : 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${f.file_name}"`);
        res.setHeader('Content-Length', f.size_bytes);
        fs.createReadStream(f.file_path).pipe(res);
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_DOWNLOAD', 'backup_files', JSON.stringify({ id, file_name: f.file_name }), req.ip]); } catch (_) {}
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET log content for backup file (text)
apiRouter.get('/backup/files/:id/log', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT log_path, file_name FROM backup_files WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0 || !rows[0].log_path) return res.status(404).json({ success: false, message: 'ไม่มี log file' });
        if (!fs.existsSync(rows[0].log_path)) return res.status(404).json({ success: false, message: 'log file หายจากดิสก์' });
        const content = await fsp.readFile(rows[0].log_path, 'utf8');
        const wantDownload = req.query.download === '1';
        if (wantDownload) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rows[0].log_path)}"`);
            return res.send(content);
        }
        res.json({ success: true, file_name: rows[0].file_name, log_content: content });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET log content for restore job (text)
apiRouter.get('/backup/restore-jobs/:id/log', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT log_path, target_db FROM restore_jobs WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0 || !rows[0].log_path) return res.status(404).json({ success: false, message: 'ไม่มี log file' });
        if (!fs.existsSync(rows[0].log_path)) return res.status(404).json({ success: false, message: 'log file หายจากดิสก์' });
        const content = await fsp.readFile(rows[0].log_path, 'utf8');
        const wantDownload = req.query.download === '1';
        if (wantDownload) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rows[0].log_path)}"`);
            return res.send(content);
        }
        res.json({ success: true, target_db: rows[0].target_db, log_content: content });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/backup/files/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const deleteCloud = req.query.delete_cloud === '1' || req.query.delete_cloud === 'true';
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        try { if (fs.existsSync(f.file_path)) await fsp.unlink(f.file_path); } catch (e) { /* ignore */ }
        try { if (f.log_path && fs.existsSync(f.log_path)) await fsp.unlink(f.log_path); } catch (e) { /* ignore */ }
        if (deleteCloud && f.cloud_file_id) {
            try { await deleteFileFromDrive(f.cloud_file_id); } catch (e) {
                console.warn('[Cloud] delete from drive during file delete failed:', e.message);
            }
        }
        await db.query('DELETE FROM backup_files WHERE id = ?', [id]);
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_DELETE', 'backup_files', JSON.stringify({ id, file_name: f.file_name }), req.ip]); } catch (_) {}
        res.json({ success: true, message: 'ลบไฟล์สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== Restore Jobs Polling ==========
apiRouter.get('/backup/restore-jobs/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM restore_jobs WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ job' });
        const j = rows[0];
        let elapsed_ms = null;
        if (j.started_at) {
            elapsed_ms = (j.finished_at ? new Date(j.finished_at) : new Date()).getTime() - new Date(j.started_at).getTime();
        }
        const percent = j.total_bytes > 0 ? Math.min(100, Math.round((j.progress_bytes / j.total_bytes) * 100)) : 0;
        res.json({ success: true, data: { ...j, elapsed_ms, percent } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== Restore ==========
// POST /backup/restore  body: { file_id, mode, target_db?, auto_backup_first?:true }
// Response: { success, restore_job_id } — poll GET /backup/restore-jobs/:id
apiRouter.post('/backup/restore', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { file_id, mode, target_db, auto_backup_first = true } = req.body || {};
        if (!['new_db', 'replace'].includes(mode)) {
            return res.status(400).json({ success: false, message: 'mode ต้องเป็น new_db หรือ replace' });
        }
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [Number(file_id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        if (!fs.existsSync(f.file_path)) return res.status(404).json({ success: false, message: 'ไฟล์หายจากดิสก์' });

        const conn = await getBackupConnection(f.connection_id);
        if (!conn) return res.status(404).json({ success: false, message: 'ไม่พบ connection เดิม' });

        // กำหนด target DB
        let dbTarget;
        if (mode === 'new_db') {
            const ts = bangkokTimestamp(new Date(), 'compact'); // 14-digit Bangkok time
            dbTarget = target_db && isValidIdent(target_db) ? target_db : `${conn.db_name}_restore_${ts}`;
            if (!isValidIdent(dbTarget)) {
                return res.status(400).json({ success: false, message: 'target_db ไม่ถูกต้อง (a-z, 0-9, _ เท่านั้น)' });
            }
        } else {
            dbTarget = conn.db_name;
        }

        // === สร้าง restore_jobs record + return ทันที ===
        const [rj] = await db.query(
            `INSERT INTO restore_jobs (file_id, source_file_name, connection_id, target_db, mode, status, total_bytes, started_at, phase, created_by)
             VALUES (?,?,?,?,?, 'running', ?, NOW(), ?, ?)`,
            [f.id, f.file_name, f.connection_id, dbTarget, mode, f.size_bytes, 'starting', req.user.userId]
        );
        const restoreJobId = rj.insertId;
        const userId = req.user.userId;
        const reqIp = req.ip;

        res.json({ success: true, restore_job_id: restoreJobId, target_db: dbTarget, message: 'เริ่ม Restore แล้ว — poll /backup/restore-jobs/:id' });

        // === Background work ===
        runRestoreJob(restoreJobId, f, conn, mode, dbTarget, auto_backup_first, userId, reqIp).catch((e) => {
            console.error(`[Restore] job ${restoreJobId} failed:`, e.message);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== Backup Schedules CRUD ==========
apiRouter.get('/backup/schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT s.*, c.name AS connection_name, c.db_name, c.host AS conn_host
            FROM backup_schedules s
            LEFT JOIN backup_connections c ON s.connection_id = c.id
            ORDER BY s.id DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.name || !b.connection_id || !b.days_of_week || !b.time_of_day) {
            return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ (name/connection_id/days_of_week/time_of_day)' });
        }
        const [r] = await db.query(
            `INSERT INTO backup_schedules
             (name, is_enabled, connection_id, days_of_week, time_of_day, compress, retention_days,
              notify_email, notify_email_on_success, notify_email_on_failure,
              notify_telegram, notify_telegram_on_success, notify_telegram_on_failure,
              notify_line, notify_line_on_success, notify_line_on_failure,
              auto_upload_cloud, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [b.name, b.is_enabled ? 1 : 0, Number(b.connection_id), b.days_of_week, b.time_of_day,
             b.compress !== false ? 1 : 0, Number(b.retention_days) || 30,
             b.notify_email ? 1 : 0, b.notify_email_on_success !== false ? 1 : 0, b.notify_email_on_failure !== false ? 1 : 0,
             b.notify_telegram ? 1 : 0, b.notify_telegram_on_success !== false ? 1 : 0, b.notify_telegram_on_failure !== false ? 1 : 0,
             b.notify_line ? 1 : 0, b.notify_line_on_success !== false ? 1 : 0, b.notify_line_on_failure !== false ? 1 : 0,
             b.auto_upload_cloud ? 1 : 0,
             req.user.userId]
        );
        res.json({ success: true, id: r.insertId, message: 'สร้าง schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/backup/schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        // ข้อมูลไม่ครบ → 400 (เดิม 500 "Unknown column 'NaN'" จาก Number(undefined)) — เงื่อนไขเดียวกับ POST
        if (!b.name || !b.connection_id || !b.days_of_week || !b.time_of_day) {
            return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ (name/connection_id/days_of_week/time_of_day)' });
        }
        const [upd] = await db.query(
            `UPDATE backup_schedules SET name=?, is_enabled=?, connection_id=?, days_of_week=?, time_of_day=?, compress=?, retention_days=?,
             notify_email=?, notify_email_on_success=?, notify_email_on_failure=?,
             notify_telegram=?, notify_telegram_on_success=?, notify_telegram_on_failure=?,
             notify_line=?, notify_line_on_success=?, notify_line_on_failure=?,
             auto_upload_cloud=?
             WHERE id=?`,
            [b.name, b.is_enabled ? 1 : 0, Number(b.connection_id), b.days_of_week, b.time_of_day,
             b.compress !== false ? 1 : 0, Number(b.retention_days) || 30,
             b.notify_email ? 1 : 0, b.notify_email_on_success !== false ? 1 : 0, b.notify_email_on_failure !== false ? 1 : 0,
             b.notify_telegram ? 1 : 0, b.notify_telegram_on_success !== false ? 1 : 0, b.notify_telegram_on_failure !== false ? 1 : 0,
             b.notify_line ? 1 : 0, b.notify_line_on_success !== false ? 1 : 0, b.notify_line_on_failure !== false ? 1 : 0,
             b.auto_upload_cloud ? 1 : 0,
             Number(req.params.id)]
        );
        if (!upd.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบตารางเวลาสำรองข้อมูล' });
        res.json({ success: true, message: 'แก้ไข schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/backup/schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM backup_schedules WHERE id=?', [Number(req.params.id)]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/schedules/:id/run-now', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM backup_schedules WHERE id=?', [Number(req.params.id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ schedule' });
        // Lock + รันแบบ async ใน background
        await db.query('UPDATE backup_schedules SET last_run_at=NOW() WHERE id=?', [rows[0].id]);
        runScheduledBackup(rows[0]).catch(e => console.error('[Scheduler] manual run-now error:', e.message));
        res.json({ success: true, message: 'เริ่ม backup แล้ว — ดู Files tab + Logs ภายในไม่กี่นาที' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/backup/schedules/:id/logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM backup_schedule_logs WHERE schedule_id=? ORDER BY id DESC LIMIT 100',
            [Number(req.params.id)]
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /backup/schedules/test-notification — ทดสอบการส่ง notification
apiRouter.post('/backup/schedules/test-notification', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const testResult = {
            status: 'success',
            connection_name: 'Test Connection',
            db_name: 'test_db',
            file_name: 'test_backup_' + Date.now() + '.sql.gz',
            size_bytes: 1024 * 1024,
            total_inserts: 12345,
            tables_count: 39,
            duration_ms: 2500,
            cleaned_up_files: 0,
            cleaned_up_bytes: 0,
            warnings: []
        };
        const testSchedule = {
            name: 'TEST NOTIFICATION',
            notify_email: req.body.email !== false,
            notify_email_on_success: true,
            notify_email_on_failure: true,
            notify_telegram: req.body.telegram !== false,
            notify_telegram_on_success: true,
            notify_telegram_on_failure: true
        };
        const notif = await notifyBackupResult(testSchedule, testResult);
        res.json({ success: true, ...notif, message: 'ส่งทดสอบแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========================================================================
// =========== Phase 3: Cloud Upload (Google Drive) + Monitor =============
// ========================================================================


// === OAuth State Map (CSRF protection) — 10 นาที TTL ===
const _gdriveStateMap = new Map();

const GDRIVE_STATE_TTL = 10 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _gdriveStateMap.entries()) {
        if (v.expiry < now) _gdriveStateMap.delete(k);
    }
}, 60 * 1000);

// === Cloud Settings endpoints ===
apiRouter.get('/backup/cloud/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const cfg = await getDriveSettings();
        res.json({
            success: true,
            enabled: cfg.enabled,
            client_id: cfg.clientId,
            has_client_secret: !!cfg.clientSecret,
            has_refresh_token: !!cfg.refreshToken,
            user_email: cfg.userEmail,
            redirect_uri: cfg.redirectUri,
            folder_id: cfg.folderId,
            folder_name: cfg.folderName,
            // hint สำหรับ frontend: ต้อง config อะไรบ้าง
            needs_credentials: !cfg.clientId || !cfg.clientSecret,
            needs_authorization: !cfg.refreshToken
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/cloud/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { enabled, client_id, client_secret, redirect_uri, folder_id, folder_name } = req.body || {};
        const updates = [
            ['gdrive_enabled', enabled ? 'true' : 'false'],
            ['gdrive_client_id', client_id || ''],
            ['gdrive_redirect_uri', redirect_uri || ''],
            ['gdrive_folder_id', folder_id || ''],
            ['gdrive_folder_name', folder_name || '']
        ];
        // client_secret: ถ้าส่งมา → encrypt + save; ถ้าไม่ส่ง คงค่าเดิม
        if (client_secret !== undefined && client_secret !== null && client_secret !== '') {
            updates.push(['gdrive_client_secret_enc', bkEncrypt(client_secret)]);
        }
        for (const [k, v] of updates) {
            await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, v, v]);
        }
        resetDriveClientCache();
        res.json({ success: true, message: 'บันทึก settings สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// === OAuth 2.0 Flow ===
// POST /backup/cloud/oauth/auth-url — สร้าง Google consent URL (authenticated)
apiRouter.post('/backup/cloud/oauth/auth-url', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const cfg = await getDriveSettings();
        if (!cfg.clientId || !cfg.clientSecret) {
            return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้ง Client ID/Secret' });
        }
        if (!cfg.redirectUri) {
            return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้ง Redirect URI (ต้องตรงกับใน Google Cloud Console)' });
        }
        // state CSRF — random + เก็บ userId เพื่อตรวจสอบ
        const state = crypto.randomBytes(24).toString('hex');
        _gdriveStateMap.set(state, { userId: req.user.userId, expiry: Date.now() + GDRIVE_STATE_TTL });

        const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
        const authUrl = oauth2.generateAuthUrl({
            access_type: 'offline',           // ขอ refresh_token
            prompt: 'consent',                // บังคับ consent ทุกครั้ง (กัน Google ไม่ส่ง refresh_token รอบ 2)
            scope: [
                'https://www.googleapis.com/auth/drive.file',     // เข้าถึงไฟล์ที่แอปสร้าง/เปิด
                'https://www.googleapis.com/auth/userinfo.email'  // ดึง email user
            ],
            state
        });
        res.json({ success: true, auth_url: authUrl, state });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /backup/cloud/oauth/callback — Google redirect กลับมาที่นี่ (public, ไม่ต้อง auth)
apiRouter.get('/backup/cloud/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const buildHtml = (status, msg, detail = '') => `
<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>Google Drive — ${status}</title>
<style>body{font-family:sans-serif;text-align:center;padding:60px 20px;background:#f5f5f5}
.card{background:#fff;max-width:520px;margin:auto;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
.ok{color:#10b981}.err{color:#dc2626}h1{margin:10px 0}p{color:#555;font-size:14px}
.close-hint{margin-top:24px;padding:12px;background:#f0fdf4;border-radius:8px;font-size:13px;color:#15803d}</style></head><body>
<div class="card">
<div style="font-size:48px" class="${status==='success'?'ok':'err'}">${status==='success'?'✓':'✗'}</div>
<h1>${msg}</h1><p>${detail}</p>
<div class="close-hint">คุณสามารถปิดหน้านี้แล้วกลับไปยังแอป — สถานะจะ refresh อัตโนมัติ</div>
</div></body></html>`;
    try {
        if (error) return res.send(buildHtml('error', 'การ authorize ถูกยกเลิก', String(error)));
        if (!code || !state) return res.send(buildHtml('error', 'พารามิเตอร์ไม่ครบ', 'missing code or state'));
        const stateInfo = _gdriveStateMap.get(state);
        if (!stateInfo || stateInfo.expiry < Date.now()) {
            return res.send(buildHtml('error', 'State ไม่ถูกต้องหรือหมดอายุ', 'ลอง Connect ใหม่อีกครั้ง'));
        }
        _gdriveStateMap.delete(state);

        const cfg = await getDriveSettings();
        const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.refresh_token) {
            return res.send(buildHtml('error', 'Google ไม่ส่ง refresh_token กลับมา',
                'ลองไป <a href="https://myaccount.google.com/permissions">https://myaccount.google.com/permissions</a> ลบสิทธิ์เก่าออก แล้วลองใหม่'));
        }
        // ดึง email ของ user
        oauth2.setCredentials(tokens);
        let userEmail = '';
        try {
            const peopleRes = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get();
            userEmail = peopleRes.data.email || '';
        } catch (e) { /* ignore */ }

        // เก็บ refresh_token (encrypted) + email
        await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
            ['gdrive_refresh_token_enc', bkEncrypt(tokens.refresh_token), bkEncrypt(tokens.refresh_token)]);
        await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
            ['gdrive_user_email', userEmail, userEmail]);
        // auto-enable
        await db.query("UPDATE system_settings SET setting_value='true' WHERE setting_key='gdrive_enabled'");

        resetDriveClientCache();

        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [stateInfo.userId, 'GDRIVE_OAUTH_CONNECT', 'system_settings', JSON.stringify({ email: userEmail }), req.ip]); } catch (_) {}

        res.send(buildHtml('success', 'เชื่อมต่อ Google Drive สำเร็จ', `Account: <b>${userEmail || '(ไม่ทราบ)'}</b>`));
    } catch (e) {
        console.error('[OAuth] callback error:', e.message);
        res.send(buildHtml('error', 'OAuth ล้มเหลว', e.message));
    }
});

// POST /backup/cloud/disconnect — revoke refresh_token + clear
apiRouter.post('/backup/cloud/disconnect', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const cfg = await getDriveSettings();
        if (cfg.refreshToken) {
            // พยายาม revoke ที่ Google (best effort)
            try {
                const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
                await oauth2.revokeToken(cfg.refreshToken);
            } catch (e) { console.warn('[OAuth] revoke failed (continuing):', e.message); }
        }
        await db.query("UPDATE system_settings SET setting_value='' WHERE setting_key IN ('gdrive_refresh_token_enc','gdrive_user_email')");
        await db.query("UPDATE system_settings SET setting_value='false' WHERE setting_key='gdrive_enabled'");
        resetDriveClientCache();
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'GDRIVE_OAUTH_DISCONNECT', 'system_settings', '{}', req.ip]); } catch (_) {}
        res.json({ success: true, message: 'Disconnect สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/cloud/test', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const result = await testDriveConnection();
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// === Manual upload to cloud ===
apiRouter.post('/backup/files/:id/upload-cloud', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        if (!fs.existsSync(f.file_path)) return res.status(404).json({ success: false, message: 'ไฟล์หายจากดิสก์' });
        if (f.cloud_file_id) return res.status(400).json({ success: false, message: 'ไฟล์นี้อัพโหลดไป cloud แล้ว' });

        const result = await uploadFileToDrive(f.file_path, f.file_name);
        await db.query(
            'UPDATE backup_files SET cloud_provider=?, cloud_file_id=?, cloud_url=?, cloud_uploaded_at=NOW(), cloud_size_bytes=? WHERE id=?',
            ['gdrive', result.file_id, result.web_url, result.size, id]
        );
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_CLOUD_UPLOAD', 'backup_files', JSON.stringify({ id, file_name: f.file_name, cloud_file_id: result.file_id }), req.ip]); } catch (_) {}
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.delete('/backup/files/:id/cloud', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0 || !rows[0].cloud_file_id) return res.status(404).json({ success: false, message: 'ไม่มี cloud file' });
        try { await deleteFileFromDrive(rows[0].cloud_file_id); } catch (e) {
            console.warn('[Cloud] delete from drive failed (continuing):', e.message);
        }
        await db.query('UPDATE backup_files SET cloud_provider=NULL, cloud_file_id=NULL, cloud_url=NULL, cloud_uploaded_at=NULL, cloud_size_bytes=NULL WHERE id=?', [id]);
        res.json({ success: true, message: 'ลบจาก cloud สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========================================================================
// ============== Monitor Dashboard endpoint ==============================
// ========================================================================
apiRouter.get('/backup/monitor', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const result = {
            timestamp: new Date().toISOString(),
            bangkok_time: bangkokTimestamp(new Date(), 'log')
        };

        // === 1. DB info ===
        try {
            const [versionRows] = await db.query("SELECT VERSION() AS version, @@hostname AS hostname, @@port AS port, DATABASE() AS current_db");
            const [uptimeRows] = await db.query("SHOW STATUS LIKE 'Uptime'");
            const [varsRows] = await db.query("SHOW VARIABLES WHERE Variable_name IN ('max_connections','wait_timeout','long_query_time')");
            const vars = {};
            for (const v of varsRows) vars[v.Variable_name] = v.Value;
            result.db = {
                version: versionRows[0].version,
                hostname: versionRows[0].hostname,
                port: versionRows[0].port,
                database: versionRows[0].current_db,
                uptime_seconds: Number(uptimeRows[0]?.Value) || 0,
                max_connections: Number(vars.max_connections) || 0,
                wait_timeout: Number(vars.wait_timeout) || 0,
                long_query_time: Number(vars.long_query_time) || 0
            };
        } catch (e) { result.db = { error: e.message }; }

        // === 2. Tables (size + rows) ===
        try {
            const [tables] = await db.query(`
                SELECT table_name, table_type, IFNULL(table_rows, 0) AS rows_approx,
                       IFNULL(data_length, 0) AS data_bytes, IFNULL(index_length, 0) AS index_bytes,
                       IFNULL(data_free, 0) AS free_bytes, update_time
                FROM INFORMATION_SCHEMA.TABLES
                WHERE table_schema = DATABASE()
                ORDER BY (IFNULL(data_length,0) + IFNULL(index_length,0)) DESC
            `);
            const totalData = tables.reduce((s, t) => s + Number(t.data_bytes || 0), 0);
            const totalIndex = tables.reduce((s, t) => s + Number(t.index_bytes || 0), 0);
            const totalRows = tables.reduce((s, t) => s + Number(t.rows_approx || 0), 0);
            result.tables = {
                count: tables.length,
                total_data_bytes: totalData,
                total_index_bytes: totalIndex,
                total_size_bytes: totalData + totalIndex,
                total_rows_approx: totalRows,
                list: tables.map(t => ({
                    name: t.table_name,
                    type: t.table_type,
                    rows: Number(t.rows_approx),
                    data_bytes: Number(t.data_bytes),
                    index_bytes: Number(t.index_bytes),
                    total_bytes: Number(t.data_bytes) + Number(t.index_bytes),
                    update_time: t.update_time
                }))
            };
        } catch (e) { result.tables = { error: e.message }; }

        // === 3. Pool status ===
        try {
            // mysql2 promise pool — เข้าถึง underlying pool ผ่าน .pool
            const underlying = db.pool || db;
            result.pool = {
                connection_limit: underlying.config?.connectionLimit || 0,
                queue_limit: underlying.config?.queueLimit || 0,
                total_connections: underlying._allConnections?.length ?? null,
                free_connections: underlying._freeConnections?.length ?? null,
                queued_requests: underlying._connectionQueue?.length ?? null,
                acquiring_connections: underlying._acquiringConnections?.length ?? null
            };
        } catch (e) { result.pool = { error: e.message }; }

        // === 4. Running processes / slow queries ===
        try {
            const [processes] = await db.query("SHOW FULL PROCESSLIST");
            const longQueryTime = result.db?.long_query_time || 1;
            const slow = processes
                .filter(p => p.Time >= Math.max(longQueryTime, 5) && p.Command !== 'Sleep')
                .slice(0, 10)
                .map(p => ({
                    id: p.Id, user: p.User, host: p.Host, db: p.db, command: p.Command,
                    time_seconds: p.Time, state: p.State, info: (p.Info || '').slice(0, 300)
                }));
            result.processes = {
                total: processes.length,
                active: processes.filter(p => p.Command !== 'Sleep').length,
                sleeping: processes.filter(p => p.Command === 'Sleep').length,
                slow_queries: slow
            };
        } catch (e) { result.processes = { error: e.message }; }

        // === 5. Disk usage (backup dir) ===
        try {
            const dirFiles = await fsp.readdir(BACKUP_DIR);
            let totalBackupBytes = 0;
            let backupFileCount = 0;
            let oldestFileTime = null, newestFileTime = null;
            for (const fname of dirFiles) {
                try {
                    const fpath = path.join(BACKUP_DIR, fname);
                    const st = await fsp.stat(fpath);
                    if (!st.isFile()) continue;
                    totalBackupBytes += st.size;
                    backupFileCount++;
                    if (!oldestFileTime || st.mtimeMs < oldestFileTime) oldestFileTime = st.mtimeMs;
                    if (!newestFileTime || st.mtimeMs > newestFileTime) newestFileTime = st.mtimeMs;
                } catch (_) {}
            }
            let diskStats = null;
            try {
                const sf = await fsp.statfs(BACKUP_DIR);
                diskStats = {
                    total_bytes: sf.blocks * sf.bsize,
                    free_bytes: sf.bfree * sf.bsize,
                    available_bytes: sf.bavail * sf.bsize,
                    used_bytes: (sf.blocks - sf.bfree) * sf.bsize
                };
            } catch (_) { /* statfs not available */ }
            result.disk = {
                backup_dir: BACKUP_DIR,
                file_count: backupFileCount,
                total_size_bytes: totalBackupBytes,
                oldest_file: oldestFileTime ? new Date(oldestFileTime).toISOString() : null,
                newest_file: newestFileTime ? new Date(newestFileTime).toISOString() : null,
                filesystem: diskStats
            };
        } catch (e) { result.disk = { error: e.message }; }

        // === 6. Backup summary (จากตาราง backup_files) ===
        try {
            const [summary] = await db.query(`
                SELECT
                    COUNT(*) AS total_files,
                    IFNULL(SUM(size_bytes), 0) AS total_size,
                    COUNT(CASE WHEN trigger_type='manual' THEN 1 END) AS manual_count,
                    COUNT(CASE WHEN trigger_type='scheduled' THEN 1 END) AS scheduled_count,
                    COUNT(CASE WHEN trigger_type='auto_before_restore' THEN 1 END) AS auto_count,
                    COUNT(CASE WHEN cloud_file_id IS NOT NULL THEN 1 END) AS cloud_uploaded
                FROM backup_files
            `);
            const [latest] = await db.query('SELECT id, file_name, size_bytes, created_at FROM backup_files ORDER BY id DESC LIMIT 1');
            result.backups = {
                ...summary[0],
                total_size: Number(summary[0].total_size),
                latest: latest[0] || null
            };
        } catch (e) { result.backups = { error: e.message }; }

        // === 7. Recent errors (จาก backup_jobs + restore_jobs) ===
        try {
            const [failedBackups] = await db.query(
                "SELECT id, connection_name, db_name, error_msg, created_at FROM backup_jobs WHERE status='failed' ORDER BY id DESC LIMIT 5"
            );
            const [failedRestores] = await db.query(
                "SELECT id, source_file_name, target_db, error_msg, created_at FROM restore_jobs WHERE status='failed' ORDER BY id DESC LIMIT 5"
            );
            result.recent_errors = {
                failed_backups: failedBackups,
                failed_restores: failedRestores
            };
        } catch (e) { result.recent_errors = { error: e.message }; }

        // === 8. Schedule status ===
        try {
            const [schedules] = await db.query(`
                SELECT s.id, s.name, s.is_enabled, s.last_run_at, s.last_status, s.time_of_day,
                       c.name AS connection_name
                FROM backup_schedules s
                LEFT JOIN backup_connections c ON s.connection_id = c.id
                ORDER BY s.id DESC
            `);
            result.schedules = {
                total: schedules.length,
                enabled: schedules.filter(s => s.is_enabled).length,
                list: schedules
            };
        } catch (e) { result.schedules = { error: e.message }; }

        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = { _gdriveStateMap, GDRIVE_STATE_TTL };
