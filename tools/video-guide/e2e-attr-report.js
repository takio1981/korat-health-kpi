// ทดสอบหน้าจอจริง (27 พ.ย. 2569): ตัวกรองคุณสมบัติตัวชี้วัดในหน้าจัดการข้อมูล KPI + เป้าหมายรวมในรายงานรายข้อตัวชี้วัด
// ฐานทดสอบเท่านั้น (backend :3710 + ng serve :4520) — อ่านอย่างเดียว ไม่บันทึกข้อมูล | node e2e-attr-report.js → cache/e2e-attr-report/*.png
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { withDb, resetSessions } = require('./lib/db');
const { PASSWORD } = require('./setup-data');

const OUT = path.join(__dirname, 'cache', 'e2e-attr-report');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const num = (s) => Number(String(s || '').replace(/[^0-9.\-]/g, ''));

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const db = await withDb(async c => {
        const [inds] = await c.query(`SELECT id, result_formula, is_cumulative, result_manual, pct_manual, upload_excel FROM kpi_indicators WHERE is_active = 1`);
        const [sums] = await c.query(`SELECT s.indicator_id, MAX(s.kpi_indicators_name) name,
                SUM(CASE WHEN TRIM(s.target_value) REGEXP '^-{0,1}[0-9]+([.][0-9]+){0,1}$' THEN CAST(s.target_value AS DECIMAL(20,4)) ELSE 0 END) t,
                COUNT(DISTINCT s.hospcode) n
            FROM kpi_summary s JOIN kpi_indicators i ON i.id = s.indicator_id AND i.is_active = 1 WHERE s.year_bh = '2570' GROUP BY s.indicator_id`);
        return { inds, sums };
    });

    await resetSessions('test_vg_super_admin');
    const browser = await launch();
    const state = await loginState(browser, 'test_vg_super_admin', PASSWORD);
    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: state });
    await guardContext(ctx);
    await ctx.addInitScript(() => { try { const u = JSON.parse(localStorage.getItem('kpi_user') || 'null'); localStorage.setItem('kpi_mascot_assistant_off', '1'); if (u) localStorage.setItem('kpi_mascot_assistant_off_' + u.id, '1'); } catch (e) { } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /GlobalErrorHandler|NG0/.test(m.text())) errs.push(m.text().slice(0, 200)); });

    // ===== 1) ตัวกรองคุณสมบัติตัวชี้วัด =====
    await page.goto(FE + '/kpi-manager');
    await page.waitForTimeout(6000); await closeSwal(page);
    check('มีตัวกรองคุณสมบัติ 8 หัวข้อ', (await page.locator('#kpi-attr-filters select').count()) === 8);
    const rows = () => page.locator('#kpi-export-table tbody tr[data-ind]');
    const total = await rows().count();
    check('ตารางมีตัวชี้วัด', total > 0, `${total} แถว`);
    const isF = (i) => (db.inds.some(x => x.result_formula) ? !!i.result_formula : +i.is_cumulative === 1 && !i.result_formula);
    const mKey = db.inds.some(x => x.result_formula) ? 'formula' : 'cumulative';
    const nFormula = db.inds.filter(isF).length;
    await page.selectOption('#attr-method', mKey); await page.waitForTimeout(600);
    const shownF = await rows().count();
    check('วิธีคิดผลงาน = ' + mKey + ' → เหลือเฉพาะตัวที่ตรง', shownF > 0 && shownF <= nFormula && shownF < total, `แสดง ${shownF} / มีสูตรในฐาน ${nFormula}`);
    const ids = await rows().evaluateAll(trs => trs.map(t => Number(t.getAttribute('data-ind'))));
    const byId = new Map(db.inds.map(i => [i.id, i]));
    check('ทุกแถวที่แสดงตรงวิธีคิดผลงานจริง', ids.every(id => byId.get(id) && isF(byId.get(id))), ids.slice(0, 8).join(','));
    check('ป้ายนับตัวกรอง', ((await page.locator('#attr-filter-count').textContent()) || '').includes('1'));
    await page.selectOption('#attr-khd', 'off'); await page.waitForTimeout(600);
    const ids2 = await rows().evaluateAll(trs => trs.map(t => Number(t.getAttribute('data-ind'))));
    check(mKey + ' + ไม่ส่ง KHD → ทุกแถว upload_excel = 1', ids2.every(id => +byId.get(id)?.upload_excel === 1), `${ids2.length} แถว`);
    await page.locator('#kpi-attr-filters').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, '1-attr-filter.png') });
    await page.click('button:has-text("ล้างตัวกรอง")'); await page.waitForTimeout(600);
    check('ล้างตัวกรองแล้วแสดงครบ', (await rows().count()) === total);

    // ===== 2) รายงานสรุปผล แถบรายข้อตัวชี้วัด =====
    await page.goto(FE + '/charts');
    await page.waitForTimeout(4000); await closeSwal(page);
    await page.click('button:has-text("รายงานสรุปผล")'); await page.waitForTimeout(1500);
    const yearSel = page.locator('select').filter({ has: page.locator('option[value="2570"]') }).first();
    if (await yearSel.count()) { await yearSel.selectOption('2570'); }
    await page.waitForTimeout(6000); await closeSwal(page);
    const table = page.locator('table:has(th:has-text("เป้าหมาย (รวม)"))').first();
    check('หัวตาราง "เป้าหมาย (รวม)"', (await table.count()) === 1);
    const heads = (await table.locator('thead th').allTextContents()).map(s => s.replace(/\s+/g, ' ').trim());
    const ti = heads.findIndex(h => h.startsWith('เป้าหมาย'));
    check('ลำดับคอลัมน์ เป้าหมาย → ผลงานรวม → %สำเร็จ → รพ. → ต.ค.',
        heads[ti + 1] === 'ผลงานรวม' && heads[ti + 2] === '%สำเร็จ' && heads[ti + 3] === 'รพ.' && /ต\.ค/.test(heads[ti + 4] || ''), heads.slice(ti, ti + 5).join(' | '));
    const trs = await table.locator('tbody tr').evaluateAll(t => t.map(r => Array.from(r.querySelectorAll('td')).map(td => td.textContent.replace(/\s+/g, ' ').trim())));
    const sumByName = new Map(db.sums.map(s => [String(s.name).trim(), s]));
    let ok = 0, cmp = 0; const bad = [];
    for (const cells of trs) {
        const nameCell = cells.find(c => [...sumByName.keys()].some(n => c.includes(n)));
        if (!nameCell) continue;
        const s = [...sumByName.values()].find(v => nameCell.includes(String(v.name).trim()));
        cmp++;
        const shown = cells[ti];
        if (Math.abs(num(shown) - Number(s.t)) < 0.01 && num(cells[ti + 3]) === Number(s.n)) ok++; else bad.push(`${s.name.slice(0, 30)}: ${shown} ≠ ${Number(s.t)}`);
        if (cmp >= 30) break;
    }
    check('เป้าหมาย = ผลรวมเป้าหมายตัวเลขของทุกหน่วยบริการ (เทียบฐานข้อมูล) + จำนวน รพ. ตรง', cmp > 0 && ok === cmp, `${ok}/${cmp} แถว ${bad.slice(0, 3).join('; ')}`);
    await table.screenshot({ path: path.join(OUT, '2-report-by-indicator.png') });

    check('ไม่มี error ใน console/หน้า', errs.length === 0, errs.slice(0, 3).join(' | '));
    await browser.close();
    await resetSessions('test_vg_super_admin');
    const pass = results.filter(r => r.ok).length;
    console.log(`\nสรุป: ผ่าน ${pass}/${results.length}`);
    process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
