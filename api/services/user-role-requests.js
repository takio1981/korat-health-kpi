/**
 * คำขอเปลี่ยนสิทธิ์การใช้งาน (Role) (23 พ.ย. 2569)
 * ผู้ใช้เลือก: ผู้ดูแลทุกระดับอนุมัติตามขอบเขต | ขอได้ทุก Role ยกเว้น super_admin | ผู้ใช้ขอเอง + ผู้ดูแลระดับพื้นที่ยื่นแทน
 *
 * ระดับ (ROLE_RANK): ผู้ใช้ทั่วไป 1 < admin_hos/admin_sso 2 < admin_cup 3 < admin_ssj 4 < super_admin 5
 * ผู้อนุมัติ: super_admin = ทุกคำขอ | ผู้ดูแลอื่น = ผู้ใช้ในขอบเขต (admin_ssj กลุ่มงาน, admin_cup อำเภอ, admin_hos/admin_sso หน่วยบริการ)
 *   และทั้ง Role ที่ขอ + Role ปัจจุบันของผู้ใช้ ต้องต่ำกว่าระดับของผู้อนุมัติ — อนุมัติคำขอของตนเองไม่ได้
 * อนุมัติแล้ว: users.role เปลี่ยน + ล้าง active_session_id (token เดิมเก็บ Role เดิม → SESSION_ENDED ต้องเข้าสู่ระบบใหม่)
 */
const db = require('../db');
const { getDistrictId } = require('../core/access');
const { ASSIGNABLE_ROLES } = require('./users');

const ROLE_RANK = {
    user: 1, user_hos: 1, user_sso: 1, user_cup: 1, user_ssj: 1,
    admin_hos: 2, admin_sso: 2, admin_cup: 3, admin_ssj: 4, super_admin: 5,
};
const APPROVER_ROLES = ['super_admin', 'admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso'];
const ON_BEHALF_ROLES = ['admin_hos', 'admin_sso', 'admin_cup'];
const REQUESTABLE_ROLES = ASSIGNABLE_ROLES;
const rankOf = (r) => ROLE_RANK[r] || 0;
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

async function loadUser(conn, id) {
    const [[u]] = await conn.query('SELECT id, username, firstname, lastname, role, dept_id, hospcode, is_active FROM users WHERE id = ?', [id]);
    return u || null;
}

/** ผู้ใช้เป้าหมายอยู่ในขอบเขตของผู้ดูแลหรือไม่ (ctx.distid = อำเภอของผู้ดูแล admin_cup คำนวณครั้งเดียว) */
function inScopeSync(actor, target, ctx = {}) {
    if (!actor || !target) return false;
    switch (actor.role) {
        case 'super_admin': return true;
        case 'admin_ssj': return actor.deptId != null && String(target.dept_id) === String(actor.deptId);
        case 'admin_cup': return !!ctx.distid && !!target.distid && String(target.distid) === String(ctx.distid);
        case 'admin_hos': case 'admin_sso': return !!actor.hospcode && String(target.hospcode) === String(actor.hospcode);
        default: return false;
    }
}

/** ตัดสินคำขอได้หรือไม่ (ฟังก์ชันล้วน — ขอบเขตตรวจด้วย inScopeSync) */
function canDecideSync(actor, target, toRole, ctx = {}, requestedBy = null) {
    if (!actor || !target || !APPROVER_ROLES.includes(actor.role)) return false;
    if (Number(actor.userId) === Number(target.id)) return false;
    // ผู้ยื่นแทนอนุมัติคำขอที่ตนยื่นไม่ได้ (ต้องผ่านผู้ดูแลอีกคน) — super_admin ก็เช่นกัน
    if (requestedBy != null && Number(actor.userId) === Number(requestedBy)) return false;
    if (actor.role === 'super_admin') return true;
    const r = rankOf(actor.role);
    return rankOf(toRole) < r && rankOf(target.role) < r && inScopeSync(actor, target, ctx);
}

async function scopeCtx(actor) {
    return actor && actor.role === 'admin_cup' ? { distid: await getDistrictId(actor.hospcode) } : {};
}
async function withDistid(rows) {
    const codes = [...new Set(rows.map(r => r.hospcode).filter(Boolean).map(String))];
    if (!codes.length) return rows;
    const [h] = await db.query('SELECT hoscode, distid FROM chospital WHERE hoscode IN (?)', [codes]);
    const m = new Map(h.map(x => [String(x.hoscode), x.distid]));
    return rows.map(r => ({ ...r, distid: m.get(String(r.hospcode)) || null }));
}

const fullName = (u) => u ? (`${u.firstname || ''} ${u.lastname || ''}`.trim() || u.username) + ` (${u.username})` : '';
async function notify(userId, title, message, actorId) {
    await db.query("INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)", [userId, title, message, actorId || null]).catch(() => {});
}

/** ผู้ดูแลที่อนุมัติคำขอนี้ได้ (แจ้งเตือน) */
async function approversFor(target, toRole, requestedBy) {
    const [t] = await withDistid([target]);
    const [rows] = await db.query(
        `SELECT id, role, dept_id, hospcode FROM users WHERE is_active = 1 AND role IN (?) AND id <> ?
           AND (role = 'super_admin' OR (role = 'admin_ssj' AND dept_id <=> ?) OR (role IN ('admin_hos','admin_sso') AND hospcode = ?) OR role = 'admin_cup')`,
        [APPROVER_ROLES, target.id, target.dept_id, target.hospcode || '']);
    const cups = await withDistid(rows.filter(r => r.role === 'admin_cup'));
    const cupDist = new Map(cups.map(c => [c.id, c.distid]));
    return rows.filter(a => canDecideSync({ userId: a.id, role: a.role, deptId: a.dept_id, hospcode: a.hospcode }, t, toRole, { distid: cupDist.get(a.id) }, requestedBy))
        .map(a => a.id);
}

/**
 * ยื่นคำขอ — targetUserId ว่าง/ตัวเอง = ขอเอง | อื่น = ผู้ดูแลระดับพื้นที่ยื่นแทนผู้ใช้ในขอบเขต
 * → { id, to_role, approvers }
 */
async function createRequest(actor, { userId, role, note }) {
    const targetId = userId == null || userId === '' ? Number(actor.userId) : Number(userId);
    if (!Number.isInteger(targetId) || targetId <= 0) throw httpError(400, 'BAD_INPUT', 'รหัสผู้ใช้ไม่ถูกต้อง');
    const self = targetId === Number(actor.userId);
    const target = await loadUser(db, targetId);
    if (!target) throw httpError(404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
    if (target.role === 'super_admin') throw httpError(403, 'FORBIDDEN', 'บัญชีผู้ดูแลระบบสูงสุดไม่ใช้การขอเปลี่ยนสิทธิ์');
    if (!self) {
        if (!ON_BEHALF_ROLES.includes(actor.role)) throw httpError(403, 'FORBIDDEN', 'ยื่นคำขอแทนผู้ใช้ได้เฉพาะผู้ดูแลระดับพื้นที่ (รพ./สสอ./CUP)');
        const [t] = await withDistid([target]);
        if (!inScopeSync(actor, t, await scopeCtx(actor))) throw httpError(403, 'OUT_OF_SCOPE', 'ผู้ใช้นี้อยู่นอกขอบเขตของท่าน');
    }
    const toRole = String(role || '').trim();
    if (!REQUESTABLE_ROLES.includes(toRole)) throw httpError(400, 'BAD_ROLE', 'กรุณาเลือกสิทธิ์การใช้งาน (Role) ที่ต้องการ');
    if (toRole === target.role) throw httpError(400, 'SAME_ROLE', 'ผู้ใช้มีสิทธิ์นี้อยู่แล้ว');
    const n = String(note || '').trim().slice(0, 500);
    if (!n) throw httpError(400, 'NOTE_REQUIRED', 'กรุณาระบุเหตุผลที่ขอเปลี่ยนสิทธิ์');
    const [[pend]] = await db.query("SELECT id FROM user_role_requests WHERE user_id = ? AND status = 'pending' LIMIT 1", [targetId]);
    if (pend) throw httpError(409, 'ALREADY_PENDING', 'มีคำขอเปลี่ยนสิทธิ์ที่รออนุมัติอยู่แล้ว — ยกเลิกคำขอเดิมก่อน');
    const [ins] = await db.query(
        'INSERT INTO user_role_requests (user_id, from_role, to_role, status, request_note, requested_by) VALUES (?, ?, ?, ?, ?, ?)',
        [targetId, target.role, toRole, 'pending', n, actor.userId]);
    const approvers = await approversFor(target, toRole, actor.userId);
    const by = self ? '' : ` (ยื่นโดยผู้ดูแล ${fullName(await loadUser(db, actor.userId))})`;
    for (const a of approvers) {
        await notify(a, 'คำขอเปลี่ยนสิทธิ์การใช้งาน',
            `${fullName(target)} ขอเปลี่ยนสิทธิ์จาก ${target.role} เป็น ${toRole}${by} — เหตุผล: ${n} (พิจารณาที่หน้าจัดการผู้ใช้งาน)`, actor.userId);
    }
    if (!self) await notify(targetId, 'มีการยื่นคำขอเปลี่ยนสิทธิ์ให้ท่าน', `ผู้ดูแลยื่นคำขอเปลี่ยนสิทธิ์ของท่านเป็น ${toRole} — รอผู้ดูแลระดับสูงกว่าอนุมัติ`, actor.userId);
    return { id: ins.insertId, user_id: targetId, from_role: target.role, to_role: toRole, approvers: approvers.length };
}

/** ยกเลิกคำขอที่รออนุมัติ — ผู้ใช้เจ้าของคำขอ หรือผู้ยื่นแทน */
async function cancelRequest(actor, id) {
    const [r] = await db.query(
        "UPDATE user_role_requests SET status = 'cancelled', decided_by = ?, decided_at = NOW() WHERE id = ? AND status = 'pending' AND (user_id = ? OR requested_by = ?)",
        [actor.userId, Number(id), actor.userId, actor.userId]);
    if (!r.affectedRows) throw httpError(404, 'NOT_FOUND', 'ไม่พบคำขอที่ยกเลิกได้');
    return { cancelled: true };
}

/** คำขอของผู้ใช้ (ล่าสุด 10 รายการ) + Role ที่ขอได้ */
async function myRequests(user) {
    const [rows] = await db.query(
        `SELECT r.id, r.from_role, r.to_role, r.status, r.request_note, r.decision_note, r.requested_at, r.decided_at, r.requested_by,
                du.username AS decided_by_name
         FROM user_role_requests r LEFT JOIN users du ON du.id = r.decided_by
         WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 10`, [user.userId]);
    const [[me]] = await db.query('SELECT role FROM users WHERE id = ?', [user.userId]);
    const role = me ? me.role : user.role;
    return {
        role, eligible: role !== 'super_admin',
        requestable: role === 'super_admin' ? [] : REQUESTABLE_ROLES.filter(r => r !== role),
        pending: rows.find(r => r.status === 'pending') || null,
        requests: rows,
    };
}

/** คำขอรออนุมัติที่ผู้ดูแลคนนี้ตัดสินได้ */
async function pendingFor(actor) {
    if (!APPROVER_ROLES.includes(actor.role)) return [];
    const [rows] = await db.query(
        `SELECT r.id, r.user_id, r.from_role, r.to_role, r.request_note, r.requested_at, r.requested_by,
                u.username, u.firstname, u.lastname, u.role, u.dept_id, u.hospcode, d.dept_name,
                rb.username AS requested_by_name
         FROM user_role_requests r JOIN users u ON u.id = r.user_id
         LEFT JOIN departments d ON d.id = u.dept_id LEFT JOIN users rb ON rb.id = r.requested_by
         WHERE r.status = 'pending' ORDER BY r.requested_at LIMIT 500`);
    const ctx = await scopeCtx(actor);
    const withD = await withDistid(rows);
    return withD.filter(r => canDecideSync(actor, { id: r.user_id, role: r.role, dept_id: r.dept_id, hospcode: r.hospcode, distid: r.distid }, r.to_role, ctx, r.requested_by))
        .map(({ distid, ...r }) => r);
}

/** คำขอที่ผู้ดูแลระดับพื้นที่ยื่นแทนไว้และยังรออนุมัติ */
async function filedBy(actor) {
    const [rows] = await db.query(
        `SELECT r.id, r.user_id, r.from_role, r.to_role, r.request_note, r.requested_at, u.username, u.firstname, u.lastname
         FROM user_role_requests r JOIN users u ON u.id = r.user_id
         WHERE r.status = 'pending' AND r.requested_by = ? AND r.user_id <> ? ORDER BY r.requested_at`, [actor.userId, actor.userId]);
    return rows;
}

/** อนุมัติ/ไม่อนุมัติ → { user_id, from_role, to_role, status } */
async function decideRequest(actor, id, approve, note) {
    const n = String(note || '').trim().slice(0, 500) || null;
    if (!approve && !n) throw httpError(400, 'NOTE_REQUIRED', 'กรุณาระบุเหตุผลที่ไม่อนุมัติ');
    const conn = await db.getConnection();
    let r, target;
    try {
        await conn.beginTransaction();
        [[r]] = await conn.query('SELECT * FROM user_role_requests WHERE id = ? FOR UPDATE', [Number(id)]);
        if (!r) throw httpError(404, 'NOT_FOUND', 'ไม่พบคำขอ');
        if (r.status !== 'pending') throw httpError(409, 'NOT_PENDING', 'คำขอนี้ได้รับการพิจารณาแล้ว');
        target = await loadUser(conn, r.user_id);
        if (!target) throw httpError(404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
        const [t] = await withDistid([target]);
        if (!canDecideSync(actor, t, r.to_role, await scopeCtx(actor), r.requested_by)) {
            const own = Number(actor.userId) === Number(target.id) || Number(actor.userId) === Number(r.requested_by);
            throw httpError(403, 'CANNOT_DECIDE', own
                ? 'พิจารณาคำขอที่ตนเองยื่นไม่ได้' : 'ท่านไม่มีสิทธิ์พิจารณาคำขอนี้ (นอกขอบเขต หรือสิทธิ์ที่ขอสูงกว่า/เท่ากับระดับของท่าน)');
        }
        if (approve && target.role !== r.from_role) {
            throw httpError(409, 'ROLE_CHANGED', `สิทธิ์ของผู้ใช้เปลี่ยนเป็น ${target.role} แล้วหลังยื่นคำขอ — ให้ผู้ใช้ยื่นคำขอใหม่`);
        }
        await conn.query("UPDATE user_role_requests SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?",
            [approve ? 'approved' : 'rejected', actor.userId, n, r.id]);
        if (approve) await conn.query('UPDATE users SET role = ?, active_session_id = NULL WHERE id = ?', [r.to_role, r.user_id]);
        await conn.commit();
    } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
    } finally { conn.release(); }
    await notify(r.user_id, approve ? 'อนุมัติการเปลี่ยนสิทธิ์แล้ว' : 'ไม่อนุมัติการเปลี่ยนสิทธิ์',
        approve ? `สิทธิ์การใช้งานของท่านเปลี่ยนจาก ${r.from_role} เป็น ${r.to_role} แล้ว — กรุณาเข้าสู่ระบบใหม่เพื่อใช้สิทธิ์ใหม่`
            : `คำขอเปลี่ยนสิทธิ์เป็น ${r.to_role} ไม่ได้รับอนุมัติ — เหตุผล: ${n}`, actor.userId);
    if (Number(r.requested_by) !== Number(r.user_id)) {
        await notify(r.requested_by, approve ? 'อนุมัติคำขอเปลี่ยนสิทธิ์ที่ท่านยื่นแทนแล้ว' : 'ไม่อนุมัติคำขอเปลี่ยนสิทธิ์ที่ท่านยื่นแทน',
            `${fullName(target)}: ${r.from_role} → ${r.to_role}${approve ? '' : ` — เหตุผล: ${n}`}`, actor.userId);
    }
    return { user_id: Number(r.user_id), from_role: r.from_role, to_role: r.to_role, status: approve ? 'approved' : 'rejected' };
}

module.exports = {
    ROLE_RANK, APPROVER_ROLES, ON_BEHALF_ROLES, REQUESTABLE_ROLES, rankOf, inScopeSync, canDecideSync,
    createRequest, cancelRequest, myRequests, pendingFor, filedBy, decideRequest,
};
