// ค่าความปลอดภัยของระบบ: SECRET_KEY, ค่าตั้งค่าการเข้าสู่ระบบ (โหลดจาก system_settings), ตัวจำกัดอัตราคำขอ
// ย้ายจาก server.js (ระยะ 1 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

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

// ============================================================
//  Rate Limiting — 2-layer สำหรับ /login (กัน Office NAT พลาด)
// ============================================================
// Layer 1: per-IP (DDoS protection only) — สูงพอให้ทั้งออฟฟิศใช้ได้
//   - 500 attempts/15min/IP — เผื่อ 100+ users ใต้ NAT เดียวกัน
//   - skipSuccessful: เฉพาะ fail นับ → ผู้ใช้ที่ login สำเร็จไม่กิน quota
const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 500,
    keyGenerator: (req) => `loginip:${req.ip || 'unknown'}`,
    message: {
        success: false,
        code: 'IP_RATE_LIMIT',
        message: 'ระบบตรวจพบการ login ล้มเหลวจาก IP นี้จำนวนมาก กรุณารอ 15 นาที (อาจมี user หลายคนใช้ network เดียวกัน หรือ script ผิดปกติ)'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

// Layer 2: per-(IP + username) — Brute force protection (เดารหัส)
//   - max_login_attempts (default 10) ต่อ user/15min — เข้มเพราะรู้ username แล้ว
//   - คนละ user ที่ IP เดียวกัน = counter แยก → 1 user ติดบล็อก ไม่กระทบเพื่อน
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: (req, res) => loginAttemptsEnabled ? maxLoginAttempts : 9999,
    keyGenerator: (req) => {
        const ip = req.ip || 'unknown';
        const username = (req.body?.username || 'anonymous').toString().toLowerCase().trim();
        return `login:${ip}:${username}`;
    },
    message: {
        success: false,
        code: 'USER_RATE_LIMIT',
        message: 'รหัสผ่านผิดเกินกำหนด กรุณารอ 15 นาที หรือกด "ลืมรหัสผ่าน" เพื่อรับรหัสชั่วคราว'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});

// apiLimiter: per-user (parse JWT manually) ไม่ใช่ per-IP — รองรับ users หลายคนหลัง NAT
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 นาที
    max: 600, // 600 req/min/user (เผื่อ dashboard หลายแถว + polling)
    keyGenerator: (req) => {
        // parse JWT manually (ก่อน authenticateToken middleware) → ใช้ userId เป็น key
        try {
            const authHeader = req.headers['authorization'];
            const token = authHeader && authHeader.split(' ')[1];
            if (token) {
                const payload = jwt.verify(token, SECRET_KEY);
                if (payload?.userId) return `user:${payload.userId}`;
            }
        } catch (_) { /* invalid token — fall through to IP */ }
        return `ip:${req.ip || 'unknown'}`;
    },
    skip: (req) => {
        // ข้าม endpoints heavy ที่ super_admin ใช้ (export, backup, restore, monitor) — มีสิทธิ์อยู่แล้ว
        const url = req.url || '';
        return url.includes('/backup/') || url.includes('/export-kpi-tables') || url.includes('/sync-to-khd') ||
               url.includes('/refresh-summary') || url.includes('/online-users');
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'เรียก API ถี่เกินไป กรุณารอสักครู่' }
});
// ตั้งชื่อฟังก์ชัน middleware (ไม่เปลี่ยนการทำงาน) — ให้ tests/route-inventory.test.js แยกได้ว่าเส้นทางใดใช้ตัวจำกัดตัวไหน
for (const [n, fn] of Object.entries({ loginIpLimiter, loginLimiter, apiLimiter })) Object.defineProperty(fn, 'name', { value: n });

const SECRET_KEY = process.env.SECRET_KEY;
if (!SECRET_KEY) {
    console.error('FATAL ERROR: SECRET_KEY is not defined.');
    process.exit(1);
}

module.exports = { updateSystemSettings, loginIpLimiter, loginLimiter, apiLimiter, SECRET_KEY };
