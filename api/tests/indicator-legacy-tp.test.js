/**
 * แก้ไขตัวชี้วัดที่ table_process เดิมมีขีดกลาง (12 พ.ย. 2569 — 400 บน production PUT /indicators/206)
 *   - ส่ง table_process เดิมกลับมา (ไม่ได้เปลี่ยน) = บันทึกได้ | เปลี่ยนเป็นค่าที่ไม่ถูกรูปแบบ = 400 INVALID_TABLE_PROCESS
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, token, id;
const api = (p) => '/khupskpi/api' + p;
const put = (body) => request(app).put(api('/indicators/' + id)).set('Authorization', `Bearer ${token}`).send(body);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test-legacytp-%' OR table_process LIKE 'test\_legacytp\_%'");
    const sa = await ensureTestUser(db, { username: 'test_legacytp_sa', role: 'super_admin' });
    token = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    [{ insertId: id }] = await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active) VALUES ('test_legacytp ตัวชี้วัด', 'test-legacytp-2568-1901', 1)");
}, 60000);
afterAll(async () => {
    await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
    await cleanupTestUsers(db);
});

test('table_process เดิมมีขีดกลาง + ไม่ได้เปลี่ยน → บันทึกได้', async () => {
    const res = await put({ kpi_indicators_name: 'test_legacytp ตัวชี้วัด (แก้ไข)', table_process: 'test-legacytp-2568-1901', is_active: 1 });
    expect(res.status).toBe(200);
    const [[r]] = await db.query('SELECT kpi_indicators_name, table_process FROM kpi_indicators WHERE id = ?', [id]);
    expect(r).toEqual({ kpi_indicators_name: 'test_legacytp ตัวชี้วัด (แก้ไข)', table_process: 'test-legacytp-2568-1901' });
});

test('เปลี่ยน table_process เป็นค่าที่ไม่ถูกรูปแบบ → 400 และไม่เปลี่ยนค่า', async () => {
    const res = await put({ kpi_indicators_name: 'x', table_process: 'test-legacytp-new', is_active: 1 });
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_TABLE_PROCESS']);
    const [[r]] = await db.query('SELECT table_process FROM kpi_indicators WHERE id = ?', [id]);
    expect(r.table_process).toBe('test-legacytp-2568-1901');
});
