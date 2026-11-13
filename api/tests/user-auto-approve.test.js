/**
 * อนุมัติผู้สมัครใหม่อัตโนมัติตามเวลา + ส่งผู้ใช้ใหม่ขึ้น KHD (13 พ.ย. 2569)
 *   - อนุมัติเฉพาะผู้รออนุมัติที่มีเวลาลงทะเบียน (user_registrations) และครบเวลาหน่วงแล้ว — ทุกบทบาท, ผู้ที่รออยู่ก่อน (ไม่มีแถว) ไม่อนุมัติ
 *   - แจ้ง super_admin (notifications) + ส่งขึ้น KHD ทันทีเมื่อเปิดไว้ | ส่งไม่สำเร็จ = เก็บข้อผิดพลาดแล้วส่งซ้ำตามรอบ
 *   - ตั้งค่า super_admin เท่านั้น, ค่าผิด = 400
 * ไม่เชื่อม KHD จริง (mock syncUsersToKhd) และไม่ส่ง LINE/อีเมลจริง (ฐานทดสอบมีโทเคนจริง — mock core/notify)
 */
jest.mock('../services/users-khd-sync', () => ({ getUsersSyncConfig: jest.fn(async () => ({ exclude: new Set(), mapping: {} })), syncUsersToKhd: jest.fn() }));
jest.mock('../core/notify', () => {
    const actual = jest.requireActual('../core/notify');
    return { ...actual, sendLineToUser: jest.fn(), sendMail: jest.fn(), notifyAdmins: jest.fn(async () => {}), sendTelegramDirect: jest.fn(), sendLineMulticast: jest.fn() };
});
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { syncUsersToKhd } = require('../services/users-khd-sync');
const { isSyncDue } = require('../jobs/user-approval');

let app, db, saToken, ssjToken, sa;
const api = (p) => '/khupskpi/api' + p;
const as = (t) => ({ Authorization: `Bearer ${t}` });
const KEYS = ['user_auto_approve_enabled', 'user_auto_approve_delay_min', 'user_khd_sync_on_approve', 'user_khd_sync_schedule_enabled', 'user_khd_sync_time', 'user_approval_last_run'];
let savedSettings = [];
const created = [];
const pending = async (username, role, minutesAgo) => {
    const u = await ensureTestUser(db, { username, role, is_approved: 0 });
    created.push(u.id);
    if (minutesAgo !== null) await db.query('INSERT INTO user_registrations (user_id, registered_at, source) VALUES (?, NOW() - INTERVAL ? MINUTE, ?)', [u.id, minutesAgo, 'test']);
    return u;
};
const approvedOf = async (id) => (await db.query('SELECT is_approved, approved_by FROM users WHERE id = ?', [id]))[0][0];
const putSettings = (body, t = saToken) => request(app).put(api('/user-approval/settings')).set(as(t)).send(body);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    [savedSettings] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [KEYS]);
    sa = await ensureTestUser(db, { username: 'test_uaa_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    const ssj = await ensureTestUser(db, { username: 'test_uaa_ssj', role: 'admin_ssj' });
    ssjToken = makeToken({ userId: ssj.id, username: ssj.username, role: 'admin_ssj', deptId: 1, hospcode: null });
}, 60000);
afterAll(async () => {
    await db.query('DELETE FROM system_settings WHERE setting_key IN (?)', [KEYS]);
    for (const r of savedSettings) await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
    require('../services/user-approval').invalidateUserApprovalSettings();
    if (created.length) {
        await db.query('DELETE FROM user_registrations WHERE user_id IN (?)', [created]);
        await db.query('DELETE FROM user_khd_sync WHERE user_id IN (?)', [created]);
        await db.query("DELETE FROM notifications WHERE title = 'อนุมัติผู้ใช้งานใหม่อัตโนมัติ' AND user_id = ?", [sa.id]);
    }
    await cleanupTestUsers(db);
});
beforeEach(() => syncUsersToKhd.mockReset());

describe('ตั้งค่า', () => {
    test('super_admin เท่านั้น | ค่าผิด = 400 | บันทึกแล้วอ่านกลับได้', async () => {
        expect((await request(app).get(api('/user-approval/settings')).set(as(ssjToken))).status).toBe(403);
        expect((await putSettings({ delay: 0 })).status).toBe(400);
        expect((await putSettings({ syncTime: '25:00' })).status).toBe(400);
        expect((await putSettings({ autoApprove: 'yes' })).status).toBe(400);
        const r = await putSettings({ autoApprove: false, delay: 5, syncOnApprove: true, syncSchedule: true, syncTime: '03:30' });
        expect(r.status).toBe(200);
        expect(r.body.data).toEqual({ autoApprove: false, delay: 5, syncOnApprove: true, syncSchedule: true, syncTime: '03:30' });
        const g = await request(app).get(api('/user-approval/settings')).set(as(saToken));
        expect(g.body.status).toEqual(expect.objectContaining({ waiting_auto: expect.any(Number), khd_failed: expect.any(Number) }));
    });
});

describe('อนุมัติอัตโนมัติ', () => {
    let due, notYet, old, dueAdmin;
    beforeAll(async () => {
        due = await pending('test_uaa_due', 'user_hos', 10);         // ลงทะเบียน 10 นาทีก่อน
        dueAdmin = await pending('test_uaa_adm', 'admin_cup', 6);     // ทุกบทบาท (ผู้ใช้สั่ง)
        notYet = await pending('test_uaa_new', 'user_hos', 1);        // ยังไม่ครบ 5 นาที
        old = await pending('test_uaa_old', 'user_hos', null);        // รออยู่ก่อนเปิดระบบนี้ (ไม่มีเวลาลงทะเบียน)
    });

    test('ปิดอยู่ = ไม่อนุมัติ (ตรวจตอนนี้ = 400)', async () => {
        const r = await request(app).post(api('/user-approval/run')).set(as(saToken)).send({ task: 'approve' });
        expect(r.status).toBe(400);
        expect((await approvedOf(due.id)).is_approved).toBe(0);
    });

    test('ครบเวลา = อนุมัติ (ทุกบทบาท) + แจ้ง super_admin + ส่งขึ้น KHD ทันที | ยังไม่ครบ / ไม่มีเวลาลงทะเบียน = รอต่อ', async () => {
        syncUsersToKhd.mockResolvedValue({ status: 200, body: { success: true, message: 'Sync สำเร็จ 2 คน' }, failedUsernames: [] });
        await putSettings({ autoApprove: true, delay: 5, syncOnApprove: true });
        const r = await request(app).post(api('/user-approval/run')).set(as(saToken)).send({ task: 'approve' });
        expect(r.status).toBe(200);
        expect(r.body.approved.sort()).toEqual(['test_uaa_adm', 'test_uaa_due']);
        expect(await approvedOf(due.id)).toEqual({ is_approved: 1, approved_by: null });
        expect((await approvedOf(dueAdmin.id)).is_approved).toBe(1);
        expect((await approvedOf(notYet.id)).is_approved).toBe(0);
        expect((await approvedOf(old.id)).is_approved).toBe(0);
        const [[log]] = await db.query("SELECT COUNT(*) AS n FROM system_logs WHERE action_type = 'AUTO_APPROVE_USER' AND record_id = ?", [due.id]);
        expect(log.n).toBe(1);
        const [[n]] = await db.query("SELECT message FROM notifications WHERE user_id = ? AND title = 'อนุมัติผู้ใช้งานใหม่อัตโนมัติ' ORDER BY id DESC LIMIT 1", [sa.id]);
        expect(n.message).toContain('test_uaa_due');
        expect(syncUsersToKhd).toHaveBeenCalledTimes(1);
        expect(syncUsersToKhd.mock.calls[0][0].usernames.sort()).toEqual(['test_uaa_adm', 'test_uaa_due']);
        const [[s]] = await db.query('SELECT synced_at, last_error FROM user_khd_sync WHERE user_id = ?', [due.id]);
        expect(s.synced_at).not.toBeNull();
        expect(s.last_error).toBeNull();
        // รอบถัดไปไม่อนุมัติซ้ำ
        const again = await request(app).post(api('/user-approval/run')).set(as(saToken)).send({ task: 'approve' });
        expect(again.body.approved).toEqual([]);
    });

    test('ส่งขึ้น KHD ไม่สำเร็จ → เก็บข้อผิดพลาด → รอบเวลาส่งซ้ำสำเร็จ', async () => {
        const u = await pending('test_uaa_fail', 'user_sso', 20);
        syncUsersToKhd.mockResolvedValueOnce({ status: 500, body: { success: false, message: 'KHD ล่ม' }, failedUsernames: [] });
        await request(app).post(api('/user-approval/run')).set(as(saToken)).send({ task: 'approve' });
        let [[s]] = await db.query('SELECT synced_at, last_error, attempts FROM user_khd_sync WHERE user_id = ?', [u.id]);
        expect([s.synced_at, s.last_error, s.attempts]).toEqual([null, 'KHD ล่ม', 1]);
        syncUsersToKhd.mockResolvedValueOnce({ status: 200, body: { success: true, message: 'ok' }, failedUsernames: [] });
        const r = await request(app).post(api('/user-approval/run')).set(as(saToken)).send({ task: 'sync' });
        expect(r.status).toBe(200);
        expect(syncUsersToKhd.mock.calls[1][0].usernames).toContain('test_uaa_fail');
        expect(syncUsersToKhd.mock.calls[1][0].usernames).not.toContain('test_uaa_due');   // ส่งสำเร็จแล้วไม่ส่งซ้ำ
        [[s]] = await db.query('SELECT synced_at, last_error FROM user_khd_sync WHERE user_id = ?', [u.id]);
        expect(s.synced_at).not.toBeNull();
        expect(s.last_error).toBeNull();
    });

    test('ผู้ดูแลกดอนุมัติเอง → ส่งขึ้น KHD ทันที (เมื่อเปิดไว้)', async () => {
        syncUsersToKhd.mockResolvedValue({ status: 200, body: { success: true }, failedUsernames: [] });
        const r = await request(app).put(api(`/users/${old.id}/approve`)).set(as(saToken)).send({});
        expect(r.status).toBe(200);
        for (let i = 0; i < 20 && !syncUsersToKhd.mock.calls.length; i++) await new Promise(res => setTimeout(res, 50));
        expect(syncUsersToKhd.mock.calls[0][0].usernames).toEqual(['test_uaa_old']);
        expect((await approvedOf(old.id)).approved_by).toBe(sa.id);
    });
});

test('isSyncDue: ตรงเวลา (ช่วง 2 นาที) วันละครั้ง, ปิด = ไม่ส่ง', () => {
    const cfg = { syncSchedule: true, syncTime: '02:00' };
    const at = (hhmm) => new Date(`2026-11-13T${hhmm}:10+07:00`);
    expect(isSyncDue(cfg, at('02:00'), '').due).toBe(true);
    expect(isSyncDue(cfg, at('02:01'), '').due).toBe(true);
    expect(isSyncDue(cfg, at('02:02'), '').due).toBe(false);
    expect(isSyncDue(cfg, at('02:00'), '2026-11-13').due).toBe(false);
    expect(isSyncDue({ ...cfg, syncSchedule: false }, at('02:00'), '').due).toBe(false);
});
