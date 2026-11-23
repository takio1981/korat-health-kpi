/**
 * คำขอเปลี่ยนสิทธิ์การใช้งาน (Role) (23 พ.ย. 2569)
 *   - ผู้ใช้ขอเอง (ต้องมีเหตุผล, ขอ super_admin ไม่ได้, รออนุมัติได้ครั้งละ 1 คำขอ)
 *   - ผู้อนุมัติ: ผู้ดูแลทุกระดับตามขอบเขต และสิทธิ์ที่ขอ + สิทธิ์ปัจจุบันต้องต่ำกว่าระดับของผู้อนุมัติ
 *   - ผู้ดูแลระดับพื้นที่ยื่นแทนผู้ใช้ในขอบเขต — อนุมัติคำขอที่ตนยื่นไม่ได้
 *   - อนุมัติแล้ว: role เปลี่ยน + ล้าง session (ต้องเข้าสู่ระบบใหม่)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const rr = require('../services/user-role-requests');
jest.setTimeout(60000);

const api = (p) => '/khupskpi/api' + p;
const as = (r, t) => r.set('Authorization', `Bearer ${t}`);
let app, db, deptA, deptB, hosX, hosY, hosZ, U = {}, tok = {};

describe('services/user-role-requests (ฟังก์ชันล้วน)', () => {
    const t = { id: 9, role: 'user_hos', dept_id: 1, hospcode: '1', distid: 'D1' };
    test('ระดับ + ขอบเขต + ห้ามพิจารณาของตนเอง', () => {
        expect(rr.canDecideSync({ userId: 1, role: 'super_admin' }, t, 'admin_ssj')).toBe(true);
        expect(rr.canDecideSync({ userId: 9, role: 'super_admin' }, t, 'admin_ssj')).toBe(false);
        expect(rr.canDecideSync({ userId: 1, role: 'super_admin' }, t, 'admin_ssj', {}, 1)).toBe(false);
        expect(rr.canDecideSync({ userId: 2, role: 'admin_ssj', deptId: 1 }, t, 'admin_cup')).toBe(true);
        expect(rr.canDecideSync({ userId: 2, role: 'admin_ssj', deptId: 1 }, t, 'admin_ssj')).toBe(false);
        expect(rr.canDecideSync({ userId: 2, role: 'admin_ssj', deptId: 2 }, t, 'user_ssj')).toBe(false);
        expect(rr.canDecideSync({ userId: 3, role: 'admin_cup', hospcode: 'x' }, t, 'admin_hos', { distid: 'D1' })).toBe(true);
        expect(rr.canDecideSync({ userId: 3, role: 'admin_cup', hospcode: 'x' }, t, 'admin_hos', { distid: 'D2' })).toBe(false);
        expect(rr.canDecideSync({ userId: 4, role: 'admin_hos', hospcode: '1' }, t, 'user_ssj')).toBe(true);
        expect(rr.canDecideSync({ userId: 4, role: 'admin_hos', hospcode: '1' }, t, 'admin_sso')).toBe(false);
        expect(rr.canDecideSync({ userId: 4, role: 'admin_hos', hospcode: '1' }, { ...t, role: 'admin_sso' }, 'user_hos')).toBe(false);
        expect(rr.canDecideSync({ userId: 5, role: 'user_ssj' }, t, 'user_cup')).toBe(false);
        expect(rr.REQUESTABLE_ROLES).not.toContain('super_admin');
    });
});

describe('API คำขอเปลี่ยนสิทธิ์', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        await cleanupTestUsers(db, 'test\\_rr\\_');
        await db.query("DELETE FROM departments WHERE dept_name LIKE 'test\\_rr %'");
        const mkDept = async (n) => (await db.query('INSERT INTO departments (dept_name, dept_code) VALUES (?, ?)', [`test_rr ${n}`, `trr${n}`]))[0].insertId;
        deptA = await mkDept('A'); deptB = await mkDept('B');
        const [[d]] = await db.query(`SELECT distid FROM chospital WHERE distid IS NOT NULL GROUP BY distid HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, distid LIMIT 1`);
        const [two] = await db.query('SELECT hoscode FROM chospital WHERE distid = ? ORDER BY hoscode LIMIT 2', [d.distid]);
        [hosX, hosY] = two.map(r => String(r.hoscode));
        const [[z]] = await db.query('SELECT hoscode FROM chospital WHERE distid IS NOT NULL AND distid <> ? ORDER BY hoscode LIMIT 1', [d.distid]);
        hosZ = String(z.hoscode);
        const mk = async (name, role, dept, hos) => {
            const u = await ensureTestUser(db, { username: `test_rr_${name}`, role, dept_id: dept, hospcode: hos });
            await db.query('UPDATE users SET role = ?, dept_id = ?, hospcode = ?, is_active = 1, active_session_id = ? WHERE id = ?', [role, dept, hos, 'sess-' + name, u.id]);
            U[name] = u.id;
            tok[name] = makeToken({ userId: u.id, username: `test_rr_${name}`, role, deptId: dept, hospcode: hos });
        };
        await mk('user', 'user_hos', deptA, hosX);
        await mk('user2', 'user_hos', deptA, hosX);
        await mk('ahos', 'admin_hos', deptA, hosX);
        await mk('ahosZ', 'admin_hos', deptA, hosZ);
        await mk('cup', 'admin_cup', deptA, hosY);
        await mk('ssjA', 'admin_ssj', deptA, hosZ);
        await mk('ssjB', 'admin_ssj', deptB, hosZ);
        await mk('sa', 'super_admin', null, hosZ);
    });

    afterAll(async () => {
        const ids = Object.values(U);
        await db.query('DELETE FROM user_role_requests WHERE user_id IN (?)', [ids]);
        await db.query("DELETE FROM system_logs WHERE action_type LIKE 'ROLE\\_REQUEST%' AND user_id IN (?)", [ids]);
        await db.query('DELETE FROM notifications WHERE user_id IN (?)', [ids]);
        await cleanupTestUsers(db, 'test\\_rr\\_');
        await db.query('DELETE FROM departments WHERE id IN (?)', [[deptA, deptB]]);
    });

    const notes = async (name, title) => Number((await db.query('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = ?', [U[name], title]))[0][0].c);
    const roleOf = async (name) => (await db.query('SELECT role, active_session_id FROM users WHERE id = ?', [U[name]]))[0][0];
    let reqId;

    test('ผู้ใช้ขอเอง: ต้องมีเหตุผล, ขอ super_admin/สิทธิ์เดิมไม่ได้, ขอซ้ำ = 409 + แจ้งเฉพาะผู้อนุมัติที่มีสิทธิ์', async () => {
        const noNote = await as(request(app).post(api('/my-role-request')), tok.user).send({ role: 'admin_hos' });
        expect(noNote.status).toBe(400);
        const sa = await as(request(app).post(api('/my-role-request')), tok.user).send({ role: 'super_admin', note: 'x' });
        expect(sa.body.code).toBe('BAD_ROLE');
        const same = await as(request(app).post(api('/my-role-request')), tok.user).send({ role: 'user_hos', note: 'x' });
        expect(same.body.code).toBe('SAME_ROLE');
        const ok = await as(request(app).post(api('/my-role-request')), tok.user).send({ role: 'admin_hos', note: 'ได้รับมอบหมายเป็นผู้ดูแล รพ.' });
        expect(ok.status).toBe(200);
        reqId = ok.body.data.id;
        const dup = await as(request(app).post(api('/my-role-request')), tok.user).send({ role: 'admin_cup', note: 'x' });
        expect(dup.status).toBe(409);
        const t = 'คำขอเปลี่ยนสิทธิ์การใช้งาน';
        expect(await notes('cup', t)).toBe(1);
        expect(await notes('ssjA', t)).toBe(1);
        expect(await notes('sa', t)).toBe(1);
        expect(await notes('ahos', t)).toBe(0);  // ระดับเท่ากับสิทธิ์ที่ขอ
        expect(await notes('ssjB', t)).toBe(0);  // คนละกลุ่มงาน
        const mine = await as(request(app).get(api('/my-role-request')), tok.user);
        expect(mine.body.data.pending).toEqual(expect.objectContaining({ to_role: 'admin_hos', status: 'pending' }));
        expect(mine.body.data.requestable).not.toContain('user_hos');
    });

    test('ผู้อนุมัติ: เห็น/อนุมัติได้เฉพาะในขอบเขตและระดับสูงกว่า, ไม่อนุมัติต้องมีเหตุผล', async () => {
        const list = async (n) => (await as(request(app).get(api('/role-requests')), tok[n])).body.data.requests.map(r => r.id);
        expect(await list('ahos')).not.toContain(reqId);
        expect(await list('ssjB')).not.toContain(reqId);
        expect(await list('cup')).toContain(reqId);
        expect((await as(request(app).post(api(`/role-requests/${reqId}/approve`)), tok.ahos)).status).toBe(403);
        expect((await as(request(app).post(api(`/role-requests/${reqId}/approve`)), tok.ssjB)).status).toBe(403);
        expect((await as(request(app).get(api('/role-requests')), tok.user)).status).toBe(403);
        expect((await as(request(app).post(api(`/role-requests/${reqId}/reject`)), tok.cup).send({})).status).toBe(400);
        const ap = await as(request(app).post(api(`/role-requests/${reqId}/approve`)), tok.cup);
        expect(ap.status).toBe(200);
        expect(await roleOf('user')).toEqual({ role: 'admin_hos', active_session_id: null });
        expect(await notes('user', 'อนุมัติการเปลี่ยนสิทธิ์แล้ว')).toBe(1);
        expect((await as(request(app).post(api(`/role-requests/${reqId}/approve`)), tok.cup)).status).toBe(409);
    });

    test('ผู้ดูแลระดับพื้นที่ยื่นแทน: ในขอบเขตเท่านั้น, ผู้ยื่นอนุมัติเองไม่ได้, ผู้ใช้ยกเลิกได้', async () => {
        const notAdmin = await as(request(app).post(api('/role-requests')), tok.user2).send({ user_id: U.user, role: 'user_ssj', note: 'x' });
        expect(notAdmin.status).toBe(403);
        const out = await as(request(app).post(api('/role-requests')), tok.ahosZ).send({ user_id: U.user2, role: 'user_ssj', note: 'x' });
        expect(out.body.code).toBe('OUT_OF_SCOPE');
        const ok = await as(request(app).post(api('/role-requests')), tok.ahos).send({ user_id: U.user2, role: 'user_ssj', note: 'ย้ายไปปฏิบัติงานที่ สสจ.' });
        expect(ok.status).toBe(200);
        const id = ok.body.data.id;
        expect(await notes('user2', 'มีการยื่นคำขอเปลี่ยนสิทธิ์ให้ท่าน')).toBe(1);
        expect(await notes('ahos', 'คำขอเปลี่ยนสิทธิ์การใช้งาน')).toBe(0);
        const filed = await as(request(app).get(api('/role-requests')), tok.ahos);
        expect(filed.body.data.filed.map(r => r.id)).toContain(id);
        expect(filed.body.data.requests.map(r => r.id)).not.toContain(id);
        expect((await as(request(app).post(api(`/role-requests/${id}/approve`)), tok.ahos)).status).toBe(403);
        const c = await as(request(app).post(api(`/role-requests/${id}/cancel`)), tok.user2);
        expect(c.status).toBe(200);
        expect((await as(request(app).post(api(`/role-requests/${id}/cancel`)), tok.user2)).status).toBe(404);
        expect((await roleOf('user2')).role).toBe('user_hos');
    });

    test('สิทธิ์เปลี่ยนหลังยื่นคำขอ = อนุมัติไม่ได้ (409) / ไม่อนุมัติพร้อมเหตุผล', async () => {
        const ok = await as(request(app).post(api('/my-role-request')), tok.user2).send({ role: 'user_cup', note: 'ดูแลทั้งอำเภอ' });
        const id = ok.body.data.id;
        await db.query("UPDATE users SET role = 'user_sso' WHERE id = ?", [U.user2]);
        const ap = await as(request(app).post(api(`/role-requests/${id}/approve`)), tok.sa);
        expect(ap.body.code).toBe('ROLE_CHANGED');
        const rj = await as(request(app).post(api(`/role-requests/${id}/reject`)), tok.sa).send({ note: 'ยังไม่ได้รับมอบหมาย' });
        expect(rj.status).toBe(200);
        expect(await notes('user2', 'ไม่อนุมัติการเปลี่ยนสิทธิ์')).toBe(1);
        expect((await roleOf('user2')).role).toBe('user_sso');
    });
});
