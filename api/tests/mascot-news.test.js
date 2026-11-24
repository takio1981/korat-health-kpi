/**
 * น้องคิดดีแจ้งข่าว (22 พ.ย. 2569)
 *   - ประกาศมีตัวเลือก "ให้น้องคิดดีแจ้งข่าว" (mascot_announce) + ข้อความที่น้องพูด (mascot_text ≤ 300 ตัวอักษร ข้อความล้วน)
 *   - GET /announcement/active คืนสองช่องนี้ให้ผู้ช่วยในระบบ
 *   - GET /system/maintenance-status คืน mascot_news_enabled (ไม่มีค่า = เปิด, ตั้ง 'false' = ปิด)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => '/khupskpi/api' + p;
let app, db, saToken, userToken, prevActive = [], prevNews = null, createdId = null;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db, 'test\\_mn\\_');
    const sa = await ensureTestUser(db, { username: 'test_mn_sa', role: 'super_admin' });
    const u = await ensureTestUser(db, { username: 'test_mn_user', role: 'user_hos' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId: 1, hospcode: '11000' });
    [prevActive] = await db.query('SELECT id FROM system_announcements WHERE is_active = 1');
    const [[n]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'mascot_news_enabled'");
    prevNews = n ? n.setting_value : null;
});

afterAll(async () => {
    if (createdId) await db.query('DELETE FROM system_announcements WHERE id = ?', [createdId]);
    if (prevActive.length) await db.query('UPDATE system_announcements SET is_active = 1 WHERE id IN (?)', [prevActive.map(r => r.id)]);
    if (prevNews === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_news_enabled'");
    else await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'mascot_news_enabled'", [prevNews]);
    await cleanupTestUsers(db, 'test\\_mn\\_');
});

test('สร้าง/แก้ไขประกาศพร้อมตัวเลือกให้น้องคิดดีแจ้ง — ผู้ใช้ทั่วไปได้รับผ่าน /announcement/active', async () => {
    const c = await request(app).post(api('/announcements')).set('Authorization', `Bearer ${saToken}`).send({
        title: 'test_mn ประกาศ', content_html: '<b>ปิดระบบ</b>', content_text: 'ปิดระบบ', is_active: true,
        mascot_announce: true, mascot_text: '<script>x</script>คืนนี้ปิดระบบ ' + 'ก'.repeat(400),
    });
    expect(c.status).toBe(200);
    createdId = c.body.id;
    const a = await request(app).get(api('/announcement/active')).set('Authorization', `Bearer ${userToken}`);
    expect(a.status).toBe(200);
    expect(a.body.data).toMatchObject({ id: createdId, mascot_announce: 1 });
    expect(a.body.data.mascot_text).not.toContain('<script>');
    expect(a.body.data.mascot_text.startsWith('x คืนนี้ปิดระบบ')).toBe(true);
    expect(a.body.data.mascot_text.length).toBe(300);
    // แก้ไข: ปิดตัวเลือก + ข้อความว่าง = NULL
    const u = await request(app).put(api(`/announcements/${createdId}`)).set('Authorization', `Bearer ${saToken}`).send({
        title: 'test_mn ประกาศ', content_html: '<b>ปิดระบบ</b>', is_active: true, mascot_announce: false, mascot_text: '  ',
    });
    expect(u.status).toBe(200);
    const [[row]] = await db.query('SELECT mascot_announce, mascot_text FROM system_announcements WHERE id = ?', [createdId]);
    expect(row).toEqual({ mascot_announce: 0, mascot_text: null });
});

test('maintenance-status: mascot_news_enabled ไม่มีค่า = เปิด / ตั้ง false = ปิด', async () => {
    await db.query("DELETE FROM system_settings WHERE setting_key = 'mascot_news_enabled'");
    const on = await request(app).get(api('/system/maintenance-status'));
    expect(on.body.mascot_news_enabled).toBe(true);
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('mascot_news_enabled', 'false')");
    const off = await request(app).get(api('/system/maintenance-status'));
    expect(off.body.mascot_news_enabled).toBe(false);
});
