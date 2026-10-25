// เส้นทาง: เทียบ/sync ฐานข้อมูล Local ↔ KHD (db-compare) + sync ผู้ใช้กับ KHD
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { diffTableColumns } = require('../services/khd');
const { getRemotePool } = require('../db-remote');

// GET /db-compare — เปรียบเทียบ structure ตาราง table_process ระหว่าง local กับ khd
apiRouter.get('/db-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD) ใน .env (KHD_DB_HOST)' });

    try {
        // 1. ดึง table_process ทั้งหมดจาก kpi_indicators (deduplicate ตาม table_process)
        const [allIndicators] = await db.query("SELECT id, kpi_indicators_name, table_process, dept_id, main_indicator_id, is_active FROM kpi_indicators WHERE table_process IS NOT NULL AND table_process != ''");
        // รวมชื่อตัวชี้วัดที่ใช้ table_process เดียวกัน + เก็บ dept_id/main_indicator_id ของตัวแรก (สำหรับตัวกรอง)
        const tableMap = new Map();
        for (const ind of allIndicators) {
            const tp = ind.table_process.trim().replace(/-/g, '_');
            if (!tableMap.has(tp)) {
                tableMap.set(tp, {
                    id: ind.id, table_process: tp, names: [],
                    dept_id: ind.dept_id, main_indicator_id: ind.main_indicator_id, is_active: ind.is_active
                });
            }
            tableMap.get(tp).names.push(ind.kpi_indicators_name);
        }
        const indicators = Array.from(tableMap.values()).map(v => ({
            id: v.id, table_process: v.table_process,
            kpi_indicators_name: v.names.length === 1 ? v.names[0] : v.names.join(' | '),
            dept_id: v.dept_id, main_indicator_id: v.main_indicator_id, is_active: v.is_active
        }));

        const results = [];
        const localDbName = process.env.DB_NAME || 'khups_kpi_db';
        const remoteDbName = process.env.KHD_DB_NAME || 'hdc';

        for (const ind of indicators) {
            const tableName = ind.table_process.trim().replace(/-/g, '_');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) continue;

            const item = {
                id: ind.id, name: ind.kpi_indicators_name, table: tableName,
                dept_id: ind.dept_id, main_indicator_id: ind.main_indicator_id, is_active: ind.is_active,
                local: null, remote: null, status: 'unknown', diff: []
            };

            // Local structure
            try {
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [localCount] = await db.query(`SELECT COUNT(*) AS cnt FROM \`${tableName}\``);
                item.local = { exists: true, columns: localCols.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default })), row_count: localCount[0].cnt };
            } catch (e) { item.local = { exists: false, columns: [], row_count: 0 }; }

            // Remote structure
            try {
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [remoteCount] = await remoteDb.query(`SELECT COUNT(*) AS cnt FROM \`${tableName}\``);
                item.remote = { exists: true, columns: remoteCols.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default })), row_count: remoteCount[0].cnt };
            } catch (e) { item.remote = { exists: false, columns: [], row_count: 0 }; }

            // Compare
            if (!item.local.exists && !item.remote.exists) { item.status = 'missing_both'; }
            else if (!item.local.exists) { item.status = 'missing_local'; }
            else if (!item.remote.exists) { item.status = 'missing_remote'; }
            else {
                // เปรียบเทียบ columns
                item.diff = diffTableColumns(item.local.columns, item.remote.columns);
                item.status = item.diff.length === 0 ? 'match' : 'different';
            }

            results.push(item);
        }

        const summary = {
            total: results.length,
            match: results.filter(r => r.status === 'match').length,
            different: results.filter(r => r.status === 'different').length,
            missing_local: results.filter(r => r.status === 'missing_local').length,
            missing_remote: results.filter(r => r.status === 'missing_remote').length,
            missing_both: results.filter(r => r.status === 'missing_both').length
        };

        res.json({ success: true, local_db: localDbName, remote_db: remoteDbName, summary, tables: results });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST /db-compare/create-local — สร้าง/แก้ไขตารางใน local ให้ตรงกับ remote
apiRouter.post('/db-compare/create-local', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body; // ['table1', 'table2']
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const created = [], altered = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ดึง CREATE TABLE จาก remote
            const [ddlRows] = await remoteDb.query(`SHOW CREATE TABLE \`${tableName}\``);
            if (ddlRows.length === 0) { errors.push({ table: tableName, error: 'ไม่พบตารางใน remote' }); continue; }

            let ddl = ddlRows[0]['Create Table'];

            // ตรวจว่า local มีตารางนี้หรือยัง
            let localExists = false;
            try { await db.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); localExists = true; } catch (e) {}

            if (!localExists) {
                // สร้างใหม่
                await db.query(ddl);
                created.push(tableName);
            } else {
                // ALTER เพิ่มคอลัมน์ที่ขาด
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const localFieldSet = new Set(localCols.map(c => c.Field));
                let alteredCount = 0;
                for (const col of remoteCols) {
                    if (!localFieldSet.has(col.Field)) {
                        const nullable = col.Null === 'YES' ? 'NULL' : 'NOT NULL';
                        const def = col.Default !== null ? `DEFAULT '${col.Default}'` : (col.Null === 'YES' ? 'DEFAULT NULL' : '');
                        try {
                            await db.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.Field}\` ${col.Type} ${nullable} ${def}`);
                            alteredCount++;
                        } catch (e) { /* column อาจมีอยู่แล้ว */ }
                    }
                }
                if (alteredCount > 0) altered.push({ table: tableName, added_columns: alteredCount });
            }
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_CREATE', 'MULTIPLE', JSON.stringify({ created, altered }), req.ip]).catch(() => {});

    res.json({ success: true, message: `สร้าง ${created.length} ตาราง, แก้ไข ${altered.length} ตาราง`, created, altered, errors });
});

// POST /db-compare/sync-data — Sync ข้อมูลจาก remote (khd) เข้า local
apiRouter.post('/db-compare/sync-data', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const synced = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ตรวจว่า local มีตารางนี้
            try { await db.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); } catch (e) {
                errors.push({ table: tableName, error: 'ตารางไม่มีใน local กรุณาสร้างก่อน' }); continue;
            }

            // ดึงข้อมูลจาก remote
            const [remoteRows] = await remoteDb.query(`SELECT * FROM \`${tableName}\``);
            if (remoteRows.length === 0) { synced.push({ table: tableName, rows: 0, message: 'ไม่มีข้อมูลใน remote' }); continue; }

            // ดึง column names
            const columns = Object.keys(remoteRows[0]);
            const colList = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const onDup = columns.map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

            // Batch upsert (100 rows per batch)
            let totalInserted = 0;
            for (let i = 0; i < remoteRows.length; i += 100) {
                const batch = remoteRows.slice(i, i + 100);
                const allPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
                const flatValues = batch.flatMap(row => columns.map(c => row[c]));
                await db.query(`INSERT INTO \`${tableName}\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${onDup}`, flatValues);
                totalInserted += batch.length;
            }

            synced.push({ table: tableName, rows: totalInserted });
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_SYNC', 'MULTIPLE', JSON.stringify({ synced: synced.length, total_rows: synced.reduce((s, t) => s + t.rows, 0) }), req.ip]).catch(() => {});

    res.json({ success: true, message: `Sync สำเร็จ ${synced.length} ตาราง`, synced, errors });
});

// POST /db-compare/create-remote — สร้าง/แก้ไขตารางใน KHD จาก DDL ของ Local (สำหรับ missing_remote)
apiRouter.post('/db-compare/create-remote', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const created = [], altered = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ดึง CREATE TABLE จาก local
            const [ddlRows] = await db.query(`SHOW CREATE TABLE \`${tableName}\``);
            if (ddlRows.length === 0) { errors.push({ table: tableName, error: 'ไม่พบตารางใน local' }); continue; }

            const ddl = ddlRows[0]['Create Table'];

            // ตรวจว่า remote มีตารางนี้หรือยัง
            let remoteExists = false;
            try { await remoteDb.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); remoteExists = true; } catch (e) {}

            if (!remoteExists) {
                // สร้างใหม่ใน KHD
                await remoteDb.query(ddl);
                created.push(tableName);
            } else {
                // ALTER เพิ่มคอลัมน์ที่ขาดใน KHD
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const remoteFieldSet = new Set(remoteCols.map(c => c.Field));
                let alteredCount = 0;
                for (const col of localCols) {
                    if (!remoteFieldSet.has(col.Field)) {
                        const nullable = col.Null === 'YES' ? 'NULL' : 'NOT NULL';
                        const def = col.Default !== null ? `DEFAULT '${col.Default}'` : (col.Null === 'YES' ? 'DEFAULT NULL' : '');
                        try {
                            await remoteDb.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.Field}\` ${col.Type} ${nullable} ${def}`);
                            alteredCount++;
                        } catch (e) { /* column อาจมีอยู่แล้ว */ }
                    }
                }
                if (alteredCount > 0) altered.push({ table: tableName, added_columns: alteredCount });
            }
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_CREATE_REMOTE', 'MULTIPLE', JSON.stringify({ created, altered }), req.ip]).catch(() => {});

    res.json({ success: true, message: `สร้าง ${created.length} ตาราง, แก้ไข ${altered.length} ตารางใน KHD`, created, altered, errors });
});

// POST /db-compare/sync-to-khd — Sync ข้อมูลจาก Local → KHD (upsert batch 100 rows)
apiRouter.post('/db-compare/sync-to-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const synced = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ตรวจว่า remote มีตารางนี้
            try { await remoteDb.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); } catch (e) {
                errors.push({ table: tableName, error: 'ตารางไม่มีใน KHD กรุณาสร้างก่อน' }); continue;
            }

            // ดึงข้อมูลจาก local
            const [localRows] = await db.query(`SELECT * FROM \`${tableName}\``);
            if (localRows.length === 0) { synced.push({ table: tableName, rows: 0, message: 'ไม่มีข้อมูลใน local' }); continue; }

            // ดึง column names
            const columns = Object.keys(localRows[0]);
            const colList = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const onDup = columns.map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

            // Batch upsert → KHD (100 rows per batch)
            let totalInserted = 0;
            for (let i = 0; i < localRows.length; i += 100) {
                const batch = localRows.slice(i, i + 100);
                const allPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
                const flatValues = batch.flatMap(row => columns.map(c => row[c]));
                await remoteDb.query(`INSERT INTO \`${tableName}\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${onDup}`, flatValues);
                totalInserted += batch.length;
            }

            synced.push({ table: tableName, rows: totalInserted });
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_SYNC_TO_KHD', 'MULTIPLE', JSON.stringify({ synced: synced.length, total_rows: synced.reduce((s, t) => s + t.rows, 0) }), req.ip]).catch(() => {});

    res.json({ success: true, message: `Sync → KHD สำเร็จ ${synced.length} ตาราง`, synced, errors });
});

// ========== Users Data Sync (Local ↔ KHD) ==========
// โหลด config exclude/mapping ของ Users Data Sync จาก system_settings
async function getUsersSyncConfig() {
    const [rows] = await db.query(
        "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('users_sync_exclude_columns','users_sync_field_mapping')"
    );
    const map = new Map(rows.map(r => [r.setting_key, r.setting_value]));
    let exclude = [], mapping = {};
    try { exclude = JSON.parse(map.get('users_sync_exclude_columns') || '[]'); } catch (e) { exclude = []; }
    try { mapping = JSON.parse(map.get('users_sync_field_mapping') || '{}'); } catch (e) { mapping = {}; }
    // safety: กันไม่ให้ id/username ถูก exclude เผลอ (username คือ key เทียบ, id คือ PK local)
    exclude = exclude.filter(c => c !== 'id' && c !== 'username');
    return { exclude: new Set(exclude), mapping };
}

// GET /users/sync-compare — เปรียบเทียบ users ระหว่าง Local กับ KHD (เก็บ diff รายฟิลด์จริง ไม่ใช่แค่ boolean)
apiRouter.get('/users/sync-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const { exclude, mapping } = await getUsersSyncConfig();

        // ดึง local users (ทุกคอลัมน์)
        const [localUsers] = await db.query('SELECT * FROM users ORDER BY username');

        // ดึง remote users — ถ้าตารางไม่มี → ถือว่าว่าง
        let remoteUsers = [];
        try {
            const [rows] = await remoteDb.query('SELECT * FROM users ORDER BY username');
            remoteUsers = rows;
        } catch (e) { /* ตาราง users ไม่มีใน KHD */ }

        const remoteMap = new Map(remoteUsers.map(u => [u.username, u]));
        const localMap = new Map(localUsers.map(u => [u.username, u]));

        const matched = [], different = [], local_only = [], khd_only = [];
        const alwaysSkip = ['id', 'created_at', 'updated_at']; // baseline เดิม ไม่เปลี่ยน

        for (const lu of localUsers) {
            const ru = remoteMap.get(lu.username);
            if (!ru) { local_only.push(lu); continue; }
            // เทียบค่าทีละ field — เก็บ diff ทุกฟิลด์ (ไม่ break ที่ตัวแรก) + ใช้ mapping ชื่อ field ถ้ามี
            const fieldDiffs = [];
            for (const k of Object.keys(lu)) {
                if (alwaysSkip.includes(k) || exclude.has(k)) continue;
                const remoteKey = mapping[k] || k;
                const lv = lu[k] == null ? '' : String(lu[k]);
                const rv = ru[remoteKey] == null ? '' : String(ru[remoteKey]);
                if (lv !== rv) {
                    fieldDiffs.push({ field: k, khd_field: remoteKey !== k ? remoteKey : undefined, local_value: lu[k], khd_value: ru[remoteKey] });
                }
            }
            (fieldDiffs.length > 0 ? different : matched).push(fieldDiffs.length > 0 ? { ...lu, _diff: fieldDiffs } : lu);
        }
        for (const ru of remoteUsers) {
            if (!localMap.has(ru.username)) khd_only.push(ru);
        }

        res.json({
            success: true,
            summary: { matched: matched.length, different: different.length, local_only: local_only.length, khd_only: khd_only.length, total_local: localUsers.length, total_khd: remoteUsers.length },
            matched, different, local_only, khd_only,
            sync_config: { exclude: [...exclude], mapping }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /users/sync-to-khd — ส่ง users จาก Local → KHD (UPSERT)
apiRouter.post('/users/sync-to-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { usernames } = req.body; // optional: ถ้าไม่ส่ง = sync ทั้งหมด
    const { exclude, mapping } = await getUsersSyncConfig();

    try {
        // === Step 1: ensure KHD users table exists (สร้างจาก local DDL ถ้าไม่มี) ===
        let khdTableExists = true;
        try {
            await remoteDb.query('SELECT 1 FROM users LIMIT 0');
        } catch (e) {
            khdTableExists = false;
            const [ddlRows] = await db.query('SHOW CREATE TABLE users');
            if (ddlRows.length > 0) {
                try {
                    await remoteDb.query(ddlRows[0]['Create Table']);
                    console.log('[sync-to-khd] Created users table in KHD');
                    khdTableExists = true;
                } catch (ce) {
                    return res.status(500).json({
                        success: false,
                        message: `ไม่สามารถสร้างตาราง users ใน KHD: ${ce.message}`
                    });
                }
            }
        }

        // === Step 2: sync schema — ALTER ADD COLUMN ที่ Local มีแต่ KHD ไม่มี (ข้ามคอลัมน์ที่ตั้งใจไม่ sync) ===
        const [localColsInfo] = await db.query('SHOW COLUMNS FROM users');
        const [remoteColsInfo] = await remoteDb.query('SHOW COLUMNS FROM users');
        const remoteColSet = new Set(remoteColsInfo.map(c => c.Field));
        const missingInRemote = localColsInfo.filter(c => !remoteColSet.has(c.Field) && !exclude.has(c.Field));
        const addedColumns = [];
        const alterErrors = [];
        for (const col of missingInRemote) {
            // สร้าง ALTER statement (ระวัง quotes ใน Default)
            let alter = `ALTER TABLE \`users\` ADD COLUMN \`${col.Field}\` ${col.Type}`;
            if (col.Null === 'NO') alter += ' NOT NULL';
            if (col.Default !== null && col.Default !== undefined) {
                const def = String(col.Default);
                // Skip default ที่เป็น expression (CURRENT_TIMESTAMP, etc)
                if (/^(CURRENT_TIMESTAMP|NULL)$/i.test(def)) {
                    alter += ` DEFAULT ${def}`;
                } else {
                    alter += ` DEFAULT ${remoteDb.escape ? remoteDb.escape(def) : `'${def.replace(/'/g, "''")}'`}`;
                }
            }
            if (col.Extra) alter += ` ${col.Extra}`;
            try {
                await remoteDb.query(alter);
                addedColumns.push(col.Field);
                console.log(`[sync-to-khd] Added column ${col.Field} to KHD users`);
            } catch (ae) {
                alterErrors.push({ column: col.Field, error: ae.message });
                console.warn(`[sync-to-khd] ALTER add ${col.Field} failed:`, ae.message);
            }
        }

        // === Step 3: ดึง users ที่ต้องการ sync ===
        let query = 'SELECT * FROM users';
        const params = [];
        if (Array.isArray(usernames) && usernames.length > 0) {
            query += ` WHERE username IN (${usernames.map(() => '?').join(',')})`;
            params.push(...usernames);
        }
        const [localUsers] = await db.query(query, params);
        if (localUsers.length === 0) return res.json({ success: true, synced: 0, message: 'ไม่มีข้อมูลที่จะ sync' });

        // === Step 4: resolve local→KHD target column names (mapping) + ตัด exclude + ใช้เฉพาะ columns ที่มีใน KHD จริงๆ ===
        const [remoteColsAfter] = await remoteDb.query('SHOW COLUMNS FROM users');
        const remoteColSetAfter = new Set(remoteColsAfter.map(c => c.Field));
        const localCols = Object.keys(localUsers[0]);
        const eligibleCols = localCols.filter(c => !exclude.has(c));
        const excludedCols = localCols.filter(c => exclude.has(c));
        const colPairs = eligibleCols.map(c => ({ local: c, khd: mapping[c] || c }));
        // กรอง: ใช้เฉพาะ column ปลายทางที่ KHD มีจริงๆ (กัน Unknown column) — ไม่ ALTER สร้างตามชื่อ mapping อัตโนมัติ
        const syncableCols = colPairs.filter(p => remoteColSetAfter.has(p.khd));
        const skippedCols = colPairs.filter(p => !remoteColSetAfter.has(p.khd)).map(p => p.local);
        if (skippedCols.length > 0) {
            console.warn('[sync-to-khd] Skipped columns (target not in KHD):', skippedCols.join(', '));
        }

        // === Step 5: identify JSON columns → stringify ===
        const jsonCols = new Set(
            localColsInfo
                .filter(c => /^(json|longtext)/i.test(c.Type))
                .map(c => c.Field)
        );

        // === Step 6: UPSERT batch 100 rows (เขียนลงชื่อคอลัมน์ปลายทางตาม mapping) ===
        const colList = syncableCols.map(p => `\`${p.khd}\``).join(', ');
        const placeholders = syncableCols.map(() => '?').join(', ');
        const onDup = syncableCols.filter(p => p.khd !== 'id').map(p => `\`${p.khd}\`=VALUES(\`${p.khd}\`)`).join(', ');

        let totalSynced = 0;
        const errors = [];
        for (let i = 0; i < localUsers.length; i += 100) {
            const batch = localUsers.slice(i, i + 100);
            const allPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
            const flatValues = batch.flatMap(row => syncableCols.map(p => {
                const v = row[p.local];
                if (v === undefined) return null;
                if (jsonCols.has(p.local) && v !== null && typeof v === 'object') {
                    try { return JSON.stringify(v); } catch (e) { return null; }
                }
                return v;
            }));
            try {
                const [result] = await remoteDb.query(
                    `INSERT INTO \`users\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${onDup}`,
                    flatValues
                );
                totalSynced += batch.length;
                console.log(`[sync-to-khd] Batch ${i}: affected=${result.affectedRows}, inserted=${result.affectedRows - (result.changedRows || 0)}, updated=${result.changedRows || 0}`);
            } catch (e) {
                console.error(`[sync-to-khd] Batch ${i} failed:`, e.message);
                // เก็บ usernames ที่ fail
                errors.push({
                    batch_start: i,
                    batch_size: batch.length,
                    usernames: batch.map(u => u.username),
                    error: e.message,
                    code: e.code
                });
            }
        }

        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'USERS_SYNC_TO_KHD', 'users', JSON.stringify({ synced: totalSynced, total: localUsers.length, errors: errors.length, addedColumns }), req.ip]).catch(() => {});

        // === Step 7: build response ===
        const success = totalSynced === localUsers.length && errors.length === 0;
        const partial = totalSynced > 0 && totalSynced < localUsers.length;
        const failure = totalSynced === 0;
        let message;
        if (success) {
            message = `Sync สำเร็จ ${totalSynced} คน`;
        } else if (partial) {
            message = `Sync บางส่วน: สำเร็จ ${totalSynced}/${localUsers.length} คน (มี ${errors.length} batch ผิดพลาด)`;
        } else {
            message = `Sync ล้มเหลว — ไม่มีข้อมูลถูกส่ง (${errors.length} batch ผิดพลาด)`;
        }
        if (addedColumns.length > 0) {
            message += ` | เพิ่ม column ใหม่ใน KHD: ${addedColumns.join(', ')}`;
        }
        if (skippedCols.length > 0) {
            message += ` | ข้าม column ที่ KHD ไม่มี: ${skippedCols.join(', ')}`;
        }
        if (excludedCols.length > 0) {
            message += ` | ไม่ sync (ตั้งค่าไว้): ${excludedCols.join(', ')}`;
        }

        res.status(failure ? 500 : 200).json({
            success: !failure,
            partial,
            synced: totalSynced,
            total: localUsers.length,
            failed: localUsers.length - totalSynced,
            message,
            errors: errors.slice(0, 5),  // ส่งกลับเฉพาะ 5 errors แรก
            added_columns: addedColumns,
            skipped_columns: skippedCols,
            excluded_columns: excludedCols,
            applied_mapping: mapping,
            alter_errors: alterErrors
        });
    } catch (e) {
        console.error('[sync-to-khd] Fatal error:', e);
        res.status(500).json({ success: false, message: e.message, code: e.code });
    }
});

// GET /users/structure-compare — SHOW COLUMNS diff เฉพาะตาราง users ระหว่าง Local กับ KHD (รายงานอย่างเดียว ไม่แก้โครงสร้าง KHD อัตโนมัติ)
apiRouter.get('/users/structure-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [localColsRaw] = await db.query('SHOW COLUMNS FROM users');
        let remoteColsRaw = [];
        try { const [rc] = await remoteDb.query('SHOW COLUMNS FROM users'); remoteColsRaw = rc; } catch (e) { /* ตาราง users ไม่มีใน KHD */ }
        const local_columns = localColsRaw.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default }));
        const remote_columns = remoteColsRaw.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default }));
        const diff = diffTableColumns(local_columns, remote_columns);
        res.json({
            success: true,
            local_db: process.env.DB_NAME || 'khups_kpi_db',
            remote_db: process.env.KHD_DB_NAME || 'hdc',
            local_columns, remote_columns, diff,
            status: diff.length === 0 ? 'match' : 'different'
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /users/sync-mapping — ดึง config mapping/exclude ปัจจุบัน + รายชื่อคอลัมน์ local ทั้งหมด
apiRouter.get('/users/sync-mapping', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { exclude, mapping } = await getUsersSyncConfig();
        const [localColsInfo] = await db.query('SHOW COLUMNS FROM users');
        res.json({ success: true, columns: localColsInfo.map(c => c.Field), exclude: [...exclude], mapping });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = { getUsersSyncConfig };
