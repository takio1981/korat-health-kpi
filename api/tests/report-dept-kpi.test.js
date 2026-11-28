/**
 * รายงานสรุปผล: สรุปข้อมูลตัวชี้วัดของกลุ่มงาน (28 พ.ย. 2569 — ผู้ใช้สั่ง) — GET /report/by-dept-kpi
 * แถวรายตัวชี้วัดชุดเดียวกับแถบรายข้อตัวชี้วัด จัดกลุ่มตามกลุ่มงาน | ร้อยละผ่านเกณฑ์ของกลุ่มงาน = คู่ผ่าน ÷ คู่ที่มีเป้าหมาย
 * ขอบเขตตามสิทธิ์เดียวกับรายงาน (ผู้ใช้กลุ่มงาน = เฉพาะกลุ่มงานตัวเอง) + AI สรุปรายแถบรองรับแถบนี้ (ไม่มีรหัสหน่วยบริการใน prompt)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { summarizeDeptKpi } = require('../services/report-dept-kpi');
const { tabKey, buildTabInput } = require('../services/ai-report-tabs');

describe('summarizeDeptKpi (ฟังก์ชันล้วน)', () => {
    test('จัดกลุ่ม + นับผ่านทุกแห่ง/บางแห่ง/ยังไม่ผ่าน/ไม่มีเป้าหมาย + ร้อยละจากคู่ (ไม่ใช่ค่าเฉลี่ยร้อยละ)', () => {
        const out = summarizeDeptKpi([
            { indicator_id: 1, dept_id: 7, dept_name: 'ก', kpi_indicators_name: 'x1', hospitals_with_target: 10, hospitals_passed: 10, achievement_pct: 100 },
            { indicator_id: 2, dept_id: 7, dept_name: 'ก', kpi_indicators_name: 'x2', hospitals_with_target: 2, hospitals_passed: 0, achievement_pct: 0 },
            { indicator_id: 3, dept_id: 7, dept_name: 'ก', kpi_indicators_name: 'x3', hospitals_with_target: 0, hospitals_passed: 0, achievement_pct: 0 },
            { indicator_id: 4, dept_id: 8, dept_name: 'ข', kpi_indicators_name: 'y1', hospitals_with_target: 4, hospitals_passed: 1, achievement_pct: 25 },
            { indicator_id: 5, dept_id: null, dept_name: null, kpi_indicators_name: 'z', hospitals_with_target: 1, hospitals_passed: 1, achievement_pct: 100 },
        ]);
        const g = Object.fromEntries(out.data.map(d => [d.dept_name, d]));
        expect(g['ก']).toMatchObject({ dept_id: 7, total_indicators: 3, indicators_all_passed: 1, indicators_partial: 0, indicators_none_passed: 1, indicators_no_target: 1, pairs_with_target: 12, pairs_passed: 10 });
        expect(g['ก'].pass_pct).toBeCloseTo(83.33, 2);      // 10 / 12 — ไม่ใช่ (100 + 0) / 2
        expect(g['ก'].avg_indicator_pct).toBe(50);
        expect(g['ข']).toMatchObject({ indicators_partial: 1, pass_pct: 25 });
        expect(g['ไม่ระบุกลุ่มงาน']).toBeTruthy();
        expect(out.data[0].pass_pct).toBeGreaterThanOrEqual(out.data[1].pass_pct);   // เรียงร้อยละมาก → น้อย
        expect(g['ก'].indicators.map(r => r.indicator_id)).toEqual([1, 2, 3]);
        expect(out.summary).toMatchObject({ total_depts: 3, total_indicators: 5, indicators_with_target: 4, pairs_with_target: 17, pairs_passed: 12, depts_ge_80: 2, depts_lt_50: 1 });
    });
    test('ไม่มีแถว = ว่าง', () => {
        expect(summarizeDeptKpi([])).toEqual(expect.objectContaining({ data: [], summary: expect.objectContaining({ total_depts: 0, pass_pct: 0 }) }));
    });
});

const YEAR = '2501';
let app, db, deptA, deptB, indA, indB, hs, saToken, userToken;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_rdk\\_');
    const [ds] = await db.query('SELECT id, dept_name FROM departments ORDER BY id LIMIT 2');
    [deptA, deptB] = ds;
    indA = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, target_condition) VALUES ('test_rdk_A', ?, 1, '', 'GTE')", [deptA.id]))[0].insertId;
    indB = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, target_condition) VALUES ('test_rdk_B', ?, 1, '', 'GTE')", [deptB.id]))[0].insertId;
    [hs] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 2');
    // A: 2 แห่งผ่านทั้งคู่ | B: 2 แห่ง ผ่าน 1
    const rows = [[indA, deptA, hs[0].hoscode, '10', '12'], [indA, deptA, hs[1].hoscode, '10', '10'],
                  [indB, deptB, hs[0].hoscode, '10', '3'], [indB, deptB, hs[1].hoscode, '10', '11']];
    for (const [ind, d, h, t, a] of rows) {
        await db.query('INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, kpi_indicators_name, target_value, last_actual, oct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [ind, YEAR, h, d.id, d.dept_name, ind === indA ? 'test_rdk_A' : 'test_rdk_B', t, a, a]);
    }
    const sa = await ensureTestUser(db, { username: 'test_rdk_sa', role: 'super_admin', session_id: 's-rdk' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-rdk' });
    const u = await ensureTestUser(db, { username: 'test_rdk_ssj', role: 'user_ssj', dept_id: deptA.id, hospcode: hs[0].hoscode, session_id: 's-rdk2' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_ssj', deptId: deptA.id, hospcode: hs[0].hoscode, sessionId: 's-rdk2' });
}, 60000);

afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [[indA, indB]]);
    await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [[indA, indB]]);
    await cleanupTestUsers(db, 'test\\_rdk\\_');
});

const findInd = (body, id) => {
    for (const g of body.data) { const r = g.indicators.find(x => x.indicator_id === id); if (r) return { g, r }; }
    return null;
};

test('super_admin: ตัวชี้วัดอยู่ใต้กลุ่มงานของตัวเอง + ตัวเลขตรงกับแถบรายข้อตัวชี้วัด', async () => {
    const r = await request(app).get('/khupskpi/api/report/by-dept-kpi').set('Authorization', `Bearer ${saToken}`).query({ year_bh: YEAR });
    expect(r.status).toBe(200);
    const a = findInd(r.body, indA), b = findInd(r.body, indB);
    expect(a.g.dept_id).toBe(deptA.id);
    expect(b.g.dept_id).toBe(deptB.id);
    expect(Number(a.r.hospitals_passed)).toBe(2);
    expect(Number(b.r.hospitals_passed)).toBe(1);
    expect(Number(b.r.achievement_pct)).toBe(50);
    expect(a.g.indicators_all_passed).toBeGreaterThanOrEqual(1);
    const bi = await request(app).get('/khupskpi/api/report/by-indicator').set('Authorization', `Bearer ${saToken}`).query({ year_bh: YEAR });
    const rowB = bi.body.data.find(x => x.indicator_id === indB);
    expect(Number(rowB.achievement_pct)).toBe(Number(b.r.achievement_pct));
    expect(Number(rowB.dept_id)).toBe(deptB.id);     // by-indicator คืน dept_id ด้วย
    expect(r.body.summary.total_depts).toBe(r.body.data.length);
});

test('ตัวกรองกลุ่มงาน (dept_id) = เหลือกลุ่มงานเดียว', async () => {
    const r = await request(app).get('/khupskpi/api/report/by-dept-kpi').set('Authorization', `Bearer ${saToken}`).query({ year_bh: YEAR, dept_id: deptB.id });
    expect(r.status).toBe(200);
    expect(r.body.data.map(g => g.dept_id)).toEqual([deptB.id]);
});

test('ผู้ใช้กลุ่มงาน (user_ssj) เห็นเฉพาะกลุ่มงานของตัวเอง', async () => {
    const r = await request(app).get('/khupskpi/api/report/by-dept-kpi').set('Authorization', `Bearer ${userToken}`).query({ year_bh: YEAR });
    expect(r.status).toBe(200);
    expect(findInd(r.body, indA)).toBeTruthy();
    expect(findInd(r.body, indB)).toBeNull();
    expect(r.body.data.every(g => g.dept_id === deptA.id)).toBe(true);
});

test('ไม่มี token = 401', async () => {
    const r = await request(app).get('/khupskpi/api/report/by-dept-kpi').query({ year_bh: YEAR });
    expect(r.status).toBe(401);
});

test('AI สรุปรายแถบรองรับแถบนี้ + ข้อมูลเข้า prompt ไม่มีรหัสหน่วยบริการ', async () => {
    expect(tabKey('by-dept-kpi', '')).toBe('by-dept-kpi');
    const r = await request(app).get('/khupskpi/api/report/by-dept-kpi').set('Authorization', `Bearer ${saToken}`).query({ year_bh: YEAR });
    const input = buildTabInput('by-dept-kpi', r.body, { year_bh: YEAR, filters: {} });
    expect(input.has_data).toBe(true);
    expect(input.report).toBe('สรุปข้อมูลตัวชี้วัดของกลุ่มงาน');
    expect(input.departments.some(d => d.name === deptA.dept_name)).toBe(true);
    const text = JSON.stringify(input);
    for (const h of hs) expect(text).not.toContain(h.hoscode);
});
