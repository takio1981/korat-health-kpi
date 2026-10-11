/**
 * Integration tests (database ทดสอบ) — เพิ่มตัวชี้วัดให้ง่ายขึ้น (11 ต.ค. 2569)
 *   1) รหัสอัตโนมัติ: GET /indicators/suggest-code + POST /indicators ที่ไม่กรอกชื่อตาราง → ระบบสร้าง table_process/รหัสตัวชี้วัดให้ (ไม่ซ้ำ)
 *      เดิม: ไม่กรอก = บันทึก NULL ทั้งคู่ ผู้ใช้ต้องคิดรหัสเอง
 *   2) ขอบเขตประเภทหน่วยบริการ: /kpi-template และ /update-kpi (setup_insert_new) ต้องตรงกับ evaluation_mode/required_off_types
 *      เดิม: เพิ่มตัวชี้วัดที่ตั้งไว้เฉพาะ รพ.สต. ให้โรงพยาบาลได้
 *   3) รายชื่อตัวชี้วัดทุก endpoint คืน result_formula (ใช้แสดงป้ายสูตร)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2503';
const FORMULA = 'SUM(ALL)';
let app, db, saToken, hosToken, deptId, deptKeyPrefix, hospIn, hospOut, typeIn, typeOut;
const created = [];
const ind = {};
const api = (p) => '/khupskpi/api' + p;
const as = (token, r) => r.set('Authorization', `Bearer ${token}`);

async function addIndicator(name, extra = {}) {
    const cols = { kpi_indicators_name: name, dept_id: deptId, is_active: 1, ...extra };
    const keys = Object.keys(cols);
    const [r] = await db.query(`INSERT INTO kpi_indicators (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => cols[k]));
    created.push(r.insertId);
    return r.insertId;
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_codes\\_%'");

    const [[d]] = await db.query('SELECT id, dept_code FROM departments ORDER BY id LIMIT 1');
    deptId = d.id;
    const code = String(d.dept_code || '').trim().toLowerCase();
    deptKeyPrefix = 'kpi_' + (/^[a-z][a-z0-9]{0,9}$/.test(code) ? code : 'd' + String(d.id).padStart(2, '0')) + '_';

    // หน่วยบริการ 2 ประเภทต่างกัน
    const [types] = await db.query("SELECT hostype, MIN(hoscode) AS hoscode FROM chospital WHERE hostype IS NOT NULL AND hostype <> '' GROUP BY hostype ORDER BY hostype LIMIT 2");
    expect(types.length).toBe(2);
    typeIn = String(types[0].hostype); hospIn = types[0].hoscode;
    typeOut = String(types[1].hostype); hospOut = types[1].hoscode;

    const sa = await ensureTestUser(db, { username: 'test_codes_sa', role: 'super_admin', session_id: 'sess-codes-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-codes-sa' });
    // admin_hos ของหน่วยบริการประเภท typeOut (เห็นทุกหน่วยงาน แต่ผูกหน่วยบริการเดียว)
    const ah = await ensureTestUser(db, { username: 'test_codes_hos', role: 'admin_hos', dept_id: deptId, hospcode: hospOut, session_id: 'sess-codes-hos' });
    hosToken = makeToken({ userId: ah.id, username: ah.username, role: 'admin_hos', deptId, hospcode: hospOut, sessionId: 'sess-codes-hos' });

    ind.only = await addIndicator('test_codes_only_type', { evaluation_mode: 'any_one', required_off_types: JSON.stringify([typeIn]), result_formula: FORMULA, table_process: 'test_codes_only_tp' });
    ind.all = await addIndicator('test_codes_all_types', { evaluation_mode: 'all_required', required_off_types: null });
    ind.unset = await addIndicator('test_codes_unset', { evaluation_mode: 'any_one', required_off_types: null });
});

afterAll(async () => {
    const [rows] = await db.query("SELECT id FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_codes\\_%'");
    const ids = [...new Set([...created, ...rows.map(r => r.id)])];
    if (ids.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [ids]);
    }
    await cleanupTestUsers(db);
});

describe('รหัสตัวชี้วัดอัตโนมัติ', () => {
    test('✅ suggest-code คืนชื่อตารางตามหน่วยงาน + ลำดับถัดไป และรหัสตัวชี้วัดแบบขีดกลาง', async () => {
        const res = await as(saToken, request(app).get(api(`/indicators/suggest-code?dept_id=${deptId}`)));
        expect(res.status).toBe(200);
        const { table_process, kpi_indicators_code } = res.body.data;
        expect(table_process.startsWith(deptKeyPrefix)).toBe(true);
        expect(table_process).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
        expect(table_process).toMatch(/_\d{3,}$/);
        expect(kpi_indicators_code).toBe(table_process.replace(/_/g, '-'));
        const [[dup]] = await db.query('SELECT COUNT(*) AS n FROM kpi_indicators WHERE table_process = ?', [table_process]);
        expect(dup.n).toBe(0);
    });

    test('✅ ไม่เลือกหน่วยงาน → ใช้ prefix kpi_gen_', async () => {
        const res = await as(saToken, request(app).get(api('/indicators/suggest-code')));
        expect(res.body.data.table_process).toMatch(/^kpi_gen_\d{3,}$/);
    });

    test('✅ POST /indicators ไม่กรอกรหัส → ระบบสร้างให้ และตัวถัดไปได้ลำดับใหม่ไม่ซ้ำ', async () => {
        const post = (name) => as(saToken, request(app).post(api('/indicators')))
            .send({ kpi_indicators_name: name, dept_id: deptId, table_process: '', kpi_indicators_code: '', is_active: 1 });
        const r1 = await post('test_codes_auto_1');
        expect(r1.status).toBe(200);
        expect(r1.body.table_process.startsWith(deptKeyPrefix)).toBe(true);   // เดิม: undefined (บันทึก NULL)
        expect(r1.body.kpi_indicators_code).toBe(r1.body.table_process.replace(/_/g, '-'));
        const r2 = await post('test_codes_auto_2');
        expect(r2.body.table_process).not.toBe(r1.body.table_process);
        const n = (tp) => parseInt(tp.slice(deptKeyPrefix.length), 10);
        expect(n(r2.body.table_process)).toBe(n(r1.body.table_process) + 1);
        const [[row]] = await db.query('SELECT table_process, kpi_indicators_code FROM kpi_indicators WHERE id = ?', [r1.body.id]);
        expect(row.table_process).toBe(r1.body.table_process);
        expect(row.kpi_indicators_code).toBe(r1.body.kpi_indicators_code);
    });

    test('✅ กรอกชื่อตารางเอง → ใช้ค่าที่กรอก (ไม่ถูกทับ)', async () => {
        const res = await as(saToken, request(app).post(api('/indicators')))
            .send({ kpi_indicators_name: 'test_codes_manual', dept_id: deptId, table_process: 'test_codes_manual_tp', kpi_indicators_code: 'MY-CODE', is_active: 1 });
        expect(res.status).toBe(200);
        expect(res.body.table_process).toBe('test_codes_manual_tp');
        expect(res.body.kpi_indicators_code).toBe('MY-CODE');
    });

    test('🛡️ suggest-code ต้องมีสิทธิ์เพิ่มตัวชี้วัด (admin_hos ไม่มี) และต้อง login', async () => {
        expect((await request(app).get(api('/indicators/suggest-code'))).status).toBe(401);
        expect((await as(hosToken, request(app).get(api('/indicators/suggest-code')))).status).toBe(403);
    });
});

describe('เพิ่มตัวชี้วัดให้หน่วยบริการ — ตรงประเภทหน่วยบริการที่ตั้งไว้', () => {
    test('✅ /kpi-template คืนค่าที่ตั้งไว้ของตัวชี้วัด (ประเภทหน่วยบริการ + สูตร)', async () => {
        const res = await as(saToken, request(app).get(api('/kpi-template')));
        expect(res.status).toBe(200);
        const row = res.body.data.find(r => Number(r.indicator_id) === ind.only);
        expect(row.evaluation_mode).toBe('any_one');
        expect(JSON.parse(row.required_off_types)).toEqual([typeIn]);
        expect(row.result_formula).toBe(FORMULA);
    });

    test('✅ ผู้ใช้ที่ผูกหน่วยบริการเดียว เห็นเฉพาะตัวชี้วัดที่ใช้กับประเภทหน่วยบริการของตน', async () => {
        const res = await as(hosToken, request(app).get(api('/kpi-template')));
        const ids = res.body.data.map(r => Number(r.indicator_id));
        expect(ids).not.toContain(ind.only);   // ตั้งไว้เฉพาะ typeIn — ผู้ใช้อยู่ typeOut (เดิม: เห็น)
        expect(ids).toContain(ind.all);
        expect(ids).toContain(ind.unset);
    });

    test('✅ setup_insert_new ข้ามคู่ที่ประเภทหน่วยบริการไม่ตรง (เดิม: เพิ่มให้ทุกแห่ง)', async () => {
        const updates = [ind.only, ind.all, ind.unset].map(id => ({ indicator_id: id, year_bh: YEAR, target_value: '80' }));
        const out = await as(saToken, request(app).post(api('/update-kpi'))).send({ updates, targetHospcode: hospOut, mode: 'setup_insert_new' });
        expect(out.status).toBe(200);
        expect(out.body.inserted).toBe(2);
        expect(out.body.skipped_type).toBe(1);
        const [[cOut]] = await db.query('SELECT COUNT(*) AS n FROM kpi_results WHERE indicator_id = ? AND hospcode = ? AND year_bh = ?', [ind.only, hospOut, YEAR]);
        expect(cOut.n).toBe(0);

        const inn = await as(saToken, request(app).post(api('/update-kpi'))).send({ updates, targetHospcode: hospIn, mode: 'setup_insert_new' });
        expect(inn.body.inserted).toBe(3);
        expect(inn.body.skipped_type).toBe(0);
        const [[cIn]] = await db.query('SELECT COUNT(*) AS n FROM kpi_results WHERE indicator_id = ? AND hospcode = ? AND year_bh = ?', [ind.only, hospIn, YEAR]);
        expect(cIn.n).toBe(12);
    });

    test('✅ ส่งซ้ำ → นับ "มีอยู่แล้ว" กับ "ไม่ตรงประเภท" แยกกัน', async () => {
        const updates = [ind.only, ind.all].map(id => ({ indicator_id: id, year_bh: YEAR, target_value: '80' }));
        const res = await as(saToken, request(app).post(api('/update-kpi'))).send({ updates, targetHospcode: hospOut, mode: 'setup_insert_new' });
        expect(res.status).toBe(200);
        expect(res.body.inserted).toBe(0);
        expect(res.body.skipped).toBe(1);
        expect(res.body.skipped_type).toBe(1);
    });
});

describe('รายชื่อตัวชี้วัดทุกหน้าแนบสูตรคำนวณผลงาน (result_formula)', () => {
    const findInd = (rows, key = 'indicator_id') => (rows || []).find(r => Number(r[key]) === ind.only);

    test('✅ รายการส่งออก / Form Builder / จัดการข้อมูลผลงาน', async () => {
        const ex = await as(saToken, request(app).get(api(`/exportable-indicators?year_bh=${YEAR}`)));
        expect(ex.status).toBe(200);
        expect(findInd(ex.body.data, 'id').result_formula).toBe(FORMULA);

        const fb = await as(saToken, request(app).get(api('/form-schemas/all-indicators')));
        expect(fb.status).toBe(200);
        expect(findInd(fb.body.data, 'id').result_formula).toBe(FORMULA);

        const mg = await as(saToken, request(app).get(api(`/kpi-results/manage?year_bh=${YEAR}&month_from=10&month_to=9`)));
        expect(mg.status).toBe(200);
        expect(findInd(mg.body.data).result_formula).toBe(FORMULA);
    });

    test('✅ รายงานสถานะการบันทึก (รายตัวชี้วัด)', async () => {
        const res = await as(saToken, request(app).get(api(`/report/recording-status?year_bh=${YEAR}`)));
        expect(res.status).toBe(200);
        expect(findInd(res.body.data).result_formula).toBe(FORMULA);
    });
});
