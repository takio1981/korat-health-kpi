// เส้นทาง: เข้าสู่ระบบ/ออก, ThaID/ProviderID (SSO), ผู้ดูแล session, ลืมรหัสผ่าน, ลงทะเบียน, ข้อมูลสาธารณะ
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const jwt = require('jsonwebtoken');
const { SECRET_KEY, loginIpLimiter, loginLimiter } = require('../core/security');
const { THAID_AUTH_URL, THAID_CLIENT_ID, THAID_REDIRECT_URI, THAID_SCOPE, THAID_TOKEN_URL, getProviderIdSettings, getThaidSettings } = require('../services/sso');
const { _sessionCache, authenticateToken, isSuperAdmin, saveLog } = require('../core/auth');
const { apiRouter } = require('../core/router');
const { cleanupPendingApprovalNotifications, notifyAdmins, sendLoginNotifications, sendMail } = require('../core/notify');
const { countUserKpiResults } = require('../services/users');
const { itemsTableName } = require('../services/export');

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
        trust_proxy: req.app.get('trust proxy'),   // req.app = app เดียวกัน (ใช้ได้ในไฟล์เส้นทางแยก)
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

// ============================================================
// === ProviderID (MOPH) OAuth 2.0 Login Flow ================
// ============================================================

/** ดึง ProviderID config จาก DB */
// MOPH Health ID (moph.id.th) — default endpoints (discovered from /back/oauth/service-provider pattern)
const MOPH_AUTH_URL     = 'https://moph.id.th/oauth/redirect';

const MOPH_REDIRECT_URI = 'https://apikorat.moph.go.th/authen/healthid/callback';

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
        const [hospitals] = await db.query("SELECT hoscode, hosname, hostype, CONCAT(provcode, distcode) as distid, zone FROM chospital ORDER BY FIELD(hostype,'05','06','07','18'), hosname");
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

module.exports = { _thaidOtpMap, _thaidStateMap, _thaidRegMap, sanitizeSsoPayload, saveSsoLog, upsertSsoProfile, extractCidFromPayload, extractHospcodeFromPayload, extractDistCodeFromPayload, resolveRegLocationFromPayload, getFrontendBase, handleThaidCallback, MOPH_AUTH_URL, MOPH_REDIRECT_URI, _providerIdStateMap, handleProviderIdCallback };
