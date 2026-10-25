/**
 * การยกเลิกสิทธิ์ใช้งาน token ต้องมีผลทันที (พบจากการทดสอบทั้งระบบ 25 ต.ค. 2569)
 * - เดิม authenticateToken ปฏิเสธเฉพาะเมื่อ active_session_id ในฐาน "มีค่าและไม่ตรง" (login จากเครื่องอื่น)
 *   → logout / บังคับ logout (ตั้งเป็น NULL) แล้ว token เดิมยังใช้ได้จนหมดอายุ 8 ชม. และบัญชีที่ถูกปิดใช้งานยังเรียก API ได้
 * - PUT /users/bulk-toggle-active ที่ไม่ส่ง is_active (ข้อมูลว่าง) = ปิดใช้งานผู้ใช้ทุกคนยกเว้น super_admin
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => `/khupskpi/api${p}`;
let app, db, sa, saToken;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_revoke\\_');
    sa = await ensureTestUser(db, { username: 'test_revoke_sa', role: 'super_admin', session_id: 'sess-revoke-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-revoke-sa' });
}, 60000);
afterAll(async () => { await cleanupTestUsers(db, 'test\\_revoke\\_'); });

async function userWithSession(name) {
    const u = await ensureTestUser(db, { username: name, role: 'user_hos', session_id: 'sess-' + name });
    const token = makeToken({ userId: u.id, username: u.username, role: 'user_hos', hospcode: '11000', sessionId: 'sess-' + name });
    return { u, token };
}
const probe = (token) => request(app).get(api('/notifications/unread-count')).set('Authorization', `Bearer ${token}`);

describe('token เดิมใช้ไม่ได้หลัง session ถูกยกเลิก', () => {
    test('✅ session ปกติ → 200', async () => {
        const { token } = await userWithSession('test_revoke_ok');
        expect((await probe(token)).status).toBe(200);
    });

    test('🛡️ หลังบังคับ logout → 401 SESSION_ENDED (เดิม 200)', async () => {
        const { u, token } = await userWithSession('test_revoke_force');
        expect((await probe(token)).status).toBe(200);
        const f = await request(app).post(api(`/admin/force-logout-user/${u.id}`)).set('Authorization', `Bearer ${saToken}`);
        expect(f.status).toBe(200);
        const r = await probe(token);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_ENDED');
    });

    test('🛡️ หลัง logout → token เดิม 401 (เดิม 200)', async () => {
        const { token } = await userWithSession('test_revoke_logout');
        expect((await request(app).post(api('/logout')).set('Authorization', `Bearer ${token}`)).status).toBe(200);
        const r = await probe(token);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('SESSION_ENDED');
    });

    test('🛡️ บัญชีถูกปิดใช้งาน → 401 ACCOUNT_DISABLED ทันที (เดิม 200)', async () => {
        const { u, token } = await userWithSession('test_revoke_off');
        expect((await probe(token)).status).toBe(200);
        const t = await request(app).put(api(`/users/${u.id}/toggle-active`)).set('Authorization', `Bearer ${saToken}`).send({ is_active: false });
        expect(t.status).toBe(200);
        const r = await probe(token);
        expect(r.status).toBe(401);
        expect(r.body.code).toBe('ACCOUNT_DISABLED');
    });
});

describe('เปิด/ปิดใช้งานต้องระบุค่าชัดเจน', () => {
    test('🛡️ bulk-toggle-active ไม่ส่ง is_active → 400 และไม่มีผู้ใช้ถูกปิด (เดิม: ปิดทุกคน)', async () => {
        const { u } = await userWithSession('test_revoke_bulk');
        const r = await request(app).put(api('/users/bulk-toggle-active')).set('Authorization', `Bearer ${saToken}`).send({});
        expect(r.status).toBe(400);
        const [[row]] = await db.query('SELECT is_active FROM users WHERE id = ?', [u.id]);
        expect(Number(row.is_active)).toBe(1);
    });

    test('🛡️ toggle-active รายคนไม่ส่ง is_active → 400 (เดิม: ปิดใช้งาน)', async () => {
        const { u } = await userWithSession('test_revoke_single');
        const r = await request(app).put(api(`/users/${u.id}/toggle-active`)).set('Authorization', `Bearer ${saToken}`).send({});
        expect(r.status).toBe(400);
        const [[row]] = await db.query('SELECT is_active FROM users WHERE id = ?', [u.id]);
        expect(Number(row.is_active)).toBe(1);
    });
});
