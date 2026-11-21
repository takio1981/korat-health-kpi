/**
 * กติกาการส่ง KHD (ระยะ 3 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569): ค่าตั้งต้น "ส่งเฉพาะที่อนุมัติ"
 * เดิม: export/sync ไม่ดูสถานะเลย — ผลงานที่ยังไม่ผ่านการตรวจถูกส่งเข้า KHD
 * ตรวจ: ตารางส่งออกเก็บเฉพาะเดือนที่อนุมัติ, checkKpiChanges ตรงกับ performKpiExport, ตั้งค่าเป็น all = ส่งทุกค่า, สิทธิ์ตั้งค่า = super_admin แบบเข้ม
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => `/khupskpi/api${p}`;
const YEAR = '2570';
let app, db, ind, hos, tp, T = {}, prevPolicy, exportSvc, policySvc;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    exportSvc = require('../services/export');
    policySvc = require('../services/khd-policy');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_khdpol\\_');
    const [[h]] = await db.query("SELECT hoscode, hostype FROM chospital WHERE hostype IS NOT NULL ORDER BY hoscode LIMIT 1");
    hos = h.hoscode;
    tp = 'test_khdpol_' + Date.now();
    ind = (await db.query(
        `INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, upload_excel, evaluation_mode, required_off_types)
         VALUES ('test_khdpol_ind', (SELECT id FROM departments ORDER BY id LIMIT 1), 1, ?, 0, 'any_one', ?)`, [tp, JSON.stringify([h.hostype])]))[0].insertId;
    const sa = await ensureTestUser(db, { username: 'test_khdpol_sa', role: 'super_admin', session_id: 's-khdpol-sa' });
    T.sa = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-khdpol-sa' });
    const ssj = await ensureTestUser(db, { username: 'test_khdpol_ssj', role: 'admin_ssj', session_id: 's-khdpol-ssj' });
    T.ssj = makeToken({ userId: ssj.id, username: ssj.username, role: 'admin_ssj', deptId: 1, hospcode: null, sessionId: 's-khdpol-ssj' });
    const ins = (m, actual, status, locked) => db.query(
        `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked) VALUES (?, ?, ?, ?, '50', ?, ?, ?, ?)`,
        [ind, YEAR, m, actual, sa.id, status, hos, locked]);
    await ins(10, '10', 'Approved', 1);
    await ins(11, '20', 'Pending', 0);
    const [[p]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'khd_send_policy'");
    prevPolicy = p ? p.setting_value : null;
    await db.query("DELETE FROM system_settings WHERE setting_key = 'khd_send_policy'"); // ค่าตั้งต้น
    policySvc.invalidateKhdSyncSettings();
}, 60000);

afterAll(async () => {
    if (prevPolicy === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'khd_send_policy'");
    else await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('khd_send_policy', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [prevPolicy]);
    policySvc.invalidateKhdSyncSettings();
    await db.query(`DROP TABLE IF EXISTS \`${tp}\``).catch(() => {});
    if (ind) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [ind]);
    }
    await cleanupTestUsers(db, 'test\\_khdpol\\_');
});

const exportedRow = async () => (await db.query(`SELECT target, result, m10, m11, m12 FROM \`${tp}\` WHERE hospcode = ? AND byear = ?`, [hos, YEAR]))[0][0];
const checkStatus = async () => ((await exportSvc.checkKpiChanges(YEAR, [ind])).details || []).find(d => d.id === ind).status;
const num = (v) => (v === null || v === undefined ? null : Number(v));

test('ค่าตั้งต้น = approved_only: ส่งออกเฉพาะเดือนที่อนุมัติ (เดิมส่ง พ.ย. ที่ยังรอตรวจด้วย)', async () => {
    expect(await policySvc.getKhdSendPolicy()).toBe('approved_only');
    const r = await exportSvc.performKpiExport(YEAR, [ind], null);
    expect(r.success).toBe(true);
    expect(r.policy).toBe('approved_only');
    const row = await exportedRow();
    expect(num(row.m10)).toBe(10);
    expect(row.m11).toBeNull();
    expect(num(row.result)).toBe(10);
    // ตรวจการเปลี่ยนแปลงตรงกับการส่งออกจริง (กติกาเดียวกัน)
    expect(await checkStatus()).toBe('up_to_date');
});

test('อนุมัติเดือนถัดไป → ตรวจพบการเปลี่ยนแปลง → ส่งออกค่าใหม่', async () => {
    await db.query('UPDATE kpi_results SET status = ?, is_locked = 1 WHERE indicator_id = ? AND month_bh = 11', ['Approved', ind]);
    expect(await checkStatus()).toBe('has_changes');
    await exportSvc.performKpiExport(YEAR, [ind], null);
    const row = await exportedRow();
    expect(num(row.m11)).toBe(20);
    expect(num(row.result)).toBe(20);
    expect(await checkStatus()).toBe('up_to_date');
});

test('ตั้งค่า all (super_admin) → ส่งค่าที่ยังไม่อนุมัติด้วย / admin_ssj ตั้งค่าไม่ได้', async () => {
    const put = (t, body) => request(app).put(api('/khd-sync/settings')).set('Authorization', `Bearer ${t}`).send(body);
    expect((await put(T.ssj, { khd_send_policy: 'all' })).status).toBe(403);
    expect((await put(T.sa, { khd_send_policy: 'bogus' })).status).toBe(400);
    expect((await put(T.sa, { khd_sync_batch_size: 5 })).status).toBe(400);
    const ok = await put(T.sa, { khd_send_policy: 'all' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.khd_send_policy).toBe('all');
    await db.query(`INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked)
                    SELECT ?, ?, 12, '30', '50', id, 'Pending', ?, 0 FROM users WHERE username = 'test_khdpol_sa'`, [ind, YEAR, hos]);
    expect(await checkStatus()).toBe('has_changes');
    await exportSvc.performKpiExport(YEAR, [ind], null);
    expect(num((await exportedRow()).m12)).toBe(30);
    const g = await request(app).get(api('/khd-sync/settings')).set('Authorization', `Bearer ${T.sa}`);
    expect(g.body.data.khd_send_policy).toBe('all');
});
