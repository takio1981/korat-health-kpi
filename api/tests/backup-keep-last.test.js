/**
 * Integration tests: ล้างไฟล์ backup เก่า — เก็บเฉพาะ N ไฟล์ล่าสุด (keep_last) + ตามอายุ (retention_days) (16 พ.ย. 2569) — database ทดสอบ
 *   - เฉพาะไฟล์ scheduled ของการเชื่อมต่อนั้น (ไฟล์ manual / cloud_download ไม่ถูกลบ)
 *   - preview ไม่ลบ | ลบไฟล์ในเครื่อง + แถว backup_files | cleanup_cloud = ลบสำเนาบน Google Drive ด้วย (Drive จำลอง)
 *   - retention_days 0 = ไม่ลบตามอายุ | keep_last 0 = ไม่จำกัด | บันทึกค่าผ่าน POST/PUT /backup/schedules (ค่าเกินช่วงถูกปรับ)
 */
require('./setup');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khups-bkkeep-'));

const FOLDER = 'FOLDER_TEST_bkkeep';
jest.mock('googleapis', () => {
    const state = { deleted: [] };
    const drive = { files: { delete: async ({ fileId }) => { state.deleted.push(fileId); return {}; }, list: async () => ({ data: { files: [] } }), get: async () => ({ data: {} }), create: async () => ({ data: {} }) } };
    class OAuth2 { setCredentials() {} generateAuthUrl() { return 'https://example.invalid'; } }
    return { __state: state, google: { auth: { OAuth2 }, drive: () => drive } };
});
const gstate = require('googleapis').__state;

const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, bk, saToken, connId, scheduleId, savedSettings = [];
const api = (p) => '/khupskpi/api' + p;
const auth = (r) => r.set('Authorization', `Bearer ${saToken}`);

// สร้างไฟล์ backup จำลอง: daysAgo = อายุ, trigger = ประเภท
async function addFile(tag, daysAgo, trigger = 'scheduled', cloudId = null) {
    const name = `test_bkkeep_${tag}.sql.gz`;
    const p = path.join(process.env.BACKUP_DIR, name);
    fs.writeFileSync(p, 'x'.repeat(10));
    const [r] = await db.query(
        `INSERT INTO backup_files (connection_id, connection_name, db_name, file_path, file_name, size_bytes, compressed, trigger_type, cloud_file_id, created_at)
         VALUES (?, 'TEST_bkkeep', 'khups_kpi_test_db', ?, ?, 10, 1, ?, ?, NOW() - INTERVAL ? DAY)`, [connId, p, name, trigger, cloudId, daysAgo]);
    return { id: r.insertId, path: p };
}
const remaining = async () => (await db.query("SELECT file_name FROM backup_files WHERE connection_id = ? ORDER BY created_at DESC, id DESC", [connId]))[0].map(r => r.file_name.replace(/^test_bkkeep_|\.sql\.gz$/g, ''));
const setSchedule = (vals) => db.query('UPDATE backup_schedules SET retention_days = ?, keep_last = ?, cleanup_cloud = ? WHERE id = ?', [vals.days, vals.keep, vals.cloud ? 1 : 0, scheduleId]);
const cleanup = (preview) => auth(request(app).post(api(`/backup/schedules/${scheduleId}/cleanup`))).send({ preview });

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    bk = require('../services/backup');
    await migrationsReady;
    await bk.backupTablesReady;
    await cleanupTestUsers(db);
    const sa = await ensureTestUser(db, { username: 'test_bkkeep_sa', role: 'super_admin', session_id: 'sess-bkkeep-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-bkkeep-sa' });
    connId = (await db.query(`INSERT INTO backup_connections (name, host, port, db_user, db_password_enc, db_name) VALUES ('TEST_bkkeep', '127.0.0.1', 3306, 'x', NULL, 'khups_kpi_test_db')`))[0].insertId;

    [savedSettings] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'gdrive_%'");
    const set = (k, v) => db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, v]);
    await set('gdrive_enabled', 'true');
    await set('gdrive_client_id', 'test-client');
    await set('gdrive_client_secret_enc', bk.bkEncrypt('test-secret'));
    await set('gdrive_refresh_token_enc', bk.bkEncrypt('test-refresh-keep-' + Date.now()));
    await set('gdrive_folder_id', FOLDER);
    bk.resetDriveClientCache();
});

afterAll(async () => {
    await db.query('DELETE FROM backup_files WHERE connection_id = ?', [connId]);
    await db.query('DELETE FROM backup_schedules WHERE connection_id = ?', [connId]);
    await db.query('DELETE FROM backup_connections WHERE id = ?', [connId]);
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'gdrive_%'");
    for (const r of savedSettings) await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
    bk.resetDriveClientCache();
    await cleanupTestUsers(db);
    fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
});

describe('ล้างไฟล์ backup เก่า: เก็บ N ไฟล์ล่าสุด', () => {
    test('บันทึก keep_last / cleanup_cloud / retention_days 0 ผ่าน POST + PUT (ค่าเกินช่วงถูกปรับ)', async () => {
        const body = { name: 'test_bkkeep', is_enabled: false, connection_id: connId, days_of_week: '1', time_of_day: '03:00', retention_days: 0, keep_last: 3, cleanup_cloud: true };
        const r = await auth(request(app).post(api('/backup/schedules'))).send(body);
        expect(r.status).toBe(200);
        scheduleId = r.body.id;
        let [[s]] = await db.query('SELECT retention_days, keep_last, cleanup_cloud FROM backup_schedules WHERE id = ?', [scheduleId]);
        expect(s).toEqual({ retention_days: 0, keep_last: 3, cleanup_cloud: 1 });
        await auth(request(app).put(api(`/backup/schedules/${scheduleId}`))).send({ ...body, keep_last: 99999, retention_days: undefined, cleanup_cloud: false });
        [[s]] = await db.query('SELECT retention_days, keep_last, cleanup_cloud FROM backup_schedules WHERE id = ?', [scheduleId]);
        expect(s).toEqual({ retention_days: 30, keep_last: 1000, cleanup_cloud: 0 });   // ไม่ส่ง = 30 วัน (ค่าเดิม)
        expect(bk.normKeepLast(-5)).toBe(0);
        expect(bk.normKeepLast('abc')).toBe(0);
    });

    test('preview ไม่ลบ แล้วลบจริงเหลือ 3 ไฟล์ล่าสุด — ไฟล์ manual / cloud_download ไม่ถูกลบ', async () => {
        const files = {};
        for (const [tag, d] of [['s1', 1], ['s2', 2], ['s3', 3], ['s4', 4], ['s5', 5]]) files[tag] = await addFile(tag, d);
        await addFile('m6', 6, 'manual');
        await addFile('c7', 7, 'cloud_download');
        await setSchedule({ days: 0, keep: 3, cloud: false });

        const p = await cleanup(true);
        expect(p.status).toBe(200);
        expect(p.body).toEqual(expect.objectContaining({ preview: true, files: 2, bytes: 20, kept: 3 }));
        expect(p.body.list.map(f => f.file_name)).toEqual(['test_bkkeep_s4.sql.gz', 'test_bkkeep_s5.sql.gz']);
        expect((await remaining()).length).toBe(7);

        const r = await cleanup(false);
        expect(r.body).toEqual(expect.objectContaining({ preview: false, files: 2 }));
        expect(await remaining()).toEqual(['s1', 's2', 's3', 'm6', 'c7']);
        expect(fs.existsSync(files.s5.path)).toBe(false);
        expect(fs.existsSync(files.s1.path)).toBe(true);
        const [[log]] = await db.query("SELECT new_value FROM system_logs WHERE action_type = 'BACKUP_CLEANUP' ORDER BY id DESC LIMIT 1");
        expect(JSON.parse(log.new_value)).toEqual(expect.objectContaining({ schedule_id: scheduleId, files: 2 }));
    });

    test('ตามอายุ + จำนวนรวมกัน: เกินอายุถูกลบแม้อยู่ใน N ล่าสุด, ทั้ง 2 เป็น 0 = ไม่ลบ', async () => {
        await addFile('old40', 40);
        await setSchedule({ days: 30, keep: 10, cloud: false });
        expect((await cleanup(false)).body.files).toBe(1);
        expect(await remaining()).toEqual(['s1', 's2', 's3', 'm6', 'c7']);
        await setSchedule({ days: 0, keep: 0, cloud: false });
        expect((await cleanup(false)).body.files).toBe(0);
    });

    test('cleanup_cloud = ลบสำเนาบน Google Drive ด้วย / ปิด = ไม่แตะ Drive', async () => {
        await addFile('d8', 8, 'scheduled', 'drvKeepCloud0001');
        await setSchedule({ days: 0, keep: 4, cloud: false });
        expect((await cleanup(false)).body.cloud).toBe(0);
        expect(gstate.deleted).toEqual([]);
        await addFile('d9', 9, 'scheduled', 'drvKeepCloud0002');
        await setSchedule({ days: 0, keep: 4, cloud: true });
        const r = await cleanup(false);
        expect(r.body).toEqual(expect.objectContaining({ files: 1, cloud: 1 }));
        expect(gstate.deleted).toEqual(['drvKeepCloud0002']);
    });

    test('ตารางเวลาที่ไม่มี = 404', async () => {
        expect((await auth(request(app).post(api('/backup/schedules/99999999/cleanup'))).send({})).status).toBe(404);
    });
});
