/**
 * Integration tests: ลบผู้ใช้ต้องไม่ทำให้ผลงานหาย (database ทดสอบ)
 * Regression (11 ต.ค. 2569): kpi_results.user_id → users เป็น ON DELETE CASCADE — ลบผู้ใช้ = ผลงานทุกแถวของผู้ใช้นั้นถูกลบตามแบบเงียบๆ
 *   (เหตุการณ์จริง: ผลงาน ~17,400 แถวหายจากการลบบัญชีที่รหัสตรงกับ user_id ของแถวผลงานเก่า)
 *   - FK ต้องเป็น RESTRICT (auto-migration)
 *   - DELETE /users/:id ปฏิเสธพร้อมเหตุผลเมื่อผู้ใช้มีผลงาน และผลงานยังอยู่ครบ
 *   - ผู้ใช้ที่ไม่มีผลงานยังลบได้ตามปกติ
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2506';
let app, db, saToken, indId, hosp, owner, plain;
const api = (p) => '/khupskpi/api' + p;
const asSa = (r) => r.set('Authorization', `Bearer ${saToken}`);
const countResults = async (userId) => (await db.query('SELECT COUNT(*) AS n FROM kpi_results WHERE user_id = ?', [userId]))[0][0].n;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    hosp = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_delguard_sa', role: 'super_admin', session_id: 'sess-dg-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-dg-sa' });
    owner = await ensureTestUser(db, { username: 'test_delguard_owner', role: 'user_hos', dept_id: d.id, hospcode: hosp });
    plain = await ensureTestUser(db, { username: 'test_delguard_plain', role: 'user_hos', dept_id: d.id, hospcode: hosp });
    const [i] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?,?,1)', ['test_delguard_ind', d.id]);
    indId = i.insertId;
    for (const m of [10, 11, 12]) {
        await db.query('INSERT INTO kpi_results (indicator_id, year_bh, month_bh, target_value, actual_value, user_id, status, hospcode, is_locked) VALUES (?,?,?,?,?,?,?,?,0)',
            [indId, YEAR, m, '80', String(70 + m), owner.id, 'Pending', hosp]);
    }
});

afterAll(async () => {
    if (indId) {
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
    }
    await cleanupTestUsers(db);
});

describe('ลบผู้ใช้ต้องไม่ทำให้ผลงานหาย', () => {
    test('✅ FK kpi_results.user_id → users ไม่ใช่ CASCADE แล้ว (auto-migration)', async () => {
        const [rows] = await db.query(
            `SELECT CONSTRAINT_NAME AS name, DELETE_RULE AS rule FROM information_schema.REFERENTIAL_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'kpi_results' AND REFERENCED_TABLE_NAME = 'users'`);
        expect(rows.length).toBe(1);
        expect(['RESTRICT', 'NO ACTION']).toContain(rows[0].rule);
    });

    test('🛡️ DELETE /users/:id ของผู้ใช้ที่มีผลงาน → ปฏิเสธพร้อมเหตุผล และผลงานยังอยู่ครบ', async () => {
        const res = await asSa(request(app).delete(api(`/users/${owner.id}`)));
        expect(res.status).toBe(400);                         // เดิม: 200 แล้วผลงาน 3 แถวหายตาม
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('USER_HAS_KPI_RESULTS');
        expect(res.body.kpi_results).toBe(3);
        expect(res.body.message).toContain('ปิดการใช้งาน');
        expect(await countResults(owner.id)).toBe(3);
        const [[u]] = await db.query('SELECT COUNT(*) AS n FROM users WHERE id = ?', [owner.id]);
        expect(u.n).toBe(1);
    });

    test('🛡️ ลบตรงที่ฐานข้อมูลก็ถูกปฏิเสธ (ไม่ลบผลงานตามแบบเงียบๆ)', async () => {
        await expect(db.query('DELETE FROM users WHERE id = ?', [owner.id])).rejects.toMatchObject({ code: 'ER_ROW_IS_REFERENCED_2' });
        expect(await countResults(owner.id)).toBe(3);
    });

    test('✅ ผู้ใช้ที่ไม่มีผลงานยังลบได้ตามปกติ', async () => {
        const res = await asSa(request(app).delete(api(`/users/${plain.id}`)));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const [[u]] = await db.query('SELECT COUNT(*) AS n FROM users WHERE id = ?', [plain.id]);
        expect(u.n).toBe(0);
    });

    test('✅ ลบผลงานออกก่อนแล้ว จึงลบผู้ใช้ได้', async () => {
        await db.query('DELETE FROM kpi_results WHERE user_id = ?', [owner.id]);
        const res = await asSa(request(app).delete(api(`/users/${owner.id}`)));
        expect(res.status).toBe(200);
    });
});
