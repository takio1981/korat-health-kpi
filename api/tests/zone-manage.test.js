/**
 * หน้าจัดการโซน (9 พ.ย. 2569): ชื่อโซน + เพิ่มโซนเกิน 6 (รหัส 1–99) + ย้ายอำเภอ (อัปเดตหน่วยบริการทุกแห่งในอำเภอ)
 *   - seed ครั้งแรกจาก DISTRICT_ZONES, chospital.zone รองรับ 2 หลัก
 *   - GET /zones (ทุก role), GET|PUT /zones/districts + POST/PUT /zones (requireAction kpi-manage), DELETE /zones/:code (super_admin)
 *   - ตัวกรอง zone ใช้โซนใหม่ได้ทันที | POST /hospitals ไม่ส่งโซน = โซนของอำเภอจาก district_zones
 * คืนค่าโซนเดิมของอำเภอ/หน่วยบริการ/ตาราง zones ใน afterAll (ฐานทดสอบเท่านั้น)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { parseZones, isZoneCode, DISTRICT_ZONES } = require('../core/zones');

const api = (p) => '/khupskpi/api' + p;
let app, db, saToken, ssjToken, hosToken, dist, origHosp, origZones, origDz;
const as = (t, r) => r.set('Authorization', `Bearer ${t}`);
const TEST_HOS = 'TZ001';

describe('core/zones.js รหัสโซน 2 หลัก', () => {
    test('isZoneCode / parseZones รับ 1–99', () => {
        expect(isZoneCode('7')).toBe(true);
        expect(isZoneCode('12')).toBe(true);
        expect(isZoneCode('0')).toBe(false);
        expect(isZoneCode('100')).toBe(false);
        expect(parseZones('1,12,abc')).toEqual(['1', '12']);
    });
});

describe('API จัดการโซน', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        await cleanupTestUsers(db);
        [origZones] = await db.query('SELECT code, name, sort_order FROM zones');
        [origDz] = await db.query('SELECT distid, zone_code FROM district_zones');
        // อำเภอที่มีหน่วยบริการมากกว่า 1 แห่ง (เรียงคงที่)
        const [[d]] = await db.query("SELECT distid, COUNT(*) AS n FROM chospital WHERE distid LIKE '30%' GROUP BY distid HAVING n > 1 ORDER BY n DESC, distid LIMIT 1");
        dist = String(d.distid);
        [origHosp] = await db.query('SELECT hoscode, zone FROM chospital WHERE distid = ?', [dist]);
        await db.query('DELETE FROM chospital WHERE hoscode = ?', [TEST_HOS]);
        const sa = await ensureTestUser(db, { username: 'test_zone_sa', role: 'super_admin' });
        saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
        const ssj = await ensureTestUser(db, { username: 'test_zone_ssj', role: 'admin_ssj' });
        ssjToken = makeToken({ userId: ssj.id, username: ssj.username, role: 'admin_ssj' });
        const hos = await ensureTestUser(db, { username: 'test_zone_hos', role: 'user_hos' });
        hosToken = makeToken({ userId: hos.id, username: hos.username, role: 'user_hos' });
    });
    afterAll(async () => {
        await db.query('DELETE FROM chospital WHERE hoscode = ?', [TEST_HOS]);
        for (const h of origHosp) await db.query('UPDATE chospital SET zone = ? WHERE hoscode = ?', [h.zone, h.hoscode]);
        await db.query('DELETE FROM district_zones');
        for (const r of origDz) await db.query('INSERT INTO district_zones (distid, zone_code) VALUES (?, ?)', [r.distid, r.zone_code]);
        await db.query('DELETE FROM zones');
        for (const z of origZones) await db.query('INSERT INTO zones (code, name, sort_order) VALUES (?, ?, ?)', [z.code, z.name, z.sort_order]);
        require('../services/zones').invalidateZoneCache();
        await cleanupTestUsers(db);
    });

    test('seed จาก DISTRICT_ZONES: 6 โซน 32 อำเภอ | chospital.zone ขยายเป็น VARCHAR(10)', async () => {
        const codes = origZones.map(z => String(z.code));
        for (const z of Object.keys(DISTRICT_ZONES)) expect(codes).toContain(z);
        expect(origDz.length).toBeGreaterThanOrEqual(32);
        const [[col]] = await db.query("SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chospital' AND COLUMN_NAME = 'zone'");
        expect(Number(col.len)).toBe(10);
    });

    test('GET /zones ทุก role เห็นรายการ + จำนวน | GET /zones/districts ต้องมีสิทธิ์แก้ไขหน้าจัดการตัวชี้วัด', async () => {
        const r = await as(hosToken, request(app).get(api('/zones')));
        expect(r.status).toBe(200);
        expect(r.body.data.find(z => z.code === '1').district_count).toBeGreaterThan(0);
        expect((await as(hosToken, request(app).get(api('/zones/districts')))).status).toBe(403);
        const d = await as(saToken, request(app).get(api('/zones/districts')));
        expect(d.status).toBe(200);
        expect(d.body.data.find(x => x.distid === dist).hospital_count).toBe(origHosp.length);
    });

    test('✅ เพิ่มโซนเกิน 6 + ตั้งชื่อ → ย้ายอำเภอ = หน่วยบริการทุกแห่งเปลี่ยน → ตัวกรองโซนใหม่ใช้ได้ทันที', async () => {
        const add = await as(saToken, request(app).post(api('/zones'))).send({ name: 'โซนทดสอบ' });
        expect(add.status).toBe(200);
        const code = add.body.data.code;
        expect(Number(code)).toBeGreaterThan(6);
        const add2 = await as(saToken, request(app).post(api('/zones'))).send({});
        expect(Number(add2.body.data.code)).toBe(Number(code) + 1);   // รหัสถัดไปอัตโนมัติ (2 หลักได้ถ้าเกิน 9)
        expect((await as(saToken, request(app).put(api('/zones/' + code))).send({ name: 'โซนทดสอบใหม่' })).status).toBe(200);
        const list = (await as(saToken, request(app).get(api('/zones')))).body.data;
        expect(list.find(z => z.code === code).name).toBe('โซนทดสอบใหม่');

        const mv = await as(saToken, request(app).put(api('/zones/districts'))).send({ changes: [{ distid: dist, zone: code }] });
        expect(mv.status).toBe(200);
        expect(mv.body.data[0].hospitals).toBe(origHosp.length);
        const [rows] = await db.query('SELECT DISTINCT zone FROM chospital WHERE distid = ?', [dist]);
        expect(rows.map(r => r.zone)).toEqual([code]);
        const ds = (await as(saToken, request(app).get(api('/districts')))).body.data;
        expect(String(ds.find(x => String(x.distid) === dist).zone)).toBe(code);
        const hz = (await as(saToken, request(app).get(api('/hospitals')))).body.data;
        expect(hz.filter(h => String(h.zone) === code).length).toBe(origHosp.length);

        // หน่วยบริการใหม่ในอำเภอนี้ (ไม่ส่งโซน) = โซนใหม่ของอำเภอ
        const [[h0]] = await db.query('SELECT provcode, distcode FROM chospital WHERE distid = ? LIMIT 1', [dist]);
        const ph = await as(saToken, request(app).post(api('/hospitals'))).send({ hoscode: TEST_HOS, hosname: 'test_zone รพ.', hostype: '18', provcode: h0.provcode, distcode: h0.distcode });
        expect(ph.status).toBe(200);
        const [[nh]] = await db.query('SELECT zone FROM chospital WHERE hoscode = ?', [TEST_HOS]);
        expect(nh.zone).toBe(code);
        // ส่งโซนที่ไม่มีอยู่ = 400
        const bad = await as(saToken, request(app).put(api('/hospitals/' + TEST_HOS))).send({ hosname: 'x', provcode: h0.provcode, distcode: h0.distcode, zone: '98' });
        expect(bad.status).toBe(400);

        // ลบโซนที่ยังมีอำเภอ = 400 | admin_ssj ลบ = 403 | ลบโซนว่าง = 200
        expect((await as(saToken, request(app).delete(api('/zones/' + code)))).status).toBe(400);
        expect((await as(ssjToken, request(app).delete(api('/zones/' + add2.body.data.code)))).status).toBe(403);
        expect((await as(saToken, request(app).delete(api('/zones/' + add2.body.data.code)))).status).toBe(200);
    });

    test('ย้ายไปโซนที่ไม่มี / อำเภอผิด / ไม่มีรายการ = 400 (ไม่มีอะไรเปลี่ยน) | role ไม่มีสิทธิ์ = 403', async () => {
        const before = (await db.query('SELECT zone FROM chospital WHERE distid = ? LIMIT 1', [dist]))[0][0].zone;
        expect((await as(saToken, request(app).put(api('/zones/districts'))).send({ changes: [{ distid: dist, zone: '97' }] })).status).toBe(400);
        expect((await as(saToken, request(app).put(api('/zones/districts'))).send({ changes: [{ distid: 'x', zone: '1' }] })).status).toBe(400);
        expect((await as(saToken, request(app).put(api('/zones/districts'))).send({ changes: [] })).status).toBe(400);
        expect((await as(hosToken, request(app).put(api('/zones/districts'))).send({ changes: [{ distid: dist, zone: '1' }] })).status).toBe(403);
        expect((await as(hosToken, request(app).post(api('/zones'))).send({ name: 'x' })).status).toBe(403);
        expect((await db.query('SELECT zone FROM chospital WHERE distid = ? LIMIT 1', [dist]))[0][0].zone).toBe(before);
    });
});
