/**
 * Integration tests: เงื่อนไขเป้าหมาย (target_condition ≥ > ≤ < =) ในการนับ "ผ่านเกณฑ์" — รันบน database ทดสอบ
 *   การ์ด /dashboard-stats, /report/by-indicator, /report/by-hospital, /report/chart-stats ต้องนับตามเงื่อนไขของแต่ละตัวชี้วัด
 *   และให้ผลตรงกับ kpi-target.js (สำเนาเดียวกับหน้าบันทึกผลงาน)
 * Regression (22 ต.ค. 2569): เดิมทุกจุดนับผ่านด้วย last_actual >= target_value — ตัวชี้วัด "ยิ่งน้อยยิ่งดี" (≤ 8, ผลงาน 4) ถูกนับว่าไม่ผ่าน
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { evaluateTarget, hasTarget } = require('../kpi-target');

const YEAR = '2507'; // ปีแยกเฉพาะ test นี้
let app, db, saToken, deptId, hospA;
const created = [];
const api = (p) => '/khupskpi/api' + p;

// [ชื่อ, เงื่อนไข, เป้าหมาย, ผลงาน, ผ่าน?, มีเป้าหมาย?]
const CASES = [
    ['test_tc_lte_pass', 'LTE', '8', '4', true, true],
    ['test_tc_lte_fail', 'LTE', '8', '10', false, true],
    ['test_tc_lt_equal', 'LT', '8', '8', false, true],
    ['test_tc_lt_zero', 'LT', '5', '0', true, true],
    ['test_tc_eq_pass', 'EQ', '100', '100', true, true],
    ['test_tc_eq_fail', 'EQ', '100', '90', false, true],
    ['test_tc_gt_equal', 'GT', '80', '80', false, true],
    ['test_tc_gte_equal', 'GTE', '80', '80', true, true],
    ['test_tc_none_fail', null, '80', '40', false, true],            // ไม่ได้ตั้ง = ≥ (วิธีเดิม)
    ['test_tc_lte_zero_target', 'LTE', '0', '0', true, true],         // เป้าหมาย 0 ใช้ได้กับ ≤
    ['test_tc_gte_zero_target', 'GTE', '0', '5', false, false],       // ≥ เป้าหมาย 0 = ไม่มีเป้าหมาย (เดิม)
    ['test_tc_lte_text', 'LTE', '8', 'กำลังดำเนินการ', false, true],  // ข้อความไม่นับว่าผ่าน (CAST = 0 ห้ามผ่าน ≤)
];
const EXPECT_WITH = CASES.filter(c => c[5]).length;
const EXPECT_PASS = CASES.filter(c => c[4]).length;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query('SELECT hoscode, hosname, distid, hostype FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 1');
    deptId = d.id; hospA = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_tc_sa', role: 'super_admin', session_id: 'sess-tc-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-tc-sa' });
    for (const [name, cond, target, last] of CASES) {
        const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, target_condition) VALUES (?,?,1,?)', [name, deptId, cond]);
        created.push(r.insertId);
        await db.query(
            `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [r.insertId, YEAR, hospA, deptId, 'test_dept', h.hosname, h.distid, 'test_dist', h.hostype, target, last, last]);
    }
});

afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    if (created.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created]);
    await cleanupTestUsers(db);
});

const get = async (p) => {
    const res = await request(app).get(api(p)).set('Authorization', `Bearer ${saToken}`);
    expect(res.status).toBe(200);
    return res.body;
};

test('ตารางเคสตรงกับกฎกลาง kpi-target.js (frontend ใช้สำเนาเดียวกัน)', () => {
    for (const [name, cond, target, last, pass, has] of CASES) {
        expect([name, evaluateTarget(last, target, cond).pass === true]).toEqual([name, pass]);
        expect([name, hasTarget(target, cond)]).toEqual([name, has]);
    }
});

test('/report/by-indicator นับผ่านตามเงื่อนไขของแต่ละตัวชี้วัด', async () => {
    const b = await get(`/report/by-indicator?year_bh=${YEAR}`);
    const rows = b.data.filter(r => created.includes(Number(r.indicator_id)));
    expect(rows).toHaveLength(CASES.length);
    CASES.forEach(([name, , , , pass, has], k) => {
        const r = rows.find(x => Number(x.indicator_id) === created[k]);
        expect([name, Number(r.hospitals_with_target), Number(r.hospitals_passed)]).toEqual([name, has ? 1 : 0, pass ? 1 : 0]);
    });
});

test('/report/by-hospital และ /dashboard-stats รวมผลตรงกัน', async () => {
    const h = await get(`/report/by-hospital?year_bh=${YEAR}`);
    const row = h.data.find(r => r.hospcode === hospA);
    expect(Number(row.indicators_with_target)).toBe(EXPECT_WITH);
    expect(Number(row.indicators_passed)).toBe(EXPECT_PASS);
    const s = await get(`/dashboard-stats?year=${YEAR}`);
    expect(Number(s.data.successRate)).toBeCloseTo(EXPECT_PASS / EXPECT_WITH * 100, 1);
});

test('/report/chart-stats ภาพรวม + รายเดือน ตามเงื่อนไข', async () => {
    const b = await get(`/report/chart-stats?year_bh=${YEAR}`);
    expect(b.overall).toMatchObject({ with_target: EXPECT_WITH, passed: EXPECT_PASS });
    const oct = b.monthly.find(m => m.month === 'oct');
    // รายเดือนนับเฉพาะค่าที่เป็นตัวเลข (ข้อความไม่นับเป็น eligible)
    expect(oct.eligible).toBe(EXPECT_WITH - 1);
    expect(oct.passed).toBe(EXPECT_PASS);
});

test('PUT /indicators รับเงื่อนไข GT/LT และค่าที่ไม่รู้จักเก็บเป็นว่าง', async () => {
    const id = created[0];
    const [[cur]] = await db.query('SELECT * FROM kpi_indicators WHERE id = ?', [id]);
    const body = { ...cur, target_condition: 'lt' };
    let res = await request(app).put(api(`/indicators/${id}`)).set('Authorization', `Bearer ${saToken}`).send(body);
    expect(res.status).toBe(200);
    expect((await db.query('SELECT target_condition FROM kpi_indicators WHERE id = ?', [id]))[0][0].target_condition).toBe('LT');
    res = await request(app).put(api(`/indicators/${id}`)).set('Authorization', `Bearer ${saToken}`).send({ ...body, target_condition: 'ABC' });
    expect(res.status).toBe(200);
    expect((await db.query('SELECT target_condition FROM kpi_indicators WHERE id = ?', [id]))[0][0].target_condition).toBeNull();
    await db.query("UPDATE kpi_indicators SET target_condition = 'LTE' WHERE id = ?", [id]);
});

test('GET /kpi-results ส่ง target_condition ให้หน้าบันทึกผลงาน (เดิมไม่ได้ส่ง → ร้อยละคิดแบบ ≥ เสมอ)', async () => {
    const [[u]] = await db.query("SELECT id FROM users WHERE username = 'test_tc_sa'");
    const id = created[1]; // LTE
    await db.query("INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, user_id, status) VALUES (?,?,?,10,'8','10',?,'Pending')", [id, YEAR, hospA, u.id]);
    try {
        const b = await get(`/kpi-results?year=${YEAR}&hospcode=${hospA}`);
        const row = (b.data || b).find(r => Number(r.indicator_id) === id);
        expect(row).toBeDefined();
        expect(row.target_condition).toBe('LTE');
        expect(evaluateTarget(row.last_actual, row.target_value, row.target_condition)).toEqual({ pct: 80, pass: false });
    } finally {
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ?', [id, YEAR]);
    }
});
