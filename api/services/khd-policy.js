/**
 * กติกาการส่งข้อมูลเข้า KHD (ระยะ 3 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569, ผู้ใช้เลือก: ตั้งค่าได้)
 * system_settings.khd_send_policy = 'all' (ไม่มีค่า = ค่านี้ — 27 พ.ย. 2569 ผู้ใช้เลือก: ทั้งระบบยังไม่มีผลงานที่อนุมัติ ตารางส่งออกจึงว่างทั้งหมด) | 'approved_only'
 * approved_only: ตารางส่งออกเก็บเฉพาะเดือนที่อนุมัติ/ล็อคแล้ว (is_locked = 1) เดือนอื่นเป็นค่าว่าง → การส่งเข้า KHD ไม่เขียนค่าว่างทับ (planKhdTableSync)
 * จึงไม่ล้างค่าที่มีอยู่ใน KHD และ KHD ได้รับค่าใหม่เมื่ออนุมัติแล้วเท่านั้น
 * + ค่าควบคุมภาระของ KHD (ขนาดชุด/พัก/เพดานแถว/เวลา/timeout) และอายุบันทึกการส่ง
 */
const db = require('../db');

const KHD_SEND_POLICIES = ['approved_only', 'all'];
const DEFAULTS = {
    khd_send_policy: 'all',
    khd_sync_batch_size: 100,      // แถวต่อชุด UPDATE/INSERT
    khd_sync_pause_ms: 50,         // พักระหว่างชุด (ลดภาระ KHD)
    khd_sync_max_rows: 20000,      // เพดานแถวที่เขียนต่อรอบ (เกิน = partial รอบหน้าทำต่อ)
    khd_sync_max_seconds: 300,     // เพดานเวลาต่อรอบ
    khd_query_timeout_ms: 30000,   // timeout ต่อคำสั่งฝั่ง KHD
    khd_sync_audit_keep_days: 180, // อายุบันทึกค่าก่อน-หลังที่เขียนลง KHD
};
const LIMITS = {
    khd_sync_batch_size: [10, 500], khd_sync_pause_ms: [0, 5000], khd_sync_max_rows: [100, 500000],
    khd_sync_max_seconds: [30, 3600], khd_query_timeout_ms: [5000, 120000], khd_sync_audit_keep_days: [7, 3650],
};

let _cache = null, _cacheAt = 0;
function invalidateKhdSyncSettings() { _cache = null; }

async function getKhdSyncSettings() {
    if (_cache && Date.now() - _cacheAt < 60000) return _cache;
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [Object.keys(DEFAULTS)]);
    const s = { ...DEFAULTS };
    for (const r of rows) {
        if (r.setting_key === 'khd_send_policy') s.khd_send_policy = KHD_SEND_POLICIES.includes(r.setting_value) ? r.setting_value : DEFAULTS.khd_send_policy;
        else if (LIMITS[r.setting_key]) {
            const n = Number(r.setting_value);
            const [lo, hi] = LIMITS[r.setting_key];
            if (Number.isFinite(n)) s[r.setting_key] = Math.min(hi, Math.max(lo, Math.round(n)));
        }
    }
    _cache = s; _cacheAt = Date.now();
    return s;
}

async function getKhdSendPolicy() {
    return (await getKhdSyncSettings()).khd_send_policy;
}

/** ตรวจค่าที่ส่งมา (PUT /khd-sync/settings) → { values } | { error } — ไม่ส่ง = ไม่เปลี่ยน */
function validateKhdSyncSettings(body) {
    const out = {};
    if (!body || typeof body !== 'object') return { error: 'ข้อมูลไม่ถูกต้อง' };
    if (body.khd_send_policy !== undefined) {
        if (!KHD_SEND_POLICIES.includes(body.khd_send_policy)) return { error: 'กติกาการส่งต้องเป็น approved_only หรือ all' };
        out.khd_send_policy = body.khd_send_policy;
    }
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
        if (body[k] === undefined) continue;
        const n = Number(body[k]);
        if (!Number.isInteger(n) || n < lo || n > hi) return { error: `${k} ต้องเป็นจำนวนเต็ม ${lo}–${hi}` };
        out[k] = n;
    }
    return { values: out };
}

async function saveKhdSyncSettings(values) {
    for (const [k, v] of Object.entries(values)) {
        await db.query(
            'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            [k, String(v)]
        );
    }
    invalidateKhdSyncSettings();
}

module.exports = { KHD_SEND_POLICIES, KHD_SYNC_DEFAULTS: DEFAULTS, getKhdSyncSettings, getKhdSendPolicy, validateKhdSyncSettings, saveKhdSyncSettings, invalidateKhdSyncSettings };
