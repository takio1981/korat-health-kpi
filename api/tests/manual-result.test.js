/**
 * Integration tests: ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569) — database ทดสอบ
 *   ผู้ใช้เลือก: ตั้งแยก 2 ตัวเลือกต่อตัวชี้วัด (result_manual / pct_manual), ผ่านเกณฑ์ = ร้อยละที่กรอก ≥ 100,
 *   ช่องรายเดือนยังกรอกได้แต่ไม่นำมาคำนวณ, ยังไม่กรอก = ว่าง (ไม่ใช้ค่าที่คำนวณแทน)
 *   - บันทึก manual_result / manual_pct ผ่าน /update-kpi (ตัวชี้วัดที่ไม่ได้ตั้งกรอกเอง = ข้าม, ร้อยละไม่ใช่ตัวเลข = 400, ไม่มีสิทธิ์ผลงาน = 403)
 *   - GET /kpi-results: last_actual = ผลงานที่กรอก | kpi_summary: last_actual + manual_pct | รายงาน: ผ่าน = ร้อยละที่กรอก ≥ 100
 *   - คู่ที่มีแต่ค่าที่กรอกเอง (ไม่มีผลงานรายเดือน) ขึ้นในตารางสรุป | Export: result = ผลงานที่กรอก | เปลี่ยนกลับเป็นคำนวณ → summary คำนวณตามเดิม
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2511';
const TP = 'kpi_tmanual_001';
let saId;
let app, db, summaryRefreshIdle, saToken, userToken, roToken, deptId, hosp, hosp2, indId, plainId;
const api = (p) => '/khupskpi/api' + p;
const as = (t) => (r) => r.set('Authorization', `Bearer ${t}`);
const MONTHS = ['10', '11', '12', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

async function seedPair(indicatorId, hc) {
    for (const m of MONTHS) {
        await db.query(`INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked)
                        VALUES (?,?,?,'', '80', ?, 'Pending', ?, 0)`, [indicatorId, YEAR, m, saId, hc]);
    }
}
const summaryRow = async (id, hc) => (await db.query('SELECT last_actual, manual_pct FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [id, YEAR, hc]))[0][0];
const reportRow = async () => ((await as(saToken)(request(app).get(api(`/report/by-indicator?year_bh=${YEAR}`)))).body.data || [])
    .find(r => Number(r.indicator_id) === indId);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady, summaryRefreshIdle } = require('../server'));
    await migrationsReady;
    db = require('../db');
    for (let i = 0; i < 90; i++) {
        const [c] = await db.query("SHOW COLUMNS FROM kpi_indicators LIKE 'pct_manual'");
        const [s] = await db.query("SHOW COLUMNS FROM kpi_summary LIKE 'manual_pct'");
        if (c.length && s.length) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_indicators WHERE table_process = ? OR kpi_indicators_name LIKE ?', [TP, 'test_tmanual_%']);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [hs] = await db.query("SELECT hoscode FROM chospital WHERE hostype = '07' ORDER BY hoscode LIMIT 2");
    deptId = d.id; hosp = hs[0].hoscode; hosp2 = hs[1].hoscode;
    const sa = await ensureTestUser(db, { username: 'test_tmanual_sa', role: 'super_admin', session_id: 'sess-tm-sa' });
    saId = sa.id;
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-tm-sa' });
    const u = await ensureTestUser(db, { username: 'test_tmanual_user', role: 'user_hos', dept_id: deptId, hospcode: hosp, session_id: 'sess-tm-u' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hosp, sessionId: 'sess-tm-u' });
    const ro = await ensureTestUser(db, { username: 'test_tmanual_ro', role: 'user_hos', dept_id: deptId, hospcode: hosp, session_id: 'sess-tm-ro' });
    await db.query('UPDATE users SET can_edit_actual = 0 WHERE id = ?', [ro.id]);
    roToken = makeToken({ userId: ro.id, username: ro.username, role: 'user_hos', deptId, hospcode: hosp, sessionId: 'sess-tm-ro' });
});

afterAll(async () => {
    await summaryRefreshIdle();
    for (const id of [indId, plainId].filter(Boolean)) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_base_values WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
    }
    await db.query(`DROP TABLE IF EXISTS \`${TP}\``);
    await cleanupTestUsers(db);
});

test('สร้างตัวชี้วัดแบบกรอกผลงานล่าสุดและร้อยละเอง → บันทึกการตั้งค่า', async () => {
    const res = await as(saToken)(request(app).post(api('/indicators'))).send({
        kpi_indicators_name: 'test_tmanual_ind', dept_id: deptId, is_active: 1, table_process: TP,
        target_percentage: '80', criterion: '80', target_condition: 'GTE', evaluation_mode: 'any_one', required_off_types: ['07'],
        result_manual: 1, pct_manual: 1,
    });
    expect(res.status).toBe(200);
    indId = res.body.id;
    const [[row]] = await db.query('SELECT result_manual, pct_manual FROM kpi_indicators WHERE id = ?', [indId]);
    expect([Number(row.result_manual), Number(row.pct_manual)]).toEqual([1, 1]);
    const p = await as(saToken)(request(app).post(api('/indicators'))).send({ kpi_indicators_name: 'test_tmanual_plain', dept_id: deptId, is_active: 1, target_percentage: '80' });
    plainId = p.body.id;
    await seedPair(indId, hosp);
    await seedPair(indId, hosp2);
    await seedPair(plainId, hosp);
});

test('บันทึกผลงานรายเดือน + ผลงานล่าสุด/ร้อยละที่กรอกเอง → ใช้ค่าที่กรอก ไม่คำนวณ (เดือนสุดท้าย 90 ÷ 80 ไม่ถูกใช้)', async () => {
    const res = await as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [
        { indicator_id: indId, year_bh: YEAR, target_value: '80', oct: '70', nov: '90', manual_result: '65', manual_pct: '95.5' },
        { indicator_id: plainId, year_bh: YEAR, target_value: '80', oct: '50', manual_result: '999', manual_pct: '1' },   // ตัวชี้วัดปกติ → ข้ามค่าที่กรอกเอง
    ] });
    expect(res.status).toBe(200);
    const [vals] = await db.query("SELECT indicator_id, var_key, base_value FROM kpi_base_values WHERE indicator_id IN (?) ORDER BY indicator_id, var_key", [[indId, plainId]]);
    expect(vals.map(v => [Number(v.indicator_id), v.var_key, v.base_value])).toEqual([[indId, '__pct', '95.5'], [indId, '__result', '65']]);
    const list = (await as(userToken)(request(app).get(api(`/kpi-results?year=${YEAR}`)))).body.data;
    const r = list.find(x => Number(x.indicator_id) === indId);
    expect(r.last_actual).toBe('65');
    expect(r.manual_result).toBe('65');
    expect(r.manual_pct).toBe('95.5');
    expect([Number(r.result_manual), Number(r.pct_manual)]).toEqual([1, 1]);
    const p = list.find(x => Number(x.indicator_id) === plainId);
    expect(p.last_actual).toBe('50');
    expect(p.manual_result).toBeUndefined();
});

test('ตารางสรุป + รายงาน: ผ่านเกณฑ์ = ร้อยละที่กรอก ≥ 100 (95.5 = ไม่ผ่าน แม้ผลงาน 65 ไม่ถึงเป้าก็ไม่ใช่เหตุ)', async () => {
    await summaryRefreshIdle();
    expect(await summaryRow(indId, hosp)).toEqual({ last_actual: '65', manual_pct: '95.5' });
    let rep = await reportRow();
    expect([Number(rep.hospitals_with_target), Number(rep.hospitals_passed)]).toEqual([1, 0]);   // hosp2 ยังไม่มีแถว (ไม่มีข้อมูล)
    // ร้อยละ 100 = ผ่าน แม้ผลงานที่กรอก (10) ต่ำกว่าเป้าหมาย (80) — ไม่คำนวณจากผลงาน/เป้าหมาย
    expect((await as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [{ indicator_id: indId, year_bh: YEAR, target_value: '80', oct: '70', nov: '90', manual_result: '10', manual_pct: '100' }] })).status).toBe(200);
    await summaryRefreshIdle();
    rep = await reportRow();
    expect([Number(rep.hospitals_with_target), Number(rep.hospitals_passed)]).toEqual([1, 1]);
});

test('คู่ที่มีแต่ค่าที่กรอกเอง (ไม่มีผลงานรายเดือน) ขึ้นในตารางสรุป / ล้างค่า = ว่าง ไม่ใช้ค่าที่คำนวณ', async () => {
    expect((await as(saToken)(request(app).post(api('/update-kpi'))).send({ updates: [{ indicator_id: indId, year_bh: YEAR, hospcode: hosp2, target_value: '80', manual_result: '40', manual_pct: '120' }] })).status).toBe(200);
    await summaryRefreshIdle();
    expect(await summaryRow(indId, hosp2)).toEqual({ last_actual: '40', manual_pct: '120' });
    // ล้างผลงาน/ร้อยละที่กรอก → ว่าง (ไม่ย้อนไปใช้ผลงานเดือนล่าสุด 90 / ร้อยละคำนวณ) และไม่นับว่ามีเป้าหมาย
    expect((await as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [{ indicator_id: indId, year_bh: YEAR, target_value: '80', oct: '70', nov: '90', manual_result: '', manual_pct: '' }] })).status).toBe(200);
    await summaryRefreshIdle();
    expect(await summaryRow(indId, hosp)).toEqual({ last_actual: null, manual_pct: '' });
    const r = (await as(userToken)(request(app).get(api(`/kpi-results?year=${YEAR}`)))).body.data.find(x => Number(x.indicator_id) === indId);
    expect(r.last_actual).toBeNull();
    const rep = await reportRow();
    expect([Number(rep.hospitals_with_target), Number(rep.hospitals_passed)]).toEqual([1, 1]);   // เหลือ hosp2 (120)
});

test('ร้อยละไม่ใช่ตัวเลข → 400 / ไม่มีสิทธิ์แก้ผลงาน → 403 และไม่บันทึก', async () => {
    let res = await as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [{ indicator_id: indId, year_bh: YEAR, target_value: '80', manual_pct: 'ดีมาก' }] });
    expect(res.status).toBe(400);
    res = await as(roToken)(request(app).post(api('/update-kpi'))).send({ updates: [{ indicator_id: indId, year_bh: YEAR, target_value: '80', manual_result: '77' }] });
    expect([403, 400]).toContain(res.status);
    const [v] = await db.query("SELECT base_value FROM kpi_base_values WHERE indicator_id = ? AND hospcode = ? AND var_key = '__result'", [indId, hosp]);
    expect(v.length).toBe(0);
});

test('Export: result = ผลงานที่กรอกเอง (ตรวจการเปลี่ยนแปลงตรงกับการส่งออก)', async () => {
    const ex = await as(saToken)(request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: [indId] });
    expect(ex.status).toBe(200);
    const [rows] = await db.query(`SELECT hospcode, result FROM \`${TP}\` WHERE byear = ? ORDER BY hospcode`, [YEAR]);
    const byHc = Object.fromEntries(rows.map(r => [r.hospcode, r.result == null ? null : String(Number(r.result))]));
    expect(byHc[hosp2]).toBe('40');
    expect(byHc[hosp]).toBeNull();
    const chk = await as(saToken)(request(app).post(api('/check-kpi-export'))).send({ year_bh: YEAR, indicator_ids: [indId] });
    const st = (chk.body.data || chk.body.results || []).find(x => Number(x.indicator_id || x.id) === indId);
    expect(st && st.status).not.toBe('has_changes');
});

test('เปลี่ยนกลับเป็นคำนวณ → ตารางสรุปคำนวณตามเดิม (manual_pct = NULL, ผลงานเดือนล่าสุด)', async () => {
    const [[cur]] = await db.query('SELECT * FROM kpi_indicators WHERE id = ?', [indId]);
    const res = await as(saToken)(request(app).put(api(`/indicators/${indId}`))).send({ ...cur, result_manual: 0, pct_manual: 0 });
    expect(res.status).toBe(200);
    await summaryRefreshIdle();
    expect(await summaryRow(indId, hosp)).toEqual({ last_actual: '90', manual_pct: null });
});
