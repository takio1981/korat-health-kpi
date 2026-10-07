/**
 * Build guard: ไฟล์ทุกตัวที่ server.js require แบบ local ('./xxx') ต้องอยู่ในรายการ copy ของ `npm run build`
 * Regression (7 ต.ค. 2569): เพิ่ม api/kpi-formula.js แต่ลืมใส่ใน build script → Docker image ไม่มีไฟล์นี้
 *   → container backend crash "Cannot find module './kpi-formula'" (unhealthy) ตอน deploy — tests อื่นรันจาก api/
 *   โดยตรงจึงไม่เจอ
 */
const fs = require('fs');
const path = require('path');

const apiDir = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(apiDir, 'package.json'), 'utf8'));

function buildFileList() {
    const m = pkg.scripts.build.match(/\[([^\]]+)\]\.forEach/);
    if (!m) throw new Error('หา file list ใน build script ไม่เจอ — รูปแบบ script เปลี่ยน ต้องแก้ test นี้ด้วย');
    return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
}

function localRequires(file) {
    const src = fs.readFileSync(path.join(apiDir, file), 'utf8');
    const out = new Set();
    for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
        out.add(m[1].endsWith('.js') ? m[1] : m[1] + '.js');
    }
    return [...out];
}

test('ทุกไฟล์ที่ server.js (และไฟล์ที่ถูก build) require แบบ local อยู่ใน build script', () => {
    const built = buildFileList();
    expect(built).toContain('server.js');
    const missing = [];
    const seen = new Set();
    const queue = ['server.js'];
    while (queue.length) {
        const f = queue.shift();
        if (seen.has(f)) continue;
        seen.add(f);
        for (const dep of localRequires(f)) {
            if (!fs.existsSync(path.join(apiDir, dep))) continue; // require ที่อยู่ใน try/catch แบบ optional
            if (!built.includes(dep)) missing.push(`${f} → ${dep}`);
            queue.push(dep);
        }
    }
    expect(missing).toEqual([]);
});
