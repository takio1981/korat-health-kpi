// สรุปผล "ตรวจสอบข้อมูล" ของหน้าจัดการข้อมูล KPI ↔ KHD (28 พ.ย. 2569 — ผู้ใช้แจ้ง: ตัวเลขใน card ไม่เท่ากับจำนวนแถวเมื่อกดกรอง)
// สาเหตุเดิม: card นับ "ตาราง" (dedupe table_process) แต่ตารางแสดง "ตัวชี้วัด", card นับทุกตัวชี้วัดแต่ตารางกรองตามตัวกรองอื่นด้วย,
// ตัวชี้วัดที่ปิดส่ง KHD (upload_excel = 1 — ไม่ถูกตรวจ) นับเป็น "ยังไม่ตรวจสอบ" แต่ตัวกรอง "ไม่มีข้อมูล" แสดงรวมไว้, invalid_name ไม่อยู่ใน card ใดเลย
// → กติกาเดียว: card และตัวกรองใช้ checkCategoryOf() ตัวเดียวกัน นับต่อ "ตัวชี้วัด" บนรายการที่ผ่านตัวกรองอื่นแล้ว (ก่อนกรองสถานะตรวจสอบ)

export type CheckCategory = 'has_changes' | 'up_to_date' | 'no_data' | 'not_exported' | 'unchecked';
/** ค่าของตัวกรองสถานะตรวจสอบ — '' = ทั้งหมด */
export type CheckFilter = '' | CheckCategory;

export interface CheckSummary {
  total: number;
  has_changes: number;
  /** จำนวนแถวข้อมูลที่เพิ่ม/แก้ไข ของตัวชี้วัดที่มีการเปลี่ยนแปลง — ตารางที่ใช้ร่วมกันนับครั้งเดียว */
  data_changes: number;
  up_to_date: number;
  no_data: number;
  not_exported: number;
  unchecked: number;
  /** จำนวนตาราง (table_process ไม่ซ้ำ) ต่อกลุ่ม — แสดงประกอบเมื่อหลายตัวชี้วัดใช้ตารางเดียวกัน */
  tables: Record<'total' | 'has_changes' | 'up_to_date' | 'no_data' | 'not_exported' | 'unchecked', number>;
}

export const EMPTY_SUMMARY: CheckSummary = {
  total: 0, has_changes: 0, data_changes: 0, up_to_date: 0, no_data: 0, not_exported: 0, unchecked: 0,
  tables: { total: 0, has_changes: 0, up_to_date: 0, no_data: 0, not_exported: 0, unchecked: 0 },
};

const tpOf = (ind: any) => String(ind?.table_process || '').trim().replace(/-/g, '_').toLowerCase();

/**
 * กลุ่มของตัวชี้วัด 1 ตัว
 * - not_exported: ปิดส่งออก KHD (upload_excel = 1) — ระบบไม่ตรวจและไม่ส่งออกตัวนี้เลย
 * - unchecked: ยังไม่มีผลตรวจ (ยังไม่กด / กดแล้วแต่ batch ยังไม่ถึง)
 * - no_data: ตรวจแล้วไม่มีข้อมูลในปีงบนี้ + ชื่อตารางไม่ถูกต้อง (ส่งออกไม่ได้เหมือนกัน)
 */
export function checkCategoryOf(ind: any, chk: any): CheckCategory {
  if (Number(ind?.upload_excel) === 1) return 'not_exported';
  if (!chk) return 'unchecked';
  if (chk.status === 'has_changes') return 'has_changes';
  if (chk.status === 'up_to_date') return 'up_to_date';
  return 'no_data';
}

export function matchCheckFilter(ind: any, chk: any, filter: CheckFilter): boolean {
  return !filter || checkCategoryOf(ind, chk) === filter;
}

/** นับต่อตัวชี้วัดบน list (รายการที่ผ่านตัวกรองอื่นแล้ว) — ผลรวม 5 กลุ่ม = total เสมอ */
export function summarizeCheck(list: any[], statusOf: (id: number) => any): CheckSummary {
  const s: CheckSummary = { ...EMPTY_SUMMARY, tables: { ...EMPTY_SUMMARY.tables } };
  const tableSets: Record<string, Set<string>> = { total: new Set(), has_changes: new Set(), up_to_date: new Set(), no_data: new Set(), not_exported: new Set(), unchecked: new Set() };
  const changeByTable = new Map<string, number>();
  for (const ind of list || []) {
    const chk = statusOf(ind.id);
    const cat = checkCategoryOf(ind, chk);
    const tp = tpOf(ind);
    s.total++; s[cat]++;
    tableSets['total'].add(tp); tableSets[cat].add(tp);
    if (cat === 'has_changes' && !changeByTable.has(tp)) changeByTable.set(tp, (Number(chk.new_count) || 0) + (Number(chk.changed_count) || 0));
  }
  s.data_changes = [...changeByTable.values()].reduce((a, b) => a + b, 0);
  for (const k of Object.keys(s.tables) as (keyof CheckSummary['tables'])[]) s.tables[k] = tableSets[k].size;
  return s;
}
