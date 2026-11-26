// เสียงบรรยายภาษาไทย + ซองความดังสำหรับขยับปากน้องคิดดี + แคชตามข้อความ
// 26 พ.ย. 2569 ผู้ใช้เลือก Google Gemini TTS (ชายวัยหนุ่ม สดใส เป็นกันเอง — api/lib/gemini-tts.js ตัวเดียวกับ backend)
//   คีย์: ตัวแปร GEMINI_API_KEY หรือไฟล์ tools/video-guide/.env (gitignore แล้ว) | VG_TTS=edge = เสียงเดิม th-TH-NiwatNeural (Microsoft Edge)
//   ไม่มีคีย์ = ใช้เสียง Edge (แจ้งเตือน) | ตั้งเสียง/รุ่น/คำกำกับได้ด้วย VG_TTS_VOICE / VG_TTS_MODEL / VG_TTS_STYLE / VG_TTS_RPM
//   ค่าเสียงอยู่ในคีย์แคช — เปลี่ยนเสียง = สร้างใหม่ทั้งหมด (ไฟล์เดิมยังอยู่ในแคช สลับกลับได้)
// ส่งเฉพาะข้อความบรรยายไปสังเคราะห์เสียง ไม่มีข้อมูลผู้ใช้
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const FFMPEG = require('ffmpeg-static');
const gtts = require('../../../api/lib/gemini-tts');

// อ่าน .env ของเครื่องมือ (ไม่ใช้ dotenv — ไม่อยู่ใน dependency ของเครื่องมือ) — ค่าในตัวแปรแวดล้อมมาก่อน
(function loadEnv() {
    const f = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(f)) return;
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        if (line.trim().startsWith('#')) continue;
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
})();
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
if (process.env.VG_TTS === 'gemini' && !GEMINI_KEY) throw new Error('VG_TTS=gemini แต่ไม่มี GEMINI_API_KEY (ใส่ในไฟล์ tools/video-guide/.env)');
const PROVIDER = process.env.VG_TTS === 'edge' || !GEMINI_KEY ? 'edge' : 'gemini';
if (PROVIDER === 'edge' && process.env.VG_TTS !== 'edge') console.warn('⚠ ไม่มี GEMINI_API_KEY — ใช้เสียง Microsoft Edge (th-TH-NiwatNeural) แทน Gemini');

const VOICE = PROVIDER === 'gemini'
    ? { provider: 'gemini', model: process.env.VG_TTS_MODEL || gtts.DEFAULT_MODEL, voice: process.env.VG_TTS_VOICE || gtts.DEFAULT_VOICE, style: process.env.VG_TTS_STYLE || gtts.DEFAULT_STYLE }
    : { id: 'th-TH-NiwatNeural', rate: '-4%' };
const CACHE = path.join(__dirname, '..', 'cache', 'tts-narrator');
const ENV_FPS = 25;
const MIN_GAP_MS = Math.round(60000 / Math.max(1, Number(process.env.VG_TTS_RPM) || 8)); // เว้นระยะคำขอตามโควตาต่อนาทีของ Gemini
let lastCall = 0;

function durationOf(file) {
    let out = '';
    try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = String(e.stderr || ''); }
    const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (!m) throw new Error('อ่านความยาวเสียงไม่ได้: ' + file);
    return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
}

async function synthGemini(text, file) {
    for (let attempt = 0; ; attempt++) {
        const wait = lastCall + MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastCall = Date.now();
        try {
            const r = await gtts.synthesize({ apiKey: GEMINI_KEY, text, model: VOICE.model, voice: VOICE.voice, style: VOICE.style, timeoutMs: 90000 });
            const wav = file.replace(/\.mp3$/, '.wav');
            fs.writeFileSync(wav, r.wav);
            execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', wav, '-ac', '1', '-ar', '24000', '-b:a', '96k', file]);
            fs.unlinkSync(wav);
            return;
        } catch (e) {
            // เกินโควตา = รอตามที่บริการบอก (หรือ 30 วินาที) แล้วลองใหม่ — คีย์ผิด/รุ่นผิด = หยุดทันที (ไม่ลองซ้ำ)
            if (e.code === 'TTS_RATE_LIMIT' && attempt < 60) {
                const ms = Math.max(e.retryMs || 0, 30000);
                console.log(`    ⏳ โควตา Gemini เต็ม รอ ${Math.round(ms / 1000)} วินาที`);
                await new Promise(r => setTimeout(r, ms));
                continue;
            }
            if (e.code === 'TTS_AUTH' || e.code === 'TTS_BAD_MODEL') e.fatal = true;
            throw e;
        }
    }
}

async function synthEdge(text, file) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE.id, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: VOICE.rate });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', d => chunks.push(d)); audioStream.on('end', res); audioStream.on('error', rej); });
    tts.close?.();
    const buf = Buffer.concat(chunks);
    if (buf.length < 2000) throw new Error('เสียงสั้นผิดปกติ');
    fs.writeFileSync(file, buf);
}

const synthOnce = (text, file) => (PROVIDER === 'gemini' ? synthGemini(text, file) : synthEdge(text, file));

/** ความดังราย 1/25 วินาที (0..1) สำหรับขยับปาก */
function envelopeOf(file) {
    const pcm = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 1 << 28 });
    const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1), step = 16000 / ENV_FPS, out = [];
    for (let i = 0; i < s.length; i += step) {
        let e = 0, n = 0;
        for (let j = i; j < Math.min(i + step, s.length); j++, n++) e += s[j] * s[j];
        out.push(Math.sqrt(e / (n || 1)));
    }
    const peak = [...out].sort((a, b) => a - b)[Math.floor(out.length * 0.95)] || 1;
    return out.map(v => Math.round(Math.min(1, Math.pow(v / peak, 0.7)) * 100) / 100);
}

/** คืน { file, ms, env } — สร้างใหม่เฉพาะข้อความที่ยังไม่มีในแคช */
async function speech(text) {
    fs.mkdirSync(CACHE, { recursive: true });
    const base = path.join(CACHE, crypto.createHash('sha1').update(JSON.stringify(VOICE) + '|' + text).digest('hex').slice(0, 20));
    const file = base + '.mp3', envFile = base + '.json';
    if (!fs.existsSync(file)) {
        let err;
        for (let i = 0; i < 5; i++) {
            try { await synthOnce(text, file); err = null; break; } catch (e) { err = e; if (e.fatal) break; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
        }
        if (err) throw new Error('สังเคราะห์เสียงไม่สำเร็จ: ' + err.message);
    }
    if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, JSON.stringify(envelopeOf(file)));
    return { file, ms: durationOf(file), env: JSON.parse(fs.readFileSync(envFile, 'utf8')) };
}

module.exports = { VOICE, PROVIDER, ENV_FPS, speech, FFMPEG };
