/**
 * เทียบ/ปรับ "หน่วยงาน" และ "หมวดหมู่หลัก" ของตัวชี้วัดกับ KHD (11 พ.ย. 2569)
 *   - services/khd-org.js: แปลงค่าข้อความของ KHD (reports.dept / main_indicator) เป็น id ด้วยตัวจับคู่เดียวกับเพิ่มตัวชี้วัดจาก KHD
 *     ตรง = true / ต่าง = false / ไม่ระบุ · ยังจับคู่ไม่ได้ · ตั้งว่าไม่ต้องจับคู่ = null (ไม่นับว่าต่าง)
 *   - POST /indicators/apply-khd-org: server อ่าน KHD ใหม่ ปรับเฉพาะส่วนที่เลือก, เทียบไม่ได้ = ข้าม (ไม่ล้างค่าเดิม) — KHD จำลอง (ห้ามเชื่อม KHD จริง)
 */
const mockReports = [
    { report_id: 980001, table_process: 'test_khdorg_a', report_code: 'TEST_KHDORG_A', data_source: 'excel', dept: 'TESTORG', main_indicator: 'test_khdorg หมวด X' },
    { report_id: 980002, table_process: 'test_khdorg_b', report_code: 'TEST_KHDORG_B', data_source: 'excel', dept: 'ไม่มีในระบบ_test_khdorg', main_indicator: '' },
];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/FROM reports WHERE data_source = 'excel' AND LENGTH\(report_code\) = LENGTH\(table_process\) AND table_process IN \(\?\)/.test(s))
                return [mockReports.filter(r => params[0].includes(r.table_process))];
            throw new Error('KHD จำลองไม่รองรับคำสั่ง: ' + s.slice(0, 120));
        }
    })
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { buildKhdResolver } = require('../khd-mapping');
const { compareKhdOrg, khdOrgUpdate } = require('../services/khd-org');

describe('services/khd-org.js', () => {
    const resolver = buildKhdResolver({
        departments: [{ id: 1, dept_code: 'NCD', dept_name: 'กลุ่มงานโรคไม่ติดต่อ' }, { id: 2, dept_code: 'ยสต.', dept_name: 'กลุ่มงานยุทธศาสตร์' }],
        mainIndicators: [{ id: 10, main_indicator_name: 'หมวด ก', yut_id: 3 }],
        strategies: [], mappings: [],
    });
    test('ตรง / ต่าง / เทียบไม่ได้ (ไม่ระบุ · ยังจับคู่ไม่ได้)', () => {
        const c = compareKhdOrg(resolver, { dept: 'ncd', main_indicator: 'หมวด ก' }, { dept_id: 1, main_indicator_id: 10 });
        expect([c.dept_match, c.main_match]).toEqual([true, true]);
        expect(c.khd_dept_name).toBe('กลุ่มงานโรคไม่ติดต่อ');
        const d = compareKhdOrg(resolver, { dept: 'ยสต.', main_indicator: 'หมวด ก' }, { dept_id: 1, main_indicator_id: null });
        expect([d.dept_match, d.khd_dept_id, d.main_match]).toEqual([false, 2, false]);
        const u = compareKhdOrg(resolver, { dept: 'ไม่มี', main_indicator: null }, { dept_id: 1, main_indicator_id: 10 });
        expect([u.dept_match, u.khd_dept_status, u.main_match, u.khd_main_status]).toEqual([null, 'unmatched', null, 'empty']);
    });
    test('ค่าที่จะปรับ: เฉพาะส่วนที่ต่าง + เหตุผลเมื่อข้าม', () => {
        expect(khdOrgUpdate(resolver, { dept: 'ยสต.', main_indicator: 'หมวด ก' }, { dept_id: 1, main_indicator_id: 10 }, ['dept', 'main']).set).toEqual({ dept_id: 2 });
        const skip = khdOrgUpdate(resolver, { dept: 'ไม่มี', main_indicator: '' }, { dept_id: 1 }, ['dept', 'main']);
        expect(skip.set).toEqual({});
        expect(skip.reason).toMatch(/ยังจับคู่กับระบบไม่ได้/);
        expect(skip.reason).toMatch(/KHD ไม่ได้ระบุหมวดหมู่หลัก/);
    });
});

let app, db, saToken, hosToken, deptId, mainId, otherDept;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const row = async (id) => (await db.query('SELECT dept_id, main_indicator_id FROM kpi_indicators WHERE id = ?', [id]))[0][0];
const apply = (token, body) => request(app).post(api('/indicators/apply-khd-org')).set('Authorization', `Bearer ${token}`).send(body);

describe('POST /indicators/apply-khd-org', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        db = require('../db');
        await migrationsReady;
        await cleanupTestUsers(db);
        await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdorg\\_%'");
        await db.query("DELETE FROM kpi_main_indicators WHERE main_indicator_name LIKE 'test\\_khdorg%'");
        await db.query("DELETE FROM departments WHERE dept_code = 'TESTORG'");
        deptId = (await db.query("INSERT INTO departments (dept_name, dept_code, is_active) VALUES ('test_khdorg กลุ่มงาน', 'TESTORG', 1)"))[0].insertId;
        mainId = (await db.query("INSERT INTO kpi_main_indicators (main_indicator_name, is_active) VALUES ('test_khdorg หมวด X', 1)"))[0].insertId;
        [[{ id: otherDept }]] = await db.query('SELECT id FROM departments WHERE id <> ? ORDER BY id LIMIT 1', [deptId]);
        const sa = await ensureTestUser(db, { username: 'test_khdorg_sa', role: 'super_admin' });
        saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
        const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
        const ah = await ensureTestUser(db, { username: 'test_khdorg_hos', role: 'admin_hos', hospcode: h.hoscode });
        hosToken = makeToken({ userId: ah.id, username: ah.username, role: 'admin_hos', deptId: 1, hospcode: h.hoscode });
        const add = async (name, tp) => (await db.query(
            'INSERT INTO kpi_indicators (kpi_indicators_name, table_process, dept_id, main_indicator_id, is_active) VALUES (?, ?, ?, NULL, 1)', [name, tp, otherDept]))[0].insertId;
        ids.a = await add('test_khdorg A', 'test_khdorg_a');
        ids.b = await add('test_khdorg B', 'test_khdorg_b');
        ids.c = await add('test_khdorg C', 'test_khdorg_c');
    });
    afterAll(async () => {
        await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdorg\\_%'");
        await db.query('DELETE FROM kpi_main_indicators WHERE id = ?', [mainId]);
        await db.query('DELETE FROM departments WHERE id = ?', [deptId]);
        await cleanupTestUsers(db);
    });

    test('ปรับเฉพาะหน่วยงาน — หมวดหมู่หลักไม่เปลี่ยน', async () => {
        const res = await apply(saToken, { ids: [ids.a], parts: ['dept'] });
        expect(res.status).toBe(200);
        expect(await row(ids.a)).toEqual({ dept_id: deptId, main_indicator_id: null });
    });
    test('ปรับหมวดหมู่หลัก | ยังจับคู่ไม่ได้ = ข้าม (ไม่ล้างค่าเดิม) | ไม่พบใน KHD = ข้าม', async () => {
        const res = await apply(saToken, { ids: [ids.a, ids.b, ids.c], parts: ['dept', 'main'] });
        expect(res.status).toBe(200);
        expect(res.body.updated.map(u => u.id)).toEqual([ids.a]);
        expect(await row(ids.a)).toEqual({ dept_id: deptId, main_indicator_id: mainId });
        expect(await row(ids.b)).toEqual({ dept_id: otherDept, main_indicator_id: null });
        const why = Object.fromEntries(res.body.skipped.map(s => [s.id, s.reason]));
        expect(why[ids.b]).toMatch(/ยังจับคู่กับระบบไม่ได้/);
        expect(why[ids.c]).toBe('ไม่พบใน KHD');
        const [[log]] = await db.query("SELECT COUNT(*) AS n FROM system_logs WHERE action_type = 'APPLY_KHD_ORG' AND new_value LIKE ?", [`%"id":${ids.a}%`]);
        expect(log.n).toBeGreaterThan(0);
    });
    test('ข้อมูลไม่ครบ = 400 | ไม่มีสิทธิ์แก้ไขหน้าจัดการตัวชี้วัด = 403', async () => {
        expect((await apply(saToken, { ids: [ids.a], parts: ['xyz'] })).status).toBe(400);
        expect((await apply(saToken, { ids: [], parts: ['dept'] })).status).toBe(400);
        expect((await apply(hosToken, { ids: [ids.a], parts: ['dept'] })).status).toBe(403);
    });
});
