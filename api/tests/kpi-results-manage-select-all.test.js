/**
 * จัดการข้อมูลผลงานตัวชี้วัด — "เลือกทั้งหมดที่ค้นหาได้ทุกหน้า" (12 พ.ย. 2569)
 *   - GET /kpi-results/manage/ids คืนรหัสทุกแถวที่ตรงเงื่อนไขเดียวกับตาราง (ทุกหน้า) | ไม่มีเงื่อนไข = 400 | super_admin เท่านั้น
 *   - POST /kpi-results/manage/bulk-delete รับครั้งละไม่เกิน 2000 รายการ (หน้าจอส่งเป็นชุด)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2998';   // ปีงบที่ไม่มีข้อมูลจริง — แยกข้อมูลของชุดทดสอบนี้
let app, db, saToken, adminToken, indId, hospcode;
const api = (p) => '/khupskpi/api' + p;
const get = (p, t = saToken) => request(app).get(api(p)).set('Authorization', `Bearer ${t}`);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE table_process = 'test_krmsel_ind'");
    const sa = await ensureTestUser(db, { username: 'test_krmsel_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    const ad = await ensureTestUser(db, { username: 'test_krmsel_ssj', role: 'admin_ssj', dept_id: 1 });
    adminToken = makeToken({ userId: ad.id, username: ad.username, role: 'admin_ssj', deptId: 1, hospcode: null });
    [{ insertId: indId }] = await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active) VALUES ('test_krmsel ตัวชี้วัด', 'test_krmsel_ind', 1)");
    [[{ hoscode: hospcode }]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    for (const m of [10, 11, 12, 1, 2]) {
        await db.query('INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, user_id, status) VALUES (?,?,?,?,?,?,?,?)',
            [indId, YEAR, hospcode, m, '80', String(m), sa.id, 'Pending']);
    }
}, 60000);
afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [indId]).catch(() => {});
    await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
    await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
    await cleanupTestUsers(db);
});

test('ids = ทุกแถวที่ตรงเงื่อนไข (ทุกหน้า) ชุดเดียวกับตาราง + กรองช่วงเดือนแบบเดียวกัน', async () => {
    const p1 = await get(`/kpi-results/manage?year_bh=${YEAR}&page=1&limit=2`);
    expect([p1.status, p1.body.total, p1.body.data.length]).toEqual([200, 5, 2]);
    const all = await get(`/kpi-results/manage/ids?year_bh=${YEAR}`);
    expect(all.status).toBe(200);
    expect(all.body.truncated).toBe(false);
    expect(all.body.ids.length).toBe(5);
    const [rows] = await db.query('SELECT id FROM kpi_results WHERE indicator_id = ?', [indId]);
    expect([...all.body.ids].sort((a, b) => a - b)).toEqual(rows.map(r => r.id).sort((a, b) => a - b));
    for (const r of p1.body.data) expect(all.body.ids).toContain(r.id);
    const q = await get(`/kpi-results/manage/ids?year_bh=${YEAR}&month_from=11&month_to=1`);   // พ.ย.–ม.ค. (ข้ามปีปฏิทิน)
    expect(q.body.ids.length).toBe(3);
});

test('ไม่มีเงื่อนไข = 400 | ไม่ใช่ super_admin = 403', async () => {
    expect((await get('/kpi-results/manage/ids')).status).toBe(400);
    expect((await get(`/kpi-results/manage/ids?year_bh=${YEAR}`, adminToken)).status).toBe(403);
});

test('bulk-delete เกิน 2000 รายการต่อคำขอ = 400 (ไม่ลบอะไร) | ลบตามรหัสที่เลือกทั้งหมดได้', async () => {
    const big = Array.from({ length: 2001 }, (_, i) => i + 1);
    const r = await request(app).post(api('/kpi-results/manage/bulk-delete')).set('Authorization', `Bearer ${saToken}`).send({ ids: big });
    expect(r.status).toBe(400);
    const { body } = await get(`/kpi-results/manage/ids?year_bh=${YEAR}`);
    const del = await request(app).post(api('/kpi-results/manage/bulk-delete')).set('Authorization', `Bearer ${saToken}`).send({ ids: body.ids });
    expect([del.status, del.body.deletedKpi]).toEqual([200, 5]);
    const [[c]] = await db.query('SELECT COUNT(*) AS n FROM kpi_results WHERE indicator_id = ?', [indId]);
    expect(c.n).toBe(0);
});
