// สภาพแวดล้อม (timezone, .env.dev, ตัวดัก error ระดับ process) — ต้องเป็น require แรก ก่อน require('./db')
require('./core/env');

const express = require('express');
const cors = require('cors');
const db = require('./db');
const kpiFormula = require('./kpi-formula'); // สูตรคำนวณผลงานเฉพาะตัวชี้วัด (result_formula)
const kpiTarget = require('./kpi-target'); // เงื่อนไขเป้าหมาย ≥ > ≤ < = (ร้อยละ/ผ่านเกณฑ์) — สำเนาเดียวกับ frontend shared/kpi-target.ts
// target_condition ที่บันทึก: GTE/GT/LTE/LT/EQ — ว่าง/ไม่รู้จัก = null (คำนวณแบบ ≥ เหมือนเดิม)
const normTargetCondition = (c) => { const v = String(c == null ? '' : c).trim().toUpperCase(); return kpiTarget.TARGET_CONDITIONS.includes(v) ? v : null; };
const kpiRollup = require('./kpi-rollup'); // ผลงานระดับบนจากระดับล่าง (ตัวชี้วัด 3 ระดับ: หลัก → ย่อย → กิจกรรม)
const khdMapping = require('./khd-mapping'); // จับคู่หน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ของ KHD กับ Local
const { getRemotePool } = require('./db-remote');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const crypto = require('crypto');

const app = express();

// ส่วนแกนกลาง (core/) — แยกจาก server.js 25 ต.ค. 2569 (ระยะ 1): notify / errors / security / access / sql / auth
const { mailTransporter, sendMail, sendTelegramDirect, sendLineDirect, sendLineMulticast, invalidateLineCategoryCache, notifyLineAction, sendLineToUser, cleanupPendingApprovalNotifications, sendLoginNotifications, getNotifSettings, notifyAdmins } = require('./core/notify');
const { captureError } = require('./core/errors');
const { updateSystemSettings, loginIpLimiter, loginLimiter, apiLimiter, SECRET_KEY } = require('./core/security');
const { PAGE_ACCESS_ROLES, PAGE_ACCESS_PAGES, PAGE_ACCESS_DEFAULT_ENABLED, loadRolePageAccessCache, hasPageAccess, PAGE_ACCESS_RULES, ACTION_ACCESS_ROLES, ACTION_ACCESS_PAGES, ACTION_TYPES, ACTION_ACCESS_DEFAULT_ENABLED, loadRoleActionAccessCache, hasActionAccess, requireAction, ROLE_ADMIN_ALL, ROLE_ADMIN_CENTRAL, ROLE_ADMIN_LOCAL, ROLE_SCOPE_DISTRICT, ROLE_SCOPE_HOSPCODE, ROLE_SCOPE_OWN_DEPT, getDistrictId, getPermsForUser, invalidateUserPermCache } = require('./core/access');
const { activeIndicatorSql, targetCondOf, targetHasSql, targetPassSql, isValidIdentifier } = require('./core/sql');
const { _sessionCache, authenticateToken, isAdmin, isAnyAdmin, isSuperAdmin, saveLog } = require('./core/auth');
const { parseFormulaInput, normalizeCustomVars, customVarsOf, varKeysOf, formulaOk, needsCustomValues } = require('./services/formula-vars');
const { getHierarchyMaxLevels, subLevelIn, activeSubTree, rolledSubIds, ROLLED_SUB_MESSAGE, SUB_AGG_MONTH_KEYS, SUB_AGG_FISCAL_ORDER, loadSubAggregates, loadSubExportMonthMap } = require('./services/hierarchy');
const { mergeSubIntoSummary, withSummaryLock, scheduleSummaryRefresh, summaryRefreshIdle, refreshSummaryAfterSubSave, refreshKpiSummaryForIndicatorYears, baseKey, loadBaseValues, loadPrevYearData, applyFormulaToSummary } = require('./services/summary');
const { indicatorTypeSetting, indicatorAllowsHostype, resolveIndicatorHostypes } = require('./services/indicator-scope');
const { itemsTableName, checkKpiChanges, performKpiExport } = require('./services/export');
const { performSyncToKhd, getKhdEffectiveCriteriaFor, loadKhdResolver, insertIndicatorFromKhd, diffTableColumns } = require('./services/khd');
const { BACKUP_DIR, MYSQL_BIN, MYSQLDUMP_BIN, bkEncrypt, getBackupConnection, isValidIdent, cleanStderr, buildConnectArgs, verifyBackupPrivileges, runBackupJob, runRestoreJob, notifyBackupResult, runScheduledBackup, bangkokTimestamp, startBackupScheduler, getDriveSettings, resetDriveClientCache, uploadFileToDrive, deleteFileFromDrive, testDriveConnection } = require('./services/backup');

// ใช้ Port จาก ENV หรือ Default 8830 ตามโจทย์
const port = process.env.PORT || 8830; 

// Security Middleware
app.set('trust proxy', 1); // จำเป็นเมื่ออยู่หลัง Nginx Proxy เพื่อให้ Rate Limit ทำงานถูกต้องกับ IP จริง
app.use(helmet()); // เพิ่ม HTTP Headers เพื่อความปลอดภัย (XSS, Clickjacking, etc.)
// CORS — จำกัด origin เฉพาะ frontend ที่รู้จัก (กัน cross-origin API abuse)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_BASE_URL || '')
    .split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        // ยอมรับ request ที่ไม่มี origin (curl, server-to-server) และ origin ที่อยู่ใน allowlist
        if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        // อนุญาต localhost ทุก port สำหรับ development
        if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
            return callback(null, true);
        }
        callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true
}));
app.use(express.json({
    limit: '50mb',
    // เก็บ raw body ไว้สำหรับ webhook ที่ต้อง verify signature (เช่น LINE)
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// สร้าง Router เพื่อรองรับ Prefix /khupskpi/api
const apiRouter = express.Router();

// Root endpoint — used by Docker healthcheck (returns 200 so wget --spider succeeds)
apiRouter.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'KHUPS KPI API' });
});


// ==========================================
// ย้าย Route ทั้งหมดมาใส่ใน apiRouter
// ==========================================

apiRouter.get('/status', (req, res) => {
    res.json({ message: '🚀 API พร้อมใช้งานที่ /khupskpi/api' });
});

// GET /debug/my-ip — ตรวจสอบว่า backend เห็น IP อะไรจาก client (debug proxy config)
// Public — ใครเรียกก็ได้ — ใช้ตอนสงสัยว่ารับ IP ไม่ถูกต้อง (เช่น users office NAT ถูก block)
apiRouter.get('/debug/my-ip', (req, res) => {
    res.json({
        success: true,
        req_ip: req.ip,                                    // Express เห็น IP อะไร (หลัง trust proxy)
        x_forwarded_for: req.headers['x-forwarded-for'] || null,
        x_real_ip: req.headers['x-real-ip'] || null,
        remote_address: req.socket?.remoteAddress || null, // raw TCP source
        trust_proxy: app.get('trust proxy'),
        note: 'ถ้า req_ip เป็น docker bridge IP (172.x.x.x) สำหรับ user ทุกคน = nginx X-Forwarded-For ไม่ทำงาน — แก้ nginx config ให้ส่ง XFF header'
    });
});

// รหัส ThaiD OTP แบบใช้ครั้งเดียว (code → { username, userId, expires }) — ยังไม่มีจุดใดสร้างรหัส จึงว่างเสมอ = ปฏิเสธทุกรหัสด้วย 401
// (เดิมไม่ได้ประกาศตัวแปรนี้เลย → ส่ง thaid_otp มา = ReferenceError → 500 — พบจาก ESLint no-undef 25 ต.ค. 2569)
const _thaidOtpMap = new Map();

apiRouter.post('/login', loginIpLimiter, loginLimiter, async (req, res) => {
    const { username, password, force_login, thaid_otp } = req.body;
    // ใช้ req.headers['x-forwarded-for'] กรณีอยู่หลัง Nginx/Docker Proxy
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // === ThaiD OTP login — ข้าม bcrypt ตรวจสอบด้วย OTP map แทน ===
    if (thaid_otp && username) {
        const otpEntry = _thaidOtpMap.get(thaid_otp);
        if (!otpEntry || otpEntry.username !== username || otpEntry.expires < Date.now()) {
            _thaidOtpMap.delete(thaid_otp);
            return res.status(401).json({ success: false, message: 'รหัส ThaiD หมดอายุ กรุณาสแกน QR ใหม่' });
        }
        _thaidOtpMap.delete(thaid_otp); // one-time use
        // ดึง user จาก DB
        const [otpUsers] = await db.query(`
            SELECT u.*, d.dept_name, h.hosname, dist.distname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            WHERE u.id = ?
        `, [otpEntry.userId]);
        if (!otpUsers.length) return res.status(401).json({ success: false, message: 'ไม่พบผู้ใช้' });
        const otpUser = otpUsers[0];
        if (!otpUser.is_active)   return res.status(403).json({ success: false, message: 'บัญชีถูกปิดใช้งาน' });
        if (!otpUser.is_approved) return res.status(403).json({ success: false, message: 'บัญชียังรอการอนุมัติ' });
        const sessionId = crypto.randomBytes(24).toString('hex');
        await db.query('UPDATE users SET active_session_id=?, session_started_at=NOW(), last_seen_at=NOW(), last_seen_ip=? WHERE id=?',
            [sessionId, String(ip).split(',')[0].trim().slice(0, 64), otpUser.id]);
        _sessionCache.delete(otpUser.id);
        const token = jwt.sign(
            { userId: otpUser.id, username: otpUser.username, deptId: otpUser.dept_id, role: otpUser.role, hospcode: otpUser.hospcode, sessionId },
            SECRET_KEY, { expiresIn: '8h' }
        );
        await saveLog(otpUser.username, 'login_success', 'เข้าสู่ระบบผ่าน ThaiD OTP', ip);
        return res.json({ success: true, token, user: {
            id: otpUser.id, username: otpUser.username, role: otpUser.role,
            dept_id: otpUser.dept_id, hospcode: otpUser.hospcode,
            firstname: otpUser.firstname, lastname: otpUser.lastname,
            dept_name: otpUser.dept_name, hosname: otpUser.hosname
        }});
    }

    try {
        const [users] = await db.query(`
            SELECT u.*, d.dept_name, h.hosname, dist.distname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            WHERE u.username = ?
        `, [username]);

        if (users.length > 0) {
            const user = users[0];
            // ใช้ bcryptjs.compare
            // ตรวจสอบรหัสผ่านปกติ หรือ รหัสชั่วคราว
            let isMatch = await bcrypt.compare(password, user.password_hash);
            let usedTempPassword = false;

            if (!isMatch && user.temp_password && user.temp_password_expiry) {
                const tempMatch = await bcrypt.compare(password, user.temp_password);
                if (tempMatch && new Date(user.temp_password_expiry) > new Date()) {
                    isMatch = true;
                    usedTempPassword = true;
                }
            }

            if (isMatch) {
                // ตรวจสอบสถานะการอนุมัติ
                if (user.is_approved === 0) {
                    await saveLog(username, 'login_failed', 'บัญชีรอการอนุมัติ', ip);
                    return res.status(403).json({ success: false, message: 'บัญชีของคุณยังรอการอนุมัติจากผู้ดูแลระบบ กรุณารอการติดต่อกลับ' });
                }
                if (user.is_approved === -1) {
                    await saveLog(username, 'login_failed', 'บัญชีถูกปฏิเสธ', ip);
                    return res.status(403).json({ success: false, message: 'คำขอลงทะเบียนถูกปฏิเสธ กรุณาติดต่อผู้ดูแลระบบ' });
                }
                if (user.is_active === 0) {
                    await saveLog(username, 'login_failed', 'บัญชีถูกปิดใช้งาน', ip);
                    return res.status(403).json({ success: false, message: 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });
                }

                // === ตรวจสอบ login ซ้อน (Single Session Enforcement) ===
                // ถ้ามี active_session_id อยู่ + last_seen ภายใน 5 นาทีล่าสุด → ถือว่ายังใช้งานอยู่ ห้าม login ซ้อน
                // ยกเว้น force_login = true (user ยืนยันว่าจะ kick session เก่า)
                if (user.active_session_id && !force_login) {
                    const lastSeen = user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
                    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
                    if (lastSeen > fiveMinAgo) {
                        await saveLog(username, 'login_blocked', 'login ซ้อน — บัญชีกำลังใช้งานที่อื่น', ip);
                        return res.status(409).json({
                            success: false,
                            code: 'CONCURRENT_LOGIN',
                            message: 'บัญชีนี้กำลังใช้งานอยู่ที่อุปกรณ์อื่น',
                            last_seen_ip: user.last_seen_ip || '-',
                            last_seen_at: user.last_seen_at,
                            can_force_login: true
                        });
                    }
                }
                // ถ้าเป็น force_login → log ว่า kick session เดิม + บันทึก kicked_by_* ให้เครื่องเก่าเห็น
                if (user.active_session_id && force_login) {
                    await saveLog(username, 'login_force', `force login — kick session เดิม (last IP: ${user.last_seen_ip || '-'})`, ip);
                    const ua = (req.headers['user-agent'] || '').toString().slice(0, 255);
                    try {
                        await db.query(
                            'UPDATE users SET kicked_by_ip = ?, kicked_by_ua = ?, kicked_at = NOW() WHERE id = ?',
                            [ip || '-', ua, user.id]
                        );
                    } catch (e) { /* column อาจยังไม่ migrate — ปล่อย */ }
                    // _sessionCache.delete จะถูก override ตอน update active_session_id ใหม่ด้านล่างอยู่แล้ว
                }

                const serviceUnitDisplay = user.hosname ? `${user.hosname} ${user.distname ? 'อ.' + user.distname : ''}` : user.service_unit;

                // ถ้าใช้รหัสชั่วคราว → ยังไม่ล้าง (จะล้างตอน change-password สำเร็จ)
                // เพื่อให้ change-password ยังตรวจ temp_password ได้

                const forceChange = user.must_change_password === 1 || usedTempPassword;

                await saveLog(username, 'login_success', usedTempPassword ? 'เข้าสู่ระบบด้วยรหัสชั่วคราว' : 'เข้าสู่ระบบสำเร็จ', ip);

                sendLoginNotifications(user, ip, req.headers['user-agent'] || '', 'password');

                // สร้าง sessionId ใหม่ + บันทึกลง DB (overwrite session เดิมถ้า stale > 5 นาที)
                const sessionId = crypto.randomBytes(24).toString('hex');
                try {
                    const [updateResult] = await db.query(
                        'UPDATE users SET active_session_id = ?, session_started_at = NOW(), last_seen_at = NOW(), last_seen_ip = ? WHERE id = ?',
                        [sessionId, ip.toString().split(',')[0].trim().slice(0, 64), user.id]
                    );
                    if (!updateResult || updateResult.affectedRows === 0) {
                        console.error(`⚠️ [Single Session] UPDATE active_session_id ไม่ได้แก้ไขแถวใดสำหรับ user_id=${user.id}`);
                    }
                    _sessionCache.delete(user.id);  // เคลียร์ cache เพื่อให้ middleware อ่านค่าใหม่
                } catch (e) {
                    console.error(`❌ [Single Session] UPDATE active_session_id ล้มเหลว user_id=${user.id} —`, e.message);
                    console.error('   👉 ตรวจสอบว่าได้ ALTER TABLE users ADD COLUMN active_session_id แล้วหรือยัง');
                }

                const token = jwt.sign(
                    { userId: user.id, username: user.username, deptId: user.dept_id, role: user.role, hospcode: user.hospcode, sessionId },
                    SECRET_KEY,
                    { expiresIn: '8h' }
                );
                res.json({
                    success: true,
                    token,
                    force_change: forceChange,
                    user: {
                        id: user.id,
                        username: user.username,
                        role: user.role,
                        firstname: user.firstname,
                        lastname: user.lastname,
                        service_unit: serviceUnitDisplay,
                        dept_name: user.dept_name,
                        hospcode: user.hospcode,
                        dept_id: user.dept_id,
                        email: user.email || '',
                        phone: user.phone || ''
                    }
                });
            } else {
                await saveLog(username, 'login_failed', 'รหัสผ่านไม่ถูกต้อง', ip);
                res.status(401).json({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
            }
        } else {
            await saveLog(username, 'login_failed', 'ไม่พบชื่อผู้ใช้งาน', ip);
            res.status(401).json({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
        }
    } catch (error) {
        console.error(error);
        await saveLog(username, 'system_error', error.message, ip);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่ Server' });
    }
});

// === Logout — เคลียร์ active_session_id ของ user ปัจจุบัน ===
apiRouter.post('/logout', authenticateToken, async (req, res) => {
    const uid = req.user.userId;
    try {
        await db.query('UPDATE users SET active_session_id = NULL, session_started_at = NULL WHERE id = ?', [uid]);
        _sessionCache.delete(uid);
        await saveLog(req.user.username, 'logout', 'ออกจากระบบ', req.headers['x-forwarded-for'] || req.ip);
        res.json({ success: true, message: 'ออกจากระบบเรียบร้อย' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === Refresh Token — ออก JWT ใหม่โดยไม่ต้อง login ซ้ำ (ถ้า session ยังถูกต้อง) ===
// Frontend เรียกเมื่อ token เหลือ < 30 นาที เพื่อ extend session โดยอัตโนมัติ
apiRouter.post('/auth/refresh-token', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const newToken = jwt.sign(
            { userId: user.userId, username: user.username, deptId: user.deptId, role: user.role, hospcode: user.hospcode, sessionId: user.sessionId },
            SECRET_KEY,
            { expiresIn: '8h' }
        );
        res.json({ success: true, token: newToken });
    } catch (e) {
        res.status(500).json({ success: false, message: 'ไม่สามารถต่ออายุ Token ได้' });
    }
});

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

// CSRF state map: state → { origin, created_at, flow? } — TTL 10 นาที
const _thaidStateMap = new Map();
// Register map: token → { cid_hash, firstname_th, lastname_th, expires } — TTL 10 นาที (one-time use)
const _thaidRegMap  = new Map();
setInterval(() => {
    const cutoff10m = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of _thaidStateMap.entries()) {
        if (v.created_at < cutoff10m) _thaidStateMap.delete(k);
    }
    const now = Date.now();
    for (const [k, v] of _thaidRegMap.entries()) {
        if (v.expires < now) _thaidRegMap.delete(k);
    }
}, 60 * 1000);

/**
 * ลบฟิลด์ที่อาจมีเลขบัตรประชาชน 13 หลัก (plain CID) ออกจาก JWT payload ก่อนบันทึก DB
 * เพื่อให้ sso_logs/sso_profiles เก็บเฉพาะข้อมูลที่ไม่ใช่ PII ที่ละเอียดอ่อน
 */
function sanitizeSsoPayload(payload) {
    if (!payload) return null;
    const safe = { ...payload };
    // ฟิลด์ที่อาจมีเลขบัตร 13 หลัก
    for (const f of ['cid','pid','citizen_id','national_id','personal_id','id_card','hash_cid','sub_id']) delete safe[f];
    // sub อาจเป็น user identifier ธรรมดา (ไม่ใช่ CID) ให้เก็บแค่ 4 ตัวสุดท้ายหาก format เป็น 13 หลัก
    if (safe.sub && /^\d{13}$/.test(String(safe.sub).trim())) safe.sub = '***' + String(safe.sub).slice(-4);
    return safe;
}

/**
 * บันทึก SSO log ทุก attempt (login/register/error)
 * @param {string} provider  'thaid' | 'providerid'
 * @param {string} flow      'login' | 'register'
 * @param {object} data      { outcome, cid_hash, user_id, username, raw_payload, extracted_fields, ip, error_msg }
 */
async function saveSsoLog(provider, flow, data) {
    try {
        await db.query(
            `INSERT INTO sso_logs (provider, flow, cid_hash, user_id, username, outcome, raw_payload, extracted_fields, ip, error_msg)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                provider, flow,
                data.cid_hash || null,
                data.user_id  || null,
                data.username || null,
                data.outcome,
                data.raw_payload  ? JSON.stringify(sanitizeSsoPayload(data.raw_payload))  : null,
                data.extracted_fields ? JSON.stringify(data.extracted_fields) : null,
                data.ip       || null,
                data.error_msg || null
            ]
        );
    } catch (e) {
        console.error('[saveSsoLog] error:', e.message);
    }
}

/**
 * UPSERT sso_profiles — เรียกเมื่อ SSO login/register สำเร็จ
 * @param {string} provider  'thaid' | 'providerid'
 * @param {number} userId    users.id
 * @param {object} profile   { cid_hash, firstname_th, lastname_th, birthdate, name_th, pid_partial, extra_fields, raw_payload }
 */
async function upsertSsoProfile(provider, userId, profile) {
    try {
        await db.query(
            `INSERT INTO sso_profiles
                (user_id, provider, cid_hash, firstname_th, lastname_th, birthdate, name_th, pid_partial, extra_fields, raw_payload, linked_at, last_seen_at, login_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)
             ON DUPLICATE KEY UPDATE
                cid_hash       = VALUES(cid_hash),
                firstname_th   = VALUES(firstname_th),
                lastname_th    = VALUES(lastname_th),
                birthdate      = VALUES(birthdate),
                name_th        = VALUES(name_th),
                pid_partial    = VALUES(pid_partial),
                extra_fields   = VALUES(extra_fields),
                raw_payload    = VALUES(raw_payload),
                last_seen_at   = NOW(),
                login_count    = login_count + 1`,
            [
                userId, provider,
                profile.cid_hash    || null,
                profile.firstname_th || null,
                profile.lastname_th  || null,
                profile.birthdate    || null,
                profile.name_th      || null,
                profile.pid_partial  || null,
                profile.extra_fields ? JSON.stringify(profile.extra_fields) : null,
                profile.raw_payload  ? JSON.stringify(sanitizeSsoPayload(profile.raw_payload))  : null
            ]
        );
    } catch (e) {
        console.error('[upsertSsoProfile] error:', e.message);
    }
}

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

/** ดึง national ID (13 หลัก) จาก JWT payload — ลองทุก field ที่ DGA อาจใช้ */
function extractCidFromPayload(payload) {
    const candidates = [
        payload.pid, payload.cid, payload.citizen_id,
        payload.national_id, payload.citizenId, payload.sub
    ];
    for (const v of candidates) {
        if (!v) continue;
        const digits = String(v).replace(/\D/g, '');
        if (digits.length === 13) return digits;
    }
    return null;
}

/**
 * ลองดึงรหัสหน่วยบริการ (hospcode) จาก JWT payload ของ ProviderID (MOPH)
 * ยืนยันแล้วจาก token จริง (ทดสอบผ่านเครื่องมือ "ทดสอบถอดรหัส JWT" ใน Settings) ว่า MOPH ใช้ field
 * ชื่อ "hcode" — เก็บชื่อ candidate อื่นไว้เป็น fallback เผื่อ provider เวอร์ชันอื่น/token รูปแบบอื่น
 */
function extractHospcodeFromPayload(payload) {
    if (!payload) return null;
    const candidates = [
        payload.hcode, payload.hospcode, payload.hospital_code,
        payload.agency_code, payload.agencycode, payload.org_code, payload.orgcode,
        payload.workplace, payload.work_place, payload.affiliation,
        payload.unit_code, payload.unitcode, payload.moph_hospcode
    ];
    for (const v of candidates) {
        if (!v) continue;
        const code = String(v).trim();
        if (code) return code;
    }
    return null;
}

/**
 * ลองดึงรหัสอำเภอ (distcode) จาก JWT payload — ใช้เป็น fallback เมื่อไม่มี hospcode
 * หรือหา hospcode ในตาราง chospital ไม่เจอ (ไม่มีเอกสารยืนยันชื่อ field จริง)
 */
function extractDistCodeFromPayload(payload) {
    if (!payload) return null;
    const candidates = [
        payload.distcode, payload.district_code, payload.amphoe_code,
        payload.amphur_code, payload.district, payload.amphoe
    ];
    for (const v of candidates) {
        if (!v) continue;
        const code = String(v).trim();
        if (code) return code;
    }
    return null;
}

/**
 * แปลง hospcode/distcode ที่ดึงจาก JWT (best-effort, ไม่รับประกันชื่อ field ถูกต้อง)
 * เป็น { hospcode, distid } ที่ตรงกับข้อมูลจริงในระบบ — ตรวจสอบกับตาราง chospital/co_district
 * ก่อนส่งกลับให้ frontend เสมอ กัน pre-fill ค่าที่ไม่มีอยู่จริง
 */
async function resolveRegLocationFromPayload(payload) {
    const result = { hospcode: null, distid: null };
    try {
        const hospcodeGuess = extractHospcodeFromPayload(payload);
        if (hospcodeGuess) {
            const [rows] = await db.query('SELECT hoscode, distid FROM chospital WHERE hoscode = ? LIMIT 1', [hospcodeGuess]);
            if (rows.length) {
                result.hospcode = rows[0].hoscode;
                result.distid = rows[0].distid || null;
            }
        }
        if (!result.distid) {
            const distcodeGuess = extractDistCodeFromPayload(payload);
            if (distcodeGuess) {
                const [drows] = await db.query('SELECT distid FROM co_district WHERE distid = ? LIMIT 1', [distcodeGuess]);
                if (drows.length) result.distid = drows[0].distid;
            }
        }
    } catch (e) {
        console.warn('[resolveRegLocationFromPayload] lookup failed (non-fatal):', e.message);
    }
    return result;
}

/** URL ฝั่ง frontend (ใช้ redirect หลัง callback) */
function getFrontendBase(req) {
    // ใช้ Origin ที่เก็บไว้ใน state map (เก็บตอน /start) หรือ fallback .env
    const envBase = process.env.FRONTEND_BASE_URL || '';
    if (envBase) return envBase.replace(/\/$/, '');
    // derive จาก request host
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    return `${proto}://${host}/khupskpi`;
}

// GET /auth/thaid/test-config — ตรวจสอบค่า config ที่บันทึกไว้ (super_admin) ไม่แสดง secret
apiRouter.get('/auth/thaid/test-config', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const s = await getThaidSettings();
        res.json({
            success: true,
            config: {
                enabled: s.thaid_enabled,
                auth_url:     THAID_AUTH_URL    + ' (hardcoded)',
                token_url:    THAID_TOKEN_URL   + ' (hardcoded)',
                client_id:    THAID_CLIENT_ID   + ' (hardcoded)',
                redirect_uri: THAID_REDIRECT_URI + ' (hardcoded)',
                scope:        THAID_SCOPE       + ' (hardcoded)',
                client_secret: s.thaid_client_secret ? '(กรอกแล้ว *** ซ่อน)' : '⚠️ ยังไม่ได้กรอก — ThaiD ใช้งานไม่ได้',
            },
            ready: !!(s.thaid_enabled === 'true' && s.thaid_client_secret)
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /auth/thaid/debug-token — ทดสอบ decode JWT + ดู hash ว่าตรงกับ users.cid ไหม (super_admin)
// ส่ง body: { token: "<jwt string>" }
apiRouter.post('/auth/thaid/debug-token', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { token: rawToken } = req.body;
        if (!rawToken) return res.status(400).json({ success: false, message: 'ส่ง token มาด้วย' });
        const s = await getThaidSettings();

        let payload, verifyOk = false;
        try {
            payload = jwt.verify(rawToken, s.thaid_client_secret, { algorithms: ['HS256'] });
            verifyOk = true;
        } catch (_) {
            payload = jwt.decode(rawToken);
        }
        if (!payload) return res.json({ success: false, message: 'decode JWT ไม่ได้' });

        const cidStr = extractCidFromPayload(payload);
        const hashCidDga = payload.hash_cid || null;
        const hashCidOurs = cidStr ? crypto.createHash('sha256').update(cidStr).digest('hex') : null;

        // ค้นหา user ทั้ง 2 hash
        let userByOurs = null, userByDga = null;
        if (hashCidOurs) {
            const [r] = await db.query('SELECT id, username, firstname, lastname, cid FROM users WHERE cid = ?', [hashCidOurs]);
            if (r.length) userByOurs = { id: r[0].id, username: r[0].username, name: `${r[0].firstname} ${r[0].lastname}` };
        }
        if (hashCidDga && hashCidDga !== hashCidOurs) {
            const [r] = await db.query('SELECT id, username, firstname, lastname, cid FROM users WHERE cid = ?', [hashCidDga]);
            if (r.length) userByDga = { id: r[0].id, username: r[0].username, name: `${r[0].firstname} ${r[0].lastname}` };
        }

        res.json({
            success: true,
            jwt_verified: verifyOk,
            payload_fields: Object.keys(payload),
            cid_plain: cidStr,
            hash_by_sha256_ours: hashCidOurs,
            hash_cid_from_dga: hashCidDga,
            hashes_match: hashCidOurs === hashCidDga,
            user_found_by_our_hash: userByOurs,
            user_found_by_dga_hash: userByDga,
            thaid_name: payload.name_th || `${payload.firstname_th||''} ${payload.lastname_th||''}`.trim(),
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /auth/sso/decode-token — super_admin วาง token จริงมาทดสอบ ดูว่า extraction logic
// ปัจจุบันดึงข้อมูลอะไรได้บ้าง เทียบกับ raw payload ทั้งหมด (ไม่ verify signature — เพื่อ inspect เท่านั้น
// ไม่ insert/log อะไรลง DB, เลขบัตรประชาชน mask บางส่วนก่อนส่งกลับ)
apiRouter.post('/auth/sso/decode-token', authenticateToken, isSuperAdmin, async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'ไม่มี token' });
    let payload;
    try { payload = jwt.decode(token); } catch (e) { payload = null; }
    if (!payload) return res.status(400).json({ success: false, message: 'ไม่สามารถถอดรหัส JWT ได้ — รูปแบบ token ไม่ถูกต้อง' });

    const cidStr = extractCidFromPayload(payload);
    const firstname_th = payload.firstname_th || payload.th_given_name || payload.given_name || '';
    const lastname_th  = payload.lastname_th  || payload.th_family_name || payload.family_name || '';
    const regLocation = await resolveRegLocationFromPayload(payload);

    // resolve ชื่อจริงของ hospcode/distid ที่เจอ (ถ้ามี) ให้ super_admin เห็นชัดว่า match ถูกต้อง
    let hospname = '', distname = '';
    if (regLocation.hospcode) {
        const [h] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ? LIMIT 1', [regLocation.hospcode]);
        if (h.length) hospname = h[0].hosname;
    }
    if (regLocation.distid) {
        const [d] = await db.query('SELECT distname FROM co_district WHERE distid = ? LIMIT 1', [regLocation.distid]);
        if (d.length) distname = d[0].distname;
    }

    res.json({
        success: true,
        extracted: {
            firstname_th, lastname_th,
            cid_masked: cidStr ? `${cidStr.slice(0, 1)}-****-*****-**-${cidStr.slice(-1)}` : null,
            hospcode: regLocation.hospcode || null, hospname,
            distid: regLocation.distid || null, distname,
        },
        raw_payload: payload,           // ดูทั้งหมดเพื่อหา field name จริงถ้า extraction พลาด
        raw_keys: Object.keys(payload),
    });
});


// GET /auth/thaid/start — redirect ไป DGA (public, ไม่ต้อง auth)
// === Direct JWT Login — รับ token จาก redirect (/login?token=<JWT>) — รองรับทั้ง ThaID (DGA) และ ProviderID (MOPH) ===
apiRouter.post('/auth/thaid/verify-token', async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'ไม่มี token' });

    // 0. ตรวจ provider — ใช้ JWT iss field เป็นหลัก, ถ้า iss ไม่เข้าเงื่อนไขที่รู้จัก ใช้ hint_provider
    //    จากปุ่มที่ผู้ใช้กด (sso_intent) เป็น fallback — hint มาจาก sessionStorage ที่ frontend ตั้งไว้เอง
    //    ตอนกดปุ่ม ไม่ได้มาจาก token จึงไม่ใช่ช่องทางให้ปลอม token ข้ามการตรวจสอบ (การ verify signature/decode
    //    ของทั้ง 2 ฝั่งท้ายที่สุด fallback ไป decode เหมือนกันอยู่แล้วเมื่อ signature ไม่ผ่าน — ดูจุด verify ด้านล่าง)
    const hintProvider = String(req.body.hint_provider || '').toLowerCase();
    let rawDecoded;
    try { rawDecoded = jwt.decode(token); } catch (_) { rawDecoded = null; }
    if (!rawDecoded) return res.status(400).json({ success: false, message: 'JWT ไม่ถูกต้อง ไม่สามารถอ่านได้' });
    const rawIss = String(rawDecoded?.iss || '').toLowerCase();
    const issIsMoph = rawIss.includes('moph') || rawIss.includes('health.moph') || rawIss.includes('moph.id');
    const detectedProvider = issIsMoph ? 'providerid' : (hintProvider === 'providerid' ? 'providerid' : 'thaid');
    console.log(`[verify-token] iss="${rawDecoded?.iss}" hint="${hintProvider}" fields=${Object.keys(rawDecoded||{}).join(',')} -> provider=${detectedProvider}`);

    // MOPH ISS allowlist — log-only (ยังไม่รู้ iss จริงจาก production จึงไม่ reject เพื่อกัน false-block)
    const MOPH_ISS_DOMAINS = ['moph.id.th', 'moph.go.th', 'health.moph.go.th', 'moph.id'];
    if (detectedProvider === 'providerid') {
        let issHost = '';
        try { issHost = new URL(rawDecoded.iss.startsWith('http') ? rawDecoded.iss : `https://${rawDecoded.iss}`).hostname.toLowerCase(); } catch (_) { issHost = rawDecoded.iss || ''; }
        const issAllowed = MOPH_ISS_DOMAINS.some(d => issHost === d || issHost.endsWith('.' + d));
        if (!issAllowed) {
            console.warn(`[verify-token] ProviderID iss ไม่อยู่ใน allowlist (ปล่อยผ่าน, log-only): iss="${rawDecoded.iss}"`);
        }
    }

    let s;
    if (detectedProvider === 'providerid') {
        try {
            const ps = await getProviderIdSettings();
            if (!ps.enabled) return res.status(403).json({ success: false, message: 'ProviderID ยังไม่ได้เปิดใช้งาน' });
        } catch (e) {
            return res.status(500).json({ success: false, message: 'ไม่สามารถโหลด ProviderID settings ได้' });
        }
    } else {
        try { s = await getThaidSettings(); } catch (e) {
            return res.status(500).json({ success: false, message: 'ไม่สามารถโหลด ThaiD settings ได้' });
        }
        if (s.thaid_enabled !== 'true')
            return res.status(403).json({ success: false, message: 'ThaiD ยังไม่ได้เปิดใช้งาน' });
    }

    // 1. Verify JWT — ลอง signature check ก่อน ถ้าไม่ผ่าน fallback decode (DGA อาจเซ็นด้วย RS256 ไม่ใช่ HS256+client_secret
    //    ตามที่ handleThaidCallback เจอมาแล้ว — ดู server.js ฟังก์ชัน handleThaidCallback comment "อาจเป็น RS256")
    let payload;
    if (detectedProvider === 'thaid') {
        if (!s.thaid_client_secret)
            return res.status(500).json({ success: false, message: 'ThaiD client secret ยังไม่ได้ตั้งค่า' });
        try {
            payload = jwt.verify(token, s.thaid_client_secret, { algorithms: ['HS256'] });
        } catch (e) {
            console.warn('[verify-token] ThaiD verify failed (อาจเป็น RS256), fallback decode:', e.message);
            payload = rawDecoded;
            if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp)
                return res.status(401).json({ success: false, message: 'ThaiD token หมดอายุ กรุณาสแกน QR ใหม่' });
        }
    } else {
        // ProviderID (MOPH): ไม่มี shared secret — ตรวจ iss allowlist (ข้างบน) + exp
        payload = rawDecoded;
        if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp)
            return res.status(401).json({ success: false, message: 'ProviderID token หมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    }

    // 2. Extract cid (13 หลัก) — ใช้ extractCidFromPayload เดิม
    const cidStr = extractCidFromPayload(payload);
    if (!cidStr) return res.status(400).json({ success: false, message: 'ไม่พบเลขบัตรประชาชน 13 หลักใน token' });

    const cidHashOurs = crypto.createHash('sha256').update(cidStr).digest('hex');
    const cidHashFromDga = payload.hash_cid || null;

    const firstname_th = payload.firstname_th || payload.th_given_name || payload.given_name || '';
    const lastname_th  = payload.lastname_th  || payload.th_family_name || payload.family_name || '';
    const _extracted = { firstname_th, lastname_th, name_th: payload.name_th || payload.name || '' };
    console.log(`[verify-token] name fields: firstname_th="${firstname_th}" lastname_th="${lastname_th}" keys=${Object.keys(payload||{}).join(',')}`)

    // 3. Lookup user — JOIN departments + chospital เพื่อได้ข้อมูล profile ครบ
    const userQuery = `
        SELECT u.*, d.dept_name, h.hosname,
               dist.distname,
               CONCAT(COALESCE(h.hosname,''), IF(dist.distname IS NOT NULL AND dist.distname != '', CONCAT(' อ.', dist.distname), '')) AS service_unit
        FROM users u
        LEFT JOIN departments d ON d.id = u.dept_id
        LEFT JOIN chospital h ON h.hoscode = u.hospcode
        LEFT JOIN co_district dist ON dist.distid = h.distid
        WHERE u.cid = ? AND u.is_active = 1`;
    let [users] = await db.query(userQuery, [cidHashOurs]);
    if (!users.length && cidHashFromDga) {
        [users] = await db.query(userQuery, [cidHashFromDga]);
    }

    if (!users.length) {
        // ไม่พบ → สร้าง reg_token เพื่อ pre-fill register form (TTL 10 นาที)
        const regToken = crypto.randomBytes(16).toString('hex');
        const emailFromJwt = String(rawDecoded?.email || '').trim();
        const phoneFromJwt = String(rawDecoded?.phone_number || rawDecoded?.phone || '').trim();
        const regLocation = await resolveRegLocationFromPayload(payload);
        _thaidRegMap.set(regToken, {
            cid_hash: cidHashOurs, cid: cidStr, firstname_th, lastname_th,
            email: emailFromJwt, phone: phoneFromJwt,
            hospcode: regLocation.hospcode, distid: regLocation.distid,
            provider: detectedProvider,
            expires: Date.now() + 10 * 60 * 1000
        });
        saveSsoLog(detectedProvider, 'login', { outcome: 'no_user', cid_hash: cidHashOurs, ip, extracted_fields: _extracted });
        return res.json({
            success: false, not_found: true,
            firstname_th, lastname_th,
            reg_token: regToken,
            message: 'ไม่พบบัญชีผู้ใช้งานที่ลงทะเบียนด้วยเลขบัตรนี้'
        });
    }

    const user = users[0];

    // 4. ตรวจสอบ approved
    if (!user.is_approved) {
        saveSsoLog(detectedProvider, 'login', { outcome: 'not_approved', user_id: user.id, username: user.username, ip });
        return res.status(403).json({ success: false, message: 'บัญชีนี้ยังไม่ได้รับการอนุมัติจากผู้ดูแลระบบ' });
    }

    // 5. Concurrent session check (≤5 นาที ที่ IP อื่น)
    if (user.active_session_id && user.last_seen_at) {
        const lastSeen = new Date(user.last_seen_at).getTime();
        if (Date.now() - lastSeen < 5 * 60 * 1000 && user.last_seen_ip !== ip) {
            saveSsoLog(detectedProvider, 'login', { outcome: 'concurrent', user_id: user.id, username: user.username, ip });
            return res.status(409).json({
                success: false, code: 'CONCURRENT_LOGIN',
                message: `มีการเข้าสู่ระบบจาก IP ${user.last_seen_ip} อยู่แล้ว กรุณาออกจากระบบก่อน`
            });
        }
    }

    // 6. Issue KHUPS JWT
    const sessionId = crypto.randomBytes(24).toString('hex');
    await db.query('UPDATE users SET active_session_id=?, session_started_at=NOW() WHERE id=?', [sessionId, user.id]);
    _sessionCache.delete(user.id);

    const appToken = jwt.sign(
        { userId: user.id, username: user.username, role: user.role,
          deptId: user.dept_id, hospcode: user.hospcode, sessionId },
        SECRET_KEY, { expiresIn: '8h' }
    );

    // 7. Audit logs
    const outcomeKey = detectedProvider === 'providerid' ? 'success_providerid' : 'success_thaid';
    saveSsoLog(detectedProvider, 'login', { outcome: outcomeKey, cid_hash: cidHashOurs,
                                            user_id: user.id, username: user.username,
                                            ip, extracted_fields: _extracted });
    try {
        await db.query(
            `INSERT INTO login_logs (user_id, username, ip, status, user_agent) VALUES (?, ?, ?, ?, ?)`,
            [user.id, user.username, ip, `success_sso_${detectedProvider}`, req.headers['user-agent'] || '']
        );
    } catch (e) {}

    console.log(`[verify-token/${detectedProvider}] ✓ login user=${user.username} ip=${ip}`);
    sendLoginNotifications(user, ip, req.headers['user-agent'] || '', detectedProvider);
    const serviceUnitDisplay = user.service_unit?.trim() || user.hosname || '';
    res.json({
        success: true,
        provider: detectedProvider,
        token: appToken,
        user: { id: user.id, username: user.username, role: user.role,
                dept_id: user.dept_id, hospcode: user.hospcode,
                firstname: user.firstname, lastname: user.lastname,
                dept_name: user.dept_name || '',
                service_unit: serviceUnitDisplay,
                email: user.email || '',
                phone: user.phone || '' }
    });
});

apiRouter.get('/auth/thaid/start', async (req, res) => {
    try {
        const s = await getThaidSettings();
        const frontendBase = getFrontendBase(req);

        if (s.thaid_enabled !== 'true') {
            return res.redirect(`${frontendBase}/login?sso_error=${encodeURIComponent('ThaiD ยังไม่ได้เปิดใช้งาน')}`);
        }

        // สร้าง state แบบ dynamic — เก็บ origin ไว้ใน map เพื่อ redirect กลับหลัง callback
        const state = 'khupskpi-' + crypto.randomBytes(8).toString('hex');
        _thaidStateMap.set(state, { origin: frontendBase, created_at: Date.now() });

        const thaidUrl = `${THAID_AUTH_URL}?response_type=code`
            + `&client_id=${THAID_CLIENT_ID}`
            + `&redirect_uri=${encodeURIComponent(THAID_REDIRECT_URI)}`
            + `&scope=${encodeURIComponent(THAID_SCOPE)}`
            + `&state=${state}`;

        console.log(`[ThaiD/start] redirect → DGA | origin=${frontendBase} | redirect_uri=${THAID_REDIRECT_URI}`);
        res.redirect(thaidUrl);
    } catch (e) {
        console.error('[ThaiD/start]', e.message);
        const base = getFrontendBase(req);
        res.redirect(`${base}/login?sso_error=` + encodeURIComponent('เกิดข้อผิดพลาด กรุณาลองใหม่'));
    }
});

// === ThaiD Register Start — สำหรับลงทะเบียนด้วย ThaiD (flow='register') ===
apiRouter.get('/auth/thaid/register-start', async (req, res) => {
    try {
        const s = await getThaidSettings();
        const frontendBase = getFrontendBase(req);

        // ตรวจ register enabled (แยกจาก login enabled)
        const registerEnabled = s.thaid_register_enabled === 'true';
        if (!registerEnabled) {
            return res.redirect(`${frontendBase}/register?sso_error=${encodeURIComponent('ThaiD สำหรับลงทะเบียนยังไม่ได้เปิดใช้งาน')}`);
        }

        // สร้าง dynamic state สำหรับ register flow
        const state = 'khupskpi-reg-' + crypto.randomBytes(8).toString('hex');
        _thaidStateMap.set(state, { origin: frontendBase, flow: 'register', created_at: Date.now() });

        // ใช้ URL จาก settings (configurable) หรือ default จาก hardcoded constants
        let regUrl = s.thaid_register_url || '';
        if (!regUrl) {
            regUrl = `${THAID_AUTH_URL}?response_type=code&client_id=${THAID_CLIENT_ID}&redirect_uri=${encodeURIComponent(THAID_REDIRECT_URI)}&scope=${encodeURIComponent(THAID_SCOPE)}`;
        }
        // Replace/append state parameter (override ค่า state ที่ user กำหนดใน settings ด้วย dynamic state)
        const urlObj = new URL(regUrl);
        urlObj.searchParams.set('state', state);
        const finalUrl = urlObj.toString();

        console.log(`[ThaiD/register-start] state=${state} | url=${finalUrl.substring(0, 80)}...`);
        res.redirect(finalUrl);
    } catch (e) {
        console.error('[ThaiD/register-start]', e.message);
        res.redirect('/register?sso_error=' + encodeURIComponent('เกิดข้อผิดพลาด กรุณาลองใหม่'));
    }
});

// GET /auth/thaid/reg-data — ดึงข้อมูล CID hash + ชื่อ จาก register token เพื่อ pre-fill ฟอร์ม (public)
// หมายเหตุ: ไม่ลบ entry ที่นี่ — ต้องคงอยู่จนกว่าจะใช้จริงตอน POST /register (บรรทัดที่ลบคือจุด one-time consume จริง)
// เดิมลบทิ้งทันทีหลัง read ที่นี่ ทำให้ POST /register (ซึ่งอ่าน token เดิมอีกครั้งตอนกดบันทึก) หา entry ไม่เจอเสมอ
// กลายเป็น "Token ThaiD หมดอายุ" ทุกครั้งแม้กรอกฟอร์มเสร็จเร็วก็ตาม เพราะถูกลบไปตั้งแต่ตอนโหลดหน้าแล้ว
apiRouter.get('/auth/thaid/reg-data', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'ไม่มี token' });
    const entry = _thaidRegMap.get(String(token));
    if (!entry || entry.expires < Date.now()) {
        _thaidRegMap.delete(String(token));
        return res.status(404).json({ success: false, message: 'Token หมดอายุ กรุณาสแกน QR ThaiD ใหม่' });
    }
    res.json({
        success: true,
        cid_hash: entry.cid_hash,
        cid: entry.cid || '',
        firstname_th: entry.firstname_th || '',
        lastname_th: entry.lastname_th || '',
        email: entry.email || '',
        phone: entry.phone || '',
        hospcode: entry.hospcode || '',
        distid: entry.distid || '',
        provider: entry.provider || 'thaid'
    });
});

// === ThaiD Callback Handler (shared function) ===
// mount ทั้งบน apiRouter (/khupskpi/api/auth/thaid/callback)
// และบน app root (/authen/thaid/callback — ตรงกับ redirect_uri ที่ลงทะเบียนกับ DGA)
async function handleThaidCallback(req, res) {
    const { code, state, error, error_description } = req.query;
    console.warn('[ThaiD/callback] ▶ path=', req.path, '| code=', code ? code.substring(0,12)+'...' : 'NONE', '| state=', String(state||'').substring(0,30), '| error=', error||'-');

    const stateStr = String(state || '');
    const stateData = _thaidStateMap.get(stateStr);
    const isKhupskpiState = stateStr.startsWith('khupskpi-');
    // origin: ดึงจาก state map (บันทึกตอน /start) หรือ fallback จาก request
    const frontendBase = stateData?.origin || getFrontendBase(req);
    const loginUrl = `${frontendBase}/login`;
    const dashboardUrl = `${frontendBase}/dashboard`;
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    const _thaidFlow = stateData?.flow || 'login';

    console.warn('[ThaiD/callback] stateFound=', !!stateData, '| isKhupskpiState=', isKhupskpiState, '| frontendBase=', frontendBase);

    const redirectErr = (msg, opts = {}) => {
        console.error('[ThaiD/callback] ❌ ERROR:', msg);
        saveSsoLog('thaid', _thaidFlow, { outcome: 'error', ip, error_msg: msg, ...opts });
        const ssoCallbackUrl = `${frontendBase}/sso-callback?sso_error=${encodeURIComponent(msg)}&sso_provider=thaid`;
        return res.redirect(ssoCallbackUrl);
    };

    if (error) {
        return redirectErr(error_description ? String(error_description) : String(error));
    }
    if (!state || !stateData) {
        return redirectErr('state ไม่ถูกต้อง กรุณาลอง login ใหม่');
    }
    if (stateData) _thaidStateMap.delete(stateStr);

    if (!code) return redirectErr('ไม่ได้รับ authorization code จาก ThaiD');

    try {
        const s = await getThaidSettings();

        // 1. Exchange code → id_token (ใช้ hardcoded constants — s มีแค่ client_secret + return_page)
        const tokenRes = await fetch(THAID_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: String(code),
                redirect_uri: THAID_REDIRECT_URI,
                client_id: THAID_CLIENT_ID,
                client_secret: s.thaid_client_secret || ''
            }).toString()
        });

        if (!tokenRes.ok) {
            const errBody = await tokenRes.text().catch(() => '');
            console.error(`[ThaiD/callback] ❌ token exchange FAILED ${tokenRes.status}:`, errBody.substring(0, 300));
            return redirectErr(`แลก token ไม่สำเร็จ (${tokenRes.status}) — ตรวจสอบ client_secret ในหน้า Settings`);
        }

        const tokenData = await tokenRes.json();
        console.warn('[ThaiD/callback] ✓ token exchange OK | keys:', Object.keys(tokenData));
        const idToken = tokenData.id_token || tokenData.access_token;
        if (!idToken) return redirectErr('DGA ไม่ได้ส่ง id_token — ตรวจสอบ scope (ต้องมี openid)');

        // 2. Verify + Decode JWT (HS256 — signed ด้วย client_secret)
        let payload;
        try {
            payload = jwt.verify(idToken, s.thaid_client_secret, { algorithms: ['HS256'] });
            console.warn('[ThaiD/callback] ✓ JWT verified | fields:', Object.keys(payload));
        } catch (verifyErr) {
            console.warn('[ThaiD] JWT verify failed (อาจเป็น RS256), ใช้ decode แทน:', verifyErr.message);
            payload = jwt.decode(idToken);
            if (!payload) return redirectErr('ไม่สามารถอ่าน token จาก ThaiD ได้');
            if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp)
                return redirectErr('ThaiD token หมดอายุ กรุณา login ใหม่');
            console.warn('[ThaiD/callback] decoded (no verify) | fields:', Object.keys(payload));
        }
        if (!payload || typeof payload !== 'object') {
            return redirectErr('ถอดรหัส JWT จาก DGA ไม่สำเร็จ');
        }

        // 3. ดึงเลขบัตรประชาชน 13 หลัก (DGA ส่งเป็น field "cid" plain text)
        const cidStr = extractCidFromPayload(payload);
        console.warn('[ThaiD/callback] CID extracted:', cidStr ? `****${cidStr.slice(-4)}` : 'NOT FOUND', '| payload keys:', Object.keys(payload));
        if (!cidStr) {
            return redirectErr('ไม่พบเลขบัตรประชาชน 13 หลักใน JWT (field ที่ตรวจ: cid, pid, citizen_id, national_id, sub)', { raw_payload: payload });
        }

        // ข้อมูลชื่อ-สกุลจาก DGA (ใช้แสดงใน log)
        const thaiFullName = payload.name_th || `${payload.firstname_th || ''} ${payload.lastname_th || ''}`.trim();
        // extracted_fields ที่ใช้บ่อย — บันทึกใน log ทุกครั้ง
        const _extracted = {
            firstname_th: payload.firstname_th || payload.given_name || '',
            lastname_th:  payload.lastname_th  || payload.family_name || '',
            name_th:      payload.name_th || thaiFullName || '',
            birthdate:    payload.birthdate || '',
            sub:          payload.sub || ''
        };

        // 4. เทียบ users.cid — ลอง 2 วิธี:
        //    วิธี 1: SHA-256 ของ cid ที่เราคำนวณเอง (วิธีมาตรฐานที่ users ลงทะเบียน)
        //    วิธี 2: hash_cid ที่ DGA ส่งมาตรง ๆ (DGA pre-hash ไว้ให้)
        const hashedCid = crypto.createHash('sha256').update(cidStr).digest('hex');
        const hashCidFromDga = (payload.hash_cid && String(payload.hash_cid).length === 64)
            ? String(payload.hash_cid) : null;
        const pidPartial = cidStr.length >= 4 ? cidStr.slice(-4) : '';

        // === Register flow — ไม่ match user, สร้าง reg token แล้ว redirect ไปหน้า register ===
        if (stateData?.flow === 'register') {
            const regToken = crypto.randomBytes(8).toString('hex');
            const regLocation = await resolveRegLocationFromPayload(payload);
            _thaidRegMap.set(regToken, {
                cid_hash: hashedCid, cid: cidStr,
                firstname_th: payload.firstname_th || payload.given_name || '',
                lastname_th: payload.lastname_th || payload.family_name || '',
                hospcode: regLocation.hospcode, distid: regLocation.distid,
                expires: Date.now() + 10 * 60 * 1000
            });
            const fn = encodeURIComponent(payload.firstname_th || payload.given_name || '');
            const ln = encodeURIComponent(payload.lastname_th || payload.family_name || '');
            const regUrl = `${frontendBase}/register?thaid_reg=${regToken}&thaid_fn=${fn}&thaid_ln=${ln}`;
            console.warn('[ThaiD/register] reg token created, redirect →', regUrl);
            saveSsoLog('thaid', 'register', {
                outcome: 'register_redirect', cid_hash: hashedCid, ip,
                raw_payload: payload, extracted_fields: _extracted
            });
            return res.redirect(regUrl);
        }

        // === Login flow — match user by CID hash (JOIN for full profile) ===
        const SELECT_USER = `
            SELECT u.id, u.username, u.role, u.dept_id, u.hospcode, u.firstname, u.lastname,
                   u.is_active, u.is_approved, u.active_session_id, u.last_seen_at, u.last_seen_ip,
                   u.email, u.phone,
                   d.dept_name, h.hosname,
                   TRIM(CONCAT(COALESCE(h.hosname,''), IF(dist.distname IS NOT NULL AND dist.distname != '', CONCAT(' อ.', dist.distname), ''))) AS service_unit
            FROM users u
            LEFT JOIN departments d ON d.id = u.dept_id
            LEFT JOIN chospital h ON h.hoscode = u.hospcode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            WHERE u.cid = ? LIMIT 1`;

        let [rows] = await db.query(SELECT_USER, [hashedCid]);

        // fallback: ลอง hash_cid จาก DGA ถ้าไม่เจอด้วย SHA-256 ของเรา
        if (rows.length === 0 && hashCidFromDga && hashCidFromDga !== hashedCid) {
            console.log('[ThaiD] ไม่พบด้วย SHA-256 ของเรา ลอง hash_cid จาก DGA...');
            [rows] = await db.query(SELECT_USER, [hashCidFromDga]);
        }

        if (rows.length === 0) {
            console.warn(`[ThaiD/callback] ❌ no_match | SHA256=${hashedCid} | hash_cid_dga=${hashCidFromDga}`);
            saveSsoLog('thaid', 'login', {
                outcome: 'no_match', cid_hash: hashedCid, ip,
                raw_payload: payload, extracted_fields: _extracted,
                error_msg: `ไม่พบ user สำหรับ CID hash นี้`
            });
            return res.redirect(`${frontendBase}/sso-callback?sso_error=${encodeURIComponent(`ไม่พบบัญชีที่ผูกกับบัตรประชาชนนี้ (${thaiFullName || 'ไม่ทราบชื่อ'}) — กรุณาให้ผู้ดูแลระบบบันทึกเลขบัตรประชาชนในบัญชีผู้ใช้ก่อน`)}`);
        }

        const user = rows[0];
        const ssoErrUrl = (msg) => `${frontendBase}/sso-callback?sso_error=${encodeURIComponent(msg)}`;

        if (!user.is_active) {
            saveSsoLog('thaid', 'login', { outcome: 'blocked', cid_hash: hashedCid, user_id: user.id, username: user.username, ip, raw_payload: payload, extracted_fields: _extracted, error_msg: 'บัญชีถูกปิดใช้งาน' });
            return res.redirect(ssoErrUrl('บัญชีถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ'));
        }
        if (!user.is_approved) {
            saveSsoLog('thaid', 'login', { outcome: 'blocked', cid_hash: hashedCid, user_id: user.id, username: user.username, ip, raw_payload: payload, extracted_fields: _extracted, error_msg: 'บัญชียังรอการอนุมัติ' });
            return res.redirect(ssoErrUrl('บัญชียังรอการอนุมัติจากผู้ดูแลระบบ'));
        }

        // 5. Concurrent login check
        if (user.active_session_id) {
            const lastSeen = user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
            if (lastSeen > Date.now() - 5 * 60 * 1000) {
                saveSsoLog('thaid', 'login', { outcome: 'blocked', cid_hash: hashedCid, user_id: user.id, username: user.username, ip, raw_payload: payload, extracted_fields: _extracted, error_msg: `Concurrent session ที่ IP ${user.last_seen_ip}` });
                return res.redirect(ssoErrUrl(`บัญชีนี้กำลังใช้งานอยู่ที่ IP ${user.last_seen_ip || '-'} — รอ 5 นาที หรือ logout เครื่องเก่าก่อน`));
            }
        }

        // 6. Issue session + JWT
        console.warn(`[ThaiD/callback] ✓ user found: ${user.username} (id=${user.id})`);
        const sessionId = crypto.randomBytes(24).toString('hex');
        await db.query(
            'UPDATE users SET active_session_id = ?, session_started_at = NOW(), last_seen_at = NOW(), last_seen_ip = ? WHERE id = ?',
            [sessionId, ip, user.id]
        );
        _sessionCache.delete(user.id);

        const token = jwt.sign(
            { userId: user.id, username: user.username, deptId: user.dept_id, role: user.role, hospcode: user.hospcode, sessionId },
            SECRET_KEY,
            { expiresIn: '8h' }
        );

        await saveLog(user.username, 'login_success', `เข้าสู่ระบบผ่าน ThaiD SSO (${thaiFullName || '****' + cidStr.slice(-4)})`, ip);
        sendLoginNotifications(user, ip, req.headers['user-agent'] || '', 'thaid');

        // บันทึก SSO log + อัปเดต profile
        saveSsoLog('thaid', 'login', {
            outcome: 'success', cid_hash: hashedCid, user_id: user.id, username: user.username, ip,
            raw_payload: payload, extracted_fields: _extracted
        });
        upsertSsoProfile('thaid', user.id, {
            cid_hash: hashedCid,
            firstname_th: _extracted.firstname_th,
            lastname_th:  _extracted.lastname_th,
            birthdate:    _extracted.birthdate,
            name_th:      _extracted.name_th,
            pid_partial:  pidPartial,
            extra_fields: { sub: payload.sub, hash_cid: payload.hash_cid, iss: payload.iss },
            raw_payload:  payload
        });

        const userInfo = {
            id: user.id, username: user.username, role: user.role,
            dept_id: user.dept_id, hospcode: user.hospcode,
            firstname: user.firstname, lastname: user.lastname,
            dept_name: user.dept_name || '',
            service_unit: user.service_unit || user.hosname || '',
            email: user.email || '',
            phone: user.phone || ''
        };

        // Redirect ไป /sso-callback (public route) — save token แล้วไป /dashboard ทันที
        const ssoUserB64 = encodeURIComponent(Buffer.from(JSON.stringify(userInfo)).toString('base64'));
        const finalUrl = `${frontendBase}/sso-callback?sso_token=${encodeURIComponent(token)}&sso_user=${ssoUserB64}&sso_provider=thaid`;
        console.warn('[ThaiD] ✅ SUCCESS redirect →', finalUrl.substring(0, 80) + '...');
        res.redirect(finalUrl);
    } catch (e) {
        console.error('[ThaiD/callback] ❌ EXCEPTION:', e.message, e.stack?.split('\n')[1]);
        saveSsoLog('thaid', _thaidFlow, { outcome: 'error', ip, error_msg: e.message });
        const errUrl = `${frontendBase}/sso-callback?sso_error=${encodeURIComponent('เกิดข้อผิดพลาดระหว่างเชื่อมต่อ ThaiD — ' + e.message)}`;
        res.redirect(errUrl);
    }
}

// Mount callback บน 2 path:
// - /khupskpi/api/auth/thaid/callback (primary — สำหรับ redirect_uri ใหม่)
apiRouter.get('/auth/thaid/callback', handleThaidCallback);
// - /authen/thaid/callback (ตรงกับที่ลงทะเบียน DGA: https://apikorat.moph.go.th/authen/thaid/callback)
//   ต้องเพิ่ม nginx: location /authen/ { proxy_pass http://backend:8830; ... }
app.get('/authen/thaid/callback', handleThaidCallback);

// ============================================================
// === ProviderID (MOPH) OAuth 2.0 Login Flow ================
// ============================================================

/** ดึง ProviderID config จาก DB */
// MOPH Health ID (moph.id.th) — default endpoints (discovered from /back/oauth/service-provider pattern)
const MOPH_AUTH_URL     = 'https://moph.id.th/oauth/redirect';
const MOPH_TOKEN_URL    = 'https://moph.id.th/back/oauth/token';
const MOPH_USERINFO_URL = 'https://moph.id.th/back/oauth/userinfo';
const MOPH_REDIRECT_URI = 'https://apikorat.moph.go.th/authen/healthid/callback';

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

/** CSRF state map สำหรับ ProviderID (TTL 10 นาที) */
const _providerIdStateMap = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _providerIdStateMap) {
        if (v.expires < now) _providerIdStateMap.delete(k);
    }
}, 60000);

/** GET /auth/providerid/start — redirect ไปหน้า ProviderID Login */
apiRouter.get('/auth/providerid/start', async (req, res) => {
    try {
        const s = await getProviderIdSettings();
        const frontendBase = getFrontendBase(req);
        if (!s.enabled)
            return res.redirect(`${frontendBase}/sso-callback?sso_error=${encodeURIComponent('ProviderID ยังไม่ได้เปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ')}`);
        if (!s.login_url)
            return res.redirect(`${frontendBase}/sso-callback?sso_error=${encodeURIComponent('ProviderID ยังไม่ได้ตั้งค่า URL กรุณาตรวจสอบ Settings')}`);

        // สร้าง dynamic state + เก็บใน _providerIdStateMap (เดิมไม่เคยเก็บเลย ทำให้ callback
        // เช็ค state ไม่เจอ → error ทุกครั้ง) แล้ว override ค่า state เดิมใน URL (เหมือน ThaiD /auth/thaid/start)
        const state = 'khupskpi-' + crypto.randomBytes(8).toString('hex');
        _providerIdStateMap.set(state, { origin: frontendBase, flow: 'login', expires: Date.now() + 10 * 60 * 1000 });
        const urlObj = new URL(s.login_url);
        urlObj.searchParams.set('state', state);
        const finalUrl = urlObj.toString();

        console.log(`[ProviderID/start] state=${state} | → ${finalUrl.slice(0, 80)}...`);
        res.redirect(finalUrl);
    } catch (e) {
        console.error('[ProviderID/start] error:', e.message);
        const frontendBase = getFrontendBase(req);
        res.redirect(`${frontendBase}/sso-callback?sso_error=${encodeURIComponent('เกิดข้อผิดพลาดในการเชื่อมต่อ ProviderID')}`);
    }
});

/** GET /auth/providerid/register-start — redirect ไปหน้า ProviderID (สำหรับ flow ลงทะเบียน) */
apiRouter.get('/auth/providerid/register-start', async (req, res) => {
    try {
        const s = await getProviderIdSettings();
        const frontendBase = getFrontendBase(req);
        if (!s.register_enabled)
            return res.redirect(`${frontendBase}/register?sso_error=${encodeURIComponent('ProviderID สำหรับลงทะเบียนยังไม่ได้เปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ')}`);
        // ใช้ register_url ถ้าตั้งไว้ ไม่งั้น fallback เป็น login_url
        const targetUrl = s.register_url || s.login_url;
        if (!targetUrl)
            return res.redirect(`${frontendBase}/register?sso_error=${encodeURIComponent('ProviderID ยังไม่ได้ตั้งค่า Register URL กรุณาตรวจสอบ Settings')}`);

        // สร้าง dynamic state + เก็บ flow='register' — callback จะเช็คค่านี้เพื่อรู้ว่าต้อง
        // พาไปหน้า register (ไม่ใช่พยายาม login) เมื่อ MOPH redirect กลับมา
        const state = 'khupskpi-reg-' + crypto.randomBytes(8).toString('hex');
        _providerIdStateMap.set(state, { origin: frontendBase, flow: 'register', expires: Date.now() + 10 * 60 * 1000 });
        const urlObj = new URL(targetUrl);
        urlObj.searchParams.set('state', state);
        const finalUrl = urlObj.toString();

        console.log(`[ProviderID/register-start] state=${state} | → ${finalUrl.slice(0, 80)}...`);
        res.redirect(finalUrl);
    } catch (e) {
        console.error('[ProviderID/register-start] error:', e.message);
        const frontendBase = getFrontendBase(req);
        res.redirect(`${frontendBase}/register?sso_error=${encodeURIComponent('เกิดข้อผิดพลาดในการเชื่อมต่อ ProviderID')}`);
    }
});

/** Handler หลักของ ProviderID OAuth callback */
async function handleProviderIdCallback(req, res) {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    const frontendBase = getFrontendBase(req);
    const { code, state, error, error_description } = req.query;
    const stateStr = String(state || '');
    const stateData = _providerIdStateMap.get(stateStr);
    const _pidFlow = stateData?.flow || 'login';

    const redirectErr = (msg) => {
        console.error('[ProviderID/callback] ❌ ERROR:', msg);
        saveSsoLog('providerid', _pidFlow, { outcome: 'error', ip, error_msg: msg });
        return res.redirect(`${frontendBase}/sso-callback?sso_error=${encodeURIComponent(msg)}&sso_provider=providerid`);
    };

    if (error) return redirectErr(error_description ? String(error_description) : String(error));
    if (!state || !stateData) return redirectErr('state ไม่ถูกต้อง กรุณาลอง login ใหม่');
    if (stateData) _providerIdStateMap.delete(stateStr);
    if (!code) return redirectErr('ไม่ได้รับ authorization code จาก ProviderID');

    try {
        const s = await getProviderIdSettings();
        if (!s.enabled) return redirectErr('ProviderID ยังไม่ได้เปิดใช้งาน');

        // 1. Exchange code → access_token
        // ลอง form-urlencoded ก่อน ถ้า 400/500 ลอง JSON (MOPH บางเวอร์ชันใช้ JSON body)
        if (!s.token_url) return redirectErr('ยังไม่ได้ตั้งค่า Token URL — กรุณากรอกใน Settings');
        const tokenBody = {
            grant_type: 'authorization_code',
            code: String(code),
            redirect_uri: s.redirect_uri,
            client_id: s.client_id,
            ...(s.client_secret ? { client_secret: s.client_secret } : {})
        };
        console.log(`[ProviderID/callback] token exchange → ${s.token_url} | client_id=${s.client_id.slice(0,8)}...`);
        let tokenRes = await fetch(s.token_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: new URLSearchParams(tokenBody).toString()
        });
        // fallback: ลอง JSON body ถ้า form-encoded ไม่สำเร็จ
        if (!tokenRes.ok && (tokenRes.status === 400 || tokenRes.status === 415 || tokenRes.status === 500)) {
            console.warn(`[ProviderID/callback] form-encoded ${tokenRes.status} → ลอง JSON body`);
            tokenRes = await fetch(s.token_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify(tokenBody)
            });
        }
        if (!tokenRes.ok) {
            const errBody = await tokenRes.text().catch(() => '');
            console.error(`[ProviderID/callback] ❌ token exchange FAILED ${tokenRes.status}:`, errBody.substring(0, 500));
            const hint = tokenRes.status === 401 ? 'client_id หรือ client_secret ไม่ถูกต้อง'
                       : tokenRes.status === 400 ? 'redirect_uri ไม่ตรงกับที่จด หรือ code หมดอายุ'
                       : tokenRes.status === 500 ? 'MOPH server error — ตรวจสอบว่า client_id ลงทะเบียนแล้ว'
                       : `HTTP ${tokenRes.status}`;
            return redirectErr(`แลก token ไม่สำเร็จ — ${hint}`);
        }
        const tokenData = await tokenRes.json().catch(() => ({}));
        const accessToken = tokenData.access_token || tokenData.token;
        if (!accessToken) {
            console.error('[ProviderID/callback] ❌ token response keys:', Object.keys(tokenData));
            return redirectErr('ProviderID ไม่ได้ส่ง access_token กลับมา — ตรวจสอบ Token URL และ scope');
        }
        console.warn('[ProviderID/callback] ✓ token exchange OK | keys:', Object.keys(tokenData));

        // 2. Call userinfo endpoint — ดึงเลขบัตร 13 หลัก
        let userProfile = null;
        if (s.userinfo_url) {
            const uiRes = await fetch(s.userinfo_url, {
                headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
            });
            if (uiRes.ok) {
                userProfile = await uiRes.json();
                console.warn('[ProviderID/callback] userinfo keys:', Object.keys(userProfile || {}));
            } else {
                console.warn('[ProviderID/callback] userinfo failed', uiRes.status, '— ลอง decode access_token แทน');
            }
        }
        // fallback: decode access_token ถ้าเป็น JWT
        if (!userProfile) {
            userProfile = jwt.decode(accessToken) || {};
            console.warn('[ProviderID/callback] decoded access_token keys:', Object.keys(userProfile));
        }

        // 3. ดึงเลขบัตรประชาชน 13 หลัก
        const cidStr = extractCidFromPayload(userProfile);
        if (!cidStr) {
            return redirectErr('ไม่พบเลขบัตรประชาชน 13 หลักจาก ProviderID (field ที่ตรวจ: cid, pid, citizen_id, national_id, sub)');
        }
        const hashedCid = crypto.createHash('sha256').update(cidStr).digest('hex');
        const pidPartial = cidStr.slice(-4);
        const fullName = userProfile.name_th || userProfile.name || `${userProfile.given_name || ''} ${userProfile.family_name || ''}`.trim();
        console.warn(`[ProviderID/callback] CID extracted ****${pidPartial} | name: ${fullName || '-'}`);

        // === Register flow — ไม่ match user, สร้าง reg token แล้ว redirect ไปหน้า register ===
        // (เดิมไม่มี branch นี้เลย — ทุก callback ถูกปฏิบัติเหมือน login ทำให้ผู้ลงทะเบียนใหม่เจอ
        // ข้อความ error "ไม่พบบัญชี" แทนที่จะไปหน้า register — ดู handleThaidCallback สำหรับ pattern เดิม)
        if (stateData?.flow === 'register') {
            const regToken = crypto.randomBytes(8).toString('hex');
            const regLocation = await resolveRegLocationFromPayload(userProfile);
            _thaidRegMap.set(regToken, {
                cid_hash: hashedCid, cid: cidStr,
                firstname_th: userProfile.firstname_th || userProfile.given_name || '',
                lastname_th: userProfile.lastname_th || userProfile.family_name || '',
                hospcode: regLocation.hospcode, distid: regLocation.distid,
                provider: 'providerid',
                expires: Date.now() + 10 * 60 * 1000
            });
            const fn = encodeURIComponent(userProfile.firstname_th || userProfile.given_name || '');
            const ln = encodeURIComponent(userProfile.lastname_th || userProfile.family_name || '');
            const regUrl = `${frontendBase}/register?thaid_reg=${regToken}&thaid_fn=${fn}&thaid_ln=${ln}&sso_provider=providerid`;
            console.warn('[ProviderID/register] reg token created, redirect →', regUrl);
            saveSsoLog('providerid', 'register', {
                outcome: 'register_redirect', cid_hash: hashedCid, ip,
                raw_payload: userProfile, extracted_fields: { firstname_th: userProfile.given_name || '', lastname_th: userProfile.family_name || '', name_th: fullName }
            });
            return res.redirect(regUrl);
        }

        // 4. Lookup user — JOIN departments + chospital
        const SELECT_USER_PID = `
            SELECT u.id, u.username, u.role, u.dept_id, u.hospcode, u.firstname, u.lastname,
                   u.is_active, u.is_approved, u.active_session_id, u.last_seen_at, u.last_seen_ip,
                   u.email, u.phone,
                   d.dept_name, h.hosname,
                   TRIM(CONCAT(COALESCE(h.hosname,''), IF(dist.distname IS NOT NULL AND dist.distname != '', CONCAT(' อ.', dist.distname), ''))) AS service_unit
            FROM users u
            LEFT JOIN departments d ON d.id = u.dept_id
            LEFT JOIN chospital h ON h.hoscode = u.hospcode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            WHERE u.cid = ? LIMIT 1`;
        const [rows] = await db.query(SELECT_USER_PID, [hashedCid]);

        if (rows.length === 0) {
            saveSsoLog('providerid', 'login', { outcome: 'no_match', cid_hash: hashedCid, ip, error_msg: 'ไม่พบ user' });
            return redirectErr(`ไม่พบบัญชีที่ผูกกับบัตรประชาชนนี้${fullName ? ` (${fullName})` : ''} — กรุณาให้ผู้ดูแลระบบบันทึกเลขบัตรในบัญชีผู้ใช้ก่อน`);
        }

        const user = rows[0];
        if (!user.is_active) {
            saveSsoLog('providerid', 'login', { outcome: 'blocked', user_id: user.id, ip, error_msg: 'บัญชีถูกปิด' });
            return redirectErr('บัญชีถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
        }
        if (!user.is_approved) {
            saveSsoLog('providerid', 'login', { outcome: 'blocked', user_id: user.id, ip, error_msg: 'รออนุมัติ' });
            return redirectErr('บัญชียังรอการอนุมัติจากผู้ดูแลระบบ');
        }

        // 5. Concurrent session check
        if (user.active_session_id) {
            const lastSeen = user.last_seen_at ? new Date(user.last_seen_at).getTime() : 0;
            if (lastSeen > Date.now() - 5 * 60 * 1000) {
                saveSsoLog('providerid', 'login', { outcome: 'blocked', user_id: user.id, ip, error_msg: `Concurrent session at ${user.last_seen_ip}` });
                return redirectErr(`บัญชีนี้กำลังใช้งานอยู่ที่ IP ${user.last_seen_ip || '-'} — รอ 5 นาที หรือ logout เครื่องเก่าก่อน`);
            }
        }

        // 6. Issue session + JWT
        console.warn(`[ProviderID/callback] ✓ user found: ${user.username} (id=${user.id})`);
        const sessionId = crypto.randomBytes(24).toString('hex');
        await db.query(
            'UPDATE users SET active_session_id = ?, session_started_at = NOW(), last_seen_at = NOW(), last_seen_ip = ? WHERE id = ?',
            [sessionId, ip, user.id]
        );
        _sessionCache.delete(user.id);

        const token = jwt.sign(
            { userId: user.id, username: user.username, deptId: user.dept_id, role: user.role, hospcode: user.hospcode, sessionId },
            SECRET_KEY, { expiresIn: '8h' }
        );

        // 7. Log + notifications
        await saveLog(user.username, 'login_success', `เข้าสู่ระบบผ่าน ProviderID SSO (${fullName || '****' + cidStr.slice(-4)})`, ip);
        saveSsoLog('providerid', 'login', { outcome: 'success', cid_hash: hashedCid, user_id: user.id, username: user.username, ip });
        try {
            await db.query(
                `INSERT INTO login_logs (user_id, username, ip, status, user_agent) VALUES (?, ?, ?, 'success_sso_providerid', ?)`,
                [user.id, user.username, ip, req.headers['user-agent'] || '']
            );
        } catch (e) {}
        upsertSsoProfile('providerid', user.id, {
            cid_hash: hashedCid,
            firstname_th: userProfile.given_name || userProfile.firstname_th || '',
            lastname_th:  userProfile.family_name || userProfile.lastname_th  || '',
            name_th:      fullName || '',
            pid_partial:  pidPartial,
            extra_fields: { sub: userProfile.sub, iss: userProfile.iss },
            raw_payload:  userProfile
        });
        sendLoginNotifications(user, ip, req.headers['user-agent'] || '', 'providerid');

        // 8. Redirect ไป sso-callback
        const userInfo = {
            id: user.id, username: user.username, role: user.role,
            dept_id: user.dept_id, hospcode: user.hospcode,
            firstname: user.firstname, lastname: user.lastname,
            dept_name: user.dept_name || '',
            service_unit: user.service_unit || user.hosname || '',
            email: user.email || '',
            phone: user.phone || ''
        };
        const ssoUserB64 = encodeURIComponent(Buffer.from(JSON.stringify(userInfo)).toString('base64'));
        const finalUrl = `${frontendBase}/sso-callback?sso_token=${encodeURIComponent(token)}&sso_user=${ssoUserB64}&sso_provider=providerid`;
        console.warn('[ProviderID] ✅ SUCCESS redirect →', finalUrl.substring(0, 80) + '...');
        res.redirect(finalUrl);
    } catch (e) {
        console.error('[ProviderID/callback] ❌ EXCEPTION:', e.message, e.stack?.split('\n')[1]);
        saveSsoLog('providerid', 'login', { outcome: 'error', ip, error_msg: e.message });
        res.redirect(`${frontendBase}/sso-callback?sso_error=${encodeURIComponent('เกิดข้อผิดพลาดระหว่างเชื่อมต่อ ProviderID — ' + e.message)}`);
    }
}

// Mount ProviderID callback — 3 paths:
// 1. /khupskpi/api/auth/providerid/callback (dev / API-prefixed)
// 2. /authen/providerid/callback (legacy nginx alias)
// 3. /authen/healthid/callback (redirect_uri จดทะเบียนกับ MOPH moph.id.th)
apiRouter.get('/auth/providerid/callback', handleProviderIdCallback);
app.get('/authen/providerid/callback', handleProviderIdCallback);
app.get('/authen/healthid/callback', handleProviderIdCallback);

// === ProviderID Config Diagnostic — ตรวจสอบ config และ MOPH endpoint (super_admin) ===
apiRouter.get('/admin/test-providerid-config', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'super_admin only' });
    try {
        const s = await getProviderIdSettings();
        const result = {
            enabled:      s.enabled,
            client_id:    s.client_id ? `${s.client_id.slice(0,8)}...` : '(ไม่ได้ตั้ง)',
            has_secret:   !!s.client_secret,
            auth_url:     s.auth_url,
            token_url:    s.token_url,
            userinfo_url: s.userinfo_url,
            redirect_uri: s.redirect_uri,
            scope:        s.scope || '(ไม่ส่ง)',
            checks: {}
        };
        // ตรวจ token_url ว่าเข้าถึงได้
        try {
            const tokenCheck = await fetch(s.token_url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'grant_type=authorization_code&code=test_probe&client_id=test&redirect_uri=test',
                signal: AbortSignal.timeout(5000)
            });
            const body = await tokenCheck.text().catch(() => '');
            result.checks.token_url = {
                status: tokenCheck.status,
                reachable: true,
                note: tokenCheck.status === 400 ? 'endpoint ตอบสนอง (400=param ผิด — ปกติ)' :
                      tokenCheck.status === 401 ? 'endpoint ตอบสนอง (401=auth ผิด — ปกติ)' :
                      tokenCheck.status === 500 ? 'endpoint ตอบสนอง แต่ server error (ตรวจ client_id/secret)' :
                      `HTTP ${tokenCheck.status}`,
                body_preview: body.substring(0, 200)
            };
        } catch (e) {
            result.checks.token_url = { reachable: false, error: e.message };
        }
        result.checks.config_complete = !!(s.client_id && s.client_secret && s.token_url && s.redirect_uri);
        result.checks.redirect_uri_match = s.redirect_uri.includes('/authen/healthid/callback') ||
                                           s.redirect_uri.includes('/authen/providerid/callback');
        result.recommendation = !s.client_id ? '⚠️ ยังไม่ได้ตั้ง client_id' :
                                !s.client_secret ? '⚠️ ยังไม่ได้ตั้ง client_secret (รับจาก MOPH portal)' :
                                result.checks.config_complete ? '✅ Config ครบ — ทดสอบ login ได้' :
                                '⚠️ Config ยังไม่ครบ';
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === Session status diagnostic (super_admin) — ตรวจว่า Single Session ทำงานหรือไม่ ===
apiRouter.get('/admin/session-status', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin') {
        return res.status(403).json({ success: false, message: 'super_admin เท่านั้น' });
    }
    try {
        // 1. ตรวจว่ามีคอลัมน์ active_session_id หรือไม่
        const [cols] = await db.query(`
            SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
              AND COLUMN_NAME IN ('active_session_id','session_started_at','last_seen_at')
        `);
        const colNames = cols.map(c => c.COLUMN_NAME || c.column_name);
        const hasSessionId = colNames.includes('active_session_id');

        const status = {
            success: true,
            schema_ok: hasSessionId,
            columns_present: colNames,
            session_cache_size: _sessionCache.size,
            current_jwt_has_session_id: !!req.user.sessionId,
            db_now: null,
            server_now: new Date().toISOString(),
            active_sessions_count: 0,
            recent_active_users: []
        };

        if (hasSessionId) {
            // 2. นับจำนวน user ที่มี active session
            const [countRow] = await db.query(`
                SELECT COUNT(*) AS cnt FROM users
                WHERE active_session_id IS NOT NULL
                  AND last_seen_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
            `);
            status.active_sessions_count = countRow[0]?.cnt || 0;

            // 3. ดึงตัวอย่าง 10 user ที่ active ล่าสุด
            const [recent] = await db.query(`
                SELECT id, username, role, last_seen_at, last_seen_ip, session_started_at,
                       SUBSTRING(active_session_id, 1, 8) AS session_prefix
                FROM users
                WHERE active_session_id IS NOT NULL
                ORDER BY last_seen_at DESC
                LIMIT 10
            `);
            status.recent_active_users = recent;

            // 4. NOW() จาก DB เพื่อเทียบ timezone
            const [now] = await db.query('SELECT NOW() AS db_now, @@global.time_zone AS tz, @@session.time_zone AS sess_tz');
            status.db_now = now[0]?.db_now;
            status.db_timezone = now[0]?.tz;
            status.db_session_timezone = now[0]?.sess_tz;
        }

        res.json(status);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message, error: e.stack });
    }
});

// === Export Debug — ตรวจว่าตัวชี้วัด+hospcode+ปี มีข้อมูลใน source ไหนบ้าง ===
// GET /admin/export-debug?year_bh=2569&indicator_id=123&hospcode=10888 (super_admin)
// หรือ ?table_process=excellence_indicator_4_54&hospcode=10888 (หา indicator_id จาก table_process)
apiRouter.get('/admin/export-debug', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'super_admin เท่านั้น' });
    const { year_bh, hospcode, table_process } = req.query;
    let indicator_id = req.query.indicator_id;
    if (!year_bh) return res.status(400).json({ success: false, message: 'year_bh required' });
    if (!indicator_id && !table_process) return res.status(400).json({ success: false, message: 'indicator_id หรือ table_process required' });
    try {
        // ถ้าใช้ table_process → ค้นหา indicator_id (อาจมีหลายตัว)
        let indicatorsByTable = [];
        if (table_process && !indicator_id) {
            const tp = String(table_process).trim().replace(/-/g, '_');
            const [rows] = await db.query(
                'SELECT id, kpi_indicators_name, table_process, dept_id, main_indicator_id, is_active FROM kpi_indicators WHERE table_process = ? OR table_process = ?',
                [table_process, tp]
            );
            indicatorsByTable = rows;
            if (rows.length === 0) return res.status(404).json({ success: false, message: `ไม่พบ kpi_indicators ที่ table_process = '${table_process}'` });
            indicator_id = rows[0].id;  // ใช้ตัวแรกเป็น primary
        }

        // Indicator info
        const [indRows] = await db.query(
            'SELECT id, kpi_indicators_name, table_process, dept_id, main_indicator_id, is_active FROM kpi_indicators WHERE id = ?',
            [indicator_id]
        );
        if (indRows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ indicator_id นี้' });
        const ind = indRows[0];

        // Sub-indicators ที่ link กับ indicator นี้
        const [subInds] = await db.query(
            'SELECT id, sub_indicator_name, sub_indicator_code, is_active FROM kpi_sub_indicators WHERE indicator_id = ? ORDER BY sort_order, id',
            [indicator_id]
        );
        // Sub-indicators ที่ไม่ได้ link (indicator_id = NULL) — เป็น orphan
        const [orphanSubs] = await db.query(
            'SELECT id, sub_indicator_name, indicator_id FROM kpi_sub_indicators WHERE indicator_id IS NULL LIMIT 20'
        );
        // หา sub_indicator_id ที่มีข้อมูลใน kpi_sub_results สำหรับ hospcode + year นี้
        const subSummarySql = `
            SELECT sr.sub_indicator_id, si.sub_indicator_name, si.indicator_id AS sub_indicator_belongs_to,
                   ki.kpi_indicators_name AS belongs_to_name, ki.table_process AS belongs_to_table,
                   COUNT(*) AS row_count, MIN(sr.month_bh) AS min_month, MAX(sr.month_bh) AS max_month
            FROM kpi_sub_results sr
            LEFT JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
            LEFT JOIN kpi_indicators ki ON si.indicator_id = ki.id
            WHERE sr.year_bh = ? ${hospcode ? 'AND sr.hospcode = ?' : ''}
              AND sr.actual_value IS NOT NULL AND sr.actual_value != ''
            GROUP BY sr.sub_indicator_id, si.sub_indicator_name, si.indicator_id, ki.kpi_indicators_name, ki.table_process
            ORDER BY row_count DESC
        `;
        const subSummaryParams = hospcode ? [year_bh, hospcode] : [year_bh];
        const [subSummary] = await db.query(subSummarySql, subSummaryParams);
        const tp = ind.table_process ? ind.table_process.trim().replace(/-/g, '_') : null;
        const dynTable = tp ? 'form_' + tp : null;

        // 1. kpi_results
        const kpiSql = hospcode
            ? 'SELECT month_bh, target_value, actual_value, status FROM kpi_results WHERE indicator_id=? AND year_bh=? AND hospcode=? ORDER BY month_bh'
            : 'SELECT hospcode, month_bh, target_value, actual_value, status FROM kpi_results WHERE indicator_id=? AND year_bh=? ORDER BY hospcode, month_bh';
        const kpiParams = hospcode ? [indicator_id, year_bh, hospcode] : [indicator_id, year_bh];
        const [kpiResults] = await db.query(kpiSql, kpiParams);

        // 2. kpi_sub_results (via sub_indicators)
        const subSql = hospcode
            ? `SELECT si.sub_indicator_name, sr.month_bh, sr.target_value, sr.actual_value FROM kpi_sub_results sr
               JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
               WHERE si.indicator_id=? AND sr.year_bh=? AND sr.hospcode=? ORDER BY si.id, sr.month_bh`
            : `SELECT sr.hospcode, si.sub_indicator_name, sr.month_bh, sr.target_value, sr.actual_value FROM kpi_sub_results sr
               JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
               WHERE si.indicator_id=? AND sr.year_bh=? ORDER BY sr.hospcode, si.id, sr.month_bh`;
        const subParams = hospcode ? [indicator_id, year_bh, hospcode] : [indicator_id, year_bh];
        const [subResults] = await db.query(subSql, subParams);

        // 3. form_<table_process>
        let formData = null;
        if (dynTable) {
            try {
                const [colInfo] = await db.query(
                    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
                    [dynTable]
                );
                if (colInfo.length > 0) {
                    const colNames = colInfo.map(c => c.COLUMN_NAME || c.column_name);
                    const allCols = colNames.map(n => `\`${n}\``).join(', ');
                    const hasIndId = colNames.includes('indicator_id');
                    let where = 'WHERE year_bh=?';
                    const params = [year_bh];
                    if (hasIndId) { where += ' AND (indicator_id=? OR indicator_id IS NULL)'; params.push(indicator_id); }
                    if (hospcode) { where += ' AND hospcode=?'; params.push(hospcode); }
                    const [rows] = await db.query(`SELECT ${allCols} FROM \`${dynTable}\` ${where} LIMIT 100`, params);
                    formData = { table: dynTable, columns: colNames, rows };
                } else {
                    formData = { table: dynTable, columns: [], rows: [], note: 'ตารางไม่มีอยู่ในฐานข้อมูล' };
                }
            } catch (e) { formData = { table: dynTable, error: e.message }; }
        }

        // 4. Schema info
        const [schemas] = await db.query(
            'SELECT id, form_title, actual_value_field, is_active FROM kpi_form_schemas WHERE indicator_id = ? ORDER BY is_active DESC, id DESC',
            [indicator_id]
        );
        let schemaFields = [];
        if (schemas.length > 0) {
            const [f] = await db.query('SELECT field_name, field_label, field_type FROM kpi_form_fields WHERE schema_id = ? ORDER BY sort_order', [schemas[0].id]);
            schemaFields = f;
        }

        // 5. Export table existing row
        let exportData = null;
        if (tp && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tp)) {
            try {
                const exportWhere = hospcode ? 'WHERE byear=? AND hospcode=?' : 'WHERE byear=?';
                const exportParams = hospcode ? [year_bh, hospcode] : [year_bh];
                const [rows] = await db.query(`SELECT * FROM \`${tp}\` ${exportWhere} LIMIT 50`, exportParams);
                exportData = { table: tp, rows };
            } catch (e) { exportData = { table: tp, error: e.message }; }
        }
        // 6. ตารางรายละเอียดข้อย่อย/กิจกรรม (Export 3 ระดับ) — ถ้ามี
        let itemsData = null;
        const itemsName = tp && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tp) ? itemsTableName(tp) : null;
        if (itemsName) {
            try {
                const w = hospcode ? 'WHERE byear=? AND hospcode=?' : 'WHERE byear=?';
                const [rows] = await db.query(`SELECT * FROM \`${itemsName}\` ${w} ORDER BY hospcode, item_level, item_no LIMIT 100`, hospcode ? [year_bh, hospcode] : [year_bh]);
                itemsData = { table: itemsName, rows };
            } catch (e) { itemsData = { table: itemsName, error: e.code === 'ER_NO_SUCH_TABLE' ? 'ยังไม่มีตาราง (ยังไม่เปิด/ยังไม่ส่งออก)' : e.message }; }
        }

        res.json({
            success: true,
            query: { indicator_id, table_process: table_process || ind.table_process, year_bh, hospcode: hospcode || '(all)' },
            indicator: ind,
            indicators_with_same_table_process: indicatorsByTable.length > 1 ? indicatorsByTable : undefined,
            sub_indicators: { count: subInds.length, list: subInds },
            kpi_sub_results_summary: {
                hint: 'แต่ละ sub_indicator_id แสดงว่า belong กับ indicator ไหน (ดู belongs_to_name) — ถ้าไม่ตรงกับ indicator ที่ query → ข้อมูลนั้นไม่ใช่ของ indicator นี้',
                rows: subSummary
            },
            orphan_sub_indicators: { count: orphanSubs.length, list: orphanSubs, hint: 'sub_indicator ที่ indicator_id IS NULL → ไม่ link กับ indicator ใด → export จะไม่เห็น' },
            kpi_results: { count: kpiResults.length, rows: kpiResults },
            kpi_sub_results: { count: subResults.length, rows: subResults },
            form_table: formData,
            schemas: { count: schemas.length, list: schemas, active_fields: schemaFields },
            export_table: exportData,
            items_table: itemsData
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === Force-logout user (super_admin only) — บังคับ logout user คนใดก็ตาม ===
apiRouter.post('/admin/force-logout-user/:userId', authenticateToken, async (req, res) => {
    if (req.user.role !== 'super_admin') {
        return res.status(403).json({ success: false, message: 'super_admin เท่านั้น' });
    }
    const uid = parseInt(req.params.userId);
    if (!uid) return res.status(400).json({ success: false, message: 'userId ไม่ถูกต้อง' });
    try {
        await db.query('UPDATE users SET active_session_id = NULL, session_started_at = NULL WHERE id = ?', [uid]);
        _sessionCache.delete(uid);
        await saveLog(req.user.username, 'admin_force_logout', `บังคับ logout user id=${uid}`, req.headers['x-forwarded-for'] || req.ip);
        res.json({ success: true, message: 'บังคับ logout user สำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================================
// === SSO Audit Endpoints (super_admin) ======================
// ============================================================

// GET /admin/sso-logs?provider=&flow=&outcome=&user_id=&page=&limit=&from=&to=
apiRouter.get('/admin/sso-logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const page    = Math.max(1, parseInt(req.query.page)  || 1);
        const limit   = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
        const offset  = (page - 1) * limit;
        const where   = [];
        const params  = [];
        if (req.query.provider) { where.push('provider = ?'); params.push(req.query.provider); }
        if (req.query.flow)     { where.push('flow = ?');     params.push(req.query.flow); }
        if (req.query.outcome)  { where.push('outcome = ?');  params.push(req.query.outcome); }
        if (req.query.user_id)  { where.push('user_id = ?'); params.push(parseInt(req.query.user_id)); }
        if (req.query.from)     { where.push('created_at >= ?'); params.push(req.query.from); }
        if (req.query.to)       { where.push('created_at <= ?'); params.push(req.query.to + ' 23:59:59'); }
        const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM sso_logs ${whereStr}`, params);
        const [rows] = await db.query(
            `SELECT id, provider, flow, cid_hash, user_id, username, outcome,
                    extracted_fields, ip, error_msg, created_at
             FROM sso_logs ${whereStr}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        res.json({ success: true, data: rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /admin/sso-logs/:id — ดู raw_payload ของ log รายการเดียว
apiRouter.get('/admin/sso-logs/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM sso_logs WHERE id = ?', [parseInt(req.params.id)]);
        if (!rows.length) return res.status(404).json({ success: false, message: 'ไม่พบ log' });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /admin/sso-profiles?user_id=&provider=&page=&limit=
apiRouter.get('/admin/sso-profiles', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(req.query.page) || 1);
        const limit  = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
        const offset = (page - 1) * limit;
        const where  = [];
        const params = [];
        if (req.query.user_id)  { where.push('p.user_id = ?');  params.push(parseInt(req.query.user_id)); }
        if (req.query.provider) { where.push('p.provider = ?'); params.push(req.query.provider); }
        const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM sso_profiles p ${whereStr}`, params);
        const [rows] = await db.query(
            `SELECT p.id, p.user_id, p.provider, p.cid_hash, p.firstname_th, p.lastname_th,
                    p.birthdate, p.name_th, p.pid_partial, p.extra_fields,
                    p.linked_at, p.last_seen_at, p.login_count,
                    u.username, u.hospcode, u.role
             FROM sso_profiles p
             LEFT JOIN users u ON u.id = p.user_id
             ${whereStr}
             ORDER BY p.last_seen_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        res.json({ success: true, data: rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /admin/sso-profiles/user/:userId — โปรไฟล์ทุก provider ของ user คนเดียว
apiRouter.get('/admin/sso-profiles/user/:userId', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT p.*, u.username, u.hospcode, u.role
             FROM sso_profiles p
             LEFT JOIN users u ON u.id = p.user_id
             WHERE p.user_id = ?`,
            [parseInt(req.params.userId)]
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /admin/sso-stats — สรุปสถิติ SSO
apiRouter.get('/admin/sso-stats', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [byOutcome] = await db.query(
            `SELECT provider, outcome, COUNT(*) AS cnt
             FROM sso_logs GROUP BY provider, outcome ORDER BY provider, cnt DESC`
        );
        const [byDay] = await db.query(
            `SELECT DATE(created_at) AS day, provider, outcome, COUNT(*) AS cnt
             FROM sso_logs
             WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             GROUP BY day, provider, outcome ORDER BY day DESC`
        );
        const [profiles] = await db.query(
            `SELECT provider, COUNT(*) AS cnt, SUM(login_count) AS total_logins
             FROM sso_profiles GROUP BY provider`
        );
        res.json({ success: true, by_outcome: byOutcome, by_day: byDay, profiles });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === ลืมรหัสผ่าน: ส่งรหัสชั่วคราว 6 หลักทาง Email ===
apiRouter.post('/forgot-password', loginIpLimiter, loginLimiter, async (req, res) => {
    const { username } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!username) return res.status(400).json({ success: false, message: 'กรุณากรอก Username' });

    try {
        const [users] = await db.query('SELECT id, email, firstname, lastname FROM users WHERE username = ? AND is_approved = 1 AND is_active = 1', [username]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ Username นี้ในระบบ หรือบัญชียังไม่ได้รับการอนุมัติ' });

        const user = users[0];
        if (!user.email) return res.status(400).json({ success: false, message: 'บัญชีนี้ไม่มี Email ลงทะเบียนไว้ กรุณาติดต่อผู้ดูแลระบบ' });

        // สร้างรหัสชั่วคราว 6 หลัก — ใช้ crypto.randomInt (CSPRNG)
        const tempCode = String(crypto.randomInt(100000, 1000000));
        const hashedTemp = await bcrypt.hash(tempCode, 10);
        const expiry = new Date(Date.now() + 15 * 60 * 1000); // หมดอายุ 15 นาที

        await db.query('UPDATE users SET temp_password = ?, temp_password_expiry = ?, must_change_password = 1 WHERE id = ?',
            [hashedTemp, expiry, user.id]);

        // ส่ง Email
        const emailMask = user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3');
        sendMail(user.email, '🔑 รหัสชั่วคราวสำหรับเข้าสู่ระบบ — ระบบ KPI สสจ.นครราชสีมา',
            `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:linear-gradient(135deg,#2563eb,#3b82f6);padding:24px;text-align:center;color:white">
                    <h2 style="margin:0;font-size:20px">🔑 รหัสชั่วคราว</h2>
                </div>
                <div style="padding:24px;text-align:center">
                    <p>เรียน คุณ${user.firstname} ${user.lastname},</p>
                    <p>รหัสชั่วคราวสำหรับเข้าสู่ระบบของคุณคือ:</p>
                    <div style="background:#f0f9ff;border:2px dashed #3b82f6;border-radius:12px;padding:20px;margin:16px 0">
                        <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1d4ed8;font-family:monospace">${tempCode}</span>
                    </div>
                    <p style="color:#dc2626;font-weight:bold;font-size:14px">รหัสนี้จะหมดอายุใน 15 นาที</p>
                    <p style="font-size:13px;color:#6b7280">ใช้รหัสนี้แทนรหัสผ่านเดิมเพื่อเข้าสู่ระบบ<br>ระบบจะบังคับให้เปลี่ยนรหัสผ่านใหม่ทันที</p>
                    <p style="color:#9ca3af;font-size:11px;margin-top:24px">หากคุณไม่ได้ขอรีเซ็ตรหัสผ่าน กรุณาเพิกเฉยอีเมลนี้<br>อีเมลฉบับนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ</p>
                </div>
            </div>`
        );

        await saveLog(username, 'forgot_password', `ส่งรหัสชั่วคราวไปที่ ${emailMask}`, ip);
        res.json({ success: true, message: `ส่งรหัสชั่วคราว 6 หลักไปที่ ${emailMask} แล้ว กรุณาตรวจสอบ Email`, email_masked: emailMask });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
    }
});

// === ลงทะเบียนผู้ใช้งานใหม่ (Public - ไม่ต้อง login) ===
apiRouter.post('/register', loginIpLimiter, loginLimiter, async (req, res) => {
    const { username, password, firstname, lastname, hospcode, phone, email, dept_id, cid, role: reqRole, thaid_reg_token } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        // ตรวจสอบข้อมูลครบถ้วน — ถ้ามี thaid_reg_token ไม่ต้องการ cid (ได้มาจาก ThaiD แล้ว)
        const needCid = !thaid_reg_token;
        if (!username || !password || !firstname || !lastname || !hospcode || !phone || !dept_id || (needCid && !cid)) {
            return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบทุกช่อง' });
        }

        // ตรวจสอบ username ขั้นต่ำ 6 ตัวอักษร + เฉพาะ a-z, A-Z, 0-9, อักขระพิเศษ
        if (username.length < 6) {
            return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้งานต้องมีอย่างน้อย 6 ตัวอักษร' });
        }
        if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(username)) {
            return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้งานต้องเป็น a-z, A-Z, 0-9 หรืออักขระพิเศษเท่านั้น' });
        }

        // ตรวจสอบ email (ถ้ากรอก)
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ success: false, message: 'รูปแบบอีเมลไม่ถูกต้อง' });
        }

        // === กำหนด cid hash: จาก ThaiD reg token หรือ กรอกเอง ===
        let hashedCidCheck;
        if (thaid_reg_token) {
            // ลงทะเบียนผ่าน ThaiD — ดึง cid_hash จาก map (ข้าม 13-หลัก validation)
            const regEntry = _thaidRegMap.get(String(thaid_reg_token));
            if (!regEntry || regEntry.expires < Date.now()) {
                _thaidRegMap.delete(String(thaid_reg_token));
                return res.status(400).json({ success: false, message: 'Token ThaiD หมดอายุ กรุณาสแกน QR ใหม่' });
            }
            hashedCidCheck = regEntry.cid_hash;
            _thaidRegMap.delete(String(thaid_reg_token)); // one-time use
        } else {
            // ลงทะเบียนด้วยตัวเอง — ตรวจสอบ cid 13 หลัก + Check Digit (Modulus 11)
            if (!/^\d{13}$/.test(cid)) {
                return res.status(400).json({ success: false, message: 'เลขบัตรประชาชนต้องเป็นตัวเลข 13 หลัก' });
            }
            const digits = cid.split('').map(Number);
            let sum = 0;
            for (let i = 0; i < 12; i++) sum += digits[i] * (13 - i);
            const checkDigit = (11 - (sum % 11)) % 10;
            if (checkDigit !== digits[12]) {
                return res.status(400).json({ success: false, message: 'เลขบัตรประชาชนไม่ผ่านการตรวจสอบ Check Digit (Modulus 11)' });
            }
            hashedCidCheck = crypto.createHash('sha256').update(cid).digest('hex');
        }

        // ตรวจสอบ cid ซ้ำ (hash แล้วเทียบกับ DB)
        const [existingCid] = await db.query('SELECT id, is_approved FROM users WHERE cid = ?', [hashedCidCheck]);
        if (existingCid.length > 0) {
            if (existingCid[0].is_approved === -1) {
                // ถูกปฏิเสธ → ลบ account เก่าแล้วให้สมัครใหม่ได้ (ยกเว้นบัญชีที่เคยบันทึกผลงานไว้ — ห้ามลบ ผลงานจะหาย)
                if (await countUserKpiResults(existingCid[0].id) > 0) {
                    return res.status(400).json({ success: false, message: 'บัญชีเดิมของท่านมีผลงานที่บันทึกไว้ในระบบ ไม่สามารถลงทะเบียนใหม่ทับได้ กรุณาติดต่อผู้ดูแลระบบ' });
                }
                await db.query('DELETE FROM users WHERE id = ?', [existingCid[0].id]);
                await cleanupPendingApprovalNotifications(existingCid[0].id);
            } else {
                return res.status(400).json({ success: false, message: 'เลขบัตรประชาชนนี้ถูกลงทะเบียนไปแล้ว' });
            }
        }

        // role ที่อนุญาตให้เลือกได้ (ไม่รวม super_admin)
        const allowedRoles = ['user_hos', 'user_sso', 'user_cup', 'user_ssj', 'admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj'];
        const finalRole = allowedRoles.includes(reqRole) ? reqRole : 'user_hos';

        // ตรวจสอบ password ขั้นต่ำ 6 ตัวอักษร + ครบทุกประเภท
        if (password.length < 6) return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
        if (!/[a-z]/.test(password)) return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีตัวอักษรพิมพ์เล็ก (a-z) อย่างน้อย 1 ตัว' });
        if (!/[A-Z]/.test(password)) return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีตัวอักษรพิมพ์ใหญ่ (A-Z) อย่างน้อย 1 ตัว' });
        if (!/[0-9]/.test(password)) return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีตัวเลข (0-9) อย่างน้อย 1 ตัว' });
        if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) return res.status(400).json({ success: false, message: 'รหัสผ่านต้องมีอักขระพิเศษอย่างน้อย 1 ตัว' });
        if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(password)) {
            return res.status(400).json({ success: false, message: 'รหัสผ่านมีอักขระที่ไม่อนุญาต' });
        }

        // ตรวจสอบเบอร์โทร 10 หลัก
        const cleanPhone = phone.replace(/\D/g, '');
        if (cleanPhone.length !== 10) {
            return res.status(400).json({ success: false, message: 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก' });
        }

        // ตรวจสอบ username ซ้ำ
        const [existing] = await db.query('SELECT id, is_approved FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            if (existing[0].is_approved === -1) {
                // ถูกปฏิเสธ → ลบ account เก่า (ยกเว้นบัญชีที่เคยบันทึกผลงานไว้ — ห้ามลบ ผลงานจะหาย)
                if (await countUserKpiResults(existing[0].id) > 0) {
                    return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้งานนี้มีผลงานที่บันทึกไว้ในระบบ ไม่สามารถลงทะเบียนใหม่ทับได้ กรุณาติดต่อผู้ดูแลระบบ' });
                }
                await db.query('DELETE FROM users WHERE id = ?', [existing[0].id]);
                await cleanupPendingApprovalNotifications(existing[0].id);
            } else {
                return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้งานนี้ถูกใช้แล้ว กรุณาเปลี่ยนชื่อผู้ใช้งาน' });
            }
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // CID hash: ใช้จาก ThaiD token (หาก login ด้วย ThaiD) หรือ hash ตัวเอง
        const hashedCid = thaid_reg_token ? hashedCidCheck : (cid ? crypto.createHash('sha256').update(cid).digest('hex') : null);

        // บันทึกผู้ใช้ is_approved = 0 (รอการอนุมัติ)
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, role, dept_id, firstname, lastname, hospcode, phone, email, cid, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
            [username, hashedPassword, finalRole, dept_id || null, firstname, lastname, hospcode, cleanPhone, email || null, hashedCid]
        );

        // บันทึก log
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [result.insertId, dept_id || null, 'INSERT', 'users', result.insertId, JSON.stringify({ username, role: finalRole, action: 'self_register' }), ip]
        );

        // ดึงข้อมูลหน่วยบริการเพื่อแจ้งเตือน
        const [hosRows] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ?', [hospcode]);
        const hosName = hosRows[0]?.hosname || hospcode;
        const roleLabelMap = { user_hos: 'User รพ.', user_sso: 'User รพ.สต.', user_cup: 'User CUP', user_ssj: 'User SSJ', admin_hos: 'Admin รพ.', admin_sso: 'Admin รพ.สต.', admin_cup: 'Admin CUP', admin_ssj: 'Admin SSJ' };
        const roleLabel = roleLabelMap[finalRole] || finalRole;

        // ดึงค่า toggle แจ้งเตือนจาก settings
        const [notifSettings] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('notif_telegram_enabled','notif_email_enabled','notif_system_enabled','notif_line_enabled')");
        const ntfMap = {};
        notifSettings.forEach(r => ntfMap[r.setting_key] = r.setting_value);
        const ntfTelegram = ntfMap['notif_telegram_enabled'] !== 'false';
        const ntfEmail = ntfMap['notif_email_enabled'] !== 'false';
        const ntfSystem = ntfMap['notif_system_enabled'] !== 'false';
        const ntfLine = ntfMap['notif_line_enabled'] !== 'false';

        // แจ้ง super_admin ทุกคน (ถ้าเปิดแจ้งเตือนในระบบ)
        if (ntfSystem) {
            const [superAdmins] = await db.query("SELECT id FROM users WHERE role = 'super_admin' AND is_approved = 1");
            for (const sa of superAdmins) {
                await db.query(
                    "INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)",
                    [sa.id,
                     `ผู้ใช้งานใหม่รอการอนุมัติ`,
                     `${firstname} ${lastname} (${username}) จาก ${hosName} ขอลงทะเบียนในสิทธิ์ ${roleLabel} กรุณาตรวจสอบและอนุมัติ`,
                     result.insertId]
                );
            }
        }

        // สร้าง URL ของ Frontend
        const referer = req.headers['referer'] || req.headers['origin'] || '';
        let baseUrl = process.env.APP_URL || '';
        if (!baseUrl && referer) {
            try { baseUrl = new URL(referer).origin; } catch (e) { baseUrl = ''; }
        }
        if (!baseUrl) baseUrl = 'http://localhost:8881';
        const approveUrl = `${baseUrl.replace(/\/+$/, '')}/khupskpi/login`;

        // แจ้ง Telegram + Email Admin (ตาม toggle)
        notifyAdmins(
            '🆕 ผู้สมัครใหม่รอการอนุมัติ — ระบบ KPI สสจ.นครราชสีมา',
            `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:linear-gradient(135deg,#2563eb,#3b82f6);padding:20px;text-align:center;color:white">
                    <h2 style="margin:0;font-size:18px">🆕 ผู้สมัครใหม่รอการอนุมัติ</h2>
                </div>
                <div style="padding:20px">
                    <table style="width:100%;font-size:14px;border-collapse:collapse">
                        <tr><td style="padding:6px 0;color:#6b7280">ชื่อ-นามสกุล</td><td style="font-weight:bold">${firstname} ${lastname}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">Username</td><td style="font-weight:bold">${username}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">สิทธิ์ที่ขอ</td><td style="font-weight:bold">${roleLabel}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">หน่วยบริการ</td><td style="font-weight:bold">${hosName}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">เบอร์โทร</td><td>${cleanPhone}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">Email</td><td>${email || '-'}</td></tr>
                    </table>
                    <div style="text-align:center;margin-top:20px">
                        <a href="${approveUrl}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#16a34a,#22c55e);color:white;font-weight:bold;font-size:14px;text-decoration:none;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.15)">
                            🔑 เข้าสู่ระบบเพื่ออนุมัติ
                        </a>
                    </div>
                </div>
            </div>`,
            `🆕 ผู้สมัครใหม่รอการอนุมัติ\n━━━━━━━━━━━━━━━\n👤 ${firstname} ${lastname}\n🔑 Username: ${username}\n🏥 ${hosName}\n📋 สิทธิ์: ${roleLabel}\n📱 โทร: ${cleanPhone}\n📧 Email: ${email || '-'}\n━━━━━━━━━━━━━━━\n🔑 เข้าสู่ระบบ: ${approveUrl}`,
            { telegram: ntfTelegram, email: ntfEmail, line: ntfLine }
        );

        await saveLog(username, 'register_success', 'ลงทะเบียนผู้ใช้งานใหม่ — รอการอนุมัติ', ip);
        res.json({ success: true, message: 'ลงทะเบียนสำเร็จ กรุณารอการอนุมัติจากผู้ดูแลระบบก่อนเข้าสู่ระบบ' });
    } catch (error) {
        console.error('Register Error:', error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' });
    }
});

// === Public endpoints สำหรับหน้าลงทะเบียน (ไม่ต้อง login) ===
apiRouter.get('/public/departments', async (req, res) => {
    try {
        const [depts] = await db.query('SELECT * FROM departments ORDER BY dept_name');
        res.json({ success: true, data: depts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/public/hospitals', async (req, res) => {
    try {
        const [hospitals] = await db.query("SELECT hoscode, hosname, hostype, CONCAT(provcode, distcode) as distid FROM chospital ORDER BY FIELD(hostype,'05','06','07','18'), hosname");
        res.json({ success: true, data: hospitals });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/public/districts', async (req, res) => {
    try {
        const [districts] = await db.query('SELECT distid, distname FROM co_district WHERE distid LIKE ? ORDER BY distname', ['30%']);
        res.json({ success: true, data: districts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// /public/kpi-results และ /public/dashboard-stats ถูกลบแล้ว (7 ต.ค. 2569) — เดิมเปิดให้ดูผลงานทุกหน่วยบริการ
// โดยไม่ต้อง login และไม่ผ่าน rate limit (query ทั้งตาราง kpi_results ทุกครั้ง) — ผู้ใช้ยืนยันว่าไม่ต้องการหน้าสาธารณะ
// ห้ามเพิ่ม endpoint ข้อมูลผลงานแบบไม่ต้อง login กลับมาอีก

// ใช้ apiLimiter กับ Route ที่เหลือทั้งหมด (ป้องกันการยิง API รัวๆ)
apiRouter.use(apiLimiter);

apiRouter.get('/kpi-results', authenticateToken, async (req, res) => {
    try {
        const user = req.user;

        let whereClause = '';
        let params = [];

        // === Role-based KPI visibility ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            // เห็นทุก hospcode แต่เฉพาะหน่วยงานตัวเอง
            if (user.deptId != null) { whereClause = 'WHERE i.dept_id = ?'; params.push(user.deptId); }
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
            // admin_cup / user_cup: ทุกตัวชี้วัด ทุก hospcode ในอำเภอ
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                whereClause = 'WHERE h.distid = ?';
                params.push(distid);
                // user_cup เห็นเฉพาะ dept ตัวเอง, admin_cup เห็นทุก dept
                if (user.role === 'user_cup' && user.deptId != null) {
                    whereClause += ' AND i.dept_id = ?'; params.push(user.deptId);
                }
            } else {
                whereClause = 'WHERE r.hospcode = ?'; params.push(user.hospcode);
            }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            // admin_hos / admin_sso: ทุก dept แต่เฉพาะ hospcode ตัวเอง
            if (user.hospcode) { whereClause = 'WHERE r.hospcode = ?'; params.push(user.hospcode); }
        } else {
            // user_hos / user_sso / user_ssj: hospcode + dept ตัวเอง
            const conditions = [];
            if (user.hospcode) { conditions.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { conditions.push('i.dept_id = ?'); params.push(user.deptId); }
            if (conditions.length > 0) whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        // === กรอง year + ตัวกรองเพิ่มเติมจาก query params ===
        // รองรับ comma-separated (multi) ใช้ IN (...)
        const extraConditions = [];
        const addMultiFilter = (column, value) => {
            if (!value) return;
            const list = String(value).split(',').map(v => v.trim()).filter(Boolean);
            if (list.length === 0) return;
            if (list.length === 1) { extraConditions.push(`${column} = ?`); params.push(list[0]); }
            else { extraConditions.push(`${column} IN (${list.map(() => '?').join(',')})`); params.push(...list); }
        };
        extraConditions.push('i.is_active = 1'); // แสดงเฉพาะตัวชี้วัดที่เปิดใช้งาน
        if (req.query.year) { extraConditions.push('r.year_bh = ?'); params.push(req.query.year); }
        addMultiFilter('r.hospcode', req.query.hospcode);
        addMultiFilter('d.dept_name', req.query.dept);
        addMultiFilter('dist.distname', req.query.district);
        if (req.query.indicator) { extraConditions.push('i.kpi_indicators_name = ?'); params.push(req.query.indicator); }
        if (req.query.main) { extraConditions.push('mi.main_indicator_name = ?'); params.push(req.query.main); }
        // Hostype filter: filter h.hostype โดยตรง (LEFT JOIN chospital จาก main query)
        addMultiFilter('h.hostype', req.query.hostype);
        // Indicator off-type filter: กรองตัวชี้วัดตาม required_off_types (JSON array)
        // all_required = ใช้ทุกประเภท จึงแสดงเสมอ
        if (req.query.indicator_off_type) {
            const list = String(req.query.indicator_off_type).split(',').map(v => v.trim()).filter(Boolean);
            if (list.length > 0) {
                const likeConds = list.map(() => 'i.required_off_types LIKE ?').join(' OR ');
                extraConditions.push(`(i.evaluation_mode = 'all_required' OR ${likeConds})`);
                for (const code of list) params.push(`%"${code}"%`);
            }
        }
        let extraWhere = '';
        if (extraConditions.length > 0) {
            extraWhere = (whereClause ? ' AND ' : 'WHERE ') + extraConditions.join(' AND ');
        }

        // === Pre-load form schemas + appeal counts เป็น batch (ลด N+1 subquery) ===
        const [formSchemas] = await db.query('SELECT indicator_id FROM kpi_form_schemas WHERE is_active = 1');
        const formSchemaSet = new Set(formSchemas.map((f) => f.indicator_id));

        // ใช้ MIN()/MAX() wrap คอลัมน์ที่ functionally dependent เพื่อให้ GROUP BY มีแค่ 3 cols
        // (i.id, r.year_bh, r.hospcode) — เร็วกว่า GROUP BY 18 cols เดิมมาก
        const sql = `
            SELECT
                IFNULL(MIN(mi.main_indicator_name), 'ยังไม่กำหนด') AS main_indicator_name,
                MIN(i.kpi_indicators_name) AS kpi_indicators_name,
                r.year_bh,
                i.id AS indicator_id,
                MIN(d.dept_name) AS dept_name,
                MAX(r.target_value) AS target_value,
                MAX(CASE WHEN r.month_bh = 10 THEN r.actual_value END) AS oct,
                MAX(CASE WHEN r.month_bh = 11 THEN r.actual_value END) AS nov,
                MAX(CASE WHEN r.month_bh = 12 THEN r.actual_value END) AS dece,
                MAX(CASE WHEN r.month_bh = 1  THEN r.actual_value END) AS jan,
                MAX(CASE WHEN r.month_bh = 2  THEN r.actual_value END) AS feb,
                MAX(CASE WHEN r.month_bh = 3  THEN r.actual_value END) AS mar,
                MAX(CASE WHEN r.month_bh = 4  THEN r.actual_value END) AS apr,
                MAX(CASE WHEN r.month_bh = 5  THEN r.actual_value END) AS may,
                MAX(CASE WHEN r.month_bh = 6  THEN r.actual_value END) AS jun,
                MAX(CASE WHEN r.month_bh = 7  THEN r.actual_value END) AS jul,
                MAX(CASE WHEN r.month_bh = 8  THEN r.actual_value END) AS aug,
                MAX(CASE WHEN r.month_bh = 9  THEN r.actual_value END) AS sep,
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count,
                MAX(r.status) AS indicator_status,
                MAX(CASE WHEN r.is_locked = 1 THEN 1 ELSE 0 END) AS is_locked,
                MIN(i.table_process) AS table_process,
                MIN(i.criterion) AS criterion,
                MIN(i.target_condition) AS target_condition, -- เงื่อนไขเป้าหมาย ≥ > ≤ < = (ร้อยละ/ผ่านเกณฑ์ในหน้าบันทึกผลงาน) — เดิมไม่ได้ส่งมา 22 ต.ค. 2569
                MIN(i.data_source) AS data_source,
                MIN(i.khd_report_id) AS khd_report_id,
                MIN(i.item_no) AS item_no,
                MIN(i.sub_rollup_mode) AS sub_rollup_mode,
                MAX(i.r9) AS r9, MAX(i.moph) AS moph, MAX(i.ssj) AS ssj, MAX(i.rmw) AS rmw, MAX(i.other) AS other,
                MIN(i.evaluation_mode) AS evaluation_mode,
                MIN(i.required_off_types) AS required_off_types,
                MAX(i.is_cumulative) AS is_cumulative,
                MIN(i.result_formula) AS result_formula,
                MIN(i.custom_vars) AS custom_vars, -- ค่าเพิ่มเติมที่ตั้งชื่อเอง [{key,label}] (25 ต.ค. 2569)
                MIN(i.pct_formula) AS pct_formula, -- สูตรร้อยละ (ว่าง = ตามเงื่อนไขเป้าหมาย)
                r.hospcode,
                MIN(h.hosname) AS hosname,
                MIN(h.hostype) AS hostype,
                MIN(ht.hostypename) AS hostypename,
                MIN(dist.distname) AS distname
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN chostype ht ON h.hostype = ht.hostypecode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            ${whereClause}${extraWhere}
            GROUP BY i.id, r.year_bh, r.hospcode
            ORDER BY r.year_bh DESC, MIN(mi.main_indicator_name), MIN(i.kpi_indicators_name), r.hospcode
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);

        // === ข้อมูลปีงบที่แล้ว เฉพาะแถวที่สูตรอ้าง prev_* (โหลดเป็นชุดต่อปีงบ ไม่ใช่ทีละแถว) ===
        const prevRowsByYear = new Map();
        for (const row of rows) {
            const f = kpiFormula.activeFormula(row);
            if (!f || !formulaOk(row, f) || !kpiFormula.usesPrevYear(f)) continue;
            if (!prevRowsByYear.has(row.year_bh)) prevRowsByYear.set(row.year_bh, []);
            prevRowsByYear.get(row.year_bh).push(row);
        }
        const prevByYear = new Map();
        for (const [yb, list] of prevRowsByYear) {
            prevByYear.set(yb, await loadPrevYearData(db, list.map(r => r.indicator_id), yb, list.map(r => r.hospcode)));
        }
        // === ค่าฐาน/ค่าเพิ่มเติม เฉพาะตัวชี้วัดที่ใช้ — แนบ row.cv_<key> (+ base_value) ให้หน้าบันทึกผลงานแสดง/แก้ไข/คำนวณร้อยละ ===
        const baseRows = rows.filter(needsCustomValues);
        const baseMap = baseRows.length ? await loadBaseValues(db, baseRows.map(r => r.indicator_id), baseRows.map(r => r.year_bh)) : new Map();

        // === คำนวณ last_actual + appeal + has_form ฝั่ง JS (เร็วกว่า subquery) ===
        const monthOrder = [10,11,12,1,2,3,4,5,6,7,8,9];
        const monthKeys = ['oct','nov','dece','jan','feb','mar','apr','may','jun','jul','aug','sep'];
        for (const row of rows) {
            const isCumulative = Number(row.is_cumulative) === 1;
            const formula = kpiFormula.activeFormula(row);
            let lastVal = null;
            // ค่าเพิ่มเติมของคู่นี้ (base + ที่ประกาศไว้ + ที่สูตรอ้าง) — แนบทุกแถวของตัวชี้วัดที่ใช้ เพื่อให้กรอกได้แม้ยังไม่มีค่า
            let cvals;
            if (needsCustomValues(row)) {
                cvals = baseMap.get(baseKey(row.indicator_id, row.year_bh, row.hospcode)) || {};
                const keys = new Set(['base', ...varKeysOf(row), ...(formula ? kpiFormula.formulaVarNames(formula) : [])]);
                for (const k of keys) row['cv_' + k] = cvals[k] ?? null;
                row.base_value = cvals.base ?? null;
            }
            if (formula && formulaOk(row, formula)) {
                // ตัวชี้วัดที่ตั้งสูตรคำนวณผลงาน — ใช้สูตรแทน is_cumulative / ค่าเดือนล่าสุด
                // สูตรอ้างปีที่แล้ว → แนบ prev_year ให้ frontend คำนวณซ้ำได้ตรงกันตอนแก้ไขค่า (โหมดแก้ไข)
                const pm = prevByYear.get(row.year_bh);
                const prev = pm ? (pm.get(`${row.indicator_id}|${String(row.hospcode).trim()}`) || { year_bh: String(parseInt(row.year_bh, 10) - 1), months: null, target: null, result: null }) : undefined;
                if (prev) row.prev_year = prev;
                lastVal = kpiFormula.evaluateFormula(formula, row, row.target_value, prev, cvals);
            } else if (isCumulative) {
                // ตัวชี้วัดสะสม: รวมค่าตัวเลขทุกเดือนที่มีข้อมูล (ไม่ sum ถ้าไม่มีเดือนไหนมีค่าเลย → คง null)
                const numericVals = monthKeys.map(k => row[k]).filter(v => v != null && String(v).trim() !== '' && !isNaN(parseFloat(v)));
                lastVal = numericVals.length > 0 ? String(numericVals.reduce((s, v) => s + parseFloat(v), 0)) : null;
            } else {
                // last_actual: หาเดือนล่าสุดที่มีค่า
                for (let m = monthKeys.length - 1; m >= 0; m--) {
                    const v = row[monthKeys[m]];
                    if (v != null && String(v).trim() !== '' && String(v).trim() !== '0') { lastVal = v; break; }
                }
            }
            row.last_actual = lastVal;
            row.has_form_schema = formSchemaSet.has(row.indicator_id) ? 1 : 0;
            row.appeal_approved = 0; // จะ load แยกถ้าจำเป็น
        }

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูล KPI ได้' });
    }
});


// GET /bulk-add-kpi/preview — ตรวจสอบก่อนเพิ่ม KPI ทั้งหมด
apiRouter.get('/bulk-add-kpi/preview', authenticateToken, isAdmin, async (req, res) => {
    const year_bh = req.query.year;
    const dept_id = req.query.dept_id;
    if (!year_bh) return res.status(400).json({ success: false, message: 'กรุณาเลือกปีงบประมาณ' });
    try {
        let indWhere = 'WHERE is_active = 1';
        const indParams = [];
        const filterDeptId = req.user.role === 'admin_ssj' ? req.user.deptId : (dept_id || null);
        if (filterDeptId) { indWhere += ' AND dept_id = ?'; indParams.push(filterDeptId); }
        const [indicators] = await db.query(`SELECT id, evaluation_mode, required_off_types FROM kpi_indicators ${indWhere}`, indParams);
        const [hospitals] = await db.query("SELECT hoscode, hostype FROM chospital WHERE hostype IN ('05','06','07','18')");
        const [existing] = await db.query('SELECT indicator_id, hospcode FROM kpi_results WHERE year_bh = ? GROUP BY indicator_id, hospcode', [year_bh]);
        const existSet = new Set(existing.map(r => `${r.indicator_id}_${r.hospcode}`));

        // นับ totalPossible/toAdd จริงต่อตัวชี้วัด (กรองตาม hostype ที่ใช้ได้ของแต่ละตัว) ให้ตรงกับที่จะ insert จริง
        let totalPossible = 0, toAdd = 0;
        for (const ind of indicators) {
            const allowedTypes = resolveIndicatorHostypes(ind);
            for (const hos of hospitals) {
                if (!allowedTypes.has(String(hos.hostype))) continue;
                totalPossible++;
                if (!existSet.has(`${ind.id}_${hos.hoscode}`)) toAdd++;
            }
        }
        res.json({
            success: true,
            indicatorCount: indicators.length,
            hospitalCount: hospitals.length,
            existingCount: existing.length,
            totalPossible,
            toAdd,
            year_bh
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /bulk-add-kpi — super_admin/admin_ssj เพิ่ม KPI ทุกหน่วยบริการทีเดียว
apiRouter.post('/bulk-add-kpi', authenticateToken, isAdmin, async (req, res) => {
    const { year_bh, dept_id } = req.body;
    if (!year_bh) return res.status(400).json({ success: false, message: 'กรุณาเลือกปีงบประมาณ' });
    try {
        // admin_ssj → กรองเฉพาะ dept ตัวเอง, super_admin → ทั้งหมดหรือตาม dept_id
        let indWhere = 'WHERE is_active = 1';
        const indParams = [];
        const filterDeptId = req.user.role === 'admin_ssj' ? req.user.deptId : (dept_id || null);
        if (filterDeptId) { indWhere += ' AND dept_id = ?'; indParams.push(filterDeptId); }
        const [indicators] = await db.query(`SELECT id, target_percentage, evaluation_mode, required_off_types FROM kpi_indicators ${indWhere}`, indParams);
        // ดึงเฉพาะ รพ., สสอ., รพ.สต. (hostype 05,06,07,18) — กรองแคบลงต่อตัวชี้วัดด้วย resolveIndicatorHostypes() ด้านล่าง
        const [hospitals] = await db.query("SELECT hoscode, hostype FROM chospital WHERE hostype IN ('05','06','07','18')");
        if (indicators.length === 0) return res.json({ success: true, message: 'ไม่มีตัวชี้วัดที่ active', inserted: 0, skipped: 0 });
        if (hospitals.length === 0) return res.json({ success: true, message: 'ไม่มีหน่วยบริการในระบบ', inserted: 0, skipped: 0 });

        // ดึง kpi_results ที่มีอยู่แล้วสำหรับปีนี้ → สร้าง Set เพื่อเช็คซ้ำเร็ว
        const [existing] = await db.query('SELECT indicator_id, hospcode FROM kpi_results WHERE year_bh = ? GROUP BY indicator_id, hospcode', [year_bh]);
        const existSet = new Set(existing.map(r => `${r.indicator_id}_${r.hospcode}`));

        let inserted = 0, skipped = 0;
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const ind of indicators) {
                const allowedTypes = resolveIndicatorHostypes(ind);
                const hospsForThisIndicator = hospitals.filter(h => allowedTypes.has(String(h.hostype)));
                for (const hos of hospsForThisIndicator) {
                    const key = `${ind.id}_${hos.hoscode}`;
                    if (existSet.has(key)) { skipped++; continue; }
                    // สร้าง 12 records (เดือน 10-9)
                    const months = [10,11,12,1,2,3,4,5,6,7,8,9];
                    const targetVal = ind.target_percentage != null ? String(ind.target_percentage) : null;
                    for (const month of months) {
                        await connection.query(
                            'INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id) VALUES (?,?,?,?,?,NULL,?,?)',
                            [ind.id, year_bh, hos.hoscode, month, targetVal, 'Pending', req.user.userId]
                        );
                    }
                    inserted++;
                }
            }
            await connection.query(
                'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
                [req.user.userId, 'BULK_ADD_KPI', 'kpi_results', JSON.stringify({ year_bh, indicators: indicators.length, hospitals: hospitals.length, inserted, skipped }), req.ip]
            );
            await connection.commit();
        } catch (e) { await connection.rollback(); throw e; }
        finally { connection.release(); }

        res.json({
            success: true,
            message: `เพิ่ม KPI สำเร็จ`,
            inserted, skipped,
            totalRecords: inserted * 12,
            indicatorCount: indicators.length,
            hospitalCount: hospitals.length,
            year_bh
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /kpi-results/bulk-delete — ลบ kpi_results + kpi_sub_results ตาม triplet
// body: { items: [{ indicator_id, year_bh, hospcode }, ...] }
apiRouter.post('/kpi-results/bulk-delete', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีรายการที่จะลบ' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        let deletedKpi = 0, deletedSub = 0;
        for (const it of items) {
            const { indicator_id, year_bh, hospcode } = it;
            if (!indicator_id || !year_bh || !hospcode) continue;
            // ลบ kpi_sub_results ที่ sub_indicator อยู่ใน kpi_indicators นี้
            const [subRes] = await connection.query(
                `DELETE sr FROM kpi_sub_results sr
                 JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode = ?`,
                [indicator_id, year_bh, hospcode]
            );
            deletedSub += subRes.affectedRows || 0;
            const [actRes] = await connection.query(
                `DELETE ar FROM kpi_activity_results ar
                 JOIN kpi_sub_activities a ON ar.activity_id = a.id
                 JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode = ?`,
                [indicator_id, year_bh, hospcode]
            );
            deletedSub += actRes.affectedRows || 0;
            // ลบ kpi_results
            const [kpiRes] = await connection.query(
                'DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                [indicator_id, year_bh, hospcode]
            );
            deletedKpi += kpiRes.affectedRows || 0;
            // ลบ kpi_summary ด้วย (ถ้ามี)
            try {
                await connection.query(
                    'DELETE FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                    [indicator_id, year_bh, hospcode]
                );
            } catch (_) {}
        }
        await connection.commit();
        // log
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'BULK_DELETE_KPI', 'kpi_results,kpi_sub_results', JSON.stringify({ count: items.length, deletedKpi, deletedSub }), req.ip]
        ).catch(() => {});
        res.json({ success: true, message: `ลบสำเร็จ — kpi_results ${deletedKpi}, kpi_sub_results ${deletedSub}`, deletedKpi, deletedSub });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally { connection.release(); }
}));

// ========== จัดการข้อมูลผลงานตัวชี้วัด (super_admin) — View + Bulk Delete รายระเบียน ==========
// คนละ endpoint กับ /kpi-results/bulk-delete เดิม (ซึ่งลบทั้งปีของ indicator+hospcode เดียว) — หน้านี้
// ต้องการลบละเอียดถึงระดับ "รายการเดียว" (1 แถว = 1 เดือนจริง) จึงลบด้วย kpi_results.id ตรงๆ

// month_bh encoding ที่ระบบใช้จริงทั้งระบบ: 10,11,12,1,2,...,9 (เลขเดือนปฏิทินจริง, ปีงบเริ่ม ต.ค.=10)
// แปลงเป็นลำดับปีงบ (ต.ค.=1 ... ก.ย.=12) เพื่อใช้เทียบช่วงเดือนที่ผู้ใช้เลือกแบบข้ามปีปฏิทินได้ถูกต้อง
function fiscalMonthOrdinal(monthBh) {
    const m = Number(monthBh);
    return m >= 10 ? m - 9 : m + 3;
}
// คืนรายการ month_bh ทั้งหมดที่อยู่ในช่วงปีงบ [monthFrom, monthTo] (รับค่าเป็น month_bh ปฏิทินทั้งคู่)
function monthBhRangeList(monthFrom, monthTo) {
    const allMonths = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const fromOrd = fiscalMonthOrdinal(monthFrom);
    const toOrd = fiscalMonthOrdinal(monthTo);
    return allMonths.filter(m => {
        const ord = fiscalMonthOrdinal(m);
        return ord >= fromOrd && ord <= toOrd;
    });
}


// GET /kpi-results/manage — list + filter (date_from/date_to บน created_at, year_bh+month_from/month_to บนปีงบ)
// หมายเหตุ perf (สำคัญ): kpi_results มีจริง ~494,066 แถว — คิวรีนี้ "ห้าม JOIN chospital ตรงๆ" เพราะ
// kpi_results.hospcode (varchar utf8mb4_unicode_ci) กับ chospital.hoscode (char utf8mb3_general_ci) ชนิด/
// charset/collation ไม่ตรงกันทั้ง 3 อย่าง (บั๊ก schema เดิมที่มีอยู่ก่อนงานนี้ ไม่ได้เกิดจากโค้ดใหม่) ทำให้ MySQL
// ใช้ index ของ chospital ไม่ได้เลย (แม้ hoscode เป็น PRIMARY KEY) กลายเป็น full scan วัดจริงช้ากว่า 30s —
// แก้โดย query ชื่อหน่วยบริการแยกเฉพาะ hoscode ที่อยู่ในหน้านั้นๆ (≤ limit ต่อหน้า) มา merge ใน JS แทน
apiRouter.get('/kpi-results/manage', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { date_from, date_to, year_bh, month_from, month_to, indicator_id, hospcode, dept_id } = req.query;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        // บังคับต้องมีอย่างน้อย 1 filter เสมอ — กัน query ทั้งตาราง 494K แถวโดยไม่มีเงื่อนไข (ORDER BY + LIMIT
        // ไม่มี WHERE ทำให้ MySQL optimizer เลือก full scan เองไม่ว่าจะเพิ่ม index อะไรก็ตาม — เป็นข้อจำกัดโดย
        // ธรรมชาติของ query แบบนี้ ไม่ใช่แค่เรื่อง index)
        if (!date_from && !date_to && !year_bh) {
            return res.status(400).json({ success: false, message: 'กรุณาเลือกช่วงวันที่หรือปีงบก่อนค้นหา' });
        }

        // แยก WHERE 2 ชุด — ชุดที่ join กับ kpi_indicators (ต้องใช้เมื่อกรอง dept_id) กับชุดที่ไม่ต้อง join
        // (กรอง r.* ล้วนๆ) กัน COUNT(*) ช้าโดยไม่จำเป็นเมื่อไม่ได้กรอง dept_id
        const where = [];
        const params = [];
        if (date_from) { where.push('r.created_at >= ?'); params.push(date_from + ' 00:00:00'); }
        if (date_to) { where.push('r.created_at <= ?'); params.push(date_to + ' 23:59:59'); }
        if (year_bh) { where.push('r.year_bh = ?'); params.push(String(year_bh)); }
        if (month_from && month_to) {
            const months = monthBhRangeList(month_from, month_to);
            where.push(`r.month_bh IN (${months.map(() => '?').join(',')})`);
            params.push(...months);
        }
        if (indicator_id) { where.push('r.indicator_id = ?'); params.push(Number(indicator_id)); }
        if (hospcode) { where.push('r.hospcode = ?'); params.push(String(hospcode)); }
        const needsIndicatorJoin = !!dept_id;
        if (dept_id) { where.push('i.dept_id = ?'); params.push(Number(dept_id)); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [countRows] = await db.query(`
            SELECT COUNT(*) AS total
            FROM kpi_results r
            ${needsIndicatorJoin ? 'JOIN kpi_indicators i ON r.indicator_id = i.id' : ''}
            ${whereSql}
        `, params);

        const [rows] = await db.query(`
            SELECT r.id, r.indicator_id, r.year_bh, r.month_bh, r.hospcode, r.target_value, r.actual_value,
                   r.status, r.is_locked, r.created_at,
                   i.kpi_indicators_name, i.result_formula, i.dept_id, d.dept_name
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN departments d ON d.id = i.dept_id
            ${whereSql}
            ORDER BY r.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        // เติมชื่อหน่วยบริการแยกต่างหาก (ดู comment ด้านบน) — เฉพาะ hoscode ที่ปรากฏในหน้านี้เท่านั้น
        const hoscodes = [...new Set(rows.map(r => r.hospcode).filter(Boolean))];
        let hosMap = new Map();
        if (hoscodes.length > 0) {
            const [hosRows] = await db.query(
                `SELECT hoscode, hosname FROM chospital WHERE hoscode IN (${hoscodes.map(() => '?').join(',')})`,
                hoscodes
            );
            hosMap = new Map(hosRows.map(h => [String(h.hoscode).trim(), h.hosname]));
        }
        const data = rows.map(r => ({ ...r, hosname: hosMap.get(String(r.hospcode).trim()) || null }));

        res.json({ success: true, data, total: countRows[0].total, page, limit });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /kpi-results/manage/bulk-delete — ลบตาม kpi_results.id ตรงๆ (ละเอียดระดับ 1 เดือน/1 แถว)
// hardcode isSuperAdmin ตรงๆ เสมอ (ไม่เข้า PAGE_ACCESS_RULES) ตามกฎ DELETE ทุกตัวของระบบ
apiRouter.post('/kpi-results/manage/bulk-delete', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีรายการที่จะลบ' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const idPlaceholders = ids.map(() => '?').join(',');
        // ดึงข้อมูลแถวที่จะลบไว้ก่อน — ต้องใช้ (indicator_id, year_bh, hospcode, month_bh) ไปลบ kpi_sub_results
        // ที่ตรงกันเป๊ะ และ (indicator_id, year_bh) ไปสั่ง refresh kpi_summary หลังลบเสร็จ
        const [targetRows] = await connection.query(
            `SELECT id, indicator_id, year_bh, hospcode, month_bh FROM kpi_results WHERE id IN (${idPlaceholders})`,
            ids
        );
        if (targetRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ไม่พบรายการที่ระบุ' });
        }

        let deletedSub = 0;
        for (const t of targetRows) {
            const [subRes] = await connection.query(
                `DELETE sr FROM kpi_sub_results sr
                 JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode = ? AND sr.month_bh = ?`,
                [t.indicator_id, t.year_bh, t.hospcode, t.month_bh]
            );
            deletedSub += subRes.affectedRows || 0;
            const [actRes] = await connection.query(
                `DELETE ar FROM kpi_activity_results ar
                 JOIN kpi_sub_activities a ON ar.activity_id = a.id
                 JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode = ? AND ar.month_bh = ?`,
                [t.indicator_id, t.year_bh, t.hospcode, t.month_bh]
            );
            deletedSub += actRes.affectedRows || 0;
        }

        const [kpiRes] = await connection.query(
            `DELETE FROM kpi_results WHERE id IN (${idPlaceholders})`,
            ids
        );

        // recompute kpi_summary เฉพาะ (indicator_id, year_bh) ที่ได้รับผลกระทบ (unique pairs)
        const pairSet = new Map();
        for (const t of targetRows) pairSet.set(`${t.indicator_id}_${t.year_bh}`, { indicator_id: t.indicator_id, year_bh: t.year_bh });
        await refreshKpiSummaryForIndicatorYears(connection, [...pairSet.values()]);

        await connection.commit();
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'BULK_DELETE_KPI_MANAGE', 'kpi_results,kpi_sub_results', JSON.stringify({ count: ids.length, deletedKpi: kpiRes.affectedRows || 0, deletedSub }), req.ip]
        ).catch(() => {});
        res.json({ success: true, message: `ลบสำเร็จ — kpi_results ${kpiRes.affectedRows || 0}, kpi_sub_results ${deletedSub}`, deletedKpi: kpiRes.affectedRows || 0, deletedSub });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally {
        connection.release();
    }
}));

// authenticateToken: เดิม route นี้ verify JWT เองอย่างเดียว ข้ามการตรวจ single session — ผู้ใช้ที่ถูกบังคับ logout
// หรือ login ซ้อนจากเครื่องอื่นแล้ว ยังบันทึกผลงานด้วย token เก่าได้จนหมดอายุ (8 ชม.) — ต้องผ่าน middleware กลางเสมอ
apiRouter.post('/update-kpi', authenticateToken, async (req, res) => {
    let updates = req.body;
    if (req.body && req.body.updates && Array.isArray(req.body.updates)) {
        updates = req.body.updates;
    }
    const targetHospcode = req.body.targetHospcode;
    // mode: 'setup_overwrite' = KPI-Setup เพิ่มทั้งหมด (เขียนทับ, บันทึก 0 ได้)
    //        'setup_insert_new' = KPI-Setup เพิ่มเฉพาะที่ยังไม่มี (บันทึก 0 ได้)
    //        undefined/default = Dashboard ปกติ (ข้าม row ที่ค่า 0 ทั้งหมด)
    const saveMode = req.body.mode || 'default';

    const user = req.user; // ผ่าน authenticateToken แล้ว (JWT + single session)

    const hospcodeToSave = (ROLE_ADMIN_ALL.includes(user.role) && targetHospcode) ? targetHospcode : user.hospcode;

    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' });
    }

    // ผู้ดูแลที่ระบุหน่วยบริการรายแถวครบทุกแถว (เพิ่มตัวชี้วัดให้หลายหน่วยบริการในคำขอเดียว) ไม่ต้องมี targetHospcode
    const everyRowHasHospcode = ROLE_ADMIN_ALL.includes(user.role) && updates.every(r => r && r.hospcode);
    if (!hospcodeToSave && !everyRowHasHospcode) {
        return res.status(400).json({ success: false, message: 'ไม่พบรหัสหน่วยบริการ กรุณาเลือกหน่วยบริการ' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Admin ทุกระดับเพิ่มตัวชี้วัดทุก dept ได้, User ต้องเป็น dept ตัวเอง
        if (!ROLE_ADMIN_ALL.includes(user.role)) {
            const indicatorIds = [...new Set(updates.map(u => u.indicator_id))];
            if (indicatorIds.length > 0) {
                const [allowed] = await connection.query(
                    'SELECT id FROM kpi_indicators WHERE id IN (?) AND dept_id = ?',
                    [indicatorIds, user.deptId]
                );
                const allowedIds = allowed.map(a => a.id);
                const unauthorizedIds = indicatorIds.filter(id => !allowedIds.includes(id));
                if (unauthorizedIds.length > 0) throw new Error('ไม่มีสิทธิ์แก้ไขข้อมูลหน่วยงานอื่น');
            }
        }

        const months = [
            { col: 'oct', val: 10 }, { col: 'nov', val: 11 }, { col: 'dece', val: 12 },
            { col: 'jan', val: 1 }, { col: 'feb', val: 2 }, { col: 'mar', val: 3 },
            { col: 'apr', val: 4 }, { col: 'may', val: 5 }, { col: 'jun', val: 6 },
            { col: 'jul', val: 7 }, { col: 'aug', val: 8 }, { col: 'sep', val: 9 }
        ];

        // สร้าง uniqueKeys สำหรับใช้ทั้ง lock check + insert/update
        const uniqueKeys = [...new Set(updates.map(row => {
            const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
            return `${row.indicator_id}_${row.year_bh}_${hc}`;
        }))];

        // --- Mode: setup_insert_new → เพิ่มเฉพาะคู่ (ตัวชี้วัด × หน่วยบริการ × ปีงบ) ที่ยังไม่มี ---
        // ทำก่อนลูปตรวจล็อค/คงค่าเดิมรายคู่ด้านล่าง: โหมดนี้ไม่แตะแถวที่มีอยู่ (รวมแถวที่ล็อค = ข้ามเฉยๆ ไม่ทำให้ทั้งคำขอล้ม)
        // และรองรับหลายหน่วยบริการในคำขอเดียว (หน้าต่างเพิ่มตัวชี้วัดหาปลายทางอัตโนมัติจากประเภทหน่วยบริการ — 19 ต.ค. 2569)
        if (saveMode === 'setup_insert_new') {
            const rowHc = (row) => String((ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave).trim();
            const hcs = [...new Set(updates.map(rowHc).filter(Boolean))];
            const indIds = [...new Set(updates.map(r => Number(r.indicator_id)).filter(Boolean))];
            const years = [...new Set(updates.map(r => String(r.year_bh || '')).filter(Boolean))];
            if (indIds.length === 0 || years.length === 0) throw new Error('ข้อมูลไม่ครบ');
            const [hosRows] = hcs.length ? await connection.query('SELECT hoscode, hostype, distid FROM chospital WHERE hoscode IN (?)', [hcs]) : [[]];
            const hosMap = new Map(hosRows.map(h => [String(h.hoscode).trim(), h]));

            // ขอบเขตหน่วยบริการปลายทางตามบทบาท (เดิมไม่ตรวจ — admin_cup ส่งรหัสหน่วยบริการอำเภออื่นได้)
            let outOfScope = [];
            if (ROLE_SCOPE_HOSPCODE.includes(user.role)) {
                outOfScope = hcs.filter(hc => hc !== String(user.hospcode || '').trim());
            } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
                const myDist = await getDistrictId(user.hospcode);
                outOfScope = hcs.filter(hc => !myDist || String(hosMap.get(hc)?.distid || '') !== String(myDist));
            }
            if (outOfScope.length > 0) {
                await connection.rollback();
                return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เพิ่มตัวชี้วัดให้หน่วยบริการนอกขอบเขตของท่าน: ' + outOfScope.slice(0, 5).join(', ') });
            }

            // คู่ที่มีอยู่แล้ว — query เดียว (เดิม 1 query ต่อคู่)
            const [existRows] = await connection.query(
                'SELECT DISTINCT indicator_id, year_bh, hospcode FROM kpi_results WHERE indicator_id IN (?) AND year_bh IN (?) AND hospcode IN (?)',
                [indIds, years, hcs.length ? hcs : ['']]
            );
            const existingKeys = new Set(existRows.map(r => r.indicator_id + '_' + r.year_bh + '_' + String(r.hospcode).trim()));
            const [indRows] = await connection.query('SELECT id, evaluation_mode, required_off_types FROM kpi_indicators WHERE id IN (?)', [indIds]);
            const indMap = new Map(indRows.map(i => [Number(i.id), i]));

            const seen = new Set();
            const newUpdates = [];
            let skipped = 0, skippedType = 0, skippedUnset = 0;
            for (const row of updates) {
                const hc = rowHc(row);
                const key = Number(row.indicator_id) + '_' + row.year_bh + '_' + hc;
                if (existingKeys.has(key) || seen.has(key)) { skipped++; continue; }
                const ind = indMap.get(Number(row.indicator_id));
                // ยังไม่ได้ตั้งประเภทหน่วยบริการ → เพิ่มไม่ได้ ต้องตั้งค่าที่หน้าจัดการตัวชี้วัดก่อน
                if (indicatorTypeSetting(ind) === 'unset') { skippedUnset++; continue; }
                const ht = hosMap.get(hc)?.hostype;
                if (ht && !indicatorAllowsHostype(ind, ht)) { skippedType++; continue; }
                seen.add(key);
                newUpdates.push({ ...row, _hc: hc });
            }

            if (newUpdates.length === 0) {
                await connection.commit();
                const why = [skipped ? 'มีอยู่แล้ว ' + skipped : '', skippedType ? 'ไม่ตรงประเภทหน่วยบริการ ' + skippedType : '', skippedUnset ? 'ตัวชี้วัดยังไม่ได้ตั้งประเภทหน่วยบริการ ' + skippedUnset : ''].filter(Boolean).join(', ');
                return res.json({ success: true, message: 'ไม่มีตัวชี้วัดใหม่ที่ต้องเพิ่ม' + (why ? ' (' + why + ')' : ''), inserted: 0, skipped, skipped_type: skippedType, skipped_unset: skippedUnset });
            }

            // INSERT เฉพาะคู่ใหม่ ครบ 12 เดือน (บันทึก 0 ได้) — แบ่งชุดกันคำสั่งยาวเกิน
            const insertRows = [];
            for (const row of newUpdates) {
                const rawTarget = row.target_value;
                const targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? String(rawTarget).trim() : '';
                for (const m of months) {
                    const rawActual = row[m.col];
                    const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? String(rawActual).trim() : '';
                    insertRows.push([row.indicator_id, row.year_bh, m.val, actualValue, targetValue, user.userId, 'Pending', row._hc, 0]);
                }
            }
            for (let i = 0; i < insertRows.length; i += 2400) {
                await connection.query(
                    'INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked) VALUES ?',
                    [insertRows.slice(i, i + 2400)]
                );
            }

            await connection.query(
                'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
                [user.userId, user.deptId || 0, 'INSERT', 'kpi_results',
                 JSON.stringify({ message: 'เพิ่มตัวชี้วัดให้หน่วยบริการ ' + newUpdates.length + ' คู่ (' + hcs.length + ' หน่วยบริการ) ข้ามที่มีอยู่แล้ว ' + skipped + ' ไม่ตรงประเภท ' + skippedType + ' ยังไม่ตั้งประเภท ' + skippedUnset }),
                 req.ip]
            );

            await connection.commit();
            scheduleSummaryRefresh(updates); // อัปเดต kpi_summary ของคู่ (ตัวชี้วัด × ปีงบ) ที่บันทึก ทันที (fire-and-forget)
            return res.json({
                success: true,
                message: 'เพิ่มตัวชี้วัดใหม่ ' + newUpdates.length + ' รายการ (ข้าม ' + (skipped + skippedType + skippedUnset) + ' รายการ)',
                inserted: newUpdates.length,
                skipped,
                skipped_type: skippedType,
                skipped_unset: skippedUnset
            });
        }

        // ตรวจสอบล็อค (super_admin ข้ามได้)
        if (user.role !== 'super_admin') {
            for (const key of uniqueKeys) {
                const [indId, ybh, hc] = key.split('_');
                const [lockedRows] = await connection.query(
                    'SELECT COUNT(*) as cnt FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                    [indId, ybh, hc]
                );
                if (lockedRows[0].cnt > 0) {
                    throw new Error(`ไม่สามารถแก้ไขได้ ข้อมูลตัวชี้วัด ID ${indId} ถูกล็อคอยู่`);
                }
            }
        }

        // === Permission Enforcement (super_admin ข้าม) ===
        // ถ้า user แก้เป้าหมาย/ผลงานไม่ได้ → preserve ค่าเดิมจาก DB (ไม่ให้ค่าที่ส่งมา override)
        if (user.role !== 'super_admin') {
            const perms = await getPermsForUser(user.userId, user.role);
            if (!perms.can_edit_target || !perms.can_edit_actual) {
                // โหลดค่าเดิมจาก DB ทำ preserveMap: key → { target, months: {monthVal: actual} }
                const preserveMap = {};
                for (const key of uniqueKeys) {
                    const [indId, ybh, hc] = key.split('_');
                    const [existing] = await connection.query(
                        'SELECT month_bh, actual_value, target_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                        [indId, ybh, hc]
                    );
                    const entry = { target: null, months: {} };
                    for (const r of existing) {
                        if (entry.target === null && r.target_value != null && r.target_value !== '') entry.target = r.target_value;
                        entry.months[r.month_bh] = r.actual_value;
                    }
                    preserveMap[key] = entry;
                }
                // apply preserve ลงใน updates แต่ละ row
                for (const row of updates) {
                    const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
                    const key = `${row.indicator_id}_${row.year_bh}_${hc}`;
                    const saved = preserveMap[key];
                    if (!saved) continue;
                    // ถ้าแก้เป้าหมายไม่ได้ → คืนค่า target เดิม
                    if (!perms.can_edit_target) {
                        row.target_value = saved.target != null ? saved.target : (row.target_value || '');
                    }
                    // ถ้าแก้ผลงานไม่ได้ → คืนค่า actual เดิมรายเดือน
                    if (!perms.can_edit_actual) {
                        for (const m of months) {
                            const old = saved.months[m.val];
                            row[m.col] = (old != null) ? old : (row[m.col] ?? '');
                        }
                    }
                }
            }
        }

        // --- Mode: setup_overwrite → เพิ่มทั้งหมด เขียนทับ (บันทึก 0 ได้) ---
        if (saveMode === 'setup_overwrite') {
            // DELETE ข้อมูลเก่าทั้งหมด
            for (const key of uniqueKeys) {
                const [indId, ybh, hc] = key.split('_');
                await connection.query(
                    'DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                    [indId, ybh, hc]
                );
            }

            // INSERT ทั้งหมด (รวม 0 ด้วย)
            const insertValues = [];
            const insertParams = [];
            for (const row of updates) {
                const { indicator_id, year_bh } = row;
                const rowHospcode = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;

                for (const m of months) {
                    const rawActual = row[m.col];
                    const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? String(rawActual).trim() : '';
                    const rawTarget = row.target_value;
                    const targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? String(rawTarget).trim() : '';
                    insertValues.push('(?, ?, ?, ?, ?, ?, ?, ?, 0)');
                    insertParams.push(indicator_id, year_bh, m.val, actualValue, targetValue, user.userId, 'Pending', rowHospcode);
                }
            }

            if (insertValues.length > 0) {
                await connection.query(
                    `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked)
                     VALUES ${insertValues.join(', ')}`,
                    insertParams
                );
            }

            await connection.query(
                'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
                [user.userId, user.deptId || 0, 'INSERT', 'kpi_results',
                 JSON.stringify({ message: `KPI-Setup: เขียนทับทั้งหมด ${updates.length} ตัวชี้วัด` }),
                 req.ip]
            );

            await connection.commit();
            scheduleSummaryRefresh(updates); // อัปเดต kpi_summary ของคู่ (ตัวชี้วัด × ปีงบ) ที่บันทึก ทันที (fire-and-forget)
            return res.json({
                success: true,
                message: `บันทึกตัวชี้วัดทั้งหมด ${updates.length} รายการเรียบร้อยแล้ว (เขียนทับ)`,
                inserted: updates.length
            });
        }

        // --- Mode: default → Dashboard ปกติ (DELETE + INSERT เฉพาะ row ที่มีค่า) ---
        // Batch DELETE: ลบข้อมูลเก่าทั้งหมดของแต่ละ indicator/year/hospcode
        for (const key of uniqueKeys) {
            const [indId, ybh, hc] = key.split('_');
            await connection.query(
                'DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                [indId, ybh, hc]
            );
        }

        // Batch INSERT: รวมข้อมูลทั้งหมดแล้ว INSERT ทีเดียว (ข้าม row ที่ค่า 0 ทั้งหมด)
        const insertValues = [];
        const insertParams = [];
        for (const row of updates) {
            const { indicator_id, year_bh } = row;
            const rowHospcode = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
            const rowStatus = row.preserve_status || 'Pending';

            const rawTarget3 = row.target_value;
            const targetValue3 = (rawTarget3 !== undefined && rawTarget3 !== null && rawTarget3 !== '') ? String(rawTarget3).trim() : '';
            for (const m of months) {
                const rawActual = row[m.col];
                const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? String(rawActual).trim() : null;

                if ((actualValue && actualValue !== '0') || (targetValue3 && targetValue3 !== '0')) {
                    insertValues.push('(?, ?, ?, ?, ?, ?, ?, ?, 0)');
                    insertParams.push(indicator_id, year_bh, m.val, actualValue, targetValue3, user.userId, rowStatus, rowHospcode);
                }
            }
        }

        if (insertValues.length > 0) {
            await connection.query(
                `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked)
                 VALUES ${insertValues.join(', ')}`,
                insertParams
            );
        }

        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId || 0, 'UPDATE', 'kpi_results', JSON.stringify({ message: `บันทึก KPI ${updates.length} รายการ` }), req.ip]
        );

        // ค่าฐาน + ค่าเพิ่มเติมที่ตั้งชื่อเอง (kpi_base_values.var_key) เฉพาะแถวที่ส่งมา: base_value (= base) และ cv_<key> (24–25 ต.ค. 2569)
        // รับเฉพาะชื่อที่ตัวชี้วัดประกาศไว้ (custom_vars) + base | ล็อคตรวจด้านบนแล้ว | สิทธิ์เดียวกับเป้าหมาย (can_edit_target) — ไม่มีสิทธิ์ = ไม่เปลี่ยนค่าเดิม | ว่าง = ลบ
        const varRowsToSave = updates.filter(r => r && Object.keys(r).some(k => k === 'base_value' || /^cv_[a-z][a-z0-9_]{0,19}$/.test(k)));
        if (varRowsToSave.length) {
            const canEditVars = user.role === 'super_admin' || !!(await getPermsForUser(user.userId, user.role)).can_edit_target;
            if (canEditVars) {
                const indIds = [...new Set(varRowsToSave.map(r => Number(r.indicator_id)).filter(Boolean))];
                const [indRows] = indIds.length ? await connection.query('SELECT id, custom_vars FROM kpi_indicators WHERE id IN (?)', [indIds]) : [[]];
                const allowedByInd = new Map(indRows.map(i => [Number(i.id), new Set(['base', ...varKeysOf(i)])]));
                for (const row of varRowsToSave) {
                    const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
                    const allowed = allowedByInd.get(Number(row.indicator_id)) || new Set(['base']);
                    const entries = [];
                    if (Object.prototype.hasOwnProperty.call(row, 'base_value')) entries.push(['base', row.base_value]);
                    for (const k of Object.keys(row)) {
                        const m = /^cv_([a-z][a-z0-9_]{0,19})$/.exec(k);
                        if (m && !(m[1] === 'base' && Object.prototype.hasOwnProperty.call(row, 'base_value'))) entries.push([m[1], row[k]]);
                    }
                    for (const [key, raw] of entries) {
                        if (!allowed.has(key)) continue;   // ชื่อที่ตัวชี้วัดไม่ได้ประกาศ — ข้าม
                        const v = String(raw ?? '').trim();
                        if (v.length > 100) throw new Error(`ค่า "${key}" ยาวเกิน 100 ตัวอักษร`);
                        if (!v) {
                            await connection.query('DELETE FROM kpi_base_values WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND var_key = ?', [row.indicator_id, row.year_bh, hc, key]);
                        } else {
                            await connection.query(
                                `INSERT INTO kpi_base_values (indicator_id, year_bh, hospcode, var_key, base_value, updated_by) VALUES (?, ?, ?, ?, ?, ?)
                                 ON DUPLICATE KEY UPDATE base_value = VALUES(base_value), updated_by = VALUES(updated_by)`,
                                [row.indicator_id, row.year_bh, hc, key, v, user.userId]);
                        }
                    }
                }
            }
        }

        await connection.commit();
        scheduleSummaryRefresh(updates); // อัปเดต kpi_summary ของคู่ (ตัวชี้วัด × ปีงบ) ที่บันทึก ทันที (fire-and-forget)

        // === KPI Save Audit (fire-and-forget) ===
        (async () => {
            try {
                const userInfo = await getUserAuditInfo(user.userId);
                // Group by indicator_id เพื่อเก็บ row_count ต่อ indicator
                const byInd = new Map();
                for (const u of updates) {
                    const k = u.indicator_id;
                    if (!byInd.has(k)) byInd.set(k, { count: 0, year_bh: u.year_bh, months: new Set() });
                    byInd.get(k).count++;
                    if (u.month_bh) byInd.get(k).months.add(u.month_bh);
                }
                // ดึง indicator names ทีเดียว
                const indIds = [...byInd.keys()].filter(Boolean);
                let indNames = {};
                if (indIds.length > 0) {
                    const [rs] = await db.query(`SELECT id, kpi_indicators_name FROM kpi_indicators WHERE id IN (${indIds.map(() => '?').join(',')})`, indIds);
                    indNames = Object.fromEntries(rs.map(r => [r.id, r.kpi_indicators_name]));
                }
                for (const [indId, info] of byInd) {
                    await logKpiSaveAudit({
                        ...(userInfo || { user_id: user.userId, username: user.username }),
                        hospcode: hospcodeToSave || userInfo?.hospcode,
                        action_type: 'kpi_results',
                        indicator_id: indId,
                        indicator_name: indNames[indId] || null,
                        year_bh: info.year_bh,
                        month_bh: info.months.size ? Array.from(info.months).join(',') : null,
                        row_count: info.count,
                        summary: `${info.count} เดือน`,
                        ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                    });
                }
            } catch (e) { console.warn('[KPI Audit] update-kpi log error:', e.message); }
        })();

        res.json({ success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        console.error('Update Error:', error);
        res.status(500).json({ success: false, message: error.message || 'เกิดข้อผิดพลาดในการบันทึก' });
    } finally {
        connection.release();
    }
});

// ============================================================
// === Form Builder APIs (สร้างแบบฟอร์มบันทึกข้อมูล KPI) ===
// ============================================================


// GET /form-schemas — รายการ schema ทั้งหมด (super_admin ดูทั้งหมด, อื่น ๆ ดูเฉพาะที่มี schema)
apiRouter.get('/form-schemas', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT fs.*, i.kpi_indicators_name, i.table_process, d.dept_name,
                   u.username AS created_by_name,
                   (SELECT COUNT(*) FROM kpi_form_fields ff WHERE ff.schema_id = fs.id) AS field_count
            FROM kpi_form_schemas fs
            LEFT JOIN kpi_indicators i ON fs.indicator_id = i.id
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN users u ON fs.created_by = u.id
            ORDER BY fs.updated_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /form-schemas/indicator/:indicator_id — schema ของ indicator นั้น ๆ พร้อม fields
apiRouter.get('/form-schemas/indicator/:indicator_id', authenticateToken, async (req, res) => {
    try {
        const [schemas] = await db.query(
            `SELECT fs.*, i.kpi_indicators_name, i.table_process FROM kpi_form_schemas fs
             LEFT JOIN kpi_indicators i ON fs.indicator_id = i.id
             WHERE fs.indicator_id = ? AND fs.is_active = 1 LIMIT 1`,
            [req.params.indicator_id]
        );
        if (schemas.length === 0) return res.json({ success: true, data: null });
        const schema = schemas[0];
        const [fields] = await db.query(
            'SELECT * FROM kpi_form_fields WHERE schema_id = ? ORDER BY sort_order, id',
            [schema.id]
        );
        schema.fields = fields;
        res.json({ success: true, data: schema });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /form-schemas/all-indicators — รายการ indicators ทั้งหมดพร้อมสถานะ schema
apiRouter.get('/form-schemas/all-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process, i.criterion, i.target_condition, i.result_formula, d.dept_name,
                   fs.id AS schema_id, fs.form_title, fs.is_active AS schema_active,
                   (SELECT COUNT(*) FROM kpi_form_fields ff WHERE ff.schema_id = fs.id) AS field_count
            FROM kpi_indicators i
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN kpi_form_schemas fs ON fs.indicator_id = i.id AND fs.is_active = 1
            WHERE i.is_active = 1
            ORDER BY d.dept_name, i.kpi_indicators_name
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /form-schemas — สร้าง/อัปเดต schema + CREATE TABLE ในฐานข้อมูล
apiRouter.post('/form-schemas', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { indicator_id, form_title, form_description, fields, schema_id, actual_value_field, include_default_fields } = req.body;
    const withDefaults = include_default_fields !== false; // default true
    if (!indicator_id || !form_title || !Array.isArray(fields) || fields.length === 0) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }
    // ตรวจสอบชื่อ field ทุกตัว
    for (const f of fields) {
        if (!f.field_name || !isValidIdentifier(f.field_name)) {
            return res.status(400).json({ success: false, message: `ชื่อคอลัมน์ "${f.field_name}" ไม่ถูกต้อง (ใช้ตัวอักษร a-z, A-Z, 0-9, _ เท่านั้น, ขึ้นต้นด้วยตัวอักษร)` });
        }
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        // ดึง table_process จาก kpi_indicators
        const [indRows] = await connection.query('SELECT table_process, kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        if (indRows.length === 0) throw new Error('ไม่พบตัวชี้วัด');
        const tableProcess = indRows[0].table_process;
        if (!tableProcess || !isValidIdentifier(tableProcess)) {
            throw new Error('ตัวชี้วัดนี้ยังไม่ได้กำหนดชื่อตาราง (table_process) กรุณาแก้ไขในหน้าจัดการตัวชี้วัดก่อน');
        }
        const avField = actual_value_field || null;
        let currentSchemaId = schema_id;
        if (currentSchemaId) {
            // อัปเดต schema เดิม
            await connection.query(
                'UPDATE kpi_form_schemas SET form_title=?, form_description=?, actual_value_field=?, updated_at=NOW() WHERE id=?',
                [form_title, form_description || null, avField, currentSchemaId]
            );
            await connection.query('DELETE FROM kpi_form_fields WHERE schema_id = ?', [currentSchemaId]);
        } else {
            // ปิด schema เก่า (ถ้ามี) แล้วสร้างใหม่
            await connection.query('UPDATE kpi_form_schemas SET is_active = 0 WHERE indicator_id = ?', [indicator_id]);
            const [ins] = await connection.query(
                'INSERT INTO kpi_form_schemas (indicator_id, form_title, form_description, actual_value_field, created_by) VALUES (?, ?, ?, ?, ?)',
                [indicator_id, form_title, form_description || null, avField, req.user.userId]
            );
            currentSchemaId = ins.insertId;
        }
        // บันทึก fields
        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            await connection.query(
                'INSERT INTO kpi_form_fields (schema_id, field_name, field_label, field_type, field_options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [currentSchemaId, f.field_name, f.field_label, f.field_type || 'text', f.field_options ? JSON.stringify(f.field_options) : null, f.is_required ? 1 : 0, i]
            );
        }
        // สร้าง / อัปเดตตาราง Dynamic (ใช้ prefix form_ เพื่อไม่ซ้ำกับตาราง export)
        const formTableName = 'form_' + tableProcess;
        const reservedFields = withDefaults ? ['id','hospcode','year_bh','month_bh','created_by','created_at','updated_at'] : ['id','created_at','updated_at'];
        const customCols = fields.filter(f => !reservedFields.includes(f.field_name));
        // map field_type → SQL type
        const sqlTypeOf = (ft) => ft === 'number' ? 'DECIMAL(15,4) NULL'
                                : ft === 'score_option' ? 'VARCHAR(255) NULL'
                                : 'TEXT NULL';
        let colDefs = customCols.map(f => `\`${f.field_name}\` ${sqlTypeOf(f.field_type)}`).join(', ');
        // เพิ่มคอลัมน์ <field>_pct สำหรับ field_type='score_option' (เก็บ % คะแนนของตัวเลือกที่ผู้ใช้เลือก)
        const pctCols = customCols.filter(f => f.field_type === 'score_option');
        if (pctCols.length > 0) {
            const pctDefs = pctCols.map(f => `\`${f.field_name}_pct\` DECIMAL(10,2) NULL`).join(', ');
            colDefs = colDefs ? `${colDefs}, ${pctDefs}` : pctDefs;
        }
        if (colDefs) colDefs = ', ' + colDefs;

        if (withDefaults) {
            // สร้างตารางพร้อมฟิลด์เริ่มต้น (id, hospcode, year_bh, month_bh, created_by, created_at)
            await connection.query(`
                CREATE TABLE IF NOT EXISTS \`${formTableName}\` (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    hospcode VARCHAR(20) NOT NULL,
                    year_bh INT NOT NULL,
                    month_bh INT NULL,
                    indicator_id INT NULL${colDefs},
                    created_by INT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_hym (hospcode, year_bh, month_bh)
                )
            `);
        } else {
            // สร้างตารางโดยไม่มีฟิลด์เริ่มต้น — ใช้เฉพาะฟิลด์ที่กำหนดเอง
            await connection.query(`
                CREATE TABLE IF NOT EXISTS \`${formTableName}\` (
                    id INT AUTO_INCREMENT PRIMARY KEY${colDefs},
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);
        }

        // เพิ่มคอลัมน์ใหม่ที่ยังไม่มี (ALTER TABLE ADD COLUMN IF NOT EXISTS)
        for (const f of customCols) {
            try {
                await connection.query(`ALTER TABLE \`${formTableName}\` ADD COLUMN IF NOT EXISTS \`${f.field_name}\` ${sqlTypeOf(f.field_type)}`);
            } catch (e) { /* ignore */ }
            // ALTER เพิ่ม <field>_pct สำหรับ score_option
            if (f.field_type === 'score_option') {
                try {
                    await connection.query(`ALTER TABLE \`${formTableName}\` ADD COLUMN IF NOT EXISTS \`${f.field_name}_pct\` DECIMAL(10,2) NULL`);
                } catch (e) { /* ignore */ }
            }
        }
        await connection.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'INSERT', 'kpi_form_schemas', JSON.stringify({ indicator_id, form_title, table: tableProcess }), req.ip]
        );
        await connection.commit();
        res.json({ success: true, message: `สร้างแบบฟอร์มและตาราง "${tableProcess}" เรียบร้อยแล้ว`, schema_id: currentSchemaId });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally { connection.release(); }
});

// DELETE /form-schemas/:id — ลบ schema (super_admin)
apiRouter.delete('/form-schemas/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('UPDATE kpi_form_schemas SET is_active = 0 WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบแบบฟอร์มเรียบร้อยแล้ว (ตารางข้อมูลยังคงอยู่)' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /dynamic-data/:table_name — ดึงข้อมูลจากตาราง dynamic (form_ prefix)
apiRouter.get('/dynamic-data/:table_name', authenticateToken, async (req, res) => {
    const { table_name } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    const formTable = 'form_' + table_name;
    try {
        // ตรวจสอบ columns ที่มีจริงในตาราง form (กัน ER_BAD_FIELD_ERROR ถ้าตารางไม่มี hospcode/year_bh)
        const [colInfo] = await db.query(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
            [formTable]
        );
        if (colInfo.length === 0) {
            return res.json({ success: true, data: [], reason: 'ตาราง form ยังไม่ถูกสร้าง' });
        }
        const tableCols = new Set(colInfo.map(c => c.COLUMN_NAME || c.column_name));

        const { hospcode, year_bh, month_bh, indicator_id } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        // filter เฉพาะ column ที่มีอยู่จริง
        if (hospcode && tableCols.has('hospcode')) { where += ' AND t.hospcode = ?'; params.push(hospcode); }
        if (year_bh && tableCols.has('year_bh')) { where += ' AND t.year_bh = ?'; params.push(year_bh); }
        if (month_bh && tableCols.has('month_bh')) { where += ' AND t.month_bh = ?'; params.push(month_bh); }
        if (indicator_id && tableCols.has('indicator_id')) {
            where += ' AND (t.indicator_id = ? OR t.indicator_id IS NULL)';
            params.push(indicator_id);
        }

        // ORDER BY: ใช้ฟิลด์ที่มี (year_bh + month_bh + created_at)
        const orderParts = [];
        if (tableCols.has('year_bh')) orderParts.push('t.year_bh DESC');
        if (tableCols.has('month_bh')) orderParts.push('t.month_bh DESC');
        orderParts.push('t.created_at DESC');
        const orderClause = 'ORDER BY ' + orderParts.join(', ');

        const [rows] = await db.query(`SELECT t.*, u.username AS created_by_name FROM \`${formTable}\` t LEFT JOIN users u ON t.created_by = u.id ${where} ${orderClause}`, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error(`❌ [dynamic-data GET] ${formTable}:`, e.code || '', e.message);
        res.json({ success: true, data: [], error: e.message });
    }
});

// GET /dynamic-data-months/:table_name — ดึงเดือนที่มีข้อมูลจาก dynamic table (สำหรับแสดงไอคอนใน dashboard)
apiRouter.get('/dynamic-data-months/:table_name', authenticateToken, async (req, res) => {
    const { table_name } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    try {
        const { hospcode, year_bh } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (hospcode) { where += ' AND hospcode = ?'; params.push(hospcode); }
        if (year_bh) { where += ' AND year_bh = ?'; params.push(year_bh); }
        const formTable = 'form_' + table_name;
        // ตรวจสอบว่าตารางมีอยู่จริงก่อน query
        const [tableCheck] = await db.query("SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [formTable]);
        if (!tableCheck[0]?.cnt) {
            return res.json({ success: true, data: [] });
        }
        const [rows] = await db.query(`SELECT DISTINCT month_bh FROM \`${formTable}\` ${where} AND month_bh IS NOT NULL ORDER BY month_bh`, params);
        res.json({ success: true, data: rows.map(r => r.month_bh) });
    } catch (e) { res.json({ success: true, data: [] }); }
});

// POST /dynamic-data-months/batch — batch ดึงเดือนจากหลาย table+hospcode พร้อมกัน (ลด N requests → M)
// Body: { year_bh, items: [{ table_process, hospcode }, ...] }
// Response: { success: true, data: { "table|hospcode": [10, 11, ...], ... } }
apiRouter.post('/dynamic-data-months/batch', authenticateToken, async (req, res) => {
    try {
        const { year_bh, items } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            return res.json({ success: true, data: {} });
        }
        // Group hospcodes by table_process
        const grouped = new Map(); // table_process → Set<hospcode>
        for (const it of items) {
            const tp = it && it.table_process;
            const hos = it && it.hospcode;
            if (!tp || !hos || !isValidIdentifier(tp)) continue;
            if (!grouped.has(tp)) grouped.set(tp, new Set());
            grouped.get(tp).add(String(hos));
        }
        if (grouped.size === 0) return res.json({ success: true, data: {} });

        // Pre-check ตารางไหนที่ form_* มีอยู่จริง (1 query)
        const tableNames = Array.from(grouped.keys()).map(t => 'form_' + t);
        const [existRows] = await db.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?)`,
            [tableNames]
        );
        const existSet = new Set(existRows.map(r => r.table_name || r.TABLE_NAME));

        const result = {};
        // Query แต่ละตารางครั้งเดียว (IN hospcodes)
        for (const [tp, hosSet] of grouped.entries()) {
            const formTable = 'form_' + tp;
            if (!existSet.has(formTable)) {
                for (const h of hosSet) result[`${tp}|${h}`] = [];
                continue;
            }
            const hosList = Array.from(hosSet);
            const params = [hosList];
            let where = 'WHERE hospcode IN (?) AND month_bh IS NOT NULL';
            if (year_bh) { where += ' AND year_bh = ?'; params.push(year_bh); }
            try {
                const [rows] = await db.query(
                    `SELECT DISTINCT hospcode, month_bh FROM \`${formTable}\` ${where}`, params
                );
                // init keys (รวมที่ไม่มีข้อมูล)
                for (const h of hosSet) result[`${tp}|${h}`] = [];
                for (const r of rows) {
                    const k = `${tp}|${r.hospcode}`;
                    if (!result[k]) result[k] = [];
                    result[k].push(r.month_bh);
                }
            } catch (_) {
                for (const h of hosSet) result[`${tp}|${h}`] = [];
            }
        }
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /dynamic-data/:table_name — บันทึกข้อมูลลงตาราง dynamic (form_ prefix) + sync kpi_results
apiRouter.post('/dynamic-data/:table_name', authenticateToken, async (req, res) => {
    const { table_name } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    const formTable = 'form_' + table_name;
    const isUpdate = !!(req.body.id && Number(req.body.id) > 0);
    const rowId = isUpdate ? Number(req.body.id) : null;
    const data = { ...req.body };
    delete data.id; delete data.created_at; delete data.updated_at; delete data.created_by_name;
    data.created_by = req.user.userId;
    if (!data.hospcode) data.hospcode = req.user.hospcode;
    if (!ROLE_ADMIN_ALL.includes(req.user.role)) data.hospcode = req.user.hospcode;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // === Validate: ดึง columns จริงของตาราง form แล้วกรองเฉพาะ field ที่มีอยู่ ===
        // กัน "Unknown column" error เมื่อ frontend ส่ง field ที่ schema เพิ่งเพิ่มแต่ตารางยังไม่ ALTER
        const [colInfo] = await connection.query(
            "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
            [formTable]
        );
        if (colInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: `ไม่พบตาราง ${formTable} — กรุณาสร้างแบบฟอร์มก่อน` });
        }
        const tableCols = new Map(colInfo.map(c => [(c.COLUMN_NAME || c.column_name), (c.DATA_TYPE || c.data_type || '').toLowerCase()]));

        // === Auto-compute <field>_pct สำหรับ score_option ===
        // อ่าน schema fields ของ indicator เพื่อหาว่า field ไหนเป็น score_option
        if (data.indicator_id) {
            const [scOptionFields] = await connection.query(
                `SELECT ff.field_name, ff.field_options
                 FROM kpi_form_fields ff
                 JOIN kpi_form_schemas fs ON ff.schema_id = fs.id
                 WHERE fs.indicator_id = ? AND ff.field_type = 'score_option'
                 ORDER BY fs.is_active DESC, fs.id DESC`,
                [data.indicator_id]
            );
            for (const f of scOptionFields) {
                const fname = f.field_name;
                const pctCol = fname + '_pct';
                if (!tableCols.has(pctCol)) continue;  // ตารางยังไม่มีคอลัมน์ _pct → ข้าม
                const selectedLabel = data[fname];
                if (selectedLabel == null || selectedLabel === '') continue;
                let opts = [];
                try { opts = JSON.parse(f.field_options || '[]'); } catch (_) { opts = []; }
                // หา option ที่ตรงกับ label ที่ผู้ใช้เลือก → set _pct
                const match = opts.find(o => (o.label != null ? String(o.label) : String(o)) === String(selectedLabel));
                if (match) {
                    const pct = match.percentage != null ? Number(match.percentage) : null;
                    if (pct !== null && !isNaN(pct)) data[pctCol] = pct;
                }
            }
        }

        // กรอง: เฉพาะ key ที่ valid + เป็นคอลัมน์จริงในตาราง + ไม่ใช่ id (auto-increment)
        const cols = Object.keys(data).filter(k => isValidIdentifier(k) && tableCols.has(k) && k !== 'id');
        // แปลง '' → null สำหรับคอลัมน์ตัวเลข (DECIMAL/INT/FLOAT/DOUBLE) กัน MySQL error
        const numericTypes = new Set(['decimal', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint', 'float', 'double']);
        const vals = cols.map(k => {
            const v = data[k];
            const dt = tableCols.get(k);
            if ((v === '' || v === undefined) && numericTypes.has(dt)) return null;
            return v === undefined ? null : v;
        });
        let insertedId = rowId;

        if (cols.length === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่บันทึกได้ (ฟิลด์ที่ส่งมาไม่ตรงกับโครงสร้างตาราง)' });
        }

        if (isUpdate) {
            const setClauses = cols.map(c => `\`${c}\` = ?`).join(', ');
            await connection.query(`UPDATE \`${formTable}\` SET ${setClauses} WHERE id = ?`, [...vals, rowId]);
        } else {
            const placeholders = cols.map(() => '?').join(', ');
            const [result] = await connection.query(`INSERT INTO \`${formTable}\` (\`${cols.join('`, `')}\`) VALUES (${placeholders})`, vals);
            insertedId = result.insertId;
        }

        // === Sync ไปยัง kpi_results ถ้า schema มี actual_value_field ===
        const indicatorId = data.indicator_id;
        const yearBh = data.year_bh;
        const monthBh = data.month_bh;
        const hospcode = data.hospcode;

        if (indicatorId && yearBh && monthBh) {
            const [schemaRows] = await connection.query(
                `SELECT fs.actual_value_field, ff.field_type
                   FROM kpi_form_schemas fs
                   LEFT JOIN kpi_form_fields ff ON ff.schema_id = fs.id AND ff.field_name = fs.actual_value_field
                  WHERE fs.indicator_id = ? AND fs.is_active = 1 LIMIT 1`,
                [indicatorId]
            );
            if (schemaRows.length > 0 && schemaRows[0].actual_value_field) {
                const avField = schemaRows[0].actual_value_field;
                const avType = schemaRows[0].field_type || null;
                // ถ้า field เป็น score_option → sync เป็นค่า % (จาก <field>_pct) แทน label เพื่อให้ kpi_results เก็บเป็นเปอร์เซ็นต์
                let actualValue;
                if (avType === 'score_option') {
                    const pctVal = data[avField + '_pct'];
                    actualValue = (pctVal !== undefined && pctVal !== null && pctVal !== '') ? String(pctVal) : null;
                } else {
                    actualValue = data[avField] !== undefined && data[avField] !== null && data[avField] !== '' ? String(data[avField]) : null;
                }
                if (actualValue !== null) {
                    // ดึง target_value เดิมก่อน DELETE (เก็บจากเดือน 10 แต่ใช้ร่วมทุกเดือน)
                    const [tRows] = await connection.query(
                        'SELECT MAX(target_value) AS tv FROM kpi_results WHERE indicator_id=? AND year_bh=? AND hospcode=?',
                        [indicatorId, yearBh, hospcode]
                    );
                    const targetValue = tRows[0]?.tv != null ? String(tRows[0].tv) : '';
                    // DELETE แถวเดิมของ month นั้น แล้ว INSERT ใหม่
                    await connection.query(
                        'DELETE FROM kpi_results WHERE indicator_id=? AND year_bh=? AND month_bh=? AND hospcode=?',
                        [indicatorId, yearBh, monthBh, hospcode]
                    );
                    await connection.query(
                        'INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
                        [indicatorId, yearBh, monthBh, actualValue, targetValue, req.user.userId, 'Pending', hospcode]
                    );
                }
            }
        }

        await connection.commit();

        // === KPI Save Audit (fire-and-forget) ===
        (async () => {
            try {
                const userInfo = await getUserAuditInfo(req.user.userId);
                let indName = null;
                if (data.indicator_id) {
                    const [rs] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [data.indicator_id]);
                    indName = rs[0]?.kpi_indicators_name || null;
                }
                await logKpiSaveAudit({
                    ...(userInfo || { user_id: req.user.userId, username: req.user.username }),
                    hospcode: data.hospcode || userInfo?.hospcode,
                    action_type: 'dynamic_form',
                    indicator_id: data.indicator_id || null,
                    indicator_name: indName,
                    year_bh: data.year_bh || null,
                    month_bh: data.month_bh || null,
                    table_name: formTable,
                    row_count: 1,
                    summary: isUpdate ? 'อัปเดต record' : 'เพิ่ม record',
                    ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                });
            } catch (e) { console.warn('[KPI Audit] dynamic-data log error:', e.message); }
        })();

        scheduleSummaryRefresh([{ indicator_id: data.indicator_id, year_bh: data.year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: isUpdate ? 'อัปเดตข้อมูลเรียบร้อยแล้ว' : 'บันทึกข้อมูลเรียบร้อยแล้ว', id: insertedId });
    } catch (e) {
        await connection.rollback();
        console.error(`❌ [dynamic-data] ${formTable} POST error:`, e.code || '', e.message);
        // map MySQL error → ข้อความเข้าใจง่าย
        let userMsg = e.message;
        if (e.code === 'ER_BAD_FIELD_ERROR') userMsg = 'มีฟิลด์ที่ไม่ตรงกับโครงสร้างตาราง — กรุณาแจ้ง admin ให้ปรับแบบฟอร์ม';
        else if (e.code === 'ER_TRUNCATED_WRONG_VALUE' || e.code === 'ER_DATA_TOO_LONG') userMsg = 'ข้อมูลที่กรอกไม่ถูกต้องหรือยาวเกินกำหนด — กรุณาตรวจสอบ';
        else if (e.code === 'ER_BAD_NULL_ERROR') userMsg = 'มีฟิลด์ที่จำเป็นต้องกรอก — กรุณาตรวจสอบ';
        else if (e.code === 'ER_NO_SUCH_TABLE') userMsg = 'ไม่พบตารางในฐานข้อมูล — กรุณาสร้างแบบฟอร์มก่อน';
        res.status(500).json({ success: false, message: userMsg, code: e.code });
    } finally { connection.release(); }
});

// DELETE /dynamic-data/:table_name/:record_id — ลบรายการ
apiRouter.delete('/dynamic-data/:table_name/:record_id', authenticateToken, async (req, res) => {
    const { table_name, record_id } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    try {
        const formTable = 'form_' + table_name;
        await db.query(`DELETE FROM \`${formTable}\` WHERE id = ?`, [record_id]);
        res.json({ success: true, message: 'ลบข้อมูลเรียบร้อยแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ===========================
apiRouter.get('/kpi-template', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let deptFilter = '';
        const params = [];
        // กรองตาม dept เฉพาะ role ที่ scope = หน่วยงานตัวเอง (ROLE_SCOPE_OWN_DEPT) — admin_cup/hos/sso เห็นทุกหน่วยงาน
        // แม้บัญชีจะมี dept_id ติดอยู่ก็ตาม (ตาราง Role System ใน CLAUDE.md)
        if (ROLE_SCOPE_OWN_DEPT.includes(user.role) && user.deptId != null) {
            deptFilter = 'AND i.dept_id = ?';
            params.push(user.deptId);
        }
        const sql = `
            SELECT
                if (mi.main_indicator_name is NULL,"ยังไม่กำหนด",mi.main_indicator_name) main_indicator_name,
                i.kpi_indicators_name,
                i.id AS indicator_id,
                i.dept_id,
                i.target_percentage,
                i.target_condition,
                i.criterion,
                i.table_process,
                i.evaluation_mode,
                i.required_off_types,
                i.result_formula,
                i.is_cumulative,
                d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            WHERE i.is_active = 1
              AND (mi.id IS NULL OR mi.is_active = 1)
              AND (d.id IS NULL OR d.is_active = 1) ${deptFilter}
            ORDER BY mi.main_indicator_name DESC, i.kpi_indicators_name DESC, d.dept_name DESC
        `;
        let [rows] = await db.query(sql, params);
        // hostype_setting: 'types' | 'all' | 'unset' — 'unset' แสดงในรายการแต่เพิ่มไม่ได้ (ต้องตั้งประเภทหน่วยบริการก่อน)
        rows.forEach(r => { r.hostype_setting = indicatorTypeSetting(r); });
        // ผู้ใช้ที่ผูกกับหน่วยบริการเดียว (ROLE_SCOPE_HOSPCODE): ซ่อนตัวชี้วัดที่ตั้งไว้เฉพาะประเภทอื่น (คงตัวที่ยังไม่ได้ตั้งไว้ให้เห็นว่าต้องตั้งค่า)
        if (ROLE_SCOPE_HOSPCODE.includes(user.role) && user.hospcode) {
            const [[h]] = await db.query('SELECT hostype FROM chospital WHERE hoscode = ?', [user.hospcode]);
            if (h && h.hostype) rows = rows.filter(r => r.hostype_setting === 'unset' || indicatorAllowsHostype(r, h.hostype));
        }
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching template' });
    }
});

// ตรวจสอบข้อมูล KPI ที่มีอยู่แล้วสำหรับ KPI-Setup
apiRouter.get('/kpi-setup-check', authenticateToken, async (req, res) => {
    try {
        const { hospcode, year_bh, dept_id } = req.query;
        if (!hospcode || !year_bh) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ hospcode และ year_bh' });
        }

        let deptFilter = '';
        let params = [hospcode, year_bh];
        if (dept_id) {
            deptFilter = 'AND i.dept_id = ?';
            params.push(dept_id);
        }

        // นับจำนวนตัวชี้วัดที่มีข้อมูลอยู่แล้ว + ตัวชี้วัดที่มีคะแนนจริง
        const [rows] = await db.query(`
            SELECT
                COUNT(DISTINCT r.indicator_id) AS total_existing,
                COUNT(DISTINCT CASE WHEN r.actual_value > 0 THEN r.indicator_id END) AS scored_indicators,
                SUM(r.actual_value) AS total_score
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            WHERE r.hospcode = ? AND r.year_bh = ? AND ${activeIndicatorSql('r.indicator_id')} ${deptFilter}
        `, params);

        const data = rows[0] || { total_existing: 0, scored_indicators: 0, total_score: 0 };
        res.json({
            success: true,
            data: {
                totalExisting: Number(data.total_existing) || 0,
                scoredIndicators: Number(data.scored_indicators) || 0,
                totalScore: Number(data.total_score) || 0
            }
        });
    } catch (error) {
        console.error('KPI Setup Check Error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถตรวจสอบข้อมูลได้' });
    }
});

apiRouter.get('/dashboard-stats', authenticateToken, async (req, res) => {
    try {
        const user = req.user;

        const year = req.query.year || (new Date().getFullYear() + 543).toString();
        let whereClause = '';
        let filterParams = [];

        // === Role-based stats filtering (same logic as /kpi-results) ===
        const needsHosJoin = ROLE_SCOPE_DISTRICT.includes(user.role);
        if (user.role === 'super_admin') {
            // no filter
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClause = 'AND i.dept_id = ?'; filterParams.push(user.deptId); }
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                whereClause = 'AND h.distid = ?'; filterParams.push(distid);
                if (user.role === 'user_cup' && user.deptId != null) { whereClause += ' AND i.dept_id = ?'; filterParams.push(user.deptId); }
            } else { whereClause = 'AND r.hospcode = ?'; filterParams.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            // ทุก dept แต่เฉพาะ hospcode ตัวเอง
            if (user.hospcode) { whereClause += ' AND r.hospcode = ?'; filterParams.push(user.hospcode); }
        } else {
            if (user.hospcode) { whereClause += ' AND r.hospcode = ?'; filterParams.push(user.hospcode); }
            if (user.deptId != null) { whereClause += ' AND i.dept_id = ?'; filterParams.push(user.deptId); }
        }

        const queryParams = [year, ...filterParams];
        const hosJoin = needsHosJoin ? 'LEFT JOIN chospital h ON r.hospcode = h.hoscode' : '';

        // === Card 1: ร้อยละความสำเร็จ KPI ===
        // ใช้ kpi_summary (มี last_actual = ค่าเดือนล่าสุดที่คีย์) — ไม่ใช่ SUM ทั้งปี
        // นับ % ของ (indicator × hospcode) ที่ "ผ่านเกณฑ์" คือ last_actual >= target_value (target > 0)
        // role-based filter — ใช้ s.* (kpi_summary มี dept_id, distid อยู่แล้ว)
        const summaryWhereClauses = ['s.year_bh = ?', activeIndicatorSql('s.indicator_id')];
        const summaryParams = [year];
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { summaryWhereClauses.push('s.dept_id = ?'); summaryParams.push(user.deptId); }
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                summaryWhereClauses.push('s.distid = ?'); summaryParams.push(distid);
                if (user.role === 'user_cup' && user.deptId != null) { summaryWhereClauses.push('s.dept_id = ?'); summaryParams.push(user.deptId); }
            } else if (user.hospcode) { summaryWhereClauses.push('s.hospcode = ?'); summaryParams.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { summaryWhereClauses.push('s.hospcode = ?'); summaryParams.push(user.hospcode); }
        } else {
            if (user.hospcode) { summaryWhereClauses.push('s.hospcode = ?'); summaryParams.push(user.hospcode); }
            if (user.deptId != null) { summaryWhereClauses.push('s.dept_id = ?'); summaryParams.push(user.deptId); }
        }
        const summaryWhere = summaryWhereClauses.join(' AND ');

        // ผ่านเกณฑ์ตามเงื่อนไขเป้าหมายของตัวชี้วัด (≥ > ≤ < =) — targetPassSql() (22 ต.ค. 2569)
        const _sc = targetCondOf('s');
        const [successRows] = await db.query(`
            SELECT
                SUM(CASE WHEN ${targetHasSql('s.target_value', _sc)} THEN 1 ELSE 0 END) AS total_with_target,
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', _sc)} THEN 1 ELSE 0 END) AS passed
            FROM kpi_summary s
            WHERE ${summaryWhere}
        `, summaryParams);
        const totalWithTarget = Number(successRows[0]?.total_with_target || 0);
        const passedCount = Number(successRows[0]?.passed || 0);
        const successRate = totalWithTarget > 0 ? ((passedCount / totalWithTarget) * 100).toFixed(1) : 0;

        // === Card 2: กลุ่มงานที่บันทึกแล้ว ===
        // นับ dept_id ที่มีผลงานจริง (actual_value ไม่ว่าง) ใน kpi_results หรือ kpi_sub_results
        // เทียบกับ dept ทั้งหมดที่มี indicator active ในปีนี้ (ไม่ใช่ count(*) ทั้งตาราง departments)
        const recordedSql = `
            SELECT COUNT(DISTINCT i.dept_id) as recorded_count
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            ${hosJoin}
            WHERE r.year_bh = ? AND i.is_active = 1
              AND r.actual_value IS NOT NULL AND r.actual_value != ''
              AND i.dept_id IS NOT NULL
              ${whereClause}
        `;
        const [recordedRows] = await db.query(recordedSql, queryParams);
        // นับ dept ที่มาจาก sub-results ด้วย (กรณีตัวชี้วัดที่บันทึกใน kpi_sub_results)
        const subRecordedSql = `
            SELECT COUNT(DISTINCT i.dept_id) AS recorded_sub
            FROM kpi_sub_results sr
            JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
            JOIN kpi_indicators i ON si.indicator_id = i.id
            ${needsHosJoin ? 'LEFT JOIN chospital h ON sr.hospcode = h.hoscode' : ''}
            WHERE sr.year_bh = ? AND i.is_active = 1
              AND sr.actual_value IS NOT NULL AND sr.actual_value != ''
              AND i.dept_id IS NOT NULL
              ${whereClause.replace(/r\.hospcode/g, 'sr.hospcode')}
        `;
        const [subRecRows] = await db.query(subRecordedSql, queryParams).catch(() => [[{ recorded_sub: 0 }]]);
        // ผลงานกิจกรรม (ตัวชี้วัด 3 ระดับ)
        const [actRecRows] = await db.query(`
            SELECT COUNT(DISTINCT i.dept_id) AS recorded_act
            FROM kpi_activity_results ar
            JOIN kpi_sub_activities a ON a.id = ar.activity_id
            JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
            JOIN kpi_indicators i ON si.indicator_id = i.id
            ${needsHosJoin ? 'LEFT JOIN chospital h ON ar.hospcode = h.hoscode' : ''}
            WHERE ar.year_bh = ? AND i.is_active = 1
              AND ar.actual_value IS NOT NULL AND ar.actual_value != ''
              AND i.dept_id IS NOT NULL
              ${whereClause.replace(/r\.hospcode/g, 'ar.hospcode')}
        `, queryParams).catch(() => [[{ recorded_act: 0 }]]);
        // รวม dept_id จากทุก source — ใช้ Math.max ป้องกันนับซ้ำ (อาจมี dept ที่มีทั้งใน results และ sub_results)
        const recordedCount = Math.max(Number(recordedRows[0]?.recorded_count || 0), Number(subRecRows[0]?.recorded_sub || 0), Number(actRecRows[0]?.recorded_act || 0));

        // totalDepts: นับ dept ที่มี active indicator ในปีนี้ (consistent กับ scope)
        const [totalDeptRows] = await db.query(`
            SELECT COUNT(DISTINCT i.dept_id) AS total
            FROM kpi_indicators i
            WHERE i.is_active = 1 AND i.dept_id IS NOT NULL
        `);

        // === Card 3: รอการตรวจสอบ ===
        // นับ distinct (indicator, hospcode) ที่มี Pending row พร้อม actual_value (มีผลงานจริงรอ approve)
        // + คู่ที่บันทึกผลงานที่ข้อย่อย/กิจกรรม (ตัวชี้วัด 3 ระดับ — แถวผลงานหลักอาจว่าง) — alias ตารางผลงานเป็น r ทุกส่วน ใช้ whereClause ชุดเดียวกัน
        const pendingSql = `
            SELECT COUNT(DISTINCT x.k) AS pending_count FROM (
                SELECT CONCAT(r.indicator_id, '|', r.hospcode) AS k
                FROM kpi_results r
                LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
                ${hosJoin}
                WHERE r.status = 'Pending' AND r.year_bh = ? AND ${activeIndicatorSql('r.indicator_id')}
                  AND r.actual_value IS NOT NULL AND r.actual_value != ''
                  ${whereClause}
                UNION ALL
                SELECT CONCAT(i.id, '|', r.hospcode)
                FROM kpi_sub_results r
                JOIN kpi_sub_indicators si ON si.id = r.sub_indicator_id
                JOIN kpi_indicators i ON i.id = si.indicator_id
                ${hosJoin}
                WHERE r.status = 'Pending' AND r.year_bh = ? AND i.is_active = 1
                  AND r.actual_value IS NOT NULL AND r.actual_value != ''
                  ${whereClause}
                UNION ALL
                SELECT CONCAT(i.id, '|', r.hospcode)
                FROM kpi_activity_results r
                JOIN kpi_sub_activities a ON a.id = r.activity_id
                JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id
                JOIN kpi_indicators i ON i.id = si.indicator_id
                ${hosJoin}
                WHERE r.status = 'Pending' AND r.year_bh = ? AND i.is_active = 1
                  AND r.actual_value IS NOT NULL AND r.actual_value != ''
                  ${whereClause}
            ) x
        `;
        const [pendingRows] = await db.query(pendingSql, [...queryParams, ...queryParams, ...queryParams]);

        // === Card 4: อันดับผลงานระดับจังหวัด ===
        // ใช้ kpi_summary.last_actual (ค่าเดือนล่าสุด) — ไม่ใช่ raw actual_value ของแต่ละเดือน
        let rank = 0;
        let totalHospitals = 0;
        if (user.hospcode) {
            const [allHosRows] = await db.query(`
                SELECT s.hospcode,
                    SUM(CASE WHEN ${targetHasSql('s.target_value', _sc)} THEN 1 ELSE 0 END) AS total_with_target,
                    SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', _sc)} THEN 1 ELSE 0 END) AS passed,
                    CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', _sc)} THEN 1 ELSE 0 END) = 0 THEN 0
                         ELSE ROUND(
                            SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', _sc)} THEN 1 ELSE 0 END)
                            / SUM(CASE WHEN ${targetHasSql('s.target_value', _sc)} THEN 1 ELSE 0 END) * 100, 2)
                    END AS success_pct
                FROM kpi_summary s
                WHERE s.year_bh = ? AND ${activeIndicatorSql('s.indicator_id')}
                GROUP BY s.hospcode
                HAVING total_with_target > 0
                ORDER BY success_pct DESC, total_with_target DESC
            `, [year]);
            totalHospitals = allHosRows.length;
            const idx = allHosRows.findIndex(r => r.hospcode === user.hospcode);
            rank = idx >= 0 ? idx + 1 : 0;
        }

        res.json({
            success: true,
            data: {
                successRate,
                recordedCount, // เดิมส่งค่าจาก kpi_results อย่างเดียว ทั้งที่คำนวณรวมข้อย่อย/กิจกรรมไว้แล้ว — แก้ 18 ต.ค. 2569
                totalDepts: totalDeptRows[0].total || 0,
                pendingCount: pendingRows[0].pending_count || 0,
                rank,
                totalHospitals
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Stats Error' });
    }
});


// --- Log Management ---
apiRouter.get('/logs/backup', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [systemLogs] = await db.query(`SELECT l.*, u.username FROM system_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC`);
        const [loginLogs] = await db.query(`SELECT * FROM login_logs ORDER BY created_at DESC`);

        let csv = 'log_type,id,timestamp,username,action,details,ip_address\n';

        systemLogs.forEach(row => {
            let details = '';
            try {
                details = row.new_value ? (JSON.parse(row.new_value).message || row.new_value) : (row.old_value || '');
            } catch (e) {
                details = row.new_value || '';
            }
            csv += `SYSTEM,${row.id},"${row.created_at}","${row.username || ''}","${row.action_type}","${details.toString().replace(/"/g, '""')}","${row.ip_address || ''}"\n`;
        });

        loginLogs.forEach(row => {
            csv += `LOGIN,${row.id},"${row.created_at}","${row.username || ''}","${row.action}","${(row.details || '').toString().replace(/"/g, '""')}","${row.ip_address || ''}"\n`;
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="korat_kpi_logs.csv"');
        res.send('\ufeff' + csv);
    } catch (error) {
        console.error("Log Backup Error:", error);
        const detail = process.env.NODE_ENV !== 'production' ? error.message : undefined;
        res.status(500).json({ success: false, message: detail || 'ไม่สามารถสำรองข้อมูลได้' });
    }
});

apiRouter.delete('/logs/clear', authenticateToken, isSuperAdmin, async (req, res) => {
    const user = req.user;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        
        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'DELETE', 'ALL_LOGS', JSON.stringify({ message: `ล้างข้อมูล Log ทั้งหมดโดย ${user.username}` }), req.ip]
        );
        
        await connection.query('TRUNCATE TABLE system_logs');
        await connection.query('TRUNCATE TABLE login_logs');

        await connection.commit();
        res.json({ success: true, message: 'ล้างข้อมูล Log ทั้งหมดเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        console.error("Log Clear Error:", error);
        res.status(500).json({ success: false, message: 'ไม่สามารถล้างข้อมูล Log ได้' });
    } finally {
        connection.release();
    }
});

apiRouter.get('/users', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        let sql = `
            SELECT u.id, u.username, u.role, u.dept_id, u.firstname, u.lastname, u.phone, u.hospcode,
                   u.email, u.cid, u.is_approved, u.is_active, u.approved_by,
                   u.active_session_id, u.session_started_at, u.last_seen_at, u.last_seen_ip,
                   u.can_edit_actual, u.can_edit_target,
                   u.line_user_id, u.notif_line_enabled,
                   d.dept_name, h.hosname, dist.distname,
                   approver.firstname AS approved_by_name, approver.lastname AS approved_by_lastname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            LEFT JOIN users approver ON u.approved_by = approver.id`;
        let params = [];

        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            // เห็นเฉพาะ dept เดียวกัน ยกเว้น super_admin
            sql += ` WHERE u.role != 'super_admin'`;
            if (user.deptId != null) { sql += ' AND u.dept_id = ?'; params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            // admin_cup: ทุกคนในอำเภอเดียวกัน ยกเว้น super_admin
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                sql += ` WHERE u.role != 'super_admin' AND h.distid = ?`;
                params.push(distid);
            } else {
                sql += ` WHERE u.role != 'super_admin' AND u.hospcode = ?`;
                params.push(user.hospcode);
            }
        } else if (ROLE_SCOPE_HOSPCODE.includes(user.role) && ROLE_ADMIN_ALL.includes(user.role)) {
            // admin_hos / admin_sso: เฉพาะ hospcode ตัวเอง ยกเว้น super_admin
            sql += ` WHERE u.role != 'super_admin' AND u.hospcode = ?`;
            params.push(user.hospcode);
        } else {
            // user ทั่วไป: เฉพาะ dept_id เดียวกัน ยกเว้น super_admin
            sql += ` WHERE u.role != 'super_admin' AND u.dept_id = ?`;
            params.push(user.deptId);
        }
        sql += ' ORDER BY u.id DESC';

        const [users] = await db.query(sql, params);
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// GET /users/stats — สถิติผู้ใช้งาน แยกตาม role / อำเภอ / หน่วยบริการ / กลุ่มงาน (anyAdmin)
apiRouter.get('/users/stats', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        // ---- สร้าง WHERE + params เดียวกับ GET /users ----
        let where = `WHERE u.role != 'super_admin'`;
        let params = [];
        if (user.role === 'super_admin') {
            where = '';
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { where += ' AND u.dept_id = ?'; params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where += ' AND h.distid = ?'; params.push(distid); }
            else { where += ' AND u.hospcode = ?'; params.push(user.hospcode); }
        } else if (ROLE_SCOPE_HOSPCODE.includes(user.role) && ROLE_ADMIN_ALL.includes(user.role)) {
            where += ' AND u.hospcode = ?'; params.push(user.hospcode);
        } else {
            where += ' AND u.dept_id = ?'; params.push(user.deptId);
        }

        const join = `FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode LEFT JOIN co_district dist ON dist.distid = h.distid LEFT JOIN departments d ON u.dept_id = d.id`;

        // 1. Summary totals
        const [summary] = await db.query(`
            SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN u.is_approved = 1 AND u.is_active = 1 THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN u.is_approved = 0 THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN u.is_approved = -1 THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN u.is_active = 0 THEN 1 ELSE 0 END) AS disabled,
              SUM(CASE WHEN u.is_approved = 1 THEN 1 ELSE 0 END) AS approved
            ${join} ${where}
        `, params);

        // 2. By role
        const [byRole] = await db.query(`
            SELECT u.role, COUNT(*) AS count
            ${join} ${where}
            GROUP BY u.role ORDER BY count DESC
        `, params);

        // 3. By district
        const [byDistrict] = await db.query(`
            SELECT h.distid, dist.distname, COUNT(*) AS count
            ${join} ${where}
            GROUP BY h.distid, dist.distname ORDER BY count DESC
        `, params);

        // 4. By hospital (top 50)
        const [byHospital] = await db.query(`
            SELECT u.hospcode, h.hosname, h.hostype, dist.distname, COUNT(*) AS count
            ${join} ${where}
            GROUP BY u.hospcode, h.hosname, h.hostype, dist.distname ORDER BY count DESC LIMIT 50
        `, params);

        // 5. By department
        const [byDept] = await db.query(`
            SELECT d.id AS dept_id, d.dept_name, COUNT(*) AS count
            ${join} ${where}
            GROUP BY d.id, d.dept_name ORDER BY count DESC
        `, params);

        res.json({
            success: true,
            summary: summary[0],
            byRole,
            byDistrict,
            byHospital,
            byDept
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /users/pending-count — จำนวน user ที่ลงทะเบียนใหม่และรออนุมัติ (is_approved = 0) ตาม scope ของ admin
apiRouter.get('/users/pending-count', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        let where = "u.is_approved = 0 AND u.role != 'super_admin'";
        const params = [];
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { where += ' AND u.dept_id = ?'; params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where += ' AND h.distid = ?'; params.push(distid); }
            else { where += ' AND u.hospcode = ?'; params.push(user.hospcode); }
        } else if (ROLE_SCOPE_HOSPCODE.includes(user.role) && ROLE_ADMIN_ALL.includes(user.role)) {
            where += ' AND u.hospcode = ?'; params.push(user.hospcode);
        } else {
            where += ' AND u.dept_id = ?'; params.push(user.deptId);
        }
        const [rows] = await db.query(
            `SELECT COUNT(*) AS cnt FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE ${where}`,
            params
        );
        res.json({ success: true, count: rows[0].cnt });
    } catch (error) {
        res.status(500).json({ success: false, count: 0 });
    }
});

// GET /online-users — รายชื่อ user ที่ online (activity ล่าสุดภายใน windowMin นาที)
// ============================================================
//  Error Monitoring Endpoints
// ============================================================
// POST /errors/report — รับ error จาก frontend (authenticated หรือ anon ก็ได้)
apiRouter.post('/errors/report', async (req, res) => {
    try {
        // ไม่ require auth — error อาจเกิดก่อน login
        let userId = null, username = null;
        try {
            const token = (req.headers['authorization'] || '').split(' ')[1];
            if (token) {
                const decoded = jwt.verify(token, SECRET_KEY);
                userId = decoded.userId || null;
                username = decoded.username || null;
            }
        } catch (_) {}
        const b = req.body || {};
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
        const result = await captureError({
            source: b.source || 'frontend',
            severity: b.severity || 'error',
            message: b.message || '(empty)',
            stack: b.stack || null,
            url: b.url || null,
            user_id: userId,
            username,
            user_agent: req.headers['user-agent'] || null,
            ip_address: ip,
            extra: b.extra || null
        });
        res.json({ success: true, ...(result || {}) });
    } catch (e) {
        // ไม่บอก error กลับ frontend (กัน loop) แค่ 200
        res.json({ success: false });
    }
});

// GET /admin/error-logs — ดู error log (super_admin)
apiRouter.get('/admin/error-logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { source, severity, resolved, limit = 100 } = req.query;
        const params = [];
        let where = '1=1';
        if (source) { where += ' AND source = ?'; params.push(source); }
        if (severity) { where += ' AND severity = ?'; params.push(severity); }
        if (resolved !== undefined && resolved !== '') {
            where += ' AND resolved = ?';
            params.push(resolved === '1' || resolved === 'true' ? 1 : 0);
        }
        params.push(Math.min(Number(limit) || 100, 500));
        const [rows] = await db.query(
            `SELECT id, source, severity, fingerprint, message, stack, url, user_id, username,
                    user_agent, ip_address, count, first_seen, last_seen, resolved, resolved_by, resolved_at
             FROM error_logs WHERE ${where} ORDER BY last_seen DESC LIMIT ?`,
            params
        );
        const [stat] = await db.query(`
            SELECT
              COUNT(*) AS total,
              COUNT(CASE WHEN resolved = 0 THEN 1 END) AS unresolved,
              COUNT(CASE WHEN source='frontend' AND resolved=0 THEN 1 END) AS frontend_open,
              COUNT(CASE WHEN source='backend' AND resolved=0 THEN 1 END) AS backend_open,
              COUNT(CASE WHEN severity='fatal' AND resolved=0 THEN 1 END) AS fatal_open,
              COUNT(CASE WHEN DATE(last_seen) = CURDATE() THEN 1 END) AS today
            FROM error_logs
        `);
        res.json({ success: true, data: rows, stats: stat[0] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /admin/error-logs/:id/resolve — mark error เป็น resolved
apiRouter.post('/admin/error-logs/:id/resolve', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query(
            'UPDATE error_logs SET resolved = 1, resolved_by = ?, resolved_at = NOW() WHERE id = ?',
            [req.user.userId, Number(req.params.id)]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /admin/error-logs/clear-resolved — ลบ error ที่ resolved แล้ว
apiRouter.delete('/admin/error-logs/clear-resolved', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [r] = await db.query('DELETE FROM error_logs WHERE resolved = 1');
        res.json({ success: true, deleted: r.affectedRows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Express error middleware — capture 500 errors ที่ไม่ได้ handle ใน route
// (ใส่ก่อน mount router — ต้องเอาก่อน app.listen)
// ฟังก์ชันนี้ export ให้ใช้ทีหลังตอน app.use

apiRouter.get('/online-users', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const windowMin = Math.max(1, Math.min(1440, parseInt(req.query.window || '5', 10))); // 1 นาที - 24 ชม
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.role, u.firstname, u.lastname, u.hospcode,
                    u.last_seen_at, u.last_seen_ip, u.last_seen_ua,
                    d.dept_name, h.hosname, dist.distname,
                    TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) AS idle_seconds
             FROM users u
             LEFT JOIN departments d ON u.dept_id = d.id
             LEFT JOIN chospital h ON u.hospcode = h.hoscode
             LEFT JOIN co_district dist ON dist.distid = h.distid
             WHERE u.last_seen_at IS NOT NULL
               AND u.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
             ORDER BY u.last_seen_at DESC`,
            [windowMin]
        );
        // สถิติสรุปแยก role
        const stats = {
            total: rows.length,
            by_role: {},
            window_min: windowMin,
            server_time: new Date().toISOString(),
        };
        for (const r of rows) {
            stats.by_role[r.role] = (stats.by_role[r.role] || 0) + 1;
        }
        res.json({ success: true, data: rows, stats });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /departments — กรองเหลือเฉพาะ dept ตัวเองสำหรับ role ที่ scope คือ "dept ตัวเอง" (ROLE_SCOPE_OWN_DEPT)
// role อื่น (super_admin, admin_cup, admin_hos, admin_sso) เห็น "ทุก dept" แม้จะมี dept_id ติดตัวอยู่ก็ตาม (ตาราง Role System ใน CLAUDE.md)
apiRouter.get('/departments', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let where = '';
        const params = [];
        if (ROLE_SCOPE_OWN_DEPT.includes(user.role) && user.deptId != null) {
            where = 'WHERE id = ?';
            params.push(user.deptId);
        }
        const [depts] = await db.query(`SELECT * FROM departments ${where} ORDER BY dept_name`, params);
        res.json({ success: true, data: depts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// GET /hospitals — กรองตาม role scope: ROLE_SCOPE_HOSPCODE เห็นเฉพาะ hoscode ตัวเอง, ROLE_SCOPE_DISTRICT เห็นทุก hoscode ในอำเภอตัวเอง
// role อื่น (super_admin, admin_ssj) เห็นทุกหน่วยบริการ (ตาราง Role System ใน CLAUDE.md — admin_ssj scope คือ "ทุก hospcode")
apiRouter.get('/hospitals', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let where = '';
        const params = [];
        if (ROLE_SCOPE_HOSPCODE.includes(user.role) && user.hospcode) {
            where = 'WHERE h.hoscode = ?';
            params.push(user.hospcode);
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role) && user.hospcode) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where = 'WHERE h.distid = ?'; params.push(distid); }
        }
        const [hospitals] = await db.query(`
            SELECT h.hoscode, h.hosname, h.hostype, h.provcode, h.distcode, h.distid,
                   t.hostypename, d.distname
              FROM chospital h
         LEFT JOIN chostype t ON t.hostypecode = h.hostype
         LEFT JOIN co_district d ON d.distid = h.distid
              ${where}
          ORDER BY FIELD(h.hostype,'05','06','07','18'), h.hosname
        `, params);
        res.json({ success: true, data: hospitals });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// === Hospitals CRUD (super_admin) ===
// POST /hospitals — create
apiRouter.post('/hospitals', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { hoscode, hosname, hostype, provcode, distcode } = req.body;
    if (!hoscode || !hosname) return res.status(400).json({ success: false, message: 'กรุณากรอก hoscode + hosname' });
    if (!/^[0-9A-Za-z_-]{1,20}$/.test(String(hoscode))) return res.status(400).json({ success: false, message: 'hoscode ไม่ถูกต้อง (สูงสุด 20 ตัวอักษร a-z, 0-9, _, -)' });
    try {
        const [exists] = await db.query('SELECT hoscode FROM chospital WHERE hoscode = ?', [hoscode]);
        if (exists.length > 0) return res.status(400).json({ success: false, message: 'hoscode นี้มีอยู่แล้ว' });
        const distid = (provcode && distcode) ? String(provcode) + String(distcode) : null;
        await db.query(
            'INSERT INTO chospital (hoscode, hosname, hostype, provcode, distcode, distid) VALUES (?, ?, ?, ?, ?, ?)',
            [hoscode, hosname, hostype || null, provcode || null, distcode || null, distid]
        );
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'HOSPITAL_CREATE', 'chospital', JSON.stringify(req.body), req.ip]);
        res.json({ success: true, message: 'เพิ่มหน่วยบริการเรียบร้อย' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /hospitals/:hoscode — update
apiRouter.put('/hospitals/:hoscode', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { hoscode } = req.params;
    const { hosname, hostype, provcode, distcode } = req.body;
    if (!hosname) return res.status(400).json({ success: false, message: 'กรุณากรอก hosname' });
    try {
        const distid = (provcode && distcode) ? String(provcode) + String(distcode) : null;
        const [r] = await db.query(
            'UPDATE chospital SET hosname=?, hostype=?, provcode=?, distcode=?, distid=? WHERE hoscode = ?',
            [hosname, hostype || null, provcode || null, distcode || null, distid, hoscode]
        );
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'ไม่พบหน่วยบริการนี้' });
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'HOSPITAL_UPDATE', 'chospital', JSON.stringify({ hoscode, ...req.body }), req.ip]);
        res.json({ success: true, message: 'อัปเดตเรียบร้อย' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /hospitals/:hoscode — delete (ตรวจสอบว่ามี user/kpi_results อ้างอิงอยู่หรือไม่)
apiRouter.delete('/hospitals/:hoscode', authenticateToken, isSuperAdmin, async (req, res) => {
    const { hoscode } = req.params;
    try {
        const [users] = await db.query('SELECT COUNT(*) AS cnt FROM users WHERE hospcode = ?', [hoscode]);
        const [results] = await db.query('SELECT COUNT(*) AS cnt FROM kpi_results WHERE hospcode = ? LIMIT 1', [hoscode]);
        if (users[0].cnt > 0 || results[0].cnt > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: มี user (${users[0].cnt}) หรือ ผลงาน KPI (${results[0].cnt}) อ้างอิงอยู่` });
        }
        const [r] = await db.query('DELETE FROM chospital WHERE hoscode = ?', [hoscode]);
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'ไม่พบหน่วยบริการนี้' });
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'HOSPITAL_DELETE', 'chospital', JSON.stringify({ hoscode }), req.ip]);
        res.json({ success: true, message: 'ลบเรียบร้อย' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /hostype — นับจำนวนหน่วยบริการเฉพาะในขอบเขตของ role (เหมือน /hospitals) กันนับรวมหน่วยบริการนอกขอบเขต
apiRouter.get('/hostype', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let hospJoinWhere = '';
        const params = [];
        if (ROLE_SCOPE_HOSPCODE.includes(user.role) && user.hospcode) {
            hospJoinWhere = 'AND h.hoscode = ?';
            params.push(user.hospcode);
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role) && user.hospcode) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { hospJoinWhere = 'AND h.distid = ?'; params.push(distid); }
        }
        const [rows] = await db.query(`
            SELECT t.hostypecode, t.hostypename, COUNT(h.hoscode) AS hospital_count
            FROM chostype t
            LEFT JOIN chospital h ON h.hostype = t.hostypecode ${hospJoinWhere}
            GROUP BY t.hostypecode, t.hostypename
            HAVING hospital_count > 0
            ORDER BY t.hostypecode
        `, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /districts — ROLE_SCOPE_DISTRICT (admin_cup/user_cup) เห็นเฉพาะอำเภอตัวเอง, role อื่นเห็นทุกอำเภอ
apiRouter.get('/districts', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let where = 'WHERE distid LIKE ?';
        const params = ['30%'];
        if (ROLE_SCOPE_DISTRICT.includes(user.role) && user.hospcode) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) { where = 'WHERE distid = ?'; params[0] = distid; }
        }
        const [districts] = await db.query(`SELECT distid, distname FROM co_district ${where} ORDER BY distname`, params);
        res.json({ success: true, data: districts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.post('/users', authenticateToken, requireAction('users', 'add'), async (req, res) => {
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone, email, cid } = req.body;
    const user = req.user;
    const isCentralAdmin = ROLE_ADMIN_CENTRAL.includes(user.role);
    const isLocalAdmin = ROLE_ADMIN_LOCAL.includes(user.role);

    // central admin: เปลี่ยน role+dept ได้, local admin: เปลี่ยน dept ได้แต่ role ไม่ได้
    const finalRole = isCentralAdmin ? (role || 'user_hos') : 'user_hos';
    const finalDeptId = (isCentralAdmin || isLocalAdmin) ? (dept_id || null) : user.deptId;

    try {
        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'Username exists' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const hashedCid = cid ? crypto.createHash('sha256').update(cid).digest('hex') : null;
        // super_admin สร้าง → อนุมัติทันที + บันทึกผู้อนุมัติ, อื่นๆ → รอ super_admin อนุมัติ
        const autoApprove = user.role === 'super_admin' ? 1 : 0;
        const approvedBy = autoApprove ? user.userId : null;
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, role, dept_id, firstname, lastname, hospcode, phone, email, cid, is_approved, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, finalRole, finalDeptId, firstname, lastname, hospcode, phone, email || null, hashedCid, autoApprove, approvedBy]
        );

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'INSERT', 'users', result.insertId, JSON.stringify({ username, role: finalRole }), req.ip]
        );
        res.json({ success: true, message: 'User created' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// เปลี่ยนรหัสผ่านตัวเอง (ทุก role ใช้ได้)
apiRouter.put('/users/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = req.user; // authenticateToken ตรวจ session + set req.user แล้ว

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ success: false, message: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร' });
    }

    try {
        const [users] = await db.query('SELECT password_hash, temp_password, temp_password_expiry FROM users WHERE id = ?', [user.userId]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });

        // ตรวจสอบรหัสผ่านปัจจุบัน หรือ รหัสชั่วคราว
        let isMatch = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!isMatch && users[0].temp_password) {
            isMatch = await bcrypt.compare(currentPassword, users[0].temp_password);
        }
        if (!isMatch) return res.status(400).json({ success: false, message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password_hash = ?, must_change_password = 0, temp_password = NULL, temp_password_expiry = NULL WHERE id = ?', [hashedPassword, user.userId]);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'users', user.userId, JSON.stringify({ message: 'เปลี่ยนรหัสผ่านตัวเอง' }), req.ip]
        );

        res.json({ success: true, message: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่ Server' });
    }
});

// ตรวจสอบการเชื่อมต่อ SSO provider จากฝั่ง server (public — หลีกเลี่ยง CORS)
apiRouter.get('/sso/connectivity', async (req, res) => {
    const checkUrl = async (url) => {
        if (!url) return false;
        let origin;
        try { origin = new URL(url).origin; } catch { return false; }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        try {
            const r = await fetch(origin, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
            clearTimeout(timer);
            return r.status < 500;
        } catch { clearTimeout(timer); return false; }
    };

    const [ts, ps] = await Promise.all([
        getThaidSettings().catch(() => null),
        getProviderIdSettings().catch(() => null)
    ]);
    const thaidUrl   = (ts?.thaid_enabled === 'true' && ts?.thaid_login_url) ? ts.thaid_login_url : '';
    const providerUrl = (ps?.enabled && ps?.login_url) ? ps.login_url : '';

    const [thaid, providerid] = await Promise.all([checkUrl(thaidUrl), checkUrl(providerUrl)]);
    res.json({ success: true, thaid, providerid });
});

// ตรวจสอบสถานะ maintenance mode (public — ไม่ต้อง login)
apiRouter.get('/system/maintenance-status', async (req, res) => {
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('maintenance_mode','maintenance_message','thaid_enabled','providerid_enabled','thaid_login_url','thaid_register_enabled','providerid_register_enabled','system_version')"
        );
        const s = {};
        rows.forEach(r => s[r.setting_key] = r.setting_value);
        res.json({
            success: true,
            maintenance: s['maintenance_mode'] === 'true',
            message: s['maintenance_message'] || 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน',
            thaid_enabled: s['thaid_enabled'] === 'true',
            providerid_enabled: s['providerid_enabled'] === 'true',
            thaid_login_url: s['thaid_login_url'] || '',
            thaid_register_enabled: s['thaid_register_enabled'] === 'true',
            providerid_register_enabled: s['providerid_register_enabled'] === 'true',
            system_version: s['system_version'] || 'v1.0.0',
        });
    } catch (error) {
        res.json({ success: true, maintenance: false, message: '', thaid_enabled: false, providerid_enabled: false, system_version: 'v1.0.0' });
    }
});

// เปิด/ปิด maintenance mode (super_admin เท่านั้น)
apiRouter.put('/system/maintenance-mode', authenticateToken, isSuperAdmin, async (req, res) => {
    const { enabled, message } = req.body;
    try {
        await db.query(
            "INSERT INTO system_settings (setting_key, setting_value, description) VALUES ('maintenance_mode', ?, 'โหมดปิดปรับปรุงระบบ') ON DUPLICATE KEY UPDATE setting_value = ?",
            [enabled ? 'true' : 'false', enabled ? 'true' : 'false']
        );
        if (message !== undefined) {
            await db.query(
                "INSERT INTO system_settings (setting_key, setting_value, description) VALUES ('maintenance_message', ?, 'ข้อความแจ้งเตือนปิดปรับปรุง') ON DUPLICATE KEY UPDATE setting_value = ?",
                [message, message]
            );
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, enabled ? 'MAINTENANCE_ON' : 'MAINTENANCE_OFF', 'system_settings',
             JSON.stringify({ enabled, message }), req.ip]
        );
        res.json({ success: true, message: enabled ? 'เปิดโหมดปิดปรับปรุงระบบ' : 'ปิดโหมดปิดปรับปรุง — ระบบเปิดใช้งานปกติ' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================================

// เปิด/ปิดใช้งานทั้งหมด ยกเว้น super_admin (super_admin เท่านั้น)
apiRouter.put('/users/bulk-toggle-active', authenticateToken, isSuperAdmin, async (req, res) => {
    const { is_active } = req.body;
    const newStatus = is_active ? 1 : 0;
    const actionText = newStatus ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
    try {
        const [result] = await db.query(
            'UPDATE users SET is_active = ? WHERE role != ? AND id != ?',
            [newStatus, 'super_admin', req.user.userId]
        );
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, req.user.deptId, newStatus ? 'BULK_ACTIVATE' : 'BULK_DEACTIVATE', 'users',
             JSON.stringify({ affected: result.affectedRows, is_active: newStatus }), req.ip]
        );
        res.json({ success: true, message: `${actionText}ผู้ใช้งานทั้งหมด ${result.affectedRows} คน (ยกเว้น super_admin)` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /users/sync-mapping — บันทึก config mapping/exclude ใหม่ (super_admin)
// ⚠️ ต้องอยู่ก่อน PUT /users/:id เสมอ — ไม่งั้น Express จะจับ 'sync-mapping' เป็นค่า :id แทน (route ตรงตัวต้องมาก่อน wildcard เสมอ)
apiRouter.put('/users/sync-mapping', authenticateToken, isSuperAdmin, async (req, res) => {
    const { exclude, mapping } = req.body;
    try {
        if (!Array.isArray(exclude)) return res.status(400).json({ success: false, message: 'exclude ต้องเป็น array' });
        if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) return res.status(400).json({ success: false, message: 'mapping ต้องเป็น object' });

        const [localColsInfo] = await db.query('SHOW COLUMNS FROM users');
        const validFields = new Set(localColsInfo.map(c => c.Field));
        const cleanExclude = [...new Set(exclude)].filter(f => validFields.has(f) && f !== 'id' && f !== 'username');

        const cleanMapping = {};
        for (const [local, khd] of Object.entries(mapping)) {
            if (!validFields.has(local)) continue;
            const target = String(khd || '').trim();
            if (!target || target === local) continue; // ว่าง/ไม่เปลี่ยน = identity, ไม่ต้องเก็บ
            if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(target)) continue; // กันชื่อ identifier ผิดรูปแบบ
            cleanMapping[local] = target;
        }
        const targets = Object.values(cleanMapping);
        const dupTargets = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))];
        if (dupTargets.length > 0) return res.status(400).json({ success: false, message: `มีหลายคอลัมน์ map ไปชื่อ KHD เดียวกัน: ${dupTargets.join(', ')}` });

        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('users_sync_exclude_columns', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [JSON.stringify(cleanExclude), JSON.stringify(cleanExclude)]);
        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('users_sync_field_mapping', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [JSON.stringify(cleanMapping), JSON.stringify(cleanMapping)]);

        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'USERS_SYNC_MAPPING_UPDATE', 'system_settings', JSON.stringify({ exclude: cleanExclude, mapping: cleanMapping }), req.ip]).catch(() => {});

        res.json({ success: true, message: 'บันทึกการตั้งค่า Mapping สำเร็จ', exclude: cleanExclude, mapping: cleanMapping });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.put('/users/:id', authenticateToken, requireAction('users', 'edit'), async (req, res) => {
    const userId = req.params.id;
    const { username, password, role, dept_id, firstname, lastname, hospcode, phone, email, cid } = req.body;
    const user = req.user;
    const isSuperAdmin = user.role === 'super_admin';
    const isCentralAdmin = ROLE_ADMIN_CENTRAL.includes(user.role);
    const isDistrictAdmin = user.role === 'admin_cup';
    const isHosAdmin = ['admin_hos', 'admin_sso'].includes(user.role);

    try {
        // ตรวจสอบสิทธิ์ตามขอบเขต
        if (user.role === 'admin_ssj') {
            // admin_ssj: ต้อง dept_id เดียวกัน
            const [target] = await db.query('SELECT dept_id FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (user.deptId != null && String(target[0].dept_id) !== String(user.deptId)) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งานต่างหน่วยงาน' });
        } else if (isDistrictAdmin) {
            const [target] = await db.query(`SELECT h.distid AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            const myDistid = await getDistrictId(user.hospcode);
            if (!myDistid || target[0].distid !== myDistid) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งานต่างอำเภอ' });
        } else if (isHosAdmin) {
            const [target] = await db.query('SELECT hospcode FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (target[0].hospcode !== user.hospcode) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งานต่างหน่วยบริการ' });
        } else if (!isSuperAdmin) {
            return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์แก้ไขผู้ใช้งาน' });
        }

        const isLocalAdmin = ROLE_ADMIN_LOCAL.includes(user.role);
        const finalDeptId = (isCentralAdmin || isLocalAdmin) ? (dept_id || null) : user.deptId;

        // อัปเดต cid เฉพาะเมื่อส่ง raw national ID 13 หลักมาเท่านั้น
        // (ป้องกัน frontend ส่ง SHA-256 hash กลับมา → double-hash หรือ null → ลบค่าเดิม)
        const cidRaw = cid ? String(cid).replace(/\D/g, '') : '';
        const shouldUpdateCid = cidRaw.length === 13;
        const hashedCid = shouldUpdateCid ? crypto.createHash('sha256').update(cidRaw).digest('hex') : null;

        let sql, params;
        if (isCentralAdmin) {
            sql = 'UPDATE users SET username = ?, role = ?, dept_id = ?, firstname = ?, lastname = ?, hospcode = ?, phone = ?, email = ?';
            params = [username, role, finalDeptId, firstname, lastname, hospcode, phone, email || null];
        } else {
            // local admin: ไม่แก้ role
            sql = 'UPDATE users SET username = ?, dept_id = ?, firstname = ?, lastname = ?, hospcode = ?, phone = ?, email = ?';
            params = [username, finalDeptId, firstname, lastname, hospcode, phone, email || null];
        }
        if (shouldUpdateCid) {
            sql += ', cid = ?';
            params.push(hashedCid);
        }

        if (password && password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(password, 10);
            sql += ', password_hash = ?';
            params.push(hashedPassword);
        }
        sql += ' WHERE id = ?';
        params.push(userId);

        await db.query(sql, params);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'users', userId, JSON.stringify({ username, role: isCentralAdmin ? role : '(unchanged)', password_changed: !!password }), req.ip]
        );
        res.json({ success: true, message: 'Updated' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// ห้ามลบผู้ใช้ที่เป็นเจ้าของผลงาน (kpi_results.user_id) — การลบผู้ใช้ต้องไม่ทำให้ผลงานหาย (11 ต.ค. 2569)
// เดิม FK เป็น ON DELETE CASCADE: ลบผู้ใช้ = ลบผลงานทุกแถวของผู้ใช้นั้นแบบเงียบๆ → เปลี่ยนเป็น RESTRICT ใน auto-migration แล้ว
// และตรวจที่นี่ก่อนเพื่อให้ได้ข้อความที่เข้าใจได้ (ไม่ใช่ข้อผิดพลาดจากฐานข้อมูล) — ให้ "ปิดการใช้งาน" บัญชีแทนการลบ
async function countUserKpiResults(userId) {
    const [[r]] = await db.query('SELECT COUNT(*) AS n FROM kpi_results WHERE user_id = ?', [userId]);
    return Number(r.n) || 0;
}
const userHasResultsMessage = (n) =>
    `ลบไม่ได้: ผู้ใช้นี้เป็นเจ้าของผลงานที่บันทึกไว้ ${Number(n).toLocaleString('en-US')} ระเบียน — การลบบัญชีจะทำให้ผลงานหาย กรุณา "ปิดการใช้งาน" บัญชีแทน`;

apiRouter.delete('/users/:id', authenticateToken, isAnyAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;

    try {
        if (user.role === 'admin_ssj') {
            const [target] = await db.query('SELECT dept_id FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (user.deptId != null && String(target[0].dept_id) !== String(user.deptId)) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งานต่างหน่วยงาน' });
        } else if (user.role === 'admin_cup') {
            const [target] = await db.query(`SELECT h.distid AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            const myDistid = await getDistrictId(user.hospcode);
            if (!myDistid || target[0].distid !== myDistid) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งานต่างอำเภอ' });
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            const [target] = await db.query('SELECT hospcode FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (target[0].hospcode !== user.hospcode) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งานต่างหน่วยบริการ' });
        } else if (user.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์ลบผู้ใช้งาน' });
        }

        const ownedResults = await countUserKpiResults(userId);
        if (ownedResults > 0) {
            return res.status(400).json({ success: false, code: 'USER_HAS_KPI_RESULTS', kpi_results: ownedResults, message: userHasResultsMessage(ownedResults) });
        }

        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        await cleanupPendingApprovalNotifications(userId);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'DELETE', 'users', userId, JSON.stringify({ message: `Deleted ID: ${userId}` }), req.ip]
        );
        res.json({ success: true, message: 'Deleted' });
    } catch (error) {
        // ฐานข้อมูลปฏิเสธเพราะยังมีข้อมูลอ้างอิงผู้ใช้นี้ (FK RESTRICT) — ไม่ใช่ข้อผิดพลาดของระบบ
        if (error && (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_ROW_IS_REFERENCED')) {
            return res.status(400).json({ success: false, code: 'USER_HAS_KPI_RESULTS', message: 'ลบไม่ได้: ยังมีข้อมูลผลงานที่อ้างอิงผู้ใช้นี้ กรุณา "ปิดการใช้งาน" บัญชีแทน' });
        }
        res.status(500).json({ success: false, message: 'ไม่สามารถลบผู้ใช้งานได้' });
    }
});

apiRouter.put('/users/:id/reset-password', authenticateToken, requireAction('users', 'edit'), async (req, res) => {
    const userId = req.params.id;
    const user = req.user;
    // ตรวจสอบสิทธิ์ตามขอบเขต
    try {
        if (user.role === 'admin_ssj') {
            const [target] = await db.query('SELECT dept_id FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (user.deptId != null && String(target[0].dept_id) !== String(user.deptId)) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่านผู้ใช้งานต่างหน่วยงาน' });
        } else if (user.role === 'admin_cup') {
            const [target] = await db.query(`SELECT h.distid AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            const myDistid = await getDistrictId(user.hospcode);
            if (!myDistid || target[0].distid !== myDistid) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่านผู้ใช้งานต่างอำเภอ' });
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            const [target] = await db.query('SELECT hospcode FROM users WHERE id = ?', [userId]);
            if (target.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
            if (target[0].hospcode !== user.hospcode) return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่านผู้ใช้งานต่างหน่วยบริการ' });
        } else if (user.role !== 'super_admin') {
            return res.status(403).json({ success: false, message: 'คุณไม่มีสิทธิ์รีเซ็ตรหัสผ่าน' });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }

    try {
        // สร้างรหัสชั่วคราว 6 หลัก + hash
        const tempCode = String(Math.floor(100000 + Math.random() * 900000));
        const hashedTemp = await bcrypt.hash(tempCode, 10);
        const expiry = new Date(Date.now() + 15 * 60 * 1000);

        await db.query('UPDATE users SET temp_password = ?, temp_password_expiry = ?, must_change_password = 1 WHERE id = ?',
            [hashedTemp, expiry, userId]);

        // ดึงข้อมูล user เพื่อส่ง email
        const [targetUser] = await db.query('SELECT username, email, firstname, lastname FROM users WHERE id = ?', [userId]);
        const target = targetUser[0];

        // LINE: แจ้งรหัสชั่วคราว (กรณี user ลงทะเบียน LINE ไว้)
        sendLineToUser(userId,
            `🔑 รหัสผ่านของคุณถูกรีเซ็ต\n\n` +
            `รหัสชั่วคราว: ${tempCode}\n` +
            `⏰ หมดอายุใน 15 นาที\n\n` +
            `ใช้รหัสนี้แทนรหัสผ่านเดิม — ระบบจะบังคับให้เปลี่ยนรหัสใหม่ทันที`
        );

        // ส่ง Email แจ้งรหัสชั่วคราว (ถ้ามี email)
        if (target && target.email) {
            sendMail(target.email, '🔑 รหัสผ่านของคุณถูกรีเซ็ต — ระบบ KPI สสจ.นครราชสีมา',
                `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:linear-gradient(135deg,#f97316,#fb923c);padding:24px;text-align:center;color:white">
                        <h2 style="margin:0;font-size:20px">🔑 รีเซ็ตรหัสผ่าน</h2>
                    </div>
                    <div style="padding:24px;text-align:center">
                        <p>เรียน คุณ${target.firstname} ${target.lastname},</p>
                        <p>ผู้ดูแลระบบได้ทำการรีเซ็ตรหัสผ่านของคุณ<br>รหัสชั่วคราวสำหรับเข้าสู่ระบบคือ:</p>
                        <div style="background:#fff7ed;border:2px dashed #f97316;border-radius:12px;padding:20px;margin:16px 0">
                            <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#c2410c;font-family:monospace">${tempCode}</span>
                        </div>
                        <p style="color:#dc2626;font-weight:bold;font-size:14px">รหัสนี้จะหมดอายุใน 15 นาที</p>
                        <p style="font-size:13px;color:#6b7280">ใช้รหัสนี้แทนรหัสผ่านเดิมเพื่อเข้าสู่ระบบ<br>ระบบจะบังคับให้เปลี่ยนรหัสผ่านใหม่ทันที</p>
                    </div>
                </div>`
            );
        }

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UPDATE', 'users', userId, JSON.stringify({ message: 'Reset Password', email_sent: !!target?.email }), req.ip]
        );
        res.json({ success: true, message: target?.email ? `รีเซ็ตสำเร็จ — ส่งรหัสชั่วคราวไปที่ Email ของผู้ใช้แล้ว` : `รีเซ็ตสำเร็จ — ผู้ใช้ไม่มี Email ให้แจ้งรหัสชั่วคราว: ${tempCode}` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// อนุมัติการลงทะเบียน
apiRouter.put('/users/:id/approve', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        const target = rows[0];
        if (target.is_approved !== 0) return res.status(400).json({ success: false, message: 'ผู้ใช้งานนี้ไม่ได้อยู่ในสถานะรอการอนุมัติ' });

        await db.query('UPDATE users SET is_approved = 1, approved_by = ? WHERE id = ?', [user.userId, userId]);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPROVE_USER', 'users', userId, JSON.stringify({ username: target.username, approved_by: user.userId }), req.ip]
        );

        // LINE: แจ้งผลอนุมัติให้ผู้สมัคร
        sendLineToUser(userId,
            `✅ บัญชีของคุณได้รับการอนุมัติแล้ว\n` +
            `Username: ${target.username}\n\n` +
            `เข้าใช้งานระบบได้ที่:\nhttps://apikorat.moph.go.th/khupskpi/login`
        );

        // ส่ง Email แจ้งผลอนุมัติ
        if (target.email) {
            sendMail(target.email, '✅ บัญชีของคุณได้รับการอนุมัติแล้ว — ระบบ KPI สสจ.นครราชสีมา',
                `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:linear-gradient(135deg,#16a34a,#22c55e);padding:24px;text-align:center;color:white">
                        <h2 style="margin:0;font-size:20px">✅ อนุมัติเรียบร้อยแล้ว</h2>
                    </div>
                    <div style="padding:24px">
                        <p>เรียน คุณ${target.firstname} ${target.lastname},</p>
                        <p>คำขอลงทะเบียนใช้งาน <b>ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา</b> ได้รับการ <span style="color:#16a34a;font-weight:bold">อนุมัติ</span> แล้ว</p>
                        <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
                            <tr><td style="padding:6px 0;color:#6b7280">ชื่อผู้ใช้</td><td style="font-weight:bold">${target.username}</td></tr>
                            <tr><td style="padding:6px 0;color:#6b7280">สิทธิ์</td><td style="font-weight:bold">${target.role}</td></tr>
                        </table>
                        <p>คุณสามารถเข้าสู่ระบบได้ทันที</p>
                        <p style="color:#9ca3af;font-size:12px;margin-top:24px">อีเมลฉบับนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ</p>
                    </div>
                </div>`
            );
        }

        res.json({ success: true, message: 'อนุมัติผู้ใช้งานเรียบร้อย' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ปฏิเสธการลงทะเบียน (รับ reason จาก body)
apiRouter.put('/users/:id/reject', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const user = req.user;
    const reason = req.body.reason || '';
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        const target = rows[0];
        if (target.is_approved !== 0) return res.status(400).json({ success: false, message: 'ผู้ใช้งานนี้ไม่ได้อยู่ในสถานะรอการอนุมัติ' });

        await db.query('UPDATE users SET is_approved = -1 WHERE id = ?', [userId]);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'REJECT_USER', 'users', userId, JSON.stringify({ username: target.username, reason }), req.ip]
        );

        // LINE: แจ้งผลปฏิเสธให้ผู้สมัคร
        sendLineToUser(userId,
            `❌ คำขอลงทะเบียนถูกปฏิเสธ\n` +
            `Username: ${target.username}\n` +
            (reason ? `\nเหตุผล: ${reason}\n` : '') +
            `\nกรุณาติดต่อผู้ดูแลระบบหากต้องการสมัครใหม่`
        );

        // ส่ง Email แจ้งผลปฏิเสธ พร้อมเหตุผล
        if (target.email) {
            const reasonHtml = reason
                ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:12px 0">
                     <p style="color:#991b1b;font-weight:bold;margin:0 0 4px">เหตุผล:</p>
                     <p style="color:#dc2626;margin:0">${reason}</p>
                   </div>`
                : '';
            sendMail(target.email, '❌ คำขอลงทะเบียนถูกปฏิเสธ — ระบบ KPI สสจ.นครราชสีมา',
                `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:linear-gradient(135deg,#dc2626,#ef4444);padding:24px;text-align:center;color:white">
                        <h2 style="margin:0;font-size:20px">❌ คำขอถูกปฏิเสธ</h2>
                    </div>
                    <div style="padding:24px">
                        <p>เรียน คุณ${target.firstname} ${target.lastname},</p>
                        <p>คำขอลงทะเบียนใช้งาน <b>ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา</b> <span style="color:#dc2626;font-weight:bold">ไม่ได้รับการอนุมัติ</span></p>
                        ${reasonHtml}
                        <p>คุณสามารถแก้ไขข้อมูลแล้ว <b>ลงทะเบียนใหม่</b> ได้อีกครั้ง หรือติดต่อผู้ดูแลระบบ</p>
                        <p style="color:#9ca3af;font-size:12px;margin-top:24px">อีเมลฉบับนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ</p>
                    </div>
                </div>`
            );
        }

        res.json({ success: true, message: 'ปฏิเสธผู้ใช้งานเรียบร้อย' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// เปิด/ปิดใช้งาน user account
apiRouter.put('/users/:id/toggle-active', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    const { is_active } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        // ป้องกันปิดตัวเอง
        if (Number(userId) === user.userId) {
            return res.status(400).json({ success: false, message: 'ไม่สามารถปิดใช้งานบัญชีของตัวเองได้' });
        }
        const newStatus = is_active ? 1 : 0;
        await db.query('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, userId]);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, newStatus ? 'ACTIVATE_USER' : 'DEACTIVATE_USER', 'users', userId,
             JSON.stringify({ username: rows[0].username, is_active: newStatus }), req.ip]
        );
        res.json({ success: true, message: newStatus ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ดูข้อมูลผู้ใช้งานที่รอการอนุมัติ (super_admin/admin_ssj เท่านั้น)
apiRouter.get('/users/:id/basic', authenticateToken, isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        const [rows] = await db.query(
            `SELECT u.id, u.username, u.firstname, u.lastname, u.role, u.hospcode, u.phone, u.email, u.cid, u.is_approved,
                    h.hosname, d.dept_name
             FROM users u
             LEFT JOIN chospital h ON u.hospcode = h.hoscode
             LEFT JOIN departments d ON u.dept_id = d.id
             WHERE u.id = ?`,
            [userId]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้งาน' });
        res.json({ success: true, data: rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.get('/system-logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [logs] = await db.query(`
            SELECT s.*, u.username, u.firstname, u.lastname 
            FROM system_logs s
            LEFT JOIN users u ON s.user_id = u.id
            ORDER BY s.created_at DESC
            LIMIT 500
        `);
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// หมายเหตุ: เปิดให้ทุก role ที่ login แล้วอ่านได้ (ไม่ผูกกับหน้า "ตั้งค่าระบบ" โดยเฉพาะ) — layout.ts/idle-timeout.service.ts
// ใช้ดึงค่า system_version/idle timeout ที่ทุก role ต้องเห็น ไม่ใช่แค่ super_admin — เดิมไม่มี authenticateToken เลย (เปิดสาธารณะ
// แม้ไม่ login ก็อ่าน secrets เช่น thaid_client_secret/telegram token ได้) แก้ให้ต้อง login อย่างน้อย
apiRouter.get('/settings', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM system_settings');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching settings' });
    }
});

apiRouter.post('/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    const settings = req.body; // Expect array of { key, value }

    const connection = await db.getConnection();
    try {
        // === ดึง current values ของ key ทั้งหมดที่ส่งมา เพื่อ diff หา key ที่เปลี่ยนจริง ===
        const submittedKeys = settings.map(s => s.setting_key);
        let oldValuesMap = new Map();
        if (submittedKeys.length > 0) {
            const placeholders = submittedKeys.map(() => '?').join(',');
            const [oldRows] = await connection.query(
                `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${placeholders})`,
                submittedKeys
            );
            for (const r of oldRows) oldValuesMap.set(r.setting_key, r.setting_value);
        }

        await connection.beginTransaction();
        for (const item of settings) {
            await connection.query(
                'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [item.setting_key, item.setting_value, item.setting_value]
            );
        }
        await connection.commit();
        // Reload settings เพื่อให้ค่าใหม่มีผลทันที
        updateSystemSettings();
        // invalidate LINE category cache (อาจเปลี่ยน toggles หรือ line_channel_token)
        invalidateLineCategoryCache();

        // === LINE notify: เฉพาะ key ที่ค่าเปลี่ยนจริงจากเดิม ===
        try {
            const sensitive = ['telegram_bot_token', 'line_channel_token'];
            // หา key ที่เปลี่ยนจริง — ใช้ string compare (DB เก็บเป็น VARCHAR)
            const changedSettings = settings.filter(s => {
                const oldVal = oldValuesMap.get(s.setting_key);
                // key ใหม่ที่ไม่เคยมีใน DB → ถือว่าเปลี่ยน (ยกเว้นค่าว่าง)
                if (oldVal === undefined) return String(s.setting_value || '') !== '';
                return String(oldVal) !== String(s.setting_value || '');
            });

            if (changedSettings.length === 0) {
                // ไม่มีการเปลี่ยนแปลงจริง → ไม่ส่ง LINE (กัน noise)
                console.log('[Settings] save without actual changes — skip LINE notify');
            } else {
                const mask = (key, val) => sensitive.includes(key) ? '***' : String(val || '').slice(0, 80) || '(ว่าง)';
                const detailLines = changedSettings.slice(0, 10).map(s => {
                    const oldV = mask(s.setting_key, oldValuesMap.get(s.setting_key));
                    const newV = mask(s.setting_key, s.setting_value);
                    return `• ${s.setting_key}\n   ↳ ${oldV} → ${newV}`;
                }).join('\n');
                const moreCount = changedSettings.length > 10 ? changedSettings.length - 10 : 0;
                const [actor] = await db.query('SELECT firstname, lastname, username FROM users WHERE id = ?', [req.user.userId]);
                const actorName = actor[0] ? `${actor[0].firstname} ${actor[0].lastname} (${actor[0].username})` : `user_id ${req.user.userId}`;
                notifyLineAction('settings_change',
                    `⚙️ Settings ถูกแก้ไข\n` +
                    `👤 ${actorName}\n` +
                    `🔧 เปลี่ยน ${changedSettings.length} key (จาก ${settings.length} ที่ส่ง)\n` +
                    detailLines +
                    (moreCount > 0 ? `\n... และอีก ${moreCount} key` : '')
                );
            }
        } catch (_) { /* don't fail save if LINE noti fails */ }

        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: 'Update failed' });
    } finally {
        connection.release();
    }
});

// ========== Role × Page Access — หน้า "สิทธิ์การเข้าถึงหน้า" (Super Admin) ==========

// GET /my-page-access — role ของ user ปัจจุบันเข้าหน้าไหนได้บ้าง (ทุก role ใช้ได้ — frontend เรียกตอน login/app init)
apiRouter.get('/my-page-access', authenticateToken, async (req, res) => {
    const role = req.user.role;
    const access = {};
    for (const page of PAGE_ACCESS_PAGES) access[page.key] = hasPageAccess(role, page.key);
    res.json({ success: true, role, access });
});

// GET /role-page-access — เมทริกซ์เต็ม 9 role × ทุกหน้า (super_admin เท่านั้น — จัดการหน้านี้เองไม่ผูกกับตาราง toggle ได้)
apiRouter.get('/role-page-access', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT role, page_key, is_enabled FROM role_page_access');
        res.json({
            success: true,
            roles: PAGE_ACCESS_ROLES,
            pages: PAGE_ACCESS_PAGES,
            data: rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /role-page-access — บันทึกทั้งเมทริกซ์ (super_admin เท่านั้น)
apiRouter.put('/role-page-access', authenticateToken, isSuperAdmin, async (req, res) => {
    const { items } = req.body; // [{ role, page_key, is_enabled }]
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่จะบันทึก' });
    }
    const validPageKeys = new Set(PAGE_ACCESS_PAGES.map(p => p.key));
    const validRoles = new Set(PAGE_ACCESS_ROLES);
    const clean = [];
    for (const it of items) {
        const role = String(it.role || '');
        const pageKey = String(it.page_key || '');
        if (!validRoles.has(role) || !validPageKeys.has(pageKey)) continue; // ข้าม role/page ที่ไม่รู้จัก (กัน payload มั่ว)
        clean.push([role, pageKey, it.is_enabled ? 1 : 0]);
    }
    if (clean.length === 0) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ถูกต้อง' });

    try {
        await db.query(
            `INSERT INTO role_page_access (role, page_key, is_enabled) VALUES ?
             ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
            [clean]
        );
        await loadRolePageAccessCache();
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId || null, 'UPDATE', 'role_page_access', JSON.stringify({ count: clean.length }), (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)]
        ).catch(() => {});
        res.json({ success: true, message: `บันทึกสิทธิ์การเข้าถึงหน้า ${clean.length} รายการสำเร็จ` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /my-action-access — สิทธิ์ "เพิ่ม"/"แก้ไข" ของ role ปัจจุบัน (ทุก role ใช้ได้)
apiRouter.get('/my-action-access', authenticateToken, async (req, res) => {
    const role = req.user.role;
    const access = {};
    for (const page of ACTION_ACCESS_PAGES) {
        access[page.key] = {};
        for (const action of ACTION_TYPES) access[page.key][action] = hasActionAccess(role, page.key, action);
    }
    res.json({ success: true, role, access });
});

// ========== ค่าการแสดงผลส่วนตัวของผู้ใช้ (UI preferences) ==========
// เก็บค่าต่อบัญชีผู้ใช้ (ใช้ได้ทุกเครื่องที่ login บัญชีเดียวกัน) เช่น คอลัมน์ที่แสดงในหน้าบันทึกผลงานตัวชี้วัด
// pref_key จำกัดเป็น whitelist กันเขียนค่าอะไรก็ได้ลงตาราง — ใช้ได้ทุก role (ไม่ map ใน PAGE_ACCESS_RULES)
const UI_PREF_KEYS = ['dashboard_columns'];

// สร้างตารางแบบ lazy — เรียกทั้งตอน startup และก่อนใช้ใน endpoint (ครั้งแรกเท่านั้น)
// กันกรณี migration ตอน startup ไม่ได้รัน/ล้มเหลวเงียบๆ แล้ว endpoint ตอบ 500 "Table doesn't exist"
let _uiPrefsTableReady = null;
function ensureUiPrefsTable() {
    if (!_uiPrefsTableReady) {
        _uiPrefsTableReady = db.query(`
            CREATE TABLE IF NOT EXISTS user_ui_prefs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                pref_key VARCHAR(50) NOT NULL,
                pref_value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_user_pref (user_id, pref_key),
                CONSTRAINT fk_user_ui_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `).catch(err => { _uiPrefsTableReady = null; throw err; }); // ล้มเหลว → ให้ลองใหม่ครั้งถัดไป
    }
    return _uiPrefsTableReady;
}

apiRouter.get('/my-ui-prefs/:key', authenticateToken, async (req, res) => {
    try {
        if (!UI_PREF_KEYS.includes(req.params.key)) return res.status(400).json({ success: false, message: 'pref_key ไม่ถูกต้อง' });
        await ensureUiPrefsTable();
        const [rows] = await db.query('SELECT pref_value FROM user_ui_prefs WHERE user_id = ? AND pref_key = ?', [req.user.userId, req.params.key]);
        let value = null;
        if (rows.length > 0) { try { value = JSON.parse(rows[0].pref_value); } catch (e) { value = null; } }
        res.json({ success: true, data: value });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.put('/my-ui-prefs/:key', authenticateToken, async (req, res) => {
    try {
        if (!UI_PREF_KEYS.includes(req.params.key)) return res.status(400).json({ success: false, message: 'pref_key ไม่ถูกต้อง' });
        await ensureUiPrefsTable();
        const json = JSON.stringify(req.body?.value ?? null);
        if (json.length > 5000) return res.status(400).json({ success: false, message: 'ข้อมูลมีขนาดใหญ่เกินไป' });
        await db.query(
            `INSERT INTO user_ui_prefs (user_id, pref_key, pref_value) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE pref_value = VALUES(pref_value)`,
            [req.user.userId, req.params.key, json]
        );
        res.json({ success: true, message: 'บันทึกการตั้งค่าเรียบร้อย' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /role-action-access — เมทริกซ์เต็ม (super_admin เท่านั้น)
apiRouter.get('/role-action-access', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT role, page_key, action, is_enabled FROM role_action_access');
        res.json({
            success: true,
            roles: ACTION_ACCESS_ROLES,
            pages: ACTION_ACCESS_PAGES,
            actions: ACTION_TYPES,
            data: rows
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /role-action-access — บันทึกทั้งเมทริกซ์ (super_admin เท่านั้น)
apiRouter.put('/role-action-access', authenticateToken, isSuperAdmin, async (req, res) => {
    const { items } = req.body; // [{ role, page_key, action, is_enabled }]
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่จะบันทึก' });
    }
    const validPageKeys = new Set(ACTION_ACCESS_PAGES.map(p => p.key));
    const validRoles = new Set(ACTION_ACCESS_ROLES);
    const validActions = new Set(ACTION_TYPES);
    const clean = [];
    for (const it of items) {
        const role = String(it.role || '');
        const pageKey = String(it.page_key || '');
        const action = String(it.action || '');
        if (!validRoles.has(role) || !validPageKeys.has(pageKey) || !validActions.has(action)) continue;
        clean.push([role, pageKey, action, it.is_enabled ? 1 : 0]);
    }
    if (clean.length === 0) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ถูกต้อง' });

    try {
        await db.query(
            `INSERT INTO role_action_access (role, page_key, action, is_enabled) VALUES ?
             ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled)`,
            [clean]
        );
        await loadRoleActionAccessCache();
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId || null, 'UPDATE', 'role_action_access', JSON.stringify({ count: clean.length }), (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)]
        ).catch(() => {});
        res.json({ success: true, message: `บันทึกสิทธิ์เพิ่ม/แก้ไขข้อมูล ${clean.length} รายการสำเร็จ` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- CRUD Main Yut (ยุทธศาสตร์) ---
apiRouter.get('/main-yut', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM main_yut ORDER BY id');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching strategies' });
    }
});

apiRouter.post('/main-yut', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { yut_name, yut_code, description, sort_order } = req.body;
    if (!yut_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อยุทธศาสตร์' });
    try {
        await db.query(
            'INSERT INTO main_yut (yut_name, yut_code, description, sort_order) VALUES (?, ?, ?, ?)',
            [yut_name, yut_code || null, description || null, sort_order || 0]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/main-yut/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { yut_name, yut_code, description, sort_order, is_active } = req.body;
    if (!yut_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อยุทธศาสตร์' });
    try {
        await db.query(
            'UPDATE main_yut SET yut_name=?, yut_code=?, description=?, sort_order=?, is_active=? WHERE id=?',
            [yut_name, yut_code || null, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.delete('/main-yut/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM main_yut WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting strategy' });
    }
});

// --- CRUD Main Indicators (ตัวชี้วัดหลัก) ---
apiRouter.get('/main-indicators', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT mi.*, my.yut_name 
            FROM kpi_main_indicators mi 
            LEFT JOIN main_yut my ON mi.yut_id = my.id 
            ORDER BY mi.id
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching main indicators' });
    }
});

apiRouter.post('/main-indicators', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const name = req.body.main_indicator_name || req.body.indicator_name;
    const { yut_id, main_indicator_code, description, sort_order } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหมวดหมู่หลัก' });
    try {
        await db.query(
            'INSERT INTO kpi_main_indicators (main_indicator_name, yut_id, main_indicator_code, description, sort_order) VALUES (?, ?, ?, ?, ?)',
            [name, yut_id || null, main_indicator_code || null, description || null, sort_order || 0]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/main-indicators/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const name = req.body.main_indicator_name || req.body.indicator_name;
    const { yut_id, main_indicator_code, description, sort_order, is_active } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหมวดหมู่หลัก' });
    try {
        await db.query(
            'UPDATE kpi_main_indicators SET main_indicator_name=?, yut_id=?, main_indicator_code=?, description=?, sort_order=?, is_active=? WHERE id=?',
            [name, yut_id || null, main_indicator_code || null, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.delete('/main-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_main_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting main indicator' });
    }
});

// --- CRUD KPI Indicators (ตัวชี้วัดย่อย) ---
apiRouter.get('/indicators', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let whereClause = '';
        const params = [];
        // กรองตาม dept ของ user — เฉพาะ role ที่ scope คือ "dept ตัวเอง" (ROLE_SCOPE_OWN_DEPT)
        // เดิมกรองด้วย user.deptId != null ตรงๆ ทำให้ admin_cup/admin_hos/admin_sso (scope "ทุก dept") โดนจำกัดผิดๆ
        // เวลาบัญชีของ role เหล่านั้นบังเอิญมี dept_id ติดตัวอยู่ (พบจริงจากข้อมูล — admin_cup 11/20 บัญชีมี dept_id)
        const conds = [];
        if (ROLE_SCOPE_OWN_DEPT.includes(user.role) && user.deptId != null) {
            conds.push('i.dept_id = ?');
            params.push(user.deptId);
        }
        // ค่าเริ่มต้น: เฉพาะตัวชี้วัดที่เปิดใช้งาน (dropdown ทั่วระบบ) — ?include_inactive=1 ให้หน้าจัดการตัวชี้วัดเห็นทุกตัว
        // (เฉพาะ role ที่เข้าหน้า kpi-manage ได้ — role อื่นส่งมาก็ได้แค่ตัวที่เปิดใช้งาน)
        const includeInactive = String(req.query.include_inactive || '') === '1' && hasPageAccess(user.role, 'kpi-manage');
        if (!includeInactive) conds.push('i.is_active = 1');
        if (conds.length) whereClause = 'WHERE ' + conds.join(' AND ');
        const [rows] = await db.query(`
            SELECT i.*, mi.main_indicator_name, COALESCE(mi.yut_id, i.main_yut) AS yut_id, my.yut_name, d.dept_name,
                   COALESCE(rc.cnt, 0) + COALESCE(src.cnt, 0) AS result_count
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN main_yut my ON my.id = COALESCE(mi.yut_id, i.main_yut)
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN (
                SELECT indicator_id, COUNT(*) AS cnt FROM kpi_results
                WHERE actual_value IS NOT NULL AND actual_value != '' GROUP BY indicator_id
            ) rc ON rc.indicator_id = i.id
            LEFT JOIN (
                SELECT si.indicator_id, COUNT(*) AS cnt FROM kpi_sub_results sr
                JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
                WHERE sr.actual_value IS NOT NULL AND sr.actual_value != '' GROUP BY si.indicator_id
            ) src ON src.indicator_id = i.id
            ${whereClause}
            ORDER BY i.id DESC
        `, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching indicators:', error);
        res.status(500).json({ success: false, message: 'Error fetching indicators' });
    }
});

// Helper: normalize required_off_types → JSON string หรือ null
const normalizeOffTypes = (v) => {
    if (v == null) return null;
    if (Array.isArray(v)) return v.length > 0 ? JSON.stringify(v.map(x => String(x))) : null;
    if (typeof v === 'string') {
        const trimmed = v.trim();
        if (!trimmed) return null;
        try { const parsed = JSON.parse(trimmed); return Array.isArray(parsed) && parsed.length > 0 ? JSON.stringify(parsed.map(x => String(x))) : null; }
        catch { return null; }
    }
    return null;
};
const normalizeEvalMode = (v) => (v === 'any_one' || v === 'all_required') ? v : null;

// Helper: ดึงชื่อ user สำหรับ message LINE
const _actorLabel = async (userId) => {
    try {
        const [r] = await db.query('SELECT firstname, lastname, username FROM users WHERE id = ?', [userId]);
        return r[0] ? `${r[0].firstname} ${r[0].lastname} (${r[0].username})` : `user_id ${userId}`;
    } catch (_) { return `user_id ${userId}`; }
};


apiRouter.post('/indicators/bulk-import', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลสำหรับนำเข้า' });
    const results = [];
    for (const row of rows) {
        const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula } = row;
        const formula = parseFormulaInput(result_formula);
        if (formula.error) { results.push({ name: kpi_indicators_name, status: 'error', message: formula.error }); continue; }
        try {
            const [r] = await db.query(
                `INSERT INTO kpi_indicators (kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, normTargetCondition(target_condition), criterion || null, weight || null, kpi_indicators_code || null, table_process || null, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types), is_cumulative ? 1 : 0, use_sub_indicator_export ? 1 : 0, formula.value]
            );
            results.push({ name: kpi_indicators_name, status: 'success', id: r.insertId });
        } catch (e) {
            results.push({ name: kpi_indicators_name, status: 'error', message: e.message });
        }
    }
    const inserted = results.filter(r => r.status === 'success').length;
    const errors = results.filter(r => r.status === 'error');
    try {
        const actor = await _actorLabel(req.user.userId);
        notifyLineAction('indicator_change',
            `📥 นำเข้าตัวชี้วัดจาก Excel\n` +
            `👤 ${actor}\n` +
            `✅ สำเร็จ: ${inserted} รายการ` +
            (errors.length ? `\n❌ ผิดพลาด: ${errors.length} รายการ` : '')
        );
    } catch (_) {}
    res.json({ success: true, inserted, errors, results });
});

// แนะนำรหัสสำหรับตัวชี้วัดใหม่ — ผู้ใช้ไม่ต้องคิดรหัสเอง (11 ต.ค. 2569)
//   ชื่อตาราง (table_process) = kpi_<หน่วยงาน>_<ลำดับ 3 หลัก> เช่น kpi_dh_001 — <หน่วยงาน> = รหัสย่อหน่วยงานถ้าเป็น a-z/0-9 (dh, ncd, ems)
//   ไม่งั้นใช้ d<id 2 หลัก> (เช่น d07) / ไม่เลือกหน่วยงาน = gen — ลำดับ = เลขถัดจากค่าสูงสุดที่มีอยู่ของ prefix เดียวกัน (ไม่ซ้ำ)
//   รหัสตัวชี้วัด (kpi_indicators_code) = ชื่อตารางแบบใช้ขีดกลาง (ตามรูปแบบข้อมูลเดิม เช่น excellence-indicator-1-1)
//   รหัสอ้างอิง (kpi_indicators_id) ไม่สร้างให้ — ในข้อมูลจริงคือเลขรายงานของ KHD ใช้เฉพาะตัวชี้วัดที่มาจาก KHD
async function suggestIndicatorCodes(conn, deptId) {
    let key = 'gen';
    if (deptId) {
        const [dRows] = await conn.query('SELECT id, dept_code FROM departments WHERE id = ?', [deptId]);
        if (dRows[0]) {
            const c = String(dRows[0].dept_code || '').trim().toLowerCase();
            key = /^[a-z][a-z0-9]{0,9}$/.test(c) ? c : 'd' + String(dRows[0].id).padStart(2, '0');
        }
    }
    const prefix = `kpi_${key}_`;
    const [rows] = await conn.query('SELECT table_process FROM kpi_indicators WHERE table_process LIKE ?', [prefix.replace(/_/g, '\\_') + '%']);
    let max = 0;
    for (const r of rows) {
        const m = String(r.table_process).slice(prefix.length).match(/^(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const table_process = prefix + String(max + 1).padStart(3, '0');
    return { table_process, kpi_indicators_code: table_process.replace(/_/g, '-') };
}

apiRouter.get('/indicators/suggest-code', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        const deptId = req.query.dept_id ? Number(req.query.dept_id) : null;
        res.json({ success: true, data: await suggestIndicatorCodes(db, Number.isFinite(deptId) ? deptId : null) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.post('/indicators', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    // ค่าเพิ่มเติมที่ตั้งชื่อเอง + สูตรร้อยละ (ตรวจชื่อตัวแปรในสูตรตามค่าที่ประกาศ)
    const cvars = normalizeCustomVars(req.body.custom_vars);
    if (cvars.error) return res.status(400).json({ success: false, message: cvars.error });
    const cvKeys = cvars.list.map(v => v.key);
    const formula = parseFormulaInput(result_formula, cvKeys);
    if (formula.error) return res.status(400).json({ success: false, message: formula.error });
    const pctF = parseFormulaInput(req.body.pct_formula, cvKeys, ['result'], 'สูตรร้อยละ');
    if (pctF.error) return res.status(400).json({ success: false, message: pctF.error });
    try {
        // ไม่ได้กรอกชื่อตาราง → ระบบสร้างรหัสให้อัตโนมัติ (รหัสตัวชี้วัดสร้างตามถ้าไม่ได้กรอก)
        let tpFinal = table_process && String(table_process).trim() ? String(table_process).trim() : null;
        let codeFinal = kpi_indicators_code && String(kpi_indicators_code).trim() ? String(kpi_indicators_code).trim() : null;
        if (!tpFinal) {
            const sug = await suggestIndicatorCodes(db, dept_id || null);
            tpFinal = sug.table_process;
        }
        if (!codeFinal) codeFinal = tpFinal.replace(/_/g, '-');
        const [r] = await db.query(
            `INSERT INTO kpi_indicators (kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, normTargetCondition(target_condition), criterion || null, weight || null, codeFinal, tpFinal, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types), is_cumulative ? 1 : 0, use_sub_indicator_export ? 1 : 0, formula.value]
        );
        // LINE notify: created
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `➕ สร้างตัวชี้วัดใหม่\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${r.insertId}\n` +
                `📌 ${kpi_indicators_name}` +
                `\n🔑 table_process: ${tpFinal}`
            );
        } catch (_) {}
        await saveHierarchyFields(db, 'kpi_indicators', r.insertId, req.body);
        res.json({ success: true, message: 'Created successfully', id: r.insertId, table_process: tpFinal, kpi_indicators_code: codeFinal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/indicators/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, is_active, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    // ค่าเพิ่มเติมที่ตั้งชื่อเอง + สูตรร้อยละ — ไม่ส่ง custom_vars/pct_formula มา = ใช้ค่าเดิม (ผู้เรียกเดิมไม่กระทบ)
    let cvKeys;
    let pctRaw = req.body.pct_formula;
    {
        const [cur] = await db.query('SELECT custom_vars, pct_formula FROM kpi_indicators WHERE id = ?', [req.params.id]).catch(() => [[]]);
        const cvars = req.body.custom_vars !== undefined ? normalizeCustomVars(req.body.custom_vars) : { list: customVarsOf(cur[0]), error: null };
        if (cvars.error) return res.status(400).json({ success: false, message: cvars.error });
        cvKeys = cvars.list.map(v => v.key);
        if (pctRaw === undefined && cur[0]) pctRaw = cur[0].pct_formula;
    }
    const formula = parseFormulaInput(result_formula, cvKeys);
    if (formula.error) return res.status(400).json({ success: false, message: formula.error });
    const pctF = parseFormulaInput(pctRaw, cvKeys, ['result'], 'สูตรร้อยละ');
    if (pctF.error) return res.status(400).json({ success: false, message: pctF.error });
    try {
        // ดึง old row เพื่อหาว่าฟิลด์ไหนเปลี่ยน (diff สั้นๆ)
        let diff = '';
        let calcChanged = false; // สูตร/สะสม เปลี่ยน → ต้องคำนวณ kpi_summary ใหม่
        try {
            const [oldRow] = await db.query('SELECT kpi_indicators_name, is_active, table_process, target_percentage, criterion, is_cumulative, result_formula FROM kpi_indicators WHERE id = ?', [req.params.id]);
            if (oldRow[0]) {
                const o = oldRow[0];
                const changes = [];
                if (o.kpi_indicators_name !== kpi_indicators_name) changes.push('ชื่อ');
                if (Number(o.is_active) !== (is_active ? 1 : 0)) changes.push(`สถานะ→${is_active ? 'เปิด' : 'ปิด'}`);
                if ((o.table_process || '') !== (table_process || '')) changes.push('table_process');
                if (String(o.target_percentage || '') !== String(target_percentage || '')) changes.push('เป้าหมาย');
                if (String(o.criterion || '') !== String(criterion || '')) changes.push('เกณฑ์');
                if ((o.result_formula || '') !== (formula.value || '')) {
                    changes.push(formula.value ? `สูตรคำนวณผลงาน→${formula.value}` : 'ยกเลิกสูตรคำนวณผลงาน');
                    calcChanged = true;
                }
                if (Number(o.is_cumulative || 0) !== (is_cumulative ? 1 : 0)) calcChanged = true;
                if (changes.length > 0) diff = `\n📝 เปลี่ยน: ${changes.join(', ')}`;
            }
        } catch (_) {}

        await db.query(
            `UPDATE kpi_indicators SET kpi_indicators_name=?, kpi_indicators_id=?, main_indicator_id=?, dept_id=?, target_percentage=?, target_condition=?, criterion=?, weight=?, kpi_indicators_code=?, is_active=?, table_process=?, description=?, r9=?, moph=?, ssj=?, rmw=?, other=?, evaluation_mode=?, required_off_types=?, is_cumulative=?, use_sub_indicator_export=?, result_formula=? WHERE id=?`,
            [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, normTargetCondition(target_condition), criterion || null, weight || null, kpi_indicators_code || null, is_active ? 1 : 0, table_process || null, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types), is_cumulative ? 1 : 0, use_sub_indicator_export ? 1 : 0, formula.value, req.params.id]
        );
        await saveHierarchyFields(db, 'kpi_indicators', req.params.id, req.body);

        // วิธีคำนวณผลงานเปลี่ยน → คำนวณ kpi_summary ของตัวชี้วัดนี้ใหม่ทุกปีงบทันที ให้กราฟ/รายงานตรงกับหน้าบันทึกผลงาน
        // (ไม่ต้องรอผู้ดูแลกด "อัปเดต Summary") — ทำนอก transaction หลัก ล้มเหลวไม่กระทบการบันทึกตัวชี้วัด
        if (calcChanged) {
            try {
                const [years] = await db.query('SELECT DISTINCT year_bh FROM kpi_summary WHERE indicator_id = ?', [req.params.id]);
                if (years.length > 0) {
                    await scheduleSummaryRefresh(years.map(y => ({ indicator_id: Number(req.params.id), year_bh: y.year_bh }))); // ผ่านคิวเดียวกับการบันทึกผลงาน (ไม่รันซ้อนคู่เดียวกัน)
                }
            } catch (e) { console.error('[indicators PUT] refresh kpi_summary failed:', e.message); }
        }
        // LINE notify: updated
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `✏️ แก้ไขตัวชี้วัด\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${req.params.id}\n` +
                `📌 ${kpi_indicators_name}` +
                diff
            );
        } catch (_) {}
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.delete('/indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        // เช็คผลงานที่บันทึกแล้วก่อนลบ — กันข้อมูลสูญหาย (mirror pattern เดียวกับ DELETE /hospitals/:hoscode)
        const [results] = await db.query(
            "SELECT COUNT(*) AS cnt FROM kpi_results WHERE indicator_id = ? AND actual_value IS NOT NULL AND actual_value != ''",
            [id]
        );
        const [subResults] = await db.query(
            `SELECT COUNT(*) AS cnt FROM kpi_sub_results sr
             JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
             WHERE si.indicator_id = ? AND sr.actual_value IS NOT NULL AND sr.actual_value != ''`,
            [id]
        );
        const [actResults] = await db.query(
            `SELECT COUNT(*) AS cnt FROM kpi_activity_results ar
             JOIN kpi_sub_activities a ON ar.activity_id = a.id
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
             WHERE si.indicator_id = ? AND ar.actual_value IS NOT NULL AND ar.actual_value != ''`,
            [id]
        );
        const totalResults = results[0].cnt + subResults[0].cnt + actResults[0].cnt;
        if (totalResults > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: มีผลงานบันทึกแล้ว ${totalResults} รายการ กรุณา "ปิดใช้งาน" แทนการลบ` });
        }
        // ดึงชื่อก่อนลบ
        let oldName = '';
        try {
            const [r] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [id]);
            if (r[0]) oldName = r[0].kpi_indicators_name;
        } catch (_) {}
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
        // LINE notify: deleted
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `🗑️ ลบตัวชี้วัด\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${req.params.id}` +
                (oldName ? `\n📌 ${oldName}` : '')
            );
        } catch (_) {}
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting indicator' });
    }
});

// GET /indicators/:id/result-summary — รายชื่อหน่วยบริการ+ปีที่มีผลงานบันทึกแล้ว (เรียกเมื่อคลิก badge เท่านั้น)
apiRouter.get('/indicators/:id/result-summary', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT r.hospcode, h.hosname, r.year_bh, COUNT(*) AS month_count
            FROM kpi_results r
            LEFT JOIN chospital h ON h.hoscode = r.hospcode
            WHERE r.indicator_id = ? AND r.actual_value IS NOT NULL AND r.actual_value != ''
            GROUP BY r.hospcode, r.year_bh
            ORDER BY r.year_bh DESC, h.hosname
        `, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// ========== KPI Sub-Indicators CRUD ==========
apiRouter.get('/sub-indicators', authenticateToken, async (req, res) => {
    try {
        const { indicator_id } = req.query;
        let sql = `SELECT si.*, i.kpi_indicators_name,
                   (SELECT COUNT(*) FROM kpi_sub_activities a WHERE a.sub_indicator_id = si.id AND a.is_active = 1) AS activity_count,
                   (SELECT COUNT(*) FROM kpi_sub_indicators c WHERE c.parent_sub_id = si.id AND c.is_active = 1) AS child_count
                   FROM kpi_sub_indicators si
                   LEFT JOIN kpi_indicators i ON si.indicator_id = i.id`;
        const params = [];
        if (indicator_id) { sql += ' WHERE si.indicator_id = ?'; params.push(indicator_id); }
        sql += ' ORDER BY si.indicator_id, si.sort_order, si.id';
        const [rows] = await db.query(sql, params);
        const byInd = new Map();
        for (const r of rows) { if (!byInd.has(r.indicator_id)) byInd.set(r.indicator_id, []); byInd.get(r.indicator_id).push(r); }
        for (const r of rows) r.level = subLevelIn(byInd.get(r.indicator_id), r.id);
        res.json({ success: true, data: rows, max_levels: await getHierarchyMaxLevels() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-indicators', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        let { indicator_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order, parent_sub_id } = req.body;
        let parentId = null;
        if (parent_sub_id !== undefined && parent_sub_id !== null && parent_sub_id !== '') {
            parentId = Number(parent_sub_id);
            const [[parent]] = await db.query('SELECT id, indicator_id FROM kpi_sub_indicators WHERE id = ?', [parentId]);
            if (!parent) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดย่อยที่เป็นข้อแม่' });
            if (indicator_id && Number(indicator_id) !== Number(parent.indicator_id)) {
                return res.status(400).json({ success: false, message: 'ข้อแม่ต้องอยู่ในตัวชี้วัดหลักเดียวกัน' });
            }
            indicator_id = parent.indicator_id;
            const [siblings] = await db.query('SELECT id, parent_sub_id FROM kpi_sub_indicators WHERE indicator_id = ?', [indicator_id]);
            const maxLevels = await getHierarchyMaxLevels();
            // ข้อย่อยใหม่ต้องเหลือที่ให้กิจกรรมอีก 1 ระดับ → ระดับของข้อใหม่ ≤ จำนวนระดับสูงสุด − 1
            if (subLevelIn(siblings, parentId) + 1 > maxLevels - 1) {
                return res.status(400).json({ success: false, message: `เพิ่มข้อย่อยได้ไม่เกิน ${maxLevels - 1} ระดับ (รวมตัวชี้วัดหลัก) — ระดับสุดท้ายสงวนไว้สำหรับกิจกรรม` });
            }
        }
        if (!indicator_id || !sub_indicator_name) return res.status(400).json({ success: false, message: 'indicator_id + sub_indicator_name required' });
        const [r] = await db.query(
            `INSERT INTO kpi_sub_indicators (indicator_id, parent_sub_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
            [indicator_id, parentId, sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0]
        );
        await saveHierarchyFields(db, 'kpi_sub_indicators', r.insertId, req.body);
        res.json({ success: true, id: r.insertId, message: 'เพิ่มตัวชี้วัดย่อยสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /sub-indicators/bulk-import — นำเข้าตัวชี้วัดย่อยหลายรายการจาก Excel (scoped ต่อ indicator_id เดียว)
apiRouter.post('/sub-indicators/bulk-import', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { indicator_id, rows } = req.body;
    if (!indicator_id) return res.status(400).json({ success: false, message: 'ไม่พบ indicator_id' });
    if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลสำหรับนำเข้า' });
    const [indRows] = await db.query('SELECT id FROM kpi_indicators WHERE id = ?', [indicator_id]);
    if (indRows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดหลัก' });

    const results = [];
    for (const row of rows) {
        const { sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order } = row;
        try {
            const [r] = await db.query(
                `INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order) VALUES (?,?,?,?,?,?,?)`,
                [indicator_id, sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0]
            );
            results.push({ name: sub_indicator_name, status: 'success', id: r.insertId });
        } catch (e) {
            results.push({ name: sub_indicator_name, status: 'error', message: e.message });
        }
    }
    const inserted = results.filter(r => r.status === 'success').length;
    const errors = results.filter(r => r.status === 'error');
    res.json({ success: true, inserted, errors, results });
});

apiRouter.put('/sub-indicators/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order, is_active } = req.body;
        await db.query(
            `UPDATE kpi_sub_indicators SET sub_indicator_name=?, sub_indicator_code=?, target_percentage=?, weight=?, description=?, sort_order=?, is_active=? WHERE id=?`,
            [sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        await saveHierarchyFields(db, 'kpi_sub_indicators', req.params.id, req.body);
        res.json({ success: true, message: 'แก้ไขสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/sub-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        // ลบข้อย่อย = ลบข้อลูก กิจกรรม และผลงานทั้งสาย (FK CASCADE) — ต้องไม่มีผลงานบันทึกอยู่ (เดิมไม่ตรวจ ลบผลงานเงียบๆ)
        const [[me]] = await db.query('SELECT id, indicator_id FROM kpi_sub_indicators WHERE id = ?', [req.params.id]);
        if (!me) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดย่อย' });
        const [all] = await db.query('SELECT id, parent_sub_id FROM kpi_sub_indicators WHERE indicator_id = ?', [me.indicator_id]);
        const ids = new Set([Number(me.id)]);
        for (let grew = true; grew;) {
            grew = false;
            for (const s of all) if (s.parent_sub_id != null && ids.has(Number(s.parent_sub_id)) && !ids.has(Number(s.id))) { ids.add(Number(s.id)); grew = true; }
        }
        const idList = [...ids];
        const [[c]] = await db.query(
            `SELECT (SELECT COUNT(*) FROM kpi_sub_results WHERE sub_indicator_id IN (?) AND actual_value IS NOT NULL AND actual_value <> '')
                  + (SELECT COUNT(*) FROM kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id
                     WHERE a.sub_indicator_id IN (?) AND ar.actual_value IS NOT NULL AND ar.actual_value <> '') AS cnt`, [idList, idList]);
        if (Number(c.cnt) > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: ข้อนี้หรือระดับล่างมีผลงานบันทึกแล้ว ${c.cnt} รายการ กรุณา "ปิดใช้งาน" แทนการลบ` });
        }
        await db.query('DELETE FROM kpi_sub_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-indicators/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE kpi_sub_indicators SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== ตัวชี้วัด 3 ระดับ (18 ต.ค. 2569): หลัก 1 → ย่อย 1.1 → กิจกรรม 1.1.1 ==========
// item_no = เลขข้อที่แสดง (ว่าง = หน้าจอสร้างจากลำดับ), sub_rollup_mode (ตัวชี้วัดหลัก) / rollup_mode (ข้อย่อย) = 'auto' | 'manual'
// อัปเดตเฉพาะฟิลด์ที่ส่งมา — ผู้เรียกเดิม (KHD sync, คัดลอก, นำเข้า) ที่ไม่ส่งฟิลด์เหล่านี้ไม่ถูกเปลี่ยนค่า
async function saveHierarchyFields(conn, table, id, body) {
    const sets = [], params = [];
    if (body && body.item_no !== undefined) {
        sets.push('item_no = ?');
        params.push(String(body.item_no || '').trim().slice(0, 20) || null);
    }
    const modeKey = table === 'kpi_indicators' ? 'sub_rollup_mode' : 'rollup_mode';
    if (body && body[modeKey] !== undefined) {
        sets.push(`${modeKey} = ?`);
        params.push(body[modeKey] === 'auto' ? 'auto' : 'manual');
    }
    if (table === 'kpi_indicators' && body && body.export_items !== undefined) {
        sets.push('export_items = ?');
        params.push(body.export_items === true || Number(body.export_items) === 1 ? 1 : 0);
    }
    if (table === 'kpi_indicators' && body && body.custom_vars !== undefined) {
        const list = normalizeCustomVars(body.custom_vars).list;
        sets.push('custom_vars = ?');
        params.push(list.length ? JSON.stringify(list) : null);
    }
    if (table === 'kpi_indicators' && body && body.pct_formula !== undefined) {
        sets.push('pct_formula = ?');
        params.push(String(body.pct_formula || '').trim().slice(0, 500) || null);
    }
    // ยุทธศาสตร์ของตัวชี้วัดโดยตรง (ใช้แสดงเมื่อไม่มีหมวดหมู่หลัก — 19 ต.ค. 2569)
    if (table === 'kpi_indicators' && body && body.main_yut !== undefined) {
        const y = Number(body.main_yut);
        sets.push('main_yut = ?');
        params.push(Number.isInteger(y) && y > 0 ? y : null);
    }
    if (sets.length === 0) return;
    await conn.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

// --- CRUD กิจกรรม (สิทธิ์เดียวกับตัวชี้วัดย่อย: เพิ่ม/แก้ไขตาม requireAction, ลบ = super_admin เท่านั้น) ---
const normalizeActivityType = (t) => (t === 'check' ? 'check' : 'number');
apiRouter.get('/sub-activities', authenticateToken, async (req, res) => {
    try {
        const { sub_indicator_id, indicator_id } = req.query;
        const conds = [], params = [];
        if (sub_indicator_id) { conds.push('a.sub_indicator_id = ?'); params.push(sub_indicator_id); }
        if (indicator_id) { conds.push('si.indicator_id = ?'); params.push(indicator_id); }
        const [rows] = await db.query(
            `SELECT a.*, si.indicator_id, si.sub_indicator_name FROM kpi_sub_activities a
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
             ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
             ORDER BY a.sub_indicator_id, a.sort_order, a.id`, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-activities', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        const { sub_indicator_id, activity_name, activity_code, item_no, value_type, target_percentage, sort_order } = req.body;
        if (!sub_indicator_id || !activity_name || !String(activity_name).trim()) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุตัวชี้วัดย่อยและชื่อกิจกรรม' });
        }
        const [si] = await db.query('SELECT id, indicator_id FROM kpi_sub_indicators WHERE id = ?', [sub_indicator_id]);
        if (si.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดย่อย' });
        const [tree] = await db.query('SELECT id, parent_sub_id FROM kpi_sub_indicators WHERE indicator_id = ?', [si[0].indicator_id]);
        const maxLevels = await getHierarchyMaxLevels();
        if (subLevelIn(tree, sub_indicator_id) + 1 > maxLevels) {
            return res.status(400).json({ success: false, message: `กิจกรรมต้องอยู่ไม่เกินระดับที่ ${maxLevels}` });
        }
        const [r] = await db.query(
            `INSERT INTO kpi_sub_activities (sub_indicator_id, activity_name, activity_code, item_no, value_type, target_percentage, sort_order)
             VALUES (?,?,?,?,?,?,?)`,
            [sub_indicator_id, String(activity_name).trim(), activity_code || null, String(item_no || '').trim().slice(0, 20) || null,
             normalizeActivityType(value_type), target_percentage || null, Number(sort_order) || 0]);
        res.json({ success: true, id: r.insertId, message: 'เพิ่มกิจกรรมสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-activities/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { activity_name, activity_code, item_no, value_type, target_percentage, sort_order, is_active } = req.body;
        if (!activity_name || !String(activity_name).trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อกิจกรรม' });
        await db.query(
            `UPDATE kpi_sub_activities SET activity_name=?, activity_code=?, item_no=?, value_type=?, target_percentage=?, sort_order=?, is_active=? WHERE id=?`,
            [String(activity_name).trim(), activity_code || null, String(item_no || '').trim().slice(0, 20) || null,
             normalizeActivityType(value_type), target_percentage || null, Number(sort_order) || 0, is_active === undefined || is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: 'แก้ไขสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-activities/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE kpi_sub_activities SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/sub-activities/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [[cnt]] = await db.query("SELECT COUNT(*) AS cnt FROM kpi_activity_results WHERE activity_id = ? AND actual_value IS NOT NULL AND actual_value != ''", [req.params.id]);
        if (cnt.cnt > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: มีผลงานบันทึกแล้ว ${cnt.cnt} รายการ กรุณา "ปิดใช้งาน" แทนการลบ` });
        }
        await db.query('DELETE FROM kpi_sub_activities WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ขอบเขตหน่วยบริการตามบทบาท (ROLE_SCOPE_HOSPCODE = หน่วยบริการตัวเอง, ROLE_SCOPE_DISTRICT = อำเภอตัวเอง, อื่นๆ = ทุกหน่วย)
async function canAccessHospcode(user, hospcode) {
    if (!hospcode) return false;
    if (ROLE_SCOPE_HOSPCODE.includes(user.role)) return String(user.hospcode || '') === String(hospcode);
    if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
        const [mine, target] = await Promise.all([getDistrictId(user.hospcode), getDistrictId(hospcode)]);
        return !!mine && mine === target;
    }
    return true;
}

// สถานะ "ล็อคการคีย์ข้อมูล" ของระบบ (ตั้งค่าที่หน้า settings) — ใช้ร่วม GET /data-entry-lock และการบันทึกผลงานระดับย่อย/กิจกรรม
async function getDataEntryLockState() {
    const keys = ['data_entry_locked', 'data_entry_lock_start', 'data_entry_lock_end', 'data_entry_lock_days'];
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
    const st = {};
    for (const r of rows) st[r.setting_key] = r.setting_value;
    const manualLock = st.data_entry_locked === 'true';
    const startDate = st.data_entry_lock_start || '';
    let effectiveEnd = st.data_entry_lock_end || '';
    const lockDays = parseInt(st.data_entry_lock_days) || 0;
    if (startDate && lockDays > 0) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + lockDays);
        effectiveEnd = d.toISOString().split('T')[0];
    }
    const today = new Date().toISOString().split('T')[0];
    return manualLock || !!(startDate && effectiveEnd && today >= startDate && today <= effectiveEnd);
}

// GET /hierarchy-results?indicator_id=&year_bh=&hospcode= — โครงสร้างข้อย่อย + กิจกรรม + ผลงานรายเดือนของ 1 แถวในหน้าบันทึกผลงาน
// (โหลดเมื่อผู้ใช้กดขยายแถว) — หน้าจอคำนวณค่าระดับบนเองด้วย shared/kpi-rollup.ts (กติกาเดียวกับ backend)
apiRouter.get('/hierarchy-results', authenticateToken, async (req, res) => {
    try {
        const { indicator_id, year_bh, hospcode } = req.query;
        if (!indicator_id || !year_bh || !hospcode) return res.status(400).json({ success: false, message: 'ต้องระบุ indicator_id, year_bh, hospcode' });
        if (!(await canAccessHospcode(req.user, hospcode))) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูข้อมูลหน่วยบริการนี้' });
        const [[ind]] = await db.query('SELECT id, item_no, sub_rollup_mode FROM kpi_indicators WHERE id = ?', [indicator_id]);
        if (!ind) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัด' });
        const [allSubs] = await db.query(
            `SELECT id, parent_sub_id, is_active, sub_indicator_name, sub_indicator_code, item_no, rollup_mode, target_percentage, sort_order
             FROM kpi_sub_indicators WHERE indicator_id = ? ORDER BY sort_order, id`, [indicator_id]);
        // เฉพาะข้อที่เปิดใช้งานและข้อแม่ทุกชั้นเปิดใช้งาน (ตัวชี้วัดหลายระดับ — 19 ต.ค. 2569)
        const subs = activeSubTree(allSubs).map(({ is_active, ...rest }) => rest);
        const subIds = subs.map(x => x.id);
        let acts = [], subRes = [], actRes = [];
        if (subIds.length > 0) {
            [acts] = await db.query(
                `SELECT id, sub_indicator_id, activity_name, activity_code, item_no, value_type, target_percentage, sort_order
                 FROM kpi_sub_activities WHERE sub_indicator_id IN (?) AND is_active = 1 ORDER BY sort_order, id`, [subIds]);
            [subRes] = await db.query(
                'SELECT sub_indicator_id, month_bh, target_value, actual_value, is_locked FROM kpi_sub_results WHERE sub_indicator_id IN (?) AND year_bh = ? AND hospcode = ?',
                [subIds, year_bh, hospcode]);
            if (acts.length > 0) {
                [actRes] = await db.query(
                    'SELECT activity_id, month_bh, target_value, actual_value, is_locked FROM kpi_activity_results WHERE activity_id IN (?) AND year_bh = ? AND hospcode = ?',
                    [acts.map(a => a.id), year_bh, hospcode]);
            }
        }
        const pack = (rows, idKey) => {
            const m = new Map();
            for (const r of rows) {
                if (!m.has(r[idKey])) m.set(r[idKey], { months: {}, target: null, locked: false });
                const e = m.get(r[idKey]);
                e.months[Number(r.month_bh)] = r.actual_value != null ? String(r.actual_value) : '';
                if (Number(r.month_bh) === 10 && r.target_value != null && r.target_value !== '') e.target = String(r.target_value);
                if (Number(r.is_locked) === 1) e.locked = true;
            }
            return m;
        };
        const subMap = pack(subRes, 'sub_indicator_id'), actMap = pack(actRes, 'activity_id');
        const empty = { months: {}, target: null, locked: false };
        res.json({
            success: true,
            data: {
                indicator_id: ind.id, item_no: ind.item_no, sub_rollup_mode: ind.sub_rollup_mode || 'auto', max_levels: await getHierarchyMaxLevels(),
                subs: subs.map(x => ({ ...x, rollup_mode: x.rollup_mode || 'manual', ...(subMap.get(x.id) || empty) })),
                activities: acts.map(a => ({ ...a, ...(actMap.get(a.id) || empty) })),
            }
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /hierarchy-results/save — บันทึกผลงานข้อย่อย + กิจกรรม ของ 1 หน่วยบริการ × 1 ปีงบ ในคราวเดียว (transaction)
// body: { year_bh, hospcode, sub: [{ sub_indicator_id, month_bh, actual_value, target_value? }], activity: [{ activity_id, month_bh, actual_value, target_value? }] }
// ตรวจ: ขอบเขตหน่วยบริการ, ล็อคการคีย์ของระบบ (user ทั่วไป), ล็อคจากการอนุมัติ (super_admin ข้ามได้), สิทธิ์แก้ผลงาน/เป้าหมายรายบุคคล,
//       ห้ามกรอกข้อย่อยที่ "คำนวณจากกิจกรรม" (มีกิจกรรมเปิดใช้งานอยู่) — ค่า 0 เก็บเป็น '0', ค่าว่าง = ลบค่าเดิม (NULL)
apiRouter.post('/hierarchy-results/save', authenticateToken, async (req, res) => {
    const user = req.user;
    const { year_bh, hospcode } = req.body || {};
    const subItems = Array.isArray(req.body?.sub) ? req.body.sub : [];
    const actItems = Array.isArray(req.body?.activity) ? req.body.activity : [];
    if (!year_bh || !hospcode) return res.status(400).json({ success: false, message: 'ต้องระบุ year_bh และ hospcode' });
    if (subItems.length + actItems.length === 0) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ต้องบันทึก' });
    const validMonth = (m) => Number.isInteger(Number(m)) && Number(m) >= 1 && Number(m) <= 12;
    const norm = (v) => (v === 0 || (v !== null && v !== undefined && String(v).trim() !== '')) ? String(v).trim() : null;
    for (const it of [...subItems, ...actItems]) {
        if (!validMonth(it.month_bh)) return res.status(400).json({ success: false, message: 'เดือนไม่ถูกต้อง' });
        for (const k of ['actual_value', 'target_value']) {
            const v = norm(it[k]);
            if (v !== null && v.length > 100) return res.status(400).json({ success: false, message: 'ค่าที่บันทึกยาวเกิน 100 ตัวอักษร' });
        }
    }
    try {
        if (!(await canAccessHospcode(user, hospcode))) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์บันทึกข้อมูลหน่วยบริการนี้' });
        if (!ROLE_ADMIN_ALL.includes(user.role) && await getDataEntryLockState()) {
            return res.status(403).json({ success: false, message: 'ระบบปิดการคีย์ข้อมูลชั่วคราว' });
        }
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        // ข้อมูลข้อย่อย/กิจกรรมที่อ้างถึง → ตัวชี้วัดหลักที่เกี่ยวข้อง
        const subIds = [...new Set(subItems.map(x => Number(x.sub_indicator_id)))];
        const actIds = [...new Set(actItems.map(x => Number(x.activity_id)))];
        const [subRows] = subIds.length ? await conn.query('SELECT id, indicator_id, rollup_mode FROM kpi_sub_indicators WHERE id IN (?)', [subIds]) : [[]];
        const [actRows] = actIds.length ? await conn.query(
            `SELECT a.id, a.value_type, si.indicator_id, si.id AS sub_indicator_id FROM kpi_sub_activities a
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id WHERE a.id IN (?)`, [actIds]) : [[]];
        if (subRows.length !== subIds.length || actRows.length !== actIds.length) throw Object.assign(new Error('ไม่พบตัวชี้วัดย่อยหรือกิจกรรมที่ระบุ'), { status: 404 });
        const subById = new Map(subRows.map(r => [r.id, r]));
        const actById = new Map(actRows.map(r => [r.id, r]));

        // ข้อย่อยที่คำนวณจากระดับล่าง (auto + มีข้อลูก/กิจกรรมเปิดใช้งาน) กรอกเองไม่ได้
        if ((await rolledSubIds(conn, subIds)).size > 0) throw Object.assign(new Error(ROLLED_SUB_MESSAGE), { status: 400 });

        const indicatorIds = [...new Set([...subRows.map(r => r.indicator_id), ...actRows.map(r => r.indicator_id)])];
        // user ทั่วไปบันทึกได้เฉพาะตัวชี้วัดของหน่วยงานตัวเอง (เหมือน /update-kpi)
        if (!ROLE_ADMIN_ALL.includes(user.role)) {
            const [allowed] = await conn.query('SELECT id FROM kpi_indicators WHERE id IN (?) AND dept_id = ?', [indicatorIds, user.deptId]);
            if (allowed.length !== indicatorIds.length) throw Object.assign(new Error('ไม่มีสิทธิ์แก้ไขข้อมูลหน่วยงานอื่น'), { status: 403 });
        }
        // ล็อคจากการอนุมัติ — ตัวชี้วัดหลักที่ล็อคแล้ว ข้อย่อย/กิจกรรมของมันแก้ไม่ได้ (super_admin ข้ามได้)
        if (user.role !== 'super_admin') {
            const [locked] = await conn.query(
                'SELECT DISTINCT indicator_id FROM kpi_results WHERE indicator_id IN (?) AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [indicatorIds, year_bh, hospcode]);
            const [subLocked] = subIds.length ? await conn.query(
                'SELECT COUNT(*) AS cnt FROM kpi_sub_results WHERE sub_indicator_id IN (?) AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [subIds, year_bh, hospcode]) : [[{ cnt: 0 }]];
            const [actLocked] = actIds.length ? await conn.query(
                'SELECT COUNT(*) AS cnt FROM kpi_activity_results WHERE activity_id IN (?) AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [actIds, year_bh, hospcode]) : [[{ cnt: 0 }]];
            if (locked.length || subLocked[0].cnt > 0 || actLocked[0].cnt > 0) {
                throw Object.assign(new Error('ไม่สามารถแก้ไขได้ ตัวชี้วัดนี้ถูกล็อคอยู่ (ได้รับการอนุมัติแล้ว)'), { status: 403 });
            }
        }
        const perms = await getPermsForUser(user.userId, user.role);

        const upsert = async (table, idCol, id, it, valueType) => {
            let actual = norm(it.actual_value);
            if (valueType === 'check' && actual !== null) actual = kpiRollup.activityValue('check', actual) === 100 ? '1' : '0';
            const hasTarget = it.target_value !== undefined;
            const target = norm(it.target_value);
            const [ex] = await conn.query(`SELECT target_value, actual_value FROM ${table} WHERE ${idCol} = ? AND year_bh = ? AND hospcode = ? AND month_bh = ?`,
                [id, year_bh, hospcode, Number(it.month_bh)]);
            const old = ex[0] || {};
            // ไม่มีสิทธิ์แก้ผลงาน/เป้าหมาย → คงค่าเดิม (เหมือน /update-kpi)
            const finalActual = perms.can_edit_actual ? actual : (old.actual_value ?? null);
            const finalTarget = (hasTarget && perms.can_edit_target) ? target : (old.target_value ?? null);
            await conn.query(
                `INSERT INTO ${table} (${idCol}, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id)
                 VALUES (?,?,?,?,?,?, 'Pending', ?)
                 ON DUPLICATE KEY UPDATE target_value = VALUES(target_value), actual_value = VALUES(actual_value), user_id = VALUES(user_id)`,
                [id, year_bh, hospcode, Number(it.month_bh), finalTarget, finalActual, user.userId]);
        };
        for (const it of subItems) await upsert('kpi_sub_results', 'sub_indicator_id', Number(it.sub_indicator_id), it, 'number');
        for (const it of actItems) await upsert('kpi_activity_results', 'activity_id', Number(it.activity_id), it, actById.get(Number(it.activity_id)).value_type);
        await conn.commit();

        (async () => {
            try {
                const userInfo = await getUserAuditInfo(user.userId);
                for (const indId of indicatorIds) {
                    const nSub = subItems.filter(x => subById.get(Number(x.sub_indicator_id)).indicator_id === indId).length;
                    const nAct = actItems.filter(x => actById.get(Number(x.activity_id)).indicator_id === indId).length;
                    await logKpiSaveAudit({
                        ...(userInfo || { user_id: user.userId, username: user.username }),
                        hospcode, action_type: 'hierarchy_results', indicator_id: indId, year_bh,
                        row_count: nSub + nAct, summary: `ข้อย่อย ${nSub} ช่อง, กิจกรรม ${nAct} ช่อง`,
                        ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                    });
                }
            } catch (e) { console.warn('[KPI Audit] hierarchy log error:', e.message); }
        })();
        refreshSummaryAfterSubSave(indicatorIds.map(id => ({ indicator_id: id, year_bh })));
        res.json({ success: true, message: 'บันทึกสำเร็จ', saved: subItems.length + actItems.length });
    } catch (e) {
        await conn.rollback();
        res.status(e.status || 500).json({ success: false, message: e.message });
    } finally {
        conn.release();
    }
});

// ========== KPI Sub-Results (บันทึกผลงานย่อย) ==========
apiRouter.get('/sub-results', authenticateToken, async (req, res) => {
    try {
        const { sub_indicator_id, year_bh, hospcode, indicator_id } = req.query;
        const conditions = []; const params = [];
        if (sub_indicator_id) { conditions.push('sr.sub_indicator_id = ?'); params.push(sub_indicator_id); }
        if (indicator_id) { conditions.push('si.indicator_id = ?'); params.push(indicator_id); }
        if (year_bh) { conditions.push('sr.year_bh = ?'); params.push(year_bh); }
        if (hospcode) { conditions.push('sr.hospcode = ?'); params.push(hospcode); }
        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const [rows] = await db.query(
            `SELECT sr.*, si.sub_indicator_name, si.indicator_id FROM kpi_sub_results sr
             JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
             ${where} ORDER BY sr.sub_indicator_id, sr.hospcode, sr.month_bh`,
            params
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// GET /sub-results/summary — aggregate ต่อ indicator + hospcode (รวม monthly breakdown) — ดู loadSubAggregates()
apiRouter.get('/sub-results/summary', authenticateToken, async (req, res) => {
    try {
        const { year_bh, hospcode } = req.query;
        const rows = await loadSubAggregates(db, { yearBh: year_bh, hospcode });
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-results/upsert', authenticateToken, async (req, res) => {
    try {
        const { sub_indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status } = req.body;
        if (!sub_indicator_id || !year_bh || !hospcode || !month_bh) {
            return res.status(400).json({ success: false, message: 'sub_indicator_id, year_bh, hospcode, month_bh required' });
        }
        // ข้อย่อยที่คำนวณจากระดับล่าง (ข้อลูก/กิจกรรม) กรอกเองไม่ได้ — บันทึกที่ระดับล่างแทน
        if ((await rolledSubIds(db, [sub_indicator_id])).size > 0) return res.status(400).json({ success: false, message: ROLLED_SUB_MESSAGE });
        // ตรวจสอบล็อค (super_admin ข้ามได้) — mirror /update-kpi (ล็อคจะถูก cascade มาจากตัวชี้วัดหลักตอนอนุมัติ)
        if (req.user.role !== 'super_admin') {
            const [lockedRows] = await db.query(
                'SELECT COUNT(*) as cnt FROM kpi_sub_results WHERE sub_indicator_id = ? AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [sub_indicator_id, year_bh, hospcode]
            );
            if (lockedRows[0].cnt > 0) {
                return res.status(403).json({ success: false, message: 'ไม่สามารถแก้ไขได้ ตัวชี้วัดย่อยนี้ถูกล็อคอยู่ (ตัวชี้วัดหลักได้รับการอนุมัติแล้ว)' });
            }
        }
        await db.query(
            `INSERT INTO kpi_sub_results (sub_indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id)
             VALUES (?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE target_value=VALUES(target_value), actual_value=VALUES(actual_value), status=VALUES(status), user_id=VALUES(user_id)`,
            [sub_indicator_id, year_bh, hospcode, month_bh, target_value || null, (actual_value === 0 || actual_value) ? actual_value : null, status || 'Pending', req.user.userId]
        );

        // === KPI Save Audit (fire-and-forget) ===
        (async () => {
            try {
                const userInfo = await getUserAuditInfo(req.user.userId);
                // ดึง parent indicator
                const [siRows] = await db.query(`
                    SELECT si.indicator_id, si.sub_indicator_name, i.kpi_indicators_name
                    FROM kpi_sub_indicators si
                    LEFT JOIN kpi_indicators i ON si.indicator_id = i.id
                    WHERE si.id = ?
                `, [sub_indicator_id]);
                const parentIndName = siRows[0]?.kpi_indicators_name || null;
                const subName = siRows[0]?.sub_indicator_name || null;
                await logKpiSaveAudit({
                    ...(userInfo || { user_id: req.user.userId, username: req.user.username }),
                    hospcode,
                    action_type: 'sub_results',
                    indicator_id: siRows[0]?.indicator_id || null,
                    indicator_name: parentIndName ? `${parentIndName} / ${subName}` : subName,
                    year_bh, month_bh,
                    row_count: 1,
                    summary: `sub: ${subName || sub_indicator_id}`,
                    ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                });
            } catch (e) { console.warn('[KPI Audit] sub-results log error:', e.message); }
        })();
        db.query('SELECT indicator_id FROM kpi_sub_indicators WHERE id = ?', [sub_indicator_id])
            .then(([r]) => r[0] && refreshSummaryAfterSubSave([{ indicator_id: r[0].indicator_id, year_bh }]))
            .catch(e => console.error('[sub-results] refresh kpi_summary failed:', e.message));

        res.json({ success: true, message: 'บันทึกสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/sub-results/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_sub_results WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// --- Toggle is_active สำหรับ Master Data ทั้ง 4 ตาราง ---
apiRouter.put('/indicators/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE kpi_indicators SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling indicator' });
    }
});

apiRouter.put('/main-indicators/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE kpi_main_indicators SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling main indicator' });
    }
});

apiRouter.put('/main-yut/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE main_yut SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling strategy' });
    }
});

apiRouter.put('/departments/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE departments SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling department' });
    }
});

// อนุมัติผล KPI และ Lock ข้อมูล (รองรับทั้งรายการเดียวและหลายรายการ)
// Cascade สถานะ/ล็อคจากตัวชี้วัดหลักไปตัวชี้วัดย่อยทั้งหมดของ indicator นั้น (join ผ่าน kpi_sub_indicators)
// ใช้โดย approve/reject/unlock/appeal ทุกจุด — ให้ kpi_sub_results.status/is_locked mirror ค่าที่ตั้งบน kpi_results เสมอ
async function cascadeSubResultsStatus(dbOrConn, indicator_id, year_bh, hospcode, status, is_locked) {
    let sql = `UPDATE kpi_sub_results sr
               JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
               SET sr.status = ?, sr.is_locked = ?
               WHERE si.indicator_id = ? AND sr.year_bh = ?`;
    const params = [status, is_locked, indicator_id, year_bh];
    if (hospcode) { sql += ' AND sr.hospcode = ?'; params.push(hospcode); }
    await dbOrConn.query(sql, params);
    // ระดับกิจกรรม (ตัวชี้วัด 3 ระดับ) — mirror เหมือนข้อย่อย
    let asql = `UPDATE kpi_activity_results ar
               JOIN kpi_sub_activities a ON ar.activity_id = a.id
               JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
               SET ar.status = ?, ar.is_locked = ?
               WHERE si.indicator_id = ? AND ar.year_bh = ?`;
    const aparams = [status, is_locked, indicator_id, year_bh];
    if (hospcode) { asql += ' AND ar.hospcode = ?'; aparams.push(hospcode); }
    await dbOrConn.query(asql, aparams);
}

apiRouter.post('/approve-kpi', authenticateToken, isAdmin, async (req, res) => {
    const user = req.user;
    // รองรับทั้ง object เดียว และ array หลายรายการ
    const items = Array.isArray(req.body) ? req.body : [req.body];

    if (items.length === 0 || !items[0].indicator_id) {
        return res.status(400).json({ success: false, message: 'No approval data' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        for (const item of items) {
            let whereClause = 'indicator_id = ? AND year_bh = ?';
            let params = [item.indicator_id, item.year_bh];

            // ใช้ hospcode จาก request body (ของหน่วยบริการเป้าหมาย) ถ้ามี
            // ถ้าไม่มีและไม่ใช่ super_admin ให้ใช้ hospcode ของ admin เอง
            if (item.hospcode) {
                whereClause += ' AND hospcode = ?';
                params.push(item.hospcode);
            } else if (user.role !== 'super_admin') {
                whereClause += ' AND hospcode = ?';
                params.push(user.hospcode);
            }

            await connection.query(
                `UPDATE kpi_results SET status = 'Approved', is_locked = 1 WHERE ${whereClause}`,
                params
            );
            // Cascade ไปตัวชี้วัดย่อย (ถ้ามี) — hospcode เดียวกับที่ใช้ตัดสินใน whereClause ด้านบน
            const cascadeHospcode = item.hospcode || (user.role !== 'super_admin' ? user.hospcode : null);
            await cascadeSubResultsStatus(connection, item.indicator_id, item.year_bh, cascadeHospcode, 'Approved', 1);
        }

        // Create notifications for approved items
        for (const item of items) {
            const targetHospcode = item.hospcode || user.hospcode;
            const [indRows] = await connection.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [item.indicator_id]);
            const indName = indRows.length > 0 ? indRows[0].kpi_indicators_name : `ตัวชี้วัด #${item.indicator_id}`;
            await connection.query(
                'INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [targetHospcode, 'approve', 'ตัวชี้วัดได้รับการอนุมัติ', `"${indName}" ปีงบ ${item.year_bh} ได้รับการอนุมัติและล็อคข้อมูลแล้ว`, item.indicator_id, item.year_bh, user.userId]
            );
        }

        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPROVE', 'kpi_results', JSON.stringify({ count: items.length, message: `อนุมัติและล็อคข้อมูล ${items.length} รายการ` }), req.ip]
        );

        await connection.commit();
        scheduleSummaryRefresh(items); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: `อนุมัติและล็อคข้อมูลเรียบร้อยแล้ว ${items.length} รายการ` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// ปลดล็อคข้อมูล KPI (เฉพาะ super_admin)
apiRouter.post('/unlock-kpi', authenticateToken, isSuperAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.body;
    const user = req.user;

    try {
        await db.query(
            "UPDATE kpi_results SET is_locked = 0, status = 'Pending' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade ไปตัวชี้วัดย่อย (ถ้ามี)
        await cascadeSubResultsStatus(db, indicator_id, year_bh, hospcode, 'Pending', 0);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UNLOCK', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, message: 'ปลดล็อคข้อมูล' }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ปลดล็อคข้อมูลเรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST /unlock-kpi-all — ปลดล็อคทั้งหมดตามปี (super_admin)
apiRouter.post('/unlock-kpi-all', authenticateToken, isSuperAdmin, async (req, res) => {
    const { year_bh } = req.body;
    if (!year_bh) return res.status(400).json({ success: false, message: 'กรุณาเลือกปีงบประมาณ' });
    try {
        const [result] = await db.query(
            "UPDATE kpi_results SET is_locked = 0, status = 'Pending' WHERE year_bh = ? AND is_locked = 1",
            [year_bh]
        );
        // Cascade ไปตัวชี้วัดย่อยทั้งหมดที่ล็อคอยู่ในปีนี้ (ไม่กรอง indicator — unlock ทั้งปี)
        await db.query(
            "UPDATE kpi_sub_results SET is_locked = 0, status = 'Pending' WHERE year_bh = ? AND is_locked = 1",
            [year_bh]
        );
        await db.query(
            "UPDATE kpi_activity_results SET is_locked = 0, status = 'Pending' WHERE year_bh = ? AND is_locked = 1",
            [year_bh]
        );
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'UNLOCK_ALL', 'kpi_results', JSON.stringify({ year_bh, affected: result.affectedRows }), req.ip]
        );
        db.query('SELECT DISTINCT indicator_id FROM kpi_summary WHERE year_bh = ?', [year_bh]).then(([rs]) => scheduleSummaryRefresh(rs.map(r => ({ indicator_id: r.indicator_id, year_bh })))).catch(e => console.error('[summary] unlock-all:', e.message)); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: `ปลดล็อคทั้งหมด ${result.affectedRows} รายการ ในปี ${year_bh}` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== ล็อคการคีย์ข้อมูล ==========

// ดึงสถานะล็อคการคีย์ข้อมูล
apiRouter.get('/data-entry-lock', authenticateToken, async (req, res) => {
    try {
        const keys = ['data_entry_locked', 'data_entry_lock_start', 'data_entry_lock_end', 'data_entry_lock_days', 'target_edit_locked'];
        const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
        const settings = {};
        for (const r of rows) settings[r.setting_key] = r.setting_value;

        const manualLock = settings.data_entry_locked === 'true';
        const startDate = settings.data_entry_lock_start || '';
        const endDate = settings.data_entry_lock_end || '';
        const lockDays = parseInt(settings.data_entry_lock_days) || 0;

        const today = new Date().toISOString().split('T')[0];

        // คำนวณวันสิ้นสุดจากจำนวนวัน (ถ้ามี startDate + lockDays > 0)
        let effectiveEnd = endDate;
        if (startDate && lockDays > 0) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + lockDays);
            effectiveEnd = d.toISOString().split('T')[0];
        }

        // !! บังคับเป็น boolean — เดิมถ้าไม่ได้ตั้ง startDate นิพจน์ && คืนค่า '' (string ว่าง) ทำให้ API ส่ง is_locked: ''
        // แทน false → หน้าบันทึกผลงานของ user ทั่วไปเกิด NG0100 (ค่าเปลี่ยนจาก false เป็น '' ระหว่าง change detection)
        const inDateRange = !!(startDate && effectiveEnd && today >= startDate && today <= effectiveEnd);
        const isLocked = manualLock || inDateRange;

        let lockReason = '';
        if (manualLock) lockReason = 'ล็อคโดย Admin';
        else if (inDateRange) lockReason = `ล็อคตามช่วงวันที่ ${startDate} - ${effectiveEnd}`;

        res.json({
            success: true,
            data: {
                data_entry_locked: manualLock,
                data_entry_lock_start: startDate,
                data_entry_lock_end: endDate,
                data_entry_lock_days: lockDays,
                effective_end: effectiveEnd,
                is_locked: isLocked,
                lock_reason: lockReason,
                target_edit_locked: settings.target_edit_locked === 'true'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== User Permissions (per-user) ==========
// PUT /users/:id/permissions — super_admin ตั้งสิทธิ์ราย user
apiRouter.put('/users/:id/permissions', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { can_edit_actual, can_edit_target } = req.body || {};
        // ห้ามแก้สิทธิ์ super_admin (สิทธิ์เต็มเสมอ)
        const [u] = await db.query('SELECT role FROM users WHERE id = ?', [id]);
        if (u.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบผู้ใช้' });
        if (u[0].role === 'super_admin') return res.status(400).json({ success: false, message: 'ไม่สามารถแก้สิทธิ์ super_admin ได้ (มีสิทธิ์เต็มเสมอ)' });
        await db.query('UPDATE users SET can_edit_actual = ?, can_edit_target = ? WHERE id = ?',
            [can_edit_actual ? 1 : 0, can_edit_target ? 1 : 0, id]);
        invalidateUserPermCache(id);
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?,?,?,?,?,?)',
            [req.user.userId, 'UPDATE', 'users', id, JSON.stringify({ can_edit_actual: !!can_edit_actual, can_edit_target: !!can_edit_target }), req.ip]); } catch (_) {}
        res.json({ success: true, message: 'บันทึกสิทธิ์ผู้ใช้สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /my-permissions — สิทธิ์ของ user ปัจจุบัน (frontend ใช้ควบคุม UI)
apiRouter.get('/my-permissions', authenticateToken, async (req, res) => {
    try {
        const perms = await getPermsForUser(req.user.userId, req.user.role);
        res.json({ success: true, role: req.user.role, permissions: perms });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== ระบบอุทธรณ์ (Appeal) ==========

// ดึงการตั้งค่าอุทธรณ์ + คำนวณว่าเปิดรับอยู่หรือไม่
apiRouter.get('/appeal-settings', authenticateToken, async (req, res) => {
    try {
        const keys = ['appeal_enabled', 'appeal_start_date', 'appeal_end_date', 'appeal_days_after_approve'];
        const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
        const settings = {};
        for (const r of rows) settings[r.setting_key] = r.setting_value;

        const enabled = settings.appeal_enabled === 'true';
        const startDate = settings.appeal_start_date || '';
        const endDate = settings.appeal_end_date || '';
        const daysAfter = parseInt(settings.appeal_days_after_approve) || 0;

        // คำนวณว่าวันนี้อยู่ในช่วงเปิดรับหรือไม่
        const today = new Date().toISOString().split('T')[0];
        const inDateRange = (!startDate || today >= startDate) && (!endDate || today <= endDate);
        const isOpen = enabled && inDateRange;

        res.json({ success: true, data: { appeal_enabled: enabled, appeal_start_date: startDate, appeal_end_date: endDate, appeal_days_after_approve: daysAfter, is_open: isOpen } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// หน่วยบริการยื่นอุทธรณ์
apiRouter.post('/appeal-kpi', authenticateToken, async (req, res) => {
    const { indicator_id, year_bh, hospcode, reason } = req.body;
    const user = req.user;

    if (!indicator_id || !year_bh || !hospcode || !reason) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    }

    try {
        // ตรวจสอบการตั้งค่าอุทธรณ์
        const [settingsRows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)',
            [['appeal_enabled', 'appeal_start_date', 'appeal_end_date', 'appeal_days_after_approve']]);
        const settings = {};
        for (const r of settingsRows) settings[r.setting_key] = r.setting_value;

        if (settings.appeal_enabled !== 'true') {
            return res.status(400).json({ success: false, message: 'ระบบอุทธรณ์ยังไม่เปิดใช้งาน' });
        }

        const today = new Date().toISOString().split('T')[0];
        if (settings.appeal_start_date && today < settings.appeal_start_date) {
            return res.status(400).json({ success: false, message: `ยังไม่ถึงช่วงเวลายื่นอุทธรณ์ (เริ่ม ${settings.appeal_start_date})` });
        }
        if (settings.appeal_end_date && today > settings.appeal_end_date) {
            return res.status(400).json({ success: false, message: `หมดช่วงเวลายื่นอุทธรณ์แล้ว (สิ้นสุด ${settings.appeal_end_date})` });
        }

        // ตรวจสอบว่า KPI ต้อง Approved + locked (ดูจาก row ใดก็ได้ ไม่จำกัดเดือน)
        const [kpiRows] = await db.query(
            "SELECT status, is_locked, created_at FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? ORDER BY month_bh LIMIT 1",
            [indicator_id, year_bh, hospcode]
        );
        if (kpiRows.length === 0) {
            return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล KPI' });
        }
        if (kpiRows[0].status !== 'Approved' || !kpiRows[0].is_locked) {
            return res.status(400).json({ success: false, message: 'สามารถยื่นอุทธรณ์ได้เฉพาะ KPI ที่ถูกอนุมัติและล็อคแล้วเท่านั้น' });
        }

        // ตรวจสอบจำนวนวันหลัง approve
        const daysAfter = parseInt(settings.appeal_days_after_approve) || 0;
        if (daysAfter > 0) {
            // หา approve date จาก system_logs หรือใช้ created_at
            const [logRows] = await db.query(
                "SELECT created_at FROM system_logs WHERE action_type = 'APPROVE' AND new_value LIKE ? ORDER BY created_at DESC LIMIT 1",
                [`%"indicator_id":${indicator_id}%${hospcode}%`]
            );
            const approveDate = logRows.length > 0 ? new Date(logRows[0].created_at) : new Date(kpiRows[0].created_at);
            const diffDays = Math.floor((new Date() - approveDate) / (1000 * 60 * 60 * 24));
            if (diffDays > daysAfter) {
                return res.status(400).json({ success: false, message: `เลยกำหนดยื่นอุทธรณ์แล้ว (ภายใน ${daysAfter} วันหลังอนุมัติ)` });
            }
        }

        // ตรวจสอบว่ายังไม่ได้ยื่นอุทธรณ์อยู่แล้ว
        const [existingAppeal] = await db.query(
            "SELECT id FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status = 'Appeal' LIMIT 1",
            [indicator_id, year_bh, hospcode]
        );
        if (existingAppeal.length > 0) {
            return res.status(400).json({ success: false, message: 'ตัวชี้วัดนี้มีการยื่นอุทธรณ์อยู่แล้ว' });
        }

        // อัปเดตสถานะเป็น Appeal (ยังคง locked)
        await db.query(
            "UPDATE kpi_results SET status = 'Appeal' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade สถานะไปตัวชี้วัดย่อย (ไม่แตะ lock เหมือน kpi_results)
        await db.query(
            `UPDATE kpi_sub_results sr JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
             SET sr.status = 'Appeal' WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode = ?`,
            [indicator_id, year_bh, hospcode]
        );
        await db.query(
            `UPDATE kpi_activity_results ar JOIN kpi_sub_activities a ON ar.activity_id = a.id
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
             SET ar.status = 'Appeal' WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode = ?`,
            [indicator_id, year_bh, hospcode]
        );

        // บันทึกเหตุผลอุทธรณ์
        await db.query(
            "INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, replied_by, rejected_by) VALUES (?, ?, ?, ?, 'appeal', ?, NULL)",
            [indicator_id, year_bh, hospcode, reason, user.userId]
        );

        // ดึงชื่อตัวชี้วัด
        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        // แจ้งเตือน admin_ssj ในหน่วยงานเดียวกัน + super_admin ทั้งหมด
        const [admins] = await db.query(
            "SELECT id, role, dept_id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND dept_id = ?)",
            [deptId]
        );
        for (const admin of admins) {
            await db.query(
                "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'appeal', ?, ?, ?, ?, ?)",
                [admin.id, hospcode, `ยื่นอุทธรณ์: ${indName}`, `หน่วยบริการ ${hospcode} ขออุทธรณ์แก้ไขคะแนน ปี ${year_bh}\nเหตุผล: ${reason}`, indicator_id, year_bh, user.userId]
            );
        }

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, reason }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ยื่นอุทธรณ์เรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin อนุมัติอุทธรณ์ → ปลดล็อค
apiRouter.post('/appeal-approve', authenticateToken, isAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode, comment } = req.body;
    const user = req.user;

    try {
        // ปลดล็อคและเปลี่ยนสถานะเป็น Pending
        await db.query(
            "UPDATE kpi_results SET status = 'Pending', is_locked = 0 WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade ไปตัวชี้วัดย่อย
        await cascadeSubResultsStatus(db, indicator_id, year_bh, hospcode, 'Pending', 0);

        // บันทึก comment
        await db.query(
            "INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, rejected_by) VALUES (?, ?, ?, ?, 'appeal_approve', ?)",
            [indicator_id, year_bh, hospcode, comment || 'อนุมัติอุทธรณ์', user.userId]
        );

        // ดึงชื่อตัวชี้วัด
        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;

        // แจ้ง hospcode
        await db.query(
            "INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, 'approve', ?, ?, ?, ?, ?)",
            [hospcode, `อุทธรณ์ได้รับการอนุมัติ: ${indName}`, `การอุทธรณ์ได้รับการอนุมัติแล้ว ข้อมูลถูกปลดล็อค สามารถแก้ไขคะแนนได้${comment ? '\nความเห็น: ' + comment : ''}`, indicator_id, year_bh, user.userId]
        );

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL_APPROVE', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, comment }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'อนุมัติอุทธรณ์เรียบร้อย ปลดล็อคข้อมูลแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Admin ปฏิเสธอุทธรณ์ → กลับ Approved/locked
apiRouter.post('/appeal-reject', authenticateToken, isAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode, comment } = req.body;
    const user = req.user;

    if (!comment) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุเหตุผลในการปฏิเสธอุทธรณ์' });
    }

    try {
        // กลับสถานะ Approved + locked
        await db.query(
            "UPDATE kpi_results SET status = 'Approved', is_locked = 1 WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?",
            [indicator_id, year_bh, hospcode]
        );
        // Cascade ไปตัวชี้วัดย่อย
        await cascadeSubResultsStatus(db, indicator_id, year_bh, hospcode, 'Approved', 1);

        // บันทึก comment
        await db.query(
            "INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, rejected_by) VALUES (?, ?, ?, ?, 'appeal_reject', ?)",
            [indicator_id, year_bh, hospcode, comment, user.userId]
        );

        // ดึงชื่อตัวชี้วัด
        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;

        // แจ้ง hospcode
        await db.query(
            "INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, 'reject', ?, ?, ?, ?, ?)",
            [hospcode, `อุทธรณ์ถูกปฏิเสธ: ${indName}`, `การอุทธรณ์ถูกปฏิเสธ ข้อมูลยังคงถูกล็อค\nเหตุผล: ${comment}`, indicator_id, year_bh, user.userId]
        );

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL_REJECT', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, comment }), req.ip]
        );

        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ปฏิเสธอุทธรณ์เรียบร้อย' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// แจ้ง admin ว่าหน่วยบริการแก้ไขข้อมูลจากอุทธรณ์เสร็จแล้ว ให้ตรวจสอบรับรอง
apiRouter.post('/appeal-edited', authenticateToken, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.body;
    const user = req.user;

    try {
        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        // ดึงชื่อหน่วยบริการ
        const [hosRows] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ?', [hospcode]);
        const hosName = hosRows[0]?.hosname || hospcode;

        // แจ้ง admin_ssj ในหน่วยงานเดียวกัน + super_admin ทั้งหมด
        const [admins] = await db.query(
            "SELECT id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND dept_id = ?)",
            [deptId]
        );
        for (const admin of admins) {
            await db.query(
                "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'info', ?, ?, ?, ?, ?)",
                [admin.id, hospcode,
                 `แก้ไขข้อมูลอุทธรณ์แล้ว: ${indName}`,
                 `${hosName} (${hospcode}) แก้ไขข้อมูลจากการอุทธรณ์เรียบร้อยแล้ว ปี ${year_bh}\nกรุณาเข้าตรวจสอบและรับรองข้อมูล`,
                 indicator_id, year_bh, user.userId]
            );
        }

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPEAL_EDITED', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode }), req.ip]
        );

        res.json({ success: true, message: 'แจ้ง Admin เรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== Target Edit Request APIs ==========

// ดึงรายการขอแก้ไขเป้าหมาย
apiRouter.get('/target-edit-requests', authenticateToken, isAnyAdmin, async (req, res) => {
    const user = req.user;
    try {
        let rows;
        if (user.role === 'admin_ssj' || user.role === 'super_admin') {
            [rows] = await db.query(
                `SELECT t.*, u.firstname, u.lastname, u.username
                 FROM target_edit_requests t
                 LEFT JOIN users u ON t.requested_by = u.id
                 WHERE t.status IN ('pending','approved')
                 ORDER BY t.created_at DESC`
            );
        } else {
            [rows] = await db.query(
                `SELECT t.*, u.firstname, u.lastname, u.username
                 FROM target_edit_requests t
                 LEFT JOIN users u ON t.requested_by = u.id
                 WHERE t.requested_by = ? AND t.status IN ('pending','approved','rejected')
                 ORDER BY t.created_at DESC`,
                [user.userId]
            );
        }
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ส่งคำขอแก้ไขเป้าหมาย (admin_cup / admin_ssj / super_admin)
apiRouter.post('/target-edit-request', authenticateToken, isAnyAdmin, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.body;
    const user = req.user;
    try {
        const [existing] = await db.query(
            "SELECT id FROM target_edit_requests WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status IN ('pending','approved')",
            [indicator_id, year_bh, hospcode]
        );
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'มีคำขออยู่แล้ว กรุณารอการอนุมัติ' });
        }

        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        const [hosRows] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ?', [hospcode]);
        const hosName = hosRows[0]?.hosname || hospcode;

        const byName = `${user.firstname || ''} ${user.lastname || ''}`.trim() || user.username;

        const [result] = await db.query(
            'INSERT INTO target_edit_requests (indicator_id, year_bh, hospcode, requested_by, requested_by_name, status) VALUES (?, ?, ?, ?, ?, ?)',
            [indicator_id, year_bh, hospcode, user.userId, byName, 'pending']
        );

        // แจ้ง admin_ssj + super_admin
        const [admins] = await db.query(
            "SELECT id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND (dept_id = ? OR dept_id IS NULL))",
            [deptId]
        );
        for (const admin of admins) {
            if (admin.id !== user.userId) {
                await db.query(
                    "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'target_request', ?, ?, ?, ?, ?)",
                    [admin.id, hospcode,
                     `ขอแก้ไขเป้าหมาย: ${indName}`,
                     `${byName} (${hosName}) ขอแก้ไขเป้าหมาย "${indName}" ปี ${year_bh} กรุณาอนุมัติหรือปฏิเสธ`,
                     indicator_id, year_bh, user.userId]
                );
            }
        }

        res.json({ success: true, message: 'ส่งคำขอแล้ว รอการอนุมัติ', request_id: result.insertId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// อนุมัติคำขอแก้ไขเป้าหมาย (admin_ssj / super_admin)
apiRouter.post('/target-edit-approve', authenticateToken, isAdmin, async (req, res) => {
    const { request_id } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM target_edit_requests WHERE id = ?', [request_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
        const reqRow = rows[0];
        if (reqRow.status !== 'pending') return res.status(400).json({ success: false, message: 'คำขอนี้ไม่ได้รออนุมัติ' });

        await db.query('UPDATE target_edit_requests SET status = ?, approved_by = ?, updated_at = NOW() WHERE id = ?',
            ['approved', user.userId, request_id]);

        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [reqRow.indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${reqRow.indicator_id}`;

        await db.query(
            "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'approve', ?, ?, ?, ?, ?)",
            [reqRow.requested_by, reqRow.hospcode,
             `อนุมัติแก้ไขเป้าหมาย: ${indName}`,
             `คำขอแก้ไขเป้าหมาย "${indName}" ปี ${reqRow.year_bh} ได้รับการอนุมัติแล้ว กรุณาแก้ไขและบันทึก`,
             reqRow.indicator_id, reqRow.year_bh, user.userId]
        );

        res.json({ success: true, message: 'อนุมัติคำขอแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ปฏิเสธคำขอแก้ไขเป้าหมาย (admin_ssj / super_admin)
apiRouter.post('/target-edit-reject', authenticateToken, isAdmin, async (req, res) => {
    const { request_id, reason } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM target_edit_requests WHERE id = ?', [request_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
        const reqRow = rows[0];
        if (reqRow.status !== 'pending') return res.status(400).json({ success: false, message: 'คำขอนี้ไม่ได้รออนุมัติ' });

        await db.query('UPDATE target_edit_requests SET status = ?, reject_reason = ?, updated_at = NOW() WHERE id = ?',
            ['rejected', reason || '', request_id]);

        const [indRows] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [reqRow.indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${reqRow.indicator_id}`;

        await db.query(
            "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'reject', ?, ?, ?, ?, ?)",
            [reqRow.requested_by, reqRow.hospcode,
             `ปฏิเสธการแก้ไขเป้าหมาย: ${indName}`,
             `คำขอแก้ไขเป้าหมาย "${indName}" ปี ${reqRow.year_bh} ถูกปฏิเสธ${reason ? ': ' + reason : ''}`,
             reqRow.indicator_id, reqRow.year_bh, user.userId]
        );

        res.json({ success: true, message: 'ปฏิเสธคำขอแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ปิดคำขอแก้ไขเป้าหมาย หลังบันทึกสำเร็จ
apiRouter.post('/target-edit-complete', authenticateToken, isAnyAdmin, async (req, res) => {
    const { request_id } = req.body;
    const user = req.user;
    try {
        const [rows] = await db.query('SELECT * FROM target_edit_requests WHERE id = ?', [request_id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบคำขอ' });
        const reqRow = rows[0];
        if (reqRow.status !== 'approved') return res.status(400).json({ success: false, message: 'คำขอนี้ยังไม่ได้รับอนุมัติ' });

        await db.query('UPDATE target_edit_requests SET status = ?, updated_at = NOW() WHERE id = ?', ['completed', request_id]);

        const [indRows] = await db.query('SELECT kpi_indicators_name, dept_id FROM kpi_indicators WHERE id = ?', [reqRow.indicator_id]);
        const indName = indRows[0]?.kpi_indicators_name || `ID ${reqRow.indicator_id}`;
        const deptId = indRows[0]?.dept_id;

        const [hosRows] = await db.query('SELECT hosname FROM chospital WHERE hoscode = ?', [reqRow.hospcode]);
        const hosName = hosRows[0]?.hosname || reqRow.hospcode;
        const byName = reqRow.requested_by_name || `ผู้ใช้ #${reqRow.requested_by}`;

        const [admins] = await db.query(
            "SELECT id FROM users WHERE (role = 'super_admin') OR (role = 'admin_ssj' AND (dept_id = ? OR dept_id IS NULL))",
            [deptId]
        );
        for (const admin of admins) {
            if (admin.id !== reqRow.requested_by) {
                await db.query(
                    "INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, 'info', ?, ?, ?, ?, ?)",
                    [admin.id, reqRow.hospcode,
                     `บันทึกเป้าหมายแล้ว: ${indName}`,
                     `${byName} (${hosName}) บันทึกเป้าหมาย "${indName}" ปี ${reqRow.year_bh} เรียบร้อยแล้ว`,
                     reqRow.indicator_id, reqRow.year_bh, user.userId]
                );
            }
        }

        res.json({ success: true, message: 'ปิดคำขอแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ดึงจำนวนตัวชี้วัดที่รอการตรวจสอบ (ปีงบปัจจุบัน, แสดง dept/hospital/indicator)
apiRouter.get('/notifications/pending-kpi', authenticateToken, isAdmin, async (req, res) => {
    const user = req.user;
    try {
        // คำนวณปีงบประมาณปัจจุบัน (ต.ค. = เดือน 9 ของ JS → ปี+1+543)
        const today = new Date();
        let fyYear = today.getFullYear();
        if (today.getMonth() >= 9) fyYear += 1; // เดือน ต.ค. ขึ้นปีใหม่
        const currentFY = (fyYear + 543).toString();

        let whereClause = `WHERE r.status = 'Pending' AND r.year_bh = ? AND ${activeIndicatorSql('r.indicator_id')}`;
        let params = [currentFY];

        // admin: เฉพาะหน่วยงานตัวเอง (ทุก hospcode)
        if (user.role !== 'super_admin' && user.deptId !== null && user.deptId !== undefined) {
            whereClause += " AND i.dept_id = ?";
            params.push(user.deptId);
        }

        const [rows] = await db.query(
            `SELECT
                COUNT(DISTINCT i.dept_id) AS dept_count,
                COUNT(DISTINCT r.hospcode) AS hos_count,
                COUNT(DISTINCT r.indicator_id) AS indicator_count
             FROM kpi_results r
             LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
             ${whereClause}`,
            params
        );
        const data = rows[0] || { dept_count: 0, hos_count: 0, indicator_count: 0 };
        res.json({
            success: true,
            count: data.indicator_count, // backward compat
            data: {
                deptCount: data.dept_count,
                hosCount: data.hos_count,
                indicatorCount: data.indicator_count,
                yearBh: currentFY
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
apiRouter.post('/departments', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { dept_code, dept_name, description, sort_order } = req.body;
    if (!dept_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        await db.query(
            'INSERT INTO departments (dept_code, dept_name, description, sort_order) VALUES (?, ?, ?, ?)',
            [dept_code || null, dept_name, description || null, sort_order || 0]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/departments/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { dept_code, dept_name, description, sort_order, is_active } = req.body;
    if (!dept_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        await db.query(
            'UPDATE departments SET dept_code=?, dept_name=?, description=?, sort_order=?, is_active=? WHERE id=?',
            [dept_code || null, dept_name, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========== System Announcements (ประกาศระบบ) ==========
apiRouter.get('/announcement/active', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM system_announcements WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1');
        res.json({ success: true, data: rows[0] || null });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/announcements', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT a.*, u.firstname, u.lastname
            FROM system_announcements a
            LEFT JOIN users u ON a.created_by = u.id
            ORDER BY a.is_active DESC, a.updated_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/announcements', authenticateToken, requireAction('announcements', 'add'), async (req, res) => {
    try {
        const { title, content_html, content_text, bg_color, text_color, blink_enabled, show_on_header, show_on_login, is_active } = req.body;
        if (!content_html) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความ' });
        // Limit content_text ≤ 500 chars
        const textTruncated = (content_text || '').substring(0, 500);
        // ถ้า is_active=1 → ปิด active อื่นๆ ทั้งหมด
        if (is_active) await db.query('UPDATE system_announcements SET is_active = 0');
        const [r] = await db.query(
            `INSERT INTO system_announcements (title, content_html, content_text, bg_color, text_color, blink_enabled, show_on_header, show_on_login, is_active, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [title || 'ประกาศระบบ', content_html, textTruncated, bg_color || '#dc2626', text_color || '#ffffff',
             blink_enabled ? 1 : 0, show_on_header ? 1 : 0, show_on_login ? 1 : 0, is_active ? 1 : 0, req.user.userId]
        );
        res.json({ success: true, id: r.insertId, message: 'สร้างประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/announcements/:id', authenticateToken, requireAction('announcements', 'edit'), async (req, res) => {
    try {
        const { title, content_html, content_text, bg_color, text_color, blink_enabled, show_on_header, show_on_login, is_active } = req.body;
        if (!content_html) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความ' });
        const textTruncated = (content_text || '').substring(0, 500);
        if (is_active) await db.query('UPDATE system_announcements SET is_active = 0 WHERE id != ?', [req.params.id]);
        await db.query(
            `UPDATE system_announcements SET title=?, content_html=?, content_text=?, bg_color=?, text_color=?,
             blink_enabled=?, show_on_header=?, show_on_login=?, is_active=? WHERE id=?`,
            [title || 'ประกาศระบบ', content_html, textTruncated, bg_color || '#dc2626', text_color || '#ffffff',
             blink_enabled ? 1 : 0, show_on_header ? 1 : 0, show_on_login ? 1 : 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'แก้ไขประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/announcements/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM system_announcements WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/announcements/:id/activate', authenticateToken, requireAction('announcements', 'edit'), async (req, res) => {
    try {
        await db.query('UPDATE system_announcements SET is_active = 0');
        await db.query('UPDATE system_announcements SET is_active = 1 WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'เปิดใช้งานประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /announcements/:id/send-email — ส่งประกาศเข้าอีเมล (all / dept / users)
apiRouter.post('/announcements/:id/send-email', authenticateToken, isSuperAdmin, async (req, res) => {
    if (!mailTransporter) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า SMTP' });
    try {
        const { scope, dept_ids, user_ids } = req.body;
        // ดึงประกาศ
        const [aRows] = await db.query('SELECT * FROM system_announcements WHERE id = ?', [req.params.id]);
        if (aRows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบประกาศ' });
        const a = aRows[0];

        // หา recipients ตาม scope
        let recipients = [];
        if (scope === 'all') {
            const [rows] = await db.query(`SELECT id, email, firstname, lastname FROM users WHERE email IS NOT NULL AND email != '' AND is_active = 1`);
            recipients = rows;
        } else if (scope === 'dept' && Array.isArray(dept_ids) && dept_ids.length > 0) {
            const [rows] = await db.query(
                `SELECT id, email, firstname, lastname FROM users WHERE email IS NOT NULL AND email != '' AND is_active = 1 AND dept_id IN (${dept_ids.map(() => '?').join(',')})`,
                dept_ids
            );
            recipients = rows;
        } else if (scope === 'users' && Array.isArray(user_ids) && user_ids.length > 0) {
            const [rows] = await db.query(
                `SELECT id, email, firstname, lastname FROM users WHERE email IS NOT NULL AND email != '' AND id IN (${user_ids.map(() => '?').join(',')})`,
                user_ids
            );
            recipients = rows;
        } else {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ scope + ผู้รับ' });
        }

        if (recipients.length === 0) {
            return res.json({ success: true, sent: 0, message: 'ไม่พบผู้รับที่มี email' });
        }

        // template email (ใช้ bg_color/text_color จากประกาศ)
        const htmlTemplate = (name) => `
            <div style="font-family:'Sarabun',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px;border-radius:12px">
                <div style="background:linear-gradient(135deg,#065f46,#16a34a);color:white;padding:20px;border-radius:12px 12px 0 0">
                    <h2 style="margin:0">📢 ${a.title || 'ประกาศระบบ'}</h2>
                    <p style="margin:4px 0 0;opacity:.85;font-size:13px">Korat Health KPI — สสจ.นครราชสีมา</p>
                </div>
                <div style="background:white;padding:20px;border-radius:0 0 12px 12px">
                    <p style="margin:0 0 12px;color:#374151">เรียน คุณ${name || 'ผู้ใช้งาน'},</p>
                    <div style="background:${a.bg_color || '#dc2626'};color:${a.text_color || '#ffffff'};padding:14px 20px;border-radius:10px;font-weight:bold;text-align:center">
                        ${a.content_html}
                    </div>
                    <p style="margin:16px 0 0;color:#6b7280;font-size:12px">
                        ส่งจากระบบอัตโนมัติ — กรุณาอย่าตอบกลับอีเมลนี้<br>
                        <a href="https://apikorat.moph.go.th/khupskpi/" style="color:#16a34a">เปิดระบบ Korat Health KPI</a>
                    </p>
                </div>
            </div>
        `;

        // ส่งทีละคน (ไม่ block response — fire and forget สำหรับคนที่เหลือ)
        let sent = 0, failed = 0;
        const subject = `[Korat Health KPI] ${a.title || 'ประกาศระบบ'}`;
        for (const r of recipients) {
            try {
                await sendMail(r.email, subject, htmlTemplate(`${r.firstname} ${r.lastname}`));
                sent++;
            } catch (e) { failed++; }
        }

        // log
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'ANNOUNCEMENT_EMAIL', 'system_announcements', JSON.stringify({ announcement_id: a.id, scope, sent, failed, total: recipients.length }), req.ip]).catch(() => {});

        res.json({ success: true, sent, failed, total: recipients.length, message: `ส่งอีเมลสำเร็จ ${sent}/${recipients.length} คน` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/departments/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM departments WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting department' });
    }
});

// ========== Export KPI Tables ==========

// ดึงรายการ KPI indicators ที่มี table_process (สำหรับเลือก export) พร้อมชื่อหมวดหมู่และหน่วยงาน
apiRouter.get('/exportable-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        // คืน upload_excel ด้วย — UI export-kpi จะใช้กรอง/แสดง badge
        const [rows] = await db.query(
            `SELECT i.id, i.kpi_indicators_name, i.table_process, i.dept_id, i.main_indicator_id, i.is_active,
                    i.upload_excel, i.criterion, i.target_condition, i.result_formula, i.export_items,
                    d.dept_name, mi.main_indicator_name
             FROM kpi_indicators i
             LEFT JOIN departments d ON i.dept_id = d.id
             LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
             WHERE i.table_process IS NOT NULL AND i.table_process != '' AND i.is_active = 1
             ORDER BY i.id`
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


// HTTP wrapper
apiRouter.post('/check-kpi-export', authenticateToken, isSuperAdmin, async (req, res) => {
    const result = await checkKpiChanges(req.body.year_bh, req.body.indicator_ids);
    if (!result.success) return res.status(result.message?.includes('กรุณา') ? 400 : 500).json(result);
    res.json(result);
});


// HTTP endpoint เรียก core function
apiRouter.post('/export-kpi-tables', authenticateToken, isSuperAdmin, async (req, res) => {
    const result = await performKpiExport(req.body.year_bh, req.body.indicator_ids, req.user.id);
    if (!result.success) return res.status(result.message?.includes('กรุณา') ? 400 : 500).json(result);
    res.json(result);
});

// ========== Export Scheduler (run automatically) ==========

// ส่ง notification (email + telegram) หลัง export เสร็จ
async function sendExportNotification(schedule, result, durationMs) {
    const summary = result.summary || { inserted: 0, updated: 0, unchanged: 0, no_data: 0 };
    const tablesCount = (result.created_tables || []).length;
    const subject = `[Korat Health KPI] รายงาน Export อัตโนมัติ — ${schedule.name}`;

    const allTables = result.created_tables || [];
    const tablesHtml = allTables.slice(0, 100).map(t => {
        const isUpdated = (t.inserted || 0) > 0 || (t.updated || 0) > 0;
        const statusIcon = isUpdated
            ? '<span style="color:#16a34a">✓ อัปเดต</span>'
            : '<span style="color:#6b7280">= ไม่เปลี่ยน</span>';
        return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px">${t.table}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center;font-size:11px">${statusIcon}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">+${t.inserted || 0}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">~${t.updated || 0}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">=${t.unchanged || 0}</td></tr>`;
    }).join('');
    const tablesMore = allTables.length > 100 ? `<p style="color:#6b7280;font-size:11px;margin-top:4px">... และอีก ${allTables.length - 100} ตาราง</p>` : '';

    // Sync-to-KHD summary (ถ้ามี)
    const sync = result.sync;
    const syncHtml = sync ? `
        <div style="margin-top:16px;padding:14px;border-radius:10px;background:${sync.success ? '#ecfdf5' : '#fef2f2'};border-left:4px solid ${sync.success ? '#10b981' : '#ef4444'}">
          <h3 style="margin:0 0 8px;color:${sync.success ? '#065f46' : '#991b1b'};font-size:14px">
            ${sync.success ? '☁️ Sync ไปยัง KHD สำเร็จ' : '⚠️ Sync ไปยัง KHD ผิดพลาดบางส่วน'}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0">
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#065f46">${sync.summary.success}</div><div style="font-size:10px;color:#065f46">สำเร็จ</div></div>
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#991b1b">${sync.summary.error}</div><div style="font-size:10px;color:#991b1b">ผิดพลาด</div></div>
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#6b7280">${sync.summary.skipped}</div><div style="font-size:10px;color:#6b7280">ข้าม</div></div>
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#1e40af">${sync.summary.rows}</div><div style="font-size:10px;color:#1e40af">rows</div></div>
          </div>
          ${(sync.results || []).filter(r => r.status === 'error').slice(0, 10).map(r => `<div style="font-size:11px;color:#991b1b;margin-top:4px">✗ <b>${r.table}</b>: ${r.reason}</div>`).join('')}
        </div>` : '';

    const html = `
    <div style="font-family:'Sarabun',Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#065f46,#16a34a);color:white;padding:20px;border-radius:12px 12px 0 0">
        <h2 style="margin:0">📊 รายงาน Export KPI อัตโนมัติ</h2>
        <p style="margin:4px 0 0;opacity:.85;font-size:13px">${schedule.name} — ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p>
      </div>
      <div style="background:white;padding:20px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
        <p style="margin:0 0 12px"><b>สถานะ:</b> ${result.success ? '<span style="color:#16a34a">✓ สำเร็จ</span>' : '<span style="color:#dc2626">✗ ผิดพลาด</span>'}</p>
        <p style="margin:0 0 12px"><b>ใช้เวลา:</b> ${(durationMs/1000).toFixed(1)} วินาที</p>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0">
          <div style="background:#dbeafe;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#1e40af">${summary.inserted}</div><div style="font-size:11px;color:#1e40af">เพิ่มใหม่</div></div>
          <div style="background:#fed7aa;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#c2410c">${summary.updated}</div><div style="font-size:11px;color:#c2410c">อัปเดต</div></div>
          <div style="background:#f3f4f6;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#4b5563">${summary.unchanged}</div><div style="font-size:11px;color:#4b5563">ไม่เปลี่ยน</div></div>
          <div style="background:#fef3c7;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#a16207">${tablesCount}</div><div style="font-size:11px;color:#a16207">ตาราง</div></div>
        </div>
        ${tablesHtml ? `<h3 style="margin:16px 0 8px;color:#374151;font-size:14px">📋 รายการตารางที่ส่งออก (${tablesCount}):</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#f9fafb">
          <th style="padding:6px 8px;text-align:left">ตาราง</th>
          <th style="padding:6px 8px;text-align:center">สถานะ</th>
          <th style="padding:6px 8px;text-align:center">เพิ่ม</th>
          <th style="padding:6px 8px;text-align:center">อัปเดต</th>
          <th style="padding:6px 8px;text-align:center">เดิม</th>
        </tr></thead><tbody>${tablesHtml}</tbody></table>${tablesMore}` : ''}
        ${syncHtml}
        <div style="background:#fef9c3;border-left:4px solid #eab308;padding:12px;margin-top:16px;border-radius:4px">
          <p style="margin:0;color:#713f12;font-size:13px">
            ${sync
              ? `📬 ระบบส่งข้อมูลเข้า KHD เรียบร้อยแล้ว — กรุณาตรวจสอบที่ <a href="https://apikorat.moph.go.th/khupskpi/">Korat Health KPI</a>`
              : `⚠️ <b>กรุณาตรวจสอบผลก่อนส่งไปยัง KHD</b> โดยเข้าระบบที่ <a href="https://apikorat.moph.go.th/khupskpi/">Korat Health KPI</a> → จัดการข้อมูล KPI → Tab "Export ข้อมูล"`}
          </p>
        </div>
      </div>
    </div>`;

    // ดึง recipients จาก system_settings (ไม่ใช่จาก schedule)
    const ns = await getNotifSettings();
    let sentEmail = false, sentTelegram = false, sentLine = false;

    if (Number(schedule.notify_email) === 1 && ns.adminEmails) {
        const recipients = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of recipients) {
            try { await sendMail(email, subject, html); sentEmail = true; } catch (e) {}
        }
    }
    if (Number(schedule.notify_telegram) === 1 && ns.tgToken && ns.tgChatId) {
        const chatIds = ns.tgChatId.split(',').map(c => c.trim()).filter(Boolean);
        const syncBlock = sync
          ? `\n☁️ *Sync ไปยัง KHD:*\n` +
            `• ${sync.success ? 'สำเร็จ' : 'มีข้อผิดพลาด'}: *${sync.summary.success}/${sync.summary.total}* ตาราง\n` +
            `• Rows: *${sync.summary.rows}*\n` +
            (sync.summary.error > 0 ? `• ผิดพลาด: *${sync.summary.error}*\n` : '')
          : '';
        // รายการตาราง (top 20 — กัน Telegram message limit 4096 char)
        const topTables = allTables.slice(0, 20);
        const tablesBlock = topTables.length > 0
          ? `\n📋 *รายการตารางที่ส่งออก:*\n` + topTables.map(t => {
              const isUpdated = (t.inserted || 0) > 0 || (t.updated || 0) > 0;
              const icon = isUpdated ? '✓' : '=';
              return `${icon} \`${t.table}\` (+${t.inserted || 0}/~${t.updated || 0}/=${t.unchanged || 0})`;
            }).join('\n') + (allTables.length > 20 ? `\n... และอีก ${allTables.length - 20} ตาราง` : '')
          : '';
        const footer = sync ? '\n\n📬 ข้อมูลถูกส่งเข้า KHD แล้ว' : '\n\n⚠️ กรุณาตรวจสอบก่อนส่ง KHD';
        const tgMsg = `📊 *รายงาน Export KPI — ${schedule.name}*\n\n` +
            `สถานะ: ${result.success ? '✅ สำเร็จ' : '❌ ผิดพลาด'}\n` +
            `⏱ เวลา: ${(durationMs/1000).toFixed(1)} วินาที\n\n` +
            `📋 สรุปผล:\n` +
            `• เพิ่มใหม่: *${summary.inserted}*\n` +
            `• อัปเดต: *${summary.updated}*\n` +
            `• ไม่เปลี่ยน: *${summary.unchanged}*\n` +
            `• ตารางทั้งหมด: *${tablesCount}*\n` +
            syncBlock +
            tablesBlock +
            footer;
        for (const chatId of chatIds) {
            try { await sendTelegramDirect(ns.tgToken, chatId, tgMsg); sentTelegram = true; } catch (e) {}
        }
    }

    // LINE (ใช้ข้อความเดียวกับ Telegram — สั้นกะทัดรัด)
    if (Number(schedule.notify_line) === 1 && ns.lineToken && ns.lineGroupId) {
        try {
            // สร้าง message สั้นๆ (ไม่มี markdown ไม่ใช้)
            const lineMsg = `📊 Export KPI — ${schedule.name}\n` +
                `สถานะ: ${result.success ? '✅ สำเร็จ' : '❌ ผิดพลาด'}\n` +
                `⏱ ${(durationMs/1000).toFixed(1)} วินาที\n\n` +
                `📋 สรุปผล:\n` +
                `• เพิ่มใหม่: ${summary.inserted}\n` +
                `• อัปเดต: ${summary.updated}\n` +
                `• ไม่เปลี่ยน: ${summary.unchanged}\n` +
                `• ตารางทั้งหมด: ${tablesCount}\n` +
                (sync ? `\n☁️ Sync KHD:\n• ${sync.success ? 'สำเร็จ' : 'ผิดพลาด'}: ${sync.summary.success}/${sync.summary.total} ตาราง\n• Rows: ${sync.summary.rows}` : '') +
                (sync ? '\n\n📬 ข้อมูลถูกส่งเข้า KHD แล้ว' : '\n\n⚠️ กรุณาตรวจสอบก่อนส่ง KHD');
            const r = await sendLineMulticast(ns.lineToken, ns.lineGroupId, lineMsg);
            sentLine = r.sent > 0;
        } catch (e) { console.error('[Schedule] LINE send error:', e.message); }
    }

    // Append "สถานะการส่งรายงาน" footer ใน HTML — แต่ส่งหลังจาก email/telegram เสร็จแล้ว
    // (ไม่ส่ง email อีกครั้งเพื่อแจ้ง — เก็บใน return value แทน)
    return { sentEmail, sentTelegram, sentLine };
}

// รันตาม schedule
async function runScheduledExport(schedule) {
    const startTime = Date.now();
    let result, status = 'success', errorMsg = null;
    try {
        const year_bh = schedule.year_bh || String(new Date().getFullYear() + 543);
        const scope = schedule.indicator_scope || 'all';
        let indicator_ids = 'all';

        if (scope === 'changes_only') {
            // ตรวจสอบก่อน — export เฉพาะตัวชี้วัดที่มีข้อมูลเพิ่ม/แก้ไข
            const check = await checkKpiChanges(year_bh, 'all');
            if (!check.success) {
                result = { success: false, message: check.message, summary: { inserted: 0, updated: 0, unchanged: 0, no_data: 0 }, created_tables: [], skipped: [] };
                status = 'failed'; errorMsg = check.message;
            } else {
                const changedIds = (check.details || []).filter(d => d.status === 'has_changes').map(d => d.id);
                if (changedIds.length === 0) {
                    result = { success: true, message: 'ไม่มีตัวชี้วัดที่มีการเปลี่ยนแปลง — ข้าม export', summary: { inserted: 0, updated: 0, unchanged: 0, no_data: 0 }, created_tables: [], skipped: [] };
                } else {
                    indicator_ids = changedIds;
                }
            }
        } else if (scope === 'selected') {
            indicator_ids = schedule.indicator_ids ? JSON.parse(schedule.indicator_ids) : 'all';
        }

        if (!result) {
            result = await performKpiExport(year_bh, indicator_ids, schedule.created_by);
            if (!result.success) { status = 'failed'; errorMsg = result.message; }
        }

        // Auto-sync to KHD ถ้า export สำเร็จและมีตารางและเปิด auto_sync_khd
        if (Number(schedule.auto_sync_khd) === 1 && result.success && (result.created_tables || []).length > 0) {
            try {
                const syncTables = result.created_tables.map(t => ({ table: t.table, sync_columns: null }));
                const syncOut = await performSyncToKhd(syncTables, schedule.created_by);
                result.sync = syncOut;
                if (!syncOut.success) { status = 'partial'; errorMsg = 'Export สำเร็จแต่ sync KHD มีข้อผิดพลาด'; }
            } catch (e) {
                result.sync = { success: false, message: e.message, summary: { total: 0, success: 0, error: 0, skipped: 0, rows: 0 }, results: [] };
                status = 'partial'; errorMsg = `Sync KHD failed: ${e.message}`;
            }
        }
    } catch (e) {
        result = { success: false, message: e.message };
        status = 'failed'; errorMsg = e.message;
    }
    const duration = Date.now() - startTime;

    // ส่ง notification
    let notif = { sentEmail: false, sentTelegram: false, sentLine: false };
    try { notif = await sendExportNotification(schedule, result, duration); } catch (_) {}

    // อัปเดต last_run + log
    await db.query('UPDATE export_schedules SET last_run_at=NOW(), last_status=? WHERE id=?', [status, schedule.id]);
    const summary = result.summary || { inserted: 0, updated: 0, unchanged: 0, no_data: 0 };
    await db.query(
        `INSERT INTO export_schedule_logs (schedule_id, status, inserted, updated_count, unchanged, no_data, tables_count, skipped_count, duration_ms, notified_email, notified_telegram, notified_line, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [schedule.id, status, summary.inserted, summary.updated, summary.unchanged, summary.no_data,
         (result.created_tables || []).length, (result.skipped || []).length, duration,
         notif.sentEmail ? 1 : 0, notif.sentTelegram ? 1 : 0, notif.sentLine ? 1 : 0, errorMsg]
    );
    return result;
}

// Scheduler loop: ตรวจทุก 30 วินาที + match 2 นาทีย้อนหลัง กันพลาด (dedup ด้วย last_run_at>120s)
function startExportScheduler() {
    const pad2 = (n) => String(n).padStart(2, '0');
    // ใช้ Intl.DateTimeFormat บังคับเวลา Bangkok ไม่ขึ้นกับ process.env.TZ (กันบาง env ที่ V8 cache TZ ผิด)
    const bkkFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Bangkok',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
    });
    const getBkk = (date) => {
        const parts = bkkFormatter.formatToParts(date);
        const get = (t) => parts.find(p => p.type === t)?.value || '';
        const hour = get('hour') === '24' ? '00' : get('hour');
        const wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
        return { hhmm: `${hour}:${get('minute')}`, dow: wdMap[get('weekday')] || 1 };
    };
    const check = async () => {
        try {
            const now = new Date();
            const bkkNow = getBkk(now);
            const hhmmNow = bkkNow.hhmm;
            const prev = new Date(now.getTime() - 60 * 1000);
            const hhmmPrev = getBkk(prev).hhmm;
            const dow = bkkNow.dow; // 1=จ., 7=อา.

            // ดึง schedules ที่ตรงเวลา (current หรือนาทีก่อน) และยังไม่ได้รันในช่วง 120s
            const [schedules] = await db.query(
                `SELECT * FROM export_schedules WHERE is_enabled=1
                 AND time_of_day IN (?, ?)
                 AND (last_run_at IS NULL OR TIMESTAMPDIFF(SECOND, last_run_at, NOW()) > 120)`,
                [hhmmNow, hhmmPrev]
            );
            if (schedules.length === 0) return;

            for (const s of schedules) {
                const days = (s.days_of_week || '').split(',').map(d => parseInt(d.trim(), 10)).filter(n => !isNaN(n));
                if (!days.includes(dow)) {
                    console.log(`[Scheduler] Skip "${s.name}" — วันนี้ (${dow}) ไม่อยู่ใน days [${days.join(',')}]`);
                    continue;
                }
                console.log(`[Scheduler] 🚀 Running "${s.name}" (time=${s.time_of_day}, now=${hhmmNow}, dow=${dow})`);
                // Lock ทันทีโดย update last_run_at ก่อน execute กัน double-run จาก overlapping ticks
                try {
                    await db.query('UPDATE export_schedules SET last_run_at=NOW() WHERE id=?', [s.id]);
                } catch (e) {}
                runScheduledExport(s).catch(e => console.error(`[Scheduler] "${s.name}" Error:`, e.message));
            }
        } catch (e) {
            console.error('[Scheduler] check() failed:', e.message);
        }
    };

    // รันครั้งแรกทันที (กันกรณี server start ตอนใกล้เวลา schedule)
    check().catch(e => console.error('[Scheduler] initial check failed:', e.message));
    // ตรวจทุก 30 วินาที (1 นาที จะได้ตรวจ 2 ครั้ง → ลดโอกาสพลาด)
    setInterval(check, 30000);
    const initBkk = getBkk(new Date());
    console.log(`[Scheduler] Export scheduler started — Bangkok time: ${initBkk.hhmm} (dow=${initBkk.dow}), check every 30s`);
}

// ========== Export Schedules CRUD ==========
apiRouter.get('/export-schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT s.*, u.firstname, u.lastname FROM export_schedules s LEFT JOIN users u ON s.created_by = u.id ORDER BY s.id DESC`);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/export-schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_khd, notify_email, notify_telegram, notify_line } = req.body;
        if (!name || !days_of_week || !time_of_day) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' });
        const scope = ['all', 'selected', 'changes_only'].includes(indicator_scope) ? indicator_scope : 'all';
        const [r] = await db.query(
            `INSERT INTO export_schedules (name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_khd, notify_email, notify_telegram, notify_line, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, is_enabled ? 1 : 0, days_of_week, time_of_day, year_bh || null,
             scope === 'selected' && Array.isArray(indicator_ids) ? JSON.stringify(indicator_ids) : null,
             scope, auto_sync_khd ? 1 : 0,
             notify_email ? 1 : 0, notify_telegram ? 1 : 0, notify_line ? 1 : 0, req.user.id]
        );
        res.json({ success: true, id: r.insertId, message: 'สร้าง schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/export-schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_khd, notify_email, notify_telegram, notify_line } = req.body;
        const scope = ['all', 'selected', 'changes_only'].includes(indicator_scope) ? indicator_scope : 'all';
        await db.query(
            `UPDATE export_schedules SET name=?, is_enabled=?, days_of_week=?, time_of_day=?, year_bh=?, indicator_ids=?, indicator_scope=?, auto_sync_khd=?, notify_email=?, notify_telegram=?, notify_line=? WHERE id=?`,
            [name, is_enabled ? 1 : 0, days_of_week, time_of_day, year_bh || null,
             scope === 'selected' && Array.isArray(indicator_ids) ? JSON.stringify(indicator_ids) : null,
             scope, auto_sync_khd ? 1 : 0,
             notify_email ? 1 : 0, notify_telegram ? 1 : 0, notify_line ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'แก้ไข schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/export-schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM export_schedules WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/export-schedules/:id/run-now', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM export_schedules WHERE id=?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ schedule' });
        const result = await runScheduledExport(rows[0]);
        res.json({ success: true, message: 'รัน schedule สำเร็จ', result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/export-schedules/:id/logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM export_schedule_logs WHERE schedule_id=? ORDER BY run_at DESC LIMIT 50',
            [req.params.id]
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /sync-to-khd/preview — ตรวจสอบข้อมูลก่อนส่ง KHD
apiRouter.post('/sync-to-khd/preview', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        // ดึงตาราง export ทั้งหมดจาก local (table_process ที่มีข้อมูล) พร้อมหมวดหมู่หลัก + หน่วยงาน สำหรับ filter/แสดงผล
        const [indicators] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process,
                   mi.main_indicator_name, d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON i.dept_id = d.id
            WHERE i.is_active = 1 AND i.table_process IS NOT NULL AND i.table_process != ''
        `);
        // deduplicate ตาม table_process (1 ตารางอาจมีหลายตัวชี้วัด/หลายหมวดหมู่/หลายหน่วยงานรวมกันได้)
        const tableMap = new Map();
        for (const ind of indicators) {
            const tp = ind.table_process.trim();
            if (!tableMap.has(tp)) tableMap.set(tp, { table: tp, names: [], ids: [], mainIndicatorNames: new Set(), deptNames: new Set() });
            const entry = tableMap.get(tp);
            entry.names.push(ind.kpi_indicators_name);
            entry.ids.push(ind.id);
            if (ind.main_indicator_name) entry.mainIndicatorNames.add(ind.main_indicator_name);
            if (ind.dept_name) entry.deptNames.add(ind.dept_name);
        }
        const tables = [];
        for (const [tp, info] of tableMap) {
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tp)) continue;
            const item = {
                table: tp, name: info.names.join(' | '),
                main_indicator_name: Array.from(info.mainIndicatorNames).join(' | ') || null,
                dept_name: Array.from(info.deptNames).join(' | ') || null,
                local_rows: 0, remote_rows: 0, local_columns: [], remote_columns: [], status: 'unknown'
            };
            // ตรวจ local table
            try {
                const [localCount] = await db.query(`SELECT COUNT(*) AS cnt FROM \`${tp}\``);
                item.local_rows = localCount[0].cnt;
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tp}\``);
                item.local_columns = localCols.map(c => c.Field);
            } catch (e) { item.status = 'no_local'; continue; }
            // ตรวจ remote table
            try {
                const [remoteCount] = await remoteDb.query(`SELECT COUNT(*) AS cnt FROM \`${tp}\``);
                item.remote_rows = remoteCount[0].cnt;
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tp}\``);
                item.remote_columns = remoteCols.map(c => c.Field);
            } catch (e) { item.status = 'no_remote'; }
            if (item.status === 'unknown') {
                item.status = item.local_rows > 0 ? 'ready' : 'empty';
            }
            // หา common columns
            if (item.local_columns.length > 0 && item.remote_columns.length > 0) {
                item.sync_columns = item.local_columns.filter(c => item.remote_columns.includes(c));
            }
            tables.push(item);
        }
        res.json({ success: true, tables });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// POST /sync-to-khd/execute — ส่งข้อมูลจาก local export tables เข้า KHD
apiRouter.post('/sync-to-khd/execute', authenticateToken, isSuperAdmin, async (req, res) => {
    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตารางที่ต้องการ' });
    const out = await performSyncToKhd(tables, req.user.userId);
    if (!out.success && out.results.length === 0) return res.status(400).json(out);
    res.json(out);
});

// ========== KPI Summary (Materialized View) ==========

// POST /refresh-summary/prepare — ล้างข้อมูลเก่า + ส่ง indicator_ids กลับให้ frontend batch
apiRouter.post('/refresh-summary/prepare', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    try {
        const year = req.body.year_bh || '';
        if (year) await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [year]);
        else await db.query('TRUNCATE TABLE kpi_summary');

        const yearFilter = year ? 'AND year_bh = ?' : '';
        const yearParams = year ? [year] : [];
        const [indRows] = await db.query(
            `SELECT DISTINCT indicator_id FROM kpi_results WHERE 1=1 ${yearFilter}`,
            yearParams
        );
        // ตัวชี้วัดที่มีผลงานเฉพาะข้อย่อย/กิจกรรม (ตัวชี้วัด 3 ระดับ) ต้องอยู่ในรายการ batch ด้วย
        const [subIndRows] = await db.query(
            `SELECT DISTINCT si.indicator_id FROM kpi_sub_results sr JOIN kpi_sub_indicators si ON si.id = sr.sub_indicator_id WHERE 1=1 ${yearFilter.replace('year_bh', 'sr.year_bh')}
             UNION
             SELECT DISTINCT si.indicator_id FROM kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id
             JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id WHERE 1=1 ${yearFilter.replace('year_bh', 'ar.year_bh')}`,
            [...yearParams, ...yearParams]
        );
        const allIds = [...new Set([...indRows, ...subIndRows].map(r => Number(r.indicator_id)))];
        res.json({ success: true, indicator_ids: allIds, total: allIds.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}));

// POST /refresh-summary/batch — ประมวลผลทีละ batch (frontend ส่ง indicator_ids มา)
apiRouter.post('/refresh-summary/batch', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    try {
        const { indicator_ids, year_bh } = req.body;
        if (!Array.isArray(indicator_ids) || indicator_ids.length === 0) {
            return res.json({ success: true, inserted: 0 });
        }
        const yearFilter = year_bh ? 'AND r.year_bh = ?' : '';
        const yearParams = year_bh ? [year_bh] : [];
        const idPlaceholders = indicator_ids.map(() => '?').join(',');

        // ลบแถวของตัวชี้วัดชุดนี้ก่อน (เดิมพึ่ง /prepare ลบทั้งปีไว้ก่อน — แต่ระหว่าง prepare กับ batch การอัปเดตอัตโนมัติหลังบันทึกผลงาน
        // อาจสร้างแถวกลับมาแล้ว → INSERT ชน uk_ind_year_hos) — ลบซ้ำได้ ไม่มีผลข้างเคียง
        await db.query(`DELETE FROM kpi_summary WHERE indicator_id IN (${idPlaceholders}) ${year_bh ? 'AND year_bh = ?' : ''}`, [...indicator_ids, ...yearParams]);

        const [result] = await db.query(`
            INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, main_indicator_name, kpi_indicators_name,
                dept_id, dept_name, hosname, distid, hostype, distname, table_process, target_value,
                oct, nov, dece, jan, feb, mar, apr, may, jun, jul, aug, sep,
                pending_count, indicator_status, is_locked, updated_at)
            SELECT
                i.id, r.year_bh, r.hospcode,
                IFNULL(mi.main_indicator_name, 'ยังไม่กำหนด'),
                i.kpi_indicators_name, i.dept_id, d.dept_name, h.hosname, h.distid, h.hostype, dist.distname, i.table_process,
                MAX(r.target_value),
                MAX(CASE WHEN r.month_bh=10 THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=11 THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=12 THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=1  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=2  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=3  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=4  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=5  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=6  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=7  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=8  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=9  THEN r.actual_value END),
                SUM(CASE WHEN r.status='Pending' THEN 1 ELSE 0 END),
                MAX(r.status),
                MAX(CASE WHEN r.is_locked=1 THEN 1 ELSE 0 END),
                NOW()
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            WHERE r.indicator_id IN (${idPlaceholders}) ${yearFilter}
            GROUP BY i.id, r.year_bh, r.hospcode
            -- ผลงาน 0 นับเป็นผลงานจริง (เช่น ไม่มีผู้เสียชีวิต = 0 ราย) — เดิมตัดทิ้งทำให้คู่ที่บันทึก 0 ทั้งปีหายจากรายงาน (24 ต.ค. 2569 — ตรงกับ hasActualData ของ Export)
            HAVING MAX(CASE WHEN r.actual_value IS NOT NULL AND TRIM(r.actual_value) != '' THEN 1 ELSE 0 END) = 1
        `, [...indicator_ids, ...yearParams]);
        // ผลงานจากตัวชี้วัดย่อย/กิจกรรม (ตัวชี้วัด 3 ระดับ) — last_actual คำนวณใน /refresh-summary/finalize
        const merged = await mergeSubIntoSummary(db, { indicatorIds: indicator_ids, yearBh: year_bh || undefined });

        res.json({ success: true, inserted: result.affectedRows || 0, merged_from_sub: merged });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}));

// POST /refresh-summary/finalize — อัปเดต last_actual + has_form_schema
apiRouter.post('/refresh-summary/finalize', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    try {
        const year = req.body.year_bh || '';
        const yearWhere = year ? `AND s.year_bh = ?` : '';
        const yearParams = year ? [year] : [];

        // ตัวชี้วัดปกติ: last_actual = ค่าเดือนล่าสุดที่มีข้อมูล (เดิม)
        await db.query(`
            UPDATE kpi_summary s
            JOIN kpi_indicators i ON i.id = s.indicator_id AND (i.is_cumulative = 0 OR i.is_cumulative IS NULL)
            SET s.last_actual = COALESCE(
                NULLIF(s.sep,''), NULLIF(s.aug,''), NULLIF(s.jul,''), NULLIF(s.jun,''),
                NULLIF(s.may,''), NULLIF(s.apr,''), NULLIF(s.mar,''), NULLIF(s.feb,''),
                NULLIF(s.jan,''), NULLIF(s.dece,''), NULLIF(s.nov,''), NULLIF(s.oct,'')
            )
            WHERE 1=1 ${yearWhere}
        `, yearParams);

        // ตัวชี้วัดสะสม: last_actual = ผลรวมตัวเลขทุกเดือนในปีงบ (NULL ถ้าไม่มีเดือนไหนมีค่าเลย)
        await db.query(`
            UPDATE kpi_summary s
            JOIN kpi_indicators i ON i.id = s.indicator_id AND i.is_cumulative = 1
            SET s.last_actual = CASE
                WHEN NULLIF(s.oct,'') IS NULL AND NULLIF(s.nov,'') IS NULL AND NULLIF(s.dece,'') IS NULL AND NULLIF(s.jan,'') IS NULL
                 AND NULLIF(s.feb,'') IS NULL AND NULLIF(s.mar,'') IS NULL AND NULLIF(s.apr,'') IS NULL AND NULLIF(s.may,'') IS NULL
                 AND NULLIF(s.jun,'') IS NULL AND NULLIF(s.jul,'') IS NULL AND NULLIF(s.aug,'') IS NULL AND NULLIF(s.sep,'') IS NULL
                THEN NULL
                ELSE (
                    COALESCE(CAST(NULLIF(s.oct,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.nov,'') AS DECIMAL(20,4)),0) +
                    COALESCE(CAST(NULLIF(s.dece,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.jan,'') AS DECIMAL(20,4)),0) +
                    COALESCE(CAST(NULLIF(s.feb,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.mar,'') AS DECIMAL(20,4)),0) +
                    COALESCE(CAST(NULLIF(s.apr,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.may,'') AS DECIMAL(20,4)),0) +
                    COALESCE(CAST(NULLIF(s.jun,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.jul,'') AS DECIMAL(20,4)),0) +
                    COALESCE(CAST(NULLIF(s.aug,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.sep,'') AS DECIMAL(20,4)),0)
                )
            END
            WHERE 1=1 ${yearWhere}
        `, yearParams);

        // ตัวชี้วัดที่ตั้งสูตรคำนวณผลงาน: ทับ last_actual ด้วยผลจากสูตร (ต้องอยู่หลัง 2 UPDATE ด้านบนเสมอ)
        await applyFormulaToSummary(db, { yearBh: year || undefined });

        const [formSchemas] = await db.query('SELECT indicator_id FROM kpi_form_schemas WHERE is_active = 1');
        if (formSchemas.length > 0) {
            const ids = formSchemas.map(f => f.indicator_id);
            await db.query('UPDATE kpi_summary SET has_form_schema = 1 WHERE indicator_id IN (' + ids.join(',') + ')');
        }

        res.json({ success: true, message: 'Finalize สำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}));

// GET /kpi-summary — ดึงข้อมูลจาก summary table (เร็วมาก ไม่ต้อง JOIN)
// ผลงานรายเดือนของปีงบที่แล้ว (year_bh - 1) จาก kpi_summary ตามขอบเขตสิทธิ์เดียวกับรายงาน (chartScopeClauses)
// ใช้เป็นค่าอ้างอิง "เตือนค่าที่อาจผิดปกติ" ตอนบันทึกผลงานในหน้า dashboard (frontend/src/app/shared/anomaly.ts) — อ่านอย่างเดียว
// hospcodes (ไม่บังคับ, คั่นด้วยจุลภาค ≤ 300) = จำกัดเฉพาะหน่วยบริการที่แสดงอยู่ในตาราง
apiRouter.get('/kpi-summary/prev-year-months', authenticateToken, async (req, res) => {
    try {
        const year = String(req.query.year_bh || '').trim();
        if (!/^\d{4}$/.test(year)) return res.status(400).json({ success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' });
        const prevYear = String(Number(year) - 1);
        const scope = await chartScopeClauses(req.user);
        const c = [...scope.c, 's.year_bh = ?'], p = [...scope.p, prevYear];
        const hospcodes = String(req.query.hospcodes || '').split(',').map(h => h.trim()).filter(h => /^[0-9A-Za-z]{1,20}$/.test(h)).slice(0, 300);
        if (hospcodes.length > 0) { c.push('s.hospcode IN (?)'); p.push(hospcodes); }
        const [rows] = await db.query(
            `SELECT s.indicator_id, s.hospcode, s.oct, s.nov, s.dece, s.jan, s.feb, s.mar, s.apr, s.may, s.jun, s.jul, s.aug, s.sep
             FROM kpi_summary s JOIN kpi_indicators i ON i.id = s.indicator_id
             WHERE ${c.join(' AND ')} LIMIT 20000`, p);
        res.json({ success: true, year_bh: prevYear, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.get('/kpi-summary', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const conditions = [];
        const params = [];

        if (req.query.year && req.query.year !== '') { conditions.push('s.year_bh = ?'); params.push(req.query.year); }
        if (req.query.hospcode) { conditions.push('s.hospcode = ?'); params.push(req.query.hospcode); }
        if (req.query.dept) { conditions.push('s.dept_name = ?'); params.push(req.query.dept); }
        if (req.query.district) { conditions.push('s.distname = ?'); params.push(req.query.district); }
        if (req.query.indicator) { conditions.push('s.kpi_indicators_name = ?'); params.push(req.query.indicator); }
        if (req.query.main) { conditions.push('s.main_indicator_name = ?'); params.push(req.query.main); }
        conditions.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        // Role-based filter
        if (user.role === 'admin_ssj' && user.deptId != null) {
            conditions.push('s.dept_name = (SELECT dept_name FROM departments WHERE id = ?)');
            params.push(user.deptId);
        } else if (!['super_admin', 'admin_ssj'].includes(user.role) && user.hospcode) {
            conditions.push('s.hospcode = ?');
            params.push(user.hospcode);
        }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const [rows] = await db.query(`SELECT * FROM kpi_summary s ${where} ORDER BY s.year_bh DESC, s.main_indicator_name, s.kpi_indicators_name LIMIT 500`, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== Report Summary APIs ==========

// รายงานสรุป: รายข้อตัวชี้วัด
apiRouter.get('/report/by-indicator', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('s.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('s.distid = ?'); params.push(distid); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.indicator_id,
                MAX(s.kpi_indicators_name) AS kpi_indicators_name,
                MAX(s.main_indicator_name) AS main_indicator_name,
                MAX(s.dept_name) AS dept_name,
                MAX(i.criterion) AS ind_criterion,
                MAX(i.result_formula) AS result_formula,
                MAX(i.target_condition) AS ind_target_condition,
                s.year_bh,
                MAX(CAST(s.target_value AS DECIMAL(20,4))) AS target_value,
                SUM(CAST(s.oct AS DECIMAL(20,4))) AS oct,
                SUM(CAST(s.nov AS DECIMAL(20,4))) AS nov,
                SUM(CAST(s.dece AS DECIMAL(20,4))) AS dece,
                SUM(CAST(s.jan AS DECIMAL(20,4))) AS jan,
                SUM(CAST(s.feb AS DECIMAL(20,4))) AS feb,
                SUM(CAST(s.mar AS DECIMAL(20,4))) AS mar,
                SUM(CAST(s.apr AS DECIMAL(20,4))) AS apr,
                SUM(CAST(s.may AS DECIMAL(20,4))) AS may_val,
                SUM(CAST(s.jun AS DECIMAL(20,4))) AS jun,
                SUM(CAST(s.jul AS DECIMAL(20,4))) AS jul,
                SUM(CAST(s.aug AS DECIMAL(20,4))) AS aug,
                SUM(CAST(s.sep AS DECIMAL(20,4))) AS sep,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                COUNT(DISTINCT s.hospcode) AS hospital_count,
                -- จำนวน hospcode ที่มี target — ใช้เทียบความสำเร็จ
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS hospitals_with_target,
                -- จำนวน hospcode ที่ผ่านเกณฑ์ (ตามเงื่อนไขเป้าหมาย ≥ > ≤ < = — targetPassSql)
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS hospitals_passed,
                -- % สำเร็จ = passed / with_target × 100
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct
            FROM kpi_summary s
            LEFT JOIN kpi_indicators i ON i.id = s.indicator_id
            ${whereStr}
            GROUP BY s.indicator_id, s.year_bh
            ORDER BY achievement_pct DESC, MAX(s.main_indicator_name), MAX(s.kpi_indicators_name)
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-indicator error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายหน่วยบริการ
apiRouter.get('/report/by-hospital', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('s.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('s.distid = ?'); params.push(distid); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.hospcode,
                MAX(s.hosname) AS hosname,
                MAX(s.distid) AS distid,
                MAX(s.distname) AS distname,
                s.year_bh,
                COUNT(DISTINCT s.indicator_id) AS indicator_count,
                SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) AS total_target,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                -- จำนวนตัวชี้วัดที่มี target (ใช้เป็นตัวหารของ % สำเร็จ)
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS indicators_with_target,
                -- จำนวนตัวชี้วัดที่ผ่านเกณฑ์ (ตามเงื่อนไขเป้าหมาย ≥ > ≤ < = — targetPassSql)
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS indicators_passed,
                -- % สำเร็จ = passed / with_target × 100 (ไม่ใช่ SUM(actual)/SUM(target))
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct,
                SUM(CASE WHEN s.indicator_status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(s.pending_count) AS pending_count
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.hospcode, s.year_bh
            ORDER BY achievement_pct DESC, MAX(s.distname), MAX(s.hosname)
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-hospital error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายอำเภอ
apiRouter.get('/report/by-district', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('s.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.distid,
                MAX(s.distname) AS distname,
                s.year_bh,
                COUNT(DISTINCT s.hospcode) AS hospital_count,
                COUNT(DISTINCT s.indicator_id) AS indicator_count,
                SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) AS total_target,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                -- count-based achievement (ไม่ใช่ SUM ratio)
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS pairs_with_target,
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS pairs_passed,
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.distid, s.year_bh
            ORDER BY achievement_pct DESC, MAX(s.distname)
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-district error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายปีงบประมาณ
apiRouter.get('/report/by-year', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { dept_id, distid, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('s.distid = ?'); params.push(distid); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.year_bh,
                COUNT(DISTINCT s.indicator_id) AS indicator_count,
                COUNT(DISTINCT s.hospcode) AS hospital_count,
                SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) AS total_target,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                -- count-based achievement (ไม่ใช่ SUM ratio)
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS pairs_with_target,
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS pairs_passed,
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct,
                SUM(CASE WHEN s.indicator_status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(s.pending_count) AS pending_count
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.year_bh
            ORDER BY achievement_pct DESC, s.year_bh DESC
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-year error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// ========== กราฟและสถิติ (หน้า /charts แท็บกราฟ) ==========
// รวมผลทุกมิติใน SQL จาก kpi_summary ทั้งหมด (ไม่จำกัด 500 แถวแบบ /kpi-summary เดิม) — ใช้เกณฑ์ "ผ่าน" เดียวกับการ์ดสถิติ
// และรายงาน 4 แถบ: คู่ (ตัวชี้วัด × หน่วยบริการ) ที่มีเป้าหมาย > 0 และผลงานล่าสุด (last_actual) ≥ เป้าหมาย
// ร้อยละ = ผ่าน ÷ มีเป้าหมาย × 100 (นับเป็นคู่ ไม่ SUM ค่าดิบข้ามตัวชี้วัด เพราะหน่วยนับต่างกัน)
const CHART_MONTHS = [
    ['oct', 'ต.ค.'], ['nov', 'พ.ย.'], ['dece', 'ธ.ค.'], ['jan', 'ม.ค.'], ['feb', 'ก.พ.'], ['mar', 'มี.ค.'],
    ['apr', 'เม.ย.'], ['may', 'พ.ค.'], ['jun', 'มิ.ย.'], ['jul', 'ก.ค.'], ['aug', 'ส.ค.'], ['sep', 'ก.ย.']
];
// มีเป้าหมาย/ผ่าน ตามเงื่อนไขเป้าหมายของตัวชี้วัด (i.target_condition — CHART_FROM_SQL JOIN kpi_indicators อยู่แล้ว) ตรงกับการ์ด /dashboard-stats
const _cHas = targetHasSql('s.target_value', 'i.target_condition');
// ห้ามใช้ "?" ใน regex — mysql2 ตีความ ? ทุกตัวเป็น placeholder แม้อยู่ใน string literal ของ SQL
const _cNum = (col) => `TRIM(${col}) REGEXP '^-{0,1}[0-9]+([.][0-9]+){0,1}$'`;
const CHART_METRICS_SQL = `
    COUNT(*) AS pairs,
    COUNT(DISTINCT s.indicator_id) AS indicator_count,
    COUNT(DISTINCT s.hospcode) AS hospital_count,
    SUM(CASE WHEN ${_cHas} THEN 1 ELSE 0 END) AS with_target,
    SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', 'i.target_condition')} THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN NULLIF(TRIM(s.last_actual),'') IS NOT NULL THEN 1 ELSE 0 END) AS recorded,
    SUM(CASE WHEN COALESCE(s.pending_count,0) > 0 THEN 1 ELSE 0 END) AS pending_pairs`;
// รายเดือน: recorded = มีค่าในเดือนนั้น | eligible/passed = เทียบค่าเดือนนั้นกับเป้าหมาย เฉพาะตัวชี้วัดแบบปกติ
// (ไม่รวมตัวชี้วัดสะสม/มีสูตร เพราะค่ารายเดือนของตัวชี้วัดเหล่านั้นไม่ใช่ "ผลงาน ณ เดือนนั้น")
const _cNormal = "(COALESCE(i.is_cumulative,0) = 0 AND (i.result_formula IS NULL OR TRIM(i.result_formula) = ''))";
const CHART_MONTHLY_SQL = CHART_MONTHS.map(([m]) => `
    SUM(CASE WHEN NULLIF(TRIM(s.${m}),'') IS NOT NULL THEN 1 ELSE 0 END) AS rec_${m},
    SUM(CASE WHEN ${_cNormal} AND ${_cHas} AND ${_cNum('s.' + m)} THEN 1 ELSE 0 END) AS elig_${m},
    SUM(CASE WHEN ${_cNormal} AND ${_cNum('s.' + m)} AND ${targetPassSql('s.' + m, 's.target_value', 'i.target_condition')} THEN 1 ELSE 0 END) AS pass_${m}`).join(',');

function chartPct(n, d) { return Number(d) > 0 ? Math.round(Number(n) / Number(d) * 10000) / 100 : 0; }
function chartRow(r) {
    const o = { ...r };
    for (const k of ['pairs', 'indicator_count', 'hospital_count', 'with_target', 'passed', 'recorded', 'pending_pairs']) o[k] = Number(r[k] || 0);
    o.not_passed = o.with_target - o.passed;
    o.no_target = o.pairs - o.with_target;
    o.achievement_pct = chartPct(o.passed, o.with_target);
    o.recording_pct = chartPct(o.recorded, o.pairs);
    return o;
}
function chartMonthly(r) {
    return CHART_MONTHS.map(([m, label]) => {
        const rec = Number(r[`rec_${m}`] || 0), elig = Number(r[`elig_${m}`] || 0), pass = Number(r[`pass_${m}`] || 0);
        return { month: m, label, recorded: rec, eligible: elig, passed: pass, pass_pct: chartPct(pass, elig), recording_pct: chartPct(rec, Number(r.pairs || 0)) };
    });
}

// ขอบเขตตาม role บน kpi_summary (เหมือน /report/by-indicator ทุกประการ)
async function chartScopeClauses(user) {
    const c = [], p = [];
    if (user.role === 'super_admin') {
        // เห็นทั้งหมด
    } else if (user.role === 'admin_ssj') {
        if (user.deptId != null) { c.push('s.dept_id = ?'); p.push(user.deptId); }
    } else if (user.role === 'admin_cup') {
        const d = await getDistrictId(user.hospcode);
        if (d) { c.push('s.distid = ?'); p.push(d); } else if (user.hospcode) { c.push('s.hospcode = ?'); p.push(user.hospcode); }
    } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
        if (user.hospcode) { c.push('s.hospcode = ?'); p.push(user.hospcode); }
    } else if (user.role === 'user_cup') {
        const d = await getDistrictId(user.hospcode);
        if (d) { c.push('s.distid = ?'); p.push(d); }
        if (user.deptId != null) { c.push('s.dept_id = ?'); p.push(user.deptId); }
    } else {
        if (user.hospcode) { c.push('s.hospcode = ?'); p.push(user.hospcode); }
        if (user.deptId != null) { c.push('s.dept_id = ?'); p.push(user.deptId); }
    }
    c.push('i.is_active = 1'); // เฉพาะตัวชี้วัดที่เปิดใช้งาน
    return { c, p };
}

const CHART_FROM_SQL = `
    FROM kpi_summary s
    JOIN kpi_indicators i ON i.id = s.indicator_id
    LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
    LEFT JOIN main_yut y ON y.id = COALESCE(mi.yut_id, i.main_yut)`;  // ยุทธศาสตร์: จากหมวดหมู่หลัก ถ้าไม่มีหมวดหมู่ใช้ kpi_indicators.main_yut

apiRouter.get('/report/chart-stats', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, yut_id, main_id, dept_id, indicator_id, distid, hostype } = req.query;
        const scope = await chartScopeClauses(user);

        // ปีงบที่มีข้อมูล (ตามขอบเขต role) — ใช้เป็นตัวเลือกปี
        const [yearRows] = await db.query(
            `SELECT DISTINCT s.year_bh ${CHART_FROM_SQL} WHERE ${scope.c.join(' AND ')} ORDER BY s.year_bh DESC`, scope.p);
        const years = yearRows.map(r => String(r.year_bh));
        const year = year_bh ? String(year_bh) : (years[0] || '');

        // ตัวเลือก dropdown — ขอบเขต role + ปี (ไม่ขึ้นกับตัวกรองอื่น)
        const baseC = [...scope.c, 's.year_bh = ?'], baseP = [...scope.p, year];
        const [optRows] = await db.query(`
            SELECT DISTINCT y.id AS yut_id, y.yut_name, mi.id AS main_id, mi.main_indicator_name,
                   s.dept_id, s.dept_name, s.indicator_id, i.kpi_indicators_name, s.distid, s.distname, s.hostype
            ${CHART_FROM_SQL} WHERE ${baseC.join(' AND ')}`, baseP);

        // ตัวกรองที่ผู้ใช้เลือก
        const c = [...baseC], p = [...baseP];
        const eqFilter = (col, v, num) => {
            if (v === undefined || v === null || v === '') return;
            if (num && !/^\d+$/.test(String(v))) { c.push('1 = 0'); return; } // id ไม่ใช่ตัวเลข → ไม่มีข้อมูล
            c.push(`${col} = ?`); p.push(num ? Number(v) : String(v));
        };
        if (yut_id === '0') c.push('y.id IS NULL'); else eqFilter('y.id', yut_id, true);
        if (main_id === '0') c.push('mi.id IS NULL'); else eqFilter('mi.id', main_id, true);
        if (dept_id === '0') c.push('s.dept_id IS NULL'); else eqFilter('s.dept_id', dept_id, true);
        eqFilter('s.indicator_id', indicator_id, true);
        eqFilter('s.distid', distid, false);
        eqFilter('s.hostype', hostype, false);
        const where = 'WHERE ' + c.join(' AND ');

        const groupQuery = (keySql, nameSql, extra = '') => db.query(`
            SELECT ${keySql} AS gkey, ${nameSql} AS gname ${extra}, ${CHART_METRICS_SQL}
            ${CHART_FROM_SQL} ${where} GROUP BY ${keySql}`, p);

        const [[overallRows], [yutRows], [mainRows], [deptRows], [indRows], [distRows], [hostypeRows], [mainMonthRows], [deptMonthRows], [hostypeNames]] = await Promise.all([
            db.query(`SELECT ${CHART_METRICS_SQL}, ${CHART_MONTHLY_SQL} ${CHART_FROM_SQL} ${where}`, p),
            groupQuery('COALESCE(y.id, 0)', "COALESCE(MAX(y.yut_name), 'ไม่ระบุยุทธศาสตร์')"),
            groupQuery('COALESCE(mi.id, 0)', "COALESCE(MAX(mi.main_indicator_name), 'ไม่ระบุหมวดหมู่')", ", MAX(y.yut_name) AS yut_name"),
            groupQuery('COALESCE(s.dept_id, 0)', "COALESCE(MAX(s.dept_name), 'ไม่ระบุหน่วยงาน')"),
            groupQuery('s.indicator_id', 'MAX(i.kpi_indicators_name)',
                ", MAX(mi.main_indicator_name) AS main_indicator_name, MAX(s.dept_name) AS dept_name, MAX(i.criterion) AS criterion, MAX(i.target_condition) AS target_condition, MAX(i.result_formula) AS result_formula"),
            groupQuery("COALESCE(s.distid, '')", "COALESCE(MAX(s.distname), 'ไม่ระบุอำเภอ')"),
            groupQuery("COALESCE(s.hostype, '')", "MAX(s.hostype)"),
            db.query(`SELECT COALESCE(mi.id, 0) AS gkey, COALESCE(MAX(mi.main_indicator_name), 'ไม่ระบุหมวดหมู่') AS gname, COUNT(*) AS pairs, ${CHART_MONTHLY_SQL}
                      ${CHART_FROM_SQL} ${where} GROUP BY COALESCE(mi.id, 0)`, p),
            db.query(`SELECT COALESCE(s.dept_id, 0) AS gkey, COALESCE(MAX(s.dept_name), 'ไม่ระบุหน่วยงาน') AS gname, COUNT(*) AS pairs, ${CHART_MONTHLY_SQL}
                      ${CHART_FROM_SQL} ${where} GROUP BY COALESCE(s.dept_id, 0)`, p),
            // ชื่อประเภทหน่วยบริการแยก query (chostype คนละ collation กับ kpi_summary — ไม่ JOIN ตรง)
            db.query('SELECT hostypecode, hostypename FROM chostype'),
        ]);

        const typeName = new Map(hostypeNames.map(h => [String(h.hostypecode), h.hostypename]));
        const byPct = (a, b) => b.achievement_pct - a.achievement_pct || b.with_target - a.with_target || String(a.gname).localeCompare(String(b.gname), 'th');
        const mapGroup = (rows) => rows.map(chartRow).sort(byPct);
        const overall = chartRow(overallRows[0] || {});

        // การกระจายของตัวชี้วัดตามช่วงร้อยละผ่านเกณฑ์ (เฉพาะตัวที่มีเป้าหมาย)
        const byIndicator = mapGroup(indRows);
        const buckets = [
            { key: 'b0', label: '0–49%', min: 0, max: 50 }, { key: 'b50', label: '50–79%', min: 50, max: 80 },
            { key: 'b80', label: '80–99%', min: 80, max: 100 }, { key: 'b100', label: '100%', min: 100, max: Infinity }
        ].map(b => ({ ...b, count: byIndicator.filter(r => r.with_target > 0 && r.achievement_pct >= b.min && r.achievement_pct < b.max).length }));
        buckets.forEach(b => { delete b.min; delete b.max; });

        const uniq = (arr, key) => [...new Map(arr.filter(r => r[key] != null).map(r => [r[key], r])).values()];
        res.json({
            success: true,
            year_bh: year,
            options: {
                years,
                yuts: uniq(optRows, 'yut_id').map(r => ({ id: r.yut_id, name: r.yut_name })).sort((a, b) => a.id - b.id),
                mains: uniq(optRows, 'main_id').map(r => ({ id: r.main_id, name: r.main_indicator_name, yut_id: r.yut_id })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                depts: uniq(optRows, 'dept_id').map(r => ({ id: r.dept_id, name: r.dept_name })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                indicators: uniq(optRows, 'indicator_id').map(r => ({ id: r.indicator_id, name: r.kpi_indicators_name, main_id: r.main_id, dept_id: r.dept_id })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                districts: uniq(optRows, 'distid').map(r => ({ id: r.distid, name: r.distname })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                hostypes: uniq(optRows, 'hostype').map(r => ({ id: r.hostype, name: typeName.get(String(r.hostype)) || r.hostype })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
            },
            overall,
            monthly: chartMonthly(overallRows[0] || {}),
            by_yut: mapGroup(yutRows),
            by_main: mapGroup(mainRows),
            by_dept: mapGroup(deptRows),
            by_indicator: byIndicator,
            by_district: mapGroup(distRows),
            by_hostype: mapGroup(hostypeRows).map(r => ({ ...r, gname: typeName.get(String(r.gkey)) || (r.gkey ? `ประเภท ${r.gkey}` : 'ไม่ระบุประเภท') })),
            heatmap_main: mainMonthRows.map(r => ({ gkey: r.gkey, gname: r.gname, months: chartMonthly(r) })),
            heatmap_dept: deptMonthRows.map(r => ({ gkey: r.gkey, gname: r.gname, months: chartMonthly(r) })),
            distribution: buckets,
        });
    } catch (error) {
        console.error('Report chart-stats error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลกราฟได้' });
    }
});

// รายงาน: สถานะการบันทึก (Monitor) — ดูว่าตัวชี้วัดใดมีการบันทึก/ไม่ได้บันทึก คิดเป็น %
//   - total_hospitals  = จำนวน hospcode ที่อยู่ใน kpi_results (มี target หรือ actual ใดๆ) ของตัวชี้วัดนั้น
//   - recorded_hospitals = จำนวน hospcode ที่มี actual_value ในเดือนใดๆ (ไม่ว่า target จะตั้งหรือไม่)
//   - recording_pct    = recorded / total × 100
apiRouter.get('/report/recording-status', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        if (!year_bh) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณ' });
        }

        let indicatorWhere = ['r.year_bh = ?', 'i.is_active = 1'];
        let params = [year_bh];

        // Role-based scope (เทียบกับ kpi_indicators i, kpi_results r)
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { indicatorWhere.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { indicatorWhere.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
            if (user.deptId != null) { indicatorWhere.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { indicatorWhere.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { indicatorWhere.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { indicatorWhere.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid); }
        if (hostype) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE hostype = ?)'); params.push(hostype); }

        const whereStr = 'WHERE ' + indicatorWhere.join(' AND ');

        // Per-indicator recording stats
        const sql = `
            WITH hospital_records AS (
                SELECT
                    r.indicator_id,
                    r.year_bh,
                    r.hospcode,
                    MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded,
                    MAX(CASE WHEN NULLIF(TRIM(r.target_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_target
                FROM kpi_results r
                JOIN kpi_indicators i ON i.id = r.indicator_id
                ${whereStr}
                GROUP BY r.indicator_id, r.year_bh, r.hospcode
            )
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                i.criterion,
                i.target_condition,
                i.result_formula,
                mi.main_indicator_name,
                d.dept_name,
                hr.year_bh,
                COUNT(*) AS total_hospitals,
                SUM(hr.has_recorded) AS recorded_hospitals,
                SUM(hr.has_target) AS target_hospitals,
                COUNT(*) - SUM(hr.has_recorded) AS missing_hospitals,
                CASE WHEN COUNT(*) = 0 THEN 0
                     ELSE ROUND(SUM(hr.has_recorded) / COUNT(*) * 100, 2)
                END AS recording_pct
            FROM hospital_records hr
            JOIN kpi_indicators i ON i.id = hr.indicator_id
            LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
            LEFT JOIN departments d ON d.id = i.dept_id
            GROUP BY i.id, hr.year_bh
            ORDER BY recording_pct DESC, mi.main_indicator_name, i.kpi_indicators_name
            LIMIT 1000
        `;
        const [rows] = await db.query(sql, params);

        // Summary (overall)
        const totalIndicators = rows.length;
        const fullyRecorded = rows.filter(r => Number(r.recording_pct) >= 100).length;
        const notRecorded = rows.filter(r => Number(r.recording_pct) === 0).length;
        const partiallyRecorded = totalIndicators - fullyRecorded - notRecorded;
        const avgPct = totalIndicators === 0 ? 0 :
            Math.round(rows.reduce((s, r) => s + Number(r.recording_pct || 0), 0) / totalIndicators * 100) / 100;

        res.json({
            success: true,
            summary: {
                total_indicators: totalIndicators,
                fully_recorded: fullyRecorded,
                partially_recorded: partiallyRecorded,
                not_recorded: notRecorded,
                avg_recording_pct: avgPct
            },
            data: rows
        });
    } catch (error) {
        console.error('Report recording-status error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลสถานะการบันทึกได้' });
    }
});

// รายงาน: สถานะการบันทึก รายหน่วยบริการ (Monitor — Per Hospital)
//   - total_indicators   = จำนวนตัวชี้วัดที่ รพ. นั้นต้องบันทึก (มีใน kpi_results ของปีนั้น)
//   - recorded_indicators = จำนวนตัวชี้วัดที่ รพ. มี actual_value ในเดือนใดๆ
//   - missing_indicators = total - recorded (ตัวที่ยังค้าง)
//   - recording_pct      = recorded / total × 100
//   เรียงจาก recording_pct ASC (ค้างมากสุดขึ้นก่อน) เพื่อให้ admin จับตา รพ. ที่ล่าช้าได้ง่าย
apiRouter.get('/report/recording-status/by-hospital', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        if (!year_bh) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณ' });
        }

        let whereClauses = ['r.year_bh = ?', 'i.is_active = 1'];
        let params = [year_bh];

        // Role-based scope (เดียวกับ /report/recording-status)
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid); }
        if (hostype) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE hostype = ?)'); params.push(hostype); }

        const whereStr = 'WHERE ' + whereClauses.join(' AND ');

        const sql = `
            WITH hospital_indicators AS (
                SELECT
                    r.hospcode,
                    r.year_bh,
                    r.indicator_id,
                    MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded
                FROM kpi_results r
                JOIN kpi_indicators i ON i.id = r.indicator_id
                ${whereStr}
                GROUP BY r.hospcode, r.year_bh, r.indicator_id
            )
            SELECT
                hi.hospcode,
                MAX(h.hosname) AS hosname,
                MAX(h.distid) AS distid,
                MAX(cd.distname) AS distname,
                MAX(h.hostype) AS hostype,
                MAX(ct.hostypename) AS hostypename,
                hi.year_bh,
                COUNT(*) AS total_indicators,
                SUM(hi.has_recorded) AS recorded_indicators,
                COUNT(*) - SUM(hi.has_recorded) AS missing_indicators,
                CASE WHEN COUNT(*) = 0 THEN 0
                     ELSE ROUND(SUM(hi.has_recorded) / COUNT(*) * 100, 2)
                END AS recording_pct
            FROM hospital_indicators hi
            LEFT JOIN chospital h ON h.hoscode = hi.hospcode
            LEFT JOIN co_district cd ON cd.distid = h.distid
            LEFT JOIN chostype ct ON ct.hostypecode = h.hostype
            GROUP BY hi.hospcode, hi.year_bh
            ORDER BY recording_pct ASC, hi.hospcode
            LIMIT 1000
        `;
        const [rows] = await db.query(sql, params);

        // Summary (overall)
        const totalHospitals = rows.length;
        const fullyRecorded = rows.filter(r => Number(r.recording_pct) >= 100).length;
        const notRecorded = rows.filter(r => Number(r.recording_pct) === 0).length;
        const partiallyRecorded = totalHospitals - fullyRecorded - notRecorded;
        const avgPct = totalHospitals === 0 ? 0 :
            Math.round(rows.reduce((s, r) => s + Number(r.recording_pct || 0), 0) / totalHospitals * 100) / 100;

        res.json({
            success: true,
            summary: {
                total_hospitals: totalHospitals,
                fully_recorded: fullyRecorded,
                partially_recorded: partiallyRecorded,
                not_recorded: notRecorded,
                avg_recording_pct: avgPct
            },
            data: rows
        });
    } catch (error) {
        console.error('Report recording-status/by-hospital error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลสถานะการบันทึก (รายหน่วยบริการ) ได้' });
    }
});

// รายงาน: ตัวชี้วัดที่ค้างบันทึกของหน่วยบริการ (drill-down)
//   ใช้ดูว่า รพ. นั้นค้างตัวชี้วัดไหนบ้าง (สำหรับปุ่ม "ดูรายละเอียด" ในแถว by-hospital)
apiRouter.get('/report/recording-missing/by-hospital/:hospcode', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id } = req.query;
        const { hospcode } = req.params;
        if (!year_bh || !hospcode) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณ + hospcode' });
        }

        let whereClauses = ['r.year_bh = ?', 'r.hospcode = ?', 'i.is_active = 1'];
        let params = [year_bh, hospcode];

        // Role-based scope — ผู้ใช้ที่ไม่ใช่ super_admin/admin_ssj ต้องดูเฉพาะ hospcode ตัวเอง
        if (user.role === 'super_admin') {
            // ผ่าน
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (['admin_hos', 'admin_sso', 'user_hos', 'user_sso'].includes(user.role)) {
            if (user.hospcode && user.hospcode !== hospcode) {
                return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูหน่วยบริการอื่น' });
            }
        } else if (['admin_cup', 'user_cup'].includes(user.role)) {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
            if (user.role === 'user_cup' && user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }

        const whereStr = 'WHERE ' + whereClauses.join(' AND ');

        const sql = `
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                i.criterion,
                i.target_condition,
                i.result_formula,
                mi.main_indicator_name,
                d.dept_name,
                r.target_value,
                MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded
            FROM kpi_results r
            JOIN kpi_indicators i ON i.id = r.indicator_id
            LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
            LEFT JOIN departments d ON d.id = i.dept_id
            ${whereStr}
            GROUP BY i.id, r.target_value
            HAVING has_recorded = 0
            ORDER BY mi.main_indicator_name, i.kpi_indicators_name
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, hospcode, year_bh, data: rows });
    } catch (error) {
        console.error('Report recording-missing/by-hospital error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลตัวชี้วัดที่ค้างบันทึกได้' });
    }
});

// รายงาน: สรุปรายหน่วยงาน (Dept Summary)
//   - แต่ละหน่วยงาน: ตัวชี้วัดทั้งหมด / คีย์แล้ว (มีอย่างน้อย 1 รพ.บันทึก actual) / ยังไม่คีย์
//   - avg_coverage_pct = % รพ.ที่บันทึกเฉลี่ยข้ามทุกตัวชี้วัดของ dept
//   สิทธิ์: super_admin ดูทุก dept, admin_ssj ดูเฉพาะ dept ตัวเอง
apiRouter.get('/report/by-dept-summary', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, hostype } = req.query;
        if (!year_bh) {
            return res.json({ success: true, summary: { total_depts: 0, fully_covered: 0, not_entered: 0, avg_coverage_pct: 0 }, data: [] });
        }

        let cteWhere = ['r.year_bh = ?'];
        let cteParams = [year_bh];
        let deptFilter = '';
        let deptFilterParam = null;

        // Role-based scope
        if (user.role === 'super_admin') {
            // เห็นทุก dept
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { deptFilter = 'AND i.dept_id = ?'; deptFilterParam = user.deptId; }
        } else {
            // role อื่นไม่ควรเห็น dept summary แต่ให้กรองตาม dept ตัวเองไว้
            if (user.deptId != null) { deptFilter = 'AND i.dept_id = ?'; deptFilterParam = user.deptId; }
        }

        let hostypeJoin = '';
        if (hostype) {
            hostypeJoin = 'JOIN chospital ch ON ch.hoscode = r.hospcode';
            cteWhere.push('ch.hostype = ?');
            cteParams.push(hostype);
        }

        const cteWhereStr = cteWhere.join(' AND ');

        // params สำหรับ query หลัก
        const queryParams = [...cteParams];
        if (deptFilterParam != null) queryParams.push(deptFilterParam);

        const sql = `
            WITH ind_stats AS (
                SELECT
                    r.indicator_id,
                    COUNT(DISTINCT r.hospcode) AS total_hosp,
                    COUNT(DISTINCT CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN r.hospcode END) AS recorded_hosp
                FROM kpi_results r
                ${hostypeJoin}
                WHERE ${cteWhereStr}
                GROUP BY r.indicator_id
            )
            SELECT
                d.id AS dept_id,
                d.dept_name,
                COUNT(DISTINCT i.id) AS total_indicators,
                COUNT(DISTINCT CASE WHEN IFNULL(ist.recorded_hosp, 0) > 0 THEN i.id END) AS entered_indicators,
                COUNT(DISTINCT CASE WHEN IFNULL(ist.recorded_hosp, 0) = 0 THEN i.id END) AS not_entered_indicators,
                IFNULL(ROUND(
                    100.0 * SUM(IFNULL(ist.recorded_hosp, 0)) / NULLIF(SUM(IFNULL(ist.total_hosp, 0)), 0)
                , 1), 0) AS avg_coverage_pct
            FROM departments d
            JOIN kpi_indicators i ON i.dept_id = d.id AND i.is_active = 1
            LEFT JOIN ind_stats ist ON ist.indicator_id = i.id
            WHERE 1=1 ${deptFilter}
            GROUP BY d.id, d.dept_name
            ORDER BY d.dept_name
        `;
        const [rows] = await db.query(sql, queryParams);

        const totalDepts = rows.length;
        const fullyCovered = rows.filter(r => Number(r.entered_indicators) === Number(r.total_indicators) && Number(r.total_indicators) > 0).length;
        const notEntered = rows.filter(r => Number(r.entered_indicators) === 0).length;
        const avgPct = totalDepts === 0 ? 0 :
            Math.round(rows.reduce((s, r) => s + Number(r.avg_coverage_pct || 0), 0) / totalDepts * 10) / 10;

        res.json({
            success: true,
            summary: { total_depts: totalDepts, fully_covered: fullyCovered, not_entered: notEntered, avg_coverage_pct: avgPct },
            data: rows
        });
    } catch (error) {
        console.error('Report by-dept-summary error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลสรุปรายหน่วยงานได้' });
    }
});

// รายงาน: drill-down รายชื่อหน่วยบริการของตัวชี้วัด (by-dept-summary/hospitals)
//   - filter=recorded → รพ.ที่มี actual_value แล้ว
//   - filter=missing  → รพ.ที่ยังไม่มี actual_value (แต่มี record ใน kpi_results)
//   - filter ไม่ส่ง   → ทั้งหมด
apiRouter.get('/report/by-dept-summary/hospitals', authenticateToken, async (req, res) => {
    try {
        const { year_bh, indicator_id, filter, hostype } = req.query;
        if (!year_bh || !indicator_id) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณและตัวชี้วัด' });
        }

        let whereClauses = ['r.indicator_id = ?', 'r.year_bh = ?'];
        let params = [indicator_id, year_bh];

        if (hostype) { whereClauses.push('h.hostype = ?'); params.push(hostype); }

        let having = '';
        if (filter === 'recorded') having = 'HAVING has_recorded = 1';
        else if (filter === 'missing') having = 'HAVING has_recorded = 0';

        const sql = `
            SELECT
                r.hospcode,
                MAX(COALESCE(h.hosname, r.hospcode)) AS hosname,
                MAX(h.hostype) AS hostype,
                MAX(ct.hostypename) AS hostypename,
                MAX(cd.distname) AS distname,
                MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded
            FROM kpi_results r
            LEFT JOIN chospital h ON h.hoscode = r.hospcode
            LEFT JOIN co_district cd ON cd.distid = h.distid
            LEFT JOIN chostype ct ON ct.hostypecode = h.hostype
            WHERE ${whereClauses.join(' AND ')}
            GROUP BY r.hospcode
            ${having}
            ORDER BY cd.distname, h.hosname
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-dept-summary/hospitals error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงรายชื่อหน่วยบริการได้' });
    }
});

// รายงาน: drill-down ตัวชี้วัดของหน่วยงาน (by-dept-summary/indicators)
//   - ดูว่าแต่ละตัวชี้วัดใน dept นั้น มีกี่ รพ. คีย์แล้ว / ยังไม่คีย์
apiRouter.get('/report/by-dept-summary/indicators', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, hostype } = req.query;
        if (!year_bh || !dept_id) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณและหน่วยงาน' });
        }

        // Role check: admin_ssj ดูได้เฉพาะ dept ตัวเอง
        if (user.role === 'admin_ssj' && user.deptId != null && String(user.deptId) !== String(dept_id)) {
            return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูหน่วยงานอื่น' });
        }

        let cteWhere = ['r.year_bh = ?'];
        let cteParams = [year_bh];
        let hostypeJoin = '';
        if (hostype) {
            hostypeJoin = 'JOIN chospital ch ON ch.hoscode = r.hospcode';
            cteWhere.push('ch.hostype = ?');
            cteParams.push(hostype);
        }
        const cteWhereStr = cteWhere.join(' AND ');

        const sql = `
            WITH ind_stats AS (
                SELECT
                    r.indicator_id,
                    COUNT(DISTINCT r.hospcode) AS total_hosp,
                    COUNT(DISTINCT CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN r.hospcode END) AS recorded_hosp
                FROM kpi_results r
                ${hostypeJoin}
                WHERE ${cteWhereStr}
                GROUP BY r.indicator_id
            )
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                i.result_formula,
                mi.main_indicator_name,
                IFNULL(ist.total_hosp, 0) AS total_hospitals,
                IFNULL(ist.recorded_hosp, 0) AS recorded_hospitals,
                IFNULL(ist.total_hosp, 0) - IFNULL(ist.recorded_hosp, 0) AS missing_hospitals,
                CASE WHEN IFNULL(ist.total_hosp, 0) = 0 THEN 0
                     ELSE ROUND(IFNULL(ist.recorded_hosp, 0) / ist.total_hosp * 100, 1)
                END AS recording_pct
            FROM kpi_indicators i
            LEFT JOIN ind_stats ist ON ist.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
            WHERE i.dept_id = ? AND i.is_active = 1
            ORDER BY recording_pct DESC, mi.main_indicator_name, i.kpi_indicators_name
        `;
        const queryParams = [...cteParams, dept_id];
        const [rows] = await db.query(sql, queryParams);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-dept-summary/indicators error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลตัวชี้วัดของหน่วยงานได้' });
    }
});

// Migration ตอนเริ่มระบบ (ตารางหลัก + seed สิทธิ์ + SSO audit) — migrations/index.js (แยกจาก server.js 25 ต.ค. 2569 ระยะ 2)
const { migrationsReady } = require('./migrations');

// ========== Auto-create user_ui_prefs (ค่าการแสดงผลส่วนตัวต่อบัญชีผู้ใช้) ==========
ensureUiPrefsTable().catch(err => console.error('⚠️ user_ui_prefs setup error:', err.message));


// ========== Rejection & Notification APIs ==========

// ตีกลับ KPI (admin only) - รองรับทั้งรายการเดียวและหลายรายการ
apiRouter.post('/reject-kpi', authenticateToken, isAdmin, async (req, res) => {
    const user = req.user;
    const items = Array.isArray(req.body) ? req.body : [req.body];

    if (items.length === 0 || !items[0].indicator_id) {
        return res.status(400).json({ success: false, message: 'No rejection data' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        for (const item of items) {
            const { indicator_id, year_bh, hospcode, comment, reject_months } = item;

            if (!comment || !comment.trim()) {
                throw new Error('กรุณาระบุเหตุผลการส่งคืนแก้ไข');
            }

            let whereClause = 'indicator_id = ? AND year_bh = ?';
            let params = [indicator_id, year_bh];

            // ใช้ hospcode จาก request body (ของหน่วยบริการเป้าหมาย) ถ้ามี
            // ถ้าไม่มีและไม่ใช่ super_admin ให้ใช้ hospcode ของ admin เอง
            if (hospcode) {
                whereClause += ' AND hospcode = ?';
                params.push(hospcode);
            } else if (user.role !== 'super_admin') {
                whereClause += ' AND hospcode = ?';
                params.push(user.hospcode);
            }

            // Update status to Rejected and unlock
            await connection.query(
                `UPDATE kpi_results SET status = 'Rejected', is_locked = 0 WHERE ${whereClause}`,
                params
            );
            // Cascade ไปตัวชี้วัดย่อย (ถ้ามี) — hospcode เดียวกับที่ใช้ตัดสินใน whereClause ด้านบน
            const cascadeHospcode = hospcode || (user.role !== 'super_admin' ? user.hospcode : null);
            await cascadeSubResultsStatus(connection, indicator_id, year_bh, cascadeHospcode, 'Rejected', 0);

            // Save rejection comment with reject_months
            const targetHospcode = hospcode || user.hospcode;
            const monthsStr = Array.isArray(reject_months) ? reject_months.join(',') : (reject_months || '');
            await connection.query(
                'INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, reject_months, type, rejected_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [indicator_id, year_bh, targetHospcode, comment.trim(), monthsStr, 'reject', user.userId]
            );

            // Get indicator name for notification
            const [indRows] = await connection.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
            const indName = indRows.length > 0 ? indRows[0].kpi_indicators_name : `ตัวชี้วัด #${indicator_id}`;

            // สร้างชื่อเดือนไทยสำหรับ notification
            const monthNamesTh = { oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.', apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.' };
            const monthsDisplay = monthsStr ? monthsStr.split(',').map(m => monthNamesTh[m.trim()] || m.trim()).join(', ') : '';
            const monthsMsg = monthsDisplay ? ` เดือนที่ต้องแก้ไข: ${monthsDisplay}` : '';

            // Create notification for the hospcode owner
            await connection.query(
                'INSERT INTO notifications (hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [targetHospcode, 'reject', 'ตัวชี้วัดถูกส่งคืนแก้ไข', `"${indName}" ปีงบ ${year_bh} ถูกส่งคืนแก้ไข${monthsMsg} เหตุผล: ${comment.trim()}`, indicator_id, year_bh, user.userId]
            );
        }

        // Log action
        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'REJECT', 'kpi_results', JSON.stringify({ count: items.length, message: `ส่งคืนแก้ไข ${items.length} รายการ` }), req.ip]
        );

        await connection.commit();
        scheduleSummaryRefresh(items); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: `ส่งคืนแก้ไขเรียบร้อยแล้ว ${items.length} รายการ` });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// ดึงรายการแจ้งเตือนของผู้ใช้
apiRouter.get('/notifications', authenticateToken, async (req, res) => {
    const user = req.user;
    try {
        const [rows] = await db.query(
            `SELECT n.*, u.firstname AS created_by_name, u.lastname AS created_by_lastname,
                    (SELECT COUNT(*) FROM kpi_rejection_comments rc
                     WHERE rc.indicator_id = n.indicator_id AND rc.year_bh = n.year_bh
                     AND rc.hospcode = n.hospcode AND rc.type = 'reply'
                     AND rc.created_at > n.created_at) AS has_reply,
                    (SELECT r.status FROM kpi_results r
                     WHERE r.indicator_id = n.indicator_id AND r.year_bh = n.year_bh
                     AND r.hospcode = n.hospcode ORDER BY r.month_bh LIMIT 1) AS kpi_status
             FROM notifications n
             LEFT JOIN users u ON n.created_by = u.id
             WHERE n.user_id = ? OR n.hospcode = ? OR (n.user_id IS NULL AND n.hospcode IS NULL)
             ORDER BY n.created_at DESC LIMIT 50`,
            [user.userId, user.hospcode]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// นับจำนวนแจ้งเตือนที่ยังไม่อ่าน
apiRouter.get('/notifications/unread-count', authenticateToken, async (req, res) => {
    const user = req.user;
    try {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS count FROM notifications
             WHERE is_read = 0 AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
            [user.userId, user.hospcode]
        );
        res.json({ success: true, count: rows[0].count });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Mark notifications as read
apiRouter.post('/notifications/mark-read', authenticateToken, async (req, res) => {
    const user = req.user;
    const { ids, all } = req.body;
    try {
        // ดึง rejection notifications ที่ยังไม่อ่าน ก่อน mark as read
        let rejNotifs = [];
        if (all) {
            const [rows] = await db.query(
                `SELECT indicator_id, year_bh, hospcode FROM notifications
                 WHERE type = 'reject' AND is_read = 0 AND indicator_id IS NOT NULL
                 AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
                [user.userId, user.hospcode]
            );
            rejNotifs = rows;
            await db.query(
                `UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
                [user.userId, user.hospcode]
            );
        } else if (ids && Array.isArray(ids) && ids.length > 0) {
            const [rows] = await db.query(
                `SELECT indicator_id, year_bh, hospcode FROM notifications
                 WHERE id IN (?) AND type = 'reject' AND is_read = 0 AND indicator_id IS NOT NULL`,
                [ids]
            );
            rejNotifs = rows;
            await db.query(
                `UPDATE notifications SET is_read = 1 WHERE id IN (?) AND (user_id = ? OR hospcode = ? OR (user_id IS NULL AND hospcode IS NULL))`,
                [ids, user.userId, user.hospcode]
            );
        }

        // เมื่ออ่านแจ้งเตือนตีกลับแล้ว → เปลี่ยนสถานะจาก Rejected เป็น Resubmit
        for (const n of rejNotifs) {
            if (n.indicator_id && n.year_bh && n.hospcode) {
                await db.query(
                    `UPDATE kpi_results SET status = 'Resubmit' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status = 'Rejected'`,
                    [n.indicator_id, n.year_bh, n.hospcode]
                );
            }
        }

        scheduleSummaryRefresh(rejNotifs); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'อ่านแจ้งเตือนเรียบร้อยแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ดึงประวัติเหตุผลการตีกลับ + การตอบกลับ
apiRouter.get('/rejection-comments/:indicator_id/:year_bh/:hospcode', authenticateToken, async (req, res) => {
    const { indicator_id, year_bh, hospcode } = req.params;
    try {
        const [rows] = await db.query(
            `SELECT rc.*,
                    COALESCE(u1.firstname, u2.firstname) AS firstname,
                    COALESCE(u1.lastname, u2.lastname) AS lastname
             FROM kpi_rejection_comments rc
             LEFT JOIN users u1 ON rc.rejected_by = u1.id
             LEFT JOIN users u2 ON rc.replied_by = u2.id
             WHERE rc.indicator_id = ? AND rc.year_bh = ? AND rc.hospcode = ?
             ORDER BY rc.created_at DESC`,
            [indicator_id, year_bh, hospcode]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ตอบกลับการตีกลับ KPI (หน่วยบริการ)
apiRouter.post('/reply-kpi', authenticateToken, async (req, res) => {
    const user = req.user;
    const { indicator_id, year_bh, hospcode, message } = req.body;

    if (!indicator_id || !year_bh) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุข้อมูลให้ครบถ้วน' });
    }

    // ถ้าไม่มีข้อความตอบกลับ ใช้ข้อความเริ่มต้น
    const replyMessage = (message && message.trim()) ? message.trim() : 'แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว';

    const targetHospcode = hospcode || user.hospcode;
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // บันทึกข้อความตอบกลับ
        await connection.query(
            'INSERT INTO kpi_rejection_comments (indicator_id, year_bh, hospcode, comment, type, replied_by) VALUES (?, ?, ?, ?, ?, ?)',
            [indicator_id, year_bh, targetHospcode, replyMessage, 'reply', user.userId]
        );

        // เปลี่ยนสถานะกลับเป็น Pending เพื่อให้ admin ตรวจสอบใหม่
        await connection.query(
            `UPDATE kpi_results SET status = 'Pending' WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND status = 'Resubmit'`,
            [indicator_id, year_bh, targetHospcode]
        );

        // Get indicator name for notification
        const [indRows] = await connection.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        const indName = indRows.length > 0 ? indRows[0].kpi_indicators_name : `ตัวชี้วัด #${indicator_id}`;

        // Get hospital name
        const [hosRows] = await connection.query('SELECT hosname FROM chospital WHERE hoscode = ?', [targetHospcode]);
        const hosName = hosRows.length > 0 ? hosRows[0].hosname : targetHospcode;

        // หา admin ที่เคย reject ตัวชี้วัดนี้ (ไม่ซ้ำ)
        const [rejecters] = await connection.query(
            `SELECT DISTINCT rejected_by FROM kpi_rejection_comments
             WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND type = 'reject' AND rejected_by IS NOT NULL`,
            [indicator_id, year_bh, targetHospcode]
        );
        const rejecterIds = rejecters.map(r => r.rejected_by);

        // ถ้าไม่เจอ admin ที่ reject → ส่งให้ super_admin ทุกคน
        let targetAdminIds = rejecterIds;
        if (targetAdminIds.length === 0) {
            const [superAdmins] = await connection.query("SELECT id FROM users WHERE role = 'super_admin'");
            targetAdminIds = superAdmins.map(a => a.id);
        }

        // สร้าง notification เฉพาะ admin ที่เกี่ยวข้อง (ไม่ซ้ำ)
        const uniqueAdminIds = [...new Set(targetAdminIds)];
        for (const adminId of uniqueAdminIds) {
            await connection.query(
                'INSERT INTO notifications (user_id, hospcode, type, title, message, indicator_id, year_bh, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [adminId, targetHospcode, 'info', 'หน่วยบริการตอบกลับการตีกลับ',
                 `${hosName} ตอบกลับตัวชี้วัด "${indName}" ปีงบ ${year_bh}: ${replyMessage}`,
                 indicator_id, year_bh, user.userId]
            );
        }

        // Log action
        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'REPLY', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode: targetHospcode, message: replyMessage }), req.ip]
        );

        await connection.commit();
        scheduleSummaryRefresh([{ indicator_id, year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: 'ส่งตอบกลับเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: error.message });
    } finally {
        connection.release();
    }
});

// ดึงรายการตอบกลับทั้งหมด (สำหรับ admin/user)
apiRouter.get('/kpi-replies', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let whereClause = "WHERE rc.type = 'reply'";
        let params = [];

        // super_admin: เห็นทั้งหมด
        // admin: เฉพาะหน่วยงานตัวเอง (ทุก hospcode)
        // user: เฉพาะ hospcode + dept ของตัวเอง
        if (user.role === 'super_admin') {
            // ไม่มี filter เพิ่ม
        } else if (user.role === 'admin_ssj') {
            if (user.deptId !== null && user.deptId !== undefined) {
                whereClause += ' AND i.dept_id = ?';
                params.push(user.deptId);
            }
        } else {
            if (user.hospcode) {
                whereClause += ' AND rc.hospcode = ?';
                params.push(user.hospcode);
            }
            if (user.deptId !== null && user.deptId !== undefined) {
                whereClause += ' AND i.dept_id = ?';
                params.push(user.deptId);
            }
        }

        const [rows] = await db.query(`
            SELECT rc.id, rc.indicator_id, rc.year_bh, rc.hospcode, rc.comment, rc.created_at,
                   i.kpi_indicators_name, d.dept_name,
                   h.hosname,
                   u.firstname AS replied_firstname, u.lastname AS replied_lastname,
                   (SELECT rc2.comment FROM kpi_rejection_comments rc2
                    WHERE rc2.indicator_id = rc.indicator_id AND rc2.year_bh = rc.year_bh
                    AND rc2.hospcode = rc.hospcode AND rc2.type = 'reject'
                    AND rc2.created_at < rc.created_at
                    ORDER BY rc2.created_at DESC LIMIT 1) AS original_reject_comment
            FROM kpi_rejection_comments rc
            LEFT JOIN kpi_indicators i ON rc.indicator_id = i.id
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN chospital h ON rc.hospcode = h.hoscode
            LEFT JOIN users u ON rc.replied_by = u.id
            ${whereClause}
            ORDER BY rc.created_at DESC
            LIMIT 100
        `, params);

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('KPI Replies Error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลตอบกลับได้' });
    }
});

// === Test Telegram (super_admin) ===
// ============================================================
// === Structure Compare: Local DB vs Remote KHD DB ===
// ============================================================

// GET /report-compare — เปรียบเทียบ reports (KHD) กับ kpi_indicators (Local) โดยใช้ table_process เป็น key
apiRouter.get('/report-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        // ปีงบประมาณที่ใช้เทียบเกณฑ์ — จาก query param หรือ default ปีงบปัจจุบัน (ต.ค. ขึ้นปีใหม่)
        const today = new Date();
        let fyYear = today.getFullYear();
        if (today.getMonth() >= 9) fyYear += 1;
        const currentFY = (fyYear + 543).toString();
        const year_bh = req.query.year_bh ? String(req.query.year_bh) : currentFY;

        // ดึง reports จาก KHD
        const [khdRows] = await remoteDb.query(`
            SELECT *
            FROM reports
            WHERE data_source = 'excel'
            AND LENGTH(report_code) = LENGTH(table_process)
            ORDER BY report_id
        `);
        // ดึง override เกณฑ์รายปีงบจาก report_fiscal_year_config (เฉพาะปีที่กำลังเทียบ)
        const [fyRows] = await remoteDb.query(
            `SELECT report_id, fiscal_year, target_percentage, target_condition, is_active
             FROM report_fiscal_year_config WHERE fiscal_year = ?`,
            [year_bh]
        );
        const fyConfigMap = new Map();
        fyRows.forEach(r => fyConfigMap.set(r.report_id, r));

        // ดึง kpi_indicators จาก Local (เพิ่ม dept_id, main_indicator_id, upload_excel, เกณฑ์ + data_source/khd_report_id เพื่อ frontend)
        const [localRows] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process, i.kpi_indicators_code, i.is_active,
                   i.dept_id, i.main_indicator_id, i.upload_excel,
                   i.criterion, i.target_condition, i.data_source, i.khd_report_id,
                   d.dept_name, mi.main_indicator_name
            FROM kpi_indicators i
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            ORDER BY i.id
        `);
        const khdResolver = await loadKhdResolver(db); // จับคู่หน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ของแถวที่ยังไม่มีใน Local
        // สร้าง map โดยใช้ table_process เป็น key
        const khdMap = new Map();
        khdRows.forEach(r => { if (r.table_process) khdMap.set(r.table_process, r); });
        const localMap = new Map();
        localRows.forEach(r => { if (r.table_process) localMap.set(r.table_process, r); });

        const items = [];
        let match = 0, different = 0, missing_local = 0, missing_remote = 0, criteria_different = 0;
        let khd_inactive_count = 0, suggest_disable_count = 0;

        // Helper: ถ้า KHD report inactive (=0) แต่ Local ยัง upload_excel=0 → suggest = ปิด upload_excel
        const computeSuggest = (khdIsActive, localUploadExcel) => {
            const inactive = khdIsActive === 0 || khdIsActive === '0';
            const stillAutoExport = !localUploadExcel || localUploadExcel === 0;
            return inactive && stillAutoExport;
        };

        // Helper: ค่าเกณฑ์ที่ใช้จริง — ใช้ report_fiscal_year_config (ปีที่กำลังเทียบ) ถ้ามี ไม่งั้น fallback ไปที่ reports (base value)
        const getEffectiveKhdCriteria = (khd, fyConfig) => {
            if (fyConfig && fyConfig.target_percentage != null) {
                return { target_percentage: fyConfig.target_percentage, target_condition: fyConfig.target_condition, source: 'fiscal_year_config' };
            }
            return { target_percentage: khd.target_percentage, target_condition: khd.target_condition, source: 'reports' };
        };

        // เทียบจาก KHD
        for (const khd of khdRows) {
            const tp = khd.table_process;
            const local = tp ? localMap.get(tp) : null;
            const fyConfig = fyConfigMap.get(khd.report_id) || null;
            const effective = getEffectiveKhdCriteria(khd, fyConfig);
            // effectiveIsActive: ใช้ report_fiscal_year_config.is_active ของปีงบที่กำลังเทียบก่อนเสมอ (ถ้ามี override
            // ปีนั้น) ไม่งั้น fallback ไปที่ reports.is_active (ค่าทั่วไป ไม่ผูกปี) — เดิมโค้ดใช้ khd.is_active (reports)
            // ตรงๆ ทุกจุด ทำให้ badge "HDC inactive"/คำแนะนำปิด upload_excel ผิดพลาดเมื่อ 2 ค่านี้ไม่ตรงกัน (ยืนยันจริงว่า
            // มีเคสแบบนี้อยู่จริงบน remote — ไม่ใช่แค่ทฤษฎี)
            const effectiveIsActive = (fyConfig && fyConfig.is_active != null) ? fyConfig.is_active : khd.is_active;
            if (!local) {
                items.push({
                    status: 'missing_local',
                    khd_report_id: khd.report_id, khd_name: khd.report_name, khd_dept: khd.dept, khd_main_yut: khd.main_yut,
                    khd_main_indicator: khd.main_indicator || null,
                    khd_resolved: khdResolver.resolveIndicator(khd),
                    report_code: khd.report_code, table_process: tp, khd_is_active: effectiveIsActive,
                    khd_data_source: khd.data_source,
                    khd_target_percentage: effective.target_percentage, khd_target_condition: effective.target_condition,
                    khd_criteria_source: effective.source, khd_fiscal_year: fyConfig ? year_bh : null,
                    local_id: null, local_name: null,
                    local_dept_id: null, local_main_indicator_id: null, local_is_active: null,
                    local_upload_excel: null,
                    local_criterion: null, local_target_condition: null, local_data_source: null,
                    criteria_match: null,
                    suggest_disable_upload: false
                });
                if (effectiveIsActive === 0 || effectiveIsActive === '0') khd_inactive_count++;
                missing_local++;
            } else {
                const nameMatch = (khd.report_name || '').trim() === (local.kpi_indicators_name || '').trim();
                const status = nameMatch ? 'match' : 'different';
                if (status === 'match') match++; else different++;

                // criteria_match: เทียบ criterion (numeric-aware) + target_condition — local.criterion คือ "เกณฑ์" จริง (แยกจาก target_percentage/เป้าหมาย แล้ว)
                const pctMatch = Number(effective.target_percentage) === Number(local.criterion)
                    || (effective.target_percentage == null && local.criterion == null);
                const condMatch = String(effective.target_condition || '') === String(local.target_condition || '');
                const criteria_match = pctMatch && condMatch;
                if (!criteria_match) criteria_different++;

                const suggest = computeSuggest(effectiveIsActive, local.upload_excel);
                if (suggest) suggest_disable_count++;
                if (effectiveIsActive === 0 || effectiveIsActive === '0') khd_inactive_count++;
                items.push({
                    status,
                    khd_report_id: khd.report_id, khd_name: khd.report_name, khd_dept: khd.dept, khd_main_yut: khd.main_yut,
                    report_code: khd.report_code, table_process: tp, khd_is_active: effectiveIsActive,
                    khd_data_source: khd.data_source,
                    khd_target_percentage: effective.target_percentage, khd_target_condition: effective.target_condition,
                    khd_criteria_source: effective.source, khd_fiscal_year: fyConfig ? year_bh : null,
                    local_id: local.id, local_name: local.kpi_indicators_name, local_dept: local.dept_name,
                    local_dept_id: local.dept_id, local_main_indicator_id: local.main_indicator_id, local_is_active: local.is_active,
                    local_upload_excel: local.upload_excel || 0,
                    local_criterion: local.criterion, local_target_condition: local.target_condition,
                    local_data_source: local.data_source,
                    criteria_match,
                    suggest_disable_upload: suggest
                });
            }
        }
        // เทียบจาก Local ที่ไม่มีใน KHD
        for (const local of localRows) {
            if (local.table_process && !khdMap.has(local.table_process)) {
                items.push({
                    status: 'missing_remote',
                    khd_report_id: null, khd_name: null, khd_dept: null, khd_main_yut: null,
                    report_code: null, table_process: local.table_process, khd_is_active: null,
                    khd_data_source: null, khd_target_percentage: null, khd_target_condition: null,
                    khd_criteria_source: null, khd_fiscal_year: null,
                    local_id: local.id, local_name: local.kpi_indicators_name, local_dept: local.dept_name,
                    local_dept_id: local.dept_id, local_main_indicator_id: local.main_indicator_id, local_is_active: local.is_active,
                    local_upload_excel: local.upload_excel || 0,
                    local_criterion: local.criterion, local_target_condition: local.target_condition,
                    local_data_source: local.data_source,
                    criteria_match: null,
                    suggest_disable_upload: false
                });
                missing_remote++;
            }
        }
        res.json({
            success: true,
            khd_count: khdRows.length, local_count: localRows.length,
            summary: {
                total: items.length, match, different, missing_local, missing_remote,
                khd_inactive: khd_inactive_count, suggest_disable: suggest_disable_count,
                criteria_different, year_bh
            },
            items
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /indicators/:id/upload-excel — toggle upload_excel (0=auto export, 1=skip)
apiRouter.put('/indicators/:id/upload-excel', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const v = req.body?.upload_excel;
        const val = (v === 1 || v === '1' || v === true) ? 1 : 0;
        const [r] = await db.query('UPDATE kpi_indicators SET upload_excel = ? WHERE id = ?', [val, id]);
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัด' });
        // LINE notify
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `🔁 เปลี่ยน upload_excel\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${id}\n` +
                `📋 ${val ? '1 = ข้าม export (ลง Excel เอง)' : '0 = ส่งออกอัตโนมัติ'}`
            );
        } catch (_) {}
        res.json({ success: true, id, upload_excel: val, message: val ? 'ตั้งเป็น "ไม่ส่งออกอัตโนมัติ" แล้ว' : 'ตั้งเป็น "ส่งออกอัตโนมัติได้" แล้ว' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/bulk-upload-excel — set upload_excel แบบ batch (ใช้ตอน "ปิดทั้งหมดที่ KHD inactive")
// POST /indicators/apply-khd-criteria — ปรับ "เกณฑ์" (criterion + target_condition) ของตัวชี้วัดให้เท่ากับ KHD (19 ต.ค. 2569)
// body { ids: number[], year_bh } — อ่านเกณฑ์จาก KHD ใหม่ที่ฝั่ง server เสมอ (ไม่เชื่อค่าจาก client) ด้วยการจับคู่เดียวกับ GET /report-compare
// (table_process, data_source='excel', LENGTH(report_code)=LENGTH(table_process), report_id มากสุดชนะ) และเกณฑ์ของปีงบที่เลือก
// (report_fiscal_year_config ก่อน แล้วจึง reports) — ไม่แตะ "เป้าหมาย" (target_percentage) และข้ามตัวที่ KHD ไม่มีเกณฑ์ (ไม่ล้างค่าเดิม)
apiRouter.post('/indicators/apply-khd-criteria', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    const now = new Date();
    const yearBh = req.body?.year_bh ? String(req.body.year_bh) : String(now.getFullYear() + 543 + (now.getMonth() >= 9 ? 1 : 0)); // ปีงบปัจจุบัน (ต.ค. ขึ้นปีใหม่)
    const fmt = (v) => (v === null || v === undefined || String(v).trim() === '') ? null
        : (Number.isFinite(Number(v)) ? String(Number(v)) : String(v).trim());
    try {
        const [locals] = await db.query('SELECT id, kpi_indicators_name, table_process, criterion, target_condition FROM kpi_indicators WHERE id IN (?)', [ids]);
        const tps = [...new Set(locals.map(l => String(l.table_process || '').trim()).filter(Boolean))];
        const khdByTp = new Map();
        if (tps.length) {
            const [khdRows] = await remoteDb.query(
                `SELECT report_id, table_process, target_percentage, target_condition FROM reports
                 WHERE data_source = 'excel' AND LENGTH(report_code) = LENGTH(table_process) AND table_process IN (?) ORDER BY report_id`, [tps]);
            khdRows.forEach(r => khdByTp.set(String(r.table_process).trim(), r));
        }
        const updated = [], skipped = [];
        for (const l of locals) {
            const khd = khdByTp.get(String(l.table_process || '').trim());
            if (!khd) { skipped.push({ id: l.id, reason: 'ไม่พบใน KHD' }); continue; }
            const eff = await getKhdEffectiveCriteriaFor(remoteDb, khd.report_id, khd.target_percentage, khd.target_condition, yearBh);
            const criterion = fmt(eff.target_percentage);
            const cond = eff.target_condition ? String(eff.target_condition) : null;
            if (criterion === null) { skipped.push({ id: l.id, reason: 'KHD ไม่มีเกณฑ์' }); continue; }
            if (fmt(l.criterion) === criterion && String(l.target_condition || '') === String(cond || '')) { skipped.push({ id: l.id, reason: 'ตรงกันอยู่แล้ว' }); continue; }
            await db.query('UPDATE kpi_indicators SET criterion = ?, target_condition = ? WHERE id = ?', [criterion, cond, l.id]);
            updated.push({ id: l.id, name: l.kpi_indicators_name, before: { criterion: l.criterion, target_condition: l.target_condition }, after: { criterion, target_condition: cond } });
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'APPLY_KHD_CRITERIA', 'kpi_indicators', JSON.stringify({ year_bh: yearBh, updated, skipped }).slice(0, 60000), req.ip]);
        res.json({ success: true, message: `ปรับเกณฑ์ให้เท่ากับ KHD ${updated.length} ตัวชี้วัด` + (skipped.length ? ` (ข้าม ${skipped.length})` : ''), updated, skipped, year_bh: yearBh });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.post('/indicators/bulk-upload-excel', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => Number(x)).filter(Number.isFinite) : [];
        const v = req.body?.upload_excel;
        const val = (v === 1 || v === '1' || v === true) ? 1 : 0;
        if (ids.length === 0) return res.status(400).json({ success: false, message: 'ต้องระบุ ids' });
        const placeholders = ids.map(() => '?').join(',');
        const [r] = await db.query(`UPDATE kpi_indicators SET upload_excel = ? WHERE id IN (${placeholders})`, [val, ...ids]);
        // LINE notify
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `📦 Bulk เปลี่ยน upload_excel\n` +
                `👤 ${actor}\n` +
                `🔢 จำนวน: ${r.affectedRows} ตัวชี้วัด\n` +
                `📋 → ${val ? '1 = ข้าม export' : '0 = ส่งออกอัตโนมัติ'}`
            );
        } catch (_) {}
        res.json({ success: true, affected: r.affectedRows, upload_excel: val });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /report-compare/sync — Sync reports จาก KHD เข้า kpi_indicators (Local)
apiRouter.post('/report-compare/sync', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { khd_report_ids } = req.body;
    if (!Array.isArray(khd_report_ids) || khd_report_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกรายการที่ต้องการ Sync' });
    }
    try {
        const [khdRows] = await remoteDb.query(
            `SELECT report_id, report_name, dept, main_yut, report_code, table_process, data_source FROM reports WHERE report_id IN (?)`,
            [khd_report_ids]
        );
        let inserted = 0, updated = 0, skipped = 0;
        for (const khd of khdRows) {
            if (!khd.table_process) { skipped++; continue; }
            // ตรวจสอบว่ามีอยู่แล้วหรือไม่ (โดย table_process)
            const [existing] = await db.query('SELECT id, kpi_indicators_name FROM kpi_indicators WHERE table_process = ?', [khd.table_process]);
            if (existing.length > 0) {
                // อัปเดตชื่อ + report_code + data_source + khd_report_id (ไม่แตะ target_percentage/target_condition — local อาจตั้งค่าเองไว้)
                await db.query(
                    'UPDATE kpi_indicators SET kpi_indicators_name = ?, kpi_indicators_code = ?, data_source = ?, khd_report_id = ? WHERE table_process = ?',
                    [khd.report_name, khd.report_code || null, khd.data_source || null, khd.report_id, khd.table_process]
                );
                updated++;
            } else {
                // สร้างใหม่
                await db.query(
                    'INSERT INTO kpi_indicators (kpi_indicators_name, table_process, kpi_indicators_code, data_source, khd_report_id) VALUES (?, ?, ?, ?, ?)',
                    [khd.report_name, khd.table_process, khd.report_code || null, khd.data_source || null, khd.report_id]
                );
                inserted++;
            }
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'SYNC_REPORTS', 'kpi_indicators',
             JSON.stringify({ khd_ids: khd_report_ids, inserted, updated, skipped }), req.ip]
        );
        res.json({ success: true, message: `Sync สำเร็จ — เพิ่มใหม่ ${inserted} รายการ, อัปเดตชื่อ ${updated} รายการ${skipped > 0 ? ', ข้าม ' + skipped + ' รายการ' : ''}`, inserted, updated, skipped });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


const KHD_REPORT_ADD_COLS = 'report_id, report_name, report_code, table_process, data_source, target_percentage, target_condition, dept, main_yut, main_indicator';

apiRouter.post('/report-compare/add-from-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { khd_report_id, dept_id, main_indicator_id, year_bh } = req.body;
    if (!khd_report_id) return res.status(400).json({ success: false, message: 'กรุณาระบุ khd_report_id' });
    try {
        const [khdRows] = await remoteDb.query(`SELECT ${KHD_REPORT_ADD_COLS} FROM reports WHERE report_id = ?`, [khd_report_id]);
        if (!khdRows.length) return res.status(404).json({ success: false, message: 'ไม่พบรายการนี้ใน KHD' });
        const khd = khdRows[0];
        if (!khd.table_process) return res.status(400).json({ success: false, message: 'รายการ KHD นี้ไม่มี table_process' });
        const [existing] = await db.query('SELECT id FROM kpi_indicators WHERE table_process = ?', [khd.table_process]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มีตัวชี้วัดนี้ในระบบแล้ว (table_process ซ้ำ)' });
        const resolver = await loadKhdResolver(db);
        const { id, resolved } = await insertIndicatorFromKhd(remoteDb, resolver, khd, { dept_id, main_indicator_id }, year_bh);
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'kpi_indicators', id,
             JSON.stringify({ khd_report_id, table_process: khd.table_process, dept_id: resolved.dept_id, main_indicator_id: resolved.main_indicator_id, main_yut: resolved.main_yut, unmatched: resolved.unmatched, year_bh: year_bh || null }), req.ip]
        );
        res.json({ success: true, message: `เพิ่ม "${khd.report_name}" เข้าระบบเรียบร้อย`, id, resolved });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /report-compare/bulk-add-from-khd — เพิ่มตัวชี้วัดจาก KHD หลายตัวพร้อมกัน (checkbox เลือกจากตาราง "ยังไม่มีในระบบ")
// dept_id/main_indicator_id/year_bh ใช้ค่าเดียวกันกับทุกตัวที่เลือก (แก้แยกทีละตัวได้ภายหลังเหมือนเดิม)
apiRouter.post('/report-compare/bulk-add-from-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { khd_report_ids, dept_id, main_indicator_id, year_bh } = req.body;
    if (!Array.isArray(khd_report_ids) || khd_report_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัดที่ต้องการเพิ่มอย่างน้อย 1 รายการ' });
    }
    try {
        const [khdRows] = await remoteDb.query(`SELECT ${KHD_REPORT_ADD_COLS} FROM reports WHERE report_id IN (?)`, [khd_report_ids]);
        const resolver = await loadKhdResolver(db);
        let inserted = 0, skipped = 0;
        const skippedNames = [];
        const unmatchedNames = [];   // เพิ่มแล้ว แต่ค่าบางช่องใน KHD ยังจับคู่ไม่ได้ (ช่องนั้นใช้ค่าที่เลือกในหน้าต่าง/ว่าง)
        for (const khd of khdRows) {
            if (!khd.table_process) { skipped++; skippedNames.push(khd.report_name + ' (ไม่มี table_process)'); continue; }
            const [existing] = await db.query('SELECT id FROM kpi_indicators WHERE table_process = ?', [khd.table_process]);
            if (existing.length) { skipped++; skippedNames.push(khd.report_name + ' (มีอยู่แล้ว)'); continue; }
            const { resolved } = await insertIndicatorFromKhd(remoteDb, resolver, khd, { dept_id, main_indicator_id }, year_bh);
            if (resolved.unmatched.length) unmatchedNames.push(khd.report_name);
            inserted++;
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'BULK_ADD_FROM_KHD', 'kpi_indicators',
             JSON.stringify({ requested: khd_report_ids.length, inserted, skipped, dept_id: dept_id || null, main_indicator_id: main_indicator_id || null, year_bh: year_bh || null }), req.ip]
        );
        res.json({
            success: true,
            message: `เพิ่มสำเร็จ ${inserted} รายการ${skipped > 0 ? `, ข้าม ${skipped} รายการ` : ''}`,
            inserted, skipped, skippedNames, unmatchedNames
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /report-compare/sync-khd-link — Backfill ถาวร: link kpi_indicators.khd_report_id + data_source + khd_fiscal_year จาก KHD
// (ทั้ง hdc และ excel ไม่กรองเหมือน /report-compare หลัก เพราะต้องการ data_source จริงของทุกตัวชี้วัด ไม่ใช่แค่ตัวที่จะ sync เข้าระบบ)
// ใช้ heuristic เดียวกับ /report-compare (LENGTH(report_code)=LENGTH(table_process)) กันคู่ table_process ซ้ำที่ report_code สั้นกว่าปกติ (ข้อมูลคุณภาพต่ำใน KHD)
// เรียงตาม report_id ASC แล้วให้ตัวหลังทับตัวก่อนใน map — เมื่อ table_process ชนกันหลายตัว (พบจริง 12/172 แถว เป็น "พี่น้อง" conceptually ใกล้กันแต่ report_id ต่างกัน)
// จะได้ report_id ล่าสุด/มากสุด ซึ่งไม่กระทบความถูกต้องของ badge (data_source ของคู่ที่ชนกันเป็น 'excel' เหมือนกันทุกคู่จากการตรวจสอบจริง)
// khd_fiscal_year เก็บเป็น comma-list ของทุกปีงบที่พบใน report_fiscal_year_config ของ report_id นั้น (ไม่กรอง is_active — แค่บอกว่า
// KHD เคย/กำลังกำหนดค่าปีงบนี้ไว้ให้ตัวชี้วัดนี้ ใช้สำหรับ filter+badge ปีงบประมาณ ไม่ใช่สถานะ active/inactive ซึ่งมี badge แยกอยู่แล้ว)
apiRouter.post('/report-compare/sync-khd-link', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [khdRows] = await remoteDb.query(`
            SELECT report_id, table_process, data_source
            FROM reports
            WHERE table_process IS NOT NULL AND table_process != ''
            AND LENGTH(report_code) = LENGTH(table_process)
            ORDER BY report_id
        `);
        const khdMap = new Map();
        khdRows.forEach(r => { khdMap.set(r.table_process.trim(), r); });

        const [fyRows] = await remoteDb.query(`SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config ORDER BY report_id, fiscal_year`);
        const fyMap = new Map(); // report_id -> "2569,2570"
        fyRows.forEach(r => {
            const list = fyMap.get(r.report_id) || [];
            list.push(String(r.fiscal_year));
            fyMap.set(r.report_id, list);
        });

        const [localRows] = await db.query('SELECT id, table_process FROM kpi_indicators');
        let matched = 0, localOnly = 0, withFiscalYear = 0;
        const dsCounts = {};
        for (const local of localRows) {
            const key = local.table_process ? local.table_process.trim() : '';
            const khd = key ? khdMap.get(key) : null;
            if (khd) {
                const fyList = fyMap.get(khd.report_id) || null;
                const khdFiscalYear = fyList ? fyList.join(',') : null;
                if (khdFiscalYear) withFiscalYear++;
                await db.query('UPDATE kpi_indicators SET khd_report_id = ?, data_source = ?, khd_fiscal_year = ? WHERE id = ?', [khd.report_id, khd.data_source, khdFiscalYear, local.id]);
                matched++;
                dsCounts[khd.data_source] = (dsCounts[khd.data_source] || 0) + 1;
            } else {
                // ไม่พบเทียบเคียง — reset ให้ตรงความจริง (local-only) กันค่าเก่าค้างจาก sync ครั้งก่อนที่ table_process เปลี่ยนไปแล้ว
                await db.query('UPDATE kpi_indicators SET khd_report_id = NULL, data_source = NULL, khd_fiscal_year = NULL WHERE id = ?', [local.id]);
                localOnly++;
            }
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'SYNC_KHD_LINK', 'kpi_indicators', JSON.stringify({ matched, localOnly, withFiscalYear, dsCounts }), req.ip]
        );
        res.json({ success: true, message: `เชื่อมโยง KHD สำเร็จ — จับคู่ได้ ${matched} ตัวชี้วัด (key_in ${dsCounts.excel || 0}, hdc ${dsCounts.hdc || 0}, มีปีงบ ${withFiscalYear} ตัว), local-only ${localOnly} ตัวชี้วัด`, matched, localOnly, withFiscalYear, dsCounts });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== จับคู่ข้อมูล KHD ↔ Local (หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์) — 19 ต.ค. 2569 ==========
// GET /khd-mappings?kind=dept|main|yut — ค่าที่พบใน KHD reports (data_source='excel') + ผลการจับคู่ปัจจุบัน + รายการของ Local ให้เลือก
const KHD_MAP_COLUMN = { dept: 'dept', main: 'main_indicator', yut: 'main_yut' };
apiRouter.get('/khd-mappings', authenticateToken, isSuperAdmin, async (req, res) => {
    const kind = String(req.query.kind || '');
    if (!khdMapping.KHD_MAP_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'kind ต้องเป็น dept, main หรือ yut' });
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const col = KHD_MAP_COLUMN[kind];
        const [khdRows] = await remoteDb.query(
            `SELECT ${col} AS v, table_process FROM reports
             WHERE data_source = 'excel' AND ${col} IS NOT NULL AND TRIM(${col}) <> ''`
        );
        // ชื่อเต็มของรหัสหน่วยงานจากตาราง departments ของ KHD (ช่วยตัดสินใจ — ไม่บังคับมี)
        let khdLabels = new Map();
        if (kind === 'dept') {
            try {
                const [d] = await remoteDb.query('SELECT dept_code, dept_name FROM departments');
                khdLabels = new Map(d.map(r => [khdMapping.normKhd(r.dept_code), r.dept_name]));
            } catch (_) { /* KHD ไม่มีตาราง departments */ }
        }
        const [localTp] = await db.query("SELECT table_process FROM kpi_indicators WHERE table_process IS NOT NULL AND table_process <> ''");
        const tpSet = new Set(localTp.map(r => String(r.table_process).trim()));
        const groups = new Map();   // normKhd(ค่า) → { khd_value, report_count, missing_count }
        for (const r of khdRows) {
            const n = khdMapping.normKhd(r.v);
            if (!n) continue;
            if (!groups.has(n)) groups.set(n, { khd_value: String(r.v).replace(/[\s\u200b\u00a0]+/g, ' ').trim(), report_count: 0, missing_count: 0 });
            const g = groups.get(n);
            g.report_count++;
            if (r.table_process && !tpSet.has(String(r.table_process).trim())) g.missing_count++;
        }
        const resolver = await loadKhdResolver(db);
        const [maps] = await db.query('SELECT khd_key, local_id, updated_at FROM khd_value_mappings WHERE kind = ?', [kind]);
        const mapByKey = new Map(maps.map(m => [m.khd_key, m]));
        const items = [...groups.values()].map(g => ({
            ...g,
            khd_label: khdLabels.get(khdMapping.normKhd(g.khd_value)) || null,
            resolved: resolver.resolve(kind, g.khd_value),
            mapping: mapByKey.get(khdMapping.khdKey(g.khd_value)) || null,
        })).sort((a, b) => b.missing_count - a.missing_count || b.report_count - a.report_count);
        const optionSql = {
            dept: 'SELECT id, dept_name AS name, dept_code AS code FROM departments ORDER BY dept_name',
            main: 'SELECT mi.id, mi.main_indicator_name AS name, y.yut_name AS code FROM kpi_main_indicators mi LEFT JOIN main_yut y ON y.id = mi.yut_id ORDER BY mi.main_indicator_name',
            yut: 'SELECT id, yut_name AS name, NULL AS code FROM main_yut ORDER BY id',
        }[kind];
        const [options] = await db.query(optionSql);
        const summary = { total: items.length, unmatched: 0, auto: 0, mapped: 0, ignored: 0 };
        items.forEach(i => { summary[i.resolved.status] = (summary[i.resolved.status] || 0) + 1; });
        res.json({ success: true, kind, summary, items, options });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /khd-mappings — { kind, khd_value, local_id }: local_id = จับคู่, ignore = true → ไม่ต้องจับคู่ (เว้นว่าง), ทั้งคู่ไม่ส่ง = ลบการจับคู่ (กลับไปใช้อัตโนมัติ)
apiRouter.put('/khd-mappings', authenticateToken, isSuperAdmin, async (req, res) => {
    const { kind, khd_value, local_id, ignore } = req.body || {};
    if (!khdMapping.KHD_MAP_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'kind ต้องเป็น dept, main หรือ yut' });
    if (!khdMapping.normKhd(khd_value)) return res.status(400).json({ success: false, message: 'กรุณาระบุค่าจาก KHD' });
    try {
        const key = khdMapping.khdKey(khd_value);
        const id = Number(local_id);
        if (Number.isInteger(id) && id > 0) {
            const table = { dept: 'departments', main: 'kpi_main_indicators', yut: 'main_yut' }[kind];
            const [[row]] = await db.query(`SELECT id FROM ${table} WHERE id = ?`, [id]);
            if (!row) return res.status(400).json({ success: false, message: 'ไม่พบรายการปลายทางในระบบ' });
        }
        const target = (Number.isInteger(id) && id > 0) ? id : null;
        if (target === null && !ignore) {
            await db.query('DELETE FROM khd_value_mappings WHERE kind = ? AND khd_key = ?', [kind, key]);
        } else {
            await db.query(
                `INSERT INTO khd_value_mappings (kind, khd_key, khd_value, local_id, updated_by) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE khd_value = VALUES(khd_value), local_id = VALUES(local_id), updated_by = VALUES(updated_by)`,
                [kind, key, String(khd_value).trim().slice(0, 1000), target, req.user.userId]
            );
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'KHD_MAPPING_UPDATE', 'khd_value_mappings', JSON.stringify({ kind, khd_value, local_id: target, ignore: !!ignore }), req.ip]);
        const resolver = await loadKhdResolver(db);
        res.json({ success: true, message: 'บันทึกการจับคู่เรียบร้อย', resolved: resolver.resolve(kind, khd_value) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== Report Compare — Tabs (Strategies / Departments / Main-Indicators / Hospitals) ==========

// GET /report-compare/strategies — เปรียบเทียบ main_yut (Local) กับ distinct main_yut text ใน KHD reports
apiRouter.get('/report-compare/strategies', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [khdRows] = await remoteDb.query(
            `SELECT DISTINCT TRIM(main_yut) AS khd_yut FROM reports WHERE data_source='excel' AND main_yut IS NOT NULL AND TRIM(main_yut) != ''`
        );
        const [localRows] = await db.query('SELECT id, yut_name FROM main_yut ORDER BY yut_name');
        const resolver = await loadKhdResolver(db);
        const usedLocal = new Set();
        const items = [];
        let match = 0, missing_local = 0, missing_remote = 0;
        khdRows.forEach(r => {
            const m = resolver.resolve('yut', r.khd_yut);
            if (m.local_id) { usedLocal.add(m.local_id); items.push({ status: 'match', khd_yut_name: r.khd_yut, local_id: m.local_id, local_yut_name: m.local_name, match_source: m.status }); match++; }
            else { items.push({ status: 'missing_local', khd_yut_name: r.khd_yut, local_id: null, local_yut_name: null, match_source: m.status }); missing_local++; }
        });
        localRows.forEach(r => {
            if (!usedLocal.has(Number(r.id))) { items.push({ status: 'missing_remote', khd_yut_name: null, local_id: r.id, local_yut_name: r.yut_name }); missing_remote++; }
        });
        res.json({ success: true, summary: { total: items.length, match, missing_local, missing_remote }, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-strategy — เพิ่ม yut_name ใหม่จาก KHD text
apiRouter.post('/report-compare/add-strategy', authenticateToken, isSuperAdmin, async (req, res) => {
    const { yut_name } = req.body;
    if (!yut_name?.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อยุทธศาสตร์' });
    try {
        const [existing] = await db.query('SELECT id FROM main_yut WHERE TRIM(LOWER(yut_name)) = TRIM(LOWER(?))', [yut_name]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มียุทธศาสตร์ชื่อนี้ในระบบแล้ว' });
        const [ins] = await db.query('INSERT INTO main_yut (yut_name) VALUES (?)', [yut_name.trim()]);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'main_yut', ins.insertId, JSON.stringify({ yut_name: yut_name.trim() }), req.ip]);
        res.json({ success: true, message: `เพิ่มยุทธศาสตร์ "${yut_name.trim()}" เรียบร้อย`, id: ins.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /report-compare/departments — เปรียบเทียบ departments (Local) กับ distinct dept text ใน KHD reports
apiRouter.get('/report-compare/departments', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [khdRows] = await remoteDb.query(
            `SELECT DISTINCT TRIM(dept) AS khd_dept FROM reports WHERE data_source='excel' AND dept IS NOT NULL AND TRIM(dept) != ''`
        );
        const [localRows] = await db.query('SELECT id, dept_name, dept_code FROM departments ORDER BY dept_name');
        const resolver = await loadKhdResolver(db);
        const byId = new Map(localRows.map(r => [Number(r.id), r]));
        const usedLocal = new Set();
        const items = [];
        let match = 0, missing_local = 0, missing_remote = 0;
        khdRows.forEach(r => {
            const m = resolver.resolve('dept', r.khd_dept);
            const local = m.local_id ? byId.get(m.local_id) : null;
            if (local) { usedLocal.add(m.local_id); items.push({ status: 'match', khd_dept_name: r.khd_dept, local_id: local.id, local_dept_name: local.dept_name, local_dept_code: local.dept_code, match_source: m.status }); match++; }
            else { items.push({ status: 'missing_local', khd_dept_name: r.khd_dept, local_id: null, local_dept_name: null, match_source: m.status }); missing_local++; }
        });
        localRows.forEach(r => {
            if (!usedLocal.has(Number(r.id))) { items.push({ status: 'missing_remote', khd_dept_name: null, local_id: r.id, local_dept_name: r.dept_name, local_dept_code: r.dept_code }); missing_remote++; }
        });
        res.json({ success: true, summary: { total: items.length, match, missing_local, missing_remote }, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-department — เพิ่ม dept_name ใหม่จาก KHD text
apiRouter.post('/report-compare/add-department', authenticateToken, isSuperAdmin, async (req, res) => {
    const { dept_name, dept_code } = req.body;
    if (!dept_name?.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        const [existing] = await db.query('SELECT id FROM departments WHERE TRIM(LOWER(dept_name)) = TRIM(LOWER(?))', [dept_name]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มีหน่วยงานชื่อนี้ในระบบแล้ว' });
        const [ins] = await db.query('INSERT INTO departments (dept_name, dept_code) VALUES (?, ?)', [dept_name.trim(), (dept_code || '').trim()]);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'departments', ins.insertId, JSON.stringify({ dept_name: dept_name.trim(), dept_code }), req.ip]);
        res.json({ success: true, message: `เพิ่มหน่วยงาน "${dept_name.trim()}" เรียบร้อย`, id: ins.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /report-compare/main-indicators — เปรียบเทียบ kpi_main_indicators: KHD table (ถ้ามี) หรือ Coverage fallback
apiRouter.get('/report-compare/main-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [localMainRows] = await db.query('SELECT id, main_indicator_name FROM kpi_main_indicators ORDER BY main_indicator_name');
        // ลองดึง kpi_main_indicators จาก KHD ก่อน
        let khdMainRows = null;
        try { [khdMainRows] = await remoteDb.query('SELECT id, main_indicator_name FROM kpi_main_indicators'); } catch (e) { khdMainRows = null; }

        if (khdMainRows) {
            // KHD มีตาราง kpi_main_indicators — เทียบชื่อตรงๆ
            const khdNames = new Map(khdMainRows.map(r => [r.main_indicator_name.trim().toLowerCase(), r]));
            const localNames = new Map(localMainRows.map(r => [r.main_indicator_name.trim().toLowerCase(), r]));
            const items = [];
            let match = 0, missing_local = 0, missing_remote = 0;
            khdMainRows.forEach(khd => {
                const key = khd.main_indicator_name.trim().toLowerCase();
                const local = localNames.get(key);
                if (!local) { items.push({ status: 'missing_local', khd_name: khd.main_indicator_name.trim(), local_id: null, local_name: null }); missing_local++; }
                else { items.push({ status: 'match', khd_name: khd.main_indicator_name.trim(), local_id: local.id, local_name: local.main_indicator_name }); match++; }
            });
            localMainRows.forEach(local => {
                if (!khdNames.has(local.main_indicator_name.trim().toLowerCase())) {
                    items.push({ status: 'missing_remote', khd_name: null, local_id: local.id, local_name: local.main_indicator_name }); missing_remote++;
                }
            });
            return res.json({ success: true, source: 'khd_table', summary: { total: items.length, match, missing_local, missing_remote }, items });
        }

        // Fallback: coverage จาก table_process ใน KHD reports
        const [khdTpRows] = await remoteDb.query(
            `SELECT DISTINCT TRIM(table_process) AS tp FROM reports WHERE data_source='excel' AND table_process IS NOT NULL AND TRIM(table_process) != ''`
        );
        const khdTpSet = new Set(khdTpRows.map(r => r.tp));
        const [localIndRows] = await db.query('SELECT id, main_indicator_id, table_process FROM kpi_indicators WHERE is_active = 1');
        const coverageItems = [];
        let has_khd = 0, local_only = 0;
        for (const mi of localMainRows) {
            const linked = localIndRows.filter(i => i.main_indicator_id == mi.id);
            const khdLinked = linked.filter(i => i.table_process && khdTpSet.has(i.table_process.trim()));
            const status = khdLinked.length > 0 ? 'has_khd' : 'local_only';
            if (status === 'has_khd') has_khd++; else local_only++;
            coverageItems.push({ status, local_id: mi.id, local_name: mi.main_indicator_name, total_indicators: linked.length, khd_linked_count: khdLinked.length });
        }
        res.json({ success: true, source: 'coverage_fallback', summary: { total: coverageItems.length, has_khd, local_only }, items: coverageItems });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-main-indicator — เพิ่มหมวดหมู่หลักจาก KHD เข้า Local
apiRouter.post('/report-compare/add-main-indicator', authenticateToken, isSuperAdmin, async (req, res) => {
    const { khd_name, yut_id } = req.body;
    if (!khd_name?.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหมวดหมู่หลัก' });
    try {
        const [existing] = await db.query('SELECT id FROM kpi_main_indicators WHERE LOWER(TRIM(main_indicator_name)) = LOWER(TRIM(?))', [khd_name]);
        if (existing.length) return res.status(409).json({ success: false, message: `มี "${khd_name.trim()}" ในระบบแล้ว` });
        const [ins] = await db.query('INSERT INTO kpi_main_indicators (main_indicator_name, yut_id) VALUES (?, ?)', [khd_name.trim(), yut_id || null]);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'kpi_main_indicators', ins.insertId, JSON.stringify({ khd_name: khd_name.trim(), yut_id }), req.ip]);
        res.json({ success: true, message: `เพิ่ม "${khd_name.trim()}" เรียบร้อย`, id: ins.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /report-compare/hospitals — เปรียบเทียบ chospital Local กับ KHD chospital (ถ้ามี)
apiRouter.get('/report-compare/hospitals', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        let khdRows;
        try { [khdRows] = await remoteDb.query('SELECT hoscode, hosname, hostype, distid FROM chospital'); }
        catch (e) { return res.status(400).json({ success: false, message: 'ไม่พบตาราง chospital ใน KHD: ' + e.message }); }
        const [localRows] = await db.query('SELECT hoscode, hosname, hostype, distid FROM chospital');
        const localMap = new Map(localRows.map(r => [String(r.hoscode).trim(), r]));
        const khdMap = new Map(khdRows.map(r => [String(r.hoscode).trim(), r]));
        const items = [];
        let match = 0, different = 0, missing_local = 0, missing_remote = 0;
        khdRows.forEach(khd => {
            const key = String(khd.hoscode).trim();
            const local = localMap.get(key);
            if (!local) { items.push({ status: 'missing_local', hoscode: key, khd_hosname: khd.hosname, khd_hostype: khd.hostype, khd_distid: khd.distid, local_hosname: null }); missing_local++; }
            else if ((local.hosname || '').trim() !== (khd.hosname || '').trim()) { items.push({ status: 'different', hoscode: key, khd_hosname: khd.hosname, local_hosname: local.hosname, khd_hostype: khd.hostype, khd_distid: khd.distid }); different++; }
            else { items.push({ status: 'match', hoscode: key, khd_hosname: khd.hosname, local_hosname: local.hosname, khd_hostype: khd.hostype }); match++; }
        });
        localRows.forEach(local => {
            if (!khdMap.has(String(local.hoscode).trim())) { items.push({ status: 'missing_remote', hoscode: String(local.hoscode).trim(), local_hosname: local.hosname, khd_hosname: null, khd_hostype: null }); missing_remote++; }
        });
        res.json({ success: true, summary: { total: items.length, match, different, missing_local, missing_remote }, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-hospital — เพิ่ม hoscode จาก KHD chospital เข้า Local
apiRouter.post('/report-compare/add-hospital', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { hoscode } = req.body;
    if (!hoscode) return res.status(400).json({ success: false, message: 'กรุณาระบุ hoscode' });
    try {
        const [khdRows] = await remoteDb.query(
            'SELECT hoscode, hosname, hostype, distid, provcode, distcode FROM chospital WHERE hoscode = ?', [hoscode]
        );
        if (!khdRows.length) return res.status(404).json({ success: false, message: 'ไม่พบ hoscode นี้ใน KHD' });
        const khd = khdRows[0];
        const [existing] = await db.query('SELECT hoscode FROM chospital WHERE hoscode = ?', [hoscode]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มี hoscode นี้ในระบบแล้ว' });
        await db.query(
            'INSERT INTO chospital (hoscode, hosname, hostype, distid, provcode, distcode) VALUES (?, ?, ?, ?, ?, ?)',
            [khd.hoscode, khd.hosname, khd.hostype || null, khd.distid || null, khd.provcode || null, khd.distcode || null]
        );
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'chospital', hoscode, JSON.stringify({ hoscode, hosname: khd.hosname }), req.ip]);
        res.json({ success: true, message: `เพิ่ม "${khd.hosname}" (${hoscode}) เรียบร้อย` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== Feedback Board API ==========

// POST /feedback/mark-read — เคลียร์ badge เมื่อเข้าหน้า feedback
apiRouter.post('/feedback/mark-read', authenticateToken, async (req, res) => {
    try {
        await db.query(
            "INSERT INTO system_settings (setting_key, setting_value) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE setting_value = NOW()",
            [`feedback_last_read_${req.user.userId}`]
        );
        res.json({ success: true });
    } catch (e) { res.json({ success: true }); }
});

// GET /feedback/unread-count — นับกระทู้/reply ใหม่ตั้งแต่ครั้งล่าสุดที่เข้าดู
apiRouter.get('/feedback/unread-count', authenticateToken, async (req, res) => {
    try {
        const [lastRead] = await db.query(
            "SELECT setting_value FROM system_settings WHERE setting_key = ?",
            [`feedback_last_read_${req.user.userId}`]
        );
        const since = lastRead[0]?.setting_value || '2000-01-01';
        // นับกระทู้ + reply ที่สร้างหลังจาก last_read
        const [posts] = await db.query(
            'SELECT COUNT(*) AS cnt FROM feedback_posts WHERE created_at > ? AND user_id != ?',
            [since, req.user.userId]
        );
        const [replies] = await db.query(
            'SELECT COUNT(*) AS cnt FROM feedback_replies WHERE created_at > ? AND user_id != ?',
            [since, req.user.userId]
        );
        res.json({ success: true, count: (posts[0].cnt || 0) + (replies[0].cnt || 0) });
    } catch (e) { res.json({ success: true, count: 0 }); }
});

// GET /feedback — ดึงกระทู้ทั้งหมด
apiRouter.get('/feedback', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT p.*, u.firstname, u.lastname, u.username, u.role AS user_role,
                   (SELECT COUNT(*) FROM feedback_replies r WHERE r.post_id = p.id) AS reply_count
            FROM feedback_posts p
            LEFT JOIN users u ON p.user_id = u.id
            ORDER BY p.updated_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /feedback — สร้างกระทู้ใหม่ + แจ้งเตือน
apiRouter.post('/feedback', authenticateToken, async (req, res) => {
    const { category, title, message } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, message: 'กรุณากรอกหัวข้อและข้อความ' });
    try {
        const [result] = await db.query(
            'INSERT INTO feedback_posts (user_id, category, title, message) VALUES (?,?,?,?)',
            [req.user.userId, category || 'suggestion', title, message]
        );
        // แจ้งเตือน super_admin ทุกคน
        const [superAdmins] = await db.query("SELECT id FROM users WHERE role = 'super_admin' AND is_approved = 1");
        const user = req.user;
        const [userInfo] = await db.query('SELECT firstname, lastname FROM users WHERE id = ?', [user.userId]);
        const authorName = userInfo[0] ? `${userInfo[0].firstname} ${userInfo[0].lastname}` : user.username;
        for (const sa of superAdmins) {
            await db.query(
                "INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)",
                [sa.id, `กระทู้ใหม่: ${title}`, `${authorName} — ${message.substring(0, 100)}`, user.userId]
            );
        }
        // แจ้ง Telegram + Email
        const catLabels = { suggestion: 'ข้อเสนอแนะ', question: 'คำถาม', bug: 'แจ้งปัญหา', other: 'อื่นๆ' };
        const catLabel = catLabels[category] || category;
        notifyAdmins(
            `📝 กระทู้ใหม่: ${title} — ระบบ KPI สสจ.นครราชสีมา`,
            `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:linear-gradient(135deg,#0d9488,#14b8a6);padding:20px;text-align:center;color:white">
                    <h2 style="margin:0;font-size:18px">📝 กระทู้ใหม่</h2>
                </div>
                <div style="padding:20px">
                    <table style="width:100%;font-size:14px;border-collapse:collapse">
                        <tr><td style="padding:6px 0;color:#6b7280">หมวดหมู่</td><td style="font-weight:bold">${catLabel}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">หัวข้อ</td><td style="font-weight:bold">${title}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">ผู้สร้าง</td><td style="font-weight:bold">${authorName}</td></tr>
                    </table>
                    <div style="margin-top:12px;padding:12px;background:#f3f4f6;border-radius:8px;font-size:13px">${message.substring(0, 300)}</div>
                </div>
            </div>`,
            `📝 กระทู้ใหม่\n━━━━━━━━━━━━━━━\n📋 ${catLabel}\n📌 ${title}\n👤 ${authorName}\n━━━━━━━━━━━━━━━\n${message.substring(0, 200)}`
        );
        res.json({ success: true, message: 'สร้างกระทู้สำเร็จ', id: result.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /feedback/:id/replies — ดึง replies ของกระทู้
apiRouter.get('/feedback/:id/replies', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT r.*, u.firstname, u.lastname, u.username, u.role AS user_role
            FROM feedback_replies r
            LEFT JOIN users u ON r.user_id = u.id
            WHERE r.post_id = ?
            ORDER BY r.created_at ASC
        `, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /feedback/:id/replies — ตอบกลับกระทู้ + แจ้งเตือนทุกช่องทาง
apiRouter.post('/feedback/:id/replies', authenticateToken, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความ' });
    try {
        await db.query('INSERT INTO feedback_replies (post_id, user_id, message) VALUES (?,?,?)', [req.params.id, req.user.userId, message]);
        await db.query('UPDATE feedback_posts SET updated_at = NOW() WHERE id = ?', [req.params.id]);
        const [post] = await db.query('SELECT user_id, title FROM feedback_posts WHERE id = ?', [req.params.id]);
        const [replier] = await db.query('SELECT firstname, lastname, role FROM users WHERE id = ?', [req.user.userId]);
        const replierName = replier[0] ? `${replier[0].firstname} ${replier[0].lastname}` : 'ผู้ใช้งาน';
        const replierRole = replier[0]?.role || '';

        // 1. แจ้ง Notification เจ้าของกระทู้ (ถ้าไม่ใช่ตัวเอง)
        if (post[0] && post[0].user_id !== req.user.userId) {
            await db.query(
                "INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)",
                [post[0].user_id, `มีคนตอบกระทู้ของคุณ`, `${replierName} ตอบกลับกระทู้ "${post[0].title}"`, req.user.userId]
            );
            // LINE ส่วนตัวให้เจ้าของกระทู้
            sendLineToUser(post[0].user_id,
                `💬 มีคนตอบกระทู้ของคุณ\n` +
                `📌 ${post[0].title}\n` +
                `👤 ${replierName}\n` +
                `━━━━━━━━━━━\n` +
                `${(message || '').substring(0, 200)}`
            );
        }

        // 2. แจ้ง super_admin ทุกคน (ถ้าคนตอบไม่ใช่ super_admin)
        if (replierRole !== 'super_admin') {
            const [superAdmins] = await db.query("SELECT id FROM users WHERE role = 'super_admin' AND is_approved = 1 AND id != ?", [req.user.userId]);
            for (const sa of superAdmins) {
                await db.query(
                    "INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)",
                    [sa.id, `ตอบกลับกระทู้: ${post[0]?.title}`, `${replierName}: ${message.substring(0, 100)}`, req.user.userId]
                );
            }
        }

        // 3. แจ้ง Telegram ทุกข้อความตอบกลับ
        const title = post[0]?.title || '';
        notifyAdmins(
            `💬 ตอบกลับกระทู้: ${title}`,
            `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:linear-gradient(135deg,#0d9488,#14b8a6);padding:16px;text-align:center;color:white">
                    <h2 style="margin:0;font-size:16px">💬 ตอบกลับกระทู้</h2>
                </div>
                <div style="padding:16px">
                    <p style="font-weight:bold;margin-bottom:4px">📌 ${title}</p>
                    <p style="color:#6b7280;font-size:13px">👤 ${replierName}</p>
                    <div style="margin-top:8px;padding:10px;background:#f3f4f6;border-radius:8px;font-size:13px">${message.substring(0, 300)}</div>
                </div>
            </div>`,
            `💬 ตอบกลับกระทู้\n📌 ${title}\n👤 ${replierName}\n━━━━━━━━━━━━━━━\n${message.substring(0, 200)}`
        );

        res.json({ success: true, message: 'ตอบกลับสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /feedback/:id/status — อัปเดตสถานะ (super_admin)
apiRouter.put('/feedback/:id/status', authenticateToken, isSuperAdmin, async (req, res) => {
    const { status } = req.body;
    try {
        await db.query('UPDATE feedback_posts SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ success: true, message: 'อัปเดตสถานะสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /feedback/:id — ลบกระทู้ (super_admin)
apiRouter.delete('/feedback/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM feedback_posts WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบกระทู้สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// GET /db-compare — เปรียบเทียบ structure ตาราง table_process ระหว่าง local กับ khd
apiRouter.get('/db-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD) ใน .env (KHD_DB_HOST)' });

    try {
        // 1. ดึง table_process ทั้งหมดจาก kpi_indicators (deduplicate ตาม table_process)
        const [allIndicators] = await db.query("SELECT id, kpi_indicators_name, table_process, dept_id, main_indicator_id, is_active FROM kpi_indicators WHERE table_process IS NOT NULL AND table_process != ''");
        // รวมชื่อตัวชี้วัดที่ใช้ table_process เดียวกัน + เก็บ dept_id/main_indicator_id ของตัวแรก (สำหรับตัวกรอง)
        const tableMap = new Map();
        for (const ind of allIndicators) {
            const tp = ind.table_process.trim().replace(/-/g, '_');
            if (!tableMap.has(tp)) {
                tableMap.set(tp, {
                    id: ind.id, table_process: tp, names: [],
                    dept_id: ind.dept_id, main_indicator_id: ind.main_indicator_id, is_active: ind.is_active
                });
            }
            tableMap.get(tp).names.push(ind.kpi_indicators_name);
        }
        const indicators = Array.from(tableMap.values()).map(v => ({
            id: v.id, table_process: v.table_process,
            kpi_indicators_name: v.names.length === 1 ? v.names[0] : v.names.join(' | '),
            dept_id: v.dept_id, main_indicator_id: v.main_indicator_id, is_active: v.is_active
        }));

        const results = [];
        const localDbName = process.env.DB_NAME || 'khups_kpi_db';
        const remoteDbName = process.env.KHD_DB_NAME || 'hdc';

        for (const ind of indicators) {
            const tableName = ind.table_process.trim().replace(/-/g, '_');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) continue;

            const item = {
                id: ind.id, name: ind.kpi_indicators_name, table: tableName,
                dept_id: ind.dept_id, main_indicator_id: ind.main_indicator_id, is_active: ind.is_active,
                local: null, remote: null, status: 'unknown', diff: []
            };

            // Local structure
            try {
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [localCount] = await db.query(`SELECT COUNT(*) AS cnt FROM \`${tableName}\``);
                item.local = { exists: true, columns: localCols.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default })), row_count: localCount[0].cnt };
            } catch (e) { item.local = { exists: false, columns: [], row_count: 0 }; }

            // Remote structure
            try {
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [remoteCount] = await remoteDb.query(`SELECT COUNT(*) AS cnt FROM \`${tableName}\``);
                item.remote = { exists: true, columns: remoteCols.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default })), row_count: remoteCount[0].cnt };
            } catch (e) { item.remote = { exists: false, columns: [], row_count: 0 }; }

            // Compare
            if (!item.local.exists && !item.remote.exists) { item.status = 'missing_both'; }
            else if (!item.local.exists) { item.status = 'missing_local'; }
            else if (!item.remote.exists) { item.status = 'missing_remote'; }
            else {
                // เปรียบเทียบ columns
                item.diff = diffTableColumns(item.local.columns, item.remote.columns);
                item.status = item.diff.length === 0 ? 'match' : 'different';
            }

            results.push(item);
        }

        const summary = {
            total: results.length,
            match: results.filter(r => r.status === 'match').length,
            different: results.filter(r => r.status === 'different').length,
            missing_local: results.filter(r => r.status === 'missing_local').length,
            missing_remote: results.filter(r => r.status === 'missing_remote').length,
            missing_both: results.filter(r => r.status === 'missing_both').length
        };

        res.json({ success: true, local_db: localDbName, remote_db: remoteDbName, summary, tables: results });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST /db-compare/create-local — สร้าง/แก้ไขตารางใน local ให้ตรงกับ remote
apiRouter.post('/db-compare/create-local', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body; // ['table1', 'table2']
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const created = [], altered = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ดึง CREATE TABLE จาก remote
            const [ddlRows] = await remoteDb.query(`SHOW CREATE TABLE \`${tableName}\``);
            if (ddlRows.length === 0) { errors.push({ table: tableName, error: 'ไม่พบตารางใน remote' }); continue; }

            let ddl = ddlRows[0]['Create Table'];

            // ตรวจว่า local มีตารางนี้หรือยัง
            let localExists = false;
            try { await db.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); localExists = true; } catch (e) {}

            if (!localExists) {
                // สร้างใหม่
                await db.query(ddl);
                created.push(tableName);
            } else {
                // ALTER เพิ่มคอลัมน์ที่ขาด
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const localFieldSet = new Set(localCols.map(c => c.Field));
                let alteredCount = 0;
                for (const col of remoteCols) {
                    if (!localFieldSet.has(col.Field)) {
                        const nullable = col.Null === 'YES' ? 'NULL' : 'NOT NULL';
                        const def = col.Default !== null ? `DEFAULT '${col.Default}'` : (col.Null === 'YES' ? 'DEFAULT NULL' : '');
                        try {
                            await db.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.Field}\` ${col.Type} ${nullable} ${def}`);
                            alteredCount++;
                        } catch (e) { /* column อาจมีอยู่แล้ว */ }
                    }
                }
                if (alteredCount > 0) altered.push({ table: tableName, added_columns: alteredCount });
            }
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_CREATE', 'MULTIPLE', JSON.stringify({ created, altered }), req.ip]).catch(() => {});

    res.json({ success: true, message: `สร้าง ${created.length} ตาราง, แก้ไข ${altered.length} ตาราง`, created, altered, errors });
});

// POST /db-compare/sync-data — Sync ข้อมูลจาก remote (khd) เข้า local
apiRouter.post('/db-compare/sync-data', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const synced = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ตรวจว่า local มีตารางนี้
            try { await db.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); } catch (e) {
                errors.push({ table: tableName, error: 'ตารางไม่มีใน local กรุณาสร้างก่อน' }); continue;
            }

            // ดึงข้อมูลจาก remote
            const [remoteRows] = await remoteDb.query(`SELECT * FROM \`${tableName}\``);
            if (remoteRows.length === 0) { synced.push({ table: tableName, rows: 0, message: 'ไม่มีข้อมูลใน remote' }); continue; }

            // ดึง column names
            const columns = Object.keys(remoteRows[0]);
            const colList = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const onDup = columns.map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

            // Batch upsert (100 rows per batch)
            let totalInserted = 0;
            for (let i = 0; i < remoteRows.length; i += 100) {
                const batch = remoteRows.slice(i, i + 100);
                const allPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
                const flatValues = batch.flatMap(row => columns.map(c => row[c]));
                await db.query(`INSERT INTO \`${tableName}\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${onDup}`, flatValues);
                totalInserted += batch.length;
            }

            synced.push({ table: tableName, rows: totalInserted });
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_SYNC', 'MULTIPLE', JSON.stringify({ synced: synced.length, total_rows: synced.reduce((s, t) => s + t.rows, 0) }), req.ip]).catch(() => {});

    res.json({ success: true, message: `Sync สำเร็จ ${synced.length} ตาราง`, synced, errors });
});

// POST /db-compare/create-remote — สร้าง/แก้ไขตารางใน KHD จาก DDL ของ Local (สำหรับ missing_remote)
apiRouter.post('/db-compare/create-remote', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const created = [], altered = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ดึง CREATE TABLE จาก local
            const [ddlRows] = await db.query(`SHOW CREATE TABLE \`${tableName}\``);
            if (ddlRows.length === 0) { errors.push({ table: tableName, error: 'ไม่พบตารางใน local' }); continue; }

            const ddl = ddlRows[0]['Create Table'];

            // ตรวจว่า remote มีตารางนี้หรือยัง
            let remoteExists = false;
            try { await remoteDb.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); remoteExists = true; } catch (e) {}

            if (!remoteExists) {
                // สร้างใหม่ใน KHD
                await remoteDb.query(ddl);
                created.push(tableName);
            } else {
                // ALTER เพิ่มคอลัมน์ที่ขาดใน KHD
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tableName}\``);
                const remoteFieldSet = new Set(remoteCols.map(c => c.Field));
                let alteredCount = 0;
                for (const col of localCols) {
                    if (!remoteFieldSet.has(col.Field)) {
                        const nullable = col.Null === 'YES' ? 'NULL' : 'NOT NULL';
                        const def = col.Default !== null ? `DEFAULT '${col.Default}'` : (col.Null === 'YES' ? 'DEFAULT NULL' : '');
                        try {
                            await remoteDb.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.Field}\` ${col.Type} ${nullable} ${def}`);
                            alteredCount++;
                        } catch (e) { /* column อาจมีอยู่แล้ว */ }
                    }
                }
                if (alteredCount > 0) altered.push({ table: tableName, added_columns: alteredCount });
            }
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_CREATE_REMOTE', 'MULTIPLE', JSON.stringify({ created, altered }), req.ip]).catch(() => {});

    res.json({ success: true, message: `สร้าง ${created.length} ตาราง, แก้ไข ${altered.length} ตารางใน KHD`, created, altered, errors });
});

// POST /db-compare/sync-to-khd — Sync ข้อมูลจาก Local → KHD (upsert batch 100 rows)
apiRouter.post('/db-compare/sync-to-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });

    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const synced = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ตรวจว่า remote มีตารางนี้
            try { await remoteDb.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); } catch (e) {
                errors.push({ table: tableName, error: 'ตารางไม่มีใน KHD กรุณาสร้างก่อน' }); continue;
            }

            // ดึงข้อมูลจาก local
            const [localRows] = await db.query(`SELECT * FROM \`${tableName}\``);
            if (localRows.length === 0) { synced.push({ table: tableName, rows: 0, message: 'ไม่มีข้อมูลใน local' }); continue; }

            // ดึง column names
            const columns = Object.keys(localRows[0]);
            const colList = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const onDup = columns.map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

            // Batch upsert → KHD (100 rows per batch)
            let totalInserted = 0;
            for (let i = 0; i < localRows.length; i += 100) {
                const batch = localRows.slice(i, i + 100);
                const allPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
                const flatValues = batch.flatMap(row => columns.map(c => row[c]));
                await remoteDb.query(`INSERT INTO \`${tableName}\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${onDup}`, flatValues);
                totalInserted += batch.length;
            }

            synced.push({ table: tableName, rows: totalInserted });
        } catch (e) { errors.push({ table: tableName, error: e.message }); }
    }

    await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
        [req.user.userId, 'DB_COMPARE_SYNC_TO_KHD', 'MULTIPLE', JSON.stringify({ synced: synced.length, total_rows: synced.reduce((s, t) => s + t.rows, 0) }), req.ip]).catch(() => {});

    res.json({ success: true, message: `Sync → KHD สำเร็จ ${synced.length} ตาราง`, synced, errors });
});

// ========== Users Data Sync (Local ↔ KHD) ==========
// โหลด config exclude/mapping ของ Users Data Sync จาก system_settings
async function getUsersSyncConfig() {
    const [rows] = await db.query(
        "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('users_sync_exclude_columns','users_sync_field_mapping')"
    );
    const map = new Map(rows.map(r => [r.setting_key, r.setting_value]));
    let exclude = [], mapping = {};
    try { exclude = JSON.parse(map.get('users_sync_exclude_columns') || '[]'); } catch (e) { exclude = []; }
    try { mapping = JSON.parse(map.get('users_sync_field_mapping') || '{}'); } catch (e) { mapping = {}; }
    // safety: กันไม่ให้ id/username ถูก exclude เผลอ (username คือ key เทียบ, id คือ PK local)
    exclude = exclude.filter(c => c !== 'id' && c !== 'username');
    return { exclude: new Set(exclude), mapping };
}

// GET /users/sync-compare — เปรียบเทียบ users ระหว่าง Local กับ KHD (เก็บ diff รายฟิลด์จริง ไม่ใช่แค่ boolean)
apiRouter.get('/users/sync-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const { exclude, mapping } = await getUsersSyncConfig();

        // ดึง local users (ทุกคอลัมน์)
        const [localUsers] = await db.query('SELECT * FROM users ORDER BY username');

        // ดึง remote users — ถ้าตารางไม่มี → ถือว่าว่าง
        let remoteUsers = [];
        try {
            const [rows] = await remoteDb.query('SELECT * FROM users ORDER BY username');
            remoteUsers = rows;
        } catch (e) { /* ตาราง users ไม่มีใน KHD */ }

        const remoteMap = new Map(remoteUsers.map(u => [u.username, u]));
        const localMap = new Map(localUsers.map(u => [u.username, u]));

        const matched = [], different = [], local_only = [], khd_only = [];
        const alwaysSkip = ['id', 'created_at', 'updated_at']; // baseline เดิม ไม่เปลี่ยน

        for (const lu of localUsers) {
            const ru = remoteMap.get(lu.username);
            if (!ru) { local_only.push(lu); continue; }
            // เทียบค่าทีละ field — เก็บ diff ทุกฟิลด์ (ไม่ break ที่ตัวแรก) + ใช้ mapping ชื่อ field ถ้ามี
            const fieldDiffs = [];
            for (const k of Object.keys(lu)) {
                if (alwaysSkip.includes(k) || exclude.has(k)) continue;
                const remoteKey = mapping[k] || k;
                const lv = lu[k] == null ? '' : String(lu[k]);
                const rv = ru[remoteKey] == null ? '' : String(ru[remoteKey]);
                if (lv !== rv) {
                    fieldDiffs.push({ field: k, khd_field: remoteKey !== k ? remoteKey : undefined, local_value: lu[k], khd_value: ru[remoteKey] });
                }
            }
            (fieldDiffs.length > 0 ? different : matched).push(fieldDiffs.length > 0 ? { ...lu, _diff: fieldDiffs } : lu);
        }
        for (const ru of remoteUsers) {
            if (!localMap.has(ru.username)) khd_only.push(ru);
        }

        res.json({
            success: true,
            summary: { matched: matched.length, different: different.length, local_only: local_only.length, khd_only: khd_only.length, total_local: localUsers.length, total_khd: remoteUsers.length },
            matched, different, local_only, khd_only,
            sync_config: { exclude: [...exclude], mapping }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /users/sync-to-khd — ส่ง users จาก Local → KHD (UPSERT)
apiRouter.post('/users/sync-to-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { usernames } = req.body; // optional: ถ้าไม่ส่ง = sync ทั้งหมด
    const { exclude, mapping } = await getUsersSyncConfig();

    try {
        // === Step 1: ensure KHD users table exists (สร้างจาก local DDL ถ้าไม่มี) ===
        let khdTableExists = true;
        try {
            await remoteDb.query('SELECT 1 FROM users LIMIT 0');
        } catch (e) {
            khdTableExists = false;
            const [ddlRows] = await db.query('SHOW CREATE TABLE users');
            if (ddlRows.length > 0) {
                try {
                    await remoteDb.query(ddlRows[0]['Create Table']);
                    console.log('[sync-to-khd] Created users table in KHD');
                    khdTableExists = true;
                } catch (ce) {
                    return res.status(500).json({
                        success: false,
                        message: `ไม่สามารถสร้างตาราง users ใน KHD: ${ce.message}`
                    });
                }
            }
        }

        // === Step 2: sync schema — ALTER ADD COLUMN ที่ Local มีแต่ KHD ไม่มี (ข้ามคอลัมน์ที่ตั้งใจไม่ sync) ===
        const [localColsInfo] = await db.query('SHOW COLUMNS FROM users');
        const [remoteColsInfo] = await remoteDb.query('SHOW COLUMNS FROM users');
        const remoteColSet = new Set(remoteColsInfo.map(c => c.Field));
        const missingInRemote = localColsInfo.filter(c => !remoteColSet.has(c.Field) && !exclude.has(c.Field));
        const addedColumns = [];
        const alterErrors = [];
        for (const col of missingInRemote) {
            // สร้าง ALTER statement (ระวัง quotes ใน Default)
            let alter = `ALTER TABLE \`users\` ADD COLUMN \`${col.Field}\` ${col.Type}`;
            if (col.Null === 'NO') alter += ' NOT NULL';
            if (col.Default !== null && col.Default !== undefined) {
                const def = String(col.Default);
                // Skip default ที่เป็น expression (CURRENT_TIMESTAMP, etc)
                if (/^(CURRENT_TIMESTAMP|NULL)$/i.test(def)) {
                    alter += ` DEFAULT ${def}`;
                } else {
                    alter += ` DEFAULT ${remoteDb.escape ? remoteDb.escape(def) : `'${def.replace(/'/g, "''")}'`}`;
                }
            }
            if (col.Extra) alter += ` ${col.Extra}`;
            try {
                await remoteDb.query(alter);
                addedColumns.push(col.Field);
                console.log(`[sync-to-khd] Added column ${col.Field} to KHD users`);
            } catch (ae) {
                alterErrors.push({ column: col.Field, error: ae.message });
                console.warn(`[sync-to-khd] ALTER add ${col.Field} failed:`, ae.message);
            }
        }

        // === Step 3: ดึง users ที่ต้องการ sync ===
        let query = 'SELECT * FROM users';
        const params = [];
        if (Array.isArray(usernames) && usernames.length > 0) {
            query += ` WHERE username IN (${usernames.map(() => '?').join(',')})`;
            params.push(...usernames);
        }
        const [localUsers] = await db.query(query, params);
        if (localUsers.length === 0) return res.json({ success: true, synced: 0, message: 'ไม่มีข้อมูลที่จะ sync' });

        // === Step 4: resolve local→KHD target column names (mapping) + ตัด exclude + ใช้เฉพาะ columns ที่มีใน KHD จริงๆ ===
        const [remoteColsAfter] = await remoteDb.query('SHOW COLUMNS FROM users');
        const remoteColSetAfter = new Set(remoteColsAfter.map(c => c.Field));
        const localCols = Object.keys(localUsers[0]);
        const eligibleCols = localCols.filter(c => !exclude.has(c));
        const excludedCols = localCols.filter(c => exclude.has(c));
        const colPairs = eligibleCols.map(c => ({ local: c, khd: mapping[c] || c }));
        // กรอง: ใช้เฉพาะ column ปลายทางที่ KHD มีจริงๆ (กัน Unknown column) — ไม่ ALTER สร้างตามชื่อ mapping อัตโนมัติ
        const syncableCols = colPairs.filter(p => remoteColSetAfter.has(p.khd));
        const skippedCols = colPairs.filter(p => !remoteColSetAfter.has(p.khd)).map(p => p.local);
        if (skippedCols.length > 0) {
            console.warn('[sync-to-khd] Skipped columns (target not in KHD):', skippedCols.join(', '));
        }

        // === Step 5: identify JSON columns → stringify ===
        const jsonCols = new Set(
            localColsInfo
                .filter(c => /^(json|longtext)/i.test(c.Type))
                .map(c => c.Field)
        );

        // === Step 6: UPSERT batch 100 rows (เขียนลงชื่อคอลัมน์ปลายทางตาม mapping) ===
        const colList = syncableCols.map(p => `\`${p.khd}\``).join(', ');
        const placeholders = syncableCols.map(() => '?').join(', ');
        const onDup = syncableCols.filter(p => p.khd !== 'id').map(p => `\`${p.khd}\`=VALUES(\`${p.khd}\`)`).join(', ');

        let totalSynced = 0;
        const errors = [];
        for (let i = 0; i < localUsers.length; i += 100) {
            const batch = localUsers.slice(i, i + 100);
            const allPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
            const flatValues = batch.flatMap(row => syncableCols.map(p => {
                const v = row[p.local];
                if (v === undefined) return null;
                if (jsonCols.has(p.local) && v !== null && typeof v === 'object') {
                    try { return JSON.stringify(v); } catch (e) { return null; }
                }
                return v;
            }));
            try {
                const [result] = await remoteDb.query(
                    `INSERT INTO \`users\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${onDup}`,
                    flatValues
                );
                totalSynced += batch.length;
                console.log(`[sync-to-khd] Batch ${i}: affected=${result.affectedRows}, inserted=${result.affectedRows - (result.changedRows || 0)}, updated=${result.changedRows || 0}`);
            } catch (e) {
                console.error(`[sync-to-khd] Batch ${i} failed:`, e.message);
                // เก็บ usernames ที่ fail
                errors.push({
                    batch_start: i,
                    batch_size: batch.length,
                    usernames: batch.map(u => u.username),
                    error: e.message,
                    code: e.code
                });
            }
        }

        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'USERS_SYNC_TO_KHD', 'users', JSON.stringify({ synced: totalSynced, total: localUsers.length, errors: errors.length, addedColumns }), req.ip]).catch(() => {});

        // === Step 7: build response ===
        const success = totalSynced === localUsers.length && errors.length === 0;
        const partial = totalSynced > 0 && totalSynced < localUsers.length;
        const failure = totalSynced === 0;
        let message;
        if (success) {
            message = `Sync สำเร็จ ${totalSynced} คน`;
        } else if (partial) {
            message = `Sync บางส่วน: สำเร็จ ${totalSynced}/${localUsers.length} คน (มี ${errors.length} batch ผิดพลาด)`;
        } else {
            message = `Sync ล้มเหลว — ไม่มีข้อมูลถูกส่ง (${errors.length} batch ผิดพลาด)`;
        }
        if (addedColumns.length > 0) {
            message += ` | เพิ่ม column ใหม่ใน KHD: ${addedColumns.join(', ')}`;
        }
        if (skippedCols.length > 0) {
            message += ` | ข้าม column ที่ KHD ไม่มี: ${skippedCols.join(', ')}`;
        }
        if (excludedCols.length > 0) {
            message += ` | ไม่ sync (ตั้งค่าไว้): ${excludedCols.join(', ')}`;
        }

        res.status(failure ? 500 : 200).json({
            success: !failure,
            partial,
            synced: totalSynced,
            total: localUsers.length,
            failed: localUsers.length - totalSynced,
            message,
            errors: errors.slice(0, 5),  // ส่งกลับเฉพาะ 5 errors แรก
            added_columns: addedColumns,
            skipped_columns: skippedCols,
            excluded_columns: excludedCols,
            applied_mapping: mapping,
            alter_errors: alterErrors
        });
    } catch (e) {
        console.error('[sync-to-khd] Fatal error:', e);
        res.status(500).json({ success: false, message: e.message, code: e.code });
    }
});

// GET /users/structure-compare — SHOW COLUMNS diff เฉพาะตาราง users ระหว่าง Local กับ KHD (รายงานอย่างเดียว ไม่แก้โครงสร้าง KHD อัตโนมัติ)
apiRouter.get('/users/structure-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [localColsRaw] = await db.query('SHOW COLUMNS FROM users');
        let remoteColsRaw = [];
        try { const [rc] = await remoteDb.query('SHOW COLUMNS FROM users'); remoteColsRaw = rc; } catch (e) { /* ตาราง users ไม่มีใน KHD */ }
        const local_columns = localColsRaw.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default }));
        const remote_columns = remoteColsRaw.map(c => ({ field: c.Field, type: c.Type, nullable: c.Null, key: c.Key, default: c.Default }));
        const diff = diffTableColumns(local_columns, remote_columns);
        res.json({
            success: true,
            local_db: process.env.DB_NAME || 'khups_kpi_db',
            remote_db: process.env.KHD_DB_NAME || 'hdc',
            local_columns, remote_columns, diff,
            status: diff.length === 0 ? 'match' : 'different'
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /users/sync-mapping — ดึง config mapping/exclude ปัจจุบัน + รายชื่อคอลัมน์ local ทั้งหมด
apiRouter.get('/users/sync-mapping', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { exclude, mapping } = await getUsersSyncConfig();
        const [localColsInfo] = await db.query('SHOW COLUMNS FROM users');
        res.json({ success: true, columns: localColsInfo.map(c => c.Field), exclude: [...exclude], mapping });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === Environment Config Management ===
// GET /env-config — ดึง config ทั้งหมด (DB override + ENV fallback)
apiRouter.get('/env-config', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const envKeys = [
            { key: 'DB_HOST', group: 'database', label: 'Database Host', sensitive: false },
            { key: 'DB_PORT', group: 'database', label: 'Database Port', sensitive: false },
            { key: 'DB_NAME', group: 'database', label: 'Database Name', sensitive: false },
            { key: 'DB_USER', group: 'database', label: 'Database User', sensitive: false },
            { key: 'DB_PASSWORD', group: 'database', label: 'Database Password', sensitive: true },
            { key: 'SMTP_HOST', group: 'email', label: 'SMTP Host', sensitive: false },
            { key: 'SMTP_PORT', group: 'email', label: 'SMTP Port', sensitive: false },
            { key: 'SMTP_USER', group: 'email', label: 'SMTP Email', sensitive: false },
            { key: 'SMTP_PASS', group: 'email', label: 'SMTP Password (App Password)', sensitive: true },
            { key: 'SMTP_FROM', group: 'email', label: 'SMTP From Name', sensitive: false },
            { key: 'TELEGRAM_BOT_TOKEN', group: 'notification', label: 'Telegram Bot Token', sensitive: true },
            { key: 'TELEGRAM_CHAT_ID', group: 'notification', label: 'Telegram Chat ID', sensitive: false },
            { key: 'ADMIN_EMAILS', group: 'notification', label: 'Admin Emails (comma)', sensitive: false },
            { key: 'APP_URL', group: 'app', label: 'Application URL (Frontend)', sensitive: false },
            { key: 'SECRET_KEY', group: 'app', label: 'JWT Secret Key', sensitive: true },
            { key: 'PORT', group: 'app', label: 'Backend Port', sensitive: false },
            { key: 'KHD_DB_HOST', group: 'khd', label: 'KHD Database Host', sensitive: false },
            { key: 'KHD_DB_PORT', group: 'khd', label: 'KHD Database Port', sensitive: false },
            { key: 'KHD_DB_NAME', group: 'khd', label: 'KHD Database Name', sensitive: false },
            { key: 'KHD_DB_USER', group: 'khd', label: 'KHD Database User', sensitive: false },
            { key: 'KHD_DB_PASSWORD', group: 'khd', label: 'KHD Database Password', sensitive: true },
        ];

        // ดึงค่าจาก system_settings (DB override)
        const settingKeys = envKeys.map(e => 'env_' + e.key);
        const [dbRows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [settingKeys]);
        const dbMap = new Map(dbRows.map(r => [r.setting_key.replace('env_', ''), r.setting_value]));

        const config = envKeys.map(e => ({
            ...e,
            env_value: e.sensitive ? (process.env[e.key] ? '••••••••' : '') : (process.env[e.key] || ''),
            db_value: e.sensitive ? (dbMap.get(e.key) ? '••••••••' : '') : (dbMap.get(e.key) || ''),
            source: dbMap.has(e.key) && dbMap.get(e.key) ? 'db' : (process.env[e.key] ? 'env' : 'none'),
            has_value: !!(dbMap.get(e.key) || process.env[e.key])
        }));

        res.json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST /env-config — บันทึก config ลง DB (override .env)
apiRouter.post('/env-config', authenticateToken, isSuperAdmin, async (req, res) => {
    const { settings } = req.body; // [{ key: 'SMTP_HOST', value: 'smtp.gmail.com' }, ...]
    if (!Array.isArray(settings)) return res.status(400).json({ success: false, message: 'Invalid data' });

    try {
        for (const s of settings) {
            if (!s.key || s.value === undefined) continue;
            const dbKey = 'env_' + s.key;
            await db.query(
                'INSERT INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [dbKey, s.value, `ENV override: ${s.key}`, s.value]
            );
        }

        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'UPDATE', 'env_config', JSON.stringify({ keys: settings.map(s => s.key) }), req.ip]).catch(() => {});

        res.json({ success: true, message: `บันทึก ${settings.length} รายการสำเร็จ (มีผลหลัง restart server)` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.post('/test-telegram', authenticateToken, isSuperAdmin, async (req, res) => {
    const { bot_token, chat_id } = req.body;
    if (!bot_token || !chat_id) return res.status(400).json({ success: false, message: 'กรุณากรอก Bot Token และ Chat ID' });
    const ok = await sendTelegramDirect(bot_token, chat_id, '🔔 ทดสอบการแจ้งเตือน\nจากระบบ KPI สสจ.นครราชสีมา\n✅ การเชื่อมต่อสำเร็จ!');
    res.json({ success: ok, message: ok ? 'ส่ง Telegram สำเร็จ' : 'ส่งไม่สำเร็จ ตรวจสอบ Token และ Chat ID' });
});

// === Test LINE Group Notification (super_admin) ===
apiRouter.post('/test-line', authenticateToken, isSuperAdmin, async (req, res) => {
    const { channel_token, group_id } = req.body;
    if (!channel_token || !group_id) return res.status(400).json({ success: false, message: 'กรุณากรอก Channel Access Token และ Group ID' });
    const groupIds = String(group_id).split(',').map(s => s.trim()).filter(Boolean);
    const msg = '🔔 ทดสอบการแจ้งเตือน\nจากระบบ KPI สสจ.นครราชสีมา\n✅ การเชื่อมต่อ LINE สำเร็จ!';
    const r = await sendLineMulticast(channel_token, groupIds.join(','), msg);
    const ok = r.sent > 0;
    res.json({
        success: ok,
        sent: r.sent, failed: r.failed,
        message: ok ? `ส่ง LINE สำเร็จ ${r.sent}/${groupIds.length} group` : (r.lastError || 'ส่งไม่สำเร็จ ตรวจสอบ Channel Access Token และ Group ID')
    });
});

// === Personal LINE — ของ user ตัวเอง ===
// GET /me/line — ดู LINE settings ของตัวเอง
apiRouter.get('/me/line', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT line_user_id, notif_line_enabled FROM users WHERE id = ? LIMIT 1',
            [req.user.userId]
        );
        if (!rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบ user' });
        // ดึง system line_channel_token เพื่อบอก client ว่าระบบเปิด LINE ใช้งานได้ไหม
        const ns = await getNotifSettings();
        res.json({
            success: true,
            line_user_id: rows[0].line_user_id || '',
            notif_line_enabled: Number(rows[0].notif_line_enabled) === 1,
            system_line_configured: !!ns.lineToken
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /me/line — บันทึก LINE userId + toggle
apiRouter.put('/me/line', authenticateToken, async (req, res) => {
    try {
        let { line_user_id, notif_line_enabled } = req.body || {};
        line_user_id = String(line_user_id || '').trim();
        // validate: ต้องเป็น "U" + 32 hex chars หรือว่าง (clear)
        if (line_user_id && !/^U[a-f0-9]{32}$/i.test(line_user_id)) {
            return res.status(400).json({ success: false, message: 'LINE userId ต้องเป็นรูปแบบ U + 32 hex chars (เช่น Uxxxxxx...)' });
        }
        const enabled = (notif_line_enabled === false || notif_line_enabled === 0 || notif_line_enabled === '0') ? 0 : 1;
        await db.query(
            'UPDATE users SET line_user_id = ?, notif_line_enabled = ? WHERE id = ?',
            [line_user_id || null, enabled, req.user.userId]
        );
        res.json({ success: true, message: 'บันทึก LINE settings สำเร็จ', line_user_id: line_user_id || '', notif_line_enabled: enabled === 1 });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /me/line/test — ทดสอบส่ง LINE ไปที่ user ตัวเอง
apiRouter.post('/me/line/test', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT firstname, lastname, line_user_id FROM users WHERE id = ? LIMIT 1',
            [req.user.userId]
        );
        if (!rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบ user' });
        if (!rows[0].line_user_id) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้ง LINE userId — กรอกและบันทึกก่อนทดสอบ' });
        const ns = await getNotifSettings();
        if (!ns.lineToken) return res.status(400).json({ success: false, message: 'ระบบยังไม่ได้ตั้ง Channel Access Token (super_admin ต้องตั้งที่ Settings)' });
        const msg = `🔔 ทดสอบการแจ้งเตือนส่วนตัว\nสวัสดี คุณ${rows[0].firstname} ${rows[0].lastname}\n✅ การเชื่อมต่อ LINE สำเร็จ! ระบบจะส่งแจ้งเตือนเข้าที่ LINE นี้`;
        const r = await sendLineDirect(ns.lineToken, rows[0].line_user_id, msg);
        res.json({
            success: r.ok,
            message: r.ok ? 'ส่ง LINE ทดสอบสำเร็จ — กรุณาตรวจสอบ LINE' : (r.error || 'ส่งไม่สำเร็จ — ตรวจว่าคุณ Add friend bot แล้วและ userId ถูกต้อง')
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === LINE Profile API: ดึงชื่อ + รูปจาก userId ===
const getLineProfile = async (channelToken, lineUserId) => {
    if (!channelToken || !lineUserId) return null;
    try {
        const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
            headers: { 'Authorization': `Bearer ${channelToken}` }
        });
        if (!res.ok) return null;
        return await res.json();  // { userId, displayName, pictureUrl, statusMessage }
    } catch (e) {
        console.error('[LINE profile] error:', e.message);
        return null;
    }
};

// === LINE Webhook — รับ event จาก LINE Platform เมื่อ user ทักเข้า bot ===
// LINE platform จะ POST ไปที่ webhook URL ที่ตั้งใน Developers Console
// URL ที่ต้องตั้งที่ console: https://<your-domain>/khupskpi/api/webhook/line
// ไม่ใช้ authenticateToken เพราะ LINE ไม่ส่ง JWT — verify ด้วย signature แทน
apiRouter.post('/webhook/line', async (req, res) => {
    try {
        const relayAuth = req.headers['x-relay-auth'];
        console.log(`[LINE webhook] HIT — IP=${req.ip} signature=${req.headers['x-line-signature'] ? 'present' : 'MISSING'} relayAuth=${relayAuth ? 'present' : 'MISSING'} hasRawBody=${!!req.rawBody} events=${(req.body?.events || []).length}`);

        // === Auth: รับ 2 แบบ — (1) LINE signature ตรงๆ (2) X-Relay-Auth จาก Cloudflare Worker ===
        const [secretRow] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'line_channel_secret' LIMIT 1");
        const [relayKeyRow] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'line_relay_auth_key' LIMIT 1");
        const channelSecret = secretRow[0]?.setting_value || '';
        const relayAuthKey = relayKeyRow[0]?.setting_value || '';

        let authMethod = null;
        // ลอง relay auth ก่อน (Cloudflare Worker forward case)
        if (relayAuth && relayAuthKey && relayAuth === relayAuthKey) {
            authMethod = 'relay';
            console.log('[LINE webhook] auth=RELAY OK (from Cloudflare Worker)');
        }
        // ถ้าไม่ใช่ relay → ลอง LINE signature
        else if (channelSecret) {
            const signature = req.headers['x-line-signature'];
            if (!signature) {
                console.warn('[LINE webhook] no x-line-signature header + no valid relay auth');
                return res.status(401).send('Unauthorized: no signature or relay auth');
            }
            if (!req.rawBody) {
                console.warn('[LINE webhook] rawBody missing — global json verify middleware not applied?');
            }
            const body = req.rawBody || Buffer.from(JSON.stringify(req.body), 'utf8');
            const expected = crypto.createHmac('sha256', channelSecret).update(body).digest('base64');
            if (signature !== expected) {
                console.warn(`[LINE webhook] signature mismatch — got=${signature?.slice(0, 12)}... expected=${expected.slice(0, 12)}... bodyLen=${body.length}`);
                return res.status(401).send('Invalid signature');
            }
            authMethod = 'line-signature';
            console.log('[LINE webhook] auth=LINE-SIGNATURE OK');
        } else {
            console.warn('[LINE webhook] no channel_secret + no relay key set — accept all (insecure)');
            authMethod = 'none';
        }

        // === Reply 200 OK ทันที (LINE timeout เร็ว) ===
        res.status(200).send('OK');

        const events = req.body?.events || [];
        if (!Array.isArray(events) || events.length === 0) return;

        const ns = await getNotifSettings();
        for (const ev of events) {
            const lineUserId = ev?.source?.userId;
            if (!lineUserId) continue;
            const messageText = ev?.message?.text || `[event: ${ev.type}]`;
            // ดึง profile (display name + picture)
            const profile = await getLineProfile(ns.lineToken, lineUserId);
            const displayName = profile?.displayName || null;
            const pictureUrl = profile?.pictureUrl || null;

            // INSERT ON DUPLICATE — เก็บล่าสุด + นับ message_count
            await db.query(
                `INSERT INTO line_inbox (line_user_id, display_name, picture_url, last_message, message_count, received_at)
                 VALUES (?, ?, ?, ?, 1, NOW())
                 ON DUPLICATE KEY UPDATE
                     display_name = COALESCE(VALUES(display_name), display_name),
                     picture_url = COALESCE(VALUES(picture_url), picture_url),
                     last_message = VALUES(last_message),
                     message_count = message_count + 1,
                     received_at = NOW(),
                     is_archived = 0`,
                [lineUserId, displayName, pictureUrl, messageText.slice(0, 500)]
            ).catch(e => console.error('[LINE webhook] inbox insert error:', e.message));

            // === Auto-reply userId กลับให้ user ผ่าน LINE bot ===
            // 3 scenario: (1) follow event ครั้งแรก (2) ผูกบัญชีแล้ว (3) ยังไม่ผูก
            const evType = ev.type;
            const replyToken = ev.replyToken;
            console.log(`[LINE webhook] event type=${evType} replyToken=${replyToken ? replyToken.slice(0, 12) + '...' : 'MISSING'} hasToken=${!!ns.lineToken}`);

            if ((evType === 'follow' || evType === 'message') && replyToken && ns.lineToken) {
                try {
                    const [linkedRows] = await db.query(
                        'SELECT id, username, firstname, lastname, notif_line_enabled FROM users WHERE line_user_id = ? LIMIT 1',
                        [lineUserId]
                    );
                    const linkedUser = linkedRows[0];
                    const baseUrl = (process.env.APP_URL || 'https://apikorat.moph.go.th/khupskpi').replace(/\/+$/, '');
                    const lowerText = (messageText || '').toLowerCase().trim();
                    const isQuestionForId = /(\buserid\b|\buser id\b|\buser_id\b|\bid\b|ไอดี|รหัส|เริ่ม|\bstart\b|\/start|\bhelp\b|\?)/i.test(lowerText);

                    let messages = [];
                    if (evType === 'follow') {
                        messages = [
                            { type: 'text', text: `🙏 ยินดีต้อนรับสู่ระบบ KHUPS KPI\n\n📌 LINE userId ของคุณ (แตะค้างข้อความถัดไปเพื่อคัดลอก) ⬇️` },
                            { type: 'text', text: lineUserId },
                            { type: 'text', text: `วิธีใช้งาน:\n1️⃣ คัดลอก userId ด้านบน\n2️⃣ ส่งให้ super_admin (หรือ Login ที่ ${baseUrl}/login → Profile → "ตั้งค่า LINE แจ้งเตือนส่วนตัว")\n3️⃣ พิมพ์ "id" ที่นี่ → ขอ userId ใหม่ได้ทุกเมื่อ` }
                        ];
                    } else if (linkedUser && isQuestionForId) {
                        const userName = `${linkedUser.firstname || ''} ${linkedUser.lastname || ''}`.trim() || linkedUser.username;
                        const status = Number(linkedUser.notif_line_enabled) === 1 ? '🟢 เปิดแจ้งเตือน' : '🔴 ปิดแจ้งเตือน';
                        messages = [
                            { type: 'text', text: `✅ บัญชีนี้ผูกอยู่แล้ว\n\n👤 ${userName} (${linkedUser.username})\n${status}\n\n📌 LINE userId ⬇️` },
                            { type: 'text', text: lineUserId }
                        ];
                    } else if (linkedUser) {
                        // ทักเฉยๆ — ตอบสั้นๆ
                        const userName = `${linkedUser.firstname || ''} ${linkedUser.lastname || ''}`.trim() || linkedUser.username;
                        messages = [{ type: 'text', text: `สวัสดีคุณ${userName} 👋\nระบบจะส่งแจ้งเตือนเข้า LINE นี้\nพิมพ์ "id" → ดู userId` }];
                    } else {
                        // ยังไม่ผูก
                        messages = [
                            { type: 'text', text: `📌 LINE userId ของคุณ (แตะค้างข้อความถัดไปเพื่อคัดลอก) ⬇️` },
                            { type: 'text', text: lineUserId },
                            { type: 'text', text: `วิธีใช้งาน:\n1️⃣ คัดลอก userId ด้านบน\n2️⃣ ส่งให้ super_admin\n3️⃣ Login ${baseUrl}/login → Profile → "ตั้งค่า LINE แจ้งเตือนส่วนตัว" → วาง userId → บันทึก\n\nจะได้รับแจ้งเตือน: login, อนุมัติบัญชี, reset password, มีคนตอบกระทู้` }
                        ];
                    }

                    console.log(`[LINE webhook] sending reply: replyToken=${replyToken.slice(0, 16)}... msgCount=${messages.length} tokenLen=${ns.lineToken.length}`);
                    const replyRes = await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${ns.lineToken}`
                        },
                        body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) })
                    });
                    const replyBody = await replyRes.text();
                    if (replyRes.ok) {
                        console.log(`[LINE webhook] ✓ reply SUCCESS status=${replyRes.status}`);
                    } else {
                        console.error(`[LINE webhook] ✗ reply FAILED status=${replyRes.status} body=${replyBody.slice(0, 500)}`);
                    }
                } catch (e) {
                    console.error('[LINE webhook] reply error:', e.message, e.stack?.split('\n').slice(0, 3).join(' | '));
                }
            } else {
                console.log(`[LINE webhook] skip reply: evType=${evType} hasReplyToken=${!!replyToken} hasLineToken=${!!ns.lineToken}`);
            }
        }
    } catch (e) {
        console.error('[LINE webhook] handler error:', e.message);
        // already sent 200 — ไม่ส่งอีก
    }
});

// === Admin: LINE Inbox + จัดการ line_user_id ของ user คนใดก็ได้ (super_admin only) ===
// GET /admin/line-inbox — รายการล่าสุดจาก webhook
apiRouter.get('/admin/line-inbox', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const showArchived = req.query.archived === '1';
        const [rows] = await db.query(`
            SELECT i.*, u.id AS user_id, u.username, u.firstname, u.lastname, u.role
            FROM line_inbox i
            LEFT JOIN users u ON u.id = i.linked_user_id
            ${showArchived ? '' : 'WHERE i.is_archived = 0'}
            ORDER BY i.received_at DESC
            LIMIT 100
        `);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/line-inbox/:id/assign — assign userId ใน inbox ให้กับ system user
apiRouter.post('/admin/line-inbox/:id/assign', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const inboxId = Number(req.params.id);
        const targetUserId = Number(req.body?.user_id);
        if (!targetUserId) return res.status(400).json({ success: false, message: 'ต้องระบุ user_id' });
        const [inboxRow] = await db.query('SELECT line_user_id FROM line_inbox WHERE id = ?', [inboxId]);
        if (!inboxRow[0]) return res.status(404).json({ success: false, message: 'ไม่พบ inbox' });
        const lineUserId = inboxRow[0].line_user_id;
        // เช็คว่า userId นี้มี user คนอื่นเซ็ตอยู่หรือไม่
        const [conflict] = await db.query('SELECT id, username FROM users WHERE line_user_id = ? AND id != ?', [lineUserId, targetUserId]);
        if (conflict.length > 0) {
            return res.status(409).json({ success: false, message: `userId นี้ผูกอยู่กับ user "${conflict[0].username}" แล้ว` });
        }
        await db.query('UPDATE users SET line_user_id = ? WHERE id = ?', [lineUserId, targetUserId]);
        await db.query('UPDATE line_inbox SET linked_user_id = ?, linked_at = NOW() WHERE id = ?', [targetUserId, inboxId]);
        res.json({ success: true, message: 'ผูกสำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/line-inbox/:id/archive — ซ่อน entry ที่ไม่ใช้
apiRouter.post('/admin/line-inbox/:id/archive', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const archived = req.body?.archived === false ? 0 : 1;
        await db.query('UPDATE line_inbox SET is_archived = ? WHERE id = ?', [archived, Number(req.params.id)]);
        res.json({ success: true, archived: archived === 1 });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/users/:id/line — super_admin set/clear line_user_id ของ user คนใดก็ได้
apiRouter.put('/admin/users/:id/line', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        let { line_user_id, notif_line_enabled } = req.body || {};
        line_user_id = String(line_user_id || '').trim();
        if (line_user_id && !/^U[a-f0-9]{32}$/i.test(line_user_id)) {
            return res.status(400).json({ success: false, message: 'LINE userId ต้องเป็นรูปแบบ U + 32 hex chars' });
        }
        // เช็ค conflict (userId ซ้ำกับ user อื่น)
        if (line_user_id) {
            const [conflict] = await db.query('SELECT id, username FROM users WHERE line_user_id = ? AND id != ?', [line_user_id, userId]);
            if (conflict.length > 0) {
                return res.status(409).json({ success: false, message: `userId นี้ผูกอยู่กับ user "${conflict[0].username}" แล้ว` });
            }
        }
        const enabled = (notif_line_enabled === false || notif_line_enabled === 0 || notif_line_enabled === '0') ? 0 : 1;
        await db.query('UPDATE users SET line_user_id = ?, notif_line_enabled = ? WHERE id = ?',
            [line_user_id || null, enabled, userId]);
        // sync linked_user_id ใน inbox (ถ้ามี)
        if (line_user_id) {
            await db.query('UPDATE line_inbox SET linked_user_id = ?, linked_at = NOW() WHERE line_user_id = ?', [userId, line_user_id]);
        } else {
            await db.query('UPDATE line_inbox SET linked_user_id = NULL, linked_at = NULL WHERE linked_user_id = ?', [userId]);
        }
        res.json({ success: true, message: 'บันทึกสำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/users/:id/line/test — super_admin ทดสอบส่ง LINE ให้ user คนใดก็ได้
apiRouter.post('/admin/users/:id/line/test', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT firstname, lastname, line_user_id FROM users WHERE id = ? LIMIT 1', [Number(req.params.id)]);
        if (!rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบ user' });
        if (!rows[0].line_user_id) return res.status(400).json({ success: false, message: 'user ยังไม่ได้ตั้ง LINE userId' });
        const ns = await getNotifSettings();
        if (!ns.lineToken) return res.status(400).json({ success: false, message: 'ระบบยังไม่ตั้ง Channel Access Token' });
        const msg = `🔔 ทดสอบการแจ้งเตือนจาก super_admin\nสวัสดี คุณ${rows[0].firstname} ${rows[0].lastname}\n✅ การเชื่อมต่อ LINE สำเร็จ`;
        const r = await sendLineDirect(ns.lineToken, rows[0].line_user_id, msg);
        res.json({ success: r.ok, message: r.ok ? 'ส่งสำเร็จ' : (r.error || 'ส่งไม่สำเร็จ — userId อาจไม่ได้ Add friend bot') });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === Test Admin Email (super_admin) ===
apiRouter.post('/test-admin-email', authenticateToken, isSuperAdmin, async (req, res) => {
    const { emails } = req.body;
    if (!emails) return res.status(400).json({ success: false, message: 'กรุณากรอก Email' });
    const list = emails.split(',').map(e => e.trim()).filter(Boolean);
    if (list.length === 0) return res.status(400).json({ success: false, message: 'ไม่มี Email ที่ถูกต้อง' });
    for (const email of list) {
        sendMail(email, '🔔 ทดสอบการแจ้งเตือน — ระบบ KPI สสจ.นครราชสีมา',
            `<div style="font-family:Sarabun,sans-serif;max-width:400px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:#16a34a;padding:16px;text-align:center;color:white"><h3 style="margin:0">🔔 ทดสอบการแจ้งเตือน</h3></div>
                <div style="padding:20px;text-align:center"><p>การเชื่อมต่อ Email สำเร็จ!</p><p style="color:#6b7280;font-size:13px">ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา</p></div>
            </div>`
        );
    }
    res.json({ success: true, message: `ส่ง Email ทดสอบไปที่ ${list.length} ที่อยู่แล้ว` });
});

// === Database Backup (super_admin เท่านั้น) ===
apiRouter.get('/backup-database', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const tables = [
            'users', 'departments', 'kpi_indicators', 'kpi_main_indicators', 'main_yut',
            'kpi_results', 'chospital', 'co_district', 'system_settings', 'notifications',
            'kpi_rejection_comments', 'kpi_form_schemas', 'kpi_form_fields',
            'target_edit_requests', 'login_logs', 'system_logs'
        ];
        const backup = {};
        for (const table of tables) {
            try {
                const [rows] = await db.query(`SELECT * FROM \`${table}\``);
                backup[table] = { count: rows.length, data: rows };
            } catch (e) { backup[table] = { count: 0, data: [], error: e.message }; }
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `khups_kpi_backup_${timestamp}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json({ backup_date: new Date().toISOString(), db_name: process.env.DB_NAME, tables: backup });

        try {
            await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
                [req.user.userId, 'BACKUP', 'ALL', JSON.stringify({ tables: tables.length, filename }), req.ip]);
        } catch (_) {}
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /backup-kpi-data — สำรองเฉพาะข้อมูลผลงาน (kpi_results + form_ tables)
apiRouter.get('/backup-kpi-data', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const backup = {};
        const [kpiRows] = await db.query('SELECT * FROM kpi_results');
        backup['kpi_results'] = { count: kpiRows.length, data: kpiRows };
        const [formTables] = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'form_%'");
        for (const t of formTables) {
            try {
                const [rows] = await db.query(`SELECT * FROM \`${t.table_name}\``);
                backup[t.table_name] = { count: rows.length, data: rows };
            } catch (e) { backup[t.table_name] = { count: 0, data: [], error: e.message }; }
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="kpi_data_backup_${timestamp}.json"`);
        res.json({ backup_date: new Date().toISOString(), tables: backup });
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_KPI_DATA', 'kpi_results', JSON.stringify({ tables: Object.keys(backup).length }), req.ip]); } catch (_) {}
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /clear-kpi-data — ล้างข้อมูลผลงานทั้งหมด (kpi_results + form_ data)
apiRouter.post('/clear-kpi-data', authenticateToken, isSuperAdmin, async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [kpiResult] = await connection.query('DELETE FROM kpi_results');
        const [formTables] = await connection.query("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'form_%'");
        let formCleared = 0;
        for (const t of formTables) {
            try { await connection.query(`DELETE FROM \`${t.table_name}\``); formCleared++; } catch (_) {}
        }
        await connection.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'CLEAR_KPI_DATA', 'kpi_results', JSON.stringify({ kpi_results_deleted: kpiResult.affectedRows, form_tables_cleared: formCleared }), req.ip]);
        await connection.commit();
        res.json({ success: true, message: `ลบข้อมูลสำเร็จ — kpi_results: ${kpiResult.affectedRows} rows, form tables: ${formCleared} ตาราง` });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally { connection.release(); }
});

// ========================================================================
// ========== Database Backup & Restore Module (Phase 1) =================
// ========================================================================
// รองรับ: Manual backup/restore, Multi-DB Connection Manager, mysqldump streaming + gzip
// ผ่าน super_admin เท่านั้น
// ========================================================================
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');


// Debug: ตรวจสอบ env + binary + timezone
apiRouter.get('/backup/system-info', authenticateToken, isSuperAdmin, async (req, res) => {
    const _now = new Date();
    const _bkkFmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false
    });
    const bkkParts = _bkkFmt.formatToParts(_now);
    const bkkTime = bkkParts.map(p => p.type === 'literal' ? p.value : p.value).join('');
    res.json({
        success: true,
        platform: process.platform,
        node_version: process.version,
        cwd: process.cwd(),
        backup_dir: BACKUP_DIR,
        backup_dir_exists: fs.existsSync(BACKUP_DIR),
        mysql_bin: MYSQL_BIN,
        mysql_bin_exists: fs.existsSync(MYSQL_BIN),
        mysqldump_bin: MYSQLDUMP_BIN,
        mysqldump_bin_exists: fs.existsSync(MYSQLDUMP_BIN),
        env_NODE_ENV: process.env.NODE_ENV || '(unset)',
        // === Timezone diagnostics ===
        timezone: {
            env_TZ: process.env.TZ || '(unset)',
            getTimezoneOffset_min: _now.getTimezoneOffset(),
            utc_offset_hours: -_now.getTimezoneOffset() / 60,
            local_time: _now.toString(),
            local_iso: _now.toISOString(),
            bangkok_time: bkkTime,
            using_bangkok_explicit: true,
            note: 'Scheduler ใช้ Intl.DateTimeFormat กับ Asia/Bangkok เสมอ — ไม่ขึ้นกับ process timezone'
        }
    });
});

// ========== Connection Manager ==========
apiRouter.get('/backup/connections', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, name, host, port, db_user, db_name, description, is_default, created_at, updated_at
             FROM backup_connections ORDER BY is_default DESC, id ASC`
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/connections', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { name, host, port, db_user, db_password, db_name, description, is_default } = req.body || {};
        if (!name || !host || !db_user || !db_name) {
            return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ (name/host/db_user/db_name)' });
        }
        const pwEnc = bkEncrypt(db_password || '');
        if (is_default) await db.query('UPDATE backup_connections SET is_default = 0');
        const [r] = await db.query(
            `INSERT INTO backup_connections (name, host, port, db_user, db_password_enc, db_name, description, is_default, created_by)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [name, host, Number(port) || 3306, db_user, pwEnc, db_name, description || null, is_default ? 1 : 0, req.user.userId]
        );
        res.json({ success: true, id: r.insertId, message: 'เพิ่ม connection สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/backup/connections/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { name, host, port, db_user, db_password, db_name, description, is_default } = req.body || {};
        const cur = await getBackupConnection(id);
        if (!cur) return res.status(404).json({ success: false, message: 'ไม่พบ connection' });
        // ถ้าไม่ส่ง password มาให้คงของเดิม
        const pwEnc = (db_password !== undefined && db_password !== null && db_password !== '')
            ? bkEncrypt(db_password) : cur.db_password_enc;
        if (is_default) await db.query('UPDATE backup_connections SET is_default = 0');
        await db.query(
            `UPDATE backup_connections SET name=?, host=?, port=?, db_user=?, db_password_enc=?, db_name=?, description=?, is_default=? WHERE id=?`,
            [name || cur.name, host || cur.host, Number(port) || cur.port, db_user || cur.db_user, pwEnc,
             db_name || cur.db_name, description ?? cur.description, is_default ? 1 : 0, id]
        );
        res.json({ success: true, message: 'แก้ไข connection สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/backup/connections/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [files] = await db.query('SELECT COUNT(*) AS c FROM backup_files WHERE connection_id = ?', [id]);
        if (files[0].c > 0) {
            return res.status(400).json({ success: false, message: `ลบไม่ได้ — มี backup files ${files[0].c} ไฟล์ผูกอยู่` });
        }
        await db.query('DELETE FROM backup_connections WHERE id = ? AND is_default = 0', [id]);
        res.json({ success: true, message: 'ลบ connection สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /backup/connections/:id/test — ทดสอบเชื่อมต่อ (ใช้ mysql client)
apiRouter.post('/backup/connections/:id/test', authenticateToken, isSuperAdmin, async (req, res) => {
    let responded = false;
    const safeJson = (status, body) => { if (responded) return; responded = true; res.status(status).json(body); };
    try {
        const id = Number(req.params.id);
        const conn = await getBackupConnection(id);
        if (!conn) return safeJson(404, { success: false, message: 'ไม่พบ connection' });
        const args = [
            ...buildConnectArgs(conn),
            `-e`,
            `SELECT 1 AS ok, VERSION() AS version, NOW() AS server_time`,
            conn.db_name,
            '--connect-timeout=8',
            '--silent'
        ];
        const env = { ...process.env };
        if (conn.db_password) env.MYSQL_PWD = conn.db_password;
        let proc;
        try {
            proc = spawn(MYSQL_BIN, args, { env });
        } catch (e) {
            return safeJson(500, { success: false, message: `ไม่สามารถเรียก mysql client ('${MYSQL_BIN}') — ตั้งค่า ENV MYSQL_BIN เป็น path เต็ม (เช่น C:\\xampp\\mysql\\bin\\mysql.exe)`, error: e.message });
        }
        let out = '', err = '';
        proc.stdout.on('data', (d) => out += d.toString());
        proc.stderr.on('data', (d) => err += d.toString());
        const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} safeJson(408, { success: false, message: 'timeout' }); }, 12000);
        proc.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) safeJson(200, { success: true, message: 'เชื่อมต่อสำเร็จ', output: out.trim() });
            else safeJson(400, { success: false, message: 'เชื่อมต่อล้มเหลว', error: cleanStderr(err), exit_code: code });
        });
        proc.on('error', (e) => {
            clearTimeout(timeout);
            safeJson(500, { success: false, message: `ไม่สามารถเรียก mysql client ('${MYSQL_BIN}') — ตั้งค่า ENV MYSQL_BIN เป็น path เต็ม (Windows dev: เช่น C:\\xampp\\mysql\\bin\\mysql.exe)`, error: e.message });
        });
    } catch (e) { safeJson(500, { success: false, message: e.message }); }
});

// POST /backup/connections/:id/verify-privileges — ตรวจสอบสิทธิ์ user ก่อน backup
apiRouter.post('/backup/connections/:id/verify-privileges', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const conn = await getBackupConnection(Number(req.params.id));
        if (!conn) return res.status(404).json({ success: false, message: 'ไม่พบ connection' });
        const result = await verifyBackupPrivileges(conn);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== Manual Backup ==========
// POST /backup/run  body: { connection_id, compress?:true, skip_privilege_check?:false }
// Response (immediate): { success, job_id }  — frontend polls GET /backup/jobs/:id
apiRouter.post('/backup/run', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { connection_id, compress = true, trigger_type = 'manual', skip_privilege_check = false } = req.body || {};
        const conn = await getBackupConnection(Number(connection_id));
        if (!conn) return res.status(404).json({ success: false, message: 'ไม่พบ connection' });

        // === ตรวจ privilege ก่อน — ถ้า user ขาดสิทธิ์ขัด backup ตั้งแต่ต้น ===
        if (!skip_privilege_check) {
            const priv = await verifyBackupPrivileges(conn);
            if (!priv.ok) {
                return res.status(400).json({
                    success: false,
                    code: 'PRIVILEGE_CHECK_FAILED',
                    message: priv.error,
                    hint: 'แก้ไข Connection ให้ใช้ user ที่มีสิทธิ์ SELECT บน DB นี้ (เช่น root) หรือกด "ข้ามการตรวจ" เพื่อ backup เลย'
                });
            }
        }

        // สร้าง job record
        const [r] = await db.query(
            `INSERT INTO backup_jobs (connection_id, connection_name, db_name, status, trigger_type, started_at, created_by)
             VALUES (?,?,?, 'running', ?, NOW(), ?)`,
            [conn.id, conn.name, conn.db_name, trigger_type, req.user.userId]
        );
        const jobId = r.insertId;
        const userId = req.user.userId;
        const reqIp = req.ip;

        // ตอบ jobId กลับทันที — work ทำใน background
        res.json({ success: true, job_id: jobId, message: 'เริ่ม backup แล้ว — poll /backup/jobs/:id เพื่อดู progress' });

        // === Background work ===
        runBackupJob(jobId, conn, compress, trigger_type, userId, reqIp).catch((e) => {
            console.error(`[Backup] job ${jobId} failed:`, e.message);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// ========== Files ==========
apiRouter.get('/backup/files', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { connection_id, limit = 100 } = req.query;
        const params = [];
        let where = 'WHERE 1=1';
        if (connection_id) { where += ' AND connection_id = ?'; params.push(Number(connection_id)); }
        params.push(Math.min(Number(limit) || 100, 500));
        const [rows] = await db.query(
            `SELECT id, connection_id, connection_name, db_name, file_name, size_bytes, compressed, checksum_sha256,
                    trigger_type, created_by, created_at,
                    (log_path IS NOT NULL) AS has_log,
                    cloud_provider, cloud_url, cloud_uploaded_at, cloud_size_bytes
             FROM backup_files ${where} ORDER BY created_at DESC LIMIT ?`,
            params
        );
        // ตรวจ disk usage
        let diskInfo = null;
        try {
            const stats = await fsp.statfs(BACKUP_DIR);
            diskInfo = {
                total_bytes: stats.blocks * stats.bsize,
                free_bytes: stats.bfree * stats.bsize,
                available_bytes: stats.bavail * stats.bsize
            };
        } catch (e) { /* statfs not available on all platforms */ }
        res.json({ success: true, data: rows, backup_dir: BACKUP_DIR, disk: diskInfo });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /backup/jobs/:id — สำหรับ frontend polling progress
apiRouter.get('/backup/jobs/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM backup_jobs WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ job' });
        const j = rows[0];
        let elapsed_ms = null;
        if (j.started_at) {
            elapsed_ms = (j.finished_at ? new Date(j.finished_at) : new Date()).getTime() - new Date(j.started_at).getTime();
        }
        res.json({ success: true, data: { ...j, elapsed_ms } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/backup/jobs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const [rows] = await db.query(
            `SELECT id, connection_id, connection_name, db_name, status, trigger_type, file_id,
                    started_at, finished_at, duration_ms, size_bytes, error_msg, created_by, created_at
             FROM backup_jobs ORDER BY id DESC LIMIT ?`,
            [Math.min(Number(limit) || 50, 200)]
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Download backup file (stream)
apiRouter.get('/backup/files/:id/download', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        if (!fs.existsSync(f.file_path)) return res.status(404).json({ success: false, message: 'ไฟล์หายไปจากดิสก์' });
        res.setHeader('Content-Type', f.compressed ? 'application/gzip' : 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${f.file_name}"`);
        res.setHeader('Content-Length', f.size_bytes);
        fs.createReadStream(f.file_path).pipe(res);
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_DOWNLOAD', 'backup_files', JSON.stringify({ id, file_name: f.file_name }), req.ip]); } catch (_) {}
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET log content for backup file (text)
apiRouter.get('/backup/files/:id/log', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT log_path, file_name FROM backup_files WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0 || !rows[0].log_path) return res.status(404).json({ success: false, message: 'ไม่มี log file' });
        if (!fs.existsSync(rows[0].log_path)) return res.status(404).json({ success: false, message: 'log file หายจากดิสก์' });
        const content = await fsp.readFile(rows[0].log_path, 'utf8');
        const wantDownload = req.query.download === '1';
        if (wantDownload) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rows[0].log_path)}"`);
            return res.send(content);
        }
        res.json({ success: true, file_name: rows[0].file_name, log_content: content });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET log content for restore job (text)
apiRouter.get('/backup/restore-jobs/:id/log', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT log_path, target_db FROM restore_jobs WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0 || !rows[0].log_path) return res.status(404).json({ success: false, message: 'ไม่มี log file' });
        if (!fs.existsSync(rows[0].log_path)) return res.status(404).json({ success: false, message: 'log file หายจากดิสก์' });
        const content = await fsp.readFile(rows[0].log_path, 'utf8');
        const wantDownload = req.query.download === '1';
        if (wantDownload) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rows[0].log_path)}"`);
            return res.send(content);
        }
        res.json({ success: true, target_db: rows[0].target_db, log_content: content });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/backup/files/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const deleteCloud = req.query.delete_cloud === '1' || req.query.delete_cloud === 'true';
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        try { if (fs.existsSync(f.file_path)) await fsp.unlink(f.file_path); } catch (e) { /* ignore */ }
        try { if (f.log_path && fs.existsSync(f.log_path)) await fsp.unlink(f.log_path); } catch (e) { /* ignore */ }
        if (deleteCloud && f.cloud_file_id) {
            try { await deleteFileFromDrive(f.cloud_file_id); } catch (e) {
                console.warn('[Cloud] delete from drive during file delete failed:', e.message);
            }
        }
        await db.query('DELETE FROM backup_files WHERE id = ?', [id]);
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_DELETE', 'backup_files', JSON.stringify({ id, file_name: f.file_name }), req.ip]); } catch (_) {}
        res.json({ success: true, message: 'ลบไฟล์สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== Restore Jobs Polling ==========
apiRouter.get('/backup/restore-jobs/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM restore_jobs WHERE id = ?', [Number(req.params.id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ job' });
        const j = rows[0];
        let elapsed_ms = null;
        if (j.started_at) {
            elapsed_ms = (j.finished_at ? new Date(j.finished_at) : new Date()).getTime() - new Date(j.started_at).getTime();
        }
        const percent = j.total_bytes > 0 ? Math.min(100, Math.round((j.progress_bytes / j.total_bytes) * 100)) : 0;
        res.json({ success: true, data: { ...j, elapsed_ms, percent } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== Restore ==========
// POST /backup/restore  body: { file_id, mode, target_db?, auto_backup_first?:true }
// Response: { success, restore_job_id } — poll GET /backup/restore-jobs/:id
apiRouter.post('/backup/restore', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { file_id, mode, target_db, auto_backup_first = true } = req.body || {};
        if (!['new_db', 'replace'].includes(mode)) {
            return res.status(400).json({ success: false, message: 'mode ต้องเป็น new_db หรือ replace' });
        }
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [Number(file_id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        if (!fs.existsSync(f.file_path)) return res.status(404).json({ success: false, message: 'ไฟล์หายจากดิสก์' });

        const conn = await getBackupConnection(f.connection_id);
        if (!conn) return res.status(404).json({ success: false, message: 'ไม่พบ connection เดิม' });

        // กำหนด target DB
        let dbTarget;
        if (mode === 'new_db') {
            const ts = bangkokTimestamp(new Date(), 'compact'); // 14-digit Bangkok time
            dbTarget = target_db && isValidIdent(target_db) ? target_db : `${conn.db_name}_restore_${ts}`;
            if (!isValidIdent(dbTarget)) {
                return res.status(400).json({ success: false, message: 'target_db ไม่ถูกต้อง (a-z, 0-9, _ เท่านั้น)' });
            }
        } else {
            dbTarget = conn.db_name;
        }

        // === สร้าง restore_jobs record + return ทันที ===
        const [rj] = await db.query(
            `INSERT INTO restore_jobs (file_id, source_file_name, connection_id, target_db, mode, status, total_bytes, started_at, phase, created_by)
             VALUES (?,?,?,?,?, 'running', ?, NOW(), ?, ?)`,
            [f.id, f.file_name, f.connection_id, dbTarget, mode, f.size_bytes, 'starting', req.user.userId]
        );
        const restoreJobId = rj.insertId;
        const userId = req.user.userId;
        const reqIp = req.ip;

        res.json({ success: true, restore_job_id: restoreJobId, target_db: dbTarget, message: 'เริ่ม Restore แล้ว — poll /backup/restore-jobs/:id' });

        // === Background work ===
        runRestoreJob(restoreJobId, f, conn, mode, dbTarget, auto_backup_first, userId, reqIp).catch((e) => {
            console.error(`[Restore] job ${restoreJobId} failed:`, e.message);
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// ========== Backup Schedules CRUD ==========
apiRouter.get('/backup/schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT s.*, c.name AS connection_name, c.db_name, c.host AS conn_host
            FROM backup_schedules s
            LEFT JOIN backup_connections c ON s.connection_id = c.id
            ORDER BY s.id DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.name || !b.connection_id || !b.days_of_week || !b.time_of_day) {
            return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ (name/connection_id/days_of_week/time_of_day)' });
        }
        const [r] = await db.query(
            `INSERT INTO backup_schedules
             (name, is_enabled, connection_id, days_of_week, time_of_day, compress, retention_days,
              notify_email, notify_email_on_success, notify_email_on_failure,
              notify_telegram, notify_telegram_on_success, notify_telegram_on_failure,
              notify_line, notify_line_on_success, notify_line_on_failure,
              auto_upload_cloud, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [b.name, b.is_enabled ? 1 : 0, Number(b.connection_id), b.days_of_week, b.time_of_day,
             b.compress !== false ? 1 : 0, Number(b.retention_days) || 30,
             b.notify_email ? 1 : 0, b.notify_email_on_success !== false ? 1 : 0, b.notify_email_on_failure !== false ? 1 : 0,
             b.notify_telegram ? 1 : 0, b.notify_telegram_on_success !== false ? 1 : 0, b.notify_telegram_on_failure !== false ? 1 : 0,
             b.notify_line ? 1 : 0, b.notify_line_on_success !== false ? 1 : 0, b.notify_line_on_failure !== false ? 1 : 0,
             b.auto_upload_cloud ? 1 : 0,
             req.user.userId]
        );
        res.json({ success: true, id: r.insertId, message: 'สร้าง schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/backup/schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        await db.query(
            `UPDATE backup_schedules SET name=?, is_enabled=?, connection_id=?, days_of_week=?, time_of_day=?, compress=?, retention_days=?,
             notify_email=?, notify_email_on_success=?, notify_email_on_failure=?,
             notify_telegram=?, notify_telegram_on_success=?, notify_telegram_on_failure=?,
             notify_line=?, notify_line_on_success=?, notify_line_on_failure=?,
             auto_upload_cloud=?
             WHERE id=?`,
            [b.name, b.is_enabled ? 1 : 0, Number(b.connection_id), b.days_of_week, b.time_of_day,
             b.compress !== false ? 1 : 0, Number(b.retention_days) || 30,
             b.notify_email ? 1 : 0, b.notify_email_on_success !== false ? 1 : 0, b.notify_email_on_failure !== false ? 1 : 0,
             b.notify_telegram ? 1 : 0, b.notify_telegram_on_success !== false ? 1 : 0, b.notify_telegram_on_failure !== false ? 1 : 0,
             b.notify_line ? 1 : 0, b.notify_line_on_success !== false ? 1 : 0, b.notify_line_on_failure !== false ? 1 : 0,
             b.auto_upload_cloud ? 1 : 0,
             Number(req.params.id)]
        );
        res.json({ success: true, message: 'แก้ไข schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/backup/schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM backup_schedules WHERE id=?', [Number(req.params.id)]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/schedules/:id/run-now', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM backup_schedules WHERE id=?', [Number(req.params.id)]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ schedule' });
        // Lock + รันแบบ async ใน background
        await db.query('UPDATE backup_schedules SET last_run_at=NOW() WHERE id=?', [rows[0].id]);
        runScheduledBackup(rows[0]).catch(e => console.error('[Scheduler] manual run-now error:', e.message));
        res.json({ success: true, message: 'เริ่ม backup แล้ว — ดู Files tab + Logs ภายในไม่กี่นาที' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/backup/schedules/:id/logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM backup_schedule_logs WHERE schedule_id=? ORDER BY id DESC LIMIT 100',
            [Number(req.params.id)]
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /backup/schedules/test-notification — ทดสอบการส่ง notification
apiRouter.post('/backup/schedules/test-notification', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const testResult = {
            status: 'success',
            connection_name: 'Test Connection',
            db_name: 'test_db',
            file_name: 'test_backup_' + Date.now() + '.sql.gz',
            size_bytes: 1024 * 1024,
            total_inserts: 12345,
            tables_count: 39,
            duration_ms: 2500,
            cleaned_up_files: 0,
            cleaned_up_bytes: 0,
            warnings: []
        };
        const testSchedule = {
            name: 'TEST NOTIFICATION',
            notify_email: req.body.email !== false,
            notify_email_on_success: true,
            notify_email_on_failure: true,
            notify_telegram: req.body.telegram !== false,
            notify_telegram_on_success: true,
            notify_telegram_on_failure: true
        };
        const notif = await notifyBackupResult(testSchedule, testResult);
        res.json({ success: true, ...notif, message: 'ส่งทดสอบแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========================================================================
// =========== Phase 3: Cloud Upload (Google Drive) + Monitor =============
// ========================================================================
const { google } = require('googleapis');


// === OAuth State Map (CSRF protection) — 10 นาที TTL ===
const _gdriveStateMap = new Map();
const GDRIVE_STATE_TTL = 10 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _gdriveStateMap.entries()) {
        if (v.expiry < now) _gdriveStateMap.delete(k);
    }
}, 60 * 1000);


// === Cloud Settings endpoints ===
apiRouter.get('/backup/cloud/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const cfg = await getDriveSettings();
        res.json({
            success: true,
            enabled: cfg.enabled,
            client_id: cfg.clientId,
            has_client_secret: !!cfg.clientSecret,
            has_refresh_token: !!cfg.refreshToken,
            user_email: cfg.userEmail,
            redirect_uri: cfg.redirectUri,
            folder_id: cfg.folderId,
            folder_name: cfg.folderName,
            // hint สำหรับ frontend: ต้อง config อะไรบ้าง
            needs_credentials: !cfg.clientId || !cfg.clientSecret,
            needs_authorization: !cfg.refreshToken
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/cloud/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { enabled, client_id, client_secret, redirect_uri, folder_id, folder_name } = req.body || {};
        const updates = [
            ['gdrive_enabled', enabled ? 'true' : 'false'],
            ['gdrive_client_id', client_id || ''],
            ['gdrive_redirect_uri', redirect_uri || ''],
            ['gdrive_folder_id', folder_id || ''],
            ['gdrive_folder_name', folder_name || '']
        ];
        // client_secret: ถ้าส่งมา → encrypt + save; ถ้าไม่ส่ง คงค่าเดิม
        if (client_secret !== undefined && client_secret !== null && client_secret !== '') {
            updates.push(['gdrive_client_secret_enc', bkEncrypt(client_secret)]);
        }
        for (const [k, v] of updates) {
            await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, v, v]);
        }
        resetDriveClientCache();
        res.json({ success: true, message: 'บันทึก settings สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// === OAuth 2.0 Flow ===
// POST /backup/cloud/oauth/auth-url — สร้าง Google consent URL (authenticated)
apiRouter.post('/backup/cloud/oauth/auth-url', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const cfg = await getDriveSettings();
        if (!cfg.clientId || !cfg.clientSecret) {
            return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้ง Client ID/Secret' });
        }
        if (!cfg.redirectUri) {
            return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้ง Redirect URI (ต้องตรงกับใน Google Cloud Console)' });
        }
        // state CSRF — random + เก็บ userId เพื่อตรวจสอบ
        const state = crypto.randomBytes(24).toString('hex');
        _gdriveStateMap.set(state, { userId: req.user.userId, expiry: Date.now() + GDRIVE_STATE_TTL });

        const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
        const authUrl = oauth2.generateAuthUrl({
            access_type: 'offline',           // ขอ refresh_token
            prompt: 'consent',                // บังคับ consent ทุกครั้ง (กัน Google ไม่ส่ง refresh_token รอบ 2)
            scope: [
                'https://www.googleapis.com/auth/drive.file',     // เข้าถึงไฟล์ที่แอปสร้าง/เปิด
                'https://www.googleapis.com/auth/userinfo.email'  // ดึง email user
            ],
            state
        });
        res.json({ success: true, auth_url: authUrl, state });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /backup/cloud/oauth/callback — Google redirect กลับมาที่นี่ (public, ไม่ต้อง auth)
apiRouter.get('/backup/cloud/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const buildHtml = (status, msg, detail = '') => `
<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><title>Google Drive — ${status}</title>
<style>body{font-family:sans-serif;text-align:center;padding:60px 20px;background:#f5f5f5}
.card{background:#fff;max-width:520px;margin:auto;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}
.ok{color:#10b981}.err{color:#dc2626}h1{margin:10px 0}p{color:#555;font-size:14px}
.close-hint{margin-top:24px;padding:12px;background:#f0fdf4;border-radius:8px;font-size:13px;color:#15803d}</style></head><body>
<div class="card">
<div style="font-size:48px" class="${status==='success'?'ok':'err'}">${status==='success'?'✓':'✗'}</div>
<h1>${msg}</h1><p>${detail}</p>
<div class="close-hint">คุณสามารถปิดหน้านี้แล้วกลับไปยังแอป — สถานะจะ refresh อัตโนมัติ</div>
</div></body></html>`;
    try {
        if (error) return res.send(buildHtml('error', 'การ authorize ถูกยกเลิก', String(error)));
        if (!code || !state) return res.send(buildHtml('error', 'พารามิเตอร์ไม่ครบ', 'missing code or state'));
        const stateInfo = _gdriveStateMap.get(state);
        if (!stateInfo || stateInfo.expiry < Date.now()) {
            return res.send(buildHtml('error', 'State ไม่ถูกต้องหรือหมดอายุ', 'ลอง Connect ใหม่อีกครั้ง'));
        }
        _gdriveStateMap.delete(state);

        const cfg = await getDriveSettings();
        const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
        const { tokens } = await oauth2.getToken(code);
        if (!tokens.refresh_token) {
            return res.send(buildHtml('error', 'Google ไม่ส่ง refresh_token กลับมา',
                'ลองไป <a href="https://myaccount.google.com/permissions">https://myaccount.google.com/permissions</a> ลบสิทธิ์เก่าออก แล้วลองใหม่'));
        }
        // ดึง email ของ user
        oauth2.setCredentials(tokens);
        let userEmail = '';
        try {
            const peopleRes = await google.oauth2({ version: 'v2', auth: oauth2 }).userinfo.get();
            userEmail = peopleRes.data.email || '';
        } catch (e) { /* ignore */ }

        // เก็บ refresh_token (encrypted) + email
        await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
            ['gdrive_refresh_token_enc', bkEncrypt(tokens.refresh_token), bkEncrypt(tokens.refresh_token)]);
        await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?',
            ['gdrive_user_email', userEmail, userEmail]);
        // auto-enable
        await db.query("UPDATE system_settings SET setting_value='true' WHERE setting_key='gdrive_enabled'");

        resetDriveClientCache();

        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [stateInfo.userId, 'GDRIVE_OAUTH_CONNECT', 'system_settings', JSON.stringify({ email: userEmail }), req.ip]); } catch (_) {}

        res.send(buildHtml('success', 'เชื่อมต่อ Google Drive สำเร็จ', `Account: <b>${userEmail || '(ไม่ทราบ)'}</b>`));
    } catch (e) {
        console.error('[OAuth] callback error:', e.message);
        res.send(buildHtml('error', 'OAuth ล้มเหลว', e.message));
    }
});

// POST /backup/cloud/disconnect — revoke refresh_token + clear
apiRouter.post('/backup/cloud/disconnect', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const cfg = await getDriveSettings();
        if (cfg.refreshToken) {
            // พยายาม revoke ที่ Google (best effort)
            try {
                const oauth2 = new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
                await oauth2.revokeToken(cfg.refreshToken);
            } catch (e) { console.warn('[OAuth] revoke failed (continuing):', e.message); }
        }
        await db.query("UPDATE system_settings SET setting_value='' WHERE setting_key IN ('gdrive_refresh_token_enc','gdrive_user_email')");
        await db.query("UPDATE system_settings SET setting_value='false' WHERE setting_key='gdrive_enabled'");
        resetDriveClientCache();
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'GDRIVE_OAUTH_DISCONNECT', 'system_settings', '{}', req.ip]); } catch (_) {}
        res.json({ success: true, message: 'Disconnect สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/backup/cloud/test', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const result = await testDriveConnection();
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// === Manual upload to cloud ===
apiRouter.post('/backup/files/:id/upload-cloud', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบไฟล์' });
        const f = rows[0];
        if (!fs.existsSync(f.file_path)) return res.status(404).json({ success: false, message: 'ไฟล์หายจากดิสก์' });
        if (f.cloud_file_id) return res.status(400).json({ success: false, message: 'ไฟล์นี้อัพโหลดไป cloud แล้ว' });

        const result = await uploadFileToDrive(f.file_path, f.file_name);
        await db.query(
            'UPDATE backup_files SET cloud_provider=?, cloud_file_id=?, cloud_url=?, cloud_uploaded_at=NOW(), cloud_size_bytes=? WHERE id=?',
            ['gdrive', result.file_id, result.web_url, result.size, id]
        );
        try { await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'BACKUP_CLOUD_UPLOAD', 'backup_files', JSON.stringify({ id, file_name: f.file_name, cloud_file_id: result.file_id }), req.ip]); } catch (_) {}
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.delete('/backup/files/:id/cloud', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const [rows] = await db.query('SELECT * FROM backup_files WHERE id = ?', [id]);
        if (rows.length === 0 || !rows[0].cloud_file_id) return res.status(404).json({ success: false, message: 'ไม่มี cloud file' });
        try { await deleteFileFromDrive(rows[0].cloud_file_id); } catch (e) {
            console.warn('[Cloud] delete from drive failed (continuing):', e.message);
        }
        await db.query('UPDATE backup_files SET cloud_provider=NULL, cloud_file_id=NULL, cloud_url=NULL, cloud_uploaded_at=NULL, cloud_size_bytes=NULL WHERE id=?', [id]);
        res.json({ success: true, message: 'ลบจาก cloud สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========================================================================
// ============== Monitor Dashboard endpoint ==============================
// ========================================================================
apiRouter.get('/backup/monitor', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const result = {
            timestamp: new Date().toISOString(),
            bangkok_time: bangkokTimestamp(new Date(), 'log')
        };

        // === 1. DB info ===
        try {
            const [versionRows] = await db.query("SELECT VERSION() AS version, @@hostname AS hostname, @@port AS port, DATABASE() AS current_db");
            const [uptimeRows] = await db.query("SHOW STATUS LIKE 'Uptime'");
            const [varsRows] = await db.query("SHOW VARIABLES WHERE Variable_name IN ('max_connections','wait_timeout','long_query_time')");
            const vars = {};
            for (const v of varsRows) vars[v.Variable_name] = v.Value;
            result.db = {
                version: versionRows[0].version,
                hostname: versionRows[0].hostname,
                port: versionRows[0].port,
                database: versionRows[0].current_db,
                uptime_seconds: Number(uptimeRows[0]?.Value) || 0,
                max_connections: Number(vars.max_connections) || 0,
                wait_timeout: Number(vars.wait_timeout) || 0,
                long_query_time: Number(vars.long_query_time) || 0
            };
        } catch (e) { result.db = { error: e.message }; }

        // === 2. Tables (size + rows) ===
        try {
            const [tables] = await db.query(`
                SELECT table_name, table_type, IFNULL(table_rows, 0) AS rows_approx,
                       IFNULL(data_length, 0) AS data_bytes, IFNULL(index_length, 0) AS index_bytes,
                       IFNULL(data_free, 0) AS free_bytes, update_time
                FROM INFORMATION_SCHEMA.TABLES
                WHERE table_schema = DATABASE()
                ORDER BY (IFNULL(data_length,0) + IFNULL(index_length,0)) DESC
            `);
            const totalData = tables.reduce((s, t) => s + Number(t.data_bytes || 0), 0);
            const totalIndex = tables.reduce((s, t) => s + Number(t.index_bytes || 0), 0);
            const totalRows = tables.reduce((s, t) => s + Number(t.rows_approx || 0), 0);
            result.tables = {
                count: tables.length,
                total_data_bytes: totalData,
                total_index_bytes: totalIndex,
                total_size_bytes: totalData + totalIndex,
                total_rows_approx: totalRows,
                list: tables.map(t => ({
                    name: t.table_name,
                    type: t.table_type,
                    rows: Number(t.rows_approx),
                    data_bytes: Number(t.data_bytes),
                    index_bytes: Number(t.index_bytes),
                    total_bytes: Number(t.data_bytes) + Number(t.index_bytes),
                    update_time: t.update_time
                }))
            };
        } catch (e) { result.tables = { error: e.message }; }

        // === 3. Pool status ===
        try {
            // mysql2 promise pool — เข้าถึง underlying pool ผ่าน .pool
            const underlying = db.pool || db;
            result.pool = {
                connection_limit: underlying.config?.connectionLimit || 0,
                queue_limit: underlying.config?.queueLimit || 0,
                total_connections: underlying._allConnections?.length ?? null,
                free_connections: underlying._freeConnections?.length ?? null,
                queued_requests: underlying._connectionQueue?.length ?? null,
                acquiring_connections: underlying._acquiringConnections?.length ?? null
            };
        } catch (e) { result.pool = { error: e.message }; }

        // === 4. Running processes / slow queries ===
        try {
            const [processes] = await db.query("SHOW FULL PROCESSLIST");
            const longQueryTime = result.db?.long_query_time || 1;
            const slow = processes
                .filter(p => p.Time >= Math.max(longQueryTime, 5) && p.Command !== 'Sleep')
                .slice(0, 10)
                .map(p => ({
                    id: p.Id, user: p.User, host: p.Host, db: p.db, command: p.Command,
                    time_seconds: p.Time, state: p.State, info: (p.Info || '').slice(0, 300)
                }));
            result.processes = {
                total: processes.length,
                active: processes.filter(p => p.Command !== 'Sleep').length,
                sleeping: processes.filter(p => p.Command === 'Sleep').length,
                slow_queries: slow
            };
        } catch (e) { result.processes = { error: e.message }; }

        // === 5. Disk usage (backup dir) ===
        try {
            const dirFiles = await fsp.readdir(BACKUP_DIR);
            let totalBackupBytes = 0;
            let backupFileCount = 0;
            let oldestFileTime = null, newestFileTime = null;
            for (const fname of dirFiles) {
                try {
                    const fpath = path.join(BACKUP_DIR, fname);
                    const st = await fsp.stat(fpath);
                    if (!st.isFile()) continue;
                    totalBackupBytes += st.size;
                    backupFileCount++;
                    if (!oldestFileTime || st.mtimeMs < oldestFileTime) oldestFileTime = st.mtimeMs;
                    if (!newestFileTime || st.mtimeMs > newestFileTime) newestFileTime = st.mtimeMs;
                } catch (_) {}
            }
            let diskStats = null;
            try {
                const sf = await fsp.statfs(BACKUP_DIR);
                diskStats = {
                    total_bytes: sf.blocks * sf.bsize,
                    free_bytes: sf.bfree * sf.bsize,
                    available_bytes: sf.bavail * sf.bsize,
                    used_bytes: (sf.blocks - sf.bfree) * sf.bsize
                };
            } catch (_) { /* statfs not available */ }
            result.disk = {
                backup_dir: BACKUP_DIR,
                file_count: backupFileCount,
                total_size_bytes: totalBackupBytes,
                oldest_file: oldestFileTime ? new Date(oldestFileTime).toISOString() : null,
                newest_file: newestFileTime ? new Date(newestFileTime).toISOString() : null,
                filesystem: diskStats
            };
        } catch (e) { result.disk = { error: e.message }; }

        // === 6. Backup summary (จากตาราง backup_files) ===
        try {
            const [summary] = await db.query(`
                SELECT
                    COUNT(*) AS total_files,
                    IFNULL(SUM(size_bytes), 0) AS total_size,
                    COUNT(CASE WHEN trigger_type='manual' THEN 1 END) AS manual_count,
                    COUNT(CASE WHEN trigger_type='scheduled' THEN 1 END) AS scheduled_count,
                    COUNT(CASE WHEN trigger_type='auto_before_restore' THEN 1 END) AS auto_count,
                    COUNT(CASE WHEN cloud_file_id IS NOT NULL THEN 1 END) AS cloud_uploaded
                FROM backup_files
            `);
            const [latest] = await db.query('SELECT id, file_name, size_bytes, created_at FROM backup_files ORDER BY id DESC LIMIT 1');
            result.backups = {
                ...summary[0],
                total_size: Number(summary[0].total_size),
                latest: latest[0] || null
            };
        } catch (e) { result.backups = { error: e.message }; }

        // === 7. Recent errors (จาก backup_jobs + restore_jobs) ===
        try {
            const [failedBackups] = await db.query(
                "SELECT id, connection_name, db_name, error_msg, created_at FROM backup_jobs WHERE status='failed' ORDER BY id DESC LIMIT 5"
            );
            const [failedRestores] = await db.query(
                "SELECT id, source_file_name, target_db, error_msg, created_at FROM restore_jobs WHERE status='failed' ORDER BY id DESC LIMIT 5"
            );
            result.recent_errors = {
                failed_backups: failedBackups,
                failed_restores: failedRestores
            };
        } catch (e) { result.recent_errors = { error: e.message }; }

        // === 8. Schedule status ===
        try {
            const [schedules] = await db.query(`
                SELECT s.id, s.name, s.is_enabled, s.last_run_at, s.last_status, s.time_of_day,
                       c.name AS connection_name
                FROM backup_schedules s
                LEFT JOIN backup_connections c ON s.connection_id = c.id
                ORDER BY s.id DESC
            `);
            result.schedules = {
                total: schedules.length,
                enabled: schedules.filter(s => s.is_enabled).length,
                list: schedules
            };
        } catch (e) { result.schedules = { error: e.message }; }

        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========================================================================
// ====== KPI Save Audit + Daily Digest Notification (Phase 4 add-on) ======
// ========================================================================

// Cache audit settings (refresh ทุก 60 วินาที กัน query DB ทุก save)
let _auditSettingsCache = null;
let _auditSettingsExpiry = 0;
async function getAuditSettings() {
    const now = Date.now();
    if (_auditSettingsCache && _auditSettingsExpiry > now) return _auditSettingsCache;
    try {
        const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'kpi_audit_%'");
        const s = {};
        for (const r of rows) s[r.setting_key] = r.setting_value;
        _auditSettingsCache = {
            enabled: s.kpi_audit_enabled !== 'false',
            digestEnabled: s.kpi_audit_digest_enabled !== 'false',
            digestTime: s.kpi_audit_digest_time || '17:00',
            digestEmail: s.kpi_audit_digest_email !== 'false',
            digestTelegram: s.kpi_audit_digest_telegram !== 'false',
            digestLine: s.kpi_audit_digest_line !== 'false',
            minRecords: parseInt(s.kpi_audit_digest_min_records) || 1,
            lastDigestAt: s.kpi_audit_last_digest_at || '',
            lastDigestResult: s.kpi_audit_last_digest_result || ''
        };
        _auditSettingsExpiry = now + 60 * 1000;
        return _auditSettingsCache;
    } catch (e) {
        return { enabled: false, digestEnabled: false };
    }
}

// Fire-and-forget audit logger (ไม่ throw, ไม่ block save endpoint)
async function logKpiSaveAudit(meta) {
    try {
        const cfg = await getAuditSettings();
        if (!cfg.enabled) return;
        await db.query(
            `INSERT INTO kpi_save_audit
             (user_id, username, full_name, dept_id, dept_name, hospcode, hospname,
              action_type, indicator_id, indicator_name, year_bh, month_bh, table_name, row_count, summary, ip_address)
             VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`,
            [meta.user_id || null, meta.username || null, meta.full_name || null,
             meta.dept_id || null, meta.dept_name || null, meta.hospcode || null, meta.hospname || null,
             meta.action_type, meta.indicator_id || null, meta.indicator_name || null,
             meta.year_bh || null, meta.month_bh || null, meta.table_name || null,
             meta.row_count || 1, meta.summary || null, meta.ip_address || null]
        );
    } catch (e) {
        // ไม่ throw — audit log ห้ามทำ save endpoint พัง
        console.warn('[KPI Audit] log failed (continuing):', e.message);
    }
}

// Helper: ดึงข้อมูล user แบบเต็ม (full_name, dept_name, hospname) จาก userId
async function getUserAuditInfo(userId) {
    try {
        const [rows] = await db.query(`
            SELECT u.id, u.username, u.firstname, u.lastname, u.dept_id, u.hospcode,
                   d.dept_name, h.hosname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            WHERE u.id = ?
        `, [userId]);
        if (rows.length === 0) return null;
        const u = rows[0];
        return {
            user_id: u.id,
            username: u.username,
            full_name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username,
            dept_id: u.dept_id,
            dept_name: u.dept_name,
            hospcode: u.hospcode,
            hospname: u.hosname
        };
    } catch (e) { return null; }
}

// ===== Daily digest function =====
async function runKpiAuditDigest(manual = false) {
    const cfg = await getAuditSettings();
    if (!manual && !cfg.digestEnabled) return { skipped: true, reason: 'digest_disabled' };

    // ดึงรายการที่ยัง notified_at IS NULL
    const [records] = await db.query(`
        SELECT * FROM kpi_save_audit
        WHERE notified_at IS NULL
        ORDER BY created_at ASC
    `);
    if (records.length < cfg.minRecords) {
        return { skipped: true, reason: 'below_minimum', records_count: records.length, min: cfg.minRecords };
    }

    // Group by user
    const byUser = new Map();
    for (const r of records) {
        const key = r.user_id || 'unknown';
        if (!byUser.has(key)) {
            byUser.set(key, {
                user_id: r.user_id,
                full_name: r.full_name || r.username || 'Unknown',
                dept_name: r.dept_name || '-',
                hospname: r.hospname || '-',
                kpi_count: 0, sub_count: 0, dynamic_count: 0,
                indicators: new Map(),
                first_at: r.created_at, last_at: r.created_at
            });
        }
        const u = byUser.get(key);
        if (r.action_type === 'kpi_results') u.kpi_count += r.row_count || 1;
        else if (r.action_type === 'sub_results' || r.action_type === 'hierarchy_results') u.sub_count += r.row_count || 1;
        else if (r.action_type === 'dynamic_form') u.dynamic_count += r.row_count || 1;
        if (r.indicator_name) {
            const k = r.indicator_name;
            u.indicators.set(k, (u.indicators.get(k) || 0) + (r.row_count || 1));
        }
        if (new Date(r.created_at) > new Date(u.last_at)) u.last_at = r.created_at;
        if (new Date(r.created_at) < new Date(u.first_at)) u.first_at = r.created_at;
    }

    const usersList = Array.from(byUser.values()).sort((a, b) =>
        (b.kpi_count + b.sub_count + b.dynamic_count) - (a.kpi_count + a.sub_count + a.dynamic_count)
    );
    const totalSaves = records.length;
    const totalUsers = usersList.length;

    // Build messages
    const dateStr = bangkokTimestamp(new Date(), 'log').split(' ')[0];
    const subject = `📊 สรุปการบันทึกข้อมูล KPI ประจำวัน (${dateStr})`;

    // HTML email
    let html = `<h2>📊 สรุปการบันทึกข้อมูล KPI ประจำวัน</h2>`;
    html += `<p><b>วันที่:</b> ${dateStr}</p>`;
    html += `<p><b>ผู้ใช้งานที่บันทึก:</b> ${totalUsers} คน · <b>รายการบันทึกทั้งหมด:</b> ${totalSaves.toLocaleString()} รายการ</p>`;
    html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">`;
    html += `<thead style="background:#10b981;color:#fff"><tr>
        <th>#</th><th>ผู้ใช้</th><th>หน่วยงาน</th><th>หน่วยบริการ</th>
        <th>KPI หลัก</th><th>Sub</th><th>Dynamic Form</th><th>รวม</th>
    </tr></thead><tbody>`;
    usersList.forEach((u, i) => {
        const total = u.kpi_count + u.sub_count + u.dynamic_count;
        html += `<tr>
            <td>${i+1}</td>
            <td><b>${u.full_name}</b></td>
            <td>${u.dept_name}</td>
            <td>${u.hospname}</td>
            <td align="right">${u.kpi_count.toLocaleString()}</td>
            <td align="right">${u.sub_count.toLocaleString()}</td>
            <td align="right">${u.dynamic_count.toLocaleString()}</td>
            <td align="right"><b>${total.toLocaleString()}</b></td>
        </tr>`;
    });
    html += `</tbody></table>`;
    // Top indicators
    const allIndicators = new Map();
    for (const u of usersList) {
        for (const [ind, cnt] of u.indicators) {
            allIndicators.set(ind, (allIndicators.get(ind) || 0) + cnt);
        }
    }
    const topInd = Array.from(allIndicators.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (topInd.length > 0) {
        html += `<h3 style="margin-top:20px">🔝 ตัวชี้วัดที่ถูกบันทึกมากสุด (10 อันดับ)</h3>`;
        html += `<ol style="font-size:13px">`;
        for (const [ind, cnt] of topInd) html += `<li>${ind} — <b>${cnt.toLocaleString()}</b> ครั้ง</li>`;
        html += `</ol>`;
    }
    html += `<div style="margin-top:24px;padding:14px;background:#fef3c7;border-left:4px solid #f59e0b;color:#92400e;font-size:13px">
        💡 <b>แนะนำสำหรับ super_admin:</b> มีการบันทึกข้อมูลใหม่ ควรอัพเดทตาราง Export
        (เข้าหน้า "จัดการข้อมูล KPI" → Export Tables → กด "เริ่มสร้าง/อัพเดต")
    </div>`;

    // Telegram text
    let tg = `📊 <b>สรุปการบันทึก KPI ประจำวัน</b>\n📅 ${dateStr}\n\n`;
    tg += `👥 ผู้บันทึก: <b>${totalUsers}</b> คน\n📝 รายการ: <b>${totalSaves.toLocaleString()}</b> รายการ\n\n`;
    tg += `<b>Top ผู้บันทึก:</b>\n`;
    usersList.slice(0, 10).forEach((u, i) => {
        const total = u.kpi_count + u.sub_count + u.dynamic_count;
        tg += `${i+1}. ${u.full_name} (${u.hospname}) — <b>${total}</b>`;
        const parts = [];
        if (u.kpi_count) parts.push(`KPI:${u.kpi_count}`);
        if (u.sub_count) parts.push(`Sub:${u.sub_count}`);
        if (u.dynamic_count) parts.push(`Form:${u.dynamic_count}`);
        if (parts.length) tg += ` (${parts.join(', ')})`;
        tg += `\n`;
    });
    if (usersList.length > 10) tg += `... และอีก ${usersList.length - 10} คน\n`;
    if (topInd.length > 0) {
        tg += `\n<b>🔝 KPI ที่บันทึกมากสุด:</b>\n`;
        topInd.slice(0, 5).forEach(([ind, cnt], i) => { tg += `${i+1}. ${ind} (${cnt})\n`; });
    }
    tg += `\n💡 แนะนำ: อัพเดทตาราง Export`;

    // Send
    const ns = await getNotifSettings();
    let sentEmail = false, sentTelegram = false, sentLine = false;
    if (cfg.digestEmail && ns.adminEmails) {
        const emails = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of emails) {
            try { await sendMail(email, subject, html); sentEmail = true; } catch (e) {}
        }
    }
    if (cfg.digestTelegram && ns.tgToken && ns.tgChatId) {
        try { sentTelegram = await sendTelegramDirect(ns.tgToken, ns.tgChatId, tg); } catch (e) {}
    }
    if (cfg.digestLine && ns.lineToken && ns.lineGroupId) {
        try { const r = await sendLineMulticast(ns.lineToken, ns.lineGroupId, tg); sentLine = r.sent > 0; } catch (e) {}
    }

    // Mark records as notified
    const recordIds = records.map(r => r.id);
    if (recordIds.length > 0) {
        await db.query(`UPDATE kpi_save_audit SET notified_at = NOW() WHERE id IN (${recordIds.map(() => '?').join(',')})`, recordIds);
    }

    const summary = {
        total_users: totalUsers, total_saves: totalSaves,
        sent_email: sentEmail, sent_telegram: sentTelegram, sent_line: sentLine,
        date: dateStr, ran_at: new Date().toISOString(), manual
    };
    // บันทึก last digest
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('kpi_audit_last_digest_at', ?) ON DUPLICATE KEY UPDATE setting_value=?",
        [new Date().toISOString(), new Date().toISOString()]);
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('kpi_audit_last_digest_result', ?) ON DUPLICATE KEY UPDATE setting_value=?",
        [JSON.stringify(summary), JSON.stringify(summary)]);
    _auditSettingsExpiry = 0; // invalidate cache

    console.log(`[KPI Audit] digest sent — ${totalSaves} records / ${totalUsers} users (email:${sentEmail} tg:${sentTelegram})`);
    return summary;
}

// Scheduler — ตรวจทุก 30 วินาทีเหมือน backup scheduler
function startKpiAuditScheduler() {
    const pad2 = (n) => String(n).padStart(2, '0');
    const bkkFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const getHHMM = (date) => {
        const p = bkkFormatter.formatToParts(date);
        const h = p.find(x => x.type === 'hour')?.value;
        const m = p.find(x => x.type === 'minute')?.value;
        return `${h === '24' ? '00' : h}:${m}`;
    };
    let _lastDigestDateKey = null;
    const check = async () => {
        try {
            const cfg = await getAuditSettings();
            if (!cfg.digestEnabled) return;
            const now = new Date();
            const hhmm = getHHMM(now);
            const prev = getHHMM(new Date(now.getTime() - 60 * 1000));
            const todayKey = bangkokTimestamp(now, 'log').split(' ')[0];
            // match 2-min window
            if (hhmm !== cfg.digestTime && prev !== cfg.digestTime) return;
            if (_lastDigestDateKey === todayKey) return; // กัน double-run ใน 1 วัน
            _lastDigestDateKey = todayKey;
            console.log(`[KPI Audit] 🚀 daily digest triggered — ${todayKey} ${hhmm}`);
            runKpiAuditDigest(false).catch(e => console.error('[KPI Audit] digest error:', e.message));
        } catch (e) { console.error('[KPI Audit] check failed:', e.message); }
    };
    check().catch(() => {});
    setInterval(check, 30000);
    console.log(`[KPI Audit] scheduler started — daily digest check every 30s`);
}

// ========== Endpoints ==========
apiRouter.get('/kpi-audit/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        _auditSettingsExpiry = 0;
        const cfg = await getAuditSettings();
        res.json({ success: true, data: cfg });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/kpi-audit/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const updates = [
            ['kpi_audit_enabled', b.enabled === false ? 'false' : 'true'],
            ['kpi_audit_digest_enabled', b.digestEnabled === false ? 'false' : 'true'],
            ['kpi_audit_digest_time', b.digestTime || '17:00'],
            ['kpi_audit_digest_email', b.digestEmail === false ? 'false' : 'true'],
            ['kpi_audit_digest_telegram', b.digestTelegram === false ? 'false' : 'true'],
            ['kpi_audit_digest_line', b.digestLine === false ? 'false' : 'true'],
            ['kpi_audit_digest_min_records', String(parseInt(b.minRecords) || 1)]
        ];
        for (const [k, v] of updates) {
            await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, v, v]);
        }
        _auditSettingsExpiry = 0;
        res.json({ success: true, message: 'บันทึก settings สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /kpi-audit/records — ดู audit log
apiRouter.get('/kpi-audit/records', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { limit = 200, only_unnotified } = req.query;
        let where = '1=1';
        if (only_unnotified === '1') where += ' AND notified_at IS NULL';
        const [rows] = await db.query(
            `SELECT * FROM kpi_save_audit WHERE ${where} ORDER BY id DESC LIMIT ?`,
            [Math.min(Number(limit) || 200, 1000)]
        );
        const [stat] = await db.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(CASE WHEN notified_at IS NULL THEN 1 END) AS unnotified,
                COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS today,
                COUNT(DISTINCT user_id) AS unique_users
            FROM kpi_save_audit
        `);
        res.json({ success: true, data: rows, stats: stat[0] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /kpi-audit/run-digest-now — ส่ง digest ทันที (test)
apiRouter.post('/kpi-audit/run-digest-now', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const result = await runKpiAuditDigest(true);
        res.json({ success: true, result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Mount Router ที่ path /khupskpi/api
app.use('/khupskpi/api', apiRouter);


// Express error middleware — capture 500 errors ที่ไม่ได้ handle ใน route → error_logs + Telegram
// (ต้องอยู่หลัง mount router)
app.use((err, req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    captureError({
        source: 'http',
        severity: 'error',
        message: err?.message || String(err),
        stack: err?.stack || null,
        url: req.originalUrl,
        user_id: req.user?.userId || null,
        username: req.user?.username || null,
        user_agent: req.headers['user-agent'] || null,
        ip_address: ip,
        extra: { method: req.method }
    }).catch(() => {});
    res.status(err.status || 500).json({ success: false, message: err.message || 'Internal Server Error' });
});

// === Session Cleanup Job — เคลียร์ active_session_id ที่ค้างเกิน 8h (= JWT lifetime) ===
// ป้องกันกรณีปิด browser โดยไม่ logout → session ค้างใน DB ตลอดไป
function startSessionCleanupJob() {
    const JWT_LIFETIME_HOURS = 8;
    const runCleanup = async () => {
        try {
            const [result] = await db.query(`
                UPDATE users
                SET active_session_id = NULL, session_started_at = NULL
                WHERE active_session_id IS NOT NULL
                  AND last_seen_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
            `, [JWT_LIFETIME_HOURS]);
            if (result.affectedRows > 0) {
                console.log(`🧹 [SessionCleanup] เคลียร์ stale session ${result.affectedRows} user(s) (last_seen > ${JWT_LIFETIME_HOURS}h ago)`);
            }
        } catch (e) {
            console.error('❌ [SessionCleanup] error:', e.message);
        }
    };
    runCleanup(); // รันทันทีตอน startup (เผื่อ restart กลางคัน)
    setInterval(runCleanup, 30 * 60 * 1000); // ทุก 30 นาที
    console.log(`⏱️  [SessionCleanup] เริ่ม job — เคลียร์ session ที่ไม่ active > ${JWT_LIFETIME_HOURS}h ทุก 30 นาที`);
}

// ============= Test mode: export app, ไม่ listen ตอน require =============
// ใช้ใน integration test (supertest) — ไม่เปิด port + ไม่ start scheduler
if (require.main === module) {
    app.listen(port, () => {
        console.log(`🚀 API Server เปิดทำงานแล้วที่พอร์ต ${port} (Path: /khupskpi/api)`);
        try { startExportScheduler(); } catch (e) { console.error('[Scheduler] start failed:', e.message); }
        try { startBackupScheduler(); } catch (e) { console.error('[BackupScheduler] start failed:', e.message); }
        try { startKpiAuditScheduler(); } catch (e) { console.error('[KPI Audit] start failed:', e.message); }
        startSessionCleanupJob();
    });
}
module.exports = { app, apiRouter, captureError, migrationsReady, loadSubAggregates, loadSubExportMonthMap, refreshKpiSummaryForIndicatorYears, scheduleSummaryRefresh, summaryRefreshIdle };
