const express = require('express');
const cors = require('cors');
const db = require('./db'); // แก้ไข path ให้ถูกต้อง (เนื่องจากใน Docker ไฟล์จะอยู่ระดับเดียวกัน)
const bcrypt = require('bcryptjs'); // แนะนำใช้ bcryptjs เพื่อเลี่ยงปัญหา compile ใน docker alpine
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
// ใช้ Port จาก ENV หรือ Default 8830 ตามโจทย์
const port = process.env.PORT || 8830; 

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const SECRET_KEY = process.env.SECRET_KEY || "Korat_Health_Secret_Key_2026";

// สร้าง Router เพื่อรองรับ Prefix /khupskpi/api
const apiRouter = express.Router();

const saveLog = async (username, action, details, ip) => {
    try {
        await db.query(
            'INSERT INTO login_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
            [username, action, details, ip]
        );
    } catch (err) {
        console.error("Failed to save log:", err);
    }
};

// ==========================================
// ย้าย Route ทั้งหมดมาใส่ใน apiRouter
// ==========================================

apiRouter.get('/status', (req, res) => {
    res.json({ message: '🚀 API พร้อมใช้งานที่ /khupskpi/api' });
});

apiRouter.post('/login', async (req, res) => {
    const { username, password } = req.body;
    // ใช้ req.headers['x-forwarded-for'] กรณีอยู่หลัง Nginx/Docker Proxy
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        const [users] = await db.query(`
            SELECT u.*, d.dept_name, h.hosname, dist.distname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            WHERE u.username = ?
        `, [username]);

        if (users.length > 0) {
            const user = users[0];
            // ใช้ bcryptjs.compare
            const isMatch = await bcrypt.compare(password, user.password_hash);

            if (isMatch) {
                const serviceUnitDisplay = user.hosname ? `${user.hosname} ${user.distname ? 'อ.' + user.distname : ''}` : user.service_unit;

                await saveLog(username, 'login_success', 'เข้าสู่ระบบสำเร็จ', ip);
                const token = jwt.sign(
                    { userId: user.id, username: user.username, deptId: user.dept_id, role: user.role, hospcode: user.hospcode },
                    SECRET_KEY,
                    { expiresIn: '8h' }
                );
                res.json({ 
                    success: true, 
                    token, 
                    user: { 
                        id: user.id, 
                        username: user.username, 
                        role: user.role,
                        firstname: user.firstname,
                        lastname: user.lastname,
                        service_unit: serviceUnitDisplay,
                        dept_name: user.dept_name
                    } 
                });
            } else {
                await saveLog(username, 'login_failed', 'รหัสผ่านไม่ถูกต้อง', ip);
                res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
            }
        } else {
            await saveLog(username, 'login_failed', 'ไม่พบชื่อผู้ใช้งาน', ip);
            res.status(401).json({ success: false, message: 'ไม่พบชื่อผู้ใช้งาน' });
        }
    } catch (error) {
        console.error(error);
        await saveLog(username, 'system_error', error.message, ip);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่ Server' });
    }
});

apiRouter.get('/kpi-results', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        let user = null;
        if (token) {
            try {
                user = jwt.verify(token, SECRET_KEY);
            } catch (e) {}
        }

        let whereClause = '';
        let params = [];

        if (user && user.role !== 'admin') {
            if (user.hospcode === '00018' && user.deptId) {
                whereClause = 'WHERE i.dept_id = ?';
                params.push(user.deptId);
            } else if (user.hospcode) {
                whereClause = 'WHERE r.hospcode = ?';
                params.push(user.hospcode);
            } else if (user.deptId) {
                whereClause = 'WHERE i.dept_id = ?';
                params.push(user.deptId);
            }
        }

        const sql = `
            SELECT 
                if (mi.main_indicator_name is NULL,"ยังไม่กำหนด",mi.main_indicator_name) main_indicator_name,
                i.kpi_indicators_name,
                i.id AS indicator_id,
                d.dept_name,
                r.year_bh,
                SUM(r.target_value) AS target_value,
                SUM(CASE WHEN r.month_bh = 10 THEN r.actual_value ELSE 0 END) AS oct,
                SUM(CASE WHEN r.month_bh = 11 THEN r.actual_value ELSE 0 END) AS nov,
                SUM(CASE WHEN r.month_bh = 12 THEN r.actual_value ELSE 0 END) AS dece,
                SUM(CASE WHEN r.month_bh = 1 THEN r.actual_value ELSE 0 END) AS jan,
                SUM(CASE WHEN r.month_bh = 2 THEN r.actual_value ELSE 0 END) AS feb,
                SUM(CASE WHEN r.month_bh = 3 THEN r.actual_value ELSE 0 END) AS mar,
                SUM(CASE WHEN r.month_bh = 4 THEN r.actual_value ELSE 0 END) AS apr,
                SUM(CASE WHEN r.month_bh = 5 THEN r.actual_value ELSE 0 END) AS may,
                SUM(CASE WHEN r.month_bh = 6 THEN r.actual_value ELSE 0 END) AS jun,
                SUM(CASE WHEN r.month_bh = 7 THEN r.actual_value ELSE 0 END) AS jul,
                SUM(CASE WHEN r.month_bh = 8 THEN r.actual_value ELSE 0 END) AS aug,
                SUM(CASE WHEN r.month_bh = 9 THEN r.actual_value ELSE 0 END) AS sep,
                SUM(r.actual_value) AS total_actual,
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            ${whereClause}
            GROUP BY 
                mi.main_indicator_name, 
                i.kpi_indicators_name, 
                i.id,
                d.dept_name,
                r.year_bh                
            ORDER BY 
                mi.main_indicator_name DESC, 
                i.kpi_indicators_name DESC, 
                i.id DESC,
                d.dept_name DESC,
                r.year_bh DESC;
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูล KPI ได้' });
    }
});

apiRouter.post('/update-kpi', async (req, res) => {
    let updates = req.body;
    if (req.body && req.body.updates && Array.isArray(req.body.updates)) {
        updates = req.body.updates;
    }
    const targetHospcode = req.body.targetHospcode; 
    
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    let user;
    try {
        user = jwt.verify(token, SECRET_KEY);
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้อง' });
    }

    const hospcodeToSave = (user.role === 'admin' && targetHospcode) ? targetHospcode : user.hospcode;

    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        if (user.role !== 'admin') {
            const indicatorIds = [...new Set(updates.map(u => u.indicator_id))];
            if (indicatorIds.length > 0) {
                const [allowed] = await connection.query(
                    'SELECT id FROM kpi_indicators WHERE id IN (?) AND dept_id = ?',
                    [indicatorIds, user.deptId]
                );
                const allowedIds = allowed.map(a => a.id);
                const unauthorizedIds = indicatorIds.filter(id => !allowedIds.includes(id));
                if (unauthorizedIds.length > 0) throw new Error('ไม่มีสิทธิ์แก้ไขข้อมูลหน่วยงานอื่น');
            }
        }

        for (const row of updates) {
            const { indicator_id, year_bh } = row;
            const months = [
                { col: 'oct', val: 10 }, { col: 'nov', val: 11 }, { col: 'dece', val: 12 },
                { col: 'jan', val: 1 }, { col: 'feb', val: 2 }, { col: 'mar', val: 3 },
                { col: 'apr', val: 4 }, { col: 'may', val: 5 }, { col: 'jun', val: 6 },
                { col: 'jul', val: 7 }, { col: 'aug', val: 8 }, { col: 'sep', val: 9 }
            ];

            for (const m of months) {
                const rawActual = row[m.col];
                const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? Number(rawActual) : 0;
                let targetValue = 0;
                if (m.val === 10) {
                    const rawTarget = row.target_value;
                    targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? Number(rawTarget) : 0;
                }

                await connection.query(
                    'DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND month_bh = ? AND hospcode = ?',
                    [indicator_id, year_bh, m.val, hospcodeToSave]
                );

                if (actualValue > 0 || targetValue > 0) {
                    await connection.query(
                        `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [indicator_id, year_bh, m.val, actualValue, targetValue, user.userId, 'Pending', hospcodeToSave]
                    );
                }
            }
        }

        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'kpi_results', JSON.stringify({ message: `บันทึก KPI ${updates.length} รายการ` }), req.ip]
        );

        await connection.commit();
        res.json({ success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        console.error('Update Error:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึก' });
    } finally {
        connection.release();
    }
});

apiRouter.get('/kpi-template', async (req, res) => {
    try {
        const sql = `
            SELECT 
                if (mi.main_indicator_name is NULL,"ยังไม่กำหนด",mi.main_indicator_name) main_indicator_name,
                i.kpi_indicators_name,
                i.id AS indicator_id,
                d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            ORDER BY mi.main_indicator_name DESC, i.kpi_indicators_name DESC, d.dept_name DESC
        `;
        const [rows] = await db.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching template' });
    }
});

apiRouter.get('/dashboard-stats', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        let user = null;
        if (token) {
            try { user = jwt.verify(token, SECRET_KEY); } catch (e) {}
        }

        const year = req.query.year || (new Date().getFullYear() + 543).toString();
        let whereClause = '';
        let filterParams = [];

        if (user && user.role !== 'admin') {
            if (user.hospcode === '00018' && user.deptId) {
                whereClause = 'AND i.dept_id = ?';
                filterParams.push(user.deptId);
            } else if (user.hospcode) {
                whereClause = 'AND r.hospcode = ?';
                filterParams.push(user.hospcode);
            } else if (user.deptId) {
                whereClause = 'AND i.dept_id = ?';
                filterParams.push(user.deptId);
            }
        }
        
        const queryParams = [year, ...filterParams];

        const kpiSql = `
            SELECT r.indicator_id, SUM(r.target_value) as total_target, SUM(r.actual_value) as total_actual
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            WHERE r.year_bh = ? ${whereClause}
            GROUP BY r.indicator_id
        `;
        const [kpiRows] = await db.query(kpiSql, queryParams);
        
        let passedCount = 0;
        kpiRows.forEach(row => {
            if (Number(row.total_target) > 0 && Number(row.total_actual) >= Number(row.total_target)) passedCount++;
        });
        
        const successRate = kpiRows.length > 0 ? ((passedCount / kpiRows.length) * 100).toFixed(1) : 0;

        const recordedSql = `
            SELECT COUNT(DISTINCT i.dept_id) as recorded_count
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            WHERE r.year_bh = ? ${whereClause}
        `;
        const [recordedRows] = await db.query(recordedSql, queryParams);
        
        const [totalDeptRows] = await db.query('SELECT COUNT(*) as total FROM departments');
        
        const pendingSql = `
            SELECT COUNT(*) as pending_count FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            WHERE r.status = 'Pending' AND r.year_bh = ? ${whereClause}
        `;
        const [pendingRows] = await db.query(pendingSql, queryParams);

        res.json({
            success: true,
            data: {
                successRate,
                recordedCount: recordedRows[0].recorded_count || 0,
                totalDepts: totalDeptRows[0].total || 0,
                pendingCount: pendingRows[0].pending_count || 0,
                rank: 1
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Stats Error' });
    }
});

apiRouter.post('/approve-kpi', async (req, res) => {
    const approvals = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(403).json({ success: false }); }

    if (user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });
    if (!Array.isArray(approvals) || approvals.length === 0) return res.status(400).json({ success: false });

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        for (const item of approvals) {
            await connection.query(
                `UPDATE kpi_results SET status = 'Approved' WHERE indicator_id = ? AND year_bh = ? AND status = 'Pending'`,
                [item.indicator_id, item.year_bh]
            );
        }
        await connection.commit();
        res.json({ success: true, message: 'Approved' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false });
    } finally {
        connection.release();
    }
});

apiRouter.get('/users', async (req, res) => {
    try {
        const [users] = await db.query(`
            SELECT u.id, u.username, u.role, u.dept_id, u.firstname, u.lastname, u.phone, u.hospcode, d.dept_name,
                   h.hosname, dist.distname
            FROM users u 
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            ORDER BY u.id DESC
        `);
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/departments', async (req, res) => {
    try {
        const [depts] = await db.query('SELECT * FROM departments ORDER BY dept_name');
        res.json({ success: true, data: depts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/hospitals', async (req, res) => {
    try {
        const [hospitals] = await db.query('SELECT hoscode, hosname, CONCAT(provcode, distcode) as distid FROM chospital ORDER BY hoscode');
        res.json({ success: true, data: hospitals });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/districts', async (req, res) => {
    try {
        const [districts] = await db.query('SELECT distid, distname FROM co_district WHERE distid LIKE "30%" ORDER BY distname');
        res.json({ success: true, data: districts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.post('/users', async (req, res) => {
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone } = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(401).json({ success: false }); }

    try {
        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'Username exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, role, dept_id, firstname, lastname, hospcode, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, role, dept_id || null, firstname, lastname, hospcode, phone]
        );

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'INSERT', 'users', result.insertId, JSON.stringify({ username, role }), req.ip]
        );
        res.json({ success: true, message: 'User created' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.put('/users/:id', async (req, res) => {
    const userId = req.params.id;
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone } = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(401).json({ success: false }); }

    try {
        let sql = 'UPDATE users SET username = ?, role = ?, dept_id = ?, firstname = ?, lastname = ?, hospcode = ?, phone = ?';
        let params = [username, role, dept_id || null, firstname, lastname, hospcode, phone];

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
            [user.userId, user.deptId, 'UPDATE', 'users', userId, JSON.stringify({ username, role, password_changed: !!password }), req.ip]
        );
        res.json({ success: true, message: 'Updated' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.delete('/users/:id', async (req, res) => {
    const userId = req.params.id;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(401).json({ success: false }); }

    try {
        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'DELETE', 'users', userId, JSON.stringify({ message: `Deleted ID: ${userId}` }), req.ip]
        );
        res.json({ success: true, message: 'Deleted' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.put('/users/:id/reset-password', async (req, res) => {
    const userId = req.params.id;
    const defaultPassword = 'password123';
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(401).json({ success: false }); }

    try {
        const hashedPassword = await bcrypt.hash(defaultPassword, 10);
        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, userId]);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'users', userId, JSON.stringify({ message: 'Reset Password' }), req.ip]
        );
        res.json({ success: true, message: `Reset to "${defaultPassword}"` });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/system-logs', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false });

    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(403).json({ success: false }); }
    if (user.role !== 'admin') return res.status(403).json({ success: false });

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

// Mount Router ที่ path /khupskpi/api
app.use('/khupskpi/api', apiRouter);

app.listen(port, () => console.log(`🚀 API Server เปิดทำงานแล้วที่พอร์ต ${port} (Path: /khupskpi/api)`));
