/**
 * ESLint (eslint.config.js) — ชื่อที่ไม่ได้ประกาศ (no-undef) / ประกาศซ้ำ ฯลฯ ต้องเป็นศูนย์
 * ย้ายโค้ดจาก server.js ไปโมดูลอื่นแล้วลืม require = ReferenceError เฉพาะตอนเส้นทางนั้นถูกเรียก — test นี้จับได้ก่อนรัน
 * Regression (25 ต.ค. 2569): baseline พบ `_thaidOtpMap` ใน POST /login ที่ไม่เคยถูกประกาศ (ส่ง thaid_otp = 500)
 * รัน ESLint ใน process แยก (ESLint 9 ใช้ dynamic import ซึ่ง Jest ไม่รองรับถ้าไม่เปิด --experimental-vm-modules)
 */
const path = require('path');
const { spawnSync } = require('child_process');

test('backend ไม่มี error จาก ESLint', () => {
    const apiDir = path.join(__dirname, '..');
    const bin = path.join(apiDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
    const r = spawnSync(process.execPath, [bin, '.', '--format', 'json'], { cwd: apiDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let results;
    try { results = JSON.parse(r.stdout); } catch (e) { throw new Error('ESLint ทำงานไม่สำเร็จ: ' + (r.stderr || r.stdout).slice(0, 2000)); }
    const errors = results.flatMap(f => f.messages.filter(m => m.severity === 2)
        .map(m => `${path.relative(apiDir, f.filePath)}:${m.line} ${m.ruleId} ${m.message}`));
    expect(errors).toEqual([]);
}, 120000);
