/**
 * เข้าสู่ระบบอัตโนมัติจาก KHD (9 พ.ย. 2569): POST /auth/khd/login + GET|PUT /auth/khd/settings
 *   - JWT HS256 รหัสลับร่วม ภายในมีแค่ชื่อผู้ใช้ | exp ≤ 5 นาที, jti ใช้ครั้งเดียว (จำเมื่อสำเร็จ), iss = ชื่อโฮสต์ของ URL ระบบ KHD ที่ตั้งไว้, aud
 *   - กติกาบัญชี/login ซ้อนใช้ completeLogin() ตัวเดียวกับ POST /login
 *   - รหัสลับไม่หลุดใน GET /auth/khd/settings และ GET /settings | URL ตั้งได้ (ต้อง https)
 * ฐานทดสอบมีโทเคน LINE/Telegram จริง → mock sendLoginNotifications
 */
jest.mock('../core/notify', () => {
    const actual = jest.requireActual('../core/notify');
    return { ...actual, sendLoginNotifications: jest.fn() };
});
require('./setup');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { sendLoginNotifications } = require('../core/notify');

const api = (p) => '/khupskpi/api' + p;
let app, db, saToken, userToken, secret;
const KEYS = ['khd_sso_enabled', 'khd_sso_url', 'khd_sso_login_url', 'khd_sso_issuer', 'khd_sso_audience', 'khd_sso_secret_enc'];

const now = () => Math.floor(Date.now() / 1000);
const sign = (claims = {}, opts = {}) => jwt.sign({
    username: 'test_khdsso_user', iat: now(), exp: now() + 120, jti: crypto.randomUUID(), iss: 'khd.moph.go.th', aud: 'khupskpi', ...claims,
}, opts.secret || secret, { algorithm: opts.alg || 'HS256' });
const khdLogin = (token, extra = {}) => request(app).post(api('/auth/khd/login')).send({ token, ...extra });
// ล้าง session ของผู้ใช้ทดสอบ (เข้าสู่ระบบสำเร็จครั้งก่อน = session ยังใช้อยู่ → 409 ตามกติกา 1 บัญชี 1 เครื่อง)
const freeSession = () => db.query("UPDATE users SET active_session_id = NULL WHERE username LIKE 'test\_khdsso\_%'");
const putSettings = (body) => request(app).put(api('/auth/khd/settings')).set('Authorization', `Bearer ${saToken}`)
    .send({ enabled: true, url: 'https://khd.moph.go.th/', login_url: 'https://apikorat.moph.go.th/khupskpi/login', ...body });

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    await db.query('DELETE FROM system_settings WHERE setting_key IN (?)', [KEYS]);
    const sa = await ensureTestUser(db, { username: 'test_khdsso_sa', role: 'super_admin', session_id: 'sess-khdsso-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-khdsso-sa' });
    const u = await ensureTestUser(db, { username: 'test_khdsso_user', role: 'user_hos' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos' });
    await ensureTestUser(db, { username: 'test_khdsso_off', role: 'user_hos', is_active: 0 });
    await ensureTestUser(db, { username: 'test_khdsso_wait', role: 'user_hos', is_approved: 0 });
});
afterAll(async () => {
    await db.query('DELETE FROM system_settings WHERE setting_key IN (?)', [KEYS]);
    await cleanupTestUsers(db);
});

describe('ตั้งค่า /auth/khd/settings', () => {
    test('ยังไม่ตั้งค่า = ปิดใช้งาน → เข้าสู่ระบบจาก KHD ได้ 403 KHD_SSO_DISABLED', async () => {
        const res = await khdLogin(jwt.sign({ username: 'x' }, 'whatever-secret'));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('KHD_SSO_DISABLED');
    });
    test('เปิดโดยไม่มีรหัสลับ = 400 | URL ไม่ใช่ https = 400 | role อื่น = 403', async () => {
        expect((await putSettings({})).status).toBe(400);
        expect((await putSettings({ generate_secret: true, url: 'http://khd.moph.go.th/' })).status).toBe(400);
        expect((await putSettings({ generate_secret: true, login_url: 'javascript:alert(1)' })).status).toBe(400);
        expect((await putSettings({ secret: 'short' })).status).toBe(400);
        const r = await request(app).get(api('/auth/khd/settings')).set('Authorization', `Bearer ${userToken}`);
        expect(r.status).toBe(403);
    });
    test('✅ สร้างรหัสลับ → คืนครั้งเดียว | GET ไม่มีรหัสลับ | GET /settings ไม่มี khd_sso_secret_enc', async () => {
        const res = await putSettings({ generate_secret: true });
        expect(res.status).toBe(200);
        secret = res.body.secret;
        expect(secret.length).toBeGreaterThanOrEqual(48);
        expect(res.body.data.effective_issuer).toBe('khd.moph.go.th');
        const g = await request(app).get(api('/auth/khd/settings')).set('Authorization', `Bearer ${saToken}`);
        expect(g.body.data.has_secret).toBe(true);
        expect(JSON.stringify(g.body)).not.toContain(secret);
        const all = await request(app).get(api('/settings')).set('Authorization', `Bearer ${saToken}`);
        expect(all.body.data.map(r => r.setting_key)).not.toContain('khd_sso_secret_enc');
        expect(JSON.stringify(all.body)).not.toContain(secret);
        // บันทึกครั้งถัดไปไม่ส่งรหัสลับ = คงค่าเดิม
        expect((await putSettings({})).status).toBe(200);
        expect((await khdLogin(sign({}))).status).toBe(200);
    });
});

describe('POST /auth/khd/login', () => {
    test('✅ token ถูกต้อง → เข้าสู่ระบบ + session ใหม่ + log + แจ้งเตือนช่องทาง khd | ลิงก์เดิมใช้ซ้ำไม่ได้', async () => {
        await db.query("UPDATE users SET active_session_id = NULL WHERE username = 'test_khdsso_user'");
        sendLoginNotifications.mockClear();
        const t = sign({});
        const res = await khdLogin(t);
        expect(res.status).toBe(200);
        expect(res.body.force_change).toBe(false);
        expect(res.body.user.username).toBe('test_khdsso_user');
        const p = jwt.decode(res.body.token);
        const [[u]] = await db.query("SELECT active_session_id FROM users WHERE username = 'test_khdsso_user'");
        expect(p.sessionId).toBe(u.active_session_id);
        expect(sendLoginNotifications.mock.calls[0][3]).toBe('khd');
        const [logs] = await db.query("SELECT details FROM login_logs WHERE username = 'test_khdsso_user' AND action = 'login_success' ORDER BY id DESC LIMIT 1");
        expect(logs[0].details).toBe('เข้าสู่ระบบจาก KHD');
        const again = await khdLogin(t, { force_login: true });
        expect(again.status).toBe(401);
        expect(again.body.code).toBe('KHD_TOKEN_INVALID');
    });
    test('token ไม่ถูกต้องทุกแบบ → 401', async () => {
        const cases = [
            sign({}, { secret: 'another-secret-another-secret-another-secret' }),   // รหัสลับผิด
            sign({ iat: now() - 400, exp: now() - 100 }),                            // หมดอายุ
            sign({ exp: now() + 3600 }),                                             // อายุเกิน 5 นาที
            sign({ jti: undefined }),                                                // ไม่มี jti
            sign({ iss: 'evil.example.com' }),                                       // issuer ผิด
            sign({ aud: 'other-system' }),                                           // audience ผิด
            sign({ username: '' }),                                                  // ไม่มีชื่อผู้ใช้
            jwt.sign({ username: 'test_khdsso_user', jti: 'x', iss: 'khd.moph.go.th', aud: 'khupskpi', exp: now() + 60 }, null, { algorithm: 'none' }), // alg none
            'not-a-jwt',
        ];
        for (const t of cases) {
            const res = await khdLogin(t);
            expect([res.status, res.body.code]).toEqual([401, 'KHD_TOKEN_INVALID']);
        }
        expect((await request(app).post(api('/auth/khd/login')).send({})).status).toBe(401);
    });
    test('ไม่พบผู้ใช้ = 401 KHD_USER_NOT_FOUND | ปิดใช้งาน/รออนุมัติ = 403 (กติกาเดียวกับ /login)', async () => {
        const nf = await khdLogin(sign({ username: 'test_khdsso_none' }));
        expect([nf.status, nf.body.code]).toEqual([401, 'KHD_USER_NOT_FOUND']);
        expect((await khdLogin(sign({ username: 'test_khdsso_off' }))).status).toBe(403);
        expect((await khdLogin(sign({ username: 'test_khdsso_wait' }))).status).toBe(403);
        await freeSession();
        expect((await khdLogin(sign({ sub: 'test_khdsso_user', username: undefined }))).status).toBe(200);   // รับ sub แทน username
    });
    test('บัญชีใช้งานอยู่ที่อื่น → 409 แล้วกดเข้าใช้ที่นี่ด้วย token เดิม (force_login) ได้', async () => {
        await db.query("UPDATE users SET active_session_id = 'sess-other', last_seen_at = NOW() WHERE username = 'test_khdsso_user'");
        const t = sign({});
        const r1 = await khdLogin(t);
        expect([r1.status, r1.body.code]).toEqual([409, 'CONCURRENT_LOGIN']);
        const r2 = await khdLogin(t, { force_login: true });
        expect(r2.status).toBe(200);
        const [[u]] = await db.query("SELECT active_session_id, kicked_at FROM users WHERE username = 'test_khdsso_user'");
        expect(u.active_session_id).not.toBe('sess-other');
        expect(u.kicked_at).not.toBeNull();
    });
    test('เปลี่ยน URL ระบบ KHD → issuer ที่ยอมรับเปลี่ยนตาม | ตั้ง issuer เองได้ | ปิดใช้งานแล้วเข้าไม่ได้', async () => {
        await putSettings({ url: 'https://khd-new.moph.go.th/portal' });
        expect((await khdLogin(sign({}))).status).toBe(401);
        await freeSession();
        expect((await khdLogin(sign({ iss: 'khd-new.moph.go.th' }))).status).toBe(200);
        await putSettings({ url: 'https://khd.moph.go.th/', issuer: 'KHD-PORTAL', audience: 'kpi-korat' });
        await freeSession();
        expect((await khdLogin(sign({ iss: 'KHD-PORTAL', aud: 'kpi-korat' }))).status).toBe(200);
        await putSettings({ enabled: false, issuer: '', audience: '' });
        expect((await khdLogin(sign({}))).status).toBe(403);
    });
});
