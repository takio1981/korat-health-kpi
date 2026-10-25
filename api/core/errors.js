// Error monitoring: บันทึก error_logs (รวมรายการซ้ำด้วย fingerprint) + แจ้งเตือนแบบจำกัดความถี่
// ย้ายจาก server.js (ระยะ 1 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const { getNotifSettings, sendTelegramDirect, sendLineMulticast } = require('./notify');

// ============================================================
//  Error Monitoring — capture + dedupe + throttled alert
// ============================================================
// fingerprint = hash ของ source+message (เพื่อ merge error ซ้ำ + INSERT...UPDATE count)
// throttled alert: ส่ง Telegram เมื่อ error ใหม่หรือ severity=fatal เท่านั้น (1 ครั้ง/fingerprint/ชม)
const _errorAlertThrottle = new Map(); // fingerprint → last alert timestamp
const ERROR_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 ชั่วโมง

async function captureError(payload) {
    try {
        const source = payload.source || 'backend';
        const severity = payload.severity || 'error';
        const message = String(payload.message || '').slice(0, 1000);
        const stack = payload.stack ? String(payload.stack).slice(0, 8000) : null;
        const url = payload.url ? String(payload.url).slice(0, 500) : null;
        const userId = payload.user_id || null;
        const username = payload.username ? String(payload.username).slice(0, 100) : null;
        const ua = payload.user_agent ? String(payload.user_agent).slice(0, 500) : null;
        const ip = payload.ip_address ? String(payload.ip_address).slice(0, 64) : null;
        const extra = payload.extra ? (typeof payload.extra === 'string' ? payload.extra : JSON.stringify(payload.extra)).slice(0, 4000) : null;

        // fingerprint = SHA-1(source + first line of message)
        const firstLine = message.split('\n')[0].slice(0, 200);
        // require ตรงนี้ (ไม่ใช้ const crypto ระดับไฟล์) — captureError ถูกเรียกจาก uncaughtException ได้ตั้งแต่ก่อน
        // บรรทัด `const crypto = require('crypto')` ทำงาน (เช่น require module หายตอน startup) → TDZ error ทำให้ log หาย
        const fingerprint = require('crypto').createHash('sha1').update(`${source}|${firstLine}`).digest('hex').slice(0, 16);

        // INSERT...ON DUPLICATE: ถ้า fingerprint เคยมีแล้ว → count++, อัพเดท last_seen
        // db เป็น promise pool (db.js export pool.promise()) — ห้ามส่ง callback: callback จะไม่ถูกเรียกเลย
        // ทำให้ Promise ค้างตลอดไป (เคยเป็นบั๊กจริง: /errors/report ไม่ตอบกลับ + ไม่เคยส่ง alert Telegram/LINE)
        let isNew = false;
        try {
            const [result] = await db.query(
                `INSERT INTO error_logs (source, severity, fingerprint, message, stack, url, user_id, username, user_agent, ip_address, extra)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)
                 ON DUPLICATE KEY UPDATE count = count + 1, last_seen = CURRENT_TIMESTAMP,
                   severity = VALUES(severity), message = VALUES(message)`,
                [source, severity, fingerprint, message, stack, url, userId, username, ua, ip, extra]
            );
            // affectedRows === 1 = INSERT ใหม่, 2 = UPDATE แถวเดิม (mysql convention)
            isNew = result.affectedRows === 1;
        } catch (_) { isNew = false; }

        // === Throttled alert ===
        // alert เฉพาะ: ใหม่ครั้งแรก หรือ severity=fatal และไม่เกิน cooldown
        const now = Date.now();
        const lastAlert = _errorAlertThrottle.get(fingerprint) || 0;
        const shouldAlert = (isNew || severity === 'fatal') && (now - lastAlert > ERROR_ALERT_COOLDOWN_MS);
        if (shouldAlert) {
            _errorAlertThrottle.set(fingerprint, now);
            const tgMsg = `🐛 <b>${severity.toUpperCase()}</b> [${source}]\n` +
                          `<b>Message:</b> ${firstLine.slice(0, 200)}\n` +
                          (url ? `<b>URL:</b> <code>${url.slice(0, 100)}</code>\n` : '') +
                          (username ? `<b>User:</b> ${username}\n` : '') +
                          `<b>ID:</b> ${fingerprint}`;
            try {
                const ns = await getNotifSettings();
                if (ns.tgToken && ns.tgChatId) sendTelegramDirect(ns.tgToken, ns.tgChatId, tgMsg);
                if (ns.lineToken && ns.lineGroupId) sendLineMulticast(ns.lineToken, ns.lineGroupId, tgMsg);
            } catch (_) {}
        }
        return { fingerprint, alerted: shouldAlert };
    } catch (e) {
        // capture เองยังพังได้ — log console เท่านั้น
        console.error('[captureError] failed:', e.message);
        return null;
    }
}

// cleanup throttle map ทุก 6 ชั่วโมง
setInterval(() => {
    const cutoff = Date.now() - 2 * ERROR_ALERT_COOLDOWN_MS;
    for (const [k, v] of _errorAlertThrottle.entries()) if (v < cutoff) _errorAlertThrottle.delete(k);
}, 6 * 60 * 60 * 1000);

module.exports = { captureError };
