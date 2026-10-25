// เส้นทาง: อนุมัติ/ปลดล็อค/อุทธรณ์/ขอแก้ไขเป้าหมาย/ปิดการคีย์ + แจ้งเตือน (+ เพิ่มหน่วยงาน POST /departments ที่อยู่ช่วงเดียวกันในไฟล์เดิม)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { activeIndicatorSql } = require('../core/sql');
const { apiRouter } = require('../core/router');
const { authenticateToken, isAdmin, isAnyAdmin, isSuperAdmin } = require('../core/auth');
const { cascadeSubResultsStatus } = require('../services/hierarchy');
const { getPermsForUser, invalidateUserPermCache, requireAction } = require('../core/access');
const { scheduleSummaryRefresh } = require('../services/summary');

apiRouter.post('/approve-kpi', authenticateToken, isAdmin, async (req, res) => {
    const user = req.user;
    // รองรับทั้ง object เดียว และ array หลายรายการ
    const items = Array.isArray(req.body) ? req.body : [req.body];

    if (items.length === 0 || !items[0].indicator_id) {
        return res.status(400).json({ success: false, message: 'No approval data' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        for (const item of items) {
            let whereClause = 'indicator_id = ? AND year_bh = ?';
            let params = [item.indicator_id, item.year_bh];

            // ใช้ hospcode จาก request body (ของหน่วยบริการเป้าหมาย) ถ้ามี
            // ถ้าไม่มีและไม่ใช่ super_admin ให้ใช้ hospcode ของ admin เอง
            if (item.hospcode) {
                whereClause += ' AND hospcode = ?';
                params.push(item.hospcode);
            } else if (user.role !== 'super_admin') {
                whereClause += ' AND hospcode = ?';
                params.push(user.hospcode);
            }

            await connection.query(
                `UPDATE kpi_results SET status = 'Approved', is_locked = 1 WHERE ${whereClause}`,
                params
            );
            // Cascade ไปตัวชี้วัดย่อย (ถ้ามี) — hospcode เดียวกับที่ใช้ตัดสินใน whereClause ด้านบน
            const cascadeHospcode = item.hospcode || (user.role !== 'super_admin' ? user.hospcode : null);
            await cascadeSubResultsStatus(connection, item.indicator_id, item.year_bh, cascadeHospcode, 'Approved', 1);
        }

        // Create notifications for approved items
        for (const item of items) {
            const targetHospcode = item.hospcode || user.hospcode;
            const [indRows] = await connection.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [item.indicator_id]);
            const indName = indRows.length > 0 ? indRows[0].kpi_indicators_name : `ตัวชี้วัด #${item.indicator_id}`;
            await connection.query(
                'INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [targetHospcode, 'approve', 'ตัวชี้วัดได้รับการอนุมัติ', `"${indName}" ปีงบ ${item.year_bh} ได้รับการอนุมัติและล็อคข้อมูลแล้ว`, item.indicator_id, item.year_bh, user.userId]
            );
        }

        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPROVE', 'kpi_results', JSON.stringify({ count: items.length, message: `อนุมัติและล็อคข้อมูล ${items.length} รายการ` }), req.ip]
        );

        await connection.commit();
        scheduleSummaryRefresh(items); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: `อนุมัติและล็อคข้อมูลเรียบร้อยแล้ว ${items.length} รายการ` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// ปลดล็อคข้อมูล KPI (เฉพาะ super_admin)
apiRouter.post('/unlock-kpi', authenticateToken, isSuperAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.body;
    const user = req.user;

    try {
        await db.query(
            "UPDATE kpi_results SET is_locked = 0, status = 'Pending' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade ไปตัวชี้วัดย่อย (ถ้ามี)
        await cascadeSubResultsStatus(db, indicator_id, year_bh, hospcode, 'Pending', 0);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UNLOCK', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, message: 'ปลดล็อคข้อมูล' }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ปลดล็อคข้อมูลเรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST /unlock-kpi-all — ปลดล็อคทั้งหมดตามปี (super_admin)
apiRouter.post('/unlock-kpi-all', authenticateToken, isSuperAdmin, async (req, res) => {
    const { year_bh } = req.body;
    if (!year_bh) return res.status(400).json({ success: false, message: 'กรุณาเลือกปีงบประมาณ' });
    try {
        const [result] = await db.query(
            "UPDATE kpi_results SET is_locked = 0, status = 'Pending' WHERE year_bh = ? AND is_locked = 1",
            [year_bh]
        );
        // Cascade ไปตัวชี้วัดย่อยทั้งหมดที่ล็อคอยู่ในปีนี้ (ไม่กรอง indicator — unlock ทั้งปี)
        await db.query(
            "UPDATE kpi_sub_results SET is_locked = 0, status = 'Pending' WHERE year_bh = ? AND is_locked = 1",
            [year_bh]
        );
        await db.query(
            "UPDATE kpi_activity_results SET is_locked = 0, status = 'Pending' WHERE year_bh = ? AND is_locked = 1",
            [year_bh]
        );
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'UNLOCK_ALL', 'kpi_results', JSON.stringify({ year_bh, affected: result.affectedRows }), req.ip]
        );
        db.query('SELECT DISTINCT indicator_id FROM kpi_summary WHERE year_bh = ?', [year_bh]).then(([rs]) => scheduleSummaryRefresh(rs.map(r => ({ indicator_id: r.indicator_id, year_bh })))).catch(e => console.error('[summary] unlock-all:', e.message)); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: `ปลดล็อคทั้งหมด ${result.affectedRows} รายการ ในปี ${year_bh}` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== ล็อคการคีย์ข้อมูล ==========

// ดึงสถานะล็อคการคีย์ข้อมูล
apiRouter.get('/data-entry-lock', authenticateToken, async (req, res) => {
    try {
        const keys = ['data_entry_locked', 'data_entry_lock_start', 'data_entry_lock_end', 'data_entry_lock_days', 'target_edit_locked'];
        const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
        const settings = {};
        for (const r of rows) settings[r.setting_key] = r.setting_value;

        const manualLock = settings.data_entry_locked === 'true';
        const startDate = settings.data_entry_lock_start || '';
        const endDate = settings.data_entry_lock_end || '';
        const lockDays = parseInt(settings.data_entry_lock_days) || 0;

        const today = new Date().toISOString().split('T')[0];

        // คำนวณวันสิ้นสุดจากจำนวนวัน (ถ้ามี startDate + lockDays > 0)
        let effectiveEnd = endDate;
        if (startDate && lockDays > 0) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + lockDays);
            effectiveEnd = d.toISOString().split('T')[0];
        }

        // !! บังคับเป็น boolean — เดิมถ้าไม่ได้ตั้ง startDate นิพจน์ && คืนค่า '' (string ว่าง) ทำให้ API ส่ง is_locked: ''
        // แทน false → หน้าบันทึกผลงานของ user ทั่วไปเกิด NG0100 (ค่าเปลี่ยนจาก false เป็น '' ระหว่าง change detection)
        const inDateRange = !!(startDate && effectiveEnd && today >= startDate && today <= effectiveEnd);
        const isLocked = manualLock || inDateRange;

        let lockReason = '';
        if (manualLock) lockReason = 'ล็อคโดย Admin';
        else if (inDateRange) lockReason = `ล็อคตามช่วงวันที่ ${startDate} - ${effectiveEnd}`;

        res.json({
            success: true,
            data: {
                data_entry_locked: manualLock,
                data_entry_lock_start: startDate,
                data_entry_lock_end: endDate,
                data_entry_lock_days: lockDays,
                effective_end: effectiveEnd,
                is_locked: isLocked,
                lock_reason: lockReason,
                target_edit_locked: settings.target_edit_locked === 'true'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== User Permissions (per-user) ==========
// PUT /users/:id/permissions — super_admin ตั้งสิทธิ์ราย user
apiRouter.put('/users/:id/permissions', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { can_edit_actual, can_edit_target } = req.body || {};
        // ห้ามแก้สิทธิ์ super_admin (สิทธิ์เต็มเสมอ)
        const [u] = await db.query('SELECT role FROM users WHERE id = ?', [id]);
        if (u.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้' });
        if (u[0].role === 'super_admin') return res.status(400).json({ success: false, message: 'ไม่สามารถแก้สิทธิ์ super_admin ได้ (มีสิทธิ์เต็มเสมอ)' });
        await db.query('UPDATE users SET can_edit_actual = ?, can_edit_target = ? WHERE id = ?',
            [can_edit_actual ? 1 : 0, can_edit_target ? 1 : 0, id]);
        invalidateUserPermCache(id);
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?,?,?,?,?,?)',
            [req.user.userId, 'UPDATE', 'users', id, JSON.stringify({ can_edit_actual: !!can_edit_actual, can_edit_target: !!can_edit_target }), req.ip]); } catch (_) {}
        res.json({ success: true, message: 'บันทึกสิทธิ์ผู้ใช้สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /my-permissions — สิทธิ์ของ user ปัจจุบัน (frontend ใช้ควบคุม UI)
apiRouter.get('/my-permissions', authenticateToken, async (req, res) => {
    try {
        const perms = await getPermsForUser(req.user.userId, req.user.role);
        res.json({ success: true, role: req.user.role, permissions: perms });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== ระบบอุทธรณ์ (Appeal) ==========

// ดึงการตั้งค่าอุทธรณ์ + คำนวณว่าเปิดรับอยู่หรือไม่
apiRouter.get('/appeal-settings', authenticateToken, async (req, res) => {
    try {
        const keys = ['appeal_enabled', 'appeal_start_date', 'appeal_end_date', 'appeal_days_after_approve'];
        const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
        const settings = {};
        for (const r of rows) settings[r.setting_key] = r.setting_value;

        const enabled = settings.appeal_enabled === 'true';
        const startDate = settings.appeal_start_date || '';
        const endDate = settings.appeal_end_date || '';
        const daysAfter = parseInt(settings.appeal_days_after_approve) || 0;

        // คำนวณว่าวันนี้อยู่ในช่วงเปิดรับหรือไม่
        const today = new Date().toISOString().split('T')[0];
        const inDateRange = (!startDate || today >= startDate) && (!endDate || today <= endDate);
        const isOpen = enabled && inDateRange;

        res.json({ success: true, data: { appeal_enabled: enabled, appeal_start_date: startDate, appeal_end_date: endDate, appeal_days_after_approve: daysAfter, is_open: isOpen } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// หน่วยบริการยื่นอุทธรณ์
apiRouter.post('/appeal-kpi', authenticateToken, async (req, res) => {
    const { indicator_id, year_bh, hospcode, reason } = req.body;
    const user = req.user;

    if (!indicator_id || !year_bh || !hospcode || !reason) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    try {
        // ตรวจสอบการตั้งค่าอุทธรณ์
        const [settingsRows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)',
            [['appeal_enabled', 'appeal_start_date', 'appeal_end_date', 'appeal_days_after_approve']]);
        const settings = {};
        for (const r of settingsRows) settings[r.setting_key] = r.setting_value;

        if (settings.appeal_enabled !== 'true') {
            return res.status(400).json({ success: false, message: 'ระบบอุทธรณ์ยังไม่เปิดใช้งาน' });
        }

        const today = new Date().toISOString().split('T')[0];
        if (settings.appeal_start_date && today < settings.appeal_start_date) {
            return res.status(400).json({ success: false, message: `ยังไม่ถึงช่วงเวลายื่นอุทธรณ์ (เริ่ม ${settings.appeal_start_date})` });
        }
        if (settings.appeal_end_date && today > settings.appeal_end_date) {
            return res.status(400).json({ success: false, message: `หมดช่วงเวลายื่นอุทธรณ์แล้ว (สิ้นสุด ${settings.appeal_end_date})` });
        }

        // ตรวจสอบว่า KPI ต้อง Approved + locked (ดูจาก row ใดก็ได้ ไม่จำกัดเดือน)
        const [kpiRows] = await db.query(
            "SELECT status, is_locked, created_at FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? ORDER BY month_bh LIMIT 1",
            [indicator_id, year_bh, hospcode]
        );
        if (kpiRows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล KPI' });
        }
        if (kpiRows[0].status !== 'Approved' || !kpiRows[0].is_locked) {
            return res.status(400).json({ success: false, message: 'สามารถยื่นอุทธรณ์ได้เฉพาะ KPI ที่ถูกอนุมัติและล็อคแล้วเท่านั้น' });
        }

        // ตรวจสอบจำนวนวันหลัง approve
        const daysAfter = parseInt(settings.appeal_days_after_approve) || 0;
        if (daysAfter > 0) {
            // หา approve date จาก system_logs หรือใช้ created_at
            const [logRows] = await db.query(
                "SELECT created_at FROM system_logs WHERE action_type = 'APPROVE' AND new_value LIKE ? ORDER BY created_at DESC LIMIT 1",
                [`%"indicator_id":${indicator_id}%${hospcode}%`]
            );
            const approveDate = logRows.length > 0 ? new Date(logRows[0].created_at) : new Date(kpiRows[0].created_at);
            const diffDays = Math.floor((new Date() - approveDate) / (1000 * 60 * 60 * 24));
            if (diffDays > daysAfter) {
                return res.status(400).json({ success: false, message: `เลยกำหนดยื่นอุทธรณ์แล้ว (ภายใน ${daysAfter} วันหลังอนุมัติ)` });
            }
        }

        // ตรวจสอบว่ายังไม่ได้ยื่นอุทธรณ์อยู่แล้ว
        const [existingAppeal] = await db.query(
            "SELECT id FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status = 'Appeal' LIMIT 1",
            [indicator_id, year_bh, hospcode]
        );
        if (existingAppeal.length > 0) {
            return res.status(400).json({ success: false, message: 'ตัวชี้วัดนี้มีการยื่นอุทธรณ์อยู่แล้ว' });
        }

        // อัปเดตสถานะเป็น Appeal (ยังคง locked)
        await db.query(
            "UPDATE kpi_results SET status = 'Appeal' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade สถานะไปตัวชี้วัดย่อย (ไม่แตะ lock เหมือน kpi_results)
        await db.query(
            `UPDATE kpi_sub_results sr JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
             SET sr.status = 'Appeal' WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode = ?`,
            [indicator_id, year_bh, hospcode]
        );
        await db.query(
            `UPDATE kpi_activity_results ar JOIN kpi_sub_activities a ON ar.activity_id = a.id
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
             SET ar.status = 'Appeal' WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode = ?`,
            [indicator_id, year_bh, hospcode]
        );

        // บันทึกเหตุผลอุทธรณ์
        await db.query(
            "INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, replied_by, rejected_by) VALUES (?, ?, ?, ?, 'appeal', ?, NULL)",
            [indicator_id, year_bh, hospcode, reason, user.userId]
        );

        // ดึงชื่อตัวชี้วัด
        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        // แจ้งเตือน admin_ssj ในหน่วยงานเดียวกัน + super_admin ทั้งหมด
        const [admins] = await db.query(
            "SELECT id, role, dept_id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND dept_id = ?)",
            [deptId]
        );
        for (const admin of admins) {
            await db.query(
                "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'appeal', ?, ?, ?, ?, ?)",
                [admin.id, hospcode, `ยื่นอุทธรณ์: ${indName}`, `หน่วยบริการ ${hospcode} ขออุทธรณ์แก้ไขคะแนน ปี ${year_bh}\nเหตุผล: ${reason}`, indicator_id, year_bh, user.userId]
            );
        }

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, reason }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ยื่นอุทธรณ์เรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin อนุมัติอุทธรณ์ → ปลดล็อค
apiRouter.post('/appeal-approve', authenticateToken, isAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode, comment } = req.body;
    const user = req.user;

    try {
        // ปลดล็อคและเปลี่ยนสถานะเป็น Pending
        await db.query(
            "UPDATE kpi_results SET status = 'Pending', is_locked = 0 WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade ไปตัวชี้วัดย่อย
        await cascadeSubResultsStatus(db, indicator_id, year_bh, hospcode, 'Pending', 0);

        // บันทึก comment
        await db.query(
            "INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, rejected_by) VALUES (?, ?, ?, ?, 'appeal_approve', ?)",
            [indicator_id, year_bh, hospcode, comment || 'อนุมัติอุทธรณ์', user.userId]
        );

        // ดึงชื่อตัวชี้วัด
        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;

        // แจ้ง hospcode
        await db.query(
            "INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, 'approve', ?, ?, ?, ?, ?)",
            [hospcode, `อุทธรณ์ได้รับการอนุมัติ: ${indName}`, `การอุทธรณ์ได้รับการอนุมัติแล้ว ข้อมูลถูกปลดล็อค สามารถแก้ไขคะแนนได้${comment ? '\nความเห็น: ' + comment : ''}`, indicator_id, year_bh, user.userId]
        );

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL_APPROVE', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, comment }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'อนุมัติอุทธรณ์เรียบร้อย ปลดล็อคข้อมูลแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin ปฏิเสธอุทธรณ์ → กลับ Approved/locked
apiRouter.post('/appeal-reject', authenticateToken, isAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode, comment } = req.body;
    const user = req.user;

    if (!comment) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลในการปฏิเสธอุทธรณ์' });
    }

    try {
        // กลับสถานะ Approved + locked
        await db.query(
            "UPDATE kpi_results SET status = 'Approved', is_locked = 1 WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade ไปตัวชี้วัดย่อย
        await cascadeSubResultsStatus(db, indicator_id, year_bh, hospcode, 'Approved', 1);

        // บันทึก comment
        await db.query(
            "INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, rejected_by) VALUES (?, ?, ?, ?, 'appeal_reject', ?)",
            [indicator_id, year_bh, hospcode, comment, user.userId]
        );

        // ดึงชื่อตัวชี้วัด
        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;

        // แจ้ง hospcode
        await db.query(
            "INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, 'reject', ?, ?, ?, ?, ?)",
            [hospcode, `อุทธรณ์ถูกปฏิเสธ: ${indName}`, `การอุทธรณ์ถูกปฏิเสธ ข้อมูลยังคงถูกล็อค\nเหตุผล: ${comment}`, indicator_id, year_bh, user.userId]
        );

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL_REJECT', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, comment }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ปฏิเสธอุทธรณ์เรียบร้อย' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// แจ้ง admin ว่าหน่วยบริการแก้ไขข้อมูลจากอุทธรณ์เสร็จแล้ว ให้ตรวจสอบรับรอง
apiRouter.post('/appeal-edited', authenticateToken, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.body;
    const user = req.user;

    try {
        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        // ดึงชื่อหน่วยบริการ
        const [hosRows] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ?', [hospcode]);
        const hosName = hosRows[0]?.hosname || hospcode;

        // แจ้ง admin_ssj ในหน่วยงานเดียวกัน + super_admin ทั้งหมด
        const [admins] = await db.query(
            "SELECT id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND dept_id = ?)",
            [deptId]
        );
        for (const admin of admins) {
            await db.query(
                "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'info', ?, ?, ?, ?, ?)",
                [admin.id, hospcode,
                 `แก้ไขข้อมูลอุทธรณ์แล้ว: ${indName}`,
                 `${hosName} (${hospcode}) แก้ไขข้อมูลจากการอุทธรณ์เรียบร้อยแล้ว ปี ${year_bh}\nกรุณาเข้าตรวจสอบและรับรองข้อมูล`,
                 indicator_id, year_bh, user.userId]
            );
        }

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL_EDITED', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode }), req.ip]
        );

        res.json({ success: true, message: 'แจ้ง Admin เรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== Target Edit Request APIs ==========

// ดึงรายการขอแก้ไขเป้าหมาย
apiRouter.get('/target-edit-requests', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        let rows;
        if (user.role === 'admin_ssj' || user.role === 'super_admin') {
            [rows] = await db.query(
                `SELECT t.*, u.firstname, u.lastname, u.username
                 FROM target_edit_requests t
                 LEFT JOIN users u ON t.requested_by = u.id
                 WHERE t.status IN ('pending','approved')
                 ORDER BY t.created_at DESC`
            );
        } else {
            [rows] = await db.query(
                `SELECT t.*, u.firstname, u.lastname, u.username
                 FROM target_edit_requests t
                 LEFT JOIN users u ON t.requested_by = u.id
                 WHERE t.requested_by = ? AND t.status IN ('pending','approved','rejected')
                 ORDER BY t.created_at DESC`,
                [user.userId]
            );
        }
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ส่งคำขอแก้ไขเป้าหมาย (admin_cup / admin_ssj / super_admin)
apiRouter.post('/target-edit-request', authenticateToken, isAnyAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.body;
    const user = req.user;
    try {
        const [existing] = await db.query(
            "SELECT id FROM target_edit_requests WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status IN ('pending','approved')",
            [indicator_id, year_bh, hospcode]
        );
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'มีคำขออยู่แล้ว กรุณารอการอนุมัติ' });
        }

        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        const [hosRows] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ?', [hospcode]);
        const hosName = hosRows[0]?.hosname || hospcode;

        const byName = `${user.firstname || ''} ${user.lastname || ''}`.trim() || user.username;

        const [result] = await db.query(
            'INSERT INTO target_edit_requests (indicator_id, year_bh, hospcode, requested_by, requested_by_name, status) VALUES (?, ?, ?, ?, ?, ?)',
            [indicator_id, year_bh, hospcode, user.userId, byName, 'pending']
        );

        // แจ้ง admin_ssj + super_admin
        const [admins] = await db.query(
            "SELECT id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND (dept_id = ? OR dept_id IS NULL))",
            [deptId]
        );
        for (const admin of admins) {
            if (admin.id !== user.userId) {
                await db.query(
                    "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'target_request', ?, ?, ?, ?, ?)",
                    [admin.id, hospcode,
                     `ขอแก้ไขเป้าหมาย: ${indName}`,
                     `${byName} (${hosName}) ขอแก้ไขเป้าหมาย "${indName}" ปี ${year_bh} กรุณาอนุมัติหรือปฏิเสธ`,
                     indicator_id, year_bh, user.userId]
                );
            }
        }

        res.json({ success: true, message: 'ส่งคำขอแล้ว รอการอนุมัติ', request_id: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// อนุมัติคำขอแก้ไขเป้าหมาย (admin_ssj / super_admin)
apiRouter.post('/target-edit-approve', authenticateToken, isAdmin, async (req, res) => {
    const { request_id } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM target_edit_requests WHERE id = ?', [request_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
        const reqRow = rows[0];
        if (reqRow.status !== 'pending') return res.status(400).json({ success: false, message: 'คำขอนี้ไม่ได้รออนุมัติ' });

        await db.query('UPDATE target_edit_requests SET status = ?, approved_by = ?, updated_at = NOW() WHERE id = ?',
            ['approved', user.userId, request_id]);

        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [reqRow.indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${reqRow.indicator_id}`;

        await db.query(
            "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'approve', ?, ?, ?, ?, ?)",
            [reqRow.requested_by, reqRow.hospcode,
             `อนุมัติแก้ไขเป้าหมาย: ${indName}`,
             `คำขอแก้ไขเป้าหมาย "${indName}" ปี ${reqRow.year_bh} ได้รับการอนุมัติแล้ว กรุณาแก้ไขและบันทึก`,
             reqRow.indicator_id, reqRow.year_bh, user.userId]
        );

        res.json({ success: true, message: 'อนุมัติคำขอแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ปฏิเสธคำขอแก้ไขเป้าหมาย (admin_ssj / super_admin)
apiRouter.post('/target-edit-reject', authenticateToken, isAdmin, async (req, res) => {
    const { request_id, reason } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM target_edit_requests WHERE id = ?', [request_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
        const reqRow = rows[0];
        if (reqRow.status !== 'pending') return res.status(400).json({ success: false, message: 'คำขอนี้ไม่ได้รออนุมัติ' });

        await db.query('UPDATE target_edit_requests SET status = ?, reject_reason = ?, updated_at = NOW() WHERE id = ?',
            ['rejected', reason || '', request_id]);

        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [reqRow.indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${reqRow.indicator_id}`;

        await db.query(
            "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'reject', ?, ?, ?, ?, ?)",
            [reqRow.requested_by, reqRow.hospcode,
             `ปฏิเสธการแก้ไขเป้าหมาย: ${indName}`,
             `คำขอแก้ไขเป้าหมาย "${indName}" ปี ${reqRow.year_bh} ถูกปฏิเสธ${reason ? ': ' + reason : ''}`,
             reqRow.indicator_id, reqRow.year_bh, user.userId]
        );

        res.json({ success: true, message: 'ปฏิเสธคำขอแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ปิดคำขอแก้ไขเป้าหมาย หลังบันทึกสำเร็จ
apiRouter.post('/target-edit-complete', authenticateToken, isAnyAdmin, async (req, res) => {
    const { request_id } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM target_edit_requests WHERE id = ?', [request_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
        const reqRow = rows[0];
        if (reqRow.status !== 'approved') return res.status(400).json({ success: false, message: 'คำขอนี้ยังไม่ได้รับอนุมัติ' });

        await db.query('UPDATE target_edit_requests SET status = ?, updated_at = NOW() WHERE id = ?', ['completed', request_id]);

        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [reqRow.indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${reqRow.indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        const [hosRows] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ?', [reqRow.hospcode]);
        const hosName = hosRows[0]?.hosname || reqRow.hospcode;
        const byName = reqRow.requested_by_name || `ผู้ใช้ #${reqRow.requested_by}`;

        const [admins] = await db.query(
            "SELECT id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND (dept_id = ? OR dept_id IS NULL))",
            [deptId]
        );
        for (const admin of admins) {
            if (admin.id !== reqRow.requested_by) {
                await db.query(
                    "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'info', ?, ?, ?, ?, ?)",
                    [admin.id, reqRow.hospcode,
                     `บันทึกเป้าหมายแล้ว: ${indName}`,
                     `${byName} (${hosName}) บันทึกเป้าหมาย "${indName}" ปี ${reqRow.year_bh} เรียบร้อยแล้ว`,
                     reqRow.indicator_id, reqRow.year_bh, user.userId]
                );
            }
        }

        res.json({ success: true, message: 'ปิดคำขอแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ดึงจำนวนตัวชี้วัดที่รอการตรวจสอบ (ปีงบปัจจุบัน, แสดง dept/hospital/indicator)
apiRouter.get('/notifications/pending-kpi', authenticateToken, isAdmin, async (req, res) => {
    const user = req.user;
    try {
        // คำนวณปีงบประมาณปัจจุบัน (ต.ค. = เดือน 9 ของ JS → ปี+1+543)
        const today = new Date();
        let fyYear = today.getFullYear();
        if (today.getMonth() >= 9) fyYear += 1; // เดือน ต.ค. ขึ้นปีใหม่
        const currentFY = (fyYear + 543).toString();

        let whereClause = `WHERE r.status = 'Pending' AND r.year_bh = ? AND ${activeIndicatorSql('r.indicator_id')}`;
        let params = [currentFY];

        // admin: เฉพาะหน่วยงานตัวเอง (ทุก hospcode)
        if (user.role !== 'super_admin' && user.deptId !== null && user.deptId !== undefined) {
            whereClause += " AND i.dept_id = ?";
            params.push(user.deptId);
        }

        const [rows] = await db.query(
            `SELECT
                COUNT(DISTINCT i.dept_id) AS dept_count,
                COUNT(DISTINCT r.hospcode) AS hos_count,
                COUNT(DISTINCT r.indicator_id) AS indicator_count
             FROM kpi_results r
             LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
             ${whereClause}`,
            params
        );
        const data = rows[0] || { dept_count: 0, hos_count: 0, indicator_count: 0 };
        res.json({
            success: true,
            count: data.indicator_count, // backward compat
            data: {
                deptCount: data.dept_count,
                hosCount: data.hos_count,
                indicatorCount: data.indicator_count,
                yearBh: currentFY
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.post('/departments', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { dept_code, dept_name, description, sort_order } = req.body;
    if (!dept_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        await db.query(
            'INSERT INTO departments (dept_code, dept_name, description, sort_order) VALUES (?, ?, ?, ?)',
            [dept_code || null, dept_name, description || null, sort_order || 0]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/departments/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { dept_code, dept_name, description, sort_order, is_active } = req.body;
    if (!dept_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        await db.query(
            'UPDATE departments SET dept_code=?, dept_name=?, description=?, sort_order=?, is_active=? WHERE id=?',
            [dept_code || null, dept_name, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
