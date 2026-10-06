/**
 * Integration tests: Single Session บน endpoint บันทึกผลงาน
 *   Regression (6 ต.ค. 2569): /update-kpi เคย verify JWT เองอย่างเดียว ข้ามการตรวจ single session
 *   → ผู้ใช้ที่ session ถูกยกเลิกแล้ว (ถูกบังคับ logout / login ซ้อนจากเครื่องอื่น) ยังบันทึกผลงานได้
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db;
beforeAll(async () => {
    ({ app } = require('../server'));
    db = require('../db');
    await cleanupTestUsers(db);
});
afterAll(async () => { await cleanupTestUsers(db); });

describe('POST /khupskpi/api/update-kpi — single session', () => {
    test('❌ ไม่มี token → 401', async () => {
        const res = await request(app).post('/khupskpi/api/update-kpi').send({ updates: [] });
        expect(res.status).toBe(401);
    });

    test('✅ session ตรงกับในฐานข้อมูล → ผ่านการยืนยันตัวตน (ได้ 400 "ไม่มีข้อมูล" เพราะส่ง updates ว่าง)', async () => {
        const u = await ensureTestUser(db, { username: 'test_sess_ok', role: 'user_hos', session_id: 'sess-current' });
        const token = makeToken({ userId: u.id, username: u.username, role: 'user_hos', hospcode: '11000', sessionId: 'sess-current' });
        const res = await request(app)
            .post('/khupskpi/api/update-kpi')
            .set('Authorization', `Bearer ${token}`)
            .send({ updates: [] });
        expect(res.status).toBe(400);
        expect(res.body.message).toBe('ไม่มีข้อมูล');
    });

    // บันทึกจริงลง database ทดสอบ — ยืนยันว่าเส้นทางบันทึกผลงานยังทำงานครบหลังเพิ่ม authenticateToken
    // และค่า "รอดำเนินการ" (ข้อความ) บันทึกลง actual_value ได้ (ฟีเจอร์ 5 ต.ค. 2569)
    test('✅ บันทึกผลงานรายเดือน (รวมค่า "รอดำเนินการ") ลง kpi_results ได้', async () => {
        const [[ind]] = await db.query('SELECT id, dept_id FROM kpi_indicators WHERE is_active = 1 AND dept_id IS NOT NULL LIMIT 1');
        const [[hos]] = await db.query('SELECT hoscode FROM chospital LIMIT 1');
        const u = await ensureTestUser(db, { username: 'test_sess_save', role: 'user_hos', dept_id: ind.dept_id, hospcode: hos.hoscode, session_id: 'sess-save' });
        const token = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId: ind.dept_id, hospcode: hos.hoscode, sessionId: 'sess-save' });
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [ind.id, '2569', hos.hoscode]);

        const res = await request(app)
            .post('/khupskpi/api/update-kpi')
            .set('Authorization', `Bearer ${token}`)
            .send({ updates: [{ indicator_id: ind.id, year_bh: '2569', hospcode: hos.hoscode, target_value: '80', oct: 'รอดำเนินการ', nov: '42' }] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const [rows] = await db.query(
            'SELECT month_bh, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh IN (?) ORDER BY month_bh',
            [ind.id, '2569', hos.hoscode, ['10', '11']]
        );
        const byMonth = Object.fromEntries(rows.map(r => [String(Number(r.month_bh)), r.actual_value]));
        expect(byMonth['10']).toBe('รอดำเนินการ');
        expect(byMonth['11']).toBe('42');
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [ind.id, '2569', hos.hoscode]);
    });

    test('❌ session ถูกแทนที่แล้ว (login จากเครื่องอื่น/ถูกบังคับ logout) → 401 SESSION_INVALIDATED', async () => {
        const u = await ensureTestUser(db, { username: 'test_sess_old', role: 'user_hos', session_id: 'sess-new-device' });
        const oldToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', hospcode: '11000', sessionId: 'sess-old-device' });
        const res = await request(app)
            .post('/khupskpi/api/update-kpi')
            .set('Authorization', `Bearer ${oldToken}`)
            .send({ updates: [{ indicator_id: 1, year_bh: '2569', month_bh: 10, actual_value: '1' }] });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('SESSION_INVALIDATED');
    });
});
