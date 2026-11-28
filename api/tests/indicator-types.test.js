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

/**
 * ตรวจทุกแถบของรายงานสรุปผลเมื่อกรองประเภทตัวชี้วัด (20 พ.ย. 2569)
 * Regression: สรุปรายกลุ่มงาน — จำนวนตัวชี้วัดของกลุ่มงานไม่เปลี่ยนเมื่อเลือกประเภท (นับจาก kpi_indicators โดยไม่กรองประเภท)
 */
describe('รายงานสรุปผลทุกแถบกรองประเภทตัวชี้วัดถูกต้อง (integration)', () => {
    const Y = '2503';
    let sa, saTok, dept, hA, hB;
    const mine = [];
    const tok = () => ({ Authorization: `Bearer ${saTok}` });
    const get = (p) => request(app).get(api(p)).set(tok());
    const typeOf = async (ids) => {
        if (!ids.length) return [];
        const [rows] = await db.query('SELECT id, r9, moph, ssj, rmw, `other` FROM kpi_indicators WHERE id IN (?)', [ids]);
        return rows;
    };
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
        dept = d.id;
        const hs = (await db.query('SELECT hoscode FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 2'))[0];
        hA = hs[0].hoscode; hB = hs[1].hoscode;
        sa = await ensureTestUser(db, { username: 'test_itype_sa2', role: 'super_admin', session_id: 'sess-it-sa2' });
        saTok = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-it-sa2' });
        for (const [name, flags] of [['test_itall_rmw', { rmw: 1 }], ['test_itall_rmwssj', { rmw: 1, ssj: 1 }], ['test_itall_moph', { moph: 1 }]]) {
            const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, r9, moph, ssj, rmw, `other`) VALUES (?,?,1,?,?,?,?,?)',
                [name, dept, flags.r9 || 0, flags.moph || 0, flags.ssj || 0, flags.rmw || 0, flags.other || 0]);
            mine.push(r.insertId);
        }
        for (const id of mine) for (const h of [hA, hB]) {
            await db.query('INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id) VALUES (?,?,?,?,?,?,?,?)',
                [id, Y, h, 10, '80', h === hA ? '90' : '', 'Pending', sa.id]);
            const [[ch]] = await db.query('SELECT hosname, distid, hostype FROM chospital WHERE hoscode = ?', [h]);
            await db.query(`INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [id, Y, h, dept, 'test_dept', ch.hosname, ch.distid, 'test_dist', ch.hostype, '80', h === hA ? '90' : '10', h === hA ? '90' : '10']);
        }
    });
    afterAll(async () => {
        await db.query('DELETE FROM kpi_results WHERE year_bh = ? AND indicator_id IN (?)', [Y, mine]);
        await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [Y]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [mine]);
        await cleanupTestUsers(db);
    });

    test('สรุปรายกลุ่มงาน: จำนวนตัวชี้วัดของกลุ่มงานตามประเภทที่เลือก (ตรงกับฐานข้อมูล) + หน้าเจาะลึก', async () => {
        const all = await get(`/report/by-dept-summary?year_bh=${Y}`);
        const rmw = await get(`/report/by-dept-summary?year_bh=${Y}&itype=rmw`);
        const [[exp]] = await db.query('SELECT COUNT(*) AS n FROM kpi_indicators WHERE dept_id = ? AND is_active = 1 AND COALESCE(rmw,0) = 1', [dept]);
        const [[expAll]] = await db.query('SELECT COUNT(*) AS n FROM kpi_indicators WHERE dept_id = ? AND is_active = 1', [dept]);
        const rowOf = (res) => res.body.data.find(r => Number(r.dept_id) === Number(dept));
        expect(Number(rowOf(all).total_indicators)).toBe(Number(expAll.n));
        expect(Number(rowOf(rmw).total_indicators)).toBe(Number(exp.n));
        expect(Number(rowOf(rmw).total_indicators)).toBeLessThan(Number(rowOf(all).total_indicators));
        const none = await get(`/report/by-dept-summary?year_bh=${Y}&itype=bogus`);
        expect(none.body.data.length).toBe(0);
        const drill = await get(`/report/by-dept-summary/indicators?year_bh=${Y}&dept_id=${dept}&itype=rmw`);
        const ids = drill.body.data.map(r => Number(r.indicator_id));
        expect(ids).toEqual(expect.arrayContaining([mine[0], mine[1]]));
        expect(ids).not.toContain(mine[2]);
        expect((await typeOf(ids)).every(r => Number(r.rmw) === 1)).toBe(true);
    });

    test('รายตัวชี้วัด / สถานะการบันทึก / หน่วยบริการที่ยังไม่บันทึก: มีแต่ตัวชี้วัดประเภทที่เลือก', async () => {
        for (const p of [`/report/by-indicator?year_bh=${Y}&itype=moph`, `/report/recording-status?year_bh=${Y}&itype=moph`, `/report/recording-missing/by-hospital/${hB}?year_bh=${Y}&itype=moph`]) {
            const res = await get(p);
            expect(res.status).toBe(200);
            const rows = Array.isArray(res.body.data) ? res.body.data : (res.body.data?.indicators || res.body.indicators || []);
            const ids = rows.map(r => Number(r.indicator_id ?? r.id)).filter(Boolean);
            expect(ids.length).toBeGreaterThan(0);
            expect((await typeOf(ids)).every(r => Number(r.moph) === 1)).toBe(true);
            expect(ids).toContain(mine[2]);
        }
    });

    test('รายหน่วยบริการ / รายอำเภอ / รายปี / สถานะรายหน่วยบริการ: ประเภทไม่รู้จัก = ไม่มีข้อมูล, ประเภทที่มี = มีข้อมูล', async () => {
        for (const p of ['/report/by-hospital', '/report/by-district', '/report/by-year', '/report/recording-status/by-hospital']) {
            const ok = await get(`${p}?year_bh=${Y}&itype=rmw`);
            const bad = await get(`${p}?year_bh=${Y}&itype=bogus`);
            expect(ok.status).toBe(200); expect(bad.status).toBe(200);
            const len = (b) => (Array.isArray(b.data) ? b.data : (b.data?.hospitals || b.hospitals || [])).length;
            expect(len(bad.body)).toBe(0);
            expect(len(ok.body)).toBeGreaterThan(0);
        }
    });
});
