// ระบบเตือนล่วงหน้า (ข้อเสนอแนวคิดการพัฒนา — 8 พ.ย. 2569) ระยะที่ 2: คาดการณ์ทุกคู่ตัวชี้วัด×หน่วยบริการของปีงบตามขอบเขตที่ผู้เรียกกำหนด
// แหล่งข้อมูล = kpi_summary (ตารางเดียวกับรายงาน — รวมผลงานข้อย่อย/กิจกรรมแล้ว) + คุณสมบัติตัวชี้วัด — การคาดการณ์อยู่ใน kpi-forecast.js (ไม่ใช้ AI)
// ผู้เรียกส่ง scope = { c: [...เงื่อนไข SQL], p: [...ค่า] } ที่อ้าง s.* / i.* (route: chartScopeClauses ของรายงาน, งานส่งสรุป: ตามหน่วยงานผู้รับ)
const db = require('../db');
const kpiFormula = require('../kpi-formula');
const { forecastPair, throughIndex, MONTH_KEYS, DEFAULTS } = require('../kpi-forecast');
const { zoneOfDistrict } = require('../core/zones');
const { loadBaseValues, baseKey } = require('./summary');

const FROM_SQL = `
    FROM kpi_summary s
    JOIN kpi_indicators i ON i.id = s.indicator_id
    LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
    LEFT JOIN main_yut y ON y.id = COALESCE(mi.yut_id, i.main_yut)`;
const MONTH_LABELS = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];
const STATUS_ORDER = { high: 0, watch: 1, no_report: 2, normal: 3, insufficient: 4, no_target: 5, unsupported: 6 };
const RISK_STATUSES = ['high', 'watch', 'no_report'];
const MAX_ITEMS = 3000;
const PERIODIC_MAX_MONTHS = 6; // ปีงบที่แล้วรายงานไม่ถึง 6 เดือน = ตัวชี้วัดรายงานเป็นรอบ (ไม่ตรวจขาดการรายงาน)

// ---- การตั้งค่า (system_settings) — เกณฑ์เฝ้าระวัง + สรุปรายสัปดาห์ (ระยะที่ 3) ----
const SETTING_KEYS = {
    forecast_watch_pct: '10',
    forecast_digest_enabled: 'false',
    forecast_digest_day: '1',          // 0 = อาทิตย์ … 6 = เสาร์ (ค่าตั้งต้น จันทร์)
    forecast_digest_time: '08:00',
    forecast_digest_email: 'true',
    forecast_digest_telegram: 'true',
    forecast_digest_inapp: 'true',
    forecast_digest_ai: 'false',
};
let _settingsCache = null, _settingsAt = 0;
async function getForecastSettings(force = false) {
    if (!force && _settingsCache && Date.now() - _settingsAt < 60000) return _settingsCache;
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [Object.keys(SETTING_KEYS)]);
    const raw = { ...SETTING_KEYS };
    for (const r of rows) if (r.setting_value !== null && r.setting_value !== undefined) raw[r.setting_key] = String(r.setting_value);
    const pct = Number(raw.forecast_watch_pct);
    const day = Number(raw.forecast_digest_day);
    _settingsCache = {
        watchPct: Number.isFinite(pct) && pct >= 1 && pct <= 50 ? pct : 10,
        digestEnabled: raw.forecast_digest_enabled === 'true',
        digestDay: Number.isInteger(day) && day >= 0 && day <= 6 ? day : 1,
        digestTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.forecast_digest_time) ? raw.forecast_digest_time : '08:00',
        digestEmail: raw.forecast_digest_email === 'true',
        digestTelegram: raw.forecast_digest_telegram === 'true',
        digestInapp: raw.forecast_digest_inapp === 'true',
        digestAi: raw.forecast_digest_ai === 'true',
    };
    _settingsAt = Date.now();
    return _settingsCache;
}
function invalidateForecastSettings() { _settingsCache = null; }
async function saveForecastSetting(key, value) {
    if (!(key in SETTING_KEYS)) throw new Error('unknown forecast setting ' + key);
    await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, String(value)]);
    invalidateForecastSettings();
}

/** ปีงบปัจจุบัน (พ.ศ.) — ต.ค. ขึ้นปีงบใหม่ (กติกาเดียวกับ getCurrentFiscalYear ฝั่ง frontend) */
function currentFiscalYear(now = new Date()) {
    return now.getFullYear() + 543 + (now.getMonth() + 1 >= 10 ? 1 : 0);
}

/**
 * คาดการณ์ทุกคู่ในขอบเขต
 * @param scope { c, p } เงื่อนไขขอบเขต (ต้องมีอย่างน้อย i.is_active = 1 จากผู้เรียกหรือเติมให้)
 * @param opts { year, now, watchPct, method, includeAll }
 */
async function computeForecasts(scope, opts = {}) {
    const now = opts.now || new Date();
    const settings = opts.watchPct ? null : await getForecastSettings();
    const watchPct = opts.watchPct || settings.watchPct;
    const year = String(opts.year || currentFiscalYear(now));
    if (!/^\d{4}$/.test(year)) { const e = new Error('ปีงบประมาณไม่ถูกต้อง'); e.status = 400; throw e; }
    const c = [...(scope.c || [])], p = [...(scope.p || [])];
    if (!c.some(x => /i\.is_active\s*=\s*1/.test(x))) c.push('i.is_active = 1');
    c.push('s.year_bh = ?'); p.push(year);

    const [rows] = await db.query(`
        SELECT s.indicator_id, s.hospcode, s.hosname, s.distid, s.distname, s.hostype, s.dept_id, s.dept_name, s.target_value,
               ${MONTH_KEYS.map(k => 's.' + k).join(', ')},
               i.kpi_indicators_name, i.target_condition, i.is_cumulative, i.result_formula, i.result_manual, i.target_monthly,
               mi.id AS main_id, mi.main_indicator_name, y.id AS yut_id, y.yut_name
        ${FROM_SQL} WHERE ${c.join(' AND ')}`, p);

    // เป้าหมายรายเดือน (เฉพาะตัวชี้วัดที่ตั้ง) — จาก kpi_results ของแต่ละเดือน
    const monthlyIds = [...new Set(rows.filter(r => r.target_monthly).map(r => Number(r.indicator_id)))];
    const monthlyTargets = new Map();
    if (monthlyIds.length) {
        const [tr] = await db.query('SELECT indicator_id, hospcode, month_bh, target_value FROM kpi_results WHERE year_bh = ? AND indicator_id IN (?)', [year, monthlyIds]);
        const idx = { 10: 0, 11: 1, 12: 2, 1: 3, 2: 4, 3: 5, 4: 6, 5: 7, 6: 8, 7: 9, 8: 10, 9: 11 };
        for (const t of tr) {
            const k = `${Number(t.indicator_id)}|${String(t.hospcode).trim()}`;
            if (!monthlyTargets.has(k)) monthlyTargets.set(k, Array(12).fill(''));
            const i = idx[Number(t.month_bh)];
            if (i !== undefined) monthlyTargets.get(k)[i] = t.target_value ?? '';
        }
    }
    // ค่าฐาน/ค่าเพิ่มเติม — เฉพาะตัวชี้วัดที่สูตรใช้
    const varIds = [...new Set(rows.filter(r => r.result_formula && kpiFormula.formulaVarNames(r.result_formula).length).map(r => Number(r.indicator_id)))];
    const vars = varIds.length ? await loadBaseValues(db, varIds, [year]) : new Map();

    // ดู ณ เดือนที่เลือก (ย้อนดูได้ไม่เกินเดือนล่าสุดที่ควรรายงานแล้ว) — ปีงบที่ปิดแล้วไม่ตรวจขาดการรายงาน (ข้อมูลจริงปีงบ 2569 ส่วนใหญ่หยุดที่ เม.ย.)
    const natural = throughIndex(year, now);
    const asked = opts.through === undefined || opts.through === null || opts.through === '' ? null : Number(opts.through);
    const through = Number.isInteger(asked) && asked >= 0 && asked <= natural ? asked : natural;
    const missingRun = through >= 11 ? 99 : DEFAULTS.missingRun;
    // ตัวชี้วัดรายงานเป็นรอบ (ประเมินปีละครั้ง/รายไตรมาส) — ข้อมูลจริงปีงบ 2569: 468 คู่มีผลงานเดือนเดียวทั้งปี (เช่น RDU) ถ้าตรวจขาดการรายงานจะเตือนผิดหลายร้อยคู่
    const periodic = new Set();
    const indIds = [...new Set(rows.map(r => Number(r.indicator_id)))];
    if (indIds.length && missingRun < 99) {
        const [pr] = await db.query(`SELECT indicator_id, ${MONTH_KEYS.join(', ')} FROM kpi_summary WHERE year_bh = ? AND indicator_id IN (?)`, [String(Number(year) - 1), indIds]);
        const maxMonths = new Map();
        for (const r of pr) {
            const n = MONTH_KEYS.filter(k => r[k] !== null && r[k] !== undefined && String(r[k]).trim() !== '').length;
            maxMonths.set(Number(r.indicator_id), Math.max(maxMonths.get(Number(r.indicator_id)) || 0, n));
        }
        for (const [id, n] of maxMonths) if (n > 0 && n < PERIODIC_MAX_MONTHS) periodic.add(id);
    }
    const counts = { high: 0, watch: 0, no_report: 0, normal: 0, insufficient: 0, no_target: 0, unsupported: 0 };
    const items = [];
    for (const r of rows) {
        const hc = String(r.hospcode || '').trim();
        const key = `${Number(r.indicator_id)}|${hc}`;
        const f = forecastPair({
            months: Object.fromEntries(MONTH_KEYS.map(k => [k, r[k]])),
            target: r.target_value, condition: r.target_condition, cumulative: r.is_cumulative,
            formula: r.result_formula, targetMonthly: r.target_monthly, targets: monthlyTargets.get(key),
            manual: Number(r.result_manual) === 1,
            vars: vars.get(baseKey(r.indicator_id, year, hc)),
        }, { through, method: opts.method || DEFAULTS.method, watchPct, missingRun: periodic.has(Number(r.indicator_id)) ? 99 : missingRun });
        counts[f.status] = (counts[f.status] || 0) + 1;
        if (!opts.includeAll && !RISK_STATUSES.includes(f.status)) continue;
        items.push({
            indicator_id: Number(r.indicator_id), indicator_name: r.kpi_indicators_name, result_formula: r.result_formula || null,
            hospcode: hc, hosname: r.hosname, distid: r.distid, distname: r.distname, zone: zoneOfDistrict(r.distid), hostype: r.hostype,
            dept_id: r.dept_id, dept_name: r.dept_name, main_id: r.main_id, main_name: r.main_indicator_name, yut_id: r.yut_id, yut_name: r.yut_name,
            last_actual: f.last_idx !== null ? String(r[MONTH_KEYS[f.last_idx]]) : null, last_month: f.last_idx !== null ? MONTH_LABELS[f.last_idx] : null,
            ...f, periodic: periodic.has(Number(r.indicator_id)),
        });
    }
    items.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.gap_pct || 0) - (a.gap_pct || 0)
        || String(a.indicator_name).localeCompare(String(b.indicator_name), 'th') || a.hospcode.localeCompare(b.hospcode));
    const pairs = rows.length;
    const forecastable = counts.high + counts.watch + counts.normal;
    return {
        year_bh: year, through, natural_through: natural, year_closed: natural >= 11, through_label: through >= 0 ? MONTH_LABELS[through] : null, method: opts.method || DEFAULTS.method, watch_pct: watchPct,
        pairs, forecastable, counts, periodic_indicators: periodic.size,
        risk_pct: forecastable ? Math.round(((counts.high + counts.watch) / forecastable) * 10000) / 100 : null,
        items: items.slice(0, MAX_ITEMS), truncated: items.length > MAX_ITEMS, total_items: items.length,
    };
}

/** สรุปตามตัวชี้วัด (เรียงตามจำนวนเสี่ยงสูง) — ใช้ในหน้าจอ สรุปรายสัปดาห์ และข้อมูลที่ส่งให้ AI */
function summarizeByIndicator(items, limit = 10) {
    const m = new Map();
    for (const it of items) {
        const e = m.get(it.indicator_id) || { indicator_id: it.indicator_id, name: it.indicator_name, dept_name: it.dept_name, high: 0, watch: 0, no_report: 0 };
        e[it.status] = (e[it.status] || 0) + 1;
        m.set(it.indicator_id, e);
    }
    return [...m.values()].sort((a, b) => b.high - a.high || b.watch - a.watch || b.no_report - a.no_report).slice(0, limit);
}
function summarizeByDistrict(items, limit = 10) {
    const m = new Map();
    for (const it of items) {
        if (!it.distid) continue;
        const e = m.get(it.distid) || { distid: it.distid, name: it.distname, high: 0, watch: 0, no_report: 0 };
        e[it.status] = (e[it.status] || 0) + 1;
        m.set(it.distid, e);
    }
    return [...m.values()].sort((a, b) => b.high - a.high || b.watch - a.watch).slice(0, limit);
}

module.exports = {
    PERIODIC_MAX_MONTHS, computeForecasts, summarizeByIndicator, summarizeByDistrict, currentFiscalYear,
    getForecastSettings, saveForecastSetting, invalidateForecastSettings, SETTING_KEYS, MONTH_LABELS, RISK_STATUSES,
};
