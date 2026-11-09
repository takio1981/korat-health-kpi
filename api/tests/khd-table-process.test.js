/**
 * เทียบ table_process กับ KHD (9 พ.ย. 2569) — KHD จำลอง (ห้ามเชื่อม KHD จริง)
 *   - GET /report-compare: ชื่อเดียวกัน (ไม่สนช่องว่าง/ตัวพิมพ์) แต่ table_process ต่าง → แถว Local status 'tp_different' + khd_table_process,
 *     แถว KHD ไม่อยู่ใน "ยังไม่มีใน Local" | ชื่อซ้ำฝั่งใดฝั่งหนึ่ง = ไม่จับคู่ (ไม่เดา)
 *   - POST /indicators/apply-khd-table-process: ตรวจชื่อตรง, table_process ไม่ซ้ำ, ไม่มีตารางที่ใช้ชื่อเดิม, สิทธิ์แก้ไขตัวชี้วัด
 */
const mockReports = [
    { report_id: 950001, report_name: 'test_khdtp  ตัวชี้วัด X', report_code: 'KHD_TP_X', table_process: 'test_khdtp_khd_x', data_source: 'excel', is_active: 1 },
    { report_id: 950002, report_name: 'test_khdtp ตัวชี้วัด Y', report_code: 'KHD_TP_Y', table_process: 'test_khdtp_khd_y', data_source: 'excel', is_active: 1 },
    { report_id: 950003, report_name: 'test_khdtp ตัวชี้วัด Z', report_code: 'KHD_TP_Z', table_process: 'test_khdtp_khd_z', data_source: 'excel', is_active: 1 },
    { report_id: 950004, report_name: 'test_khdtp ตัวชี้วัด W', report_code: 'KHD_TP_W', table_process: 'test_khdtp_dup', data_source: 'excel', is_active: 1 },
];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/FROM report_fiscal_year_config/.test(s)) return [[]];
            if (/SELECT \* FROM reports WHERE data_source = 'excel'/.test(s)) return [mockReports];
            if (/FROM reports WHERE report_id = \? AND data_source = 'excel'/.test(s)) return [mockReports.filter(r => r.report_id === Number(params[0]))];
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
const add = async (name, tp) => (await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active) VALUES (?, ?, 1)', [name, tp]))[0].insertId;
const apply = (t, body) => request(app).post(api('/indicators/apply-khd-table-process')).set('Authorization', `Bearer ${t}`).send(body);

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
    ids.x = await add('test_khdtp ตัวชี้วัด x', 'test_khdtp_local_x');      // ชื่อเดียวกับ KHD (ต่างช่องว่าง/ตัวพิมพ์)
    ids.y1 = await add('test_khdtp ตัวชี้วัด Y', 'test_khdtp_local_y1');    // ชื่อซ้ำ 2 ตัว → ไม่จับคู่
    ids.y2 = await add('test_khdtp ตัวชี้วัด Y', 'test_khdtp_local_y2');
    ids.z = await add('test_khdtp ตัวชี้วัด Z', 'test_khdtp_local_z');      // มีตารางชื่อเดิม → เปลี่ยนไม่ได้
    ids.w = await add('test_khdtp ตัวชี้วัด W', 'test_khdtp_local_w');      // table_process ของ KHD ถูกตัวอื่นใช้แล้ว
    ids.dup = await add('test_khdtp อื่น', 'test_khdtp_dup');
    await db.query('CREATE TABLE test_khdtp_local_z (hospcode VARCHAR(5))');
});
afterAll(async () => {
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdtp\\_%'");
    await db.query('DROP TABLE IF EXISTS test_khdtp_local_z');
    await cleanupTestUsers(db);
});

describe('GET /report-compare — ชื่อเดียวกันแต่ table_process ต่างกัน', () => {
    test('จับคู่ด้วยชื่อ (ไม่สนช่องว่าง/ตัวพิมพ์) และตัดแถว KHD ออกจาก "ยังไม่มีใน Local" | ชื่อซ้ำ = ไม่จับคู่', async () => {
        const res = await request(app).get(api('/report-compare?year_bh=2570')).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
        const byTp = (tp) => res.body.items.find(i => i.table_process === tp);
        expect(byTp('test_khdtp_local_x')).toEqual(expect.objectContaining({ status: 'tp_different', khd_report_id: 950001, khd_table_process: 'test_khdtp_khd_x' }));
        expect(byTp('test_khdtp_khd_x')).toBeUndefined();
        expect(byTp('test_khdtp_local_y1').status).toBe('missing_remote');
        expect(byTp('test_khdtp_khd_y').status).toBe('missing_local');
        expect(byTp('test_khdtp_local_z').status).toBe('tp_different');
        // KHD W ใช้ table_process เดียวกับตัวชี้วัดอื่นในระบบ → จับคู่ด้วย table_process ก่อน (= ชื่อต่างกัน) ไม่จับคู่ซ้ำด้วยชื่อ
        expect(byTp('test_khdtp_dup').status).toBe('different');
        expect(byTp('test_khdtp_local_w').status).toBe('missing_remote');
        expect(res.body.summary.tp_different).toBeGreaterThanOrEqual(2);   // x, z
    });
});

describe('POST /indicators/apply-khd-table-process', () => {
    test('✅ ใช้ table_process ของ KHD + รหัส + ลิงก์ KHD', async () => {
        const res = await apply(saToken, { id: ids.x, khd_report_id: 950001 });
        expect(res.status).toBe(200);
        const [[r]] = await db.query('SELECT table_process, kpi_indicators_code, khd_report_id FROM kpi_indicators WHERE id = ?', [ids.x]);
        expect(r).toEqual({ table_process: 'test_khdtp_khd_x', kpi_indicators_code: 'KHD_TP_X', khd_report_id: 950001 });
        expect((await apply(saToken, { id: ids.x, khd_report_id: 950001 })).status).toBe(400);   // ตรงกันอยู่แล้ว
    });
    test('ด่านตรวจ: ชื่อไม่ตรง 400 | มีตารางชื่อเดิม 409 | table_process ถูกใช้แล้ว 409 | ไม่มีสิทธิ์ 403 — ไม่เปลี่ยนค่า', async () => {
        expect((await apply(saToken, { id: ids.y1, khd_report_id: 950003 })).body.code).toBe('NAME_MISMATCH');
        const z = await apply(saToken, { id: ids.z, khd_report_id: 950003 });
        expect([z.status, z.body.code, z.body.tables]).toEqual([409, 'OLD_TABLES_EXIST', ['test_khdtp_local_z']]);
        const w = await apply(saToken, { id: ids.w, khd_report_id: 950004 });
        expect([w.status, w.body.code]).toEqual([409, 'TP_IN_USE']);
        expect((await apply(hosToken, { id: ids.w, khd_report_id: 950004 })).status).toBe(403);
        const [[zr]] = await db.query('SELECT table_process FROM kpi_indicators WHERE id = ?', [ids.z]);
        expect(zr.table_process).toBe('test_khdtp_local_z');
    });
});
