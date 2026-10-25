/**
 * อนุมัติ/ส่งคืน/อุทธรณ์: ขอบเขตหน่วยงานของ admin_ssj + ตรวจข้อมูลที่ส่งมา (พบจากการทดสอบทั้งระบบ 25 ต.ค. 2569)
 * - admin_ssj (เห็นเฉพาะหน่วยงานตัวเอง) อนุมัติ/ส่งคืน/รับอุทธรณ์ตัวชี้วัดของหน่วยงานอื่นผ่าน API ได้ (หน้าจอกรองให้เท่านั้น)
 * - ข้อมูลไม่ครบ → 500 "Column 'indicator_id' cannot be null" (appeal-approve, target-edit-request) / ไม่มีเหตุผลส่งคืน → 500
 * - แก้ตารางเวลาสำรองข้อมูลที่ไม่มีอยู่/ข้อมูลไม่ครบ → 500 "Unknown column 'NaN'"
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => `/khupskpi/api${p}`;
const YEAR = '2570';
let app, db, deptA, deptB, hos, indA, indB, T = {};

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_apscope\\_');
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_apscope\\_%'");
    const [ds] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
    deptA = ds[0].id; deptB = ds[1].id;
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    hos = h.hoscode;
    const mkInd = async (name, dept) => (await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?,?,1)', [name, dept]))[0].insertId;
    indA = await mkInd('test_apscope_a', deptA);
    indB = await mkInd('test_apscope_b', deptB);
    const owner = await ensureTestUser(db, { username: 'test_apscope_owner', role: 'user_hos', dept_id: deptA, hospcode: hos });
    for (const ind of [indA, indB]) {
        await db.query(`INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked)
                        VALUES (?,?,10,'90','80',?,'Pending',?,0)`, [ind, YEAR, owner.id, hos]);
    }
    const ssj = await ensureTestUser(db, { username: 'test_apscope_ssj', role: 'admin_ssj', dept_id: deptA, hospcode: hos, session_id: 's-apscope-ssj' });
    const sa = await ensureTestUser(db, { username: 'test_apscope_sa', role: 'super_admin', session_id: 's-apscope-sa' });
    T.ssj = makeToken({ userId: ssj.id, username: ssj.username, role: 'admin_ssj', deptId: deptA, hospcode: hos, sessionId: 's-apscope-ssj' });
    T.sa = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-apscope-sa' });
}, 60000);

afterAll(async () => {
    for (const ind of [indA, indB].filter(Boolean)) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM notifications WHERE indicator_id = ?', [ind]).catch(() => {});
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [ind]);
    }
    await cleanupTestUsers(db, 'test\\_apscope\\_');
});

const status = async (ind) => (await db.query('SELECT status, is_locked FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [ind, YEAR, hos]))[0][0];
const post = (t, p, body) => request(app).post(api(p)).set('Authorization', `Bearer ${t}`).send(body);

describe('ขอบเขตหน่วยงานของ admin_ssj', () => {
    test('🛡️ อนุมัติตัวชี้วัดของหน่วยงานอื่น → 403 ไม่เปลี่ยนสถานะ (เดิม: อนุมัติ+ล็อค)', async () => {
        const r = await post(T.ssj, '/approve-kpi', [{ indicator_id: indB, year_bh: YEAR, hospcode: hos }]);
        expect(r.status).toBe(403);
        expect((await status(indB)).status).toBe('Pending');
    });

    test('✅ อนุมัติตัวชี้วัดของหน่วยงานตัวเองได้', async () => {
        const r = await post(T.ssj, '/approve-kpi', [{ indicator_id: indA, year_bh: YEAR, hospcode: hos }]);
        expect(r.status).toBe(200);
        expect((await status(indA)).status).toBe('Approved');
        await db.query("UPDATE kpi_results SET status='Pending', is_locked=0 WHERE indicator_id = ?", [indA]);
    });

    test('🛡️ ส่งคืนแก้ไข / รับอุทธรณ์ / ปฏิเสธอุทธรณ์ ของหน่วยงานอื่น → 403', async () => {
        expect((await post(T.ssj, '/reject-kpi', [{ indicator_id: indB, year_bh: YEAR, hospcode: hos, comment: 'ทดสอบ' }])).status).toBe(403);
        expect((await post(T.ssj, '/appeal-approve', { indicator_id: indB, year_bh: YEAR, hospcode: hos, comment: 'ทดสอบ' })).status).toBe(403);
        expect((await post(T.ssj, '/appeal-reject', { indicator_id: indB, year_bh: YEAR, hospcode: hos, comment: 'ทดสอบ' })).status).toBe(403);
        expect((await status(indB)).status).toBe('Pending');
    });

    test('✅ super_admin อนุมัติได้ทุกหน่วยงาน', async () => {
        expect((await post(T.sa, '/approve-kpi', [{ indicator_id: indB, year_bh: YEAR, hospcode: hos }])).status).toBe(200);
        await db.query("UPDATE kpi_results SET status='Pending', is_locked=0 WHERE indicator_id = ?", [indB]);
    });
});

describe('ข้อมูลไม่ครบ → 400 (เดิม 500)', () => {
    test('🛡️ appeal-approve / appeal-reject / target-edit-request ไม่มีตัวชี้วัด', async () => {
        expect((await post(T.sa, '/appeal-approve', {})).status).toBe(400);
        expect((await post(T.sa, '/appeal-reject', { comment: 'x' })).status).toBe(400);
        expect((await post(T.sa, '/target-edit-request', {})).status).toBe(400);
    });

    test('🛡️ reject-kpi ไม่มีเหตุผล → 400', async () => {
        expect((await post(T.sa, '/reject-kpi', [{ indicator_id: indA, year_bh: YEAR, hospcode: hos }])).status).toBe(400);
    });

    test('🛡️ แก้ตารางเวลาสำรองข้อมูล: ไม่มีอยู่ → 404, ข้อมูลไม่ครบ → 400', async () => {
        const put = (id, body) => request(app).put(api(`/backup/schedules/${id}`)).set('Authorization', `Bearer ${T.sa}`).send(body);
        const full = { name: 'x', connection_id: 1, days_of_week: '1', time_of_day: '02:00' };
        expect((await put(999999999, full)).status).toBe(404);
        expect((await put(999999999, {})).status).toBe(400);
    });
});
