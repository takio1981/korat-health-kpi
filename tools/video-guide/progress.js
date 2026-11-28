// แถบความคืบหน้าการถ่ายวิดีโอคู่มือ — node progress.js [ไฟล์ log] [--watch] [--total=N]
// นับคลิปที่เสร็จ (✓) / ล้มเหลว (✗) จาก log ของ run.js — ค่าตั้งต้น: redo-all.log, จำนวนทั้งหมด = คลิปใน videos-next-old/
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const logFile = path.resolve(__dirname, args.find(a => !a.startsWith('--')) || 'redo-all.log');
const watch = args.includes('--watch');
const totalArg = Number((args.find(a => a.startsWith('--total=')) || '').split('=')[1]);

function countMp4(dir) {
    let n = 0;
    if (!fs.existsSync(dir)) return 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) n += countMp4(path.join(dir, e.name));
        else if (e.name.endsWith('.mp4')) n++;
    }
    return n;
}
const total = totalArg || countMp4(path.join(__dirname, '..', '..', 'videos-next-old')) || 1;
const fmt = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} ชม. ${m % 60} นาที` : `${m} นาที`; };

function render() {
    if (!fs.existsSync(logFile)) return `ไม่พบไฟล์ ${logFile}`;
    const text = fs.readFileSync(logFile, 'utf8');
    const ok = (text.match(/^\s+✓/gm) || []).length;
    const fail = (text.match(/^\s+✗/gm) || []).length;
    const warn = (text.match(/✓.*⚠/g) || []).length;
    const current = ((text.match(/^▶ (.+)$/gm) || []).pop() || '').slice(2);
    const done = ok + fail;
    const pct = Math.min(100, (done / total) * 100);
    const width = 30;
    const filled = Math.round((pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const st = fs.statSync(logFile);
    const finished = done >= total;
    const start = st.birthtimeMs || st.ctimeMs;
    const elapsed = (finished ? st.mtimeMs : Date.now()) - start;
    const eta = done ? ((st.mtimeMs - start) / done) * (total - done) : 0;
    return [
        `[${bar}] ${pct.toFixed(1)}%  ${done}/${total} คลิป`,
        `สำเร็จ ${ok} · ล้มเหลว ${fail} · มีคำเตือน ${warn}`,
        finished ? 'ถ่ายครบแล้ว' : `กำลังถ่าย: ${current || '-'}`,
        `ใช้เวลาแล้ว ${fmt(elapsed)}${!finished && done ? ` · เหลืออีกราว ${fmt(eta)}` : ''}`,
    ].join('\n');
}

if (!watch) console.log(render());
else {
    const tick = () => { process.stdout.write('\x1b[2J\x1b[H' + render() + '\n\n(Ctrl+C เพื่อออก)\n'); };
    tick();
    setInterval(tick, 5000);
}
