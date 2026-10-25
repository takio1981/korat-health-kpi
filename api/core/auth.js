// การยืนยันตัวตน: authenticateToken (JWT + สิทธิ์เข้าหน้า + single session + last seen), isAdmin/isAnyAdmin/isSuperAdmin, saveLog
// ย้ายจาก server.js (ระยะ 1 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const jwt = require('jsonwebtoken');
const { SECRET_KEY } = require('./security');
const { ROLE_ADMIN_ALL, ROLE_ADMIN_CENTRAL, hasPageAccess, resolvePageKeyFromPath } = require('./access');

// Middleware ตรวจสอบ JWT Token
// Throttle cache สำหรับ update last_seen — userId → timestamp ของ update ล่าสุด
const _lastSeenCache = new Map();
const LAST_SEEN_THROTTLE_MS = 3 * 60 * 1000; // update DB ไม่เกิน 1 ครั้ง/3นาที/user (เดิม 1 นาที → ลด DB writes)

// Cache active_session_id per user (TTL 2 นาที) — ลด DB SELECT ทุก request
// userId → { sessionId, expiry }
const _sessionCache = new Map();
const SESSION_CACHE_TTL = 2 * 60 * 1000; // 2 นาที (เดิม 30s)

// ล้าง cache entries เก่าเป็นระยะ กัน memory leak
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _sessionCache.entries()) {
        if (v.expiry < now - 5 * 60 * 1000) _sessionCache.delete(k);
    }
    for (const [k, t] of _lastSeenCache.entries()) {
        if (t < now - 30 * 60 * 1000) _lastSeenCache.delete(k);
    }
}, 5 * 60 * 1000); // ทุก 5 นาที

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });

    let user;
    try {
        user = jwt.verify(token, SECRET_KEY);
    } catch (err) {
        return res.status(403).json({ success: false, code: 'TOKEN_EXPIRED', message: 'Token ไม่ถูกต้องหรือหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
    }
    req.user = user;

    // === Role × Page Access — ปฏิเสธก่อน session/last-seen ถ้า role นี้ไม่มีสิทธิ์เข้าหน้าที่ endpoint นี้สังกัดอยู่ ===
    const _pageKey = resolvePageKeyFromPath(req.method, req.path);
    if (_pageKey && !hasPageAccess(user.role, _pageKey)) {
        return res.status(403).json({ success: false, code: 'PAGE_ACCESS_DENIED', message: 'ไม่มีสิทธิ์เข้าถึงเมนูนี้ กรุณาติดต่อผู้ดูแลระบบ' });
    }

    const uid = user.userId;
    if (!uid) return next();

    // === ตรวจสอบบัญชี + session (Single Session Enforcement) ===
    // แคชต่อผู้ใช้ 2 นาที: { sessionId, exists, isActive } — เส้นทางที่ปิดใช้งาน/ลบผู้ใช้/บังคับ logout ต้อง _sessionCache.delete(uid) ให้มีผลทันที
    // (25 ต.ค. 2569) เดิมปฏิเสธเฉพาะ session ในฐาน "มีค่าและไม่ตรง" → logout/บังคับ logout (NULL) แล้ว token เดิมยังใช้ได้ 8 ชม.
    //   และบัญชีที่ถูกปิดใช้งาน/ลบแล้วยังเรียก API ได้ — ตอนนี้: ไม่พบบัญชี/ปิดใช้งาน = ACCOUNT_DISABLED, token มี sessionId แต่ในฐานว่าง = SESSION_ENDED
    {
        const now = Date.now();
        let cached = _sessionCache.get(uid);
        if (!cached || cached.expiry < now) {
            try {
                const [rows] = await db.query('SELECT active_session_id, is_active FROM users WHERE id = ?', [uid]);
                cached = {
                    sessionId: rows[0]?.active_session_id || null,
                    exists: rows.length > 0,
                    isActive: rows.length > 0 && Number(rows[0].is_active) !== 0,
                    expiry: now + SESSION_CACHE_TTL,
                };
                _sessionCache.set(uid, cached);
            } catch (e) {
                // DB error — log + ปล่อยผ่านเพื่อไม่ให้ระบบล่มทั้งระบบ (แต่ enforcement ถูก bypass)
                console.error(`❌ [Single Session] SELECT active_session_id ล้มเหลว user_id=${uid} —`, e.message);
                console.error('   👉 ตรวจสอบว่ามีคอลัมน์ active_session_id ใน users table หรือไม่');
                cached = { sessionId: user.sessionId || null, exists: true, isActive: true, dbError: true, expiry: now + SESSION_CACHE_TTL };
            }
        }
        if (!cached.exists || !cached.isActive) {
            return res.status(401).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'บัญชีนี้ถูกปิดใช้งานหรือไม่มีอยู่ในระบบแล้ว กรุณาติดต่อผู้ดูแลระบบ' });
        }
        // token รุ่นเก่าที่ไม่มี sessionId (สร้างก่อนมีระบบนี้) — ข้ามการตรวจ session เหมือนเดิม
        if (user.sessionId && !cached.sessionId && !cached.dbError) {
            return res.status(401).json({ success: false, code: 'SESSION_ENDED', message: 'การเข้าสู่ระบบนี้สิ้นสุดแล้ว (ออกจากระบบ หรือผู้ดูแลระบบบังคับออกจากระบบ) กรุณาเข้าสู่ระบบใหม่' });
        }
        if (user.sessionId && cached.sessionId && cached.sessionId !== user.sessionId) {
            // ดึงข้อมูล "ใครเตะ" จาก DB ให้เครื่องเก่าเห็น
            let kickInfo = { kicked_by_ip: null, kicked_by_ua: null, kicked_at: null };
            try {
                const [kr] = await db.query('SELECT kicked_by_ip, kicked_by_ua, kicked_at FROM users WHERE id = ?', [uid]);
                if (kr.length > 0) {
                    kickInfo = {
                        kicked_by_ip: kr[0].kicked_by_ip,
                        kicked_by_ua: kr[0].kicked_by_ua,
                        kicked_at: kr[0].kicked_at
                    };
                }
            } catch (_) { /* column ไม่มี — ปล่อย */ }
            return res.status(401).json({
                success: false,
                code: 'SESSION_INVALIDATED',
                message: 'บัญชีของคุณถูกใช้งานจากอุปกรณ์อื่น',
                ...kickInfo
            });
        }
    }

    // Track last_seen — throttled (max 1/min/user) กันเขียน DB ถี่เกิน
    const now = Date.now();
    const last = _lastSeenCache.get(uid) || 0;
    if (now - last > LAST_SEEN_THROTTLE_MS) {
        _lastSeenCache.set(uid, now);
        const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
        const ua = (req.headers['user-agent'] || '').toString().slice(0, 255);
        db.query('UPDATE users SET last_seen_at = NOW(), last_seen_ip = ?, last_seen_ua = ? WHERE id = ?', [ip, ua, uid])
          .catch(() => {});
    }
    next();
};

// Middleware ตรวจสอบสิทธิ์ Admin ส่วนกลาง (admin_ssj + super_admin)
// OR hasPageAccess — เผื่อ Super Admin เปิดสิทธิ์หน้านี้ให้ role อื่นเพิ่มผ่านหน้า "สิทธิ์การเข้าถึงหน้า"
// (ค่าเริ่มต้นในตาราง role_page_access seed ให้ตรงกับ ROLE_ADMIN_CENTRAL เป๊ะ จึงไม่เปลี่ยนพฤติกรรมเดิมจนกว่าจะถูกแก้ไข)
const isAdmin = (req, res, next) => {
    const role = req.user?.role;
    if (role && (ROLE_ADMIN_CENTRAL.includes(role) || hasPageAccess(role, resolvePageKeyFromPath(req.method, req.path)))) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบส่วนกลาง (สสจ.) เท่านั้น' });
    }
};

// Middleware ตรวจสอบสิทธิ์ Admin ทุกระดับ (+ hasPageAccess เช่นเดียวกับ isAdmin)
const isAnyAdmin = (req, res, next) => {
    const role = req.user?.role;
    if (role && (ROLE_ADMIN_ALL.includes(role) || hasPageAccess(role, resolvePageKeyFromPath(req.method, req.path)))) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบเท่านั้น' });
    }
};

// Middleware ตรวจสอบสิทธิ์ Super Admin เท่านั้น (+ hasPageAccess — hasPageAccess คืน true เสมอถ้า role==='super_admin' อยู่แล้ว)
const isSuperAdmin = (req, res, next) => {
    if (req.user && (req.user.role === 'super_admin' || hasPageAccess(req.user.role, resolvePageKeyFromPath(req.method, req.path)))) {
        next();
    } else {
        res.status(403).json({ success: false, message: 'สิทธิ์การเข้าถึงจำกัดเฉพาะผู้ดูแลระบบสูงสุด (Super Admin) เท่านั้น' });
    }
};

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

module.exports = { _sessionCache, authenticateToken, isAdmin, isAnyAdmin, isSuperAdmin, saveLog };
