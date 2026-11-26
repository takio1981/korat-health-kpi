// ตัวอย่างเสียง Gemini ให้ผู้ใช้เลือก (26 พ.ย. 2569) — node voice-samples.js [Puck,Achird,...]
// → cache/samples/<เสียง>.mp3 (ไม่อยู่ใน git) ประโยคเดียวกันทุกเสียง ใช้คำกำกับน้ำเสียงค่าตั้งต้น
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('./lib/tts'); // อ่าน .env
const gtts = require('../../api/lib/gemini-tts');
const FFMPEG = require('ffmpeg-static');

const TEXT = 'สวัสดีครับ ผมน้องคิดดี ผู้ช่วยประจำระบบบันทึกผลงานตัวชี้วัดครับ วันนี้ให้ผมแนะนำการบันทึกผลงานไหมครับ '
    + 'เริ่มจากเลือกปีงบประมาณ แล้วกดปุ่มแก้ไข พิมพ์ผลงานในเดือนที่ต้องการ ตรวจค่าให้ถูกต้อง แล้วกดบันทึกได้เลยครับ';
const voices = (process.argv[2] || 'Puck,Achird,Sadachbia,Zubenelgenubi').split(',');
const OUT = path.join(__dirname, 'cache', 'samples');

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    for (const v of voices) {
        const t = Date.now();
        try {
            const r = await gtts.synthesize({ apiKey: process.env.GEMINI_API_KEY, text: TEXT, voice: v, timeoutMs: 90000 });
            const wav = path.join(OUT, v + '.wav'), mp3 = path.join(OUT, v + '.mp3');
            fs.writeFileSync(wav, r.wav);
            execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', wav, '-b:a', '96k', mp3]);
            fs.unlinkSync(wav);
            console.log(`✓ ${v} ${(r.ms / 1000).toFixed(1)} วินาที (สร้าง ${((Date.now() - t) / 1000).toFixed(1)} วินาที) → ${mp3}`);
        } catch (e) {
            console.log(`✗ ${v}: ${e.code || ''} ${e.message}`);
            if (e.code === 'TTS_AUTH' || e.code === 'TTS_BAD_MODEL') break;
        }
    }
})();
