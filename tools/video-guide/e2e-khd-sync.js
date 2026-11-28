// ทดสอบหน้าจอจริง (28 พ.ย. 2569): หน้าจัดการข้อมูล KPI ↔ KHD
//   1) card สรุปผลตรวจสอบ = จำนวนแถวในตารางเมื่อกด card ทุกใบ (เทียบกับค่าที่คำนวณจากฐานโดยตรงด้วย)
//   2) ส่งข้อมูลเข้า KHD เป็นขั้นที่ 5 ในหน้าเดียวกัน เฉพาะตัวชี้วัดที่เลือก + ปีงบที่เลือก → ข้อมูลใน KHD = ตารางส่งออกของปีงบนั้นทุกช่อง
// ฐานทดสอบเท่านั้น: VG_KHD_MOCK_DB=khups_khd_mock_test node start-backend.js + ng serve :4520 — KHD จำลอง = ฐาน khups_khd_mock_test บนเครื่องทดสอบ
const path = require('path');
const fs = require('fs');
const { FE, VIEW, launch, guardContext, closeSwal, loginState } = require('./lib/browser');
const { withDb, resetSessions } = require('./lib/db');
const { PASSWORD } = require('./setup-data');

const MOCK = 'khups_khd_mock_test';
const YEAR = '2570';
const OUT = path.join(__dirname, 'cache', 'e2e-khd-sync');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const num = (v) => (v === null || v === undefined || v === '' ? null : String(v));

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    // ตัวชี้วัดตัวอย่าง 2 ตัวที่มีผลงานปีงบ 2570 และส่ง KHD ได้ — ลบตารางส่งออก/ตาราง KHD จำลองเดิม
    const picks = await withDb(async c => {
        const [rows] = await c.query(`SELECT i.id, i.kpi_indicators_name, REPLACE(TRIM(i.table_process), '-', '_') tp
                                      FROM kpi_indicators i JOIN kpi_results r ON r.indicator_id = i.id AND r.year_bh = ?
                                      WHERE i.is_active = 1 AND i.table_process <> '' AND IFNULL(i.upload_excel, 0) = 0
                                      GROUP BY i.id HAVING SUM(r.actual_value IS NOT NULL AND r.actual_value <> '') > 0
                                      ORDER BY i.id LIMIT 2`, [YEAR]);
        if (rows.length < 2) throw new Error('ต้องมีตัวชี้วัดตัวอย่างที่มีผลงาน 2570 อย่างน้อย 2 ตัว — รัน node setup-data.js up');
        if (new Set(rows.map(r => r.tp)).size < 2) throw new Error('ตัวชี้วัดตัวอย่างใช้ตารางเดียวกัน');
        for (const r of rows) {
            await c.query(`DROP TABLE IF EXISTS \`${r.tp}\``);
            await c.query(`DROP TABLE IF EXISTS \`${MOCK}\`.\`${r.tp}\``);
        }
        await c.query("DELETE FROM system_settings WHERE setting_key = 'khd_send_policy'");
        return rows;
    });
    const [A, B] = picks;
    console.log('ตัวชี้วัดทดสอบ:', picks.map(p => `${p.id} ${p.tp}`).join(', '));

    await resetSessions('test_vg_super_admin');
    const browser = await launch();
    const state = await loginState(browser, 'test_vg_super_admin', PASSWORD);
    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: state });
    await guardContext(ctx);
    await ctx.addInitScript(() => { try { const u = JSON.parse(localStorage.getItem('kpi_user') || 'null'); localStorage.setItem('kpi_mascot_assistant_off', '1'); if (u) localStorage.setItem('kpi_mascot_assistant_off_' + u.id, '1'); } catch (e) { } });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /GlobalErrorHandler|NG0/.test(m.text())) errs.push((results.length + ' ' + m.text()).slice(0, 1500)); });
    await page.goto(FE + '/kpi-manager');
    await page.waitForSelector('#kpi-export-table tr[data-ind]', { timeout: 60000 });
    await page.waitForTimeout(1500); await closeSwal(page);
    const yearSel = await page.locator('#export-year').inputValue();
    if (yearSel !== YEAR) { await page.selectOption('#export-year', YEAR); await page.waitForTimeout(1500); }

    // ===== 1) ตรวจสอบข้อมูล แล้วกด card ทุกใบ =====
    await page.click('button:has-text("ตรวจสอบข้อมูล")');
    await page.waitForSelector('.swal2-popup:has-text("ตรวจสอบเสร็จสิ้น")', { timeout: 300000 });
    const popup = ((await page.locator('.swal2-popup').textContent()) || '').replace(/\s+/g, ' ');
    await closeSwal(page);
    await page.waitForTimeout(500);
    const rowCount = () => page.locator('#kpi-export-table tr[data-ind]').count();
    const cardNum = async (k) => Number(((await page.locator(`#check-cards [data-card="${k}"] .text-3xl`).textContent()) || '').trim());
    const total = await cardNum('');
    check('card ตัวชี้วัดทั้งหมด = จำนวนแถวในตาราง', total === await rowCount(), `card ${total} / แถว ${await rowCount()}`);
    let sum = 0;
    const counts = {};
    for (const k of ['has_changes', 'up_to_date', 'no_data', 'not_exported', 'unchecked']) {
        const n = await cardNum(k);
        counts[k] = n; sum += n;
        await page.click(`#check-cards [data-card="${k}"]`);
        await page.waitForTimeout(300);
        const rows = await rowCount();
        const sel = ((await page.locator('text=/เลือกแล้ว \\d+/').first().textContent()) || '').match(/เลือกแล้ว (\d+)/);
        check(`card ${k} = จำนวนแถวที่กรองได้ และเลือกเฉพาะรายการนั้น`, n === rows && Number(sel && sel[1]) === n, `card ${n} / แถว ${rows} / เลือก ${sel && sel[1]}`);
        await page.click(`#check-cards [data-card="${k}"]`); // ยกเลิก
        await page.waitForTimeout(200);
    }
    check('ผลรวมทุกกลุ่ม = ตัวชี้วัดทั้งหมด', sum === total, `${sum} / ${total}`);
    check('หน้าต่างสรุปผลใช้ตัวเลขเดียวกับ card', popup.includes(`ตัวชี้วัดที่เพิ่ม/แก้ไข${counts.has_changes}`) || popup.includes(`ตัวชี้วัดที่เพิ่ม/แก้ไข ${counts.has_changes}`), popup.slice(0, 220));
    // เทียบกับฐานข้อมูลโดยตรง: ปิดส่งออก KHD = ตัวชี้วัด is_active ที่ upload_excel = 1
    const dbOff = await withDb(async c => (await c.query("SELECT COUNT(*) n FROM kpi_indicators WHERE is_active = 1 AND table_process IS NOT NULL AND table_process <> '' AND upload_excel = 1"))[0][0].n);
    check('card ปิดส่งออก KHD = จำนวนในฐานข้อมูล', Number(dbOff) === counts.not_exported, `ฐาน ${dbOff} / card ${counts.not_exported}`);
    check('หลังตรวจ ไม่เหลือ "ยังไม่ตรวจสอบ"', counts.unchecked === 0, String(counts.unchecked));
    // card ทำงานร่วมกับตัวกรองอื่น: ค้นหาตัวชี้วัด A
    await page.fill('#export-search', A.tp);
    await page.waitForTimeout(500);
    check('มีตัวกรองค้นหา: card ทั้งหมด = แถวที่แสดง', await cardNum('') === await rowCount(), `card ${await cardNum('')} / แถว ${await rowCount()}`);
    await page.screenshot({ path: path.join(OUT, '1-cards.png') });

    // ===== 2) เลือก A + B → ส่งออก → ส่งเข้า KHD ในหน้าเดียวกัน =====
    await page.fill('#export-search', '');
    await page.waitForTimeout(400);
    // เลือกเฉพาะ A และ B
    const allBox = page.locator('label:has-text("เลือกทั้งหมด") input[type=checkbox]').first();
    for (let i = 0; i < 3 && !((await page.locator('#btn-open-khd-sync').textContent()) || '').includes('(0)'); i++) {
        await allBox.click();
        await page.waitForTimeout(500);
    }
    for (const p of picks) await page.locator(`tr[data-ind="${p.id}"] input[type=checkbox]`).check();
    await page.waitForTimeout(500);
    check('เลือกแล้ว 2 รายการ', ((await page.locator('#btn-open-khd-sync').textContent()) || '').includes('(2)'));
    await page.click('button:has-text("ส่งออกข้อมูล (2)")');
    await page.click('.swal2-confirm');
    await page.waitForSelector('.swal2-popup:has-text("ส่งออกสำเร็จ")', { timeout: 120000 });
    await closeSwal(page);
    check('ไม่มีหน้าต่าง modal ส่ง KHD แบบเดิม', (await page.locator('.fixed.inset-0:has-text("ตรวจสอบตารางที่จะส่งออกไปยัง KHD")').count()) === 0);
    await page.click('#btn-open-khd-sync');
    await page.waitForSelector('#khd-sync-panel', { timeout: 10000 });
    await page.waitForSelector('#khd-sync-table, #khd-sync-empty', { timeout: 60000 });
    let panelRows = await page.locator('#khd-sync-table tr[data-sync]').evaluateAll(els => els.map(e => e.getAttribute('data-sync')));
    check('ขั้นที่ 5 แสดงในหน้าเดียวกัน เฉพาะตารางของตัวชี้วัดที่เลือก', panelRows.sort().join(',') === picks.map(p => p.tp).sort().join(','), panelRows.join(', '));
    const st = await page.locator('#khd-sync-table tr[data-sync] td:last-child').allTextContents();
    check('ตาราง KHD จำลองยังไม่มี = สถานะ ไม่มีใน KHD', st.every(t => t.includes('ไม่มีใน KHD')), st.map(s => s.trim()).join(' | '));
    await page.screenshot({ path: path.join(OUT, '2-panel-no-remote.png') });

    // สร้างตารางใน KHD ผ่านปุ่มในแถว (พิมพ์ยืนยัน)
    for (const p of picks) {
        await page.locator(`tr[data-ind="${p.id}"] [data-act="push"]`).click();
        await page.fill('.swal2-input', p.tp);
        await page.click('.swal2-confirm');
        await page.waitForSelector('.swal2-popup:has-text("ปรับตารางในKHDแล้ว")', { timeout: 30000 });
        await closeSwal(page);
    }
    await page.click('#btn-khd-sync-refresh');
    await page.waitForTimeout(3000);
    const st2 = await page.locator('#khd-sync-table tr[data-sync] td:last-child').allTextContents();
    check('หลังสร้างตารางใน KHD: ทั้ง 2 ตาราง พร้อมส่ง', st2.length === 2 && st2.every(t => t.includes('พร้อมส่ง')), st2.map(s => s.trim()).join(' | '));
    const localRows = await withDb(async c => {
        const out = {};
        for (const p of picks) out[p.tp] = Number((await c.query(`SELECT COUNT(*) n FROM \`${p.tp}\` WHERE byear = ?`, [YEAR]))[0][0].n);
        return out;
    });
    const shownLocal = await page.locator('#khd-sync-table tr[data-sync]').evaluateAll(els => els.map(e => [e.getAttribute('data-sync'), Number(e.children[2].textContent.trim())]));
    check('แถวในระบบที่แสดง = จำนวนแถวปีงบนี้ในตารางส่งออก', shownLocal.every(([t, n]) => localRows[t] === n), JSON.stringify(shownLocal));

    // เปลี่ยนรายการที่เลือก = ต้องตรวจใหม่ก่อนส่ง
    const other = await page.locator('#kpi-export-table tr[data-ind]').evaluateAll((els, ids) => els.map(e => Number(e.getAttribute('data-ind'))).find(id => !ids.includes(id)), picks.map(p => p.id));
    await page.locator(`tr[data-ind="${other}"] input[type=checkbox]`).check();
    await page.waitForTimeout(300);
    check('เปลี่ยนรายการที่เลือก → แจ้งให้ตรวจแผนใหม่ + ปุ่มส่งใช้ไม่ได้', (await page.locator('#khd-sync-stale').count()) === 1 && await page.locator('#btn-khd-sync-execute').isDisabled());
    await page.locator(`tr[data-ind="${other}"] input[type=checkbox]`).uncheck();
    await page.waitForTimeout(300);
    check('เลือกกลับเหมือนเดิม → ส่งได้', (await page.locator('#khd-sync-stale').count()) === 0 && !(await page.locator('#btn-khd-sync-execute').isDisabled()));

    // ส่งจริง (เข้า KHD จำลอง)
    await page.click('#btn-khd-sync-execute');
    check('หน้ายืนยันระบุปีงบ', ((await page.locator('.swal2-popup').textContent()) || '').includes(`ปีงบ ${YEAR}`));
    await page.click('.swal2-confirm');
    await page.waitForSelector('.swal2-popup:has-text("ส่งข้อมูลเสร็จสิ้น")', { timeout: 120000 });
    const done = ((await page.locator('.swal2-popup').textContent()) || '').replace(/\s+/g, ' ');
    await page.screenshot({ path: path.join(OUT, '3-sent.png') });
    await closeSwal(page);
    check('ผลส่ง: สำเร็จ 2 ตาราง', /2\s*สำเร็จ/.test(done), done.slice(0, 160));

    // ตรวจข้อมูลใน KHD จำลองเทียบตารางส่งออก ทุกแถวทุกช่อง (ปีงบ 2570) + ไม่มีปีอื่น
    await withDb(async c => {
        for (const p of picks) {
            const [cols] = await c.query(`SHOW COLUMNS FROM \`${MOCK}\`.\`${p.tp}\``);
            const names = cols.map(x => x.Field).filter(f => !['create_date', 'update_date'].includes(f));
            const sel = names.map(n => `\`${n}\``).join(', ');
            const [loc] = await c.query(`SELECT ${sel} FROM \`${p.tp}\` WHERE byear = ? ORDER BY hospcode`, [YEAR]);
            const [rem] = await c.query(`SELECT ${sel} FROM \`${MOCK}\`.\`${p.tp}\` ORDER BY hospcode`);
            let diff = 0;
            const remBy = new Map(rem.map(r => [`${r.hospcode}|${r.byear}`, r]));
            for (const l of loc) {
                const r = remBy.get(`${l.hospcode}|${l.byear}`);
                if (!r) { diff++; continue; }
                for (const n of names) if (num(l[n]) !== num(r[n]) && !(num(l[n]) === null)) diff++;
            }
            check(`${p.tp}: KHD มีแถวปีงบ ${YEAR} ครบตรงกับตารางส่งออกทุกช่อง`, rem.length === loc.length && diff === 0, `ระบบ ${loc.length} แถว / KHD ${rem.length} แถว / ต่าง ${diff} ช่อง`);
            check(`${p.tp}: KHD ไม่มีแถวปีงบอื่น`, rem.every(r => String(r.byear) === YEAR));
        }
    });
    // ตรวจแผนอีกครั้งหลังส่ง → ไม่มีแถวต้องเพิ่ม
    await page.waitForTimeout(2500);
    const plans = await page.locator('#khd-sync-table tr[data-sync] td:nth-child(6)').allTextContents();
    check('แผนหลังส่ง: ไม่มีแถวต้องเพิ่มแล้ว (+0)', plans.length === 2 && plans.every(t => t.includes('+0')), plans.map(s => s.replace(/\s+/g, ' ').trim()).join(' | '));
    check('ไม่มี error ใน console/หน้าเว็บ', errs.length === 0, errs.slice(0, 3).join(' | '));
    if (errs.length) fs.writeFileSync(path.join(OUT, 'errors.txt'), errs.join('\n\n'));

    await browser.close();
    const ok = results.filter(r => r.ok).length;
    console.log(`\nผล: ผ่าน ${ok}/${results.length}`);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
    process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error('ล้มเหลว:', e); process.exit(2); });
