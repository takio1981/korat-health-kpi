// เงื่อนไขเป้าหมายของตัวชี้วัด (target_condition) — คำนวณร้อยละและ "ผ่านเกณฑ์" ของผลงานเทียบเป้าหมาย (เพิ่ม 22 ต.ค. 2569)
// ⚠️ มี 2 สำเนาที่ต้องตรงกันทุกบรรทัด: api/kpi-target.js (CommonJS) + frontend/src/app/shared/kpi-target.ts
//    เคสทดสอบร่วม api/tests/fixtures/target-cases.json = frontend/src/app/shared/kpi-target.cases.json (jest บังคับให้ตรงกัน)
//    ฝั่ง SQL (kpi_summary → รายงาน/กราฟ/การ์ดสถิติ) ใช้ targetPassSql()/targetHasSql() ใน server.js ซึ่งต้องให้ผลตรงกับไฟล์นี้
//
// | เงื่อนไข  | ผ่าน            | ร้อยละ                                            |
// | GTE / GT | a ≥ t / a > t   | a ÷ t × 100 (วิธีเดิม)                              |
// | LTE / LT | a ≤ t / a < t   | ไม่เกินเป้าหมาย (a ≤ t) = 100, เกินเป้าหมาย = t ÷ a × 100 (ยิ่งน้อยยิ่งดี — 30 ต.ค. 2569) |
// | EQ       | a = t           | ค่าน้อย ÷ ค่ามาก × 100 (ความใกล้เคียง) — ทั้งคู่ 0 = 100 |
// เป้าหมายที่ใช้ได้: GTE/GT ต้อง > 0 (เดิม) | LTE/LT/EQ ≥ 0 (เป้าหมาย 0 เช่น "≤ 0 ราย" ใช้ได้)
// ผลงาน/เป้าหมายเป็นข้อความ: ตรงกัน = 100/ผ่าน ไม่ตรง = 0/ไม่ผ่าน (วิธีเดิม) | ไม่มีเป้าหมาย/ไม่มีผลงาน → { pct: null, pass: null }

const TARGET_CONDITIONS = ['GTE', 'GT', 'LTE', 'LT', 'EQ'];
const CONDITION_SYMBOL = { GTE: '≥', GT: '>', LTE: '≤', LT: '<', EQ: '=' };
const CONDITION_LABEL = {
    GTE: 'มากกว่าหรือเท่ากับ', GT: 'มากกว่า', LTE: 'น้อยกว่าหรือเท่ากับ', LT: 'น้อยกว่า', EQ: 'เท่ากับ',
};

function normalizeCondition(c) {
    const s = String(c == null ? '' : c).trim().toUpperCase();
    return TARGET_CONDITIONS.includes(s) ? s : 'GTE';
}

// ตัวเลขแบบเดียวกับ parseFloat เดิมของหน้าบันทึกผลงาน (ยอมรับ "80%", "1,200") — ไม่ใช่ตัวเลข = null
function targetNum(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
}

function hasTarget(target, cond) {
    const t = targetNum(target);
    if (t === null) return false;
    const c = normalizeCondition(cond);
    return (c === 'GTE' || c === 'GT') ? t > 0 : t >= 0;
}

function evaluateTarget(actual, target, cond) {
    const tv = String(target == null ? '' : target).trim();
    const av = String(actual == null ? '' : actual).trim();
    if (!tv || !av) return { pct: null, pass: null };
    const t = targetNum(tv);
    const a = targetNum(av);
    if (t === null || a === null) {
        // ข้อความ (เช่น "ผ่าน", "กำลังดำเนินการ") — ตรงกัน = ผ่าน
        return av === tv ? { pct: 100, pass: true } : { pct: 0, pass: false };
    }
    const c = normalizeCondition(cond);
    if (!hasTarget(t, c)) return { pct: null, pass: null };
    if (c === 'GTE') return { pct: a / t * 100, pass: a >= t };
    if (c === 'GT') return { pct: a / t * 100, pass: a > t };
    if (c === 'LTE' || c === 'LT') {
        return { pct: a <= t ? 100 : t / a * 100, pass: c === 'LTE' ? a <= t : a < t };
    }
    // EQ
    let pct;
    if (a === t) pct = 100;
    else if (a * t < 0 || a === 0 || t === 0) pct = 0;
    else pct = Math.min(Math.abs(a), Math.abs(t)) / Math.max(Math.abs(a), Math.abs(t)) * 100;
    return { pct, pass: a === t };
}

// === เป้าหมายรายเดือน (target_monthly — เพิ่ม 29 ต.ค. 2569) ===
// ตัวชี้วัดที่ตั้งเป้าหมายรายเดือน: เป้าหมายแต่ละเดือนเก็บคู่กับผลงานใน kpi_results.target_value ของเดือนนั้น
// และ "เป้าหมายรวม" (คอลัมน์เป้าหมาย / ร้อยละ / ผ่านเกณฑ์ / ตารางสรุป / ส่งออก) คำนวณจากเป้าหมายรายเดือน:
//   'latest'     = เป้าหมายของเดือนเดียวกับผลงานล่าสุด (เดือนนั้นว่าง = เดือนก่อนหน้าที่มีเป้าหมาย)
//   'cumulative' = ผลรวมเป้าหมายตั้งแต่ ต.ค. ถึงเดือนของผลงานล่าสุด (ค่าที่ไม่ใช่ตัวเลขไม่นับ)
//   อื่นๆ/ว่าง   = ไม่ใช้เป้าหมายรายเดือน (เป้าหมายเดียวทั้งปี — วิธีเดิม) → คืน null
// "เดือนของผลงานล่าสุด" = เดือนสุดท้าย (ต.ค. → ก.ย.) ที่ผลงานไม่ว่าง (ค่า 0 นับ) — ยังไม่มีผลงาน = เดือนสุดท้ายที่มีเป้าหมาย
// actuals / targets = อาร์เรย์ 12 ช่องเรียงตามปีงบ (ต.ค. … ก.ย.)
const TARGET_MONTHLY_MODES = ['latest', 'cumulative'];

function normalizeTargetMonthly(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return TARGET_MONTHLY_MODES.includes(s) ? s : '';
}

function aggregateMonthlyTarget(mode, actuals, targets) {
    const m = normalizeTargetMonthly(mode);
    if (!m) return null;
    const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
    const a = actuals || [], t = targets || [];
    let end = -1;
    for (let i = 11; i >= 0; i--) if (has(a[i])) { end = i; break; }
    if (end < 0) for (let i = 11; i >= 0; i--) if (has(t[i])) { end = i; break; }
    if (end < 0) return null;
    if (m === 'latest') {
        for (let i = end; i >= 0; i--) if (has(t[i])) return String(t[i]).trim();
        return null;
    }
    let sum = 0, n = 0;
    for (let i = 0; i <= end; i++) {
        const v = has(t[i]) ? targetNum(t[i]) : null;
        if (v !== null) { sum += v; n++; }
    }
    return n ? String(Math.round(sum * 100) / 100) : null;
}

module.exports = { TARGET_MONTHLY_MODES, normalizeTargetMonthly, aggregateMonthlyTarget, TARGET_CONDITIONS, CONDITION_SYMBOL, CONDITION_LABEL, normalizeCondition, targetNum, hasTarget, evaluateTarget };
