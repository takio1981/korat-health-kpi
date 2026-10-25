/**
 * ขอบเขตสิทธิ์ของผู้ดูแลเมื่อเพิ่ม/แก้ไขผู้ใช้ (พบจากการทดสอบทั้งระบบ 25 ต.ค. 2569)
 * - admin_ssj แก้ role ผู้ใช้ในหน่วยงานตัวเองเป็น super_admin ได้ทันที (ไม่ผ่านการอนุมัติ) — ยกระดับสิทธิ์
 * - admin_hos/admin_sso ย้าย hospcode ผู้ใช้ไปหน่วยบริการอื่น / admin_cup ย้ายไปอำเภออื่นได้ (ตรวจเฉพาะ hospcode เดิม)
 * - ส่งข้อมูลไม่ครบ → 500 / แก้ไข-ลบ-รีเซ็ตรหัสผ่านผู้ใช้ที่ไม่มีอยู่ → "สำเร็จ" + บันทึก log ปลอม
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => `/khupskpi/api${p}`;
let app, db;
const T = {};   // tokens
let deptA, deptB, hosA, hosA2, hosOtherDist, target;

const tok = (u, role, extra = {}) => makeToken({ userId: u.id, username: u.username, role, sessionId: 'sess-' + u.username, ...extra });
const put = (token, id, body) => request(app).put(api(`/users/${id}`)).set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_uscope\\_');
    const [ds] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
    deptA = ds[0].id; deptB = ds[1].id;
    // อำเภอที่มีหน่วยบริการ ≥ 2 แห่ง + หน่วยบริการในอำเภออื่น
    const [[g]] = await db.query(`SELECT distid FROM chospital WHERE distid <> '' GROUP BY distid HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, distid LIMIT 1`);
    const [same] = await db.query('SELECT hoscode FROM chospital WHERE distid = ? ORDER BY hoscode LIMIT 2', [g.distid]);
    hosA = same[0].hoscode; hosA2 = same[1].hoscode;
    const [[o]] = await db.query('SELECT hoscode FROM chospital WHERE distid <> ? AND distid <> \'\' ORDER BY hoscode LIMIT 1', [g.distid]);
    hosOtherDist = o.hoscode;

    const mk = async (name, role, dept, hos) => {
        const u = await ensureTestUser(db, { username: 'test_uscope_' + name, role, dept_id: dept, hospcode: hos, session_id: 'sess-test_uscope_' + name });
        return u;
    };
    const sa = await mk('sa', 'super_admin', deptA, hosA);
    const ssj = await mk('ssj', 'admin_ssj', deptA, hosA);
    const hos = await mk('hos', 'admin_hos', deptA, hosA);
    const cup = await mk('cup', 'admin_cup', deptA, hosA);
    target = await mk('target', 'user_hos', deptA, hosA);
    T.sa = tok(sa, 'super_admin', { deptId: null, hospcode: null });
    T.ssj = tok(ssj, 'admin_ssj', { deptId: deptA, hospcode: hosA });
    T.hos = tok(hos, 'admin_hos', { deptId: deptA, hospcode: hosA });
    T.cup = tok(cup, 'admin_cup', { deptId: deptA, hospcode: hosA });
}, 60000);
afterAll(async () => { await cleanupTestUsers(db, 'test\\_uscope\\_'); });

const base = () => ({ username: target.username, firstname: 'ทดสอบ', lastname: 'ผู้ใช้', dept_id: deptA, hospcode: hosA, role: 'user_hos' });
const row = async () => (await db.query('SELECT role, dept_id, hospcode FROM users WHERE id = ?', [target.id]))[0][0];
afterEach(async () => { await db.query("UPDATE users SET role='user_hos', dept_id=?, hospcode=? WHERE id=?", [deptA, hosA, target.id]); });

describe('PUT /users/:id — ขอบเขตของผู้ดูแล', () => {
    test('🛡️ admin_ssj ตั้ง role เป็น super_admin → 403 (เดิม: สำเร็จทันที)', async () => {
        const r = await put(T.ssj, target.id, { ...base(), role: 'super_admin' });
        expect(r.status).toBe(403);
        expect((await row()).role).toBe('user_hos');
    });

    test('✅ admin_ssj ตั้ง role ที่อยู่ในรายการของหน้าจอได้ (admin_hos)', async () => {
        const r = await put(T.ssj, target.id, { ...base(), role: 'admin_hos' });
        expect(r.status).toBe(200);
        expect((await row()).role).toBe('admin_hos');
    });

    test('🛡️ admin_ssj ย้ายผู้ใช้ไปหน่วยงานอื่น → ใช้หน่วยงานของ admin_ssj (ล็อคหน่วยงานเหมือนหน้าจอ)', async () => {
        const r = await put(T.ssj, target.id, { ...base(), dept_id: deptB });
        expect(r.status).toBe(200);
        expect(Number((await row()).dept_id)).toBe(Number(deptA));
    });

    test('🛡️ admin_hos ย้ายผู้ใช้ไปหน่วยบริการอื่น → 403 (เดิม: สำเร็จ)', async () => {
        const r = await put(T.hos, target.id, { ...base(), hospcode: hosA2 });
        expect(r.status).toBe(403);
        expect((await row()).hospcode).toBe(hosA);
    });

    test('🛡️ admin_cup ย้ายผู้ใช้ไปอำเภออื่น → 403 / ในอำเภอเดียวกันได้', async () => {
        expect((await put(T.cup, target.id, { ...base(), hospcode: hosOtherDist })).status).toBe(403);
        expect((await row()).hospcode).toBe(hosA);
        expect((await put(T.cup, target.id, { ...base(), hospcode: hosA2 })).status).toBe(200);
        expect((await row()).hospcode).toBe(hosA2);
    });

    test('✅ super_admin แก้ role ได้ทุกค่า', async () => {
        expect((await put(T.sa, target.id, { ...base(), role: 'admin_ssj' })).status).toBe(200);
        expect((await row()).role).toBe('admin_ssj');
    });

    test('🛡️ ข้อมูลไม่ครบ (ไม่มี username) → 400 ไม่แก้ฐาน', async () => {
        const r = await put(T.sa, target.id, {});
        expect(r.status).toBe(400);
        expect((await row()).role).toBe('user_hos');
    });

    test('🛡️ ผู้ใช้ที่ไม่มีอยู่ → 404 (เดิม: "Updated")', async () => {
        expect((await put(T.sa, 999999999, base())).status).toBe(404);
    });
});

describe('POST /users, DELETE, reset-password', () => {
    test('🛡️ POST ไม่มี username/password → 400 (เดิม 500)', async () => {
        const r = await request(app).post(api('/users')).set('Authorization', `Bearer ${T.sa}`).send({});
        expect(r.status).toBe(400);
    });

    test('🛡️ DELETE / reset-password ผู้ใช้ที่ไม่มีอยู่ → 404 (เดิม: สำเร็จ + log ปลอม)', async () => {
        expect((await request(app).delete(api('/users/999999999')).set('Authorization', `Bearer ${T.sa}`)).status).toBe(404);
        expect((await request(app).put(api('/users/999999999/reset-password')).set('Authorization', `Bearer ${T.sa}`).send({})).status).toBe(404);
    });
});
