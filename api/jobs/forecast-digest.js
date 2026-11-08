// ระบบเตือนล่วงหน้า ระยะที่ 3 (ข้อเสนอแนวคิด — 8 พ.ย. 2569): สรุปตัวชี้วัดเสี่ยงรายสัปดาห์ผ่านช่องทางแจ้งเตือนเดิม
//   - แจ้งเตือนในระบบ: super_admin = ภาพรวมทั้งจังหวัด, admin_ssj = เฉพาะหน่วยงานของตน (ผู้รับผิดชอบตัวชี้วัด)
//   - อีเมล / Telegram ไปยังผู้ดูแลตามการตั้งค่าแจ้งเตือนเดิม (getNotifSettings) — ภาพรวมทั้งจังหวัด
//   - เน้นระดับเสี่ยงสูง (ข้อเสนอแนวคิด 3.4 ข้อ 4: กันแจ้งเตือนมากเกินไป) — ไม่มีคู่เสี่ยงสูง/ขาดการรายงาน = ไม่ส่ง
// ตัวตั้งเวลาเช็คทุก 30 วินาที (แบบ jobs/kpi-audit.js) วันและเวลาตามการตั้งค่า (เวลาไทย) — รันใน process เดียวกับ server
const db = require('../db');
const { computeForecasts, summarizeByIndicator, summarizeByDistrict, currentFiscalYear, getForecastSettings } = require('../services/forecast');
const { getNotifSettings, sendMail, sendTelegramDirect } = require('../core/notify');

const LAST_RUN_KEY = 'forecast_digest_last_run';
const TOP_N = 10;
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** สร้างข้อความสรุป (ฟังก์ชันล้วน) จากผลคาดการณ์ — aiSummary (ระยะที่ 4) แนบท้ายเมื่อมี */
function buildDigest(fc, { dateStr, aiSummary } = {}) {
    const c = fc.counts;
    const topInd = summarizeByIndicator(fc.items, TOP_N).filter(x => x.high > 0 || x.no_report > 0);
    const topDist = summarizeByDistrict(fc.items, 5).filter(x => x.high > 0);
    const subject = `⚠️ สรุปตัวชี้วัดเสี่ยงรายสัปดาห์ ปีงบ ${fc.year_bh} (ข้อมูลถึง ${fc.through_label || '-'})`;
    const lines = [
        `⚠️ สรุปตัวชี้วัดเสี่ยงรายสัปดาห์ — ปีงบ ${fc.year_bh}`,
        `📅 ${dateStr || ''} · ใช้ข้อมูลถึงเดือน ${fc.through_label || '-'}`,
        `🔴 เสี่ยงสูง ${c.high} · 🟠 เฝ้าระวัง ${c.watch} · ⏳ ขาดการรายงาน ${c.no_report} · 🟢 ปกติ ${c.normal} (คู่ตัวชี้วัด×หน่วยบริการ)`,
    ];
    if (topInd.length) {
        lines.push('', 'ตัวชี้วัดที่มีหน่วยบริการเสี่ยงสูงมากที่สุด:');
        topInd.forEach((x, i) => lines.push(`${i + 1}. ${x.name} — เสี่ยงสูง ${x.high}${x.no_report ? ` · ขาดรายงาน ${x.no_report}` : ''}`));
    }
    if (topDist.length) lines.push('', 'อำเภอที่มีคู่เสี่ยงสูงมากที่สุด: ' + topDist.map(x => `${x.name} (${x.high})`).join(', '));
    if (aiSummary) lines.push('', '— สรุปโดย AI (โปรดตรวจสอบ) —', aiSummary);
    lines.push('', 'ดูรายละเอียด: เมนูรายงานสถิติ → แท็บ "ตัวชี้วัดเสี่ยง"');
    const text = lines.join('\n');
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px">${text.split('\n').map(l => (l ? esc(l) : '&nbsp;')).join('<br>')}</div>`;
    const tg = text.split('\n').map(esc).join('\n');
    return { subject, text, html, tg, topInd, topDist };
}

/** ข้อความแจ้งเตือนในระบบของหน่วยงาน (admin_ssj) — เฉพาะหน่วยงานที่มีคู่เสี่ยงสูง */
function buildDeptNotices(fc) {
    const byDept = new Map();
    for (const it of fc.items) {
        if (it.dept_id == null || it.status !== 'high') continue;
        const e = byDept.get(it.dept_id) || { dept_id: it.dept_id, dept_name: it.dept_name, high: 0, items: [] };
        e.high++;
        e.items.push(it);
        byDept.set(it.dept_id, e);
    }
    return [...byDept.values()].map(d => {
        const top = summarizeByIndicator(d.items, 5);
        return {
            dept_id: d.dept_id,
            title: `เตือนล่วงหน้า: ตัวชี้วัดเสี่ยงสูง ${d.high} คู่ (ปีงบ ${fc.year_bh})`,
            message: `${d.dept_name || 'หน่วยงานของคุณ'} — ค่าคาดการณ์ ณ สิ้นปีงบต่ำกว่าเป้าหมายเกิน ${fc.watch_pct}% (ข้อมูลถึง ${fc.through_label}): ` +
                top.map(x => `${x.name} (${x.high})`).join(', ') + ' — ดูที่รายงานสถิติ แท็บ "ตัวชี้วัดเสี่ยง"',
        };
    });
}

/**
 * รันสรุปรายสัปดาห์ — manual = สั่งจากหน้าตั้งค่า (ไม่ดูสวิตช์เปิด/ปิด), preview = สร้างข้อความอย่างเดียว ไม่ส่ง
 * opts.aiSummarize(fc) (ไม่บังคับ) = ฟังก์ชันสรุปด้วย AI (ระยะที่ 4) — ล้มเหลว = ส่งโดยไม่มีสรุป AI
 */
async function runForecastDigest({ manual = false, preview = false, now = new Date(), aiSummarize = null } = {}) {
    const cfg = await getForecastSettings(true);
    if (!manual && !cfg.digestEnabled) return { skipped: true, reason: 'disabled' };
    const fc = await computeForecasts({ c: [], p: [] }, { year: currentFiscalYear(now), now });
    const dateStr = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' }).format(now);
    if (fc.counts.high + fc.counts.no_report === 0) {
        const r = { skipped: true, reason: 'no_risk', year_bh: fc.year_bh, through_label: fc.through_label, counts: fc.counts, ran_at: now.toISOString(), manual };
        if (!preview) await saveLastRun(r);
        return r;
    }
    let aiSummary = null, aiError = null;
    if (cfg.digestAi && aiSummarize) {
        try { aiSummary = (await aiSummarize(fc)) || null; } catch (e) { aiError = e.message; }
    }
    const msg = buildDigest(fc, { dateStr, aiSummary });
    const notices = buildDeptNotices(fc);
    if (preview) return { preview: true, year_bh: fc.year_bh, counts: fc.counts, subject: msg.subject, text: msg.text, dept_notices: notices.length, ai_error: aiError };

    let inapp = 0, sentEmail = false, sentTelegram = false;
    if (cfg.digestInapp) {
        const [admins] = await db.query("SELECT id, role, dept_id FROM users WHERE is_active = 1 AND role IN ('super_admin','admin_ssj')");
        for (const u of admins) {
            const n = u.role === 'super_admin'
                ? { title: `เตือนล่วงหน้า: เสี่ยงสูง ${fc.counts.high} คู่ · ขาดการรายงาน ${fc.counts.no_report} คู่`, message: msg.text.split('\n').slice(2).join(' ').slice(0, 2000) }
                : notices.find(x => Number(x.dept_id) === Number(u.dept_id));
            if (!n) continue;
            await db.query("INSERT INTO notifications (user_id, type, title, message, year_bh) VALUES (?, 'info', ?, ?, ?)", [u.id, n.title.slice(0, 255), n.message, fc.year_bh]);
            inapp++;
        }
    }
    const ns = await getNotifSettings();
    if (cfg.digestEmail && ns.adminEmails) {
        for (const email of ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean)) {
            try { await sendMail(email, msg.subject, msg.html); sentEmail = true; } catch (e) { /* ช่องทางอื่นยังส่งต่อ */ }
        }
    }
    if (cfg.digestTelegram && ns.tgToken && ns.tgChatId) {
        try { sentTelegram = !!(await sendTelegramDirect(ns.tgToken, ns.tgChatId, msg.tg)); } catch (e) { /* ignore */ }
    }
    const r = { year_bh: fc.year_bh, through_label: fc.through_label, counts: fc.counts, inapp, sent_email: sentEmail, sent_telegram: sentTelegram, ai: !!aiSummary, ai_error: aiError, ran_at: now.toISOString(), manual };
    await saveLastRun(r);
    console.log(`[Forecast] digest sent — high ${fc.counts.high} / no_report ${fc.counts.no_report} (inapp:${inapp} email:${sentEmail} tg:${sentTelegram})`);
    return r;
}

async function saveLastRun(r) {
    await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [LAST_RUN_KEY, JSON.stringify(r)]);
}
async function getLastRun() {
    const [[row]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [LAST_RUN_KEY]);
    try { return row ? JSON.parse(row.setting_value) : null; } catch (e) { return null; }
}

/** ถึงเวลาส่งหรือไม่ (เวลาไทย) — วันตรง + เวลาอยู่ในช่วง 2 นาที + ยังไม่ส่งวันนี้ (ฟังก์ชันล้วน ทดสอบได้) */
function isDue(cfg, now, lastDateKey) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t) => parts.find(p => p.type === t)?.value;
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    const hh = get('hour') === '24' ? '00' : get('hour');
    const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
    if (!cfg.digestEnabled || dow !== cfg.digestDay || dateKey === lastDateKey) return { due: false, dateKey };
    const [th, tm] = cfg.digestTime.split(':').map(Number);
    const mins = Number(hh) * 60 + Number(get('minute'));
    const due = mins >= th * 60 + tm && mins <= th * 60 + tm + 1;
    return { due, dateKey };
}

function startForecastDigestScheduler(aiSummarize = null) {
    let lastDateKey = null;
    const check = async () => {
        try {
            const cfg = await getForecastSettings();
            const { due, dateKey } = isDue(cfg, new Date(), lastDateKey);
            if (!due) return;
            lastDateKey = dateKey;
            console.log(`[Forecast] 🚀 weekly digest triggered — ${dateKey}`);
            runForecastDigest({ aiSummarize }).catch(e => console.error('[Forecast] digest error:', e.message));
        } catch (e) { console.error('[Forecast] check failed:', e.message); }
    };
    setInterval(check, 30000);
    console.log('[Forecast] weekly digest scheduler started — check every 30s');
}

module.exports = { runForecastDigest, startForecastDigestScheduler, buildDigest, buildDeptNotices, isDue, getLastRun, LAST_RUN_KEY };
