// สำรวจทุกหน้าด้วยบัญชีเดียว — node probe-all.js <role> <path,path,...> → cache/probe/<ชื่อ>.txt + .png
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { PASSWORD } = require('./setup-data');
const { resetSessions } = require('./lib/db');

(async () => {
    const [role, list] = process.argv.slice(2);
    await resetSessions('test_vg_' + role);
    const browser = await launch();
    const state = await loginState(browser, 'test_vg_' + role, PASSWORD);
    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: state });
    await guardContext(ctx);
    const page = await ctx.newPage();
    const dir = path.join(__dirname, 'cache', 'probe'); fs.mkdirSync(dir, { recursive: true });
    for (const p of list.split(',')) {
        await page.goto(FE + p); await page.waitForTimeout(3500); await closeSwal(page);
        const items = await page.evaluate(() => {
            const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const els = [...document.querySelectorAll('main button, main a, main input, main select, main textarea, main h1, main h2, main h3, main label, main [role=tab]')].filter(vis);
            return els.map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.title ? '[title=' + e.title + ']' : ''} [${Math.round(e.getBoundingClientRect().x)},${Math.round(e.getBoundingClientRect().y)}] ${(e.innerText || e.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 60)}`);
        });
        const name = p.replace(/\//g, '_') || 'root';
        fs.writeFileSync(path.join(dir, name + '.txt'), page.url() + '\n' + items.join('\n'));
        await page.screenshot({ path: path.join(dir, name + '.png') });
        console.log(p, items.length);
    }
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
