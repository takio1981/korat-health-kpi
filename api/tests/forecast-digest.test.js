/**
 * ระบบเตือนล่วงหน้า ระยะที่ 3 (8 พ.ย. 2569): สรุปตัวชี้วัดเสี่ยงรายสัปดาห์ + การตั้งค่า (database ทดสอบ)
 *   - ข้อความสรุป / แจ้งเตือนในระบบของ admin_ssj เฉพาะหน่วยงานตน + super_admin ภาพรวม / ไม่มีความเสี่ยง = ไม่ส่ง
 *   - ตัวตั้งเวลา: วัน + เวลา (ช่วง 2 นาที เวลาไทย) + ไม่ส่งซ้ำวันเดียวกัน
 *   - PUT/GET /forecast/settings + POST /forecast/digest/run (preview) — super_admin เท่านั้น, ตรวจค่า
 *   ⚠️ ฐานทดสอบมีโทเคนจริง — ส่งอีเมล/Telegram ถูกแทนด้วย mock ทั้งหมด
 */
jest.mock('../core/notify', () => {
    const actual = jest.requireActual('../core/notify');
    return { ...actual, sendMail: jest.fn().mockResolvedValue(true), sendTelegramDirect: jest.fn().mockResolvedValue(true),
        getNotifSettings: jest.fn().mockResolvedValue({ adminEmails: 'a@test.local', tgToken: 't', tgChatId: 'c' }) };
});
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { sendMail, sendTelegramDirect } = require('../core/notify');
const { buildDigest, buildDeptNotices, isDue, runForecastDigest } = require('../jobs/forecast-digest');

const YEAR = '2524';                     // ปีงบ 2524 = ต.ค. 1980 – ก.ย. 1981 (ค.ศ.)
const NOW = new Date(1981, 3, 10, 9, 0); // 10 เม.ย. 1981 → ข้อมูลถึง มี.ค.
let app, db, saToken, hosToken, ssjUser, ssjOther, deptId, otherDeptId, hosp;
const created = [];
const api = (p) => '/khupskpi/api' + p;
const as = (t, r) => r.set('Authorization', `Bearer ${t}`);

const fc = {
    year_bh: '2570', through_label: 'มี.ค.', watch_pct: 10, counts: { high: 2, watch: 1, no_report: 1, normal: 5 },
    items: [
        { indicator_id: 1, indicator_name: 'อัตราตาย <ทารก>', dept_id: 5, dept_name: 'NCD', distid: '3001', distname: 'เมือง', status: 'high' },
        { indicator_id: 1, indicator_name: 'อัตราตาย <ทารก>', dept_id: 5, dept_name: 'NCD', distid: '3002', distname: 'ครบุรี', status: 'high' },
        { indicator_id: 2, indicator_name: 'คัดกรอง', dept_id: 6, dept_name: 'ส่งเสริม', distid: '3001', distname: 'เมือง', status: 'watch' },
        { indicator_id: 3, indicator_name: 'อุบัติเหตุ', dept_id: 6, dept_name: 'ส่งเสริม', distid: '3001', distname: 'เมือง', status: 'no_report' },
    ],
};

describe('ข้อความสรุป (buildDigest / buildDeptNotices)', () => {
    test('สรุปจำนวนทุกระดับ + ตัวชี้วัดที่เสี่ยงสูงมากที่สุด + อำเภอ — escape HTML สำหรับอีเมล/Telegram', () => {
        const m = buildDigest(fc, { dateStr: '13 เม.ย. 2570' });
        expect(m.subject).toContain('ปีงบ 2570');
        expect(m.text).toContain('เสี่ยงสูง 2 · 🟠 เฝ้าระวัง 1 · ⏳ ขาดการรายงาน 1');
        expect(m.text).toContain('1. อัตราตาย <ทารก> — เสี่ยงสูง 2');
        expect(m.text).toContain('อำเภอที่มีคู่เสี่ยงสูงมากที่สุด: เมือง (1), ครบุรี (1)');
        expect(m.html).toContain('อัตราตาย &lt;ทารก&gt;');
        expect(m.tg).not.toContain('<ทารก>');
        expect(buildDigest(fc, { aiSummary: 'สรุปจาก AI' }).text).toContain('— สรุปโดย AI (โปรดตรวจสอบ) —\nสรุปจาก AI');
    });
    test('แจ้งเตือนรายหน่วยงาน: เฉพาะหน่วยงานที่มีคู่เสี่ยงสูง', () => {
        const n = buildDeptNotices(fc);
        expect(n.map(x => x.dept_id)).toEqual([5]);
        expect(n[0].title).toBe('เตือนล่วงหน้า: ตัวชี้วัดเสี่ยงสูง 2 คู่ (ปีงบ 2570)');
    });
});

describe('ตัวตั้งเวลา (isDue — เวลาไทย)', () => {
    const cfg = { digestEnabled: true, digestDay: 1, digestTime: '08:00' };
    const at = (iso) => new Date(iso);
    test('จันทร์ 08:00–08:01 = ถึงเวลา | วันอื่น/เวลาอื่น/ส่งแล้ววันนี้/ปิดอยู่ = ไม่', () => {
        expect(isDue(cfg, at('2026-11-09T01:00:30Z'), null).due).toBe(true);     // จันทร์ 08:00 (UTC+7)
        expect(isDue(cfg, at('2026-11-09T01:01:50Z'), null).due).toBe(true);
        expect(isDue(cfg, at('2026-11-09T01:02:10Z'), null).due).toBe(false);
        expect(isDue(cfg, at('2026-11-10T01:00:30Z'), null).due).toBe(false);    // อังคาร
        expect(isDue(cfg, at('2026-11-09T01:00:30Z'), '2026-11-09').due).toBe(false);
        expect(isDue({ ...cfg, digestEnabled: false }, at('2026-11-09T01:00:30Z'), null).due).toBe(false);
    });
});

describe('ส่งสรุป + ตั้งค่า (ฐานทดสอบ)', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        await cleanupTestUsers(db);
        await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
        const [depts] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
        deptId = depts[0].id; otherDeptId = depts[1].id;
        const [hs] = await db.query("SELECT hoscode, hosname, distid FROM chospital WHERE distid IS NOT NULL AND hosname <> '' ORDER BY hoscode LIMIT 1");
        hosp = hs[0];
        const sa = await ensureTestUser(db, { username: 'test_fd_sa', role: 'super_admin', session_id: 'sess-fd-sa' });
        saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-fd-sa' });
        ssjUser = await ensureTestUser(db, { username: 'test_fd_ssj', role: 'admin_ssj', dept_id: deptId });
        ssjOther = await ensureTestUser(db, { username: 'test_fd_ssj2', role: 'admin_ssj', dept_id: otherDeptId });
        const u = await ensureTestUser(db, { username: 'test_fd_hos', role: 'user_hos', dept_id: deptId, hospcode: hosp.hoscode, session_id: 'sess-fd-hos' });
        hosToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hosp.hoscode, sessionId: 'sess-fd-hos' });
        const [r] = await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES ('test_fd_ตัวชี้วัดเสี่ยง', ?, 1)", [deptId]);
        created.push(r.insertId);
        await db.query(`INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, target_value, last_actual, oct, nov, dece, jan, feb, mar)
            VALUES (?,?,?,?,?,?,?,?,'80','10','10','10','10','10','10','10')`, [r.insertId, YEAR, hosp.hoscode, deptId, 'test_dept', hosp.hosname, hosp.distid, 'test_dist']);
        await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'forecast\\_%'");
    });
    afterAll(async () => {
        await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
        await db.query("DELETE FROM notifications WHERE year_bh = ? AND title LIKE 'เตือนล่วงหน้า%'", [YEAR]);
        if (created.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created]);
        await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'forecast\\_%'");
        await cleanupTestUsers(db);
    });

    test('ปิดอยู่ (ค่าตั้งต้น) = ไม่ส่งจากตัวตั้งเวลา', async () => {
        expect(await runForecastDigest({ now: NOW })).toEqual({ skipped: true, reason: 'disabled' });
    });
    test('สั่งส่ง: แจ้งเตือนในระบบ admin_ssj หน่วยงานที่มีความเสี่ยง + super_admin, อีเมล/Telegram (mock)', async () => {
        const r = await runForecastDigest({ manual: true, now: NOW });
        expect(r.year_bh).toBe(YEAR);
        expect(r.counts.high).toBeGreaterThanOrEqual(1);
        expect(r.sent_email).toBe(true);
        expect(r.sent_telegram).toBe(true);
        expect(sendMail.mock.calls[0][1]).toContain(`ปีงบ ${YEAR}`);
        const [mine] = await db.query("SELECT user_id, title FROM notifications WHERE year_bh = ? AND title LIKE 'เตือนล่วงหน้า%'", [YEAR]);
        const ids = mine.map(x => x.user_id);
        expect(ids).toContain(ssjUser.id);
        expect(ids).not.toContain(ssjOther.id);              // หน่วยงานอื่นไม่มีคู่เสี่ยงสูง
        expect(mine.find(x => x.user_id === ssjUser.id).title).toContain('ตัวชี้วัดเสี่ยงสูง 1 คู่');
    });
    test('PUT /forecast/settings ตรวจค่า + GET คืนค่าที่บันทึก | ผู้ใช้ทั่วไป = 403', async () => {
        const good = { watch_pct: 15, digest_enabled: true, digest_day: 2, digest_time: '07:30', digest_inapp: true, digest_email: false, digest_telegram: false, digest_ai: false };
        expect((await as(saToken, request(app).put(api('/forecast/settings'))).send({ ...good, watch_pct: 0 })).status).toBe(400);
        expect((await as(saToken, request(app).put(api('/forecast/settings'))).send({ ...good, digest_time: '7:30' })).status).toBe(400);
        expect((await as(saToken, request(app).put(api('/forecast/settings'))).send({ ...good, digest_email: undefined })).status).toBe(400);
        expect((await as(saToken, request(app).put(api('/forecast/settings'))).send(good)).status).toBe(200);
        const g = await as(saToken, request(app).get(api('/forecast/settings')));
        expect(g.body.data).toMatchObject({ watch_pct: 15, digest_enabled: true, digest_day: 2, digest_time: '07:30', digest_email: false });
        expect(g.body.last_run).toMatchObject({ year_bh: YEAR });
        expect((await as(hosToken, request(app).get(api('/forecast/settings')))).status).toBe(403);
        expect((await as(hosToken, request(app).post(api('/forecast/digest/run'))).send({ preview: true })).status).toBe(403);
    });
    test('POST /forecast/digest/run preview = สร้างข้อความ ไม่ส่ง', async () => {
        sendMail.mockClear();
        const res = await as(saToken, request(app).post(api('/forecast/digest/run'))).send({ preview: true });
        expect(res.status).toBe(200);
        expect(res.body.preview === true || res.body.skipped === true).toBe(true);
        expect(sendMail).not.toHaveBeenCalled();
    });
});
