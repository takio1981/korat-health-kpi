/**
 * อนุมัติรายเดือน (ระยะ 2 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 * เดิม: อนุมัติ = ล็อคทั้งปี → หน่วยบริการบันทึกเดือนถัดไปไม่ได้จนกว่า super_admin ปลดล็อค (และปลดแล้วทุกเดือนกลับเป็นรอตรวจ)
 * ใหม่: อนุมัติ "ถึงเดือน M" ล็อคเฉพาะเดือน ≤ M — บันทึกเดือนถัดไปได้, แก้เดือนที่อนุมัติแล้ว = 403, ส่งคืน/อุทธรณ์/ข้อย่อย ทำงานรายเดือน
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => `/khupskpi/api${p}`;
const YEAR = '2570';
let app, db, dept, hos, ind, sub, T = {};

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_mappr\\_');
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_mappr\\_%'");
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    dept = d.id;
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    hos = h.hoscode;
    ind = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES ('test_mappr_ind', ?, 1)", [dept]))[0].insertId;
    sub = (await db.query("INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, is_active) VALUES (?, 'test_mappr_sub', 1)", [ind]))[0].insertId;
    const mk = async (key, role, hospcode) => {
        const u = await ensureTestUser(db, { username: 'test_mappr_' + key, role, dept_id: dept, hospcode, session_id: 's-mappr-' + key });
        T[key] = makeToken({ userId: u.id, username: u.username, role, deptId: dept, hospcode, sessionId: 's-mappr-' + key });
    };
    await mk('user', 'user_hos', hos);
    await mk('ssj', 'admin_ssj', hos);
    await mk('sa', 'super_admin', null);
}, 60000);

afterAll(async () => {
    if (ind) {
        await db.query('DELETE FROM kpi_sub_results WHERE sub_indicator_id = ?', [sub]).catch(() => {});
        await db.query('DELETE FROM kpi_sub_indicators WHERE id = ?', [sub]).catch(() => {});
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM notifications WHERE indicator_id = ?', [ind]).catch(() => {});
        await db.query('DELETE FROM kpi_rejection_comments WHERE indicator_id = ?', [ind]).catch(() => {});
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [ind]);
    }
    await cleanupTestUsers(db, 'test\\_mappr\\_');
});

const post = (t, p, body) => request(app).post(api(p)).set('Authorization', `Bearer ${t}`).send(body);
const save = (t, vals, extra = {}) => post(t, '/update-kpi', { updates: [{ indicator_id: ind, year_bh: YEAR, hospcode: hos, target_value: '100', ...vals }], targetHospcode: hos, ...extra });
/** สถานะรายเดือน { 10: {status, locked, actual}, ... } */
async function months() {
    const [rows] = await db.query('SELECT month_bh, status, is_locked, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [ind, YEAR, hos]);
    const out = {};
    for (const r of rows) out[Number(r.month_bh)] = { status: r.status, locked: Number(r.is_locked), actual: r.actual_value };
    return out;
}

test('อนุมัติ (ไม่ระบุเดือน) = ถึงเดือนล่าสุดที่มีผลงาน — เดือนถัดไปยังเปิด', async () => {
    expect((await save(T.user, { oct: '10', nov: '20' })).status).toBe(200);
    const r = await post(T.ssj, '/approve-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hos }]);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approved: 1, months: 2 });
    const m = await months();
    expect(m[10]).toMatchObject({ status: 'Approved', locked: 1 });
    expect(m[11]).toMatchObject({ status: 'Approved', locked: 1 });
    expect(m[12]).toMatchObject({ status: 'Pending', locked: 0 });   // เดือนว่าง (มีแต่เป้าหมาย) ยังเปิด
});

test('🛡️ บันทึกเดือนถัดไปได้ (เดิม: ล็อคทั้งปี = 403) / เดือนที่อนุมัติคงเดิม', async () => {
    const r = await save(T.user, { oct: '10', nov: '20', dece: '30' });
    expect(r.status).toBe(200);
    const m = await months();
    expect(m[12]).toMatchObject({ status: 'Pending', locked: 0, actual: '30' });
    expect(m[10]).toMatchObject({ status: 'Approved', locked: 1, actual: '10' });
    expect(m[11]).toMatchObject({ status: 'Approved', locked: 1, actual: '20' });
});

test('🛡️ แก้ผลงานเดือนที่อนุมัติแล้ว → 403 MONTH_LOCKED (ค่าไม่เปลี่ยน)', async () => {
    const r = await save(T.user, { oct: '10', nov: '25', dece: '30' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MONTH_LOCKED');
    expect((await months())[11]).toMatchObject({ status: 'Approved', locked: 1, actual: '20' });
});

test('แก้เป้าหมายได้ — เดือนที่ล็อคปรับเป้าหมายในแถวเดิม (ยังล็อค)', async () => {
    expect((await save(T.user, { oct: '10', nov: '20', dece: '30', target_value: '120' })).status).toBe(200);
    const [rows] = await db.query('SELECT month_bh, target_value, is_locked FROM kpi_results WHERE indicator_id = ? AND hospcode = ? AND month_bh IN (10, 12)', [ind, hos]);
    for (const r of rows) expect(r.target_value).toBe('120');
    expect(Number(rows.find(r => Number(r.month_bh) === 10).is_locked)).toBe(1);
});

test('ส่งคืน (ไม่ระบุเดือน) โดย admin_ssj = เฉพาะเดือนที่ยังไม่อนุมัติ', async () => {
    const r = await post(T.ssj, '/reject-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hos, comment: 'ทดสอบ' }]);
    expect(r.status).toBe(200);
    const m = await months();
    expect(m[12]).toMatchObject({ status: 'Rejected', locked: 0 });
    expect(m[10]).toMatchObject({ status: 'Approved', locked: 1 });
    // ระบุเดือนที่อนุมัติแล้ว = super_admin เท่านั้น
    expect((await post(T.ssj, '/reject-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hos, comment: 'x', reject_months: ['nov'] }])).status).toBe(409);
});

test('super_admin แก้เดือนที่อนุมัติ = เดือนนั้นกลับเป็นรอตรวจ (เดือนอื่นคงล็อค) + อนุมัติถึงเดือนที่ระบุ', async () => {
    expect((await save(T.sa, { oct: '10', nov: '22', dece: '30' })).status).toBe(200);
    let m = await months();
    expect(m[11]).toMatchObject({ status: 'Pending', locked: 0, actual: '22' });
    expect(m[10]).toMatchObject({ status: 'Approved', locked: 1 });
    // อนุมัติถึง พ.ย. (ธ.ค. ยังเปิด)
    const r = await post(T.ssj, '/approve-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hos, through_month: 'nov' }]);
    expect(r.status).toBe(200);
    m = await months();
    expect(m[11]).toMatchObject({ status: 'Approved', locked: 1 });
    expect(m[12].locked).toBe(0);
    expect((await post(T.ssj, '/approve-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hos, through_month: 'xyz' }])).status).toBe(400);
});

test('🛡️ ข้อย่อย: เดือนที่ตัวชี้วัดหลักอนุมัติแล้ว → 403 / เดือนที่ยังเปิดบันทึกได้', async () => {
    const up = (m) => post(T.user, '/sub-results/upsert', { sub_indicator_id: sub, year_bh: YEAR, hospcode: hos, month_bh: m, actual_value: '5', target_value: '10' });
    const locked = await up(10);
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe('MONTH_LOCKED');
    expect((await up(1)).status).toBe(200);
});

test('อุทธรณ์: ไม่รับอุทธรณ์ = ล็อคกลับเฉพาะเดือนที่อุทธรณ์ (เดิมล็อคทั้งปีรวมเดือนที่ยังไม่อนุมัติ)', async () => {
    await db.query("UPDATE kpi_results SET status = 'Appeal' WHERE indicator_id = ? AND hospcode = ? AND is_locked = 1", [ind, hos]);
    const r = await post(T.ssj, '/appeal-reject', { indicator_id: ind, year_bh: YEAR, hospcode: hos, comment: 'ทดสอบ' });
    expect(r.status).toBe(200);
    const m = await months();
    expect(m[10]).toMatchObject({ status: 'Approved', locked: 1 });
    expect(m[12].locked).toBe(0);
    expect(m[12].status).not.toBe('Approved');
});

test('สถานะรวม/จำนวนรอตรวจ: เดือนว่างหลังเดือนที่อนุมัติไม่นับเป็นรอตรวจ', async () => {
    // อนุมัติทุกเดือนที่มีผลงาน (ธ.ค. ที่ถูกส่งคืน → หน่วยบริการแก้ส่งใหม่ → อนุมัติ)
    await db.query("UPDATE kpi_results SET status = 'Pending' WHERE indicator_id = ? AND hospcode = ? AND status = 'Rejected'", [ind, hos]);
    await post(T.ssj, '/approve-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hos }]);
    const { scheduleSummaryRefresh, summaryRefreshIdle } = require('../services/summary');
    scheduleSummaryRefresh([{ indicator_id: ind, year_bh: YEAR }]);
    await summaryRefreshIdle();
    const [[s]] = await db.query('SELECT pending_count, indicator_status, is_locked FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [ind, YEAR, hos]);
    expect(s).toMatchObject({ pending_count: 0, indicator_status: 'Approved' });
    const m = await months();
    // ม.ค. มีผลงานข้อย่อย (บันทึกในกรณีก่อนหน้า) → อนุมัติถึง ม.ค. (นับผลงานข้อย่อย/กิจกรรมด้วย) | ก.พ. ยังว่าง = เปิดบันทึก
    expect(m[1].locked).toBe(1);
    expect(m[2].locked).toBe(0);
});
