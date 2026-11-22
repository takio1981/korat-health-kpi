/**
 * กลุ่มงานเพิ่มเติมของผู้ใช้ (22 พ.ย. 2569 — ผู้ใช้ดูแลตัวชี้วัดข้ามกลุ่มงาน)
 * ผู้ใช้เลือก: ผู้ดูแลกำหนดให้ได้ + ผู้ใช้ขอเอง (ผู้ดูแลอนุมัติ) | สิทธิ์ = ผู้ใช้ทั่วไปทุกระดับ (ROLE_MULTI_DEPT) | มีผลทุกหน้า
 *
 * ตาราง user_departments (user_id, dept_id) UNIQUE — status approved | pending | rejected (users.dept_id = กลุ่มงานหลัก ไม่อยู่ในตารางนี้)
 * ผู้มีสิทธิ์กำหนด/อนุมัติ: super_admin = ทุกกลุ่มงาน, admin_ssj = เฉพาะกลุ่มงานของตนเอง (ตรงกับขอบเขตการจัดการผู้ใช้เดิม)
 * มีผลผ่าน authenticateToken → user.deptIds (แคช session 2 นาที — เปลี่ยนแล้ว _sessionCache.delete(uid))
 */
const db = require('../db');
const { ROLE_MULTI_DEPT } = require('../core/access');

const MAX_EXTRA = 10;
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

/** กลุ่มงานที่ผู้ดูแลคนนี้กำหนด/อนุมัติได้: null = ทุกกลุ่มงาน (super_admin) | [id] (admin_ssj) | [] = ไม่มีสิทธิ์ */
function grantableDepts(actor) {
    if (!actor) return [];
    if (actor.role === 'super_admin') return null;
    if (actor.role === 'admin_ssj' && actor.deptId != null) return [Number(actor.deptId)];
    return [];
}
const canGrant = (actor, deptId) => { const g = grantableDepts(actor); return g === null || g.includes(Number(deptId)); };

async function loadUser(conn, userId) {
    const [[u]] = await conn.query('SELECT id, username, role, dept_id, firstname, lastname, hospcode FROM users WHERE id = ?', [userId]);
    return u || null;
}

/** รายการกลุ่มงานของผู้ใช้ (หลัก + เพิ่มเติมทุกสถานะ) */
async function listForUser(userId) {
    const u = await loadUser(db, userId);
    if (!u) return null;
    const [rows] = await db.query(
        `SELECT ud.id, ud.dept_id, d.dept_name, ud.status, ud.request_note, ud.decision_note, ud.requested_at, ud.decided_at,
                ud.decided_by, du.username AS decided_by_name
         FROM user_departments ud LEFT JOIN departments d ON d.id = ud.dept_id LEFT JOIN users du ON du.id = ud.decided_by
         WHERE ud.user_id = ? ORDER BY ud.status, d.dept_name`, [userId]);
    let primaryName = null;
    if (u.dept_id != null) { const [[d]] = await db.query('SELECT dept_name FROM departments WHERE id = ?', [u.dept_id]); primaryName = d ? d.dept_name : null; }
    return {
        user_id: u.id, role: u.role, eligible: ROLE_MULTI_DEPT.includes(u.role),
        primary: u.dept_id != null ? { dept_id: Number(u.dept_id), dept_name: primaryName } : null,
        extras: rows.map(r => ({ ...r, dept_id: Number(r.dept_id) })),
    };
}

async function notifyUser(conn, userId, title, message, actorId) {
    await conn.query("INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)", [userId, title, message, actorId || null]).catch(() => {});
}

/**
 * ผู้ดูแลกำหนดกลุ่มงานเพิ่มเติม (อนุมัติทันที) — deptIds = รายการที่ต้องการให้ "อนุมัติ" หลังบันทึก
 * super_admin: ตั้งทั้งชุด | admin_ssj: เพิ่ม/เอาออกได้เฉพาะกลุ่มงานของตนเอง (กลุ่มงานอื่นคงเดิม)
 * → { added, removed }
 */
async function setApprovedDepts(actor, userId, deptIds) {
    const grant = grantableDepts(actor);
    if (Array.isArray(grant) && !grant.length) throw httpError(403, 'FORBIDDEN', 'ไม่มีสิทธิ์กำหนดกลุ่มงานให้ผู้ใช้');
    if (!Array.isArray(deptIds)) throw httpError(400, 'BAD_INPUT', 'กรุณาระบุรายการกลุ่มงาน (dept_ids)');
    const want = [...new Set(deptIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const u = await loadUser(conn, userId);
        if (!u) throw httpError(404, 'NOT_FOUND', 'ไม่พบผู้ใช้');
        if (!ROLE_MULTI_DEPT.includes(u.role)) throw httpError(400, 'ROLE_NOT_ELIGIBLE', 'กลุ่มงานเพิ่มเติมใช้ได้เฉพาะผู้ใช้ทั่วไป (ไม่ใช่ผู้ดูแล)');
        const wantExtra = want.filter(d => Number(d) !== Number(u.dept_id));
        if (wantExtra.length > MAX_EXTRA) throw httpError(400, 'TOO_MANY', `กลุ่มงานเพิ่มเติมได้ไม่เกิน ${MAX_EXTRA} กลุ่มงาน`);
        if (wantExtra.length) {
            const [ok] = await conn.query('SELECT id FROM departments WHERE id IN (?)', [wantExtra]);
            if (ok.length !== wantExtra.length) throw httpError(400, 'BAD_DEPT', 'มีกลุ่มงานที่ไม่มีอยู่ในระบบ');
        }
        const [cur] = await conn.query('SELECT dept_id, status FROM user_departments WHERE user_id = ?', [userId]);
        const approvedNow = new Set(cur.filter(r => r.status === 'approved').map(r => Number(r.dept_id)));
        // ขอบเขตของผู้ดูแล: แตะได้เฉพาะกลุ่มงานที่กำหนดได้
        const inScope = (d) => grant === null || grant.includes(Number(d));
        const target = new Set(wantExtra.filter(inScope));
        for (const d of approvedNow) if (!inScope(d)) target.add(d); // กลุ่มงานนอกขอบเขต = คงเดิม
        const outOfScope = wantExtra.filter(d => !inScope(d) && !approvedNow.has(d));
        if (outOfScope.length) throw httpError(403, 'DEPT_OUT_OF_SCOPE', 'กำหนดได้เฉพาะกลุ่มงานของท่าน');
        const added = [...target].filter(d => !approvedNow.has(d));
        const removed = [...approvedNow].filter(d => !target.has(d));
        for (const d of added) {
            await conn.query(
                `INSERT INTO user_departments (user_id, dept_id, status, decided_by, decided_at) VALUES (?, ?, 'approved', ?, NOW())
                 ON DUPLICATE KEY UPDATE status = 'approved', decided_by = VALUES(decided_by), decided_at = NOW(), decision_note = NULL`, [userId, d, actor.userId]);
        }
        if (removed.length) await conn.query("DELETE FROM user_departments WHERE user_id = ? AND dept_id IN (?) AND status = 'approved'", [userId, removed]);
        await conn.commit();
        if (added.length || removed.length) {
            const names = await deptNames([...added, ...removed]);
            const txt = [added.length ? `เพิ่ม: ${added.map(d => names.get(d)).join(', ')}` : '', removed.length ? `เอาออก: ${removed.map(d => names.get(d)).join(', ')}` : ''].filter(Boolean).join(' · ');
            await notifyUser(db, userId, 'กลุ่มงานของท่านเปลี่ยนแปลง', `ผู้ดูแลปรับกลุ่มงานเพิ่มเติมของท่าน — ${txt} (มีผลทันทีเมื่อโหลดหน้าใหม่)`, actor.userId);
        }
        return { added, removed };
    } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
    } finally { conn.release(); }
}

async function deptNames(ids) {
    const m = new Map();
    if (!ids.length) return m;
    const [r] = await db.query('SELECT id, dept_name FROM departments WHERE id IN (?)', [ids]);
    for (const x of r) m.set(Number(x.id), x.dept_name);
    return m;
}

/** ผู้ใช้ขอกลุ่มงานเพิ่มเติม → pending + แจ้งเตือนผู้อนุมัติ (super_admin + admin_ssj ของกลุ่มงานนั้น) */
async function requestDept(user, deptId, note) {
    if (!ROLE_MULTI_DEPT.includes(user.role)) throw httpError(403, 'ROLE_NOT_ELIGIBLE', 'การขอกลุ่มงานเพิ่มเติมใช้ได้เฉพาะผู้ใช้ทั่วไป');
    const d = Number(deptId);
    if (!Number.isInteger(d) || d <= 0) throw httpError(400, 'BAD_DEPT', 'กรุณาเลือกกลุ่มงาน');
    if (Number(user.deptId) === d) throw httpError(400, 'PRIMARY_DEPT', 'กลุ่มงานนี้เป็นกลุ่มงานหลักของท่านอยู่แล้ว');
    const [[dept]] = await db.query('SELECT id, dept_name FROM departments WHERE id = ?', [d]);
    if (!dept) throw httpError(400, 'BAD_DEPT', 'ไม่พบกลุ่มงานนี้');
    const [[cur]] = await db.query('SELECT status FROM user_departments WHERE user_id = ? AND dept_id = ?', [user.userId, d]);
    if (cur && cur.status === 'approved') throw httpError(409, 'ALREADY_APPROVED', 'ท่านมีกลุ่มงานนี้อยู่แล้ว');
    if (cur && cur.status === 'pending') throw httpError(409, 'ALREADY_PENDING', 'ส่งคำขอกลุ่มงานนี้ไว้แล้ว รอผู้ดูแลอนุมัติ');
    const [[cnt]] = await db.query("SELECT COUNT(*) AS n FROM user_departments WHERE user_id = ? AND status IN ('approved', 'pending')", [user.userId]);
    if (Number(cnt.n) >= MAX_EXTRA) throw httpError(400, 'TOO_MANY', `กลุ่มงานเพิ่มเติม (รวมที่รออนุมัติ) ได้ไม่เกิน ${MAX_EXTRA} กลุ่มงาน`);
    const n = String(note || '').trim().slice(0, 500) || null;
    await db.query(
        `INSERT INTO user_departments (user_id, dept_id, status, request_note, requested_by, requested_at) VALUES (?, ?, 'pending', ?, ?, NOW())
         ON DUPLICATE KEY UPDATE status = 'pending', request_note = VALUES(request_note), requested_by = VALUES(requested_by), requested_at = NOW(),
           decided_by = NULL, decided_at = NULL, decision_note = NULL`, [user.userId, d, n, user.userId]);
    const [approvers] = await db.query(
        "SELECT id FROM users WHERE is_active = 1 AND (role = 'super_admin' OR (role = 'admin_ssj' AND dept_id = ?))", [d]);
    const [[me]] = await db.query('SELECT username, firstname, lastname FROM users WHERE id = ?', [user.userId]);
    const who = me ? `${me.firstname || ''} ${me.lastname || ''} (${me.username})`.trim() : `ผู้ใช้ #${user.userId}`;
    for (const a of approvers) {
        await notifyUser(db, a.id, 'คำขอเพิ่มกลุ่มงาน', `${who} ขอบันทึกผลงานตัวชี้วัดของกลุ่มงาน "${dept.dept_name}"${n ? ` — เหตุผล: ${n}` : ''} (อนุมัติที่หน้าจัดการผู้ใช้งาน)`, user.userId);
    }
    return { dept_id: d, dept_name: dept.dept_name, status: 'pending' };
}

/** ผู้ใช้ยกเลิกคำขอที่ยังรออนุมัติ */
async function cancelRequest(user, deptId) {
    const [r] = await db.query("DELETE FROM user_departments WHERE user_id = ? AND dept_id = ? AND status IN ('pending', 'rejected')", [user.userId, Number(deptId)]);
    if (!r.affectedRows) throw httpError(404, 'NOT_FOUND', 'ไม่พบคำขอที่ยกเลิกได้');
    return { cancelled: true };
}

/** คำขอรออนุมัติที่ผู้ดูแลคนนี้พิจารณาได้ */
async function pendingRequests(actor) {
    const grant = grantableDepts(actor);
    if (Array.isArray(grant) && !grant.length) return [];
    const [rows] = await db.query(
        `SELECT ud.id, ud.user_id, u.username, u.firstname, u.lastname, u.role, u.hospcode, u.dept_id AS primary_dept_id, pd.dept_name AS primary_dept_name,
                ud.dept_id, d.dept_name, ud.request_note, ud.requested_at
         FROM user_departments ud JOIN users u ON u.id = ud.user_id
         LEFT JOIN departments d ON d.id = ud.dept_id LEFT JOIN departments pd ON pd.id = u.dept_id
         WHERE ud.status = 'pending'${grant === null ? '' : ' AND ud.dept_id IN (?)'}
         ORDER BY ud.requested_at`, grant === null ? [] : [grant]);
    return rows;
}

/** ผู้ใช้ที่ได้รับกลุ่มงานเพิ่มเติม (อนุมัติแล้ว) ในกลุ่มงานที่ผู้ดูแลคนนี้กำหนดได้ — ใช้เอาออก (admin_ssj มองไม่เห็นผู้ใช้กลุ่มงานอื่นในรายชื่อผู้ใช้) */
async function grantedMembers(actor) {
    const grant = grantableDepts(actor);
    if (Array.isArray(grant) && !grant.length) return [];
    const [rows] = await db.query(
        `SELECT ud.id, ud.user_id, u.username, u.firstname, u.lastname, u.role, u.hospcode, pd.dept_name AS primary_dept_name,
                ud.dept_id, d.dept_name, ud.decided_at
         FROM user_departments ud JOIN users u ON u.id = ud.user_id
         LEFT JOIN departments d ON d.id = ud.dept_id LEFT JOIN departments pd ON pd.id = u.dept_id
         WHERE ud.status = 'approved'${grant === null ? '' : ' AND ud.dept_id IN (?)'}
         ORDER BY d.dept_name, u.username LIMIT 1000`, grant === null ? [] : [grant]);
    return rows;
}

/** อนุมัติ/ไม่อนุมัติคำขอ → { user_id, dept_id, status } */
async function decideRequest(actor, requestId, approve, note) {
    const [[r]] = await db.query(
        'SELECT ud.id, ud.user_id, ud.dept_id, ud.status, d.dept_name, u.role FROM user_departments ud JOIN users u ON u.id = ud.user_id LEFT JOIN departments d ON d.id = ud.dept_id WHERE ud.id = ?',
        [requestId]);
    if (!r) throw httpError(404, 'NOT_FOUND', 'ไม่พบคำขอ');
    if (!canGrant(actor, r.dept_id)) throw httpError(403, 'DEPT_OUT_OF_SCOPE', 'พิจารณาได้เฉพาะคำขอของกลุ่มงานของท่าน');
    if (r.status !== 'pending') throw httpError(409, 'NOT_PENDING', 'คำขอนี้ได้รับการพิจารณาแล้ว');
    if (approve && !ROLE_MULTI_DEPT.includes(r.role)) throw httpError(400, 'ROLE_NOT_ELIGIBLE', 'ผู้ใช้นี้ไม่ใช่ผู้ใช้ทั่วไปแล้ว (เปลี่ยนสิทธิ์) — อนุมัติไม่ได้');
    const n = String(note || '').trim().slice(0, 500) || null;
    if (!approve && !n) throw httpError(400, 'NOTE_REQUIRED', 'กรุณาระบุเหตุผลที่ไม่อนุมัติ');
    const status = approve ? 'approved' : 'rejected';
    const [u] = await db.query(
        "UPDATE user_departments SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ? AND status = 'pending'",
        [status, actor.userId, n, requestId]);
    if (!u.affectedRows) throw httpError(409, 'NOT_PENDING', 'คำขอนี้ได้รับการพิจารณาแล้ว');
    await notifyUser(db, r.user_id, approve ? 'อนุมัติกลุ่มงานเพิ่มเติมแล้ว' : 'ไม่อนุมัติกลุ่มงานเพิ่มเติม',
        approve ? `ท่านบันทึกผลงานตัวชี้วัดของกลุ่มงาน "${r.dept_name}" ได้แล้ว (โหลดหน้าใหม่เพื่อเห็นตัวชี้วัด)`
            : `คำขอกลุ่มงาน "${r.dept_name}" ไม่ได้รับอนุมัติ — เหตุผล: ${n}`, actor.userId);
    return { user_id: Number(r.user_id), dept_id: Number(r.dept_id), status };
}

module.exports = { MAX_EXTRA, grantableDepts, canGrant, listForUser, setApprovedDepts, requestDept, cancelRequest, pendingRequests, grantedMembers, decideRequest };
