/**
 * ประเภทตัวชี้วัด R9 / MOPH / SSJ / RMW / อื่น ๆ ในหน้ารายงานสถิติ (20 พ.ย. 2569)
 *   - unit: parseItypes / itypeCond / addItypeFilter / itypesOf
 *   - integration (ฐานทดสอบ): /report/chart-stats คืน by_itype ครบทุกประเภท (ตัวชี้วัดหลายประเภทนับในทุกประเภท),
 *     ตัวกรอง itype ใช้ได้กับกราฟ + รายงานรายตัวชี้วัด, คีย์ที่ไม่รู้จัก = ไม่มีข้อมูล, ตัวชี้วัดรายตัวมีธงประเภท
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { parseItypes, itypeCond, addItypeFilter, itypesOf, ITYPE_ALL } = require('../services/indicator-types');

describe('services/indicator-types (unit)', () => {
    test('parseItypes: เฉพาะคีย์ที่รู้จัก เรียงตามลำดับมาตรฐาน ไม่ส่ง = null', () => {
        expect(parseItypes(undefined)).toBeNull();
        expect(parseItypes('')).toBeNull();
        expect(parseItypes('moph, R9 ,x;drop')).toEqual(['r9', 'moph']);
        expect(parseItypes('zzz')).toEqual([]);
        expect(ITYPE_ALL).toEqual(['r9', 'moph', 'ssj', 'rmw', 'other', 'none']);
    });
    test('itypeCond: คอลัมน์จากรายการคงที่เท่านั้น / none = ไม่มีธงใดเลย', () => {
        expect(itypeCond('r9', 'i')).toBe('COALESCE(i.`r9`, 0) = 1');
        expect(itypeCond('none', 'x')).toContain('COALESCE(x.`other`, 0) <> 1');
        expect(() => itypeCond('r9; DROP TABLE x', 'i')).toThrow();
    });
    test('addItypeFilter: ไม่ส่ง = ไม่กรอง, คีย์ไม่รู้จักทั้งหมด = 1 = 0, หลายประเภท = OR', () => {
        const a = []; addItypeFilter(a, 's.indicator_id', undefined); expect(a).toEqual([]);
        const b = []; addItypeFilter(b, 's.indicator_id', 'bogus'); expect(b).toEqual(['1 = 0']);
        const c = []; addItypeFilter(c, 's.indicator_id', 'r9,ssj');
        expect(c[0]).toContain('s.indicator_id IN (SELECT ki.id FROM kpi_indicators ki WHERE');
        expect(c[0]).toContain(' OR ');
    });
    test('itypesOf', () => {
        expect(itypesOf({ r9: 1, moph: '1', ssj: 0 })).toEqual(['r9', 'moph']);
        expect(itypesOf({})).toEqual(['none']);
    });
});

jest.setTimeout(120000);
const YEAR = '2502';
let app, db, saToken, deptId, hospA, hospB;
const ids = [];
const api = (p) => '/khupskpi/api' + p;

async function addIndicator(name, flags) {
    const [r] = await db.query(
        'INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, r9, moph, ssj, rmw, `other`) VALUES (?,?,1,?,?,?,?,?)',
        [name, deptId, flags.r9 || 0, flags.moph || 0, flags.ssj || 0, flags.rmw || 0, flags.other || 0]);
    ids.push(r.insertId);
    return r.insertId;
}
async function addSummary(indicatorId, hospcode, target, last) {
    const [[h]] = await db.query('SELECT hosname, distid, hostype FROM chospital WHERE hoscode = ?', [hospcode]);
    await db.query(
        `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [indicatorId, YEAR, hospcode, deptId, 'test_dept', h.hosname, h.distid, 'test_dist', h.hostype, target, last, last]);
}

let indR9Moph, indSsj, indNone;
describe('รายงานสถิติแยกประเภทตัวชี้วัด (integration)', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
        const hs = (await db.query('SELECT hoscode FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 2'))[0];
        deptId = d.id; hospA = hs[0].hoscode; hospB = hs[1].hoscode;
        const sa = await ensureTestUser(db, { username: 'test_itype_sa', role: 'super_admin', session_id: 'sess-it-sa' });
        saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-it-sa' });
        indR9Moph = await addIndicator('test_itype_r9moph', { r9: 1, moph: 1 });
        indSsj = await addIndicator('test_itype_ssj', { ssj: 1 });
        indNone = await addIndicator('test_itype_none', {});
        await addSummary(indR9Moph, hospA, '80', '90');  // ผ่าน
        await addSummary(indR9Moph, hospB, '80', '10');  // ไม่ผ่าน
        await addSummary(indSsj, hospA, '50', '60');     // ผ่าน
        await addSummary(indNone, hospA, '50', '10');    // ไม่ผ่าน
    });
    afterAll(async () => {
        await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
        if (ids.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [ids]);
        await cleanupTestUsers(db);
    });

    const chart = (qs = '') => request(app).get(api(`/report/chart-stats?year_bh=${YEAR}${qs}`)).set('Authorization', `Bearer ${saToken}`);

    test('by_itype ครบ 5 ประเภทหลัก (+ ไม่ระบุประเภทเมื่อมีข้อมูล) และนับตัวชี้วัดหลายประเภทในทุกประเภท', async () => {
        const res = await chart();
        expect(res.status).toBe(200);
        const by = Object.fromEntries(res.body.by_itype.map(r => [r.gkey, r]));
        expect(Object.keys(by)).toEqual(['r9', 'moph', 'ssj', 'rmw', 'other', 'none']);
        expect(by.r9).toMatchObject({ gname: 'R9 เขต 9', pairs: 2, with_target: 2, passed: 1, achievement_pct: 50, indicator_count: 1 });
        expect(by.moph).toMatchObject({ pairs: 2, passed: 1 });
        expect(by.ssj).toMatchObject({ pairs: 1, passed: 1, achievement_pct: 100 });
        expect(by.rmw).toMatchObject({ pairs: 0, with_target: 0 });
        expect(by.other.pairs).toBe(0);
        expect(by.none).toMatchObject({ pairs: 1, passed: 0 });
        expect(by.r9.months).toHaveLength(12);
        expect(res.body.options.itypes.map(o => o.id)).toEqual(['r9', 'moph', 'ssj', 'rmw', 'other', 'none']);
        // ตัวชี้วัดรายตัวมีธงประเภท
        const row = res.body.by_indicator.find(r => Number(r.gkey) === indR9Moph);
        expect(Number(row.r9)).toBe(1); expect(Number(row.moph)).toBe(1); expect(Number(row.ssj)).toBe(0);
    });

    test('ตัวกรอง itype: กราฟเหลือเฉพาะตัวชี้วัดประเภทนั้น / หลายประเภท / ไม่รู้จัก = ว่าง', async () => {
        const r1 = await chart('&itype=ssj');
        expect(r1.body.overall).toMatchObject({ pairs: 1, indicator_count: 1, passed: 1 });
        const r2 = await chart('&itype=ssj,none');
        expect(r2.body.overall.pairs).toBe(2);
        const r3 = await chart('&itype=nope');
        expect(r3.body.overall.pairs).toBe(0);
        const r4 = await chart('&itype=none');
        expect(r4.body.by_indicator.map(r => Number(r.gkey))).toEqual([indNone]);
    });

    test('รายงานรายตัวชี้วัดรับตัวกรอง itype', async () => {
        const res = await request(app).get(api(`/report/by-indicator?year_bh=${YEAR}&itype=r9`)).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
        const rows = res.body.data || res.body.rows || res.body;
        const idsOut = (Array.isArray(rows) ? rows : []).map(r => Number(r.indicator_id));
        expect(idsOut).toContain(indR9Moph);
        expect(idsOut).not.toContain(indSsj);
        expect(idsOut).not.toContain(indNone);
    });
});
