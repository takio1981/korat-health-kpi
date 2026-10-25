// เส้นทาง: บันทึกการใช้งาน, ผู้ใช้ (บางส่วน), error logs, เครื่องมือผู้ดูแล, ผู้ใช้งานออนไลน์
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const jwt = require('jsonwebtoken');
const { ROLE_ADMIN_ALL, ROLE_SCOPE_HOSPCODE, getDistrictId } = require('../core/access');
const { SECRET_KEY } = require('../core/security');
const { apiRouter } = require('../core/router');
const { authenticateToken, isAnyAdmin, isSuperAdmin } = require('../core/auth');
const { captureError } = require('../core/errors');

// --- Log Management ---
apiRouter.get('/logs/backup', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [systemLogs] = await db.query(`SELECT l.*, u.username FROM system_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC`);
        const [loginLogs] = await db.query(`SELECT * FROM login_logs ORDER BY created_at DESC`);

        let csv = 'log_type,id,timestamp,username,action,details,ip_address\n';

        systemLogs.forEach(row => {
            let details = '';
            try {
                details = row.new_value ? (JSON.parse(row.new_value).message || row.new_value) : (row.old_value || '');
            } catch (e) {
                details = row.new_value || '';
            }
            csv += `SYSTEM,${row.id},"${row.created_at}","${row.username || ''}","${row.action_type}","${details.toString().replace(/"/g, '""')}","${row.ip_address || ''}"\n`;
        });

        loginLogs.forEach(row => {
            csv += `LOGIN,${row.id},"${row.created_at}","${row.username || ''}","${row.action}","${(row.details || '').toString().replace(/"/g, '""')}","${row.ip_address || ''}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="korat_kpi_logs.csv"');
        res.send('\ufeff' + csv);
    } catch (error) {
        console.error("Log Backup Error:", error);
        const detail = process.env.NODE_ENV !== 'production' ? error.message : undefined;
        res.status(500).json({ success: false, message: detail || 'ไม่สามารถสำรองข้อมูลได้' });
    }
});

apiRouter.delete('/logs/clear', authenticateToken, isSuperAdmin, async (req, res) => {
    const user = req.user;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        
        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'DELETE', 'ALL_LOGS', JSON.stringify({ message: `ล้างข้อมูล Log ทั้งหมดโดย ${user.username}` }), req.ip]
        );
        
        await connection.query('TRUNCATE TABLE system_logs');
        await connection.query('TRUNCATE TABLE login_logs');

        await connection.commit();
        res.json({ success: true, message: 'ล้างข้อมูล Log ทั้งหมดเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        console.error("Log Clear Error:", error);
        res.status(500).json({ success: false, message: 'ไม่สามารถล้างข้อมูล Log ได้' });
    } finally {
        connection.release();
    }
});

apiRouter.get('/users', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        let sql = `
            SELECT u.id, u.username, u.role, u.dept_id, u.firstname, u.lastname, u.phone, u.hospcode,
                   u.email, u.cid, u.is_approved, u.is_active, u.approved_by,
                   u.active_session_id, u.session_started_at, u.last_seen_at, u.last_seen_ip,
                   u.can_edit_actual, u.can_edit_target,
                   u.line_user_id, u.notif_line_enabled,
                   d.dept_name, h.hosname, dist.distname,
                   approver.firstname AS approved_by_name, approver.lastname AS approved_by_lastname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            LEFT JOIN users approver ON u.approved_by = approver.id`;
        let params = [];

        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            // เห็นเฉพาะ dept เดียวกัน ยกเว้น super_admin
            sql += ` WHERE u.role != 'super_admin'`;
            if (user.deptId != null) { sql += ' AND u.dept_id = ?'; params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            // admin_cup: ทุกคนในอำเภอเดียวกัน ยกเว้น super_admin
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                sql += ` WHERE u.role != 'super_admin' AND h.distid = ?`;
                params.push(distid);
            } else {
                sql += ` WHERE u.role != 'super_admin' AND u.hospcode = ?`;
                params.push(user.hospcode);
            }
        } else if (ROLE_SCOPE_HOSPCODE.includes(user.role) && ROLE_ADMIN_ALL.includes(user.role)) {
            // admin_hos / admin_sso: เฉพาะ hospcode ตัวเอง ยกเว้น super_admin
            sql += ` WHERE u.role != 'super_admin' AND u.hospcode = ?`;
            params.push(user.hospcode);
        } else {
            // user ทั่วไป: เฉพาะ dept_id เดียวกัน ยกเว้น super_admin
            sql += ` WHERE u.role != 'super_admin' AND u.dept_id = ?`;
            params.push(user.deptId);
        }
        sql += ' ORDER BY u.id DESC';

        const [users] = await db.query(sql, params);
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// GET /users/stats — สถิติผู้ใช้งาน แยกตาม role / อำเภอ / หน่วยบริการ / กลุ่มงาน (anyAdmin)
apiRouter.get('/users/stats', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        // ---- สร้าง WHERE + params เดียวกับ GET /users ----
        let where = `WHERE u.role != 'super_admin'`;
        let params = [];
        if (user.role === 'super_admin') {
            where = '';
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { where += ' AND u.dept_id = ?'; params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where += ' AND h.distid = ?'; params.push(distid); }
            else { where += ' AND u.hospcode = ?'; params.push(user.hospcode); }
        } else if (ROLE_SCOPE_HOSPCODE.includes(user.role) && ROLE_ADMIN_ALL.includes(user.role)) {
            where += ' AND u.hospcode = ?'; params.push(user.hospcode);
        } else {
            where += ' AND u.dept_id = ?'; params.push(user.deptId);
        }

        const join = `FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode LEFT JOIN co_district dist ON dist.distid = h.distid LEFT JOIN departments d ON u.dept_id = d.id`;

        // 1. Summary totals
        const [summary] = await db.query(`
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN u.is_approved = 1 AND u.is_active = 1 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN u.is_approved = 0 THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN u.is_approved = -1 THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN u.is_active = 0 THEN 1 ELSE 0 END) AS disabled,
              SUM(CASE WHEN u.is_approved = 1 THEN 1 ELSE 0 END) AS approved
            ${join} ${where}
        `, params);

        // 2. By role
        const [byRole] = await db.query(`
            SELECT u.role, COUNT(*) AS count
            ${join} ${where}
            GROUP BY u.role ORDER BY count DESC
        `, params);

        // 3. By district
        const [byDistrict] = await db.query(`
            SELECT h.distid, dist.distname, COUNT(*) AS count
            ${join} ${where}
            GROUP BY h.distid, dist.distname ORDER BY count DESC
        `, params);

        // 4. By hospital (top 50)
        const [byHospital] = await db.query(`
            SELECT u.hospcode, h.hosname, h.hostype, dist.distname, COUNT(*) AS count
            ${join} ${where}
            GROUP BY u.hospcode, h.hosname, h.hostype, dist.distname ORDER BY count DESC LIMIT 50
        `, params);

        // 5. By department
        const [byDept] = await db.query(`
            SELECT d.id AS dept_id, d.dept_name, COUNT(*) AS count
            ${join} ${where}
            GROUP BY d.id, d.dept_name ORDER BY count DESC
        `, params);

        res.json({
            success: true,
            summary: summary[0],
            byRole,
            byDistrict,
            byHospital,
            byDept
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /users/pending-count — จำนวน user ที่ลงทะเบียนใหม่และรออนุมัติ (is_approved = 0) ตาม scope ของ admin
apiRouter.get('/users/pending-count', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        let where = "u.is_approved = 0 AND u.role != 'super_admin'";
        const params = [];
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { where += ' AND u.dept_id = ?'; params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where += ' AND h.distid = ?'; params.push(distid); }
            else { where += ' AND u.hospcode = ?'; params.push(user.hospcode); }
        } else if (ROLE_SCOPE_HOSPCODE.includes(user.role) && ROLE_ADMIN_ALL.includes(user.role)) {
            where += ' AND u.hospcode = ?'; params.push(user.hospcode);
        } else {
            where += ' AND u.dept_id = ?'; params.push(user.deptId);
        }
        const [rows] = await db.query(
            `SELECT COUNT(*) AS cnt FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE ${where}`,
            params
        );
        res.json({ success: true, count: rows[0].cnt });
    } catch (error) {
        res.status(500).json({ success: false, count: 0 });
    }
});

// GET /online-users — รายชื่อ user ที่ online (activity ล่าสุดภายใน windowMin นาที)
// ============================================================
//  Error Monitoring Endpoints
// ============================================================
// POST /errors/report — รับ error จาก frontend (authenticated หรือ anon ก็ได้)
apiRouter.post('/errors/report', async (req, res) => {
    try {
        // ไม่ require auth — error อาจเกิดก่อน login
        let userId = null, username = null;
        try {
            const token = (req.headers['authorization'] || '').split(' ')[1];
            if (token) {
                const decoded = jwt.verify(token, SECRET_KEY);
                userId = decoded.userId || null;
                username = decoded.username || null;
            }
        } catch (_) {}
        const b = req.body || {};
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
        const result = await captureError({
            source: b.source || 'frontend',
            severity: b.severity || 'error',
            message: b.message || '(empty)',
            stack: b.stack || null,
            url: b.url || null,
            user_id: userId,
            username,
            user_agent: req.headers['user-agent'] || null,
            ip_address: ip,
            extra: b.extra || null
        });
        res.json({ success: true, ...(result || {}) });
    } catch (e) {
        // ไม่บอก error กลับ frontend (กัน loop) แค่ 200
        res.json({ success: false });
    }
});

// GET /admin/error-logs — ดู error log (super_admin)
apiRouter.get('/admin/error-logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { source, severity, resolved, limit = 100 } = req.query;
        const params = [];
        let where = '1=1';
        if (source) { where += ' AND source = ?'; params.push(source); }
        if (severity) { where += ' AND severity = ?'; params.push(severity); }
        if (resolved !== undefined && resolved !== '') {
            where += ' AND resolved = ?';
            params.push(resolved === '1' || resolved === 'true' ? 1 : 0);
        }
        params.push(Math.min(Number(limit) || 100, 500));
        const [rows] = await db.query(
            `SELECT id, source, severity, fingerprint, message, stack, url, user_id, username,
                    user_agent, ip_address, count, first_seen, last_seen, resolved, resolved_by, resolved_at
             FROM error_logs WHERE ${where} ORDER BY last_seen DESC LIMIT ?`,
            params
        );
        const [stat] = await db.query(`
            SELECT
              COUNT(*) AS total,
              COUNT(CASE WHEN resolved = 0 THEN 1 END) AS unresolved,
              COUNT(CASE WHEN source='frontend' AND resolved=0 THEN 1 END) AS frontend_open,
              COUNT(CASE WHEN source='backend' AND resolved=0 THEN 1 END) AS backend_open,
              COUNT(CASE WHEN severity='fatal' AND resolved=0 THEN 1 END) AS fatal_open,
              COUNT(CASE WHEN DATE(last_seen) = CURDATE() THEN 1 END) AS today
            FROM error_logs
        `);
        res.json({ success: true, data: rows, stats: stat[0] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /admin/error-logs/:id/resolve — mark error เป็น resolved
apiRouter.post('/admin/error-logs/:id/resolve', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query(
            'UPDATE error_logs SET resolved = 1, resolved_by = ?, resolved_at = NOW() WHERE id = ?',
            [req.user.userId, Number(req.params.id)]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /admin/error-logs/clear-resolved — ลบ error ที่ resolved แล้ว
apiRouter.delete('/admin/error-logs/clear-resolved', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [r] = await db.query('DELETE FROM error_logs WHERE resolved = 1');
        res.json({ success: true, deleted: r.affectedRows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Express error middleware — capture 500 errors ที่ไม่ได้ handle ใน route
// (ใส่ก่อน mount router — ต้องเอาก่อน app.listen)
// ฟังก์ชันนี้ export ให้ใช้ทีหลังตอน app.use

apiRouter.get('/online-users', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const windowMin = Math.max(1, Math.min(1440, parseInt(req.query.window || '5', 10))); // 1 นาที - 24 ชม
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.role, u.firstname, u.lastname, u.hospcode,
                    u.last_seen_at, u.last_seen_ip, u.last_seen_ua,
                    d.dept_name, h.hosname, dist.distname,
                    TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) AS idle_seconds
             FROM users u
             LEFT JOIN departments d ON u.dept_id = d.id
             LEFT JOIN chospital h ON u.hospcode = h.hoscode
             LEFT JOIN co_district dist ON dist.distid = h.distid
             WHERE u.last_seen_at IS NOT NULL
               AND u.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
             ORDER BY u.last_seen_at DESC`,
            [windowMin]
        );
        // สถิติสรุปแยก role
        const stats = {
            total: rows.length,
            by_role: {},
            window_min: windowMin,
            server_time: new Date().toISOString(),
        };
        for (const r of rows) {
            stats.by_role[r.role] = (stats.by_role[r.role] || 0) + 1;
        }
        res.json({ success: true, data: rows, stats });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
