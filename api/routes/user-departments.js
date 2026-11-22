// เส้นทาง: กลุ่มงานเพิ่มเติมของผู้ใช้ (22 พ.ย. 2569 — ผู้ใช้ดูแลตัวชี้วัดข้ามกลุ่มงาน)
// ผู้ใช้: ดู/ขอ/ยกเลิกคำขอ (/my-departments) | ผู้ดูแล: กำหนดให้ทันที (/users/:id/departments) + อนุมัติคำขอ (/user-dept-requests)
// ขอบเขตผู้ดูแล (services/user-departments.js grantableDepts): super_admin = ทุกกลุ่มงาน, admin_ssj = กลุ่มงานของตนเอง
// ไม่อยู่ใน PAGE_ACCESS_RULES (path ไม่ตรงกฎใด) — ตรวจสิทธิ์ใน handler/service | เปลี่ยนแล้วล้างแคช session ของผู้ใช้นั้นให้มีผลทันที

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isAdmin, _sessionCache } = require('../core/auth');
const ud = require('../services/user-departments');

function sendErr(res, e) {
    if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    return res.status(500).json({ success: false, message: e && e.message });
}
const log = (req, action, value) => db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
    [req.user.userId, action, 'user_departments', JSON.stringify(value), req.ip]).catch(() => {});

// ---------- ผู้ใช้ ----------
apiRouter.get('/my-departments', authenticateToken, async (req, res) => {
    try {
        const data = await ud.listForUser(req.user.userId);
        if (!data) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้' });
        // กลุ่มงานที่ขอได้ = ทั้งหมด ยกเว้นกลุ่มงานหลัก และที่มี/รออนุมัติอยู่แล้ว (GET /departments ของผู้ใช้ถูกจำกัดตามขอบเขต จึงคืนรายการที่นี่)
        let available = [];
        if (data.eligible) {
            const taken = new Set([...(data.primary ? [data.primary.dept_id] : []), ...data.extras.filter(x => x.status !== 'rejected').map(x => x.dept_id)]);
            const [all] = await db.query('SELECT id, dept_name FROM departments ORDER BY dept_name');
            available = all.filter(d => !taken.has(Number(d.id))).map(d => ({ id: Number(d.id), dept_name: d.dept_name }));
        }
        res.json({ success: true, data: { ...data, available, max_extra: ud.MAX_EXTRA } });
    } catch (e) { sendErr(res, e); }
});
apiRouter.post('/my-departments/request', authenticateToken, async (req, res) => {
    try {
        const out = await ud.requestDept(req.user, (req.body || {}).dept_id, (req.body || {}).note);
        log(req, 'USER_DEPT_REQUEST', { dept_id: out.dept_id });
        res.json({ success: true, data: out, message: `ส่งคำขอกลุ่มงาน "${out.dept_name}" แล้ว รอผู้ดูแลอนุมัติ` });
    } catch (e) { sendErr(res, e); }
});
apiRouter.post('/my-departments/cancel', authenticateToken, async (req, res) => {
    try {
        res.json({ success: true, data: await ud.cancelRequest(req.user, (req.body || {}).dept_id), message: 'ยกเลิกคำขอแล้ว' });
    } catch (e) { sendErr(res, e); }
});

// ---------- ผู้ดูแล ----------
apiRouter.get('/users/:id/departments', authenticateToken, isAdmin, async (req, res) => {
    try {
        const data = await ud.listForUser(Number(req.params.id));
        if (!data) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้' });
        const g = ud.grantableDepts(req.user);
        res.json({ success: true, data: { ...data, grantable: g, max_extra: ud.MAX_EXTRA } });
    } catch (e) { sendErr(res, e); }
});
apiRouter.put('/users/:id/departments', authenticateToken, isAdmin, async (req, res) => {
    const uid = Number(req.params.id);
    if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ success: false, message: 'รหัสผู้ใช้ไม่ถูกต้อง' });
    try {
        const out = await ud.setApprovedDepts(req.user, uid, (req.body || {}).dept_ids);
        _sessionCache.delete(uid);
        log(req, 'USER_DEPT_SET', { user_id: uid, ...out });
        res.json({ success: true, data: { ...out, ...(await ud.listForUser(uid)) }, message: 'บันทึกกลุ่มงานเพิ่มเติมแล้ว' });
    } catch (e) { sendErr(res, e); }
});
apiRouter.get('/user-dept-requests', authenticateToken, isAdmin, async (req, res) => {
    try {
        const [requests, members] = await Promise.all([ud.pendingRequests(req.user), ud.grantedMembers(req.user)]);
        res.json({ success: true, data: { requests, members } });
    } catch (e) { sendErr(res, e); }
});
const decide = (approve) => async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'รหัสคำขอไม่ถูกต้อง' });
    try {
        const out = await ud.decideRequest(req.user, id, approve, (req.body || {}).note);
        _sessionCache.delete(out.user_id);
        log(req, approve ? 'USER_DEPT_APPROVE' : 'USER_DEPT_REJECT', { request_id: id, ...out });
        res.json({ success: true, data: out, message: approve ? 'อนุมัติแล้ว' : 'ไม่อนุมัติแล้ว' });
    } catch (e) { sendErr(res, e); }
};
apiRouter.post('/user-dept-requests/:id/approve', authenticateToken, isAdmin, decide(true));
apiRouter.post('/user-dept-requests/:id/reject', authenticateToken, isAdmin, decide(false));
