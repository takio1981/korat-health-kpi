/**
 * น้องโคราชดีบินในหน้าเข้าสู่ระบบ (19 พ.ย. 2569) — ค่าระบบ login_mascot_enabled ส่งผ่าน /system/maintenance-status (public)
 * ไม่มีค่า = เปิด, 'false' = ปิด — ตั้งผ่าน POST /settings (super_admin) — คืนค่าเดิมหลังทดสอบ
 */
require('./setup');
const request = require('supertest');
const db = require('../db');

let app, before;
const URL = '/khupskpi/api/system/maintenance-status';
jest.setTimeout(120000);
beforeAll(async () => {
    ({ app } = require('../server'));
    const [[r]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'login_mascot_enabled'");
    before = r ? r.setting_value : null;
});
afterAll(async () => {
    if (before === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'login_mascot_enabled'");
    else await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'login_mascot_enabled'", [before]);
});

const set = (v) => v === null
    ? db.query("DELETE FROM system_settings WHERE setting_key = 'login_mascot_enabled'")
    : db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('login_mascot_enabled', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [v]);

test('ไม่มีค่าในระบบ = เปิด (ไม่ต้อง login)', async () => {
    await set(null);
    const res = await request(app).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.login_mascot_enabled).toBe(true);
});

test("ตั้ง 'false' = ปิด, 'true' = เปิด", async () => {
    await set('false');
    expect((await request(app).get(URL)).body.login_mascot_enabled).toBe(false);
    await set('true');
    expect((await request(app).get(URL)).body.login_mascot_enabled).toBe(true);
});
