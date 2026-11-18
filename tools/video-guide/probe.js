// สำรวจปุ่ม/แท็บ/ช่องกรอกในหน้า (ใช้ตอนเขียนสคริปต์วิดีโอ) — node probe.js <role> <path> [ข้อความปุ่มที่จะกดก่อน]
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { PASSWORD } = require('./setup-data');
const { resetSessions } = require('./lib/db');

(async () => {
    const [role, p, ...clicks] = process.argv.slice(2);
    await resetSessions('test_vg_' + role);
    const browser = await launch();
    const state = await loginState(browser, 'test_vg_' + role, PASSWORD);
    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: state });
    await guardContext(ctx);
    const page = await ctx.newPage();
    await page.goto(FE + p); await page.waitForTimeout(3500); await closeSwal(page);
    for (const t of clicks) { await page.locator('button:visible', { hasText: t }).first().click().catch(e => console.log('click fail', t)); await page.waitForTimeout(2500); await closeSwal(page); }
    const items = await page.evaluate(() => [...document.querySelectorAll('button, a, input, select, [role=tab]')].filter(e => {
        const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    }).map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} [${Math.round(e.getBoundingClientRect().x)},${Math.round(e.getBoundingClientRect().y)}] ${(e.innerText || e.placeholder || e.value || e.title || '').replace(/\s+/g, ' ').trim().slice(0, 50)}`));
    console.log(items.join('\n'));
    const out = path.join(__dirname, 'cache', 'probe.png'); fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
