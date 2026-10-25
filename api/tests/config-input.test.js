/**
 * ตั้งค่าระบบ: ข้อมูลที่ส่งมาต้องถูกรูปแบบ (พบจากการทดสอบทั้งระบบ 25 ต.ค. 2569)
 * - POST /settings ที่ไม่ใช่ array → 500 (settings.map is not a function) / รายการไม่มี setting_key → 500
 * - PUT /system/maintenance-mode ที่ไม่ส่ง enabled → ปิดโหมดปิดปรับปรุงเงียบๆ
 * ทดสอบเฉพาะคำขอที่ถูกปฏิเสธ — ไม่เปลี่ยนค่าตั้งค่าในฐานทดสอบ
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => `/khupskpi/api${p}`;
let app, db, token;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_cfgin\\_');
    const sa = await ensureTestUser(db, { username: 'test_cfgin_sa', role: 'super_admin', session_id: 's-cfgin' });
    token = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-cfgin' });
}, 60000);
afterAll(async () => { await cleanupTestUsers(db, 'test\\_cfgin\\_'); });

const mm = async () => (await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'maintenance_mode'"))[0][0]?.setting_value ?? null;

test('🛡️ POST /settings ที่ไม่ใช่รายการ / ไม่มี setting_key → 400 (เดิม 500)', async () => {
    expect((await request(app).post(api('/settings')).set('Authorization', `Bearer ${token}`).send({})).status).toBe(400);
    expect((await request(app).post(api('/settings')).set('Authorization', `Bearer ${token}`).send([{ setting_value: 'x' }])).status).toBe(400);
});

test('🛡️ PUT /system/maintenance-mode ไม่ส่ง enabled → 400 และค่าเดิมไม่เปลี่ยน (เดิม: ปิดโหมดปิดปรับปรุง)', async () => {
    const before = await mm();
    const r = await request(app).put(api('/system/maintenance-mode')).set('Authorization', `Bearer ${token}`).send({});
    expect(r.status).toBe(400);
    expect(await mm()).toBe(before);
});
