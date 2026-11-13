/**
 * หน้าบันทึกผลงาน — ค้นหาด้วยคำค้นโดยไม่ต้องเลือกตัวกรอง (GET /kpi-results?q= — 13 พ.ย. 2569)
 *   - คำค้นจำกัดเพิ่มจากขอบเขตสิทธิ์ของ role เสมอ (ไม่ขยายสิทธิ์) | ค้นชื่อตัวชี้วัด / ชื่อหน่วยบริการ / รหัสหน่วยบริการ
 *   - ทุกคำ (เว้นวรรค) ต้องพบ | สั้นกว่า 2 ตัวอักษร = ไม่ใช้ | % _ ในคำค้นไม่ทำงานเป็นอักขระพิเศษ
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2997';
let app, db, saToken, hosToken, ids = [], hA, hB;
const api = (p) => '/khupskpi/api' + p;
const get = (q, t = saToken) => request(app).get(api(`/kpi-results?year=${YEAR}&q=${encodeURIComponent(q)}`)).set('Authorization', `Bearer ${t}`);
const names = (res) => [...new Set(res.body.data.map(r => r.kpi_indicators_name))].sort();

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\_srch\_%'");
    const [hs] = await db.query('SELECT hoscode, hosname FROM chospital ORDER BY hoscode LIMIT 2');
    [hA, hB] = hs;
    const sa = await ensureTestUser(db, { username: 'test_srch_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    const u = await ensureTestUser(db, { username: 'test_srch_hos', role: 'admin_hos', hospcode: hA.hoscode });
    hosToken = makeToken({ userId: u.id, username: u.username, role: 'admin_hos', deptId: null, hospcode: hA.hoscode });
    for (const [name, tp] of [['test_srch วัณโรคปอด', 'test_srch_tb'], ['test_srch เบาหวาน', 'test_srch_dm']]) {
        const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active) VALUES (?, ?, 1)', [name, tp]);
        ids.push(r.insertId);
        for (const h of [hA, hB]) {
            await db.query('INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, user_id, status) VALUES (?,?,?,10,?,?,?,?)',
                [r.insertId, YEAR, h.hoscode, '80', '50', sa.id, 'Pending']);
        }
    }
}, 60000);
afterAll(async () => {
    await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [ids]);
    await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [ids]);
    await cleanupTestUsers(db);
});

test('ค้นชื่อตัวชี้วัด (ทุกคำต้องพบ) — super_admin ไม่เลือกตัวกรองก็ได้ผลเฉพาะที่ตรง', async () => {
    const r = await get('test_srch วัณโรค');
    expect(r.status).toBe(200);
    expect(names(r)).toEqual(['test_srch วัณโรคปอด']);
    expect(new Set(r.body.data.map(x => x.hospcode))).toEqual(new Set([hA.hoscode, hB.hoscode]));
    expect(names(await get('test_srch'))).toEqual(['test_srch เบาหวาน', 'test_srch วัณโรคปอด'].sort());
    expect((await get('test_srch ไม่มีคำนี้')).body.data.length).toBe(0);
});

test('ค้นด้วยรหัสหน่วยบริการ', async () => {
    const r = await get(`test_srch ${hB.hoscode}`);
    expect(new Set(r.body.data.map(x => x.hospcode))).toEqual(new Set([hB.hoscode]));
});

test('คำค้นไม่ขยายสิทธิ์: admin_hos ค้นรหัสหน่วยบริการอื่น = ไม่พบ, ค้นชื่อตัวชี้วัด = เฉพาะหน่วยบริการตัวเอง', async () => {
    expect((await get(`test_srch ${hB.hoscode}`, hosToken)).body.data.length).toBe(0);
    const r = await get('test_srch เบาหวาน', hosToken);
    expect(r.body.data.map(x => x.hospcode)).toEqual([hA.hoscode]);
});

test('% และ _ ในคำค้นไม่เป็นอักขระพิเศษ', async () => {
    expect((await get('test%srch')).body.data.length).toBe(0);
});
