// เส้นทาง: รายการอ้างอิงสำหรับตัวกรอง (หน่วยงาน, หน่วยบริการ, ประเภท, อำเภอ) — กรองตามขอบเขต role
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { ROLE_SCOPE_DISTRICT, ROLE_SCOPE_HOSPCODE, ROLE_SCOPE_OWN_DEPT, getDistrictId, requireAction } = require('../core/access');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { zoneOfDistrict } = require('../core/zones');

// โซนที่บันทึกกับหน่วยบริการ: ส่งมา = ต้องเป็นเลข 1–9 | ว่าง/ไม่ส่ง = ตามอำเภอ (DISTRICT_ZONES) | undefined คืน = ค่าไม่ถูกต้อง
function hospitalZoneOf(zone, distid) {
    if (zone === undefined || zone === null || String(zone).trim() === '') return zoneOfDistrict(distid);
    return /^[1-9]$/.test(String(zone).trim()) ? String(zone).trim() : undefined;
}

// GET /departments — กรองเหลือเฉพาะ dept ตัวเองสำหรับ role ที่ scope คือ "dept ตัวเอง" (ROLE_SCOPE_OWN_DEPT)
// role อื่น (super_admin, admin_cup, admin_hos, admin_sso) เห็น "ทุก dept" แม้จะมี dept_id ติดตัวอยู่ก็ตาม (ตาราง Role System ใน CLAUDE.md)
apiRouter.get('/departments', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let where = '';
        const params = [];
        if (ROLE_SCOPE_OWN_DEPT.includes(user.role) && user.deptId != null) {
            where = 'WHERE id = ?';
            params.push(user.deptId);
        }
        const [depts] = await db.query(`SELECT * FROM departments ${where} ORDER BY dept_name`, params);
        res.json({ success: true, data: depts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// GET /hospitals — กรองตาม role scope: ROLE_SCOPE_HOSPCODE เห็นเฉพาะ hoscode ตัวเอง, ROLE_SCOPE_DISTRICT เห็นทุก hoscode ในอำเภอตัวเอง
// role อื่น (super_admin, admin_ssj) เห็นทุกหน่วยบริการ (ตาราง Role System ใน CLAUDE.md — admin_ssj scope คือ "ทุก hospcode")
apiRouter.get('/hospitals', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let where = '';
        const params = [];
        if (ROLE_SCOPE_HOSPCODE.includes(user.role) && user.hospcode) {
            where = 'WHERE h.hoscode = ?';
            params.push(user.hospcode);
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role) && user.hospcode) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where = 'WHERE h.distid = ?'; params.push(distid); }
        }
        const [hospitals] = await db.query(`
            SELECT h.hoscode, h.hosname, h.hostype, h.provcode, h.distcode, h.distid, h.zone,
                   t.hostypename, d.distname
              FROM chospital h
         LEFT JOIN chostype t ON t.hostypecode = h.hostype
         LEFT JOIN co_district d ON d.distid = h.distid
              ${where}
          ORDER BY FIELD(h.hostype,'05','06','07','18'), h.hosname
        `, params);
        res.json({ success: true, data: hospitals });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// === Hospitals CRUD (super_admin) ===
// POST /hospitals — create
apiRouter.post('/hospitals', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { hoscode, hosname, hostype, provcode, distcode } = req.body;
    if (!hoscode || !hosname) return res.status(400).json({ success: false, message: 'กรุณากรอก hoscode + hosname' });
    if (!/^[0-9A-Za-z_-]{1,20}$/.test(String(hoscode))) return res.status(400).json({ success: false, message: 'hoscode ไม่ถูกต้อง (สูงสุด 20 ตัวอักษร a-z, 0-9, _, -)' });
    try {
        const [exists] = await db.query('SELECT hoscode FROM chospital WHERE hoscode = ?', [hoscode]);
        if (exists.length > 0) return res.status(400).json({ success: false, message: 'hoscode นี้มีอยู่แล้ว' });
        const distid = (provcode && distcode) ? String(provcode) + String(distcode) : null;
        const zone = hospitalZoneOf(req.body.zone, distid);
        if (zone === undefined) return res.status(400).json({ success: false, message: 'โซนต้องเป็นตัวเลข 1–9' });
        await db.query(
            'INSERT INTO chospital (hoscode, hosname, hostype, provcode, distcode, distid, zone) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [hoscode, hosname, hostype || null, provcode || null, distcode || null, distid, zone]
        );
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'HOSPITAL_CREATE', 'chospital', JSON.stringify(req.body), req.ip]);
        res.json({ success: true, message: 'เพิ่มหน่วยบริการเรียบร้อย' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /hospitals/:hoscode — update
apiRouter.put('/hospitals/:hoscode', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { hoscode } = req.params;
    const { hosname, hostype, provcode, distcode } = req.body;
    if (!hosname) return res.status(400).json({ success: false, message: 'กรุณากรอก hosname' });
    try {
        const distid = (provcode && distcode) ? String(provcode) + String(distcode) : null;
        const zone = hospitalZoneOf(req.body.zone, distid);
        if (zone === undefined) return res.status(400).json({ success: false, message: 'โซนต้องเป็นตัวเลข 1–9' });
        const [r] = await db.query(
            'UPDATE chospital SET hosname=?, hostype=?, provcode=?, distcode=?, distid=?, zone=? WHERE hoscode = ?',
            [hosname, hostype || null, provcode || null, distcode || null, distid, zone, hoscode]
        );
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'ไม่พบหน่วยบริการนี้' });
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'HOSPITAL_UPDATE', 'chospital', JSON.stringify({ hoscode, ...req.body }), req.ip]);
        res.json({ success: true, message: 'อัปเดตเรียบร้อย' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /hospitals/:hoscode — delete (ตรวจสอบว่ามี user/kpi_results อ้างอิงอยู่หรือไม่)
apiRouter.delete('/hospitals/:hoscode', authenticateToken, isSuperAdmin, async (req, res) => {
    const { hoscode } = req.params;
    try {
        const [users] = await db.query('SELECT COUNT(*) AS cnt FROM users WHERE hospcode = ?', [hoscode]);
        const [results] = await db.query('SELECT COUNT(*) AS cnt FROM kpi_results WHERE hospcode = ? LIMIT 1', [hoscode]);
        if (users[0].cnt > 0 || results[0].cnt > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: มี user (${users[0].cnt}) หรือ ผลงาน KPI (${results[0].cnt}) อ้างอิงอยู่` });
        }
        const [r] = await db.query('DELETE FROM chospital WHERE hoscode = ?', [hoscode]);
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'ไม่พบหน่วยบริการนี้' });
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'HOSPITAL_DELETE', 'chospital', JSON.stringify({ hoscode }), req.ip]);
        res.json({ success: true, message: 'ลบเรียบร้อย' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /hostype — นับจำนวนหน่วยบริการเฉพาะในขอบเขตของ role (เหมือน /hospitals) กันนับรวมหน่วยบริการนอกขอบเขต
apiRouter.get('/hostype', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let hospJoinWhere = '';
        const params = [];
        if (ROLE_SCOPE_HOSPCODE.includes(user.role) && user.hospcode) {
            hospJoinWhere = 'AND h.hoscode = ?';
            params.push(user.hospcode);
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role) && user.hospcode) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { hospJoinWhere = 'AND h.distid = ?'; params.push(distid); }
        }
        const [rows] = await db.query(`
            SELECT t.hostypecode, t.hostypename, COUNT(h.hoscode) AS hospital_count
            FROM chostype t
            LEFT JOIN chospital h ON h.hostype = t.hostypecode ${hospJoinWhere}
            GROUP BY t.hostypecode, t.hostypename
            HAVING hospital_count > 0
            ORDER BY t.hostypecode
        `, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /districts — ROLE_SCOPE_DISTRICT (admin_cup/user_cup) เห็นเฉพาะอำเภอตัวเอง, role อื่นเห็นทุกอำเภอ
apiRouter.get('/districts', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let where = 'WHERE distid LIKE ?';
        const params = ['30%'];
        if (ROLE_SCOPE_DISTRICT.includes(user.role) && user.hospcode) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where = 'WHERE distid = ?'; params[0] = distid; }
        }
        // zone = โซนของอำเภอ (จากหน่วยบริการในอำเภอ — ทุกแห่งในอำเภอเดียวกันอยู่โซนเดียวกัน) ใช้กรองอำเภอตามโซนในหน้าต่างๆ
        const [districts] = await db.query(`SELECT distid, distname, (SELECT MAX(h.zone) FROM chospital h WHERE h.distid = co_district.distid) AS zone
            FROM co_district ${where} ORDER BY distname`, params);
        res.json({ success: true, data: districts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// GET /hospital-zones — รหัสหน่วยบริการ → โซน (ทุกแห่ง ไม่กรองตาม role: เป็นข้อมูลอ้างอิงสาธารณะของจังหวัด)
// ใช้แสดงป้าย "โซน N" ต่อท้ายชื่อหน่วยบริการทุกหน้า (frontend shared/zone-badge.ts แคชครั้งเดียว)
apiRouter.get('/hospital-zones', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query("SELECT hoscode, zone FROM chospital WHERE zone IS NOT NULL AND zone <> ''");
        const data = {};
        for (const r of rows) data[String(r.hoscode).trim()] = String(r.zone);
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
