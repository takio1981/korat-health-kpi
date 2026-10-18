/**
 * Integration tests: ตัวชี้วัด 3 ระดับ (หลัก → ย่อย → กิจกรรม) — database ทดสอบเท่านั้น
 *   - ข้อย่อย 'auto' ที่มีกิจกรรม = ค่าจากกิจกรรม (ตัวเลข / ทำแล้ว = 100, ยังไม่ทำ = 0) ด้วยกติกาเดียวกับข้อย่อย→หลัก
 *   - ข้อย่อย 'auto' ที่ยังไม่มีกิจกรรม = ค่าที่กรอกเอง (ข้อมูลเดิมไม่หาย)
 *   - ตัวชี้วัดหลัก 'manual' ไม่ถูกนำค่าข้อย่อยไปทับ (summary ส่ง sub_rollup_mode ให้หน้าจอ)
 *   - POST /hierarchy-results/save: ห้ามกรอกข้อ auto, ล็อคจากการอนุมัติ, ขอบเขตหน่วยบริการ, cascade อนุมัติ/ปลดล็อคถึงกิจกรรม
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2503';
let app, db, loadSubExportMonthMap, saToken, userToken, otherToken, deptId, hospA, hospB, indId, ind2Id;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const as = (tok, r) => r.set('Authorization', `Bearer ${tok}`);

async function summary(hospcode, indicatorId = indId) {
    const res = await as(saToken, request(app).get(api(`/sub-results/summary?year_bh=${YEAR}&hospcode=${hospcode}`)));
    expect(res.status).toBe(200);
    return res.body.data.find(r => Number(r.indicator_id) === indicatorId);
}
const save = (tok, body) => as(tok, request(app).post(api('/hierarchy-results/save'))).send({ year_bh: YEAR, ...body });

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady, loadSubExportMonthMap } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [hs] = await db.query("SELECT hoscode FROM chospital WHERE distid IS NOT NULL AND distid != '' ORDER BY hoscode LIMIT 1");
    deptId = d.id; hospA = hs[0].hoscode;
    const [[hb]] = await db.query('SELECT hoscode FROM chospital WHERE distid != ? ORDER BY hoscode LIMIT 1',
        [(await db.query('SELECT distid FROM chospital WHERE hoscode = ?', [hospA]))[0][0].distid]);
    hospB = hb.hoscode;

    const sa = await ensureTestUser(db, { username: 'test_hier_sa', role: 'super_admin', session_id: 'sess-hier-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-hier-sa' });
    const u = await ensureTestUser(db, { username: 'test_hier_user', role: 'user_hos', dept_id: deptId, hospcode: hospA, session_id: 'sess-hier-u' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hospA, sessionId: 'sess-hier-u' });
    const o = await ensureTestUser(db, { username: 'test_hier_other', role: 'user_hos', dept_id: deptId, hospcode: hospB, session_id: 'sess-hier-o' });
    otherToken = makeToken({ userId: o.id, username: o.username, role: 'user_hos', deptId, hospcode: hospB, sessionId: 'sess-hier-o' });

    const [i] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?,?,1)', ['test_hier_ind', deptId]);
    indId = i.insertId;
    const [i2] = await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, sub_rollup_mode) VALUES (?,?,1,'manual')", ['test_hier_ind_manual', deptId]);
    ind2Id = i2.insertId;
    const addSub = async (ind, name, mode) => (await db.query(
        'INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, rollup_mode, is_active) VALUES (?,?,?,1)', [ind, name, mode]))[0].insertId;
    ids.subAuto = await addSub(indId, 'test_hier_sub_auto', 'auto');     // 1.1 คำนวณจากกิจกรรม
    ids.subManual = await addSub(indId, 'test_hier_sub_manual', 'manual'); // 1.2 กรอกเอง
    ids.subAutoEmpty = await addSub(indId, 'test_hier_sub_auto_empty', 'auto'); // 1.3 auto แต่ยังไม่มีกิจกรรม
    ids.sub2 = await addSub(ind2Id, 'test_hier_sub2', 'manual');
});

afterAll(async () => {
    for (const id of [indId, ind2Id].filter(Boolean)) {
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_sub_indicators WHERE indicator_id = ?', [id]); // CASCADE → ผลงานย่อย/กิจกรรม/ผลงานกิจกรรม
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
    }
    await cleanupTestUsers(db);
});

describe('CRUD กิจกรรม', () => {
    test('✅ super_admin เพิ่มกิจกรรมแบบตัวเลขและแบบทำแล้ว', async () => {
        let r = await as(saToken, request(app).post(api('/sub-activities')))
            .send({ sub_indicator_id: ids.subAuto, activity_name: 'test_hier_act_num', item_no: '1.1.1', value_type: 'number', sort_order: 1 });
        expect(r.status).toBe(200); ids.actNum = r.body.id;
        r = await as(saToken, request(app).post(api('/sub-activities')))
            .send({ sub_indicator_id: ids.subAuto, activity_name: 'test_hier_act_chk', value_type: 'check', sort_order: 2 });
        expect(r.status).toBe(200); ids.actChk = r.body.id;
        const list = await as(saToken, request(app).get(api(`/sub-activities?sub_indicator_id=${ids.subAuto}`)));
        expect(list.body.data.map(a => a.value_type)).toEqual(['number', 'check']);
        expect(list.body.data[0].item_no).toBe('1.1.1');
    });

    test('❌ user ทั่วไปเพิ่มกิจกรรมไม่ได้ / ลบได้เฉพาะ super_admin', async () => {
        const r = await as(userToken, request(app).post(api('/sub-activities'))).send({ sub_indicator_id: ids.subAuto, activity_name: 'x' });
        expect(r.status).toBe(403);
        const d = await as(userToken, request(app).delete(api(`/sub-activities/${ids.actNum}`)));
        expect(d.status).toBe(403);
    });

    test('✅ PUT /sub-indicators รับ rollup_mode/item_no และไม่แตะค่าเมื่อไม่ได้ส่งมา', async () => {
        const base = { sub_indicator_name: 'test_hier_sub_manual', is_active: 1 };
        let r = await as(saToken, request(app).put(api(`/sub-indicators/${ids.subManual}`))).send({ ...base, item_no: '1.2' });
        expect(r.status).toBe(200);
        r = await as(saToken, request(app).put(api(`/sub-indicators/${ids.subManual}`))).send(base);
        const [[row]] = await db.query('SELECT item_no, rollup_mode FROM kpi_sub_indicators WHERE id = ?', [ids.subManual]);
        expect(row).toEqual({ item_no: '1.2', rollup_mode: 'manual' });
    });
});

describe('บันทึกและคำนวณ 3 ระดับ', () => {
    test('❌ ห้ามกรอกผลงานข้อย่อยที่คำนวณจากกิจกรรม', async () => {
        const r = await save(userToken, { hospcode: hospA, sub: [{ sub_indicator_id: ids.subAuto, month_bh: 10, actual_value: '50' }] });
        expect(r.status).toBe(400);
        // endpoint เดิม (หน้าต่างบันทึกผลงานย่อย) ก็ต้องปฏิเสธเช่นกัน
        const old = await as(saToken, request(app).post(api('/sub-results/upsert')))
            .send({ sub_indicator_id: ids.subAuto, year_bh: YEAR, hospcode: hospA, month_bh: 10, actual_value: '50' });
        expect(old.status).toBe(400);
    });

    test('✅ กิจกรรม → ข้อย่อย auto → หลัก (หารด้วยจำนวนข้อทั้งหมด, ยกยอด)', async () => {
        const r = await save(userToken, {
            hospcode: hospA,
            activity: [{ activity_id: ids.actNum, month_bh: 10, actual_value: '80' }, { activity_id: ids.actChk, month_bh: 10, actual_value: '1' }],
            sub: [{ sub_indicator_id: ids.subManual, month_bh: 10, actual_value: '60', target_value: '100' }],
        });
        expect(r.status).toBe(200);
        // ข้อ 1.1 = (80 + 100) / 2 = 90, ข้อ 1.2 = 60, ข้อ 1.3 = ไม่มีค่า → หลัก = (90 + 60 + 0) / 3 = 50
        let s = await summary(hospA);
        expect(Number(s.m10)).toBe(50);
        expect(s.sub_rollup_mode).toBe('auto');
        // พ.ย. บันทึกเฉพาะกิจกรรมแบบทำแล้ว = ยังไม่ทำ (0) → ข้อ 1.1 = (80 + 0) / 2 = 40 → หลัก = (40 + 60) / 3
        await save(userToken, { hospcode: hospA, activity: [{ activity_id: ids.actChk, month_bh: 11, actual_value: 0 }] });
        s = await summary(hospA);
        expect(Number(s.m11)).toBe(33.3333);
        expect(s.m12).toBeNull();
        const [[chk]] = await db.query('SELECT actual_value FROM kpi_activity_results WHERE activity_id = ? AND month_bh = 11', [ids.actChk]);
        expect(chk.actual_value).toBe('0');
    });

    test('✅ ข้อย่อย auto ที่ยังไม่มีกิจกรรม ใช้ค่าที่กรอกเอง', async () => {
        const r = await save(saToken, { hospcode: hospA, sub: [{ sub_indicator_id: ids.subAutoEmpty, month_bh: 10, actual_value: '30' }] });
        expect(r.status).toBe(200);
        expect(Number((await summary(hospA)).m10)).toBe(60); // (90 + 60 + 30) / 3
    });

    test('✅ คอลัมน์รายข้อของการส่งออกใช้ค่าที่มีผล (ข้อ auto = จากกิจกรรม, ข้อกรอกเอง = ข้อความเดิม)', async () => {
        const map = await loadSubExportMonthMap(db, indId, YEAR);
        expect(map.get(`${ids.subAuto}_${hospA}`).m10).toBe('90');
        expect(map.get(`${ids.subAuto}_${hospA}`).m11).toBe('40');
        expect(map.get(`${ids.subManual}_${hospA}`).m10).toBe('60');
    });

    test('✅ ตัวชี้วัดหลักแบบกรอกเอง: summary แจ้ง sub_rollup_mode = manual', async () => {
        await save(saToken, { hospcode: hospA, sub: [{ sub_indicator_id: ids.sub2, month_bh: 10, actual_value: '70' }] });
        expect((await summary(hospA, ind2Id)).sub_rollup_mode).toBe('manual');
    });

    test('✅ GET /hierarchy-results คืนโครงสร้าง + ค่ารายเดือน', async () => {
        const r = await as(userToken, request(app).get(api(`/hierarchy-results?indicator_id=${indId}&year_bh=${YEAR}&hospcode=${hospA}`)));
        expect(r.status).toBe(200);
        expect(r.body.data.subs.map(x => x.id)).toEqual([ids.subAuto, ids.subManual, ids.subAutoEmpty]);
        const chk = r.body.data.activities.find(a => a.id === ids.actChk);
        expect(chk.months).toEqual({ 10: '1', 11: '0' });
    });
});

describe('สิทธิ์และการล็อค', () => {
    test('❌ user ของหน่วยบริการอื่นบันทึก/ดูหน่วยบริการนี้ไม่ได้', async () => {
        const r = await save(otherToken, { hospcode: hospA, activity: [{ activity_id: ids.actNum, month_bh: 12, actual_value: '1' }] });
        expect(r.status).toBe(403);
        const g = await as(otherToken, request(app).get(api(`/hierarchy-results?indicator_id=${indId}&year_bh=${YEAR}&hospcode=${hospA}`)));
        expect(g.status).toBe(403);
    });

    test('✅ อนุมัติ → ล็อคถึงกิจกรรม, user แก้ไม่ได้ / ปลดล็อค → แก้ได้อีก', async () => {
        const [[sa]] = await db.query("SELECT id FROM users WHERE username = 'test_hier_sa'");
        await db.query("INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, user_id, status) VALUES (?,?,?,?,?,?,?,'Pending')",
            [indId, YEAR, hospA, 10, '100', '50', sa.id]);
        let r = await as(saToken, request(app).post(api('/approve-kpi'))).send({ indicator_id: indId, year_bh: YEAR, hospcode: hospA });
        expect(r.status).toBe(200);
        const [[lk]] = await db.query('SELECT MIN(is_locked) AS l FROM kpi_activity_results WHERE activity_id IN (?) AND hospcode = ?', [[ids.actNum, ids.actChk], hospA]);
        expect(Number(lk.l)).toBe(1);
        r = await save(userToken, { hospcode: hospA, activity: [{ activity_id: ids.actNum, month_bh: 12, actual_value: '1' }] });
        expect(r.status).toBe(403);

        r = await as(saToken, request(app).post(api('/unlock-kpi'))).send({ indicator_id: indId, year_bh: YEAR, hospcode: hospA });
        expect(r.status).toBe(200);
        const [[ul]] = await db.query('SELECT MAX(is_locked) AS l FROM kpi_activity_results WHERE activity_id IN (?) AND hospcode = ?', [[ids.actNum, ids.actChk], hospA]);
        expect(Number(ul.l)).toBe(0);
        r = await save(userToken, { hospcode: hospA, activity: [{ activity_id: ids.actNum, month_bh: 12, actual_value: '85' }] });
        expect(r.status).toBe(200);
    });

    test('❌ ลบตัวชี้วัดที่มีผลงานกิจกรรมไม่ได้', async () => {
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
        await db.query('DELETE FROM kpi_sub_results WHERE sub_indicator_id IN (?)', [[ids.subManual, ids.subAutoEmpty]]);
        const r = await as(saToken, request(app).delete(api(`/indicators/${indId}`)));
        expect(r.status).toBe(400);
    });
});
