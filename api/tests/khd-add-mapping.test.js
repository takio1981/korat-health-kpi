/**
 * Integration tests (database ทดสอบ + KHD จำลอง — ไม่เชื่อมต่อ KHD จริง) — 19 ต.ค. 2569
 *   - เพิ่มตัวชี้วัดจาก KHD นำ หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์ จาก KHD เข้ามาด้วย (เดิม: ใช้เฉพาะค่าที่เลือกในหน้าต่าง)
 *     ค่าจาก KHD มาก่อนค่าที่เลือก — ค่าที่เลือกใช้เมื่อ KHD ไม่มีค่า/ยังจับคู่ไม่ได้
 *   - GET/PUT /khd-mappings: รายการค่าใน KHD + ผลการจับคู่ + บันทึกการจับคู่
 *   - ยุทธศาสตร์ของตัวชี้วัดที่ไม่มีหมวดหมู่หลัก แสดงจาก kpi_indicators.main_yut
 *   - แท็บเทียบหน่วยงานจับคู่ด้วยรหัสหน่วยงาน (เดิม: เทียบชื่อ ทั้งที่ KHD เก็บรหัส)
 */
const TP = { r1: 'test_khdmap_tp1', r2: 'test_khdmap_tp2', r3: 'test_khdmap_tp3' };
const mockReports = [
    { report_id: 990001, report_name: 'test_khdmap ตัวชี้วัด 1', report_code: 'TEST_KHDMAP_TP1', table_process: TP.r1, data_source: 'excel',
      target_percentage: 80, target_condition: 'GTE', is_active: 1, dept: 'TKM1', main_yut: 'test_khdmap   ยุทธศาสตร์ 1\t', main_indicator: '' },
    { report_id: 990002, report_name: 'test_khdmap ตัวชี้วัด 2', report_code: 'TEST_KHDMAP_TP2', table_process: TP.r2, data_source: 'excel',
      target_percentage: 90, target_condition: 'GTE', is_active: 1, dept: 'TKMX', main_yut: 'test_khdmap ยุทธ์ชื่ออื่น', main_indicator: 'test_khdmap หมวด 1' },
    { report_id: 990003, report_name: 'test_khdmap ตัวชี้วัด 3', report_code: 'TEST_KHDMAP_TP3', table_process: TP.r3, data_source: 'excel',
      target_percentage: 70, target_condition: 'GTE', is_active: 1, dept: 'TKMX', main_yut: 'test_khdmap ยุทธ์ชื่ออื่น', main_indicator: '' },
];
// KHD จำลอง — ตอบเฉพาะคำสั่งที่ endpoint เหล่านี้ใช้
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/FROM report_fiscal_year_config/.test(s)) return [[]];
            if (/FROM departments/.test(s)) return [[{ dept_code: 'TKMX', dept_name: 'test_khdmap กลุ่มงานใน KHD' }]];
            if (/FROM reports WHERE report_id = \?/.test(s)) return [mockReports.filter(r => r.report_id === Number(params[0]))];
            if (/FROM reports WHERE report_id IN \(\?\)/.test(s)) return [mockReports.filter(r => params[0].map(Number).includes(r.report_id))];
            if (/SELECT DISTINCT TRIM\(dept\) AS khd_dept/.test(s)) return [[...new Set(mockReports.map(r => r.dept))].map(d => ({ khd_dept: d }))];
            if (/SELECT DISTINCT TRIM\(main_yut\) AS khd_yut/.test(s)) return [[...new Set(mockReports.map(r => r.main_yut.trim()))].map(y => ({ khd_yut: y }))];
            const m = s.match(/SELECT (\w+) AS v, table_process FROM reports/);
            if (m) return [mockReports.filter(r => r[m[1]] && String(r[m[1]]).trim()).map(r => ({ v: r[m[1]], table_process: r.table_process }))];
            if (/SELECT \* FROM reports/.test(s)) return [mockReports];
            throw new Error('KHD จำลองไม่รองรับคำสั่ง: ' + s.slice(0, 120));
        }
    })
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken;
const L = {};
const api = (p) => '/khupskpi/api' + p;
const as = (r) => r.set('Authorization', `Bearer ${saToken}`);
const indByTp = async (tp) => (await db.query('SELECT id, dept_id, main_indicator_id, main_yut FROM kpi_indicators WHERE table_process = ?', [tp]))[0][0];

async function cleanup() {
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdmap\\_%' OR kpi_indicators_name LIKE 'test\\_khdmap%'");
    await db.query("DELETE FROM khd_value_mappings WHERE khd_value LIKE 'test\\_khdmap%' OR khd_value IN ('TKM1','TKMX')");
    await db.query("DELETE FROM kpi_main_indicators WHERE main_indicator_name LIKE 'test\\_khdmap%'");
    await db.query("DELETE FROM main_yut WHERE yut_name LIKE 'test\\_khdmap%'");
    await db.query("DELETE FROM departments WHERE dept_name LIKE 'test\\_khdmap%'");
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await cleanup();
    const sa = await ensureTestUser(db, { username: 'test_khdmap_sa', role: 'super_admin', session_id: 'sess-khdmap' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-khdmap' });
    const ins = async (sql, p) => (await db.query(sql, p))[0].insertId;
    L.d1 = await ins("INSERT INTO departments (dept_name, dept_code) VALUES ('test_khdmap กลุ่มงาน 1', 'tkm1')");
    L.d2 = await ins("INSERT INTO departments (dept_name, dept_code) VALUES ('test_khdmap กลุ่มงาน 2', 'tkm2')");
    L.y1 = await ins("INSERT INTO main_yut (yut_name) VALUES ('test_khdmap ยุทธศาสตร์ 1 (12)')");
    L.y2 = await ins("INSERT INTO main_yut (yut_name) VALUES ('test_khdmap ยุทธศาสตร์ 2')");
    L.m1 = await ins("INSERT INTO kpi_main_indicators (main_indicator_name, yut_id) VALUES ('test_khdmap หมวด 1', ?)", [L.y2]);
});

afterAll(async () => {
    await cleanup();
    await cleanupTestUsers(db);
});

describe('เพิ่มตัวชี้วัดจาก KHD — นำหน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ของ KHD เข้ามา', () => {
    test('/report-compare แนบผลการจับคู่ของแถวที่ยังไม่มีในระบบ', async () => {
        const res = await as(request(app).get(api('/report-compare?year_bh=2570')));
        expect(res.status).toBe(200);
        const row = res.body.items.find(i => i.table_process === TP.r1);
        expect(row.status).toBe('missing_local');
        expect(row.khd_resolved.dept_id).toBe(L.d1);
        expect(row.khd_resolved.main_yut).toBe(L.y1);
        expect(res.body.items.find(i => i.table_process === TP.r2).khd_resolved.unmatched).toEqual(['dept', 'yut']);
    });

    test('ทีละตัว: ค่าจาก KHD มาก่อนค่าที่เลือก — หมวดหมู่หลักที่ KHD ไม่มีใช้ค่าที่เลือก (เดิม: ใช้เฉพาะค่าที่เลือก)', async () => {
        const res = await as(request(app).post(api('/report-compare/add-from-khd')))
            .send({ khd_report_id: 990001, dept_id: L.d2, main_indicator_id: L.m1, year_bh: '2570' });
        expect(res.status).toBe(200);
        expect(await indByTp(TP.r1)).toEqual(expect.objectContaining({ dept_id: L.d1, main_indicator_id: L.m1, main_yut: L.y1 }));
    });

    test('หลายตัว: ช่องที่ยังจับคู่ไม่ได้ใช้ค่าที่เลือก และรายงานชื่อรายการที่ยังจับคู่ไม่ครบ', async () => {
        const res = await as(request(app).post(api('/report-compare/bulk-add-from-khd')))
            .send({ khd_report_ids: [990002], dept_id: L.d2, main_indicator_id: null, year_bh: '2570' });
        expect(res.status).toBe(200);
        expect(res.body.inserted).toBe(1);
        expect(res.body.unmatchedNames).toEqual(['test_khdmap ตัวชี้วัด 2']);
        // หมวดหมู่หลักจาก KHD ("test_khdmap หมวด 1") → ยุทธศาสตร์ตามหมวดหมู่ เพราะข้อความยุทธศาสตร์ของ KHD ยังจับคู่ไม่ได้
        expect(await indByTp(TP.r2)).toEqual(expect.objectContaining({ dept_id: L.d2, main_indicator_id: L.m1, main_yut: L.y2 }));
    });
});

describe('หน้าต่างจับคู่ข้อมูล KHD (/khd-mappings)', () => {
    test('GET แสดงค่าใน KHD + ผลการจับคู่ + ชื่อเต็มจาก KHD และรายการของระบบให้เลือก', async () => {
        const res = await as(request(app).get(api('/khd-mappings?kind=dept')));
        expect(res.status).toBe(200);
        const by = Object.fromEntries(res.body.items.map(i => [i.khd_value, i]));
        expect(by.TKM1.resolved).toEqual(expect.objectContaining({ status: 'auto', local_id: L.d1 }));
        expect(by.TKMX.resolved.status).toBe('unmatched');
        expect(by.TKMX.khd_label).toBe('test_khdmap กลุ่มงานใน KHD');
        expect(by.TKMX.missing_count).toBe(1);   // r3 ยังไม่มีในระบบ
        expect(res.body.options.some(o => o.id === L.d2)).toBe(true);
    });

    test('PUT จับคู่ → การเพิ่มครั้งถัดไปใช้ค่าที่จับคู่ / ตั้ง "ไม่ต้องจับคู่" / ลบการจับคู่', async () => {
        let r = await as(request(app).put(api('/khd-mappings'))).send({ kind: 'dept', khd_value: 'TKMX', local_id: L.d2 });
        expect(r.status).toBe(200);
        expect(r.body.resolved).toEqual(expect.objectContaining({ status: 'mapped', local_id: L.d2 }));
        r = await as(request(app).put(api('/khd-mappings'))).send({ kind: 'yut', khd_value: 'test_khdmap  ยุทธ์ชื่ออื่น', local_id: L.y1 });
        expect(r.body.resolved.local_id).toBe(L.y1);

        const add = await as(request(app).post(api('/report-compare/bulk-add-from-khd'))).send({ khd_report_ids: [990003], dept_id: null, main_indicator_id: null });
        expect(add.body.unmatchedNames).toEqual([]);
        expect(await indByTp(TP.r3)).toEqual(expect.objectContaining({ dept_id: L.d2, main_indicator_id: null, main_yut: L.y1 }));

        r = await as(request(app).put(api('/khd-mappings'))).send({ kind: 'yut', khd_value: 'test_khdmap ยุทธ์ชื่ออื่น', ignore: true });
        expect(r.body.resolved.status).toBe('ignored');
        r = await as(request(app).put(api('/khd-mappings'))).send({ kind: 'yut', khd_value: 'test_khdmap ยุทธ์ชื่ออื่น' });
        expect(r.body.resolved.status).toBe('unmatched');
    });

    test('🛡️ ตรวจค่าที่ส่งมา และเฉพาะ super_admin', async () => {
        expect((await as(request(app).put(api('/khd-mappings'))).send({ kind: 'bad', khd_value: 'x' })).status).toBe(400);
        expect((await as(request(app).put(api('/khd-mappings'))).send({ kind: 'dept', khd_value: 'x', local_id: 99999999 })).status).toBe(400);
        const u = await ensureTestUser(db, { username: 'test_khdmap_ssj', role: 'admin_ssj', dept_id: L.d1, session_id: 'sess-khdmap-ssj' });
        const userTok = makeToken({ userId: u.id, username: u.username, role: 'admin_ssj', deptId: L.d1, hospcode: null, sessionId: 'sess-khdmap-ssj' });
        expect((await request(app).get(api('/khd-mappings?kind=dept')).set('Authorization', `Bearer ${userTok}`)).status).toBe(403);
    });
});

describe('ยุทธศาสตร์ของตัวชี้วัด / แท็บเทียบหน่วยงาน', () => {
    test('ไม่มีหมวดหมู่หลัก → แสดงยุทธศาสตร์จาก kpi_indicators.main_yut (เดิม: ว่าง) และแก้ไขผ่าน PUT /indicators ได้', async () => {
        const ind = await indByTp(TP.r3);
        let res = await as(request(app).get(api('/indicators?include_inactive=1')));
        let row = res.body.data.find(i => i.id === ind.id);
        expect(Number(row.yut_id)).toBe(L.y1);
        expect(row.yut_name).toBe('test_khdmap ยุทธศาสตร์ 1 (12)');

        const put = await as(request(app).put(api(`/indicators/${ind.id}`))).send({ kpi_indicators_name: 'test_khdmap ตัวชี้วัด 3', table_process: TP.r3, is_active: 1, main_yut: L.y2 });
        expect(put.status).toBe(200);
        expect((await indByTp(TP.r3)).main_yut).toBe(L.y2);
        // มีหมวดหมู่หลัก → ยุทธศาสตร์ตามหมวดหมู่ (ไม่เปลี่ยนพฤติกรรมเดิม)
        const r1 = await indByTp(TP.r1);
        res = await as(request(app).get(api('/indicators?include_inactive=1')));
        row = res.body.data.find(i => i.id === r1.id);
        expect(Number(row.yut_id)).toBe(L.y2);
    });

    test('แท็บเทียบหน่วยงานจับคู่ด้วยรหัสหน่วยงานของ KHD (เดิม: ไม่ตรงเลยสักตัว)', async () => {
        const res = await as(request(app).get(api('/report-compare/departments')));
        expect(res.status).toBe(200);
        const row = res.body.items.find(i => i.khd_dept_name === 'TKM1');
        expect(row).toEqual(expect.objectContaining({ status: 'match', local_id: L.d1 }));
    });
});
