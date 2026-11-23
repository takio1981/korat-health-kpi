// เส้นทาง: คำขอเปลี่ยนสิทธิ์การใช้งาน (Role) (23 พ.ย. 2569)
// ผู้ใช้: ดู/ขอ/ยกเลิก (/my-role-request) | ผู้ดูแลระดับพื้นที่: ยื่นแทน (POST /role-requests) | ผู้ดูแลทุกระดับ: พิจารณาตามขอบเขต (/role-requests/:id/approve|reject)
// ขอบเขต/ระดับตรวจใน services/user-role-requests.js — ไม่อยู่ใน PAGE_ACCESS_RULES (path ไม่ตรงกฎใด)
// อนุมัติแล้วล้าง session ของผู้ใช้ (token เดิมเก็บ Role เดิม) → ต้องเข้าสู่ระบบใหม่

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isAnyAdmin, _sessionCache } = require('../core/auth');
const rr = require('../services/user-role-requests');

function sendErr(res, e) {
    if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    return res.status(500).json({ success: false, message: e && e.message });
}
const log = (req, action, value) => db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
    [req.user.userId, action, 'user_role_requests', JSON.stringify(value), req.ip]).catch(() => {});

// ---------- ผู้ใช้ ----------
apiRouter.get('/my-role-request', authenticateToken, async (req, res) => {
    try { res.json({ success: true, data: await rr.myRequests(req.user) }); } catch (e) { sendErr(res, e); }
});
apiRouter.post('/my-role-request', authenticateToken, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await rr.createRequest(req.user, { userId: req.user.userId, role: b.role, note: b.note });
        log(req, 'ROLE_REQUEST', out);
        res.json({ success: true, data: out, message: 'ส่งคำขอเปลี่ยนสิทธิ์แล้ว รอผู้ดูแลอนุมัติ' });
    } catch (e) { sendErr(res, e); }
});

// ---------- ผู้ดูแล ----------
apiRouter.get('/role-requests', authenticateToken, isAnyAdmin, async (req, res) => {
    try {
        const [requests, filed] = await Promise.all([rr.pendingFor(req.user), rr.filedBy(req.user)]);
        res.json({ success: true, data: { requests, filed, can_file: rr.ON_BEHALF_ROLES.includes(req.user.role), requestable: rr.REQUESTABLE_ROLES } });
    } catch (e) { sendErr(res, e); }
});
apiRouter.post('/role-requests', authenticateToken, isAnyAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await rr.createRequest(req.user, { userId: b.user_id, role: b.role, note: b.note });
        log(req, 'ROLE_REQUEST_ON_BEHALF', out);
        res.json({ success: true, data: out, message: 'ยื่นคำขอเปลี่ยนสิทธิ์แทนผู้ใช้แล้ว รอผู้ดูแลระดับสูงกว่าอนุมัติ' });
    } catch (e) { sendErr(res, e); }
});
apiRouter.post('/role-requests/:id/cancel', authenticateToken, async (req, res) => {
    try {
        const out = await rr.cancelRequest(req.user, req.params.id);
        log(req, 'ROLE_REQUEST_CANCEL', { request_id: Number(req.params.id) });
        res.json({ success: true, data: out, message: 'ยกเลิกคำขอแล้ว' });
    } catch (e) { sendErr(res, e); }
});
const decide = (approve) => async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, message: 'รหัสคำขอไม่ถูกต้อง' });
    try {
        const out = await rr.decideRequest(req.user, id, approve, (req.body || {}).note);
        if (approve) _sessionCache.delete(out.user_id);
        log(req, approve ? 'ROLE_REQUEST_APPROVE' : 'ROLE_REQUEST_REJECT', { request_id: id, ...out });
        res.json({ success: true, data: out, message: approve ? `อนุมัติแล้ว — สิทธิ์เปลี่ยนเป็น ${out.to_role} (ผู้ใช้ต้องเข้าสู่ระบบใหม่)` : 'ไม่อนุมัติแล้ว' });
    } catch (e) { sendErr(res, e); }
};
apiRouter.post('/role-requests/:id/approve', authenticateToken, isAnyAdmin, decide(true));
apiRouter.post('/role-requests/:id/reject', authenticateToken, isAnyAdmin, decide(false));
