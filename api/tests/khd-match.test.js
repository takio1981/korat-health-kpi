/**
 * เทียบตัวชี้วัดกับ KHD โดยตั้งต้นจาก report_fiscal_year_config ของปีงบ + จับคู่ด้วย report_id (24 พ.ย. 2569) — KHD จำลอง (ห้ามเชื่อม KHD จริง)
 *   - services/khd-match.js matchLocalsToKhd: รหัสอ้างอิง (kpi_indicators_id) → khd_report_id → table_process, ตัวชี้วัด 1 ตัว = รายงาน 1 รายการ
 *   - GET /report-compare: เฉพาะรายงานของปีงบ (ปีอื่นไม่แสดง) และเฉพาะ data_source = 'excel' (key_in — รายงาน hdc ไม่แสดง, ตัวชี้วัด hdc ของระบบไม่นำมาเทียบ),
 *     ref_match/ref_conflict, ตัวชี้วัดนอกปีงบ = missing_remote + khd_other_year
 *   - POST /indicators/apply-khd-ref: ตั้งรหัสอ้างอิง + khd_report_id + data_source, ข้ามรหัสที่ตัวอื่นใช้แล้ว/นอกปีงบ, log, สิทธิ์แก้ไขตัวชี้วัด
 */
const mockReports = [
    { report_id: 940001, report_name: 'test_khdmatch A', report_code: 'TEST_KHDMATCH_A', table_process: 'test_khdmatch_a', data_source: 'excel', is_active: 1 },
    { report_id: 940002, report_name: 'test_khdmatch B', report_code: 'TEST_KHDMATCH_B', table_process: 'test_khdmatch_b', data_source: 'hdc', is_active: 1 },
    { report_id: 940003, report_name: 'test_khdmatch C', report_code: 'TEST_KHDMATCH_C', table_process: 'test_khdmatch_c', data_source: 'excel', is_active: 1 },
    { report_id: 940004, report_name: 'test_khdmatch D', report_code: 'TEST_KHDMATCH_D', table_process: 'test_khdmatch_d', data_source: 'excel', is_active: 1 },
    { report_id: 940009, report_name: 'test_khdmatch OLD', report_code: 'TEST_KHDMATCH_OLD', table_process: 'test_khdmatch_old', data_source: 'excel', is_active: 1 },
];
const mockFy = [
    { report_id: 940001, fiscal_year: 2570, is_active: 1 }, { report_id: 940002, fiscal_year: 2570, is_active: 1 },
    { report_id: 940003, fiscal_year: 2570, is_active: 0 }, { report_id: 940004, fiscal_year: 2570, is_active: 1 },
    { report_id: 940009, fiscal_year: 2569, is_active: 1 },   // รายงานปีงบที่แล้วเท่านั้น
];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            const mockY = require('./lib/khd-year-mock').khdYearQuery(s, params, mockReports, mockFy);
            if (mockY) return mockY;
            throw new Error('KHD จำลองไม่รองรับคำสั่ง: ' + s.slice(0, 120));
        }
    })
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { matchLocalsToKhd } = require('../services/khd-match');

describe('matchLocalsToKhd (ฟังก์ชันล้วน)', () => {
    const k = (id, tp, name) => ({ report_id: id, table_process: tp, report_name: name || 'R' + id, report_code: tp });
    test('ลำดับ รหัสอ้างอิง > khd_report_id > table_process, ตัวชี้วัด 1 ตัว = รายงาน 1 รายการ', () => {
        const khd = [k(1, 'tp1'), k(2, 'tp2'), k(3, 'tp3')];
        const locals = [
            { id: 10, kpi_indicators_id: '2', khd_report_id: 1, table_process: 'tp1' },   // รหัสอ้างอิงชนะ → 2 (ขัดกับ khd_report_id 1)
            { id: 11, kpi_indicators_id: null, khd_report_id: 1, table_process: 'zz' },   // khd_report_id → 1
            { id: 12, kpi_indicators_id: ' 2 ', khd_report_id: null, table_process: 'tp2' }, // รายงาน 2 ถูกจับแล้ว → ไม่ได้ (ไม่มี tp อื่นว่าง)
            { id: 13, kpi_indicators_id: 'abc', khd_report_id: null, table_process: 'tp3' }, // table_process → 3
        ];
        const r = matchLocalsToKhd(locals, khd);
        const by = Object.fromEntries(r.pairs.map(p => [p.local.id, [p.khd.report_id, p.match_by]]));
        expect(by).toEqual({ 10: [2, 'kpi_indicators_id'], 11: [1, 'khd_report_id'], 13: [3, 'table_process'] });
        expect(r.unmatchedLocals.map(l => l.id)).toEqual([12]);
        const p10 = r.pairs.find(p => p.local.id === 10);
        expect([p10.ref_match, p10.link_match, p10.ref_conflict, p10.tp_match]).toEqual([true, false, true, false]);
        expect(r.pairs.find(p => p.local.id === 13).ref_match).toBe(false);
    });
    test('table_process ร่วมกันในปีงบ: ชื่อตรงมาก่อน', () => {
        const khd = [k(1, 'tp', 'X'), k(2, 'tp', 'Y')];
        const r = matchLocalsToKhd([{ id: 1, kpi_indicators_name: 'Y', table_process: 'tp' }], khd);
        expect(r.pairs[0].khd.report_id).toBe(2);
        expect(r.unmatchedKhd.map(x => x.report_id)).toEqual([1]);
    });
});

let app, db, saToken, hosToken;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const add = async (name, tp, ref, link) => (await db.query(
    'INSERT INTO kpi_indicators (kpi_indicators_name, table_process, kpi_indicators_id, khd_report_id, is_active) VALUES (?, ?, ?, ?, 1)',
    [name, tp, ref, link]))[0].insertId;
const refOf = async (id) => (await db.query('SELECT kpi_indicators_id, khd_report_id, data_source FROM kpi_indicators WHERE id = ?', [id]))[0][0];

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_khdmatch\\_');
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_khdmatch%'");
    const sa = await ensureTestUser(db, { username: 'test_khdmatch_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    const ah = await ensureTestUser(db, { username: 'test_khdmatch_hos', role: 'admin_hos', hospcode: h.hoscode });
    hosToken = makeToken({ userId: ah.id, username: ah.username, role: 'admin_hos', deptId: 1, hospcode: h.hoscode });
    ids.a = await add('test_khdmatch A', 'test_khdmatch_a', '940001', 940001);        // ตรงทั้งคู่
    ids.b = await add('test_khdmatch B', 'test_khdmatch_x', '123', null);             // รหัสอ้างอิงผิด + table_process ต่าง → จับด้วยชื่อ
    ids.c = await add('test_khdmatch C', 'test_khdmatch_c', null, null);             // จับด้วย table_process, รหัสอ้างอิงว่าง
    ids.d = await add('test_khdmatch D2', 'test_khdmatch_zz', null, 940004);         // จับด้วย khd_report_id, table_process ต่าง
    ids.old = await add('test_khdmatch OLD', 'test_khdmatch_old', '940009', 940009); // รายงานปีงบที่แล้ว
    ids.dupRef = await add('test_khdmatch dup', 'test_khdmatch_dup', '940003', null); // ใช้รหัส 940003 อยู่แล้ว (แต่ชื่อ/tp ไม่ตรง C)
    ids.hdc = await add('test_khdmatch H', 'test_khdmatch_h', null, 940002);            // ตัวชี้วัด hdc ของระบบ (ลิงก์รายงาน hdc)
    await db.query("UPDATE kpi_indicators SET data_source = 'hdc' WHERE id = ?", [ids.hdc]);
}, 60000);
afterAll(async () => {
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_khdmatch%'");
    await cleanupTestUsers(db, 'test\\_khdmatch\\_');
});

describe('GET /report-compare — ตารางหลัก report_fiscal_year_config', () => {
    test('เฉพาะรายงานของปีงบ + เฉพาะ excel (key_in), จับคู่ด้วยรหัส, ตัวชี้วัดนอกปีงบ = missing_remote + khd_other_year', async () => {
        const res = await request(app).get(api('/report-compare?year_bh=2570')).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
        const items = res.body.items;
        expect(items.some(i => i.khd_report_id === 940009)).toBe(false);   // รายงานปีงบ 2569 ไม่แสดง
        expect(items.some(i => i.khd_report_id === 940002)).toBe(false);   // รายงาน hdc ไม่แสดง
        expect(res.body.summary).toEqual(expect.objectContaining({ khd_year_total: 3, khd_year_active: 2, by_source: { excel: 3 } }));
        expect(res.body.summary.local_hdc_skipped).toBeGreaterThanOrEqual(1);
        const byLocal = (id) => items.find(i => i.local_id === id);
        expect(byLocal(ids.a)).toEqual(expect.objectContaining({ status: 'match', match_by: 'kpi_indicators_id', ref_match: true, link_match: true }));
        // รหัสอ้างอิง 940003 ของ dupRef ชนะ table_process ของ C → C ไม่ได้คู่ (ตัวชี้วัด 1 ตัว = รายงาน 1 รายการ)
        expect(byLocal(ids.dupRef)).toEqual(expect.objectContaining({ khd_report_id: 940003, match_by: 'kpi_indicators_id', status: 'tp_different', khd_is_active: 0 }));
        expect(byLocal(ids.d)).toEqual(expect.objectContaining({ khd_report_id: 940004, match_by: 'khd_report_id', ref_match: false, status: 'tp_different', khd_table_process: 'test_khdmatch_d' }));
        expect(byLocal(ids.old)).toEqual(expect.objectContaining({ status: 'missing_remote', khd_other_year: ['2569'] }));
        expect(byLocal(ids.c)).toEqual(expect.objectContaining({ status: 'missing_remote', khd_other_year: [] }));
        // B: ชื่อตรงกับรายงาน hdc เท่านั้น → ไม่จับคู่ (hdc ไม่นำมาเทียบ) = ไม่อยู่ในปีงบ KHD
        expect(byLocal(ids.b)).toEqual(expect.objectContaining({ status: 'missing_remote', khd_report_id: null }));
        // ตัวชี้วัด hdc ของระบบไม่แสดงในผลเทียบ
        expect(byLocal(ids.hdc)).toBeUndefined();
        expect(items.every(i => i.khd_data_source == null || i.khd_data_source === 'excel')).toBe(true);
        expect(res.body.summary.ref_different).toBeGreaterThanOrEqual(1);
    });
});

describe('POST /indicators/apply-khd-ref', () => {
    const post = (tok, body) => request(app).post(api('/indicators/apply-khd-ref')).set('Authorization', `Bearer ${tok}`).send(body);
    test('ตั้งรหัสอ้างอิง/khd_report_id/data_source = KHD | ตรงแล้ว/นอกปีงบ = ข้าม | log', async () => {
        const res = await post(saToken, { ids: [ids.a, ids.d, ids.old, ids.c], year_bh: '2570' });
        expect(res.status).toBe(200);
        expect(res.body.updated.map(u => u.id)).toEqual([ids.d]);
        expect(await refOf(ids.d)).toEqual({ kpi_indicators_id: '940004', khd_report_id: 940004, data_source: 'excel' });
        const why = Object.fromEntries(res.body.skipped.map(s => [s.id, s.reason]));
        expect(why[ids.old]).toBe('ไม่อยู่ในปีงบ 2570 ของ KHD');
        expect(why[ids.c]).toBe('ไม่อยู่ในปีงบ 2570 ของ KHD');
        expect(why[ids.a]).toBe('ตรงกันอยู่แล้ว');
        const [[log]] = await db.query("SELECT COUNT(*) AS n FROM system_logs WHERE action_type = 'APPLY_KHD_REF' AND new_value LIKE ?", [`%"id":${ids.d}%`]);
        expect(log.n).toBeGreaterThanOrEqual(1);
    });
    test('รหัสอ้างอิงชนะ table_process: ตัวชี้วัดที่ถือรหัส 940003 ได้คู่ ตัวที่ table_process ตรงไม่ได้ (ไม่ถูกตั้งรหัสซ้ำ) / สิทธิ์ / ข้อมูลไม่ครบ', async () => {
        const res = await post(saToken, { ids: [ids.c, ids.dupRef], year_bh: '2570' });
        expect(res.body.updated.map(u => u.id)).toEqual([ids.dupRef]);          // khd_report_id ตามรหัสอ้างอิง
        expect(await refOf(ids.dupRef)).toEqual({ kpi_indicators_id: '940003', khd_report_id: 940003, data_source: 'excel' });
        expect((await refOf(ids.c)).kpi_indicators_id).toBeNull();
        expect((await post(hosToken, { ids: [ids.c] })).status).toBe(403);
        expect((await post(saToken, { ids: [] })).status).toBe(400);
    });
});
