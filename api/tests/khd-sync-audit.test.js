/**
 * ส่ง KHD แบบปลอดภัย + ประวัติ/ย้อนกลับ + ส่งขั้นเดียว (ระยะ 3 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 * KHD จำลอง = ตาราง `<ชื่อ>__khd` ในฐานทดสอบ (ไม่เชื่อม KHD จริง)
 *   - ทุกการส่งบันทึกรอบ (khd_sync_runs) + ค่าก่อน-หลังรายช่อง (khd_sync_audit) + สถานะรายตาราง
 *   - ย้อนกลับ: คืนเฉพาะช่องที่ KHD ยังเป็นค่าที่ระบบเขียน, แถวที่มีผู้แก้ต่อ = ข้าม, แถวที่เพิ่มใหม่ไม่ลบ, ได้เฉพาะรอบล่าสุดของตาราง, ต้องพิมพ์เลขรอบยืนยัน
 *   - ครั้งละงานเดียว (ชนกัน = 409 KHD_SYNC_BUSY), เพดานแถวต่อรอบ = partial
 *   - ส่งขั้นเดียว: ตรวจก่อนได้ plan_token, ส่งจริงต้องแนบ token, ข้อมูลเปลี่ยนหลังตรวจ = 409 PLAN_CHANGED, admin_ssj = 403
 */
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: (sql, params) => require('../db').query(String(sql).replace(/`(test_khdaud_[a-z])`/g, '`$1__khd`'), params),
    }),
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers, withKhdPolicy } = require('./helpers');

let app, db, T = {}, sync, policy;
const api = (p) => '/khupskpi/api' + p;
const as = (t) => (r) => r.set('Authorization', `Bearer ${t}`);
const A = 'test_khdaud_a', B = 'test_khdaud_b';
const khd = (t) => `${t}__khd`;
const OLD = '2026-10-01 08:00:00', NEW = '2026-10-10 08:00:00', NEWER = '2026-10-20 08:00:00';
const cols = `hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) NULL, result VARCHAR(100) NULL,
    create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (hospcode, byear)`;
const rowOf = async (t, hc, y = '2569') => (await db.query(`SELECT * FROM \`${t}\` WHERE hospcode = ? AND byear = ?`, [hc, y]))[0][0];
const runIds = [];

async function dropAll() {
    for (const t of [A, B]) {
        await db.query(`DROP TABLE IF EXISTS \`${t}\``);
        await db.query(`DROP TABLE IF EXISTS \`${khd(t)}\``);
    }
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdaud\\_%'");
    await db.query("DELETE FROM khd_table_sync_status WHERE table_name LIKE 'test\\_khdaud\\_%'");
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    sync = require('../services/khd-sync');
    policy = require('../services/khd-policy');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_khdaud\\_');
    const sa = await ensureTestUser(db, { username: 'test_khdaud_sa', role: 'super_admin' });
    T.sa = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    // บัญชีแยกสำหรับส่งขั้นเดียว (khdLimiter 6 ครั้ง/นาที/ผู้ใช้ — การย้อนกลับในกรณีก่อนหน้าใช้โควตาของ T.sa)
    const sa2 = await ensureTestUser(db, { username: 'test_khdaud_sa2', role: 'super_admin' });
    T.sa2 = makeToken({ userId: sa2.id, username: sa2.username, role: 'super_admin', deptId: null, hospcode: null });
    const sa3 = await ensureTestUser(db, { username: 'test_khdaud_sa3', role: 'super_admin' });
    T.sa3 = makeToken({ userId: sa3.id, username: sa3.username, role: 'super_admin', deptId: null, hospcode: null });
    const ssj = await ensureTestUser(db, { username: 'test_khdaud_ssj', role: 'admin_ssj' });
    T.ssj = makeToken({ userId: ssj.id, username: ssj.username, role: 'admin_ssj', deptId: 1, hospcode: null });
}, 60000);

beforeEach(async () => {
    await dropAll();
    for (const t of [A, B]) {
        await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active, upload_excel) VALUES (?,?,1,0)', [`test_khdaud ${t}`, t]);
        await db.query(`CREATE TABLE \`${t}\` (${cols})`);
        await db.query(`CREATE TABLE \`${khd(t)}\` (${cols})`);
    }
    const ins = (t, rows) => db.query(`INSERT INTO \`${t}\` (hospcode, byear, target, result, update_date) VALUES ?`, [rows]);
    await ins(A, [['10001', '2569', '70', '60', NEW], ['10002', '2569', '80', '75', NEW], ['10003', '2569', '50', '40', NEW]]);
    await ins(khd(A), [['10001', '2569', '12', '16', OLD], ['10002', '2569', '20', '25', OLD]]);
    await ins(B, [['10001', '2569', '1', '1', NEW]]);
    await ins(khd(B), [['10001', '2569', '9', '9', OLD]]);
});

afterAll(async () => {
    await dropAll();
    const [r] = await db.query("SELECT id FROM khd_sync_runs WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'test\\_khdaud\\_%')");
    const ids = [...new Set([...runIds, ...r.map(x => x.id)])];
    if (ids.length) {
        await db.query('DELETE FROM khd_sync_audit WHERE run_id IN (?)', [ids]);
        await db.query('DELETE FROM khd_sync_runs WHERE id IN (?) OR rollback_of IN (?)', [ids, ids]);
    }
    await cleanupTestUsers(db, 'test\\_khdaud\\_');
});

const execute = (tables, token = T.sa) => as(token)(request(app).post(api('/sync-to-khd/execute'))).send({ tables: tables.map(t => ({ table: t })) });
const rollback = (id, confirm = String(id), token = T.sa) => as(token)(request(app).post(api(`/khd-sync/runs/${id}/rollback`))).send({ confirm });

test('ส่งแล้วบันทึกรอบ + ค่าก่อน-หลังรายช่อง + สถานะรายตาราง', async () => {
    const res = await execute([A]);
    expect(res.status).toBe(200);
    const runId = res.body.run_id;
    runIds.push(runId);
    expect(runId).toBeGreaterThan(0);
    expect(res.body.results[0]).toMatchObject({ status: 'success', inserted: 1, updated: 2 });
    const [[run]] = await db.query('SELECT * FROM khd_sync_runs WHERE id = ?', [runId]);
    expect(run).toMatchObject({ status: 'success', trigger_type: 'manual', rows_inserted: 1, rows_updated: 2, cells_updated: 4 });
    const [aud] = await db.query("SELECT hospcode, col_name, before_value, after_value, applied FROM khd_sync_audit WHERE run_id = ? AND op = 'update' ORDER BY hospcode, col_name", [runId]);
    expect(aud.map(a => [a.hospcode, a.col_name, a.before_value, a.after_value, Number(a.applied)])).toEqual([
        ['10001', 'result', '16', '60', 1], ['10001', 'target', '12', '70', 1],
        ['10002', 'result', '25', '75', 1], ['10002', 'target', '20', '80', 1],
    ]);
    const [[ins]] = await db.query("SELECT COUNT(*) n FROM khd_sync_audit WHERE run_id = ? AND op = 'insert'", [runId]);
    expect(Number(ins.n)).toBe(1);
    const [[st]] = await db.query('SELECT last_status, last_run_id FROM khd_table_sync_status WHERE table_name = ?', [A]);
    expect(st).toMatchObject({ last_status: 'success', last_run_id: runId });
    // อ่านประวัติได้ (super_admin เท่านั้น)
    const list = await as(T.sa)(request(app).get(api('/khd-sync/runs')));
    expect(list.body.data.some(r => r.id === runId)).toBe(true);
    expect((await as(T.ssj)(request(app).get(api('/khd-sync/runs')))).status).toBe(403);
    const det = await as(T.sa)(request(app).get(api(`/khd-sync/runs/${runId}`)));
    expect(det.body.data.audit_by_table[0]).toMatchObject({ table_name: A });
});

test('ย้อนกลับ: คืนค่าเดิมเฉพาะแถวที่ไม่มีผู้แก้ต่อ, แถวที่เพิ่มใหม่ไม่ลบ, ต้องพิมพ์เลขรอบ', async () => {
    const runId = (await execute([A])).body.run_id;
    runIds.push(runId);
    // มีผู้แก้แถว 10002 ใน KHD ต่อจากเรา (เวลาใหม่กว่า) → ห้ามทับ
    await db.query(`UPDATE \`${khd(A)}\` SET target = '99', update_date = ? WHERE hospcode = '10002' AND byear = '2569'`, [NEWER]);
    expect((await rollback(runId, 'x')).status).toBe(400);
    expect((await rollback(runId, String(runId), T.ssj)).status).toBe(403);
    const res = await rollback(runId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'partially_rolled_back', reverted_rows: 1, skipped_changed: 1, kept_inserts: 1 });
    const h1 = await rowOf(khd(A), '10001');
    expect([h1.target, h1.result]).toEqual(['12', '16']);
    expect(new Date(h1.update_date).toISOString()).toBe(new Date(OLD.replace(' ', 'T')).toISOString());
    expect((await rowOf(khd(A), '10002')).target).toBe('99');   // ค่าที่ผู้อื่นแก้คงอยู่
    expect((await rowOf(khd(A), '10003')).target).toBe('50');   // แถวที่เพิ่มไม่ลบ
    const [[run]] = await db.query('SELECT status, rolled_back_at FROM khd_sync_runs WHERE id = ?', [runId]);
    expect(run.status).toBe('partially_rolled_back');
    expect(run.rolled_back_at).not.toBeNull();
    runIds.push(res.body.data.rollback_run_id);
    // ย้อนกลับซ้ำไม่ได้
    expect((await rollback(runId)).status).toBe(409);
});

test('ย้อนกลับได้เฉพาะรอบล่าสุดของตาราง', async () => {
    const first = (await execute([A])).body.run_id;
    await db.query(`UPDATE \`${A}\` SET target = '71', update_date = ? WHERE hospcode = '10001'`, [NEWER]);
    const second = (await execute([A])).body.run_id;
    runIds.push(first, second);
    const res = await rollback(first);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_LATEST');
    const ok = await rollback(second);
    expect(ok.status).toBe(200);
    expect(ok.body.data.reverted_rows).toBe(1);
    runIds.push(ok.body.data.rollback_run_id);
    expect((await rowOf(khd(A), '10001')).target).toBe('70'); // กลับเป็นค่าของรอบแรก
});

test('ครั้งละงานเดียว: มีงานส่งอยู่ = 409 KHD_SYNC_BUSY ข้อมูล KHD ไม่เปลี่ยน', async () => {
    let release;
    const hold = sync.withKhdSyncLock({ trigger: 'test' }, () => new Promise(r => { release = r; }));
    await new Promise(r => setTimeout(r, 50));
    try {
        const res = await execute([A]);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('KHD_SYNC_BUSY');
        expect((await rowOf(khd(A), '10001')).target).toBe('12');
    } finally {
        release();
        await hold;
    }
});

test('เพดานแถวต่อรอบ: เกิน = partial ตารางที่เหลือส่งรอบถัดไป', async () => {
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('khd_sync_max_rows', '100') ON DUPLICATE KEY UPDATE setting_value = '100'");
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('khd_sync_batch_size', '10') ON DUPLICATE KEY UPDATE setting_value = '10'");
    policy.invalidateKhdSyncSettings();
    try {
        const rows = [];
        for (let i = 0; i < 120; i++) rows.push([String(20000 + i), '2569', '1', '1', NEW]);
        await db.query(`INSERT INTO \`${A}\` (hospcode, byear, target, result, update_date) VALUES ?`, [rows]);
        const res = await execute([A, B]);
        runIds.push(res.body.run_id);
        expect(res.body.status).toBe('partial');
        expect(res.body.results[0].status).toBe('partial');
        expect(res.body.results[1]).toMatchObject({ status: 'skipped', deferred: true });
        expect((await rowOf(khd(B), '10001')).target).toBe('9');
        const [[n]] = await db.query(`SELECT COUNT(*) n FROM \`${khd(A)}\``);
        expect(Number(n.n)).toBeLessThan(123);
    } finally {
        await db.query("DELETE FROM system_settings WHERE setting_key IN ('khd_sync_max_rows', 'khd_sync_batch_size')");
        policy.invalidateKhdSyncSettings();
    }
});

describe('ส่งขั้นเดียว POST /khd-sync/quick', () => {
    // ตารางอื่นในฐานทดสอบ (ตัวชี้วัดตัวอย่าง) ไม่มีตารางใน KHD จำลอง → blocked ไม่เขียนอะไร — ตรวจเฉพาะตาราง test_khdaud_*
    // ขั้นเตรียมตารางส่งออก (checkKpiChanges/performKpiExport) ทดสอบแล้วใน khd-send-policy.test.js — ที่นี่จำลองว่า "ไม่มีตัวชี้วัดเปลี่ยน"
    // ไม่ให้ส่งออกตัวชี้วัดทั้งฐานทดสอบทับตาราง test_khdaud_* ระหว่างทดสอบ
    let exportSvc;
    beforeEach(() => {
        exportSvc = require('../services/export');
        jest.spyOn(exportSvc, 'checkKpiChanges').mockResolvedValue({ success: true, details: [] });
        jest.spyOn(exportSvc, 'performKpiExport');
    });
    afterEach(() => jest.restoreAllMocks());
    const quick = (body, token = T.sa2) => as(token)(request(app).post(api('/khd-sync/quick'))).send({ year_bh: '2569', ...body });
    const mine = (b) => (b.tables || []).filter(t => t.table === A || t.table === B);

    test('ตรวจก่อน → ได้ plan_token → ส่งจริง → รอบถัดไปข้ามตารางที่ส่งครบแล้ว', () => withKhdPolicy(db, 'all', async () => {
        expect((await quick({ dry_run: true }, T.ssj)).status).toBe(403);
        const pre = await quick({ dry_run: true });
        expect(pre.status).toBe(200);
        expect(pre.body.dry_run).toBe(true);
        expect(exportSvc.performKpiExport).not.toHaveBeenCalled();
        expect(mine(pre.body).map(t => [t.table, t.status, t.insert, t.update]).sort()).toEqual([[A, 'ready', 1, 2], [B, 'ready', 0, 1]]);
        expect((await rowOf(khd(A), '10001')).target).toBe('12'); // ตรวจก่อนไม่แตะ KHD
        expect((await quick({ dry_run: false })).body.code).toBe('PLAN_TOKEN_INVALID');
        const go = await quick({ dry_run: false, plan_token: pre.body.plan_token });
        expect(go.status).toBe(200);
        runIds.push(go.body.run_id);
        expect(go.body.run_id).toBeGreaterThan(0);
        expect((await rowOf(khd(A), '10001')).target).toBe('70');
        expect((await rowOf(khd(B), '10001')).target).toBe('1');
        const [[run]] = await db.query('SELECT trigger_type, year_bh FROM khd_sync_runs WHERE id = ?', [go.body.run_id]);
        expect(run).toMatchObject({ trigger_type: 'quick', year_bh: '2569' });
        // ส่งครบแล้ว → ตรวจรอบถัดไปไม่วางแผนตารางเดิมซ้ำ (อ่าน KHD น้อยลง)
        const again = await quick({ dry_run: true });
        expect(mine(again.body)).toEqual([]);
    }));

    test('มีตัวชี้วัดเปลี่ยน → เตรียมตารางส่งออกเฉพาะตัวนั้นก่อนวางแผน', async () => {
        exportSvc.checkKpiChanges.mockResolvedValue({ success: true, details: [{ id: 901, status: 'has_changes' }, { id: 902, status: 'up_to_date' }] });
        exportSvc.performKpiExport.mockResolvedValue({ success: true, summary: { inserted: 3, updated: 0, unchanged: 0, no_data: 0 } });
        const pre = await quick({ dry_run: true });
        expect(pre.status).toBe(200);
        expect(exportSvc.performKpiExport).toHaveBeenCalledWith('2569', [901], expect.anything(), expect.anything());
        expect(pre.body.export).toMatchObject({ indicators_changed: 1, inserted: 3 });
    });

    test('ข้อมูลเปลี่ยนหลังตรวจ → 409 PLAN_CHANGED พร้อมผลตรวจใหม่ ไม่ส่ง', () => withKhdPolicy(db, 'all', async () => {
        const pre = await quick({ dry_run: true }, T.sa3);
        await db.query(`UPDATE \`${A}\` SET target = '77', update_date = ? WHERE hospcode = '10001'`, [NEWER]);
        const go = await quick({ dry_run: false, plan_token: pre.body.plan_token }, T.sa3);
        expect(go.status).toBe(409);
        expect(go.body.code).toBe('PLAN_CHANGED');
        expect(go.body.preview.plan_token).toBeTruthy();
        expect((await rowOf(khd(A), '10001')).target).toBe('12');
    }));
});
