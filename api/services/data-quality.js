// ตรวจคุณภาพข้อมูลผลงานทั้งปีงบ (ผู้ช่วย AI ระยะที่ 5 — 8 พ.ย. 2569) — ตรวจแบบกฎ ไม่ใช้ AI (ผลแน่นอน ทดสอบได้)
// AI ใช้แค่สรุป/อธิบายผลของตัวตรวจนี้ (services/ai-quality.js) — ตัวตรวจไม่แก้ข้อมูลใดๆ
// กฎ (1 ช่อง = ตัวชี้วัด × หน่วยบริการ × เดือน, รายงานเพียงข้อแรกที่เข้าเงื่อนไข):
//   negative / high / low — detectAnomaly() ของ kpi-anomaly.js (สำเนาเดียวกับคำเตือนตอนบันทึกในหน้าบันทึกผลงาน)
//     อ้างอิง: เดือนอื่นของคู่เดียวกัน → ปีงบที่แล้ว (kpi_summary) → เป้าหมาย (เกิน 10 เท่า)
//   text     — ผลงานเป็นข้อความในตัวชี้วัดที่ผลงานส่วนใหญ่ (≥ 80%, อย่างน้อย 5 ช่อง) เป็นตัวเลข
//   pct_over — ตัวชี้วัด "ร้อยละ" ที่เป้าหมายไม่เกิน 100 แต่ผลงานเกิน 100
// เฉพาะตัวชี้วัดที่เปิดใช้งาน (is_active = 1) | ⚠️ ไม่ JOIN chospital ตรง (คนละ collation — ดู /kpi-results/manage) ดึงชื่อแยก
const db = require('../db');
const { detectAnomaly, toNumber, median } = require('../kpi-anomaly');

const MONTHS = [
    { bh: 10, key: 'oct', sumCol: 'oct', label: 'ต.ค.' }, { bh: 11, key: 'nov', sumCol: 'nov', label: 'พ.ย.' },
    { bh: 12, key: 'dece', sumCol: 'dece', label: 'ธ.ค.' }, { bh: 1, key: 'jan', sumCol: 'jan', label: 'ม.ค.' },
    { bh: 2, key: 'feb', sumCol: 'feb', label: 'ก.พ.' }, { bh: 3, key: 'mar', sumCol: 'mar', label: 'มี.ค.' },
    { bh: 4, key: 'apr', sumCol: 'apr', label: 'เม.ย.' }, { bh: 5, key: 'may', sumCol: 'may', label: 'พ.ค.' },
    { bh: 6, key: 'jun', sumCol: 'jun', label: 'มิ.ย.' }, { bh: 7, key: 'jul', sumCol: 'jul', label: 'ก.ค.' },
    { bh: 8, key: 'aug', sumCol: 'aug', label: 'ส.ค.' }, { bh: 9, key: 'sep', sumCol: 'sep', label: 'ก.ย.' },
];
const MONTH_BY_BH = new Map(MONTHS.map(m => [m.bh, m]));
const KIND_ORDER = ['negative', 'high', 'low', 'text', 'pct_over'];
const KIND_LABEL = {
    negative: 'ค่าติดลบ',
    high: 'สูงผิดปกติ',
    low: 'ต่ำผิดปกติ',
    text: 'เป็นข้อความในตัวชี้วัดตัวเลข',
    pct_over: 'ร้อยละเกิน 100',
};
const TEXT_MIN_CELLS = 5;
const TEXT_NUMERIC_SHARE = 0.8;
const MAX_ISSUES = 1000;   // จำนวนรายการที่คืนให้หน้าจอ (จำนวนนับ counts ครบเสมอ)
const TOP_INDICATORS = 20;

const isPctIndicator = (name) => /ร้อยละ/.test(String(name || ''));
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2))));
const HINT_NEAR = 1.25; // "ใกล้เคียง" = ต่างกันไม่เกิน 1.25 เท่า
const near = (a, b) => a > 0 && b > 0 && a / b <= HINT_NEAR && b / a <= HINT_NEAR;

/**
 * ข้อสังเกตที่คำนวณได้แน่นอนของช่องที่ถูกเตือน (ส่งให้ AI ใช้ประกอบการอธิบาย + แสดงบนหน้าจอ) — ไม่เกิน 3 ข้อ
 * พบจากการทดลองกับผู้ให้บริการจริง (8 พ.ย. 2569): ไม่มีข้อสังเกตนี้ AI ตีความยอดสะสม (55 = ผลรวม 5 เดือนก่อนหน้า) ว่า "พิมพ์เกินหลัก ตั้งใจพิมพ์ 5"
 *   - เท่ากับผลรวมของเดือนก่อนหน้า (ตามลำดับปีงบ ≥ 2 เดือน, คลาด ≤ 1%) = อาจบันทึกยอดสะสม
 *   - หาร/คูณด้วย 10, 100, 1000 แล้วใกล้เคียงค่ากลางของเดือนอื่น = อาจพิมพ์เกิน/ตกหลัก
 *   - ตัวชี้วัดร้อยละแต่ค่าเกิน 100 | ค่าติดลบ
 */
function anomalyHints(value, months, monthKey, opts = {}) {
    const v = toNumber(value);
    if (v === null) return [];
    const hints = [];
    if (v < 0) hints.push('มีเครื่องหมายลบ — ผลงานไม่ควรน้อยกว่า 0');
    const idx = MONTHS.findIndex(m => m.key === monthKey);
    const earlier = MONTHS.slice(0, Math.max(0, idx)).map(m => toNumber(months?.[m.key])).filter(n => n !== null);
    if (earlier.length >= 2 && v > 0) {
        const sum = earlier.reduce((a, b) => a + b, 0);
        if (sum > 0 && Math.abs(v - sum) <= Math.max(0.5, sum * 0.01)) {
            hints.push(`เท่ากับผลรวมของ ${earlier.length} เดือนก่อนหน้า (${fmtNum(sum)}) — อาจบันทึกยอดสะสมแทนยอดของเดือนนี้`);
        }
    }
    const others = MONTHS.filter(m => m.key !== monthKey).map(m => toNumber(months?.[m.key])).filter(n => n !== null && n > 0);
    if (others.length && v > 0) {
        const ref = median(others);
        for (const f of [10, 100, 1000]) {
            if (near(v / f, ref)) hints.push(`ถ้าหารด้วย ${f} = ${fmtNum(v / f)} ใกล้เคียงค่ากลางของเดือนอื่น (${fmtNum(ref)}) — อาจพิมพ์เกินหลัก`);
            if (near(v * f, ref)) hints.push(`ถ้าคูณด้วย ${f} = ${fmtNum(v * f)} ใกล้เคียงค่ากลางของเดือนอื่น (${fmtNum(ref)}) — อาจพิมพ์ตกหลัก`);
        }
    }
    if (opts.pct && v > 100) hints.push('เป็นตัวชี้วัดร้อยละแต่ค่าเกิน 100 — อาจบันทึกจำนวนนับแทนร้อยละ');
    return hints.slice(0, 3);
}
// คำเตือนที่เทียบกับปีงบที่แล้ว/เป้าหมาย = ปีงบนี้ยังไม่มีเดือนอื่นให้เทียบ (AI ต้องไม่สรุปเรื่องยอดสะสมจากข้อมูลเดือนเดียว — พบจากการทดลองจริง)
function withBasisHint(hints, basis) {
    const out = [...hints];
    if (basis === 'prev-month' || basis === 'prev-year') out.push('ปีงบนี้ยังไม่มีผลงานเดือนอื่นให้เทียบ จึงเทียบกับปีงบที่แล้ว');
    else if (basis === 'target') out.push('ยังไม่มีผลงานเดือนอื่นและปีงบที่แล้วให้เทียบ จึงเทียบกับเป้าหมาย');
    return out.slice(0, 3);
}
// ลักษณะของข้อความในช่องผลงาน (ไม่ส่งข้อความจริงให้ AI — กันข้อความแทรกคำสั่ง)
function textHint(value) {
    return /\d/.test(String(value)) ? 'ข้อความมีตัวเลขปนกับตัวอักษร/สัญลักษณ์ (เช่น หน่วยนับหรือเครื่องหมาย %)' : 'ข้อความไม่มีตัวเลข (เช่น คำอธิบายหรือสถานะการดำเนินงาน)';
}

/**
 * ตรวจกฎกับข้อมูลที่เตรียมแล้ว (ฟังก์ชันล้วน — ทดสอบได้โดยไม่ใช้ฐานข้อมูล)
 * @param pairs Map key → { indicator_id, hospcode, months: {key: actual}, targets: {key: target}, target }
 * @param indicators Map id → { id, name, ... }
 * @param prev Map key → { key: actual } ของปีงบที่แล้ว
 */
function evaluatePairs(pairs, indicators, prev = new Map()) {
    // สัดส่วนผลงานที่เป็นตัวเลขต่อตัวชี้วัด (ใช้กับกฎ text)
    const share = new Map();
    for (const p of pairs.values()) {
        const s = share.get(p.indicator_id) || { n: 0, num: 0 };
        for (const m of MONTHS) {
            const v = p.months[m.key];
            if (v === undefined || v === null || String(v).trim() === '') continue;
            s.n++;
            if (toNumber(v) !== null) s.num++;
        }
        share.set(p.indicator_id, s);
    }
    const issues = [];
    let cells = 0;
    const keys = MONTHS.map(m => m.key);
    for (const [pk, p] of pairs) {
        const ind = indicators.get(p.indicator_id);
        if (!ind) continue;
        const pv = prev.get(pk);
        for (const m of MONTHS) {
            const raw = p.months[m.key];
            if (raw === undefined || raw === null || String(raw).trim() === '') continue;
            cells++;
            const value = String(raw).trim();
            const target = toNumber(p.targets?.[m.key]) !== null ? p.targets[m.key] : p.target;
            let issue = null;
            const a = detectAnomaly(value, {
                others: keys.filter(k => k !== m.key).map(k => p.months[k]),
                prevSame: pv ? pv[m.key] : null,
                prevAll: pv ? keys.map(k => pv[k]) : [],
                target,
            });
            if (a) {
                issue = { kind: a.kind, basis: a.basis, ref: a.ref, message: a.message };
            } else if (toNumber(value) === null) {
                const s = share.get(p.indicator_id);
                if (s && s.n >= TEXT_MIN_CELLS && s.num / s.n >= TEXT_NUMERIC_SHARE) {
                    issue = { kind: 'text', basis: 'indicator', ref: null, message: `ผลงานเป็นข้อความ ขณะที่ผลงานของตัวชี้วัดนี้ส่วนใหญ่ (${Math.round((s.num / s.n) * 100)}%) เป็นตัวเลข — ระบบคำนวณร้อยละ/ผ่านเกณฑ์จากข้อความไม่ได้` };
                }
            } else {
                const t = toNumber(target);
                const v = toNumber(value);
                if (isPctIndicator(ind.name) && t !== null && t > 0 && t <= 100 && v > 100) {
                    issue = { kind: 'pct_over', basis: 'target', ref: t, message: `ตัวชี้วัดร้อยละมีผลงาน ${value} ซึ่งเกิน 100 (เป้าหมาย ${t}) — ตรวจสอบว่าบันทึกเป็นจำนวนนับแทนร้อยละหรือไม่` };
                }
            }
            if (issue) issue.hints = issue.kind === 'text' ? [textHint(value)] : withBasisHint(anomalyHints(value, p.months, m.key, { pct: isPctIndicator(ind.name) }), issue.basis);
            if (issue) {
                issues.push({ indicator_id: p.indicator_id, hospcode: p.hospcode, month: m.key, month_name: m.label, value, ...issue });
            }
        }
    }
    const monthIdx = new Map(MONTHS.map((m, i) => [m.key, i]));
    issues.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind)
        || String(indicators.get(x.indicator_id)?.name || '').localeCompare(String(indicators.get(y.indicator_id)?.name || ''), 'th')
        || String(x.hospcode).localeCompare(String(y.hospcode))
        || monthIdx.get(x.month) - monthIdx.get(y.month));
    return { issues, cells };
}

function summarize(issues, indicators) {
    const counts = Object.fromEntries(KIND_ORDER.map(k => [k, 0]));
    const byInd = new Map();
    for (const it of issues) {
        counts[it.kind]++;
        const ind = indicators.get(it.indicator_id) || {};
        const e = byInd.get(it.indicator_id) || { indicator_id: it.indicator_id, name: ind.name, dept_name: ind.dept_name || null, count: 0, hospitals: new Set(), kinds: {} };
        e.count++;
        e.hospitals.add(it.hospcode);
        e.kinds[it.kind] = (e.kinds[it.kind] || 0) + 1;
        byInd.set(it.indicator_id, e);
    }
    const by_indicator = [...byInd.values()]
        .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), 'th'))
        .map(e => ({ ...e, hospitals: e.hospitals.size }));
    return { counts, by_indicator };
}

async function loadScanData(year) {
    const [indRows] = await db.query(`
        SELECT i.id, i.kpi_indicators_name AS name, i.dept_id, d.dept_name, i.is_cumulative, i.result_formula,
               i.target_condition, i.target_monthly
        FROM kpi_indicators i LEFT JOIN departments d ON d.id = i.dept_id
        WHERE i.is_active = 1`);
    const indicators = new Map(indRows.map(r => [Number(r.id), { ...r, id: Number(r.id) }]));
    const [rows] = await db.query(`
        SELECT indicator_id, hospcode, month_bh, target_value, actual_value
        FROM kpi_results
        WHERE year_bh = ? AND actual_value IS NOT NULL AND actual_value <> ''`, [year]);
    const pairs = new Map();
    for (const r of rows) {
        const id = Number(r.indicator_id);
        if (!indicators.has(id)) continue;
        const m = MONTH_BY_BH.get(Number(r.month_bh));
        if (!m) continue;
        const hc = String(r.hospcode || '').trim();
        const pk = `${id}|${hc}`;
        if (!pairs.has(pk)) pairs.set(pk, { indicator_id: id, hospcode: hc, months: {}, targets: {}, target: null });
        const p = pairs.get(pk);
        p.months[m.key] = r.actual_value;
        if (r.target_value !== null && r.target_value !== '') p.targets[m.key] = r.target_value;
    }
    // เป้าหมายของคู่ (ค่าตัวเลขมากที่สุดของทุกเดือน — รวมเดือนที่ยังไม่มีผลงาน) เฉพาะตัวชี้วัดที่มีผลงาน
    const indIds = [...new Set([...pairs.values()].map(p => p.indicator_id))];
    if (indIds.length) {
        const [tRows] = await db.query(`
            SELECT indicator_id, hospcode, target_value FROM kpi_results
            WHERE year_bh = ? AND indicator_id IN (${indIds.map(() => '?').join(',')}) AND target_value IS NOT NULL AND target_value <> ''`,
        [year, ...indIds]);
        for (const r of tRows) {
            const p = pairs.get(`${Number(r.indicator_id)}|${String(r.hospcode || '').trim()}`);
            const t = toNumber(r.target_value);
            if (p && t !== null && (p.target === null || t > toNumber(p.target))) p.target = String(t);
        }
    }
    // ปีงบที่แล้ว (จาก kpi_summary — แบบเดียวกับคำเตือนในหน้าบันทึกผลงาน)
    const prev = new Map();
    if (indIds.length) {
        const [pRows] = await db.query(`
            SELECT indicator_id, hospcode, ${MONTHS.map(m => m.sumCol).join(', ')} FROM kpi_summary
            WHERE year_bh = ? AND indicator_id IN (${indIds.map(() => '?').join(',')})`, [String(Number(year) - 1), ...indIds]);
        for (const r of pRows) {
            prev.set(`${Number(r.indicator_id)}|${String(r.hospcode || '').trim()}`, Object.fromEntries(MONTHS.map(m => [m.key, r[m.sumCol]])));
        }
    }
    return { indicators, pairs, prev };
}

/** ตรวจคุณภาพข้อมูลของปีงบ — คืนจำนวนตามประเภท, ตัวชี้วัดที่พบมาก, รายการ (≤ MAX_ISSUES) */
async function scanDataQuality(yearBh) {
    const year = String(yearBh || '').trim();
    if (!/^\d{4}$/.test(year)) {
        const e = new Error('กรุณาเลือกปีงบประมาณ (พ.ศ. 4 หลัก)');
        e.status = 400;
        throw e;
    }
    const { indicators, pairs, prev } = await loadScanData(year);
    const { issues, cells } = evaluatePairs(pairs, indicators, prev);
    const { counts, by_indicator } = summarize(issues, indicators);
    const shown = issues.slice(0, MAX_ISSUES);
    const codes = [...new Set(shown.map(i => i.hospcode).filter(Boolean))];
    let hosMap = new Map();
    if (codes.length) {
        const [h] = await db.query(`SELECT hoscode, hosname FROM chospital WHERE hoscode IN (${codes.map(() => '?').join(',')})`, codes);
        hosMap = new Map(h.map(r => [String(r.hoscode).trim(), r.hosname]));
    }
    return {
        year_bh: year,
        scanned: { indicators: new Set([...pairs.values()].map(p => p.indicator_id)).size, pairs: pairs.size, cells },
        counts,
        total: issues.length,
        by_indicator: by_indicator.slice(0, TOP_INDICATORS),
        issues: shown.map(i => {
            const ind = indicators.get(i.indicator_id) || {};
            return {
                ...i, kind_label: KIND_LABEL[i.kind],
                indicator_name: ind.name, dept_name: ind.dept_name || null, result_formula: ind.result_formula || null,
                hosname: hosMap.get(i.hospcode) || null,
            };
        }),
        truncated: issues.length > shown.length,
        _indicators: indicators, // ใช้ภายใน (ai-quality) — route ตัดออกก่อนส่ง
    };
}

module.exports = { scanDataQuality, evaluatePairs, summarize, anomalyHints, withBasisHint, textHint, MONTHS, KIND_ORDER, KIND_LABEL, MAX_ISSUES, TEXT_MIN_CELLS, TEXT_NUMERIC_SHARE };
