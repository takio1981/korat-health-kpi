// ถ่ายวิดีโอ 1 หัวข้อ: เปิดหน้าเว็บจริง (ฐานทดสอบ) ทำตามขั้นตอน + คำบรรยายสลับเสียงหญิง/ชาย → รวมเป็น MP4
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FE, VIEW, guardContext, closeSwal } = require('./browser');
const { speech, FFMPEG } = require('./tts');
const overlayInit = require('./overlay');

const OUT = path.resolve(__dirname, '../../../videos');
const TMP = path.join(__dirname, '..', 'cache', 'rec');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeHelpers(page, warn) {
    const loc = (t) => {
        if (typeof t !== 'string') return t;            // locator ส่งมาเอง
        if (/^[#.\[]|^[a-z-]+[#.\[:]|^(button|a|input|select|table|thead|tbody|tr|td|th|h1|h2|h3|nav|aside|header|main|section|app-[a-z-]+)\b/.test(t)) { const m = t.match(/^(.*?)\s*>>\s*nth=(-?\d+)$/); const l = page.locator(m ? m[1] : t).filter({ visible: true }); return m ? l.nth(+m[2]) : l.first(); }
        return page.locator('button:visible, a:visible, [role=tab]:visible', { hasText: t }).first();
    };
    const box = async (l) => { await l.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {}); return l.boundingBox({ timeout: 4000 }); };
    const moveTo = async (b) => { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 }); };
    const ring = (b) => page.evaluate(r => window.__vg && window.__vg.ring(r), b).catch(() => {});
    const safe = (name, fn) => async (...a) => { try { return await fn(...a); } catch (e) { warn(`${name}(${String(a[0]).slice(0, 60)}): ${e.message.split('\n')[0]}`); } };
    const h = {
        page,
        wait: (ms) => sleep(ms),
        go: safe('go', async (p) => { await page.goto(FE + p); await page.waitForTimeout(2500); await closeSwal(page); }),
        point: safe('point', async (t, ms = 1800) => { const b = await box(loc(t)); if (!b) throw new Error('ไม่พบ'); await moveTo(b); await ring(b); await sleep(ms); await ring(null); }),
        click: safe('click', async (t, after = 1200) => {
            const l = loc(t); const b = await box(l); if (!b) throw new Error('ไม่พบ');
            await moveTo(b); await ring(b); await sleep(450); await ring(null);
            await l.click({ timeout: 5000 }); await sleep(after);
        }),
        type: safe('type', async (t, text, after = 600) => {
            const l = loc(t); const b = await box(l); if (b) { await moveTo(b); await ring(b); }
            await l.click({ timeout: 5000 }); await l.fill(''); await l.pressSequentially(String(text), { delay: 90 }); await ring(null); await sleep(after);
        }),
        select: safe('select', async (t, opt, after = 1200) => {
            const l = loc(t); const b = await box(l); if (b) { await moveTo(b); await ring(b); await sleep(500); await ring(null); }
            await l.selectOption(opt, { timeout: 5000 }); await sleep(after);
        }),
        scroll: safe('scroll', async (t, dy = 400) => {
            if (typeof t === 'number') { await page.mouse.wheel(0, t); await sleep(900); return; }
            await loc(t).scrollIntoViewIfNeeded({ timeout: 4000 }); await sleep(900);
        }),
        wheelIn: safe('wheelIn', async (t, dy) => { const b = await box(loc(t)); if (b) await moveTo(b); await page.mouse.wheel(0, dy); await sleep(900); }),
        key: safe('key', async (k, after = 800) => { await page.keyboard.press(k); await sleep(after); }),
        swal: () => closeSwal(page),
        /** ปิดหน้าต่าง (modal) ที่เปิดอยู่: Escape → กล่องข้อความ → ปุ่มปิด/กากบาทที่มองเห็น */
        closeModal: async () => {
            await page.keyboard.press('Escape').catch(() => {}); await sleep(400); await closeSwal(page, 2);
            for (const sel of ['.fixed button:has-text("ปิด")', '.fixed button:has(i.fa-times)', '.fixed button:has(i.fa-xmark)', 'button:has-text("ยกเลิก")']) {
                const l = page.locator(sel).filter({ visible: true }).first();
                if (await l.count().catch(() => 0)) { await l.click({ timeout: 3000 }).catch(() => {}); await sleep(500); break; }
            }
        },
        swalConfirm: safe('swalConfirm', async (after = 1500) => { const b = page.locator('.swal2-confirm:visible').first(); const bb = await box(b); if (bb) { await moveTo(bb); await sleep(300); } await b.click({ timeout: 5000 }); await sleep(after); }),
        exists: async (t) => { try { return (await loc(t).count()) > 0 && await loc(t).isVisible(); } catch { return false; } },
    };
    return h;
}

/**
 * spec = { id, title, kicker, role, roleLabel, start, storageState, steps: [{ say, do? }], outName }
 * คืน { file, ms, warnings }
 */
async function record(browser, spec) {
    fs.mkdirSync(TMP, { recursive: true });
    const warnings = [];
    const warn = (m) => { warnings.push(m); console.log('    ⚠', m); };
    // เตรียมเสียงก่อน — VG_VOICES=alt สลับหญิง/ชาย (เริ่มที่หญิง), ค่าตั้งต้น = เสียงชายทั้งคลิป (เสียงหญิงไทยของ Microsoft ใช้ไม่ได้ ณ 18 พ.ย. 2569)
const ALT = process.env.VG_VOICES === 'alt';
    const steps = [];
    for (const [i, s] of spec.steps.entries()) {
        const who = ALT ? (s.who || (i % 2 === 0 ? 'f' : 'm')) : 'm';
        steps.push({ ...s, who, audio: await speech(who, s.say) });
    }
    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: spec.storageState, recordVideo: { dir: TMP, size: VIEW } });
    await guardContext(ctx);
    await ctx.addInitScript(overlayInit);
    const page = await ctx.newPage();
    const t0 = Date.now();
    const h = makeHelpers(page, warn);
    if (spec.start) { await page.goto(FE + spec.start); await page.waitForTimeout(2500); await closeSwal(page); }
    if (spec.before) await spec.before(h);
    if (await page.locator('vite-error-overlay').count()) { await ctx.close(); throw new Error('frontend แสดง error overlay (คอมไพล์ไม่ผ่าน) — แก้โค้ดแล้วถ่ายใหม่'); }
    await page.evaluate(([k, t, s]) => window.__vg.card(k, t, s), [spec.kicker || 'คู่มือการใช้งาน Korat Health KPI', spec.title, spec.roleLabel]);
    await sleep(300);
    const tStart = Date.now() - t0;
    const cues = [];
    for (const [i, s] of steps.entries()) {
        const at = Date.now() - t0 - tStart;
        cues.push({ at, file: s.audio.file });
        await page.evaluate(([t, w]) => window.__vg && window.__vg.caption(t, w), [s.say, ALT ? s.who : '']).catch(() => {});
        if (!s.keepSwal) await closeSwal(page, 2); // ปิดกล่องข้อความที่ค้างจากขั้นก่อน (เว้นขั้นที่ตั้งใจกดในกล่อง)
        const act = (async () => { if (s.do) { try { await s.do(h); } catch (e) { warn('step ' + i + ': ' + e.message.split('\n')[0]); } } })();
        await Promise.all([act, sleep(s.audio.ms + 150)]);
        if (i === 0) await page.evaluate(() => window.__vg.card()).catch(() => {});
        await sleep(s.pause ?? 350);
    }
    await page.evaluate(() => { window.__vg.caption(); window.__vg.card('คู่มือการใช้งาน Korat Health KPI', 'จบวิดีโอ', 'ดูหัวข้ออื่นได้ที่เมนู คู่มือการใช้งาน'); }).catch(() => {});
    await sleep(2200);
    const total = Date.now() - t0 - tStart;
    if (await page.locator('vite-error-overlay').count()) { await ctx.close(); throw new Error('frontend แสดง error overlay ระหว่างถ่าย — ถ่ายใหม่'); }
    const video = page.video();
    await ctx.close();
    const raw = await video.path();

    // รวมภาพ + เสียง
    const out = path.join(OUT, spec.outName);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', (tStart / 1000).toFixed(3), '-i', raw];
    cues.forEach(c => args.push('-i', c.file));
    const filt = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at)}:all=1[a${i}]`).join(';')
        + ';' + cues.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad[aout]`;
    args.push('-filter_complex', filt, '-map', '0:v', '-map', '[aout]', '-t', (total / 1000).toFixed(3),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '27', '-pix_fmt', 'yuv420p', '-r', '25',
        '-c:a', 'aac', '-b:a', '80k', '-ac', '1', '-movflags', '+faststart', out);
    execFileSync(FFMPEG, args, { stdio: 'inherit' });
    fs.unlinkSync(raw);
    return { file: out, ms: total, size: fs.statSync(out).size, warnings };
}

module.exports = { record, OUT };
