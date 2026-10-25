/**
 * Smoke test การเริ่มระบบ (25 ต.ค. 2569 — ตาข่ายกันพังของการแยก server.js เป็นโมดูล)
 * 1) โหลด server + migration ตอน startup เสร็จ + endpoint สาธารณะตอบได้
 * 2) ผลลัพธ์ของ `npm run build` (สิ่งที่ Docker คัดลอกจริง) โหลดได้ครบทุกโมดูลใน process แยก
 *    — กันกรณีไฟล์ที่ย้ายไปโฟลเดอร์ใหม่ไม่ถูกคัดลอก (container crash "Cannot find module" ทั้งที่ test อื่นผ่าน)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const { build } = require('../scripts/build');

const { app, migrationsReady } = require('../server');

beforeAll(async () => { await migrationsReady; }, 120000);

test('endpoint สาธารณะตอบได้หลังเริ่มระบบ', async () => {
    const s = await request(app).get('/khupskpi/api/status');
    expect(s.status).toBe(200);
    const m = await request(app).get('/khupskpi/api/system/maintenance-status');
    expect(m.status).toBe(200);
    expect(m.body).toHaveProperty('success', true);
});

test('ผลลัพธ์ build โหลดได้ครบทุกโมดูล', () => {
    const apiDir = path.join(__dirname, '..');
    const out = path.join(apiDir, '.build-check'); // อยู่ใต้ api/ เพื่อให้หา node_modules เจอเหมือนใน Docker
    try {
        build(apiDir, out);
        const script = "process.env.NODE_ENV='test';const s=require('./.build-check/server');" +
            "s.migrationsReady.then(()=>{console.log('LOADED '+Object.keys(s).length);process.exit(0)},e=>{console.error(e);process.exit(1)})";
        const stdout = execFileSync(process.execPath, ['-e', script], { cwd: apiDir, env: process.env, encoding: 'utf8', timeout: 110000 });
        expect(stdout).toMatch(/LOADED \d+/);
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
}, 120000);
