// ผู้ช่วย AI (7 พ.ย. 2569) — ชั้นเชื่อมต่อโมเดลภาษา ใช้ร่วมทุกฟีเจอร์ AI
// หลักการ: AI สรุป/เสนอแนะเท่านั้น ไม่บันทึกผลงาน ไม่อนุมัติ — ผลลัพธ์ทุกอย่างผ่านด่านเดิมของระบบ
// ผู้ให้บริการ 2 แบบ (ผู้ใช้เลือกให้รองรับทั้ง Claude API, โมเดลในเครื่อง และ API ฟรี):
//   anthropic = Claude API ผ่าน @anthropic-ai/sdk (ต้องใช้ Node 20+ — Dockerfile ใช้ node:22)
//   openai    = API แบบ OpenAI-compatible (/chat/completions) — Ollama ในเครื่อง, Groq, OpenRouter, Google Gemini (endpoint openai)
// ส่งเฉพาะตัวเลขรวม/ชื่อตัวชี้วัด/ข้อความคู่มือ — ห้ามส่งข้อมูลส่วนบุคคล (users, cid, บันทึกการเข้าสู่ระบบ) เข้า prompt
const db = require('../db');
const { bkEncrypt, bkDecrypt } = require('./backup');

const AI_SETTING_KEYS = ['ai_enabled', 'ai_provider', 'ai_base_url', 'ai_model', 'ai_daily_limit', 'ai_api_key_enc'];
const AI_PROVIDERS = ['anthropic', 'openai'];
const AI_DEFAULTS = { provider: 'anthropic', model: 'claude-opus-5-5', daily_limit: 200 };
const AI_TIMEOUT_MS = 90000;

class AiError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

async function getAiSettings() {
    const [rows] = await db.query(
        `SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (${AI_SETTING_KEYS.map(() => '?').join(',')})`,
        AI_SETTING_KEYS);
    const s = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    const limit = parseInt(s.ai_daily_limit, 10);
    return {
        enabled: s.ai_enabled === 'true',
        provider: AI_PROVIDERS.includes(s.ai_provider) ? s.ai_provider : AI_DEFAULTS.provider,
        base_url: s.ai_base_url || '',
        model: s.ai_model || (s.ai_provider === 'openai' ? '' : AI_DEFAULTS.model),
        daily_limit: Number.isFinite(limit) && limit > 0 ? limit : AI_DEFAULTS.daily_limit,
        api_key: s.ai_api_key_enc ? bkDecrypt(s.ai_api_key_enc) : '',
    };
}

async function saveAiSetting(key, value) {
    await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, value]);
}

const encryptApiKey = (key) => bkEncrypt(key);

async function usedToday() {
    const [[r]] = await db.query("SELECT COUNT(*) AS n FROM ai_usage_logs WHERE created_at >= CURDATE() AND feature <> 'test'");
    return Number(r.n || 0);
}

async function logUsage(row) {
    try {
        await db.query(
            `INSERT INTO ai_usage_logs (user_id, feature, provider, model, input_tokens, output_tokens, ok, error_msg, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [row.user_id || null, row.feature, row.provider, String(row.model || '').slice(0, 100), row.input_tokens || 0,
                row.output_tokens || 0, row.ok ? 1 : 0, row.error ? String(row.error).slice(0, 500) : null, row.ms || 0]);
    } catch (e) { console.error('[AI] log usage failed:', e.message); }
}

// effort / fallbacks ใช้ได้เฉพาะรุ่นใหม่ — รุ่นเก่าที่ผู้ดูแลเลือกเองจะ 400 ถ้าส่งไป
const supportsEffort = (m) => /^claude-(opus-5|sonnet-5|haiku-5|fable-5)/.test(m);
const supportsFallback = (m) => ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'].includes(m);

async function callAnthropic(cfg, { system, prompt, maxTokens }) {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!cfg.api_key) throw new AiError(400, 'ยังไม่ได้ตั้งค่า API key ของ Claude', 'AI_NO_KEY');
    const client = new Anthropic({ apiKey: cfg.api_key, timeout: AI_TIMEOUT_MS, maxRetries: 1 });
    const body = {
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
    };
    if (supportsEffort(cfg.model)) body.output_config = { effort: 'low' }; // งานสรุป/จัดรูปแบบ ไม่ต้องคิดลึก — ประหยัดค่าใช้จ่าย
    if (supportsFallback(cfg.model)) { body.betas = ['server-side-fallback-2026-07-01']; body.fallbacks = 'default'; }
    let resp;
    try {
        resp = await client.beta.messages.create(body);
    } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new AiError(502, 'API key ของ Claude ไม่ถูกต้องหรือหมดอายุ', 'AI_AUTH');
        if (e instanceof Anthropic.PermissionDeniedError) throw new AiError(502, 'บัญชี Claude ไม่มีสิทธิ์ใช้รุ่นนี้', 'AI_AUTH');
        if (e instanceof Anthropic.NotFoundError) throw new AiError(502, `ไม่พบรุ่นโมเดล "${cfg.model}"`, 'AI_MODEL');
        if (e instanceof Anthropic.RateLimitError) throw new AiError(429, 'ผู้ให้บริการ AI จำกัดจำนวนคำขอ กรุณาลองใหม่ภายหลัง', 'AI_UPSTREAM_LIMIT');
        if (e instanceof Anthropic.APIConnectionError) throw new AiError(504, 'เชื่อมต่อผู้ให้บริการ AI ไม่ได้ (เครือข่าย/หมดเวลา)', 'AI_CONNECT');
        if (e instanceof Anthropic.APIError) throw new AiError(502, `ผู้ให้บริการ AI ตอบกลับผิดพลาด (${e.status || '-'})`, 'AI_UPSTREAM');
        throw e;
    }
    if (resp.stop_reason === 'refusal') throw new AiError(422, 'AI ปฏิเสธคำขอนี้', 'AI_REFUSAL');
    const text = (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return { text, model: resp.model, input_tokens: resp.usage?.input_tokens || 0, output_tokens: resp.usage?.output_tokens || 0 };
}

async function callOpenAiCompatible(cfg, { system, prompt, maxTokens }) {
    const base = String(cfg.base_url || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new AiError(400, 'ยังไม่ได้ตั้งค่า Base URL ของผู้ให้บริการ AI', 'AI_NO_URL');
    if (!cfg.model) throw new AiError(400, 'ยังไม่ได้ระบุรุ่นโมเดล', 'AI_MODEL');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
    let r;
    try {
        r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: cfg.model,
                max_tokens: maxTokens,
                messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
            }),
            signal: AbortSignal.timeout(AI_TIMEOUT_MS),
        });
    } catch (e) {
        throw new AiError(504, 'เชื่อมต่อผู้ให้บริการ AI ไม่ได้ (เครือข่าย/หมดเวลา)', 'AI_CONNECT');
    }
    const json = await r.json().catch(() => null);
    if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new AiError(502, 'API key ของผู้ให้บริการ AI ไม่ถูกต้อง', 'AI_AUTH');
        if (r.status === 404) throw new AiError(502, `ไม่พบรุ่นโมเดล "${cfg.model}" หรือ Base URL ไม่ถูกต้อง`, 'AI_MODEL');
        if (r.status === 429) throw new AiError(429, 'ผู้ให้บริการ AI จำกัดจำนวนคำขอ (โควตาฟรีอาจหมด) กรุณาลองใหม่ภายหลัง', 'AI_UPSTREAM_LIMIT');
        throw new AiError(502, `ผู้ให้บริการ AI ตอบกลับผิดพลาด (${r.status})`, 'AI_UPSTREAM');
    }
    const text = String(json?.choices?.[0]?.message?.content || '').trim();
    return { text, model: json?.model || cfg.model, input_tokens: json?.usage?.prompt_tokens || 0, output_tokens: json?.usage?.completion_tokens || 0 };
}

// เรียกโมเดล 1 ครั้ง: ตรวจเปิดใช้งาน + โควตารายวัน → เรียกผู้ให้บริการ → บันทึก ai_usage_logs
// test = true: ปุ่ม "ทดสอบ" ของผู้ดูแล — ทำงานได้แม้ยังปิดอยู่ และไม่นับโควตา
async function callLlm({ feature, userId, system, prompt, maxTokens = 2000, test = false }) {
    const cfg = await getAiSettings();
    if (!test && !cfg.enabled) throw new AiError(503, 'ผู้ช่วย AI ยังไม่ได้เปิดใช้งาน (ตั้งค่าโดยผู้ดูแลระบบสูงสุด)', 'AI_DISABLED');
    if (!test && await usedToday() >= cfg.daily_limit) throw new AiError(429, `ใช้ผู้ช่วย AI ครบ ${cfg.daily_limit} ครั้งของวันนี้แล้ว`, 'AI_QUOTA');
    const t0 = Date.now();
    try {
        const out = cfg.provider === 'openai'
            ? await callOpenAiCompatible(cfg, { system, prompt, maxTokens })
            : await callAnthropic(cfg, { system, prompt, maxTokens });
        if (!out.text) throw new AiError(502, 'ผู้ให้บริการ AI ไม่ได้ส่งข้อความกลับมา', 'AI_EMPTY');
        await logUsage({ user_id: userId, feature: test ? 'test' : feature, provider: cfg.provider, model: out.model, input_tokens: out.input_tokens, output_tokens: out.output_tokens, ok: true, ms: Date.now() - t0 });
        return { ...out, provider: cfg.provider, ms: Date.now() - t0 };
    } catch (e) {
        await logUsage({ user_id: userId, feature: test ? 'test' : feature, provider: cfg.provider, model: cfg.model, ok: false, error: e.message, ms: Date.now() - t0 });
        throw e;
    }
}

// ===== รายชื่อรุ่นโมเดลจากผู้ให้บริการ (7 พ.ย. 2569 — ผู้ใช้ขอให้มีครบทุกรุ่น และอัปเดตได้เมื่อผู้ให้บริการออกรุ่นใหม่) =====
// ดึงจาก API ของผู้ให้บริการโดยตรง (ไม่เขียนรายชื่อตายตัว): Claude = Models API (client.models.list), OpenAI-compatible = GET {base}/models
// เก็บผลล่าสุดใน system_settings 'ai_models_cache' (แยกตามผู้ให้บริการ + Base URL) — หน้าจอแสดงทันทีโดยไม่ต้องเรียกผู้ให้บริการทุกครั้ง
const AI_MODELS_CACHE_KEY = 'ai_models_cache';
// รุ่นที่ไม่ใช่โมเดลสนทนา (ใช้กับ /chat/completions ไม่ได้) — ซ่อนจากรายการ แต่แจ้งจำนวนที่ซ่อน
const NON_CHAT_MODEL = /(embed|whisper|tts|transcri|speech|audio|imagen|image-gen|dall-e|veo|moderation|aqa|rerank|guard)/i;

const modelsCacheKey = (provider, baseUrl) => provider === 'anthropic' ? 'anthropic' : 'openai|' + String(baseUrl || '').trim().replace(/\/+$/, '').toLowerCase();

async function readModelsCache() {
    const [[r]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [AI_MODELS_CACHE_KEY]);
    try { return r?.setting_value ? JSON.parse(r.setting_value) : {}; } catch (_) { return {}; }
}

async function fetchAnthropicModels(apiKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!apiKey) throw new AiError(400, 'กรอก API key ของ Claude ก่อนดึงรายชื่อรุ่น', 'AI_NO_KEY');
    const client = new Anthropic({ apiKey, timeout: 30000, maxRetries: 1 });
    const out = [];
    try {
        for await (const m of client.models.list({ limit: 100 })) {
            out.push({ id: m.id, name: m.display_name || m.id, created: m.created_at || null, deprecated: !!m.deprecated_at });
        }
    } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new AiError(502, 'API key ของ Claude ไม่ถูกต้องหรือหมดอายุ', 'AI_AUTH');
        if (e instanceof Anthropic.APIConnectionError) throw new AiError(504, 'เชื่อมต่อผู้ให้บริการ AI ไม่ได้ (เครือข่าย/หมดเวลา)', 'AI_CONNECT');
        if (e instanceof Anthropic.APIError) throw new AiError(502, `ดึงรายชื่อรุ่นไม่สำเร็จ (${e.status || '-'})`, 'AI_UPSTREAM');
        throw e;
    }
    // ใหม่ → เก่า (Models API คืนตามวันออกรุ่นอยู่แล้ว — เรียงซ้ำกันไว้)
    out.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
    return { models: out, hidden: 0 };
}

async function fetchOpenAiModels(baseUrl, apiKey) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) throw new AiError(400, 'กรอก Base URL ก่อนดึงรายชื่อรุ่น', 'AI_NO_URL');
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let r;
    try {
        r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(30000) });
    } catch (e) {
        throw new AiError(504, 'เชื่อมต่อผู้ให้บริการ AI ไม่ได้ (เครือข่าย/หมดเวลา)', 'AI_CONNECT');
    }
    const json = await r.json().catch(() => null);
    if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new AiError(502, 'API key ของผู้ให้บริการ AI ไม่ถูกต้อง', 'AI_AUTH');
        throw new AiError(502, `ดึงรายชื่อรุ่นไม่สำเร็จ (${r.status})`, 'AI_UPSTREAM');
    }
    // { data: [...] } (OpenAI/ส่วนใหญ่) | { models: [...] } | [...] ตรงๆ (Together AI)
    const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    let hidden = 0;
    const seen = new Set();
    const models = [];
    for (const m of list) {
        // Gemini คืน "models/<รุ่น>" — ตัด prefix ให้ตรงกับชื่อที่ใช้ใน /chat/completions
        const id = String(m?.id || m?.name || '').replace(/^models\//, '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (NON_CHAT_MODEL.test(id)) { hidden++; continue; }
        // รุ่นฟรี: OpenRouter (ลงท้าย :free / pricing.prompt+completion = 0), Together AI (ลงท้าย -Free / pricing.input+output = 0) — 13 พ.ย. 2569
        const p = m.pricing || {};
        const zero = (a, b) => a !== undefined && a !== null && Number(a) === 0 && Number(b || 0) === 0;
        const free = /:free$/i.test(id) || /-free$/i.test(id) || zero(p.prompt, p.completion) || zero(p.input, p.output);
        models.push({ id, name: m.name && m.name !== m.id ? String(m.name) : id, created: m.created ? new Date(Number(m.created) * 1000).toISOString() : null, free: free || undefined });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return { models, hidden };
}

// refresh = false และมีผลเก็บไว้แล้ว → คืนผลเดิม | ไม่มี/refresh → ดึงจากผู้ให้บริการแล้วบันทึก
// apiKey ว่าง = ใช้ key ที่บันทึกไว้ (เฉพาะเมื่อผู้ให้บริการ/Base URL เดียวกับที่บันทึก — กันส่ง key ไปผิดที่)
async function listModels({ provider, base_url, api_key, refresh }) {
    if (!AI_PROVIDERS.includes(provider)) throw new AiError(400, 'ผู้ให้บริการ AI ไม่ถูกต้อง', 'AI_PROVIDER');
    const key = modelsCacheKey(provider, base_url);
    const cache = await readModelsCache();
    if (!refresh && cache[key]) return { ...cache[key], cached: true };
    let apiKey = String(api_key || '').trim();
    if (!apiKey) {
        const saved = await getAiSettings();
        if (saved.api_key && modelsCacheKey(saved.provider, saved.base_url) === key) apiKey = saved.api_key;
    }
    const res = provider === 'anthropic' ? await fetchAnthropicModels(apiKey) : await fetchOpenAiModels(base_url, apiKey);
    const entry = { fetched_at: new Date().toISOString(), models: res.models, hidden: res.hidden };
    cache[key] = entry;
    await saveAiSetting(AI_MODELS_CACHE_KEY, JSON.stringify(cache));
    return { ...entry, cached: false };
}

// ดึง JSON ก้อนแรกจากข้อความของโมเดล (บางรุ่นห่อด้วย ```json … ``` หรือมีคำนำหน้า)
function extractJson(text) {
    const s = String(text || '');
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : s;
    const start = body.search(/[[{]/);
    if (start < 0) return null;
    const open = body[start], close = open === '{' ? '}' : ']';
    const end = body.lastIndexOf(close);
    if (end <= start) return null;
    try { return JSON.parse(body.slice(start, end + 1)); } catch (_) { return null; }
}

// ส่งข้อผิดพลาดของ AI กลับเป็น HTTP — ไม่ใช้ 401 (interceptor ฝั่งหน้าจอถือว่า 401 = หมดสิทธิ์เข้าสู่ระบบ)
function sendAiError(res, e, fallbackMsg) {
    if (e instanceof AiError) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
    console.error('[AI]', e);
    return res.status(500).json({ success: false, message: fallbackMsg || 'ผู้ช่วย AI ทำงานผิดพลาด' });
}

// แคชผลลัพธ์ในหน่วยความจำ (คำขอเดียวกันภายใน ttl ไม่เรียกโมเดลซ้ำ — ประหยัดโควตา/ค่าใช้จ่าย)
function createAiCache(ttlMs = 60 * 60 * 1000, max = 200) {
    const m = new Map();
    return {
        get(k) { const v = m.get(k); if (!v) return null; if (Date.now() - v.at > ttlMs) { m.delete(k); return null; } return v.value; },
        set(k, value) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { at: Date.now(), value }); },
        clear() { m.clear(); },
    };
}

module.exports = {
    AI_SETTING_KEYS, AI_PROVIDERS, AI_DEFAULTS, AiError, getAiSettings, saveAiSetting, encryptApiKey, usedToday,
    callLlm, extractJson, sendAiError, createAiCache, listModels, AI_MODELS_CACHE_KEY, NON_CHAT_MODEL,
};
