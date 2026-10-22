// เงื่อนไขเป้าหมายของตัวชี้วัด (target_condition) — คำนวณร้อยละและ "ผ่านเกณฑ์" ของผลงานเทียบเป้าหมาย (เพิ่ม 22 ต.ค. 2569)
// ⚠️ มี 2 สำเนาที่ต้องตรงกันทุกบรรทัด: api/kpi-target.js (CommonJS) + frontend/src/app/shared/kpi-target.ts
//    เคสทดสอบร่วม api/tests/fixtures/target-cases.json = frontend/src/app/shared/kpi-target.cases.json (jest บังคับให้ตรงกัน)
//    ฝั่ง SQL (kpi_summary → รายงาน/กราฟ/การ์ดสถิติ) ใช้ targetPassSql()/targetHasSql() ใน server.js ซึ่งต้องให้ผลตรงกับไฟล์นี้
//
// | เงื่อนไข  | ผ่าน            | ร้อยละ                                            |
// | GTE / GT | a ≥ t / a > t   | a ÷ t × 100 (วิธีเดิม)                              |
// | LTE / LT | a ≤ t / a < t   | t ÷ a × 100 (ยิ่งน้อยยิ่งดี) — ผลงาน ≤ 0 = 100         |
// | EQ       | a = t           | ค่าน้อย ÷ ค่ามาก × 100 (ความใกล้เคียง) — ทั้งคู่ 0 = 100 |
// เป้าหมายที่ใช้ได้: GTE/GT ต้อง > 0 (เดิม) | LTE/LT/EQ ≥ 0 (เป้าหมาย 0 เช่น "≤ 0 ราย" ใช้ได้)
// ผลงาน/เป้าหมายเป็นข้อความ: ตรงกัน = 100/ผ่าน ไม่ตรง = 0/ไม่ผ่าน (วิธีเดิม) | ไม่มีเป้าหมาย/ไม่มีผลงาน → { pct: null, pass: null }

export type TargetCondition = 'GTE' | 'GT' | 'LTE' | 'LT' | 'EQ';
export interface TargetResult { pct: number | null; pass: boolean | null; }

export const TARGET_CONDITIONS: TargetCondition[] = ['GTE', 'GT', 'LTE', 'LT', 'EQ'];
export const CONDITION_SYMBOL: Record<TargetCondition, string> = { GTE: '≥', GT: '>', LTE: '≤', LT: '<', EQ: '=' };
export const CONDITION_LABEL: Record<TargetCondition, string> = {
  GTE: 'มากกว่าหรือเท่ากับ', GT: 'มากกว่า', LTE: 'น้อยกว่าหรือเท่ากับ', LT: 'น้อยกว่า', EQ: 'เท่ากับ',
};

export function normalizeCondition(c: any): TargetCondition {
  const s = String(c == null ? '' : c).trim().toUpperCase();
  return (TARGET_CONDITIONS as string[]).includes(s) ? s as TargetCondition : 'GTE';
}

// ตัวเลขแบบเดียวกับ parseFloat เดิมของหน้าบันทึกผลงาน (ยอมรับ "80%", "1,200") — ไม่ใช่ตัวเลข = null
export function targetNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isFinite(n) ? n : null;
}

export function hasTarget(target: any, cond: any): boolean {
  const t = targetNum(target);
  if (t === null) return false;
  const c = normalizeCondition(cond);
  return (c === 'GTE' || c === 'GT') ? t > 0 : t >= 0;
}

export function evaluateTarget(actual: any, target: any, cond: any): TargetResult {
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
    return { pct: a <= 0 ? 100 : t / a * 100, pass: c === 'LTE' ? a <= t : a < t };
  }
  // EQ
  let pct: number;
  if (a === t) pct = 100;
  else if (a * t < 0 || a === 0 || t === 0) pct = 0;
  else pct = Math.min(Math.abs(a), Math.abs(t)) / Math.max(Math.abs(a), Math.abs(t)) * 100;
  return { pct, pass: a === t };
}
