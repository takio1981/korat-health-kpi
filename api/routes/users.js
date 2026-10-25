// เส้นทาง: จัดการผู้ใช้งาน (+ SSO/สถานะระบบ/system-logs ที่อยู่ช่วงเดียวกันในไฟล์เดิม)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { ROLE_ADMIN_CENTRAL, ROLE_ADMIN_LOCAL, getDistrictId, requireAction } = require('../core/access');
const { apiRouter } = require('../core/router');
const { authenticateToken, isAdmin, isAnyAdmin, isSuperAdmin, _sessionCache } = require('../core/auth');
const { parseActiveFlag, ACTIVE_FLAG_REQUIRED } = require('../core/validate');
const { cleanupPendingApprovalNotifications, sendLineToUser, sendMail } = require('../core/notify');
const { getProviderIdSettings, getThaidSettings } = require('../services/sso');
const { countUserKpiResults, userHasResultsMessage, ALL_ROLES, ASSIGNABLE_ROLES, hospcodeInAdminScope } = require('../services/users');

apiRouter.post('/users', authenticateToken, requireAction('users', 'add'), async (req, res) => {
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone, email, cid } = req.body;
    const user = req.user;
    const isCentralAdmin = ROLE_ADMIN_CENTRAL.includes(user.role);
    const isLocalAdmin = ROLE_ADMIN_LOCAL.includes(user.role);

    // central admin: เปลี่ยน role+dept ได้, local admin: เปลี่ยน dept ได้แต่ role ไม่ได้
    const finalRole = isCentralAdmin ? (role || 'user_hos') : 'user_hos';
    // admin_ssj: หน่วยงานของผู้ใช้ใหม่ = หน่วยงานของ admin_ssj เสมอ (หน้าจอล็อค dropdown หน่วยงานไว้แล้ว — 25 ต.ค. 2569 บังคับฝั่ง backend ด้วย)
    const finalDeptId = (user.role === 'admin_ssj' && user.deptId != null) ? user.deptId
        : (isCentralAdmin || isLocalAdmin) ? (dept_id || null) : user.deptId;

    // ตรวจข้อมูล + ขอบเขต (25 ต.ค. 2569) — เดิมไม่มี username/password = 500, admin_ssj สร้าง super_admin ได้ (รอการอนุมัติ), ผู้ดูแลระดับพื้นที่ระบุหน่วยบริการนอกขอบเขตได้
    if (!username || !String(username).trim() || !password || !String(password).trim()) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
    }
    if (user.role !== 'super_admin' && !ASSIGNABLE_ROLES.includes(finalRole)) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์กำหนดสิทธิ์การใช้งาน (Role) นี้' });
    }
    if (user.role === 'super_admin' && !ALL_ROLES.includes(finalRole)) {
        return res.status(400).json({ success: false, message: 'สิทธิ์การใช้งาน (Role) ไม่ถูกต้อง' });
    }

    try {
        if (!(await hospcodeInAdminScope(user, hospcode))) {
            return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เพิ่มผู้ใช้ให้หน่วยบริการนอกขอบเขตของคุณ' });
        }
        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'Username exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const hashedCid = cid ? crypto.createHash('sha256').update(cid).digest('hex') : null;
        // super_admin สร้าง → อนุมัติทันที + บันทึกผู้อนุมัติ, อื่นๆ → รอ super_admin อนุมัติ
        const autoApprove = user.role === 'super_admin' ? 1 : 0;
        const approvedBy = autoApprove ? user.userId : null;
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, role, dept_id, firstname, lastname, hospcode, phone, email, cid, is_approved, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, finalRole, finalDeptId, firstname, lastname, hospcode, phone, email || null, hashedCid, autoApprove, approvedBy]
        );

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'INSERT', 'users', result.insertId, JSON.stringify({ username, role: finalRole }), req.ip]
        );
        res.json({ success: true, message: 'User created' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// เปลี่ยนรหัสผ่านตัวเอง (ทุก role ใช้ได้)
apiRouter.put('/users/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = req.user; // authenticateToken ตรวจ session + set req.user แล้ว

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
    }

    try {
        const [users] = await db.query('SELECT password_hash, temp_password, temp_password_expiry FROM users WHERE id = ?', [user.userId]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });

        // ตรวจสอบรหัสผ่านปัจจุบัน หรือ รหัสชั่วคราว
        let isMatch = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isMatch && users[0].temp_password) {
            isMatch = await bcrypt.compare(currentPassword, users[0].temp_password);
        }
        if (!isMatch) return res.status(400).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password_hash = ?, must_change_password = 0, temp_password = NULL, temp_password_expiry = NULL WHERE id = ?', [hashedPassword, user.userId]);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'users', user.userId, JSON.stringify({ message: 'เปลี่ยนรหัสผ่านตัวเอง' }), req.ip]
        );

        res.json({ success: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่ Server' });
    }
});

// ตรวจสอบการเชื่อมต่อ SSO provider จากฝั่ง server (public — หลีกเลี่ยง CORS)
apiRouter.get('/sso/connectivity', async (req, res) => {
    const checkUrl = async (url) => {
        if (!url) return false;
        let origin;
        try { origin = new URL(url).origin; } catch { return false; }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
            const r = await fetch(origin, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
            clearTimeout(timer);
            return r.status < 500;
        } catch { clearTimeout(timer); return false; }
    };

    const [ts, ps] = await Promise.all([
        getThaidSettings().catch(() => null),
        getProviderIdSettings().catch(() => null)
    ]);
    const thaidUrl   = (ts?.thaid_enabled === 'true' && ts?.thaid_login_url) ? ts.thaid_login_url : '';
    const providerUrl = (ps?.enabled && ps?.login_url) ? ps.login_url : '';

    const [thaid, providerid] = await Promise.all([checkUrl(thaidUrl), checkUrl(providerUrl)]);
    res.json({ success: true, thaid, providerid });
});

// ตรวจสอบสถานะ maintenance mode (public — ไม่ต้อง login)
apiRouter.get('/system/maintenance-status', async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('maintenance_mode','maintenance_message','thaid_enabled','providerid_enabled','thaid_login_url','thaid_register_enabled','providerid_register_enabled','system_version')"
        );
        const s = {};
        rows.forEach(r => s[r.setting_key] = r.setting_value);
        res.json({
            success: true,
            maintenance: s['maintenance_mode'] === 'true',
            message: s['maintenance_message'] || 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน',
            thaid_enabled: s['thaid_enabled'] === 'true',
            providerid_enabled: s['providerid_enabled'] === 'true',
            thaid_login_url: s['thaid_login_url'] || '',
            thaid_register_enabled: s['thaid_register_enabled'] === 'true',
            providerid_register_enabled: s['providerid_register_enabled'] === 'true',
            system_version: s['system_version'] || 'v1.0.0',
        });
    } catch (error) {
        res.json({ success: true, maintenance: false, message: '', thaid_enabled: false, providerid_enabled: false, system_version: 'v1.0.0' });
    }
});

// เปิด/ปิด maintenance mode (super_admin เท่านั้น)
apiRouter.put('/system/maintenance-mode', authenticateToken, isSuperAdmin, async (req, res) => {
    const { message } = req.body || {};
    // ต้องระบุ enabled ชัดเจน (25 ต.ค. 2569) — เดิมไม่ส่งค่า = ปิดโหมดปิดปรับปรุงเงียบๆ
    const flag = parseActiveFlag((req.body || {}).enabled);
    if (flag === null) return res.status(400).json({ success: false, message: 'กรุณาระบุสถานะเปิด/ปิดโหมดปิดปรับปรุง (enabled)' });
    const enabled = flag === 1;
    try {
        await db.query(
            "INSERT INTO system_settings (setting_key, setting_value, description) VALUES ('maintenance_mode', ?, 'โหมดปิดปรับปรุงระบบ') ON DUPLICATE KEY UPDATE setting_value = ?",
            [enabled ? 'true' : 'false', enabled ? 'true' : 'false']
        );
        if (message !== undefined) {
            await db.query(
                "INSERT INTO system_settings (setting_key, setting_value, description) VALUES ('maintenance_message', ?, 'ข้อความแจ้งเตือนปิดปรับปรุง') ON DUPLICATE KEY UPDATE setting_value = ?",
                [message, message]
            );
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', 'system_settings',
             JSON.stringify({ enabled, message }), req.ip]
        );
        res.json({ success: true, message: enabled ? 'เปิดโหมดปิดปรับปรุงระบบ' : 'ปิดโหมดปิดปรับปรุง — ระบบเปิดใช้งานปกติ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================

// เปิด/ปิดใช้งานทั้งหมด ยกเว้น super_admin (super_admin เท่านั้น)
apiRouter.put('/users/bulk-toggle-active', authenticateToken, isSuperAdmin, async (req, res) => {
    const { is_active } = req.body || {};
    // ต้องระบุค่าชัดเจน (25 ต.ค. 2569) — เดิมไม่ส่ง is_active = ปิดใช้งานผู้ใช้ทุกคนยกเว้น super_admin
    const newStatus = parseActiveFlag(is_active);
    if (newStatus === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
    const actionText = newStatus ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
    try {
        const [result] = await db.query(
            'UPDATE users SET is_active = ? WHERE role != ? AND id != ?',
            [newStatus, 'super_admin', req.user.userId]
        );
        _sessionCache.clear();   // ปิดใช้งานมีผลทันทีกับทุกคน
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, req.user.deptId, newStatus ? 'BULK_ACTIVATE' : 'BULK_DEACTIVATE', 'users',
             JSON.stringify({ affected: result.affectedRows, is_active: newStatus }), req.ip]
        );
        res.json({ success: true, message: `${actionText}ผู้ใช้งานทั้งหมด ${result.affectedRows} คน (ยกเว้น super_admin)` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /users/sync-mapping — บันทึก config mapping/exclude ใหม่ (super_admin)
// ⚠️ ต้องอยู่ก่อน PUT /users/:id เสมอ — ไม่งั้น Express จะจับ 'sync-mapping' เป็นค่า :id แทน (route ตรงตัวต้องมาก่อน wildcard เสมอ)
apiRouter.put('/users/sync-mapping', authenticateToken, isSuperAdmin, async (req, res) => {
    const { exclude, mapping } = req.body;
    try {
        if (!Array.isArray(exclude)) return res.status(400).json({ success: false, message: 'exclude ต้องเป็น array' });
        if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) return res.status(400).json({ success: false, message: 'mapping ต้องเป็น object' });

        const [localColsInfo] = await db.query('SHOW COLUMNS FROM users');
        const validFields = new Set(localColsInfo.map(c => c.Field));
        const cleanExclude = [...new Set(exclude)].filter(f => validFields.has(f) && f !== 'id' && f !== 'username');

        const cleanMapping = {};
        for (const [local, khd] of Object.entries(mapping)) {
            if (!validFields.has(local)) continue;
            const target = String(khd || '').trim();
            if (!target || target === local) continue; // ว่าง/ไม่เปลี่ยน = identity, ไม่ต้องเก็บ
            if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(target)) continue; // กันชื่อ identifier ผิดรูปแบบ
            cleanMapping[local] = target;
        }
        const targets = Object.values(cleanMapping);
        const dupTargets = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))];
        if (dupTargets.length > 0) return res.status(400).json({ success: false, message: `มีหลายคอลัมน์ map ไปชื่อ KHD เดียวกัน: ${dupTargets.join(', ')}` });

        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('users_sync_exclude_columns', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [JSON.stringify(cleanExclude), JSON.stringify(cleanExclude)]);
        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('users_sync_field_mapping', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [JSON.stringify(cleanMapping), JSON.stringify(cleanMapping)]);

        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'USERS_SYNC_MAPPING_UPDATE', 'system_settings', JSON.stringify({ exclude: cleanExclude, mapping: cleanMapping }), req.ip]).catch(() => {});

        res.json({ success: true, message: 'บันทึกการตั้งค่า Mapping สำเร็จ', exclude: cleanExclude, mapping: cleanMapping });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.put('/users/:id', authenticateToken, requireAction('users', 'edit'), async (req, res) => {
    const userId = req.params.id;
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone, email, cid } = req.body;
    const user = req.user;
    const isSuperAdmin = user.role === 'super_admin';
    const isCentralAdmin = ROLE_ADMIN_CENTRAL.includes(user.role);
    const isDistrictAdmin = user.role === 'admin_cup';
    const isHosAdmin = ['admin_hos', 'admin_sso'].includes(user.role);

    try {
        // ผู้ใช้ต้องมีอยู่จริง + บัญชี super_admin แก้ได้เฉพาะ super_admin + ข้อมูลที่จำเป็นต้องครบ (25 ต.ค. 2569)
        // เดิม super_admin แก้ id ที่ไม่มีอยู่ = "Updated", ส่งข้อมูลว่าง = ตั้ง username/role เป็น NULL
        const [[targetRow]] = await db.query('SELECT id, role FROM users WHERE id = ?', [userId]);
        if (!targetRow) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        if (!isSuperAdmin && targetRow.role === 'super_admin') {
            return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์แก้ไขบัญชีผู้ดูแลระบบสูงสุด' });
        }
        if (!username || !String(username).trim()) return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้' });
        if (isCentralAdmin) {
            if (!role) return res.status(400).json({ success: false, message: 'กรุณาเลือกสิทธิ์การใช้งาน (Role)' });
            // admin_ssj กำหนด role ได้เฉพาะในรายการของหน้าจอ (ไม่มี super_admin) — เดิมยกระดับผู้ใช้เป็น super_admin ได้ทันที
            if (!isSuperAdmin && !ASSIGNABLE_ROLES.includes(role)) {
                return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์กำหนดสิทธิ์การใช้งาน (Role) นี้' });
            }
            if (isSuperAdmin && !ALL_ROLES.includes(role)) return res.status(400).json({ success: false, message: 'สิทธิ์การใช้งาน (Role) ไม่ถูกต้อง' });
        }

        // ตรวจสอบสิทธิ์ตามขอบเขต
        if (user.role === 'admin_ssj') {
            // admin_ssj: ต้อง dept_id เดียวกัน
            const [target] = await db.query('SELECT dept_id FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (user.deptId != null && String(target[0].dept_id) !== String(user.deptId)) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งานต่างหน่วยงาน' });
        } else if (isDistrictAdmin) {
            const [target] = await db.query(`SELECT h.distid AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            const myDistid = await getDistrictId(user.hospcode);
            if (!myDistid || target[0].distid !== myDistid) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งานต่างอำเภอ' });
        } else if (isHosAdmin) {
            const [target] = await db.query('SELECT hospcode FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (target[0].hospcode !== user.hospcode) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งานต่างหน่วยบริการ' });
        } else if (!isSuperAdmin) {
            return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งาน' });
        }

        // หน่วยบริการใหม่ต้องอยู่ในขอบเขตของผู้ดูแลระดับพื้นที่ (เดิมตรวจเฉพาะหน่วยบริการเดิมของผู้ใช้ — ย้ายไปหน่วยบริการ/อำเภออื่นได้)
        if (!(await hospcodeInAdminScope(user, hospcode))) {
            return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ย้ายผู้ใช้ไปหน่วยบริการนอกขอบเขตของคุณ' });
        }

        const isLocalAdmin = ROLE_ADMIN_LOCAL.includes(user.role);
        // admin_ssj: หน่วยงานคงเป็นหน่วยงานของ admin_ssj (หน้าจอล็อค dropdown หน่วยงานไว้แล้ว)
        const finalDeptId = (user.role === 'admin_ssj' && user.deptId != null) ? user.deptId
            : (isCentralAdmin || isLocalAdmin) ? (dept_id || null) : user.deptId;

        // อัปเดต cid เฉพาะเมื่อส่ง raw national ID 13 หลักมาเท่านั้น
        // (ป้องกัน frontend ส่ง SHA-256 hash กลับมา → double-hash หรือ null → ลบค่าเดิม)
        const cidRaw = cid ? String(cid).replace(/\D/g, '') : '';
        const shouldUpdateCid = cidRaw.length === 13;
        const hashedCid = shouldUpdateCid ? crypto.createHash('sha256').update(cidRaw).digest('hex') : null;

        let sql, params;
        if (isCentralAdmin) {
            sql = 'UPDATE users SET username = ?, role = ?, dept_id = ?, firstname = ?, lastname = ?, hospcode = ?, phone = ?, email = ?';
            params = [username, role, finalDeptId, firstname, lastname, hospcode, phone, email || null];
        } else {
            // local admin: ไม่แก้ role
            sql = 'UPDATE users SET username = ?, dept_id = ?, firstname = ?, lastname = ?, hospcode = ?, phone = ?, email = ?';
            params = [username, finalDeptId, firstname, lastname, hospcode, phone, email || null];
        }
        if (shouldUpdateCid) {
            sql += ', cid = ?';
            params.push(hashedCid);
        }

        if (password && password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(password, 10);
            sql += ', password_hash = ?';
            params.push(hashedPassword);
        }
        sql += ' WHERE id = ?';
        params.push(userId);

        await db.query(sql, params);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'users', userId, JSON.stringify({ username, role: isCentralAdmin ? role : '(unchanged)', password_changed: !!password }), req.ip]
        );
        res.json({ success: true, message: 'Updated' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.delete('/users/:id', authenticateToken, isAnyAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;

    try {
        // ผู้ใช้ต้องมีอยู่จริง (เดิม super_admin ลบ id ที่ไม่มี = "Deleted" + log ปลอม) + บัญชี super_admin ลบได้เฉพาะ super_admin
        const [[targetRow]] = await db.query('SELECT id, role FROM users WHERE id = ?', [userId]);
        if (!targetRow) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        if (user.role !== 'super_admin' && targetRow.role === 'super_admin') {
            return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ลบบัญชีผู้ดูแลระบบสูงสุด' });
        }
        if (user.role === 'admin_ssj') {
            const [target] = await db.query('SELECT dept_id FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (user.deptId != null && String(target[0].dept_id) !== String(user.deptId)) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งานต่างหน่วยงาน' });
        } else if (user.role === 'admin_cup') {
            const [target] = await db.query(`SELECT h.distid AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            const myDistid = await getDistrictId(user.hospcode);
            if (!myDistid || target[0].distid !== myDistid) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งานต่างอำเภอ' });
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            const [target] = await db.query('SELECT hospcode FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (target[0].hospcode !== user.hospcode) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งานต่างหน่วยบริการ' });
        } else if (user.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งาน' });
        }

        const ownedResults = await countUserKpiResults(userId);
        if (ownedResults > 0) {
            return res.status(400).json({ success: false, code: 'USER_HAS_KPI_RESULTS', kpi_results: ownedResults, message: userHasResultsMessage(ownedResults) });
        }

        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        _sessionCache.delete(Number(userId));   // token ของผู้ใช้ที่ถูกลบใช้ไม่ได้ทันที (authenticateToken ตรวจว่ามีบัญชี)
        await cleanupPendingApprovalNotifications(userId);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'DELETE', 'users', userId, JSON.stringify({ message: `Deleted ID: ${userId}` }), req.ip]
        );
        res.json({ success: true, message: 'Deleted' });
    } catch (error) {
        // ฐานข้อมูลปฏิเสธเพราะยังมีข้อมูลอ้างอิงผู้ใช้นี้ (FK RESTRICT) — ไม่ใช่ข้อผิดพลาดของระบบ
        if (error && (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED')) {
            return res.status(400).json({ success: false, code: 'USER_HAS_KPI_RESULTS', message: 'ลบไม่ได้: ยังมีข้อมูลผลงานที่อ้างอิงผู้ใช้นี้ กรุณา "ปิดการใช้งาน" บัญชีแทน' });
        }
        res.status(500).json({ success: false, message: 'ไม่สามารถลบผู้ใช้งานได้' });
    }
});

apiRouter.put('/users/:id/reset-password', authenticateToken, requireAction('users', 'edit'), async (req, res) => {
    const userId = req.params.id;
    const user = req.user;
    // ตรวจสอบสิทธิ์ตามขอบเขต
    try {
        // ผู้ใช้ต้องมีอยู่จริง (เดิม super_admin รีเซ็ต id ที่ไม่มี = สำเร็จ + log ปลอม) + บัญชี super_admin รีเซ็ตได้เฉพาะ super_admin
        const [[targetRow]] = await db.query('SELECT id, role FROM users WHERE id = ?', [userId]);
        if (!targetRow) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        if (user.role !== 'super_admin' && targetRow.role === 'super_admin') {
            return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์รีเซ็ตรหัสผ่านบัญชีผู้ดูแลระบบสูงสุด' });
        }
        if (user.role === 'admin_ssj') {
            const [target] = await db.query('SELECT dept_id FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (user.deptId != null && String(target[0].dept_id) !== String(user.deptId)) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่านผู้ใช้งานต่างหน่วยงาน' });
        } else if (user.role === 'admin_cup') {
            const [target] = await db.query(`SELECT h.distid AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            const myDistid = await getDistrictId(user.hospcode);
            if (!myDistid || target[0].distid !== myDistid) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่านผู้ใช้งานต่างอำเภอ' });
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            const [target] = await db.query('SELECT hospcode FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (target[0].hospcode !== user.hospcode) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่านผู้ใช้งานต่างหน่วยบริการ' });
        } else if (user.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่าน' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    try {
        // สร้างรหัสชั่วคราว 6 หลัก + hash
        const tempCode = String(Math.floor(100000 + Math.random() * 900000));
        const hashedTemp = await bcrypt.hash(tempCode, 10);
        const expiry = new Date(Date.now() + 15 * 60 * 1000);

        await db.query('UPDATE users SET temp_password = ?, temp_password_expiry = ?, must_change_password = 1 WHERE id = ?',
            [hashedTemp, expiry, userId]);

        // ดึงข้อมูล user เพื่อส่ง email
        const [targetUser] = await db.query('SELECT username, email, firstname, lastname FROM users WHERE id = ?', [userId]);
        const target = targetUser[0];

        // LINE: แจ้งรหัสชั่วคราว (กรณี user ลงทะเบียน LINE ไว้)
        sendLineToUser(userId,
            `🔑 รหัสผ่านของคุณถูกรีเซ็ต\n\n` +
            `รหัสชั่วคราว: ${tempCode}\n` +
            `⏰ หมดอายุใน 15 นาที\n\n` +
            `ใช้รหัสนี้แทนรหัสผ่านเดิม — ระบบจะบังคับให้เปลี่ยนรหัสใหม่ทันที`
        );

        // ส่ง Email แจ้งรหัสชั่วคราว (ถ้ามี email)
        if (target && target.email) {
            sendMail(target.email, '🔑 รหัสผ่านของคุณถูกรีเซ็ต — ระบบ KPI สสจ.นครราชสีมา',
                `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:linear-gradient(135deg,#f97316,#fb923c);padding:24px;text-align:center;color:white">
                        <h2 style="margin:0;font-size:20px">🔑 รีเซ็ตรหัสผ่าน</h2>
                    </div>
                    <div style="padding:24px;text-align:center">
                        <p>เรียน คุณ${target.firstname} ${target.lastname},</p>
                        <p>ผู้ดูแลระบบได้ทำการรีเซ็ตรหัสผ่านของคุณ<br>รหัสชั่วคราวสำหรับเข้าสู่ระบบคือ:</p>
                        <div style="background:#fff7ed;border:2px dashed #f97316;border-radius:12px;padding:20px;margin:16px 0">
                            <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#c2410c;font-family:monospace">${tempCode}</span>
                        </div>
                        <p style="color:#dc2626;font-weight:bold;font-size:14px">รหัสนี้จะหมดอายุใน 15 นาที</p>
                        <p style="font-size:13px;color:#6b7280">ใช้รหัสนี้แทนรหัสผ่านเดิมเพื่อเข้าสู่ระบบ<br>ระบบจะบังคับให้เปลี่ยนรหัสผ่านใหม่ทันที</p>
                    </div>
                </div>`
            );
        }

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'users', userId, JSON.stringify({ message: 'Reset Password', email_sent: !!target?.email }), req.ip]
        );
        res.json({ success: true, message: target?.email ? `รีเซ็ตสำเร็จ — ส่งรหัสชั่วคราวไปที่ Email ของผู้ใช้แล้ว` : `รีเซ็ตสำเร็จ — ผู้ใช้ไม่มี Email ให้แจ้งรหัสชั่วคราว: ${tempCode}` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// อนุมัติการลงทะเบียน
apiRouter.put('/users/:id/approve', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        const target = rows[0];
        if (target.is_approved !== 0) return res.status(400).json({ success: false, message: 'ผู้ใช้งานนี้ไม่ได้อยู่ในสถานะรอการอนุมัติ' });

        await db.query('UPDATE users SET is_approved = 1, approved_by = ? WHERE id = ?', [user.userId, userId]);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPROVE_USER', 'users', userId, JSON.stringify({ username: target.username, approved_by: user.userId }), req.ip]
        );

        // LINE: แจ้งผลอนุมัติให้ผู้สมัคร
        sendLineToUser(userId,
            `✅ บัญชีของคุณได้รับการอนุมัติแล้ว\n` +
            `Username: ${target.username}\n\n` +
            `เข้าใช้งานระบบได้ที่:\nhttps://apikorat.moph.go.th/khupskpi/login`
        );

        // ส่ง Email แจ้งผลอนุมัติ
        if (target.email) {
            sendMail(target.email, '✅ บัญชีของคุณได้รับการอนุมัติแล้ว — ระบบ KPI สสจ.นครราชสีมา',
                `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:linear-gradient(135deg,#16a34a,#22c55e);padding:24px;text-align:center;color:white">
                        <h2 style="margin:0;font-size:20px">✅ อนุมัติเรียบร้อยแล้ว</h2>
                    </div>
                    <div style="padding:24px">
                        <p>เรียน คุณ${target.firstname} ${target.lastname},</p>
                        <p>คำขอลงทะเบียนใช้งาน <b>ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา</b> ได้รับการ <span style="color:#16a34a;font-weight:bold">อนุมัติ</span> แล้ว</p>
                        <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
                            <tr><td style="padding:6px 0;color:#6b7280">ชื่อผู้ใช้</td><td style="font-weight:bold">${target.username}</td></tr>
                            <tr><td style="padding:6px 0;color:#6b7280">สิทธิ์</td><td style="font-weight:bold">${target.role}</td></tr>
                        </table>
                        <p>คุณสามารถเข้าสู่ระบบได้ทันที</p>
                        <p style="color:#9ca3af;font-size:12px;margin-top:24px">อีเมลฉบับนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ</p>
                    </div>
                </div>`
            );
        }

        res.json({ success: true, message: 'อนุมัติผู้ใช้งานเรียบร้อย' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ปฏิเสธการลงทะเบียน (รับ reason จาก body)
apiRouter.put('/users/:id/reject', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;
    const reason = req.body.reason || '';
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        const target = rows[0];
        if (target.is_approved !== 0) return res.status(400).json({ success: false, message: 'ผู้ใช้งานนี้ไม่ได้อยู่ในสถานะรอการอนุมัติ' });

        await db.query('UPDATE users SET is_approved = -1 WHERE id = ?', [userId]);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'REJECT_USER', 'users', userId, JSON.stringify({ username: target.username, reason }), req.ip]
        );

        // LINE: แจ้งผลปฏิเสธให้ผู้สมัคร
        sendLineToUser(userId,
            `❌ คำขอลงทะเบียนถูกปฏิเสธ\n` +
            `Username: ${target.username}\n` +
            (reason ? `\nเหตุผล: ${reason}\n` : '') +
            `\nกรุณาติดต่อผู้ดูแลระบบหากต้องการสมัครใหม่`
        );

        // ส่ง Email แจ้งผลปฏิเสธ พร้อมเหตุผล
        if (target.email) {
            const reasonHtml = reason
                ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:12px 0">
                     <p style="color:#991b1b;font-weight:bold;margin:0 0 4px">เหตุผล:</p>
                     <p style="color:#dc2626;margin:0">${reason}</p>
                   </div>`
                : '';
            sendMail(target.email, '❌ คำขอลงทะเบียนถูกปฏิเสธ — ระบบ KPI สสจ.นครราชสีมา',
                `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:linear-gradient(135deg,#dc2626,#ef4444);padding:24px;text-align:center;color:white">
                        <h2 style="margin:0;font-size:20px">❌ คำขอถูกปฏิเสธ</h2>
                    </div>
                    <div style="padding:24px">
                        <p>เรียน คุณ${target.firstname} ${target.lastname},</p>
                        <p>คำขอลงทะเบียนใช้งาน <b>ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา</b> <span style="color:#dc2626;font-weight:bold">ไม่ได้รับการอนุมัติ</span></p>
                        ${reasonHtml}
                        <p>คุณสามารถแก้ไขข้อมูลแล้ว <b>ลงทะเบียนใหม่</b> ได้อีกครั้ง หรือติดต่อผู้ดูแลระบบ</p>
                        <p style="color:#9ca3af;font-size:12px;margin-top:24px">อีเมลฉบับนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ</p>
                    </div>
                </div>`
            );
        }

        res.json({ success: true, message: 'ปฏิเสธผู้ใช้งานเรียบร้อย' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// เปิด/ปิดใช้งาน user account
apiRouter.put('/users/:id/toggle-active', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const { is_active } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        // ป้องกันปิดตัวเอง
        if (Number(userId) === user.userId) {
            return res.status(400).json({ success: false, message: 'ไม่สามารถปิดใช้งานบัญชีของตัวเองได้' });
        }
        const newStatus = parseActiveFlag(is_active);
        if (newStatus === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
        await db.query('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, userId]);
        _sessionCache.delete(Number(userId));   // ปิดใช้งานมีผลทันที (authenticateToken ตรวจ is_active)
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, newStatus ? 'ACTIVATE_USER' : 'DEACTIVATE_USER', 'users', userId,
             JSON.stringify({ username: rows[0].username, is_active: newStatus }), req.ip]
        );
        res.json({ success: true, message: newStatus ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ดูข้อมูลผู้ใช้งานที่รอการอนุมัติ (super_admin/admin_ssj เท่านั้น)
apiRouter.get('/users/:id/basic', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.firstname, u.lastname, u.role, u.hospcode, u.phone, u.email, u.cid, u.is_approved,
                    h.hosname, d.dept_name
             FROM users u
             LEFT JOIN chospital h ON u.hospcode = h.hoscode
             LEFT JOIN departments d ON u.dept_id = d.id
             WHERE u.id = ?`,
            [userId]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        res.json({ success: true, data: rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.get('/system-logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [logs] = await db.query(`
            SELECT s.*, u.username, u.firstname, u.lastname 
            FROM system_logs s
            LEFT JOIN users u ON s.user_id = u.id
            ORDER BY s.created_at DESC
            LIMIT 500
        `);
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

