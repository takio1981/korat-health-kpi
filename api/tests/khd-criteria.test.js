/**
 * Integration tests (database ทดสอบ + KHD จำลอง) — ปรับเกณฑ์ของตัวชี้วัดให้เท่ากับ KHD (POST /indicators/apply-khd-criteria, 19 ต.ค. 2569)
 *   - อ่านเกณฑ์จาก KHD ที่ server (ปีงบที่เลือก: report_fiscal_year_config ก่อน แล้วจึง reports) — ไม่แตะเป้าหมาย (target_percentage)
 *   - KHD ไม่มีเกณฑ์ / ไม่พบใน KHD → ข้าม ไม่ล้างค่าเดิม
 */
const mockReports = [
    { report_id: 980001, table_process: 'test_khdcrit_a', report_code: 'TEST_KHDCRIT_A', data_source: 'excel', target_percentage: '80.00', target_condition: 'GTE' },
    { report_id: 980002, table_process: 'test_khdcrit_b', report_code: 'TEST_KHDCRIT_B', data_source: 'excel', target_percentage: null, target_condition: null },
];
const mockFy = [{ report_id: 980001, fiscal_year: 2570, target_percentage: '85.50', target_condition: 'LTE' }];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/FROM report_fiscal_year_config WHERE report_id = \? AND fiscal_year = \?/.test(s))
                return [mockFy.filter(r => r.report_id === Number(params[0]) && String(r.fiscal_year) === String(params[1]))];
            if (/FROM reports WHERE data_source = 'excel' AND LENGTH\(report_code\) = LENGTH\(table_process\) AND table_process IN \(\?\)/.test(s))
                return [mockReports.filter(r => params[0].includes(r.table_process))];
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
const row = async (id) => (await db.query('SELECT criterion, target_condition, target_percentage FROM kpi_indicators WHERE id = ?', [id]))[0][0];
const add = async (name, tp, extra = {}) => (await db.query(
    'INSERT INTO kpi_indicators (kpi_indicators_name, table_process, criterion, target_condition, target_percentage, is_active) VALUES (?, ?, ?, ?, ?, 1)',
    [name, tp, extra.criterion ?? '70', extra.cond ?? 'GTE', '60']))[0].insertId;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdcrit\\_%'");
    const sa = await ensureTestUser(db, { username: 'test_khdcrit_sa', role: 'super_admin', session_id: 'sess-khdcrit-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-khdcrit-sa' });
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    const ah = await ensureTestUser(db, { username: 'test_khdcrit_hos', role: 'admin_hos', hospcode: h.hoscode, session_id: 'sess-khdcrit-hos' });
    hosToken = makeToken({ userId: ah.id, username: ah.username, role: 'admin_hos', deptId: 1, hospcode: h.hoscode, sessionId: 'sess-khdcrit-hos' });
    ids.a = await add('test_khdcrit A', 'test_khdcrit_a');
    ids.b = await add('test_khdcrit B', 'test_khdcrit_b');
    ids.c = await add('test_khdcrit C', 'test_khdcrit_c');
});

afterAll(async () => {
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdcrit\\_%'");
    await cleanupTestUsers(db);
});

const apply = (token, body) => request(app).post(api('/indicators/apply-khd-criteria')).set('Authorization', `Bearer ${token}`).send(body);

describe('ปรับเกณฑ์ให้เท่ากับ KHD', () => {
    test('ใช้เกณฑ์ของปีงบที่เลือกจาก report_fiscal_year_config — ไม่แตะเป้าหมาย / ข้ามตัวที่ KHD ไม่มีเกณฑ์หรือไม่พบใน KHD', async () => {
        const res = await apply(saToken, { ids: [ids.a, ids.b, ids.c], year_bh: '2570' });
        expect(res.status).toBe(200);
        expect(res.body.updated.map(u => u.id)).toEqual([ids.a]);
        expect(res.body.skipped.map(s => s.reason).sort()).toEqual(['KHD ไม่มีเกณฑ์', 'ไม่พบใน KHD']);
        expect(await row(ids.a)).toEqual({ criterion: '85.5', target_condition: 'LTE', target_percentage: '60' });
        expect(await row(ids.b)).toEqual(expect.objectContaining({ criterion: '70', target_condition: 'GTE' }));
    });

    test('ปีงบที่ไม่มีค่าเฉพาะปี → ใช้เกณฑ์ตั้งต้นของ reports / ตรงกันอยู่แล้ว = ข้าม', async () => {
        let res = await apply(saToken, { ids: [ids.a], year_bh: '2571' });
        expect(await row(ids.a)).toEqual(expect.objectContaining({ criterion: '80', target_condition: 'GTE' }));
        res = await apply(saToken, { ids: [ids.a], year_bh: '2571' });
        expect(res.body.updated).toEqual([]);
        expect(res.body.skipped[0].reason).toBe('ตรงกันอยู่แล้ว');
    });

    test('🛡️ ต้องมีสิทธิ์แก้ไขตัวชี้วัด และต้องระบุรายการ', async () => {
        expect((await apply(hosToken, { ids: [ids.a] })).status).toBe(403);
        expect((await apply(saToken, { ids: [] })).status).toBe(400);
    });
});
