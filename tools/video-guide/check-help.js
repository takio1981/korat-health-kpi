// ตรวจหน้าคู่มือกับวิดีโอจริง: เสิร์ฟ /khupskpi/videos/* จากโฟลเดอร์ videos/ (แทน nginx) แล้วเปิด /help ตามสิทธิ์
// node check-help.js <role> → cache/help-<role>.png + ตรวจว่าปุ่มทุกหัวข้อชี้ไฟล์ที่มีอยู่จริง
const fs = require('fs');
const path = require('path');
const { FE, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { PASSWORD } = require('./setup-data');
const { resetSessions } = require('./lib/db');
const { OUT } = require('./lib/engine');

(async () => {
    const role = process.argv[2] || 'user_hos';
    await resetSessions('test_vg_' + role);
    const browser = await launch();
    const state = await loginState(browser, 'test_vg_' + role, PASSWORD);
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'th-TH', storageState: state });
    await guardContext(ctx);
    await ctx.route('**/khupskpi/videos/**', (route) => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/khupskpi\/videos\//, ''));
        const f = path.join(OUT, rel);
        if (!f.startsWith(OUT) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: 'not found' });
        return route.fulfill({ status: 200, contentType: f.endsWith('.json') ? 'application/json' : 'video/mp4', body: fs.readFileSync(f) });
    });
    const page = await ctx.newPage();
    await page.goto(FE + '/help'); await page.waitForTimeout(4000); await closeSwal(page);
    const boxes = await page.evaluate(() => [...document.querySelectorAll('app-help-video')].map(e => ({ section: e.getAttribute('section'), shown: !!e.querySelector('.help-video'), title: (e.querySelector('.help-video span span') || {}).textContent || '' })));
    const list = await page.locator('app-help-video-list button').count();
    console.log('สิทธิ์', role, '| ปุ่มในรายการด้านบน', list, '| หัวข้อที่มีปุ่มวิดีโอ', boxes.filter(b => b.shown).map(b => b.section).join(','));
    await page.screenshot({ path: path.join(__dirname, 'cache', `help-${role}.png`) });
    // เล่นวิดีโอหัวข้อบันทึกผลงานจากรายการด้านบน
    await page.locator('app-help-video-list button', { hasText: 'บันทึกผลงานตัวชี้วัด' }).first().click();
    await page.waitForTimeout(3000);
    const v = await page.evaluate(() => { const el = document.querySelector('#section-dashboard video'); return el ? { src: el.getAttribute('src'), dur: el.duration, err: el.error && el.error.code } : null; });
    console.log('เล่นวิดีโอหัวข้อบันทึกผลงาน:', JSON.stringify(v));
    await page.screenshot({ path: path.join(__dirname, 'cache', `help-${role}-play.png`) });
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
