// ขอบเขตประเภทหน่วยบริการของตัวชี้วัด (kpi_indicators.evaluation_mode / required_off_types)
// ต้องตรงกับ indicatorAllowsHostype() ใน api/server.js — ใช้ตอน "เพิ่มตัวชี้วัดให้หน่วยบริการ" (dashboard)

/** ประเภทหน่วยบริการ (hostypecode) ที่ตัวชี้วัดกำหนดไว้ — null = ใช้ได้ทุกประเภท */
export function indicatorHostypes(ind: any): string[] | null {
  if (!ind || ind.evaluation_mode !== 'any_one' || !ind.required_off_types) return null;
  let codes: any = ind.required_off_types;
  if (typeof codes === 'string') {
    try { codes = JSON.parse(codes); } catch { return null; }
  }
  if (!Array.isArray(codes) || codes.length === 0) return null;
  return codes.map((c: any) => String(c));
}

/** ตัวชี้วัดนี้ใช้กับหน่วยบริการประเภท hostype ได้หรือไม่ (ไม่ทราบประเภท = อนุญาต ให้ backend ตัดสิน) */
export function indicatorAllowsHostype(ind: any, hostype: any): boolean {
  const codes = indicatorHostypes(ind);
  if (!codes) return true;
  if (hostype === null || hostype === undefined || hostype === '') return true;
  return codes.includes(String(hostype));
}

/** รวมประเภทหน่วยบริการของตัวชี้วัดหลายตัว — null = มีอย่างน้อย 1 ตัวที่ใช้ได้ทุกประเภท (หรือไม่ได้เลือกตัวใด) */
export function unionHostypes(inds: any[]): string[] | null {
  if (!inds || inds.length === 0) return null;
  const set = new Set<string>();
  for (const ind of inds) {
    const codes = indicatorHostypes(ind);
    if (!codes) return null;
    codes.forEach(c => set.add(c));
  }
  return [...set].sort();
}
