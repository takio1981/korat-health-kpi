/**
 * Integration tests: ค่าเพิ่มเติมที่ตั้งชื่อเอง (kpi_indicators.custom_vars) + สูตรร้อยละ (pct_formula) — 25 ต.ค. 2569 — database ทดสอบ
 *   ตัวอย่าง: อัตราผู้เสียชีวิตต่อแสนประชากร — ประกาศค่า pop (ประชากร) รายหน่วยบริการ สูตรผลงาน SUM(ALL) / pop * 100000
 *   - ประกาศ/ตรวจชื่อค่าเพิ่มเติม, สูตรอ้างชื่อที่ไม่ได้ประกาศ = 400, สูตรร้อยละใช้ result ได้
 *   - บันทึกค่า cv_<key> ผ่าน /update-kpi (ชื่อที่ไม่ได้ประกาศ = ข้าม), GET /kpi-results แนบ cv_<key>, summary ใช้ค่าเพิ่มเติม
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2510';
let app, db, summaryRefreshIdle, saToken, deptId, hosp, indId;
const api = (p) => '/khupskpi/api' + p;
const asSa = (r) => r.set('Authorization', `Bearer ${saToken}`);
const BODY = {
    kpi_indicators_name: 'test_cvars_rate', is_active: 1, target_percentage: '5.5', criterion: '5.5', target_condition: 'LTE',
    custom_vars: [{ key: 'pop', label: 'ประชากรกลางปี' }],
    result_formula: 'SUM(ALL) / pop * 100000',
    pct_formula: '(target - result) / target * 100 + 100',
};

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady, summaryRefreshIdle } = require('../server'));
    await migrationsReady;
    db = require('../db');
    for (let i = 0; i < 90; i++) {   // ALTER ของคอลัมน์ใหม่อยู่ท้าย chain startup
        const [c] = await db.query("SHOW COLUMNS FROM kpi_indicators LIKE 'pct_formula'");
        const [v] = await db.query("SHOW COLUMNS FROM kpi_base_values LIKE 'var_key'");
        if (c.length && v.length) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query("SELECT hoscode FROM chospital WHERE hostype = '02' ORDER BY hoscode LIMIT 1");
    deptId = d.id; hosp = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_cvars_sa', role: 'super_admin', session_id: 'sess-cv-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-cv-sa' });
});

afterAll(async () => {
    await summaryRefreshIdle();
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    if (indId) {
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
    }
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test_cvars_%'");
    await cleanupTestUsers(db);
});

test('ตรวจชื่อค่าเพิ่มเติมและสูตร: ไม่ได้ประกาศ / ชื่อสงวน / ซ้ำ / สูตรร้อยละอ้างชื่อผิด = 400', async () => {
    const post = (b) => asSa(request(app).post(api('/indicators'))).send({ ...BODY, dept_id: deptId, ...b, kpi_indicators_name: 'test_cvars_bad' });
    expect((await post({ custom_vars: [] })).status).toBe(400);                                    // สูตรใช้ pop แต่ไม่ได้ประกาศ
    expect((await post({ custom_vars: [{ key: 'result', label: 'x' }] })).status).toBe(400);       // ชื่อสงวน
    expect((await post({ custom_vars: [{ key: 'pop' }, { key: 'pop' }] })).status).toBe(400);     // ซ้ำ
    expect((await post({ custom_vars: [{ key: 'Pop-1' }] })).status).toBe(400);                   // รูปแบบผิด
    expect((await post({ pct_formula: 'result / popx * 100' })).status).toBe(400);               // สูตรร้อยละอ้างชื่อที่ไม่ได้ประกาศ
    expect((await post({ result_formula: 'result + 1' })).status).toBe(400);                      // result ใช้ได้เฉพาะสูตรร้อยละ
});

test('สร้างตัวชี้วัดที่มีค่าเพิ่มเติม + สูตรร้อยละ → GET /indicators คืนค่าที่บันทึก', async () => {
    const res = await asSa(request(app).post(api('/indicators'))).send({ ...BODY, dept_id: deptId });
    expect(res.status).toBe(200);
    indId = res.body.id;
    const [[row]] = await db.query('SELECT custom_vars, pct_formula, result_formula FROM kpi_indicators WHERE id = ?', [indId]);
    expect(JSON.parse(row.custom_vars)).toEqual([{ key: 'pop', label: 'ประชากรกลางปี' }]);
    expect(row.pct_formula).toBe(BODY.pct_formula);
});

test('บันทึกค่า cv_pop รายหน่วยบริการ → ผลงานตามสูตร (3 ราย ÷ 25,000 × 100,000 = 12) + ชื่อที่ไม่ได้ประกาศถูกข้าม', async () => {
    const res = await asSa(request(app).post(api('/update-kpi'))).send({ updates: [{ indicator_id: indId, year_bh: YEAR, hospcode: hosp, target_value: '5.5', oct: '3', cv_pop: '25000', cv_hack: '1' }] });
    expect(res.status).toBe(200);
    const [vals] = await db.query('SELECT var_key, base_value FROM kpi_base_values WHERE indicator_id = ? ORDER BY var_key', [indId]);
    expect(vals.map(v => [v.var_key, v.base_value])).toEqual([['pop', '25000']]);
    const list = (await asSa(request(app).get(api(`/kpi-results?year=${YEAR}&hospcode=${hosp}`)))).body.data;
    const r = list.find(x => Number(x.indicator_id) === indId);
    expect(r.cv_pop).toBe('25000');
    expect(r.cv_base).toBeNull();          // base ใช้ได้เสมอ (ยังไม่มีค่า)
    expect(r.last_actual).toBe('12');
    expect(r.pct_formula).toBe(BODY.pct_formula);
    expect(JSON.parse(r.custom_vars)[0].key).toBe('pop');
    await summaryRefreshIdle();
    const [[s]] = await db.query('SELECT last_actual FROM kpi_summary WHERE indicator_id = ? AND year_bh = ?', [indId, YEAR]);
    expect(s.last_actual).toBe('12');
});

test('PUT ไม่ส่ง custom_vars = คงค่าเดิม / ลบ pop ทั้งที่สูตรยังใช้ = 400', async () => {
    const [[cur]] = await db.query('SELECT * FROM kpi_indicators WHERE id = ?', [indId]);
    const body = { ...cur };
    delete body.custom_vars; delete body.pct_formula;
    expect((await asSa(request(app).put(api(`/indicators/${indId}`))).send(body)).status).toBe(200);
    const [[after]] = await db.query('SELECT custom_vars, pct_formula FROM kpi_indicators WHERE id = ?', [indId]);
    expect(JSON.parse(after.custom_vars)[0].key).toBe('pop');
    expect(after.pct_formula).toBe(BODY.pct_formula);
    expect((await asSa(request(app).put(api(`/indicators/${indId}`))).send({ ...body, custom_vars: [] })).status).toBe(400);
});
