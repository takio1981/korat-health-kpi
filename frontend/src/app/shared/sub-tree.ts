// เรียงข้อย่อยหลายระดับเป็นต้นไม้ (pre-order) พร้อมระดับและเลขข้อ — ใช้ร่วมหน้าจัดการตัวชี้วัดและหน้าต่างบันทึกผลงานย่อย (19 ต.ค. 2569)
// เลขข้อ: กำหนดเอง (item_no) ก่อน ไม่งั้น เลขข้อแม่ + ลำดับในข้อแม่ (ข้อลูกใช้ลำดับ 1..n ก่อน กิจกรรมต่อท้าย — ตรงกับ backend/ตารางบันทึกผลงาน)
import { itemNumber } from './kpi-rollup';

export interface SubTreeItem { id: any; _level: number; _no: string; _childSubCount: number; [k: string]: any }

const parentOf = (s: any): number | null =>
  (s.parent_sub_id === null || s.parent_sub_id === undefined || s.parent_sub_id === '') ? null : Number(s.parent_sub_id);

/** subs = รายการข้อย่อยของตัวชี้วัดเดียว (เรียงตาม sort_order แล้ว) — _level 0 = ระดับบนสุด
 *  onlyActive = ตัดข้อที่ปิดใช้งาน และข้อที่ข้อแม่ถูกปิด (ปิดข้อแม่ = ซ่อนทั้งสาย) */
export function orderSubTree(subs: any[], parentNo: string, onlyActive = false): SubTreeItem[] {
  const list = (subs || []).filter(s => !onlyActive || Number(s.is_active ?? 1) === 1);
  const ids = new Set(list.map(s => Number(s.id)));
  const out: SubTreeItem[] = [];
  const seen = new Set<number>();
  const walk = (p: number | null, pNo: string, level: number) => {
    list.filter(s => parentOf(s) === p).forEach((s, i) => {
      const id = Number(s.id);
      if (seen.has(id)) return;
      seen.add(id);
      const no = itemNumber(s.item_no, pNo, i);
      const kids = list.filter(c => parentOf(c) === id).length;
      out.push({ ...s, _level: level, _no: no, _childSubCount: kids });
      walk(id, no, level + 1);
    });
  };
  walk(null, parentNo, 0);
  // ข้อที่ข้อแม่ไม่อยู่ในรายการ (ข้อมูลผิดปกติ) — แสดงต่อท้ายเป็นระดับบนสุดเมื่อไม่ได้กรองเฉพาะที่เปิดใช้งาน
  if (!onlyActive) for (const s of list) if (!seen.has(Number(s.id)) && !ids.has(parentOf(s) as number)) out.push({ ...s, _level: 0, _no: itemNumber(s.item_no, parentNo, out.length), _childSubCount: 0 });
  return out;
}
