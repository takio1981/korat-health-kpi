// การแจ้งเตือน: อีเมล (SMTP), Telegram, LINE (กลุ่ม/รายบุคคล + หมวดที่เปิดปิดได้), แจ้งผู้ดูแลระบบ, แจ้งเตือนการเข้าสู่ระบบ
// ย้ายจาก server.js (ระยะ 1 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const nodemailer = require('nodemailer');

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

// แปล error จาก LINE Messaging API ให้เป็นข้อความที่ตรงสาเหตุจริง — เดิมทุก endpoint ที่ทดสอบส่ง LINE
// ขึ้นข้อความเดียวกันหมด ("ตรวจสอบ Channel Access Token และ Group ID") ไม่ว่าสาเหตุจริงจะเป็นอะไร ทำให้
// ผู้ใช้เข้าใจผิดว่า token/group id ผิด ทั้งที่บางครั้งสาเหตุจริงคือโควตาเต็ม (429), token หมดอายุ (401),
// หรือ user ยังไม่ได้ add friend bot (400) ซึ่งแก้กันคนละทาง
function describeLineError(status, rawBody) {
    let lineMsg = '';
    try { lineMsg = JSON.parse(rawBody || '{}')?.message || ''; } catch (e) {}
    if (status === 429) return 'โควตาข้อความ LINE ของเดือนนี้เต็มแล้ว (LINE Official Account แผนฟรีจำกัดจำนวนข้อความ/เดือน) — รอรีเซ็ตต้นเดือนถัดไป หรืออัปเกรดแผนที่ LINE Official Account Manager (manager.line.biz)';
    if (status === 401) return 'Channel Access Token ไม่ถูกต้องหรือหมดอายุ — ออก token ใหม่ที่ LINE Developers Console แล้วอัปเดตที่ Settings';
    if (status === 403) return 'ไม่มีสิทธิ์ส่งหา ID นี้ — ผู้รับอาจบล็อกบอทไว้';
    if (status === 400) return `Group ID/User ID ไม่ถูกต้อง หรือบอทไม่ได้อยู่ในกลุ่ม/ยังไม่ถูก Add friend${lineMsg ? ' (LINE แจ้งว่า: ' + lineMsg + ')' : ''}`;
    if (lineMsg) return `ส่งไม่สำเร็จ: ${lineMsg} (HTTP ${status ?? '-'})`;
    return 'ส่งไม่สำเร็จ — ไม่ทราบสาเหตุ (ดู server log)';
}

// === LINE Messaging API Notification ===
// ใช้ Channel Access Token (long-lived) + Group/User ID
// สร้าง bot ที่ developers.line.biz/console → เชิญ bot เข้า group → ดึง groupId จาก webhook event
// LINE limit text message 5000 chars/message, push API rate 1000 msg/min ต่อ channel
// คืนค่าเป็น { ok, status, error } เสมอ (ไม่ใช่ boolean เปล่าๆ เหมือนเดิม) เพื่อให้ endpoint ที่แสดงผลให้
// ผู้ใช้เห็น (test-line, me/line/test ฯลฯ) ส่งสาเหตุจริงกลับไปได้ — จุดที่ fire-and-forget (notifyLineAction,
// sendLineToUser) ไม่ได้อ่านค่านี้อยู่แล้วจึงไม่กระทบ
const sendLineDirect = async (channelToken, groupId, message) => {
    if (!channelToken || !groupId) return { ok: false, status: null, error: 'ไม่ได้ตั้งค่า Channel Access Token หรือ Group/User ID' };
    try {
        // LINE strip HTML tag — ส่งเป็น plain text เท่านั้น
        const plain = String(message).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').slice(0, 4900);
        const res = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${channelToken}`
            },
            body: JSON.stringify({
                to: groupId,
                messages: [{ type: 'text', text: plain }]
            })
        });
        if (res.ok) { console.log('[LINE] Message sent to', groupId.slice(0, 8) + '...'); return { ok: true, status: res.status, error: null }; }
        const errBody = await res.text();
        console.error('[LINE] Failed:', res.status, errBody.slice(0, 200));
        return { ok: false, status: res.status, error: describeLineError(res.status, errBody) };
    } catch (err) {
        console.error('[LINE] Error:', err.message);
        return { ok: false, status: null, error: 'เชื่อมต่อ LINE API ไม่ได้: ' + err.message };
    }
};

// ส่ง LINE หลาย group ในครั้งเดียว — รับ comma-separated group IDs
// lastError เก็บสาเหตุของความล้มเหลวครั้งล่าสุด (ถ้ามี) ให้ caller ที่ต้องแสดงผลผู้ใช้นำไปใช้ได้
const sendLineMulticast = async (channelToken, groupIdsStr, message) => {
    if (!channelToken || !groupIdsStr) return { sent: 0, failed: 0, lastError: 'ไม่ได้ตั้งค่า Channel Access Token หรือ Group ID' };
    const groupIds = String(groupIdsStr).split(',').map(s => s.trim()).filter(Boolean);
    let sent = 0, failed = 0, lastError = null;
    for (const gid of groupIds) {
        const r = await sendLineDirect(channelToken, gid, message);
        if (r.ok) sent++; else { failed++; lastError = r.error; }
    }
    return { sent, failed, lastError };
};

// === Admin Action LINE Notification — fire-and-forget + category toggle ===
// Categories: admin_login | backup | restore | settings_change | indicator_change
// settings keys: notif_line_admin_login, notif_line_backup, notif_line_restore,
//                notif_line_settings_change, notif_line_indicator_change
//                (default 'true' — เปิดทั้งหมด ผู้ใช้ปิดเองได้)
// ใช้ cache 60s เพื่อกัน query system_settings ทุกครั้ง
let _lineCategoryCache = null;
let _lineCategoryExpiry = 0;
async function getLineCategoryToggles() {
    const now = Date.now();
    if (_lineCategoryCache && _lineCategoryExpiry > now) return _lineCategoryCache;
    try {
        const [rows] = await db.query(
            "SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('notif_line_enabled','notif_line_admin_login','notif_line_backup','notif_line_restore','notif_line_settings_change','notif_line_indicator_change')"
        );
        const s = {};
        for (const r of rows) s[r.setting_key] = r.setting_value;
        _lineCategoryCache = {
            master: s.notif_line_enabled !== 'false',
            admin_login: s.notif_line_admin_login !== 'false',
            backup: s.notif_line_backup !== 'false',
            restore: s.notif_line_restore !== 'false',
            settings_change: s.notif_line_settings_change !== 'false',
            indicator_change: s.notif_line_indicator_change !== 'false'
        };
        _lineCategoryExpiry = now + 60 * 1000;
        return _lineCategoryCache;
    } catch (e) {
        return { master: true, admin_login: true, backup: true, restore: true, settings_change: true, indicator_change: true };
    }
}
// invalidate cache (เรียกเมื่อ save settings)
function invalidateLineCategoryCache() { _lineCategoryExpiry = 0; }

// notifyLineAction — ส่ง LINE แบบสั้นๆ + check toggle + fire-and-forget
// ไม่ await — ไม่ block response
async function notifyLineAction(category, message) {
    try {
        const cfg = await getLineCategoryToggles();
        if (!cfg.master) return;            // master off
        if (cfg[category] === false) return; // category off
        const ns = await getNotifSettings();
        if (!ns.lineToken || !ns.lineGroupId) return;
        sendLineMulticast(ns.lineToken, ns.lineGroupId, message)
            .catch(e => console.error('[LINE action] error:', e.message));
    } catch (e) {
        console.error('[notifyLineAction] failed:', e.message);
    }
}

// === Personal LINE Notification — push ถึง user รายบุคคล ===
// ใช้ channel access token เดียวกับ group + ส่งไปที่ user.line_user_id ของแต่ละคน
// fire-and-forget — ไม่ block response
async function sendLineToUser(userId, message) {
    try {
        if (!userId) return false;
        // master switch ใช้ตัวเดียวกับ group (notif_line_enabled = 'false' → ปิดทั้งระบบรวม per-user ด้วย)
        const cfg = await getLineCategoryToggles();
        if (!cfg.master) return false;
        // ดึง user line_user_id + per-user opt-in
        const [rows] = await db.query(
            'SELECT line_user_id, notif_line_enabled FROM users WHERE id = ? LIMIT 1',
            [userId]
        );
        if (!rows[0]) return false;
        const u = rows[0];
        if (!u.line_user_id) return false;          // user ยังไม่ได้ลงทะเบียน LINE userId
        if (Number(u.notif_line_enabled) === 0) return false;  // user ปิด toggle เอง
        // ดึง channel token
        const ns = await getNotifSettings();
        if (!ns.lineToken) return false;
        // ใช้ sendLineDirect (รับ user/group/room ID ได้เหมือนกัน)
        sendLineDirect(ns.lineToken, u.line_user_id, message)
            .catch(e => console.error('[LINE user] error:', e.message));
        return true;
    } catch (e) {
        console.error('[sendLineToUser] failed:', e.message);
        return false;
    }
}

// ลบ notification "ผู้ใช้งานใหม่รอการอนุมัติ" ที่อ้างอิง user ที่ถูกลบไปแล้ว (created_by = deletedUserId)
// กันไม่ให้เกิด notification ค้าง → คลิกแล้ว 404 (/users/:id/basic ไม่พบ)
// ใช้ title เจาะจงแทน created_by อย่างเดียว เพราะ created_by ใช้ร่วมกับ notification ประเภทอื่นๆ ด้วย (approve/reject/appeal ฯลฯ)
async function cleanupPendingApprovalNotifications(deletedUserId) {
    try {
        if (!deletedUserId) return;
        await db.query(
            "DELETE FROM notifications WHERE title = 'ผู้ใช้งานใหม่รอการอนุมัติ' AND created_by = ?",
            [deletedUserId]
        );
    } catch (e) {
        console.error('[cleanupPendingApprovalNotifications] failed:', e.message);
    }
}

/**
 * ส่งการแจ้งเตือน login ทุกช่องทาง — fire-and-forget (ไม่ await)
 * 4 ช่องทาง: Local DB | LINE group (admin) | LINE personal (user) | Email | Telegram (admin)
 */
async function sendLoginNotifications(user, ip, ua, provider) {
    try {
        const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        const uaShort = String(ua || '').slice(0, 80);
        const providerLabel = provider === 'thaid' ? 'ThaID'
                           : provider === 'providerid' ? 'ProviderID'
                           : provider === 'password' ? 'Username/Password'
                           : 'SSO';
        const notifType   = provider === 'password' ? 'login' : 'login_sso';

        // [1] Local DB — บันทึกใน notifications (ทุก user ทุก role)
        try {
            const notifTitle = provider === 'password' ? 'เข้าสู่ระบบสำเร็จ' : `เข้าสู่ระบบผ่าน ${providerLabel}`;
            await db.query(
                `INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)`,
                [user.id, notifType, notifTitle, `เวลา ${nowStr} | IP: ${ip}`]
            );
        } catch (e) { /* ไม่ block ถ้า notifications ยังไม่มีตาราง */ }

        // [2] LINE group + Telegram — admin_login category (super_admin / admin_ssj เท่านั้น)
        if (user.role === 'super_admin' || user.role === 'admin_ssj') {
            const roleEmoji = user.role === 'super_admin' ? '👑' : '🛡️';
            const adminMsg = `${roleEmoji} Admin login (${providerLabel})\n` +
                `👤 ${user.firstname || ''} ${user.lastname || ''} (${user.username})\n` +
                `🔑 Role: ${user.role}\n🌐 IP: ${ip}\n🕐 ${nowStr}\n📱 ${uaShort}`;
            notifyLineAction('admin_login', adminMsg);

            // [5] Telegram — admin login (same message)
            const ns = await getNotifSettings();
            if (ns.tgToken && ns.tgChatId) {
                sendTelegramDirect(ns.tgToken, ns.tgChatId, adminMsg);
            }
        }

        // [3] LINE personal — push ถึง user รายบุคคล (ถ้าผูก line_user_id)
        const personalVia = provider === 'password' ? '' : `ผ่าน ${providerLabel} `;
        sendLineToUser(user.id,
            `🔑 มีการเข้าสู่ระบบบัญชีของคุณ ${personalVia}\n` +
            `🕐 ${nowStr}\n🌐 IP: ${ip}\n📱 ${uaShort}\n\n` +
            `❗ ถ้าไม่ใช่คุณ — แจ้งผู้ดูแลระบบทันที`
        );

        // [4] Email — ถ้ามี email บันทึกในระบบ
        if (user.email) {
            sendMail(user.email,
                `🔑 แจ้งเตือนการเข้าสู่ระบบ (${providerLabel}) — ระบบ KPI สสจ.นครราชสีมา`,
                `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                    <div style="background:linear-gradient(135deg,#16a34a,#22c55e);padding:20px;text-align:center;color:white">
                        <h2 style="margin:0;font-size:18px">🔑 แจ้งเตือนการเข้าสู่ระบบ (${providerLabel})</h2>
                    </div>
                    <div style="padding:20px">
                        <p>เรียน คุณ${user.firstname || ''} ${user.lastname || ''},</p>
                        <p style="color:#6b7280">บัญชีของคุณถูกเข้าสู่ระบบเมื่อ:</p>
                        <table style="width:100%;font-size:14px;border-collapse:collapse;margin-top:10px">
                            <tr><td style="padding:6px 0;color:#6b7280">เวลา</td><td style="font-weight:bold">${nowStr}</td></tr>
                            <tr><td style="padding:6px 0;color:#6b7280">IP Address</td><td style="font-weight:bold">${ip}</td></tr>
                            <tr><td style="padding:6px 0;color:#6b7280">Username</td><td style="font-weight:bold">${user.username}</td></tr>
                            <tr><td style="padding:6px 0;color:#6b7280">วิธีเข้าสู่ระบบ</td><td style="font-weight:bold">${providerLabel}</td></tr>
                        </table>
                        <p style="color:#dc2626;font-size:13px;margin-top:15px">หากไม่ใช่คุณ กรุณาติดต่อผู้ดูแลระบบทันที</p>
                    </div>
                </div>`
            );
        }
    } catch (e) {
        console.error('[sendLoginNotifications] error:', e.message);
    }
}

// Helper: ดึง notification settings จาก DB (fallback ENV)
const getNotifSettings = async () => {
    try {
        const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('telegram_bot_token','telegram_chat_id','admin_emails','line_channel_token','line_group_id')");
        const s = {};
        for (const r of rows) s[r.setting_key] = r.setting_value;
        return {
            tgToken: s.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '',
            tgChatId: s.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || '',
            adminEmails: s.admin_emails || process.env.ADMIN_EMAILS || '',
            lineToken: s.line_channel_token || process.env.LINE_CHANNEL_TOKEN || '',
            lineGroupId: s.line_group_id || process.env.LINE_GROUP_ID || ''
        };
    } catch (e) {
        return {
            tgToken: process.env.TELEGRAM_BOT_TOKEN || '',
            tgChatId: process.env.TELEGRAM_CHAT_ID || '',
            adminEmails: process.env.ADMIN_EMAILS || '',
            lineToken: process.env.LINE_CHANNEL_TOKEN || '',
            lineGroupId: process.env.LINE_GROUP_ID || ''
        };
    }
};

const notifyAdmins = async (subject, html, telegramMsg, options = {}) => {
    const ns = await getNotifSettings();
    const sendTg = options.telegram !== false;
    const sendEm = options.email !== false;
    const sendLn = options.line !== false;
    // 1. Telegram
    if (sendTg && telegramMsg) sendTelegramDirect(ns.tgToken, ns.tgChatId, telegramMsg);
    // 2. LINE (ใช้ข้อความเดียวกับ Telegram แต่ strip HTML)
    if (sendLn && telegramMsg && ns.lineToken && ns.lineGroupId) {
        sendLineMulticast(ns.lineToken, ns.lineGroupId, telegramMsg);
    }
    // 3. Email to admin list
    if (sendEm && ns.adminEmails) {
        const emails = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of emails) {
            sendMail(email, subject, html);
        }
    }
};

module.exports = { mailTransporter, sendMail, sendTelegramDirect, sendLineDirect, sendLineMulticast, invalidateLineCategoryCache, notifyLineAction, sendLineToUser, cleanupPendingApprovalNotifications, sendLoginNotifications, getNotifSettings, notifyAdmins };
