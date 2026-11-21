/**
 * ปรับวันที่ชุดเทศกาลของน้องโคราชดีอัตโนมัติ (22 พ.ย. 2569) — services/mascot-festival.js + เส้นทาง /mascot/festival-dates/*
 * ห้ามเรียกปฏิทินจริง: ส่ง fetchImpl / stub global.fetch ทุกกรณี — คืนค่า system_settings เดิมหลังทดสอบ
 */
require('./setup');
const request = require('supertest');
const db = require('../db');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const svc = require('../services/mascot-festival');

const KEYS = ['mascot_festival_auto', 'mascot_festival_ics_url', 'mascot_festival_dates_auto'];
const STATUS = '/khupskpi/api/system/maintenance-status';
let app, prev, saToken, userToken;
jest.setTimeout(120000);

const ICS = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20280210', 'SUMMARY:วันมาฆบูชา', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20280212', 'SUMMARY:วันหยุดชดเชยวันมาฆบูชา', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20280508', 'SUMMARY:วันวิสาข', ' บูชา', 'END:VEVENT', // บรรทัดพับ (folded line ขึ้นต้นด้วยช่องว่าง)
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20280706', 'SUMMARY:วันอาสาฬหบูชา', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20280127', 'SUMMARY:วันตรุษจีน (วันที่ 2)', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20280126', 'SUMMARY:วันตรุษจีน', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20280413', 'SUMMARY:วันสงกรานต์', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20291022', 'SUMMARY:End of Buddhist Lent', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20290725', 'SUMMARY:Buddhist Lent Day', 'END:VEVENT',
    'END:VCALENDAR',
].join('\r\n');
const okFetch = (body = ICS) => jest.fn(async () => ({ ok: true, status: 200, text: async () => body }));

beforeAll(async () => {
    ({ app } = require('../server'));
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [KEYS]);
    prev = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    const sa = await ensureTestUser(db, { username: 'test_mfd_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    const u = await ensureTestUser(db, { username: 'test_mfd_ssj', role: 'admin_ssj' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'admin_ssj', deptId: 1, hospcode: null });
});
beforeEach(async () => { await db.query('DELETE FROM system_settings WHERE setting_key IN (?)', [KEYS]); });
afterAll(async () => {
    await db.query('DELETE FROM system_settings WHERE setting_key IN (?)', [KEYS]);
    for (const [k, v] of Object.entries(prev)) {
        await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [k, v]);
    }
    await cleanupTestUsers(db, 'test\\_mfd\\_');
});

test('parseHolidayIcs: เลือกเฉพาะวันหลัก (ข้ามวันหยุดชดเชย/ตรุษจีนวันที่ 2) + บรรทัดพับ + ชื่ออังกฤษ', () => {
    expect(svc.parseHolidayIcs(ICS)).toEqual({
        2028: { makha: '2028-02-10', visakha: '2028-05-08', asalha: '2028-07-06', cny: '2028-01-26' },
        2029: { okphansa: '2029-10-22', khaophansa: '2029-07-25' },
    });
    expect(svc.parseHolidayIcs(ICS, { minYear: 2029, maxYear: 2029 })).toEqual({ 2029: { okphansa: '2029-10-22', khaophansa: '2029-07-25' } });
    expect(svc.parseHolidayIcs('ไม่ใช่ปฏิทิน')).toEqual({});
});

test('isRefreshDue: ไม่เคยดึง / ขึ้นปีใหม่ตามเวลาไทย / ครบ 7 วัน / พักหลังล้มเหลว 6 ชม.', () => {
    const now = new Date('2026-12-31T17:05:00Z'); // 00:05 น. 1 ม.ค. 2570 เวลาไทย
    expect(svc.isRefreshDue({}, now)).toBe(true);
    expect(svc.isRefreshDue({ fetched_at: '2026-12-31T16:30:00Z' }, now)).toBe(true); // 23:30 น. 31 ธ.ค. — ปีเก่า
    expect(svc.isRefreshDue({ fetched_at: '2026-12-31T16:30:00Z' }, new Date('2026-12-31T16:50:00Z'))).toBe(false);
    expect(svc.isRefreshDue({ fetched_at: '2026-12-20T00:00:00Z' }, new Date('2026-12-27T00:00:01Z'))).toBe(true);
    expect(svc.isRefreshDue({ fetched_at: '2026-12-01T00:00:00Z', error: 'x', last_try: '2026-12-31T15:00:00Z' }, now)).toBe(false);
    expect(svc.isValidIcsUrl('https://example.org/a.ics')).toBe(true);
    expect(svc.isValidIcsUrl('http://example.org/a.ics')).toBe(false);
    expect(svc.isValidIcsUrl('file:///etc/passwd')).toBe(false);
});

test('refreshFestivalDates: บันทึกวันที่ → maintenance-status ส่งให้หน้าจอ / ปิดใช้งาน = ไม่ดึงและไม่ส่ง', async () => {
    const f = okFetch();
    const r = await svc.refreshFestivalDates({ now: new Date('2027-03-01T00:00:00Z'), fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledWith(svc.DEFAULT_ICS_URL, expect.any(Object));
    let b = (await request(app).get(STATUS)).body;
    expect(b.mascot_festival_auto).toBe(true);
    expect(b.mascot_festival_dates_auto['2028']).toEqual({ makha: '2028-02-10', visakha: '2028-05-08', asalha: '2028-07-06', cny: '2028-01-26' });
    // ยังไม่ครบรอบ = ไม่ดึงซ้ำ
    const f2 = okFetch();
    expect((await svc.refreshFestivalDates({ now: new Date('2027-03-02T00:00:00Z'), fetchImpl: f2 })).skipped).toBe('not_due');
    expect(f2).not.toHaveBeenCalled();
    // ปิดใช้งาน
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('mascot_festival_auto', 'false')");
    const f3 = okFetch();
    expect((await svc.refreshFestivalDates({ now: new Date('2028-01-02T00:00:00Z'), fetchImpl: f3 })).skipped).toBe('disabled');
    expect(f3).not.toHaveBeenCalled();
    b = (await request(app).get(STATUS)).body;
    expect(b.mascot_festival_auto).toBe(false);
    expect(b.mascot_festival_dates_auto).toEqual({});
});

test('ดึงไม่สำเร็จ = คงวันที่ชุดเดิม + บันทึกข้อผิดพลาด / ที่อยู่ไม่ใช่ https = ไม่เชื่อมต่อ', async () => {
    await svc.refreshFestivalDates({ now: new Date('2027-03-01T00:00:00Z'), fetchImpl: okFetch() });
    const bad = jest.fn(async () => ({ ok: false, status: 503, text: async () => '' }));
    const r = await svc.refreshFestivalDates({ force: true, now: new Date('2027-03-10T00:00:00Z'), fetchImpl: bad });
    expect(r.ok).toBe(false);
    const { state } = await svc.getFestivalAutoState();
    expect(state.error).toMatch(/503/);
    expect(state.dates['2028'].makha).toBe('2028-02-10');
    expect((await svc.refreshFestivalDates({ force: true, fetchImpl: okFetch('<html>nope</html>') })).error).toMatch(/iCalendar/);
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('mascot_festival_ics_url', 'http://192.168.1.1/x.ics')");
    const never = okFetch();
    expect((await svc.refreshFestivalDates({ force: true, fetchImpl: never })).error).toMatch(/https/);
    expect(never).not.toHaveBeenCalled();
});

test('เส้นทาง status/refresh: เฉพาะ super_admin (ใช้ global.fetch ที่ stub ไว้)', async () => {
    const realFetch = global.fetch;
    global.fetch = okFetch();
    try {
        expect((await request(app).post('/khupskpi/api/mascot/festival-dates/refresh').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
        expect((await request(app).get('/khupskpi/api/mascot/festival-dates/status').set('Authorization', `Bearer ${userToken}`)).status).toBe(403);
        const r = await request(app).post('/khupskpi/api/mascot/festival-dates/refresh').set('Authorization', `Bearer ${saToken}`);
        expect(r.status).toBe(200);
        expect(r.body.count).toBe(6);
        const s = await request(app).get('/khupskpi/api/mascot/festival-dates/status').set('Authorization', `Bearer ${saToken}`);
        expect(s.body.enabled).toBe(true);
        expect(s.body.fetched_at).toBeTruthy();
        expect(s.body.dates['2029']).toEqual({ okphansa: '2029-10-22', khaophansa: '2029-07-25' });
        global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
        const f = await request(app).post('/khupskpi/api/mascot/festival-dates/refresh').set('Authorization', `Bearer ${saToken}`);
        expect(f.status).toBe(502);
    } finally {
        global.fetch = realFetch;
    }
});
