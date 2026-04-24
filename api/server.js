// Dev: load .env.dev | Production (Docker): env vars injected via docker-compose
// MUST be first — before any require('./db') that creates the MySQL pool
if (process.env.NODE_ENV !== 'production') {
    const result = require('dotenv').config({ path: '.env.dev' });
    if (result.error) {
        console.error('[dotenv] Failed to load .env.dev:', result.error.message);
    } else {
        console.log('[dotenv] Loaded .env.dev — DB_HOST:', process.env.DB_HOST, '| PORT:', process.env.PORT);
    }
}

const express = require('express');
const cors = require('cors');
const db = require('./db');
const { getRemotePool } = require('./db-remote');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();

// === Email Transporter ===
const mailTransporter = process.env.SMTP_HOST ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

const sendMail = async (to, subject, html) => {
    if (!mailTransporter || !to) return;
    try {
        await mailTransporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to, subject, html
        });
        console.log(`[Email] Sent to ${to}: ${subject}`);
    } catch (err) {
        console.error(`[Email] Failed to ${to}:`, err.message);
    }
};

// === Telegram Bot Notification ===
const sendTelegramDirect = async (botToken, chatId, message) => {
    if (!botToken || !chatId) return false;
    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
        });
        const data = await res.json();
        if (data.ok) { console.log('[Telegram] Message sent'); return true; }
        else { console.error('[Telegram] Failed:', data.description); return false; }
    } catch (err) {
        console.error('[Telegram] Error:', err.message);
        return false;
    }
};

// Helper: ดึง notification settings จาก DB (fallback ENV)
const getNotifSettings = async () => {
    try {
        const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('telegram_bot_token','telegram_chat_id','admin_emails')");
        const s = {};
        for (const r of rows) s[r.setting_key] = r.setting_value;
        return {
            tgToken: s.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '',
            tgChatId: s.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '',
            adminEmails: s.admin_emails || process.env.ADMIN_EMAILS || ''
        };
    } catch (e) {
        return {
            tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
            tgChatId: process.env.TELEGRAM_CHAT_ID || '',
            adminEmails: process.env.ADMIN_EMAILS || ''
        };
    }
};

const notifyAdmins = async (subject, html, telegramMsg, options = {}) => {
    const ns = await getNotifSettings();
    const sendTg = options.telegram !== false;
    const sendEm = options.email !== false;
    // 1. Telegram
    if (sendTg && telegramMsg) sendTelegramDirect(ns.tgToken, ns.tgChatId, telegramMsg);
    // 2. Email to admin list
    if (sendEm && ns.adminEmails) {
        const emails = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of emails) {
            sendMail(email, subject, html);
        }
    }
};
// ใช้ Port จาก ENV หรือ Default 8830 ตามโจทย์
const port = process.env.PORT || 8830; 

// Security Middleware
app.set('trust proxy', 1); // จำเป็นเมื่ออยู่หลัง Nginx Proxy เพื่อให้ Rate Limit ทำงานถูกต้องกับ IP จริง
app.use(helmet()); // เพิ่ม HTTP Headers เพื่อความปลอดภัย (XSS, Clickjacking, etc.)
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Global settings variables
let maxLoginAttempts = 10;
let loginAttemptsEnabled = true;
let autoLogoutEnabled = true;
let idleCountdownEnabled = true;

const updateSystemSettings = async () => {
    try {
        const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('max_login_attempts','login_attempts_enabled','auto_logout_enabled','idle_countdown_enabled')");
        for (const row of rows) {
            if (row.setting_key === 'max_login_attempts') maxLoginAttempts = parseInt(row.setting_value, 10) || 10;
            if (row.setting_key === 'login_attempts_enabled') loginAttemptsEnabled = row.setting_value === 'true';
            if (row.setting_key === 'auto_logout_enabled') autoLogoutEnabled = row.setting_value === 'true';
            if (row.setting_key === 'idle_countdown_enabled') idleCountdownEnabled = row.setting_value === 'true';
        }
    } catch (error) {
        console.error("Failed to load system settings:", error);
    }
};
// Load settings on start
updateSystemSettings();

// Rate Limiting: ป้องกัน Brute Force และ DDoS
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 นาที
    limit: (req, res) => loginAttemptsEnabled ? maxLoginAttempts : 9999, // ถ้าปิดระบบนับ = ไม่จำกัด
    message: { success: false, message: 'ทำรายการเกินกำหนด กรุณาลองใหม่ในอีก 15 นาที' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 นาที per IP
    max: 300, // เรียก API ทั่วไปได้ 300 ครั้งต่อนาที (ปรับตามความเหมาะสม)
    standardHeaders: true,
    legacyHeaders: false,
});

const SECRET_KEY = process.env.SECRET_KEY;
if (!SECRET_KEY) {
    console.error('FATAL ERROR: SECRET_KEY is not defined.');
    process.exit(1);
}

// Middleware ตรวจสอบ JWT Token
// Throttle cache สำหรับ update last_seen — userId → timestamp ของ update ล่าสุด
const _lastSeenCache = new Map();
const LAST_SEEN_THROTTLE_MS = 60 * 1000; // update DB ไม่เกิน 1 ครั้ง/นาที/user

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้องหรือหมดอายุ' });
        req.user = user;

        // Track last_seen — throttled (max 1/min/user) กันเขียน DB ถี่เกิน
        const uid = user.userId;
        if (uid) {
            const now = Date.now();
            const last = _lastSeenCache.get(uid) || 0;
            if (now - last > LAST_SEEN_THROTTLE_MS) {
                _lastSeenCache.set(uid, now);
                const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
                const ua = (req.headers['user-agent'] || '').toString().slice(0, 255);
                db.query('UPDATE users SET last_seen_at = NOW(), last_seen_ip = ?, last_seen_ua = ? WHERE id = ?', [ip, ua, uid])
                  .catch(() => {});
            }
        }
        next();
    });
};

// === Role Groups ===
const ROLE_ADMIN_ALL = ['admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj', 'super_admin'];
const ROLE_ADMIN_CENTRAL = ['admin_ssj', 'super_admin'];
const ROLE_ADMIN_LOCAL = ['admin_hos', 'admin_sso', 'admin_cup']; // admin ระดับพื้นที่
const ROLE_SCOPE_DISTRICT = ['user_cup', 'admin_cup']; // เห็นทุก hospcode ในอำเภอ
const ROLE_SCOPE_HOSPCODE = ['user', 'user_hos', 'user_sso', 'admin_hos', 'admin_sso']; // เห็นเฉพาะ hospcode ตัวเอง (รวม 'user' เดิม)

// Helper: ดึง distid ของ hospcode
const getDistrictId = async (hospcode) => {
    if (!hospcode) return null;
    const [rows] = await db.query('SELECT CONCAT(provcode, distcode) AS distid FROM chospital WHERE hoscode = ?', [hospcode]);
    return rows.length > 0 ? rows[0].distid : null;
};

// Middleware ตรวจสอบสิทธิ์ Admin ส่วนกลาง (admin_ssj + super_admin)
const isAdmin = (req, res, next) => {
    if (req.user && ROLE_ADMIN_CENTRAL.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบส่วนกลาง (สสจ.) เท่านั้น' });
    }
};

// Middleware ตรวจสอบสิทธิ์ Admin ทุกระดับ
const isAnyAdmin = (req, res, next) => {
    if (req.user && ROLE_ADMIN_ALL.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบเท่านั้น' });
    }
};

// Middleware ตรวจสอบสิทธิ์ Super Admin เท่านั้น
const isSuperAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'super_admin') {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบสูงสุด (Super Admin) เท่านั้น' });
    }
};

// สร้าง Router เพื่อรองรับ Prefix /khupskpi/api
const apiRouter = express.Router();

// Root endpoint — used by Docker healthcheck (returns 200 so wget --spider succeeds)
apiRouter.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'KHUPS KPI API' });
});

const saveLog = async (username, action, details, ip) => {
    try {
        await db.query(
            'INSERT INTO login_logs (username, action, details, ip_address) VALUES (?, ?, ?, ?)',
            [username, action, details, ip]
        );
    } catch (err) {
        console.error("Failed to save log:", err);
    }
};

// ==========================================
// ย้าย Route ทั้งหมดมาใส่ใน apiRouter
// ==========================================

apiRouter.get('/status', (req, res) => {
    res.json({ message: '🚀 API พร้อมใช้งานที่ /khupskpi/api' });
});

apiRouter.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    // ใช้ req.headers['x-forwarded-for'] กรณีอยู่หลัง Nginx/Docker Proxy
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

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
                const serviceUnitDisplay = user.hosname ? `${user.hosname} ${user.distname ? 'อ.' + user.distname : ''}` : user.service_unit;

                // ถ้าใช้รหัสชั่วคราว → ยังไม่ล้าง (จะล้างตอน change-password สำเร็จ)
                // เพื่อให้ change-password ยังตรวจ temp_password ได้

                const forceChange = user.must_change_password === 1 || usedTempPassword;

                await saveLog(username, 'login_success', usedTempPassword ? 'เข้าสู่ระบบด้วยรหัสชั่วคราว' : 'เข้าสู่ระบบสำเร็จ', ip);

                // ส่ง Email แจ้งเตือนการ Login (ถ้ามี email)
                if (user.email) {
                    const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
                    sendMail(user.email,
                        '🔑 แจ้งเตือนการเข้าสู่ระบบ — ระบบ KPI สสจ.นครราชสีมา',
                        `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                            <div style="background:linear-gradient(135deg,#16a34a,#22c55e);padding:20px;text-align:center;color:white">
                                <h2 style="margin:0;font-size:18px">🔑 แจ้งเตือนการเข้าสู่ระบบ</h2>
                            </div>
                            <div style="padding:20px">
                                <p>เรียน คุณ${user.firstname} ${user.lastname},</p>
                                <p style="color:#6b7280">บัญชีของคุณถูกเข้าสู่ระบบเมื่อ:</p>
                                <table style="width:100%;font-size:14px;border-collapse:collapse;margin-top:10px">
                                    <tr><td style="padding:6px 0;color:#6b7280">เวลา</td><td style="font-weight:bold">${now}</td></tr>
                                    <tr><td style="padding:6px 0;color:#6b7280">IP Address</td><td style="font-weight:bold">${ip}</td></tr>
                                    <tr><td style="padding:6px 0;color:#6b7280">Username</td><td style="font-weight:bold">${username}</td></tr>
                                </table>
                                <p style="color:#dc2626;font-size:13px;margin-top:15px">หากไม่ใช่คุณ กรุณาเปลี่ยนรหัสผ่านทันทีหรือติดต่อผู้ดูแลระบบ</p>
                            </div>
                        </div>`
                    );
                }

                const token = jwt.sign(
                    { userId: user.id, username: user.username, deptId: user.dept_id, role: user.role, hospcode: user.hospcode },
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
                res.status(401).json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
            }
        } else {
            await saveLog(username, 'login_failed', 'ไม่พบชื่อผู้ใช้งาน', ip);
            res.status(401).json({ success: false, message: 'ไม่พบชื่อผู้ใช้งาน' });
        }
    } catch (error) {
        console.error(error);
        await saveLog(username, 'system_error', error.message, ip);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดที่ Server' });
    }
});

// === ลืมรหัสผ่าน: ส่งรหัสชั่วคราว 6 หลักทาง Email ===
apiRouter.post('/forgot-password', loginLimiter, async (req, res) => {
    const { username } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!username) return res.status(400).json({ success: false, message: 'กรุณากรอก Username' });

    try {
        const [users] = await db.query('SELECT id, email, firstname, lastname FROM users WHERE username = ? AND is_approved = 1 AND is_active = 1', [username]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ Username นี้ในระบบ หรือบัญชียังไม่ได้รับการอนุมัติ' });

        const user = users[0];
        if (!user.email) return res.status(400).json({ success: false, message: 'บัญชีนี้ไม่มี Email ลงทะเบียนไว้ กรุณาติดต่อผู้ดูแลระบบ' });

        // สร้างรหัสชั่วคราว 6 หลัก
        const tempCode = String(Math.floor(100000 + Math.random() * 900000));
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
apiRouter.post('/register', loginLimiter, async (req, res) => {
    const { username, password, firstname, lastname, hospcode, phone, email, dept_id, cid, role: reqRole } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        // ตรวจสอบข้อมูลครบถ้วน (บังคับทุกช่อง)
        if (!username || !password || !firstname || !lastname || !hospcode || !phone || !cid || !dept_id) {
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

        // ตรวจสอบ cid — บังคับ 13 หลัก + Check Digit (Modulus 11) + ไม่ซ้ำ
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
        // ตรวจสอบ cid ซ้ำ (hash แล้วเทียบกับ DB)
        const hashedCidCheck = crypto.createHash('sha256').update(cid).digest('hex');
        const [existingCid] = await db.query('SELECT id, is_approved FROM users WHERE cid = ?', [hashedCidCheck]);
        if (existingCid.length > 0) {
            if (existingCid[0].is_approved === -1) {
                // ถูกปฏิเสธ → ลบ account เก่าแล้วให้สมัครใหม่ได้
                await db.query('DELETE FROM users WHERE id = ?', [existingCid[0].id]);
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
                // ถูกปฏิเสธ → ลบ account เก่า
                await db.query('DELETE FROM users WHERE id = ?', [existing[0].id]);
            } else {
                return res.status(400).json({ success: false, message: 'ชื่อผู้ใช้งานนี้ถูกใช้แล้ว กรุณาเปลี่ยนชื่อผู้ใช้งาน' });
            }
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Hash CID ด้วย SHA-256 ก่อนบันทึก
        const hashedCid = cid ? crypto.createHash('sha256').update(cid).digest('hex') : null;

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
        const [notifSettings] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('notif_telegram_enabled','notif_email_enabled','notif_system_enabled')");
        const ntfMap = {};
        notifSettings.forEach(r => ntfMap[r.setting_key] = r.setting_value);
        const ntfTelegram = ntfMap['notif_telegram_enabled'] !== 'false';
        const ntfEmail = ntfMap['notif_email_enabled'] !== 'false';
        const ntfSystem = ntfMap['notif_system_enabled'] !== 'false';

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
            { telegram: ntfTelegram, email: ntfEmail }
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

// === Public KPI endpoints (ไม่ต้อง login) ===
apiRouter.get('/public/kpi-results', async (req, res) => {
    try {
        const sql = `
            SELECT
                if(mi.main_indicator_name IS NULL,'ยังไม่กำหนด',mi.main_indicator_name) main_indicator_name,
                i.kpi_indicators_name,
                r.year_bh,
                i.id AS indicator_id,
                d.dept_name,
                MAX(r.target_value) AS target_value,
                MAX(CASE WHEN r.month_bh = 10 THEN r.actual_value ELSE NULL END) AS oct,
                MAX(CASE WHEN r.month_bh = 11 THEN r.actual_value ELSE NULL END) AS nov,
                MAX(CASE WHEN r.month_bh = 12 THEN r.actual_value ELSE NULL END) AS dece,
                MAX(CASE WHEN r.month_bh = 1  THEN r.actual_value ELSE NULL END) AS jan,
                MAX(CASE WHEN r.month_bh = 2  THEN r.actual_value ELSE NULL END) AS feb,
                MAX(CASE WHEN r.month_bh = 3  THEN r.actual_value ELSE NULL END) AS mar,
                MAX(CASE WHEN r.month_bh = 4  THEN r.actual_value ELSE NULL END) AS apr,
                MAX(CASE WHEN r.month_bh = 5  THEN r.actual_value ELSE NULL END) AS may,
                MAX(CASE WHEN r.month_bh = 6  THEN r.actual_value ELSE NULL END) AS jun,
                MAX(CASE WHEN r.month_bh = 7  THEN r.actual_value ELSE NULL END) AS jul,
                MAX(CASE WHEN r.month_bh = 8  THEN r.actual_value ELSE NULL END) AS aug,
                MAX(CASE WHEN r.month_bh = 9  THEN r.actual_value ELSE NULL END) AS sep,
                (SELECT r2.actual_value FROM kpi_results r2
                 WHERE r2.indicator_id = r.indicator_id AND r2.year_bh = r.year_bh AND r2.hospcode = r.hospcode
                   AND r2.actual_value IS NOT NULL AND TRIM(r2.actual_value) != '' AND TRIM(r2.actual_value) != '0'
                 ORDER BY FIELD(r2.month_bh,10,11,12,1,2,3,4,5,6,7,8,9) DESC LIMIT 1
                ) AS last_actual,
                r.hospcode, h.hosname, dist.distname
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            GROUP BY mi.main_indicator_name, i.kpi_indicators_name, i.id, d.dept_name, r.year_bh, r.hospcode, h.hosname, dist.distname
            ORDER BY r.year_bh DESC, mi.main_indicator_name, i.kpi_indicators_name, i.id`;
        const [rows] = await db.query(sql);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/public/dashboard-stats', async (req, res) => {
    try {
        const year = req.query.year || (new Date().getFullYear() + 543).toString();
        const [kpiRows] = await db.query(
            `SELECT r.indicator_id, SUM(r.target_value) as total_target, SUM(r.actual_value) as total_actual
             FROM kpi_results r WHERE r.year_bh = ? GROUP BY r.indicator_id`,
            [year]
        );
        let passedCount = 0;
        kpiRows.forEach(row => {
            if (Number(row.total_target) > 0 && Number(row.total_actual) >= Number(row.total_target)) passedCount++;
        });
        const successRate = kpiRows.length > 0 ? ((passedCount / kpiRows.length) * 100).toFixed(1) : 0;

        const [[{ recorded_count }]] = await db.query(
            `SELECT COUNT(DISTINCT i.dept_id) as recorded_count FROM kpi_results r
             JOIN kpi_indicators i ON r.indicator_id = i.id WHERE r.year_bh = ?`, [year]);
        const [[{ total_depts }]] = await db.query(
            `SELECT COUNT(*) as total_depts FROM departments`);
        const [[{ pending_count }]] = await db.query(
            `SELECT COUNT(*) as pending_count FROM kpi_results WHERE year_bh = ? AND status = 'Pending'`, [year]);

        res.json({ success: true, data: { successRate, recordedCount: recorded_count, totalDepts: total_depts, pendingCount: pending_count, rank: 0, totalHospitals: 0 } });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

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

        const sql = `
            SELECT
                IFNULL(mi.main_indicator_name, 'ยังไม่กำหนด') AS main_indicator_name,
                i.kpi_indicators_name,
                r.year_bh,
                i.id AS indicator_id,
                d.dept_name,
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
                i.table_process,
                i.r9, i.moph, i.ssj, i.rmw, i.other,
                i.evaluation_mode,
                i.required_off_types,
                r.hospcode,
                h.hosname,
                h.hostype,
                ht.hostypename,
                dist.distname
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN chostype ht ON h.hostype = ht.hostypecode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            ${whereClause}${extraWhere}
            GROUP BY i.id, r.year_bh, r.hospcode, mi.main_indicator_name, i.kpi_indicators_name, i.table_process, i.r9, i.moph, i.ssj, i.rmw, i.other, i.evaluation_mode, i.required_off_types, d.dept_name, h.hosname, h.hostype, ht.hostypename, dist.distname
            ORDER BY r.year_bh DESC, mi.main_indicator_name, i.kpi_indicators_name, r.hospcode
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);

        // === คำนวณ last_actual + appeal + has_form ฝั่ง JS (เร็วกว่า subquery) ===
        const monthOrder = [10,11,12,1,2,3,4,5,6,7,8,9];
        const monthKeys = ['oct','nov','dece','jan','feb','mar','apr','may','jun','jul','aug','sep'];
        for (const row of rows) {
            // last_actual: หาเดือนล่าสุดที่มีค่า
            let lastVal = null;
            for (let m = monthKeys.length - 1; m >= 0; m--) {
                const v = row[monthKeys[m]];
                if (v != null && String(v).trim() !== '' && String(v).trim() !== '0') { lastVal = v; break; }
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
        const [indicators] = await db.query(`SELECT COUNT(*) AS cnt FROM kpi_indicators ${indWhere}`, indParams);
        const [hospitals] = await db.query("SELECT COUNT(*) AS cnt FROM chospital WHERE hostype IN ('05','06','07','18')");
        const [existing] = await db.query('SELECT COUNT(DISTINCT CONCAT(indicator_id,"_",hospcode)) AS cnt FROM kpi_results WHERE year_bh = ?', [year_bh]);
        const totalPossible = indicators[0].cnt * hospitals[0].cnt;
        const toAdd = Math.max(0, totalPossible - existing[0].cnt);
        res.json({
            success: true,
            indicatorCount: indicators[0].cnt,
            hospitalCount: hospitals[0].cnt,
            existingCount: existing[0].cnt,
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
        const [indicators] = await db.query(`SELECT id, target_percentage FROM kpi_indicators ${indWhere}`, indParams);
        // ดึงเฉพาะ รพ., สสอ., รพ.สต. (hostype 05,06,07,18)
        const [hospitals] = await db.query("SELECT hoscode FROM chospital WHERE hostype IN ('05','06','07','18')");
        if (indicators.length === 0) return res.json({ success: true, message: 'ไม่มีตัวชี้วัดที่ active', inserted: 0, skipped: 0 });
        if (hospitals.length === 0) return res.json({ success: true, message: 'ไม่มีหน่วยบริการในระบบ', inserted: 0, skipped: 0 });

        // ดึง kpi_results ที่มีอยู่แล้วสำหรับปีนี้ → สร้าง Set เพื่อเช็คซ้ำเร็ว
        const [existing] = await db.query('SELECT indicator_id, hospcode FROM kpi_results WHERE year_bh = ? GROUP BY indicator_id, hospcode', [year_bh]);
        const existSet = new Set(existing.map(r => `${r.indicator_id}_${r.hospcode}`));

        let inserted = 0, skipped = 0;
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const hos of hospitals) {
                for (const ind of indicators) {
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
apiRouter.post('/kpi-results/bulk-delete', authenticateToken, isSuperAdmin, async (req, res) => {
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
});

apiRouter.post('/update-kpi', async (req, res) => {
    let updates = req.body;
    if (req.body && req.body.updates && Array.isArray(req.body.updates)) {
        updates = req.body.updates;
    }
    const targetHospcode = req.body.targetHospcode;
    // mode: 'setup_overwrite' = KPI-Setup เพิ่มทั้งหมด (เขียนทับ, บันทึก 0 ได้)
    //        'setup_insert_new' = KPI-Setup เพิ่มเฉพาะที่ยังไม่มี (บันทึก 0 ได้)
    //        undefined/default = Dashboard ปกติ (ข้าม row ที่ค่า 0 ทั้งหมด)
    const saveMode = req.body.mode || 'default';

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    let user;
    try {
        user = jwt.verify(token, SECRET_KEY);
    } catch (err) {
        return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้อง' });
    }

    const hospcodeToSave = (ROLE_ADMIN_ALL.includes(user.role) && targetHospcode) ? targetHospcode : user.hospcode;

    if (!hospcodeToSave) {
        return res.status(400).json({ success: false, message: 'ไม่พบรหัสหน่วยบริการ กรุณาเลือกหน่วยบริการ' });
    }

    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' });
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

        // --- Mode: setup_insert_new → เพิ่มเฉพาะที่ยังไม่มี (ข้ามตัวที่มีอยู่แล้ว) ---
        if (saveMode === 'setup_insert_new') {
            // ตรวจสอบว่า indicator ไหนมีข้อมูลอยู่แล้ว
            const existingKeys = new Set();
            for (const key of uniqueKeys) {
                const [indId, ybh, hc] = key.split('_');
                const [existRows] = await connection.query(
                    'SELECT COUNT(*) as cnt FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                    [indId, ybh, hc]
                );
                if (existRows[0].cnt > 0) {
                    existingKeys.add(key);
                }
            }

            // กรองเฉพาะ indicator ที่ยังไม่มีข้อมูล
            const newUpdates = updates.filter(row => {
                const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
                const key = `${row.indicator_id}_${row.year_bh}_${hc}`;
                return !existingKeys.has(key);
            });

            if (newUpdates.length === 0) {
                await connection.commit();
                return res.json({ success: true, message: 'ไม่มีตัวชี้วัดใหม่ที่ต้องเพิ่ม (ทั้งหมดมีอยู่แล้ว)', skipped: updates.length });
            }

            // INSERT เฉพาะ indicator ใหม่ (รวม 0 ด้วย)
            const insertValues = [];
            const insertParams = [];
            for (const row of newUpdates) {
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
                 JSON.stringify({ message: `KPI-Setup: เพิ่มเฉพาะที่ยังไม่มี ${newUpdates.length} ตัวชี้วัด (ข้าม ${updates.length - newUpdates.length} ที่มีอยู่แล้ว)` }),
                 req.ip]
            );

            await connection.commit();
            return res.json({
                success: true,
                message: `เพิ่มตัวชี้วัดใหม่ ${newUpdates.length} รายการ (ข้าม ${updates.length - newUpdates.length} รายการที่มีอยู่แล้ว)`,
                inserted: newUpdates.length,
                skipped: updates.length - newUpdates.length
            });
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

        await connection.commit();
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

// ตรวจสอบชื่อตาราง/คอลัมน์ (ป้องกัน SQL Injection)
const isValidIdentifier = (name) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name);

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
            SELECT i.id, i.kpi_indicators_name, i.table_process, d.dept_name,
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
apiRouter.post('/form-schemas', authenticateToken, isSuperAdmin, async (req, res) => {
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
        let colDefs = customCols.map(f => {
            const sqlType = f.field_type === 'number' ? 'DECIMAL(15,4) NULL' : 'TEXT NULL';
            return `\`${f.field_name}\` ${sqlType}`;
        }).join(', ');
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
                const sqlType = f.field_type === 'number' ? 'DECIMAL(15,4) NULL' : 'TEXT NULL';
                await connection.query(`ALTER TABLE \`${formTableName}\` ADD COLUMN IF NOT EXISTS \`${f.field_name}\` ${sqlType}`);
            } catch (e) { /* ignore */ }
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
        // ตรวจสอบว่าตารางมีอยู่จริง
        const [tableCheck] = await db.query("SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [formTable]);
        if (!tableCheck[0]?.cnt) {
            return res.json({ success: true, data: [] });
        }
        const { hospcode, year_bh, month_bh } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (hospcode) { where += ' AND t.hospcode = ?'; params.push(hospcode); }
        if (year_bh) { where += ' AND t.year_bh = ?'; params.push(year_bh); }
        if (month_bh) { where += ' AND t.month_bh = ?'; params.push(month_bh); }
        const [rows] = await db.query(`SELECT t.*, u.username AS created_by_name FROM \`${formTable}\` t LEFT JOIN users u ON t.created_by = u.id ${where} ORDER BY t.year_bh DESC, t.month_bh DESC, t.created_at DESC`, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.json({ success: true, data: [] }); }
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

        const cols = Object.keys(data).filter(k => isValidIdentifier(k));
        const vals = cols.map(k => data[k]);
        let insertedId = rowId;

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
                'SELECT actual_value_field FROM kpi_form_schemas WHERE indicator_id = ? AND is_active = 1 LIMIT 1',
                [indicatorId]
            );
            if (schemaRows.length > 0 && schemaRows[0].actual_value_field) {
                const avField = schemaRows[0].actual_value_field;
                const actualValue = data[avField] !== undefined ? String(data[avField]) : null;
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
        res.json({ success: true, message: isUpdate ? 'อัปเดตข้อมูลเรียบร้อยแล้ว' : 'บันทึกข้อมูลเรียบร้อยแล้ว', id: insertedId });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
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
        // กรองตาม dept ของ user (ยกเว้น super_admin เห็นทั้งหมด)
        if (user.role !== 'super_admin' && user.deptId != null) {
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
                d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            WHERE i.is_active = 1 ${deptFilter}
            ORDER BY mi.main_indicator_name DESC, i.kpi_indicators_name DESC, d.dept_name DESC
        `;
        const [rows] = await db.query(sql, params);
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
            WHERE r.hospcode = ? AND r.year_bh = ? ${deptFilter}
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

        const kpiSql = `
            SELECT r.indicator_id, SUM(r.target_value) as total_target, SUM(r.actual_value) as total_actual
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            ${hosJoin}
            WHERE r.year_bh = ? ${whereClause}
            GROUP BY r.indicator_id
        `;
        const [kpiRows] = await db.query(kpiSql, queryParams);

        let passedCount = 0;
        kpiRows.forEach(row => {
            if (Number(row.total_target) > 0 && Number(row.total_actual) >= Number(row.total_target)) passedCount++;
        });

        const successRate = kpiRows.length > 0 ? ((passedCount / kpiRows.length) * 100).toFixed(1) : 0;

        const recordedSql = `
            SELECT COUNT(DISTINCT i.dept_id) as recorded_count
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            ${hosJoin}
            WHERE r.year_bh = ? ${whereClause}
        `;
        const [recordedRows] = await db.query(recordedSql, queryParams);

        const [totalDeptRows] = await db.query('SELECT COUNT(*) as total FROM departments');

        const pendingSql = `
            SELECT COUNT(*) as pending_count FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            ${hosJoin}
            WHERE r.status = 'Pending' AND r.year_bh = ? ${whereClause}
        `;
        const [pendingRows] = await db.query(pendingSql, queryParams);

        // === คำนวณอันดับหน่วยบริการ ===
        let rank = 0;
        let totalHospitals = 0;
        if (user.hospcode) {
            // คำนวณ % ผลงานรวมของทุกหน่วยบริการในปีนี้
            const [allHosRows] = await db.query(`
                SELECT r.hospcode,
                       CASE WHEN SUM(CASE WHEN r.target_value > 0 THEN 1 ELSE 0 END) = 0 THEN 0
                            ELSE ROUND(SUM(CASE WHEN r.target_value > 0 AND r.actual_value >= r.target_value THEN 1 ELSE 0 END)
                                 / SUM(CASE WHEN r.target_value > 0 THEN 1 ELSE 0 END) * 100, 2)
                       END AS success_pct
                FROM kpi_results r
                WHERE r.year_bh = ?
                GROUP BY r.hospcode
                ORDER BY success_pct DESC
            `, [year]);
            totalHospitals = allHosRows.length;
            const idx = allHosRows.findIndex(r => r.hospcode === user.hospcode);
            rank = idx >= 0 ? idx + 1 : 0;
        }

        res.json({
            success: true,
            data: {
                successRate,
                recordedCount: recordedRows[0].recorded_count || 0,
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

// GET /online-users — รายชื่อ user ที่ online (activity ล่าสุดภายใน windowMin นาที)
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

apiRouter.get('/departments', authenticateToken, async (req, res) => {
    try {
        const [depts] = await db.query('SELECT * FROM departments ORDER BY dept_name');
        res.json({ success: true, data: depts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/hospitals', authenticateToken, async (req, res) => {
    try {
        const [hospitals] = await db.query("SELECT hoscode, hosname, hostype, CONCAT(provcode, distcode) as distid FROM chospital ORDER BY FIELD(hostype,'05','06','07','18'), hosname");
        res.json({ success: true, data: hospitals });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.get('/hostype', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT t.hostypecode, t.hostypename, COUNT(h.hoscode) AS hospital_count
            FROM chostype t
            LEFT JOIN chospital h ON h.hostype = t.hostypecode
            GROUP BY t.hostypecode, t.hostypename
            HAVING hospital_count > 0
            ORDER BY t.hostypecode
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.get('/districts', authenticateToken, async (req, res) => {
    try {
        const [districts] = await db.query('SELECT distid, distname FROM co_district WHERE distid LIKE ? ORDER BY distname', ['30%']);
        res.json({ success: true, data: districts });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.post('/users', authenticateToken, isAnyAdmin, async (req, res) => {
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
apiRouter.put('/users/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) {
        return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้อง' });
    }

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

// ตรวจสอบสถานะ maintenance mode (public — ไม่ต้อง login)
apiRouter.get('/system/maintenance-status', async (req, res) => {
    try {
        const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('maintenance_mode','maintenance_message')");
        const settings = {};
        rows.forEach(r => settings[r.setting_key] = r.setting_value);
        res.json({
            success: true,
            maintenance: settings['maintenance_mode'] === 'true',
            message: settings['maintenance_message'] || 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน'
        });
    } catch (error) {
        res.json({ success: true, maintenance: false, message: '' });
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

apiRouter.put('/users/:id', authenticateToken, isAnyAdmin, async (req, res) => {
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
        const hashedCid = cid ? crypto.createHash('sha256').update(cid).digest('hex') : null;

        let sql, params;
        if (isCentralAdmin) {
            sql = 'UPDATE users SET username = ?, role = ?, dept_id = ?, firstname = ?, lastname = ?, hospcode = ?, phone = ?, email = ?, cid = ?';
            params = [username, role, finalDeptId, firstname, lastname, hospcode, phone, email || null, hashedCid];
        } else {
            // local admin: ไม่แก้ role
            sql = 'UPDATE users SET username = ?, dept_id = ?, firstname = ?, lastname = ?, hospcode = ?, phone = ?, email = ?, cid = ?';
            params = [username, finalDeptId, firstname, lastname, hospcode, phone, email || null, hashedCid];
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

        await db.query('DELETE FROM users WHERE id = ?', [userId]);
        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'DELETE', 'users', userId, JSON.stringify({ message: `Deleted ID: ${userId}` }), req.ip]
        );
        res.json({ success: true, message: 'Deleted' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

apiRouter.put('/users/:id/reset-password', authenticateToken, isAnyAdmin, async (req, res) => {
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

apiRouter.get('/system-logs', async (req, res) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false });

    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้องหรือหมดอายุ' }); }
    if (user.role !== 'admin_ssj' && user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบเท่านั้น' });

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

apiRouter.get('/settings', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM system_settings');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching settings' });
    }
});

apiRouter.post('/settings', async (req, res) => {
    const settings = req.body; // Expect array of { key, value }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

    let user;
    try { user = jwt.verify(token, SECRET_KEY); } catch (err) { return res.status(403).json({ success: false }); }

    if (user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super Admin only' });

    const connection = await db.getConnection();
    try {
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
        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ success: false, message: 'Update failed' });
    } finally {
        connection.release();
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

apiRouter.post('/main-yut', authenticateToken, isSuperAdmin, async (req, res) => {
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

apiRouter.put('/main-yut/:id', authenticateToken, isSuperAdmin, async (req, res) => {
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

apiRouter.post('/main-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
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

apiRouter.put('/main-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
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
        // กรองตาม dept ของ user (ยกเว้น super_admin เห็นทั้งหมด)
        if (user.role !== 'super_admin' && user.deptId != null) {
            whereClause = 'WHERE i.dept_id = ?';
            params.push(user.deptId);
        }
        const [rows] = await db.query(`
            SELECT i.*, mi.main_indicator_name, mi.yut_id, my.yut_name, d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN main_yut my ON mi.yut_id = my.id
            LEFT JOIN departments d ON i.dept_id = d.id
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

apiRouter.post('/indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    try {
        await db.query(
            `INSERT INTO kpi_indicators (kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, target_condition || null, weight || null, kpi_indicators_code || null, table_process || null, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types)]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, weight, kpi_indicators_code, is_active, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    try {
        await db.query(
            `UPDATE kpi_indicators SET kpi_indicators_name=?, kpi_indicators_id=?, main_indicator_id=?, dept_id=?, target_percentage=?, target_condition=?, weight=?, kpi_indicators_code=?, is_active=?, table_process=?, description=?, r9=?, moph=?, ssj=?, rmw=?, other=?, evaluation_mode=?, required_off_types=? WHERE id=?`,
            [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, target_condition || null, weight || null, kpi_indicators_code || null, is_active ? 1 : 0, table_process || null, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types), req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.delete('/indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting indicator' });
    }
});

// ========== KPI Sub-Indicators CRUD ==========
apiRouter.get('/sub-indicators', authenticateToken, async (req, res) => {
    try {
        const { indicator_id } = req.query;
        let sql = `SELECT si.*, i.kpi_indicators_name FROM kpi_sub_indicators si
                   LEFT JOIN kpi_indicators i ON si.indicator_id = i.id`;
        const params = [];
        if (indicator_id) { sql += ' WHERE si.indicator_id = ?'; params.push(indicator_id); }
        sql += ' ORDER BY si.indicator_id, si.sort_order, si.id';
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { indicator_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order } = req.body;
        if (!indicator_id || !sub_indicator_name) return res.status(400).json({ success: false, message: 'indicator_id + sub_indicator_name required' });
        const [r] = await db.query(
            `INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order) VALUES (?,?,?,?,?,?,?)`,
            [indicator_id, sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0]
        );
        res.json({ success: true, id: r.insertId, message: 'เพิ่มตัวชี้วัดย่อยสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order, is_active } = req.body;
        await db.query(
            `UPDATE kpi_sub_indicators SET sub_indicator_name=?, sub_indicator_code=?, target_percentage=?, weight=?, description=?, sort_order=?, is_active=? WHERE id=?`,
            [sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'แก้ไขสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/sub-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_sub_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-indicators/:id/toggle-active', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE kpi_sub_indicators SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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

// GET /sub-results/summary — aggregate ต่อ indicator + hospcode (รวม monthly breakdown)
apiRouter.get('/sub-results/summary', authenticateToken, async (req, res) => {
    try {
        const { year_bh, hospcode } = req.query;
        const conditions = [], params = [];
        if (year_bh) { conditions.push('sr.year_bh = ?'); params.push(year_bh); }
        if (hospcode) { conditions.push('sr.hospcode = ?'); params.push(hospcode); }
        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

        // Aggregate ต่อ (indicator_id, hospcode, year_bh):
        // - sub_count: จำนวน sub_indicator ที่เกี่ยวข้อง
        // - avg_target: AVG target ของแต่ละ sub (หารด้วยจำนวน sub ที่มีค่า)
        // - m10..m09: AVG actual_value ของ sub แต่ละเดือน (หารด้วยจำนวน sub)
        const [rows] = await db.query(`
            SELECT
                si.indicator_id,
                sr.hospcode,
                sr.year_bh,
                COUNT(DISTINCT si.id) AS sub_count,
                AVG(CASE WHEN sr.month_bh = 10 THEN CAST(NULLIF(sr.target_value,'') AS DECIMAL(20,4)) END) AS avg_target,
                AVG(CASE WHEN sr.month_bh = 10 THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m10,
                AVG(CASE WHEN sr.month_bh = 11 THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m11,
                AVG(CASE WHEN sr.month_bh = 12 THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m12,
                AVG(CASE WHEN sr.month_bh = 1  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m01,
                AVG(CASE WHEN sr.month_bh = 2  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m02,
                AVG(CASE WHEN sr.month_bh = 3  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m03,
                AVG(CASE WHEN sr.month_bh = 4  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m04,
                AVG(CASE WHEN sr.month_bh = 5  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m05,
                AVG(CASE WHEN sr.month_bh = 6  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m06,
                AVG(CASE WHEN sr.month_bh = 7  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m07,
                AVG(CASE WHEN sr.month_bh = 8  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m08,
                AVG(CASE WHEN sr.month_bh = 9  THEN CAST(NULLIF(sr.actual_value,'') AS DECIMAL(20,4)) END) AS m09
            FROM kpi_sub_results sr
            JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
            ${where}
            GROUP BY si.indicator_id, sr.hospcode, sr.year_bh
        `, params);

        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-results/upsert', authenticateToken, async (req, res) => {
    try {
        const { sub_indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status } = req.body;
        if (!sub_indicator_id || !year_bh || !hospcode || !month_bh) {
            return res.status(400).json({ success: false, message: 'sub_indicator_id, year_bh, hospcode, month_bh required' });
        }
        await db.query(
            `INSERT INTO kpi_sub_results (sub_indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id)
             VALUES (?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE target_value=VALUES(target_value), actual_value=VALUES(actual_value), status=VALUES(status), user_id=VALUES(user_id)`,
            [sub_indicator_id, year_bh, hospcode, month_bh, target_value || null, actual_value || null, status || 'Pending', req.user.userId]
        );
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
apiRouter.put('/indicators/:id/toggle-active', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE kpi_indicators SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling indicator' });
    }
});

apiRouter.put('/main-indicators/:id/toggle-active', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE kpi_main_indicators SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling main indicator' });
    }
});

apiRouter.put('/main-yut/:id/toggle-active', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE main_yut SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling strategy' });
    }
});

apiRouter.put('/departments/:id/toggle-active', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { is_active } = req.body;
        await db.query('UPDATE departments SET is_active = ? WHERE id = ?', [is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling department' });
    }
});

// อนุมัติผล KPI และ Lock ข้อมูล (รองรับทั้งรายการเดียวและหลายรายการ)
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

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'UNLOCK', 'kpi_results', JSON.stringify({ indicator_id, year_bh, hospcode, message: 'ปลดล็อคข้อมูล' }), req.ip]
        );

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
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [req.user.userId, 'UNLOCK_ALL', 'kpi_results', JSON.stringify({ year_bh, affected: result.affectedRows }), req.ip]
        );
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

        const inDateRange = startDate && effectiveEnd && today >= startDate && today <= effectiveEnd;
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

        let whereClause = "WHERE r.status = 'Pending' AND r.year_bh = ?";
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
apiRouter.post('/departments', authenticateToken, isSuperAdmin, async (req, res) => {
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

apiRouter.put('/departments/:id', authenticateToken, isSuperAdmin, async (req, res) => {
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

apiRouter.post('/announcements', authenticateToken, isSuperAdmin, async (req, res) => {
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

apiRouter.put('/announcements/:id', authenticateToken, isSuperAdmin, async (req, res) => {
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

apiRouter.put('/announcements/:id/activate', authenticateToken, isSuperAdmin, async (req, res) => {
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
        const [rows] = await db.query(
            `SELECT i.id, i.kpi_indicators_name, i.table_process, i.dept_id, i.main_indicator_id, i.is_active,
                    d.dept_name, mi.main_indicator_name
             FROM kpi_indicators i
             LEFT JOIN departments d ON i.dept_id = d.id
             LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
             WHERE i.table_process IS NOT NULL AND i.table_process != ''
             ORDER BY i.id`
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Core: ตรวจสอบเปรียบเทียบข้อมูล KPI — ใช้ทั้ง HTTP endpoint และ scheduler
async function checkKpiChanges(year_bh, indicator_ids) {
    if (!year_bh || !/^\d{4}$/.test(year_bh)) {
        return { success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' };
    }
    try {
        let indicatorQuery = `SELECT id, table_process, kpi_indicators_name FROM kpi_indicators
            WHERE table_process IS NOT NULL AND table_process != ''`;
        let indicatorParams = [];
        if (indicator_ids && indicator_ids !== 'all' && Array.isArray(indicator_ids) && indicator_ids.length > 0) {
            indicatorQuery += ` AND id IN (${indicator_ids.map(() => '?').join(',')})`;
            indicatorParams = indicator_ids;
        }
        const [indicators] = await db.query(indicatorQuery, indicatorParams);

        const months = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];
        const results = [];

        for (const indicator of indicators) {
            let tableName = indicator.table_process.trim().replace(/-/g, '_');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) {
                results.push({ id: indicator.id, status: 'invalid_name', has_data: false, new_count: 0, changed_count: 0, unchanged_count: 0, no_data: true });
                continue;
            }

            // ตรวจสอบว่ามีข้อมูลใน kpi_results หรือไม่
            const [kpiRows] = await db.query(
                'SELECT hospcode, month_bh, target_value, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ?',
                [indicator.id, year_bh]
            );

            if (kpiRows.length === 0) {
                results.push({ id: indicator.id, status: 'no_data', has_data: false, new_count: 0, changed_count: 0, unchanged_count: 0, no_data: true });
                continue;
            }

            // Pivot kpi_results — เก็บค่าเป็น string (ไม่แปลงเป็นเลขทันที กัน "" → 0)
            const dataMap = new Map();
            for (const row of kpiRows) {
                if (!dataMap.has(row.hospcode)) dataMap.set(row.hospcode, {});
                const entry = dataMap.get(row.hospcode);
                const mKey = 'm' + String(row.month_bh).padStart(2, '0');
                entry[mKey] = row.actual_value != null ? String(row.actual_value) : null;
                if (String(row.month_bh) === '10') {
                    entry.target = row.target_value != null ? String(row.target_value) : null;
                }
            }

            // ตรวจสอบตาราง export มีอยู่หรือไม่
            let existingMap = new Map();
            try {
                const [existingRows] = await db.query(
                    `SELECT hospcode, target, result, m10, m11, m12, m01, m02, m03, m04, m05, m06, m07, m08, m09 FROM \`${tableName}\` WHERE byear = ?`,
                    [year_bh]
                );
                for (const row of existingRows) existingMap.set(row.hospcode, row);
            } catch (_) {
                // ตารางยังไม่มี — ทุก row เป็น new
            }

            // Helper เทียบค่า — ใช้เหมือนใน performKpiExport (numeric-aware)
            const emptyToNull = v => (v === '' || v === undefined) ? null : v;
            const sameValue = (a, b) => {
                const na = a === null || a === undefined || a === '' ? null : a;
                const nb = b === null || b === undefined || b === '' ? null : b;
                if (na === null && nb === null) return true;
                if (na === null || nb === null) return false;
                const fa = parseFloat(na), fb = parseFloat(nb);
                if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
                return String(na) === String(nb);
            };
            // ข้าม hospcode ที่ไม่มี "ผลงาน" จริง (ต้องมีเดือนใดเดือนหนึ่งที่ actual_value ไม่ว่าง/≠0)
            const hasActualResult = (d) => {
                for (const m of months) {
                    const v = d[m];
                    if (v !== null && v !== undefined && v !== '' && v !== '0') return true;
                }
                return false;
            };

            let newCount = 0, changedCount = 0, unchangedCount = 0;
            for (const [hc, d] of dataMap) {
                if (!hasActualResult(d)) continue; // ไม่มีผลงาน → ไม่นับ (matches export behavior)
                const target = emptyToNull(d.target);
                const monthValues = months.map(m => emptyToNull(d[m]));
                // result = ค่าเดือนล่าสุดที่คีย์ (ก.ย.→ต.ค.) — เหมือน performKpiExport
                const reverseMonths = [...monthValues].reverse();
                const lastActual = reverseMonths.find(v => v !== null && v !== undefined);
                const resultVal = lastActual !== undefined ? lastActual : null;

                const existing = existingMap.get(hc);
                if (!existing) {
                    newCount++;
                } else {
                    const changed =
                        !sameValue(existing.target, target) ||
                        !sameValue(existing.result, resultVal) ||
                        months.some((m, idx) => !sameValue(existing[m], monthValues[idx]));
                    if (changed) changedCount++;
                    else unchangedCount++;
                }
            }

            results.push({
                id: indicator.id,
                status: (newCount > 0 || changedCount > 0) ? 'has_changes' : 'up_to_date',
                has_data: true,
                hospcode_count: dataMap.size,
                new_count: newCount,
                changed_count: changedCount,
                unchanged_count: unchangedCount,
                no_data: false
            });
        }

        const totalWithData = results.filter(r => r.has_data).length;
        const totalChanges = results.filter(r => r.status === 'has_changes').length;
        const totalUpToDate = results.filter(r => r.status === 'up_to_date').length;
        const totalNoData = results.filter(r => r.no_data).length;

        return {
            success: true,
            check_date: new Date().toISOString(),
            year_bh,
            summary: { total: results.length, with_data: totalWithData, has_changes: totalChanges, up_to_date: totalUpToDate, no_data: totalNoData },
            details: results
        };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

// HTTP wrapper
apiRouter.post('/check-kpi-export', authenticateToken, isSuperAdmin, async (req, res) => {
    const result = await checkKpiChanges(req.body.year_bh, req.body.indicator_ids);
    if (!result.success) return res.status(result.message?.includes('กรุณา') ? 400 : 500).json(result);
    res.json(result);
});

// สร้างตาราง MySQL แยกรายตัวชี้วัด พร้อมข้อมูลคะแนนทุก hospcode
// Core function: ใช้ทั้งจาก HTTP endpoint และ scheduler
async function performKpiExport(year_bh, indicator_ids, userId) {
    if (!year_bh || !/^\d{4}$/.test(year_bh)) {
        return { success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' };
    }
    if (!indicator_ids || (indicator_ids !== 'all' && !Array.isArray(indicator_ids))) {
        return { success: false, message: 'กรุณาระบุ indicator_ids เป็น array หรือ "all"' };
    }
    const conn = await db.getConnection();
    try {
        // 1. Get indicators with valid table_process
        let indicatorQuery = `SELECT id, table_process, kpi_indicators_name FROM kpi_indicators
            WHERE is_active = 1 AND table_process IS NOT NULL AND table_process != ''`;
        let indicatorParams = [];

        if (indicator_ids !== 'all' && Array.isArray(indicator_ids) && indicator_ids.length > 0) {
            indicatorQuery += ` AND id IN (${indicator_ids.map(() => '?').join(',')})`;
            indicatorParams = indicator_ids;
        }

        const [allIndicators] = await conn.query(indicatorQuery, indicatorParams);

        const created = [];
        const skipped = [];

        // Prefilter: เก็บเฉพาะตัวชี้วัดที่มีข้อมูลใน kpi_results (target_value หรือ actual_value)
        let indicators = [];
        if (allIndicators.length > 0) {
            const indIds = allIndicators.map(i => i.id);
            const [withData] = await conn.query(
                `SELECT DISTINCT indicator_id FROM kpi_results
                 WHERE indicator_id IN (${indIds.map(() => '?').join(',')})
                 AND year_bh = ?
                 AND ((target_value IS NOT NULL AND target_value != '') OR (actual_value IS NOT NULL AND actual_value != ''))`,
                [...indIds, year_bh]
            );
            const validIds = new Set(withData.map(r => r.indicator_id));
            for (const ind of allIndicators) {
                if (validIds.has(ind.id)) indicators.push(ind);
                else skipped.push({ id: ind.id, name: ind.kpi_indicators_name, table_process: ind.table_process, reason: 'ไม่มีข้อมูลใน kpi_results' });
            }
        }

        // ตารางมีคอลัมน์เดือน (m10-m09) เสมอ + เพิ่ม form fields ถ้ามี
        const baseColsWithMonths = 'hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) DEFAULT NULL, result VARCHAR(100) DEFAULT NULL, m10 VARCHAR(100) DEFAULT NULL, m11 VARCHAR(100) DEFAULT NULL, m12 VARCHAR(100) DEFAULT NULL, m01 VARCHAR(100) DEFAULT NULL, m02 VARCHAR(100) DEFAULT NULL, m03 VARCHAR(100) DEFAULT NULL, m04 VARCHAR(100) DEFAULT NULL, m05 VARCHAR(100) DEFAULT NULL, m06 VARCHAR(100) DEFAULT NULL, m07 VARCHAR(100) DEFAULT NULL, m08 VARCHAR(100) DEFAULT NULL, m09 VARCHAR(100) DEFAULT NULL';

        const tableDDL = (name, extraCols) => {
            let cols = baseColsWithMonths;
            if (extraCols && extraCols.length > 0) {
                cols += ', ' + extraCols.map(f => `\`${f.field_name}\` VARCHAR(500) DEFAULT NULL`).join(', ');
            }
            return `CREATE TABLE IF NOT EXISTS \`${name}\` (${cols}, create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (hospcode, byear)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
        };

        // Helper: ALTER TABLE เพิ่มคอลัมน์ dynamic (form fields) ที่ยังไม่มี
        const ensureDynamicCols = async (conn2, tableName2, extraCols) => {
            for (const f of extraCols) {
                try { await conn2.query(`ALTER TABLE \`${tableName2}\` ADD COLUMN \`${f.field_name}\` VARCHAR(500) DEFAULT NULL`); } catch (e) { /* already exists */ }
            }
        };

        // Helper: ALTER TABLE เพิ่มคอลัมน์เดือน (m10-m09, result) ที่ยังไม่มี — สำหรับตารางเก่าที่สร้างโดยไม่มีเดือน
        const ensureMonthCols = async (conn2, tableName2) => {
            const monthCols = ['m10','m11','m12','m01','m02','m03','m04','m05','m06','m07','m08','m09','result'];
            for (const col of monthCols) {
                try { await conn2.query(`ALTER TABLE \`${tableName2}\` ADD COLUMN \`${col}\` VARCHAR(100) DEFAULT NULL`); } catch (e) { /* already exists */ }
            }
        };

        const months = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];

        for (const indicator of indicators) {
            // Sanitize table name (export ใช้ชื่อ table_process ตรงๆ, form builder ใช้ form_ prefix)
            let tableName = indicator.table_process.trim().replace(/-/g, '_');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) {
                skipped.push({ id: indicator.id, name: indicator.kpi_indicators_name, table_process: indicator.table_process, reason: 'ชื่อตารางไม่ถูกต้อง' });
                continue;
            }

            await conn.beginTransaction();
            try {
                // ดึง form schema + fields สำหรับ indicator นี้
                const [schemaRows] = await conn.query(
                    `SELECT fs.id, fs.actual_value_field FROM kpi_form_schemas fs WHERE fs.indicator_id = ? AND fs.is_active = 1 LIMIT 1`,
                    [indicator.id]
                );
                let formFields = [];
                let dynamicTableName = null;
                if (schemaRows.length > 0) {
                    const [fields] = await conn.query(
                        'SELECT field_name, field_label, field_type FROM kpi_form_fields WHERE schema_id = ? ORDER BY sort_order',
                        [schemaRows[0].id]
                    );
                    formFields = fields.filter(f => isValidIdentifier(f.field_name));
                    // ดึงชื่อ dynamic table จาก kpi_indicators.table_process (ใช้ตัวเดียวกับ export)
                    // dynamic data table ใช้ prefix form_ + table_process
                    const [dynTbl] = await conn.query('SELECT table_process FROM kpi_indicators WHERE id = ?', [indicator.id]);
                    if (dynTbl.length > 0 && dynTbl[0].table_process) {
                        const dynName = 'form_' + dynTbl[0].table_process;
                        try {
                            await conn.query(`SELECT 1 FROM \`${dynName}\` LIMIT 0`);
                            dynamicTableName = dynName;
                        } catch (e) { /* table ไม่มี = ไม่มี dynamic data */ }
                    }
                }

                const hasForm = formFields.length > 0;
                // Create export table: มีคอลัมน์เดือนเสมอ + เพิ่ม form fields ถ้ามี
                await conn.query(tableDDL(tableName, formFields));
                // ตารางเก่าที่ไม่มีคอลัมน์เดือน → ALTER เพิ่ม
                await ensureMonthCols(conn, tableName);
                if (hasForm) await ensureDynamicCols(conn, tableName, formFields);

                // Fetch kpi_results for this indicator + year
                const [results] = await conn.query(
                    'SELECT hospcode, month_bh, target_value, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ?',
                    [indicator.id, year_bh]
                );

                // Build hospcode -> month data map
                const dataMap = new Map();
                for (const row of results) {
                    if (!dataMap.has(row.hospcode)) dataMap.set(row.hospcode, {});
                    const entry = dataMap.get(row.hospcode);
                    const mKey = 'm' + String(row.month_bh).padStart(2, '0');
                    entry[mKey] = row.actual_value != null ? String(row.actual_value) : null;
                    if (String(row.month_bh) === '10') {
                        entry.target = row.target_value != null ? String(row.target_value) : null;
                    }
                }

                // ดึง dynamic form data (ถ้ามี) → merge เข้า dataMap
                if (dynamicTableName && formFields.length > 0) {
                    const dynFieldNames = formFields.map(f => `\`${f.field_name}\``).join(', ');
                    try {
                        const [dynRows] = await conn.query(
                            `SELECT hospcode, ${dynFieldNames} FROM \`${dynamicTableName}\` WHERE year_bh = ? AND indicator_id = ?`,
                            [year_bh, indicator.id]
                        );
                        for (const row of dynRows) {
                            if (!dataMap.has(row.hospcode)) dataMap.set(row.hospcode, {});
                            const entry = dataMap.get(row.hospcode);
                            for (const f of formFields) {
                                // ถ้ามีหลาย record ต่อ hospcode → ใช้ค่าล่าสุด (อาจ overwrite)
                                if (row[f.field_name] !== undefined && row[f.field_name] !== null) {
                                    entry['_dyn_' + f.field_name] = String(row[f.field_name]);
                                }
                            }
                        }
                    } catch (e) { /* dynamic table query failed - skip */ }
                }

                // Build upsert rows
                const upsertRows = [];
                let updatedCount = 0;
                let insertedCount = 0;
                let unchangedCount = 0;
                const dynFieldKeys = formFields.map(f => f.field_name);

                // แปลง '' → null (MySQL reject empty string ถ้า column เป็น DECIMAL/INT)
                const emptyToNull = v => (v === '' || v === undefined) ? null : v;

                // ดึงข้อมูลเดิมจากตาราง export (เปรียบเทียบค่า ไม่ใช่เวลา) — content-based diff
                const existingDataMap = new Map();
                try {
                    const selectCols = ['hospcode', 'target', 'result', ...months, ...dynFieldKeys.map(k => `\`${k}\``)].join(', ');
                    const [existingRows] = await conn.query(
                        `SELECT ${selectCols} FROM \`${tableName}\` WHERE byear = ?`,
                        [year_bh]
                    );
                    for (const r of existingRows) existingDataMap.set(r.hospcode, r);
                } catch (e) { /* table เพิ่งสร้าง/ไม่มีคอลัมน์ครบ — ถือว่าไม่มี row เดิม */ }

                // ข้าม hospcode ที่ไม่มี "ผลงาน" จริง — ต้องมีเดือนใดเดือนหนึ่งที่ actual_value ไม่ว่าง/≠0
                // หรือมี dynamic form data (กรณีตัวชี้วัดใช้ฟอร์ม) — target อย่างเดียวไม่พอ
                const hasActualData = (d) => {
                    for (const m of months) {
                        const v = d[m];
                        if (v !== null && v !== undefined && v !== '' && v !== '0') return true;
                    }
                    for (const k of dynFieldKeys) {
                        const v = d['_dyn_' + k];
                        if (v !== null && v !== undefined && v !== '') return true;
                    }
                    return false;
                };

                // เปรียบเทียบค่า 2 ตัว ยอมให้ null/'' ถือว่าเท่ากัน + ตัวเลขเทียบแบบ numeric
                const sameValue = (a, b) => {
                    const na = a === null || a === undefined || a === '' ? null : a;
                    const nb = b === null || b === undefined || b === '' ? null : b;
                    if (na === null && nb === null) return true;
                    if (na === null || nb === null) return false;
                    // ลอง numeric compare ก่อน (กัน "80" vs 80 vs "80.00")
                    const fa = parseFloat(na), fb = parseFloat(nb);
                    if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
                    return String(na) === String(nb);
                };

                let noDataCount = 0;

                for (const [hc, d] of dataMap) {
                    if (!hasActualData(d)) { noDataCount++; continue; }

                    const target = emptyToNull(d.target);
                    const dynValues = dynFieldKeys.map(k => emptyToNull(d['_dyn_' + k]));
                    const monthValues = months.map(m => emptyToNull(d[m]));
                    // result = ค่าล่าสุดที่คีย์ (เดือนท้ายสุดตามปีงบ: ก.ย.→ต.ค.)
                    const reverseMonths = [...monthValues].reverse();
                    const lastActual = reverseMonths.find(v => v !== null && v !== undefined);
                    const resultVal = lastActual !== undefined ? lastActual : null;

                    // เปรียบเทียบค่าเดิม vs ใหม่ ทีละคอลัมน์
                    const existing = existingDataMap.get(hc);
                    if (existing) {
                        const changed =
                            !sameValue(existing.target, target) ||
                            !sameValue(existing.result, resultVal) ||
                            months.some((m, idx) => !sameValue(existing[m], monthValues[idx])) ||
                            dynFieldKeys.some((k, idx) => !sameValue(existing[k], dynValues[idx]));
                        if (!changed) { unchangedCount++; continue; }
                        updatedCount++;
                    } else {
                        insertedCount++;
                    }

                    upsertRows.push([hc, year_bh, target, resultVal, ...monthValues, ...dynValues]);
                }

                // Batch UPSERT
                if (upsertRows.length > 0) {
                    const colsList = ['hospcode', 'byear', 'target', 'result', ...months, ...dynFieldKeys.map(k => `\`${k}\``)];
                    const onDupParts = ['target=VALUES(target)', 'result=VALUES(result)', ...months.map(m => `${m}=VALUES(${m})`), ...dynFieldKeys.map(k => `\`${k}\`=VALUES(\`${k}\`)`)];
                    const cols = colsList.join(', ');
                    const onDup = onDupParts.join(', ');
                    const singlePlaceholder = '(' + Array(colsList.length).fill('?').join(',') + ')';

                    for (let i = 0; i < upsertRows.length; i += 100) {
                        const batch = upsertRows.slice(i, i + 100);
                        const placeholders = batch.map(() => singlePlaceholder).join(',');
                        const flatValues = batch.flat();
                        await conn.query(`INSERT INTO \`${tableName}\` (${cols}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${onDup}`, flatValues);
                    }
                }

                await conn.commit();
                created.push({
                    table: tableName,
                    name: indicator.kpi_indicators_name,
                    total_hospcode: dataMap.size,
                    inserted: insertedCount,
                    updated: updatedCount,
                    unchanged: unchangedCount,
                    no_data: noDataCount
                });
            } catch (tableErr) {
                await conn.rollback();
                skipped.push({ id: indicator.id, name: indicator.kpi_indicators_name, table_process: indicator.table_process, reason: tableErr.message });
            }
        }

        conn.release();

        // Log action
        try {
            await db.query(
                'INSERT INTO system_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
                [userId || null, 'export_kpi_tables', `Export ${created.length} tables for year ${year_bh}`, 'scheduler']
            );
        } catch (_) {}

        const totalInserted = created.reduce((s, t) => s + t.inserted, 0);
        const totalUpdated = created.reduce((s, t) => s + t.updated, 0);
        const totalUnchanged = created.reduce((s, t) => s + t.unchanged, 0);
        const totalNoData = created.reduce((s, t) => s + (t.no_data || 0), 0);

        return {
            success: true,
            message: `สร้าง/อัปเดตตารางสำเร็จ ${created.length} ตาราง`,
            created_tables: created,
            skipped,
            summary: { inserted: totalInserted, updated: totalUpdated, unchanged: totalUnchanged, no_data: totalNoData }
        };
    } catch (err) {
        try { conn.release(); } catch(_) {}
        return { success: false, message: err.message };
    }
}

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

    const tablesHtml = (result.created_tables || []).slice(0, 30).map(t =>
        `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${t.table}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">+${t.inserted}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">~${t.updated}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">=${t.unchanged}</td></tr>`
    ).join('');

    // Sync-to-HDC summary (ถ้ามี)
    const sync = result.sync;
    const syncHtml = sync ? `
        <div style="margin-top:16px;padding:14px;border-radius:10px;background:${sync.success ? '#ecfdf5' : '#fef2f2'};border-left:4px solid ${sync.success ? '#10b981' : '#ef4444'}">
          <h3 style="margin:0 0 8px;color:${sync.success ? '#065f46' : '#991b1b'};font-size:14px">
            ${sync.success ? '☁️ Sync ไปยัง HDC สำเร็จ' : '⚠️ Sync ไปยัง HDC ผิดพลาดบางส่วน'}
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
        <p style="margin:4px 0 0;opacity:.85;font-size:13px">${schedule.name} — ${new Date().toLocaleString('th-TH')}</p>
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
        ${tablesHtml ? `<h3 style="margin:16px 0 8px;color:#374151;font-size:14px">ตารางที่ประมวลผล (${tablesCount}):</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#f9fafb">
          <th style="padding:6px 8px;text-align:left">ตาราง</th>
          <th style="padding:6px 8px;text-align:center">เพิ่ม</th>
          <th style="padding:6px 8px;text-align:center">อัปเดต</th>
          <th style="padding:6px 8px;text-align:center">เดิม</th>
        </tr></thead><tbody>${tablesHtml}</tbody></table>` : ''}
        ${syncHtml}
        <div style="background:#fef9c3;border-left:4px solid #eab308;padding:12px;margin-top:16px;border-radius:4px">
          <p style="margin:0;color:#713f12;font-size:13px">
            ${sync
              ? `📬 ระบบส่งข้อมูลเข้า HDC เรียบร้อยแล้ว — กรุณาตรวจสอบที่ <a href="https://apikorat.moph.go.th/khupskpi/">Korat Health KPI</a>`
              : `⚠️ <b>กรุณาตรวจสอบผลก่อนส่งไปยัง HDC</b> โดยเข้าระบบที่ <a href="https://apikorat.moph.go.th/khupskpi/">Korat Health KPI</a> → จัดการข้อมูล KPI → Tab "Export ข้อมูล"`}
          </p>
        </div>
      </div>
    </div>`;

    // ดึง recipients จาก system_settings (ไม่ใช่จาก schedule)
    const ns = await getNotifSettings();
    let sentEmail = false, sentTelegram = false;

    if (Number(schedule.notify_email) === 1 && ns.adminEmails) {
        const recipients = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of recipients) {
            try { await sendMail(email, subject, html); sentEmail = true; } catch (e) {}
        }
    }
    if (Number(schedule.notify_telegram) === 1 && ns.tgToken && ns.tgChatId) {
        const chatIds = ns.tgChatId.split(',').map(c => c.trim()).filter(Boolean);
        const syncBlock = sync
          ? `\n☁️ *Sync ไปยัง HDC:*\n` +
            `• ${sync.success ? 'สำเร็จ' : 'มีข้อผิดพลาด'}: *${sync.summary.success}/${sync.summary.total}* ตาราง\n` +
            `• Rows: *${sync.summary.rows}*\n` +
            (sync.summary.error > 0 ? `• ผิดพลาด: *${sync.summary.error}*\n` : '')
          : '';
        const footer = sync ? '📬 ข้อมูลถูกส่งเข้า HDC แล้ว' : '⚠️ กรุณาตรวจสอบก่อนส่ง HDC';
        const tgMsg = `📊 *รายงาน Export KPI — ${schedule.name}*\n\n` +
            `สถานะ: ${result.success ? '✅ สำเร็จ' : '❌ ผิดพลาด'}\n` +
            `⏱ เวลา: ${(durationMs/1000).toFixed(1)} วินาที\n\n` +
            `📋 สรุปผล:\n` +
            `• เพิ่มใหม่: *${summary.inserted}*\n` +
            `• อัปเดต: *${summary.updated}*\n` +
            `• ไม่เปลี่ยน: *${summary.unchanged}*\n` +
            `• ตารางทั้งหมด: *${tablesCount}*\n` +
            syncBlock + '\n' +
            footer;
        for (const chatId of chatIds) {
            try { await sendTelegramDirect(ns.tgToken, chatId, tgMsg); sentTelegram = true; } catch (e) {}
        }
    }
    return { sentEmail, sentTelegram };
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

        // Auto-sync to HDC ถ้า export สำเร็จและมีตารางและเปิด auto_sync_hdc
        if (Number(schedule.auto_sync_hdc) === 1 && result.success && (result.created_tables || []).length > 0) {
            try {
                const syncTables = result.created_tables.map(t => ({ table: t.table, sync_columns: null }));
                const syncOut = await performSyncToHdc(syncTables, schedule.created_by);
                result.sync = syncOut;
                if (!syncOut.success) { status = 'partial'; errorMsg = 'Export สำเร็จแต่ sync HDC มีข้อผิดพลาด'; }
            } catch (e) {
                result.sync = { success: false, message: e.message, summary: { total: 0, success: 0, error: 0, skipped: 0, rows: 0 }, results: [] };
                status = 'partial'; errorMsg = `Sync HDC failed: ${e.message}`;
            }
        }
    } catch (e) {
        result = { success: false, message: e.message };
        status = 'failed'; errorMsg = e.message;
    }
    const duration = Date.now() - startTime;

    // ส่ง notification
    let notif = { sentEmail: false, sentTelegram: false };
    try { notif = await sendExportNotification(schedule, result, duration); } catch (_) {}

    // อัปเดต last_run + log
    await db.query('UPDATE export_schedules SET last_run_at=NOW(), last_status=? WHERE id=?', [status, schedule.id]);
    const summary = result.summary || { inserted: 0, updated: 0, unchanged: 0, no_data: 0 };
    await db.query(
        `INSERT INTO export_schedule_logs (schedule_id, status, inserted, updated_count, unchanged, no_data, tables_count, skipped_count, duration_ms, notified_email, notified_telegram, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [schedule.id, status, summary.inserted, summary.updated, summary.unchanged, summary.no_data,
         (result.created_tables || []).length, (result.skipped || []).length, duration,
         notif.sentEmail ? 1 : 0, notif.sentTelegram ? 1 : 0, errorMsg]
    );
    return result;
}

// Scheduler loop: ตรวจทุก 60 วินาที
function startExportScheduler() {
    const check = async () => {
        try {
            const now = new Date();
            const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
            const dow = now.getDay() === 0 ? 7 : now.getDay(); // 1=จ., 7=อา.
            // ดึง schedules ที่ตรงเวลาและยังไม่ได้รันในนาทีนี้
            const [schedules] = await db.query(
                `SELECT * FROM export_schedules WHERE is_enabled=1 AND time_of_day=?
                 AND (last_run_at IS NULL OR TIMESTAMPDIFF(SECOND, last_run_at, NOW()) > 90)`,
                [hhmm]
            );
            for (const s of schedules) {
                const days = (s.days_of_week || '').split(',').map(d => parseInt(d.trim()));
                if (days.includes(dow)) {
                    console.log(`[Scheduler] Running export: ${s.name} (${hhmm})`);
                    runScheduledExport(s).catch(e => console.error('[Scheduler] Error:', e.message));
                }
            }
        } catch (e) { /* ignore */ }
    };
    setInterval(check, 60000); // ทุก 1 นาที
    console.log('[Scheduler] Export scheduler started');
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
        const { name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_hdc, notify_email, notify_telegram } = req.body;
        if (!name || !days_of_week || !time_of_day) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' });
        const scope = ['all', 'selected', 'changes_only'].includes(indicator_scope) ? indicator_scope : 'all';
        const [r] = await db.query(
            `INSERT INTO export_schedules (name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_hdc, notify_email, notify_telegram, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, is_enabled ? 1 : 0, days_of_week, time_of_day, year_bh || null,
             scope === 'selected' && Array.isArray(indicator_ids) ? JSON.stringify(indicator_ids) : null,
             scope, auto_sync_hdc ? 1 : 0,
             notify_email ? 1 : 0, notify_telegram ? 1 : 0, req.user.id]
        );
        res.json({ success: true, id: r.insertId, message: 'สร้าง schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/export-schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_hdc, notify_email, notify_telegram } = req.body;
        const scope = ['all', 'selected', 'changes_only'].includes(indicator_scope) ? indicator_scope : 'all';
        await db.query(
            `UPDATE export_schedules SET name=?, is_enabled=?, days_of_week=?, time_of_day=?, year_bh=?, indicator_ids=?, indicator_scope=?, auto_sync_hdc=?, notify_email=?, notify_telegram=? WHERE id=?`,
            [name, is_enabled ? 1 : 0, days_of_week, time_of_day, year_bh || null,
             scope === 'selected' && Array.isArray(indicator_ids) ? JSON.stringify(indicator_ids) : null,
             scope, auto_sync_hdc ? 1 : 0,
             notify_email ? 1 : 0, notify_telegram ? 1 : 0, req.params.id]
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

// POST /sync-to-hdc/preview — ตรวจสอบข้อมูลก่อนส่ง HDC
apiRouter.post('/sync-to-hdc/preview', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (HDC)' });
    try {
        // ดึงตาราง export ทั้งหมดจาก local (table_process ที่มีข้อมูล)
        const [indicators] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process
            FROM kpi_indicators i
            WHERE i.is_active = 1 AND i.table_process IS NOT NULL AND i.table_process != ''
        `);
        // deduplicate ตาม table_process
        const tableMap = new Map();
        for (const ind of indicators) {
            const tp = ind.table_process.trim();
            if (!tableMap.has(tp)) tableMap.set(tp, { table: tp, names: [], ids: [] });
            tableMap.get(tp).names.push(ind.kpi_indicators_name);
            tableMap.get(tp).ids.push(ind.id);
        }
        const tables = [];
        for (const [tp, info] of tableMap) {
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tp)) continue;
            const item = { table: tp, name: info.names.join(' | '), local_rows: 0, remote_rows: 0, local_columns: [], remote_columns: [], status: 'unknown' };
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

// Core: sync export tables to HDC — ใช้ร่วมกัน (HTTP + scheduler auto_sync_hdc)
async function performSyncToHdc(tables, userId) {
    const remoteDb = getRemotePool();
    if (!remoteDb) return { success: false, message: 'ไม่ได้ตั้งค่า Remote DB (HDC)', results: [] };
    if (!Array.isArray(tables) || tables.length === 0) return { success: false, message: 'ไม่มีตารางที่จะ sync', results: [] };
    const results = [];
    for (const t of tables) {
        const tp = t.table;
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tp)) { results.push({ table: tp, status: 'skipped', reason: 'ชื่อตารางไม่ถูกต้อง' }); continue; }
        let cols = t.sync_columns;
        if (!cols || cols.length === 0) {
            // auto-detect common columns ถ้าไม่ส่งมา (scheduler)
            try {
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tp}\``);
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tp}\``);
                const local = localCols.map(c => c.Field);
                const remote = remoteCols.map(c => c.Field);
                cols = local.filter(c => remote.includes(c));
            } catch (e) { results.push({ table: tp, status: 'skipped', reason: 'ตาราง HDC ยังไม่มี' }); continue; }
            if (cols.length === 0) { results.push({ table: tp, status: 'skipped', reason: 'ไม่มีคอลัมน์ที่ตรงกัน' }); continue; }
        }
        try {
            const colList = cols.map(c => `\`${c}\``).join(', ');
            const [localRows] = await db.query(`SELECT ${colList} FROM \`${tp}\``);
            if (localRows.length === 0) { results.push({ table: tp, status: 'skipped', reason: 'ไม่มีข้อมูลใน local', rows: 0 }); continue; }
            const placeholders = cols.map(() => '?').join(', ');
            const updateCols = cols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
            let upserted = 0;
            for (const row of localRows) {
                const vals = cols.map(c => row[c] !== undefined ? row[c] : null);
                await remoteDb.query(`INSERT INTO \`${tp}\` (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateCols}`, vals);
                upserted++;
            }
            results.push({ table: tp, status: 'success', rows: upserted });
        } catch (e) {
            results.push({ table: tp, status: 'error', reason: e.message });
        }
    }
    try {
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [userId || null, 'SYNC_TO_HDC', 'multiple', JSON.stringify({ tables: results.length, success: results.filter(r => r.status === 'success').length }), null]
        );
    } catch (_) {}
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const totalRows = results.filter(r => r.status === 'success').reduce((s, r) => s + r.rows, 0);
    return {
        success: errorCount === 0,
        message: `ส่งข้อมูลสำเร็จ ${successCount}/${results.length} ตาราง (${totalRows} rows)`,
        results,
        summary: { total: results.length, success: successCount, error: errorCount, skipped: results.length - successCount - errorCount, rows: totalRows }
    };
}

// POST /sync-to-hdc/execute — ส่งข้อมูลจาก local export tables เข้า HDC
apiRouter.post('/sync-to-hdc/execute', authenticateToken, isSuperAdmin, async (req, res) => {
    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตารางที่ต้องการ' });
    const out = await performSyncToHdc(tables, req.user.userId);
    if (!out.success && out.results.length === 0) return res.status(400).json(out);
    res.json(out);
});

// ========== KPI Summary (Materialized View) ==========

// POST /refresh-summary/prepare — ล้างข้อมูลเก่า + ส่ง indicator_ids กลับให้ frontend batch
apiRouter.post('/refresh-summary/prepare', authenticateToken, isSuperAdmin, async (req, res) => {
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
        const allIds = indRows.map(r => r.indicator_id);
        res.json({ success: true, indicator_ids: allIds, total: allIds.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /refresh-summary/batch — ประมวลผลทีละ batch (frontend ส่ง indicator_ids มา)
apiRouter.post('/refresh-summary/batch', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { indicator_ids, year_bh } = req.body;
        if (!Array.isArray(indicator_ids) || indicator_ids.length === 0) {
            return res.json({ success: true, inserted: 0 });
        }
        const yearFilter = year_bh ? 'AND r.year_bh = ?' : '';
        const yearParams = year_bh ? [year_bh] : [];
        const idPlaceholders = indicator_ids.map(() => '?').join(',');

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
            HAVING MAX(CASE WHEN r.actual_value IS NOT NULL AND r.actual_value != '' AND r.actual_value != '0' THEN 1 ELSE 0 END) = 1
        `, [...indicator_ids, ...yearParams]);

        res.json({ success: true, inserted: result.affectedRows || 0 });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /refresh-summary/finalize — อัปเดต last_actual + has_form_schema
apiRouter.post('/refresh-summary/finalize', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const year = req.body.year_bh || '';
        const lastActualWhere = year ? `WHERE year_bh = ?` : '';
        const lastActualParams = year ? [year] : [];

        await db.query(`
            UPDATE kpi_summary SET last_actual = COALESCE(
                NULLIF(sep,''), NULLIF(aug,''), NULLIF(jul,''), NULLIF(jun,''),
                NULLIF(may,''), NULLIF(apr,''), NULLIF(mar,''), NULLIF(feb,''),
                NULLIF(jan,''), NULLIF(dece,''), NULLIF(nov,''), NULLIF(oct,'')
            ) ${lastActualWhere}
        `, lastActualParams);

        const [formSchemas] = await db.query('SELECT indicator_id FROM kpi_form_schemas WHERE is_active = 1');
        if (formSchemas.length > 0) {
            const ids = formSchemas.map(f => f.indicator_id);
            await db.query('UPDATE kpi_summary SET has_form_schema = 1 WHERE indicator_id IN (' + ids.join(',') + ')');
        }

        res.json({ success: true, message: 'Finalize สำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// GET /kpi-summary — ดึงข้อมูลจาก summary table (เร็วมาก ไม่ต้อง JOIN)
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

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.indicator_id,
                MAX(s.kpi_indicators_name) AS kpi_indicators_name,
                MAX(s.main_indicator_name) AS main_indicator_name,
                MAX(s.dept_name) AS dept_name,
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
                COUNT(DISTINCT s.hospcode) AS hospital_count
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.indicator_id, s.year_bh
            ORDER BY MAX(s.main_indicator_name), MAX(s.kpi_indicators_name)
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
                CASE WHEN SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) > 0
                     THEN ROUND((SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) / SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4)))) * 100, 2)
                     ELSE 0 END AS achievement_pct,
                SUM(CASE WHEN s.indicator_status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(s.pending_count) AS pending_count
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.hospcode, s.year_bh
            ORDER BY MAX(s.distname), MAX(s.hosname)
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
                CASE WHEN SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) > 0
                     THEN ROUND((SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) / SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4)))) * 100, 2)
                     ELSE 0 END AS achievement_pct
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.distid, s.year_bh
            ORDER BY MAX(s.distname)
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

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.year_bh,
                COUNT(DISTINCT s.indicator_id) AS indicator_count,
                COUNT(DISTINCT s.hospcode) AS hospital_count,
                SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) AS total_target,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                CASE WHEN SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) > 0
                     THEN ROUND((SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) / SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4)))) * 100, 2)
                     ELSE 0 END AS achievement_pct,
                SUM(CASE WHEN s.indicator_status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(s.pending_count) AS pending_count
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.year_bh
            ORDER BY s.year_bh DESC
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-year error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// ========== Auto-create tables for Approval & Notification system ==========
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NULL,
                action VARCHAR(100) NULL,
                details TEXT NULL,
                ip_address VARCHAR(45) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_created_at (created_at)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                dept_id INT NULL,
                action_type ENUM('INSERT','UPDATE','DELETE') NULL,
                table_name VARCHAR(50) NULL,
                record_id INT NULL,
                old_value LONGTEXT NULL,
                new_value LONGTEXT NULL,
                ip_address VARCHAR(45) NULL,
                user_agent TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_created_at (created_at)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                hospcode VARCHAR(10) NULL,
                type ENUM('approve','reject','info') NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT,
                indicator_id INT NULL,
                year_bh VARCHAR(10) NULL,
                is_read TINYINT(1) DEFAULT 0,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_hospcode (hospcode),
                INDEX idx_read (is_read)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_rejection_comments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                indicator_id INT NOT NULL,
                year_bh VARCHAR(10) NOT NULL,
                hospcode VARCHAR(10) NOT NULL,
                comment TEXT NOT NULL,
                reject_months VARCHAR(255) NULL,
                type ENUM('reject','reply') DEFAULT 'reject',
                rejected_by INT NULL,
                replied_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_kpi (indicator_id, year_bh, hospcode)
            )
        `);
        // Add columns if not exist (for existing tables)
        try {
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS reject_months VARCHAR(255) NULL AFTER comment`);
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS type ENUM('reject','reply') DEFAULT 'reject' AFTER reject_months`);
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS replied_by INT NULL AFTER rejected_by`);
        } catch (e) {
            // columns may already exist
        }
        // เพิ่ม is_active ให้ตาราง master data ที่ยังไม่มี
        try {
            await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1`);
            await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1`);
            await db.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1`);
        } catch (e) {
            // columns may already exist
        }
        // ========== Appeal system migration ==========
        // เพิ่ม type สำหรับอุทธรณ์ใน kpi_rejection_comments
        try {
            await db.query(`ALTER TABLE kpi_rejection_comments MODIFY type ENUM('reject','reply','appeal','appeal_approve','appeal_reject') DEFAULT 'reject'`);
            await db.query(`ALTER TABLE kpi_rejection_comments MODIFY rejected_by INT NULL DEFAULT NULL`);
            await db.query(`ALTER TABLE kpi_rejection_comments MODIFY replied_by INT NULL DEFAULT NULL`);
        } catch (e) { /* may already be correct */ }

        // เพิ่ม data entry lock settings
        const entryLockDefaults = [
            ['data_entry_locked', 'false', 'ล็อคการคีย์ข้อมูล (เปิด/ปิดด้วยมือ)'],
            ['data_entry_lock_start', '', 'วันที่เริ่มล็อคการคีย์ (YYYY-MM-DD)'],
            ['data_entry_lock_end', '', 'วันที่สิ้นสุดล็อค (YYYY-MM-DD)'],
            ['data_entry_lock_days', '0', 'จำนวนวันที่ล็อค (นับจากวันเริ่ม, 0=ใช้วันสิ้นสุดแทน)']
        ];
        for (const [key, val, desc] of entryLockDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม maintenance mode settings
        await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)',
            ['maintenance_mode', 'false', 'โหมดปิดปรับปรุงระบบ (true/false)']);
        await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)',
            ['maintenance_message', 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน', 'ข้อความแจ้งเตือนเมื่อปิดปรับปรุง']);

        // เพิ่ม notification toggle settings
        const notifToggleDefaults = [
            ['notif_telegram_enabled', 'true', 'เปิด/ปิดแจ้งเตือนผู้สมัครใหม่ทาง Telegram'],
            ['notif_email_enabled', 'true', 'เปิด/ปิดแจ้งเตือนผู้สมัครใหม่ทาง Email'],
            ['notif_system_enabled', 'true', 'เปิด/ปิดแจ้งเตือนผู้สมัครใหม่ในระบบ']
        ];
        for (const [key, val, desc] of notifToggleDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม target edit lock setting
        await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)',
            ['target_edit_locked', 'false', 'ล็อคการแก้ไขเป้าหมาย (เฉพาะ admin_ssj และ super_admin)']);

        // เพิ่ม appeal settings defaults
        const appealDefaults = [
            ['appeal_enabled', 'false', 'เปิด/ปิดระบบอุทธรณ์'],
            ['appeal_start_date', '', 'วันที่เริ่มเปิดรับอุทธรณ์ (YYYY-MM-DD)'],
            ['appeal_end_date', '', 'วันที่ปิดรับอุทธรณ์ (YYYY-MM-DD)'],
            ['appeal_days_after_approve', '0', 'จำนวนวันหลัง approve ที่ยื่นอุทธรณ์ได้ (0=ไม่จำกัด)']
        ];
        for (const [key, val, desc] of appealDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม toggle settings สำหรับ Auto Logout, Countdown, Max Login Attempts
        const toggleDefaults = [
            ['login_attempts_enabled', 'true', 'เปิด/ปิดระบบนับจำนวนครั้ง Login ผิดพลาด'],
            ['auto_logout_enabled', 'true', 'เปิด/ปิดระบบ Auto Logout เมื่อไม่มีการใช้งาน'],
            ['idle_countdown_enabled', 'true', 'เปิด/ปิดเวลานับถอยหลังแจ้งเตือนก่อน Auto Logout']
        ];
        for (const [key, val, desc] of toggleDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม notification settings defaults
        const notifDefaults = [
            ['telegram_bot_token', '', 'Telegram Bot Token สำหรับแจ้งเตือนผู้สมัครใหม่'],
            ['telegram_chat_id', '', 'Telegram Chat ID (Group) สำหรับแจ้งเตือน'],
            ['admin_emails', '', 'Email Admin สำหรับแจ้งเตือนผู้สมัครใหม่ (คั่นด้วย comma)']
        ];
        for (const [key, val, desc] of notifDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม type 'appeal' ใน notifications
        try {
            await db.query(`ALTER TABLE notifications MODIFY type ENUM('approve','reject','info','appeal') NOT NULL`);
        } catch (e) { /* may already be correct */ }

        // เพิ่ม cid และ is_approved ใน users table
        try {
            await db.query(`ALTER TABLE users ADD COLUMN cid VARCHAR(13) NULL`);
        } catch (e) { /* already exists */ }
        // rename national_id → cid ถ้ายังใช้ชื่อเก่าอยู่
        try {
            const [cols] = await db.query(`SHOW COLUMNS FROM users LIKE 'national_id'`);
            if (cols.length > 0) {
                await db.query(`ALTER TABLE users CHANGE national_id cid VARCHAR(13) NULL`);
            }
        } catch (e) { /* ignore */ }
        // ขยาย cid เป็น VARCHAR(64) เพื่อรองรับ SHA-256 hash
        try {
            await db.query(`ALTER TABLE users MODIFY cid VARCHAR(64) NULL`);
        } catch (e) { /* ignore */ }
        // เพิ่ม email column
        try {
            await db.query(`ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL`);
        } catch (e) { /* already exists */ }
        // เพิ่ม forgot-password columns
        try { await db.query(`ALTER TABLE users ADD COLUMN temp_password VARCHAR(255) NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN temp_password_expiry DATETIME NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN last_seen_ip VARCHAR(64) NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN last_seen_ua VARCHAR(255) NULL`); } catch (e) {}
        try { await db.query(`CREATE INDEX idx_last_seen_at ON users(last_seen_at)`); } catch (e) {}
        // สร้างตาราง chostype (ประเภทสถานบริการ)
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS chostype (
                    hostypecode CHAR(2) NOT NULL PRIMARY KEY,
                    hostypename VARCHAR(255)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            const [cnt] = await db.query('SELECT COUNT(*) AS c FROM chostype');
            if (cnt[0].c === 0) {
                await db.query(`INSERT INTO chostype (hostypecode, hostypename) VALUES
                    ('01','สำนักงานสาธารณสุขจังหวัด'),('02','สำนักงานสาธารณสุขอำเภอ'),
                    ('03','สถานีอนามัย'),('04','สถานบริการสาธารณสุขชุมชน'),
                    ('05','โรงพยาบาลศูนย์'),('06','โรงพยาบาลทั่วไป'),
                    ('07','โรงพยาบาลชุมชน'),('08','ศูนย์สุขภาพชุมชน ของ รพ.'),
                    ('09','ศูนย์สุขภาพชุมชน สธ.'),('10','ศูนย์วิชาการ'),
                    ('11','โรงพยาบาล นอก สป.สธ.'),('12','โรงพยาบาล นอก สธ.'),
                    ('13','ศูนย์บริการสาธารณสุข'),('14','ศูนย์สุขภาพชุมชน นอก สธ.'),
                    ('15','โรงพยาบาลเอกชน'),('16','คลินิกเอกชน'),
                    ('17','โรงพยาบาล/ศูนย์บริการสาธารณสุข สาขา'),('18','โรงพยาบาลส่งเสริมสุขภาพตำบล')`);
            }
        } catch (e) {}

        // เพิ่ม distid column ใน chospital (performance: ลด CONCAT runtime)
        try {
            await db.query('ALTER TABLE chospital ADD COLUMN distid VARCHAR(10)');
            console.log('[Migration] Added chospital.distid column');
        } catch (e) { /* already exists */ }
        try {
            await db.query('UPDATE chospital SET distid = CONCAT(provcode, distcode) WHERE distid IS NULL');
            await db.query('CREATE INDEX idx_chospital_distid ON chospital (distid)');
        } catch (e) { /* already done */ }

        // เพิ่ม kpi_summary table
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_summary (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    indicator_id INT NOT NULL,
                    year_bh VARCHAR(10) NOT NULL,
                    hospcode VARCHAR(20) NOT NULL,
                    main_indicator_name VARCHAR(500),
                    kpi_indicators_name TEXT,
                    dept_id INT,
                    dept_name VARCHAR(255),
                    hosname VARCHAR(255),
                    distid VARCHAR(20),
                    distname VARCHAR(255),
                    table_process VARCHAR(100),
                    target_value VARCHAR(100),
                    oct VARCHAR(100), nov VARCHAR(100), dece VARCHAR(100),
                    jan VARCHAR(100), feb VARCHAR(100), mar VARCHAR(100),
                    apr VARCHAR(100), may VARCHAR(100), jun VARCHAR(100),
                    jul VARCHAR(100), aug VARCHAR(100), sep VARCHAR(100),
                    last_actual VARCHAR(100),
                    pending_count INT DEFAULT 0,
                    indicator_status VARCHAR(20),
                    is_locked TINYINT DEFAULT 0,
                    has_form_schema TINYINT DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_ind_year_hos (indicator_id, year_bh, hospcode),
                    INDEX idx_year (year_bh),
                    INDEX idx_hospcode (hospcode),
                    INDEX idx_dept (dept_name),
                    INDEX idx_dept_id (dept_id),
                    INDEX idx_distid (distid),
                    INDEX idx_district (distname)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (e) { /* already exists */ }

        // แก้ collation ของ kpi_summary ให้ตรงกับตารางอื่น
        try { await db.query('ALTER TABLE kpi_summary CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); } catch(e) {}

        // เพิ่ม dept_id, distid ใน kpi_summary สำหรับ role-based filtering
        try { await db.query('ALTER TABLE kpi_summary ADD COLUMN dept_id INT AFTER kpi_indicators_name'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD COLUMN distid VARCHAR(20) AFTER hosname'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD COLUMN hostype VARCHAR(5) AFTER distid'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD INDEX idx_hostype (hostype)'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD INDEX idx_dept_id (dept_id)'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD INDEX idx_distid (distid)'); } catch(e) {}

        // ========== kpi_sub_indicators + kpi_sub_results ==========
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_sub_indicators (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    indicator_id INT NOT NULL,
                    sub_indicator_name VARCHAR(500) NOT NULL,
                    sub_indicator_code VARCHAR(100),
                    target_percentage VARCHAR(100),
                    weight DECIMAL(5,2) DEFAULT 1.00,
                    description TEXT,
                    sort_order INT DEFAULT 0,
                    is_active TINYINT(1) DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_indicator (indicator_id),
                    INDEX idx_active (is_active)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try { await db.query('ALTER TABLE kpi_sub_indicators ADD CONSTRAINT fk_sub_indicator FOREIGN KEY (indicator_id) REFERENCES kpi_indicators(id) ON DELETE CASCADE'); } catch(e) {}
        } catch (e) {}

        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_sub_results (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    sub_indicator_id INT NOT NULL,
                    year_bh VARCHAR(10) NOT NULL,
                    hospcode VARCHAR(20) NOT NULL,
                    month_bh INT NOT NULL,
                    target_value VARCHAR(100),
                    actual_value VARCHAR(100),
                    status VARCHAR(20) DEFAULT 'Pending',
                    user_id INT,
                    is_locked TINYINT(1) DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_sub_year_hos_month (sub_indicator_id, year_bh, hospcode, month_bh),
                    INDEX idx_sub (sub_indicator_id),
                    INDEX idx_year_hos (year_bh, hospcode)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try { await db.query('ALTER TABLE kpi_sub_results ADD CONSTRAINT fk_sub_result FOREIGN KEY (sub_indicator_id) REFERENCES kpi_sub_indicators(id) ON DELETE CASCADE'); } catch(e) {}
        } catch (e) {}

        // แก้ kpi_indicators.dept_id + main_indicator_id จาก VARCHAR → INT (ถ้ายังเป็น VARCHAR)
        try {
            const [cols] = await db.query("SHOW COLUMNS FROM kpi_indicators WHERE Field = 'dept_id'");
            if (cols[0] && cols[0].Type.includes('varchar')) {
                await db.query("UPDATE kpi_indicators SET dept_id = NULL WHERE dept_id = '' OR dept_id = '0'");
                await db.query("UPDATE kpi_indicators SET main_indicator_id = NULL WHERE main_indicator_id = '' OR main_indicator_id = '0'");
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX dept_id'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX main_indicator_id'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX idx_kpi_indicators_dept'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX idx_kpi_indicators_main'); } catch(e) {}
                await db.query('ALTER TABLE kpi_indicators MODIFY dept_id INT NULL');
                await db.query('ALTER TABLE kpi_indicators MODIFY main_indicator_id INT NULL');
                try { await db.query('ALTER TABLE kpi_indicators ADD CONSTRAINT fk_indicators_dept FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE SET NULL'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators ADD CONSTRAINT fk_indicators_main FOREIGN KEY (main_indicator_id) REFERENCES kpi_main_indicators(id) ON DELETE SET NULL'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators ADD INDEX idx_dept (dept_id)'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators ADD INDEX idx_main (main_indicator_id)'); } catch(e) {}
                console.log('[Migration] Fixed kpi_indicators FK columns VARCHAR→INT');
            }
        } catch (e) { console.log('[Migration] kpi_indicators FK check:', e.message); }

        // เพิ่ม performance indexes บน kpi_results
        try { await db.query('CREATE INDEX idx_kpi_results_year ON kpi_results (year_bh)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_indicator ON kpi_results (indicator_id)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_hospcode ON kpi_results (hospcode)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_composite ON kpi_results (indicator_id, year_bh, hospcode)'); } catch (e) {}

        // เพิ่ม approved_by column
        try { await db.query(`ALTER TABLE users ADD COLUMN approved_by INT NULL`); } catch (e) {}
        // เพิ่ม indexes สำหรับ kpi_results (เร่งความเร็ว dashboard)
        try { await db.query('CREATE INDEX idx_kpi_results_year ON kpi_results (year_bh)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_indicator ON kpi_results (indicator_id)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_hospcode ON kpi_results (hospcode)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_composite ON kpi_results (indicator_id, year_bh, hospcode)'); } catch (e) {}

        // เพิ่ม is_active ใน users table
        try {
            await db.query(`ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1`);
            await db.query(`UPDATE users SET is_active = 1 WHERE is_active != 1`);
        } catch (e) { /* already exists */ }
        // เปลี่ยน actual_value เป็น VARCHAR เพื่อรองรับข้อความ
        try {
            await db.query(`ALTER TABLE kpi_results MODIFY actual_value VARCHAR(100) NULL`);
        } catch (e) { /* ignore */ }
        // เปลี่ยน target_value เป็น VARCHAR เพื่อรองรับข้อความ
        try {
            await db.query(`ALTER TABLE kpi_results MODIFY target_value VARCHAR(100) NULL`);
        } catch (e) { /* ignore */ }
        try {
            await db.query(`ALTER TABLE users ADD COLUMN is_approved TINYINT(1) NOT NULL DEFAULT 1`);
            // ผู้ใช้เดิมทั้งหมดถือว่า approved
            await db.query(`UPDATE users SET is_approved = 1 WHERE is_approved != 1`);
        } catch (e) { /* already exists */ }

        // สร้างตาราง target_edit_requests
        await db.query(`
            CREATE TABLE IF NOT EXISTS target_edit_requests (
                id INT AUTO_INCREMENT PRIMARY KEY,
                indicator_id INT NOT NULL,
                year_bh VARCHAR(10) NOT NULL,
                hospcode VARCHAR(10) NOT NULL,
                requested_by INT NOT NULL,
                requested_by_name VARCHAR(255) NULL,
                status ENUM('pending','approved','rejected','completed') DEFAULT 'pending',
                approved_by INT NULL,
                reject_reason VARCHAR(500) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        // เพิ่ม type 'target_request' ใน notifications
        try {
            await db.query(`ALTER TABLE notifications MODIFY type ENUM('approve','reject','info','appeal','target_request') NOT NULL`);
        } catch (e) { /* may already be correct */ }

        // ========== Feedback Board ==========
        await db.query(`
            CREATE TABLE IF NOT EXISTS feedback_posts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                category ENUM('suggestion','question','bug','other') DEFAULT 'suggestion',
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                status ENUM('open','in_progress','resolved','closed') DEFAULT 'open',
                reply_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_status (status)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS feedback_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                post_id INT NOT NULL,
                user_id INT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (post_id) REFERENCES feedback_posts(id) ON DELETE CASCADE,
                INDEX idx_post (post_id)
            )
        `);

        // ========== Form Builder migration ==========
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_form_schemas (
                id INT AUTO_INCREMENT PRIMARY KEY,
                indicator_id INT NOT NULL,
                form_title VARCHAR(200) NOT NULL,
                form_description TEXT NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                is_active TINYINT(1) DEFAULT 1,
                INDEX idx_indicator (indicator_id)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_form_fields (
                id INT AUTO_INCREMENT PRIMARY KEY,
                schema_id INT NOT NULL,
                field_name VARCHAR(100) NOT NULL,
                field_label VARCHAR(200) NOT NULL,
                field_type ENUM('text','number','textarea','select','date','checkbox') DEFAULT 'text',
                field_options TEXT NULL,
                is_required TINYINT(1) DEFAULT 0,
                sort_order INT DEFAULT 0,
                FOREIGN KEY (schema_id) REFERENCES kpi_form_schemas(id) ON DELETE CASCADE
            )
        `);
        // เพิ่ม table_process ใน kpi_indicators ถ้ายังไม่มี
        try {
            await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS table_process VARCHAR(100) NULL`);
        } catch (e) { /* may already exist */ }
        // เพิ่มฟิลด์ที่ขาดใน kpi_indicators
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS kpi_indicators_id VARCHAR(50) NULL COMMENT 'รหัสอ้างอิง'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS target_condition VARCHAR(10) NULL COMMENT 'GTE/LTE/EQ'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS r9 TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS moph TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS ssj TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS rmw TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS other TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS evaluation_mode VARCHAR(20) NULL COMMENT 'any_one | all_required'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS required_off_types TEXT NULL COMMENT 'JSON array of hostypecode เช่น ["05","06","07"]'`); } catch(e) {}

        // เพิ่มฟิลด์ใน main_yut (ยุทธศาสตร์)
        try { await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS yut_code VARCHAR(50) NULL COMMENT 'รหัสย่อยุทธศาสตร์'`); } catch(e) {}
        try { await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`); } catch(e) {}

        // เพิ่มฟิลด์ใน kpi_main_indicators (หมวดหมู่หลัก)
        try { await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS main_indicator_code VARCHAR(50) NULL COMMENT 'รหัสย่อหมวดหมู่'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`); } catch(e) {}

        // เพิ่มฟิลด์ใน departments
        try { await db.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`); } catch(e) {}

        // ตาราง export_schedules + logs — จัดตารางเวลา export อัตโนมัติ
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS export_schedules (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    is_enabled TINYINT(1) DEFAULT 1,
                    days_of_week VARCHAR(20) DEFAULT '1,2,3,4,5',
                    time_of_day VARCHAR(5) DEFAULT '02:00',
                    year_bh VARCHAR(10),
                    indicator_ids TEXT,
                    notify_email TINYINT(1) DEFAULT 1,
                    email_recipients TEXT,
                    notify_telegram TINYINT(1) DEFAULT 0,
                    telegram_chat_ids TEXT,
                    telegram_bot_token VARCHAR(255),
                    indicator_scope VARCHAR(20) DEFAULT 'all',
                    auto_sync_hdc TINYINT(1) DEFAULT 0,
                    last_run_at DATETIME,
                    last_status VARCHAR(20),
                    next_run_at DATETIME,
                    created_by INT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try { await db.query(`ALTER TABLE export_schedules ADD COLUMN indicator_scope VARCHAR(20) DEFAULT 'all'`); } catch (_) {}
            try { await db.query(`ALTER TABLE export_schedules ADD COLUMN auto_sync_hdc TINYINT(1) DEFAULT 0`); } catch (_) {}
        } catch (e) {}
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS export_schedule_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    schedule_id INT NOT NULL,
                    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    status VARCHAR(20),
                    inserted INT DEFAULT 0,
                    updated_count INT DEFAULT 0,
                    unchanged INT DEFAULT 0,
                    no_data INT DEFAULT 0,
                    tables_count INT DEFAULT 0,
                    skipped_count INT DEFAULT 0,
                    duration_ms INT DEFAULT 0,
                    notified_email TINYINT(1) DEFAULT 0,
                    notified_telegram TINYINT(1) DEFAULT 0,
                    error_msg TEXT,
                    INDEX idx_schedule (schedule_id),
                    INDEX idx_run_at (run_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (e) {}

        // ตาราง system_announcements — ประกาศระบบ
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS system_announcements (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    title VARCHAR(255) DEFAULT '',
                    content_html TEXT NOT NULL,
                    content_text VARCHAR(500),
                    bg_color VARCHAR(20) DEFAULT '#dc2626',
                    text_color VARCHAR(20) DEFAULT '#ffffff',
                    blink_enabled TINYINT(1) DEFAULT 1,
                    show_on_header TINYINT(1) DEFAULT 1,
                    show_on_login TINYINT(1) DEFAULT 1,
                    is_active TINYINT(1) DEFAULT 0,
                    created_by INT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_active (is_active)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            // seed ข้อความเริ่มต้น ถ้ายังไม่มีเลย
            const [existing] = await db.query('SELECT COUNT(*) AS c FROM system_announcements');
            if (existing[0].c === 0) {
                await db.query(`INSERT INTO system_announcements (title, content_html, content_text, is_active) VALUES (?, ?, ?, 1)`, [
                    'ประกาศระบบ',
                    '<i class="fas fa-chart-line"></i> <b>เริ่มใช้งาน 1 เม.ย. 2569</b> — รวบรวมผลงานตรวจราชการรอบที่ 2 *** ประมวลผลทุกวันที่ 20 ของเดือน <i class="fas fa-chart-line"></i>',
                    'เริ่มใช้งาน 1 เม.ย. 2569 — รวบรวมผลงานตรวจราชการรอบที่ 2 *** ประมวลผลทุกวันที่ 20 ของเดือน'
                ]);
            }
        } catch (e) {}
        // เพิ่ม actual_value_field ใน kpi_form_schemas
        try {
            await db.query(`ALTER TABLE kpi_form_schemas ADD COLUMN IF NOT EXISTS actual_value_field VARCHAR(100) NULL COMMENT 'ชื่อฟิลด์ที่ใช้ sync ไปยัง kpi_results.actual_value'`);
        } catch (e) { /* may already exist */ }

        // === Performance Indexes สำหรับ 500 concurrent users ===
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_composite ON kpi_results (indicator_id, year_bh, hospcode)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_status ON kpi_results (status)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_year ON kpi_results (year_bh)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_month ON kpi_results (month_bh)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_hospcode ON kpi_results (hospcode)',
            'CREATE INDEX IF NOT EXISTS idx_users_role ON users (role)',
            'CREATE INDEX IF NOT EXISTS idx_users_approved ON users (is_approved)',
            'CREATE INDEX IF NOT EXISTS idx_users_hospcode ON users (hospcode)',
            'CREATE INDEX IF NOT EXISTS idx_users_dept ON users (dept_id)',
            'CREATE INDEX IF NOT EXISTS idx_users_cid ON users (cid)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, is_read)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_indicators_dept ON kpi_indicators (dept_id)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_indicators_main ON kpi_indicators (main_indicator_id)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_indicators_active ON kpi_indicators (is_active)',
            'CREATE INDEX IF NOT EXISTS idx_login_logs_username ON login_logs (username)',
            'CREATE INDEX IF NOT EXISTS idx_system_logs_user ON system_logs (user_id)'
        ];
        for (const idx of indexes) {
            try { await db.query(idx); } catch (e) { /* index อาจมีอยู่แล้ว */ }
        }

        console.log('✅ login_logs, system_logs, notifications, rejection & appeal tables + indexes ready');
    } catch (err) {
        console.error('⚠️ Auto-create tables error:', err.message);
    }
})();

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
// === Structure Compare: Local DB vs Remote HDC DB ===
// ============================================================

// GET /report-compare — เปรียบเทียบ reports (HDC) กับ kpi_indicators (Local) โดยใช้ table_process เป็น key
apiRouter.get('/report-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (HDC)' });
    try {
        // ดึง reports จาก HDC
        const [hdcRows] = await remoteDb.query(`
            SELECT *
            FROM reports
            WHERE data_source = 'excel'
            AND LENGTH(report_code) = LENGTH(table_process)
            ORDER BY report_id
        `);
        // ดึง kpi_indicators จาก Local
        const [localRows] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process, i.kpi_indicators_code, i.is_active,
                   d.dept_name, mi.main_indicator_name
            FROM kpi_indicators i
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            ORDER BY i.id
        `);
        // สร้าง map โดยใช้ table_process เป็น key
        const hdcMap = new Map();
        hdcRows.forEach(r => { if (r.table_process) hdcMap.set(r.table_process, r); });
        const localMap = new Map();
        localRows.forEach(r => { if (r.table_process) localMap.set(r.table_process, r); });

        const items = [];
        let match = 0, different = 0, missing_local = 0, missing_remote = 0;

        // เทียบจาก HDC
        for (const hdc of hdcRows) {
            const tp = hdc.table_process;
            const local = tp ? localMap.get(tp) : null;
            if (!local) {
                items.push({
                    status: 'missing_local',
                    hdc_report_id: hdc.report_id, hdc_name: hdc.report_name, hdc_dept: hdc.dept, hdc_main_yut: hdc.main_yut,
                    report_code: hdc.report_code, table_process: tp, hdc_is_active: hdc.is_active,
                    local_id: null, local_name: null
                });
                missing_local++;
            } else {
                // เปรียบเทียบชื่อ
                const nameMatch = (hdc.report_name || '').trim() === (local.kpi_indicators_name || '').trim();
                const status = nameMatch ? 'match' : 'different';
                if (status === 'match') match++; else different++;
                items.push({
                    status,
                    hdc_report_id: hdc.report_id, hdc_name: hdc.report_name, hdc_dept: hdc.dept, hdc_main_yut: hdc.main_yut,
                    report_code: hdc.report_code, table_process: tp, hdc_is_active: hdc.is_active,
                    local_id: local.id, local_name: local.kpi_indicators_name, local_dept: local.dept_name
                });
            }
        }
        // เทียบจาก Local ที่ไม่มีใน HDC
        for (const local of localRows) {
            if (local.table_process && !hdcMap.has(local.table_process)) {
                items.push({
                    status: 'missing_remote',
                    hdc_report_id: null, hdc_name: null, hdc_dept: null, hdc_main_yut: null,
                    report_code: null, table_process: local.table_process, hdc_is_active: null,
                    local_id: local.id, local_name: local.kpi_indicators_name, local_dept: local.dept_name
                });
                missing_remote++;
            }
        }
        res.json({
            success: true,
            hdc_count: hdcRows.length, local_count: localRows.length,
            summary: { total: items.length, match, different, missing_local, missing_remote },
            items
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /report-compare/sync — Sync reports จาก HDC เข้า kpi_indicators (Local)
apiRouter.post('/report-compare/sync', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (HDC)' });
    const { hdc_report_ids } = req.body;
    if (!Array.isArray(hdc_report_ids) || hdc_report_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกรายการที่ต้องการ Sync' });
    }
    try {
        const [hdcRows] = await remoteDb.query(
            `SELECT report_id, report_name, dept, main_yut, report_code, table_process FROM reports WHERE report_id IN (?)`,
            [hdc_report_ids]
        );
        let inserted = 0, updated = 0, skipped = 0;
        for (const hdc of hdcRows) {
            if (!hdc.table_process) { skipped++; continue; }
            // ตรวจสอบว่ามีอยู่แล้วหรือไม่ (โดย table_process)
            const [existing] = await db.query('SELECT id, kpi_indicators_name FROM kpi_indicators WHERE table_process = ?', [hdc.table_process]);
            if (existing.length > 0) {
                // อัปเดตชื่อ + report_code
                await db.query(
                    'UPDATE kpi_indicators SET kpi_indicators_name = ?, kpi_indicators_code = ? WHERE table_process = ?',
                    [hdc.report_name, hdc.report_code || null, hdc.table_process]
                );
                updated++;
            } else {
                // สร้างใหม่
                await db.query(
                    'INSERT INTO kpi_indicators (kpi_indicators_name, table_process, kpi_indicators_code) VALUES (?, ?, ?)',
                    [hdc.report_name, hdc.table_process, hdc.report_code || null]
                );
                inserted++;
            }
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'SYNC_REPORTS', 'kpi_indicators',
             JSON.stringify({ hdc_ids: hdc_report_ids, inserted, updated, skipped }), req.ip]
        );
        res.json({ success: true, message: `Sync สำเร็จ — เพิ่มใหม่ ${inserted} รายการ, อัปเดตชื่อ ${updated} รายการ${skipped > 0 ? ', ข้าม ' + skipped + ' รายการ' : ''}`, inserted, updated, skipped });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
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

// GET /db-compare — เปรียบเทียบ structure ตาราง table_process ระหว่าง local กับ hdc
apiRouter.get('/db-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (HDC) ใน .env (HDC_DB_HOST)' });

    try {
        // 1. ดึง table_process ทั้งหมดจาก kpi_indicators (deduplicate ตาม table_process)
        const [allIndicators] = await db.query("SELECT id, kpi_indicators_name, table_process FROM kpi_indicators WHERE table_process IS NOT NULL AND table_process != ''");
        // รวมชื่อตัวชี้วัดที่ใช้ table_process เดียวกัน
        const tableMap = new Map();
        for (const ind of allIndicators) {
            const tp = ind.table_process.trim().replace(/-/g, '_');
            if (!tableMap.has(tp)) {
                tableMap.set(tp, { id: ind.id, table_process: tp, names: [] });
            }
            tableMap.get(tp).names.push(ind.kpi_indicators_name);
        }
        const indicators = Array.from(tableMap.values()).map(v => ({
            id: v.id, table_process: v.table_process,
            kpi_indicators_name: v.names.length === 1 ? v.names[0] : v.names.join(' | ')
        }));

        const results = [];
        const localDbName = process.env.DB_NAME || 'khups_kpi_db';
        const remoteDbName = process.env.HDC_DB_NAME || 'hdc';

        for (const ind of indicators) {
            const tableName = ind.table_process.trim().replace(/-/g, '_');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) continue;

            const item = { id: ind.id, name: ind.kpi_indicators_name, table: tableName, local: null, remote: null, status: 'unknown', diff: [] };

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
                const localFields = new Map(item.local.columns.map(c => [c.field, c]));
                const remoteFields = new Map(item.remote.columns.map(c => [c.field, c]));
                for (const [name, col] of remoteFields) {
                    if (!localFields.has(name)) { item.diff.push({ field: name, issue: 'missing_in_local', remote_type: col.type }); }
                    else if (localFields.get(name).type !== col.type) { item.diff.push({ field: name, issue: 'type_mismatch', local_type: localFields.get(name).type, remote_type: col.type }); }
                }
                for (const [name] of localFields) {
                    if (!remoteFields.has(name)) { item.diff.push({ field: name, issue: 'missing_in_remote' }); }
                }
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
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (HDC)' });

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

// POST /db-compare/sync-data — Sync ข้อมูลจาก remote (hdc) เข้า local
apiRouter.post('/db-compare/sync-data', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (HDC)' });

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

// POST /db-compare/create-remote — สร้าง/แก้ไขตารางใน HDC จาก DDL ของ Local (สำหรับ missing_remote)
apiRouter.post('/db-compare/create-remote', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (HDC)' });

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
                // สร้างใหม่ใน HDC
                await remoteDb.query(ddl);
                created.push(tableName);
            } else {
                // ALTER เพิ่มคอลัมน์ที่ขาดใน HDC
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

    res.json({ success: true, message: `สร้าง ${created.length} ตาราง, แก้ไข ${altered.length} ตารางใน HDC`, created, altered, errors });
});

// POST /db-compare/sync-to-hdc — Sync ข้อมูลจาก Local → HDC (upsert batch 100 rows)
apiRouter.post('/db-compare/sync-to-hdc', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (HDC)' });

    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตาราง' });

    const synced = [], errors = [];

    for (const tableName of tables) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) { errors.push({ table: tableName, error: 'ชื่อไม่ถูกต้อง' }); continue; }
        try {
            // ตรวจว่า remote มีตารางนี้
            try { await remoteDb.query(`SELECT 1 FROM \`${tableName}\` LIMIT 0`); } catch (e) {
                errors.push({ table: tableName, error: 'ตารางไม่มีใน HDC กรุณาสร้างก่อน' }); continue;
            }

            // ดึงข้อมูลจาก local
            const [localRows] = await db.query(`SELECT * FROM \`${tableName}\``);
            if (localRows.length === 0) { synced.push({ table: tableName, rows: 0, message: 'ไม่มีข้อมูลใน local' }); continue; }

            // ดึง column names
            const columns = Object.keys(localRows[0]);
            const colList = columns.map(c => `\`${c}\``).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const onDup = columns.map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

            // Batch upsert → HDC (100 rows per batch)
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
        [req.user.userId, 'DB_COMPARE_SYNC_TO_HDC', 'MULTIPLE', JSON.stringify({ synced: synced.length, total_rows: synced.reduce((s, t) => s + t.rows, 0) }), req.ip]).catch(() => {});

    res.json({ success: true, message: `Sync → HDC สำเร็จ ${synced.length} ตาราง`, synced, errors });
});

// ========== Users Data Sync (Local ↔ HDC) ==========
// GET /users/sync-compare — เปรียบเทียบ users ระหว่าง Local กับ HDC
apiRouter.get('/users/sync-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (HDC)' });
    try {
        // ดึง local users (ทุกคอลัมน์)
        const [localUsers] = await db.query('SELECT * FROM users ORDER BY username');

        // ดึง remote users — ถ้าตารางไม่มี → ถือว่าว่าง
        let remoteUsers = [];
        try {
            const [rows] = await remoteDb.query('SELECT * FROM users ORDER BY username');
            remoteUsers = rows;
        } catch (e) { /* ตาราง users ไม่มีใน HDC */ }

        const remoteMap = new Map(remoteUsers.map(u => [u.username, u]));
        const localMap = new Map(localUsers.map(u => [u.username, u]));

        const matched = [], different = [], local_only = [], hdc_only = [];

        for (const lu of localUsers) {
            const ru = remoteMap.get(lu.username);
            if (!ru) { local_only.push(lu); continue; }
            // เทียบค่าทีละ field (ข้าม id + timestamps)
            const skip = ['id', 'created_at', 'updated_at'];
            let isDiff = false;
            for (const k of Object.keys(lu)) {
                if (skip.includes(k)) continue;
                const lv = lu[k] == null ? '' : String(lu[k]);
                const rv = ru[k] == null ? '' : String(ru[k]);
                if (lv !== rv) { isDiff = true; break; }
            }
            (isDiff ? different : matched).push(lu);
        }
        for (const ru of remoteUsers) {
            if (!localMap.has(ru.username)) hdc_only.push(ru);
        }

        res.json({
            success: true,
            summary: { matched: matched.length, different: different.length, local_only: local_only.length, hdc_only: hdc_only.length, total_local: localUsers.length, total_hdc: remoteUsers.length },
            matched, different, local_only, hdc_only
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /users/sync-to-hdc — ส่ง users จาก Local → HDC (UPSERT)
apiRouter.post('/users/sync-to-hdc', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า Remote DB (HDC)' });
    const { usernames } = req.body; // optional: ถ้าไม่ส่ง = sync ทั้งหมด

    try {
        // สร้างตาราง users ใน HDC ถ้ายังไม่มี (ใช้ DDL จาก Local)
        try {
            await remoteDb.query('SELECT 1 FROM users LIMIT 0');
        } catch (e) {
            const [ddlRows] = await db.query('SHOW CREATE TABLE users');
            if (ddlRows.length > 0) await remoteDb.query(ddlRows[0]['Create Table']);
        }

        // ดึง users ที่ต้องการ sync
        let query = 'SELECT * FROM users';
        const params = [];
        if (Array.isArray(usernames) && usernames.length > 0) {
            query += ` WHERE username IN (${usernames.map(() => '?').join(',')})`;
            params.push(...usernames);
        }
        const [localUsers] = await db.query(query, params);
        if (localUsers.length === 0) return res.json({ success: true, synced: 0, message: 'ไม่มีข้อมูลที่จะ sync' });

        // UPSERT batch 100 rows
        const columns = Object.keys(localUsers[0]);
        const colList = columns.map(c => `\`${c}\``).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        const onDup = columns.filter(c => c !== 'id').map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(', ');

        let totalSynced = 0;
        const errors = [];
        for (let i = 0; i < localUsers.length; i += 100) {
            const batch = localUsers.slice(i, i + 100);
            const allPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
            const flatValues = batch.flatMap(row => columns.map(c => row[c]));
            try {
                await remoteDb.query(
                    `INSERT INTO \`users\` (${colList}) VALUES ${allPlaceholders} ON DUPLICATE KEY UPDATE ${onDup}`,
                    flatValues
                );
                totalSynced += batch.length;
            } catch (e) {
                errors.push({ batch_start: i, error: e.message });
            }
        }

        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'USERS_SYNC_TO_HDC', 'users', JSON.stringify({ synced: totalSynced, total: localUsers.length }), req.ip]).catch(() => {});

        res.json({ success: true, message: `Sync users → HDC สำเร็จ ${totalSynced} คน`, synced: totalSynced, errors });
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
            { key: 'HDC_DB_HOST', group: 'hdc', label: 'HDC Database Host', sensitive: false },
            { key: 'HDC_DB_PORT', group: 'hdc', label: 'HDC Database Port', sensitive: false },
            { key: 'HDC_DB_NAME', group: 'hdc', label: 'HDC Database Name', sensitive: false },
            { key: 'HDC_DB_USER', group: 'hdc', label: 'HDC Database User', sensitive: false },
            { key: 'HDC_DB_PASSWORD', group: 'hdc', label: 'HDC Database Password', sensitive: true },
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

// Mount Router ที่ path /khupskpi/api
app.use('/khupskpi/api', apiRouter);

app.listen(port, () => {
    console.log(`🚀 API Server เปิดทำงานแล้วที่พอร์ต ${port} (Path: /khupskpi/api)`);
    try { startExportScheduler(); } catch (e) { console.error('[Scheduler] start failed:', e.message); }
});
