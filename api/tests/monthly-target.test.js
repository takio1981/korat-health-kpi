/**
 * Integration tests: เป้าหมายรายเดือน (target_monthly — 29 ต.ค. 2569) — database ทดสอบ
 *   ผู้ใช้เลือก: กรอกเป้าหมายคู่กับผลงานในแต่ละเดือน, คอลัมน์เป้าหมาย = เป้าหมายรวม แบบ
 *   'latest' = เป้าหมายของเดือนเดียวกับผลงานล่าสุด / 'cumulative' = รวมเป้าหมายถึงเดือนของผลงานล่าสุด
 *   - /update-kpi รับ t_<เดือน> เฉพาะตัวชี้วัดที่ตั้งไว้ → kpi_results.target_value รายเดือน (ไม่มีสิทธิ์เป้าหมาย = คงค่าเดิม)
 *   - GET /kpi-results: target_value = เป้าหมายรวม + t_<เดือน> | kpi_summary.target_value / รายงาน / Export ใช้เป้าหมายรวมเดียวกัน
 *   - เปลี่ยนโหมด (ล่าสุด → สะสม) → ตารางสรุปคำนวณใหม่ทันที
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2512';
const TP = 'kpi_tmonthly_001';
let app, db, summaryRefreshIdle, saToken, userToken, roToken, deptId, hosp, indId, plainId;
const api = (p) => '/khupskpi/api' + p;
const as = (t) => (r) => r.set('Authorization', `Bearer ${t}`);
const T_KEYS = ['t_oct', 't_nov', 't_dece', 't_jan', 't_feb', 't_mar', 't_apr', 't_may', 't_jun', 't_jul', 't_aug', 't_sep'];
const monthTargets = (o) => Object.fromEntries(T_KEYS.map(k => [k, o[k] ?? '']));

const summaryRow = async (id) => (await db.query('SELECT target_value, last_actual FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [id, YEAR, hosp]))[0][0];
const listRow = async (id) => (await as(userToken)(request(app).get(api(`/kpi-results?year=${YEAR}`)))).body.data.find(x => Number(x.indicator_id) === id);
const reportRow = async () => ((await as(saToken)(request(app).get(api(`/report/by-indicator?year_bh=${YEAR}`)))).body.data || [])
    .find(r => Number(r.indicator_id) === indId);
const dbTargets = async () => Object.fromEntries((await db.query('SELECT month_bh, target_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [indId, YEAR, hosp]))[0]
    .map(r => [String(r.month_bh), r.target_value]));

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady, summaryRefreshIdle } = require('../server'));
    await migrationsReady;
    db = require('../db');
    for (let i = 0; i < 90; i++) {
        const [c] = await db.query("SHOW COLUMNS FROM kpi_indicators LIKE 'target_monthly'");
        if (c.length) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_indicators WHERE table_process = ? OR kpi_indicators_name LIKE ?', [TP, 'test_tmonthly_%']);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [hs] = await db.query("SELECT hoscode FROM chospital WHERE hostype = '07' ORDER BY hoscode LIMIT 1");
    deptId = d.id; hosp = hs[0].hoscode;
    const sa = await ensureTestUser(db, { username: 'test_tmonthly_sa', role: 'super_admin', session_id: 'sess-tmo-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-tmo-sa' });
    const u = await ensureTestUser(db, { username: 'test_tmonthly_user', role: 'user_hos', dept_id: deptId, hospcode: hosp, session_id: 'sess-tmo-u' });
    await db.query('UPDATE users SET can_edit_actual = 1, can_edit_target = 1 WHERE id = ?', [u.id]);
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hosp, sessionId: 'sess-tmo-u' });
    const ro = await ensureTestUser(db, { username: 'test_tmonthly_ro', role: 'user_hos', dept_id: deptId, hospcode: hosp, session_id: 'sess-tmo-ro' });
    await db.query('UPDATE users SET can_edit_actual = 1, can_edit_target = 0 WHERE id = ?', [ro.id]);
    roToken = makeToken({ userId: ro.id, username: ro.username, role: 'user_hos', deptId, hospcode: hosp, sessionId: 'sess-tmo-ro' });
});

afterAll(async () => {
    await summaryRefreshIdle();
    for (const id of [indId, plainId].filter(Boolean)) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
    }
    await db.query(`DROP TABLE IF EXISTS \`${TP}\``);
    await cleanupTestUsers(db);
});

test('ตั้งค่าเป้าหมายรายเดือนในตัวชี้วัด (ค่าที่ไม่รู้จัก = เป้าหมายเดียวทั้งปี)', async () => {
    const res = await as(saToken)(request(app).post(api('/indicators'))).send({
        kpi_indicators_name: 'test_tmonthly_ind', dept_id: deptId, is_active: 1, table_process: TP,
        target_percentage: '80', criterion: '80', target_condition: 'GTE', evaluation_mode: 'any_one', required_off_types: ['07'],
        target_monthly: 'latest',
    });
    expect(res.status).toBe(200);
    indId = res.body.id;
    const p = await as(saToken)(request(app).post(api('/indicators'))).send({ kpi_indicators_name: 'test_tmonthly_plain', dept_id: deptId, is_active: 1, target_percentage: '80', target_monthly: 'xyz' });
    plainId = p.body.id;
    const [rows] = await db.query('SELECT id, target_monthly FROM kpi_indicators WHERE id IN (?) ORDER BY id', [[indId, plainId]]);
    expect(rows.map(r => r.target_monthly)).toEqual(['latest', null]);
});

test('บันทึกเป้าหมายรายเดือนคู่กับผลงาน → เก็บรายเดือน, เป้าหมายรวม (ล่าสุด) = เป้าเดือนของผลงานล่าสุด', async () => {
    const res = await as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [
        { indicator_id: indId, year_bh: YEAR, target_value: '999', oct: '70', nov: '90', ...monthTargets({ t_oct: '80', t_nov: '100', t_dece: '120' }) },
        { indicator_id: plainId, year_bh: YEAR, target_value: '80', oct: '50', ...monthTargets({ t_oct: '1' }) },   // ตัวชี้วัดปกติ → ไม่ใช้ t_*
    ] });
    expect(res.status).toBe(200);
    const t = await dbTargets();
    expect([t['10'], t['11'], t['12'], t['1']]).toEqual(['80', '100', '120', '']);
    const [pt] = await db.query('SELECT DISTINCT target_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ?', [plainId, YEAR]);
    expect(pt.map(r => r.target_value)).toEqual(['80']);   // เป้าหมายเดียวทุกเดือนแบบเดิม
    const r = await listRow(indId);
    expect(r.target_value).toBe('100');
    expect([r.t_oct, r.t_nov, r.t_dece]).toEqual(['80', '100', '120']);
    const p = await listRow(plainId);
    expect(p.target_value).toBe('80');
    expect(p.t_oct).toBeUndefined();
});

test('ตารางสรุป + รายงาน ใช้เป้าหมายรวม (90 < 100 = ไม่ผ่าน) / เปลี่ยนเป็นสะสม → 80+100 = 180 ทันที', async () => {
    await summaryRefreshIdle();
    expect(await summaryRow(indId)).toEqual({ target_value: '100', last_actual: '90' });
    let rep = await reportRow();
    expect([Number(rep.hospitals_with_target), Number(rep.hospitals_passed)]).toEqual([1, 0]);
    // เดือนล่าสุดผ่าน (ผลงาน ธ.ค. 130 ≥ เป้า ธ.ค. 120)
    expect((await as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [
        { indicator_id: indId, year_bh: YEAR, target_value: '100', oct: '70', nov: '90', dece: '130', ...monthTargets({ t_oct: '80', t_nov: '100', t_dece: '120' }) },
    ] })).status).toBe(200);
    await summaryRefreshIdle();
    expect(await summaryRow(indId)).toEqual({ target_value: '120', last_actual: '130' });
    rep = await reportRow();
    expect(Number(rep.hospitals_passed)).toBe(1);
    // สะสม: เป้าถึงเดือนของผลงานล่าสุด (ธ.ค.) = 80+100+120 = 300 → ผลงาน 130 ไม่ผ่าน
    const [[cur]] = await db.query('SELECT * FROM kpi_indicators WHERE id = ?', [indId]);
    expect((await as(saToken)(request(app).put(api(`/indicators/${indId}`))).send({ ...cur, target_monthly: 'cumulative' })).status).toBe(200);
    await summaryRefreshIdle();
    expect(await summaryRow(indId)).toEqual({ target_value: '300', last_actual: '130' });
    expect((await listRow(indId)).target_value).toBe('300');
    rep = await reportRow();
    expect([Number(rep.hospitals_with_target), Number(rep.hospitals_passed)]).toEqual([1, 0]);
});

test('ไม่มีสิทธิ์แก้เป้าหมาย → เป้าหมายรายเดือนคงค่าเดิม (ผลงานยังบันทึกได้)', async () => {
    const res = await as(roToken)(request(app).post(api('/update-kpi'))).send({ updates: [
        { indicator_id: indId, year_bh: YEAR, target_value: '1', oct: '70', nov: '90', dece: '140', ...monthTargets({ t_oct: '1', t_nov: '1', t_dece: '1', t_jan: '1' }) },
    ] });
    expect(res.status).toBe(200);
    const t = await dbTargets();
    expect([t['10'], t['11'], t['12'], t['1']]).toEqual(['80', '100', '120', '']);
    const [[d]] = await db.query("SELECT actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = '12'", [indId, YEAR, hosp]);
    expect(d.actual_value).toBe('140');
});

test('บันทึกแถวที่ไม่ส่งเป้าหมายรายเดือน (เช่น แก้เป้าหมายรายข้อ) → คงเป้าหมายรายเดือนเดิม ไม่เขียนเป้าหมายรวมทับทุกเดือน', async () => {
    const res = await as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [
        { indicator_id: indId, year_bh: YEAR, target_value: '300', oct: '70', nov: '90', dece: '140' },
    ] });
    expect(res.status).toBe(200);
    const t = await dbTargets();
    expect([t['10'], t['11'], t['12'], t['1']]).toEqual(['80', '100', '120', '']);
});

test('Export: คอลัมน์ target = เป้าหมายรวม (ตรวจการเปลี่ยนแปลงตรงกับการส่งออก)', async () => {
    await summaryRefreshIdle();
    const ex = await as(saToken)(request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: [indId] });
    expect(ex.status).toBe(200);
    const [rows] = await db.query(`SELECT hospcode, target FROM \`${TP}\` WHERE byear = ? AND hospcode = ?`, [YEAR, hosp]);
    expect(String(Number(rows[0].target))).toBe('300');
    const chk = await as(saToken)(request(app).post(api('/check-kpi-export'))).send({ year_bh: YEAR, indicator_ids: [indId] });
    const st = (chk.body.data || chk.body.results || []).find(x => Number(x.indicator_id || x.id) === indId);
    expect(st && st.status).not.toBe('has_changes');
});
