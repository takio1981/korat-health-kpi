/**
 * Integration tests: Error Monitoring
 *   - POST /errors/report บันทึก error
 *   - GET /admin/error-logs ดูเฉพาะ super_admin
 *   - Dedup ผ่าน fingerprint (INSERT...ON DUPLICATE)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers, cleanupErrorLogs } = require('./helpers');

let app, db;
beforeAll(async () => {
    ({ app } = require('../server'));
    db = require('../db');
    await cleanupTestUsers(db);
    await cleanupErrorLogs(db);
});
afterAll(async () => {
    await cleanupTestUsers(db);
    await cleanupErrorLogs(db);
});

describe('POST /khupskpi/api/errors/report', () => {
    test('✅ รับ error report จาก anon ได้ (ไม่ต้อง token)', async () => {
        const res = await request(app)
            .post('/khupskpi/api/errors/report')
            .send({
                source: 'frontend',
                severity: 'error',
                message: 'TestError: jest dummy 1',
                stack: 'Error: jest\n  at test',
                url: '/test'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.fingerprint).toBeDefined();
    });

    test('✅ error ซ้ำ fingerprint เดิม → count++ ใน DB (ไม่สร้างแถวใหม่)', async () => {
        const payload = {
            source: 'frontend',
            severity: 'error',
            message: 'TestError: duplicate fingerprint case',
            url: '/dup'
        };
        const r1 = await request(app).post('/khupskpi/api/errors/report').send(payload);
        const r2 = await request(app).post('/khupskpi/api/errors/report').send(payload);
        const r3 = await request(app).post('/khupskpi/api/errors/report').send(payload);
        expect(r1.body.fingerprint).toBe(r2.body.fingerprint);
        expect(r2.body.fingerprint).toBe(r3.body.fingerprint);
        const [rows] = await db.query(
            "SELECT count FROM error_logs WHERE fingerprint = ? AND source = 'frontend'",
            [r1.body.fingerprint]
        );
        expect(rows.length).toBe(1);
        expect(rows[0].count).toBeGreaterThanOrEqual(3);
    });
});

describe('GET /khupskpi/api/admin/error-logs', () => {
    test('❌ non-super_admin ถูกบล็อก 403', async () => {
        const u = await ensureTestUser(db, { username: 'test_admin_cup_err', role: 'admin_cup' });
        const token = makeToken({ userId: u.id, role: 'admin_cup' });
        const res = await request(app)
            .get('/khupskpi/api/admin/error-logs')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });

    test('✅ super_admin ดูได้ + มี stats', async () => {
        const sa = await ensureTestUser(db, { username: 'test_sa_errlog', role: 'super_admin' });
        const token = makeToken({ userId: sa.id, role: 'super_admin' });
        // เพิ่ม error 1 รายการก่อน
        await request(app).post('/khupskpi/api/errors/report').send({
            source: 'backend', message: 'TestError: for super admin view'
        });
        const res = await request(app)
            .get('/khupskpi/api/admin/error-logs')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.stats).toBeDefined();
        expect(typeof res.body.stats.total).toBe('number');
    });
});
