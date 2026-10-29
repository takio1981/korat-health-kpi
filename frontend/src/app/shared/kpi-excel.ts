// นำเข้า/วางผลงานจาก Excel ในหน้าบันทึกผลงาน (dashboard โหมดแก้ไข) — ฟังก์ชันล้วน ไม่ผูกกับ Angular/xlsx
//   • แบบฟอร์ม: buildTemplateAoa() → ตาราง (array of arrays) ที่ dashboard เขียนเป็นไฟล์ .xlsx
//   • นำเข้า:   parseImportAoa() → planImport() → applyCellChanges()  (เติมค่าลงตารางแก้ไข ยังไม่บันทึก — ผู้ใช้ตรวจแล้วกดบันทึกเอง)
//   • วาง:      parseClipboardGrid() → planPaste() → applyCellChanges()
// กติการ่วม: ช่องว่างในไฟล์/คลิปบอร์ด = ไม่เปลี่ยนค่าเดิม (ไม่ล้างค่า) | แถวที่ล็อค/ไม่มีสิทธิ์ = ข้าม | ค่ายาวเกิน 100 ตัวอักษร = ข้าม
// สิทธิ์จริงยังตรวจที่ backend ตอนบันทึก (/update-kpi) เหมือนการพิมพ์เองทุกประการ

import { normalizeTargetMonthly } from './kpi-target';

export const EXCEL_MONTHS: { key: string; label: string }[] = [
  { key: 'oct', label: 'ต.ค.' }, { key: 'nov', label: 'พ.ย.' }, { key: 'dece', label: 'ธ.ค.' },
  { key: 'jan', label: 'ม.ค.' }, { key: 'feb', label: 'ก.พ.' }, { key: 'mar', label: 'มี.ค.' },
  { key: 'apr', label: 'เม.ย.' }, { key: 'may', label: 'พ.ค.' }, { key: 'jun', label: 'มิ.ย.' },
  { key: 'jul', label: 'ก.ค.' }, { key: 'aug', label: 'ส.ค.' }, { key: 'sep', label: 'ก.ย.' },
];
export const EXCEL_HEADERS = {
  indicator_id: 'indicator_id',
  hospcode: 'hospcode',
  year_bh: 'ปีงบประมาณ',
  main: 'หมวดหมู่หลัก',
  name: 'ตัวชี้วัด',
  hosname: 'หน่วยบริการ',
  note: 'หมายเหตุ',
  target: 'เป้าหมาย',
  base: 'ค่าฐาน',            // ค่าฐานของสูตร (base) — มีเฉพาะเมื่อตัวชี้วัดในตารางใช้สูตรที่อ้าง base (24 ต.ค. 2569)
  manualResult: 'ผลงานล่าสุด (กรอกเอง)',   // มีเฉพาะเมื่อตัวชี้วัดในตารางตั้งให้กรอกผลงานล่าสุดเอง (29 ต.ค. 2569)
  manualPct: 'ร้อยละ (กรอกเอง)',           // มีเฉพาะเมื่อตัวชี้วัดในตารางตั้งให้กรอกร้อยละเอง
};
// เป้าหมายรายเดือน (29 ต.ค. 2569): คอลัมน์ "เป้าหมาย ต.ค." … "เป้าหมาย ก.ย." (ฟิลด์ t_<เดือน>) — มีเฉพาะเมื่อมีแถวที่ตั้งเป้าหมายรายเดือน
// แถวเหล่านี้ "เป้าหมาย" = เป้าหมายรวมที่คำนวณ (นำเข้าไม่ได้) | สิทธิ์เดียวกับเป้าหมาย
export const monthTargetHeader = (label: string) => 'เป้าหมาย ' + label;
const isMonthlyTargetRow = (it: any) => !!normalizeTargetMonthly(it?.target_monthly);
const isManualRow = (it: any, f: string) => f === 'manual_result'
  ? (it?.result_manual === true || Number(it?.result_manual) === 1)
  : (it?.pct_manual === true || Number(it?.pct_manual) === 1);
export const EXCEL_NOTE =
  'แบบฟอร์มบันทึกผลงาน KHUPS KPI — แก้ไขได้เฉพาะคอลัมน์ "เป้าหมาย" "ค่าฐาน"/ค่าเพิ่มเติม "ผลงานล่าสุด/ร้อยละ (กรอกเอง)" "เป้าหมาย <เดือน>" (ถ้ามี) และเดือน ต.ค.–ก.ย. | ห้ามแก้ไขหรือลบคอลัมน์ indicator_id, hospcode, ปีงบประมาณ | ช่องว่าง = ไม่เปลี่ยนค่าเดิม';
export const MAX_VALUE_LENGTH = 100;   // kpi_results.actual_value / target_value = VARCHAR(100)

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** ค่าจากเซลล์ Excel/คลิปบอร์ด → ข้อความที่ระบบเก็บ (ตัดช่องว่าง, ตัดจุลภาคคั่นหลักพัน, ตัดเศษทศนิยมลอยของ Excel) */
export function normalizeCell(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    return String(parseFloat(v.toFixed(6)));   // 0.1+0.2 → 0.3, 85 → "85"
  }
  let s = String(v).replace(/ /g, ' ').trim();
  if (s === '-' || s === '—' || s === '–') return '';
  const noComma = s.replace(/,/g, '');
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) && NUMERIC_RE.test(noComma)) s = noComma;   // 1,234.5 → 1234.5
  return s;
}

/** ค่าที่ระบบเก็บ → ค่าที่เขียนลงเซลล์ (ตัวเลขเขียนเป็น number เพื่อให้ Excel คำนวณ/จัดรูปแบบได้) */
function toCell(v: any): string | number {
  const s = String(v ?? '').trim();
  return NUMERIC_RE.test(s) ? Number(s) : s;
}

/** หัวคอลัมน์ของค่าเพิ่มเติม: base = "ค่าฐาน" (เดิม) | อื่นๆ = "ชื่อที่แสดง [key]" — ตอนนำเข้าอ่าน key จากวงเล็บ */
export function customVarHeader(v: { key: string; label: string }): string {
  return v.key === 'base' ? EXCEL_HEADERS.base : `${v.label} [${v.key}]`;
}

/** สร้างตารางแบบฟอร์ม (แถวคำอธิบาย + หัวตาราง + 1 แถวต่อ ตัวชี้วัด × หน่วยบริการ)
 *  vars = ค่าฐาน/ค่าเพิ่มเติมที่ตัวชี้วัดในตารางใช้ → 1 คอลัมน์ต่อค่าต่อจากเป้าหมาย (แถวที่ไม่มีค่านั้นเว้นว่าง) | withBase = แบบเดิม (base อย่างเดียว) */
export function buildTemplateAoa(items: any[], opts: { withBase?: boolean; vars?: { key: string; label: string }[] } = {}): (string | number)[][] {
  const vars = opts.vars ?? (opts.withBase ? [{ key: 'base', label: 'ค่าฐาน' }] : []);
  // ผลงานล่าสุด/ร้อยละ แบบกรอกเอง — มีคอลัมน์เมื่อมีแถวที่ตั้งกรอกเอง (แถวอื่นเว้นว่าง)
  const manual = (['manual_result', 'manual_pct'] as const).filter(f => (items || []).some(it => isManualRow(it, f)));
  const manualHead = manual.map(f => f === 'manual_result' ? EXCEL_HEADERS.manualResult : EXCEL_HEADERS.manualPct);
  const monthly = (items || []).some(isMonthlyTargetRow);
  const mtHead = monthly ? EXCEL_MONTHS.map(m => monthTargetHeader(m.label)) : [];
  const header = [EXCEL_HEADERS.indicator_id, EXCEL_HEADERS.hospcode, EXCEL_HEADERS.year_bh, EXCEL_HEADERS.main, EXCEL_HEADERS.name,
    EXCEL_HEADERS.hosname, EXCEL_HEADERS.note, EXCEL_HEADERS.target, ...vars.map(customVarHeader), ...manualHead, ...mtHead, ...EXCEL_MONTHS.map(m => m.label)];
  const rows = (items || []).map(it => [
    Number(it.indicator_id), String(it.hospcode ?? ''), String(it.year_bh ?? ''), String(it.main_indicator_name ?? ''),
    String(it.kpi_indicators_name ?? ''), String(it.hosname ?? ''), it.is_locked ? 'ล็อคแล้ว (นำเข้าไม่ได้)' : '',
    toCell(it.target_value), ...vars.map(v => toCell(it['cv_' + v.key])), ...manual.map(f => isManualRow(it, f) ? toCell(it[f]) : ''),
    ...(monthly ? EXCEL_MONTHS.map(m => isMonthlyTargetRow(it) ? toCell(it['t_' + m.key]) : '') : []),
    ...EXCEL_MONTHS.map(m => toCell(it[m.key])),
  ]);
  return [[EXCEL_NOTE], header, ...rows];
}

export interface ImportRow {
  rowNo: number;                       // เลขแถวในไฟล์ (เริ่ม 1) — ใช้แจ้งผู้ใช้
  indicator_id: number;
  hospcode: string;
  year_bh: string;
  values: Record<string, string>;      // target_value + คีย์เดือน เฉพาะคอลัมน์ที่มีในไฟล์
}
export interface ParsedImport { rows: ImportRow[]; fields: string[]; error?: string }

/** อ่านตารางจากไฟล์ — หาแถวหัวตารางเอง (ภายใน 15 แถวแรก) และจับคู่คอลัมน์ตามชื่อหัว (สลับ/ลบคอลัมน์ที่ไม่ใช้ได้) */
export function parseImportAoa(aoa: any[][]): ParsedImport {
  const norm = (v: any) => String(v ?? '').trim();
  let h = -1;
  for (let i = 0; i < Math.min((aoa || []).length, 15); i++) {
    const cells = (aoa[i] || []).map(norm);
    if (cells.includes(EXCEL_HEADERS.indicator_id) && cells.includes(EXCEL_HEADERS.hospcode)) { h = i; break; }
  }
  if (h < 0) return { rows: [], fields: [], error: 'ไม่พบหัวตาราง (ต้องมีคอลัมน์ indicator_id และ hospcode) — กรุณาใช้ไฟล์ที่ดาวน์โหลดจากปุ่ม "แบบฟอร์ม Excel"' };
  const head = (aoa[h] || []).map(norm);
  const col = (name: string) => head.indexOf(name);
  const cId = col(EXCEL_HEADERS.indicator_id), cHos = col(EXCEL_HEADERS.hospcode), cYear = col(EXCEL_HEADERS.year_bh);
  if (cYear < 0) return { rows: [], fields: [], error: 'ไม่พบคอลัมน์ "ปีงบประมาณ" ในไฟล์' };
  const fieldCols: { field: string; idx: number }[] = [];
  if (col(EXCEL_HEADERS.target) >= 0) fieldCols.push({ field: 'target_value', idx: col(EXCEL_HEADERS.target) });
  // ค่าฐาน ("ค่าฐาน") + ค่าเพิ่มเติม ("ชื่อ [key]") → ฟิลด์ cv_<key>
  head.forEach((hh, idx) => {
    const m = /\[([a-z][a-z0-9_]{0,19})\]$/.exec(hh);
    if (hh === EXCEL_HEADERS.base) fieldCols.push({ field: 'cv_base', idx });
    else if (m) fieldCols.push({ field: 'cv_' + m[1], idx });
  });
  if (col(EXCEL_HEADERS.manualResult) >= 0) fieldCols.push({ field: 'manual_result', idx: col(EXCEL_HEADERS.manualResult) });
  if (col(EXCEL_HEADERS.manualPct) >= 0) fieldCols.push({ field: 'manual_pct', idx: col(EXCEL_HEADERS.manualPct) });
  for (const m of EXCEL_MONTHS) if (col(monthTargetHeader(m.label)) >= 0) fieldCols.push({ field: 't_' + m.key, idx: col(monthTargetHeader(m.label)) });
  for (const m of EXCEL_MONTHS) if (col(m.label) >= 0) fieldCols.push({ field: m.key, idx: col(m.label) });
  if (fieldCols.length === 0) return { rows: [], fields: [], error: 'ไม่พบคอลัมน์เป้าหมายหรือเดือน (ต.ค.–ก.ย.) ในไฟล์' };

  const rows: ImportRow[] = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const id = Number(normalizeCell(r[cId]));
    let hos = normalizeCell(r[cHos]);
    if (!Number.isInteger(id) || id <= 0 || !hos) continue;        // แถวว่าง/แถวสรุป — ข้าม
    if (/^\d{1,4}$/.test(hos)) hos = hos.padStart(5, '0');        // Excel ตัดเลข 0 นำหน้ารหัสหน่วยบริการ
    const values: Record<string, string> = {};
    for (const fc of fieldCols) values[fc.field] = normalizeCell(r[fc.idx]);
    rows.push({ rowNo: i + 1, indicator_id: id, hospcode: hos, year_bh: normalizeCell(r[cYear]), values });
  }
  return { rows, fields: fieldCols.map(f => f.field) };
}

export interface CellChange { item: any; field: string; oldVal: string; newVal: string }
export interface EditPerms { canEditActual: boolean; canEditTarget: boolean }
export interface ChangePlan {
  changes: CellChange[];
  same: number;            // ค่าเท่าเดิม
  locked: number;          // แถวล็อค
  noPerm: number;          // ไม่มีสิทธิ์แก้ไขช่องนั้น
  tooLong: number;         // ยาวเกิน 100 ตัวอักษร
  unmatchedRows: number[]; // (นำเข้า) เลขแถวในไฟล์ที่ไม่พบในตารางที่แสดงอยู่
  duplicateRows: number[]; // (นำเข้า) แถวซ้ำในไฟล์ — ใช้แถวแรก
  overflow: number;        // (วาง) ช่องที่เกินขอบตาราง
}

function emptyPlan(): ChangePlan {
  return { changes: [], same: 0, locked: 0, noPerm: 0, tooLong: 0, unmatchedRows: [], duplicateRows: [], overflow: 0 };
}

function sameValue(a: string, b: string): boolean {
  if (a === b) return true;
  return NUMERIC_RE.test(a) && NUMERIC_RE.test(b) && Number(a) === Number(b);
}

/** พิจารณา 1 ช่อง: เพิ่มเข้า plan.changes หรือเพิ่มตัวนับเหตุผลที่ข้าม */
function considerCell(plan: ChangePlan, item: any, field: string, raw: any, perms: EditPerms): void {
  const newVal = normalizeCell(raw);
  if (newVal === '') return;                                   // ช่องว่าง = ไม่เปลี่ยนค่าเดิม
  // ค่าฐาน/ค่าเพิ่มเติม: เฉพาะแถวที่ตัวชี้วัดใช้ค่านั้น (backend แนบ cv_<key> มาให้เฉพาะแถวนั้น) — แถวอื่นข้ามเงียบๆ
  if (field.startsWith('cv_') && !Object.prototype.hasOwnProperty.call(item, field)) return;
  // ผลงานล่าสุด/ร้อยละ แบบกรอกเอง: เฉพาะแถวของตัวชี้วัดที่ตั้งกรอกเอง — แถวอื่นข้ามเงียบๆ (สิทธิ์เดียวกับผลงาน)
  if ((field === 'manual_result' || field === 'manual_pct') && !isManualRow(item, field)) return;
  // เป้าหมายรายเดือน: t_<เดือน> เฉพาะแถวที่ตั้งเป้าหมายรายเดือน และแถวนั้นไม่นำเข้า "เป้าหมาย" (เป้าหมายรวมคำนวณเอง) — ข้ามเงียบๆ
  if (field.startsWith('t_') ? !isMonthlyTargetRow(item) : (field === 'target_value' && isMonthlyTargetRow(item))) return;
  // เทียบค่าเดิมก่อน — ค่าที่ไม่ได้แก้ในไฟล์ (เท่าเดิม) ของแถวล็อค/ช่องที่ไม่มีสิทธิ์ ไม่ถือว่า "ถูกข้าม" (ไม่ทำให้ผู้ใช้ตกใจ)
  const oldVal = String(item[field] ?? '').trim();
  if (sameValue(oldVal, newVal)) { plan.same++; return; }
  if (item.is_locked) { plan.locked++; return; }
  const allowed = field === 'target_value' || field.startsWith('cv_') || field.startsWith('t_') ? perms.canEditTarget : perms.canEditActual;  // ค่าฐาน/ค่าเพิ่มเติม/เป้าหมายรายเดือน = สิทธิ์เดียวกับเป้าหมาย
  if (!allowed) { plan.noPerm++; return; }
  if (newVal.length > MAX_VALUE_LENGTH) { plan.tooLong++; return; }
  plan.changes.push({ item, field, oldVal, newVal });
}

export const itemKey = (indicatorId: any, hospcode: any, yearBh: any) => `${Number(indicatorId)}|${String(hospcode ?? '').trim()}|${String(yearBh ?? '').trim()}`;

/** จับคู่แถวในไฟล์กับแถวในตาราง (ตัวชี้วัด × หน่วยบริการ × ปีงบ) แล้วสรุปช่องที่จะเปลี่ยน */
export function planImport(rows: ImportRow[], items: any[], perms: EditPerms): ChangePlan {
  const plan = emptyPlan();
  const map = new Map<string, any>();
  for (const it of items || []) map.set(itemKey(it.indicator_id, it.hospcode, it.year_bh), it);
  const seen = new Set<string>();
  for (const row of rows || []) {
    const key = itemKey(row.indicator_id, row.hospcode, row.year_bh);
    const item = map.get(key);
    if (!item) { plan.unmatchedRows.push(row.rowNo); continue; }
    if (seen.has(key)) { plan.duplicateRows.push(row.rowNo); continue; }
    seen.add(key);
    for (const field of Object.keys(row.values)) considerCell(plan, item, field, row.values[field], perms);
  }
  return plan;
}

/** ข้อความจากคลิปบอร์ด (คัดลอกหลายช่องจาก Excel = แท็บคั่นคอลัมน์ ขึ้นบรรทัดคั่นแถว) → ตาราง */
export function parseClipboardGrid(text: string): string[][] {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();   // Excel ปิดท้ายด้วยบรรทัดว่าง
  return lines.map(l => l.split('\t'));
}

/** คลิปบอร์ดมีมากกว่า 1 ช่องหรือไม่ (ช่องเดียว = ปล่อยให้เบราว์เซอร์วางตามปกติ) */
export function isMultiCell(grid: string[][]): boolean {
  return grid.length > 1 || (grid[0]?.length ?? 0) > 1;
}

/** วางตารางลงตารางแก้ไข เริ่มที่ (startRow, fields[0]) ไล่ลง/ไปทางขวา — fields = คอลัมน์ที่แสดงอยู่ตั้งแต่ช่องที่วางเป็นต้นไป */
export function planPaste(grid: string[][], rowItems: any[], startRow: number, fields: string[], perms: EditPerms): ChangePlan {
  const plan = emptyPlan();
  for (let r = 0; r < grid.length; r++) {
    const item = (rowItems || [])[startRow + r];
    for (let c = 0; c < grid[r].length; c++) {
      if (normalizeCell(grid[r][c]) === '') continue;
      const field = fields[c];
      if (!item || !field) { plan.overflow++; continue; }
      considerCell(plan, item, field, grid[r][c], perms);
    }
  }
  return plan;
}

/** เติมค่าลงแถว — คืนรายการแถวที่ถูกแก้ (ไม่ซ้ำ) ให้ผู้เรียกคำนวณผลงานล่าสุดใหม่ */
export function applyCellChanges(changes: CellChange[]): any[] {
  const touched = new Set<any>();
  for (const ch of changes || []) { ch.item[ch.field] = ch.newVal; touched.add(ch.item); }
  return Array.from(touched);
}
