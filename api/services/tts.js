// เสียงพูดน้องคิดดีแบบสด (26 พ.ย. 2569 — ผู้ใช้เลือก Gemini TTS อ่านข้อความที่ไม่มีไฟล์เสียงสร้างล่วงหน้า เช่น คำตอบจาก AI)
// ตั้งค่าใน system_settings tts_* (super_admin) — คีย์: tts_api_key_enc ก่อน ไม่มี = ใช้คีย์ของผู้ช่วย AI เมื่อตั้งเป็น Google Gemini อยู่แล้ว
// ไม่เก็บข้อความที่อ่านใน ai_usage_logs (feature 'tts') — แคชผลในหน่วยความจำตามข้อความ + ค่าเสียง
const crypto = require('crypto');
const db = require('../db');
const { bkEncrypt, bkDecrypt } = require('./backup');
const gtts = require('../lib/gemini-tts');

const TTS_KEYS = ['tts_enabled', 'tts_api_key_enc', 'tts_model', 'tts_voice', 'tts_style', 'tts_daily_limit', 'ai_base_url', 'ai_api_key_enc'];
const TTS_MAX_CHARS = 600;
const TTS_DEFAULT_LIMIT = 500;
const CACHE_MAX = 200;
const GOOGLE_HOST = 'generativelanguage.googleapis.com';

let _cache = null; // { at, value } — ค่าตั้งค่า 60 วินาที
async function getTtsSettings({ fresh = false } = {}) {
    if (!fresh && _cache && Date.now() - _cache.at < 60000) return _cache.value;
    const [rows] = await db.query(
        `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${TTS_KEYS.map(() => '?').join(',')})`, TTS_KEYS);
    const s = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    const own = s.tts_api_key_enc ? safeDecrypt(s.tts_api_key_enc) : '';
    const aiIsGoogle = String(s.ai_base_url || '').includes(GOOGLE_HOST);
    const aiKey = !own && aiIsGoogle && s.ai_api_key_enc ? safeDecrypt(s.ai_api_key_enc) : '';
    const limit = parseInt(s.tts_daily_limit, 10);
    const value = {
        enabled: s.tts_enabled !== 'false',                 // ไม่มีค่า = เปิด (ทำงานเมื่อมีคีย์)
        api_key: own || aiKey,
        key_source: own ? 'own' : aiKey ? 'ai' : 'none',
        model: gtts.MODEL_RE.test(s.tts_model || '') ? s.tts_model : gtts.DEFAULT_MODEL,
        voice: gtts.VOICE_NAMES.has(s.tts_voice) ? s.tts_voice : gtts.DEFAULT_VOICE,
        style: typeof s.tts_style === 'string' && s.tts_style.trim() ? s.tts_style.trim() : gtts.DEFAULT_STYLE,
        daily_limit: Number.isFinite(limit) && limit > 0 ? limit : TTS_DEFAULT_LIMIT,
    };
    _cache = { at: Date.now(), value };
    return value;
}
function safeDecrypt(v) { try { return bkDecrypt(v) || ''; } catch (_) { return ''; } }
function invalidateTtsSettings() { _cache = null; }

/** ค่าที่ส่งให้หน้าจอ (ไม่มีคีย์) */
function publicSettings(s) {
    return {
        enabled: s.enabled, key_source: s.key_source, has_api_key: s.key_source === 'own',
        model: s.model, voice: s.voice, style: s.style, daily_limit: s.daily_limit,
        default_model: gtts.DEFAULT_MODEL, default_voice: gtts.DEFAULT_VOICE, default_style: gtts.DEFAULT_STYLE,
        voices: gtts.VOICES, max_chars: TTS_MAX_CHARS,
    };
}

async function saveSetting(key, value) {
    await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value]);
}

/** PUT /tts/settings — ตรวจค่าแล้วบันทึกเฉพาะที่ส่งมา (ผิด = throw TtsError 400) */
async function updateTtsSettings(b) {
    const set = [];
    if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean') throw new gtts.TtsError(400, 'enabled ต้องเป็น true/false', 'TTS_BAD_INPUT');
        set.push(['tts_enabled', b.enabled ? 'true' : 'false']);
    }
    if (b.model !== undefined) {
        if (!gtts.MODEL_RE.test(String(b.model))) throw new gtts.TtsError(400, 'ชื่อรุ่นไม่ถูกต้อง', 'TTS_BAD_INPUT');
        set.push(['tts_model', String(b.model)]);
    }
    if (b.voice !== undefined) {
        if (!gtts.VOICE_NAMES.has(b.voice)) throw new gtts.TtsError(400, 'ไม่รู้จักเสียงนี้', 'TTS_BAD_INPUT');
        set.push(['tts_voice', b.voice]);
    }
    if (b.style !== undefined) {
        const st = String(b.style || '').trim();
        if (st.length > 500) throw new gtts.TtsError(400, 'คำกำกับน้ำเสียงยาวเกิน 500 ตัวอักษร', 'TTS_BAD_INPUT');
        set.push(['tts_style', st]);
    }
    if (b.daily_limit !== undefined) {
        const n = Number(b.daily_limit);
        if (!Number.isInteger(n) || n < 1 || n > 100000) throw new gtts.TtsError(400, 'โควตารายวันต้องเป็น 1–100000', 'TTS_BAD_INPUT');
        set.push(['tts_daily_limit', String(n)]);
    }
    if (b.clear_api_key === true) set.push(['tts_api_key_enc', '']);
    else if (typeof b.api_key === 'string' && b.api_key.trim()) {
        const k = b.api_key.trim();
        if (k.length < 20 || k.length > 200 || /\s/.test(k)) throw new gtts.TtsError(400, 'รูปแบบคีย์ไม่ถูกต้อง', 'TTS_BAD_INPUT');
        set.push(['tts_api_key_enc', bkEncrypt(k)]);
    }
    for (const [k, v] of set) await saveSetting(k, v);
    invalidateTtsSettings();
    return set.map(([k]) => k);
}

const _audio = new Map(); // key → { audio, ms, e }
function cacheGet(k) { const v = _audio.get(k); if (v) { _audio.delete(k); _audio.set(k, v); } return v; }
function cachePut(k, v) { _audio.set(k, v); while (_audio.size > CACHE_MAX) _audio.delete(_audio.keys().next().value); }

async function usedToday() {
    const [[r]] = await db.query("SELECT COUNT(*) AS n FROM ai_usage_logs WHERE feature = 'tts' AND ok = 1 AND created_at >= CURDATE()");
    return Number(r.n) || 0;
}
async function logUsage(userId, model, ok, ms, err) {
    try {
        await db.query('INSERT INTO ai_usage_logs (user_id, feature, provider, model, ok, error_msg, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [userId || null, 'tts', 'gemini', model, ok ? 1 : 0, err ? String(err).slice(0, 500) : null, ms]);
    } catch (_) { /* ไม่ให้การบันทึกล้มทำให้เสียงล้ม */ }
}

/** ข้อความที่จะอ่าน (ช่องว่างซ้ำ/หัวท้าย) — ยาวเกิน = 400 */
function normText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) throw new gtts.TtsError(400, 'ไม่มีข้อความ', 'TTS_EMPTY');
    if (t.length > TTS_MAX_CHARS) throw new gtts.TtsError(400, `ข้อความยาวเกิน ${TTS_MAX_CHARS} ตัวอักษร`, 'TTS_TOO_LONG');
    return t;
}

/** สร้างเสียง → { audio: base64 WAV, mime, ms, e } | test = ข้ามสวิตช์/โควตา (ปุ่มทดสอบของ super_admin) */
async function speak({ text, userId, test = false, override = {}, fetchImpl }) {
    const t = normText(text);
    const s = await getTtsSettings();
    const cfg = { ...s, ...override };
    if (!test && !cfg.enabled) throw new gtts.TtsError(503, 'ปิดเสียงพูดแบบสดอยู่', 'TTS_DISABLED');
    if (!cfg.api_key) throw new gtts.TtsError(503, 'ยังไม่ได้ตั้งค่าคีย์ Gemini สำหรับเสียงพูด', 'TTS_NO_KEY');
    const key = crypto.createHash('sha1').update([cfg.model, cfg.voice, cfg.style, t].join('|')).digest('hex');
    const hit = !test && cacheGet(key);
    if (hit) return { ...hit, cached: true };
    if (!test && (await usedToday()) >= cfg.daily_limit) throw new gtts.TtsError(429, 'ใช้เสียงพูดครบโควตาของวันนี้แล้ว', 'TTS_QUOTA');
    const t0 = Date.now();
    try {
        const r = await gtts.synthesize({ apiKey: cfg.api_key, text: t, model: cfg.model, voice: cfg.voice, style: cfg.style, timeoutMs: 45000, fetchImpl });
        const out = { audio: r.wav.toString('base64'), mime: 'audio/wav', ms: r.ms, e: r.e };
        if (!test) cachePut(key, out);
        await logUsage(userId, cfg.model, true, Date.now() - t0, null);
        return out;
    } catch (e) {
        await logUsage(userId, cfg.model, false, Date.now() - t0, `${e.code || 'ERR'}: ${e.message}`);
        throw e;
    }
}

/** ส่งข้อผิดพลาด — ห้ามเป็น 401 (interceptor หน้าจอจะออกจากระบบ) */
function sendTtsError(res, e) {
    if (e instanceof gtts.TtsError) {
        const status = e.status === 401 || e.status === 403 ? 502 : e.status;
        return res.status(status).json({ success: false, code: e.code, message: e.message });
    }
    return res.status(500).json({ success: false, message: e.message });
}

module.exports = {
    getTtsSettings, invalidateTtsSettings, publicSettings, updateTtsSettings, speak, sendTtsError, normText, TTS_MAX_CHARS,
    _clearAudioCache: () => _audio.clear(),
};
