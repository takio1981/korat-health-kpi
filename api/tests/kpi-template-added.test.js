/**
 * Integration tests: GET /kpi-template/added — หน่วยบริการที่เพิ่มตัวชี้วัดแล้วในปีงบ (15 พ.ย. 2569) — database ทดสอบ
 *   ใช้ในหน้าต่าง "เพิ่มตัวชี้วัดให้หน่วยบริการ": ป้าย "เพิ่มแล้ว N แห่ง" + ป้ายสรุป "มีอยู่แล้ว"
 *   - คืน { [indicator_id]: hospcode[] } ไม่ซ้ำ เฉพาะปีงบที่ขอ
 *   - ขอบเขต: super_admin ทุกแห่ง / admin_cup อำเภอตัวเอง / user_hos หน่วยบริการตัวเอง / admin_ssj เฉพาะตัวชี้วัดหน่วยงานตัวเอง
 *   - ไม่ส่ง/ส่งปีงบผิดรูปแบบ = 400
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, indId, deptId, otherDeptId, h1, h2, h3, tokens = {};
const api = (p) => '/khupskpi/api' + p;
const get = (token, qs) => request(app).get(api('/kpi-template/added' + qs)).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE ?', ['test_tpla_%']);
    const [depts] = await db.query('SELECT id FROM departments WHERE is_active = 1 ORDER BY id LIMIT 2');
    deptId = depts[0].id;
    otherDeptId = depts[1].id;
    // อำเภอที่มีหน่วยบริการอย่างน้อย 2 แห่ง + หน่วยบริการอำเภออื่น 1 แห่ง
    const [[d]] = await db.query('SELECT distid FROM chospital WHERE distid IS NOT NULL GROUP BY distid HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, distid LIMIT 1');
    const [inDist] = await db.query('SELECT hoscode FROM chospital WHERE distid = ? ORDER BY hoscode LIMIT 2', [d.distid]);
    const [[other]] = await db.query('SELECT hoscode FROM chospital WHERE distid <> ? ORDER BY hoscode LIMIT 1', [d.distid]);
    [h1, h2, h3] = [inDist[0].hoscode, inDist[1].hoscode, other.hoscode];
    indId = (await db.query(`INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, evaluation_mode) VALUES ('test_tpla_ind', ?, 1, 'all_required')`, [deptId]))[0].insertId;

    const mk = async (key, role, extra) => {
        const u = await ensureTestUser(db, { username: 'test_tpla_' + key, role, session_id: 'sess-tpla-' + key, ...extra });
        tokens[key] = makeToken({ userId: u.id, username: u.username, role, deptId: extra.dept_id ?? null, hospcode: extra.hospcode ?? null, sessionId: 'sess-tpla-' + key });
        return u;
    };
    const sa = await mk('sa', 'super_admin', {});
    await mk('cup', 'admin_cup', { dept_id: deptId, hospcode: h1 });
    await mk('hos', 'user_hos', { dept_id: deptId, hospcode: h2 });
    await mk('ssj', 'admin_ssj', { dept_id: deptId });
    await mk('ssj2', 'admin_ssj', { dept_id: otherDeptId });
    // ผลงานปีงบ 2570: h1 2 เดือน (นับครั้งเดียว), h2, h3 — ปีงบ 2569: h1 (ไม่นับเมื่อขอ 2570)
    const ins = (hc, year, month) => db.query(
        "INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, status, user_id) VALUES (?,?,?,?, '80', 'Pending', ?)",
        [indId, year, hc, month, sa.id]);
    await ins(h1, '2570', 10); await ins(h1, '2570', 11); await ins(h2, '2570', 10); await ins(h3, '2570', 10); await ins(h3, '2569', 10);
});

afterAll(async () => {
    if (indId) {
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
    }
    await cleanupTestUsers(db);
});

const hcsOf = (res) => (res.body.data[indId] || []).slice().sort();

test('super_admin: ทุกหน่วยบริการที่มีแถวผลงานในปีงบที่ขอ (ไม่ซ้ำ)', async () => {
    const r = await get(tokens.sa, '?year_bh=2570');
    expect(r.status).toBe(200);
    expect(hcsOf(r)).toEqual([h1, h2, h3].sort());
    const r69 = await get(tokens.sa, '?year_bh=2569');
    expect(hcsOf(r69)).toEqual([h3]);
});

test('ขอบเขต: admin_cup = อำเภอตัวเอง / user_hos = หน่วยบริการตัวเอง', async () => {
    expect(hcsOf(await get(tokens.cup, '?year_bh=2570'))).toEqual([h1, h2].sort());
    expect(hcsOf(await get(tokens.hos, '?year_bh=2570'))).toEqual([h2]);
});

test('admin_ssj: เฉพาะตัวชี้วัดของหน่วยงานตัวเอง', async () => {
    expect(hcsOf(await get(tokens.ssj, '?year_bh=2570'))).toEqual([h1, h2, h3].sort());
    const other = await get(tokens.ssj2, '?year_bh=2570');
    expect(other.status).toBe(200);
    expect(other.body.data[indId]).toBeUndefined();
});

test('ไม่ระบุปีงบ / รูปแบบผิด = 400 | ไม่มี token = 401', async () => {
    expect((await get(tokens.sa, '')).status).toBe(400);
    expect((await get(tokens.sa, '?year_bh=25x0')).status).toBe(400);
    expect((await request(app).get(api('/kpi-template/added?year_bh=2570'))).status).toBe(401);
});
