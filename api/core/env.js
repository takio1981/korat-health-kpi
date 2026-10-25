// สภาพแวดล้อมตอนเริ่มระบบ: timezone, โหลด .env.dev, ตัวดัก error ระดับ process
// ย้ายจาก server.js (ระยะ 1 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ⚠️ ต้องเป็น require แรกของ server.js — ก่อน require('./db') ที่สร้าง connection pool จากค่าใน .env

const captureError = (payload) => require('./errors').captureError(payload);

// === Timezone: บังคับ Asia/Bangkok (ICT, UTC+7) ก่อน Date object ใดๆ ถูกสร้าง ===
// สำคัญ: ต้องตั้งก่อน require ทุกอย่าง เพราะ V8 อาจ cache TZ ไว้ตอน Date.now() ครั้งแรก
if (!process.env.TZ) process.env.TZ = 'Asia/Bangkok';

// Dev: load .env.dev | Production (Docker): env vars injected via docker-compose
// MUST be first — before any require('./db') that creates the MySQL pool
if (process.env.NODE_ENV !== 'production') {
    const result = require('dotenv').config({ path: '.env.dev' });
    if (result.error) {
        console.error('[dotenv] Failed to load .env.dev:', result.error.message);
    } else {
        console.log('[dotenv] Loaded .env.dev — DB_HOST:', process.env.DB_HOST, '| PORT:', process.env.PORT);
    }
    // override อีกครั้งหลัง dotenv (เผื่อ .env.dev มี TZ override)
    if (process.env.TZ) console.log('[Timezone] process.env.TZ =', process.env.TZ);
}

// แสดงเวลาปัจจุบันชัดเจน ตรวจ TZ ตอน startup
(() => {
    const _now = new Date();
    const tzOffset = -_now.getTimezoneOffset() / 60;
    console.log(`[Timezone] Now: ${_now.toString()}`);
    console.log(`[Timezone] Local: ${_now.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })} (Asia/Bangkok)`);
    console.log(`[Timezone] process.env.TZ='${process.env.TZ || '(unset)'}', getTimezoneOffset()=${_now.getTimezoneOffset()}min → UTC${tzOffset>=0?'+':''}${tzOffset}`);
    if (tzOffset !== 7) {
        console.warn(`[Timezone] ⚠️  WARNING: timezone ไม่ใช่ UTC+7 — ตรวจ env TZ (Docker: TZ=Asia/Bangkok + apk add tzdata, Windows: ตั้ง Region เป็น Bangkok)`);
    }
})();

// === Safety net: กัน backend ตายทั้ง process จาก error ใน background job (restore/backup/scheduler) ===
// ทำให้ระบบยังตอบ request อื่นได้ (ไม่ 502) แม้ background task พัง
// + capture ลง error_logs (deferred — db อาจยังไม่ready ตอน startup)
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : null;
    console.error('[unhandledRejection]', stack || msg);
    setImmediate(() => {
        try { captureError({ source: 'backend', severity: 'error', message: 'unhandledRejection: ' + msg, stack }); } catch (_) {}
    });
});
process.on('uncaughtException', (err) => {
    // log แล้วไม่ exit — กัน 1 error ใน child process/stream ทำให้ทั้ง backend ล่ม
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
    setImmediate(() => {
        try { captureError({ source: 'backend', severity: 'fatal', message: 'uncaughtException: ' + (err?.message || String(err)), stack: err?.stack }); } catch (_) {}
    });
});

// ใช้ Port จาก ENV หรือ Default 8830 ตามโจทย์ (ย้ายจาก server.js 25 ต.ค. 2569 — ใช้ร่วมกับ routes/)
const port = process.env.PORT || 8830;

module.exports = { port };
