// การคำนวณผลงานระดับบนจากระดับล่าง (ตัวชี้วัดหลายระดับ: หลัก 1 → ย่อย 1.1 → ย่อยระดับถัดไป 1.1.1 … → กิจกรรม) — เพิ่ม 18 ต.ค. 2569, ต้นไม้ 19 ต.ค. 2569
// ⚠️ มี 2 สำเนาที่ต้องตรงกันทุกบรรทัด: api/kpi-rollup.js (CommonJS) + frontend/src/app/shared/kpi-rollup.ts
//    เคสทดสอบร่วม api/tests/fixtures/rollup-cases.json = frontend/src/app/shared/kpi-rollup.cases.json (jest บังคับให้ตรงกัน)
//
// กติกาเดียวกับ loadSubAggregates() ฝั่ง backend:
//   ค่ารายเดือน = ผลรวม "ค่าล่าสุดของแต่ละรายการลูก ณ เดือนนั้น" ÷ จำนวนรายการลูกที่เปิดใช้งานทั้งหมด
//   - รายการที่ไม่ได้บันทึกในเดือนนั้นใช้ค่าล่าสุดของเดือนก่อนหน้าในปีงบเดียวกัน (ไล่ ต.ค. → ก.ย.) ยังไม่เคยบันทึก = 0
//   - เดือนที่ไม่มีรายการใดบันทึกเลย = null (ไม่ยกยอดทั้งเดือน กันเดือนในอนาคตมีค่า)
//   - ค่าที่ไม่ใช่ตัวเลขไม่นับ

export const ROLLUP_MONTH_KEYS = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];

export type MonthVals = { [mk: string]: { [childKey: string]: unknown } | null | undefined };
export type RollupResult = { [mk: string]: number | null };

export function rollupNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const t = String(v).trim();
  return /^-?(\d+(\.\d+)?|\.\d+)$/.test(t) ? parseFloat(t) : null;
}

// ค่าของกิจกรรม 1 เดือน: แบบตัวเลข = ค่าที่บันทึก, แบบทำแล้ว/ยังไม่ทำ ('check') = 100 / 0 (ร้อยละ) — ว่าง = ไม่มีค่า
export function activityValue(valueType: string, raw: unknown): number | null {
  if (valueType === 'check') {
    const t = raw === null || raw === undefined ? '' : String(raw).trim().toLowerCase();
    if (t === '1' || t === 'true') return 100;
    if (t === '0' || t === 'false') return 0;
    return null;
  }
  return rollupNum(raw);
}

// monthVals: { m10: { <รหัสรายการลูก>: ค่า }, ... } → { m10: number|null, ... } (ปัด 4 ตำแหน่ง)
export function rollupMonthly(childCount: number, monthVals: MonthVals | null | undefined): RollupResult {
  const out: RollupResult = {};
  const latest = new Map<string, number>();
  for (const mk of ROLLUP_MONTH_KEYS) {
    const mv = monthVals ? monthVals[mk] : null;
    let has = false;
    if (mv) {
      for (const k of Object.keys(mv)) {
        const n = rollupNum(mv[k]);
        if (n !== null) { latest.set(String(k), n); has = true; }
      }
    }
    if (!has || !(childCount > 0)) { out[mk] = null; continue; }
    let sum = 0;
    for (const v of latest.values()) sum += v;
    out[mk] = Math.round((sum / childCount) * 10000) / 10000;
  }
  return out;
}

// เดือนตัวเลข (10, 11, …, 9) ↔ คีย์ m10 … m09
export const monthKey = (m: number): string => 'm' + String(m).padStart(2, '0');

// เลขข้อที่แสดง: กำหนดเอง (item_no) ก่อน ไม่งั้นสร้างจากเลขข้อแม่ + ลำดับ (เช่น "1" + ลำดับที่ 2 → "1.2", ไม่มีเลขแม่ → "2")
export function itemNumber(explicit: unknown, parentNo: unknown, index: number): string {
  const own = explicit === null || explicit === undefined ? '' : String(explicit).trim();
  if (own) return own;
  const parent = parentNo === null || parentNo === undefined ? '' : String(parentNo).trim();
  return parent ? `${parent}.${index + 1}` : String(index + 1);
}

export interface RollupNode { key: string | number; parentKey?: string | number | null; kind: 'sub' | 'activity'; auto?: boolean; valueType?: string }
export type RollupTreeResult = { [key: string]: { rolled: boolean; months: RollupResult } };

// ข้อย่อยที่ "คำนวณจากระดับล่าง" = ตั้งเป็น auto และมีรายการลูกที่เปิดใช้งาน (ข้อย่อยลูก + กิจกรรม) อย่างน้อย 1 — auto ที่ไม่มีลูก = ใช้ค่าที่กรอกเอง
export function isRolledNode(node: RollupNode | null | undefined, childCount: number): boolean {
  return !!node && node.kind === 'sub' && !!node.auto && childCount > 0;
}

// คำนวณค่าที่มีผลของทุกรายการในต้นไม้ (จากล่างขึ้นบน)
//   nodes:  [{ key, parentKey (null = ระดับบนสุด), kind: 'sub'|'activity', auto, valueType }] — เฉพาะรายการที่เปิดใช้งาน
//   values: { <key>: { m10: ค่าดิบ, ... } }
//   คืน:    { <key>: { rolled, months: { m10: number|null, ... } } }
//   กิจกรรม = activityValue(), ข้อย่อยกรอกเอง = ค่าที่กรอก (ตัวเลข), ข้อย่อยคำนวณ = rollupMonthly(จำนวนลูก, ค่าที่มีผลของลูก) — กันวนลูป
export function rollupTree(nodes: RollupNode[], values: { [key: string]: { [mk: string]: unknown } } | null | undefined): RollupTreeResult {
  const list = Array.isArray(nodes) ? nodes : [];
  const byKey = new Map<string, RollupNode>();
  const children = new Map<string, string[]>();
  for (const n of list) {
    const k = String(n.key);
    byKey.set(k, n);
    const p = n.parentKey === null || n.parentKey === undefined || n.parentKey === '' ? null : String(n.parentKey);
    if (p !== null) {
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(k);
    }
  }
  const out: RollupTreeResult = {};
  const visiting = new Set<string>();
  const empty = (): RollupResult => { const m: RollupResult = {}; for (const mk of ROLLUP_MONTH_KEYS) m[mk] = null; return m; };
  function evalNode(k: string): { rolled: boolean; months: RollupResult } {
    if (out[k]) return out[k];
    const n = byKey.get(k);
    if (!n || visiting.has(k)) return { rolled: false, months: empty() };
    visiting.add(k);
    const kids = (children.get(k) || []).filter(c => byKey.has(c));
    const raw: { [mk: string]: unknown } = (values && values[k]) || {};
    let res: { rolled: boolean; months: RollupResult };
    if (isRolledNode(n, kids.length)) {
      const mv: MonthVals = {};
      for (const mk of ROLLUP_MONTH_KEYS) mv[mk] = {};
      for (const c of kids) {
        const cm = evalNode(c).months;
        for (const mk of ROLLUP_MONTH_KEYS) if (cm[mk] !== null) (mv[mk] as { [k: string]: unknown })[c] = cm[mk];
      }
      res = { rolled: true, months: rollupMonthly(kids.length, mv) };
    } else {
      const months: RollupResult = {};
      for (const mk of ROLLUP_MONTH_KEYS) months[mk] = n.kind === 'activity' ? activityValue(n.valueType || 'number', raw[mk]) : rollupNum(raw[mk]);
      res = { rolled: false, months };
    }
    visiting.delete(k);
    out[k] = res;
    return res;
  }
  for (const n of list) evalNode(String(n.key));
  return out;
}
