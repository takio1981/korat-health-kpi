/**
 * Integration tests: ตัวชี้วัดวัดผลรายไตรมาส (kpi_indicators.quarter_mode — 10 พ.ย. 2569) — database ทดสอบ
 *   ผู้ใช้เลือก: ผู้ดูแลตั้งต่อตัวชี้วัด, บันทึกรายไตรมาส = เก็บที่เดือนสุดท้ายของไตรมาส (ธ.ค./มี.ค./มิ.ย./ก.ย.),
 *   บันทึกรายเดือน = ค่าไตรมาสตามที่ตั้ง (รวม/เดือนสุดท้าย/เฉลี่ย), ส่งออกคงคอลัมน์ m10–m09 เดิม
 *   - POST/PUT /indicators รับ quarter_mode (ค่าที่ไม่รู้จัก = รายเดือน, PUT ไม่ส่ง = คงค่าเดิม)
 *   - /update-kpi: โหมด 'quarter' บันทึกเดือนกลางไตรมาสไม่ได้ (400) แต่คงค่าเดิม/ล้างค่าได้
 *   - ผลงาน "ค่าไตรมาสล่าสุด" = สูตร LASTQ(SUM) → GET /kpi-results และ kpi_summary ตรงกัน
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2513';
let app, db, summaryRefreshIdle, saToken, userToken, deptId, hosp, qId, mId, qSubId, qActId, mSubId;
const api = (p) => '/khupskpi/api' + p;
const as = (t) => (r) => r.set('Authorization', `Bearer ${t}`);
const save = (row) => as(userToken)(request(app).post(api('/update-kpi'))).send({ updates: [{ year_bh: YEAR, target_value: '10', ...row }] });
const listRow = async (id) => (await as(userToken)(request(app).get(api(`/kpi-results?year=${YEAR}`)))).body.data.find(x => Number(x.indicator_id) === id);
const actuals = async (id) => Object.fromEntries((await db.query('SELECT month_bh, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [id, YEAR, hosp]))[0]
    .map(r => [String(r.month_bh), r.actual_value]));

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady, summaryRefreshIdle } = require('../server'));
    await migrationsReady;
    db = require('../db');
    for (let i = 0; i < 90; i++) {
        const [c] = await db.query("SHOW COLUMNS FROM kpi_indicators LIKE 'quarter_mode'");
        if (c.length) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE ?', ['test_quarter_%']);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [hs] = await db.query("SELECT hoscode FROM chospital WHERE hostype = '07' ORDER BY hoscode LIMIT 1");
    deptId = d.id; hosp = hs[0].hoscode;
    const sa = await ensureTestUser(db, { username: 'test_quarter_sa', role: 'super_admin', session_id: 'sess-q-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-q-sa' });
    const u = await ensureTestUser(db, { username: 'test_quarter_user', role: 'user_hos', dept_id: deptId, hospcode: hosp, session_id: 'sess-q-u' });
    await db.query('UPDATE users SET can_edit_actual = 1, can_edit_target = 1 WHERE id = ?', [u.id]);
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hosp, sessionId: 'sess-q-u' });
});

afterAll(async () => {
    await summaryRefreshIdle();
    for (const id of [qSubId, mSubId].filter(Boolean)) await db.query('DELETE FROM kpi_sub_results WHERE sub_indicator_id = ?', [id]);
    if (qActId) await db.query('DELETE FROM kpi_activity_results WHERE activity_id = ?', [qActId]);
    if (qActId) await db.query('DELETE FROM kpi_sub_activities WHERE id = ?', [qActId]);
    for (const id of [qSubId, mSubId].filter(Boolean)) await db.query('DELETE FROM kpi_sub_indicators WHERE id = ?', [id]);
    for (const id of [qId, mId].filter(Boolean)) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
    }
    await cleanupTestUsers(db);
});

test('ตั้งรอบการวัดผลในตัวชี้วัด — ค่าที่ไม่รู้จัก = รายเดือน, PUT ไม่ส่ง = คงค่าเดิม', async () => {
    const base = { dept_id: deptId, is_active: 1, target_percentage: '10', evaluation_mode: 'any_one', required_off_types: ['07'] };
    const q = await as(saToken)(request(app).post(api('/indicators'))).send({ ...base, kpi_indicators_name: 'test_quarter_entry', quarter_mode: 'quarter' });
    expect(q.status).toBe(200);
    qId = q.body.id;
    const m = await as(saToken)(request(app).post(api('/indicators'))).send({ ...base, kpi_indicators_name: 'test_quarter_month', quarter_mode: 'xyz' });
    mId = m.body.id;
    const [rows] = await db.query('SELECT quarter_mode FROM kpi_indicators WHERE id IN (?) ORDER BY id', [[qId, mId]]);
    expect(rows.map(r => r.quarter_mode)).toEqual(['quarter', null]);

    // ตั้งเป็นบันทึกรายเดือน ค่าไตรมาส = รวม 3 เดือน + ผลงาน = ค่าไตรมาสล่าสุด (LASTQ(SUM))
    const put = await as(saToken)(request(app).put(api(`/indicators/${mId}`))).send({ ...base, kpi_indicators_name: 'test_quarter_month', quarter_mode: 'MONTH_SUM', result_formula: 'LASTQ(SUM)' });
    expect(put.status).toBe(200);
    await as(saToken)(request(app).put(api(`/indicators/${mId}`))).send({ ...base, kpi_indicators_name: 'test_quarter_month', result_formula: 'LASTQ(SUM)' });
    const [[r2]] = await db.query('SELECT quarter_mode, result_formula FROM kpi_indicators WHERE id = ?', [mId]);
    expect(r2).toEqual({ quarter_mode: 'month_sum', result_formula: 'LASTQ(SUM)' });
    // สูตร LASTQ ผิดรูป = 400
    const bad = await as(saToken)(request(app).put(api(`/indicators/${mId}`))).send({ ...base, kpi_indicators_name: 'test_quarter_month', result_formula: 'LASTQ(MAX)' });
    expect(bad.status).toBe(400);
});

test('บันทึกรายไตรมาส: กรอกเดือนสุดท้ายของไตรมาสได้ เดือนกลางไตรมาส = 400 (ไม่บันทึกบางส่วน)', async () => {
    const ok = await save({ indicator_id: qId, dece: '5', mar: '8' });
    expect(ok.status).toBe(200);
    expect(await actuals(qId)).toMatchObject({ 12: '5', 3: '8' });

    const bad = await save({ indicator_id: qId, dece: '5', mar: '9', nov: '2' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/รายไตรมาส/);
    expect((await actuals(qId))[3]).toBe('8');   // ไม่บันทึกบางส่วน

    const row = await listRow(qId);
    expect(row.quarter_mode).toBe('quarter');
    expect(row.last_actual).toBe('8');   // ผลงานล่าสุด = ไตรมาสล่าสุด (มี.ค.)
});

test('บันทึกรายไตรมาส: ค่าเดิมในเดือนกลางไตรมาส (ก่อนเปลี่ยนโหมด) ส่งค่าเดิมกลับได้ และล้างได้', async () => {
    await db.query("UPDATE kpi_results SET actual_value = '3' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = 11", [qId, YEAR, hosp]);
    const keep = await save({ indicator_id: qId, nov: '3', dece: '5', mar: '8' });
    expect(keep.status).toBe(200);
    expect((await actuals(qId))[11]).toBe('3');
    const clear = await save({ indicator_id: qId, nov: '', dece: '5', mar: '8' });
    expect(clear.status).toBe(200);
    expect((await actuals(qId))[11] || '').toBe('');
});

test('บันทึกรายเดือน + ค่าไตรมาสล่าสุด (รวม 3 เดือน): ผลงานหน้าบันทึกผลงาน = ตารางสรุป', async () => {
    const res = await save({ indicator_id: mId, oct: '1', nov: '2', dece: '3', jan: '10', mar: '20' });
    expect(res.status).toBe(200);
    const row = await listRow(mId);
    expect(row.quarter_mode).toBe('month_sum');
    expect(row.last_actual).toBe('30');   // ไตรมาส 2 = 10 + 20
    await summaryRefreshIdle();
    const [[s]] = await db.query('SELECT last_actual FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [mId, YEAR, hosp]);
    expect(s.last_actual).toBe('30');
});


// ===== ข้อย่อย/กิจกรรม + kpi-setup (11 พ.ย. 2569) — ใช้รอบการวัดผลของตัวชี้วัดหลัก =====
const subVal = async (table, col, id, m) => (await db.query(`SELECT actual_value AS v FROM ${table} WHERE ${col} = ? AND year_bh = ? AND hospcode = ? AND month_bh = ?`, [id, YEAR, hosp, m]))[0][0]?.v;

test('ข้อย่อย/กิจกรรมของตัวชี้วัดบันทึกรายไตรมาส: บันทึกได้เฉพาะเดือนสุดท้ายของไตรมาส (หน้าต่างแถวลูก + บันทึกผลงานย่อย)', async () => {
    qSubId = (await db.query("INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, is_active, rollup_mode, sort_order) VALUES (?, 'test_quarter_sub', 1, 'manual', 1)", [qId]))[0].insertId;
    qActId = (await db.query("INSERT INTO kpi_sub_activities (sub_indicator_id, activity_name, value_type, is_active) VALUES (?, 'test_quarter_act', 'number', 1)", [qSubId]))[0].insertId;
    mSubId = (await db.query("INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, is_active, rollup_mode, sort_order) VALUES (?, 'test_quarter_msub', 1, 'manual', 1)", [mId]))[0].insertId;

    const h = await as(userToken)(request(app).get(api(`/hierarchy-results?indicator_id=${qId}&year_bh=${YEAR}&hospcode=${hosp}`)));
    expect(h.status).toBe(200);
    expect(h.body.data.quarter_mode).toBe('quarter');

    const hsave = (body) => as(userToken)(request(app).post(api('/hierarchy-results/save'))).send({ year_bh: YEAR, hospcode: hosp, ...body });
    const ok = await hsave({ sub: [{ sub_indicator_id: qSubId, month_bh: 12, actual_value: '4' }], activity: [{ activity_id: qActId, month_bh: 3, actual_value: '7' }] });
    expect(ok.status).toBe(200);
    expect(await subVal('kpi_sub_results', 'sub_indicator_id', qSubId, 12)).toBe('4');
    expect(await subVal('kpi_activity_results', 'activity_id', qActId, 3)).toBe('7');

    // เดือนกลางไตรมาส = 400 ทั้งคำขอ (ช่อง มิ.ย. ที่ถูกต้องในคำขอเดียวกันไม่ถูกบันทึก)
    const bad = await hsave({ sub: [{ sub_indicator_id: qSubId, month_bh: 6, actual_value: '9' }], activity: [{ activity_id: qActId, month_bh: 11, actual_value: '1' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('QUARTER_ENTRY_ONLY');
    expect(await subVal('kpi_sub_results', 'sub_indicator_id', qSubId, 6)).toBeUndefined();

    // หน้าต่างบันทึกผลงานย่อย (/sub-results/upsert)
    const up = (id, m, v) => as(userToken)(request(app).post(api('/sub-results/upsert'))).send({ sub_indicator_id: id, year_bh: YEAR, hospcode: hosp, month_bh: m, actual_value: v });
    const upBad = await up(qSubId, 11, '2');
    expect(upBad.status).toBe(400);
    expect(upBad.body.code).toBe('QUARTER_ENTRY_ONLY');
    expect((await up(qSubId, 11, '')).status).toBe(200);       // ค่าว่าง/ล้างค่าได้
    expect((await up(qSubId, 9, '5')).status).toBe(200);
    expect(await subVal('kpi_sub_results', 'sub_indicator_id', qSubId, 9)).toBe('5');
    // ตัวชี้วัดบันทึกรายเดือน (month_sum) — ข้อย่อยบันทึกได้ทุกเดือน
    expect((await up(mSubId, 11, '2')).status).toBe(200);
});

test('kpi-setup (setup_overwrite / setup_insert_new): ตัวชี้วัดบันทึกรายไตรมาส เดือนกลางไตรมาสเป็นค่าว่าง ไม่เก็บ 0', async () => {
    const SY = '2514';
    const zeros = { oct: 0, nov: 0, dece: 0, jan: 0, feb: 0, mar: 0, apr: 0, may: 0, jun: 0, jul: 0, aug: 0, sep: 0 };
    const send = (mode) => as(saToken)(request(app).post(api('/update-kpi'))).send({ mode, updates: [
        { indicator_id: qId, year_bh: SY, hospcode: hosp, target_value: '10', ...zeros, dece: 3 },
        { indicator_id: mId, year_bh: SY, hospcode: hosp, target_value: '10', ...zeros }] });
    const val = async (id, m) => (await db.query('SELECT actual_value AS v FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = ?', [id, SY, hosp, m]))[0][0]?.v;
    expect((await send('setup_overwrite')).status).toBe(200);
    expect(await val(qId, 11)).toBe('');
    expect(await val(qId, 12)).toBe('3');
    expect(await val(qId, 9)).toBe('0');
    expect(await val(mId, 11)).toBe('0');      // บันทึกรายเดือน = เหมือนเดิม
    await db.query('DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ?', [qId, SY]);
    expect((await send('setup_insert_new')).status).toBe(200);
    expect(await val(qId, 11)).toBe('');
    expect(await val(qId, 12)).toBe('3');
});

