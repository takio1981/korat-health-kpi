/**
 * Integration tests: GET /kpi-template — ตัวกรองหน้าต่าง "เพิ่มตัวชี้วัดให้หน่วยบริการ" (11 พ.ย. 2569) — database ทดสอบ
 *   - คืนประเภทตัวชี้วัด (r9/moph/ssj/rmw/other) + is_active
 *   - ?include_inactive=1 คืนตัวชี้วัดที่ปิดใช้งานด้วย เฉพาะ role ที่เข้าหน้าจัดการตัวชี้วัดได้ (ผู้ใช้ทั่วไป = เปิดใช้งานเท่านั้น)
 *   - ไม่ส่งพารามิเตอร์ (kpi-setup) = เปิดใช้งานเท่านั้นเหมือนเดิม
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken, userToken, deptId, onId, offId;
const api = (p) => '/khupskpi/api' + p;
const get = (token, qs = '') => request(app).get(api('/kpi-template' + qs)).set('Authorization', `Bearer ${token}`);
const ids = (res) => res.body.data.map(r => Number(r.indicator_id));

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE ?', ['test_tplf_%']);
    const [[d]] = await db.query('SELECT id FROM departments WHERE is_active = 1 ORDER BY id LIMIT 1');
    const [[h]] = await db.query("SELECT hoscode FROM chospital WHERE hostype = '07' ORDER BY hoscode LIMIT 1");
    deptId = d.id;
    const ins = async (name, active) => (await db.query(
        `INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, evaluation_mode, r9, moph, ssj, rmw, other)
         VALUES (?, ?, ?, 'all_required', 1, 0, 1, 0, 0)`, [name, deptId, active]))[0].insertId;
    onId = await ins('test_tplf_on', 1);
    offId = await ins('test_tplf_off', 0);
    const sa = await ensureTestUser(db, { username: 'test_tplf_sa', role: 'super_admin', session_id: 'sess-tplf-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-tplf-sa' });
    const u = await ensureTestUser(db, { username: 'test_tplf_user', role: 'user_hos', dept_id: deptId, hospcode: h.hoscode, session_id: 'sess-tplf-u' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: h.hoscode, sessionId: 'sess-tplf-u' });
});

afterAll(async () => {
    await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [[onId, offId].filter(Boolean)]);
    await cleanupTestUsers(db);
});

test('คืนประเภทตัวชี้วัดและสถานะ — ค่าตั้งต้นเฉพาะที่เปิดใช้งาน', async () => {
    const r = await get(saToken);
    expect(r.status).toBe(200);
    expect(ids(r)).toContain(onId);
    expect(ids(r)).not.toContain(offId);
    const row = r.body.data.find(x => Number(x.indicator_id) === onId);
    expect(row).toMatchObject({ r9: 1, moph: 0, ssj: 1, rmw: 0, other: 0, is_active: 1 });
});

test('include_inactive=1: ผู้ดูแลที่เข้าหน้าจัดการตัวชี้วัดได้เห็นตัวที่ปิด / ผู้ใช้ทั่วไปไม่เห็น', async () => {
    const sa = await get(saToken, '?include_inactive=1');
    expect(ids(sa)).toEqual(expect.arrayContaining([onId, offId]));
    expect(sa.body.data.find(x => Number(x.indicator_id) === offId).is_active).toBe(0);
    const u = await get(userToken, '?include_inactive=1');
    expect(u.status).toBe(200);
    expect(ids(u)).toContain(onId);
    expect(ids(u)).not.toContain(offId);
});
