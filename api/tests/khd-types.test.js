/**
 * เทียบ/ปรับ "ประเภทตัวชี้วัด" (r9/moph/ssj/rmw/other) และ "ประเภทหน่วยบริการ" (evaluation_mode + required_off_types) กับ KHD (9 พ.ย. 2569)
 *   - services/khd-types.js: ค่าปีงบ (report_fiscal_year_config) ก่อนค่าทั่วไป, all_required ไม่สนรายการ, any_one เทียบรายการ (เรียงแล้ว), KHD ไม่ตั้ง = ไม่นับต่าง
 *   - POST /indicators/apply-khd-types: server อ่าน KHD ใหม่, ปรับเฉพาะส่วนที่เลือก, KHD ไม่ตั้งประเภทหน่วยบริการ = ข้าม — KHD จำลอง (ห้ามเชื่อม KHD จริง)
 */
const mockReports = [
    { report_id: 970001, table_process: 'test_khdtype_a', report_code: 'TEST_KHDTYPE_A', data_source: 'excel',
      r9: 1, moph: 0, ssj: null, rmw: 0, other: null, evaluation_mode: 'any_one', required_off_types: '["07","05"]' },
    { report_id: 970002, table_process: 'test_khdtype_b', report_code: 'TEST_KHDTYPE_B', data_source: 'excel',
      r9: 0, moph: 1, ssj: 1, rmw: 0, other: '0', evaluation_mode: 'any_one', required_off_types: null },
];
const mockFy = [{ report_id: 970001, fiscal_year: 2570, r9: 0, moph: 1, ssj: 1, rmw: null }];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/FROM report_fiscal_year_config WHERE fiscal_year = \? AND report_id IN \(\?\)/.test(s))
                return [mockFy.filter(r => String(r.fiscal_year) === String(params[0]) && params[1].includes(r.report_id))];
            if (/FROM reports WHERE data_source = 'excel' AND LENGTH\(report_code\) = LENGTH\(table_process\) AND table_process IN \(\?\)/.test(s))
                return [mockReports.filter(r => params[0].includes(r.table_process))];
            throw new Error('KHD จำลองไม่รองรับคำสั่ง: ' + s.slice(0, 120));
        }
    })
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { compareKhdTypes, hostypeSetting, khdIndicatorTypes } = require('../services/khd-types');

describe('services/khd-types.js', () => {
    test('ประเภทตัวชี้วัด: ค่าปีงบ (ไม่ใช่ null) ก่อนค่าทั่วไป, null/"0" = 0', () => {
        expect(khdIndicatorTypes(mockReports[0], null)).toEqual({ r9: 1, moph: 0, ssj: 0, rmw: 0, other: 0 });
        expect(khdIndicatorTypes(mockReports[0], mockFy[0])).toEqual({ r9: 0, moph: 1, ssj: 1, rmw: 0, other: 0 });
    });
    test('ประเภทหน่วยบริการ: all_required ไม่สนรายการ, any_one เทียบรายการแบบเรียงแล้ว, ว่าง = unset', () => {
        expect(hostypeSetting('all_required', '["05"]').key).toBe('all');
        expect(hostypeSetting('any_one', '["07","05","05"]').key).toBe('any:05,07');
        expect(hostypeSetting('any_one', null).key).toBe('unset');
        expect(hostypeSetting(null, '["05"]').key).toBe('unset');
        const c = compareKhdTypes(mockReports[0], null, { r9: 1, moph: 0, ssj: 0, rmw: 0, other: null, evaluation_mode: 'any_one', required_off_types: '["05","07"]' });
        expect([c.types_match, c.hostype_match]).toEqual([true, true]);
        // KHD ไม่ได้ตั้งประเภทหน่วยบริการ = ไม่นับว่าต่าง (null)
        expect(compareKhdTypes(mockReports[1], null, { evaluation_mode: 'all_required' }).hostype_match).toBeNull();
    });
});

let app, db, saToken, hosToken;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const row = async (id) => (await db.query('SELECT r9, moph, ssj, rmw, other, evaluation_mode, required_off_types FROM kpi_indicators WHERE id = ?', [id]))[0][0];
const add = async (name, tp) => (await db.query(
    `INSERT INTO kpi_indicators (kpi_indicators_name, table_process, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_active)
     VALUES (?, ?, 0, 0, 0, 1, 0, 'all_required', NULL, 1)`, [name, tp]))[0].insertId;
const apply = (token, body) => request(app).post(api('/indicators/apply-khd-types')).set('Authorization', `Bearer ${token}`).send(body);

describe('POST /indicators/apply-khd-types', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        db = require('../db');
        await migrationsReady;
        await cleanupTestUsers(db);
        await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdtype\\_%'");
        const sa = await ensureTestUser(db, { username: 'test_khdtype_sa', role: 'super_admin' });
        saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
        const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
        const ah = await ensureTestUser(db, { username: 'test_khdtype_hos', role: 'admin_hos', hospcode: h.hoscode });
        hosToken = makeToken({ userId: ah.id, username: ah.username, role: 'admin_hos', deptId: 1, hospcode: h.hoscode });
        ids.a = await add('test_khdtype A', 'test_khdtype_a');
        ids.b = await add('test_khdtype B', 'test_khdtype_b');
        ids.c = await add('test_khdtype C', 'test_khdtype_c');
    });
    afterAll(async () => {
        await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdtype\\_%'");
        await cleanupTestUsers(db);
    });

    test('ปรับเฉพาะประเภทตัวชี้วัด (ค่าปีงบ 2570) — ประเภทหน่วยบริการไม่เปลี่ยน', async () => {
        const res = await apply(saToken, { ids: [ids.a], year_bh: '2570', parts: ['types'] });
        expect(res.status).toBe(200);
        expect(await row(ids.a)).toEqual({ r9: 0, moph: 1, ssj: 1, rmw: 0, other: 0, evaluation_mode: 'all_required', required_off_types: null });
    });
    test('ปรับประเภทหน่วยบริการ (ปีงบไม่มีค่าเฉพาะ = ค่าทั่วไป) | KHD ไม่ตั้ง = ข้าม | ไม่พบใน KHD = ข้าม | ตรงแล้ว = ข้าม', async () => {
        const res = await apply(saToken, { ids: [ids.a, ids.b, ids.c], year_bh: '2571', parts: ['types', 'hostype'] });
        expect(res.status).toBe(200);
        expect(res.body.hostype_changed).toBe(true);
        const a = await row(ids.a);
        expect(a).toEqual({ r9: 1, moph: 0, ssj: 0, rmw: 0, other: 0, evaluation_mode: 'any_one', required_off_types: '["05","07"]' });
        const b = await row(ids.b);
        expect([b.moph, b.ssj, b.rmw, b.evaluation_mode]).toEqual([1, 1, 0, 'all_required']);   // ประเภทตัวชี้วัดปรับ, ประเภทหน่วยบริการคงเดิม
        expect(res.body.skipped.map(s => s.reason)).toEqual(['ไม่พบใน KHD']);
        const again = await apply(saToken, { ids: [ids.a], year_bh: '2571', parts: ['types', 'hostype'] });
        expect(again.body.updated).toEqual([]);
        expect(again.body.skipped[0].reason).toBe('ตรงกันอยู่แล้ว');
        const onlyHos = await apply(saToken, { ids: [ids.b], year_bh: '2571', parts: ['hostype'] });
        expect(onlyHos.body.skipped[0].reason).toBe('KHD ไม่ได้ตั้งประเภทหน่วยบริการ');
    });
    test('🛡️ ต้องมีสิทธิ์แก้ไขตัวชี้วัด, ต้องระบุรายการและส่วนที่จะปรับ', async () => {
        expect((await apply(hosToken, { ids: [ids.a], parts: ['types'] })).status).toBe(403);
        expect((await apply(saToken, { ids: [], parts: ['types'] })).status).toBe(400);
        expect((await apply(saToken, { ids: [ids.a], parts: ['x'] })).status).toBe(400);
    });
});
