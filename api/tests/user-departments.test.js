/**
 * กลุ่มงานเพิ่มเติมของผู้ใช้ (22 พ.ย. 2569 — ผู้ใช้ดูแลตัวชี้วัดข้ามกลุ่มงาน)
 *   - ผู้ใช้ทั่วไปขอกลุ่มงานเพิ่ม → ผู้ดูแล (super_admin / admin_ssj ของกลุ่มงานนั้น) อนุมัติ → เห็นและบันทึกผลงานตัวชี้วัดของกลุ่มงานนั้นได้ทันที
 *   - ผู้ดูแลกำหนดให้ได้ทันที: super_admin ทุกกลุ่มงาน, admin_ssj เฉพาะกลุ่มงานของตนเอง | ผู้ดูแลไม่ใช้กลุ่มงานเพิ่มเติม
 *   - ก่อนอนุมัติ/หลังเอาออก: ไม่เห็นและบันทึกไม่ได้ (กติกาเดิม)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { deptIdsOf, ROLE_MULTI_DEPT } = require('../core/access');

const YEAR = '2504';
const api = (p) => '/khupskpi/api' + p;
const as = (r, t) => r.set('Authorization', `Bearer ${t}`);
let app, db, deptA, deptB, deptC, indA, indB, hos, user, tok = {};

describe('core/access.js', () => {
    test('deptIdsOf: กลุ่มงานหลัก + เพิ่มเติม (authenticateToken ใส่ deptIds) / ไม่มี = กลุ่มงานหลัก', () => {
        expect(deptIdsOf({ deptId: 3 })).toEqual([3]);
        expect(deptIdsOf({ deptId: 3, deptIds: [3, 7] })).toEqual([3, 7]);
        expect(deptIdsOf({ deptId: null })).toEqual([]);
        expect(deptIdsOf(null)).toEqual([]);
        expect(ROLE_MULTI_DEPT).not.toContain('admin_ssj');
        expect(ROLE_MULTI_DEPT).toEqual(expect.arrayContaining(['user_hos', 'user_sso', 'user_cup', 'user_ssj']));
    });
});

describe('API กลุ่มงานเพิ่มเติม', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        await cleanupTestUsers(db, 'test\\_ud\\_');
        await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_ud %'");
        await db.query("DELETE FROM departments WHERE dept_name LIKE 'test\\_ud %'");
        const mkDept = async (n) => (await db.query('INSERT INTO departments (dept_name, dept_code) VALUES (?, ?)', [`test_ud ${n}`, `tud${n}`]))[0].insertId;
        deptA = await mkDept('A'); deptB = await mkDept('B'); deptC = await mkDept('C');
        const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
        hos = String(h.hoscode);
        const mk = async (role, dept, name) => {
            const u = await ensureTestUser(db, { username: `test_ud_${name}`, role, dept_id: dept, hospcode: hos });
            tok[name] = makeToken({ userId: u.id, username: u.username, role, deptId: dept, hospcode: hos });
            return u;
        };
        user = await mk('user_hos', deptA, 'user');
        await mk('super_admin', null, 'sa');
        await mk('admin_ssj', deptB, 'ssjB');
        await mk('admin_ssj', deptA, 'ssjA');
        await mk('admin_hos', deptA, 'ahos');
        const mkInd = async (name, dept) => (await db.query(
            "INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, evaluation_mode) VALUES (?, ?, 1, 'all_required')", [name, dept]))[0].insertId;
        indA = await mkInd('test_ud ตัวชี้วัด A', deptA);
        indB = await mkInd('test_ud ตัวชี้วัด B', deptB);
        for (const ind of [indA, indB]) {
            await db.query('INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, user_id, status) VALUES (?,?,?,?,?,?,?,?)',
                [ind, YEAR, hos, 10, '80', '90', user.id, 'Pending']);
        }
    });

    afterAll(async () => {
        await require('../server').summaryRefreshIdle();
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [[indA, indB]]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [[indA, indB]]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [[indA, indB]]);
        await db.query("DELETE FROM system_logs WHERE action_type LIKE 'USER\\_DEPT\\_%' AND user_id IN (SELECT id FROM users WHERE username LIKE 'test\\_ud\\_%')");
        await db.query("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'test\\_ud\\_%')");
        await cleanupTestUsers(db, 'test\\_ud\\_');
        await db.query('DELETE FROM departments WHERE id IN (?)', [[deptA, deptB, deptC]]);
    });

    const myDepts = async () => (await as(request(app).get(api('/departments')), tok.user)).body.data.map(d => Number(d.id)).sort();
    const visibleInds = async () => {
        const r = await as(request(app).get(api(`/kpi-results?year=${YEAR}`)), tok.user);
        return r.body.data.map(x => Number(x.indicator_id)).filter(id => [indA, indB].includes(id)).sort();
    };
    const saveB = () => as(request(app).post(api('/update-kpi')), tok.user)
        .send({ updates: [{ indicator_id: indB, year_bh: YEAR, hospcode: hos, target_value: '80', oct: '95' }] });
    const actualB = async () => (await db.query('SELECT actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = 10', [indB, YEAR, hos]))[0][0].actual_value;

    test('ก่อนได้รับกลุ่มงาน: เห็นและบันทึกได้เฉพาะกลุ่มงานหลัก', async () => {
        expect(await myDepts()).toEqual([deptA]);
        expect(await visibleInds()).toEqual([indA]);
        const r = await saveB();
        expect(r.status).not.toBe(200);
        expect(await actualB()).toBe('90');
    });

    test('ขอกลุ่มงาน: ขอกลุ่มงานหลัก = 400, ขอซ้ำ = 409, ผู้ดูแลขอไม่ได้ + แจ้งผู้อนุมัติ', async () => {
        const p = await as(request(app).post(api('/my-departments/request')), tok.user).send({ dept_id: deptA });
        expect(p.status).toBe(400);
        const ok = await as(request(app).post(api('/my-departments/request')), tok.user).send({ dept_id: deptB, note: 'ดูแลตัวชี้วัด B' });
        expect(ok.status).toBe(200);
        expect(ok.body.data.status).toBe('pending');
        const dup = await as(request(app).post(api('/my-departments/request')), tok.user).send({ dept_id: deptB });
        expect(dup.status).toBe(409);
        const adm = await as(request(app).post(api('/my-departments/request')), tok.ahos).send({ dept_id: deptB });
        expect(adm.status).toBe(403);
        const [[n]] = await db.query("SELECT COUNT(*) AS c FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = 'test_ud_ssjB') AND title = 'คำขอเพิ่มกลุ่มงาน'");
        expect(Number(n.c)).toBe(1);
        const mine = await as(request(app).get(api('/my-departments')), tok.user);
        expect(mine.body.data.extras).toEqual([expect.objectContaining({ dept_id: deptB, status: 'pending' })]);
        expect(mine.body.data.available.map(d => d.id)).not.toContain(deptB);
        expect(await visibleInds()).toEqual([indA]); // รออนุมัติยังไม่มีผล
    });

    test('ผู้อนุมัติ: admin_ssj ของกลุ่มงานอื่นไม่เห็น/อนุมัติไม่ได้, ไม่อนุมัติต้องมีเหตุผล', async () => {
        const listA = await as(request(app).get(api('/user-dept-requests')), tok.ssjA);
        expect(listA.body.data.requests.filter(r => r.dept_id === deptB)).toEqual([]);
        const listB = await as(request(app).get(api('/user-dept-requests')), tok.ssjB);
        const req = listB.body.data.requests.find(r => r.dept_id === deptB && r.username === 'test_ud_user');
        expect(req).toBeTruthy();
        const forbidden = await as(request(app).post(api(`/user-dept-requests/${req.id}/approve`)), tok.ssjA);
        expect(forbidden.status).toBe(403);
        const noNote = await as(request(app).post(api(`/user-dept-requests/${req.id}/reject`)), tok.ssjB).send({});
        expect(noNote.status).toBe(400);
        const ap = await as(request(app).post(api(`/user-dept-requests/${req.id}/approve`)), tok.ssjB);
        expect(ap.status).toBe(200);
        const again = await as(request(app).post(api(`/user-dept-requests/${req.id}/approve`)), tok.ssjB);
        expect(again.status).toBe(409);
    });

    test('อนุมัติแล้ว: เห็นกลุ่มงาน/ตัวชี้วัด B และบันทึกผลงานได้ทันที', async () => {
        expect(await myDepts()).toEqual([deptA, deptB].sort());
        expect(await visibleInds()).toEqual([indA, indB].sort());
        const r = await saveB();
        expect(r.status).toBe(200);
        expect(await actualB()).toBe('95');
        const [[n]] = await db.query("SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND title = 'อนุมัติกลุ่มงานเพิ่มเติมแล้ว'", [user.id]);
        expect(Number(n.c)).toBe(1);
    });

    test('ผู้ดูแลกำหนดเอง: admin_ssj แตะได้เฉพาะกลุ่มงานตัวเอง, super_admin ทุกกลุ่มงาน, เอาออก = ไม่เห็นทันที', async () => {
        const out = await as(request(app).put(api(`/users/${user.id}/departments`)), tok.ssjA).send({ dept_ids: [deptB, deptC] });
        expect(out.status).toBe(403);
        expect(out.body.code).toBe('DEPT_OUT_OF_SCOPE');
        const sa = await as(request(app).put(api(`/users/${user.id}/departments`)), tok.sa).send({ dept_ids: [deptB, deptC] });
        expect(sa.status).toBe(200);
        expect(sa.body.data.added).toEqual([deptC]);
        expect(await myDepts()).toEqual([deptA, deptB, deptC].sort());
        // admin_ssj B เอา B ออก (ส่งรายการว่าง) — C ที่อยู่นอกขอบเขตคงเดิม
        const rm = await as(request(app).put(api(`/users/${user.id}/departments`)), tok.ssjB).send({ dept_ids: [] });
        expect(rm.status).toBe(200);
        expect(rm.body.data.removed).toEqual([deptB]);
        expect(await myDepts()).toEqual([deptA, deptC].sort());
        expect(await visibleInds()).toEqual([indA]);
        const r = await saveB();
        expect(r.status).not.toBe(200);
    });

    test('ผู้ดูแลไม่ใช้กลุ่มงานเพิ่มเติม / ผู้ใช้ทั่วไปกำหนดให้คนอื่นไม่ได้', async () => {
        const [[a]] = await db.query("SELECT id FROM users WHERE username = 'test_ud_ahos'");
        const r = await as(request(app).put(api(`/users/${a.id}/departments`)), tok.sa).send({ dept_ids: [deptB] });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('ROLE_NOT_ELIGIBLE');
        const u = await as(request(app).put(api(`/users/${user.id}/departments`)), tok.user).send({ dept_ids: [deptB] });
        expect(u.status).toBe(403);
        const g = await as(request(app).get(api('/user-dept-requests')), tok.user);
        expect(g.status).toBe(403);
    });
});
