/**
 * Integration tests: ค่าฐาน (base) ของสูตรคำนวณผลงาน — ตาราง kpi_base_values (24 ต.ค. 2569) — database ทดสอบ
 *   ตัวอย่างจริง: ตัวชี้วัดการเสียชีวิตจากการจมน้ำ — ผลงาน = ร้อยละการลดลงเทียบค่าเฉลี่ย 5 ปีของแต่ละอำเภอ
 *   สูตร (base - SUM(ALL)) / base * 100, เป้าหมาย 30 เงื่อนไข ≥
 *   - บันทึก/อ่านค่าฐานผ่าน /update-kpi + GET /kpi-results (แนบ base_value), summary/รายงาน/Export ใช้ค่าฐาน
 *   - ล็อคแล้วแก้ไม่ได้, ผู้ใช้ไม่มีสิทธิ์แก้เป้าหมาย = แก้ค่าฐานไม่ได้, ส่งค่าว่าง = ลบ
 *   - ผลงาน 0 (ไม่มีผู้เสียชีวิต) นับเป็นผลงานจริงในตารางสรุป (เดิมคู่ที่บันทึก 0 ทั้งปีหายจากรายงาน)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2509';
const FORMULA = '(base - SUM(ALL)) / base * 100';
let app, db, summaryRefreshIdle, saToken, userToken, userId, deptId, hospA, hospB, indId;
const api = (p) => '/khupskpi/api' + p;
const asSa = (r) => r.set('Authorization', `Bearer ${saToken}`);
const asUser = (r) => r.set('Authorization', `Bearer ${userToken}`);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady, summaryRefreshIdle } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const hs = (await db.query("SELECT hoscode FROM chospital WHERE hostype = '02' ORDER BY hoscode LIMIT 2"))[0];
    deptId = d.id; hospA = hs[0].hoscode; hospB = hs[1].hoscode;
    const sa = await ensureTestUser(db, { username: 'test_base_sa', role: 'super_admin', session_id: 'sess-base-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-base-sa' });
    const u = await ensureTestUser(db, { username: 'test_base_hos', role: 'user_hos', dept_id: deptId, hospcode: hospA, session_id: 'sess-base-hos' });
    userId = u.id;
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hospA, sessionId: 'sess-base-hos' });
    const res = await asSa(request(app).post(api('/indicators'))).send({
        kpi_indicators_name: 'test_base_drowning', dept_id: deptId, is_active: 1, result_formula: FORMULA,
        target_percentage: '30', criterion: '30', target_condition: 'GTE', evaluation_mode: 'any_one', required_off_types: ['02'],
    });
    expect(res.status).toBe(200);
    indId = res.body.id;
});

afterAll(async () => {
    await summaryRefreshIdle();
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
    await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]); // kpi_base_values ลบตาม (CASCADE)
    await cleanupTestUsers(db);
});

const saveAs = (who, hospcode, fields) => who(request(app).post(api('/update-kpi')))
    .send({ updates: [{ indicator_id: indId, year_bh: YEAR, hospcode, target_value: '30', ...fields }] });
const row = async (hospcode, who = asSa) => {
    const res = await who(request(app).get(api(`/kpi-results?year=${YEAR}&hospcode=${hospcode}`)));
    expect(res.status).toBe(200);
    return res.body.data.find(r => Number(r.indicator_id) === indId && r.hospcode === hospcode);
};
const baseOf = async (hospcode) => {
    const [r] = await db.query('SELECT base_value FROM kpi_base_values WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [indId, YEAR, hospcode]);
    return r[0] ? r[0].base_value : undefined;
};

test('บันทึกค่าฐาน + ผลงาน → ร้อยละการลดลงตรงตาราง (ขามทะเลสอ 4.6 → 1 ราย = 78.26) และไม่มีผู้เสียชีวิต (0) = 100', async () => {
    expect((await saveAs(asSa, hospA, { base_value: '4.6', oct: '1' })).status).toBe(200);
    expect((await saveAs(asSa, hospB, { base_value: '21.2', oct: '0' })).status).toBe(200);
    expect(await baseOf(hospA)).toBe('4.6');
    const a = await row(hospA);
    expect(a.base_value).toBe('4.6');
    expect(a.last_actual).toBe('78.26');
    expect((await row(hospB)).last_actual).toBe('100');
});

test('ตารางสรุป/รายงานใช้ค่าฐาน และนับคู่ที่บันทึก 0 (ไม่มีผู้เสียชีวิต) ด้วย', async () => {
    await summaryRefreshIdle();
    const [s] = await db.query('SELECT hospcode, last_actual FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? ORDER BY hospcode', [indId, YEAR]);
    expect(Object.fromEntries(s.map(r => [r.hospcode, r.last_actual]))).toEqual({ [hospA]: '78.26', [hospB]: '100' });
    const rep = (await asSa(request(app).get(api(`/report/by-indicator?year_bh=${YEAR}`)))).body.data.find(r => Number(r.indicator_id) === indId);
    expect([Number(rep.hospitals_with_target), Number(rep.hospitals_passed)]).toEqual([2, 2]);
});

test('Export ใช้ค่าฐาน (ผลงาน result ตรงหน้าบันทึกผลงาน)', async () => {
    const tp = 'test_base_exp_' + Date.now();
    await db.query('UPDATE kpi_indicators SET table_process = ? WHERE id = ?', [tp, indId]);
    try {
        const chk = await asSa(request(app).post(api('/check-kpi-export'))).send({ year_bh: YEAR, indicator_ids: [indId] });
        expect(chk.status).toBe(200);
        const exp = await asSa(request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: [indId] });
        expect(exp.status).toBe(200);
        // Export ส่งครบทุกหน่วยบริการตามขอบเขต (หน่วยที่ยังไม่บันทึก result ว่าง) — ตรวจเฉพาะ 2 หน่วยที่บันทึก
        const [rs] = await db.query(`SELECT hospcode, result FROM \`${tp}\` WHERE byear = ? AND hospcode IN (?, ?) ORDER BY hospcode`, [YEAR, hospA, hospB]);
        expect(Object.fromEntries(rs.map(r => [r.hospcode, Number(r.result)]))).toEqual({ [hospA]: 78.26, [hospB]: 100 });
    } finally {
        await db.query(`DROP TABLE IF EXISTS \`${tp}\``).catch(() => {});
    }
});

test('ผู้ใช้ไม่มีสิทธิ์แก้เป้าหมาย → แก้ค่าฐานไม่ได้ (ค่าเดิมคงอยู่)', async () => {
    await db.query('UPDATE users SET can_edit_target = 0 WHERE id = ?', [userId]);
    try {
        const res = await saveAs(asUser, hospA, { base_value: '99', oct: '1' });
        expect(res.status).toBe(200);
        expect(await baseOf(hospA)).toBe('4.6');
    } finally {
        await db.query('UPDATE users SET can_edit_target = NULL WHERE id = ?', [userId]);
    }
});

test('ล็อคแล้วแก้ค่าฐานไม่ได้ / ส่งค่าว่าง = ลบค่าฐาน → ผลงานว่าง', async () => {
    await db.query('UPDATE kpi_results SET is_locked = 1 WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [indId, YEAR, hospA]);
    const locked = await saveAs(asUser, hospA, { base_value: '10', oct: '1' });
    expect(locked.status).toBe(500);
    expect(await baseOf(hospA)).toBe('4.6');
    await db.query('UPDATE kpi_results SET is_locked = 0 WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [indId, YEAR, hospA]);
    expect((await saveAs(asSa, hospA, { base_value: '', oct: '1' })).status).toBe(200);
    expect(await baseOf(hospA)).toBeUndefined();
    expect((await row(hospA)).last_actual).toBeNull();
});

test('ไม่ส่ง base_value (ผู้เรียกเดิม) → ค่าฐานเดิมไม่เปลี่ยน', async () => {
    expect((await saveAs(asSa, hospB, { oct: '2' })).status).toBe(200);
    expect(await baseOf(hospB)).toBe('21.2');
    expect((await row(hospB)).last_actual).toBe('90.57'); // (21.2 - 2) / 21.2
});
