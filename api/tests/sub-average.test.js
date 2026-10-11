/**
 * Integration tests: ผลงานตัวชี้วัดหลักจากตัวชี้วัดย่อย (GET /sub-results/summary → loadSubAggregates) — database ทดสอบ
 *   ค่ารายเดือน = ผลรวมผลงานข้อย่อย ÷ จำนวนตัวชี้วัดย่อยที่เปิดใช้งานทั้งหมด (ข้อที่ไม่ได้บันทึก = 0 โดยไม่ต้องบันทึก 0)
 * Regression (11 ต.ค. 2569): เดิมใช้ SQL AVG หารเฉพาะข้อที่มีการบันทึก → บันทึก 2 จาก 3 ข้อ (90, 60) ได้ 75 แทนที่จะเป็น 50
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2502';
let app, db, saToken, deptId, hospA, hospB, indId;
const subs = {};
const api = (p) => '/khupskpi/api' + p;
const asSa = (r) => r.set('Authorization', `Bearer ${saToken}`);

async function addSub(name, target, active = 1) {
    const [r] = await db.query(
        'INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, target_percentage, is_active) VALUES (?,?,?,?)',
        [indId, name, target, active]);
    return r.insertId;
}
async function save(subId, hospcode, month, actual, target) {
    const res = await asSa(request(app).post(api('/sub-results/upsert')))
        .send({ sub_indicator_id: subId, year_bh: YEAR, hospcode, month_bh: month, actual_value: actual, target_value: target });
    expect(res.status).toBe(200);
}
async function summary(hospcode) {
    const res = await asSa(request(app).get(api(`/sub-results/summary?year_bh=${YEAR}&hospcode=${hospcode}`)));
    expect(res.status).toBe(200);
    return res.body.data.find(r => Number(r.indicator_id) === indId);
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [hs] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 2');
    deptId = d.id; hospA = hs[0].hoscode; hospB = hs[1].hoscode;
    const sa = await ensureTestUser(db, { username: 'test_subavg_sa', role: 'super_admin', session_id: 'sess-sub-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-sub-sa' });
    const [i] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?,?,1)', ['test_subavg_ind', deptId]);
    indId = i.insertId;
    subs.a = await addSub('test_sub_a', '100');
    subs.b = await addSub('test_sub_b', '80');
    subs.c = await addSub('test_sub_c', '60');
    subs.off = await addSub('test_sub_off', '100', 0); // ปิดใช้งาน — ไม่นับเป็นตัวหาร และไม่รวมผลงาน
});

afterAll(async () => {
    const ids = Object.values(subs);
    if (ids.length) await db.query('DELETE FROM kpi_sub_results WHERE sub_indicator_id IN (?)', [ids]);
    if (indId) {
        await db.query('DELETE FROM kpi_sub_indicators WHERE indicator_id = ?', [indId]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
    }
    await cleanupTestUsers(db);
});

describe('ผลงานจากตัวชี้วัดย่อย ÷ จำนวนข้อย่อยทั้งหมด', () => {
    test('✅ บันทึก 2 จาก 3 ข้อ → หารด้วย 3 (ข้อที่ไม่ได้บันทึก = 0) ไม่ใช่หารด้วย 2', async () => {
        await save(subs.a, hospA, 10, '90', '100');
        await save(subs.b, hospA, 10, '60', '80');
        const s = await summary(hospA);
        expect(Number(s.sub_count)).toBe(3);
        expect(Number(s.m10)).toBe(50); // (90 + 60 + 0) / 3 — เดิมได้ 75
    });

    test('✅ เดือนที่ไม่มีข้อใดบันทึกเลย = ว่าง (ไม่ใช่ 0)', async () => {
        const s = await summary(hospA);
        expect(s.m11).toBeNull();
        expect(s.m09).toBeNull();
    });

    test('✅ บันทึกข้อเดียวในเดือนถัดไป → หารด้วย 3 เช่นกัน', async () => {
        await save(subs.c, hospA, 11, '30', null);
        expect(Number((await summary(hospA)).m11)).toBe(10);
    });

    test('✅ บันทึก 0 เองกับไม่บันทึก ให้ผลเท่ากัน', async () => {
        const before = Number((await summary(hospA)).m10);
        await save(subs.c, hospA, 10, '0', '60');
        // actual '0' ถูกเก็บเป็นค่าว่างโดย endpoint เดิม (actual_value || null) — ผลต้องไม่เปลี่ยน
        expect(Number((await summary(hospA)).m10)).toBe(before);
    });

    test('✅ ข้อย่อยที่ปิดใช้งาน ไม่นับเป็นตัวหารและไม่รวมผลงาน', async () => {
        await db.query('INSERT INTO kpi_sub_results (sub_indicator_id, year_bh, hospcode, month_bh, actual_value, user_id) VALUES (?,?,?,?,?,?)',
            [subs.off, YEAR, hospA, 10, '999', (await db.query("SELECT id FROM users WHERE username = 'test_subavg_sa'"))[0][0].id]);
        const s = await summary(hospA);
        expect(Number(s.sub_count)).toBe(3);
        expect(Number(s.m10)).toBe(50);
    });

    test('✅ เป้าหมายเฉลี่ย: ข้อที่ยังไม่มีการบันทึกใช้เป้าหมายตั้งต้นของข้อย่อย', async () => {
        // หน่วยบริการ B บันทึกเฉพาะข้อ a (เป้าหมาย 100) — ข้อ b, c ใช้ค่าตั้งต้น 80, 60 → เฉลี่ย 80 (เดิมได้ 100)
        await save(subs.a, hospB, 10, '40', '100');
        const s = await summary(hospB);
        expect(Number(s.avg_target)).toBe(80);
        expect(Number(s.m10)).toBe(13.3333);
    });

    test('✅ ข้อความที่ไม่ใช่ตัวเลข (เช่น รอดำเนินการ) ไม่ถูกนับเป็นผลงาน', async () => {
        await save(subs.a, hospB, 12, 'รอดำเนินการ', '100');
        expect((await summary(hospB)).m12).toBeNull();
    });
});
