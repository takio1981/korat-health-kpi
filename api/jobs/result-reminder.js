/**
 * แจ้งเตือนหน่วยบริการที่ยังไม่ส่งผลงาน (ระยะ 4 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 * ตรวจทุก 30 วินาที: ถึงวัน "กำหนดส่ง − k วัน" และเวลาที่ตั้ง (เวลาไทย) → เตือนผลงานของเดือนก่อนหน้า
 *   - ปีงบปัจจุบันเท่านั้น | ผู้รับแต่ละคนได้รายการเฉพาะตัวชี้วัดที่ยังไม่มีผลงานของหน่วยบริการ + กลุ่มงานตนเอง (assignPairs — 24 พ.ย. 2569)
 *   - ในระบบ: 1 แจ้งเตือนต่อผู้รับ (notifications ระดับ user_id) | LINE (sendLineToUser — เคารพสวิตช์ของผู้ใช้) | อีเมล
 *   - กันส่งซ้ำด้วย kpi_reminder_log (INSERT IGNORE ก่อนส่ง) | เพดานข้อความ LINE/อีเมลต่อรอบ (โควตา LINE)
 *   - สรุปผลถึง super_admin ในระบบ | ปิดอยู่ = ไม่ส่ง (ค่าตั้งต้นปิด)
 */
const db = require('../db');
const { sendLineToUser, sendMail } = require('../core/notify');
const wc = require('../services/work-center');
const fy = require('../core/fiscal-year');
const { thaiDateKey } = fy;
const { ROLE_SCOPE_OWN_DEPT } = require('../core/access');

const SEND_CONCURRENCY = 5;
// ผู้รับเตือน = ผู้ใช้/ผู้ดูแลของหน่วยบริการที่ยังไม่ส่ง (24 พ.ย. 2569 — เพิ่ม user_ssj/admin_ssj: บันทึกผลงานของหน่วยบริการตัวเอง)
const RECIPIENT_ROLES = ['user', 'user_hos', 'user_sso', 'user_cup', 'user_ssj', 'admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj'];
const MAX_NAMES = 10;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function logOnce(row) {
    const [r] = await db.query(
        'INSERT IGNORE INTO kpi_reminder_log (year_bh, month_bh, hospcode, user_id, channel, stage) VALUES (?, ?, ?, ?, ?, ?)',
        [row.year_bh, row.month_bh, row.hospcode, row.user_id || 0, row.channel, row.stage]);
    return r.affectedRows === 1;
}

/** ผู้รับของหน่วยบริการเหล่านี้ + กลุ่มงานที่รับผิดชอบ (กลุ่มงานหลัก + เพิ่มเติมที่อนุมัติแล้ว) */
async function loadRecipients(codes) {
    let users = [];
    for (let i = 0; i < codes.length; i += 1000) {
        const [u] = await db.query(
            `SELECT id, role, hospcode, dept_id, email FROM users WHERE hospcode IN (?) AND is_active = 1 AND is_approved = 1 AND role IN (?)`,
            [codes.slice(i, i + 1000), RECIPIENT_ROLES]);
        users = users.concat(u);
    }
    const extra = new Map();
    if (users.length) {
        try {
            const uids = users.map(u => u.id);
            for (let i = 0; i < uids.length; i += 1000) {
                const [r] = await db.query("SELECT user_id, dept_id FROM user_departments WHERE status = 'approved' AND user_id IN (?)", [uids.slice(i, i + 1000)]);
                for (const x of r) { if (!extra.has(x.user_id)) extra.set(x.user_id, []); extra.get(x.user_id).push(Number(x.dept_id)); }
            }
        } catch (_) { /* ยังไม่มีตาราง = กลุ่มงานหลักอย่างเดียว */ }
    }
    return users.map(u => ({
        ...u, hospcode: String(u.hospcode).trim(),
        deptIds: [...new Set([...(u.dept_id != null ? [Number(u.dept_id)] : []), ...(extra.get(u.id) || [])])],
    }));
}

/**
 * แบ่งคู่ที่ยังไม่ส่งให้ผู้รับแต่ละคน (ฟังก์ชันล้วน — 24 พ.ย. 2569 ผู้ใช้สั่ง: ส่งเฉพาะตัวชี้วัดของกลุ่มงาน + หน่วยบริการตนเอง)
 *   - หน่วยบริการ = hospcode ของผู้รับเท่านั้น (admin_cup ไม่ได้รับของทั้งอำเภอ)
 *   - role ใน ROLE_SCOPE_OWN_DEPT = เฉพาะตัวชี้วัดที่ dept_id อยู่ในกลุ่มงานของผู้รับ — ไม่มีกลุ่มงาน = ไม่ได้รับ (no_dept)
 *   - admin_hos/admin_sso/admin_cup = ทุกกลุ่มงานของหน่วยบริการตัวเอง (ตามขอบเขตสิทธิ์)
 * pairs = [{ indicator_id, hospcode }], deptOf = Map(indicator_id → dept_id | null)
 * → { perUser: [{ user, ids }], unassigned: จำนวนคู่ที่ไม่มีผู้รับ, noDept: จำนวนผู้ใช้ที่ไม่มีกลุ่มงาน }
 */
function assignPairs(pairs, recipients, deptOf) {
    const byHos = new Map();
    for (const u of recipients) { if (!byHos.has(u.hospcode)) byHos.set(u.hospcode, []); byHos.get(u.hospcode).push(u); }
    const lists = new Map();
    const noDept = new Set();
    let unassigned = 0;
    for (const p of pairs) {
        let got = false;
        for (const u of byHos.get(p.hospcode) || []) {
            if (ROLE_SCOPE_OWN_DEPT.includes(u.role)) {
                if (!u.deptIds.length) { noDept.add(u.id); continue; }
                const d = deptOf.get(p.indicator_id);
                if (d == null || !u.deptIds.includes(Number(d))) continue;
            }
            if (!lists.has(u.id)) lists.set(u.id, { user: u, ids: [] });
            lists.get(u.id).ids.push(p.indicator_id);
            got = true;
        }
        if (!got) unassigned++;
    }
    return { perUser: [...lists.values()], unassigned, noDept: noDept.size };
}

/**
 * ส่งเตือน 1 รอบ — opts = { yearBh, monthBh, stage, preview, now, settings, deps: { sendLine, sendEmail } (ชุดทดสอบ) }
 * ปีงบปัจจุบันเท่านั้น (เวลาไทย) — ปีอื่น = ไม่ส่ง (reason 'not_current_fy')
 * แต่ละผู้รับได้ 1 ข้อความ (ในระบบ/LINE/อีเมล) เฉพาะตัวชี้วัดที่ยังไม่มีผลงานของกลุ่มงาน + หน่วยบริการตนเอง
 * คืน { year_bh, month_bh, stage, hospitals, pairs, recipients, unassigned_pairs, no_dept_users, sent, skipped_duplicate, capped, sample }
 */
async function runResultReminders(opts = {}) {
    const cfg = opts.settings || await wc.getReminderSettings();
    const now = opts.now || new Date();
    const target = opts.yearBh && opts.monthBh ? { year_bh: String(opts.yearBh), month_bh: Number(opts.monthBh) } : wc.defaultTargetMonth(now);
    const stage = opts.stage || `m${thaiDateKey(now).replace(/-/g, '')}`; // สั่งส่งเอง = ครั้งเดียวต่อวัน
    const due = wc.dueDateOf(target.year_bh, target.month_bh, cfg.reminder_due_day);
    const left = wc.daysUntil(due, now);
    const label = wc.monthLabel(target.year_bh, target.month_bh);
    const curFy = String(fy.currentFiscalYear(now));
    const result = {
        year_bh: target.year_bh, month_bh: target.month_bh, month_label: label, stage, due_date: due, days_left: left, current_fy: curFy,
        hospitals: 0, pairs: 0, recipients: 0, unassigned_pairs: 0, no_dept_users: 0,
        sent: { inapp: 0, line: 0, email: 0 }, skipped_duplicate: 0, capped: 0, sample: [], channels: cfg.reminder_channels,
    };
    if (target.year_bh !== curFy) { result.reason = 'not_current_fy'; return result; }
    const { pairs } = await wc.findMissingPairs(null, target.year_bh, target.month_bh);
    const { ind, hos } = await wc.namesFor(pairs);
    const deptOf = new Map([...ind].map(([id, x]) => [id, x.dept_id == null ? null : Number(x.dept_id)]));
    const codes = [...new Set(pairs.map(p => p.hospcode))];
    const recipients = codes.length ? await loadRecipients(codes) : [];
    const { perUser, unassigned, noDept } = assignPairs(pairs, recipients, deptOf);
    const dueText = wc.thaiDateText(due);
    const when = left > 0 ? `กำหนดส่งภายใน ${dueText} (อีก ${left} วัน)` : left === 0 ? `กำหนดส่งวันนี้ (${dueText})` : `เลยกำหนดส่ง ${dueText} แล้ว`;
    const textFor = (u, ids) => {
        const names = ids.slice(0, MAX_NAMES).map(id => ind.get(id)?.kpi_indicators_name).filter(Boolean);
        const hn = hos.get(u.hospcode)?.hosname || u.hospcode;
        return `${hn}: ยังไม่ได้บันทึกผลงานเดือน ${label} (ปีงบ ${target.year_bh}) จำนวน ${ids.length} ตัวชี้วัดที่ท่านรับผิดชอบ — ${when}`
            + (names.length ? `\n${names.map(n => '• ' + n).join('\n')}${ids.length > names.length ? `\n… และอีก ${ids.length - names.length} ตัวชี้วัด` : ''}` : '');
    };
    const usersPerHos = new Map();
    for (const x of perUser) usersPerHos.set(x.user.hospcode, (usersPerHos.get(x.user.hospcode) || 0) + 1);
    const pairsPerHos = new Map();
    for (const p of pairs) pairsPerHos.set(p.hospcode, (pairsPerHos.get(p.hospcode) || 0) + 1);
    Object.assign(result, {
        hospitals: codes.length, pairs: pairs.length, recipients: perUser.length, unassigned_pairs: unassigned, no_dept_users: noDept,
        sample: [...pairsPerHos].slice(0, 10).map(([hc, n]) => ({ hospcode: hc, hosname: hos.get(hc)?.hosname || null, count: n, recipients: usersPerHos.get(hc) || 0 })),
    });
    if (opts.preview || !perUser.length) return result;

    const ch = cfg.reminder_channels || {};
    const sendLine = (opts.deps && opts.deps.sendLine) || sendLineToUser;
    const sendEmail = (opts.deps && opts.deps.sendEmail) || sendMail;
    const progress = opts.onProgress || (() => {});
    const prog = { recipients_done: 0, recipients_total: perUser.length, messages_done: 0, messages_total: 0 };
    progress(prog);
    // ขั้น 1: ในระบบ (แจ้งเตือนรายผู้ใช้) + จองสิทธิ์ส่ง (kpi_reminder_log) — งานฐานข้อมูลล้วน เร็ว
    let budget = Number(cfg.reminder_max_messages) || 0;
    const tasks = [];
    for (const { user: u, ids } of perUser) {
        const msg = textFor(u, ids);
        const base = { year_bh: target.year_bh, month_bh: target.month_bh, hospcode: u.hospcode, user_id: u.id, stage };
        if (ch.inapp) {
            if (await logOnce({ ...base, channel: 'inapp' })) {
                await db.query(
                    "INSERT INTO notifications (user_id, type, title, message, year_bh) VALUES (?, 'info', ?, ?, ?)",
                    [u.id, `เตือนส่งผลงานเดือน ${label}`, msg, target.year_bh]);
                result.sent.inapp++;
            } else result.skipped_duplicate++;
        }
        for (const c of ['line', 'email']) {
            if (!ch[c] || (c === 'email' && !u.email)) continue;
            if (budget <= 0) { result.capped++; continue; }
            if (!(await logOnce({ ...base, channel: c }))) { result.skipped_duplicate++; continue; }
            budget--;
            tasks.push({ c, u, msg });
        }
        prog.recipients_done++;
        prog.messages_total = tasks.length;
        progress(prog);
    }
    // ขั้น 2: ส่ง LINE/อีเมลพร้อมกันทีละ SEND_CONCURRENCY ข้อความ (เดิมส่งทีละข้อความ — หลายร้อยข้อความใช้เวลานานจน gateway 504)
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) {
            const { c, u, msg } = tasks[next++];
            try {
                if (c === 'line') { if (await sendLine(u.id, `[KHUPS KPI] ${msg}`)) result.sent.line++; }
                else {
                    await sendEmail(u.email, `[KHUPS KPI] เตือนส่งผลงานเดือน ${label}`,
                        `<p>${esc(msg).replace(/\n/g, '<br>')}</p><p style="color:#6b7280;font-size:12px">ระบบบันทึกผลงาน KPI ด้านสุขภาพ — สสจ.นครราชสีมา</p>`);
                    result.sent.email++;
                }
            } catch (e) { console.error(`[Reminder] ${c} failed:`, e.message); }
            prog.messages_done++;
            progress(prog);
        }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, tasks.length) }, worker));
    // สรุปถึงผู้ดูแลระบบสูงสุด (ในระบบ)
    try {
        const [sas] = await db.query("SELECT id FROM users WHERE role = 'super_admin' AND is_active = 1");
        for (const s of sas) {
            await db.query("INSERT INTO notifications (user_id, type, title, message, year_bh) VALUES (?, 'info', ?, ?, ?)",
                [s.id, `ส่งเตือนผลงานเดือน ${label} แล้ว`,
                 `หน่วยบริการที่ยังไม่ส่ง ${codes.length} แห่ง (${pairs.length} คู่) ผู้รับ ${perUser.length} คน${unassigned ? ` · ไม่มีผู้รับผิดชอบ ${unassigned} คู่` : ''} — ในระบบ ${result.sent.inapp} · LINE ${result.sent.line} · อีเมล ${result.sent.email}${result.capped ? ` · เกินเพดาน ${result.capped}` : ''}`,
                 target.year_bh]);
        }
    } catch (_) {}
    return result;
}

async function saveLastRun(res, manual) {
    const v = JSON.stringify({ ran_at: new Date().toISOString(), manual: !!manual, ...res, sample: undefined });
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('reminder_last_run', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [v]);
}

/**
 * สั่งส่งเตือนเอง = งานเบื้องหลัง (22 พ.ย. 2569 — production ได้ 504 ที่ POST /work-center/reminders/send-now:
 * ส่ง LINE/อีเมลหลายร้อยข้อความเกินเวลารอของ gateway) — คำขอคืนทันที หน้าจอดูความคืบหน้าที่ reminderJob()
 * ครั้งละงานเดียวต่อ process (กำลังทำอยู่ = REMINDER_BUSY) | after(result) = บันทึกผล/log หลังเสร็จ
 */
let _job = null;
let _jobSeq = 0;
function publicJob(j) {
    if (!j) return null;
    const { promise, ...rest } = j;
    return JSON.parse(JSON.stringify(rest));
}
function reminderJob() { return publicJob(_job); }
function startReminderJob(opts, after) {
    if (_job && _job.status === 'running') {
        const e = new Error('กำลังส่งเตือนอยู่ — รอให้รอบเดิมเสร็จก่อน');
        e.code = 'REMINDER_BUSY'; e.job = publicJob(_job);
        throw e;
    }
    const job = {
        id: ++_jobSeq, status: 'running', year_bh: String(opts.yearBh || ''), month_bh: Number(opts.monthBh) || null,
        user_id: opts.userId || null, started_at: new Date().toISOString(), finished_at: null,
        progress: { recipients_done: 0, recipients_total: 0, messages_done: 0, messages_total: 0 }, result: null, error: null,
    };
    _job = job;
    job.promise = (async () => {
        try {
            const r = await runResultReminders({ ...opts, onProgress: (p) => { job.progress = { ...p }; } });
            job.result = { ...r, sample: undefined };
            job.status = 'done';
            if (after) { try { await after(r); } catch (e) { console.error('[Reminder] after failed:', e.message); } }
        } catch (e) {
            job.status = 'failed'; job.error = e.message;
            console.error('[Reminder] manual run failed:', e.message);
        } finally { job.finished_at = new Date().toISOString(); }
    })();
    return job;
}

function startResultReminderScheduler() {
    let lastKey = null;
    const check = async () => {
        try {
            const cfg = await wc.getReminderSettings();
            const due = wc.isReminderDue({ enabled: cfg.reminder_enabled, due_day: cfg.reminder_due_day, days_before: cfg.reminder_days_before, time: cfg.reminder_time });
            if (!due) return;
            const key = `${due.year_bh}|${due.month_bh}|${due.stage}`;
            if (key === lastKey) return;
            lastKey = key;
            console.log(`[Reminder] 🚀 ส่งเตือนผลงานเดือน ${due.month_bh}/${due.year_bh} (${due.stage})`);
            const res = await runResultReminders({ yearBh: due.year_bh, monthBh: due.month_bh, stage: due.stage, settings: cfg });
            await saveLastRun(res, false);
        } catch (e) { console.error('[Reminder] check failed:', e.message); }
    };
    setInterval(check, 30000);
    console.log('[Reminder] result reminder scheduler started — check every 30s');
}

module.exports = { runResultReminders, assignPairs, startResultReminderScheduler, saveLastRun, RECIPIENT_ROLES, startReminderJob, reminderJob };
