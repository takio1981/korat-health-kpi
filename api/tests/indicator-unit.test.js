/**
 * หน่วยนับผลงานของตัวชี้วัด (kpi_indicators.unit — 13 พ.ย. 2569, ไม่บังคับ)
 *   - POST/PUT /indicators รับ unit (ตัดช่องว่างซ้ำ ≤ 50 ตัวอักษร, ว่าง = NULL) | PUT ไม่ส่ง = ไม่เปลี่ยน | GET /indicators คืน unit
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, token, id;
const api = (p) => '/khupskpi/api' + p;
const unitOf = async () => (await db.query('SELECT unit FROM kpi_indicators WHERE id = ?', [id]))[0][0].unit;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE table_process = 'test_unit_ind'");
    const sa = await ensureTestUser(db, { username: 'test_unit_sa', role: 'super_admin' });
    token = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
}, 60000);
afterAll(async () => {
    if (id) await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
    await cleanupTestUsers(db);
});

test('POST เก็บหน่วย (ตัดช่องว่างซ้ำ) → GET /indicators คืน unit', async () => {
    const res = await request(app).post(api('/indicators')).set('Authorization', `Bearer ${token}`)
        .send({ kpi_indicators_name: 'test_unit ตัวชี้วัด', table_process: 'test_unit_ind', is_active: 1, unit: '  อัตรา   ต่อแสนประชากร ' });
    expect(res.status).toBe(200);
    [[{ id }]] = await db.query("SELECT id FROM kpi_indicators WHERE table_process = 'test_unit_ind'");
    expect(await unitOf()).toBe('อัตรา ต่อแสนประชากร');
    const list = await request(app).get(api('/indicators')).set('Authorization', `Bearer ${token}`);
    expect(list.body.data.find(r => r.id === id).unit).toBe('อัตรา ต่อแสนประชากร');
});

test('PUT ไม่ส่ง unit = คงค่าเดิม | ส่งค่าใหม่ = เปลี่ยน | ว่าง = ไม่ระบุ (NULL) | ยาวเกิน = ตัดที่ 50', async () => {
    const put = (body) => request(app).put(api('/indicators/' + id)).set('Authorization', `Bearer ${token}`)
        .send({ kpi_indicators_name: 'test_unit ตัวชี้วัด', table_process: 'test_unit_ind', is_active: 1, ...body });
    expect((await put({})).status).toBe(200);
    expect(await unitOf()).toBe('อัตรา ต่อแสนประชากร');
    await put({ unit: 'ราย' });
    expect(await unitOf()).toBe('ราย');
    await put({ unit: '' });
    expect(await unitOf()).toBeNull();
    await put({ unit: 'ก'.repeat(80) });
    expect((await unitOf()).length).toBe(50);
});
