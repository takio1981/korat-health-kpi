// เส้นทาง: ตีกลับ/ตอบกลับผลงาน + แจ้งเตือน
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isAdmin } = require('../core/auth');
const { indicatorsOutsideOwnDept, OUTSIDE_DEPT_MESSAGE } = require('../core/access');
const { cascadeSubResultsStatus } = require('../services/hierarchy');
const { scheduleSummaryRefresh } = require('../services/summary');

// ========== Rejection & Notification APIs ==========

// ตีกลับ KPI (admin only) - รองรับทั้งรายการเดียวและหลายรายการ
apiRouter.post('/reject-kpi', authenticateToken, isAdmin, async (req, res) => {
    const user = req.user;
    const items = Array.isArray(req.body) ? req.body : [req.body];

    if (items.length === 0 || !items[0].indicator_id) {
        return res.status(400).json({ success: false, message: 'No rejection data' });
    }
    // ไม่มีเหตุผล → 400 ก่อนเริ่ม transaction (เดิม throw ในลูป → 500) + admin_ssj ส่งคืนได้เฉพาะหน่วยงานตัวเอง
    if (items.some(i => !i || !i.comment || !String(i.comment).trim())) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลการส่งคืนแก้ไข' });
    }
    if ((await indicatorsOutsideOwnDept(user, items.map(i => i.indicator_id))).length) {
        return res.status(403).json({ success: false, message: OUTSIDE_DEPT_MESSAGE });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        for (const item of items) {
            const { indicator_id, year_bh, hospcode, comment, reject_months } = item;

            if (!comment || !comment.trim()) {
                throw new Error('กรุณาระบุเหตุผลการส่งคืนแก้ไข');
            }

            let whereClause = 'indicator_id = ? AND year_bh = ?';
            let params = [indicator_id, year_bh];

            // ใช้ hospcode จาก request body (ของหน่วยบริการเป้าหมาย) ถ้ามี
            // ถ้าไม่มีและไม่ใช่ super_admin ให้ใช้ hospcode ของ admin เอง
            if (hospcode) {
                whereClause += ' AND hospcode = ?';
                params.push(hospcode);
            } else if (user.role !== 'super_admin') {
                whereClause += ' AND hospcode = ?';
                params.push(user.hospcode);
            }

            // Update status to Rejected and unlock
            await connection.query(
                `UPDATE kpi_results SET status = 'Rejected', is_locked = 0 WHERE ${whereClause}`,
                params
            );
            // Cascade ไปตัวชี้วัดย่อย (ถ้ามี) — hospcode เดียวกับที่ใช้ตัดสินใน whereClause ด้านบน
            const cascadeHospcode = hospcode || (user.role !== 'super_admin' ? user.hospcode : null);
            await cascadeSubResultsStatus(connection, indicator_id, year_bh, cascadeHospcode, 'Rejected', 0);

            // Save rejection comment with reject_months
            const targetHospcode = hospcode || user.hospcode;
            const monthsStr = Array.isArray(reject_months) ? reject_months.join(',') : (reject_months || '');
            await connection.query(
                'INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, reject_months, type, rejected_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [indicator_id, year_bh, targetHospcode, comment.trim(), monthsStr, 'reject', user.userId]
            );

            // Get indicator name for notification
            const [indRows] = await connection.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
            const indName = indRows.length > 0 ? indRows[0].kpi_indicators_name : `ตัวชี้วัด #${indicator_id}`;

            // สร้างชื่อเดือนไทยสำหรับ notification
            const monthNamesTh = { oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.', apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.' };
            const monthsDisplay = monthsStr ? monthsStr.split(',').map(m => monthNamesTh[m.trim()] || m.trim()).join(', ') : '';
            const monthsMsg = monthsDisplay ? ` เดือนที่ต้องแก้ไข: ${monthsDisplay}` : '';

            // Create notification for the hospcode owner
            await connection.query(
                'INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [targetHospcode, 'reject', 'ตัวชี้วัดถูกส่งคืนแก้ไข', `"${indName}" ปีงบ ${year_bh} ถูกส่งคืนแก้ไข${monthsMsg} เหตุผล: ${comment.trim()}`, indicator_id, year_bh, user.userId]
            );
        }

        // Log action
        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'REJECT', 'kpi_results', JSON.stringify({ count: items.length, message: `ส่งคืนแก้ไข ${items.length} รายการ` }), req.ip]
        );

        await connection.commit();
        scheduleSummaryRefresh(items); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: `ส่งคืนแก้ไขเรียบร้อยแล้ว ${items.length} รายการ` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// ดึงรายการแจ้งเตือนของผู้ใช้
apiRouter.get('/notifications', authenticateToken, async (req, res) => {
    const user = req.user;
    try {
        const [rows] = await db.query(
            `SELECT n.*, u.firstname AS created_by_name, u.lastname AS created_by_lastname,
                    (SELECT COUNT(*) FROM kpi_rejection_comments rc
                     WHERE rc.indicator_id = n.indicator_id AND rc.year_bh = n.year_bh
                     AND rc.hospcode = n.hospcode AND rc.type = 'reply'
                     AND rc.created_at > n.created_at) AS has_reply,
                    (SELECT r.status FROM kpi_results r
                     WHERE r.indicator_id = n.indicator_id AND r.year_bh = n.year_bh
                     AND r.hospcode = n.hospcode ORDER BY r.month_bh LIMIT 1) AS kpi_status
             FROM notifications n
             LEFT JOIN users u ON n.created_by = u.id
             WHERE n.user_id = ? OR n.hospcode = ? OR (n.user_id IS NULL AND n.hospcode IS NULL)
             ORDER BY n.created_at DESC LIMIT 50`,
            [user.userId, user.hospcode]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// นับจำนวนแจ้งเตือนที่ยังไม่อ่าน
apiRouter.get('/notifications/unread-count', authenticateToken, async (req, res) => {
    const user = req.user;
    try {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM notifications
             WHERE is_read = 0 AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
            [user.userId, user.hospcode]
        );
        res.json({ success: true, count: rows[0].count });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark notifications as read
apiRouter.post('/notifications/mark-read', authenticateToken, async (req, res) => {
    const user = req.user;
    const { ids, all } = req.body;
    try {
        // ดึง rejection notifications ที่ยังไม่อ่าน ก่อน mark as read
        let rejNotifs = [];
        if (all) {
            const [rows] = await db.query(
                `SELECT indicator_id, year_bh, hospcode FROM notifications
                 WHERE type = 'reject' AND is_read = 0 AND indicator_id IS NOT NULL
                 AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
                [user.userId, user.hospcode]
            );
            rejNotifs = rows;
            await db.query(
                `UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
                [user.userId, user.hospcode]
            );
        } else if (ids && Array.isArray(ids) && ids.length > 0) {
            const [rows] = await db.query(
                `SELECT indicator_id, year_bh, hospcode FROM notifications
                 WHERE id IN (?) AND type = 'reject' AND is_read = 0 AND indicator_id IS NOT NULL`,
                [ids]
            );
            rejNotifs = rows;
            await db.query(
                `UPDATE notifications SET is_read = 1 WHERE id IN (?) AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
                [ids, user.userId, user.hospcode]
            );
        }

        // เมื่ออ่านแจ้งเตือนตีกลับแล้ว → เปลี่ยนสถานะจาก Rejected เป็น Resubmit
        for (const n of rejNotifs) {
            if (n.indicator_id && n.year_bh && n.hospcode) {
                await db.query(
                    `UPDATE kpi_results SET status = 'Resubmit' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status = 'Rejected'`,
                    [n.indicator_id, n.year_bh, n.hospcode]
                );
            }
        }

        scheduleSummaryRefresh(rejNotifs); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'อ่านแจ้งเตือนเรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ดึงประวัติเหตุผลการตีกลับ + การตอบกลับ
apiRouter.get('/rejection-comments/:indicator_id/:year_bh/:hospcode', authenticateToken, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT rc.*,
                    COALESCE(u1.firstname, u2.firstname) AS firstname,
                    COALESCE(u1.lastname, u2.lastname) AS lastname
             FROM kpi_rejection_comments rc
             LEFT JOIN users u1 ON rc.rejected_by = u1.id
             LEFT JOIN users u2 ON rc.replied_by = u2.id
             WHERE rc.indicator_id = ? AND rc.year_bh = ? AND rc.hospcode = ?
             ORDER BY rc.created_at DESC`,
            [indicator_id, year_bh, hospcode]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ตอบกลับการตีกลับ KPI (หน่วยบริการ)
apiRouter.post('/reply-kpi', authenticateToken, async (req, res) => {
    const user = req.user;
    const { indicator_id, year_bh, hospcode, message } = req.body;

    if (!indicator_id || !year_bh) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุข้อมูลให้ครบถ้วน' });
    }

    // ถ้าไม่มีข้อความตอบกลับ ใช้ข้อความเริ่มต้น
    const replyMessage = (message && message.trim()) ? message.trim() : 'แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว';

    const targetHospcode = hospcode || user.hospcode;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // บันทึกข้อความตอบกลับ
        await connection.query(
            'INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, replied_by) VALUES (?, ?, ?, ?, ?, ?)',
            [indicator_id, year_bh, targetHospcode, replyMessage, 'reply', user.userId]
        );

        // เปลี่ยนสถานะกลับเป็น Pending เพื่อให้ admin ตรวจสอบใหม่
        await connection.query(
            `UPDATE kpi_results SET status = 'Pending' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status = 'Resubmit'`,
            [indicator_id, year_bh, targetHospcode]
        );

        // Get indicator name for notification
        const [indRows] = await connection.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows.length > 0 ? indRows[0].kpi_indicators_name : `ตัวชี้วัด #${indicator_id}`;

        // Get hospital name
        const [hosRows] = await connection.query('SELECT hosname FROM chospital WHERE hoscode = ?', [targetHospcode]);
        const hosName = hosRows.length > 0 ? hosRows[0].hosname : targetHospcode;

        // หา admin ที่เคย reject ตัวชี้วัดนี้ (ไม่ซ้ำ)
        const [rejecters] = await connection.query(
            `SELECT DISTINCT rejected_by FROM kpi_rejection_comments
             WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND type = 'reject' AND rejected_by IS NOT NULL`,
            [indicator_id, year_bh, targetHospcode]
        );
        const rejecterIds = rejecters.map(r => r.rejected_by);

        // ถ้าไม่เจอ admin ที่ reject → ส่งให้ super_admin ทุกคน
        let targetAdminIds = rejecterIds;
        if (targetAdminIds.length === 0) {
            const [superAdmins] = await connection.query("SELECT id FROM users WHERE role = 'super_admin'");
            targetAdminIds = superAdmins.map(a => a.id);
        }

        // สร้าง notification เฉพาะ admin ที่เกี่ยวข้อง (ไม่ซ้ำ)
        const uniqueAdminIds = [...new Set(targetAdminIds)];
        for (const adminId of uniqueAdminIds) {
            await connection.query(
                'INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [adminId, targetHospcode, 'info', 'หน่วยบริการตอบกลับการตีกลับ',
                 `${hosName} ตอบกลับตัวชี้วัด "${indName}" ปีงบ ${year_bh}: ${replyMessage}`,
                 indicator_id, year_bh, user.userId]
            );
        }

        // Log action
        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'REPLY', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode: targetHospcode, message: replyMessage }), req.ip]
        );

        await connection.commit();
        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ส่งตอบกลับเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// ดึงรายการตอบกลับทั้งหมด (สำหรับ admin/user)
apiRouter.get('/kpi-replies', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let whereClause = "WHERE rc.type = 'reply'";
        let params = [];

        // super_admin: เห็นทั้งหมด
        // admin: เฉพาะหน่วยงานตัวเอง (ทุก hospcode)
        // user: เฉพาะ hospcode + dept ของตัวเอง
        if (user.role === 'super_admin') {
            // ไม่มี filter เพิ่ม
        } else if (user.role === 'admin_ssj') {
            if (user.deptId !== null && user.deptId !== undefined) {
                whereClause += ' AND i.dept_id = ?';
                params.push(user.deptId);
            }
        } else {
            if (user.hospcode) {
                whereClause += ' AND rc.hospcode = ?';
                params.push(user.hospcode);
            }
            if (user.deptId !== null && user.deptId !== undefined) {
                whereClause += ' AND i.dept_id = ?';
                params.push(user.deptId);
            }
        }

        const [rows] = await db.query(`
            SELECT rc.id, rc.indicator_id, rc.year_bh, rc.hospcode, rc.comment, rc.created_at,
                   i.kpi_indicators_name, d.dept_name,
                   h.hosname,
                   u.firstname AS replied_firstname, u.lastname AS replied_lastname,
                   (SELECT rc2.comment FROM kpi_rejection_comments rc2
                    WHERE rc2.indicator_id = rc.indicator_id AND rc2.year_bh = rc.year_bh
                    AND rc2.hospcode = rc.hospcode AND rc2.type = 'reject'
                    AND rc2.created_at < rc.created_at
                    ORDER BY rc2.created_at DESC LIMIT 1) AS original_reject_comment
            FROM kpi_rejection_comments rc
            LEFT JOIN kpi_indicators i ON rc.indicator_id = i.id
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN chospital h ON rc.hospcode = h.hoscode
            LEFT JOIN users u ON rc.replied_by = u.id
            ${whereClause}
            ORDER BY rc.created_at DESC
            LIMIT 100
        `, params);

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('KPI Replies Error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลตอบกลับได้' });
    }
});
