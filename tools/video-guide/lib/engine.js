// ถ่ายวิดีโอ 1 หัวข้อ: เปิดหน้าเว็บจริง (ฐานทดสอบ) ทำตามขั้นตอน โดยมี "น้องคิดดี" เป็นผู้นำเสนอ → รวมเป็น MP4
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FE, VIEW, guardContext, closeSwal } = require('./browser');
const { speech, FFMPEG } = require('./tts');
const overlayInit = require('./overlay');

const OUT = path.resolve(__dirname, '../../..', process.env.VG_OUT || 'videos');
const TMP = path.join(__dirname, '..', 'cache', 'rec');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GREETING = 'สวัสดีครับ ผมน้องคิดดี ';
const OUTRO = 'ขอบคุณที่รับชมครับ ถ้ายังสงสัยตรงไหน ดูหัวข้ออื่นในคู่มือต่อได้เลยนะครับ';
const CARD_KICKER = 'คู่มือการใช้งาน Korat Health KPI';

/** ตรวจว่าจุดกลางของเป้าหมายมองเห็นจริงหรือมีสิ่งใดบังอยู่ (พื้นที่ด้านล่างสุดสงวนให้คำบรรยาย) */
function inspectTarget(el) {
    const SAFE_TOP = 56, SAFE_BOTTOM = window.innerHeight - 96;
    let r = el.getBoundingClientRect();
    const centerY = r.top + r.height / 2;
    if (r.height < window.innerHeight * 0.7 && (centerY < SAFE_TOP || centerY > SAFE_BOTTOM || r.left < 0 || r.right > window.innerWidth)) {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        r = el.getBoundingClientRect();
    }
    const x = Math.min(window.innerWidth - 2, Math.max(1, r.left + r.width / 2));
    const y = Math.min(window.innerHeight - 2, Math.max(1, r.top + r.height / 2));
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) return { ok: true };
    const describe = (n) => `${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}.${String(n.className || '').split(/\s+/).slice(0, 3).join('.')}`;
    if (top.closest('.swal2-container')) return { ok: false, kind: 'swal', by: describe(top) };
    const modal = top.closest('.fixed, [role=dialog]');
    if (modal) {
        const closer = [...modal.querySelectorAll('button')].find(b => b.offsetParent && (/^(ปิด|ยกเลิก)$/.test(b.innerText.trim()) || b.querySelector('.fa-times, .fa-xmark')));
        if (closer) { closer.setAttribute('data-vg-close', '1'); return { ok: false, kind: 'modal', by: describe(top) }; }
        return { ok: false, kind: 'modal-noclose', by: describe(top) };
    }
    return { ok: false, kind: 'other', by: describe(top) };
}

function makeHelpers(page, warn, uncovered) {
    const loc = (t) => {
        if (typeof t !== 'string') return t;            // locator ส่งมาเอง
        if (/^[#.\[]|^[a-z-]+[#.\[:]|^(button|a|input|select|table|thead|tbody|tr|td|th|h1|h2|h3|nav|aside|header|main|section|app-[a-z-]+)\b/.test(t)) {
            const m = t.match(/^(.*?)\s*>>\s*nth=(-?\d+)$/);
            const l = page.locator(m ? m[1] : t).filter({ visible: true });
            return m ? l.nth(+m[2]) : l.first();
        }
        return page.locator('button:visible, a:visible, [role=tab]:visible', { hasText: t }).first();
    };
    /** ทำให้เป้าหมายอยู่บนสุดก่อนวาดกรอบ: ปิดกล่องข้อความ/หน้าต่างที่ค้างบังอยู่ เลื่อนพ้นแถบที่ตรึงไว้ */
    const reveal = async (l, name) => {
        await l.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
        let st;
        for (let i = 0; i < 5; i++) {
            st = await l.evaluate(inspectTarget, undefined, { timeout: 4000 });
            if (st.ok) return true;
            if (i === 0) uncovered.push(`${String(name).slice(0, 40)} ← ${st.by}`);
            if (st.kind === 'swal') { await closeSwal(page, 2); await sleep(350); continue; }
            if (st.kind === 'modal') { await page.locator('[data-vg-close]').first().click({ timeout: 2000 }).catch(() => {}); await page.evaluate(() => document.querySelectorAll('[data-vg-close]').forEach(e => e.removeAttribute('data-vg-close'))).catch(() => {}); await sleep(450); continue; }
            await page.keyboard.press('Escape').catch(() => {}); await sleep(300);
            await l.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })).catch(() => {}); await sleep(200); // คอลัมน์ตรึงของตารางบังด้านซ้าย
        }
        warn(`ถูกบัง ${name}: ${st.by}`);
        return false;
    };
    const box = async (l, name) => { await reveal(l, name); return l.boundingBox({ timeout: 4000 }); };
    const moveTo = async (b) => { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 }); };
    const ring = (b) => page.evaluate(r => window.__vg && window.__vg.ring(r), b).catch(() => {});
    const safe = (name, fn) => async (...a) => { try { return await fn(...a); } catch (e) { warn(`${name}(${String(a[0]).slice(0, 60)}): ${e.message.split('\n')[0]}`); } };
    const h = {
        page,
        wait: (ms) => sleep(ms),
        go: safe('go', async (p) => { await page.goto(FE + p); await page.waitForTimeout(2500); await closeSwal(page); }),
        point: safe('point', async (t, ms = 1800) => { const b = await box(loc(t), t); if (!b) throw new Error('ไม่พบ'); await moveTo(b); await ring(b); await sleep(ms); await ring(null); }),
        click: safe('click', async (t, after = 1200) => {
            const l = loc(t); const b = await box(l, t); if (!b) throw new Error('ไม่พบ');
            await moveTo(b); await ring(b); await sleep(450); await ring(null);
            await l.click({ timeout: 5000 }); await sleep(after);
        }),
        type: safe('type', async (t, text, after = 600) => {
            const l = loc(t); const b = await box(l, t); if (b) { await moveTo(b); await ring(b); }
            await l.click({ timeout: 5000 }); await l.fill(''); await l.pressSequentially(String(text), { delay: 90 }); await ring(null); await sleep(after);
        }),
        select: safe('select', async (t, opt, after = 1200) => {
            const l = loc(t); const b = await box(l, t); if (b) { await moveTo(b); await ring(b); await sleep(500); await ring(null); }
            await l.selectOption(opt, { timeout: 5000 }); await sleep(after);
        }),
        scroll: safe('scroll', async (t) => {
            if (typeof t === 'number') { await page.mouse.wheel(0, t); await sleep(900); return; }
            await loc(t).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }), undefined, { timeout: 4000 }); await sleep(900);
        }),
        wheelIn: safe('wheelIn', async (t, dy) => { const b = await box(loc(t), t); if (b) await moveTo(b); await page.mouse.wheel(0, dy); await sleep(900); }),
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
        swalConfirm: safe('swalConfirm', async (after = 1500) => { const b = page.locator('.swal2-confirm:visible').first(); const bb = await b.boundingBox({ timeout: 4000 }); if (bb) { await moveTo(bb); await ring(bb); await sleep(300); await ring(null); } await b.click({ timeout: 5000 }); await sleep(after); }),
        exists: async (t) => { try { return (await loc(t).count()) > 0 && await loc(t).isVisible(); } catch { return false; } },
    };
    return h;
}

const speak = (page, text, audio) => page.evaluate(([t, env, ms]) => { if (!window.__vg) return; window.__vg.caption(t); window.__vg.say(env, ms); }, [text, audio.env, audio.ms]).catch(() => {});

/** คืนเวลา (วินาที) ของเฟรมที่จุด 4×4 มุมซ้ายบนเปลี่ยนสีดำ↔ขาว ในวิดีโอดิบ */
function detectMarkFlips(raw) {
    try {
        const buf = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', raw, '-vf', 'crop=2:2:1:1,format=gray', '-vsync', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
        let probe = '';
        try { execFileSync(FFMPEG, ['-hide_banner', '-i', raw], { stdio: 'pipe' }); } catch (e) { probe = String(e.stderr || ''); }
        const fps = Number((/([0-9.]+) fps/.exec(probe) || [])[1]) || 25;
        const out = []; let prev = null;
        for (let i = 0; i * 4 + 3 < buf.length; i++) {
            const v = (buf[i * 4] + buf[i * 4 + 1] + buf[i * 4 + 2] + buf[i * 4 + 3]) / 4;
            const bit = v > 160 ? 1 : v < 90 ? 0 : prev;
            if (prev !== null && bit !== prev) out.push(i / fps);
            prev = bit;
        }
        return out;
    } catch (e) { return null; }
}

/**
 * spec = { id, title, kicker, roleLabel, start, storageState, steps: [{ say, do?, keepSwal?, pause? }], outName, mascot }
 * คืน { file, ms, size, warnings }
 */
async function record(browser, spec) {
    fs.mkdirSync(TMP, { recursive: true });
    const warnings = [];
    const warn = (m) => { warnings.push(m); console.log('    ⚠', m); };
    // เตรียมเสียงก่อนถ่าย เพื่อรู้ความยาวของแต่ละขั้นตอน
    const steps = [];
    for (const [i, s] of spec.steps.entries()) {
        const say = i === 0 ? GREETING + s.say : s.say;
        steps.push({ ...s, say, audio: await speech(say) });
    }
    const outro = await speech(OUTRO);

    const ctx = await browser.newContext({ viewport: VIEW, locale: 'th-TH', storageState: spec.storageState, recordVideo: { dir: TMP, size: VIEW } });
    await guardContext(ctx);
    // ซ่อนผู้ช่วยน้องคิดดีของระบบ (ใส่ 20 พ.ย. 2569 — หลังวิดีโอชุดแรก) วิดีโอมีผู้นำเสนอของตัวเองแล้ว:
    // เดิมผู้ช่วยทักทายเมื่อเข้าหน้าใหม่ กล่องคำพูดค้างบังตาราง และมีตัวละคร 2 ตัวในภาพ (22 พ.ย. 2569) — ใช้กลไกซ่อนของผู้ใช้เอง (localStorage แยกตามบัญชี)
    await ctx.addInitScript(() => {
        try {
            const u = JSON.parse(localStorage.getItem('kpi_user') || 'null');
            localStorage.setItem('kpi_mascot_assistant_off', '1');
            if (u && u.id != null) localStorage.setItem('kpi_mascot_assistant_off_' + u.id, '1');
        } catch (e) { /* หน้าไม่มี localStorage */ }
    });
    await ctx.addInitScript(overlayInit, spec.mascot);
    // จุดสัญญาณเวลา (27 พ.ย. 2569): ภาพของ Playwright ยืดช้ากว่าเวลาจริงเมื่อหน้าเรนเดอร์หนัก (หน้ากราฟเลื่อน ~6 วินาที)
    // → สลับสีจุด 4×4 px มุมซ้ายบนทุกครั้งที่เริ่มคำบรรยาย แล้ววางเสียงตามเฟรมที่ตรวจพบในวิดีโอจริง ไม่ใช่เวลานาฬิกา
    await ctx.addInitScript(() => {
        // สีคงอยู่ข้ามการเปลี่ยนหน้า (sessionStorage) กันสัญญาณปลอมเมื่อขั้นตอนเปิดหน้าใหม่
        const paint = (c) => {
            let d = document.getElementById('__vg_mark');
            if (!d) { d = document.createElement('div'); d.id = '__vg_mark'; d.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;z-index:2147483647;pointer-events:none'; document.documentElement.appendChild(d); }
            d.style.background = c;
        };
        window.__vgMark = (c) => { try { sessionStorage.setItem('__vg_mark', c); } catch (e) { } paint(c); };
        const restore = () => { let c = null; try { c = sessionStorage.getItem('__vg_mark'); } catch (e) { } if (c) paint(c); };
        if (document.documentElement) restore(); else document.addEventListener('DOMContentLoaded', restore);
    });
    const page = await ctx.newPage();
    const t0 = Date.now();
    const uncovered = [];
    const h = makeHelpers(page, warn, uncovered);
    if (spec.start) { await page.goto(FE + spec.start); await page.waitForTimeout(2500); await closeSwal(page); }
    if (spec.before) await spec.before(h);
    if (await page.locator('vite-error-overlay').count()) { await ctx.close(); throw new Error('frontend แสดง error overlay (คอมไพล์ไม่ผ่าน) — แก้โค้ดแล้วถ่ายใหม่'); }
    await page.evaluate(([k, t, s]) => window.__vg.card(k, t, s), [spec.kicker || CARD_KICKER, spec.title, spec.roleLabel]);
    await sleep(700); // ให้ตัวละครเคลื่อนเข้าตำแหน่งก่อนเริ่มภาพ
    let markN = 0;
    const mark = () => page.evaluate((c) => { window.__vgMark(c); return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, (++markN) % 2 ? '#fff' : '#000').catch(() => {});
    await page.evaluate(() => window.__vgMark('#000')).catch(() => {}); // สร้างจุด (ดำ) ก่อนเริ่ม
    await sleep(400);
    await mark();               // สลับครั้งแรก = จุดเริ่มวิดีโอ
    const tStart = Date.now() - t0;
    const cues = [];
    for (const [i, s] of steps.entries()) {
        if (!s.keepSwal) await closeSwal(page, 2); // ปิดกล่องข้อความที่ค้างจากขั้นก่อน (เว้นขั้นที่ตั้งใจกดในกล่อง)
        await mark();
        cues.push({ at: Date.now() - t0 - tStart, file: s.audio.file });
        await speak(page, s.say, s.audio);
        const act = (async () => { if (s.do) { try { await s.do(h); } catch (e) { warn('step ' + i + ': ' + e.message.split('\n')[0]); } } })();
        await Promise.all([act, sleep(s.audio.ms + 150)]);
        if (i === 0) await page.evaluate(() => window.__vg.card()).catch(() => {});
        await sleep(s.pause ?? 350);
    }
    await page.evaluate(([k]) => window.__vg.card(k, 'ขอบคุณที่รับชมครับ', 'ดูหัวข้ออื่นได้ที่เมนู คู่มือการใช้งาน'), [CARD_KICKER]).catch(() => {});
    await sleep(500);
    await mark();
    cues.push({ at: Date.now() - t0 - tStart, file: outro.file });
    await speak(page, OUTRO, outro);
    await sleep(outro.ms + 900);
    await mark();               // สลับครั้งสุดท้าย = จุดจบวิดีโอ
    await sleep(300);
    let total = Date.now() - t0 - tStart;
    if (await page.locator('vite-error-overlay').count()) { await ctx.close(); throw new Error('frontend แสดง error overlay ระหว่างถ่าย — ถ่ายใหม่'); }
    const video = page.video();
    await ctx.close();
    const raw = await video.path();
    if (process.env.VG_DEBUG) {
        let probe = '';
        try { execFileSync(FFMPEG, ['-hide_banner', '-i', raw], { stdio: 'pipe' }); } catch (e) { probe = String(e.stderr || ''); }
        console.log('    [debug] wall', ((Date.now() - t0) / 1000).toFixed(1), 's, raw', (/Duration: ([0-9:.]+)/.exec(probe) || [])[1], 'cues', cues.map(c => (c.at / 1000).toFixed(1)).join(','));
    }

    // ตรวจเฟรมที่จุดสัญญาณสลับสี → เวลาในวิดีโอจริงของแต่ละคำบรรยาย (ตรวจไม่ครบ = ใช้เวลานาฬิกาเดิม + เตือน)
    let ss = tStart / 1000;
    const flips = detectMarkFlips(raw);
    const need = cues.length + 2;
    if (flips && flips.length >= need) {
        if (flips.length > need + 1) warn(`จุดสัญญาณเวลาเกิน (${flips.length}/${need}) — ใช้ชุดท้ายสุด`);
        const f = flips.slice(-need);
        const base = f[0];
        cues.forEach((c, i) => { c.at = Math.max(0, (f[i + 1] - base) * 1000); });
        ss = base; total = (f[need - 1] - base) * 1000;
        if (process.env.VG_DEBUG) console.log('    [debug] video cues', cues.map(c => (c.at / 1000).toFixed(1)).join(','), 'total', (total / 1000).toFixed(1));
    } else warn(`ตรวจจุดสัญญาณเวลาได้ ${flips ? flips.length : 0}/${need} — ใช้เวลานาฬิกา (เสียงอาจไม่ตรงภาพ)`);

    // รวมภาพ + เสียง
    const out = path.join(OUT, spec.outName);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', ss.toFixed(3), '-i', raw];
    cues.forEach(c => args.push('-i', c.file));
    const filt = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at)}:all=1[a${i}]`).join(';')
        + ';' + cues.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${cues.length}:normalize=0:dropout_transition=0,apad[aout]`;
    args.push('-filter_complex', filt, '-map', '0:v', '-map', '[aout]', '-t', (total / 1000).toFixed(3),
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '27', '-pix_fmt', 'yuv420p', '-r', '25',
        '-c:a', 'aac', '-b:a', '80k', '-ac', '1', '-movflags', '+faststart', out);
    execFileSync(FFMPEG, args, { stdio: 'inherit' });
    fs.unlinkSync(raw);
    return { file: out, ms: total, size: fs.statSync(out).size, warnings, uncovered };
}

module.exports = { record, OUT };
