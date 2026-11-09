// ค่าตั้ง SSO (ThaID DGA / ProviderID MOPH) จาก system_settings + ค่าตั้งต้นจาก env — ใช้ร่วมระหว่างเส้นทางเข้าสู่ระบบกับหน้าตั้งค่า/สถานะ
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');

// ============================================================
// === ThaiD SSO — OAuth 2.0 Authorization Code + OIDC JWT ===
// ============================================================
// Flow:
//  1. GET /auth/thaid/start   → redirect ไป DGA auth URL พร้อม state (CSRF)
//  2. DGA callback กลับมาที่ /authen/thaid/callback (หรือ /khupskpi/api/auth/thaid/callback)
//  3. Backend แลก code → id_token JWT จาก DGA token endpoint
//  4. Decode JWT → ดึงเลขบัตร 13 หลัก (field: pid / cid / citizen_id / national_id / sub)
//  5. SHA-256 hash เลขบัตร → เทียบ users.cid (ซึ่งเก็บ hash ไว้)
//  6. ถ้าเจอ → issue JWT + session → redirect /sso-callback?sso_token=xxx&sso_user=xxx → /dashboard
//
// ค่าที่ hardcode (จาก DGA imauth.bora.dopa.go.th):
//   ตั้งค่าเพียง 2 อย่างใน Settings: thaid_enabled + thaid_client_secret

// === ThaiD hardcoded constants (จาก DGA) — ไม่ต้องตั้งค่าใน Settings ===
const THAID_AUTH_URL    = 'https://imauth.bora.dopa.go.th/api/v2/oauth2/auth/';

const THAID_TOKEN_URL   = 'https://imauth.bora.dopa.go.th/api/v2/oauth2/token/';

const THAID_CLIENT_ID   = 'THV0dzZtYjVVOHc4WVJPQVRaVndmNVYwVG82VUdlYXM';

const THAID_REDIRECT_URI = 'https://apikorat.moph.go.th/authen/thaid/callback';

const THAID_SCOPE       = 'pid name birthdate openid';

/** ดึง ThaiD config — DB ก่อน fallback hardcode สำหรับ client_id / auth_url / redirect_uri / scope */
async function getThaidSettings() {
    const [rows] = await db.query(
        "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('thaid_enabled','thaid_client_secret','thaid_login_url','thaid_register_url','thaid_register_enabled','thaid_client_id','thaid_auth_url','thaid_redirect_uri','thaid_scope','thaid_token_url')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = r.setting_value);
    // fallback to hardcoded defaults ถ้า DB ยังไม่ได้ตั้ง
    s.thaid_client_id    = s.thaid_client_id    || THAID_CLIENT_ID;
    s.thaid_auth_url     = s.thaid_auth_url     || THAID_AUTH_URL;
    s.thaid_token_url    = s.thaid_token_url    || THAID_TOKEN_URL;
    s.thaid_redirect_uri = s.thaid_redirect_uri || THAID_REDIRECT_URI;
    s.thaid_scope        = s.thaid_scope        || THAID_SCOPE;
    // client_secret: env var ก่อน → DB → ''
    s.thaid_client_secret = process.env.THAID_CLIENT_SECRET || s.thaid_client_secret || '';
    s.thaid_login_url    = s.thaid_login_url    || '';
    return s;
}

const MOPH_TOKEN_URL    = 'https://moph.id.th/back/oauth/token';

const MOPH_USERINFO_URL = 'https://moph.id.th/back/oauth/userinfo';

async function getProviderIdSettings() {
    const [rows] = await db.query(
        "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN " +
        "('providerid_enabled','providerid_login_url','providerid_register_url','providerid_register_enabled'," +
        "'providerid_client_id','providerid_client_secret','providerid_token_url','providerid_userinfo_url'," +
        "'providerid_auth_url','providerid_redirect_uri','providerid_scope')"
    );
    const s = {};
    rows.forEach(r => s[r.setting_key] = r.setting_value);
    return {
        enabled:          s.providerid_enabled === 'true',
        login_url:        s.providerid_login_url || '',
        register_enabled: s.providerid_register_enabled === 'true',
        register_url:     s.providerid_register_url || '',
        // เดิม client_id ไม่เคย SELECT/return เลย ทำให้ token exchange พังเสมอ (s.client_id undefined
        // → .slice() throw) — ตอนนี้อ่านจาก system_settings จริง (Settings UI บันทึกไว้แล้ว) ก่อน fallback
        client_id:     s.providerid_client_id || '',
        client_secret: s.providerid_client_secret || process.env.PROVIDERID_CLIENT_SECRET || '',
        token_url:     s.providerid_token_url    || MOPH_TOKEN_URL,
        userinfo_url:  s.providerid_userinfo_url || MOPH_USERINFO_URL,
        auth_url:      s.providerid_auth_url     || '',
        redirect_uri:  s.providerid_redirect_uri || '',
        scope:         s.providerid_scope        || '',
    };
}

module.exports = { THAID_AUTH_URL, THAID_TOKEN_URL, THAID_CLIENT_ID, THAID_REDIRECT_URI, THAID_SCOPE, getThaidSettings, MOPH_TOKEN_URL, MOPH_USERINFO_URL, getProviderIdSettings };

// ============================================================
// === เข้าสู่ระบบอัตโนมัติจาก KHD (9 พ.ย. 2569) ===
// ============================================================
// KHD เปิด <khd_sso_login_url>?khd_token=<JWT> — JWT ลงนาม HS256 ด้วยรหัสลับร่วม, claims: username|sub, iat, exp (อายุ ≤ 5 นาที), jti, iss, aud
// URL ทั้ง 2 ตั้งได้จากหน้าตั้งค่า (ผู้ใช้สั่ง: เผื่อ URL เปลี่ยนในอนาคต) — ค่าด้านล่างเป็นค่าตั้งต้นเมื่อยังไม่ได้ตั้งเท่านั้น
// รหัสลับเก็บเข้ารหัส (bkEncrypt) ใน khd_sso_secret_enc — GET /settings ไม่ส่งคีย์นี้ (routes/settings-access.js)
const KHD_SSO_DEFAULTS = {
    url: 'https://khd.moph.go.th/',
    login_url: 'https://apikorat.moph.go.th/khupskpi/login',
    audience: 'khupskpi',
};
const KHD_SSO_KEYS = ['khd_sso_enabled', 'khd_sso_url', 'khd_sso_login_url', 'khd_sso_issuer', 'khd_sso_audience', 'khd_sso_secret_enc'];
const KHD_TOKEN_MAX_AGE = 300; // วินาที — exp - iat ต้องไม่เกินนี้ (ลิงก์ใช้ได้ไม่เกิน 5 นาที)
let _khdSsoCache = null;

/** URL ที่ยอมรับ: https เท่านั้น (http ได้เฉพาะ localhost/127.0.0.1 สำหรับทดสอบ) — คืน URL ที่ normalize แล้ว หรือ null */
function normalizeSsoUrl(value) {
    let u;
    try { u = new URL(String(value || '').trim()); } catch (_) { return null; }
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    if (u.username || u.password) return null;
    return u.toString();
}

/** issuer ที่ยอมรับ = ค่าที่ตั้งเอง หรือชื่อโฮสต์ของ URL ระบบ KHD (เช่น khd.moph.go.th) */
function khdIssuerOf(s) {
    if (s.issuer) return s.issuer;
    try { return new URL(s.url).hostname; } catch (_) { return ''; }
}

async function getKhdSsoSettings({ fresh = false } = {}) {
    if (!fresh && _khdSsoCache && _khdSsoCache.at > Date.now() - 60000) return _khdSsoCache.value;
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [KHD_SSO_KEYS]);
    const s = {};
    rows.forEach(r => { s[r.setting_key] = r.setting_value; });
    // require ภายในฟังก์ชัน — services/backup.js โหลดหนัก และไม่ต้องใช้เมื่อปิดใช้งาน
    const { bkDecrypt } = require('./backup');
    let secret = '';
    if (s.khd_sso_secret_enc) { try { secret = bkDecrypt(s.khd_sso_secret_enc) || ''; } catch (_) { secret = ''; } }
    const value = {
        enabled: s.khd_sso_enabled === 'true',
        url: s.khd_sso_url || KHD_SSO_DEFAULTS.url,
        login_url: s.khd_sso_login_url || KHD_SSO_DEFAULTS.login_url,
        issuer: (s.khd_sso_issuer || '').trim(),
        audience: (s.khd_sso_audience || '').trim() || KHD_SSO_DEFAULTS.audience,
        secret,
    };
    value.effective_issuer = khdIssuerOf(value);
    _khdSsoCache = { at: Date.now(), value };
    return value;
}
const invalidateKhdSsoCache = () => { _khdSsoCache = null; };

module.exports.KHD_SSO_DEFAULTS = KHD_SSO_DEFAULTS;
module.exports.KHD_TOKEN_MAX_AGE = KHD_TOKEN_MAX_AGE;
module.exports.normalizeSsoUrl = normalizeSsoUrl;
module.exports.khdIssuerOf = khdIssuerOf;
module.exports.getKhdSsoSettings = getKhdSsoSettings;
module.exports.invalidateKhdSsoCache = invalidateKhdSsoCache;
