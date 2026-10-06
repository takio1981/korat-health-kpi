/**
 * Integration tests: endpoint สาธารณะ (ไม่ต้อง login)
 *   7 ต.ค. 2569 — ผู้ใช้ยืนยันว่าไม่ต้องการเปิดข้อมูลผลงานให้ดูโดยไม่ login → ลบ /public/kpi-results และ
 *   /public/dashboard-stats (เดิมคืนผลงานทุกหน่วยบริการ + ไม่ผ่าน rate limit) — test นี้กันไม่ให้กลับมาโดยไม่ตั้งใจ
 */
require('./setup');
const request = require('supertest');

let app;
beforeAll(() => { ({ app } = require('../server')); });

describe('endpoint ข้อมูลผลงานแบบไม่ต้อง login ต้องปิด', () => {
    test.each(['/khupskpi/api/public/kpi-results', '/khupskpi/api/public/dashboard-stats?year=2569'])(
        '❌ %s ไม่คืนข้อมูลผลงาน',
        async (url) => {
            const res = await request(app).get(url);
            expect(res.status).toBe(404);
            expect(res.body?.data).toBeUndefined();
        }
    );
});

describe('endpoint สาธารณะที่ยังจำเป็น (หน้าลงทะเบียนใช้ก่อน login)', () => {
    test.each(['/khupskpi/api/public/departments', '/khupskpi/api/public/districts'])(
        '✅ %s ยังใช้ได้',
        async (url) => {
            const res = await request(app).get(url);
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        }
    );
});
