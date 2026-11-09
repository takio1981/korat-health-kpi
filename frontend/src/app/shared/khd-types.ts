// ข้อความแสดงผลการเทียบ "ประเภทตัวชี้วัด" / "ประเภทหน่วยบริการ" กับ KHD (9 พ.ย. 2569) — ฟังก์ชันล้วน ใช้ในหน้าจัดการตัวชี้วัด
// ค่าที่เทียบและตัดสินว่าตรง/ต่าง มาจาก backend (api/services/khd-types.js ใน GET /report-compare: types_match / hostype_match)

export const KHD_TYPE_KEYS = ['r9', 'moph', 'ssj', 'rmw', 'other'] as const;
export const KHD_TYPE_LABEL: Record<string, string> = { r9: 'R9', moph: 'MOPH', ssj: 'SSJ', rmw: 'RMW', other: 'อื่นๆ' };

/** {r9:1, moph:0, ...} → "R9, SSJ" (ไม่มี = "ไม่ระบุ") — รับแถว kpi_indicators ได้ด้วย (ค่า null/'0' = ไม่ใช่) */
export function typesText(t: any): string {
  if (!t) return 'ไม่ระบุ';
  const on = (v: any) => v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '0';
  return KHD_TYPE_KEYS.filter(k => on(t[k])).map(k => KHD_TYPE_LABEL[k]).join(', ') || 'ไม่ระบุ';
}

/** ประเภทหน่วยบริการ → ข้อความ: ทุกประเภท / ชื่อประเภท (ตามรายการ chostype) / ยังไม่ตั้ง */
export function hostypeText(mode: any, codes: any, names?: Record<string, string>): string {
  if (mode === 'all_required') return 'ทุกประเภท';
  let list: string[] = [];
  if (Array.isArray(codes)) list = codes.map(String);
  else if (typeof codes === 'string' && codes.trim()) { try { const p = JSON.parse(codes); if (Array.isArray(p)) list = p.map(String); } catch { /* รูปแบบเสีย = ยังไม่ตั้ง */ } }
  if (mode !== 'any_one' || !list.length) return 'ยังไม่ตั้ง';
  return [...new Set(list)].sort().map(c => names?.[c] ? `${names[c]} (${c})` : c).join(', ');
}
