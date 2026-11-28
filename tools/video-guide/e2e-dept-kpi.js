// ทดสอบหน้าจอจริง (28 พ.ย. 2569): รายงานสรุปผล แถบ "สรุปตัวชี้วัดของกลุ่มงาน" + คำว่า "หน่วยงาน" → "กลุ่มงาน"
// ฐานทดสอบเท่านั้น: node start-backend.js (:3710) + ng serve :4520 + node setup-data.js up
//   1) จำนวนตัวชี้วัดรวมทุกกลุ่มงาน = จำนวนแถวของแถบรายข้อตัวชี้วัด (ตัวกรองเดียวกัน)
//   2) คลิกกลุ่มงาน = ขยายรายตัวชี้วัด, ค้นหาชื่อตัวชี้วัด, ผู้ใช้กลุ่มงาน (user_ssj) เห็นเฉพาะกลุ่มงานตัวเอง
//   3) หน้าหลักไม่เหลือคำว่า "หน่วยงาน"
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { resetSessions } = require('./lib/db');
const { PASSWORD } = require('./setup-data');

const OUT = path.join(__dirname, 'cache', 'e2e-dept-kpi');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

async function openReport(page) {
    await page.goto(FE + '/charts');
    await page.waitForTimeout(2500); await closeSwal(page);
    await page.click('button:has-text("รายงานสรุปผล")');
    await page.waitForSelector('#tab-by-dept-kpi', { timeout: 30000 });
    await page.waitForTimeout(1500);
}

async function session(browser, user, dark = false) {
    await resetSessions(user);
    const state = await loginState(browser, user, PASSWORD);
    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: state, colorScheme: dark ? 'dark' : 'light' });
    await guardContext(ctx);
    await ctx.addInitScript((d) => {
        try {
            const u = JSON.parse(localStorage.getItem('kpi_user') || 'null');
            localStorage.setItem('kpi_mascot_assistant_off', '1');
            if (u) localStorage.setItem('kpi_mascot_assistant_off_' + u.id, '1');
            localStorage.setItem('kpi_dark_mode', d ? 'true' : 'false');
        } catch (e) { }
    }, dark);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /GlobalErrorHandler|NG0/.test(m.text())) errs.push(m.text().slice(0, 800)); });
    return { ctx, page, errs };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await launch();
    try {
        // ===== super_admin =====
        const { ctx, page, errs } = await session(browser, 'test_vg_super_admin');
        await openReport(page);
        const year = await page.locator('select').first().inputValue();
        // แถบรายข้อตัวชี้วัด: จำนวนแถว
        await page.waitForSelector('#report-search-count', { timeout: 60000 });
        const byIndText = (await page.locator('#report-search-count').textContent()) || '';
        const byIndCount = Number((byIndText.match(/(\d+)\s*รายการ/) || [])[1] || -1);
        await page.click('#tab-by-dept-kpi');
        await page.waitForSelector('#dept-kpi-table', { timeout: 60000 });
        await page.waitForTimeout(800);
        const rows = page.locator('#dept-kpi-table tr[data-dept]');
        const n = await rows.count();
        check('แถบใหม่แสดงกลุ่มงาน', n > 0, `${n} กลุ่มงาน ปีงบ ${year}`);
        const sumInd = await page.$$eval('#dept-kpi-table tr[data-dept]', trs => trs.reduce((s, tr) => s + Number(tr.children[2].textContent.trim()), 0));
        check('ตัวชี้วัดรวมทุกกลุ่มงาน = แถวของแถบรายข้อตัวชี้วัด', sumInd === byIndCount, `${sumInd} / ${byIndCount}`);
        const cardText = ((await page.locator('#dept-kpi-cards').textContent()) || '').replace(/\s+/g, ' ');
        check('การ์ดจำนวนกลุ่มงาน = แถวในตาราง', cardText.replace(/ /g, '').startsWith('กลุ่มงาน' + n + 'ที่มี'), cardText.slice(0, 80));
        // เรียงร้อยละมาก → น้อย
        const pcts = await page.$$eval('#dept-kpi-table tr[data-dept]', trs => trs.map(tr => parseFloat(tr.children[8].textContent.replace(/[^0-9.]/g, ''))));
        check('เรียงร้อยละผ่านเกณฑ์มาก → น้อย', pcts.every((p, i) => i === 0 || pcts[i - 1] >= p), pcts.join(', '));
        await page.screenshot({ path: path.join(OUT, '1-groups.png'), fullPage: false });
        // ขยายกลุ่มงานแรก
        await rows.first().click();
        await page.waitForTimeout(600);
        const firstCount = Number(((await rows.first().locator('td').nth(2).textContent()) || '').trim());
        const subRows = await page.locator('#dept-kpi-table td[colspan="10"] tbody tr').count();
        check('คลิกกลุ่มงาน = ขยายรายตัวชี้วัดครบ', subRows === firstCount, `${subRows} / ${firstCount}`);
        const firstInd = ((await page.locator('#dept-kpi-table td[colspan="10"] tbody tr').first().locator('td').nth(1).locator('span').first().textContent()) || '').trim();
        await page.locator('#dept-kpi-table').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, '2-expanded.png'), fullPage: false });
        // ค้นหาชื่อตัวชี้วัด
        const word = firstInd.split(/\s+/).sort((a, b) => b.length - a.length)[0] || firstInd;
        await page.fill('#report-dept-kpi-search', word);
        await page.waitForTimeout(600);
        const after = await page.locator('#dept-kpi-table td[colspan="10"]').count();
        const txt = (await page.locator('#dept-kpi-table').textContent()) || '';
        check('ค้นหาชื่อตัวชี้วัด = ขยายกลุ่มงานที่มีตัวนั้นให้เอง', after >= 1 && txt.includes(firstInd), `"${word}" → ขยาย ${after}`);
        await page.fill('#report-dept-kpi-search', '');
        // Excel
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('button:has-text("Excel")')]);
        check('ส่งออก Excel', /ตัวชี้วัดของกลุ่มงาน/.test(dl.suggestedFilename()), dl.suggestedFilename());
        // คำว่า หน่วยงาน — แถบรายงานทุกแถบ + หน้าหลัก
        const leftovers = [];
        const scan = async (label) => {
            const t = await page.evaluate(() => document.body.innerText);
            // ชื่อตัวชี้วัด (ข้อมูลจริง เช่น ร้อยละของหน่วยงานในสังกัด…) ไม่ใช่ข้อความของระบบ — ตัดชื่อตัวชี้วัดที่แสดงออกก่อน
            const m = t.split(/\n/).filter(l => !/ร้อยละของหน่วยงาน/.test(l)).join(' ').match(/.{0,20}หน่วยงาน.{0,20}/g);
            if (m) leftovers.push(label + ': ' + m.slice(0, 3).join(' | '));
        };
        for (const tab of ['รายข้อตัวชี้วัด', 'รายหน่วยบริการ', 'สถานะการบันทึก', 'สรุปรายกลุ่มงาน']) {
            await page.click(`button:has-text("${tab}")`); await page.waitForTimeout(1500); await closeSwal(page);
            await scan('รายงาน/' + tab);
        }
        for (const p of ['/dashboard', '/kpi-manage', '/users', '/kpi-manager', '/work-center', '/help']) {
            await page.goto(FE + p); await page.waitForTimeout(3500); await closeSwal(page);
            await scan(p);
        }
        check('ไม่เหลือคำว่า "หน่วยงาน" บนหน้าจอหลัก', leftovers.length === 0, leftovers.join(' || '));
        check('ไม่มีข้อผิดพลาดของหน้าจอ (super_admin)', errs.length === 0, errs.slice(0, 2).join(' | '));
        await ctx.close();

        // ===== โหมดมืด =====
        const dk = await session(browser, 'test_vg_super_admin', true);
        await openReport(dk.page);
        await dk.page.click('#tab-by-dept-kpi');
        await dk.page.waitForSelector('#dept-kpi-table tr[data-dept]', { timeout: 60000 });
        await dk.page.locator('#dept-kpi-table tr[data-dept]').first().click();
        await dk.page.waitForTimeout(800);
        await dk.page.screenshot({ path: path.join(OUT, '3-dark.png'), fullPage: false });
        await dk.ctx.close();

        // ===== user_ssj — เฉพาะกลุ่มงานของตัวเอง =====
        const us = await session(browser, 'test_vg_user_ssj');
        await openReport(us.page);
        await us.page.click('#tab-by-dept-kpi');
        await us.page.waitForSelector('#dept-kpi-table', { timeout: 60000 });
        await us.page.waitForTimeout(800);
        const un = await us.page.locator('#dept-kpi-table tr[data-dept]').count();
        check('user_ssj เห็นกลุ่มงานเดียว (ของตัวเอง)', un <= 1, `${un} กลุ่มงาน`);
        await us.page.screenshot({ path: path.join(OUT, '4-user-ssj.png'), fullPage: false });
        check('ไม่มีข้อผิดพลาดของหน้าจอ (user_ssj)', us.errs.length === 0, us.errs.slice(0, 2).join(' | '));
        await us.ctx.close();
    } finally {
        await browser.close();
    }
    const bad = results.filter(r => !r.ok);
    console.log(`\nผล: ผ่าน ${results.length - bad.length}/${results.length} — ภาพ ${OUT}`);
    process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
