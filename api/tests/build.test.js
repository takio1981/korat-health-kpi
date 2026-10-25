/**
 * Build guard: ไฟล์ทุกตัวที่ server.js require แบบ local (ทุกชั้น รวม '../' ในโฟลเดอร์โมดูล) ต้องถูกคัดลอกโดย `npm run build`
 * Regression (7 ต.ค. 2569): เพิ่ม api/kpi-formula.js แต่ลืมใส่ใน build script → Docker image ไม่มีไฟล์นี้
 *   → container backend crash "Cannot find module './kpi-formula'" (unhealthy) ตอน deploy — tests อื่นรันจาก api/
 *   โดยตรงจึงไม่เจอ
 * (25 ต.ค. 2569) build ย้ายไป scripts/build.js — ไฟล์ราก = ROOT_FILES, โฟลเดอร์โมดูล = DIRS (คัดลอกทั้งโฟลเดอร์)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT_FILES, DIRS, build } = require('../scripts/build');

const apiDir = path.join(__dirname, '..');

function resolveLocal(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null; // require ที่อยู่ใน try/catch แบบ optional
}

function localRequires(file) {
    const src = fs.readFileSync(file, 'utf8');
    const out = new Set();
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const r = resolveLocal(file, m[1]);
        if (r) out.add(r);
    }
    return [...out];
}

function isBuilt(abs) {
    const rel = path.relative(apiDir, abs).split(path.sep).join('/');
    if (ROOT_FILES.includes(rel)) return true;
    return DIRS.some(d => rel.startsWith(d + '/'));
}

function reachableFromServer() {
    const seen = new Set();
    const queue = [path.join(apiDir, 'server.js')];
    while (queue.length) {
        const f = queue.shift();
        if (seen.has(f)) continue;
        seen.add(f);
        queue.push(...localRequires(f));
    }
    return [...seen];
}

test('ทุกไฟล์ที่ server.js require แบบ local (ทุกชั้น) อยู่ในชุดที่ build คัดลอก', () => {
    expect(ROOT_FILES).toContain('server.js');
    const missing = reachableFromServer().filter(f => !isBuilt(f)).map(f => path.relative(apiDir, f));
    expect(missing).toEqual([]);
});

test('build คัดลอกไฟล์ที่ require ถึงครบทุกตัวไปยังโฟลเดอร์ปลายทาง', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'khups-build-'));
    try {
        build(apiDir, out);
        const missing = reachableFromServer()
            .map(f => path.relative(apiDir, f))
            .filter(rel => !fs.existsSync(path.join(out, rel)));
        expect(missing).toEqual([]);
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});
