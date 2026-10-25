// สำรอง & กู้คืนข้อมูล: mysqldump/mysql, การเชื่อมต่อ (รหัสผ่านเข้ารหัส AES-256-GCM), งานสำรอง/กู้คืน + log, ตารางเวลาสำรองอัตโนมัติ, Google Drive
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const crypto = require('crypto');
const db = require('../db');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { SECRET_KEY } = require('../core/security');
const { getNotifSettings, notifyLineAction, sendLineMulticast, sendMail, sendTelegramDirect } = require('../core/notify');
const { google } = require('googleapis');
const { spawn } = require('child_process');

const BACKUP_DIR = process.env.BACKUP_DIR || (process.platform === 'win32' ? path.join(process.cwd(), 'backups') : '/backups');

// Configurable binary paths
//  - prefer 'mariadb' / 'mariadb-dump' (MariaDB 10.11+) เพื่อเลี่ยง deprecation warning ของ 'mysql'
//  - ถ้า env ไม่ตั้ง → ใช้ 'mariadb' ถ้ามี (Linux/Docker), fallback 'mysql'
function _detectBin(envName, candidates) {
    if (process.env[envName]) return process.env[envName];
    // ถ้าหา binary ใน PATH ได้ → ใช้ตัวนั้น (เช็คโดย spawn --version)
    for (const cand of candidates) {
        try {
            const r = require('child_process').spawnSync(cand, ['--version'], { timeout: 3000 });
            if (r.status === 0) return cand;
        } catch (_) {}
    }
    return candidates[candidates.length - 1]; // fallback ตัวสุดท้าย
}

const MYSQL_BIN = _detectBin('MYSQL_BIN', ['mariadb', 'mysql']);

const MYSQLDUMP_BIN = _detectBin('MYSQLDUMP_BIN', ['mariadb-dump', 'mysqldump']);

// SSL/auth options ที่ใช้ร่วมกันทุกคำสั่ง — กัน warning ของ MariaDB 10.11+ ที่ stderr (ทำให้ระบบจับเป็น error)
const MARIADB_COMMON_ARGS = ['--skip-ssl-verify-server-cert'];

console.log(`[Backup] MYSQL_BIN='${MYSQL_BIN}' exists=${fs.existsSync(MYSQL_BIN) || 'in PATH'}`);

console.log(`[Backup] MYSQLDUMP_BIN='${MYSQLDUMP_BIN}' exists=${fs.existsSync(MYSQLDUMP_BIN) || 'in PATH'}`);

// Ensure directory exists (sync at startup is fine)
try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) { /* may already exist */ }

// Probe binary availability (non-fatal — log warning if missing)
(() => {
    try {
        const probe = spawn(MYSQLDUMP_BIN, ['--version']);
        probe.on('error', (e) => {
            console.warn(`[Backup] ⚠️  mysqldump binary not found ('${MYSQLDUMP_BIN}') — set MYSQLDUMP_BIN env var to absolute path. Error: ${e.message}`);
        });
        probe.stdout.on('data', () => {}); // drain
        probe.stderr.on('data', () => {});
    } catch (e) { /* ignore */ }
})();

// === AES-256-GCM Encryption Helpers (for storing DB passwords) ===
const _bkEncKey = crypto.createHash('sha256').update(String(SECRET_KEY || 'khups-default')).digest(); // 32 bytes

const bkEncrypt = (plaintext) => {
    if (plaintext == null || plaintext === '') return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', _bkEncKey, iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: <iv-hex>:<tag-hex>:<ciphertext-hex>
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
};

const bkDecrypt = (ciphertext) => {
    if (!ciphertext) return '';
    try {
        const parts = String(ciphertext).split(':');
        if (parts.length !== 3) return '';
        const iv = Buffer.from(parts[0], 'hex');
        const tag = Buffer.from(parts[1], 'hex');
        const enc = Buffer.from(parts[2], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', _bkEncKey, iv);
        decipher.setAuthTag(tag);
        const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
        return dec.toString('utf8');
    } catch (e) {
        console.error('[Backup] decrypt error:', e.message);
        return '';
    }
};

// === Auto-migration: backup tables ===
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS backup_connections (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                host VARCHAR(255) NOT NULL,
                port INT NOT NULL DEFAULT 3306,
                db_user VARCHAR(100) NOT NULL,
                db_password_enc TEXT NULL,
                db_name VARCHAR(100) NOT NULL,
                description VARCHAR(255) NULL,
                is_default TINYINT(1) DEFAULT 0,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS backup_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                connection_id INT NULL,
                connection_name VARCHAR(100) NULL,
                db_name VARCHAR(100) NULL,
                status ENUM('pending','running','success','failed','cancelled') DEFAULT 'pending',
                trigger_type ENUM('manual','scheduled','auto_before_restore') DEFAULT 'manual',
                file_id INT NULL,
                started_at DATETIME NULL,
                finished_at DATETIME NULL,
                duration_ms INT NULL,
                size_bytes BIGINT NULL,
                error_msg TEXT NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_status (status),
                INDEX idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS backup_files (
                id INT AUTO_INCREMENT PRIMARY KEY,
                connection_id INT NULL,
                connection_name VARCHAR(100) NULL,
                db_name VARCHAR(100) NULL,
                file_path VARCHAR(500) NOT NULL,
                file_name VARCHAR(255) NOT NULL,
                size_bytes BIGINT NOT NULL DEFAULT 0,
                compressed TINYINT(1) DEFAULT 1,
                checksum_sha256 VARCHAR(64) NULL,
                trigger_type ENUM('manual','scheduled','auto_before_restore') DEFAULT 'manual',
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_conn (connection_id),
                INDEX idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS restore_jobs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                file_id INT NULL,
                source_file_name VARCHAR(255) NULL,
                connection_id INT NULL,
                target_db VARCHAR(100) NULL,
                mode ENUM('new_db','replace') NOT NULL,
                status ENUM('pending','running','success','failed') DEFAULT 'pending',
                progress_bytes BIGINT DEFAULT 0,
                total_bytes BIGINT DEFAULT 0,
                tables_count INT DEFAULT 0,
                current_table VARCHAR(255) NULL,
                phase VARCHAR(50) NULL,
                pre_backup_file_id INT NULL,
                started_at DATETIME NULL,
                finished_at DATETIME NULL,
                duration_ms INT NULL,
                error_msg TEXT NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_status (status),
                INDEX idx_created (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // เพิ่มคอลัมน์ log_path สำหรับเก็บ path ของ log file (idempotent)
        try { await db.query('ALTER TABLE backup_files ADD COLUMN log_path VARCHAR(500) NULL'); } catch (e) { /* already exists */ }
        try { await db.query('ALTER TABLE restore_jobs ADD COLUMN log_path VARCHAR(500) NULL'); } catch (e) { /* already exists */ }

        // Phase 3: cloud upload columns
        try { await db.query('ALTER TABLE backup_files ADD COLUMN cloud_provider VARCHAR(20) NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_files ADD COLUMN cloud_file_id VARCHAR(255) NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_files ADD COLUMN cloud_url VARCHAR(500) NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_files ADD COLUMN cloud_uploaded_at DATETIME NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_files ADD COLUMN cloud_size_bytes BIGINT NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_schedules ADD COLUMN auto_upload_cloud TINYINT(1) DEFAULT 0'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_schedule_logs ADD COLUMN cloud_uploaded TINYINT(1) DEFAULT 0'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_schedule_logs ADD COLUMN cloud_url VARCHAR(500) NULL'); } catch (e) {}

        // Default settings — ThaiD SSO (DGA imauth.bora.dopa.go.th)
        // auth_url, token_url, client_id, redirect_uri, scope ถูก hardcode ใน constants แล้ว
        // ใน DB เก็บแค่ enabled + client_secret เท่านั้น
        const thaidDefaults = [
            ['thaid_enabled', 'false', 'เปิดใช้ ThaiD SSO (DGA) — true/false'],
            ['thaid_client_secret', '', 'ThaiD Client Secret (จาก DGA — กรอกในหน้า Settings)'],
            ['thaid_login_url', '', 'URL ThaiD สำหรับ login — DGA redirect กลับมาที่ /khupskpi/login?token=<JWT>'],
            ['thaid_return_page', '/login', 'หน้าที่จะ redirect หลัง ThaiD สำเร็จ เช่น /login หรือ /register'],
            ['thaid_register_enabled', 'false', 'เปิดให้ลงทะเบียนด้วย ThaiD — true/false'],
            ['providerid_register_enabled', 'false', 'เปิดให้ลงทะเบียนด้วย ProviderID — true/false'],
            ['thaid_register_url', `https://imauth.bora.dopa.go.th/api/v2/oauth2/auth/?response_type=code&client_id=THV0dzZtYjVVOHc4WVJPQVRaVndmNVYwVG82VUdlYXM&redirect_uri=https://apikorat.moph.go.th/authen/thaid/callback&scope=pid%20name%20birthdate%20openid`, 'URL ThaiD OAuth สำหรับหน้าลงทะเบียน (state จะถูก override โดย backend)'],
        ];
        for (const [key, val, desc] of thaidDefaults) {
            try { await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]); } catch (e) {}
        }

        // Default settings — Google Drive cloud config (OAuth 2.0 user account, 15GB free Gmail)
        const cloudDefaults = [
            ['gdrive_enabled', 'false', 'เปิดใช้ Google Drive cloud backup (OAuth user account)'],
            ['gdrive_client_id', '', 'OAuth 2.0 Client ID จาก Google Cloud Console'],
            ['gdrive_client_secret_enc', '', 'OAuth 2.0 Client Secret (AES-256-GCM encrypted)'],
            ['gdrive_refresh_token_enc', '', 'OAuth refresh token จาก user consent (AES-256-GCM encrypted)'],
            ['gdrive_redirect_uri', '', 'Authorized redirect URI ใน Google Cloud Console'],
            ['gdrive_user_email', '', 'Email ของ Google account ที่ authorize'],
            ['gdrive_folder_id', '', 'Google Drive folder ID ที่จะเก็บ backup'],
            ['gdrive_folder_name', '', 'ชื่อ folder (แสดงผล)']
        ];
        for (const [key, val, desc] of cloudDefaults) {
            try { await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]); } catch (e) {}
        }
        // ลบ key เก่าของ service account (ถ้ามี)
        try { await db.query("DELETE FROM system_settings WHERE setting_key = 'gdrive_service_account_json'"); } catch (e) {}

        // ============= KPI Save Audit (notification ผู้ใช้บันทึกข้อมูล) =============
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_save_audit (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                username VARCHAR(100) NULL,
                full_name VARCHAR(255) NULL,
                dept_id INT NULL,
                dept_name VARCHAR(255) NULL,
                hospcode VARCHAR(20) NULL,
                hospname VARCHAR(255) NULL,
                action_type ENUM('kpi_results','dynamic_form','sub_results','hierarchy_results') NOT NULL,
                indicator_id INT NULL,
                indicator_name VARCHAR(500) NULL,
                year_bh VARCHAR(10) NULL,
                month_bh VARCHAR(10) NULL,
                table_name VARCHAR(100) NULL,
                row_count INT DEFAULT 1,
                summary VARCHAR(500) NULL,
                ip_address VARCHAR(64) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                notified_at DATETIME NULL,
                INDEX idx_created (created_at),
                INDEX idx_notified (notified_at),
                INDEX idx_user_date (user_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);

        // ตัวชี้วัด 3 ระดับ: บันทึกผลงานข้อย่อย/กิจกรรมผ่าน /hierarchy-results/save (18 ต.ค. 2569 — เดิมไม่มีค่านี้ใน ENUM ทำให้บันทึก audit ไม่ได้)
        try { await db.query("ALTER TABLE kpi_save_audit MODIFY COLUMN action_type ENUM('kpi_results','dynamic_form','sub_results','hierarchy_results') NOT NULL"); } catch (e) {}

        // Default settings for digest
        const auditDefaults = [
            ['kpi_audit_enabled', 'true', 'เปิด/ปิด ระบบบันทึกการ save ข้อมูล'],
            ['kpi_audit_digest_enabled', 'true', 'เปิด/ปิด การส่ง digest สรุปประจำวัน'],
            ['kpi_audit_digest_time', '17:00', 'เวลาส่ง digest ประจำวัน (HH:MM Bangkok)'],
            ['kpi_audit_digest_email', 'true', 'ส่ง digest ทาง Email'],
            ['kpi_audit_digest_telegram', 'true', 'ส่ง digest ทาง Telegram'],
            ['kpi_audit_digest_line', 'true', 'ส่ง digest ทาง LINE Group'],
            ['kpi_audit_digest_min_records', '1', 'ส่ง digest เฉพาะเมื่อมีอย่างน้อย N รายการ'],
            ['kpi_audit_last_digest_at', '', 'เวลาที่ส่ง digest ล่าสุด'],
            ['kpi_audit_last_digest_result', '', 'ผลลัพธ์ digest ล่าสุด (JSON)']
        ];
        for (const [k, v, d] of auditDefaults) {
            try { await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?,?,?)', [k, v, d]); } catch (e) {}
        }

        // === Performance Indexes สำหรับ high-concurrency ===
        // เพิ่ม index ที่ขาดสำหรับ query ที่ hit ถี่ (login, dashboard, dept filter)
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)'); } catch (e) {}
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_users_cid ON users(cid)'); } catch (e) {}
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_users_dept_role ON users(dept_id, role)'); } catch (e) {}
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_chospital_distid ON chospital(distid)'); } catch (e) {}
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_kpi_results_lookup ON kpi_results(indicator_id, year_bh, hospcode)'); } catch (e) {}
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_kpi_indicators_dept ON kpi_indicators(dept_id)'); } catch (e) {}
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_kpi_summary_lookup ON kpi_summary(indicator_id, year_bh, hospcode)'); } catch (e) {}
        try { await db.query('CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read)'); } catch (e) {}

        // Phase 2: backup schedules
        await db.query(`
            CREATE TABLE IF NOT EXISTS backup_schedules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                is_enabled TINYINT(1) DEFAULT 1,
                connection_id INT NOT NULL,
                days_of_week VARCHAR(20) NOT NULL,
                time_of_day VARCHAR(5) NOT NULL,
                compress TINYINT(1) DEFAULT 1,
                retention_days INT DEFAULT 30,
                notify_email TINYINT(1) DEFAULT 0,
                notify_email_on_success TINYINT(1) DEFAULT 1,
                notify_email_on_failure TINYINT(1) DEFAULT 1,
                notify_telegram TINYINT(1) DEFAULT 0,
                notify_telegram_on_success TINYINT(1) DEFAULT 1,
                notify_telegram_on_failure TINYINT(1) DEFAULT 1,
                last_run_at DATETIME NULL,
                last_status VARCHAR(30) NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_enabled (is_enabled, time_of_day),
                INDEX idx_conn (connection_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS backup_schedule_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                schedule_id INT NOT NULL,
                schedule_name VARCHAR(150) NULL,
                run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status ENUM('success','failed','skipped') NOT NULL,
                job_id INT NULL,
                file_id INT NULL,
                file_name VARCHAR(255) NULL,
                size_bytes BIGINT NULL,
                total_inserts INT NULL,
                tables_count INT NULL,
                duration_ms INT NULL,
                cleaned_up_files INT DEFAULT 0,
                cleaned_up_bytes BIGINT DEFAULT 0,
                notified_email TINYINT(1) DEFAULT 0,
                notified_telegram TINYINT(1) DEFAULT 0,
                notified_line TINYINT(1) DEFAULT 0,
                warnings TEXT NULL,
                error_msg TEXT NULL,
                INDEX idx_schedule (schedule_id),
                INDEX idx_run (run_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // backup LINE notification (auto-migrate for existing DBs)
        try { await db.query('ALTER TABLE backup_schedules ADD COLUMN notify_line TINYINT(1) DEFAULT 0'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_schedules ADD COLUMN notify_line_on_success TINYINT(1) DEFAULT 1'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_schedules ADD COLUMN notify_line_on_failure TINYINT(1) DEFAULT 1'); } catch (e) {}
        try { await db.query('ALTER TABLE backup_schedule_logs ADD COLUMN notified_line TINYINT(1) DEFAULT 0'); } catch (e) {}

        // เพิ่ม default connection (Local) ถ้ายังไม่มี
        const [defRows] = await db.query('SELECT COUNT(*) AS c FROM backup_connections');
        if (defRows[0].c === 0) {
            const localPwEnc = bkEncrypt(process.env.DB_PASSWORD || '');
            await db.query(
                `INSERT INTO backup_connections (name, host, port, db_user, db_password_enc, db_name, description, is_default, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                    'Local KPI DB',
                    process.env.DB_HOST || 'host.docker.internal',
                    Number(process.env.DB_PORT) || 3306,
                    process.env.DB_USER || 'root',
                    localPwEnc,
                    process.env.DB_NAME || 'khups_kpi_db',
                    'Connection หลักของระบบ (auto-seeded)',
                    1,
                    null
                ]
            );
            console.log('[Backup] Seeded default Local connection');
        }
        console.log('[Backup] Tables ready, BACKUP_DIR:', BACKUP_DIR);
    } catch (e) {
        console.error('[Backup] Auto-migration failed:', e.message);
    }
})();

// Helper: ดึง connection พร้อม decrypt password
const getBackupConnection = async (id) => {
    const [rows] = await db.query('SELECT * FROM backup_connections WHERE id = ?', [id]);
    if (rows.length === 0) return null;
    const c = rows[0];
    c.db_password = bkDecrypt(c.db_password_enc);
    return c;
};

// Helper: sanitize filename
const sanitizeFilename = (s) => String(s || 'backup').replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 100);

// Helper: SHA-256 checksum stream
const sha256File = (filePath) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
});

// Helper: validate identifier (db name, etc.) — กัน injection
const isValidIdent = (s) => typeof s === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(s);

// Helper: กรอง stderr ที่เป็นแค่ warning (ไม่ใช่ error จริง) ของ MariaDB/MySQL client
// MariaDB 10.11+ มี warnings หลายตัวที่เขียนไปที่ stderr แต่ไม่ทำให้ command fail:
//   - "Deprecated program name. It will be removed..."
//   - "Using a password on the command line interface can be insecure"
//   - "WARNING: option --ssl-verify-server-cert is disabled..."
function cleanStderr(stderr) {
    if (!stderr) return '';
    const lines = stderr.split('\n').filter(line => {
        const l = line.trim();
        if (!l) return false;
        if (/Deprecated program name/i.test(l)) return false;
        if (/use ['"]?(mariadb|mariadb-dump)['"]?/i.test(l)) return false;
        if (/Using a password on the command line/i.test(l)) return false;
        if (/option --ssl-verify-server-cert is disabled/i.test(l)) return false;
        if (/insecure passwordless login/i.test(l)) return false;
        if (/^WARNING:/i.test(l) && !/error|fail/i.test(l)) return false;
        return true;
    });
    return lines.join('\n').trim();
}

// Helper: รวม args สำหรับ connect (ตัด SSL warning + auth)
function buildConnectArgs(conn) {
    return [`-h${conn.host}`, `-P${conn.port}`, `-u${conn.db_user}`, ...MARIADB_COMMON_ARGS];
}

// Helper: query table list + size + rows via spawn mysql client (รองรับทุก connection)
async function listDbTables(conn, dbName) {
    const sql = `SELECT table_name, table_type, IFNULL(table_rows, 0), IFNULL(data_length, 0), IFNULL(index_length, 0) ` +
                `FROM INFORMATION_SCHEMA.TABLES WHERE table_schema = '${dbName.replace(/'/g, "''")}' ORDER BY table_name`;
    const args = [...buildConnectArgs(conn), '-N', '-B', '-e', sql];
    const env = { ...process.env };
    if (conn.db_password) env.MYSQL_PWD = conn.db_password;
    return new Promise((resolve, reject) => {
        const p = spawn(MYSQL_BIN, args, { env });
        let out = '', err = '';
        p.stdout.on('data', d => out += d.toString());
        p.stderr.on('data', d => err += d.toString());
        p.on('error', reject);
        p.on('close', code => {
            if (code !== 0) return reject(new Error(cleanStderr(err) || `mysql exit ${code}`));
            const tables = out.split('\n').filter(Boolean).map(line => {
                const parts = line.split('\t');
                return {
                    name: parts[0],
                    type: parts[1] || 'BASE TABLE',
                    rows: parseInt(parts[2]) || 0,
                    size_bytes: (parseInt(parts[3]) || 0) + (parseInt(parts[4]) || 0)
                };
            });
            resolve(tables);
        });
    });
}

// Helper: ตรวจสอบ privilege ของ user — ทดสอบ SELECT จากตารางจริง + อ่าน SHOW GRANTS
async function verifyBackupPrivileges(conn) {
    const env = { ...process.env };
    if (conn.db_password) env.MYSQL_PWD = conn.db_password;

    // 1. ลิสต์ตาราง — ถ้า list ไม่ได้แสดงว่าไม่มีสิทธิ์ INFORMATION_SCHEMA หรือ DB ไม่มีจริง
    let tables;
    try {
        tables = await listDbTables(conn, conn.db_name);
    } catch (e) {
        return { ok: false, error: `อ่าน INFORMATION_SCHEMA ไม่ได้: ${e.message}` };
    }
    if (tables.length === 0) {
        return { ok: false, error: `Database "${conn.db_name}" ว่างเปล่าหรือไม่มีสิทธิ์เห็นตาราง` };
    }
    const baseTables = tables.filter(t => t.type === 'BASE TABLE');
    if (baseTables.length === 0) {
        return { ok: true, warning: 'DB มีแต่ VIEW ไม่มี BASE TABLE — backup จะได้ schema views', tables_count: tables.length };
    }

    // 2. ทดสอบ SELECT จากตารางที่มี row > 0 (ถ้าไม่มี ใช้ตารางแรก) — ยืนยันสิทธิ์ SELECT
    const sample = baseTables.find(t => t.rows > 0) || baseTables[0];
    const selectSql = `SELECT 1 FROM \`${conn.db_name}\`.\`${sample.name}\` LIMIT 1`;
    const selectResult = await new Promise((resolve) => {
        const args = [...buildConnectArgs(conn), '-N', '-B', '-e', selectSql];
        const p = spawn(MYSQL_BIN, args, { env });
        let err = '';
        p.stderr.on('data', d => err += d.toString());
        p.on('error', () => resolve({ ok: false, error: 'spawn mysql ล้มเหลว' }));
        p.on('close', code => {
            if (code === 0) resolve({ ok: true });
            else resolve({ ok: false, error: `SELECT จากตาราง ${sample.name} ล้มเหลว: ${cleanStderr(err).slice(0, 300)}` });
        });
    });
    if (!selectResult.ok) {
        return { ok: false, error: `User '${conn.db_user}' ไม่มีสิทธิ์ SELECT — ${selectResult.error}`, sample_table: sample.name };
    }

    // 3. อ่าน SHOW GRANTS เพื่อดู privilege แบบ raw
    const grants = await new Promise((resolve) => {
        const args = [...buildConnectArgs(conn), '-N', '-B', '-e', 'SHOW GRANTS FOR CURRENT_USER()'];
        const p = spawn(MYSQL_BIN, args, { env });
        let out = '', err = '';
        p.stdout.on('data', d => out += d.toString());
        p.stderr.on('data', d => err += d.toString());
        p.on('error', () => resolve([]));
        p.on('close', code => code === 0 ? resolve(out.trim().split('\n').filter(Boolean)) : resolve([]));
    });

    // หา grant ที่ระบุ DB นี้
    const dbName = conn.db_name;
    const grantOnDb = grants.find(g =>
        g.includes(`\`${dbName}\``) || g.includes(` *.*`) || g.match(/ALL PRIVILEGES ON/i)
    );

    return {
        ok: true,
        tables_count: tables.length,
        base_tables: baseTables.length,
        rows_in_sample: sample.rows,
        sample_table: sample.name,
        grants,
        grant_on_db: grantOnDb || null,
        has_full_access: grants.some(g => /ALL PRIVILEGES ON \*\.\*/i.test(g) || new RegExp(`ALL PRIVILEGES ON \`${dbName}\``, 'i').test(g))
    };
}

// Helper: count rows accurately (สำหรับ restore verification)
async function countTableRows(conn, dbName, tableName) {
    if (!isValidIdent(tableName)) return -1;
    const sql = `SELECT COUNT(*) FROM \\\`${dbName}\\\`.\\\`${tableName}\\\``;
    const args = [...buildConnectArgs(conn), '-N', '-B', '-e', sql];
    const env = { ...process.env };
    if (conn.db_password) env.MYSQL_PWD = conn.db_password;
    return new Promise((resolve) => {
        const p = spawn(MYSQL_BIN, args, { env });
        let out = '';
        p.stdout.on('data', d => out += d.toString());
        p.on('error', () => resolve(-1));
        p.on('close', () => resolve(parseInt(out.trim()) || 0));
    });
}

// Helper: format log file content
function buildBackupLog(meta, tables) {
    const totalRows = tables.reduce((s, t) => s + t.rows, 0);
    const totalSize = tables.reduce((s, t) => s + t.size_bytes, 0);
    const fmtBytes = (b) => {
        if (!b) return '0 B';
        const k = 1024, units = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(b)/Math.log(k));
        return (b/Math.pow(k,i)).toFixed(2) + ' ' + units[i];
    };
    const lines = [];
    lines.push('='.repeat(80));
    lines.push(`  KPI DATABASE BACKUP LOG`);
    lines.push('='.repeat(80));
    lines.push(`File         : ${meta.file_name}`);
    lines.push(`Database     : ${meta.db_name}`);
    lines.push(`Connection   : ${meta.conn_name} (${meta.conn_host}:${meta.conn_port})`);
    lines.push(`Started      : ${meta.started_at}`);
    lines.push(`Finished     : ${meta.finished_at}`);
    lines.push(`Duration     : ${(meta.duration_ms/1000).toFixed(2)} seconds`);
    lines.push(`Output Size  : ${fmtBytes(meta.output_size)}  (compressed: ${meta.compressed ? 'yes (gzip)' : 'no'})`);
    lines.push(`Checksum     : ${meta.checksum || '-'}`);
    lines.push(`Status       : ${meta.status}`);
    lines.push(`Trigger      : ${meta.trigger_type}`);
    lines.push(`By User ID   : ${meta.user_id || '-'}`);
    lines.push('');
    lines.push('TABLES IN SOURCE DATABASE (snapshot at backup time):');
    lines.push('-'.repeat(95));
    lines.push('  #   Status   Name                                  Type            Rows         Size   INSERTs');
    lines.push('-'.repeat(95));
    const sorted = [...tables].sort((a,b) => a.name.localeCompare(b.name));
    sorted.forEach((t, i) => {
        const idx = String(i+1).padStart(3, ' ');
        const status = t.type === 'BASE TABLE' ? '  [OK]  ' : '  [VW]  ';
        const name = (t.name || '').padEnd(38, ' ').slice(0, 38);
        const type = (t.type || '').padEnd(15, ' ').slice(0, 15);
        const rows = String(t.rows.toLocaleString('en-US')).padStart(12, ' ');
        const size = fmtBytes(t.size_bytes).padStart(12, ' ');
        // INSERT count (ถ้ามี — มากับ meta.insertsByTable)
        let insertStr = '';
        if (meta.insertsByTable) {
            const ic = meta.insertsByTable[t.name] || 0;
            if (t.type !== 'BASE TABLE') insertStr = '       -';
            else if (ic === 0 && t.rows > 0) insertStr = `   0 [!]`; // ตารางมีข้อมูลแต่ไม่เจอ INSERT — น่าสงสัย
            else insertStr = String(ic).padStart(8, ' ');
        }
        lines.push(` ${idx}  ${status} ${name} ${type} ${rows}  ${size} ${insertStr}`);
    });
    lines.push('-'.repeat(95));
    const baseTables = sorted.filter(t => t.type === 'BASE TABLE').length;
    const views = sorted.length - baseTables;
    lines.push(`Total: ${sorted.length} objects (${baseTables} tables, ${views} views), ${totalRows.toLocaleString('en-US')} rows, ${fmtBytes(totalSize)}`);
    if (meta.totalInserts !== undefined) {
        lines.push(`Total INSERT statements in dump: ${meta.totalInserts.toLocaleString('en-US')}`);
    }
    if (meta.warnings && meta.warnings.length) {
        lines.push('');
        lines.push('!!! WARNINGS !!!');
        meta.warnings.forEach(w => lines.push('  - ' + w));
    }
    lines.push('='.repeat(95));
    lines.push('Legend: [OK] = BASE TABLE   [VW] = VIEW   [!] = ตารางมีข้อมูลในต้นทาง แต่ไม่พบ INSERT ในไฟล์');
    return lines.join('\n');
}

function buildRestoreLog(meta, sourceTables, targetTables) {
    const fmtBytes = (b) => {
        if (!b) return '0 B';
        const k = 1024, units = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(b)/Math.log(k));
        return (b/Math.pow(k,i)).toFixed(2) + ' ' + units[i];
    };
    const lines = [];
    lines.push('='.repeat(80));
    lines.push(`  KPI DATABASE RESTORE LOG`);
    lines.push('='.repeat(80));
    lines.push(`Source File   : ${meta.source_file}`);
    lines.push(`Source DB     : ${meta.source_db}`);
    lines.push(`Target DB     : ${meta.target_db}`);
    lines.push(`Mode          : ${meta.mode}`);
    lines.push(`Started       : ${meta.started_at}`);
    lines.push(`Finished      : ${meta.finished_at}`);
    lines.push(`Duration      : ${(meta.duration_ms/1000).toFixed(2)} seconds`);
    lines.push(`Status        : ${meta.status}`);
    lines.push(`Pre-Backup ID : ${meta.pre_backup_file_id || '-'}`);
    lines.push(`By User ID    : ${meta.user_id || '-'}`);
    lines.push('');
    lines.push('VERIFICATION (target DB after restore, actual COUNT(*) per table):');
    lines.push('-'.repeat(95));
    lines.push('  #   Status   Name                                  Type            Rows  Match');
    lines.push('-'.repeat(95));

    // Map source tables by name สำหรับ compare row counts
    const srcMap = new Map();
    (sourceTables || []).forEach(t => srcMap.set(t.name, t));

    // ใช้ targetTables เป็นหลัก (รวม source tables ที่หายไปด้วย)
    const allNames = new Set();
    (targetTables || []).forEach(t => allNames.add(t.name));
    (sourceTables || []).forEach(t => allNames.add(t.name));
    const allList = [...allNames].sort();

    let okCount = 0, missingCount = 0, mismatchCount = 0;
    const tgtMap = new Map();
    (targetTables || []).forEach(t => tgtMap.set(t.name, t));

    allList.forEach((name, i) => {
        const src = srcMap.get(name);
        const tgt = tgtMap.get(name);
        const idx = String(i+1).padStart(3, ' ');
        let status, matchStr;
        if (!tgt) {
            status = '  [XX]  ';
            matchStr = 'MISSING';
            missingCount++;
        } else {
            const srcRows = src ? src.rows : -1;
            const tgtRows = tgt.actual_rows !== undefined ? tgt.actual_rows : tgt.rows;
            if (src && srcRows !== tgtRows && Math.abs(srcRows - tgtRows) > Math.max(srcRows * 0.05, 1)) {
                status = '  [!!]  ';
                matchStr = `SOURCE:${srcRows.toLocaleString('en-US')}`;
                mismatchCount++;
            } else {
                status = '  [OK]  ';
                matchStr = 'OK';
                okCount++;
            }
        }
        const nameStr = name.padEnd(38, ' ').slice(0, 38);
        const type = (tgt?.type || src?.type || '-').padEnd(15, ' ').slice(0, 15);
        const rows = String(((tgt?.actual_rows !== undefined ? tgt.actual_rows : tgt?.rows) ?? 0).toLocaleString('en-US')).padStart(12, ' ');
        lines.push(` ${idx}  ${status} ${nameStr} ${type} ${rows}  ${matchStr}`);
    });
    lines.push('-'.repeat(95));
    lines.push(`Summary: ${okCount} OK, ${mismatchCount} row-count mismatch, ${missingCount} missing -- total ${allList.length} tables`);
    lines.push('='.repeat(95));
    lines.push('Legend: [OK] match   [!!] row count differs > 5%   [XX] missing from target');
    return lines.join('\n');
}

// แยกตัว worker เพื่อให้ reuse ได้ (ใช้กับ scheduler ใน Phase 2 ด้วย)
async function runBackupJob(jobId, conn, compress, trigger_type, userId, reqIp) {
    const startedAt = Date.now();
    try {

        // ตั้งชื่อไฟล์ (Bangkok timezone)
        const ts = bangkokTimestamp(new Date(), 'filename');
        const ext = compress ? '.sql.gz' : '.sql';
        const fileName = `${sanitizeFilename(conn.db_name)}_${sanitizeFilename(conn.name)}_${ts}${ext}`;
        const filePath = path.join(BACKUP_DIR, fileName);

        // spawn mysqldump → pipe (gzip optional) → file
        // หลีกเลี่ยง option ที่ไม่ universal: --column-statistics (MySQL 8 only), --events (อาจ permission issue)
        const dumpArgs = [
            ...buildConnectArgs(conn),
            '--single-transaction',
            '--quick',
            '--routines',
            '--triggers',
            '--default-character-set=utf8mb4',
            '--no-tablespaces',
            '--skip-add-locks',
            '--add-drop-table',
            conn.db_name
        ];
        const env = { ...process.env };
        if (conn.db_password) env.MYSQL_PWD = conn.db_password;

        // ตัวนับ progress — update backup_jobs.size_bytes ทุก 1 วินาที (frontend polling)
        let bytesWritten = 0;
        let lastProgressUpdate = 0;
        const updateProgress = async () => {
            const now = Date.now();
            if (now - lastProgressUpdate < 1000) return;
            lastProgressUpdate = now;
            try { await db.query('UPDATE backup_jobs SET size_bytes = ? WHERE id = ?', [bytesWritten, jobId]); } catch (_) {}
        };

        // ตัวนับ INSERT statements per-table (สแกนจาก stdout stream)
        const insertsByTable = {};
        let totalInserts = 0;
        let scanLeftover = '';
        const insertRegex = /^\s*INSERT INTO\s+[`"]?([a-zA-Z0-9_]+)[`"]?/gm;

        const { Transform } = require('stream');
        const insertScanner = new Transform({
            transform(chunk, enc, cb) {
                const text = scanLeftover + chunk.toString('utf8');
                let m;
                while ((m = insertRegex.exec(text)) !== null) {
                    const tbl = m[1];
                    insertsByTable[tbl] = (insertsByTable[tbl] || 0) + 1;
                    totalInserts++;
                }
                insertRegex.lastIndex = 0;
                scanLeftover = text.length > 500 ? text.slice(-500) : text;
                this.push(chunk);
                cb();
            }
        });

        const stderrFull = await new Promise((resolve, reject) => {
            let settled = false;
            const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(stderr); };
            let dump;
            try {
                dump = spawn(MYSQLDUMP_BIN, dumpArgs, { env });
            } catch (e) {
                return done(new Error(`spawn mysqldump ('${MYSQLDUMP_BIN}') failed: ${e.message}`));
            }
            const writeStream = fs.createWriteStream(filePath);
            let stderr = '';
            dump.stderr.on('data', (d) => stderr += d.toString());

            // ตามนับ bytes ที่เขียนจริงจาก dump.stdout (ก่อน gzip)
            dump.stdout.on('data', (chunk) => {
                bytesWritten += chunk.length;
                updateProgress();
            });

            let dumpClosed = false, dumpExitCode = null, streamFinished = false;
            const tryComplete = () => {
                if (!dumpClosed || !streamFinished) return;
                if (dumpExitCode === 0) {
                    if (bytesWritten === 0) {
                        done(new Error(`mysqldump เสร็จแล้ว แต่ไม่มีข้อมูลออกมา — stderr: ${stderr.trim().slice(0, 500) || '(empty)'}`));
                    } else { done(); }
                } else {
                    done(new Error(`mysqldump exit ${dumpExitCode}: ${stderr.trim().slice(0, 500) || '(no stderr)'}`));
                }
            };

            // pipe: dump.stdout → insertScanner → [gzip] → writeStream
            if (compress) {
                const gz = zlib.createGzip({ level: 6 });
                dump.stdout.pipe(insertScanner).pipe(gz).pipe(writeStream);
                gz.on('error', done);
            } else {
                dump.stdout.pipe(insertScanner).pipe(writeStream);
            }
            insertScanner.on('error', done);
            writeStream.on('error', done);
            writeStream.on('finish', () => { streamFinished = true; tryComplete(); });
            dump.on('close', (code) => { dumpClosed = true; dumpExitCode = code; tryComplete(); });
            dump.on('error', (e) => done(new Error(`spawn mysqldump ('${MYSQLDUMP_BIN}') failed: ${e.message}`)));
        });

        const stat = await fsp.stat(filePath);
        const checksum = await sha256File(filePath);
        const duration = Date.now() - startedAt;

        // === สร้าง backup log file (snapshot ตารางจาก source DB) ===
        let logPath = null;
        let sourceTables = [];
        let backupStatus = 'SUCCESS';
        const warnings = [];
        try {
            sourceTables = await listDbTables(conn, conn.db_name);
            // === Sanity check: ตารางมี data แต่ไม่มี INSERT ใน dump ===
            const tablesWithData = sourceTables.filter(t => t.type === 'BASE TABLE' && t.rows > 0);
            const missingInserts = tablesWithData.filter(t => !insertsByTable[t.name] || insertsByTable[t.name] === 0);
            if (tablesWithData.length > 0 && totalInserts === 0) {
                backupStatus = 'WARNING: SCHEMA ONLY';
                warnings.push(`Backup ไม่พบ INSERT statement เลย แต่ DB ต้นทางมีตาราง ${tablesWithData.length} ตารางที่มีข้อมูล — backup อาจเป็น schema-only (ตรวจสอบ privilege ของ user)`);
            } else if (missingInserts.length > 0) {
                backupStatus = 'WARNING: PARTIAL DATA';
                warnings.push(`มี ${missingInserts.length} ตารางที่มีข้อมูลแต่ไม่พบ INSERT statements: ${missingInserts.slice(0, 5).map(t => t.name).join(', ')}${missingInserts.length > 5 ? ' ...' : ''}`);
            }
            const logContent = buildBackupLog({
                file_name: fileName,
                db_name: conn.db_name,
                conn_name: conn.name,
                conn_host: conn.host,
                conn_port: conn.port,
                started_at: bangkokTimestamp(new Date(startedAt), 'log'),
                finished_at: bangkokTimestamp(new Date(), 'log'),
                duration_ms: duration,
                output_size: stat.size,
                compressed: !!compress,
                checksum,
                status: backupStatus,
                trigger_type,
                user_id: userId,
                totalInserts,
                insertsByTable,
                warnings
            }, sourceTables);
            logPath = filePath.replace(/\.sql(\.gz)?$/i, '') + '.backup_log.txt';
            await fsp.writeFile(logPath, logContent, 'utf8');
            console.log(`[Backup] job ${jobId} log written: ${logPath} (${totalInserts} INSERTs, status: ${backupStatus})`);
            if (warnings.length > 0) console.warn(`[Backup] job ${jobId} WARNINGS:`, warnings);
        } catch (e) {
            console.warn(`[Backup] job ${jobId} log generation failed:`, e.message);
        }

        // บันทึก backup_files (รวม log_path)
        const [fr] = await db.query(
            `INSERT INTO backup_files (connection_id, connection_name, db_name, file_path, file_name, size_bytes, compressed, checksum_sha256, trigger_type, created_by, log_path)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [conn.id, conn.name, conn.db_name, filePath, fileName, stat.size, compress ? 1 : 0, checksum, trigger_type, userId, logPath]
        );

        await db.query(
            `UPDATE backup_jobs SET status='success', finished_at=NOW(), duration_ms=?, size_bytes=?, file_id=? WHERE id=?`,
            [duration, stat.size, fr.insertId, jobId]
        );

        // ถ้า warning อย่างน้อย 1 — เก็บใน error_msg ของ job (ให้ UI เห็น) แม้ status='success'
        if (warnings.length > 0) {
            try { await db.query('UPDATE backup_jobs SET error_msg = ? WHERE id = ?',
                ['WARNING: ' + warnings.join(' | '), jobId]); } catch (_) {}
        }

        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [userId, 'BACKUP_RUN', 'backup_files', JSON.stringify({ file_name: fileName, size: stat.size, conn: conn.name, tables: sourceTables.length, total_inserts: totalInserts, warnings: warnings.length }), reqIp]); } catch (_) {}

        console.log(`[Backup] job ${jobId} ${backupStatus} — ${fileName} (${stat.size} bytes, ${duration}ms, ${sourceTables.length} tables, ${totalInserts} INSERTs)`);

        // LINE notify: backup สำเร็จ (เฉพาะ manual — schedule แจ้งผ่าน notifyBackupResult แล้ว)
        if (trigger_type === 'manual') {
            const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
            notifyLineAction('backup',
                `✅ Backup สำเร็จ (manual)\n` +
                `🔗 ${conn.name} → ${conn.db_name}\n` +
                `📦 ${fileName}\n` +
                `💾 ${sizeMB} MB | ${sourceTables.length} ตาราง | ${totalInserts.toLocaleString('en-US')} rows\n` +
                `⏱ ${(duration/1000).toFixed(1)} วินาที` +
                (warnings.length > 0 ? `\n⚠️ ${warnings.length} warning` : '')
            );
        }

        return { file_id: fr.insertId, file_name: fileName, size: stat.size, duration, tables: sourceTables.length, total_inserts: totalInserts, warnings };
    } catch (e) {
        const duration = Date.now() - startedAt;
        try { await db.query(`UPDATE backup_jobs SET status='failed', finished_at=NOW(), duration_ms=?, error_msg=? WHERE id=?`,
            [duration, e.message.slice(0, 2000), jobId]); } catch (_) {}
        console.error(`[Backup] job ${jobId} failed:`, e.message);
        // LINE notify: backup ล้มเหลว
        if (trigger_type === 'manual') {
            notifyLineAction('backup',
                `❌ Backup ล้มเหลว (manual)\n` +
                `🔗 ${conn.name} → ${conn.db_name}\n` +
                `⏱ ${(duration/1000).toFixed(1)} วินาที\n` +
                `💢 ${(e.message || '').slice(0, 200)}`
            );
        }
        throw e;
    }
}

async function runRestoreJob(restoreJobId, f, conn, mode, dbTarget, auto_backup_first, userId, reqIp) {
    const { Transform } = require('stream');
    const startedAt = Date.now();
    try {
        // === replace mode: auto-backup ก่อนเสมอ (ถ้า flag เปิด) ===
        let preBackupFileId = null;
        if (mode === 'replace' && auto_backup_first) {
            await db.query("UPDATE restore_jobs SET phase = 'pre_backup' WHERE id = ?", [restoreJobId]);
            try {
                const ts2 = bangkokTimestamp(new Date(), 'filename');
                const preFileName = `${sanitizeFilename(conn.db_name)}_${sanitizeFilename(conn.name)}_PRE_RESTORE_${ts2}.sql.gz`;
                const preFilePath = path.join(BACKUP_DIR, preFileName);
                const dumpArgs = [...buildConnectArgs(conn),
                    '--single-transaction', '--quick', '--routines', '--triggers',
                    '--default-character-set=utf8mb4', '--no-tablespaces',
                    '--skip-add-locks', '--add-drop-table',
                    conn.db_name];
                const env = { ...process.env };
                if (conn.db_password) env.MYSQL_PWD = conn.db_password;
                await new Promise((resolve, reject) => {
                    let settled = false;
                    const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
                    let dump;
                    try { dump = spawn(MYSQLDUMP_BIN, dumpArgs, { env }); }
                    catch (e) { return done(new Error(`spawn mysqldump failed: ${e.message}`)); }
                    const ws = fs.createWriteStream(preFilePath);
                    const gz = zlib.createGzip({ level: 6 });
                    let stderr = '';
                    dump.stderr.on('data', d => stderr += d.toString());
                    dump.stdout.pipe(gz).pipe(ws);
                    ws.on('finish', () => dump.on('close', (code) =>
                        code === 0 ? done() : done(new Error(`pre-backup mysqldump exited ${code}: ${stderr.slice(0,300)}`))));
                    ws.on('error', done);
                    gz.on('error', done);
                    dump.on('error', done);
                });
                const st = await fsp.stat(preFilePath);
                const ck = await sha256File(preFilePath);
                const [pfr] = await db.query(
                    `INSERT INTO backup_files (connection_id, connection_name, db_name, file_path, file_name, size_bytes, compressed, checksum_sha256, trigger_type, created_by)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [conn.id, conn.name, conn.db_name, preFilePath, preFileName, st.size, 1, ck, 'auto_before_restore', userId]
                );
                preBackupFileId = pfr.insertId;
                await db.query('UPDATE restore_jobs SET pre_backup_file_id = ? WHERE id = ?', [preBackupFileId, restoreJobId]);
            } catch (e) {
                throw new Error('auto-backup ก่อน restore ล้มเหลว: ' + e.message);
            }
        }

        // === สร้าง / drop+create DB ปลายทาง ===
        await db.query("UPDATE restore_jobs SET phase = 'preparing_db' WHERE id = ?", [restoreJobId]);
        const adminBase = [...buildConnectArgs(conn), '-e'];
        const env = { ...process.env };
        if (conn.db_password) env.MYSQL_PWD = conn.db_password;
        const runMysql = (sql) => new Promise((resolve, reject) => {
            let settled = false;
            const done = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
            let p;
            try { p = spawn(MYSQL_BIN, [...adminBase, sql], { env }); }
            catch (e) { return done(new Error(`spawn mysql failed: ${e.message}`)); }
            let stderr = '';
            p.stderr.on('data', d => stderr += d.toString());
            p.on('close', code => {
                const cleaned = cleanStderr(stderr);
                if (code === 0) {
                    // success — log warnings ที่ stderr (deprecated, ssl) เพื่อ debug
                    if (cleaned) console.warn(`[Restore] runMysql warnings:`, cleaned.slice(0, 200));
                    done();
                } else {
                    done(new Error(`mysql exit ${code}: ${cleaned.slice(0, 500) || '(no error message)'}`));
                }
            });
            p.on('error', done);
        });

        try {
            if (mode === 'new_db') {
                await runMysql(`CREATE DATABASE IF NOT EXISTS \`${dbTarget}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            } else {
                // แยกเป็น 2 statement (บาง MariaDB version handle multi-statement ที่ -e ไม่ดี)
                await runMysql(`DROP DATABASE IF EXISTS \`${dbTarget}\``);
                await runMysql(`CREATE DATABASE \`${dbTarget}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            }
        } catch (e) {
            // แปลง error message ให้เข้าใจง่าย ถ้าเป็น privilege issue
            const msg = (e.message || '').toLowerCase();
            if (msg.includes('access denied') || msg.includes('1044') || msg.includes('1045')) {
                throw new Error(`User '${conn.db_user}' ไม่มีสิทธิ์ CREATE/DROP DATABASE — ต้องใช้ user ที่มี GRANT CREATE,DROP ON *.* (เช่น root) | original: ${e.message}`);
            }
            throw e;
        }

        // === Restore: ส่ง SQL ผ่าน Transform stream — นับ bytes อย่างเดียว (เบา ไม่บล็อก event loop) ===
        // ไม่ทำ chunk.toString()/regex ใน hot path (เคยทำให้ Node ค้าง → nginx 502 ตอน restore ไฟล์ใหญ่)
        // จำนวนตาราง (tables_count) จะมาจากขั้น verification ตอนจบแทน
        await db.query("UPDATE restore_jobs SET phase = 'restoring' WHERE id = ?", [restoreJobId]);
        let bytesRead = 0;
        let lastUpdate = 0;

        // นับ compressed bytes (วางก่อน gunzip) → ตรงกับ total_bytes = ขนาดไฟล์ → % แม่นยำ
        const progressMonitor = new Transform({
            transform(chunk, enc, cb) {
                bytesRead += chunk.length;
                const now = Date.now();
                if (now - lastUpdate > 1500) {
                    lastUpdate = now;
                    // fire-and-forget — ไม่ await กัน backpressure
                    db.query('UPDATE restore_jobs SET progress_bytes = ? WHERE id = ?', [bytesRead, restoreJobId]).catch(() => {});
                }
                this.push(chunk);
                cb();
            }
        });

        await new Promise((resolve, reject) => {
            let settled = false;
            const doneP = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); };
            let mysqlProc;
            try { mysqlProc = spawn(MYSQL_BIN, [...buildConnectArgs(conn), dbTarget], { env }); }
            catch (e) { return doneP(new Error(`spawn mysql failed: ${e.message}`)); }
            let mysqlErr = '';
            mysqlProc.stderr.on('data', d => { if (mysqlErr.length < 8000) mysqlErr += d.toString(); });

            // *** สำคัญ: จับ error ของ stdin — ถ้า mysql จบก่อน (เจอ error ใน SQL) ขณะยัง pipe อยู่
            // จะเกิด EPIPE/ECONNRESET ที่ stdin — ถ้าไม่จับ Node จะ crash ทั้ง process (= 502) ***
            mysqlProc.stdin.on('error', (e) => {
                // EPIPE = mysql ปิด stdin ไปแล้ว (มักเพราะ exit ด้วย error) — ปล่อยให้ 'close' รายงาน exit code จริง
                if (e && e.code !== 'EPIPE') console.warn('[Restore] stdin error:', e.code || e.message);
            });

            const fileStream = fs.createReadStream(f.file_path);
            // ใช้ try/catch รอบ pipe กัน throw sync
            try {
                if (f.compressed) {
                    const gunzip = zlib.createGunzip();
                    gunzip.on('error', doneP);
                    fileStream.pipe(progressMonitor).pipe(gunzip).pipe(mysqlProc.stdin);
                } else {
                    fileStream.pipe(progressMonitor).pipe(mysqlProc.stdin);
                }
            } catch (e) { return doneP(new Error(`pipe error: ${e.message}`)); }

            fileStream.on('error', doneP);
            progressMonitor.on('error', doneP);
            mysqlProc.on('close', code => {
                const cleaned = cleanStderr(mysqlErr);
                if (code === 0) {
                    if (cleaned) console.warn(`[Restore] stream warnings:`, cleaned.slice(0, 200));
                    doneP();
                } else {
                    doneP(new Error(`mysql restore exit ${code}: ${cleaned.slice(0, 500) || '(no error)'}`));
                }
            });
            mysqlProc.on('error', doneP);
        });

        const duration = Date.now() - startedAt;

        // === Verification: query target DB จริงเพื่อยืนยันว่ามีตารางอะไรบ้าง + นับ row จริง ===
        await db.query("UPDATE restore_jobs SET phase = 'verifying' WHERE id = ?", [restoreJobId]);
        let targetTables = [];
        let sourceTables = [];
        try {
            targetTables = await listDbTables(conn, dbTarget);
            // นับ row จริง (COUNT(*)) ของแต่ละ BASE TABLE ใน target — แม่นกว่า table_rows ของ InnoDB
            for (const t of targetTables) {
                if (t.type === 'BASE TABLE') {
                    t.actual_rows = await countTableRows(conn, dbTarget, t.name);
                } else {
                    t.actual_rows = 0;
                }
            }
            // ถ้า source DB ยังอยู่ใน connection เดียวกัน — เทียบได้
            try { sourceTables = await listDbTables(conn, f.db_name); } catch (_) { sourceTables = []; }
        } catch (e) {
            console.warn(`[Restore] job ${restoreJobId} verification failed:`, e.message);
        }

        // === เขียน restore log file ===
        let logPath = null;
        try {
            const logContent = buildRestoreLog({
                source_file: f.file_name,
                source_db: f.db_name,
                target_db: dbTarget,
                mode,
                started_at: bangkokTimestamp(new Date(startedAt), 'log'),
                finished_at: bangkokTimestamp(new Date(), 'log'),
                duration_ms: duration,
                status: 'SUCCESS',
                pre_backup_file_id: preBackupFileId,
                user_id: userId
            }, sourceTables, targetTables);
            logPath = path.join(BACKUP_DIR, `restore_${restoreJobId}_${dbTarget}.restore_log.txt`);
            await fsp.writeFile(logPath, logContent, 'utf8');
            console.log(`[Restore] job ${restoreJobId} log written: ${logPath}`);
        } catch (e) {
            console.warn(`[Restore] job ${restoreJobId} log write failed:`, e.message);
        }

        const verifiedCount = targetTables.filter(t => t.type === 'BASE TABLE').length;
        await db.query(
            `UPDATE restore_jobs SET status='success', finished_at=NOW(), duration_ms=?, progress_bytes=?, tables_count=?, current_table=NULL, phase='done', log_path=? WHERE id=?`,
            [duration, bytesRead, verifiedCount, logPath, restoreJobId]
        );
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [userId, 'BACKUP_RESTORE', 'backup_files',
             JSON.stringify({ file_id: f.id, file_name: f.file_name, mode, target_db: dbTarget, pre_backup_file_id: preBackupFileId, tables: verifiedCount, duration_ms: duration }),
             reqIp]); } catch (_) {}
        console.log(`[Restore] job ${restoreJobId} success — verified:${verifiedCount} tables, ${duration}ms`);
        // LINE notify: restore สำเร็จ
        notifyLineAction('restore',
            `✅ Restore สำเร็จ\n` +
            `📦 ${f.file_name}\n` +
            `🎯 → ${dbTarget} (${mode})\n` +
            `📊 ${verifiedCount} ตาราง verified\n` +
            `⏱ ${(duration/1000).toFixed(1)} วินาที` +
            (preBackupFileId ? `\n🛡️ Pre-backup: file_id ${preBackupFileId}` : '')
        );
    } catch (e) {
        const duration = Date.now() - startedAt;
        try { await db.query(`UPDATE restore_jobs SET status='failed', finished_at=NOW(), duration_ms=?, error_msg=? WHERE id=?`,
            [duration, e.message.slice(0, 2000), restoreJobId]); } catch (_) {}
        console.error(`[Restore] job ${restoreJobId} failed:`, e.message);
        // LINE notify: restore ล้มเหลว
        notifyLineAction('restore',
            `❌ Restore ล้มเหลว\n` +
            `📦 ${f.file_name}\n` +
            `🎯 → ${dbTarget} (${mode})\n` +
            `⏱ ${(duration/1000).toFixed(1)} วินาที\n` +
            `💢 ${(e.message || '').slice(0, 200)}`
        );
        throw e;
    }
}

// ========================================================================
// ============== Phase 2: Backup Scheduler + Notifications ===============
// ========================================================================

// === Notification helper สำหรับ backup scheduler ===
async function notifyBackupResult(schedule, result) {
    const ns = await getNotifSettings();
    const wantEmail = schedule.notify_email && (
        (result.status === 'success' && schedule.notify_email_on_success) ||
        (result.status === 'failed' && schedule.notify_email_on_failure)
    );
    const wantTg = schedule.notify_telegram && (
        (result.status === 'success' && schedule.notify_telegram_on_success) ||
        (result.status === 'failed' && schedule.notify_telegram_on_failure)
    );
    const wantLn = schedule.notify_line && (
        (result.status === 'success' && (schedule.notify_line_on_success === undefined ? true : schedule.notify_line_on_success)) ||
        (result.status === 'failed' && (schedule.notify_line_on_failure === undefined ? true : schedule.notify_line_on_failure))
    );
    if (!wantEmail && !wantTg && !wantLn) return { sent_email: false, sent_telegram: false, sent_line: false };

    const fmtBytes = (b) => {
        if (!b) return '0 B';
        const k = 1024, units = ['B','KB','MB','GB','TB'];
        const i = Math.floor(Math.log(b)/Math.log(k));
        return (b/Math.pow(k,i)).toFixed(2) + ' ' + units[i];
    };
    const icon = result.status === 'success' ? '✅' : '❌';
    const subject = `${icon} Backup ${result.status === 'success' ? 'สำเร็จ' : 'ล้มเหลว'} — ${schedule.name}`;

    // HTML email body
    let html = `<h3>${icon} Backup ${result.status === 'success' ? 'สำเร็จ' : 'ล้มเหลว'}</h3>`;
    html += `<table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">`;
    html += `<tr><td style="padding:4px 12px 4px 0;color:#666">Schedule:</td><td><b>${schedule.name}</b></td></tr>`;
    html += `<tr><td style="padding:4px 12px 4px 0;color:#666">Connection:</td><td>${result.connection_name || '-'}</td></tr>`;
    html += `<tr><td style="padding:4px 12px 4px 0;color:#666">Database:</td><td><code>${result.db_name || '-'}</code></td></tr>`;
    html += `<tr><td style="padding:4px 12px 4px 0;color:#666">เวลา:</td><td>${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</td></tr>`;
    if (result.status === 'success') {
        html += `<tr><td style="padding:4px 12px 4px 0;color:#666">ไฟล์:</td><td><code>${result.file_name}</code></td></tr>`;
        html += `<tr><td style="padding:4px 12px 4px 0;color:#666">ขนาด:</td><td><b>${fmtBytes(result.size_bytes)}</b></td></tr>`;
        html += `<tr><td style="padding:4px 12px 4px 0;color:#666">ตาราง:</td><td>${result.tables_count || 0} ตาราง</td></tr>`;
        html += `<tr><td style="padding:4px 12px 4px 0;color:#666">INSERTs:</td><td>${(result.total_inserts || 0).toLocaleString('en-US')}</td></tr>`;
        html += `<tr><td style="padding:4px 12px 4px 0;color:#666">ใช้เวลา:</td><td>${((result.duration_ms || 0)/1000).toFixed(1)} วินาที</td></tr>`;
        if (result.cleaned_up_files > 0) {
            html += `<tr><td style="padding:4px 12px 4px 0;color:#666">ลบเก่า:</td><td>${result.cleaned_up_files} ไฟล์ (${fmtBytes(result.cleaned_up_bytes)})</td></tr>`;
        }
        if (result.warnings && result.warnings.length > 0) {
            html += `<tr><td colspan="2" style="padding:8px 0;color:#f59e0b"><b>⚠️ คำเตือน:</b><br>${result.warnings.map(w => `• ${w}`).join('<br>')}</td></tr>`;
        }
    } else {
        html += `<tr><td style="padding:4px 12px 4px 0;color:#666">Error:</td><td style="color:#dc2626"><code>${(result.error_msg || '').slice(0, 500)}</code></td></tr>`;
    }
    html += `</table>`;

    // Telegram message (plain text)
    let tg = `${icon} <b>Backup ${result.status === 'success' ? 'สำเร็จ' : 'ล้มเหลว'}</b>\n`;
    tg += `📋 ${schedule.name}\n`;
    tg += `🔗 ${result.connection_name || '-'} → <code>${result.db_name || '-'}</code>\n`;
    tg += `🕐 ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}\n`;
    if (result.status === 'success') {
        tg += `📦 ${result.file_name}\n`;
        tg += `💾 ${fmtBytes(result.size_bytes)} (${result.tables_count || 0} ตาราง, ${(result.total_inserts || 0).toLocaleString('en-US')} INSERTs)\n`;
        tg += `⏱ ${((result.duration_ms || 0)/1000).toFixed(1)}s`;
        if (result.cleaned_up_files > 0) tg += `\n🗑 ลบเก่า ${result.cleaned_up_files} ไฟล์`;
        if (result.warnings && result.warnings.length > 0) {
            tg += `\n⚠️ ${result.warnings[0]}`;
        }
    } else {
        tg += `❌ ${(result.error_msg || '').slice(0, 300)}`;
    }

    let sent_email = false, sent_telegram = false, sent_line = false;
    if (wantEmail && ns.adminEmails) {
        const emails = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of emails) {
            try { await sendMail(email, subject, html); sent_email = true; } catch (e) {}
        }
    }
    if (wantTg && ns.tgToken && ns.tgChatId) {
        try { sent_telegram = await sendTelegramDirect(ns.tgToken, ns.tgChatId, tg); } catch (e) {}
    }
    if (wantLn && ns.lineToken && ns.lineGroupId) {
        try { const r = await sendLineMulticast(ns.lineToken, ns.lineGroupId, tg); sent_line = r.sent > 0; } catch (e) {}
    }
    return { sent_email, sent_telegram, sent_line };
}

// === Retention cleanup — ลบ backup เก่ากว่า retention_days ของ schedule ===
async function cleanupOldBackups(connectionId, retentionDays) {
    if (!retentionDays || retentionDays <= 0) return { files: 0, bytes: 0 };
    try {
        const [rows] = await db.query(
            `SELECT id, file_path, log_path, size_bytes FROM backup_files
             WHERE connection_id = ? AND trigger_type = 'scheduled'
             AND created_at < NOW() - INTERVAL ? DAY`,
            [connectionId, retentionDays]
        );
        let deletedFiles = 0;
        let deletedBytes = 0;
        for (const f of rows) {
            try { if (f.file_path && fs.existsSync(f.file_path)) await fsp.unlink(f.file_path); } catch (_) {}
            try { if (f.log_path && fs.existsSync(f.log_path)) await fsp.unlink(f.log_path); } catch (_) {}
            await db.query('DELETE FROM backup_files WHERE id = ?', [f.id]);
            deletedFiles++;
            deletedBytes += f.size_bytes || 0;
        }
        return { files: deletedFiles, bytes: deletedBytes };
    } catch (e) {
        console.error('[Scheduler] cleanup failed:', e.message);
        return { files: 0, bytes: 0, error: e.message };
    }
}

// === รัน backup ตาม schedule (เรียกจาก scheduler + manual run-now) ===
async function runScheduledBackup(schedule) {
    const startedAt = Date.now();
    const result = {
        schedule_id: schedule.id,
        schedule_name: schedule.name,
        status: 'failed',
        connection_name: null,
        db_name: null,
        job_id: null,
        file_id: null,
        file_name: null,
        size_bytes: 0,
        total_inserts: 0,
        tables_count: 0,
        duration_ms: 0,
        cleaned_up_files: 0,
        cleaned_up_bytes: 0,
        warnings: [],
        error_msg: null
    };
    try {
        const conn = await getBackupConnection(schedule.connection_id);
        if (!conn) throw new Error(`ไม่พบ connection #${schedule.connection_id}`);
        result.connection_name = conn.name;
        result.db_name = conn.db_name;

        // สร้าง backup_jobs record + รัน worker
        const [r] = await db.query(
            `INSERT INTO backup_jobs (connection_id, connection_name, db_name, status, trigger_type, started_at, created_by)
             VALUES (?,?,?, 'running', 'scheduled', NOW(), ?)`,
            [conn.id, conn.name, conn.db_name, schedule.created_by || null]
        );
        const jobId = r.insertId;
        result.job_id = jobId;

        const r2 = await runBackupJob(jobId, conn, !!schedule.compress, 'scheduled', schedule.created_by || null, '127.0.0.1');
        result.file_id = r2.file_id;
        result.file_name = r2.file_name;
        result.size_bytes = r2.size;
        result.total_inserts = r2.total_inserts;
        result.tables_count = r2.tables;
        result.warnings = r2.warnings || [];

        // Retention cleanup หลัง backup สำเร็จ
        const cleanup = await cleanupOldBackups(conn.id, schedule.retention_days);
        result.cleaned_up_files = cleanup.files;
        result.cleaned_up_bytes = cleanup.bytes;

        // Auto upload to cloud (ถ้าเปิด)
        if (schedule.auto_upload_cloud) {
            try {
                const [bfRows] = await db.query('SELECT file_path, file_name FROM backup_files WHERE id = ?', [r2.file_id]);
                if (bfRows.length > 0) {
                    const cloudResult = await uploadFileToDrive(bfRows[0].file_path, bfRows[0].file_name);
                    await db.query(
                        'UPDATE backup_files SET cloud_provider=?, cloud_file_id=?, cloud_url=?, cloud_uploaded_at=NOW(), cloud_size_bytes=? WHERE id=?',
                        ['gdrive', cloudResult.file_id, cloudResult.web_url, cloudResult.size, r2.file_id]
                    );
                    result.cloud_url = cloudResult.web_url;
                    result.cloud_uploaded = true;
                    console.log(`[Scheduler] uploaded "${r2.file_name}" to Drive: ${cloudResult.web_url}`);
                }
            } catch (e) {
                console.error('[Scheduler] cloud upload failed:', e.message);
                result.warnings.push('Cloud upload failed: ' + e.message);
            }
        }

        result.status = 'success';
    } catch (e) {
        result.status = 'failed';
        result.error_msg = e.message;
        console.error(`[Scheduler] backup schedule "${schedule.name}" failed:`, e.message);
    }
    result.duration_ms = Date.now() - startedAt;

    // ส่ง notification
    const notif = await notifyBackupResult(schedule, result);

    // บันทึก schedule log
    try {
        await db.query(
            `INSERT INTO backup_schedule_logs
             (schedule_id, schedule_name, status, job_id, file_id, file_name, size_bytes, total_inserts, tables_count,
              duration_ms, cleaned_up_files, cleaned_up_bytes, notified_email, notified_telegram, notified_line, cloud_uploaded, cloud_url, warnings, error_msg)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [schedule.id, schedule.name, result.status, result.job_id, result.file_id, result.file_name,
             result.size_bytes, result.total_inserts, result.tables_count, result.duration_ms,
             result.cleaned_up_files, result.cleaned_up_bytes,
             notif.sent_email ? 1 : 0, notif.sent_telegram ? 1 : 0, notif.sent_line ? 1 : 0,
             result.cloud_uploaded ? 1 : 0, result.cloud_url || null,
             result.warnings.length ? JSON.stringify(result.warnings) : null,
             result.error_msg ? result.error_msg.slice(0, 2000) : null]
        );
        await db.query('UPDATE backup_schedules SET last_status = ? WHERE id = ?', [result.status, schedule.id]);
    } catch (e) {
        console.error('[Scheduler] log insert failed:', e.message);
    }

    return result;
}

// === Scheduler check loop (setInterval 30s) ===
// === Timezone-safe helpers (always Asia/Bangkok ไม่ว่า process.env.TZ จะถูกตั้งหรือไม่) ===
const BANGKOK_TZ = 'Asia/Bangkok';

const _bkkFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BANGKOK_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short'
});

function getBangkokTime(date = new Date()) {
    const parts = _bkkFormatter.formatToParts(date);
    const get = (t) => parts.find(p => p.type === t)?.value || '';
    const hour = get('hour') === '24' ? '00' : get('hour'); // Intl บางเวอร์ชันคืน 24
    const wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return {
        hhmm: `${hour}:${get('minute')}`,
        dow: wdMap[get('weekday')] || 1,
        date: `${get('year')}-${get('month')}-${get('day')}`,
        full: `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`
    };
}

// Bangkok timestamp ในรูปแบบต่างๆ — ใช้แทน new Date().toISOString() ทั้งระบบ backup
//  'compact'  → 20260519140555         (14 หลัก, ใช้ในชื่อ DB target)
//  'filename' → 2026-05-19T14-05-55    (19 chars, safe สำหรับชื่อไฟล์)
//  'log'      → 2026-05-19 14:05:55    (19 chars, สำหรับ log content)
function bangkokTimestamp(date = new Date(), format = 'filename') {
    const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: BANGKOK_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const parts = f.formatToParts(date);
    const g = (t) => parts.find(p => p.type === t)?.value || '';
    const h = g('hour') === '24' ? '00' : g('hour');
    const y = g('year'), mo = g('month'), d = g('day'), mi = g('minute'), s = g('second');
    if (format === 'compact')  return `${y}${mo}${d}${h}${mi}${s}`;
    if (format === 'log')      return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
    return `${y}-${mo}-${d}T${h}-${mi}-${s}`; // 'filename' (default)
}

function startBackupScheduler() {
    const pad2 = (n) => String(n).padStart(2, '0');
    const check = async () => {
        try {
            const now = new Date();
            const bkk = getBangkokTime(now);
            const hhmmNow = bkk.hhmm;
            const prev = new Date(now.getTime() - 60 * 1000);
            const hhmmPrev = getBangkokTime(prev).hhmm;
            const dow = bkk.dow;

            const [schedules] = await db.query(
                `SELECT * FROM backup_schedules WHERE is_enabled=1
                 AND time_of_day IN (?, ?)
                 AND (last_run_at IS NULL OR TIMESTAMPDIFF(SECOND, last_run_at, NOW()) > 120)`,
                [hhmmNow, hhmmPrev]
            );
            if (schedules.length === 0) return;

            for (const s of schedules) {
                const days = (s.days_of_week || '').split(',').map(d => parseInt(d.trim(), 10)).filter(n => !isNaN(n));
                if (!days.includes(dow)) {
                    console.log(`[BackupScheduler] Skip "${s.name}" — วันนี้ (${dow}) ไม่อยู่ใน days [${days.join(',')}]`);
                    continue;
                }
                console.log(`[BackupScheduler] 🚀 Running "${s.name}" (time=${s.time_of_day}, now=${hhmmNow}, dow=${dow})`);
                // Lock ทันทีกัน double-run
                try { await db.query('UPDATE backup_schedules SET last_run_at=NOW() WHERE id=?', [s.id]); } catch (e) {}
                runScheduledBackup(s).catch(e => console.error(`[BackupScheduler] "${s.name}" Error:`, e.message));
            }
        } catch (e) {
            console.error('[BackupScheduler] check() failed:', e.message);
        }
    };
    check().catch(e => console.error('[BackupScheduler] initial check failed:', e.message));
    setInterval(check, 30000);
    const bkk = getBangkokTime();
    console.log(`[BackupScheduler] started — Bangkok time: ${bkk.full} (dow=${bkk.dow}), check every 30s`);
}

// === Helper: ดึง Google Drive settings ===
async function getDriveSettings() {
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'gdrive_%'"
        );
        const s = {};
        for (const r of rows) s[r.setting_key] = r.setting_value;
        return {
            enabled: s.gdrive_enabled === 'true',
            clientId: s.gdrive_client_id || '',
            clientSecret: bkDecrypt(s.gdrive_client_secret_enc || ''),
            refreshToken: bkDecrypt(s.gdrive_refresh_token_enc || ''),
            redirectUri: s.gdrive_redirect_uri || '',
            userEmail: s.gdrive_user_email || '',
            folderId: s.gdrive_folder_id || '',
            folderName: s.gdrive_folder_name || ''
        };
    } catch (e) { return { enabled: false }; }
}

// === Helper: สร้าง OAuth2 client + Drive client จาก refresh_token ===
let _driveClientCache = null;

let _driveClientKey = null;

// ล้างแคช client ของ Google Drive (เรียกเมื่อเปลี่ยน/ยกเลิกการเชื่อมต่อ) — แทนการกำหนดค่าตัวแปรตรงๆ ในเส้นทาง เพื่อย้ายส่วนนี้เป็นโมดูลได้
function resetDriveClientCache() { _driveClientCache = null; _driveClientKey = null; }

async function getDriveClient() {
    const cfg = await getDriveSettings();
    if (!cfg.enabled) throw new Error('Google Drive ยังไม่เปิดใช้งาน');
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('ยังไม่ได้ตั้ง Client ID/Secret');
    if (!cfg.refreshToken) throw new Error('ยังไม่ได้ Connect Google Drive (ไม่มี refresh token)');
    if (!cfg.folderId) throw new Error('ยังไม่ได้ตั้ง Folder ID');

    const cacheKey = crypto.createHash('sha256').update(cfg.refreshToken + cfg.folderId).digest('hex');
    if (_driveClientCache && _driveClientKey === cacheKey) {
        return { drive: _driveClientCache, folderId: cfg.folderId, folderName: cfg.folderName, userEmail: cfg.userEmail };
    }

    const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
    oauth2.setCredentials({ refresh_token: cfg.refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2 });
    _driveClientCache = drive;
    _driveClientKey = cacheKey;
    return { drive, folderId: cfg.folderId, folderName: cfg.folderName, userEmail: cfg.userEmail };
}

// === Upload file to Google Drive ===
async function uploadFileToDrive(filePath, fileName) {
    const { drive, folderId } = await getDriveClient();
    const stats = await fsp.stat(filePath);
    const fileMetadata = { name: fileName, parents: [folderId] };
    const media = { mimeType: 'application/octet-stream', body: fs.createReadStream(filePath) };
    const r = await drive.files.create({
        requestBody: fileMetadata,
        media,
        fields: 'id, name, size, webViewLink, createdTime'
    });
    return {
        file_id: r.data.id,
        web_url: r.data.webViewLink || `https://drive.google.com/file/d/${r.data.id}/view`,
        size: Number(r.data.size) || stats.size,
        name: r.data.name
    };
}

// === Delete file from Drive ===
async function deleteFileFromDrive(fileId) {
    const { drive } = await getDriveClient();
    await drive.files.delete({ fileId });
}

// === Test Drive connection (list a few files in target folder) ===
async function testDriveConnection() {
    const { drive, folderId, folderName, userEmail } = await getDriveClient();
    const r = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        pageSize: 5,
        fields: 'files(id, name, size, createdTime)'
    });
    return {
        ok: true,
        user_email: userEmail,
        folder_id: folderId,
        folder_name: folderName,
        sample_files: (r.data.files || []).map(f => ({ id: f.id, name: f.name, size: f.size, created: f.createdTime }))
    };
}

module.exports = { BACKUP_DIR, _detectBin, MYSQL_BIN, MYSQLDUMP_BIN, MARIADB_COMMON_ARGS, _bkEncKey, bkEncrypt, bkDecrypt, getBackupConnection, sanitizeFilename, sha256File, isValidIdent, cleanStderr, buildConnectArgs, listDbTables, verifyBackupPrivileges, countTableRows, buildBackupLog, buildRestoreLog, runBackupJob, runRestoreJob, notifyBackupResult, cleanupOldBackups, runScheduledBackup, BANGKOK_TZ, _bkkFormatter, getBangkokTime, bangkokTimestamp, startBackupScheduler, getDriveSettings, resetDriveClientCache, getDriveClient, uploadFileToDrive, deleteFileFromDrive, testDriveConnection };
