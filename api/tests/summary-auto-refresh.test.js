/**
 * Integration tests: อัปเดตตารางสรุป kpi_summary (กราฟ/รายงาน/การ์ดสถิติ) อัตโนมัติทันทีหลังข้อมูลผลงานเปลี่ยน — database ทดสอบ
 *   - บันทึกผลงานหลัก (POST /update-kpi), อนุมัติ/ปลดล็อค → summary เปลี่ยนตามโดยไม่ต้องกด "อัปเดต Summary"
 *   - คิวต่อคู่ (ตัวชี้วัด × ปีงบ): สั่งพร้อมกันหลายครั้งไม่รันซ้อน ไม่เกิดแถวซ้ำ/ข้อผิดพลาด และรอบสุดท้ายเห็นข้อมูลล่าสุด
 * Regression (23 ต.ค. 2569): เดิมเฉพาะผลงานข้อย่อย/กิจกรรมที่อัปเดต summary ทันที — ผลงานหลักต้องรอผู้ดูแลกด "อัปเดต Summary"
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2508'; // ปีแยกเฉพาะ test นี้
let app, db, scheduleSummaryRefresh, summaryRefreshIdle, saToken, userToken, deptId, hospcode, indId, userId;
const api = (p) => '/khupskpi/api' + p;
const asSa = (r) => r.set('Authorization', `Bearer ${saToken}`);
const asUser = (r) => r.set('Authorization', `Bearer ${userToken}`);
const summary = async () => (await db.query('SELECT * FROM kpi_summary WHERE indicator_id = ? AND year_bh = ?', [indId, YEAR]))[0];

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady, scheduleSummaryRefresh, summaryRefreshIdle } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query('SELECT hoscode FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 1');
    deptId = d.id; hospcode = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_sumar_sa', role: 'super_admin', session_id: 'sess-sar-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-sar-sa' });
    const u = await ensureTestUser(db, { username: 'test_sumar_hos', role: 'user_hos', dept_id: deptId, hospcode, session_id: 'sess-sar-hos' });
    userId = u.id;
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode, sessionId: 'sess-sar-hos' });
    const [r] = await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, target_condition) VALUES ('test_sumar_ind', ?, 1, 'LTE')", [deptId]);
    indId = r.insertId;
});

afterAll(async () => {
    await summaryRefreshIdle();
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
    await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
    await cleanupTestUsers(db);
});

const save = (months) => asUser(request(app).post(api('/update-kpi')))
    .send({ updates: [{ indicator_id: indId, year_bh: YEAR, hospcode, target_value: '8', ...months }] });

test('บันทึกผลงานหลัก → kpi_summary อัปเดตเองทันที (ไม่ต้องกด อัปเดต Summary)', async () => {
    expect(await summary()).toHaveLength(0);
    let res = await save({ oct: '4' });
    expect(res.status).toBe(200);
    await summaryRefreshIdle();
    let rows = await summary();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hospcode, target_value: '8', oct: '4', last_actual: '4' });

    res = await save({ oct: '4', nov: '10' });
    expect(res.status).toBe(200);
    await summaryRefreshIdle();
    rows = await summary();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nov: '10', last_actual: '10' });
});

test('อนุมัติ/ปลดล็อค → สถานะและการล็อคใน summary ตามทันที', async () => {
    let res = await asSa(request(app).post(api('/approve-kpi'))).send({ indicator_id: indId, year_bh: YEAR, hospcode });
    expect(res.status).toBe(200);
    await summaryRefreshIdle();
    expect((await summary())[0]).toMatchObject({ is_locked: 1, indicator_status: 'Approved', pending_count: 0 });

    res = await asSa(request(app).post(api('/unlock-kpi'))).send({ indicator_id: indId, year_bh: YEAR, hospcode });
    expect(res.status).toBe(200);
    await summaryRefreshIdle();
    expect((await summary())[0]).toMatchObject({ is_locked: 0, indicator_status: 'Pending' });
});

test('รายงานเห็นผลทันทีหลังบันทึก (≤ 8: ผลงาน 10 ไม่ผ่าน → แก้เป็น 6 ผ่าน)', async () => {
    const passed = async () => {
        const b = (await asSa(request(app).get(api(`/report/by-indicator?year_bh=${YEAR}`)))).body;
        const row = b.data.find(r => Number(r.indicator_id) === indId);
        return Number(row.hospitals_passed);
    };
    expect(await passed()).toBe(0);
    await save({ oct: '4', nov: '6' });
    await summaryRefreshIdle();
    expect(await passed()).toBe(1);
});

test('สั่ง refresh คู่เดียวกันพร้อมกันหลายครั้ง → ไม่รันซ้อน ไม่มีแถวซ้ำ และรอบสุดท้ายเห็นข้อมูลล่าสุด', async () => {
    const errors = [];
    const orig = console.error;
    console.error = (...a) => { errors.push(a.join(' ')); };
    try {
        const pair = { indicator_id: indId, year_bh: YEAR };
        const all = [];
        for (let i = 0; i < 6; i++) all.push(scheduleSummaryRefresh([pair, pair]));
        // แก้ข้อมูลระหว่างที่คิวกำลังรัน → ต้องมีรอบหลังที่เห็นค่าใหม่
        await db.query("UPDATE kpi_results SET actual_value = '7' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = 11", [indId, YEAR, hospcode]);
        all.push(scheduleSummaryRefresh([pair]));
        await Promise.all(all);
        await summaryRefreshIdle();
    } finally {
        console.error = orig;
    }
    expect(errors.filter(e => e.includes('[summary]'))).toEqual([]);
    const rows = await summary();
    expect(rows).toHaveLength(1);
    expect(rows[0].last_actual).toBe('7');
});
