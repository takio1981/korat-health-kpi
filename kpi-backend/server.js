const express = require('express');
const cors = require('cors');
const db = require('./db'); // แก้ไข path ให้ถูกต้อง (เนื่องจากใน Docker ไฟล์จะอยู่ระดับเดียวกัน)
const bcrypt = require('bcryptjs'); // แนะนำใช้ bcryptjs เพื่อเลี่ยงปัญหา compile ใน docker alpine
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
// ใช้ Port จาก ENV หรือ Default 8830 ตามโจทย์
const port = process.env.PORT || 8830; 

// Security Middleware
app.set('trust proxy', 1); // จำเป็นเมื่ออยู่หลัง Nginx Proxy เพื่อให้ Rate Limit ทำงานถูกต้องกับ IP จริง
app.use(helmet()); // เพิ่ม HTTP Headers เพื่อความปลอดภัย (XSS, Clickjacking, etc.)
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Global settings variables
let maxLoginAttempts = 10;

const updateSystemSettings = async () => {
    try {
        const [rows] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'max_login_attempts'");
        if (rows.length > 0) {
            maxLoginAttempts = parseInt(rows[0].setting_value, 10) || 10;
        }
    } catch (error) {
        console.error("Failed to load system settings:", error);
    }
};
// Load settings on start
updateSystemSettings();

// Rate Limiting: ป้องกัน Brute Force และ DDoS
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 นาที
    limit: (req, res) => maxLoginAttempts, // ใช้ค่าจากตัวแปรที่โหลดจาก DB
    message: { success: false, message: 'ทำรายการเกินกำหนด กรุณาลองใหม่ในอีก 15 นาที' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 นาที
    max: 300, // เรียก API ทั่วไปได้ 300 ครั้งต่อนาที (ปรับตามความเหมาะสม)
    standardHeaders: true,
    legacyHeaders: false,
});

const SECRET_KEY = process.env.SECRET_KEY;
if (!SECRET_KEY) {
    console.error('FATAL ERROR: SECRET_KEY is not defined.');
    process.exit(1);
}

// Middleware ตรวจสอบ JWT Token
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้องหรือหมดอายุ' });
        req.user = user;
        next();
    });
};

// Middleware ตรวจสอบสิทธิ์ Admin หรือ Super Admin
const isAdmin = (req, res, next) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'super_admin')) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบเท่านั้น' });
    }
};

// Middleware ตรวจสอบสิทธิ์ Super Admin เท่านั้น
const isSuperAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'super_admin') {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบสูงสุด (Super Admin) เท่านั้น' });
    }
};

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

apiRouter.post('/login', loginLimiter, async (req, res) => {
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

// ใช้ apiLimiter กับ Route ที่เหลือทั้งหมด (ป้องกันการยิง API รัวๆ)
apiRouter.use(apiLimiter);

apiRouter.get('/kpi-results', authenticateToken, async (req, res) => {
    try {
        const user = req.user;

        let whereClause = '';
        let params = [];

        if (user && user.role !== 'admin' && user.role !== 'super_admin') {
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
                r.year_bh,
                i.id AS indicator_id,
                d.dept_name,
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
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count,
                MAX(r.status) as indicator_status,
                MAX(CASE WHEN r.is_locked = 1 THEN 1 ELSE 0 END) as is_locked,
                r.hospcode,
                h.hosname,
                dist.distname
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            ${whereClause}
            GROUP BY
                mi.main_indicator_name,
                i.kpi_indicators_name,
                i.id,
                d.dept_name,
                r.year_bh,
                r.hospcode,
                h.hosname,
                dist.distname
            ORDER BY
                r.year_bh DESC,
                mi.main_indicator_name DESC,
                i.kpi_indicators_name DESC,
                i.id DESC,
                d.dept_name DESC;
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

    const hospcodeToSave = ((user.role === 'admin' || user.role === 'super_admin') && targetHospcode) ? targetHospcode : user.hospcode;

    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        if (user.role !== 'admin' && user.role !== 'super_admin') {
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
            // ใช้ hospcode จาก row ถ้ามี (admin แก้ไขข้อมูลของ hospcode อื่น) หรือ fallback เป็น hospcodeToSave
            const rowHospcode = ((user.role === 'admin' || user.role === 'super_admin') && row.hospcode) ? row.hospcode : hospcodeToSave;
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
                    [indicator_id, year_bh, m.val, rowHospcode]
                );

                if (actualValue > 0 || targetValue > 0) {
                    await connection.query(
                        `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [indicator_id, year_bh, m.val, actualValue, targetValue, user.userId, 'Pending', rowHospcode]
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

apiRouter.get('/dashboard-stats', authenticateToken, async (req, res) => {
    try {
        const user = req.user;

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


// --- Log Management ---
apiRouter.get('/logs/backup', authenticateToken, isAdmin, async (req, res) => {
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
        res.status(500).json({ success: false, message: 'ไม่สามารถสำรองข้อมูลได้' });
    }
});

apiRouter.delete('/logs/clear', authenticateToken, isAdmin, async (req, res) => {
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

apiRouter.get('/users', authenticateToken, isAdmin, async (req, res) => {
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

apiRouter.get('/departments', authenticateToken, async (req, res) => {
    try {
        const [depts] = await db.query('SELECT * FROM departments ORDER BY dept_name');
        res.json({ success: true, data: depts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/hospitals', authenticateToken, async (req, res) => {
    try {
        const [hospitals] = await db.query('SELECT hoscode, hosname, CONCAT(provcode, distcode) as distid FROM chospital ORDER BY hoscode');
        res.json({ success: true, data: hospitals });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/districts', authenticateToken, async (req, res) => {
    try {
        const [districts] = await db.query('SELECT distid, distname FROM co_district WHERE distid LIKE ? ORDER BY distname', ['30%']);
        res.json({ success: true, data: districts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.post('/users', authenticateToken, isAdmin, async (req, res) => {
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone } = req.body;
    const user = req.user;

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

// เปลี่ยนรหัสผ่านตัวเอง (ทุก role ใช้ได้)
apiRouter.put('/users/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) {
        return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้อง' });
    }

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
    }

    try {
        const [users] = await db.query('SELECT password_hash FROM users WHERE id = ?', [user.userId]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });

        const isMatch = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isMatch) return res.status(400).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, user.userId]);

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

apiRouter.put('/users/:id', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone } = req.body;
    const user = req.user;

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

apiRouter.delete('/users/:id', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;

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

apiRouter.put('/users/:id/reset-password', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;

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
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้องหรือหมดอายุ' }); }
    if (user.role !== 'admin' && user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบเท่านั้น' });

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

apiRouter.get('/settings', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM system_settings');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching settings' });
    }
});

apiRouter.post('/settings', async (req, res) => {
    const settings = req.body; // Expect array of { key, value }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(403).json({ success: false }); }

    if (user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only' });

    const connection = await db.getConnection();
    try {
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
        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: 'Update failed' });
    } finally {
        connection.release();
    }
});

// --- CRUD Main Yut (ยุทธศาสตร์) ---
apiRouter.get('/main-yut', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM main_yut ORDER BY id');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching strategies' });
    }
});

apiRouter.post('/main-yut', authenticateToken, isAdmin, async (req, res) => {
    const { yut_name } = req.body;
    try {
        await db.query('INSERT INTO main_yut (yut_name) VALUES (?)', [yut_name]);
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating strategy' });
    }
});

apiRouter.put('/main-yut/:id', authenticateToken, isAdmin, async (req, res) => {
    const { yut_name } = req.body;
    try {
        await db.query('UPDATE main_yut SET yut_name = ? WHERE id = ?', [yut_name, req.params.id]);
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating strategy' });
    }
});

apiRouter.delete('/main-yut/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM main_yut WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting strategy' });
    }
});

// --- CRUD Main Indicators (ตัวชี้วัดหลัก) ---
apiRouter.get('/main-indicators', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT mi.*, my.yut_name 
            FROM kpi_main_indicators mi 
            LEFT JOIN main_yut my ON mi.yut_id = my.id 
            ORDER BY mi.id
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching main indicators' });
    }
});

apiRouter.post('/main-indicators', authenticateToken, isAdmin, async (req, res) => {
    const { indicator_name, yut_id } = req.body;
    try {
        await db.query('INSERT INTO kpi_main_indicators (indicator_name, yut_id) VALUES (?, ?)', [indicator_name, yut_id]);
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating main indicator' });
    }
});

apiRouter.put('/main-indicators/:id', authenticateToken, isAdmin, async (req, res) => {
    const { indicator_name, yut_id } = req.body;
    try {
        await db.query('UPDATE kpi_main_indicators SET indicator_name = ?, yut_id = ? WHERE id = ?', [indicator_name, yut_id, req.params.id]);
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating main indicator' });
    }
});

apiRouter.delete('/main-indicators/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_main_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting main indicator' });
    }
});

// --- CRUD KPI Indicators (ตัวชี้วัดย่อย) ---
apiRouter.get('/indicators', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT i.*, mi.main_indicator_name as main_indicator_name, d.dept_name 
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON i.dept_id = d.id
            ORDER BY i.id DESC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching indicators:', error);
        res.status(500).json({ success: false, message: 'Error fetching indicators' });
    }
});

apiRouter.post('/indicators', authenticateToken, isAdmin, async (req, res) => {
    const { kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code } = req.body;
    try {
        await db.query(
            'INSERT INTO kpi_indicators (kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code) VALUES (?, ?, ?, ?, ?, ?)',
            [kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating indicator' });
    }
});

apiRouter.put('/indicators/:id', authenticateToken, isAdmin, async (req, res) => {
    const { kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code, is_active } = req.body;
    try {
        await db.query(
            'UPDATE kpi_indicators SET kpi_indicators_name=?, main_indicator_id=?, dept_id=?, target_percentage=?, weight=?, kpi_indicators_code=?, is_active=? WHERE id=?',
            [kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code, is_active, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating indicator' });
    }
});

apiRouter.delete('/indicators/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting indicator' });
    }
});

// อนุมัติผล KPI และ Lock ข้อมูล (รองรับทั้งรายการเดียวและหลายรายการ)
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

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UNLOCK', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, message: 'ปลดล็อคข้อมูล' }), req.ip]
        );

        res.json({ success: true, message: 'ปลดล็อคข้อมูลเรียบร้อยแล้ว' });
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

        let whereClause = "WHERE r.status = 'Pending' AND r.year_bh = ?";
        let params = [currentFY];

        if (user.role !== 'super_admin') {
            whereClause += " AND r.hospcode = ?";
            params.push(user.hospcode);
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
apiRouter.post('/departments', authenticateToken, isAdmin, async (req, res) => {
    const { dept_code, dept_name } = req.body;
    try {
        await db.query('INSERT INTO departments (dept_code, dept_name) VALUES (?, ?)', [dept_code, dept_name]);
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating department' });
    }
});

apiRouter.put('/departments/:id', authenticateToken, isAdmin, async (req, res) => {
    const { dept_code, dept_name } = req.body;
    try {
        await db.query('UPDATE departments SET dept_code=?, dept_name=? WHERE id=?', [dept_code, dept_name, req.params.id]);
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating department' });
    }
});

apiRouter.delete('/departments/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM departments WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting department' });
    }
});

// ========== Report Summary APIs ==========

// รายงานสรุป: รายข้อตัวชี้วัด
apiRouter.get('/report/by-indicator', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid } = req.query;
        let whereClauses = [];
        let params = [];

        if (user.role !== 'admin' && user.role !== 'super_admin') {
            if (user.hospcode === '00018' && user.deptId) {
                whereClauses.push('i.dept_id = ?');
                params.push(user.deptId);
            } else if (user.hospcode) {
                whereClauses.push('r.hospcode = ?');
                params.push(user.hospcode);
            }
        }
        if (year_bh) { whereClauses.push('r.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push("CONCAT(h.provcode, h.distcode) = ?"); params.push(distid); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                IFNULL(mi.main_indicator_name, 'ยังไม่กำหนด') AS main_indicator_name,
                d.dept_name,
                r.year_bh,
                MAX(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS target_value,
                SUM(CASE WHEN r.month_bh = 10 THEN r.actual_value ELSE 0 END) AS oct,
                SUM(CASE WHEN r.month_bh = 11 THEN r.actual_value ELSE 0 END) AS nov,
                SUM(CASE WHEN r.month_bh = 12 THEN r.actual_value ELSE 0 END) AS dece,
                SUM(CASE WHEN r.month_bh = 1 THEN r.actual_value ELSE 0 END) AS jan,
                SUM(CASE WHEN r.month_bh = 2 THEN r.actual_value ELSE 0 END) AS feb,
                SUM(CASE WHEN r.month_bh = 3 THEN r.actual_value ELSE 0 END) AS mar,
                SUM(CASE WHEN r.month_bh = 4 THEN r.actual_value ELSE 0 END) AS apr,
                SUM(CASE WHEN r.month_bh = 5 THEN r.actual_value ELSE 0 END) AS may_val,
                SUM(CASE WHEN r.month_bh = 6 THEN r.actual_value ELSE 0 END) AS jun,
                SUM(CASE WHEN r.month_bh = 7 THEN r.actual_value ELSE 0 END) AS jul,
                SUM(CASE WHEN r.month_bh = 8 THEN r.actual_value ELSE 0 END) AS aug,
                SUM(CASE WHEN r.month_bh = 9 THEN r.actual_value ELSE 0 END) AS sep,
                SUM(r.actual_value) AS total_actual,
                COUNT(DISTINCT r.hospcode) AS hospital_count
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            ${whereStr}
            GROUP BY i.id, i.kpi_indicators_name, mi.main_indicator_name, d.dept_name, r.year_bh
            ORDER BY mi.main_indicator_name, i.kpi_indicators_name
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-indicator error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายหน่วยบริการ
apiRouter.get('/report/by-hospital', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid } = req.query;
        let whereClauses = [];
        let params = [];

        if (user.role !== 'admin' && user.role !== 'super_admin') {
            if (user.hospcode) {
                whereClauses.push('r.hospcode = ?');
                params.push(user.hospcode);
            }
        }
        if (year_bh) { whereClauses.push('r.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push("CONCAT(h.provcode, h.distcode) = ?"); params.push(distid); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                r.hospcode,
                h.hosname,
                CONCAT(h.provcode, h.distcode) AS distid,
                dist.distname,
                r.year_bh,
                COUNT(DISTINCT r.indicator_id) AS indicator_count,
                SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS total_target,
                SUM(r.actual_value) AS total_actual,
                CASE WHEN SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) > 0
                     THEN ROUND((SUM(r.actual_value) / SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END)) * 100, 2)
                     ELSE 0 END AS achievement_pct,
                SUM(CASE WHEN r.status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            ${whereStr}
            GROUP BY r.hospcode, h.hosname, CONCAT(h.provcode, h.distcode), dist.distname, r.year_bh
            ORDER BY dist.distname, h.hosname
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-hospital error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายอำเภอ
apiRouter.get('/report/by-district', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id } = req.query;
        let whereClauses = [];
        let params = [];

        if (user.role !== 'admin' && user.role !== 'super_admin') {
            if (user.hospcode) {
                whereClauses.push('r.hospcode = ?');
                params.push(user.hospcode);
            }
        }
        if (year_bh) { whereClauses.push('r.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                CONCAT(h.provcode, h.distcode) AS distid,
                dist.distname,
                r.year_bh,
                COUNT(DISTINCT r.hospcode) AS hospital_count,
                COUNT(DISTINCT r.indicator_id) AS indicator_count,
                SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS total_target,
                SUM(r.actual_value) AS total_actual,
                CASE WHEN SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) > 0
                     THEN ROUND((SUM(r.actual_value) / SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END)) * 100, 2)
                     ELSE 0 END AS achievement_pct
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            ${whereStr}
            GROUP BY CONCAT(h.provcode, h.distcode), dist.distname, r.year_bh
            ORDER BY dist.distname
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-district error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายปีงบประมาณ
apiRouter.get('/report/by-year', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { dept_id, distid } = req.query;
        let whereClauses = [];
        let params = [];

        if (user.role !== 'admin' && user.role !== 'super_admin') {
            if (user.hospcode === '00018' && user.deptId) {
                whereClauses.push('i.dept_id = ?');
                params.push(user.deptId);
            } else if (user.hospcode) {
                whereClauses.push('r.hospcode = ?');
                params.push(user.hospcode);
            }
        }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push("CONCAT(h.provcode, h.distcode) = ?"); params.push(distid); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                r.year_bh,
                COUNT(DISTINCT r.indicator_id) AS indicator_count,
                COUNT(DISTINCT r.hospcode) AS hospital_count,
                SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS total_target,
                SUM(r.actual_value) AS total_actual,
                CASE WHEN SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) > 0
                     THEN ROUND((SUM(r.actual_value) / SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END)) * 100, 2)
                     ELSE 0 END AS achievement_pct,
                SUM(CASE WHEN r.status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            ${whereStr}
            GROUP BY r.year_bh
            ORDER BY r.year_bh DESC
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-year error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// ========== Auto-create tables for Approval & Notification system ==========
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                hospcode VARCHAR(10) NULL,
                type ENUM('approve','reject','info') NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT,
                indicator_id INT NULL,
                year_bh VARCHAR(10) NULL,
                is_read TINYINT(1) DEFAULT 0,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_hospcode (hospcode),
                INDEX idx_read (is_read)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_rejection_comments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                indicator_id INT NOT NULL,
                year_bh VARCHAR(10) NOT NULL,
                hospcode VARCHAR(10) NOT NULL,
                comment TEXT NOT NULL,
                reject_months VARCHAR(255) NULL,
                type ENUM('reject','reply') DEFAULT 'reject',
                rejected_by INT NULL,
                replied_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_kpi (indicator_id, year_bh, hospcode)
            )
        `);
        // Add columns if not exist (for existing tables)
        try {
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS reject_months VARCHAR(255) NULL AFTER comment`);
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS type ENUM('reject','reply') DEFAULT 'reject' AFTER reject_months`);
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS replied_by INT NULL AFTER rejected_by`);
        } catch (e) {
            // columns may already exist
        }
        console.log('✅ Notification & Rejection tables ready');
    } catch (err) {
        console.error('⚠️ Auto-create tables error:', err.message);
    }
})();

// ========== Rejection & Notification APIs ==========

// ตีกลับ KPI (admin only) - รองรับทั้งรายการเดียวและหลายรายการ
apiRouter.post('/reject-kpi', authenticateToken, isAdmin, async (req, res) => {
    const user = req.user;
    const items = Array.isArray(req.body) ? req.body : [req.body];

    if (items.length === 0 || !items[0].indicator_id) {
        return res.status(400).json({ success: false, message: 'No rejection data' });
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
            `SELECT n.*, u.firstname AS created_by_name, u.lastname AS created_by_lastname
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
        res.json({ success: true, message: 'ส่งตอบกลับเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// Mount Router ที่ path /khupskpi/api
app.use('/khupskpi/api', apiRouter);

app.listen(port, () => console.log(`🚀 API Server เปิดทำงานแล้วที่พอร์ต ${port} (Path: /khupskpi/api)`));
