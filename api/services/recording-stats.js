// รายงานสถิติ แถบ "กราฟและสถิติ" = รายงานการบันทึกผลงาน เชิงปริมาณ + คุณภาพ (28 พ.ย. 2569 — ผู้ใช้สั่ง แทนกราฟผ่าน/ไม่ผ่านเกณฑ์ทั้งหมด)
// หน่วยนับ = "คู่" ตัวชี้วัด × หน่วยบริการที่ต้องกรอก (มีแถวใน kpi_results ของปีงบ = ถูกเพิ่มตัวชี้วัดแล้ว) — ไม่ดูผ่าน/ไม่ผ่านเกณฑ์
//   ปริมาณ   : คู่ที่บันทึกแล้ว (มีผลงานอย่างน้อย 1 เดือน — รวมผลงานข้อย่อย/กิจกรรม/ผลงานที่กรอกเอง จาก kpi_summary) ÷ คู่ที่ต้องกรอก
//   ครบถ้วน  : ช่องเดือนที่ถึงกำหนดแล้ว (ต.ค. → เดือนก่อนเดือนปัจจุบัน = throughIndex) ที่มีผลงาน ÷ ช่องที่ถึงกำหนด
//              ไม่นับ: ตัวชี้วัดผลงานกรอกเอง (ไม่มีค่ารายเดือน), เดือนกลางไตรมาสของตัวชี้วัดบันทึกรายไตรมาส
//   ทันเวลา  : ช่องผลงาน (kpi_results) ที่บันทึกครั้งล่าสุดไม่เกินวันกำหนดส่ง (วันที่ N ของเดือนถัดไป — reminder_due_day ของศูนย์งานผู้ดูแล)
//              ⚠️ ใช้เวลา created_at ของแถว = เวลาบันทึกครั้งล่าสุด (บันทึกซ้ำภายหลัง = นับว่าช้า) ผลงานข้อย่อยไม่นับในข้อนี้
//   ตรวจสอบ  : ช่องผลงานตามสถานะ อนุมัติ (ล็อค) / รอตรวจสอบ / ส่งกลับแก้ไข (Resubmit/Rejected)
//   ผิดปกติ  : ช่องที่ตัวตรวจคุณภาพข้อมูลแบบกฎเตือน (services/data-quality evaluatePairs — ตัวเดียวกับหน้าจัดการข้อมูลผลงาน)
const db = require('../db');
const { resultScopeFor } = require('./report-scope');
const { throughIndex } = require('../kpi-forecast');
const { evaluatePairs } = require('./data-quality');
const { getReminderSettings, dueDateOf } = require('./work-center');
const { ITYPE_KEYS, ITYPE_LABELS } = require('./indicator-types');

const MONTH_KEYS = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
const MONTH_LABELS = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];
const MONTH_BH = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const QUARTER_END = new Set([2, 5, 8, 11]);   // ธ.ค. มี.ค. มิ.ย. ก.ย. (ลำดับปีงบ)
const fiscalIdx = (monthBh) => (Number(monthBh) + 2) % 12;
const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const pct = (n, d) => (d > 0 ? Math.round(n / d * 10000) / 100 : null);

/** สถิติของคู่ 1 คู่ (ฟังก์ชันล้วน) — p: { cells: [{ m, f, st, lk, ts }], months: {oct…}|null, last: ค่าผลงานล่าสุด, manual, quarter, anomalies } */
function pairStats(p, ctx) {
    const cellByM = new Map();
    for (const c of p.cells || []) cellByM.set(c.m, c);
    const has = (m) => filled(p.months ? p.months[MONTH_KEYS[m]] : null) || !!cellByM.get(m)?.f;
    const recorded = filled(p.last) || (p.cells || []).some(c => c.f) || (p.months ? MONTH_KEYS.some(k => filled(p.months[k])) : false);
    let due = 0, dueFilled = 0;
    const monthDue = [], monthFilled = [];
    for (let m = 0; m < 12; m++) {
        const eligible = !p.manual && !(p.quarter && !QUARTER_END.has(m));
        const isDue = eligible && m <= ctx.through;
        const h = eligible && has(m);
        monthDue.push(isDue ? 1 : 0); monthFilled.push(h ? 1 : 0);
        if (isDue) { due++; if (h) dueFilled++; }
    }
    let cellsFilled = 0, onTime = 0, timed = 0, approved = 0, pending = 0, returned = 0;
    for (const c of p.cells || []) {
        if (!c.f) continue;
        cellsFilled++;
        if (c.lk || c.st === 'Approved') approved++;
        else if (c.st === 'Resubmit' || c.st === 'Rejected') returned++;
        else pending++;
        if (c.m <= ctx.through && ctx.dueTs && ctx.dueTs[c.m] && c.ts) { timed++; if (c.ts <= ctx.dueTs[c.m]) onTime++; }
    }
    return { recorded, due, dueFilled, monthDue, monthFilled, cellsFilled, timed, onTime, approved, pending, returned, anomalies: p.anomalies || 0 };
}

function emptyAgg(key, name) {
    return { gkey: key, gname: name, pairs: 0, recorded_pairs: 0, due_cells: 0, filled_due_cells: 0, filled_cells: 0, timed_cells: 0, ontime_cells: 0,
        approved_cells: 0, pending_cells: 0, returned_cells: 0, anomaly_cells: 0, _hos: new Set(), _ind: new Set() };
}
function addAgg(g, p, s) {
    g.pairs++; if (s.recorded) g.recorded_pairs++;
    g.due_cells += s.due; g.filled_due_cells += s.dueFilled;
    g.filled_cells += s.cellsFilled; g.timed_cells += s.timed; g.ontime_cells += s.onTime;
    g.approved_cells += s.approved; g.pending_cells += s.pending; g.returned_cells += s.returned; g.anomaly_cells += s.anomalies;
    g._hos.add(p.hospcode); g._ind.add(p.indicator_id);
}
function finishAgg(g) {
    const { _hos, _ind, ...r } = g;
    r.hospital_count = _hos.size; r.indicator_count = _ind.size;
    r.not_recorded_pairs = r.pairs - r.recorded_pairs;
    r.recording_pct = pct(r.recorded_pairs, r.pairs) ?? 0;
    r.completeness_pct = pct(r.filled_due_cells, r.due_cells);
    r.timeliness_pct = pct(r.ontime_cells, r.timed_cells);
    r.approved_pct = pct(r.approved_cells, r.filled_cells);
    return r;
}
function groupBy(list, keyOf, nameOf, extra) {
    const m = new Map();
    for (const { p, s } of list) {
        const keys = [].concat(keyOf(p));
        for (const k of keys) {
            const key = k == null || k === '' ? '0' : String(k);
            let g = m.get(key);
            if (!g) { g = emptyAgg(key, nameOf(p, key) || 'ไม่ระบุ'); if (extra) extra(g, p); m.set(key, g); }
            addAgg(g, p, s);
        }
    }
    return [...m.values()].map(finishAgg);
}

/**
 * คำนวณรายงานการบันทึกจากรายการคู่ (ฟังก์ชันล้วน — ทดสอบได้)
 * pairs: [{ indicator_id, hospcode, ind_name, dept_id, dept_name, main_id, main_name, yut_id, yut_name, result_formula, itypes: [],
 *           distid, distname, zone, hostype, hostype_name, hosname, manual, quarter, cells, months, last, anomalies }]
 * ctx: { through, dueTs: [YYYYMMDDhhmmss สิ้นวันกำหนดส่งของเดือนลำดับ 0–11] } — cell.ts = เวลาบันทึกแบบเดียวกัน
 */
function computeRecordingStats(pairs, ctx) {
    const list = pairs.map(p => ({ p, s: pairStats(p, ctx) }));
    const overall = finishAgg(list.reduce((g, { p, s }) => { addAgg(g, p, s); return g; }, emptyAgg('all', 'ทั้งหมด')));
    const byIndicator = groupBy(list, p => p.indicator_id, p => p.ind_name, (g, p) => {
        g.dept_name = p.dept_name || ''; g.main_indicator_name = p.main_name || ''; g.result_formula = p.result_formula || null;
    }).map(r => ({ ...r, gkey: Number(r.gkey) }));
    const byHospital = groupBy(list, p => p.hospcode, p => p.hosname || p.hospcode, (g, p) => {
        g.hospcode = p.hospcode; g.distname = p.distname || ''; g.hostype_name = p.hostype_name || '';
    });
    const months = MONTH_KEYS.map((key, m) => {
        let due = 0, dueFilled = 0, cells = 0, timed = 0, onTime = 0, pairsFilled = 0;
        for (const { p, s } of list) {
            due += s.monthDue[m]; if (s.monthDue[m] && s.monthFilled[m]) dueFilled++;
            if (s.monthFilled[m]) pairsFilled++;
            const c = (p.cells || []).find(x => x.m === m);
            if (c && c.f) { cells++; if (m <= ctx.through && ctx.dueTs?.[m] && c.ts) { timed++; if (c.ts <= ctx.dueTs[m]) onTime++; } }
        }
        return { month: key, label: MONTH_LABELS[m], is_due: m <= ctx.through, due_pairs: due, filled_due_pairs: dueFilled, filled_pairs: pairsFilled,
            completeness_pct: pct(dueFilled, due), filled_cells: cells, timed_cells: timed, ontime_cells: onTime, timeliness_pct: pct(onTime, timed) };
    });
    // แผนที่ความร้อน กลุ่มงาน × เดือน = ความครบถ้วน (ช่องที่มีผลงาน ÷ คู่ที่ต้องรายงานเดือนนั้น)
    const heat = (keyOf, nameOf) => {
        const m = new Map();
        for (const { p, s } of list) {
            const key = String(keyOf(p) ?? '0');
            let g = m.get(key);
            if (!g) { g = { gkey: key, gname: nameOf(p) || 'ไม่ระบุ', months: MONTH_KEYS.map(() => ({ due: 0, filled: 0 })) }; m.set(key, g); }
            for (let i = 0; i < 12; i++) { g.months[i].due += s.monthDue[i]; if (s.monthDue[i] && s.monthFilled[i]) g.months[i].filled++; }
        }
        return [...m.values()].map(g => ({ gkey: g.gkey, gname: g.gname, months: g.months.map((x, i) => ({ month: MONTH_KEYS[i], label: MONTH_LABELS[i], due: x.due, filled: x.filled, pct: pct(x.filled, x.due) })) }))
            .sort((a, b) => a.gname.localeCompare(b.gname, 'th'));
    };
    const itypeName = (k) => (k === 'none' ? 'ไม่ระบุประเภท' : (ITYPE_LABELS[k] || k));
    const byItype = groupBy(list, p => (p.itypes && p.itypes.length ? p.itypes : ['none']), (p, k) => itypeName(k));
    // ครบทุกประเภท แม้ไม่มีข้อมูล (การ์ดแสดงครบ)
    for (const k of ITYPE_KEYS) if (!byItype.some(r => r.gkey === k)) byItype.push(finishAgg(emptyAgg(k, itypeName(k))));
    const ordI = (k) => { const i = ITYPE_KEYS.indexOf(k); return i < 0 ? 99 : i; };
    byItype.sort((a, b) => ordI(a.gkey) - ordI(b.gkey));
    const byRec = (a, b) => a.recording_pct - b.recording_pct || (a.completeness_pct ?? 0) - (b.completeness_pct ?? 0) || String(a.gname).localeCompare(String(b.gname), 'th');
    // การกระจายของหน่วยบริการตามร้อยละการบันทึก
    const buckets = [['0', 'ยังไม่บันทึก (0%)', v => v <= 0], ['1-49', '1–49%', v => v > 0 && v < 50], ['50-79', '50–79%', v => v >= 50 && v < 80], ['80-99', '80–99%', v => v >= 80 && v < 100], ['100', 'ครบ 100%', v => v >= 100]];
    const distribution = buckets.map(([key, label, fn]) => ({ key, label, count: byHospital.filter(h => fn(h.recording_pct)).length }));
    return {
        overall,
        months,
        by_dept: groupBy(list, p => p.dept_id, p => p.dept_name).sort(byRec),
        by_main: groupBy(list, p => p.main_id, p => p.main_name).sort(byRec),
        by_yut: groupBy(list, p => p.yut_id, p => p.yut_name).sort(byRec),
        by_indicator: byIndicator.sort(byRec),
        by_district: groupBy(list, p => p.distid, p => p.distname).sort(byRec),
        by_zone: groupBy(list, p => p.zone, p => (p.zone ? 'โซน ' + p.zone : 'ไม่ระบุโซน')).sort((a, b) => Number(a.gkey) - Number(b.gkey)),
        by_hostype: groupBy(list, p => p.hostype, p => p.hostype_name || p.hostype).sort(byRec),
        by_itype: byItype,
        by_hospital: byHospital.sort(byRec),
        hospital_distribution: distribution,
        heatmap_dept: heat(p => p.dept_id, p => p.dept_name),
    };
}

// ---------------- โหลดข้อมูล ----------------
const NAME_SQL = {
    dept: 'SELECT id, dept_name AS name FROM departments',
    main: 'SELECT id, main_indicator_name AS name, yut_id FROM kpi_main_indicators',
    yut: 'SELECT id, yut_name AS name FROM main_yut',
};

/** สิ้นวันกำหนดส่งของแต่ละเดือนลำดับปีงบ → ตัวเลข YYYYMMDDhhmmss (เทียบกับ created_at แบบเดียวกัน — เวลาของฐานข้อมูล ไม่แปลง timezone) */
function dueTimestamps(yearBh, dueDay) {
    return MONTH_BH.map(mb => Number(dueDateOf(yearBh, mb, dueDay).replace(/-/g, '') + '235959'));
}

/**
 * โหลด + คำนวณตามขอบเขตผู้เรียก — q: { year_bh, dept_id, yut_id, main_id, indicator_id, zone, distid, hostype, itype }
 * ตัวกรองทั้งหมดทำในหน่วยความจำหลังโหลดตามขอบเขต (ตัวเลือก dropdown = ทุกค่าที่อยู่ในขอบเขต + ปีงบ ไม่ขึ้นกับตัวกรองอื่น)
 */
async function loadRecordingStats(user, q = {}, now = new Date()) {
    const { c, p } = await resultScopeFor(user);
    const [yrs] = await db.query(`SELECT DISTINCT r.year_bh FROM kpi_results r JOIN kpi_indicators i ON i.id = r.indicator_id WHERE ${c.join(' AND ')} ORDER BY r.year_bh DESC`, p);
    const years = yrs.map(r => String(r.year_bh));
    const year = String(q.year_bh || years[0] || '');
    const empty = { year_bh: year, through: -1, due_day: null, options: { years, depts: [], mains: [], yuts: [], indicators: [], districts: [], zones: [], hostypes: [] } };
    if (!year) return { ...empty, ...computeRecordingStats([], { through: -1, dueTs: [] }) };

    const [rows] = await db.query(`
        SELECT r.indicator_id, r.hospcode,
               MAX(i.kpi_indicators_name) AS ind_name, MAX(i.dept_id) AS dept_id, MAX(i.main_indicator_id) AS main_id,
               MAX(COALESCE(mi.yut_id, i.main_yut)) AS yut_id, MAX(i.result_formula) AS result_formula,
               MAX(COALESCE(i.result_manual, 0)) AS manual, MAX(i.quarter_mode) AS quarter_mode,
               MAX(i.r9) AS r9, MAX(i.moph) AS moph, MAX(i.ssj) AS ssj, MAX(i.rmw) AS rmw, MAX(i.other) AS other,
               GROUP_CONCAT(CONCAT(r.month_bh, '|', IF(NULLIF(TRIM(r.actual_value), '') IS NULL, 0, 1), '|', IFNULL(r.status, ''), '|', IFNULL(r.is_locked, 0), '|', IFNULL(DATE_FORMAT(r.created_at, '%Y%m%d%H%i%s'), 0)) SEPARATOR ';') AS cells
        FROM kpi_results r
        JOIN kpi_indicators i ON i.id = r.indicator_id
        LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
        WHERE r.year_bh = ? AND ${c.join(' AND ')}
        GROUP BY r.indicator_id, r.hospcode`, [year, ...p]);

    const [[depts], [mains], [yuts], [hos], [dists], [types], [sums], [prevs], settings] = await Promise.all([
        db.query(NAME_SQL.dept), db.query(NAME_SQL.main), db.query(NAME_SQL.yut),
        db.query('SELECT hoscode, hosname, distid, zone, hostype FROM chospital'),
        db.query('SELECT distid, distname FROM co_district'),
        db.query('SELECT hostypecode, hostypename FROM chostype'),
        db.query(`SELECT indicator_id, hospcode, last_actual, target_value, ${MONTH_KEYS.join(', ')} FROM kpi_summary WHERE year_bh = ?`, [year]),
        db.query(`SELECT indicator_id, hospcode, ${MONTH_KEYS.join(', ')} FROM kpi_summary WHERE year_bh = ?`, [String(Number(year) - 1)]),
        getReminderSettings(),
    ]);
    const nm = (list) => new Map(list.map(r => [String(r.id), r.name]));
    const deptN = nm(depts), mainN = nm(mains), yutN = nm(yuts);
    const distN = new Map(dists.map(r => [String(r.distid), r.distname]));
    const typeN = new Map(types.map(r => [String(r.hostypecode), r.hostypename]));
    const hosM = new Map(hos.map(r => [String(r.hoscode).trim(), r]));
    const pk = (ind, h) => ind + '|' + String(h).trim();
    const sumM = new Map(sums.map(r => [pk(r.indicator_id, r.hospcode), r]));
    const prevM = new Map(prevs.map(r => [pk(r.indicator_id, r.hospcode), Object.fromEntries(MONTH_KEYS.map(k => [k, r[k]]))]));

    let pairs = rows.map(r => {
        const h = hosM.get(String(r.hospcode).trim()) || {};
        const s = sumM.get(pk(r.indicator_id, r.hospcode));
        const cells = String(r.cells || '').split(';').filter(Boolean).map(x => {
            const [mb, f, st, lk, ts] = x.split('|');
            return { m: fiscalIdx(mb), f: f === '1', st, lk: lk === '1', ts: Number(ts) || 0 };
        });
        return {
            indicator_id: Number(r.indicator_id), hospcode: String(r.hospcode).trim(), ind_name: r.ind_name, result_formula: r.result_formula,
            dept_id: r.dept_id, dept_name: deptN.get(String(r.dept_id)) || '', main_id: r.main_id, main_name: mainN.get(String(r.main_id)) || '',
            yut_id: r.yut_id, yut_name: yutN.get(String(r.yut_id)) || '',
            itypes: ['r9', 'moph', 'ssj', 'rmw', 'other'].filter(k => Number(r[k]) === 1),
            hosname: h.hosname || r.hospcode, distid: h.distid || '', distname: distN.get(String(h.distid)) || '', zone: h.zone ? String(h.zone) : '',
            hostype: h.hostype || '', hostype_name: typeN.get(String(h.hostype)) || '',
            manual: Number(r.manual) === 1, quarter: r.quarter_mode === 'quarter',
            cells, months: s ? Object.fromEntries(MONTH_KEYS.map(k => [k, s[k]])) : null, last: s ? s.last_actual : null, target: s ? s.target_value : null,
        };
    });

    // ตัวเลือก dropdown (ก่อนกรอง)
    const uniq = (arr, k, n) => { const m = new Map(); for (const x of arr) if (!m.has(String(x[k] ?? '0'))) m.set(String(x[k] ?? '0'), n(x)); return [...m.entries()].map(([id, name]) => ({ id, name: name || 'ไม่ระบุ' })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')); };
    const options = {
        years,
        depts: uniq(pairs, 'dept_id', x => x.dept_name),
        mains: uniq(pairs, 'main_id', x => x.main_name).map(o => ({ ...o, yut_id: pairs.find(x => String(x.main_id ?? '0') === o.id)?.yut_id ?? null })),
        yuts: uniq(pairs, 'yut_id', x => x.yut_name),
        indicators: uniq(pairs, 'indicator_id', x => x.ind_name).map(o => { const x = pairs.find(y => String(y.indicator_id) === o.id); return { ...o, dept_id: x?.dept_id ?? null, main_id: x?.main_id ?? null }; }),
        districts: uniq(pairs, 'distid', x => x.distname).map(o => ({ ...o, zone: pairs.find(x => String(x.distid) === o.id)?.zone || '' })),
        zones: [...new Set(pairs.map(x => x.zone).filter(Boolean))].sort((a, b) => Number(a) - Number(b)),
        hostypes: uniq(pairs, 'hostype', x => x.hostype_name),
    };

    // ตัวกรอง
    const eq = (v, f) => !f || String(v ?? '0') === String(f);
    const zones = q.zone ? String(q.zone).split(',').map(s => s.trim()).filter(Boolean) : null;
    const itypes = q.itype ? String(q.itype).split(',').map(s => s.trim()).filter(Boolean) : null;
    pairs = pairs.filter(x => eq(x.dept_id, q.dept_id) && eq(x.yut_id, q.yut_id) && eq(x.main_id, q.main_id) && eq(x.indicator_id, q.indicator_id)
        && eq(x.distid, q.distid) && eq(x.hostype, q.hostype) && (!zones || zones.includes(x.zone))
        && (!itypes || itypes.some(t => (t === 'none' ? x.itypes.length === 0 : x.itypes.includes(t)))));

    // ค่าที่อาจผิดปกติ (ตัวตรวจเดียวกับหน้าจัดการข้อมูลผลงาน) — นับต่อคู่
    const evalMap = new Map(pairs.filter(x => x.months).map(x => [pk(x.indicator_id, x.hospcode), { indicator_id: x.indicator_id, hospcode: x.hospcode, months: x.months, target: x.target }]));
    const indMap = new Map(pairs.map(x => [x.indicator_id, { name: x.ind_name }]));
    const { issues } = evaluatePairs(evalMap, indMap, prevM);
    const anomCount = new Map();
    for (const it of issues) { const k = pk(it.indicator_id, it.hospcode); anomCount.set(k, (anomCount.get(k) || 0) + 1); }
    for (const x of pairs) x.anomalies = anomCount.get(pk(x.indicator_id, x.hospcode)) || 0;

    const through = throughIndex(year, now);
    const dueDay = settings.reminder_due_day;
    const stats = computeRecordingStats(pairs, { through, dueTs: dueTimestamps(year, dueDay) });
    return { year_bh: year, through, through_label: through >= 0 ? MONTH_LABELS[through] : null, due_day: dueDay, options, ...stats };
}

module.exports = { computeRecordingStats, pairStats, loadRecordingStats, dueTimestamps, MONTH_KEYS, MONTH_LABELS };
