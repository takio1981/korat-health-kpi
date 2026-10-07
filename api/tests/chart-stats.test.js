/**
 * Integration tests: GET /report/chart-stats (หน้ากราฟและสถิติ) — รันบน database ทดสอบ
 *   - ร้อยละผ่านเกณฑ์นับเป็นคู่ (ตัวชี้วัด × หน่วยบริการ) ไม่ SUM ค่าดิบข้ามตัวชี้วัด
 *   - แยกมิติ ยุทธศาสตร์ / หมวดหมู่ / หน่วยงาน / ตัวชี้วัด / อำเภอ / ประเภทหน่วยบริการ / รายเดือน ตรงกัน
 *   - รายเดือนไม่นับตัวชี้วัดสะสม/มีสูตร ในร้อยละผ่านรายเดือน
 *   - ไม่นับตัวชี้วัดที่ปิดใช้งาน, ตัวกรองทำงาน, ขอบเขต role (user_hos เห็นเฉพาะหน่วยบริการตัวเอง)
 * Regression (7 ต.ค. 2569): กราฟเดิมดึง /kpi-summary ที่จำกัด 500 แถว และรวมค่าดิบต่างหน่วยนับเข้าด้วยกัน
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2501'; // ปีแยกเฉพาะ test นี้ ไม่ปนข้อมูลชุดอื่น
let app, db, saToken, userToken, deptId, hospA, hospB;
const created = { indicators: [], mains: [], yuts: [] };
const api = (p) => '/khupskpi/api' + p;
const asSa = (r) => r.set('Authorization', `Bearer ${saToken}`);

async function addIndicator(name, mainId, extra = {}) {
    const [r] = await db.query(
        'INSERT INTO kpi_indicators (kpi_indicators_name, main_indicator_id, dept_id, is_active, is_cumulative, result_formula) VALUES (?,?,?,?,?,?)',
        [name, mainId, deptId, extra.is_active ?? 1, extra.is_cumulative ?? 0, extra.result_formula ?? null]);
    created.indicators.push(r.insertId);
    return r.insertId;
}
async function addSummary(indicatorId, hospcode, target, last, months = {}) {
    const [[h]] = await db.query('SELECT hosname, distid, hostype FROM chospital WHERE hoscode = ?', [hospcode]);
    await db.query(
        `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct, nov, dece)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [indicatorId, YEAR, hospcode, deptId, 'test_dept', h.hosname, h.distid, 'test_dist', h.hostype, target, last,
         months.oct ?? null, months.nov ?? null, months.dece ?? null]);
}

let yutId, mainX, mainY, ind1, ind2, ind3, indCum, indOff;

beforeAll(async () => {
    ({ app } = require('../server'));
    db = require('../db');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const hs = (await db.query('SELECT hoscode FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 2'))[0];
    deptId = d.id; hospA = hs[0].hoscode; hospB = hs[1].hoscode;
    const sa = await ensureTestUser(db, { username: 'test_chart_sa', role: 'super_admin', session_id: 'sess-c-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-c-sa' });
    const u = await ensureTestUser(db, { username: 'test_chart_hos', role: 'user_hos', dept_id: deptId, hospcode: hospA, session_id: 'sess-c-hos' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hospA, sessionId: 'sess-c-hos' });

    const [y] = await db.query("INSERT INTO main_yut (yut_name) VALUES ('test_chart_yut')"); yutId = y.insertId; created.yuts.push(yutId);
    const [mx] = await db.query('INSERT INTO kpi_main_indicators (main_indicator_name, yut_id) VALUES (?,?)', ['test_chart_main_X', yutId]); mainX = mx.insertId;
    const [my] = await db.query('INSERT INTO kpi_main_indicators (main_indicator_name, yut_id) VALUES (?,?)', ['test_chart_main_Y', yutId]); mainY = my.insertId;
    created.mains.push(mainX, mainY);

    // หน่วยนับต่างกันมาก (ราย vs ร้อยละ) — ถ้ารวมค่าดิบจะได้ผลผิด
    ind1 = await addIndicator('test_chart_ind1', mainX);
    ind2 = await addIndicator('test_chart_ind2', mainX);
    ind3 = await addIndicator('test_chart_ind3', mainY);
    indCum = await addIndicator('test_chart_cum', mainY, { is_cumulative: 1 });
    indOff = await addIndicator('test_chart_off', mainY, { is_active: 0 });

    await addSummary(ind1, hospA, '80', '90', { oct: '70', nov: '90' });      // ผ่าน (ต.ค. ไม่ผ่าน, พ.ย. ผ่าน)
    await addSummary(ind1, hospB, '80', '50', { oct: '50' });                 // ไม่ผ่าน
    await addSummary(ind2, hospA, '10000', '12000', { oct: '12000' });        // ผ่าน (ค่าดิบใหญ่)
    await addSummary(ind3, hospA, '', '5', { oct: '5' });                     // ไม่มีเป้าหมาย
    await addSummary(indCum, hospA, '100', '150', { oct: '60', nov: '90' });  // สะสม: ผ่าน (รายเดือนไม่นับ)
    await addSummary(indOff, hospA, '80', '10', { oct: '10' });               // ปิดใช้งาน: ไม่นับเลย
});

afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    if (created.indicators.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created.indicators]);
    if (created.mains.length) await db.query('DELETE FROM kpi_main_indicators WHERE id IN (?)', [created.mains]);
    if (created.yuts.length) await db.query('DELETE FROM main_yut WHERE id IN (?)', [created.yuts]);
    await cleanupTestUsers(db);
});

const get = async (qs = '', token = saToken) => {
    const res = await request(app).get(api(`/report/chart-stats?year_bh=${YEAR}${qs}`)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
};
const pick = (list, key) => list.find(r => Number(r.gkey) === Number(key));

describe('GET /report/chart-stats', () => {
    test('ภาพรวม: นับเป็นคู่ ผ่าน/ไม่ผ่าน/ไม่มีเป้าหมาย และไม่นับตัวที่ปิดใช้งาน', async () => {
        const b = await get(`&yut_id=${yutId}`);
        expect(b.overall).toMatchObject({ pairs: 5, with_target: 4, passed: 3, not_passed: 1, no_target: 1, indicator_count: 4 });
        expect(b.overall.achievement_pct).toBe(75);
        expect(b.by_indicator.map(r => Number(r.gkey))).not.toContain(indOff);
    });

    test('แยกตามหมวดหมู่ / ยุทธศาสตร์ / ตัวชี้วัด ตรงกับข้อมูล', async () => {
        const b = await get(`&yut_id=${yutId}`);
        expect(pick(b.by_main, mainX)).toMatchObject({ with_target: 3, passed: 2, achievement_pct: 66.67 });
        expect(pick(b.by_main, mainY)).toMatchObject({ with_target: 1, passed: 1, no_target: 1, achievement_pct: 100 });
        expect(pick(b.by_yut, yutId)).toMatchObject({ with_target: 4, passed: 3 });
        expect(pick(b.by_indicator, ind1)).toMatchObject({ with_target: 2, passed: 1, achievement_pct: 50 });
        expect(pick(b.by_indicator, ind2).achievement_pct).toBe(100); // ไม่ถูกค่าดิบ 12000 ถ่วง
        const sumDept = b.by_dept.reduce((s, r) => s + r.passed, 0);
        expect(sumDept).toBe(b.overall.passed);
    });

    test('รายเดือน: ไม่นับตัวชี้วัดสะสมในร้อยละผ่านรายเดือน แต่นับการบันทึก', async () => {
        const b = await get(`&yut_id=${yutId}`);
        const oct = b.monthly.find(m => m.month === 'oct');
        const nov = b.monthly.find(m => m.month === 'nov');
        expect(oct).toMatchObject({ recorded: 5, eligible: 3, passed: 1 }); // ind1A 70✗ ind1B 50✗ ind2 12000✓ (ind3 ไม่มีเป้า, cum ไม่นับ)
        expect(nov).toMatchObject({ recorded: 2, eligible: 1, passed: 1 });
        const heat = b.heatmap_main.find(r => Number(r.gkey) === mainX);
        expect(heat.months.find(m => m.month === 'oct').pass_pct).toBe(33.33);
    });

    test('ตัวกรองหมวดหมู่ / ตัวชี้วัด / หน่วยงาน', async () => {
        expect((await get(`&main_id=${mainY}`)).overall.pairs).toBe(2);
        expect((await get(`&indicator_id=${ind1}`)).overall).toMatchObject({ pairs: 2, passed: 1 });
        const opts = (await get(`&yut_id=${yutId}`)).options;
        expect(opts.mains.map(m => m.id)).toEqual(expect.arrayContaining([mainX, mainY]));
        expect(opts.indicators.map(m => m.id)).not.toContain(indOff);
        expect(opts.years).toContain(YEAR);
    });

    test('ขอบเขต role: user_hos เห็นเฉพาะหน่วยบริการตัวเอง', async () => {
        const b = await get(`&yut_id=${yutId}`, userToken);
        expect(b.overall.hospital_count).toBe(1);
        expect(pick(b.by_indicator, ind1)).toMatchObject({ pairs: 1, passed: 1 });
    });

    test('ตัวกรองค่าไม่ถูกต้องไม่ทำให้ SQL พัง (parameterized)', async () => {
        const b = await get(`&dept_id=${encodeURIComponent("1 OR 1=1")}&distid=${encodeURIComponent("' OR '1'='1")}`);
        expect(b.overall.pairs).toBe(0);
    });
});
