/**
 * Integration tests: Permission enforcement
 *   - /my-permissions คืนสิทธิ์ user ปัจจุบัน
 *   - /update-kpi preserve target/actual ตามสิทธิ์ (ถ้าไม่มีสิทธิ์)
 *   - super_admin ข้ามทุกข้อจำกัด
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db;
beforeAll(async () => {
    ({ app } = require('../server'));
    db = require('../db');
    await cleanupTestUsers(db);
});
afterAll(async () => { await cleanupTestUsers(db); });

describe('GET /khupskpi/api/my-permissions', () => {
    test('❌ ไม่มี token → 401', async () => {
        const res = await request(app).get('/khupskpi/api/my-permissions');
        expect(res.status).toBe(401);
    });

    test('✅ user ปกติได้ default สิทธิ์เต็ม (can_edit_actual + can_edit_target = true)', async () => {
        const u = await ensureTestUser(db, { username: 'test_user_perm_default', role: 'user_hos' });
        const token = makeToken({ userId: u.id, username: u.username, role: 'user_hos' });
        const res = await request(app)
            .get('/khupskpi/api/my-permissions')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.permissions.can_edit_actual).toBe(true);
        expect(res.body.permissions.can_edit_target).toBe(true);
    });

    test('✅ super_admin มีสิทธิ์เต็มเสมอ (override)', async () => {
        const u = await ensureTestUser(db, { username: 'test_user_perm_super', role: 'super_admin' });
        // ปิดสิทธิ์ใน DB ลอง — super_admin ควรยังได้ true
        await db.query('UPDATE users SET can_edit_actual=0, can_edit_target=0 WHERE id=?', [u.id]);
        const token = makeToken({ userId: u.id, role: 'super_admin' });
        const res = await request(app)
            .get('/khupskpi/api/my-permissions')
            .set('Authorization', `Bearer ${token}`);
        expect(res.body.permissions.can_edit_actual).toBe(true);
        expect(res.body.permissions.can_edit_target).toBe(true);
    });

    test('✅ user ที่ถูกปิดสิทธิ์ → ได้ false ใน /my-permissions', async () => {
        const u = await ensureTestUser(db, { username: 'test_user_perm_readonly', role: 'user_hos' });
        await db.query('UPDATE users SET can_edit_actual=0, can_edit_target=0 WHERE id=?', [u.id]);
        const token = makeToken({ userId: u.id, role: 'user_hos' });
        const res = await request(app)
            .get('/khupskpi/api/my-permissions')
            .set('Authorization', `Bearer ${token}`);
        expect(res.body.permissions.can_edit_actual).toBe(false);
        expect(res.body.permissions.can_edit_target).toBe(false);
    });
});

describe('PUT /khupskpi/api/users/:id/permissions', () => {
    test('❌ ห้าม non-super_admin แก้สิทธิ์ user', async () => {
        const target = await ensureTestUser(db, { username: 'test_user_target' });
        const admin = await ensureTestUser(db, { username: 'test_admin_cup_perm', role: 'admin_cup' });
        const token = makeToken({ userId: admin.id, role: 'admin_cup' });
        const res = await request(app)
            .put(`/khupskpi/api/users/${target.id}/permissions`)
            .set('Authorization', `Bearer ${token}`)
            .send({ can_edit_actual: false, can_edit_target: false });
        expect(res.status).toBe(403);
    });

    test('❌ ห้ามแก้สิทธิ์ super_admin (โดย super_admin คนอื่น)', async () => {
        const sa1 = await ensureTestUser(db, { username: 'test_sa_actor', role: 'super_admin' });
        const sa2 = await ensureTestUser(db, { username: 'test_sa_target', role: 'super_admin' });
        const token = makeToken({ userId: sa1.id, role: 'super_admin' });
        const res = await request(app)
            .put(`/khupskpi/api/users/${sa2.id}/permissions`)
            .set('Authorization', `Bearer ${token}`)
            .send({ can_edit_actual: false, can_edit_target: false });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/super_admin/i);
    });

    test('✅ super_admin แก้สิทธิ์ user ปกติได้', async () => {
        const target = await ensureTestUser(db, { username: 'test_user_to_modify', role: 'user_hos' });
        const sa = await ensureTestUser(db, { username: 'test_sa_modifier', role: 'super_admin' });
        const token = makeToken({ userId: sa.id, role: 'super_admin' });
        const res = await request(app)
            .put(`/khupskpi/api/users/${target.id}/permissions`)
            .set('Authorization', `Bearer ${token}`)
            .send({ can_edit_actual: true, can_edit_target: false });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // ตรวจ DB
        const [rows] = await db.query('SELECT can_edit_actual, can_edit_target FROM users WHERE id=?', [target.id]);
        expect(rows[0].can_edit_actual).toBe(1);
        expect(rows[0].can_edit_target).toBe(0);
    });
});
