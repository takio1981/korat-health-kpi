/**
 * Build ของ backend: คัดลอกโค้ดไป dist/ (Docker คัดลอกเฉพาะ dist/ — api/Dockerfile)
 * - ROOT_FILES: ไฟล์ในราก api/ ที่ระบบใช้ตอนรัน
 * - DIRS: โฟลเดอร์โมดูล (คัดลอกทั้งโฟลเดอร์ทุกชั้น) — เพิ่มไฟล์ใหม่ในโฟลเดอร์เหล่านี้ไม่ต้องแก้สคริปต์นี้
 * ⚠️ เพิ่มไฟล์ใหม่ในราก api/ ที่ถูก require → ต้องเพิ่มใน ROOT_FILES (tests/build.test.js ตรวจให้)
 */
const fs = require('fs');
const path = require('path');

const ROOT_FILES = ['server.js', 'db.js', 'db-remote.js', 'kpi-formula.js', 'kpi-rollup.js', 'khd-mapping.js', 'kpi-target.js'];
const DIRS = ['core', 'lib', 'migrations', 'services', 'routes', 'jobs'];

function build(apiDir = path.join(__dirname, '..'), outDir = path.join(apiDir, 'dist')) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of ROOT_FILES) fs.copyFileSync(path.join(apiDir, f), path.join(outDir, f));
    for (const d of DIRS) {
        const src = path.join(apiDir, d);
        const dst = path.join(outDir, d);
        fs.rmSync(dst, { recursive: true, force: true }); // กันไฟล์เก่าที่ลบ/ย้ายแล้วค้างใน dist
        if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
    }
}

module.exports = { ROOT_FILES, DIRS, build };

if (require.main === module) {
    build();
    console.log('API build complete');
}
