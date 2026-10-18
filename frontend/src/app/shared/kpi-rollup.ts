// การคำนวณผลงานระดับบนจากระดับล่าง (ตัวชี้วัด 3 ระดับ: หลัก 1 → ย่อย 1.1 → กิจกรรม 1.1.1) — เพิ่ม 18 ต.ค. 2569
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
