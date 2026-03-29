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
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Token ไม่ถูกต้องหรือหมดอายุ' });
        req.user = user;
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
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
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
                        dept_id: user.dept_id
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

        // แจ้ง super_admin ทุกคน
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
        const [hospitals] = await db.query('SELECT hoscode, hosname, CONCAT(provcode, distcode) as distid FROM chospital ORDER BY hoscode');
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
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
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

        res.json({ success: true, data: { successRate, recordedCount: recorded_count, totalDepts: total_depts, pendingCount: pending_count, rank: 1 } });
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
                whereClause = 'WHERE CONCAT(h.provcode, h.distcode) = ?';
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

        const sql = `
            SELECT
                if (mi.main_indicator_name is NULL,"ยังไม่กำหนด",mi.main_indicator_name) main_indicator_name,
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
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count,
                MAX(r.status) as indicator_status,
                MAX(CASE WHEN r.is_locked = 1 THEN 1 ELSE 0 END) as is_locked,
                (SELECT COUNT(*) FROM kpi_rejection_comments rc2
                 WHERE rc2.indicator_id = r.indicator_id AND rc2.year_bh = r.year_bh
                 AND rc2.hospcode = r.hospcode AND rc2.type = 'appeal_approve') AS appeal_approved,
                i.table_process,
                (SELECT COUNT(*) FROM kpi_form_schemas fs WHERE fs.indicator_id = i.id AND fs.is_active = 1 LIMIT 1) AS has_form_schema,
                r.hospcode,
                h.hosname,
                dist.distname
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            ${whereClause}
            GROUP BY
                mi.main_indicator_name,
                i.kpi_indicators_name,
                i.id,
                i.table_process,
                d.dept_name,
                r.year_bh,
                r.hospcode,
                h.hosname,
                dist.distname
            ORDER BY
                r.year_bh DESC,
                mi.main_indicator_name DESC,
                i.kpi_indicators_name DESC,
                i.id DESC,
                d.dept_name DESC;
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูล KPI ได้' });
    }
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

        // Batch: ตรวจสอบล็อคทั้งหมดในคราวเดียว
        const uniqueKeys = [...new Set(updates.map(row => {
            const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
            return `${row.indicator_id}_${row.year_bh}_${hc}`;
        }))];
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
                    let targetValue = '';
                    if (m.val === 10) {
                        const rawTarget = row.target_value;
                        targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? String(rawTarget).trim() : '';
                    }
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
                    let targetValue = '';
                    if (m.val === 10) {
                        const rawTarget = row.target_value;
                        targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? String(rawTarget).trim() : '';
                    }
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

            for (const m of months) {
                const rawActual = row[m.col];
                const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? String(rawActual).trim() : null;
                let targetValue = '';
                if (m.val === 10) {
                    const rawTarget = row.target_value;
                    targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? String(rawTarget).trim() : '';
                }

                if ((actualValue && actualValue !== '0') || (targetValue && targetValue !== '0')) {
                    insertValues.push('(?, ?, ?, ?, ?, ?, ?, ?, 0)');
                    insertParams.push(indicator_id, year_bh, m.val, actualValue, targetValue, user.userId, rowStatus, rowHospcode);
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
    const { indicator_id, form_title, form_description, fields, schema_id, actual_value_field } = req.body;
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
        const reservedFields = ['id','hospcode','year_bh','month_bh','created_by','created_at','updated_at'];
        const customCols = fields.filter(f => !reservedFields.includes(f.field_name));
        let colDefs = customCols.map(f => {
            const sqlType = f.field_type === 'number' ? 'DECIMAL(15,4) NULL' : 'TEXT NULL';
            return `\`${f.field_name}\` ${sqlType}`;
        }).join(', ');
        if (colDefs) colDefs = ', ' + colDefs;
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
        const { hospcode, year_bh, month_bh } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (hospcode) { where += ' AND t.hospcode = ?'; params.push(hospcode); }
        if (year_bh) { where += ' AND t.year_bh = ?'; params.push(year_bh); }
        if (month_bh) { where += ' AND t.month_bh = ?'; params.push(month_bh); }
        const [rows] = await db.query(`SELECT t.*, u.username AS created_by_name FROM \`${formTable}\` t LEFT JOIN users u ON t.created_by = u.id ${where} ORDER BY t.year_bh DESC, t.month_bh DESC, t.created_at DESC`, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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
        const [rows] = await db.query(`SELECT DISTINCT month_bh FROM \`${formTable}\` ${where} AND month_bh IS NOT NULL ORDER BY month_bh`, params);
        res.json({ success: true, data: rows.map(r => r.month_bh) });
    } catch (e) { res.status(500).json({ success: false, data: [] }); }
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
apiRouter.get('/kpi-template', async (req, res) => {
    try {
        const sql = `
            SELECT
                if (mi.main_indicator_name is NULL,"ยังไม่กำหนด",mi.main_indicator_name) main_indicator_name,
                i.kpi_indicators_name,
                i.id AS indicator_id,
                i.dept_id,
                d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            WHERE i.is_active = 1
            ORDER BY mi.main_indicator_name DESC, i.kpi_indicators_name DESC, d.dept_name DESC
        `;
        const [rows] = await db.query(sql);
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
                whereClause = 'AND CONCAT(h.provcode, h.distcode) = ?'; filterParams.push(distid);
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

        res.json({
            success: true,
            data: {
                successRate,
                recordedCount: recordedRows[0].recorded_count || 0,
                totalDepts: totalDeptRows[0].total || 0,
                pendingCount: pendingRows[0].pending_count || 0,
                rank: 1
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
                   u.email, u.cid, u.is_approved, u.is_active, d.dept_name, h.hosname, dist.distname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)`;
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
                sql += ` WHERE u.role != 'super_admin' AND CONCAT(h.provcode, h.distcode) = ?`;
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
        const [hospitals] = await db.query('SELECT hoscode, hosname, CONCAT(provcode, distcode) as distid FROM chospital ORDER BY hoscode');
        res.json({ success: true, data: hospitals });
    } catch (error) {
        res.status(500).json({ success: false });
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
        const [result] = await db.query(
            'INSERT INTO users (username, password_hash, role, dept_id, firstname, lastname, hospcode, phone, email, cid, is_approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
            [username, hashedPassword, finalRole, finalDeptId, firstname, lastname, hospcode, phone, email || null, hashedCid]
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
            const [target] = await db.query(`SELECT CONCAT(h.provcode, h.distcode) AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
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
            const [target] = await db.query(`SELECT CONCAT(h.provcode, h.distcode) AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
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
            const [target] = await db.query(`SELECT CONCAT(h.provcode, h.distcode) AS distid FROM users u LEFT JOIN chospital h ON u.hospcode = h.hoscode WHERE u.id = ?`, [userId]);
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

        await db.query('UPDATE users SET is_approved = 1 WHERE id = ?', [userId]);

        await db.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId, 'APPROVE_USER', 'users', userId, JSON.stringify({ username: target.username }), req.ip]
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
    const { yut_name } = req.body;
    try {
        await db.query('INSERT INTO main_yut (yut_name) VALUES (?)', [yut_name]);
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating strategy' });
    }
});

apiRouter.put('/main-yut/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    const { yut_name } = req.body;
    try {
        await db.query('UPDATE main_yut SET yut_name = ? WHERE id = ?', [yut_name, req.params.id]);
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating strategy' });
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
    const { indicator_name, yut_id } = req.body;
    try {
        await db.query('INSERT INTO kpi_main_indicators (indicator_name, yut_id) VALUES (?, ?)', [indicator_name, yut_id]);
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating main indicator' });
    }
});

apiRouter.put('/main-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    const { indicator_name, yut_id } = req.body;
    try {
        await db.query('UPDATE kpi_main_indicators SET indicator_name = ?, yut_id = ? WHERE id = ?', [indicator_name, yut_id, req.params.id]);
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating main indicator' });
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
        const [rows] = await db.query(`
            SELECT i.*, mi.main_indicator_name as main_indicator_name, d.dept_name 
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON i.dept_id = d.id
            ORDER BY i.id DESC
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching indicators:', error);
        res.status(500).json({ success: false, message: 'Error fetching indicators' });
    }
});

apiRouter.post('/indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    const { kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code, table_process } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    try {
        await db.query(
            'INSERT INTO kpi_indicators (kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code, table_process) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code, table_process || null]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating indicator' });
    }
});

apiRouter.put('/indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    const { kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code, is_active, table_process } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    try {
        await db.query(
            'UPDATE kpi_indicators SET kpi_indicators_name=?, main_indicator_id=?, dept_id=?, target_percentage=?, weight=?, kpi_indicators_code=?, is_active=?, table_process=? WHERE id=?',
            [kpi_indicators_name, main_indicator_id, dept_id, target_percentage, weight, kpi_indicators_code, is_active, table_process || null, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating indicator' });
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
    const { dept_code, dept_name } = req.body;
    try {
        await db.query('INSERT INTO departments (dept_code, dept_name) VALUES (?, ?)', [dept_code, dept_name]);
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creating department' });
    }
});

apiRouter.put('/departments/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    const { dept_code, dept_name } = req.body;
    try {
        await db.query('UPDATE departments SET dept_code=?, dept_name=? WHERE id=?', [dept_code, dept_name, req.params.id]);
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error updating department' });
    }
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

// ตรวจสอบเปรียบเทียบข้อมูล KPI ก่อน export (dry-run)
apiRouter.post('/check-kpi-export', authenticateToken, isSuperAdmin, async (req, res) => {
    const { year_bh, indicator_ids } = req.body;

    if (!year_bh || !/^\d{4}$/.test(year_bh)) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' });
    }

    try {
        // Get indicators
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

            // Pivot kpi_results
            const dataMap = new Map();
            for (const row of kpiRows) {
                if (!dataMap.has(row.hospcode)) dataMap.set(row.hospcode, {});
                const entry = dataMap.get(row.hospcode);
                const mKey = 'm' + String(row.month_bh).padStart(2, '0');
                entry[mKey] = Number(row.actual_value) || 0;
                if (String(row.month_bh) === '10') entry.target = Number(row.target_value) || 0;
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

            let newCount = 0, changedCount = 0, unchangedCount = 0;
            for (const [hc, d] of dataMap) {
                const target = d.target || 0;
                const monthValues = months.map(m => d[m] || 0);
                const result = monthValues.reduce((a, b) => a + b, 0);

                const existing = existingMap.get(hc);
                if (!existing) {
                    newCount++;
                } else {
                    const changed = Number(existing.target) !== target ||
                        Number(existing.result) !== result ||
                        months.some((m, idx) => Number(existing[m]) !== monthValues[idx]);
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

        res.json({
            success: true,
            check_date: new Date().toISOString(),
            year_bh,
            summary: { total: results.length, with_data: totalWithData, has_changes: totalChanges, up_to_date: totalUpToDate, no_data: totalNoData },
            details: results
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// สร้างตาราง MySQL แยกรายตัวชี้วัด พร้อมข้อมูลคะแนนทุก hospcode
apiRouter.post('/export-kpi-tables', authenticateToken, isSuperAdmin, async (req, res) => {
    const { year_bh, indicator_ids } = req.body;

    // Validate year_bh
    if (!year_bh || !/^\d{4}$/.test(year_bh)) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' });
    }

    // Validate indicator_ids
    if (!indicator_ids || (indicator_ids !== 'all' && !Array.isArray(indicator_ids))) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุ indicator_ids เป็น array หรือ "all"' });
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

        const [indicators] = await conn.query(indicatorQuery, indicatorParams);

        const created = [];
        const skipped = [];

        const baseColsWithMonths = 'hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) DEFAULT NULL, result VARCHAR(100) DEFAULT NULL, m10 VARCHAR(100) DEFAULT NULL, m11 VARCHAR(100) DEFAULT NULL, m12 VARCHAR(100) DEFAULT NULL, m01 VARCHAR(100) DEFAULT NULL, m02 VARCHAR(100) DEFAULT NULL, m03 VARCHAR(100) DEFAULT NULL, m04 VARCHAR(100) DEFAULT NULL, m05 VARCHAR(100) DEFAULT NULL, m06 VARCHAR(100) DEFAULT NULL, m07 VARCHAR(100) DEFAULT NULL, m08 VARCHAR(100) DEFAULT NULL, m09 VARCHAR(100) DEFAULT NULL';
        const baseColsNoMonths = 'hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) DEFAULT NULL, result VARCHAR(100) DEFAULT NULL';

        const tableDDL = (name, extraCols, hasForm) => {
            let cols = hasForm ? baseColsNoMonths : baseColsWithMonths;
            if (extraCols && extraCols.length > 0) {
                cols += ', ' + extraCols.map(f => `\`${f.field_name}\` VARCHAR(500) DEFAULT NULL`).join(', ');
            }
            return `CREATE TABLE IF NOT EXISTS \`${name}\` (${cols}, create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (hospcode, byear)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
        };

        // Helper: ALTER TABLE เพิ่มคอลัมน์ dynamic ที่ยังไม่มี
        const ensureDynamicCols = async (conn2, tableName2, extraCols) => {
            for (const f of extraCols) {
                try { await conn2.query(`ALTER TABLE \`${tableName2}\` ADD COLUMN \`${f.field_name}\` VARCHAR(500) DEFAULT NULL`); } catch (e) { /* already exists */ }
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
                // Create export table (ถ้ามี form → ไม่มีคอลัมน์เดือน, ใช้คอลัมน์จาก form แทน)
                await conn.query(tableDDL(tableName, formFields, hasForm));
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
                const dynFieldKeys = formFields.map(f => f.field_name);

                for (const [hc, d] of dataMap) {
                    const target = d.target || '';
                    const dynValues = dynFieldKeys.map(k => d['_dyn_' + k] || '');

                    if (hasForm) {
                        // มี form → ส่งออกเฉพาะ hospcode, byear, target, result + dynamic fields (ไม่มีเดือน)
                        const resultStr = dynValues.join('') ? '' : ''; // ไม่มี result สำหรับ form-based
                        upsertRows.push([hc, year_bh, target, resultStr, ...dynValues]);
                    } else {
                        // ไม่มี form → ส่งออกแบบเดิม (hospcode, byear, target, result, m10-m09)
                        const monthValues = months.map(m => d[m] || '');
                        const numericMonths = monthValues.map(v => parseFloat(v) || 0);
                        const result = numericMonths.reduce((a, b) => a + b, 0);
                        const resultStr = result > 0 ? String(result) : '';
                        upsertRows.push([hc, year_bh, target, resultStr, ...monthValues]);
                    }
                    insertedCount++;
                }

                // Batch UPSERT
                if (upsertRows.length > 0) {
                    let colsList, onDupParts;
                    if (hasForm) {
                        colsList = ['hospcode', 'byear', 'target', 'result', ...dynFieldKeys.map(k => `\`${k}\``)];
                        onDupParts = ['target=VALUES(target)', 'result=VALUES(result)', ...dynFieldKeys.map(k => `\`${k}\`=VALUES(\`${k}\`)`)];
                    } else {
                        colsList = ['hospcode', 'byear', 'target', 'result', ...months];
                        onDupParts = ['target=VALUES(target)', 'result=VALUES(result)', ...months.map(m => `${m}=VALUES(${m})`)];
                    }
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
                    unchanged: dataMap.size - insertedCount - updatedCount
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
                [req.user.id, 'export_kpi_tables', `Export ${created.length} tables for year ${year_bh}`, req.ip]
            );
        } catch (_) {}

        const totalInserted = created.reduce((s, t) => s + t.inserted, 0);
        const totalUpdated = created.reduce((s, t) => s + t.updated, 0);
        const totalUnchanged = created.reduce((s, t) => s + t.unchanged, 0);

        res.json({
            success: true,
            message: `สร้าง/อัปเดตตารางสำเร็จ ${created.length} ตาราง`,
            created_tables: created,
            skipped,
            summary: { inserted: totalInserted, updated: totalUpdated, unchanged: totalUnchanged }
        });
    } catch (err) {
        conn.release();
        res.status(500).json({ success: false, message: err.message });
    }
});

// ========== Report Summary APIs ==========

// รายงานสรุป: รายข้อตัวชี้วัด
apiRouter.get('/report/by-indicator', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based report filtering ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('r.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push("CONCAT(h.provcode, h.distcode) = ?"); params.push(distid); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                IFNULL(mi.main_indicator_name, 'ยังไม่กำหนด') AS main_indicator_name,
                d.dept_name,
                r.year_bh,
                MAX(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS target_value,
                SUM(CASE WHEN r.month_bh = 10 THEN r.actual_value ELSE 0 END) AS oct,
                SUM(CASE WHEN r.month_bh = 11 THEN r.actual_value ELSE 0 END) AS nov,
                SUM(CASE WHEN r.month_bh = 12 THEN r.actual_value ELSE 0 END) AS dece,
                SUM(CASE WHEN r.month_bh = 1 THEN r.actual_value ELSE 0 END) AS jan,
                SUM(CASE WHEN r.month_bh = 2 THEN r.actual_value ELSE 0 END) AS feb,
                SUM(CASE WHEN r.month_bh = 3 THEN r.actual_value ELSE 0 END) AS mar,
                SUM(CASE WHEN r.month_bh = 4 THEN r.actual_value ELSE 0 END) AS apr,
                SUM(CASE WHEN r.month_bh = 5 THEN r.actual_value ELSE 0 END) AS may_val,
                SUM(CASE WHEN r.month_bh = 6 THEN r.actual_value ELSE 0 END) AS jun,
                SUM(CASE WHEN r.month_bh = 7 THEN r.actual_value ELSE 0 END) AS jul,
                SUM(CASE WHEN r.month_bh = 8 THEN r.actual_value ELSE 0 END) AS aug,
                SUM(CASE WHEN r.month_bh = 9 THEN r.actual_value ELSE 0 END) AS sep,
                SUM(r.actual_value) AS total_actual,
                COUNT(DISTINCT r.hospcode) AS hospital_count
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            ${whereStr}
            GROUP BY i.id, i.kpi_indicators_name, mi.main_indicator_name, d.dept_name, r.year_bh
            ORDER BY mi.main_indicator_name, i.kpi_indicators_name
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
        const { year_bh, dept_id, distid } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based report filtering ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('r.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push("CONCAT(h.provcode, h.distcode) = ?"); params.push(distid); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                r.hospcode,
                h.hosname,
                CONCAT(h.provcode, h.distcode) AS distid,
                dist.distname,
                r.year_bh,
                COUNT(DISTINCT r.indicator_id) AS indicator_count,
                SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS total_target,
                SUM(r.actual_value) AS total_actual,
                CASE WHEN SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) > 0
                     THEN ROUND((SUM(r.actual_value) / SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END)) * 100, 2)
                     ELSE 0 END AS achievement_pct,
                SUM(CASE WHEN r.status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            ${whereStr}
            GROUP BY r.hospcode, h.hosname, CONCAT(h.provcode, h.distcode), dist.distname, r.year_bh
            ORDER BY dist.distname, h.hosname
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
        const { year_bh, dept_id } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based report filtering ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('r.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                CONCAT(h.provcode, h.distcode) AS distid,
                dist.distname,
                r.year_bh,
                COUNT(DISTINCT r.hospcode) AS hospital_count,
                COUNT(DISTINCT r.indicator_id) AS indicator_count,
                SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS total_target,
                SUM(r.actual_value) AS total_actual,
                CASE WHEN SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) > 0
                     THEN ROUND((SUM(r.actual_value) / SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END)) * 100, 2)
                     ELSE 0 END AS achievement_pct
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = CONCAT(h.provcode, h.distcode)
            ${whereStr}
            GROUP BY CONCAT(h.provcode, h.distcode), dist.distname, r.year_bh
            ORDER BY dist.distname
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
        const { dept_id, distid } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based report filtering ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('CONCAT(h.provcode, h.distcode) = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push("CONCAT(h.provcode, h.distcode) = ?"); params.push(distid); }

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                r.year_bh,
                COUNT(DISTINCT r.indicator_id) AS indicator_count,
                COUNT(DISTINCT r.hospcode) AS hospital_count,
                SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) AS total_target,
                SUM(r.actual_value) AS total_actual,
                CASE WHEN SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END) > 0
                     THEN ROUND((SUM(r.actual_value) / SUM(CASE WHEN r.month_bh = 10 THEN r.target_value ELSE 0 END)) * 100, 2)
                     ELSE 0 END AS achievement_pct,
                SUM(CASE WHEN r.status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            ${whereStr}
            GROUP BY r.year_bh
            ORDER BY r.year_bh DESC
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

// Mount Router ที่ path /khupskpi/api
app.use('/khupskpi/api', apiRouter);

app.listen(port, () => console.log(`🚀 API Server เปิดทำงานแล้วที่พอร์ต ${port} (Path: /khupskpi/api)`));
