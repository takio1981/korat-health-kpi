// นำเข้าผลงานจาก Excel ในหน้าต่าง "บันทึกผลงานตัวชี้วัดย่อย" (dashboard) — ฟังก์ชันล้วน ไม่แตะ DOM/HTTP
//   • แบบฟอร์ม: buildSubTemplateAoa() → ตาราง (array of arrays) ที่ dashboard เขียนเป็นไฟล์ .xlsx
//   • นำเข้า:   parseSubImportAoa() → planSubImport() → applySubChanges()  (เติมค่าลงตารางในหน้าต่าง ยังไม่บันทึก —
//               ผู้ใช้ตรวจแล้วกด "บันทึกทั้งหมด" ผ่าน saveSubResults() เดิม สิทธิ์/การล็อคจึงตรวจที่ /sub-results/upsert เหมือนพิมพ์เอง)
// กติกา: ช่องว่างในไฟล์ = ไม่เปลี่ยนค่าเดิม (สอดคล้องกับการคำนวณที่ใช้ผลงานล่าสุดของแต่ละข้อ — กรอกเฉพาะข้อที่ยังไม่ผ่าน)
//        จับคู่แถวด้วย sub_indicator_id | แถวของหน่วยบริการ/ปีงบประมาณอื่น (ถ้าไฟล์มีคอลัมน์นั้น) = ไม่ตรง ไม่นำเข้า
import { normalizeCell, MAX_VALUE_LENGTH } from './kpi-excel';

export const SUB_EXCEL_MONTHS: { month: number; label: string }[] = [
  { month: 10, label: 'ต.ค.' }, { month: 11, label: 'พ.ย.' }, { month: 12, label: 'ธ.ค.' },
  { month: 1, label: 'ม.ค.' }, { month: 2, label: 'ก.พ.' }, { month: 3, label: 'มี.ค.' },
  { month: 4, label: 'เม.ย.' }, { month: 5, label: 'พ.ค.' }, { month: 6, label: 'มิ.ย.' },
  { month: 7, label: 'ก.ค.' }, { month: 8, label: 'ส.ค.' }, { month: 9, label: 'ก.ย.' },
];
export const SUB_EXCEL_HEADERS = {
  sub_id: 'sub_indicator_id',
  hospcode: 'hospcode',
  year_bh: 'ปีงบประมาณ',
  code: 'รหัส',
  name: 'ตัวชี้วัดย่อย',
  target: 'เป้าหมาย',
};
export const SUB_EXCEL_NOTE =
  'แบบฟอร์มบันทึกผลงานตัวชี้วัดย่อย KHUPS KPI — แก้ไขได้เฉพาะคอลัมน์ "เป้าหมาย" และเดือน ต.ค.–ก.ย. | ช่องว่าง = ไม่เปลี่ยนค่าเดิม ' +
  '(ไม่ต้องกรอกครบทุกข้อ กรอกเฉพาะข้อที่ยังไม่ผ่านหรือค่าเปลี่ยน) | ห้ามแก้คอลัมน์ sub_indicator_id / hospcode / ปีงบประมาณ';

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const toCell = (v: any): string | number => {
  const s = String(v ?? '').trim();
  return NUMERIC_RE.test(s) ? Number(s) : s;
};
const sameValue = (a: string, b: string) => a === b || (NUMERIC_RE.test(a) && NUMERIC_RE.test(b) && Number(a) === Number(b));

export interface SubExcelContext { indicator_name?: string; hospcode: any; hosname?: string; year_bh: any }

/** แบบฟอร์ม: แถวคำอธิบาย + แถวบริบท (ตัวชี้วัด/หน่วยบริการ) + หัวตาราง + 1 แถวต่อข้อย่อย (พร้อมค่าปัจจุบัน) */
export function buildSubTemplateAoa(subs: any[], ctx: SubExcelContext): (string | number)[][] {
  const header = [SUB_EXCEL_HEADERS.sub_id, SUB_EXCEL_HEADERS.hospcode, SUB_EXCEL_HEADERS.year_bh, SUB_EXCEL_HEADERS.code,
    SUB_EXCEL_HEADERS.name, SUB_EXCEL_HEADERS.target, ...SUB_EXCEL_MONTHS.map(m => m.label)];
  const rows = (subs || []).map(s => [
    Number(s.id), String(ctx.hospcode ?? ''), String(ctx.year_bh ?? ''), String(s.sub_indicator_code ?? ''), String(s.sub_indicator_name ?? ''),
    toCell(s._target), ...SUB_EXCEL_MONTHS.map(m => toCell(s._actuals?.[m.month])),
  ]);
  const info = `ตัวชี้วัด: ${ctx.indicator_name ?? ''} | หน่วยบริการ: ${ctx.hosname ?? ''} (${ctx.hospcode ?? ''}) | ปีงบประมาณ ${ctx.year_bh ?? ''}`;
  return [[SUB_EXCEL_NOTE], [info], header, ...rows];
}

export interface SubImportRow {
  rowNo: number;                         // เลขแถวในไฟล์ (เริ่ม 1)
  sub_id: number;
  hospcode: string | null;               // null = ไฟล์ไม่มีคอลัมน์นี้ (ไม่ตรวจ)
  year_bh: string | null;
  values: Record<string, string>;        // 'target' + เลขเดือน ('10'…'9') เฉพาะคอลัมน์ที่มีในไฟล์
}
export interface ParsedSubImport { rows: SubImportRow[]; error?: string }

/** อ่านตารางจากไฟล์ — หาแถวหัวตารางเอง (ภายใน 15 แถวแรก) */
export function parseSubImportAoa(aoa: any[][]): ParsedSubImport {
  const norm = (v: any) => String(v ?? '').trim();
  let h = -1;
  for (let i = 0; i < Math.min((aoa || []).length, 15); i++) {
    if ((aoa[i] || []).map(norm).includes(SUB_EXCEL_HEADERS.sub_id)) { h = i; break; }
  }
  if (h < 0) return { rows: [], error: 'ไม่พบหัวตาราง (ต้องมีคอลัมน์ sub_indicator_id) — กรุณาใช้ไฟล์ที่ดาวน์โหลดจากปุ่ม "แบบฟอร์ม Excel" ในหน้าต่างนี้' };
  const head = (aoa[h] || []).map(norm);
  const col = (name: string) => head.indexOf(name);
  const cId = col(SUB_EXCEL_HEADERS.sub_id), cHos = col(SUB_EXCEL_HEADERS.hospcode), cYear = col(SUB_EXCEL_HEADERS.year_bh);
  const fieldCols: { field: string; idx: number }[] = [];
  if (col(SUB_EXCEL_HEADERS.target) >= 0) fieldCols.push({ field: 'target', idx: col(SUB_EXCEL_HEADERS.target) });
  for (const m of SUB_EXCEL_MONTHS) if (col(m.label) >= 0) fieldCols.push({ field: String(m.month), idx: col(m.label) });
  if (fieldCols.length === 0) return { rows: [], error: 'ไม่พบคอลัมน์เป้าหมายหรือเดือน (ต.ค.–ก.ย.) ในไฟล์' };

  const rows: SubImportRow[] = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const id = Number(normalizeCell(r[cId]));
    if (!Number.isInteger(id) || id <= 0) continue;               // แถวว่าง/แถวสรุป — ข้าม
    let hos: string | null = cHos >= 0 ? normalizeCell(r[cHos]) : null;
    if (hos && /^\d{1,4}$/.test(hos)) hos = hos.padStart(5, '0');  // Excel ตัดเลข 0 นำหน้ารหัสหน่วยบริการ
    const values: Record<string, string> = {};
    for (const fc of fieldCols) values[fc.field] = normalizeCell(r[fc.idx]);
    rows.push({ rowNo: i + 1, sub_id: id, hospcode: hos, year_bh: cYear >= 0 ? normalizeCell(r[cYear]) : null, values });
  }
  return { rows };
}

export interface SubCellChange { sub: any; field: string; oldVal: string; newVal: string }   // field = 'target' | เลขเดือน
export interface SubChangePlan {
  changes: SubCellChange[];
  same: number;             // ค่าเท่าเดิม
  tooLong: number;          // ยาวเกิน 100 ตัวอักษร
  unmatchedRows: number[];  // เลขแถวในไฟล์ที่ไม่ใช่ข้อย่อยของตัวชี้วัดนี้ / คนละหน่วยบริการ / คนละปีงบประมาณ
  duplicateRows: number[];  // แถวซ้ำในไฟล์ — ใช้แถวแรก
}

const currentValue = (sub: any, field: string) =>
  String((field === 'target' ? sub._target : sub._actuals?.[Number(field)]) ?? '').trim();

/** จับคู่แถวในไฟล์กับข้อย่อยในหน้าต่าง แล้วสรุปช่องที่จะเปลี่ยน */
export function planSubImport(rows: SubImportRow[], subs: any[], ctx: SubExcelContext): SubChangePlan {
  const plan: SubChangePlan = { changes: [], same: 0, tooLong: 0, unmatchedRows: [], duplicateRows: [] };
  const map = new Map<number, any>();
  for (const s of subs || []) map.set(Number(s.id), s);
  const hos = String(ctx.hospcode ?? '').trim(), year = String(ctx.year_bh ?? '').trim();
  const seen = new Set<number>();
  for (const row of rows || []) {
    const sub = map.get(row.sub_id);
    const otherScope = (row.hospcode !== null && row.hospcode !== hos) || (row.year_bh !== null && row.year_bh !== year);
    if (!sub || otherScope) { plan.unmatchedRows.push(row.rowNo); continue; }
    if (seen.has(row.sub_id)) { plan.duplicateRows.push(row.rowNo); continue; }
    seen.add(row.sub_id);
    for (const field of Object.keys(row.values)) {
      const newVal = row.values[field];
      if (newVal === '') continue;                                  // ช่องว่าง = ไม่เปลี่ยนค่าเดิม
      const oldVal = currentValue(sub, field);
      if (sameValue(oldVal, newVal)) { plan.same++; continue; }
      if (newVal.length > MAX_VALUE_LENGTH) { plan.tooLong++; continue; }
      plan.changes.push({ sub, field, oldVal, newVal });
    }
  }
  return plan;
}

/** เติมค่าลงข้อย่อย — คืนจำนวนข้อย่อยที่ถูกแก้ */
export function applySubChanges(changes: SubCellChange[]): number {
  const touched = new Set<any>();
  for (const ch of changes || []) {
    if (ch.field === 'target') ch.sub._target = ch.newVal;
    else { if (!ch.sub._actuals) ch.sub._actuals = {}; ch.sub._actuals[Number(ch.field)] = ch.newVal; }
    touched.add(ch.sub);
  }
  return touched.size;
}

export const subFieldLabel = (field: string) =>
  field === 'target' ? 'เป้าหมาย' : (SUB_EXCEL_MONTHS.find(m => String(m.month) === field)?.label || field);
