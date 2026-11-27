// ทดสอบหน้าจอจริง: หน้าจัดการข้อมูล KPI แบบตารางเดียว (27 พ.ย. 2569) — ฐานทดสอบเท่านั้น (backend :3710 + ng serve :4520)
// node e2e-kpi-manager.js → cache/e2e-kpi-manager/*.png + ผลตรวจเทียบค่าในตารางส่งออกกับ kpi_results ทุกช่อง
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { withDb, resetSessions } = require('./lib/db');
const { PASSWORD } = require('./setup-data');

const OUT = path.join(__dirname, 'cache', 'e2e-kpi-manager');
const MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const col = (m) => 'm' + String(m).padStart(2, '0');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    // ตัวชี้วัดของข้อมูลตัวอย่างที่มีผลงานปีงบ 2570 แต่ยังไม่มีตารางส่งออก (ลบตารางทดสอบเดิมก่อน — ฐานทดสอบเท่านั้น)
    const pick = await withDb(async c => {
        const [rows] = await c.query(`SELECT i.id, i.kpi_indicators_name, TRIM(i.table_process) raw_tp, REPLACE(TRIM(i.table_process), '-', '_') tp, COUNT(*) n,
                                             SUM(r.actual_value IS NOT NULL AND r.actual_value <> '') a
                                      FROM kpi_indicators i JOIN kpi_results r ON r.indicator_id = i.id AND r.year_bh = '2570'
                                      WHERE i.is_active = 1 AND i.table_process <> '' AND i.result_formula IS NULL AND IFNULL(i.is_cumulative,0) = 0
                                        AND i.target_monthly IS NULL AND i.quarter_mode IS NULL AND IFNULL(i.result_manual,0) = 0
                                      GROUP BY i.id HAVING a > 0 ORDER BY a DESC, i.id LIMIT 1`);
        if (!rows.length) throw new Error('ไม่พบตัวชี้วัดตัวอย่างที่มีผลงาน 2570 — รัน node setup-data.js up');
        await c.query(`DROP TABLE IF EXISTS \`${rows[0].tp}\``);
        await c.query("DELETE FROM system_settings WHERE setting_key = 'khd_send_policy'"); // ค่าตั้งต้น
        return rows[0];
    });
    console.log('ตัวชี้วัดทดสอบ:', pick.id, pick.kpi_indicators_name, pick.tp, `(${pick.a} ช่องผลงาน)`);

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
    await page.goto(FE + '/kpi-manager');
    await page.waitForTimeout(5000); await closeSwal(page);
    check('ไม่มี error overlay', (await page.locator('vite-error-overlay').count()) === 0);
    check('ไม่มีตัวเลือกขั้น (wizard) แล้ว', (await page.locator('button:has-text("ขั้นถัดไป")').count()) === 0);
    check('แถบกติกาการส่ง = ส่งทุกค่าที่บันทึก (ค่าตั้งต้น)', (await page.locator('#kpi-send-policy').textContent() || '').includes('ส่งทุกค่าที่บันทึก'));
    await page.waitForSelector('#kpi-khd-conn:not(:has(.fa-spinner))', { timeout: 30000 }).catch(() => {});
    const conn = (await page.locator('#kpi-khd-conn').textContent()) || '';
    check('สถานะ KHD แสดงเชื่อมต่อไม่ได้ (ฐานทดสอบตั้ง KHD ปลอม) และไม่ทำให้หน้าใช้ไม่ได้', conn.includes('เชื่อมต่อ KHD ไม่ได้'), conn.replace(/\s+/g, ' ').trim().slice(0, 120));
    const rowSel = `tr[data-ind="${pick.id}"]`;
    await page.fill('input[placeholder="ค้นหาตัวชี้วัด..."]', pick.tp);
    await page.waitForTimeout(800);
    check('แถวของตัวชี้วัดทดสอบแสดงในตาราง', (await page.locator(rowSel).count()) === 1);
    check('ตารางในระบบ = ยังไม่มีตาราง (ส่งออกแล้วสร้างให้เอง)', (await page.locator(`${rowSel} [data-local]`).getAttribute('data-local')) === 'none');
    const rowText = ((await page.locator(rowSel).textContent()) || '').replace(/\s+/g, ' ');
    check('ป้ายการตั้งค่า: ชื่อตาราง + ส่ง/ไม่ส่ง KHD + ป้ายตัวชี้วัด', rowText.includes(pick.raw_tp) && /ส่ง KHD|ไม่ส่ง KHD/.test(rowText) && (await page.locator(`${rowSel} app-indicator-badges span`).count()) > 0, rowText.slice(0, 160));
    await page.screenshot({ path: path.join(OUT, '1-before.png'), fullPage: false });

    // เลือกเฉพาะแถวนี้ → ส่งออก
    await page.locator('label:has-text("เลือกทั้งหมด") input').uncheck().catch(() => {});
    await page.locator(`${rowSel} input[type=checkbox]`).check();
    const btnText = ((await page.locator('button:has-text("ส่งออกข้อมูล")').textContent()) || '').trim();
    check('ปุ่มส่งออกนับเฉพาะรายการที่เลือก (1)', btnText.includes('(1)'), btnText);
    await page.click('button:has-text("ส่งออกข้อมูล")');
    await page.waitForSelector('.swal2-confirm', { timeout: 10000 });
    const respP = page.waitForResponse(r => r.url().includes('/export-kpi-tables'), { timeout: 60000 });
    await page.click('.swal2-confirm');
    const exp = await (await respP).json();
    check('ส่งออกเฉพาะตัวชี้วัดที่เลือก (1 ตาราง) ด้วยกติกา all', exp.created_tables.length === 1 && exp.created_tables[0].table === pick.tp && exp.policy === 'all', `ตาราง ${exp.created_tables.length} · กติกา ${exp.policy}`);
    await page.waitForSelector('.swal2-title:has-text("ส่งออกสำเร็จ")', { timeout: 60000 }).catch(() => {});
    const swalText = ((await page.locator('.swal2-html-container').textContent().catch(() => '')) || '').replace(/\s+/g, ' ');
    check('หน้าต่างสรุปผลส่งออกแสดงตารางที่สร้าง', swalText.includes(pick.tp), swalText.slice(0, 140));
    await page.screenshot({ path: path.join(OUT, '2-export-result.png') });
    await page.click('.swal2-confirm').catch(() => {});
    await page.waitForTimeout(3000);

    // ตรวจค่าในตารางส่งออกเทียบ kpi_results ทุกช่อง (ฐานทดสอบ)
    const cmp = await withDb(async c => {
        const [exp] = await c.query(`SELECT * FROM \`${pick.tp}\` WHERE byear = '2570'`);
        const [src] = await c.query("SELECT hospcode, month_bh, target_value, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = '2570'", [pick.id]);
        const byHos = new Map();
        for (const r of src) { if (!byHos.has(r.hospcode)) byHos.set(r.hospcode, []); byHos.get(r.hospcode).push(r); }
        let cells = 0; const bad = [];
        for (const [h, rs] of byHos) {
            const hasActual = rs.some(r => r.actual_value !== null && r.actual_value !== '');
            const row = exp.find(e => String(e.hospcode).trim() === h);
            if (!row) { if (hasActual) bad.push(`${h}: ไม่มีแถว`); continue; }
            for (const m of MONTHS) {
                const s = rs.find(r => Number(r.month_bh) === m);
                const want = s ? num(s.actual_value) : null;
                cells++;
                if (num(row[col(m)]) !== want) bad.push(`${h} ${col(m)}: ${row[col(m)]} ≠ ${want}`);
            }
            const tgt = Math.max(...rs.map(r => num(r.target_value)).filter(v => v !== null), -Infinity);
            if (Number.isFinite(tgt) && num(row.target) !== tgt) bad.push(`${h} target: ${row.target} ≠ ${tgt}`);
            const latest = [...MONTHS].reverse().map(m => rs.find(r => Number(r.month_bh) === m)).find(r => r && r.actual_value !== null && r.actual_value !== '');
            if (num(row.result) !== (latest ? num(latest.actual_value) : null)) bad.push(`${h} result: ${row.result} ≠ ${latest ? latest.actual_value : null}`);
        }
        return { rows: exp.length, hos: byHos.size, cells, bad };
    });
    check(`ตารางส่งออกถูกสร้าง ${cmp.rows} แถว (หน่วยบริการในผลงาน ${cmp.hos})`, cmp.rows > 0);
    check(`ค่าในตารางส่งออกตรงกับ kpi_results ทุกช่อง (${cmp.cells} ช่องรายเดือน + target + result)`, cmp.bad.length === 0, cmp.bad.slice(0, 5).join(' | '));

    await page.waitForTimeout(2000);
    const after = await page.locator(`${rowSel} [data-local]`).getAttribute('data-local');
    check('หลังส่งออก คอลัมน์ตารางในระบบเปลี่ยนเป็น "มีข้อมูล"', after === 'ok', ((await page.locator(`${rowSel} [data-local]`).textContent()) || '').trim());
    await page.screenshot({ path: path.join(OUT, '3-after.png') });

    // ตรวจข้อมูลอีกครั้ง → ล่าสุดแล้ว
    await page.click('button:has-text("ตรวจสอบข้อมูล")');
    await page.waitForSelector('.swal2-title:has-text("ตรวจสอบเสร็จสิ้น")', { timeout: 120000 }).catch(() => {});
    await page.click('.swal2-confirm').catch(() => {});
    await page.waitForTimeout(1500);
    const chk = ((await page.locator(`${rowSel} td:nth-child(5)`).textContent()) || '').replace(/\s+/g, ' ').trim();
    check('ตรวจสอบหลังส่งออก = ล่าสุดแล้ว', chk.includes('ล่าสุดแล้ว'), chk);

    // โหมดมืด
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, '4-dark.png') });
    check('ไม่มี error ของหน้าเว็บระหว่างทดสอบ (pageerror + console GlobalErrorHandler)', errs.length === 0, errs.slice(0, 3).join(' | '));
    await browser.close();
    const fail = results.filter(r => !r.ok).length;
    console.log(`\nสรุป: ผ่าน ${results.length - fail}/${results.length}`);
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ pick, results, cmp }, null, 1));
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
