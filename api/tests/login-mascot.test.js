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

// ผู้ช่วยน้องโคราชดีทุกหน้า (ระยะที่ 2) — mascot_assistant_enabled แยกจากของหน้าเข้าสู่ระบบ
test("mascot_assistant_enabled: ไม่มีค่า = เปิด, 'false' = ปิด (ไม่กระทบ login_mascot_enabled)", async () => {
    const [[r]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'mascot_assistant_enabled'");
    const prev = r ? r.setting_value : null;
    try {
        await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_assistant_enabled'");
        expect((await request(app).get(URL)).body.mascot_assistant_enabled).toBe(true);
        await set('true');
        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('mascot_assistant_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
        const body = (await request(app).get(URL)).body;
        expect(body.mascot_assistant_enabled).toBe(false);
        expect(body.login_mascot_enabled).toBe(true);
    } finally {
        if (prev === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_assistant_enabled'");
        else await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'mascot_assistant_enabled'", [prev]);
    }
});

// เสียงพูด (20 พ.ย. 2569) — mascot_voice_enabled ไม่มีค่า = เปิด, 'false' = ปิด
test("mascot_voice_enabled: ไม่มีค่า = เปิด, 'false' = ปิด", async () => {
    const [[r]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'mascot_voice_enabled'");
    const prev = r ? r.setting_value : null;
    try {
        await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_voice_enabled'");
        expect((await request(app).get(URL)).body.mascot_voice_enabled).toBe(true);
        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('mascot_voice_enabled', 'false') ON DUPLICATE KEY UPDATE setting_value = 'false'");
        expect((await request(app).get(URL)).body.mascot_voice_enabled).toBe(false);
    } finally {
        if (prev === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_voice_enabled'");
        else await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'mascot_voice_enabled'", [prev]);
    }
});

// ชุดเทศกาล (21 พ.ย. 2569) — ค่าผิด = auto, ตารางวันที่ตัดค่าที่ผิดรูปแบบ
test('mascot_outfit + mascot_festival_dates: ค่าผิด = auto / ตัดค่าที่ผิดรูปแบบ', async () => {
    const keys = ['mascot_outfit', 'mascot_festival_dates'];
    const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)", [keys]);
    const prev = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    const set = (k, v) => db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [k, v]);
    try {
        await db.query("DELETE FROM system_settings WHERE setting_key IN (?)", [keys]);
        let b = (await request(app).get(URL)).body;
        expect(b.mascot_outfit).toBe('auto');
        expect(b.mascot_festival_dates).toEqual({});
        await set('mascot_outfit', 'christmas');
        await set('mascot_festival_dates', JSON.stringify({
            2028: { loykrathong: '2028-11-02', bad_id: '2028-01-01', makha: '2029-02-01', visakha: 'x' },
            '1999': { makha: '1999-02-01' }, foo: 'bar',
        }));
        b = (await request(app).get(URL)).body;
        expect(b.mascot_outfit).toBe('christmas');
        expect(b.mascot_festival_dates).toEqual({ 2028: { loykrathong: '2028-11-02' } });
        await set('mascot_outfit', '<img src=x>');
        await set('mascot_festival_dates', 'not json');
        b = (await request(app).get(URL)).body;
        expect(b.mascot_outfit).toBe('auto');
        expect(b.mascot_festival_dates).toEqual({});
    } finally {
        await db.query("DELETE FROM system_settings WHERE setting_key IN (?)", [keys]);
        for (const k of Object.keys(prev)) await set(k, prev[k]);
    }
});

// ขนาดตั้งต้น (20 พ.ย. 2569) — ไม่มีค่า/ค่าผิด = medium, small/large ส่งตามที่ตั้ง
test('mascot_size: ไม่มีค่า/ค่าผิด = medium, small/large ตามที่ตั้ง', async () => {
    const [[r]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'mascot_size'");
    const prev = r ? r.setting_value : null;
    const set = v => db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('mascot_size', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [v]);
    try {
        await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_size'");
        expect((await request(app).get(URL)).body.mascot_size).toBe('medium');
        await set('large');
        expect((await request(app).get(URL)).body.mascot_size).toBe('large');
        await set('small');
        expect((await request(app).get(URL)).body.mascot_size).toBe('small');
        await set('<script>');
        expect((await request(app).get(URL)).body.mascot_size).toBe('medium');
    } finally {
        if (prev === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_size'");
        else await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'mascot_size'", [prev]);
    }
});
