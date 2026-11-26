/**
 * เทียบตัวชี้วัดกับ KHD — ตารางหลัก report_fiscal_year_config ของปีงบ (24 พ.ย. 2569) + คีย์จับคู่ = report_id ↔ รหัสอ้างอิง อย่างเดียว (26 พ.ย. 2569)
 * KHD จำลอง (ห้ามเชื่อม KHD จริง)
 *   - services/khd-match.js matchLocalsToKhd: kpi_indicators_id = report_id เท่านั้น (table_process/ชื่อไม่ใช้จับคู่ — table_process ใช้ร่วมกันได้),
 *     รหัสที่แนะนำ (khd_report_id → ชื่อตรงกันรายการเดียว), รหัสซ้ำ = refTaken
 *   - GET /report-compare: เฉพาะรายงานของปีงบ + key_in, ref_suggest / ref_taken_by / suggested_for, ตัวชี้วัดนอกปีงบ = missing_remote + khd_other_year
 *   - POST /indicators/apply-khd-ref: ตั้งรหัสอ้างอิงตามรหัสที่แนะนำ / แก้ลิงก์ khd_report_id ของคู่, ข้ามรหัสซ้ำ/ไม่มีรายงานที่แนะนำ, log, สิทธิ์
 */
const mockReports = [
    { report_id: 940001, report_name: 'test_khdmatch A', report_code: 'TEST_KHDMATCH_A', table_process: 'test_khdmatch_a', data_source: 'excel', is_active: 1 },
    { report_id: 940002, report_name: 'test_khdmatch B', report_code: 'TEST_KHDMATCH_B', table_process: 'test_khdmatch_b', data_source: 'hdc', is_active: 1 },
    { report_id: 940003, report_name: 'test_khdmatch C', report_code: 'TEST_KHDMATCH_C', table_process: 'test_khdmatch_c', data_source: 'excel', is_active: 1 },
    { report_id: 940004, report_name: 'test_khdmatch D', report_code: 'TEST_KHDMATCH_D', table_process: 'test_khdmatch_d', data_source: 'excel', is_active: 1 },
    { report_id: 940005, report_name: 'test_khdmatch E', report_code: 'TEST_KHDMATCH_E', table_process: 'test_khdmatch_a', data_source: 'excel', is_active: 1 }, // table_process เดียวกับ A
    { report_id: 940009, report_name: 'test_khdmatch OLD', report_code: 'TEST_KHDMATCH_OLD', table_process: 'test_khdmatch_old', data_source: 'excel', is_active: 1 },
];
const mockFy = [
    { report_id: 940001, fiscal_year: 2570, is_active: 1 }, { report_id: 940002, fiscal_year: 2570, is_active: 1 },
    { report_id: 940003, fiscal_year: 2570, is_active: 0 }, { report_id: 940004, fiscal_year: 2570, is_active: 1 },
    { report_id: 940005, fiscal_year: 2570, is_active: 1 },
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
    test('จับคู่ด้วยรหัสอ้างอิงเท่านั้น — table_process ตรงกันไม่จับคู่, รหัสซ้ำ = refTaken, ลิงก์ชี้รายงานอื่น = ref_conflict', () => {
        const khd = [k(1, 'tp1'), k(2, 'tp2'), k(3, 'tp3')];
        const locals = [
            { id: 10, kpi_indicators_id: '2', khd_report_id: 1, table_process: 'tp1' },   // คู่กับ 2 (ลิงก์ 1 ค้าง = ref_conflict)
            { id: 11, kpi_indicators_id: null, khd_report_id: 1, table_process: 'zz' },   // ไม่จับคู่ — แนะนำ 1 จากลิงก์
            { id: 12, kpi_indicators_id: ' 2 ', khd_report_id: null, table_process: 'tp2' }, // รหัส 2 ถูกตัวชี้วัด 10 ใช้แล้ว
            { id: 13, kpi_indicators_id: 'abc', khd_report_id: null, table_process: 'tp3' }, // table_process ตรงกับ 3 แต่ไม่จับคู่
        ];
        const r = matchLocalsToKhd(locals, khd);
        expect(r.pairs.map(p => [p.local.id, p.khd.report_id, p.match_by])).toEqual([[10, 2, 'kpi_indicators_id']]);
        const p10 = r.pairs[0];
        expect([p10.ref_match, p10.link_match, p10.ref_conflict, p10.tp_match]).toEqual([true, false, true, false]);
        expect(r.unmatchedLocals.map(l => l.id)).toEqual([11, 12, 13]);
        expect([...r.suggestions].map(([l, s]) => [l.id, s.khd.report_id, s.by])).toEqual([[11, 1, 'khd_report_id']]);
        expect([...r.refTaken].map(([l, o]) => [l.id, o.id])).toEqual([[12, 10]]);
        expect(r.unmatchedKhd.map(x => x.report_id)).toEqual([1, 3]);
    });
    test('รหัสที่แนะนำจากชื่อ: ต้องตรงกันรายการเดียวทั้ง 2 ฝั่ง (table_process ใช้ร่วมกันได้ ไม่ใช้ตัดสิน)', () => {
        const khd = [k(1, 'tp', 'X'), k(2, 'tp', 'Y')];
        let r = matchLocalsToKhd([{ id: 1, kpi_indicators_name: 'y', table_process: 'tp' }], khd);
        expect(r.pairs).toEqual([]);
        expect([...r.suggestions].map(([l, s]) => [l.id, s.khd.report_id, s.by])).toEqual([[1, 2, 'name']]);
        r = matchLocalsToKhd([{ id: 1, kpi_indicators_name: 'Y' }, { id: 2, kpi_indicators_name: 'Y' }], khd);
        expect(r.suggestions.size).toBe(0);   // ชื่อซ้ำในระบบ — ไม่เดา
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
    ids.b = await add('test_khdmatch B', 'test_khdmatch_x', '123', null);             // รหัสผิด + ชื่อตรงกับรายงาน hdc เท่านั้น
    ids.c = await add('test_khdmatch C', 'test_khdmatch_c', null, null);             // table_process ตรงกับ C แต่ไม่มีรหัส → ไม่จับคู่
    ids.d = await add('test_khdmatch D2', 'test_khdmatch_zz', null, 940004);         // ไม่มีรหัส — แนะนำ 940004 จากลิงก์
    ids.e = await add('test_khdmatch E', 'test_khdmatch_e', null, null);             // ไม่มีรหัส — แนะนำ 940005 จากชื่อ
    ids.old = await add('test_khdmatch OLD', 'test_khdmatch_old', '940009', 940009); // รายงานปีงบที่แล้ว
    ids.dupRef = await add('test_khdmatch dup', 'test_khdmatch_dup', '940003', null); // คู่กับ C ด้วยรหัส (ชื่อ/table_process ต่าง)
    ids.taken = await add('test_khdmatch T', 'test_khdmatch_a', '940001', null);      // รหัสซ้ำกับ A (table_process ร่วมกับ A ได้)
    ids.hdc = await add('test_khdmatch H', 'test_khdmatch_h', null, 940002);          // ตัวชี้วัด hdc ของระบบ
    await db.query("UPDATE kpi_indicators SET data_source = 'hdc' WHERE id = ?", [ids.hdc]);
}, 60000);
afterAll(async () => {
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_khdmatch%'");
    await cleanupTestUsers(db, 'test\\_khdmatch\\_');
});

describe('GET /report-compare — คีย์ report_id ↔ รหัสอ้างอิง', () => {
    test('เฉพาะรายงานของปีงบ + key_in, จับคู่ด้วยรหัสเท่านั้น, รหัสที่แนะนำ, ตัวชี้วัดนอกปีงบ = missing_remote + khd_other_year', async () => {
        const res = await request(app).get(api('/report-compare?year_bh=2570')).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
        const items = res.body.items;
        expect(items.some(i => i.khd_report_id === 940009)).toBe(false);   // รายงานปีงบ 2569 ไม่แสดง
        expect(items.some(i => i.khd_report_id === 940002)).toBe(false);   // รายงาน hdc ไม่แสดง
        expect(res.body.summary).toEqual(expect.objectContaining({ khd_year_total: 4, khd_year_active: 3, by_source: { excel: 4 } }));
        expect(res.body.summary.local_hdc_skipped).toBeGreaterThanOrEqual(1);
        const byLocal = (id) => items.find(i => i.local_id === id);
        expect(byLocal(ids.a)).toEqual(expect.objectContaining({ status: 'match', match_by: 'kpi_indicators_id', ref_match: true, link_match: true }));
        expect(byLocal(ids.dupRef)).toEqual(expect.objectContaining({ khd_report_id: 940003, match_by: 'kpi_indicators_id', status: 'tp_different', khd_is_active: 0 }));
        // table_process ตรงกับรายงาน C แต่ไม่มีรหัสอ้างอิง → ไม่จับคู่ (รายงาน C เป็นของ dupRef)
        expect(byLocal(ids.c)).toEqual(expect.objectContaining({ status: 'missing_remote', khd_report_id: null, ref_suggest: null, khd_other_year: [] }));
        expect(byLocal(ids.d)).toEqual(expect.objectContaining({ status: 'missing_remote', ref_suggest: expect.objectContaining({ report_id: 940004, by: 'khd_report_id' }) }));
        expect(byLocal(ids.e)).toEqual(expect.objectContaining({ status: 'missing_remote', ref_suggest: expect.objectContaining({ report_id: 940005, by: 'name' }) }));
        expect(items.find(i => i.status === 'missing_local' && i.khd_report_id === 940005).suggested_for).toEqual({ id: ids.e, name: 'test_khdmatch E' });
        expect(byLocal(ids.taken)).toEqual(expect.objectContaining({ status: 'missing_remote', ref_taken_by: expect.objectContaining({ id: ids.a }) }));
        expect(byLocal(ids.old)).toEqual(expect.objectContaining({ status: 'missing_remote', khd_other_year: ['2569'] }));
        expect(byLocal(ids.b)).toEqual(expect.objectContaining({ status: 'missing_remote', khd_report_id: null, ref_suggest: null }));
        expect(byLocal(ids.hdc)).toBeUndefined();
        expect(items.every(i => i.khd_data_source == null || i.khd_data_source === 'excel')).toBe(true);
        expect(res.body.summary.ref_different).toBe(2);   // d, e
        expect(res.body.summary.ref_taken).toBeGreaterThanOrEqual(1);
    });
});

describe('POST /indicators/apply-khd-ref', () => {
    const post = (tok, body) => request(app).post(api('/indicators/apply-khd-ref')).set('Authorization', `Bearer ${tok}`).send(body);
    test('ตั้งรหัสตามรหัสที่แนะนำ | ตรงแล้ว / ไม่มีรายงานที่แนะนำ / รหัสซ้ำ = ข้าม | log', async () => {
        const res = await post(saToken, { ids: [ids.a, ids.d, ids.e, ids.old, ids.c, ids.taken], year_bh: '2570' });
        expect(res.status).toBe(200);
        expect(res.body.updated.map(u => u.id).sort()).toEqual([ids.d, ids.e].sort());
        expect(await refOf(ids.d)).toEqual({ kpi_indicators_id: '940004', khd_report_id: 940004, data_source: 'excel' });
        expect(await refOf(ids.e)).toEqual({ kpi_indicators_id: '940005', khd_report_id: 940005, data_source: 'excel' });
        const why = Object.fromEntries(res.body.skipped.map(s => [s.id, s.reason]));
        expect(why[ids.a]).toBe('ตรงกันอยู่แล้ว');
        expect(why[ids.old]).toMatch(/ไม่พบรายงานที่ตรงกันใน KHD ปีงบ 2570/);
        expect(why[ids.c]).toMatch(/ไม่พบรายงานที่ตรงกันใน KHD ปีงบ 2570/);
        expect(why[ids.taken]).toBe(`รหัส 940001 ใช้โดยตัวชี้วัด #${ids.a} แล้ว`);
        const [[log]] = await db.query("SELECT COUNT(*) AS n FROM system_logs WHERE action_type = 'APPLY_KHD_REF' AND new_value LIKE ?", [`%"id":${ids.d}%`]);
        expect(log.n).toBeGreaterThanOrEqual(1);
    });
    test('คู่ที่ลิงก์ khd_report_id ไม่ตรง → แก้ลิงก์ (รหัสอ้างอิงเดิม) / table_process ไม่ทำให้ได้รหัส / สิทธิ์ / ข้อมูลไม่ครบ', async () => {
        const res = await post(saToken, { ids: [ids.c, ids.dupRef], year_bh: '2570' });
        expect(res.body.updated.map(u => u.id)).toEqual([ids.dupRef]);
        expect(await refOf(ids.dupRef)).toEqual({ kpi_indicators_id: '940003', khd_report_id: 940003, data_source: 'excel' });
        expect((await refOf(ids.c)).kpi_indicators_id).toBeNull();
        expect((await post(hosToken, { ids: [ids.c] })).status).toBe(403);
        expect((await post(saToken, { ids: [] })).status).toBe(400);
    });
});
