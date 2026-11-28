/**
 * รายงานสรุปผล: ยอดรวมเป้าหมาย/ผลงาน/ร้อยละ = ทุกหน่วยบริการที่ต้องกรอก ทั้งที่มีผลงานและยังไม่มีผลงาน (28 พ.ย. 2569 — ผู้ใช้สั่ง)
 * ร้อยละ = ผลงานรวม ÷ เป้าหมายรวม × 100 (ไม่ใช่ร้อยละผ่านเกณฑ์) | หน่วยที่ต้องกรอก = หน่วยที่ถูกเพิ่มตัวชี้วัดแล้ว (มีแถวใน kpi_results)
 * ⚠️ เดิม: รายงานอ่านเฉพาะ kpi_summary (คู่ที่มีผลงาน) → เป้าหมายรวมไม่รวมหน่วยที่ยังไม่บันทึก + ร้อยละ = ผ่านเกณฑ์
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { reportPairsSql } = require('../services/report-pairs');

const Y = '2481';
let app, db, token, userId, dept, indN, indC, indL, hs;

async function cleanup() {
    const [inds] = await db.query("SELECT id FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_rpair\\_%'");
    const ids = inds.map(r => r.id);
    if (ids.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [ids]);
    }
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_rpair\\_');
    await cleanup();
    [[dept]] = await db.query('SELECT id, dept_name FROM departments ORDER BY id LIMIT 1');
    [hs] = await db.query('SELECT h.hoscode, h.hosname, h.distid, h.hostype, d.distname FROM chospital h LEFT JOIN co_district d ON d.distid = h.distid WHERE h.distid IS NOT NULL ORDER BY h.hoscode LIMIT 3');
    const sa = await ensureTestUser(db, { username: 'test_rpair_sa', role: 'super_admin', session_id: 's-rpair' });
    userId = sa.id;
    token = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-rpair' });
    const ins = (name, monthly) => db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, target_condition, target_monthly) VALUES (?, ?, 1, '', 'GTE', ?)", [name, dept.id, monthly]).then(([r]) => r.insertId);
    indN = await ins('test_rpair_N', null);           // เป้าหมายเดียวทั้งปี
    indC = await ins('test_rpair_C', 'cumulative');   // เป้าหมายรายเดือนแบบสะสม
    indL = await ins('test_rpair_L', 'latest');       // เป้าหมายรายเดือนแบบล่าสุด
    const res = (ind, h, month, t, a) => db.query("INSERT INTO kpi_results (indicator_id, year_bh, month_bh, user_id, status, hospcode, target_value, actual_value) VALUES (?, ?, ?, ?, 'Pending', ?, ?, ?)", [ind, Y, month, userId, h.hoscode, t, a]);
    const sum = (ind, h, t, a) => db.query(`INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, kpi_indicators_name, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct)
        VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [ind, Y, h.hoscode, dept.id, dept.dept_name, h.hosname, h.distid, h.distname, h.hostype, t, a, a]);
    // indN: 3 แห่ง เป้าหมาย 10 — h0 มีผลงาน 8, h1/h2 ยังไม่มี (แถวเป้าหมาย 2 เดือน — ต้องนับครั้งเดียว)
    await res(indN, hs[0], '10', '10', '8'); await sum(indN, hs[0], '10', '8');
    for (const h of [hs[1], hs[2]]) { await res(indN, h, '10', '10', null); await res(indN, h, '11', '10', null); }
    // indC (สะสม) h0 ยังไม่มีผลงาน เป้าหมาย ต.ค. 5 + พ.ย. 7 = 12 | indL (ล่าสุด) h0 เป้าหมาย ต.ค. 5, ม.ค. 9 → 9
    await res(indC, hs[0], '10', '5', null); await res(indC, hs[0], '11', '7', null);
    await res(indL, hs[0], '10', '5', null); await res(indL, hs[0], '1', '9', null); await res(indL, hs[0], '11', 'ไม่ระบุ', null);
}, 60000);

afterAll(async () => {
    await cleanup();
    await cleanupTestUsers(db, 'test\\_rpair\\_');
});

const get = (path, q = {}) => request(app).get('/khupskpi/api' + path).set('Authorization', `Bearer ${token}`).query({ year_bh: Y, dept_id: dept.id, ...q });

test('แหล่งข้อมูลกลาง: คู่ที่มีผลงาน (kpi_summary) + คู่ที่ยังไม่มีผลงาน (kpi_results) — คู่ละ 1 แถว เป้าหมายตามโหมดเป้าหมายรายเดือน', async () => {
    const src = reportPairsSql(Y);
    const [rows] = await db.query(`SELECT indicator_id, hospcode, target_value, last_actual, is_recorded FROM ${src.sql} s WHERE s.indicator_id IN (?) ORDER BY indicator_id, hospcode`, [...src.params, [indN, indC, indL]]);
    const of = (ind) => rows.filter(r => r.indicator_id === ind);
    expect(of(indN).length).toBe(3);
    expect(of(indN).map(r => Number(r.is_recorded))).toEqual([1, 0, 0]);
    expect(of(indN).map(r => Number(r.target_value))).toEqual([10, 10, 10]);
    expect(Number(of(indC)[0].target_value)).toBe(12);
    expect(Number(of(indL)[0].target_value)).toBe(9);
    expect(of(indL)[0].last_actual).toBeNull();
});

test('รายข้อตัวชี้วัด: หน่วยบริการ 3 แห่ง (บันทึก 1) เป้าหมายรวม 30 ผลงานรวม 8 ร้อยละ = 8 ÷ 30', async () => {
    const r = await get('/report/by-indicator');
    expect(r.status).toBe(200);
    const row = r.body.data.find(x => x.indicator_id === indN);
    expect(Number(row.hospital_count)).toBe(3);
    expect(Number(row.recorded_hospitals)).toBe(1);
    expect(Number(row.target_value)).toBe(30);
    expect(Number(row.total_actual)).toBe(8);
    expect(Number(row.achievement_pct)).toBe(26.67);
    const c = r.body.data.find(x => x.indicator_id === indC);
    expect([Number(c.hospital_count), Number(c.recorded_hospitals), Number(c.target_value), Number(c.achievement_pct)]).toEqual([1, 0, 12, 0]);
});

test('รายหน่วยบริการ / รายอำเภอ / รายปีงบ / สรุปตัวชี้วัดของกลุ่มงาน นับหน่วยที่ยังไม่มีผลงานด้วย', async () => {
    const hos = (await get('/report/by-hospital')).body.data;
    const h0 = hos.find(x => x.hospcode === hs[0].hoscode);
    expect([Number(h0.indicator_count), Number(h0.recorded_indicators), Number(h0.total_target), Number(h0.total_actual)]).toEqual([3, 1, 31, 8]);   // 10 + 12 + 9
    expect(Number(h0.achievement_pct)).toBe(25.81);
    const h1 = hos.find(x => x.hospcode === hs[1].hoscode);
    expect([Number(h1.indicator_count), Number(h1.recorded_indicators), Number(h1.total_target), Number(h1.achievement_pct)]).toEqual([1, 0, 10, 0]);

    const dist = (await get('/report/by-district')).body.data;
    const pairs = dist.reduce((s, d) => s + Number(d.total_pairs), 0);
    const rec = dist.reduce((s, d) => s + Number(d.recorded_pairs), 0);
    expect([pairs, rec]).toEqual([5, 1]);
    expect(dist.reduce((s, d) => s + Number(d.total_target), 0)).toBe(51);   // 30 + 12 + 9

    const year = (await get('/report/by-year')).body.data.find(x => String(x.year_bh) === Y);
    expect([Number(year.total_pairs), Number(year.recorded_pairs), Number(year.total_target), Number(year.total_actual)]).toEqual([5, 1, 51, 8]);
    expect(Number(year.achievement_pct)).toBe(15.69);

    const dk = (await get('/report/by-dept-kpi')).body;
    const g = dk.data.find(x => x.dept_id === dept.id);
    expect([g.total_indicators, g.total_pairs, g.recorded_pairs, g.recording_pct]).toEqual([3, 5, 1, 20]);
    expect([g.indicators_all_recorded, g.indicators_partial, g.indicators_none_recorded]).toEqual([0, 1, 2]);
});

test('ตัวกรองยังทำงานกับหน่วยที่ยังไม่มีผลงาน (อำเภอ/ประเภทหน่วยบริการมาจาก chospital)', async () => {
    const byDist = await get('/report/by-indicator', { distid: hs[1].distid });
    const row = byDist.body.data.find(x => x.indicator_id === indN);
    const expected = hs.filter(h => h.distid === hs[1].distid).length;
    expect(Number(row.hospital_count)).toBe(expected);
    const byType = await get('/report/by-hospital', { hostype: hs[2].hostype });
    expect(byType.body.data.map(x => x.hospcode)).toContain(hs[2].hoscode);
    expect(byType.body.data.every(x => x.hostype === hs[2].hostype)).toBe(true);
});
