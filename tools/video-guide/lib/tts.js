// เสียงบรรยายภาษาไทย (th-TH-NiwatNeural เสียงผู้ชายตามเดิม — ผู้ใช้ทดลองฟังเสียงเด็กที่แปลงแล้วและเลือกกลับมาใช้เสียงนี้ 19 พ.ย. 2569)
// + ซองความดังสำหรับขยับปากน้องโคราชดี + แคชตามข้อความ
// ส่งเฉพาะข้อความบรรยายไปสังเคราะห์เสียง ไม่มีข้อมูลผู้ใช้
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const FFMPEG = require('ffmpeg-static');

const VOICE = { id: 'th-TH-NiwatNeural', rate: '-4%' };
const CACHE = path.join(__dirname, '..', 'cache', 'tts-narrator');
const ENV_FPS = 25;

function durationOf(file) {
    let out = '';
    try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = String(e.stderr || ''); }
    const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (!m) throw new Error('อ่านความยาวเสียงไม่ได้: ' + file);
    return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
}

async function synthOnce(text, file) {
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
            try { await synthOnce(text, file); err = null; break; } catch (e) { err = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
        }
        if (err) throw new Error('สังเคราะห์เสียงไม่สำเร็จ: ' + err.message);
    }
    if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, JSON.stringify(envelopeOf(file)));
    return { file, ms: durationOf(file), env: JSON.parse(fs.readFileSync(envFile, 'utf8')) };
}

module.exports = { VOICE, ENV_FPS, speech, FFMPEG };
