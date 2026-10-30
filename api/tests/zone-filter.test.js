/**
 * ตัวกรองโซนของหน่วยบริการ (chospital.zone '1'–'6' ตามอำเภอ — 30 ต.ค. 2569)
 *   - core/zones.js: แปลงพารามิเตอร์ / เงื่อนไข SQL / ตารางอำเภอ → โซน ครบ 32 อำเภอไม่ซ้ำ
 *   - migration backfill โซนตามอำเภอ, GET /hospitals และ /districts ส่ง zone
 *   - พารามิเตอร์ zone ใน /report/chart-stats, /report/by-hospital, /report/by-indicator, /kpi-results
 *   - POST/PUT /hospitals ตรวจค่าโซน (ไม่ใช่ตัวเลข 1–9 = 400)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { DISTRICT_ZONES, zoneOfDistrict, parseZones, zoneFilter, addZoneFilter } = require('../core/zones');

const YEAR = '2502'; // ปีแยกเฉพาะ test นี้
let app, db, saToken, saId, deptId, indId, hospA, hospB;
const api = (p) => '/khupskpi/api' + p;
const auth = (r) => r.set('Authorization', `Bearer ${saToken}`);

describe('core/zones.js', () => {
    test('ทุกอำเภอของนครราชสีมา (3001–3032) อยู่ในโซนเดียวเท่านั้น', () => {
        const all = Object.values(DISTRICT_ZONES).flat();
        expect(all).toHaveLength(32);
        expect(new Set(all).size).toBe(32);
        for (let i = 1; i <= 32; i++) expect(all).toContain(String(3000 + i));
        expect(zoneOfDistrict('3001')).toBe('1');   // เมืองนครราชสีมา
        expect(zoneOfDistrict('3027')).toBe('3');   // เมืองยาง
        expect(zoneOfDistrict('3021')).toBe('6');   // ปากช่อง
        expect(zoneOfDistrict('9999')).toBeNull();
    });
    test('parseZones: ไม่ส่ง = null, ค่าผิดถูกตัดทิ้ง, ไม่ซ้ำ', () => {
        expect(parseZones(undefined)).toBeNull();
        expect(parseZones('')).toBeNull();
        expect(parseZones('1, 3,3')).toEqual(['1', '3']);
        expect(parseZones("x' OR 1=1")).toEqual([]);
    });
    test('zoneFilter / addZoneFilter: ค่าผิดทั้งหมด = ไม่มีข้อมูล, ไม่กรอง = ไม่เพิ่มเงื่อนไข', () => {
        expect(zoneFilter('s.distid', null)).toBeNull();
        expect(zoneFilter('s.distid', [])).toEqual({ sql: '1 = 0', params: [] });
        expect(zoneFilter('r.hospcode', ['2'], 'hos').sql).toContain('zh.hoscode');
        const c = [], p = [];
        addZoneFilter(c, p, 's.distid', undefined);
        expect(c).toEqual([]);
        addZoneFilter(c, p, 's.distid', '1,2');
        expect(c).toHaveLength(1);
        expect(p).toEqual([['1', '2']]);
    });
});

describe('API ตัวกรองโซน', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        await cleanupTestUsers(db);
        const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
        deptId = d.id;
        // หน่วยบริการ 2 แห่งต่างโซน (เรียงตามรหัสให้ผลคงที่)
        const [rows] = await db.query("SELECT hoscode, distid, zone FROM chospital WHERE zone IS NOT NULL AND zone <> '' ORDER BY zone, hoscode");
        hospA = rows[0];
        hospB = rows.find(r => r.zone !== hospA.zone);
        const sa = await ensureTestUser(db, { username: 'test_zone_sa', role: 'super_admin', session_id: 'sess-zone-sa' });
        saId = sa.id;
        saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-zone-sa' });
        const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?,?,1)', ['test_zone_ind', deptId]);
        indId = r.insertId;
        for (const h of [hospA, hospB]) {
            await db.query(
                `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [indId, YEAR, h.hoscode, deptId, 'test_dept', 'test_hos', h.distid, 'test_dist', '07', '80', '90']);
            await db.query(
                'INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, user_id, status) VALUES (?,?,?,?,?,?,?,?)',
                [indId, YEAR, h.hoscode, 10, '80', '90', saId, 'Approved']);
        }
    });

    afterAll(async () => {
        if (indId) {
            await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [indId]);
            await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
            await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
        }
        await db.query("DELETE FROM chospital WHERE hoscode = 'TZ999'");
        await cleanupTestUsers(db);
    });

    test('มีหน่วยบริการต่างโซนให้ทดสอบ (migration backfill โซนตามอำเภอแล้ว)', async () => {
        expect(hospA).toBeTruthy();
        expect(hospB).toBeTruthy();
        const [bad] = await db.query("SELECT hoscode, distid, zone FROM chospital WHERE distid LIKE '30%' AND (zone IS NULL OR zone = '')");
        expect(bad).toEqual([]);
        expect(zoneOfDistrict(hospA.distid)).toBe(hospA.zone);
    });

    test('GET /hospitals และ /districts ส่งโซนมาด้วย', async () => {
        const h = await auth(request(app).get(api('/hospitals')));
        expect(h.status).toBe(200);
        expect(h.body.data.find(x => x.hoscode === hospA.hoscode).zone).toBe(hospA.zone);
        const d = await auth(request(app).get(api('/districts')));
        expect(d.status).toBe(200);
        expect(d.body.data.find(x => x.distid === hospA.distid).zone).toBe(hospA.zone);
    });

    test('GET /hospital-zones: รหัสหน่วยบริการ → โซน ทุกแห่ง (ใช้กับป้ายโซนต่อท้ายชื่อหน่วยบริการ)', async () => {
        const r = await auth(request(app).get(api('/hospital-zones')));
        expect(r.status).toBe(200);
        expect(r.body.data[hospA.hoscode]).toBe(hospA.zone);
        expect(r.body.data[hospB.hoscode]).toBe(hospB.zone);
        const anon = await request(app).get(api('/hospital-zones'));
        expect(anon.status).toBe(401);
    });

    test('GET /report/chart-stats?zone=กรองเฉพาะโซนที่เลือก + มีตัวเลือกโซน', async () => {
        const all = await auth(request(app).get(api(`/report/chart-stats?year_bh=${YEAR}&indicator_id=${indId}`)));
        expect(all.body.overall.pairs).toBe(2);
        expect(all.body.options.zones).toEqual(expect.arrayContaining([hospA.zone, hospB.zone]));
        expect(all.body.options.districts.find(x => x.id === hospA.distid).zone).toBe(hospA.zone);
        const z = await auth(request(app).get(api(`/report/chart-stats?year_bh=${YEAR}&indicator_id=${indId}&zone=${hospA.zone}`)));
        expect(z.body.overall.pairs).toBe(1);
        const none = await auth(request(app).get(api(`/report/chart-stats?year_bh=${YEAR}&indicator_id=${indId}&zone=abc`)));
        expect(none.body.overall.pairs).toBe(0);
    });

    test('GET /report/by-hospital และ /report/by-indicator?zone=', async () => {
        const h = await auth(request(app).get(api(`/report/by-hospital?year_bh=${YEAR}&zone=${hospB.zone}`)));
        expect(h.status).toBe(200);
        const codes = (h.body.data || []).map(r => r.hospcode);
        expect(codes).toContain(hospB.hoscode);
        expect(codes).not.toContain(hospA.hoscode);
        const i = await auth(request(app).get(api(`/report/by-indicator?year_bh=${YEAR}&zone=${hospA.zone}`)));
        expect(i.status).toBe(200);
        expect(i.body.success).toBe(true);
    });

    test('GET /kpi-results?zone= กรองหน่วยบริการตามโซน', async () => {
        const r = await auth(request(app).get(api(`/kpi-results?year=${YEAR}&zone=${hospA.zone}`)));
        expect(r.status).toBe(200);
        const codes = r.body.data.filter(x => Number(x.indicator_id) === indId).map(x => x.hospcode);
        expect(codes).toEqual([hospA.hoscode]);
    });

    test('POST/PUT /hospitals: โซนไม่ใช่ตัวเลข = 400, ไม่ส่งโซน = ตามอำเภอ', async () => {
        const bad = await auth(request(app).post(api('/hospitals')))
            .send({ hoscode: 'TZ999', hosname: 'test_zone_hos', hostype: '18', provcode: '30', distcode: '21', zone: 'x' });
        expect(bad.status).toBe(400);
        const ok = await auth(request(app).post(api('/hospitals')))
            .send({ hoscode: 'TZ999', hosname: 'test_zone_hos', hostype: '18', provcode: '30', distcode: '21' });
        expect(ok.status).toBe(200);
        let [[row]] = await db.query("SELECT zone FROM chospital WHERE hoscode = 'TZ999'");
        expect(row.zone).toBe('6'); // ปากช่อง
        const put = await auth(request(app).put(api('/hospitals/TZ999')))
            .send({ hosname: 'test_zone_hos', hostype: '18', provcode: '30', distcode: '21', zone: '2' });
        expect(put.status).toBe(200);
        [[row]] = await db.query("SELECT zone FROM chospital WHERE hoscode = 'TZ999'");
        expect(row.zone).toBe('2');
        const putBad = await auth(request(app).put(api('/hospitals/TZ999')))
            .send({ hosname: 'test_zone_hos', hostype: '18', provcode: '30', distcode: '21', zone: '12' });
        expect(putBad.status).toBe(400);
    });
});
