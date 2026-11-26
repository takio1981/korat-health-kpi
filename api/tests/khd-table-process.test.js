/**
 * เทียบ table_process กับ KHD (9 พ.ย. 2569, ปรับ 26 พ.ย. 2569: คีย์จับคู่ = report_id ↔ รหัสอ้างอิง, table_process ใช้ร่วมกันได้) — KHD จำลอง
 *   - GET /report-compare: คู่ที่รหัสอ้างอิงตรงแต่ table_process ต่าง = 'tp_different' + khd_table_process (ข้อมูลประกอบ ไม่ใช่คีย์)
 *     | KHD หลายรายงาน/ตัวชี้วัดหลายตัวใช้ table_process เดียวกันได้ — แต่ละตัวเทียบกับรายงานตามรหัสของตัวเอง (ไม่เกิด "ชื่อต่างกัน" ปลอม)
 *   - POST /indicators/apply-khd-table-process: รหัสอ้างอิงต้องตรงกับรายงาน (REF_MISMATCH), ใช้ table_process ร่วมกับตัวชี้วัดอื่นได้,
 *     ตารางชื่อเดิมที่ไม่มีตัวชี้วัดอื่นใช้ = 409 OLD_TABLES_EXIST, สิทธิ์แก้ไขตัวชี้วัด
 *   - POST /report-compare/sync ("ใช้ชื่อ KHD"): เปลี่ยนชื่อเฉพาะตัวชี้วัดที่รหัสอ้างอิงตรง (ไม่ใช่ทุกตัวที่ใช้ table_process เดียวกัน)
 */
const mockReports = [
    { report_id: 950001, report_name: 'test_khdtp ตัวชี้วัด X', report_code: 'KHD_TP_X', table_process: 'test_khdtp_khd_x', data_source: 'excel', is_active: 1 },
    { report_id: 950003, report_name: 'test_khdtp ตัวชี้วัด Z', report_code: 'KHD_TP_Z', table_process: 'test_khdtp_khd_z', data_source: 'excel', is_active: 1 },
    // KHD หลายรายงานใช้ table_process เดียวกัน (ข้อมูลจริง excellence_indicator_2_38_4 = 6 รายงาน) — ระบบก็ใช้ตารางเดียวกันได้
    { report_id: 950011, report_name: 'test_khdtp ตัวชี้วัด S1', report_code: 'test-khdtp-shared', table_process: 'test_khdtp_shared', data_source: 'excel', is_active: 1, target_percentage: 80, target_condition: 'GTE' },
    { report_id: 950012, report_name: 'test_khdtp ตัวชี้วัด S2', report_code: 'test-khdtp-s2', table_process: 'test_khdtp_shared', data_source: 'excel', is_active: 1, target_percentage: 90, target_condition: 'GTE' },
];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            const mockY = require('./lib/khd-year-mock').khdYearQuery(s, params, mockReports, mockReports.map(r => ({ report_id: r.report_id, fiscal_year: 2570 })));
            if (mockY) return mockY;
            if (/FROM report_fiscal_year_config/.test(s)) return [[]];
            if (/FROM reports WHERE report_id = \? AND data_source = 'excel'$/.test(s.trim())) return [mockReports.filter(r => r.report_id === Number(params[0]) && r.data_source === 'excel')];
            if (/FROM reports WHERE report_id IN \(\?\)$/.test(s.trim())) return [mockReports.filter(r => params[0].map(Number).includes(r.report_id))];
            throw new Error('KHD จำลองไม่รองรับคำสั่ง: ' + s.slice(0, 120));
        }
    })
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken, hosToken;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const add = async (name, tp, ref) => (await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, table_process, kpi_indicators_id, is_active) VALUES (?, ?, ?, 1)', [name, tp, ref]))[0].insertId;
const apply = (t, body) => request(app).post(api('/indicators/apply-khd-table-process')).set('Authorization', `Bearer ${t}`).send(body);
const rowOf = async (id) => (await db.query('SELECT kpi_indicators_name AS name, table_process, kpi_indicators_code, khd_report_id FROM kpi_indicators WHERE id = ?', [id]))[0][0];

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdtp\\_%'");
    await db.query('DROP TABLE IF EXISTS test_khdtp_local_z');
    const sa = await ensureTestUser(db, { username: 'test_khdtp_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    const ah = await ensureTestUser(db, { username: 'test_khdtp_hos', role: 'admin_hos', hospcode: h.hoscode });
    hosToken = makeToken({ userId: ah.id, username: ah.username, role: 'admin_hos', deptId: 1, hospcode: h.hoscode });
    ids.x = await add('test_khdtp ชื่อในระบบ X', 'test_khdtp_local_x', '950001');   // รหัสตรง ชื่อ+table_process ต่าง
    ids.z = await add('test_khdtp ตัวชี้วัด Z', 'test_khdtp_local_z', '950003');     // มีตารางชื่อเดิม (ไม่มีตัวอื่นใช้) → เปลี่ยนไม่ได้
    ids.z2 = await add('test_khdtp ตัวชี้วัด Z2', 'test_khdtp_local_zz', null);      // ไม่มีรหัส → เปลี่ยนไม่ได้
    ids.s1 = await add('test_khdtp ตัวชี้วัด S1', 'test_khdtp_shared', '950011');    // ใช้ตารางเดียวกับ S2
    ids.s2 = await add('test_khdtp ตัวชี้วัด S2', 'test_khdtp_local_s2', '950012');
    ids.n = await add('test_khdtp ไม่ได้ตั้งรหัส', 'test_khdtp_khd_x', null);         // table_process ตรงกับ X แต่ไม่มีรหัส = ไม่จับคู่
    await db.query('CREATE TABLE test_khdtp_local_z (hospcode VARCHAR(5))');
});
afterAll(async () => {
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdtp\\_%'");
    await db.query('DROP TABLE IF EXISTS test_khdtp_local_z');
    await cleanupTestUsers(db);
});

describe('GET /report-compare — table_process เป็นข้อมูลประกอบ (ไม่ใช่คีย์)', () => {
    let res;
    const byLocal = (id) => res.body.items.find(i => i.local_id === id);
    beforeAll(async () => {
        res = await request(app).get(api('/report-compare?year_bh=2570')).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
    });
    test('คู่จากรหัสอ้างอิง: table_process ต่าง = tp_different | table_process ตรงแต่ไม่มีรหัส = ไม่จับคู่', () => {
        expect(byLocal(ids.x)).toEqual(expect.objectContaining({ status: 'tp_different', khd_report_id: 950001, khd_table_process: 'test_khdtp_khd_x', name_match: false }));
        expect(byLocal(ids.n)).toEqual(expect.objectContaining({ status: 'missing_remote', khd_report_id: null }));
    });
    test('ตัวชี้วัด 2 ตัวกับรายงาน KHD 2 รายการที่ใช้ table_process เดียวกัน — เทียบตามรหัสของตัวเอง', () => {
        expect(byLocal(ids.s1)).toEqual(expect.objectContaining({ status: 'match', khd_report_id: 950011, criteria_match: false, khd_target_percentage: 80 }));
        expect(byLocal(ids.s2)).toEqual(expect.objectContaining({ status: 'tp_different', khd_report_id: 950012, khd_table_process: 'test_khdtp_shared',
            khd_tp_shared: 2, khd_tp_used_by: expect.objectContaining({ id: ids.s1, count: 1 }), khd_code_matches_tp: false, khd_target_percentage: 90 }));
        expect(byLocal(ids.s2)).not.toHaveProperty('_local');
        expect(res.body.items.some(i => i.status === 'missing_local' && [950011, 950012].includes(i.khd_report_id))).toBe(false);
        expect(res.body.summary.tp_different).toBeGreaterThanOrEqual(3);   // x, z, s2
    });
});

describe('POST /indicators/apply-khd-table-process', () => {
    test('✅ table_process ที่ตัวชี้วัดอื่นใช้อยู่แล้ว = ใช้ร่วมกันได้ + รหัส + ลิงก์ KHD', async () => {
        const res = await apply(saToken, { id: ids.s2, khd_report_id: 950012 });
        expect(res.status).toBe(200);
        expect(await rowOf(ids.s2)).toEqual(expect.objectContaining({ table_process: 'test_khdtp_shared', kpi_indicators_code: 'test-khdtp-s2', khd_report_id: 950012 }));
        expect((await apply(saToken, { id: ids.s2, khd_report_id: 950012 })).status).toBe(400);   // ตรงกันอยู่แล้ว
        // x: ชื่อต่างจาก KHD ก็ปรับได้ (คู่จากรหัสอ้างอิง) และ table_process ใหม่ซ้ำกับตัวชี้วัด n ได้
        expect((await apply(saToken, { id: ids.x, khd_report_id: 950001 })).status).toBe(200);
        expect((await rowOf(ids.x)).table_process).toBe('test_khdtp_khd_x');
    });
    test('ด่านตรวจ: รหัสไม่ตรง 400 | ตารางชื่อเดิม 409 | ไม่มีสิทธิ์ 403 — ไม่เปลี่ยนค่า', async () => {
        expect((await apply(saToken, { id: ids.z2, khd_report_id: 950003 })).body.code).toBe('REF_MISMATCH');
        const z = await apply(saToken, { id: ids.z, khd_report_id: 950003 });
        expect([z.status, z.body.code, z.body.tables]).toEqual([409, 'OLD_TABLES_EXIST', ['test_khdtp_local_z']]);
        expect((await apply(hosToken, { id: ids.z, khd_report_id: 950003 })).status).toBe(403);
        expect((await rowOf(ids.z)).table_process).toBe('test_khdtp_local_z');
    });
});

describe('POST /report-compare/sync — ใช้ชื่อ KHD ตามรหัสอ้างอิง', () => {
    test('เปลี่ยนชื่อเฉพาะตัวชี้วัดที่รหัสตรง — ตัวอื่นที่ใช้ table_process เดียวกันไม่เปลี่ยน', async () => {
        const res = await request(app).post(api('/report-compare/sync')).set('Authorization', `Bearer ${saToken}`).send({ khd_report_ids: [950001] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({ updated: 1, inserted: 0 }));
        expect((await rowOf(ids.x)).name).toBe('test_khdtp ตัวชี้วัด X');
        expect((await rowOf(ids.n)).name).toBe('test_khdtp ไม่ได้ตั้งรหัส');   // table_process เดียวกัน แต่ไม่มีรหัส
    });
});
