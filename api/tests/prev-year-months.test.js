/**
 * Integration tests: GET /kpi-summary/prev-year-months (database ทดสอบ)
 *   ผลงานรายเดือนของปีงบที่แล้ว ใช้เป็นค่าอ้างอิง "เตือนค่าที่อาจผิดปกติ" ตอนบันทึกผลงาน (frontend/src/app/shared/anomaly.ts)
 *   - คืนข้อมูลของปี year_bh - 1 เท่านั้น
 *   - ขอบเขตตาม role เหมือนรายงาน (user_hos เห็นเฉพาะหน่วยบริการ + หน่วยงานของตน)
 *   - ไม่รวมตัวชี้วัดที่ปิดใช้งาน, กรองด้วย hospcodes ได้, ต้อง login
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2505', PREV = '2504';
let app, db, saToken, hosToken, deptId, otherDeptId, hospA, hospB;
const created = [];
const ind = {};
const api = (p) => '/khupskpi/api' + p;
const as = (token, r) => r.set('Authorization', `Bearer ${token}`);

async function addIndicator(name, dept, isActive = 1) {
    const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?,?,?)', [name, dept, isActive]);
    created.push(r.insertId);
    return r.insertId;
}
async function addSummary(indicatorId, year, hospcode, dept, months) {
    const [[h]] = await db.query('SELECT hosname, distid FROM chospital WHERE hoscode = ?', [hospcode]);
    await db.query(
        `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, target_value, last_actual, oct, nov)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [indicatorId, year, hospcode, dept, 'test_dept', h.hosname, h.distid, 'test_dist', '80', months.nov ?? months.oct, months.oct ?? null, months.nov ?? null]);
}
const rowsOf = (res) => res.body.data.filter(r => created.includes(Number(r.indicator_id)));

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_summary WHERE year_bh IN (?)', [[YEAR, PREV]]);
    const [depts] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
    const [hs] = await db.query('SELECT hoscode FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 2');
    deptId = depts[0].id; otherDeptId = depts[1].id; hospA = hs[0].hoscode; hospB = hs[1].hoscode;

    const sa = await ensureTestUser(db, { username: 'test_prevm_sa', role: 'super_admin', session_id: 'sess-pm-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-pm-sa' });
    const u = await ensureTestUser(db, { username: 'test_prevm_hos', role: 'user_hos', dept_id: deptId, hospcode: hospA, session_id: 'sess-pm-hos' });
    hosToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hospA, sessionId: 'sess-pm-hos' });

    ind.a = await addIndicator('test_prevm_a', deptId);
    ind.otherDept = await addIndicator('test_prevm_other_dept', otherDeptId);
    ind.off = await addIndicator('test_prevm_off', deptId, 0);

    await addSummary(ind.a, PREV, hospA, deptId, { oct: '75', nov: '80' });
    await addSummary(ind.a, PREV, hospB, deptId, { oct: '60' });
    await addSummary(ind.a, YEAR, hospA, deptId, { oct: '999' });               // ปีปัจจุบัน — ต้องไม่ถูกคืน
    await addSummary(ind.otherDept, PREV, hospA, otherDeptId, { oct: '10' });   // หน่วยงานอื่น
    await addSummary(ind.off, PREV, hospA, deptId, { oct: '33' });              // ตัวชี้วัดปิดใช้งาน
});

afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE year_bh IN (?)', [[YEAR, PREV]]);
    if (created.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created]);
    await cleanupTestUsers(db);
});

describe('GET /kpi-summary/prev-year-months', () => {
    test('✅ คืนผลงานรายเดือนของปีงบที่แล้ว (year_bh - 1) ไม่ปนปีปัจจุบัน และไม่รวมตัวชี้วัดที่ปิดใช้งาน', async () => {
        const res = await as(saToken, request(app).get(api(`/kpi-summary/prev-year-months?year_bh=${YEAR}`)));
        expect(res.status).toBe(200);
        expect(res.body.year_bh).toBe(PREV);
        const rows = rowsOf(res);
        expect(rows.length).toBe(3);                                             // a×A, a×B, otherDept×A
        const a = rows.find(r => Number(r.indicator_id) === ind.a && String(r.hospcode) === String(hospA));
        expect(a.oct).toBe('75');
        expect(a.nov).toBe('80');
        expect(a.dece).toBeNull();
        expect(rows.some(r => r.oct === '999')).toBe(false);
        expect(rows.some(r => Number(r.indicator_id) === ind.off)).toBe(false);
    });

    test('✅ กรองเฉพาะหน่วยบริการที่ส่งมาใน hospcodes', async () => {
        const res = await as(saToken, request(app).get(api(`/kpi-summary/prev-year-months?year_bh=${YEAR}&hospcodes=${hospB}`)));
        const rows = rowsOf(res);
        expect(rows.length).toBe(1);
        expect(String(rows[0].hospcode)).toBe(String(hospB));
    });

    test('🛡️ user_hos เห็นเฉพาะหน่วยบริการและหน่วยงานของตน แม้ขอหน่วยบริการอื่น', async () => {
        const res = await as(hosToken, request(app).get(api(`/kpi-summary/prev-year-months?year_bh=${YEAR}&hospcodes=${hospA},${hospB}`)));
        expect(res.status).toBe(200);
        const rows = rowsOf(res);
        expect(rows.length).toBe(1);
        expect(Number(rows[0].indicator_id)).toBe(ind.a);
        expect(String(rows[0].hospcode)).toBe(String(hospA));
    });

    test('🛡️ ต้อง login และ year_bh ต้องเป็นตัวเลข 4 หลัก', async () => {
        expect((await request(app).get(api(`/kpi-summary/prev-year-months?year_bh=${YEAR}`))).status).toBe(401);
        expect((await as(saToken, request(app).get(api('/kpi-summary/prev-year-months')))).status).toBe(400);
        expect((await as(saToken, request(app).get(api('/kpi-summary/prev-year-months?year_bh=25x5')))).status).toBe(400);
    });

    test('✅ hospcodes ที่มีอักขระแปลกปลอมถูกตัดทิ้ง (ไม่กระทบ SQL)', async () => {
        const res = await as(saToken, request(app).get(api(`/kpi-summary/prev-year-months?year_bh=${YEAR}&hospcodes=${encodeURIComponent("x' OR 1=1 --")},${hospB}`)));
        expect(res.status).toBe(200);
        expect(rowsOf(res).length).toBe(1);
    });
});
