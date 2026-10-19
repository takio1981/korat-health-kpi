/**
 * Integration tests (database ทดสอบ) — เพิ่มตัวชี้วัดให้หน่วยบริการแบบหาปลายทางอัตโนมัติจากประเภทหน่วยบริการ (19 ต.ค. 2569)
 *   - /kpi-template: เฉพาะตัวชี้วัดที่เปิดใช้งาน และไม่อยู่ใต้หมวดหมู่หลัก/หน่วยงานที่ปิด + คืน hostype_setting (types | all | unset)
 *   - /update-kpi mode setup_insert_new:
 *       ตัวชี้วัดที่ยังไม่ได้ตั้งประเภทหน่วยบริการ → ไม่เพิ่ม (skipped_unset)
 *       หลายหน่วยบริการในคำขอเดียว (แถวมี hospcode) → เพิ่มครบทุกคู่ 12 เดือน
 *       admin_cup ส่งหน่วยบริการอำเภออื่น → 403 (เดิม: เพิ่มได้)
 *       คู่ที่มีอยู่แล้วและถูกล็อค → ข้าม ไม่ทำให้ทั้งคำขอล้ม (เดิม: error ทั้งคำขอ)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2504';
let app, db, saToken, cupToken, saId, deptId, mainOff;
let hA1, hA2, hB1, typeA;   // hA1/hA2 = อำเภอเดียวกัน, hB1 = อีกอำเภอ
const ind = {};
const created = [];
const api = (p) => '/khupskpi/api' + p;
const as = (token, r) => r.set('Authorization', `Bearer ${token}`);
const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
const countPair = async (id, hc) => (await db.query('SELECT COUNT(*) AS n FROM kpi_results WHERE indicator_id = ? AND hospcode = ? AND year_bh = ?', [id, hc, YEAR]))[0][0].n;

async function addIndicator(name, extra = {}) {
    const cols = { kpi_indicators_name: name, dept_id: deptId, is_active: 1, ...extra };
    const keys = Object.keys(cols);
    const [r] = await db.query(`INSERT INTO kpi_indicators (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => cols[k]));
    created.push(r.insertId);
    return r.insertId;
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_autot\\_%'");
    await db.query("DELETE FROM kpi_main_indicators WHERE main_indicator_name LIKE 'test\\_autot\\_%'");

    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    deptId = d.id;
    // อำเภอที่มีหน่วยบริการประเภทเดียวกัน ≥ 2 แห่ง + หน่วยบริการประเภทเดียวกันในอำเภออื่น
    const [[g]] = await db.query(`SELECT hostype, distid FROM chospital WHERE hostype <> '' AND distid <> ''
        GROUP BY hostype, distid HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC LIMIT 1`);
    typeA = String(g.hostype);
    const [same] = await db.query('SELECT hoscode FROM chospital WHERE hostype = ? AND distid = ? ORDER BY hoscode LIMIT 2', [typeA, g.distid]);
    [hA1, hA2] = same.map(r => r.hoscode);
    const [[other]] = await db.query('SELECT hoscode FROM chospital WHERE hostype = ? AND distid <> ? ORDER BY hoscode LIMIT 1', [typeA, g.distid]);
    hB1 = other.hoscode;

    const sa = await ensureTestUser(db, { username: 'test_autot_sa', role: 'super_admin', session_id: 'sess-autot-sa' });
    saId = sa.id;
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-autot-sa' });
    const cup = await ensureTestUser(db, { username: 'test_autot_cup', role: 'admin_cup', dept_id: deptId, hospcode: hA1, session_id: 'sess-autot-cup' });
    cupToken = makeToken({ userId: cup.id, username: cup.username, role: 'admin_cup', deptId, hospcode: hA1, sessionId: 'sess-autot-cup' });

    const [m] = await db.query("INSERT INTO kpi_main_indicators (main_indicator_name, is_active) VALUES ('test_autot_main_off', 0)");
    mainOff = m.insertId;
    ind.types = await addIndicator('test_autot_types', { evaluation_mode: 'any_one', required_off_types: JSON.stringify([typeA]) });
    ind.all = await addIndicator('test_autot_all', { evaluation_mode: 'all_required', required_off_types: null });
    ind.unset = await addIndicator('test_autot_unset', { evaluation_mode: null, required_off_types: null });
    ind.underOff = await addIndicator('test_autot_under_off', { evaluation_mode: 'all_required', main_indicator_id: mainOff });
    ind.inactive = await addIndicator('test_autot_inactive', { evaluation_mode: 'all_required', is_active: 0 });
});

afterAll(async () => {
    const [rows] = await db.query("SELECT id FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_autot\\_%'");
    const ids = [...new Set([...created, ...rows.map(r => r.id)])];
    if (ids.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [ids]);
    }
    await db.query("DELETE FROM kpi_main_indicators WHERE main_indicator_name LIKE 'test\\_autot\\_%'");
    await cleanupTestUsers(db);
});

describe('GET /kpi-template — เฉพาะตัวชี้วัดที่เปิดใช้งาน + สถานะการตั้งประเภทหน่วยบริการ', () => {
    test('✅ ไม่คืนตัวที่ปิด และตัวที่อยู่ใต้หมวดหมู่หลักที่ปิด (เดิม: คืนตัวใต้หมวดหมู่ที่ปิด)', async () => {
        const res = await as(saToken, request(app).get(api('/kpi-template')));
        expect(res.status).toBe(200);
        const ids = res.body.data.map(r => Number(r.indicator_id));
        expect(ids).toContain(ind.types);
        expect(ids).not.toContain(ind.inactive);
        expect(ids).not.toContain(ind.underOff);
    });

    test('✅ แต่ละแถวมี hostype_setting', async () => {
        const res = await as(saToken, request(app).get(api('/kpi-template')));
        const by = Object.fromEntries(res.body.data.map(r => [Number(r.indicator_id), r.hostype_setting]));
        expect(by[ind.types]).toBe('types');
        expect(by[ind.all]).toBe('all');
        expect(by[ind.unset]).toBe('unset');
    });
});

describe('/update-kpi setup_insert_new — หลายหน่วยบริการ / ขอบเขต / ยังไม่ตั้งประเภท', () => {
    const row = (id, hc, extra = {}) => ({ indicator_id: id, year_bh: YEAR, hospcode: hc, target_value: '80', ...extra });

    test('✅ หลายหน่วยบริการในคำขอเดียว เพิ่มครบทุกคู่ 12 เดือน และข้ามตัวที่ยังไม่ตั้งประเภท', async () => {
        const updates = [hA1, hB1].flatMap(hc => [row(ind.types, hc, { oct: '5' }), row(ind.unset, hc)]);
        const res = await as(saToken, request(app).post(api('/update-kpi'))).send({ updates, mode: 'setup_insert_new' });
        expect(res.status).toBe(200);
        expect(res.body.inserted).toBe(2);
        expect(res.body.skipped_unset).toBe(2);
        expect(await countPair(ind.types, hA1)).toBe(12);
        expect(await countPair(ind.types, hB1)).toBe(12);
        expect(await countPair(ind.unset, hA1)).toBe(0);
        const [[oct]] = await db.query('SELECT actual_value, target_value FROM kpi_results WHERE indicator_id = ? AND hospcode = ? AND year_bh = ? AND month_bh = 10', [ind.types, hB1, YEAR]);
        expect(oct).toEqual({ actual_value: '5', target_value: '80' });
    });

    test('🛡️ admin_cup ส่งหน่วยบริการอำเภออื่น → 403 ไม่เพิ่มอะไรเลย (เดิม: เพิ่มได้)', async () => {
        const res = await as(cupToken, request(app).post(api('/update-kpi')))
            .send({ updates: [row(ind.all, hA2), row(ind.all, hB1)], mode: 'setup_insert_new' });
        expect(res.status).toBe(403);
        expect(await countPair(ind.all, hA2)).toBe(0);
        expect(await countPair(ind.all, hB1)).toBe(0);
    });

    test('✅ คู่ที่มีอยู่แล้วและถูกล็อค → ข้าม ส่วนคู่ใหม่ยังเพิ่มได้ (เดิม: error ทั้งคำขอ)', async () => {
        await db.query("INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked) VALUES (?, ?, 10, '1', '80', ?, 'Approved', ?, 1)",
            [ind.all, YEAR, saId, hA1]);
        const res = await as(cupToken, request(app).post(api('/update-kpi')))
            .send({ updates: [row(ind.all, hA1), row(ind.all, hA2)], mode: 'setup_insert_new' });
        expect(res.status).toBe(200);
        expect(res.body.inserted).toBe(1);
        expect(res.body.skipped).toBe(1);
        expect(await countPair(ind.all, hA2)).toBe(12);
        expect(await countPair(ind.all, hA1)).toBe(1);   // แถวเดิมไม่ถูกแตะ
    });

    test('✅ ค่ารายเดือนว่างบันทึกเป็นค่าว่างครบ 12 เดือน', async () => {
        const [rows] = await db.query('SELECT month_bh, actual_value FROM kpi_results WHERE indicator_id = ? AND hospcode = ? AND year_bh = ? ORDER BY month_bh', [ind.all, hA2, YEAR]);
        expect(rows.length).toBe(months.length);
        expect(rows.every(r => r.actual_value === '')).toBe(true);
    });
});
