/**
 * สร้างไฟล์เสียงพูดของน้องคิดดี (20 พ.ย. 2569) — node build-mascot-voice.js
 * อ่านทุกประโยคจาก frontend/src/app/shared/mascot/mascot-voice-phrases.ts (collectVoicePhrases)
 * → เสียง th-TH-NiwatNeural (lib/tts.js ตัวเดียวกับวิดีโอคู่มือ — ส่งเฉพาะข้อความบทพูด ไม่มีข้อมูลผู้ใช้)
 * → แปลงเป็น mp3 ขนาดเล็ก frontend/public/mascot/voice/<key>.mp3 + index.json { key: { f, ms, e } } (e = ซองความดัง 0-9 ราย 1/25 วินาที)
 * ลบไฟล์ของประโยคที่ไม่ใช้แล้ว — แคชเสียงต้นฉบับอยู่ใน cache/tts-narrator (สร้างใหม่เฉพาะข้อความที่เปลี่ยน)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { speech, FFMPEG, PROVIDER, VOICE } = require('./lib/tts');

const ROOT = path.resolve(__dirname, '../..');
const FE = path.join(ROOT, 'frontend');
const OUT = path.join(FE, 'public', 'mascot', 'voice');

async function main() {
    const esbuild = require(path.join(FE, 'node_modules', 'esbuild'));
    const tmp = path.join(os.tmpdir(), 'mascot-voice-phrases-' + process.pid + '.cjs');
    esbuild.buildSync({ entryPoints: [path.join(FE, 'src/app/shared/mascot/mascot-voice-phrases.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: tmp, logLevel: 'warning' });
    const { collectVoicePhrases, voiceKey, speakable } = require(tmp);
    fs.unlinkSync(tmp);

    const phrases = collectVoicePhrases();
    fs.mkdirSync(OUT, { recursive: true });
    let old = {};
    try { old = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')); } catch { /* ยังไม่มีดัชนี */ }
    console.log('เสียง: ' + (PROVIDER === 'gemini' ? `Google Gemini ${VOICE.model} / ${VOICE.voice}` : 'Microsoft Edge ' + VOICE.id));
    const index = {};
    let made = 0, i = 0;
    for (const p of phrases) {
        i++;
        const key = voiceKey(p), file = key + '.mp3', dest = path.join(OUT, file);
        const clip = await speech(speakable(p));
        // s = ไฟล์เสียงต้นฉบับในแคช (ขึ้นกับข้อความ + ค่าเสียง) — เปลี่ยนเสียง/ผู้ให้บริการ = แปลงไฟล์ใหม่ทับชื่อเดิม (26 พ.ย. 2569)
        const src = path.basename(clip.file, '.mp3');
        if (!fs.existsSync(dest) || (old[key] && old[key].s !== src)) {
            execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', clip.file, '-ac', '1', '-ar', '24000', '-b:a', '40k', dest]);
            made++;
        }
        index[key] = { f: file, s: src, ms: Math.round(clip.ms), e: clip.env.map(v => Math.round(Math.max(0, Math.min(1, v)) * 9)).join('') };
        if (i % 25 === 0) console.log(`  ${i}/${phrases.length}`);
    }
    let removed = 0;
    for (const f of fs.readdirSync(OUT)) {
        if (f.endsWith('.mp3') && !index[f.slice(0, -4)]) { fs.unlinkSync(path.join(OUT, f)); removed++; }
    }
    const sorted = Object.fromEntries(Object.keys(index).sort().map(k => [k, index[k]]));
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(sorted) + '\n');
    const size = fs.readdirSync(OUT).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
    console.log(`เสียงน้องคิดดี: ${phrases.length} ประโยค | สร้างใหม่ ${made} | ลบ ${removed} | รวม ${(size / 1048576).toFixed(2)} MB`);
}

main().catch(e => { console.error(e); process.exit(1); });
