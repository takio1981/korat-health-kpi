/**
 * Integration tests: POST /login (critical auth path)
 *
 * Run: npm test -- tests/login.test.js
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, cleanupTestUsers } = require('./helpers');

let app, db;

beforeAll(async () => {
    ({ app } = require('../server'));
    db = require('../db');
    await cleanupTestUsers(db);
});

afterAll(async () => {
    await cleanupTestUsers(db);
});

describe('POST /khupskpi/api/login', () => {
    let testUser;
    beforeAll(async () => {
        testUser = await ensureTestUser(db, {
            username: 'test_user_login',
            password: 'CorrectPass123!',
            role: 'user_hos'
        });
    });

    test('✅ login สำเร็จด้วย credentials ที่ถูกต้อง', async () => {
        const res = await request(app)
            .post('/khupskpi/api/login')
            .send({ username: 'test_user_login', password: 'CorrectPass123!' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(typeof res.body.token).toBe('string');
    });

    test('❌ login ล้มเหลวเมื่อ password ผิด', async () => {
        const res = await request(app)
            .post('/khupskpi/api/login')
            .send({ username: 'test_user_login', password: 'WrongPass!' });
        expect([401, 403]).toContain(res.status);
        expect(res.body.success).toBe(false);
    });

    test('❌ login ล้มเหลวเมื่อ username ไม่มีในระบบ', async () => {
        const res = await request(app)
            .post('/khupskpi/api/login')
            .send({ username: 'nonexistent_user_xyz', password: 'Anything!' });
        expect([401, 403, 404]).toContain(res.status);
        expect(res.body.success).toBe(false);
    });

    test('❌ login ล้มเหลวเมื่อบัญชียังไม่ approved', async () => {
        const u = await ensureTestUser(db, {
            username: 'test_user_pending',
            password: 'PendingPass123!',
            is_approved: 0
        });
        const res = await request(app)
            .post('/khupskpi/api/login')
            .send({ username: 'test_user_pending', password: 'PendingPass123!' });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/รออนุมัติ|รอการอนุมัติ/);
    });

    test('❌ login ล้มเหลวเมื่อบัญชี is_active=0', async () => {
        await ensureTestUser(db, {
            username: 'test_user_inactive',
            password: 'InactivePass123!',
            is_active: 0
        });
        const res = await request(app)
            .post('/khupskpi/api/login')
            .send({ username: 'test_user_inactive', password: 'InactivePass123!' });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/ปิดใช้งาน/);
    });
});
