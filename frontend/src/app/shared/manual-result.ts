// ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569) — คู่กับ backend api/services/manual-result.js
// - kpi_indicators.result_manual / pct_manual (แถวจาก GET /kpi-results มี manual_result / manual_pct ของคู่ ตัวชี้วัด × หน่วยบริการ × ปีงบ)
// - ผลงานล่าสุดแบบกรอกเอง: ใช้ค่าที่กรอกเท่านั้น (ช่องรายเดือนยังกรอกได้แต่ไม่นำมาคำนวณ, ยังไม่กรอก = ว่าง)
// - ร้อยละแบบกรอกเอง: แสดงค่าที่กรอก, ผ่านเกณฑ์ = ร้อยละ ≥ 100 (ผู้ใช้เลือก), ยังไม่กรอก = ว่าง (ไม่ระบายแดง เหมือนไม่มีเป้าหมาย)

export const isManualResult = (item: any): boolean => item?.result_manual === true || Number(item?.result_manual) === 1;
export const isManualPct = (item: any): boolean => item?.pct_manual === true || Number(item?.pct_manual) === 1;

// ร้อยละที่กรอก: ตัวเลข ≥ 0 (ทศนิยมได้, ลงท้าย % ได้) — คืนข้อความที่ normalize แล้ว, '' = ว่าง, null = ไม่ถูกต้อง (ตรงกับ normalizeManualPct ของ backend)
export function normalizeManualPct(v: any): string | null {
  const s = String(v ?? '').trim().replace(/%$/, '').trim();
  if (!s) return '';
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
}

// ร้อยละที่กรอกเป็นตัวเลข (ว่าง/ไม่ถูกต้อง = null)
export function manualPctNumber(item: any): number | null {
  const s = normalizeManualPct(item?.manual_pct);
  return s ? parseFloat(s) : null;
}

// ผ่านเกณฑ์ของร้อยละที่กรอก: ≥ 100 | ยังไม่กรอก = null (ไม่ตัดสิน)
export function manualPctPass(item: any): boolean | null {
  const p = manualPctNumber(item);
  return p === null ? null : p >= 100;
}
