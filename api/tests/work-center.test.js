/**
 * ศูนย์งานผู้ดูแล + แจ้งเตือนหน่วยบริการที่ยังไม่ส่งผลงาน (ระยะ 4 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 *   - กติกาวันที่ (เวลาไทย): เดือนที่ควรส่งแล้ว = เดือนก่อนหน้า (ข้ามปีงบ ต.ค.), กำหนดส่ง = วันที่ N ของเดือนถัดไป, ถึงเวลาเตือน = กำหนดส่ง − k วัน ณ เวลาที่ตั้ง
 *   - ยังไม่ส่ง: เดือนนั้นผลงานว่าง (0 = ส่งแล้ว), มีผลงานข้อย่อยของเดือนนั้น = ส่งแล้ว, ตัวชี้วัดปิดใช้งาน/กรอกเอง = ไม่นับ — ตามขอบเขต role
 *   - คิวรออนุมัติตามขอบเขต (admin_ssj เฉพาะหน่วยงานตัวเอง) | สิทธิ์หน้า work-center (ผู้ใช้ทั่วไป = 403)
 *   - ส่งเตือน (24 พ.ย. 2569): ปีงบปัจจุบันเท่านั้น, ผู้รับแต่ละคนได้เฉพาะตัวชี้วัดของหน่วยบริการ + กลุ่มงานตนเอง (กลุ่มงานเพิ่มเติมนับด้วย,
 *     admin_hos ทุกกลุ่มงาน, ไม่มีกลุ่มงาน = ไม่ได้รับ) ในระบบ/LINE/อีเมลรายผู้รับ, สั่งซ้ำวันเดียวกัน = ไม่ส่งซ้ำ, ดูตัวอย่างไม่ส่ง,
 *     ตั้งค่า/ส่ง = super_admin แบบเข้ม (admin_ssj ที่เข้าหน้าได้ = 403)
 */
const mockSent = { line: [], email: [] };
jest.mock('../core/notify', () => {
    const actual = jest.requireActual('../core/notify');
    return {
        ...actual,
        // ฐานทดสอบมีโทเคน LINE/Telegram/SMTP จริง — ห้ามส่งออกนอกเครื่อง
        sendLineToUser: jest.fn(async (id, msg) => { mockSent.line.push({ id, msg }); if (mockSent.hold) await mockSent.hold; return true; }),
        sendMail: jest.fn(async (to, subject) => { mockSent.email.push({ to, subject }); }),
        sendTelegramDirect: jest.fn(async () => {}),
        sendLineDirect: jest.fn(async () => {}),
        sendLineMulticast: jest.fn(async () => {}),
        notifyAdmins: jest.fn(async () => {}),
    };
});

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => '/khupskpi/api' + p;
const YEAR = '2501';
let app, db, wc, T = {}, ids = {}, hos = [], deptA, deptB, saId, fySpy, U = {};

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    wc = require('../services/work-center');
    await migrationsReady;
    // ข้อมูลทดสอบอยู่ปีงบ 2501 — ให้ "ปีงบปัจจุบัน" ของการส่งเตือน = 2501
    fySpy = jest.spyOn(require('../core/fiscal-year'), 'currentFiscalYear').mockReturnValue(Number(YEAR));
    await cleanupTestUsers(db, 'test\\_wc\\_');
    const [deps] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
    deptA = deps[0].id; deptB = deps[1].id;
    hos = (await db.query("SELECT hoscode FROM chospital WHERE hostype IS NOT NULL ORDER BY hoscode LIMIT 4"))[0].map(r => r.hoscode);
    const mk = async (name, role, extra = {}) => {
        const u = await ensureTestUser(db, { username: name, role, ...extra });
        return { id: u.id, tok: makeToken({ userId: u.id, username: name, role, deptId: extra.dept_id ?? null, hospcode: extra.hospcode ?? null }) };
    };
    const sa = await mk('test_wc_sa', 'super_admin');
    saId = sa.id; T.sa = sa.tok;
    T.ssjA = (await mk('test_wc_ssja', 'admin_ssj', { dept_id: deptA })).tok;
    T.ssjB = (await mk('test_wc_ssjb', 'admin_ssj', { dept_id: deptB })).tok;
    T.hos1 = (await mk('test_wc_hos1', 'admin_hos', { hospcode: hos[1] })).tok;
    T.user = (await mk('test_wc_user', 'user_hos', { hospcode: hos[0], dept_id: deptA })).tok;
    U.rcpt = (await mk('test_wc_rcpt', 'user_hos', { hospcode: hos[1], dept_id: deptA, email: 'test_wc_rcpt@example.test' })).id; // ผู้รับเตือนของหน่วยบริการ hos[1]
    U.rcptB = (await mk('test_wc_rcptb', 'user_hos', { hospcode: hos[1], dept_id: deptB, email: 'test_wc_rcptb@example.test' })).id; // กลุ่มงานอื่น = ไม่ได้รับ
    U.extra = (await mk('test_wc_extra', 'user_hos', { hospcode: hos[1], dept_id: deptB, email: 'test_wc_extra@example.test' })).id; // กลุ่มงานเพิ่มเติม = deptA
    await db.query("INSERT INTO user_departments (user_id, dept_id, status) VALUES (?, ?, 'approved')", [U.extra, deptA]);
    U.nodept = (await mk('test_wc_nodept', 'user_hos', { hospcode: hos[1], email: 'test_wc_nodept@example.test' })).id;
    await db.query('UPDATE users SET dept_id = NULL WHERE id = ?', [U.nodept]); // ไม่มีกลุ่มงาน = ไม่ได้รับ
    const ind = async (name, extra = '') => (await db.query(
        `INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?, ?, 1${extra ? ', ' + extra.split('=')[1] : ''})`, [name, deptA]))[0].insertId;
    ids.main = await ind('test_wc_main');
    ids.manual = await ind('test_wc_manual', 'result_manual=1');
    ids.inactive = await ind('test_wc_inactive');
    await db.query('UPDATE kpi_indicators SET is_active = 0 WHERE id = ?', [ids.inactive]);
    ids.sub = await ind('test_wc_sub');
    const r = (indId, hc, m, actual) => db.query(
        `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, target_value, actual_value, user_id, status, hospcode) VALUES (?, ?, ?, '10', ?, ?, 'Pending', ?)`,
        [indId, YEAR, m, actual, saId, hc]);
    await r(ids.main, hos[0], 10, '5');   // ส่งแล้ว
    await r(ids.main, hos[1], 10, '');    // ยังไม่ส่ง (มีแต่เป้าหมาย)
    await r(ids.main, hos[2], 10, '0');   // 0 = ส่งแล้ว
    await r(ids.manual, hos[1], 10, '');  // กรอกผลงานเอง — ไม่นับ
    await r(ids.inactive, hos[1], 10, ''); // ปิดใช้งาน — ไม่นับ
    await r(ids.sub, hos[3], 10, '');     // หลักว่าง แต่มีผลงานข้อย่อยเดือนนี้ = ส่งแล้ว
    const sub = (await db.query('INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, is_active) VALUES (?, ?, 1)', [ids.sub, 'test_wc_sub_1']))[0].insertId;
    await db.query("INSERT INTO kpi_sub_results (sub_indicator_id, year_bh, hospcode, month_bh, actual_value) VALUES (?, ?, ?, 10, '3')", [sub, YEAR, hos[3]]);
    // คิวรออนุมัติ (kpi_summary)
    await db.query('INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, pending_count) VALUES (?, ?, ?, ?, 2)', [ids.main, YEAR, hos[0], deptA]);
}, 60000);

afterAll(async () => {
    if (fySpy) fySpy.mockRestore();
    const all = Object.values(ids);
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [all]);
    await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [all]);
    await db.query('DELETE FROM notifications WHERE year_bh = ?', [YEAR]);
    await db.query('DELETE FROM kpi_reminder_log WHERE year_bh = ?', [YEAR]);
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'reminder\\_%'");
    await cleanupTestUsers(db, 'test\\_wc\\_');
});

describe('กติกาวันที่ (เวลาไทย)', () => {
    const at = (iso) => new Date(iso);
    test('เดือนที่ควรส่งแล้ว = เดือนก่อนหน้า ข้ามปีงบตอน ต.ค./ม.ค.', () => {
        expect(wc.defaultTargetMonth(at('2026-11-21T05:00:00Z'))).toEqual({ year_bh: '2570', month_bh: 10 });
        expect(wc.defaultTargetMonth(at('2026-10-05T05:00:00Z'))).toEqual({ year_bh: '2569', month_bh: 9 });
        expect(wc.defaultTargetMonth(at('2027-01-03T05:00:00Z'))).toEqual({ year_bh: '2570', month_bh: 12 });
        // 1 พ.ย. 00:30 เวลาไทย = 31 ต.ค. 17:30 UTC → ยังเป็นเดือน พ.ย. ตามเวลาไทย
        expect(wc.defaultTargetMonth(at('2026-10-31T17:30:00Z'))).toEqual({ year_bh: '2570', month_bh: 10 });
    });
    test('กำหนดส่ง = วันที่ N ของเดือนถัดไป (เกินจำนวนวัน = วันสุดท้าย)', () => {
        expect(wc.dueDateOf('2570', 10, 10)).toBe('2026-11-10');
        expect(wc.dueDateOf('2570', 12, 10)).toBe('2027-01-10');
        expect(wc.dueDateOf('2570', 1, 31)).toBe('2027-02-28');
        expect(wc.thaiDateText('2026-11-10')).toBe('10 พ.ย. 2569');
        expect(wc.monthLabel('2570', 10)).toBe('ต.ค. 2569');
    });
    test('ถึงเวลาเตือน = กำหนดส่ง − k วัน ณ เวลาที่ตั้ง (ช่วง 2 นาที)', () => {
        const cfg = { enabled: true, due_day: 10, days_before: [3, 1], time: '09:00' };
        expect(wc.isReminderDue(cfg, at('2026-11-07T02:00:00Z'))).toMatchObject({ year_bh: '2570', month_bh: 10, stage: 'd3' });
        expect(wc.isReminderDue(cfg, at('2026-11-07T02:01:30Z'))).toMatchObject({ stage: 'd3' });
        expect(wc.isReminderDue(cfg, at('2026-11-07T02:02:30Z'))).toBeNull();
        expect(wc.isReminderDue(cfg, at('2026-11-09T02:00:00Z'))).toMatchObject({ stage: 'd1' });
        expect(wc.isReminderDue(cfg, at('2026-11-08T02:00:00Z'))).toBeNull();
        expect(wc.isReminderDue({ ...cfg, enabled: false }, at('2026-11-07T02:00:00Z'))).toBeNull();
    });
});

describe('ภาพรวม / ยังไม่ส่ง / คิวรออนุมัติ', () => {
    const get = (tok, p) => request(app).get(api(p)).set('Authorization', `Bearer ${tok}`);
    test('ยังไม่ส่ง: เฉพาะคู่ที่เดือนนั้นว่าง — 0 = ส่งแล้ว, ข้อย่อยมีผลงาน = ส่งแล้ว, กรอกเอง/ปิดใช้งาน = ไม่นับ', async () => {
        const res = await get(T.sa, `/work-center/missing?year_bh=${YEAR}&month_bh=10`);
        expect(res.status).toBe(200);
        expect(res.body.data.totals).toEqual({ pairs: 1, hospitals: 1, indicators: 1 });
        expect(res.body.data.items[0]).toMatchObject({ hospcode: hos[1], count: 1 });
        const byInd = await get(T.sa, `/work-center/missing?year_bh=${YEAR}&month_bh=10&group=indicator`);
        expect(byInd.body.data.items[0]).toMatchObject({ indicator_id: ids.main, indicator_name: 'test_wc_main' });
    });
    test('ตามขอบเขต: admin_hos เห็นเฉพาะหน่วยบริการตัวเอง / admin_ssj หน่วยงานอื่นไม่เห็น', async () => {
        expect((await get(T.hos1, `/work-center/summary?year_bh=${YEAR}&month_bh=10`)).body.data.missing.pairs).toBe(1);
        const ssjB = await get(T.ssjB, `/work-center/summary?year_bh=${YEAR}&month_bh=10`);
        expect(ssjB.body.data.missing.pairs).toBe(0);
        expect(ssjB.body.data.review.pending_pairs).toBe(0);
    });
    test('คิวรออนุมัติ + การ์ดภาพรวม (admin_ssj หน่วยงานตัวเอง)', async () => {
        const sum = await get(T.ssjA, `/work-center/summary?year_bh=${YEAR}&month_bh=10`);
        expect(sum.status).toBe(200);
        expect(sum.body.data).toMatchObject({ can_review: true, is_super_admin: false, khd: null, review: { pending_pairs: 1, pending_months: 2 } });
        expect(sum.body.data.due_date).toBe('1957-11-10'); // ปีงบ 2501 เดือน ต.ค. 2500 → ส่งภายใน 10 พ.ย. 2500 (ค.ศ. 1957)
        const q = await get(T.ssjA, `/work-center/review-queue?year_bh=${YEAR}`);
        expect(q.body.items).toEqual([expect.objectContaining({ indicator_id: ids.main, hospcode: hos[0], pending_count: 2 })]);
        expect((await get(T.ssjB, `/work-center/review-queue?year_bh=${YEAR}`)).body.items).toEqual([]);
        expect((await get(T.sa, `/work-center/summary?year_bh=${YEAR}&month_bh=10`)).body.data.khd).toMatchObject({ policy: expect.any(String) });
    });
    test('สิทธิ์หน้า: ผู้ใช้ทั่วไป = 403 / ค่าผิด = 400 / คุณภาพข้อมูลเฉพาะ super_admin', async () => {
        expect((await get(T.user, `/work-center/summary?year_bh=${YEAR}`)).status).toBe(403);
        expect((await get(T.sa, '/work-center/summary?year_bh=25x1')).status).toBe(400);
        expect((await get(T.sa, `/work-center/missing?year_bh=${YEAR}&month_bh=13`)).status).toBe(400);
        expect((await get(T.ssjA, `/work-center/data-quality?year_bh=${YEAR}`)).status).toBe(403);
        expect((await get(T.sa, `/work-center/data-quality?year_bh=${YEAR}`)).status).toBe(200);
    });
});

describe('แจ้งเตือนหน่วยบริการที่ยังไม่ส่ง', () => {
    const post = (tok, p, body) => request(app).post(api(p)).set('Authorization', `Bearer ${tok}`).send(body);
    const put = (tok, body) => request(app).put(api('/work-center/reminder-settings')).set('Authorization', `Bearer ${tok}`).send(body);
    const getStatus = (tok) => request(app).get(api('/work-center/reminders/status')).set('Authorization', `Bearer ${tok}`);
    const waitFor = async (fn, ms = 10000) => {
        const end = Date.now() + ms;
        while (!(await fn())) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 50)); }
    };
    /** รอให้งานส่งเตือนเสร็จ → ผลของรอบนั้น */
    const waitJob = async () => {
        let job;
        await waitFor(async () => { job = (await getStatus(T.sa)).body.data.job; return job && job.status !== 'running'; });
        expect(job.status).toBe('done');
        return job.result;
    };
    const notifCount = async () => Number((await db.query("SELECT COUNT(*) n FROM notifications WHERE year_bh = ? AND title LIKE 'เตือนส่งผลงาน%'", [YEAR]))[0][0].n);

    test('ตั้งค่า: super_admin เท่านั้น + ตรวจค่า', async () => {
        expect((await put(T.ssjA, { reminder_enabled: true })).status).toBe(403);
        expect((await put(T.sa, { reminder_due_day: 31 })).status).toBe(400);
        expect((await put(T.sa, { reminder_time: '9am' })).status).toBe(400);
        expect((await put(T.sa, { reminder_enabled: 'yes' })).status).toBe(400);
        const ok = await put(T.sa, { reminder_due_day: 12, reminder_days_before: [1, 3], reminder_channels: { inapp: true, line: true, email: true } });
        expect(ok.status).toBe(200);
        expect(ok.body.data).toMatchObject({ reminder_due_day: 12, reminder_days_before: [3, 1], reminder_enabled: false });
    });

    test('ดูตัวอย่างไม่ส่ง / ส่งทันที: รายผู้รับตามหน่วยบริการ + กลุ่มงาน / สั่งซ้ำวันเดียวกันไม่ส่งซ้ำ', async () => {
        expect((await post(T.ssjA, '/work-center/reminders/send-now', { year_bh: YEAR, month_bh: 10 })).status).toBe(403);
        const pre = await post(T.sa, '/work-center/reminders/preview', { year_bh: YEAR, month_bh: 10 });
        expect(pre.status).toBe(200);
        expect(pre.body.data).toMatchObject({ hospitals: 1, pairs: 1, recipients: 3, no_dept_users: 1, unassigned_pairs: 0, sent: { inapp: 0, line: 0, email: 0 } });
        expect(pre.body.data.sample[0]).toMatchObject({ hospcode: hos[1], count: 1, recipients: 3 });
        expect(await notifCount()).toBe(0);
        expect(mockSent.line.length + mockSent.email.length).toBe(0);

        // ส่งทันที = งานเบื้องหลัง (เดิม await ทั้งรอบในคำขอ → production 504) — คืน 202 แล้วดูผลที่ /reminders/status
        mockSent.hold = new Promise(r => { mockSent.release = r; });
        const start = await post(T.sa, '/work-center/reminders/send-now', { year_bh: YEAR, month_bh: 10 });
        expect(start.status).toBe(202);
        expect(start.body.data.job).toMatchObject({ status: 'running', year_bh: YEAR, month_bh: 10 });
        await waitFor(() => mockSent.line.length >= 1);
        const busy = await post(T.sa, '/work-center/reminders/send-now', { year_bh: YEAR, month_bh: 10 });
        expect(busy.status).toBe(409);
        expect(busy.body.code).toBe('REMINDER_BUSY');
        expect((await getStatus(T.ssjA)).status).toBe(403);
        mockSent.release();
        const go = { body: { data: await waitJob() } };
        mockSent.hold = null;
        // ผู้รับของ hos[1] = test_wc_rcpt (กลุ่มงาน A) + test_wc_extra (กลุ่มงานเพิ่มเติม A) + test_wc_hos1 (admin_hos ทุกกลุ่มงาน)
        // ไม่ได้รับ: test_wc_rcptb (กลุ่มงาน B), test_wc_nodept (ไม่มีกลุ่มงาน)
        expect(go.body.data.sent).toEqual({ inapp: 3, line: 3, email: 3 });
        const st = (await getStatus(T.sa)).body.data.job;
        expect(st.progress).toMatchObject({ recipients_done: 3, recipients_total: 3, messages_done: 6, messages_total: 6 });
        const [[last]] = await db.query("SELECT setting_value v FROM system_settings WHERE setting_key = 'reminder_last_run'");
        expect(JSON.parse(last.v)).toMatchObject({ manual: true, year_bh: YEAR });
        expect(await notifCount()).toBe(3);
        const [ns] = await db.query("SELECT user_id, hospcode, message FROM notifications WHERE year_bh = ? AND title LIKE 'เตือนส่งผลงาน%'", [YEAR]);
        expect(ns.map(n => n.user_id)).toEqual(expect.arrayContaining([U.rcpt, U.extra]));
        expect(ns.map(n => n.user_id)).not.toContain(U.rcptB);
        expect(ns.every(n => n.hospcode === null)).toBe(true); // รายผู้รับ ไม่ใช่ระดับหน่วยบริการ (ผู้ใช้กลุ่มงานอื่นจะเห็น)
        expect(ns[0].message).toMatch(/1 ตัวชี้วัดที่ท่านรับผิดชอบ/);
        expect(ns[0].message).toMatch(/• test_wc_main/);
        const to = mockSent.email.map(e => e.to);
        expect(to).toEqual(expect.arrayContaining(['test_wc_rcpt@example.test', 'test_wc_extra@example.test']));
        expect(to).not.toContain('test_wc_rcptb@example.test');
        expect(to).not.toContain('test_wc_nodept@example.test');
        expect(mockSent.line.map(l => l.id)).not.toContain(U.rcptB);

        expect((await post(T.sa, '/work-center/reminders/send-now', { year_bh: YEAR, month_bh: 10 })).status).toBe(202);
        const again = { body: { data: await waitJob() } };
        expect(again.body.data.sent).toEqual({ inapp: 0, line: 0, email: 0 });
        expect(again.body.data.skipped_duplicate).toBe(9);
        expect(await notifCount()).toBe(3);
        expect(mockSent.line.length).toBe(3);
    });

    test('ปีงบอื่นที่ไม่ใช่ปีงบปัจจุบัน = ไม่ส่ง (ดูตัวอย่าง/ส่งทันที 400, งานตามเวลา reason not_current_fy)', async () => {
        const pre = await post(T.sa, '/work-center/reminders/preview', { year_bh: '2502', month_bh: 10 });
        expect(pre.status).toBe(400);
        expect(pre.body.code).toBe('NOT_CURRENT_FY');
        expect((await post(T.sa, '/work-center/reminders/send-now', { year_bh: '2500', month_bh: 10 })).status).toBe(400);
        const { runResultReminders } = require('../jobs/result-reminder');
        const r = await runResultReminders({ yearBh: '2500', monthBh: 9, settings: await wc.getReminderSettings() });
        expect(r).toMatchObject({ reason: 'not_current_fy', pairs: 0, sent: { inapp: 0, line: 0, email: 0 } });
    });
});

describe('assignPairs (แบ่งรายการให้ผู้รับ)', () => {
    const { assignPairs } = require('../jobs/result-reminder');
    const u = (id, role, hospcode, deptIds) => ({ id, role, hospcode, deptIds });
    test('หน่วยบริการตนเอง + กลุ่มงานตนเอง / admin_hos ทุกกลุ่มงาน / ตัวชี้วัดไม่ระบุกลุ่มงาน = เฉพาะผู้ดูแล', () => {
        const pairs = [
            { indicator_id: 1, hospcode: 'H1' }, { indicator_id: 2, hospcode: 'H1' }, { indicator_id: 3, hospcode: 'H1' },
            { indicator_id: 1, hospcode: 'H2' }, { indicator_id: 2, hospcode: 'H9' },
        ];
        const deptOf = new Map([[1, 10], [2, 20], [3, null]]);
        const rc = [u(1, 'user_hos', 'H1', [10]), u(2, 'user_hos', 'H1', [20, 10]), u(3, 'admin_hos', 'H1', [10]),
            u(4, 'user_hos', 'H1', []), u(5, 'admin_cup', 'H2', []), u(6, 'user_cup', 'H2', [20])];
        const out = assignPairs(pairs, rc, deptOf);
        const by = Object.fromEntries(out.perUser.map(x => [x.user.id, x.ids]));
        expect(by).toEqual({ 1: [1], 2: [1, 2], 3: [1, 2, 3], 5: [1] });
        expect(out.noDept).toBe(1);
        expect(out.unassigned).toBe(1); // H9 ไม่มีผู้รับ
    });
});
