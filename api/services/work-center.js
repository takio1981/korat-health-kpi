/**
 * ศูนย์งานผู้ดูแล + แจ้งเตือนหน่วยบริการที่ยังไม่ส่งผลงาน (ระยะ 4 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 * ผู้ใช้เลือก: หน้าใหม่ในเมนูข้าง เปิดผู้ดูแลทุกระดับ | แจ้งเตือนในระบบ + LINE/อีเมลเดิม ตั้งค่า/ปิดได้ | กำหนดส่ง = วันที่ N ของเดือนถัดไป (ค่าตั้งต้น 10)
 *
 * "ยังไม่ส่งผลงานเดือน M" = คู่ตัวชี้วัด × หน่วยบริการที่มีแถวใน kpi_results ของปีงบ (ได้รับมอบหมายแล้ว) แต่เดือน M ผลงานว่าง
 *   (0 = บันทึกแล้ว) และไม่มีผลงานข้อย่อย/กิจกรรมของเดือนนั้น — ยกเว้น: ตัวชี้วัดกรอกผลงานเอง (ระดับปี),
 *   บันทึกรายไตรมาสในเดือนกลางไตรมาส, ตัวชี้วัดรายงานเป็นรอบ (ปีงบที่แล้วรายงานไม่ถึง 6 เดือน — กติกาเดียวกับระบบเตือนล่วงหน้า)
 */
const db = require('../db');
const { thaiNow, currentFiscalYear, fiscalMonthOrdinal } = require('../core/fiscal-year');
const { resultScopeFor } = require('./report-scope');
const { PERIODIC_MAX_MONTHS } = require('./forecast');

const MONTH_TH = { 1: 'ม.ค.', 2: 'ก.พ.', 3: 'มี.ค.', 4: 'เม.ย.', 5: 'พ.ค.', 6: 'มิ.ย.', 7: 'ก.ค.', 8: 'ส.ค.', 9: 'ก.ย.', 10: 'ต.ค.', 11: 'พ.ย.', 12: 'ธ.ค.' };
const SUMMARY_MONTH_COLS = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];

// ---------- กติกาวันที่ (ฟังก์ชันล้วน — เวลาไทย) ----------

/** ปี พ.ศ. ตามปฏิทินของเดือน month_bh ในปีงบ year_bh (ต.ค.–ธ.ค. = ปีก่อนหน้า) */
function calendarYearBE(yearBh, monthBh) {
    return Number(monthBh) >= 10 ? Number(yearBh) - 1 : Number(yearBh);
}
/** ปีงบของเดือนปฏิทิน (ปี พ.ศ.) */
function fiscalYearOf(calYearBE, month) {
    return Number(month) >= 10 ? Number(calYearBE) + 1 : Number(calYearBE);
}
/** เดือนที่ควรส่งผลงานแล้ว ณ วันนี้ = เดือนก่อนหน้า (เวลาไทย) → { year_bh, month_bh } */
function defaultTargetMonth(now = new Date()) {
    const t = thaiNow(now);
    let m = t.getUTCMonth() + 1, y = t.getUTCFullYear() + 543;
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    return { year_bh: String(fiscalYearOf(y, m)), month_bh: m };
}
/** กำหนดส่งผลงานเดือน month_bh = วันที่ dueDay ของเดือนถัดไป (เกินจำนวนวันของเดือน = วันสุดท้าย) → 'YYYY-MM-DD' (ค.ศ.) */
function dueDateOf(yearBh, monthBh, dueDay) {
    let y = calendarYearBE(yearBh, monthBh) - 543, m = Number(monthBh) + 1;
    if (m === 13) { m = 1; y += 1; }
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const d = Math.min(Math.max(1, Number(dueDay) || 10), last);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** จำนวนวันจากวันนี้ (เวลาไทย) ถึงวันกำหนดส่ง — ติดลบ = เลยกำหนด */
function daysUntil(dateKey, now = new Date()) {
    const today = thaiNow(now).toISOString().slice(0, 10);
    return Math.round((Date.UTC(...dateKey.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v)))) -
        Date.UTC(...today.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))))) / 86400000);
}
/** ข้อความวันที่ไทย '2026-11-10' → '10 พ.ย. 2569' */
function thaiDateText(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return `${d} ${MONTH_TH[m]} ${y + 543}`;
}
function monthLabel(yearBh, monthBh) {
    return `${MONTH_TH[Number(monthBh)]} ${calendarYearBE(yearBh, monthBh)}`;
}

/**
 * ถึงเวลาส่งเตือนไหม — cfg = { enabled, due_day, days_before: [3,1], time: 'HH:MM' }
 * วันนี้ (เวลาไทย) = กำหนดส่ง − k วัน (k ใน days_before) และเวลาอยู่ในช่วง 2 นาทีของ time → { year_bh, month_bh, stage: 'd<k>', due }
 */
function isReminderDue(cfg, now = new Date()) {
    if (!cfg || !cfg.enabled) return null;
    const t = thaiNow(now);
    const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
    const prev = new Date(t.getTime() - 60000);
    const hhmmPrev = `${String(prev.getUTCHours()).padStart(2, '0')}:${String(prev.getUTCMinutes()).padStart(2, '0')}`;
    if (cfg.time !== hhmm && cfg.time !== hhmmPrev) return null;
    const target = defaultTargetMonth(now);
    const due = dueDateOf(target.year_bh, target.month_bh, cfg.due_day);
    const left = daysUntil(due, now);
    if (!(cfg.days_before || []).includes(left)) return null;
    return { ...target, stage: `d${left}`, due };
}

// ---------- ค่าตั้งค่า ----------
const REMINDER_DEFAULTS = {
    reminder_enabled: false,
    reminder_due_day: 10,
    reminder_days_before: [3, 1],
    reminder_time: '09:00',
    reminder_channels: { inapp: true, line: true, email: true },
    reminder_max_messages: 500,
};
async function getReminderSettings() {
    const keys = Object.keys(REMINDER_DEFAULTS).concat('reminder_last_run');
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
    const raw = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    const s = JSON.parse(JSON.stringify(REMINDER_DEFAULTS));
    if (raw.reminder_enabled !== undefined) s.reminder_enabled = raw.reminder_enabled === 'true' || raw.reminder_enabled === '1';
    const dd = Number(raw.reminder_due_day);
    if (Number.isInteger(dd) && dd >= 1 && dd <= 28) s.reminder_due_day = dd;
    try { const v = JSON.parse(raw.reminder_days_before); if (Array.isArray(v)) s.reminder_days_before = v.filter(n => Number.isInteger(n) && n >= 0 && n <= 27); } catch (_) {}
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.reminder_time || '')) s.reminder_time = raw.reminder_time;
    try { const v = JSON.parse(raw.reminder_channels); if (v && typeof v === 'object') s.reminder_channels = { inapp: !!v.inapp, line: !!v.line, email: !!v.email }; } catch (_) {}
    const mx = Number(raw.reminder_max_messages);
    if (Number.isInteger(mx) && mx >= 0 && mx <= 5000) s.reminder_max_messages = mx;
    let last = null;
    try { last = raw.reminder_last_run ? JSON.parse(raw.reminder_last_run) : null; } catch (_) { last = null; }
    return { ...s, last_run: last };
}
/** ตรวจค่าที่ส่งมา (ไม่ส่ง = ไม่เปลี่ยน) → { values } | { error } */
function validateReminderSettings(b) {
    const out = {};
    if (!b || typeof b !== 'object') return { error: 'ข้อมูลไม่ถูกต้อง' };
    if (b.reminder_enabled !== undefined) {
        if (typeof b.reminder_enabled !== 'boolean') return { error: 'reminder_enabled ต้องเป็น true/false' };
        out.reminder_enabled = String(b.reminder_enabled);
    }
    if (b.reminder_due_day !== undefined) {
        const n = Number(b.reminder_due_day);
        if (!Number.isInteger(n) || n < 1 || n > 28) return { error: 'วันกำหนดส่งต้องเป็นวันที่ 1–28' };
        out.reminder_due_day = String(n);
    }
    if (b.reminder_days_before !== undefined) {
        const v = b.reminder_days_before;
        if (!Array.isArray(v) || v.length > 5 || !v.every(n => Number.isInteger(n) && n >= 0 && n <= 27)) return { error: 'วันก่อนกำหนดส่งต้องเป็นจำนวนเต็ม 0–27 ไม่เกิน 5 ค่า' };
        out.reminder_days_before = JSON.stringify([...new Set(v)].sort((a, c) => c - a));
    }
    if (b.reminder_time !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.reminder_time))) return { error: 'เวลาต้องอยู่ในรูปแบบ HH:MM' };
        out.reminder_time = String(b.reminder_time);
    }
    if (b.reminder_channels !== undefined) {
        const c = b.reminder_channels;
        if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'ช่องทางไม่ถูกต้อง' };
        out.reminder_channels = JSON.stringify({ inapp: !!c.inapp, line: !!c.line, email: !!c.email });
    }
    if (b.reminder_max_messages !== undefined) {
        const n = Number(b.reminder_max_messages);
        if (!Number.isInteger(n) || n < 0 || n > 5000) return { error: 'เพดานข้อความต่อรอบต้องเป็น 0–5000' };
        out.reminder_max_messages = String(n);
    }
    return { values: out };
}
async function saveSettings(values) {
    for (const [k, v] of Object.entries(values)) {
        await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [k, v]);
    }
}

// ---------- ผลงานที่ยังไม่ส่ง ----------
/**
 * คู่ที่ยังไม่ส่งผลงานเดือน month_bh ของปีงบ year_bh ตามขอบเขตผู้เรียก (user = null = ทั้งจังหวัด)
 * → { pairs: [{ indicator_id, hospcode }], excluded_indicators }
 */
async function findMissingPairs(user, yearBh, monthBh) {
    const scope = await resultScopeFor(user);
    const m = Number(monthBh);
    const [rows] = await db.query(
        `SELECT r.indicator_id, r.hospcode,
                MAX(CASE WHEN r.month_bh = ? AND TRIM(COALESCE(r.actual_value, '')) <> '' THEN 1 ELSE 0 END) AS has_m
         FROM kpi_results r JOIN kpi_indicators i ON i.id = r.indicator_id
         WHERE r.year_bh = ? AND ${scope.c.join(' AND ')}
           AND COALESCE(i.result_manual, 0) = 0
           AND NOT (COALESCE(i.quarter_mode, '') = 'quarter' AND ? NOT IN (12, 3, 6, 9))
         GROUP BY r.indicator_id, r.hospcode
         HAVING has_m = 0`,
        [m, String(yearBh), ...scope.p, m]);
    if (!rows.length) return { pairs: [], excluded_indicators: 0 };
    const indIds = [...new Set(rows.map(r => Number(r.indicator_id)))];
    // ผลงานข้อย่อย/กิจกรรมของเดือนนั้น = ส่งแล้ว
    const [subs] = await db.query(
        `SELECT DISTINCT si.indicator_id, sr.hospcode FROM kpi_sub_results sr JOIN kpi_sub_indicators si ON si.id = sr.sub_indicator_id
         WHERE sr.year_bh = ? AND sr.month_bh = ? AND si.indicator_id IN (?) AND TRIM(COALESCE(sr.actual_value, '')) <> ''
         UNION
         SELECT DISTINCT si.indicator_id, ar.hospcode FROM kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id
         JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id
         WHERE ar.year_bh = ? AND ar.month_bh = ? AND si.indicator_id IN (?) AND TRIM(COALESCE(ar.actual_value, '')) <> ''`,
        [String(yearBh), m, indIds, String(yearBh), m, indIds]);
    const viaSub = new Set(subs.map(r => `${Number(r.indicator_id)}|${String(r.hospcode).trim()}`));
    // ตัวชี้วัดรายงานเป็นรอบ (ปีงบที่แล้วหน่วยบริการที่รายงานมากที่สุด < 6 เดือน)
    const [pr] = await db.query(`SELECT indicator_id, ${SUMMARY_MONTH_COLS.map(c => `\`${c}\``).join(', ')} FROM kpi_summary WHERE year_bh = ? AND indicator_id IN (?)`,
        [String(Number(yearBh) - 1), indIds]);
    const maxMonths = new Map();
    for (const r of pr) {
        const n = SUMMARY_MONTH_COLS.filter(k => r[k] !== null && r[k] !== undefined && String(r[k]).trim() !== '').length;
        maxMonths.set(Number(r.indicator_id), Math.max(maxMonths.get(Number(r.indicator_id)) || 0, n));
    }
    const periodic = new Set([...maxMonths].filter(([, n]) => n > 0 && n < PERIODIC_MAX_MONTHS).map(([id]) => id));
    const pairs = rows
        .map(r => ({ indicator_id: Number(r.indicator_id), hospcode: String(r.hospcode).trim() }))
        .filter(p => !periodic.has(p.indicator_id) && !viaSub.has(`${p.indicator_id}|${p.hospcode}`));
    return { pairs, excluded_indicators: periodic.size };
}

async function namesFor(pairs) {
    const ids = [...new Set(pairs.map(p => p.indicator_id))];
    const codes = [...new Set(pairs.map(p => p.hospcode))];
    const ind = new Map(), hos = new Map();
    if (ids.length) {
        const [r] = await db.query(
            `SELECT i.id, i.kpi_indicators_name, i.result_formula, d.dept_name FROM kpi_indicators i LEFT JOIN departments d ON d.id = i.dept_id WHERE i.id IN (?)`, [ids]);
        for (const x of r) ind.set(Number(x.id), x);
    }
    for (let i = 0; i < codes.length; i += 1000) {
        const [r] = await db.query('SELECT hoscode, hosname, distid FROM chospital WHERE hoscode IN (?)', [codes.slice(i, i + 1000)]);
        for (const x of r) hos.set(String(x.hoscode).trim(), x);
    }
    return { ind, hos };
}

/** รายการที่ยังไม่ส่ง จัดกลุ่มรายหน่วยบริการ/รายตัวชี้วัด (≤ limit กลุ่ม) */
async function missingReport(user, yearBh, monthBh, group = 'hospital', limit = 500) {
    const { pairs, excluded_indicators } = await findMissingPairs(user, yearBh, monthBh);
    const { ind, hos } = await namesFor(pairs);
    const groups = new Map();
    for (const p of pairs) {
        const key = group === 'indicator' ? p.indicator_id : p.hospcode;
        if (!groups.has(key)) {
            groups.set(key, group === 'indicator'
                ? { indicator_id: p.indicator_id, indicator_name: ind.get(p.indicator_id)?.kpi_indicators_name || null,
                    dept_name: ind.get(p.indicator_id)?.dept_name || null, result_formula: ind.get(p.indicator_id)?.result_formula || null, count: 0, hospcodes: [] }
                : { hospcode: p.hospcode, hosname: hos.get(p.hospcode)?.hosname || null, distid: hos.get(p.hospcode)?.distid || null, count: 0, indicator_ids: [] });
        }
        const g = groups.get(key);
        g.count++;
        if (group === 'indicator') { if (g.hospcodes.length < 50) g.hospcodes.push(p.hospcode); }
        else if (g.indicator_ids.length < 100) g.indicator_ids.push(p.indicator_id);
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count);
    return {
        year_bh: String(yearBh), month_bh: Number(monthBh), month_label: monthLabel(yearBh, monthBh), group,
        totals: { pairs: pairs.length, hospitals: new Set(pairs.map(p => p.hospcode)).size, indicators: new Set(pairs.map(p => p.indicator_id)).size },
        excluded_periodic_indicators: excluded_indicators,
        items: list.slice(0, limit), truncated: list.length > limit,
    };
}

// ---------- คิวรอตรวจสอบ ----------
async function reviewCounts(user, yearBh, chartScope) {
    const [[s]] = await db.query(
        `SELECT COUNT(*) AS pairs, COALESCE(SUM(s.pending_count), 0) AS months
         FROM kpi_summary s JOIN kpi_indicators i ON i.id = s.indicator_id
         WHERE s.year_bh = ? AND s.pending_count > 0 AND ${chartScope.c.join(' AND ')}`, [String(yearBh), ...chartScope.p]);
    const rs = await resultScopeFor(user);
    const [[a]] = await db.query(
        `SELECT COUNT(DISTINCT r.indicator_id, r.hospcode) AS pairs FROM kpi_results r JOIN kpi_indicators i ON i.id = r.indicator_id
         WHERE r.year_bh = ? AND r.status = 'Appeal' AND ${rs.c.join(' AND ')}`, [String(yearBh), ...rs.p]);
    return { pending_pairs: Number(s.pairs) || 0, pending_months: Number(s.months) || 0, appeal_pairs: Number(a.pairs) || 0 };
}
async function reviewQueue(yearBh, chartScope, limit = 500) {
    const [rows] = await db.query(
        `SELECT s.indicator_id, s.hospcode, s.pending_count, i.kpi_indicators_name, i.result_formula, d.dept_name
         FROM kpi_summary s JOIN kpi_indicators i ON i.id = s.indicator_id LEFT JOIN departments d ON d.id = i.dept_id
         WHERE s.year_bh = ? AND s.pending_count > 0 AND ${chartScope.c.join(' AND ')}
         ORDER BY s.pending_count DESC, s.indicator_id, s.hospcode LIMIT ?`, [String(yearBh), ...chartScope.p, limit + 1]);
    const items = rows.slice(0, limit).map(r => ({ ...r, indicator_id: Number(r.indicator_id), hospcode: String(r.hospcode).trim(), pending_count: Number(r.pending_count) }));
    const { hos } = await namesFor(items.map(r => ({ indicator_id: r.indicator_id, hospcode: r.hospcode })));
    for (const r of items) r.hosname = hos.get(r.hospcode)?.hosname || null;
    // เดือนที่มีผลงานรอตรวจ (แถวหลัก) — ให้ผู้ดูแลเลือก "อนุมัติถึงเดือน" ได้ในหน้าศูนย์งาน
    if (items.length) {
        const [pm] = await db.query(
            `SELECT indicator_id, hospcode, GROUP_CONCAT(month_bh) AS ms FROM kpi_results
             WHERE year_bh = ? AND indicator_id IN (?) AND hospcode IN (?) AND status IN ('Pending', 'Resubmit')
               AND TRIM(COALESCE(actual_value, '')) <> '' GROUP BY indicator_id, hospcode`,
            [String(yearBh), [...new Set(items.map(r => r.indicator_id))], [...new Set(items.map(r => r.hospcode))]]);
        const pmMap = new Map(pm.map(x => [`${Number(x.indicator_id)}|${String(x.hospcode).trim()}`, x.ms]));
        for (const r of items) {
            const ms = String(pmMap.get(`${r.indicator_id}|${r.hospcode}`) || '').split(',').map(Number).filter(m => m >= 1 && m <= 12);
            r.pending_months = [...new Set(ms)].sort((a, b) => fiscalMonthOrdinal(a) - fiscalMonthOrdinal(b));
        }
    }
    return { items, truncated: rows.length > limit };
}

module.exports = {
    MONTH_TH, calendarYearBE, fiscalYearOf, defaultTargetMonth, dueDateOf, daysUntil, thaiDateText, monthLabel, isReminderDue,
    REMINDER_DEFAULTS, getReminderSettings, validateReminderSettings, saveSettings,
    findMissingPairs, missingReport, namesFor, reviewCounts, reviewQueue, currentFiscalYear, fiscalMonthOrdinal,
};
