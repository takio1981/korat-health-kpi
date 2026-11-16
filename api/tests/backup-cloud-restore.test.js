/**
 * Integration tests: กู้คืนฐานข้อมูลจากไฟล์บน Google Drive (16 พ.ย. 2569) — database ทดสอบ + Google Drive จำลอง (jest.mock('googleapis'))
 *   - GET /backup/cloud/files: เฉพาะไฟล์ .sql/.sql.gz ในโฟลเดอร์ที่ตั้งไว้ + เดาการเชื่อมต่อจากชื่อไฟล์ + สถานะในเซิร์ฟเวอร์
 *   - POST /backup/cloud/files/:fileId/fetch: ดาวน์โหลดลงโฟลเดอร์ backup + ลงทะเบียน backup_files (cloud_download) แล้วใช้ขั้นตอนกู้คืนเดิม
 *     มีไฟล์อยู่แล้ว = ไม่ดาวน์โหลดซ้ำ | ไฟล์ในเครื่องหาย = ดาวน์โหลดใหม่ลงแถวเดิม | ไม่รู้การเชื่อมต่อ = 400 | นอกโฟลเดอร์/ไม่ใช่ไฟล์ backup/รหัสผิด = 404/400
 *   - super_admin เท่านั้น
 */
require('./setup');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khups-bkcloud-'));

const FOLDER = 'FOLDER_TEST_bkcloud';
jest.mock('googleapis', () => {
    const { Readable } = require('stream');
    const state = { files: [], content: {}, downloads: 0 };
    const notFound = () => { const e = new Error('File not found'); e.code = 404; return e; };
    const drive = {
        files: {
            list: async ({ q }) => ({ data: { files: state.files.filter(f => q.includes(`'${f.parents[0]}' in parents`)).map(({ parents, ...f }) => f) } }),
            get: async (p) => {
                const f = state.files.find(x => x.id === p.fileId);
                if (!f) throw notFound();
                if (p.alt === 'media') { state.downloads++; return { data: Readable.from([Buffer.from(state.content[f.id])]) }; }
                return { data: { ...f, trashed: false } };
            },
            create: async () => ({ data: {} }), delete: async () => ({}),
        },
    };
    class OAuth2 { setCredentials() {} generateAuthUrl() { return 'https://example.invalid'; } }
    return { __state: state, google: { auth: { OAuth2 }, drive: () => drive } };
});
const gstate = require('googleapis').__state;

const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken, userToken, connId, savedSettings = [];
const api = (p) => '/khupskpi/api' + p;
const CONN_NAME = 'TEST_bkcloud';
const DB_NAME = 'khups_kpi_test_db';
const nameOf = (ts) => `${DB_NAME}_${CONN_NAME}_${ts}.sql.gz`;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    const bk = require('../services/backup');
    await migrationsReady;
    await bk.backupTablesReady;
    await cleanupTestUsers(db);
    const sa = await ensureTestUser(db, { username: 'test_bkcloud_sa', role: 'super_admin', session_id: 'sess-bkcloud-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-bkcloud-sa' });
    const u = await ensureTestUser(db, { username: 'test_bkcloud_user', role: 'admin_ssj', session_id: 'sess-bkcloud-u' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'admin_ssj', deptId: 1, hospcode: null, sessionId: 'sess-bkcloud-u' });

    connId = (await db.query(`INSERT INTO backup_connections (name, host, port, db_user, db_password_enc, db_name) VALUES (?, '127.0.0.1', 3306, 'x', NULL, ?)`,
        [CONN_NAME, DB_NAME]))[0].insertId;

    // ตั้งค่า Google Drive ในฐานทดสอบ (คืนค่าเดิมใน afterAll)
    [savedSettings] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'gdrive_%'");
    const set = (k, v) => db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, v]);
    await set('gdrive_enabled', 'true');
    await set('gdrive_client_id', 'test-client');
    await set('gdrive_client_secret_enc', bk.bkEncrypt('test-secret'));
    await set('gdrive_refresh_token_enc', bk.bkEncrypt('test-refresh-' + Date.now()));
    await set('gdrive_folder_id', FOLDER);
    bk.resetDriveClientCache();

    const add = (id, name, content, parent = FOLDER) => { gstate.files.push({ id, name, size: String(Buffer.byteLength(content)), parents: [parent], createdTime: '2026-11-16T05:00:00Z' }); gstate.content[id] = content; };
    add('drvKnownName0001', nameOf('2026-11-16T12-00-00'), '-- dump A\n');
    add('drvUnknownName01', 'manual-upload.sql', '-- dump B\n');
    add('drvNotBackup0001', 'notes.txt', 'hello');
    add('drvOtherFolder01', nameOf('2026-11-16T13-00-00'), '-- dump C\n', 'OTHER_FOLDER');
});

afterAll(async () => {
    const ids = gstate.files.map(f => f.id);
    await db.query('DELETE FROM backup_files WHERE cloud_file_id IN (?)', [ids]);
    await db.query('DELETE FROM backup_connections WHERE id = ?', [connId]);
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'gdrive_%'");
    for (const r of savedSettings) await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
    require('../services/backup').resetDriveClientCache();
    await cleanupTestUsers(db);
    fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
});

const list = (t = saToken) => request(app).get(api('/backup/cloud/files')).set('Authorization', `Bearer ${t}`);
const fetchFile = (id, body = {}, t = saToken) => request(app).post(api(`/backup/cloud/files/${id}/fetch`)).set('Authorization', `Bearer ${t}`).send(body);

describe('กู้คืนจากไฟล์บน Google Drive', () => {
    test('รายการ: เฉพาะไฟล์ backup ในโฟลเดอร์ที่ตั้งไว้ + เดาการเชื่อมต่อจากชื่อไฟล์', async () => {
        const res = await list();
        expect(res.status).toBe(200);
        const byId = Object.fromEntries(res.body.data.map(f => [f.id, f]));
        expect(Object.keys(byId).sort()).toEqual(['drvKnownName0001', 'drvUnknownName01']);
        expect(byId.drvKnownName0001).toEqual(expect.objectContaining({ connection_id: connId, local_exists: false, local_file_id: null }));
        expect(byId.drvUnknownName01.connection_id).toBeNull();
        expect(res.body.connections.some(c => c.id === connId)).toBe(true);
    });

    test('ไม่ใช่ super_admin = 403', async () => {
        expect((await list(userToken)).status).toBe(403);
        expect((await fetchFile('drvKnownName0001', { connection_id: connId }, userToken)).status).toBe(403);
    });

    test('ไม่รู้การเชื่อมต่อ = 400 CONNECTION_REQUIRED (ไม่ดาวน์โหลด)', async () => {
        const before = gstate.downloads;
        const res = await fetchFile('drvUnknownName01');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CONNECTION_REQUIRED');
        expect(gstate.downloads).toBe(before);
    });

    test('ดาวน์โหลดลงโฟลเดอร์ backup + ลงทะเบียน แล้วครั้งถัดไปใช้ไฟล์เดิม', async () => {
        const res = await fetchFile('drvUnknownName01', { connection_id: connId });
        expect(res.status).toBe(200);
        expect(res.body.downloaded).toBe(true);
        const f = res.body.file;
        expect(f).toEqual(expect.objectContaining({ connection_id: connId, db_name: DB_NAME, trigger_type: 'cloud_download', cloud_provider: 'gdrive', compressed: 0 }));
        expect(f.file_path).toBeUndefined();   // ไม่ส่ง path ในเครื่องให้หน้าจอ
        const [[row]] = await db.query('SELECT * FROM backup_files WHERE id = ?', [f.id]);
        expect(row.cloud_file_id).toBe('drvUnknownName01');
        expect(path.dirname(row.file_path)).toBe(process.env.BACKUP_DIR);
        expect(fs.readFileSync(row.file_path, 'utf8')).toBe('-- dump B\n');
        expect(row.checksum_sha256).toBe(crypto.createHash('sha256').update('-- dump B\n').digest('hex'));
        expect(fs.readdirSync(process.env.BACKUP_DIR).some(n => n.endsWith('.part'))).toBe(false);

        const before = gstate.downloads;
        const again = await fetchFile('drvUnknownName01');
        expect(again.body).toEqual(expect.objectContaining({ success: true, downloaded: false }));
        expect(again.body.file.id).toBe(f.id);
        expect(gstate.downloads).toBe(before);

        const l = await list();
        expect(l.body.data.find(x => x.id === 'drvUnknownName01')).toEqual(expect.objectContaining({ local_file_id: f.id, local_exists: true, connection_id: connId, known_connection: true }));
    });

    test('ไฟล์ในเครื่องหาย = ดาวน์โหลดใหม่ลงแถวเดิม (ไม่ต้องเลือกการเชื่อมต่ออีก)', async () => {
        const first = await fetchFile('drvKnownName0001', { connection_id: connId });
        expect(first.body.downloaded).toBe(true);
        expect(first.body.file.compressed).toBe(1);
        const [[row]] = await db.query('SELECT file_path FROM backup_files WHERE id = ?', [first.body.file.id]);
        fs.unlinkSync(row.file_path);
        const again = await fetchFile('drvKnownName0001');
        expect(again.body).toEqual(expect.objectContaining({ success: true, downloaded: true }));
        expect(again.body.file.id).toBe(first.body.file.id);
        const [rows] = await db.query('SELECT file_path FROM backup_files WHERE cloud_file_id = ?', ['drvKnownName0001']);
        expect(rows).toHaveLength(1);
        expect(fs.existsSync(rows[0].file_path)).toBe(true);
    });

    test('นอกโฟลเดอร์ = 404, ไม่ใช่ไฟล์ backup = 400, รหัสผิดรูปแบบ = 400', async () => {
        expect((await fetchFile('drvOtherFolder01', { connection_id: connId })).status).toBe(404);
        expect((await fetchFile('drvNotBackup0001', { connection_id: connId })).status).toBe(400);
        expect((await fetchFile('bad..id', { connection_id: connId })).status).toBe(400);
        const [rows] = await db.query('SELECT id FROM backup_files WHERE cloud_file_id IN (?)', [['drvOtherFolder01', 'drvNotBackup0001']]);
        expect(rows).toHaveLength(0);
    });
});
