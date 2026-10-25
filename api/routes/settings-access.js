// เส้นทาง: ตั้งค่าระบบ + สิทธิ์เข้าหน้า/เพิ่ม-แก้ไข + ค่าการแสดงผลส่วนตัว
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { ACTION_ACCESS_PAGES, ACTION_ACCESS_ROLES, ACTION_TYPES, PAGE_ACCESS_PAGES, PAGE_ACCESS_ROLES, hasActionAccess, hasPageAccess, loadRoleActionAccessCache, loadRolePageAccessCache } = require('../core/access');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { invalidateLineCategoryCache, notifyLineAction } = require('../core/notify');
const { updateSystemSettings } = require('../core/security');

// หมายเหตุ: เปิดให้ทุก role ที่ login แล้วอ่านได้ (ไม่ผูกกับหน้า "ตั้งค่าระบบ" โดยเฉพาะ) — layout.ts/idle-timeout.service.ts
// ใช้ดึงค่า system_version/idle timeout ที่ทุก role ต้องเห็น ไม่ใช่แค่ super_admin — เดิมไม่มี authenticateToken เลย (เปิดสาธารณะ
// แม้ไม่ login ก็อ่าน secrets เช่น thaid_client_secret/telegram token ได้) แก้ให้ต้อง login อย่างน้อย
apiRouter.get('/settings', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM system_settings');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching settings' });
    }
});

apiRouter.post('/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    const settings = req.body; // Expect array of { key, value }
    // รูปแบบไม่ถูกต้อง → 400 (เดิม: ไม่ใช่ array = 500 "settings.map is not a function", ไม่มี setting_key = 500) — 25 ต.ค. 2569
    if (!Array.isArray(settings) || settings.length === 0 || settings.some(s => !s || typeof s.setting_key !== 'string' || !s.setting_key.trim())) {
        return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลตั้งค่าไม่ถูกต้อง' });
    }

    const connection = await db.getConnection();
    try {
        // === ดึง current values ของ key ทั้งหมดที่ส่งมา เพื่อ diff หา key ที่เปลี่ยนจริง ===
        const submittedKeys = settings.map(s => s.setting_key);
        let oldValuesMap = new Map();
        if (submittedKeys.length > 0) {
            const placeholders = submittedKeys.map(() => '?').join(',');
            const [oldRows] = await connection.query(
                `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${placeholders})`,
                submittedKeys
            );
            for (const r of oldRows) oldValuesMap.set(r.setting_key, r.setting_value);
        }

        await connection.beginTransaction();
        for (const item of settings) {
            await connection.query(
                'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [item.setting_key, item.setting_value, item.setting_value]
            );
        }
        await connection.commit();
        // Reload settings เพื่อให้ค่าใหม่มีผลทันที
        updateSystemSettings();
        // invalidate LINE category cache (อาจเปลี่ยน toggles หรือ line_channel_token)
        invalidateLineCategoryCache();

        // === LINE notify: เฉพาะ key ที่ค่าเปลี่ยนจริงจากเดิม ===
        try {
            const sensitive = ['telegram_bot_token', 'line_channel_token'];
            // หา key ที่เปลี่ยนจริง — ใช้ string compare (DB เก็บเป็น VARCHAR)
            const changedSettings = settings.filter(s => {
                const oldVal = oldValuesMap.get(s.setting_key);
                // key ใหม่ที่ไม่เคยมีใน DB → ถือว่าเปลี่ยน (ยกเว้นค่าว่าง)
                if (oldVal === undefined) return String(s.setting_value || '') !== '';
                return String(oldVal) !== String(s.setting_value || '');
            });

            if (changedSettings.length === 0) {
                // ไม่มีการเปลี่ยนแปลงจริง → ไม่ส่ง LINE (กัน noise)
                console.log('[Settings] save without actual changes — skip LINE notify');
            } else {
                const mask = (key, val) => sensitive.includes(key) ? '***' : String(val || '').slice(0, 80) || '(ว่าง)';
                const detailLines = changedSettings.slice(0, 10).map(s => {
                    const oldV = mask(s.setting_key, oldValuesMap.get(s.setting_key));
                    const newV = mask(s.setting_key, s.setting_value);
                    return `• ${s.setting_key}\n   ↳ ${oldV} → ${newV}`;
                }).join('\n');
                const moreCount = changedSettings.length > 10 ? changedSettings.length - 10 : 0;
                const [actor] = await db.query('SELECT firstname, lastname, username FROM users WHERE id = ?', [req.user.userId]);
                const actorName = actor[0] ? `${actor[0].firstname} ${actor[0].lastname} (${actor[0].username})` : `user_id ${req.user.userId}`;
                notifyLineAction('settings_change',
                    `⚙️ Settings ถูกแก้ไข\n` +
                    `👤 ${actorName}\n` +
                    `🔧 เปลี่ยน ${changedSettings.length} key (จาก ${settings.length} ที่ส่ง)\n` +
                    detailLines +
                    (moreCount > 0 ? `\n... และอีก ${moreCount} key` : '')
                );
            }
        } catch (_) { /* don't fail save if LINE noti fails */ }

        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: 'Update failed' });
    } finally {
        connection.release();
    }
});

// ========== Role × Page Access — หน้า "สิทธิ์การเข้าถึงหน้า" (Super Admin) ==========

// GET /my-page-access — role ของ user ปัจจุบันเข้าหน้าไหนได้บ้าง (ทุก role ใช้ได้ — frontend เรียกตอน login/app init)
apiRouter.get('/my-page-access', authenticateToken, async (req, res) => {
    const role = req.user.role;
    const access = {};
    for (const page of PAGE_ACCESS_PAGES) access[page.key] = hasPageAccess(role, page.key);
    res.json({ success: true, role, access });
});

// GET /role-page-access — เมทริกซ์เต็ม 9 role × ทุกหน้า (super_admin เท่านั้น — จัดการหน้านี้เองไม่ผูกกับตาราง toggle ได้)
apiRouter.get('/role-page-access', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT role, page_key, is_enabled FROM role_page_access');
        res.json({
            success: true,
            roles: PAGE_ACCESS_ROLES,
            pages: PAGE_ACCESS_PAGES,
            data: rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /role-page-access — บันทึกทั้งเมทริกซ์ (super_admin เท่านั้น)
apiRouter.put('/role-page-access', authenticateToken, isSuperAdmin, async (req, res) => {
    const { items } = req.body; // [{ role, page_key, is_enabled }]
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่จะบันทึก' });
    }
    const validPageKeys = new Set(PAGE_ACCESS_PAGES.map(p => p.key));
    const validRoles = new Set(PAGE_ACCESS_ROLES);
    const clean = [];
    for (const it of items) {
        const role = String(it.role || '');
        const pageKey = String(it.page_key || '');
        if (!validRoles.has(role) || !validPageKeys.has(pageKey)) continue; // ข้าม role/page ที่ไม่รู้จัก (กัน payload มั่ว)
        clean.push([role, pageKey, it.is_enabled ? 1 : 0]);
    }
    if (clean.length === 0) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ถูกต้อง' });

    try {
        await db.query(
            `INSERT INTO role_page_access (role, page_key, is_enabled) VALUES ?
             ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
            [clean]
        );
        await loadRolePageAccessCache();
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId || null, 'UPDATE', 'role_page_access', JSON.stringify({ count: clean.length }), (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)]
        ).catch(() => {});
        res.json({ success: true, message: `บันทึกสิทธิ์การเข้าถึงหน้า ${clean.length} รายการสำเร็จ` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /my-action-access — สิทธิ์ "เพิ่ม"/"แก้ไข" ของ role ปัจจุบัน (ทุก role ใช้ได้)
apiRouter.get('/my-action-access', authenticateToken, async (req, res) => {
    const role = req.user.role;
    const access = {};
    for (const page of ACTION_ACCESS_PAGES) {
        access[page.key] = {};
        for (const action of ACTION_TYPES) access[page.key][action] = hasActionAccess(role, page.key, action);
    }
    res.json({ success: true, role, access });
});

// ========== ค่าการแสดงผลส่วนตัวของผู้ใช้ (UI preferences) ==========
// เก็บค่าต่อบัญชีผู้ใช้ (ใช้ได้ทุกเครื่องที่ login บัญชีเดียวกัน) เช่น คอลัมน์ที่แสดงในหน้าบันทึกผลงานตัวชี้วัด
// pref_key จำกัดเป็น whitelist กันเขียนค่าอะไรก็ได้ลงตาราง — ใช้ได้ทุก role (ไม่ map ใน PAGE_ACCESS_RULES)
const UI_PREF_KEYS = ['dashboard_columns'];

// สร้างตารางแบบ lazy — เรียกทั้งตอน startup และก่อนใช้ใน endpoint (ครั้งแรกเท่านั้น)
// กันกรณี migration ตอน startup ไม่ได้รัน/ล้มเหลวเงียบๆ แล้ว endpoint ตอบ 500 "Table doesn't exist"
let _uiPrefsTableReady = null;

function ensureUiPrefsTable() {
    if (!_uiPrefsTableReady) {
        _uiPrefsTableReady = db.query(`
            CREATE TABLE IF NOT EXISTS user_ui_prefs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                pref_key VARCHAR(50) NOT NULL,
                pref_value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_user_pref (user_id, pref_key),
                CONSTRAINT fk_user_ui_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `).catch(err => { _uiPrefsTableReady = null; throw err; }); // ล้มเหลว → ให้ลองใหม่ครั้งถัดไป
    }
    return _uiPrefsTableReady;
}

apiRouter.get('/my-ui-prefs/:key', authenticateToken, async (req, res) => {
    try {
        if (!UI_PREF_KEYS.includes(req.params.key)) return res.status(400).json({ success: false, message: 'pref_key ไม่ถูกต้อง' });
        await ensureUiPrefsTable();
        const [rows] = await db.query('SELECT pref_value FROM user_ui_prefs WHERE user_id = ? AND pref_key = ?', [req.user.userId, req.params.key]);
        let value = null;
        if (rows.length > 0) { try { value = JSON.parse(rows[0].pref_value); } catch (e) { value = null; } }
        res.json({ success: true, data: value });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.put('/my-ui-prefs/:key', authenticateToken, async (req, res) => {
    try {
        if (!UI_PREF_KEYS.includes(req.params.key)) return res.status(400).json({ success: false, message: 'pref_key ไม่ถูกต้อง' });
        await ensureUiPrefsTable();
        const json = JSON.stringify(req.body?.value ?? null);
        if (json.length > 5000) return res.status(400).json({ success: false, message: 'ข้อมูลมีขนาดใหญ่เกินไป' });
        await db.query(
            `INSERT INTO user_ui_prefs (user_id, pref_key, pref_value) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE pref_value = VALUES(pref_value)`,
            [req.user.userId, req.params.key, json]
        );
        res.json({ success: true, message: 'บันทึกการตั้งค่าเรียบร้อย' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /role-action-access — เมทริกซ์เต็ม (super_admin เท่านั้น)
apiRouter.get('/role-action-access', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT role, page_key, action, is_enabled FROM role_action_access');
        res.json({
            success: true,
            roles: ACTION_ACCESS_ROLES,
            pages: ACTION_ACCESS_PAGES,
            actions: ACTION_TYPES,
            data: rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /role-action-access — บันทึกทั้งเมทริกซ์ (super_admin เท่านั้น)
apiRouter.put('/role-action-access', authenticateToken, isSuperAdmin, async (req, res) => {
    const { items } = req.body; // [{ role, page_key, action, is_enabled }]
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่จะบันทึก' });
    }
    const validPageKeys = new Set(ACTION_ACCESS_PAGES.map(p => p.key));
    const validRoles = new Set(ACTION_ACCESS_ROLES);
    const validActions = new Set(ACTION_TYPES);
    const clean = [];
    for (const it of items) {
        const role = String(it.role || '');
        const pageKey = String(it.page_key || '');
        const action = String(it.action || '');
        if (!validRoles.has(role) || !validPageKeys.has(pageKey) || !validActions.has(action)) continue;
        clean.push([role, pageKey, action, it.is_enabled ? 1 : 0]);
    }
    if (clean.length === 0) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ถูกต้อง' });

    try {
        await db.query(
            `INSERT INTO role_action_access (role, page_key, action, is_enabled) VALUES ?
             ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
            [clean]
        );
        await loadRoleActionAccessCache();
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId || null, 'UPDATE', 'role_action_access', JSON.stringify({ count: clean.length }), (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)]
        ).catch(() => {});
        res.json({ success: true, message: `บันทึกสิทธิ์เพิ่ม/แก้ไขข้อมูล ${clean.length} รายการสำเร็จ` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = { UI_PREF_KEYS, ensureUiPrefsTable };
