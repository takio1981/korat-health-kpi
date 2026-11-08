// ระบบเตือนล่วงหน้า (ตามข้อเสนอแนวคิดการพัฒนา — เริ่ม 8 พ.ย. 2569) ระยะที่ 1: แบบจำลองคาดการณ์ผลงาน ณ สิ้นปีงบประมาณ + ระดับความเสี่ยง
// ฟังก์ชันล้วน (ไม่แตะฐานข้อมูล) ทดสอบได้ — ไม่ใช้ AI: ผลคาดการณ์ต้องอธิบายและตรวจสอบย้อนหลังได้ (ข้อเสนอแนวคิด ข้อ 3.4)
//
// วิธีคาดการณ์ตามประเภทตัวชี้วัด (ข้อเสนอแนวคิด 3.2 ข้อ 1):
//   สะสม (is_cumulative)      → อัตราเฉลี่ยต่อเดือน (run-rate) ของเดือนที่มีข้อมูล เติมเดือนที่เหลือ แล้วรวมทั้งปี
//   ค่าเดือนล่าสุด (ปกติ)       → ค่าของ ก.ย. จากเดือนที่มีข้อมูลด้วยวิธี method (linear / ma3 / last / blend)
//   มีสูตรคำนวณผลงาน          → เติมเดือนที่เหลือด้วยวิธีเดียวกัน แล้วคำนวณตามสูตรเดิมของตัวชี้วัด (kpi-formula.js)
// ระดับความเสี่ยง (ข้อ 2): ปกติ = ค่าคาดการณ์ผ่านเกณฑ์ | เฝ้าระวัง = ต่ำกว่าเป้าหมายไม่เกิน watchPct% | เสี่ยงสูง = ต่ำกว่าเกินนั้น
//   ร้อยละเทียบเป้าหมายใช้ evaluateTarget() ตัวเดียวกับทั้งระบบ (คำนึงถึงเงื่อนไข ≤ "ค่ายิ่งน้อยยิ่งดี")
//   ขาดการรายงาน = ไม่มีผลงานติดต่อกัน ≥ missingRun เดือนล่าสุด (แยกจากการคาดการณ์) | ข้อมูล < minPoints เดือน = ไม่คาดการณ์ (ข้อ 3.4 ข้อ 2)
const kpiFormula = require('./kpi-formula');
const { evaluateTarget, hasTarget, normalizeCondition, targetNum, aggregateMonthlyTarget, normalizeTargetMonthly } = require('./kpi-target');

const MONTH_KEYS = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
const METHODS = ['linear', 'ma3', 'last', 'blend'];
const DEFAULTS = { method: 'linear', watchPct: 10, minPoints: 3, missingRun: 2 }; // method เลือกจากการทดสอบย้อนหลังข้อมูลจริงปีงบ 2569 ตัดที่ มี.ค. (scripts/forecast-backtest.js): linear 97.35% > last 96.76% > blend 94.12% > ma3 93.82%
const STATUS = ['high', 'watch', 'no_report', 'normal', 'insufficient', 'no_target', 'unsupported'];

const NUM_RE = /^-?\d+(\.\d+)?$/;
function num(v) {
    const s = String(v == null ? '' : v).trim().replace(/,/g, '');
    return NUM_RE.test(s) ? Number(s) : null;
}
const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => String(round2(n));

/** ค่ารายเดือนตามลำดับปีงบ (12 ช่อง) จาก object {oct…sep} หรือ array */
function toSeries(months) {
    if (Array.isArray(months)) return MONTH_KEYS.map((_, i) => months[i]);
    return MONTH_KEYS.map(k => (months ? months[k] : undefined));
}

/** ดัชนีเดือนล่าสุดที่ "ควรรายงานแล้ว" (0 = ต.ค. … 11 = ก.ย.) ของปีงบ yearBh ณ วันที่ now — รายงานช้ากว่าเดือนจริง 1 เดือน
 *  ปีงบที่สิ้นสุดแล้ว = 11 | ยังไม่เริ่ม (ก่อน พ.ย. ของปีงบ) = -1 */
function throughIndex(yearBh, now = new Date()) {
    const endCe = Number(yearBh) - 543;              // ปีงบ 2570 = ต.ค. 2026 – ก.ย. 2027 (ค.ศ.)
    const startCe = endCe - 1;
    const m = now.getMonth() + 1, y = now.getFullYear();
    const monthsFromStart = (y - startCe) * 12 + (m - 10); // ต.ค. ของปีเริ่ม = 0
    const idx = monthsFromStart - 1;                 // เดือนก่อนหน้า = เดือนล่าสุดที่ควรรายงานแล้ว
    return Math.max(-1, Math.min(11, idx));
}

// ---- วิธีคาดการณ์ค่าของเดือน target จากจุดข้อมูล [{x, y}] ----
function linearAt(pts, x) {
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
    let sxy = 0, sxx = 0;
    for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; }
    const slope = sxx === 0 ? 0 : sxy / sxx;
    return my + slope * (x - mx);
}
function ma3(pts) {
    const last = pts.slice(-3);
    return last.reduce((a, p) => a + p.y, 0) / last.length;
}
function predictAt(pts, x, method) {
    let v;
    if (method === 'last') v = pts[pts.length - 1].y;
    else if (method === 'ma3') v = ma3(pts);
    else if (method === 'linear') v = linearAt(pts, x);
    else v = (linearAt(pts, x) + ma3(pts)) / 2;      // blend: แนวโน้มเชิงเส้นเฉลี่ยกับค่าเฉลี่ยเคลื่อนที่ 3 เดือน (ลดการเหวี่ยงของเส้นตรงเมื่อมีข้อมูลน้อย)
    return Math.max(0, v);
}

function confidenceOf(points, remaining) {
    if (remaining <= 0) return 'actual';
    if (points >= 6 && remaining <= 6) return 'high';
    if (points >= 4) return 'medium';
    return 'low';
}

/**
 * คาดการณ์ผลงาน ณ สิ้นปีงบของคู่ตัวชี้วัด×หน่วยบริการ 1 คู่
 * @param pair { months, targets?, target, condition, cumulative, formula, targetMonthly, manual, vars, prev }
 * @param opts { through (0–11), method, watchPct, minPoints, missingRun }
 */
function forecastPair(pair, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const through = Math.max(-1, Math.min(11, Number.isInteger(o.through) ? o.through : 11));
    const series = toSeries(pair.months);
    const values = series.map(num);
    const pts = [];
    for (let i = 0; i <= through; i++) if (values[i] !== null) pts.push({ x: i, y: values[i] });
    const base = { points: pts.length, through, last_idx: pts.length ? pts[pts.length - 1].x : null, method: null, confidence: null, projected: null, target: null, pct: null, gap_pct: null };

    // ขาดการรายงาน: เดือนล่าสุดที่ควรรายงานว่างติดต่อกัน ≥ missingRun เดือน
    let run = 0;
    for (let i = through; i >= 0 && values[i] === null; i--) run++;
    if (through >= 0 && run >= o.missingRun) return { ...base, status: 'no_report', missing_months: run };

    if (pair.manual) return { ...base, status: 'unsupported', reason: 'ผลงานกรอกเอง' };
    const formula = typeof pair.formula === 'string' && pair.formula.trim() ? pair.formula.trim() : null;
    if (formula && kpiFormula.usesPrevYear(formula) && !pair.prev) return { ...base, status: 'unsupported', reason: 'สูตรอ้างข้อมูลปีงบที่แล้ว' };
    if (formula && kpiFormula.formulaVarNames(formula).length && !pair.vars) return { ...base, status: 'unsupported', reason: 'สูตรใช้ค่าเพิ่มเติมที่ตั้งชื่อเอง' };
    if (pts.length < o.minPoints) return { ...base, status: 'insufficient' };

    // เติมเดือนที่ยังไม่ถึง (หลัง through) — เดือนที่ผ่านแล้วแต่ไม่มีข้อมูลคงว่าง (ไม่เดาข้อมูลย้อนหลัง)
    const remaining = 11 - through;
    const cumulative = !formula && Number(pair.cumulative) === 1;
    const method = remaining <= 0 ? 'actual' : (cumulative ? 'run_rate' : (formula ? 'formula:' + o.method : o.method));
    const rate = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    const filled = values.map((v, i) => {
        if (i <= through) return v;
        return cumulative ? rate : predictAt(pts, i, o.method);
    });

    let projected;
    if (formula) {
        const months = {};
        MONTH_KEYS.forEach((k, i) => { months[k] = filled[i] === null ? '' : fmt(filled[i]); });
        try { projected = kpiFormula.evaluateFormula(formula, months, pair.target, pair.prev, pair.vars); } catch (e) { projected = null; }
        if (projected === null) return { ...base, status: 'unsupported', method, reason: 'คำนวณสูตรไม่ได้' };
    } else if (cumulative) {
        projected = fmt(filled.reduce((a, v) => a + (v === null ? 0 : v), 0));
    } else {
        projected = fmt(filled[11] === null ? pts[pts.length - 1].y : filled[11]);
    }

    // เป้าหมาย: เป้าหมายรายเดือน (latest/cumulative) คำนวณจากชุดที่เติมแล้ว ไม่งั้นเป้าหมายเดียวทั้งปี
    let target = pair.target;
    const tm = normalizeTargetMonthly(pair.targetMonthly);
    if (tm && pair.targets) {
        const tSeries = toSeries(pair.targets);
        target = aggregateMonthlyTarget(tm, filled.map(v => (v === null ? '' : fmt(v))), tSeries);
    }
    const cond = normalizeCondition(pair.condition);
    const t = targetNum(target);
    if (t === null || !hasTarget(t, cond)) return { ...base, status: 'no_target', method, projected };

    const { pct, pass } = evaluateTarget(projected, String(t), cond);
    const gap = pct === null ? null : round2(Math.max(0, 100 - pct));
    const status = pass ? 'normal' : (gap !== null && gap <= o.watchPct ? 'watch' : 'high');
    return {
        ...base, status, method, projected, target: String(t), pct: pct === null ? null : round2(pct), gap_pct: pass ? 0 : gap,
        confidence: confidenceOf(pts.length, remaining), condition: cond,
    };
}

/**
 * ทดสอบย้อนหลัง (backtesting) 1 คู่: คาดการณ์จากข้อมูลถึงเดือน cutoff เทียบกับผลจริงทั้งปี (ข้อมูลครบ 12 เดือน)
 * คืน null เมื่อเทียบไม่ได้ (ข้อมูลไม่พอ/ไม่มีเป้าหมาย/ผลจริงไม่มี) — ใช้ผลผ่าน/ไม่ผ่านเป็นเกณฑ์ความแม่นยำ (ข้อเสนอแนวคิด ข้อ 5 ตัวชี้วัดที่ 2)
 */
function backtestPair(pair, cutoff, opts = {}) {
    // ต้องมีผลงานหลังเดือนตัดอย่างน้อย 1 เดือน — ไม่งั้น "ผลจริง" คือข้อมูลชุดเดียวกับที่ใช้คาดการณ์ (ความแม่นยำสูงเกินจริง: ข้อมูลจริงปีงบ 2569 ส่วนใหญ่สิ้นสุดที่ เม.ย.)
    if (!toSeries(pair.months).some((v, i) => i > cutoff && num(v) !== null)) return null;
    const actual = forecastPair(pair, { ...opts, through: 11, missingRun: 99 });
    if (!['normal', 'watch', 'high'].includes(actual.status)) return null;
    const pred = forecastPair(pair, { ...opts, through: cutoff, missingRun: 99 });
    if (!['normal', 'watch', 'high'].includes(pred.status)) return null;
    const actualPass = actual.status === 'normal', predPass = pred.status === 'normal';
    return { actualPass, predPass, correct: actualPass === predPass, actual: actual.projected, projected: pred.projected, target: actual.target };
}

/** สรุปผลทดสอบย้อนหลังของหลายคู่ — ถูก = จำแนกผ่าน/ไม่ผ่านตรงกับผลจริง | เตือนครบ (recall) / เตือนแม่น (precision) ของกลุ่ม "ไม่ผ่าน" */
function evaluateBacktest(pairs, cutoff, method) {
    let n = 0, correct = 0, tp = 0, fn = 0, fp = 0, tn = 0;
    for (const p of pairs) {
        const r = backtestPair(p, cutoff, { method });
        if (!r) continue;
        n++;
        if (r.correct) correct++;
        if (!r.actualPass && !r.predPass) tp++;      // ไม่ผ่านจริง และเตือนถูก
        if (!r.actualPass && r.predPass) fn++;       // ไม่ผ่านจริง แต่ไม่เตือน
        if (r.actualPass && !r.predPass) fp++;       // ผ่านจริง แต่เตือน
        if (r.actualPass && r.predPass) tn++;
    }
    const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : null);
    return { method, cutoff, compared: n, correct, accuracy_pct: pct(correct, n), warn_recall_pct: pct(tp, tp + fn), warn_precision_pct: pct(tp, tp + fp), tp, fn, fp, tn };
}

module.exports = { forecastPair, backtestPair, evaluateBacktest, throughIndex, toSeries, predictAt, MONTH_KEYS, METHODS, DEFAULTS, STATUS };
