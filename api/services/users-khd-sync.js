// ส่งข้อมูลผู้ใช้ (users) จาก Local ขึ้น KHD — ย้ายคำต่อคำจาก POST /users/sync-to-khd (routes/db-sync.js) 13 พ.ย. 2569
// ใช้ร่วม: ปุ่ม Data Synchronization เดิม, อนุมัติผู้ใช้ (ทันที) และงานตามรอบเวลา (jobs/user-approval.js)
// คืน { status, body, failedUsernames } — ผู้เรียกที่เป็น route ตอบ res.status(status).json(body)
const db = require('../db');
const { getRemotePool } = require('../db-remote');

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

/**
 * @param {{ usernames?: string[], actorId?: number|null, ip?: string|null, auto?: boolean }} opts
 *   usernames ว่าง/ไม่ส่ง = sync ทั้งหมด (พฤติกรรมเดิมของปุ่ม)
 */
async function syncUsersToKhd({ usernames, actorId = null, ip = null, auto = false } = {}) {
    const remoteDb = getRemotePool();
    if (!remoteDb) return { status: 400, body: { success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' } };
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
                    return { status: 500, body: {
                        success: false,
                        message: `ไม่สามารถสร้างตาราง users ใน KHD: ${ce.message}`
                    } };
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
        if (localUsers.length === 0) return { status: 200, body: { success: true, synced: 0, message: 'ไม่มีข้อมูลที่จะ sync' } };

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
            [actorId, 'USERS_SYNC_TO_KHD', 'users', JSON.stringify({ synced: totalSynced, total: localUsers.length, errors: errors.length, addedColumns, auto: !!auto }), ip]).catch(() => {});

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

        return { status: failure ? 500 : 200, failedUsernames: errors.flatMap(e => e.usernames), body: {
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
        } };
    } catch (e) {
        console.error('[sync-to-khd] Fatal error:', e);
        return { status: 500, body: { success: false, message: e.message, code: e.code } };
    }
}

module.exports = { getUsersSyncConfig, syncUsersToKhd };
