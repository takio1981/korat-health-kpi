// ทดสอบหน้าจอจริง (28 พ.ย. 2569): ตัวกรองหน้ารายงานสรุปผล ทุกแถบ × ทุกตัวกรอง
// ฐานทดสอบเท่านั้น: node start-backend.js (:3710) + ng serve :4520 + node setup-data.js up
// ทุกแถบ: เลือกค่าแรกของแต่ละตัวกรอง → คำขอไป server มีพารามิเตอร์นั้น → จำนวนรายการในตาราง = จำนวนแถวที่ server ส่งมา → ล้างตัวกรอง
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { resetSessions } = require('./lib/db');
const { PASSWORD } = require('./setup-data');

const OUT = path.join(__dirname, 'cache', 'e2e-report-filters');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

const TABS = [
    { label: 'รายข้อตัวชี้วัด', url: '/report/by-indicator', count: '#report-search-count' },
    { label: 'รายหน่วยบริการ', url: '/report/by-hospital', count: '#report-search-count' },
    { label: 'รายอำเภอ', url: '/report/by-district', count: '#report-search-count' },
    { label: 'รายปีงบประมาณ', url: '/report/by-year', count: '#report-search-count', noYear: true },
    { label: 'สรุปตัวชี้วัดของกลุ่มงาน', url: '/report/by-dept-kpi', count: '#report-dept-kpi-search-count' },
    { label: 'สถานะการบันทึก', url: '/report/recording-status', count: '#report-search-count' },
    { label: 'สรุปรายกลุ่มงาน', url: '/report/by-dept-summary', count: '#report-dept-search-count' },
];
const FILTERS = [
    ['#report-year', 'year_bh'], ['#report-dept', 'dept_id'], ['#report-zone', 'zone'], ['#report-district', 'distid'],
    ['#report-itype', 'itype'], ['#report-hostype', 'hostype'],
];

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    await resetSessions('test_vg_super_admin');
    const browser = await launch();
    try {
        const state = await loginState(browser, 'test_vg_super_admin', PASSWORD);
        const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: state });
        await guardContext(ctx);
        await ctx.addInitScript(() => { try { const u = JSON.parse(localStorage.getItem('kpi_user') || 'null'); localStorage.setItem('kpi_mascot_assistant_off', '1'); if (u) localStorage.setItem('kpi_mascot_assistant_off_' + u.id, '1'); } catch (e) { } });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(e.message));
        page.on('console', m => { if (m.type() === 'error' && /GlobalErrorHandler|NG0/.test(m.text())) errs.push(m.text().slice(0, 600)); });
        await page.goto(FE + '/charts');
        await page.waitForTimeout(2500); await closeSwal(page);
        await page.click('button:has-text("รายงานสรุปผล")');
        await page.waitForSelector('#report-dept', { timeout: 30000 });
        await page.waitForTimeout(2000); await closeSwal(page);

        const rowsOf = (body) => Array.isArray(body?.data) ? body.data.length : 0;
        const shownCount = async (sel) => {
            await page.waitForTimeout(400);
            const t = (await page.locator(sel).first().textContent().catch(() => '')) || '';
            const m = t.match(/ทั้งหมด\s*(\d+)/);
            return m ? Number(m[1]) : null;
        };
        for (const tab of TABS) {
            const tabBtn = tab.label === 'สรุปตัวชี้วัดของกลุ่มงาน' ? page.locator('#tab-by-dept-kpi') : page.locator(`button:has-text("${tab.label}")`).first();
            const first = page.waitForResponse(r => r.url().includes(tab.url + '?') || r.url().endsWith(tab.url), { timeout: 30000 }).catch(() => null);
            await tabBtn.click();
            await first; await page.waitForTimeout(800); await closeSwal(page);
            check(`[${tab.label}] ช่องปีงบ ${tab.noYear ? 'ซ่อน' : 'แสดง'}`, (await page.locator('#report-year').count() > 0) === !tab.noYear);
            for (const [sel, param] of FILTERS) {
                if (sel === '#report-year' && tab.noYear) continue;
                const s = page.locator(sel);
                if (!(await s.count())) { check(`[${tab.label}] มีตัวกรอง ${param}`, false); continue; }
                const opts = await s.locator('option').evaluateAll(os => os.map(o => o.value).filter(v => v !== ''));
                if (!opts.length) { check(`[${tab.label}] ${param}: มีตัวเลือก`, false, 'ไม่มีตัวเลือก'); continue; }
                const before = await s.inputValue();
                const value = opts.find(v => v !== before) || opts[0];
                const resp = page.waitForResponse(r => r.url().includes(tab.url) && !r.url().includes(tab.url + '/'), { timeout: 30000 });
                await s.selectOption(value);
                const r = await resp.catch(() => null);
                if (!r) { check(`[${tab.label}] ${param}=${value}`, false, 'ไม่มีคำขอไป server'); continue; }
                const url = decodeURIComponent(r.url());
                const body = await r.json().catch(() => ({}));
                await page.waitForTimeout(500); await closeSwal(page);
                const shown = await shownCount(tab.count);
                const ok = url.includes(param + '=' + value.replace(/^\d+: /, ''));
                check(`[${tab.label}] ${param}=${value}`, ok && shown === rowsOf(body), `ส่ง ${ok ? 'ถูก' : 'ไม่ส่ง'} · ตาราง ${shown} / server ${rowsOf(body)}`);
                // คืนค่าเดิม (ปีงบ = ค่าเดิม, อื่น = ทั้งหมด)
                const back = page.waitForResponse(rr => rr.url().includes(tab.url) && !rr.url().includes(tab.url + '/'), { timeout: 30000 }).catch(() => null);
                await s.selectOption(sel === '#report-year' ? before : '');
                await back; await page.waitForTimeout(300); await closeSwal(page);
            }
            await page.screenshot({ path: path.join(OUT, tab.url.split('/').pop() + '.png') });
        }
        check('ไม่มีข้อผิดพลาดของหน้าจอ', errs.length === 0, errs.slice(0, 2).join(' | '));
        await ctx.close();
    } finally {
        await browser.close();
    }
    const bad = results.filter(r => !r.ok);
    console.log(`\nผล: ผ่าน ${results.length - bad.length}/${results.length} — ภาพ ${OUT}`);
    process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
