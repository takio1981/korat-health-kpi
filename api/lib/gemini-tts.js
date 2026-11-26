// เสียงพูดจาก Google Gemini TTS (26 พ.ย. 2569 — ผู้ใช้เลือก: เสียงน้องคิดดี / เสียงบรรยายวิดีโอคู่มือ / อ่านคำตอบ AI ใช้ Gemini TTS)
// ไม่มี dependency (fetch ของ Node 20+) — ใช้ร่วมกันระหว่าง backend (services/tts.js) และเครื่องมือสร้างไฟล์เสียง/วิดีโอ (tools/video-guide/lib/tts.js)
// API: Interactions (POST /v1beta/interactions) — รุ่นเก่า (*-preview-tts) ใช้ generateContent (responseModalities AUDIO)
// ส่งเฉพาะข้อความที่จะอ่าน + คำกำกับน้ำเสียง — ห้ามส่งข้อมูลส่วนบุคคล
'use strict';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.8-flash-tts';
// ผู้ใช้เลือก: ชายวัยหนุ่ม สดใส เป็นกันเอง — Puck (Upbeat, เสียงผู้ชาย)
const DEFAULT_VOICE = 'Puck';
const DEFAULT_STYLE = 'พูดภาษาไทยด้วยน้ำเสียงชายหนุ่มอารมณ์ดี สดใส เป็นกันเอง เหมือนเพื่อนร่วมงานที่กำลังอธิบายให้ฟังอย่างใจเย็น '
    + 'จังหวะเป็นธรรมชาติแบบคนพูดจริง เว้นวรรคตามความหมาย ออกเสียงชัดถ้อยชัดคำ ไม่เร่งรีบ';
// เสียงสำเร็จรูปของ Gemini (ชื่อ: ลักษณะ, เพศของเสียงโดยประมาณ) — ใช้แสดงตัวเลือกในหน้าตั้งค่า
const VOICES = [
    ['Puck', 'Upbeat', 'm'], ['Achird', 'Friendly', 'm'], ['Sadachbia', 'Lively', 'm'], ['Zubenelgenubi', 'Casual', 'm'],
    ['Fenrir', 'Excitable', 'm'], ['Iapetus', 'Clear', 'm'], ['Umbriel', 'Easy-going', 'm'], ['Algieba', 'Smooth', 'm'],
    ['Charon', 'Informative', 'm'], ['Orus', 'Firm', 'm'], ['Enceladus', 'Breathy', 'm'], ['Algenib', 'Gravelly', 'm'],
    ['Rasalgethi', 'Informative', 'm'], ['Alnilam', 'Firm', 'm'], ['Schedar', 'Even', 'm'], ['Sadaltager', 'Knowledgeable', 'm'],
    ['Zephyr', 'Bright', 'f'], ['Kore', 'Firm', 'f'], ['Leda', 'Youthful', 'f'], ['Aoede', 'Breezy', 'f'], ['Callirrhoe', 'Easy-going', 'f'],
    ['Autonoe', 'Bright', 'f'], ['Despina', 'Smooth', 'f'], ['Erinome', 'Clear', 'f'], ['Laomedeia', 'Upbeat', 'f'], ['Achernar', 'Soft', 'f'],
    ['Gacrux', 'Mature', 'f'], ['Pulcherrima', 'Forward', 'f'], ['Vindemiatrix', 'Gentle', 'f'], ['Sulafat', 'Warm', 'f'],
].map(([name, trait, gender]) => ({ name, trait, gender }));
const VOICE_NAMES = new Set(VOICES.map(v => v.name));
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{2,80}$/i;
const ENV_FPS = 25;

class TtsError extends Error {
    constructor(status, message, code, extra = {}) {
        super(message);
        this.status = status; this.code = code;
        Object.assign(this, extra);
    }
}

const isLegacyModel = (model) => /preview-tts$/i.test(model);

function interactionsBody(text, { model, voice, style }) {
    const item = { type: 'text', text };
    if (style) item.annotations = [{ type: 'speech_metadata', style }];
    return {
        model,
        input: [{ type: 'user_input', content: [item] }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice }] },
    };
}

function generateContentBody(text, { voice, style }) {
    return {
        contents: [{ parts: [{ text: style ? `${style}:\n${text}` : text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    };
}

/** หาข้อมูลเสียง base64 ในคำตอบ (Interactions: steps[].content[] type audio | generateContent: candidates[].content.parts[].inlineData) */
function findAudio(j) {
    if (!j || typeof j !== 'object') return null;
    if (j.output_audio && typeof j.output_audio.data === 'string') return { data: j.output_audio.data, mime: j.output_audio.mime_type || '' };
    for (const st of Array.isArray(j.steps) ? j.steps : []) {
        for (const c of Array.isArray(st && st.content) ? st.content : []) {
            if (c && c.type === 'audio' && typeof c.data === 'string' && c.data) return { data: c.data, mime: c.mime_type || '' };
        }
    }
    for (const cand of Array.isArray(j.candidates) ? j.candidates : []) {
        for (const p of (cand && cand.content && Array.isArray(cand.content.parts)) ? cand.content.parts : []) {
            const d = p && (p.inlineData || p.inline_data);
            if (d && typeof d.data === 'string' && d.data) return { data: d.data, mime: d.mimeType || d.mime_type || '' };
        }
    }
    return null;
}

/** อัตราสุ่มจาก mime เช่น audio/L16;codec=pcm;rate=24000 */
function rateOfMime(mime) {
    const m = /rate=(\d+)/i.exec(mime || '');
    return m ? Number(m[1]) : 24000;
}

/** WAV (RIFF) → { sampleRate, channels, pcm: Buffer 16-bit LE } | null ถ้าไม่ใช่ WAV */
function parseWav(buf) {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, sampleRate = 24000, channels = 1, bits = 16, pcm = null;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
        if (id === 'fmt ') { channels = buf.readUInt16LE(body + 2); sampleRate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
        if (id === 'data') { pcm = buf.subarray(body, Math.min(buf.length, body + (size || buf.length - body))); break; }
        off = body + size + (size % 2);
    }
    if (!pcm || bits !== 16) return null;
    return { sampleRate, channels, pcm };
}

function wavOf(pcm, sampleRate, channels = 1) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
    h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

/** ซองความดังราย 1/25 วินาที เป็นตัวเลข 0–9 (รูปแบบเดียวกับ index.json ของไฟล์เสียงน้องคิดดี) */
function envelopeDigits(pcm, sampleRate, channels = 1) {
    const n = Math.floor(pcm.length / 2 / channels), step = Math.max(1, Math.round(sampleRate / ENV_FPS)), out = [];
    for (let i = 0; i < n; i += step) {
        let e = 0, k = 0;
        for (let j = i; j < Math.min(i + step, n); j++, k++) { const v = pcm.readInt16LE(j * 2 * channels); e += v * v; }
        out.push(Math.sqrt(e / (k || 1)));
    }
    const peak = [...out].sort((a, b) => a - b)[Math.floor(out.length * 0.95)] || 1;
    return out.map(v => Math.round(Math.min(1, Math.pow(v / peak, 0.7)) * 9)).join('');
}

/** ตัดความเงียบหัว-ท้าย (คงไว้ 80 ms) — เสียงที่สร้างมักมีช่วงเงียบยาวท้ายประโยค */
function trimSilence(pcm, sampleRate, channels = 1, thresh = 300) {
    const n = Math.floor(pcm.length / 2 / channels), keep = Math.round(sampleRate * 0.08);
    let a = 0, b = n - 1;
    while (a < n && Math.abs(pcm.readInt16LE(a * 2 * channels)) < thresh) a++;
    while (b > a && Math.abs(pcm.readInt16LE(b * 2 * channels)) < thresh) b--;
    if (a >= b) return pcm;
    a = Math.max(0, a - keep); b = Math.min(n - 1, b + keep);
    return pcm.subarray(a * 2 * channels, (b + 1) * 2 * channels);
}

/** ข้อความผิดพลาดจากผู้ให้บริการ (ไม่มีคีย์) + เวลาที่ให้รอเมื่อเกินโควตา */
function upstreamInfo(j) {
    const err = j && j.error;
    const msg = err && typeof err.message === 'string' ? err.message.slice(0, 300) : '';
    let retryMs = 0;
    for (const d of (err && Array.isArray(err.details)) ? err.details : []) {
        const m = d && typeof d.retryDelay === 'string' && /^([\d.]+)s$/.exec(d.retryDelay);
        if (m) retryMs = Math.round(Number(m[1]) * 1000);
    }
    return { msg, retryMs };
}

/**
 * สังเคราะห์เสียง → { wav: Buffer, ms, e (ซองความดัง), sampleRate }
 * opts: { apiKey, text, model, voice, style, timeoutMs, fetchImpl, trim }
 */
async function synthesize(opts) {
    const apiKey = String(opts.apiKey || '');
    const text = String(opts.text || '').trim();
    const model = opts.model || DEFAULT_MODEL;
    const voice = opts.voice || DEFAULT_VOICE;
    const style = opts.style === undefined ? DEFAULT_STYLE : String(opts.style || '');
    const f = opts.fetchImpl || globalThis.fetch;
    if (!apiKey) throw new TtsError(503, 'ยังไม่ได้ตั้งค่าคีย์ Gemini สำหรับเสียงพูด', 'TTS_NO_KEY');
    if (!text) throw new TtsError(400, 'ไม่มีข้อความ', 'TTS_EMPTY');
    if (!MODEL_RE.test(model)) throw new TtsError(400, 'ชื่อรุ่นไม่ถูกต้อง', 'TTS_BAD_MODEL');
    const legacy = isLegacyModel(model);
    const url = legacy ? `${API_BASE}/models/${encodeURIComponent(model)}:generateContent` : `${API_BASE}/interactions`;
    const body = legacy ? generateContentBody(text, { voice, style }) : interactionsBody(text, { model, voice, style });
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000) : null;
    let res, j;
    try {
        res = await f(url, {
            method: 'POST', signal: ctrl ? ctrl.signal : undefined,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
        });
        j = await res.json().catch(() => null);
    } catch (e) {
        throw new TtsError(504, e && e.name === 'AbortError' ? 'สร้างเสียงไม่ทันเวลา' : 'เชื่อมต่อบริการเสียงไม่ได้', 'TTS_CONNECT');
    } finally { if (timer) clearTimeout(timer); }
    if (!res.ok) {
        const { msg, retryMs } = upstreamInfo(j);
        const code = res.status === 429 ? 'TTS_RATE_LIMIT' : res.status === 401 || res.status === 403 ? 'TTS_AUTH' : 'TTS_UPSTREAM';
        throw new TtsError(res.status === 429 ? 429 : 502, `บริการเสียงตอบ ${res.status}${msg ? ': ' + msg : ''}`, code, { upstreamStatus: res.status, retryMs });
    }
    const a = findAudio(j);
    if (!a) throw new TtsError(502, 'บริการเสียงไม่ได้ส่งเสียงกลับมา', 'TTS_EMPTY_AUDIO');
    const raw = Buffer.from(a.data, 'base64');
    let w = parseWav(raw);
    if (!w) w = { sampleRate: rateOfMime(a.mime), channels: 1, pcm: raw.subarray(0, raw.length - (raw.length % 2)) };
    const pcm = opts.trim === false ? w.pcm : trimSilence(w.pcm, w.sampleRate, w.channels);
    if (pcm.length < w.sampleRate / 5) throw new TtsError(502, 'เสียงสั้นผิดปกติ', 'TTS_EMPTY_AUDIO');
    return {
        wav: wavOf(pcm, w.sampleRate, w.channels),
        ms: Math.round((pcm.length / 2 / w.channels) / w.sampleRate * 1000),
        e: envelopeDigits(pcm, w.sampleRate, w.channels),
        sampleRate: w.sampleRate,
    };
}

module.exports = {
    synthesize, TtsError, DEFAULT_MODEL, DEFAULT_VOICE, DEFAULT_STYLE, VOICES, VOICE_NAMES, MODEL_RE, ENV_FPS,
    // สำหรับชุดทดสอบ
    _internal: { findAudio, parseWav, wavOf, envelopeDigits, trimSilence, interactionsBody, generateContentBody, isLegacyModel, upstreamInfo },
};
