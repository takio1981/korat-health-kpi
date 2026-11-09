/**
 * ปีงบประมาณของตัวชี้วัด (khd_fiscal_year) — เทียบกับ KHD + ตั้งเอง (9 พ.ย. 2569) — KHD จำลอง (ห้ามเชื่อม KHD จริง)
 *   - services/fiscal-years.js: รับ array/ข้อความ, ตัดค่าที่ไม่ใช่ปี พ.ศ., เรียง ไม่ซ้ำ, KHD ไม่มีปีงบ = ไม่นับต่าง
 *   - GET /report-compare: fiscal_year_match + khd_fiscal_years/local_fiscal_years + summary.fiscal_year_different
 *   - POST /indicators/apply-khd-fiscal-year: server อ่านปีงบจาก KHD เอง, KHD ไม่มีปีงบ = ข้าม (ไม่ล้างค่าเดิม)
 *   - POST /indicators/set-fiscal-year: แทนที่ / เพิ่ม / ล้าง, ปีไม่ถูกต้อง = 400, ไม่มีสิทธิ์แก้ไขตัวชี้วัด = 403
 *   - PUT /indicators/:id รับ khd_fiscal_year (ไม่ส่ง = ไม่เปลี่ยน) | sync-khd-link ไม่ล้างปีงบของตัวที่ไม่มีใน KHD
 */
const mockReports = [
    { report_id: 960001, report_name: 'test_khdfy A', report_code: 'TEST_KHDFY_A', table_process: 'test_khdfy_a', data_source: 'excel', is_active: 1 },
    { report_id: 960002, report_name: 'test_khdfy B', report_code: 'TEST_KHDFY_B', table_process: 'test_khdfy_b', data_source: 'excel', is_active: 1 },
    { report_id: 960003, report_name: 'test_khdfy C', report_code: 'TEST_KHDFY_C', table_process: 'test_khdfy_c', data_source: 'excel', is_active: 1 },
];
const mockFyAll = [
    { report_id: 960001, fiscal_year: 2570 }, { report_id: 960001, fiscal_year: 2569 },
    { report_id: 960002, fiscal_year: 2570 },
];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config WHERE report_id IN \(\?\)/.test(s))
                return [mockFyAll.filter(r => params[0].includes(r.report_id))];
            if (/SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config/.test(s)) return [mockFyAll];
            if (/FROM report_fiscal_year_config/.test(s)) return [[]];
            if (/SELECT \* FROM reports WHERE data_source = 'excel'/.test(s)) return [mockReports];
            if (/FROM reports WHERE data_source = 'excel' AND LENGTH\(report_code\) = LENGTH\(table_process\) AND table_process IN \(\?\)/.test(s))
                return [mockReports.filter(r => params[0].includes(r.table_process))];
            if (/SELECT report_id, table_process, data_source FROM reports/.test(s)) return [mockReports];
            throw new Error('KHD จำลองไม่รองรับคำสั่ง: ' + s.slice(0, 120));
        }
    })
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const fy = require('../services/fiscal-years');

let app, db, saToken, hosToken;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const add = async (name, tp, years) => (await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active, khd_fiscal_year) VALUES (?, ?, 1, ?)', [name, tp, years]))[0].insertId;
const yearsOf = async (id) => (await db.query('SELECT khd_fiscal_year AS y FROM kpi_indicators WHERE id = ?', [id]))[0][0].y;
const post = (t, p, body) => request(app).post(api(p)).set('Authorization', `Bearer ${t}`).send(body);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdfy\\_%'");
    const sa = await ensureTestUser(db, { username: 'test_khdfy_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    const ah = await ensureTestUser(db, { username: 'test_khdfy_hos', role: 'admin_hos', hospcode: h.hoscode });
    hosToken = makeToken({ userId: ah.id, username: ah.username, role: 'admin_hos', deptId: 1, hospcode: h.hoscode });
    ids.a = await add('test_khdfy A', 'test_khdfy_a', '2570');         // KHD 2569,2570 → ต่าง
    ids.b = await add('test_khdfy B', 'test_khdfy_b', '2570');         // ตรงกัน
    ids.c = await add('test_khdfy C', 'test_khdfy_c', '2568');         // KHD ไม่มีปีงบ → ไม่นับต่าง
    ids.l = await add('test_khdfy local', 'test_khdfy_local', null);   // ไม่มีใน KHD, ไม่ระบุปีงบ
});
afterAll(async () => {
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdfy\\_%'");
    await cleanupTestUsers(db);
});

describe('services/fiscal-years', () => {
    test('normalize / invalid / compare', () => {
        expect(fy.normalizeFiscalYears(['2570', ' 2569', '2570', 'x', ''])).toBe('2569,2570');
        expect(fy.normalizeFiscalYears('2571, 2570')).toBe('2570,2571');
        expect(fy.normalizeFiscalYears([])).toBeNull();
        expect(fy.invalidFiscalYears(['2570', '70', 'abc', ''])).toEqual(['70', 'abc']);
        expect(fy.compareFiscalYears('2570,2569', ['2569', '2570']).fiscal_year_match).toBe(true);
        expect(fy.compareFiscalYears(null, ['2570']).fiscal_year_match).toBe(false);
        expect(fy.compareFiscalYears('2570', []).fiscal_year_match).toBeNull();
        expect([...fy.buildKhdFiscalYearMap([{ report_id: 1, fiscal_year: 2570 }, { report_id: 1, fiscal_year: '2569' }, { report_id: 1, fiscal_year: 2570 }])])
            .toEqual([[1, ['2569', '2570']]]);
    });
});

describe('GET /report-compare — ปีงบประมาณ', () => {
    test('fiscal_year_match ต่อแถว + summary.fiscal_year_different', async () => {
        const res = await request(app).get(api('/report-compare?year_bh=2570')).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
        const byTp = (tp) => res.body.items.find(i => i.table_process === tp);
        expect(byTp('test_khdfy_a')).toEqual(expect.objectContaining({ fiscal_year_match: false, khd_fiscal_years: ['2569', '2570'], local_fiscal_years: ['2570'] }));
        expect(byTp('test_khdfy_b').fiscal_year_match).toBe(true);
        expect(byTp('test_khdfy_c').fiscal_year_match).toBeNull();
        expect(byTp('test_khdfy_local')).toEqual(expect.objectContaining({ status: 'missing_remote', local_fiscal_years: [] }));
        expect(res.body.summary.fiscal_year_different).toBeGreaterThanOrEqual(1);
    });
});

describe('POST /indicators/apply-khd-fiscal-year', () => {
    test('ใช้ปีงบของ KHD — ข้ามตัวที่ตรงแล้ว/KHD ไม่มีปีงบ/ไม่พบใน KHD (ไม่ล้างค่าเดิม)', async () => {
        const res = await post(saToken, '/indicators/apply-khd-fiscal-year', { ids: [ids.a, ids.b, ids.c, ids.l] });
        expect(res.status).toBe(200);
        expect(res.body.updated.map(u => u.id)).toEqual([ids.a]);
        expect(await yearsOf(ids.a)).toBe('2569,2570');
        expect(await yearsOf(ids.c)).toBe('2568');
        const reasons = Object.fromEntries(res.body.skipped.map(s => [s.id, s.reason]));
        expect(reasons[ids.b]).toBe('ตรงกันอยู่แล้ว');
        expect(reasons[ids.c]).toBe('KHD ไม่ได้ตั้งปีงบ');
        expect(reasons[ids.l]).toBe('ไม่พบใน KHD');
        const [[log]] = await db.query("SELECT COUNT(*) AS n FROM system_logs WHERE action_type = 'APPLY_KHD_FISCAL_YEAR' AND new_value LIKE ?", [`%"id":${ids.a}%`]);
        expect(log.n).toBeGreaterThanOrEqual(1);
    });
    test('ไม่มีสิทธิ์แก้ไขตัวชี้วัด = 403', async () => {
        expect((await post(hosToken, '/indicators/apply-khd-fiscal-year', { ids: [ids.a] })).status).toBe(403);
    });
});

describe('POST /indicators/set-fiscal-year — ตั้งปีงบเอง', () => {
    test('แทนที่ / เพิ่ม / ล้าง', async () => {
        let res = await post(saToken, '/indicators/set-fiscal-year', { ids: [ids.l], years: ['2570'] });
        expect(res.status).toBe(200);
        expect(await yearsOf(ids.l)).toBe('2570');
        res = await post(saToken, '/indicators/set-fiscal-year', { ids: [ids.l], years: ['2569', '2570'], mode: 'add' });
        expect(await yearsOf(ids.l)).toBe('2569,2570');
        res = await post(saToken, '/indicators/set-fiscal-year', { ids: [ids.l], years: ['2569'], mode: 'add' });
        expect(res.body.updated).toHaveLength(0);
        res = await post(saToken, '/indicators/set-fiscal-year', { ids: [ids.l], years: [] });
        expect(await yearsOf(ids.l)).toBeNull();
    });
    test('ปีไม่ถูกต้อง / ไม่ส่งปี / เพิ่มโดยไม่เลือกปี = 400 | ไม่มีสิทธิ์ = 403', async () => {
        expect((await post(saToken, '/indicators/set-fiscal-year', { ids: [ids.l], years: ['70'] })).status).toBe(400);
        expect((await post(saToken, '/indicators/set-fiscal-year', { ids: [ids.l] })).status).toBe(400);
        expect((await post(saToken, '/indicators/set-fiscal-year', { ids: [ids.l], years: [], mode: 'add' })).status).toBe(400);
        expect((await post(hosToken, '/indicators/set-fiscal-year', { ids: [ids.l], years: ['2570'] })).status).toBe(403);
    });
});

describe('PUT /indicators/:id + sync-khd-link', () => {
    test('PUT รับ khd_fiscal_year (ไม่ส่ง = ไม่เปลี่ยน, ปีผิด = 400)', async () => {
        const [[row]] = await db.query('SELECT * FROM kpi_indicators WHERE id = ?', [ids.l]);
        const body = { kpi_indicators_name: row.kpi_indicators_name, table_process: row.table_process, is_active: 1 };
        let res = await request(app).put(api('/indicators/' + ids.l)).set('Authorization', `Bearer ${saToken}`).send({ ...body, khd_fiscal_year: ['2571', '2570'] });
        expect(res.status).toBe(200);
        expect(await yearsOf(ids.l)).toBe('2570,2571');
        res = await request(app).put(api('/indicators/' + ids.l)).set('Authorization', `Bearer ${saToken}`).send(body);
        expect(res.status).toBe(200);
        expect(await yearsOf(ids.l)).toBe('2570,2571');
        res = await request(app).put(api('/indicators/' + ids.l)).set('Authorization', `Bearer ${saToken}`).send({ ...body, khd_fiscal_year: ['25x0'] });
        expect(res.status).toBe(400);
    });
    test('sync-khd-link: ตัวที่ไม่มีใน KHD คงปีงบที่ตั้งเอง | KHD ไม่มีปีงบ = คงค่าเดิม', async () => {
        // sync-khd-link แก้ทุกตัวชี้วัดในฐานทดสอบ — เก็บค่าเดิมไว้แล้วคืนให้
        const [snap] = await db.query('SELECT id, khd_report_id, data_source, khd_fiscal_year FROM kpi_indicators');
        const res = await post(saToken, '/report-compare/sync-khd-link', {});
        const after = { l: await yearsOf(ids.l), c: await yearsOf(ids.c), a: await yearsOf(ids.a) };
        for (const r of snap) await db.query('UPDATE kpi_indicators SET khd_report_id = ?, data_source = ?, khd_fiscal_year = ? WHERE id = ?', [r.khd_report_id, r.data_source, r.khd_fiscal_year, r.id]);
        expect(res.status).toBe(200);
        expect(after).toEqual({ l: '2570,2571', c: '2568', a: '2569,2570' });
    });
});
