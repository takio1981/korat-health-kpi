// เบราว์เซอร์ + การเข้าสู่ระบบสำหรับถ่ายวิดีโอ (frontend :4520 → backend ทดสอบ :3710)
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('C:/Users/ampir/AppData/Roaming/npm/node_modules/openclaw/node_modules/playwright-core')); }

const FE = process.env.VG_FE || 'http://localhost:4520/khupskpi';
const BE_PORT = process.env.VG_BE_PORT || '3710';
const EXE = process.env.VG_CHROME || path.join(process.env.USERPROFILE || '', 'AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe');
const VIEW = { width: 1280, height: 720 };

async function launch() {
    return chromium.launch({ headless: true, executablePath: fs.existsSync(EXE) ? EXE : undefined });
}

/** route: คำขอ :3700 → backend ทดสอบ, ปิดการเชื่อมต่อออกนอกเครื่อง */
async function guardContext(ctx) {
    await ctx.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.port === '3700') { u.port = BE_PORT; return route.continue({ url: u.toString() }); }
        if (!['localhost', '127.0.0.1'].includes(u.hostname)) return route.abort();
        return route.continue();
    });
}

async function closeSwal(page, rounds = 3) {
    for (let i = 0; i < rounds; i++) {
        const c = page.locator('.swal2-cancel:visible, .swal2-deny:visible, .swal2-close:visible');
        const b = page.locator('.swal2-confirm:visible');
        if (await c.count()) await c.first().click().catch(() => {});
        else if (await b.count()) await b.first().click().catch(() => {});
        else if (i > 0) break;
        await page.waitForTimeout(300);
    }
}

/** เข้าสู่ระบบในบริบทที่ไม่ถ่าย แล้วคืน storageState ไว้เปิดบริบทที่ถ่ายวิดีโอ */
async function loginState(browser, username, password) {
    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH' });
    await guardContext(ctx);
    const page = await ctx.newPage();
    await page.goto(FE + '/login');
    await page.waitForTimeout(2000);
    await page.locator('input[type="text"]').first().fill(username);
    await page.locator('input[type="password"]').first().fill(password);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
    for (let i = 0; i < 15 && !/dashboard/.test(page.url()); i++) { await closeSwal(page); await page.waitForTimeout(800); }
    if (!/dashboard/.test(page.url())) throw new Error('เข้าสู่ระบบไม่สำเร็จ: ' + username + ' ' + page.url());
    await page.waitForTimeout(1500);
    const state = await ctx.storageState();
    await ctx.close();
    return state;
}

module.exports = { FE, VIEW, launch, guardContext, closeSwal, loginState };
