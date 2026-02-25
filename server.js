const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs'); // ตัวเข้ารหัสผ่าน
const jwt = require('jsonwebtoken'); // ตัวสร้างบัตรพนักงานดิจิทัล

const app = express();
const port = 3000;
const SECRET_KEY = "Korat_Health_Secret_Key_2026"; // กุญแจลับสำหรับเซ็นรับรอง Token (ห้ามให้ใครรู้)

app.use(cors());
app.use(express.json());

let db;
async function connectDB() {
    try {
        db = await mysql.createConnection({
            host: 'localhost',
            port: 3307,
            user: 'root',
            password: 'rootpassword',
            database: 'kpi_korat_db'
        });
        console.log('🟢 API เชื่อมต่อฐานข้อมูลสำเร็จ!');
    } catch (error) {
        console.error('❌ เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', error);
    }
}
connectDB();

// ==========================================
// เมนู API ของเรา
// ==========================================

// 1. เช็คสถานะ (ที่คุณเพิ่งทดสอบไป)
app.get('/api/status', (req, res) => {
    res.json({ message: '🚀 ระบบ API สาธารณสุขโคราช พร้อมให้บริการใช้งานครับ!' });
});

// 2. เส้นทางพิเศษ: สำหรับสร้างผู้ใช้งานคนแรก (แอดมิน) ไว้ทดสอบ Login
app.get('/api/setup-user', async (req, res) => {
    try {
        const username = "admin_korat";
        const plainPassword = "password123"; // รหัสผ่านก่อนเข้ารหัส

        // ตรวจสอบว่ามีผู้ใช้นี้หรือยัง
        const [existing] = await db.execute('SELECT id FROM users WHERE username = ?', [username]);
        if(existing.length > 0) {
            return res.send("มีผู้ใช้งาน admin_korat ในระบบแล้วครับ ไม่ต้องสร้างใหม่");
        }

        // หา ID ของแผนก (สมมติว่าให้สังกัดแผนกแรกสุดในตาราง)
        const [depts] = await db.execute('SELECT id FROM departments LIMIT 1');
        const deptId = depts.length > 0 ? depts[0].id : null;

        // ทำการเข้ารหัสผ่าน (Hash)
        const hashedPassword = await bcrypt.hash(plainPassword, 10); 

        // บันทึกลงฐานข้อมูล
        await db.execute(
            'INSERT INTO users (username, password_hash, dept_id, role) VALUES (?, ?, ?, ?)', 
            [username, hashedPassword, deptId, 'admin']
        );

        res.send("🎉 สร้างผู้ใช้งานสำเร็จ! <br> Username: <b>admin_korat</b> <br> Password: <b>password123</b> <br> (รหัสผ่านถูกเข้ารหัสในฐานข้อมูลแล้ว)");
    } catch (error) {
        res.status(500).send("เกิดข้อผิดพลาด: " + error.message);
    }
});

// 3. ระบบ Login เข้าสู่ระบบ (รับข้อมูลแบบ POST)
app.post('/api/login', async (req, res) => {
    try {
        // รับ username และ password ที่ลูกค้าส่งมา
        const { username, password } = req.body;

        // ค้นหาผู้ใช้งานในตาราง users
        const [users] = await db.execute('SELECT * FROM users WHERE username = ?', [username]);
        
        if (users.length === 0) {
            return res.status(401).json({ message: 'ไม่พบชื่อผู้ใช้งานนี้' });
        }

        const user = users[0];

        // ตรวจสอบว่ารหัสผ่านตรงกันไหม (เทียบรหัสที่พิมพ์มา กับรหัสที่เข้ารหัสไว้)
        const isMatch = await bcrypt.compare(password, user.password_hash);
        
        if (!isMatch) {
            return res.status(401).json({ message: 'รหัสผ่านไม่ถูกต้อง' });
        }

        // ถ้าถูกต้อง สร้างบัตรดิจิทัล (JWT Token) ให้พกติดตัว
        const token = jwt.sign(
            { userId: user.id, username: user.username, deptId: user.dept_id, role: user.role },
            SECRET_KEY,
            { expiresIn: '8h' } // บัตรนี้มีอายุ 8 ชั่วโมง (1 วันทำการ)
        );

        // บันทึก Log ว่ามีการเข้าสู่ระบบ (Audit Trail)
        await db.execute(
            'INSERT INTO system_logs (user_id, action, details) VALUES (?, ?, ?)',
            [user.id, 'LOGIN', 'ผู้ใช้งานเข้าสู่ระบบสำเร็จ']
        );

        // ส่งบัตรดิจิทัลกลับไปให้
        res.json({ 
            message: 'เข้าสู่ระบบสำเร็จ', 
            token: token,
            userData: { username: user.username, role: user.role }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
    }
});

// API สำหรับดึงข้อมูล KPI ทั้งหมดมาแสดงในตาราง (Read)
app.get('/api/kpi-results', async (req, res) => {
    try {
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
                SUM(r.actual_value) AS total_actual
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            GROUP BY 
                mi.main_indicator_name, 
                i.kpi_indicators_name, 
                d.dept_name,
                r.year_bh                
            ORDER BY 
                mi.main_indicator_name DESC, 
                i.kpi_indicators_name DESC, 
                d.dept_name DESC,
                r.year_bh DESC;
        `;
        const [rows] = await db.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูล KPI ได้' });
    }
});

// API สำหรับบันทึก/แก้ไขคะแนน KPI (Update)
app.post('/api/update-kpi', async (req, res) => {
    const updates = req.body;
    
    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลสำหรับการบันทึก' });
    }

    try {
        await db.beginTransaction();

        for (const row of updates) {
            const { indicator_id, year_bh } = row;
            const months = [
                { col: 'oct', val: 10 }, { col: 'nov', val: 11 }, { col: 'dece', val: 12 },
                { col: 'jan', val: 1 }, { col: 'feb', val: 2 }, { col: 'mar', val: 3 },
                { col: 'apr', val: 4 }, { col: 'may', val: 5 }, { col: 'jun', val: 6 },
                { col: 'jul', val: 7 }, { col: 'aug', val: 8 }, { col: 'sep', val: 9 }
            ];

            for (const m of months) {
                const value = row[m.col];
                if (value !== undefined && value !== null) {
                    await db.query(
                        `UPDATE kpi_results SET actual_value = ? WHERE indicator_id = ? AND year_bh = ? AND month_bh = ?`,
                        [value, indicator_id, year_bh, m.val]
                    );
                }
            }
        }

        await db.commit();
        res.json({ success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' });
    } catch (error) {
        await db.rollback();
        console.error('Update Error:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
    }
});

// API สำหรับดึงข้อมูลสรุป Dashboard (Stats)
app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const year = req.query.year || (new Date().getFullYear() + 543).toString();

        // 1. ร้อยละความสำเร็จ KPI (Success Rate)
        const kpiSql = `
            SELECT 
                indicator_id,
                SUM(target_value) as total_target,
                SUM(actual_value) as total_actual
            FROM kpi_results
            WHERE year_bh = ?
            GROUP BY indicator_id
        `;
        const [kpiRows] = await db.query(kpiSql, [year]);
        
        let passedCount = 0;
        let totalKpis = kpiRows.length;
        
        kpiRows.forEach(row => {
            if (Number(row.total_target) > 0 && Number(row.total_actual) >= Number(row.total_target)) {
                passedCount++;
            }
        });
        
        const successRate = totalKpis > 0 ? ((passedCount / totalKpis) * 100).toFixed(1) : 0;

        // 2. หน่วยบริการที่บันทึกแล้ว (Recorded Service Units)
        const recordedSql = `
            SELECT COUNT(DISTINCT i.dept_id) as recorded_count
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            WHERE r.year_bh = ?
        `;
        const [recordedRows] = await db.query(recordedSql, [year]);
        const recordedCount = recordedRows[0].recorded_count || 0;

        const [totalDeptRows] = await db.query('SELECT COUNT(*) as total FROM departments');
        const totalDepts = totalDeptRows[0].total || 0;

        // 3. รอการตรวจสอบ (Pending Verification)
        const pendingSql = `
            SELECT COUNT(*) as pending_count 
            FROM kpi_results 
            WHERE status = 'Pending' AND year_bh = ?
        `;
        const [pendingRows] = await db.query(pendingSql, [year]);
        const pendingCount = pendingRows[0].pending_count || 0;

        res.json({
            success: true,
            data: {
                successRate,
                recordedCount,
                totalDepts,
                pendingCount,
                rank: 1 // Placeholder สำหรับอันดับ
            }
        });
    } catch (error) {
        console.error('Dashboard Stats Error:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลสถิติ' });
    }
});

app.listen(port, () => {
    console.log(`🚀 API Server เปิดทำงานแล้วที่พอร์ต ${port}`);
});