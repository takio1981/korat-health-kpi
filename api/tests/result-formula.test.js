/**
 * Integration tests: สูตรคำนวณผลงานเฉพาะตัวชี้วัด (kpi_indicators.result_formula) — รันบน database ทดสอบ
 *   - /indicators POST/PUT ปฏิเสธสูตรผิด (400) และบันทึกสูตรถูก
 *   - หน้าบันทึกผลงาน (GET /kpi-results) คำนวณ last_actual ตามสูตร
 *   - kpi_summary (กราฟ/รายงาน) คำนวณตามสูตร ทั้งตอน "อัปเดต Summary" และอัตโนมัติเมื่อแก้สูตร
 *   - ตัวชี้วัดที่ไม่มีสูตรได้ผลเหมือนเดิม (ค่าเดือนล่าสุด)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2569';
let app, db, sa, saToken, user, userToken, deptId, hospcode;
const createdIndicators = [];

const api = (p) => '/khupskpi/api' + p;

async function createIndicator(fields) {
    const res = await request(app).post(api('/indicators')).set('Authorization', `Bearer ${saToken}`)
        .send({ kpi_indicators_name: 'test_formula_' + Date.now() + Math.random(), dept_id: deptId, is_active: 1, ...fields });
    if (res.body.id) createdIndicators.push(res.body.id);
    return res;
}

async function saveMonths(indicatorId, months) {
    const res = await request(app).post(api('/update-kpi')).set('Authorization', `Bearer ${userToken}`)
        .send({ updates: [{ indicator_id: indicatorId, year_bh: YEAR, hospcode, target_value: '80', ...months }] });
    expect(res.status).toBe(200);
}

async function lastActualOnDashboard(indicatorId) {
    const res = await request(app).get(api(`/kpi-results?year=${YEAR}`)).set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.find(r => Number(r.indicator_id) === Number(indicatorId) && r.hospcode === hospcode);
    return row ? row.last_actual : undefined;
}

async function summaryLastActual(indicatorId) {
    const [rows] = await db.query('SELECT last_actual FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [indicatorId, YEAR, hospcode]);
    return rows[0] ? rows[0].last_actual : undefined;
}

async function refreshSummary(indicatorId) {
    for (const [p, body] of [['/refresh-summary/batch', { indicator_ids: [indicatorId], year_bh: YEAR }], ['/refresh-summary/finalize', { year_bh: YEAR }]]) {
        const r = await request(app).post(api(p)).set('Authorization', `Bearer ${saToken}`).send(body);
        expect(r.status).toBe(200);
    }
}

// รอ auto-migration ของ server (ADD COLUMN result_formula) ทำงานจริง — อยู่ท้าย chain migration ยาวตอน startup
// ไม่สร้างคอลัมน์เองใน test เพื่อให้ test ยืนยันด้วยว่า migration ใน server.js ทำงานถูกต้อง
async function waitForColumn(table, column, timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const [rows] = await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
        if (rows.length) return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`migration ไม่ได้สร้าง ${table}.${column} ภายใน ${timeoutMs / 1000} วินาที`);
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady; // รอ migration ชุดหลักเสร็จทั้งหมด (กัน MDL deadlock กับ ALTER TABLE ที่ยังรันอยู่)
    await waitForColumn('kpi_indicators', 'result_formula');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    deptId = d.id; hospcode = h.hoscode;
    sa = await ensureTestUser(db, { username: 'test_formula_sa', role: 'super_admin', session_id: 'sess-f-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-f-sa' });
    user = await ensureTestUser(db, { username: 'test_formula_hos', role: 'user_hos', dept_id: deptId, hospcode, session_id: 'sess-f-hos' });
    userToken = makeToken({ userId: user.id, username: user.username, role: 'user_hos', deptId, hospcode, sessionId: 'sess-f-hos' });
});

afterAll(async () => {
    if (createdIndicators.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [createdIndicators]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [createdIndicators]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [createdIndicators]);
    }
    await cleanupTestUsers(db);
});

describe('บันทึกตัวชี้วัดพร้อมสูตร', () => {
    test('❌ สูตรผิด → 400 พร้อมข้อความ (POST)', async () => {
        const res = await createIndicator({ result_formula: 'process.exit(1)' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/สูตรคำนวณผลงานไม่ถูกต้อง/);
    });

    test('❌ สูตรผิด → 400 (PUT) และสูตรเดิมไม่ถูกเขียนทับ', async () => {
        const ok = await createIndicator({ result_formula: 'AVG(ALL)' });
        const res = await request(app).put(api(`/indicators/${ok.body.id}`)).set('Authorization', `Bearer ${saToken}`)
            .send({ kpi_indicators_name: 'x', dept_id: deptId, is_active: 1, result_formula: 'SUM(target)' });
        expect(res.status).toBe(400);
        const [[row]] = await db.query('SELECT result_formula FROM kpi_indicators WHERE id = ?', [ok.body.id]);
        expect(row.result_formula).toBe('AVG(ALL)');
    });

    test('✅ สูตรว่าง = NULL (ใช้วิธีเดิม)', async () => {
        const res = await createIndicator({ result_formula: '   ' });
        expect(res.status).toBe(200);
        const [[row]] = await db.query('SELECT result_formula FROM kpi_indicators WHERE id = ?', [res.body.id]);
        expect(row.result_formula).toBeNull();
    });
});

describe('ผลงานคำนวณตามสูตรทั้งระบบ', () => {
    test('✅ หน้าบันทึกผลงาน + kpi_summary ใช้สูตร AVG(ALL) แทนค่าเดือนล่าสุด', async () => {
        const res = await createIndicator({ result_formula: 'AVG(ALL)' });
        expect(res.status).toBe(200);
        const id = res.body.id;
        await saveMonths(id, { oct: '10', nov: '20', dece: '30' });

        expect(await lastActualOnDashboard(id)).toBe('20'); // ไม่ใช่ 30 (ค่าเดือนล่าสุด)
        await refreshSummary(id);
        expect(await summaryLastActual(id)).toBe('20');
    });

    test('✅ แก้สูตรแล้ว kpi_summary คำนวณใหม่อัตโนมัติ (ไม่ต้องกดอัปเดต Summary)', async () => {
        const res = await createIndicator({ result_formula: 'AVG(ALL)' });
        const id = res.body.id;
        await saveMonths(id, { oct: '10', nov: '20', dece: '30' });
        await refreshSummary(id);
        expect(await summaryLastActual(id)).toBe('20');

        const put = await request(app).put(api(`/indicators/${id}`)).set('Authorization', `Bearer ${saToken}`)
            .send({ kpi_indicators_name: 'test_formula_edit', dept_id: deptId, is_active: 1, result_formula: 'SUM(ALL)' });
        expect(put.status).toBe(200);
        expect(await summaryLastActual(id)).toBe('60');
        expect(await lastActualOnDashboard(id)).toBe('60');
    });

    test('✅ ตัวชี้วัดไม่มีสูตร → ค่าเดือนล่าสุดเหมือนเดิม (ไม่กระทบตัวชี้วัดเดิม)', async () => {
        const res = await createIndicator({});
        const id = res.body.id;
        await saveMonths(id, { oct: '10', nov: '20', dece: '30' });
        expect(await lastActualOnDashboard(id)).toBe('30');
        await refreshSummary(id);
        expect(await summaryLastActual(id)).toBe('30');
    });
});
