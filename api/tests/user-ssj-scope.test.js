/**
 * user_ssj เห็นทุกหน่วยบริการ ทุกอำเภอ เฉพาะกลุ่มงานตัวเอง (6 พ.ย. 2569 — เดิมเห็นเฉพาะหน่วยบริการตัวเอง)
 *   - /hospitals, /kpi-results, /report/by-hospital, /dashboard-stats: ทุกหน่วยบริการ แต่เฉพาะตัวชี้วัดของหน่วยงานตัวเอง
 *   - บันทึก (update-kpi, sub-results/upsert, dynamic-data): ผู้ใช้ที่ไม่ใช่ผู้ดูแลบันทึกได้เฉพาะหน่วยบริการตัวเอง → 403 FOREIGN_HOSPCODE
 *     (เดิม /update-kpi แทน hospcode ของแถวด้วยของผู้ใช้เงียบๆ — ค่าที่แก้ในแถวหน่วยบริการอื่นไปลงหน่วยบริการตัวเอง)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { ROLE_SCOPE_HOSPCODE, ROLE_SCOPE_OWN_DEPT, ROLE_SCOPE_ALL_HOSPCODE_OWN_DEPT, foreignWriteHospcodes } = require('../core/access');

const YEAR = '2503'; // ปีแยกเฉพาะ test นี้
let app, db, ssj, ssjToken, cupToken, deptA, deptB, indA, indB, subA, hosA, hosB, distB;
const api = (p) => '/khupskpi/api' + p;
const as = (r, t) => r.set('Authorization', `Bearer ${t}`);

describe('core/access.js', () => {
    test('user_ssj: ไม่อยู่ใน ROLE_SCOPE_HOSPCODE แต่ยังจำกัดหน่วยงานตัวเอง', () => {
        expect(ROLE_SCOPE_HOSPCODE).not.toContain('user_ssj');
        expect(ROLE_SCOPE_OWN_DEPT).toContain('user_ssj');
        expect(ROLE_SCOPE_ALL_HOSPCODE_OWN_DEPT).toEqual(['admin_ssj', 'user_ssj']);
    });
    test('foreignWriteHospcodes: ผู้ใช้ที่ไม่ใช่ผู้ดูแลบันทึกได้เฉพาะหน่วยบริการตัวเอง', () => {
        expect(foreignWriteHospcodes({ role: 'user_ssj', hospcode: '10001' }, ['10001', ' 10002', '10002', null])).toEqual(['10002']);
        expect(foreignWriteHospcodes({ role: 'user_cup', hospcode: '10001' }, ['10003'])).toEqual(['10003']);
        expect(foreignWriteHospcodes({ role: 'admin_ssj', hospcode: '10001' }, ['10002'])).toEqual([]);
        expect(foreignWriteHospcodes({ role: 'admin_cup', hospcode: '10001' }, ['10002'])).toEqual([]);
    });
});

describe('API ขอบเขต user_ssj', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        await migrationsReady;
        db = require('../db');
        await cleanupTestUsers(db);
        const [deps] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
        [deptA, deptB] = deps.map(d => d.id);
        // หน่วยบริการ 2 แห่งต่างอำเภอ (เรียงตามรหัสให้ผลคงที่)
        const [hs] = await db.query("SELECT hoscode, distid FROM chospital WHERE distid IS NOT NULL AND distid <> '' ORDER BY distid, hoscode");
        hosA = hs[0].hoscode;
        const other = hs.find(h => h.distid !== hs[0].distid);
        hosB = other.hoscode; distB = other.distid;
        const u = await ensureTestUser(db, { username: 'test_ssjscope_user', role: 'user_ssj', dept_id: deptA, hospcode: hosA });
        ssj = u.id;
        ssjToken = makeToken({ userId: u.id, username: u.username, role: 'user_ssj', deptId: deptA, hospcode: hosA });
        const c = await ensureTestUser(db, { username: 'test_ssjscope_cup', role: 'user_cup', dept_id: deptA, hospcode: hosA });
        cupToken = makeToken({ userId: c.id, username: c.username, role: 'user_cup', deptId: deptA, hospcode: hosA });

        const mk = async (name, dept) => (await db.query(
            "INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, evaluation_mode) VALUES (?,?,1,'all_required')", [name, dept]))[0].insertId;
        indA = await mk('test_ssjscope ตัวชี้วัด A', deptA);
        indB = await mk('test_ssjscope ตัวชี้วัด B', deptB);
        subA = (await db.query('INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, is_active) VALUES (?,?,1)', [indA, 'test_ssjscope ข้อย่อย']))[0].insertId;
        for (const ind of [indA, indB]) {
            for (const hc of [hosA, hosB]) {
                await db.query(
                    'INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, user_id, status) VALUES (?,?,?,?,?,?,?,?)',
                    [ind, YEAR, hc, 10, '80', '90', ssj, 'Approved']);
                const [[h]] = await db.query('SELECT distid FROM chospital WHERE hoscode = ?', [hc]);
                await db.query(
                    `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                    [ind, YEAR, hc, ind === indA ? deptA : deptB, 'test_dept', 'test_hos', h.distid, 'test_dist', '07', '80', '90']);
            }
        }
    });

    afterAll(async () => {
        await db.query('DELETE FROM kpi_sub_results WHERE sub_indicator_id = ?', [subA]);
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [[indA, indB]]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [[indA, indB]]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [[indA, indB]]);
        await cleanupTestUsers(db);
    });

    test('GET /hospitals และ /districts: เห็นทุกหน่วยบริการ ทุกอำเภอ', async () => {
        const h = await as(request(app).get(api('/hospitals')), ssjToken);
        expect(h.status).toBe(200);
        const codes = h.body.data.map(x => x.hoscode);
        expect(codes).toEqual(expect.arrayContaining([hosA, hosB]));
        const d = await as(request(app).get(api('/districts')), ssjToken);
        expect(d.body.data.map(x => x.distid)).toContain(distB);
    });

    test('GET /kpi-results: ทุกหน่วยบริการ แต่เฉพาะตัวชี้วัดของหน่วยงานตัวเอง', async () => {
        const r = await as(request(app).get(api(`/kpi-results?year=${YEAR}`)), ssjToken);
        expect(r.status).toBe(200);
        const mine = r.body.data.filter(x => [indA, indB].includes(Number(x.indicator_id)));
        expect(mine.map(x => `${x.indicator_id}|${x.hospcode}`).sort()).toEqual([`${indA}|${hosA}`, `${indA}|${hosB}`].sort());
    });

    test('GET /report/by-hospital: เห็นหน่วยบริการอื่นของหน่วยงานตัวเอง', async () => {
        const r = await as(request(app).get(api(`/report/by-hospital?year_bh=${YEAR}`)), ssjToken);
        expect(r.status).toBe(200);
        const codes = (r.body.data || []).map(x => x.hospcode);
        expect(codes).toEqual(expect.arrayContaining([hosA, hosB]));
    });

    test('POST /update-kpi แถวของหน่วยบริการอื่น = 403 และข้อมูลหน่วยบริการตัวเองไม่ถูกแก้', async () => {
        const res = await as(request(app).post(api('/update-kpi')), ssjToken)
            .send({ updates: [{ indicator_id: indA, year_bh: YEAR, hospcode: hosB, target_value: '80', oct: '1' }] });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FOREIGN_HOSPCODE');
        const [[own]] = await db.query('SELECT actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = 10', [indA, YEAR, hosA]);
        expect(own.actual_value).toBe('90');
        // user_cup ก็เช่นกัน (เดิมเห็นทั้งอำเภอแต่บันทึกลงหน่วยบริการตัวเองเงียบๆ)
        const cup = await as(request(app).post(api('/update-kpi')), cupToken)
            .send({ updates: [{ indicator_id: indA, year_bh: YEAR, hospcode: hosB, target_value: '80', oct: '1' }] });
        expect(cup.status).toBe(403);
    });

    test('POST /sub-results/upsert และ /dynamic-data ของหน่วยบริการอื่น = 403', async () => {
        const s = await as(request(app).post(api('/sub-results/upsert')), ssjToken)
            .send({ sub_indicator_id: subA, year_bh: YEAR, hospcode: hosB, month_bh: 10, actual_value: '5' });
        expect(s.status).toBe(403);
        const [[n]] = await db.query('SELECT COUNT(*) c FROM kpi_sub_results WHERE sub_indicator_id = ?', [subA]);
        expect(Number(n.c)).toBe(0);
        const d = await as(request(app).post(api('/dynamic-data/test_ssjscope_none')), ssjToken)
            .send({ hospcode: hosB, year_bh: YEAR, month_bh: 10 });
        expect(d.status).toBe(403);
        // หน่วยบริการตัวเองบันทึกผลงานย่อยได้
        const ok = await as(request(app).post(api('/sub-results/upsert')), ssjToken)
            .send({ sub_indicator_id: subA, year_bh: YEAR, hospcode: hosA, month_bh: 10, actual_value: '5' });
        expect(ok.status).toBe(200);
    });
});
