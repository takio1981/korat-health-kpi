/**
 * ระบบเตือนล่วงหน้า ระยะที่ 2 (8 พ.ย. 2569): GET /report/forecast — ตัวชี้วัดเสี่ยงตามขอบเขตเดียวกับรายงาน (database ทดสอบ)
 *   - ระดับ เสี่ยงสูง/เฝ้าระวัง/ปกติ/ขาดการรายงาน/ข้อมูลไม่พอ จาก kpi_summary + คุณสมบัติตัวชี้วัด (สะสม)
 *   - ดู ณ เดือน (through) ไม่เกินเดือนล่าสุดที่ควรรายงาน | ปีงบที่ปิดแล้วไม่ตรวจขาดการรายงาน
 *   - ตัวชี้วัดรายงานเป็นรอบ (ปีงบที่แล้วรายงาน < 6 เดือน) ไม่ถูกนับขาดการรายงาน
 *   - user_hos เห็นเฉพาะหน่วยบริการ + หน่วยงานของตน, ไม่รวมตัวชี้วัดที่ปิดใช้งาน
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2523', PREV = '2522';
let app, db, saToken, hosToken, deptId, otherDeptId, hosp;
const created = [];
const ind = {};
const api = (p) => '/khupskpi/api' + p;
const as = (t, r) => r.set('Authorization', `Bearer ${t}`);
const MK = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];

async function addIndicator(name, dept, extra = {}) {
    const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, is_cumulative) VALUES (?,?,?,?)',
        [name, dept, extra.active === 0 ? 0 : 1, extra.cumulative ? 1 : 0]);
    created.push(r.insertId);
    return r.insertId;
}
async function addSummary(indicatorId, year, h, dept, target, vals) {
    const cols = MK.slice(0, vals.length);
    await db.query(`INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, target_value, last_actual, ${cols.join(', ')})
        VALUES (?,?,?,?,?,?,?,?,?,?${', ?'.repeat(cols.length)})`,
    [indicatorId, year, h.hoscode, dept, 'test_dept', h.hosname, h.distid, 'test_dist', target, vals.filter(Boolean).slice(-1)[0] || null, ...vals.map(v => (v === '' ? null : v))]);
}
const get = (t, q) => as(t, request(app).get(api('/report/forecast' + q)));
const mine = (items) => items.filter(i => created.includes(i.indicator_id));

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_summary WHERE year_bh IN (?)', [[YEAR, PREV]]);
    const [depts] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
    deptId = depts[0].id; otherDeptId = depts[1].id;
    const [hs] = await db.query("SELECT hoscode, hosname, distid FROM chospital WHERE distid IS NOT NULL AND hosname <> '' ORDER BY hoscode LIMIT 2");
    hosp = hs;
    const sa = await ensureTestUser(db, { username: 'test_fc_sa', role: 'super_admin', session_id: 'sess-fc-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-fc-sa' });
    const u = await ensureTestUser(db, { username: 'test_fc_hos', role: 'user_hos', dept_id: deptId, hospcode: hs[0].hoscode, session_id: 'sess-fc-hos' });
    hosToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hs[0].hoscode, sessionId: 'sess-fc-hos' });

    ind.latest = await addIndicator('test_fc_ค่าล่าสุด', deptId);
    ind.cum = await addIndicator('test_fc_สะสม', deptId, { cumulative: true });
    ind.stop = await addIndicator('test_fc_หยุดรายงาน', deptId);
    ind.periodic = await addIndicator('test_fc_รายงานเป็นรอบ', deptId);
    ind.off = await addIndicator('test_fc_ปิดใช้งาน', deptId, { active: 0 });
    ind.other = await addIndicator('test_fc_หน่วยงานอื่น', otherDeptId);
    const six = (v) => Array(6).fill(v);
    await addSummary(ind.latest, YEAR, hs[0], deptId, '80', six('85'));          // ปกติ
    await addSummary(ind.latest, YEAR, hs[1], deptId, '80', six('75'));          // 93.75% → เฝ้าระวัง
    await addSummary(ind.cum, YEAR, hs[0], deptId, '120', six('5'));             // 5 × 12 = 60 → 50% เสี่ยงสูง
    await addSummary(ind.stop, YEAR, hs[0], deptId, '80', ['80', '80', '80']);   // ม.ค.–มี.ค. ว่าง → ขาดการรายงาน
    await addSummary(ind.periodic, YEAR, hs[0], deptId, '80', ['80']);           // รายงานเป็นรอบ → ข้อมูลไม่พอ (ไม่ใช่ขาดการรายงาน)
    await addSummary(ind.periodic, PREV, hs[0], deptId, '80', ['80']);           // ปีงบที่แล้วรายงานเดือนเดียว
    await addSummary(ind.off, YEAR, hs[0], deptId, '80', six('1'));
    await addSummary(ind.other, YEAR, hs[0], otherDeptId, '80', six('1'));
});
afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE year_bh IN (?)', [[YEAR, PREV]]);
    if (created.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created]);
    await cleanupTestUsers(db);
});

describe('GET /report/forecast', () => {
    test('✅ ดู ณ มี.ค.: เสี่ยงสูง/เฝ้าระวัง/ขาดการรายงาน เรียงตามระดับ — ปกติ/ข้อมูลไม่พอนับใน counts เท่านั้น', async () => {
        const res = await get(saToken, `?year_bh=${YEAR}&through=5`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ year_bh: YEAR, through: 5, through_label: 'มี.ค.', year_closed: true, watch_pct: 10 });
        const items = mine(res.body.items);
        expect(items.map(i => [i.indicator_id, i.hospcode, i.status])).toEqual([
            [ind.other, hosp[0].hoscode, 'high'],                                            // ห่างเป้า 98.75% (เรียงตามระยะห่างจากเป้า)
            [ind.cum, hosp[0].hoscode, 'high'],
            [ind.latest, hosp[1].hoscode, 'watch'],
            [ind.stop, hosp[0].hoscode, 'no_report'],
        ]);
        expect(items[1]).toMatchObject({ projected: '60', target: '120', pct: 50, method: 'run_rate', last_actual: '5', last_month: 'มี.ค.' });
        expect(items[2]).toMatchObject({ pct: 93.75, gap_pct: 6.25 });
        expect(items[3].missing_months).toBe(3);
        expect(items.find(i => i.indicator_id === ind.off)).toBeUndefined();                 // ปิดใช้งาน
        expect(items.find(i => i.indicator_id === ind.periodic)).toBeUndefined();            // รายงานเป็นรอบ → ข้อมูลไม่พอ
        expect(res.body.by_indicator.find(x => x.indicator_id === ind.cum)).toMatchObject({ high: 1 });
    });
    test('ปีงบที่ปิดแล้ว (ข้อมูลล่าสุด) ไม่ตรวจขาดการรายงาน — ใช้ผลจริง', async () => {
        const res = await get(saToken, `?year_bh=${YEAR}`);
        expect(res.body.through).toBe(11);
        const stop = mine(res.body.items).find(i => i.indicator_id === ind.stop);
        expect(stop).toBeUndefined();                                                          // ผลจริง 80 ≥ 80 = ปกติ
        expect(mine(res.body.items).find(i => i.indicator_id === ind.cum)).toMatchObject({ method: 'actual', projected: '30', confidence: 'actual', status: 'high' });
    });
    test('ขอบเขต user_hos: เฉพาะหน่วยบริการ + หน่วยงานของตน', async () => {
        const res = await get(hosToken, `?year_bh=${YEAR}&through=5`);
        expect(res.status).toBe(200);
        const items = mine(res.body.items);
        expect(items.length).toBeGreaterThan(0);
        expect(items.every(i => i.hospcode === hosp[0].hoscode && i.dept_id === deptId)).toBe(true);
        expect(items.find(i => i.indicator_id === ind.other)).toBeUndefined();
    });
    test('ปีงบไม่ถูกต้อง = 400 | ไม่เข้าสู่ระบบ = 401', async () => {
        expect((await get(saToken, '?year_bh=abc')).status).toBe(400);
        expect((await request(app).get(api('/report/forecast'))).status).toBe(401);
    });
});
