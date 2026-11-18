// สังเคราะห์เสียงบรรยายภาษาไทย (Microsoft Edge Neural) + แคชตามข้อความ — ส่งเฉพาะข้อความบรรยาย ไม่มีข้อมูลผู้ใช้
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const FFMPEG = require('ffmpeg-static');

const VOICES = {
    f: { id: 'th-TH-PremwadeeNeural', name: 'ผู้บรรยายหญิง' },
    m: { id: 'th-TH-NiwatNeural', name: 'ผู้บรรยายชาย' },
};
const CACHE = path.join(__dirname, '..', 'cache', 'tts');

function durationOf(file) {
    let out = '';
    try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { out = String(e.stderr || ''); }
    const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (!m) throw new Error('อ่านความยาวเสียงไม่ได้: ' + file);
    return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
}

async function synthOnce(voice, text, file) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, { rate: '-4%' });
    const chunks = [];
    await new Promise((res, rej) => { audioStream.on('data', d => chunks.push(d)); audioStream.on('end', res); audioStream.on('error', rej); });
    tts.close?.();
    const buf = Buffer.concat(chunks);
    if (buf.length < 2000) throw new Error('เสียงสั้นผิดปกติ');
    fs.writeFileSync(file, buf);
}

/** คืน { file, ms } — สร้างใหม่เฉพาะข้อความที่ยังไม่มีในแคช */
async function speech(voiceKey, text) {
    fs.mkdirSync(CACHE, { recursive: true });
    const v = VOICES[voiceKey].id;
    const file = path.join(CACHE, crypto.createHash('sha1').update(v + '|' + text).digest('hex').slice(0, 20) + '.mp3');
    if (!fs.existsSync(file)) {
        let err;
        for (let i = 0; i < 5; i++) {
            try { await synthOnce(v, text, file); err = null; break; } catch (e) { err = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
        }
        if (err) throw new Error('สังเคราะห์เสียงไม่สำเร็จ: ' + err.message);
    }
    return { file, ms: durationOf(file) };
}

module.exports = { VOICES, speech, FFMPEG };
