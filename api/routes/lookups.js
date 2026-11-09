// เส้นทาง: รายการอ้างอิงสำหรับตัวกรอง (หน่วยงาน, หน่วยบริการ, ประเภท, อำเภอ) — กรองตามขอบเขต role
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { ROLE_SCOPE_DISTRICT, ROLE_SCOPE_HOSPCODE, ROLE_SCOPE_OWN_DEPT, getDistrictId, requireAction } = require('../core/access');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { isZoneCode } = require('../core/zones');
const { zoneOfDistrictDb, zoneExists, loadZoneData, invalidateZoneCache } = require('../services/zones');

// โซนที่บันทึกกับหน่วยบริการ: ส่งมา = ต้องเป็นรหัสโซนที่มีอยู่ (ตาราง zones) | ว่าง/ไม่ส่ง = โซนของอำเภอ (district_zones) | undefined คืน = ค่าไม่ถูกต้อง
async function hospitalZoneOf(zone, distid) {
    if (zone === undefined || zone === null || String(zone).trim() === '') return zoneOfDistrictDb(distid);
    const z = String(zone).trim();
    return isZoneCode(z) && await zoneExists(z) ? z : undefined;
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
        const zone = await hospitalZoneOf(req.body.zone, distid);
        if (zone === undefined) return res.status(400).json({ success: false, message: 'โซนไม่ถูกต้อง — เลือกจากโซนที่มีในแท็บ "โซน"' });
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
        const zone = await hospitalZoneOf(req.body.zone, distid);
        if (zone === undefined) return res.status(400).json({ success: false, message: 'โซนไม่ถูกต้อง — เลือกจากโซนที่มีในแท็บ "โซน"' });
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
        const [districts] = await db.query(`SELECT distid, distname, COALESCE((SELECT dz.zone_code FROM district_zones dz WHERE dz.distid = co_district.distid), (SELECT MAX(h.zone) FROM chospital h WHERE h.distid = co_district.distid)) AS zone
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

// ===== หน้าจัดการโซน (9 พ.ย. 2569) — แท็บ "โซน" ในหน้าจัดการตัวชี้วัด =====
// รหัสโซน = ตัวเลข 1–99 (สร้างอัตโนมัติ) + ชื่อโซน | โซนของอำเภอเก็บใน district_zones และย้ายอำเภอ = อัปเดต chospital.zone ทุกแห่งในอำเภอ
// สิทธิ์เหมือน /hospitals: เพิ่ม = requireAction add, แก้ไข/ย้ายอำเภอ = requireAction edit, ลบ = isSuperAdmin เท่านั้น
// path เจาะจง (/zones/districts) ต้องอยู่ก่อน /zones/:code
const zoneLog = (req, action, value) => db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
    [req.user.userId, action, 'zones', JSON.stringify(value), req.ip]).catch(() => {});

// GET /zones — ทุก role (ชื่อโซนใช้แสดงในตัวกรอง/ป้ายทุกหน้า): จำนวนอำเภอ/หน่วยบริการต่อโซน
apiRouter.get('/zones', authenticateToken, async (req, res) => {
    try {
        const { zones } = await loadZoneData({ fresh: true });
        const [dc] = await db.query('SELECT zone_code, COUNT(*) AS n FROM district_zones GROUP BY zone_code');
        const [hc] = await db.query("SELECT zone, COUNT(*) AS n FROM chospital WHERE zone IS NOT NULL AND zone <> '' GROUP BY zone");
        const dMap = new Map(dc.map(r => [String(r.zone_code), Number(r.n)]));
        const hMap = new Map(hc.map(r => [String(r.zone), Number(r.n)]));
        res.json({ success: true, data: zones.map(z => ({ code: String(z.code), name: z.name || '', sort_order: z.sort_order, district_count: dMap.get(String(z.code)) || 0, hospital_count: hMap.get(String(z.code)) || 0 })) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /zones/districts — ทุกอำเภอ + โซนที่ตั้ง + จำนวนหน่วยบริการแยกตามโซนที่บันทึกจริง (เตือนอำเภอที่หน่วยบริการอยู่คนละโซน)
apiRouter.get('/zones/districts', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const [dists] = await db.query("SELECT distid, distname FROM co_district WHERE distid LIKE '30%' ORDER BY distname");
        const { districtZone } = await loadZoneData({ fresh: true });
        const [hz] = await db.query("SELECT distid, COALESCE(NULLIF(zone, ''), '') AS zone, COUNT(*) AS n FROM chospital WHERE distid LIKE '30%' GROUP BY distid, COALESCE(NULLIF(zone, ''), '')");
        const byDist = new Map();
        for (const r of hz) {
            const m = byDist.get(String(r.distid)) || {};
            m[String(r.zone)] = Number(r.n);
            byDist.set(String(r.distid), m);
        }
        res.json({ success: true, data: dists.map(d => {
            const zone = districtZone.get(String(d.distid)) || '';
            const hzs = byDist.get(String(d.distid)) || {};
            const total = Object.values(hzs).reduce((a, b) => a + b, 0);
            return { distid: String(d.distid), distname: d.distname, zone, hospital_count: total, mismatch_count: total - (hzs[zone] || 0), hospital_zones: hzs };
        }) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /zones/districts { changes: [{ distid, zone }] } — ย้ายอำเภอ: บันทึกโซนของอำเภอ + ตั้งโซนให้หน่วยบริการทุกแห่งในอำเภอ (transaction เดียว)
apiRouter.put('/zones/districts', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : null;
    if (!changes || !changes.length || changes.length > 100) return res.status(400).json({ success: false, message: 'ไม่มีรายการที่เปลี่ยน' });
    const { zones } = await loadZoneData({ fresh: true }).catch(() => ({ zones: [] }));
    const codes = new Set(zones.map(z => String(z.code)));
    for (const c of changes) {
        if (!/^\d{4}$/.test(String(c?.distid || ''))) return res.status(400).json({ success: false, message: 'รหัสอำเภอไม่ถูกต้อง' });
        if (!codes.has(String(c?.zone || ''))) return res.status(400).json({ success: false, message: `ไม่มีโซน "${c?.zone ?? ''}" — เพิ่มโซนก่อน` });
    }
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const log = [];
        let hospitals = 0;
        for (const c of changes) {
            const distid = String(c.distid), zone = String(c.zone);
            const [[d]] = await conn.query('SELECT distname FROM co_district WHERE distid = ?', [distid]);
            if (!d) { await conn.rollback(); return res.status(400).json({ success: false, message: `ไม่พบอำเภอรหัส ${distid}` }); }
            const [[old]] = await conn.query('SELECT zone_code FROM district_zones WHERE distid = ?', [distid]);
            await conn.query('INSERT INTO district_zones (distid, zone_code, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE zone_code = VALUES(zone_code), updated_by = VALUES(updated_by)',
                [distid, zone, req.user.username]);
            const [u] = await conn.query('UPDATE chospital SET zone = ? WHERE distid = ?', [zone, distid]);
            hospitals += u.affectedRows;
            log.push({ distid, distname: d.distname, from: old?.zone_code || null, to: zone, hospitals: u.affectedRows });
        }
        await conn.commit();
        invalidateZoneCache();
        await zoneLog(req, 'ZONE_DISTRICT_UPDATE', log);
        res.json({ success: true, message: `ย้ายโซน ${log.length} อำเภอ (หน่วยบริการ ${hospitals} แห่ง) เรียบร้อย`, data: log });
    } catch (e) {
        await conn.rollback().catch(() => {});
        res.status(500).json({ success: false, message: e.message });
    } finally { conn.release(); }
});

// POST /zones { name } — เพิ่มโซน: รหัส = เลขถัดไป (สูงสุด 99)
apiRouter.post('/zones', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (name.length > 100) return res.status(400).json({ success: false, message: 'ชื่อโซนยาวเกิน 100 ตัวอักษร' });
    try {
        const [[m]] = await db.query('SELECT COALESCE(MAX(CAST(code AS UNSIGNED)), 0) AS mx FROM zones');
        const next = Number(m.mx) + 1;
        if (!isZoneCode(next)) return res.status(400).json({ success: false, message: 'เพิ่มได้สูงสุด 99 โซน' });
        await db.query('INSERT INTO zones (code, name, sort_order, updated_by) VALUES (?, ?, ?, ?)', [String(next), name || null, next, req.user.username]);
        invalidateZoneCache();
        await zoneLog(req, 'ZONE_CREATE', { code: String(next), name });
        res.json({ success: true, message: `เพิ่มโซน ${next} เรียบร้อย`, data: { code: String(next), name } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /zones/:code { name, sort_order? } — ตั้งชื่อ/ลำดับ
apiRouter.put('/zones/:code', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const code = String(req.params.code);
    const name = String(req.body?.name ?? '').trim();
    if (!isZoneCode(code)) return res.status(400).json({ success: false, message: 'รหัสโซนไม่ถูกต้อง' });
    if (name.length > 100) return res.status(400).json({ success: false, message: 'ชื่อโซนยาวเกิน 100 ตัวอักษร' });
    const sort = req.body?.sort_order === undefined ? null : parseInt(req.body.sort_order, 10);
    if (sort !== null && (!Number.isFinite(sort) || sort < 0 || sort > 9999)) return res.status(400).json({ success: false, message: 'ลำดับไม่ถูกต้อง' });
    try {
        const [r] = await db.query('UPDATE zones SET name = ?, sort_order = COALESCE(?, sort_order), updated_by = ? WHERE code = ?', [name || null, sort, req.user.username, code]);
        if (!r.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบโซนนี้' });
        invalidateZoneCache();
        await zoneLog(req, 'ZONE_UPDATE', { code, name, sort_order: sort });
        res.json({ success: true, message: 'บันทึกชื่อโซนเรียบร้อย' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /zones/:code — super_admin เท่านั้น และต้องไม่มีอำเภอ/หน่วยบริการอยู่ในโซน
apiRouter.delete('/zones/:code', authenticateToken, isSuperAdmin, async (req, res) => {
    const code = String(req.params.code);
    try {
        const [[d]] = await db.query('SELECT COUNT(*) AS n FROM district_zones WHERE zone_code = ?', [code]);
        const [[h]] = await db.query('SELECT COUNT(*) AS n FROM chospital WHERE zone = ?', [code]);
        if (d.n || h.n) return res.status(400).json({ success: false, message: `ลบไม่ได้ — ยังมี ${d.n} อำเภอ / ${h.n} หน่วยบริการในโซนนี้ ย้ายไปโซนอื่นก่อน` });
        const [r] = await db.query('DELETE FROM zones WHERE code = ?', [code]);
        if (!r.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบโซนนี้' });
        invalidateZoneCache();
        await zoneLog(req, 'ZONE_DELETE', { code });
        res.json({ success: true, message: `ลบโซน ${code} เรียบร้อย` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
