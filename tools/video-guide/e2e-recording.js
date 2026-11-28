// ทดสอบหน้าจอจริง (28 พ.ย. 2569): รายงานสถิติ
//   1) แถบกราฟและสถิติ = รายงานการบันทึกผลงาน: การ์ด/ตาราง = ตัวเลขจาก /report/recording-stats, ตัวกรองส่งค่าไป server, ไม่มีคำ "ผ่านเกณฑ์"
//   2) รายงานสรุปผล: จำนวนหน่วยบริการของแต่ละตัวชี้วัด (รวมที่ยังไม่มีผลงาน) = หน่วยบริการทั้งหมดในแถบสถานะการบันทึก (นับจาก kpi_results เหมือนกัน)
//      และร้อยละ = ผลงานรวม ÷ เป้าหมายรวม
// ฐานทดสอบเท่านั้น: node start-backend.js (:3710) + ng serve :4520 + node setup-data.js up
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { resetSessions, withDb } = require('./lib/db');
const { PASSWORD } = require('./setup-data');

const OUT = path.join(__dirname, 'cache', 'e2e-recording');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const num = (s) => Number(String(s || '').replace(/[^0-9.]/g, ''));

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    // คู่ที่ยังไม่มีผลงาน 1 คู่ (เพิ่มแถวเป้าหมายอย่างเดียวให้หน่วยบริการที่ยังไม่มีตัวชี้วัดนั้น) — ลบคืนตอนจบ
    const extra = await withDb(async c => {
        const [[ind]] = await c.query("SELECT r.indicator_id, r.year_bh, MIN(r.user_id) uid FROM kpi_results r JOIN kpi_indicators i ON i.id = r.indicator_id WHERE i.is_active = 1 AND r.year_bh = '2570' GROUP BY r.indicator_id, r.year_bh ORDER BY r.indicator_id LIMIT 1");
        const [[h]] = await c.query("SELECT hoscode FROM chospital WHERE hoscode NOT IN (SELECT hospcode FROM kpi_results WHERE indicator_id = ? AND year_bh = '2570') AND distid IS NOT NULL ORDER BY hoscode LIMIT 1", [ind.indicator_id]);
        const [r] = await c.query("INSERT INTO kpi_results (indicator_id, year_bh, month_bh, user_id, status, hospcode, target_value, actual_value) VALUES (?, '2570', 10, ?, 'Pending', ?, '10', NULL)", [ind.indicator_id, ind.uid, h.hoscode]);
        return { id: r.insertId, indicator_id: ind.indicator_id, hospcode: h.hoscode };
    });
    console.log('คู่ที่ยังไม่มีผลงาน (เพิ่มชั่วคราว):', extra);
    await resetSessions('test_vg_super_admin');
    const browser = await launch();
    try {
        for (const dark of [false, true]) {
            await resetSessions('test_vg_super_admin');
            const state = await loginState(browser, 'test_vg_super_admin', PASSWORD);
            const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: state });
            await guardContext(ctx);
            await ctx.addInitScript((d) => { try { const u = JSON.parse(localStorage.getItem('kpi_user') || 'null'); localStorage.setItem('kpi_mascot_assistant_off', '1'); if (u) localStorage.setItem('kpi_mascot_assistant_off_' + u.id, '1'); localStorage.setItem('kpi_dark_mode', d ? 'true' : 'false'); } catch (e) { } }, dark);
            const page = await ctx.newPage();
            const errs = [];
            page.on('pageerror', e => errs.push(e.message));
            page.on('console', m => { if (m.type() === 'error' && /GlobalErrorHandler|NG0/.test(m.text())) errs.push(m.text().slice(0, 600)); });
            let stats = null, byInd = null, recStat = null;
            page.on('response', async r => {
                if (r.url().includes('/report/by-indicator?')) { try { byInd = await r.json(); } catch (e) { } }
                if (r.url().includes('/report/recording-status?')) { try { recStat = await r.json(); } catch (e) { } }
            });
            page.on('response', async r => { if (r.url().includes('/report/recording-stats')) { try { stats = await r.json(); } catch (e) { } } });
            await page.goto(FE + '/charts');
            await page.waitForSelector('#rec-dept-table', { timeout: 60000 });
            await page.waitForTimeout(1500); await closeSwal(page);
            if (dark) {
                await page.screenshot({ path: path.join(OUT, 'dark-1-top.png') });
                await page.locator('#section-rec-dept').scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
                await page.screenshot({ path: path.join(OUT, 'dark-2-dept.png') });
                check('ไม่มีข้อผิดพลาดของหน้าจอ (โหมดมืด)', errs.length === 0, errs.slice(0, 2).join(' | '));
                await ctx.close();
                continue;
            }
            const o = stats.overall;
            const cards = ((await page.locator('#rec-cards').textContent()) || '').replace(/\s+/g, ' ');
            check('การ์ดร้อยละการบันทึก = server', cards.includes(o.recording_pct + '%'), `${o.recording_pct}% (${o.recorded_pairs}/${o.pairs})`);
            check('การ์ดความครบถ้วน/ทันเวลา = server', cards.includes((o.completeness_pct == null ? '–' : o.completeness_pct + '%')) && cards.includes((o.timeliness_pct == null ? '–' : o.timeliness_pct + '%')), `ครบถ้วน ${o.completeness_pct} ทันเวลา ${o.timeliness_pct} (ถึง ${stats.through_label})`);
            check('คู่ที่ยังไม่มีผลงานถูกนับ', o.not_recorded_pairs >= 1, `ยังไม่บันทึก ${o.not_recorded_pairs} คู่`);
            check('ตารางกลุ่มงาน = by_dept', await page.locator('#rec-dept-table tr[data-dept]').count() === stats.by_dept.length, String(stats.by_dept.length));
            check('ตารางตัวชี้วัด = by_indicator', await page.locator('#rec-ind-table tr[data-ind]').count() === stats.by_indicator.length, String(stats.by_indicator.length));
            check('ตารางหน่วยบริการ ≤ 20 แถว', await page.locator('#rec-hos-table tr[data-hos]').count() === Math.min(20, stats.by_hospital.length), String(stats.by_hospital.length));
            const chartText = await page.evaluate(() => (document.querySelector('#rec-cards')?.closest('.card-scroll') || document.body).innerText);
            const passWords = (chartText.match(/.{0,15}ผ่านเกณฑ์.{0,15}/g) || []).filter(t => !/ว่าผ่านหรือไม่ผ่านเกณฑ์|ว่าผ่านเกณฑ์หรือไม่/.test(t));
            check('แถบกราฟไม่มีตัวเลขผ่าน/ไม่ผ่านเกณฑ์', passWords.length === 0, passWords.slice(0, 2).join(' | '));
            await page.screenshot({ path: path.join(OUT, '1-top.png') });
            await page.locator('#section-rec-dept').scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
            await page.screenshot({ path: path.join(OUT, '2-dept.png') });
            await page.locator('#rec-ind-table').scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
            await page.screenshot({ path: path.join(OUT, '3-indicator.png') });
            await page.locator('#rec-hos-table').scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
            await page.screenshot({ path: path.join(OUT, '4-hospital.png') });
            // ตัวกรอง
            for (const [sel, param] of [['#chart-dept', 'dept_id'], ['#chart-itype', 'itype'], ['#chart-hostype', 'hostype'], ['#chart-district', 'distid'], ['#chart-zone', 'zone']]) {
                const opts = await page.locator(sel + ' option').evaluateAll(os => os.map(x => x.value).filter(v => v));
                const value = opts.find(v => v !== '');
                if (!value) { check(`ตัวกรอง ${param}`, false, 'ไม่มีตัวเลือก'); continue; }
                const resp = page.waitForResponse(r => r.url().includes('/report/recording-stats'), { timeout: 30000 });
                await page.selectOption(sel, value);
                const r = await resp; const body = await r.json();
                await page.waitForTimeout(500);
                const v = value.replace(/^\d+: /, '');
                const rows = await page.locator('#rec-ind-table tr[data-ind]').count();
                check(`ตัวกรอง ${param}=${v}`, decodeURIComponent(r.url()).includes(param + '=' + v) && rows === body.by_indicator.length, `ตัวชี้วัด ${rows} / server ${body.by_indicator.length}`);
                const back = page.waitForResponse(rr => rr.url().includes('/report/recording-stats'), { timeout: 30000 });
                await page.selectOption(sel, ''); await back; await page.waitForTimeout(300);
            }
            // คลิกแถวตัวชี้วัด = กรอง
            const first = page.locator('#rec-ind-table tr[data-ind]').first();
            const indId = await first.getAttribute('data-ind');
            const rr = page.waitForResponse(r => r.url().includes('/report/recording-stats') && r.url().includes('indicator_id=' + indId), { timeout: 30000 });
            await first.click(); await rr; await page.waitForTimeout(500);
            check('คลิกแถวตัวชี้วัด = กรองตัวชี้วัดนั้น', await page.locator('#rec-ind-table tr[data-ind]').count() === 1);
            await page.click('button:has-text("ล้างตัวกรองทั้งหมด")'); await page.waitForTimeout(1200);

            // ===== รายงานสรุปผล =====
            await page.click('button:has-text("รายงานสรุปผล")');
            await page.waitForSelector('#report-total-note', { timeout: 30000 });
            await page.waitForTimeout(1500); await closeSwal(page);
            if ((await page.locator('#report-year').inputValue()) !== '2570') { const w = page.waitForResponse(r => r.url().includes('/report/by-indicator?')); await page.selectOption('#report-year', '2570'); await w; await page.waitForTimeout(800); }
            const row = (byInd?.data || []).find(x => x.indicator_id === extra.indicator_id);
            check('รายข้อตัวชี้วัด: นับหน่วยบริการที่ยังไม่มีผลงาน', row && Number(row.hospital_count) > Number(row.recorded_hospitals), row ? `บันทึก ${row.recorded_hospitals} / ทั้งหมด ${row.hospital_count}` : 'ไม่พบ');
            const ratio = row && Number(row.target_value) > 0 ? Math.round(Number(row.total_actual) / Number(row.target_value) * 10000) / 100 : 0;
            check('ร้อยละ = ผลงานรวม ÷ เป้าหมายรวม', row && Math.abs(Number(row.achievement_pct) - ratio) < 0.011, `${row?.achievement_pct} = ${row?.total_actual} ÷ ${row?.target_value}`);
            await page.screenshot({ path: path.join(OUT, '5-report.png') });
            await page.click('button:has-text("สถานะการบันทึก")');
            await page.waitForTimeout(2500); await closeSwal(page);
            const mism = (byInd?.data || []).filter(b => { const s = (recStat?.data || []).find(x => x.indicator_id === b.indicator_id); return s && Number(s.total_hospitals) !== Number(b.hospital_count); });
            check('หน่วยบริการของตัวชี้วัด = แถบสถานะการบันทึก (ทุกตัวชี้วัด)', recStat && mism.length === 0, mism.length ? mism.slice(0, 3).map(m => m.indicator_id).join(',') : `${(byInd?.data || []).length} ตัวชี้วัด`);
            check('ไม่มีข้อผิดพลาดของหน้าจอ', errs.length === 0, errs.slice(0, 2).join(' | '));
            await ctx.close();
        }
    } finally {
        await browser.close();
        await withDb(c => c.query('DELETE FROM kpi_results WHERE id = ?', [extra.id]));
    }
    const bad = results.filter(r => !r.ok);
    console.log(`\nผล: ผ่าน ${results.length - bad.length}/${results.length} — ภาพ ${OUT}`);
    process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
