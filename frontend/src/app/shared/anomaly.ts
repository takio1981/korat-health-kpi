// ตรวจจับค่าผลงานรายเดือนที่ "อาจผิดปกติ" ตอนบันทึก (เช่น พิมพ์ 850 แทน 85) — เตือนเท่านั้น ไม่ห้ามบันทึก
// ใช้สถิติอย่างง่ายที่อธิบายให้ผู้ใช้เข้าใจได้ (เทียบกับค่ากลางของเดือนอื่น) ไม่ใช้ AI
// ลำดับข้อมูลอ้างอิง (ใช้ชุดแรกที่มี): 1) เดือนอื่นของปีงบเดียวกัน  2) ปีงบที่แล้ว (เดือนเดียวกัน → ค่ากลางทั้งปี)  3) เป้าหมาย
// เทียบกับเดือนอื่น: เตือนเมื่อค่านั้นต่างจากเดือนอื่น "ส่วนใหญ่" (เกินครึ่ง) ≥ 5 เท่า — ไม่ใช่เทียบค่ากลางตรงๆ
//   เพราะเมื่อแถวมีค่าน้อย (85, 88, 850) ค่ากลางของ "เดือนอื่น" ของค่าปกติจะถูกค่าที่ผิดดึงไป ทำให้ค่าปกติ (85, 88) ถูกเตือนไปด้วย
//   (พบจากการทดสอบหน้าจอจริง 11 ต.ค. 2569) — กรณีมีเพียง 2 ค่าที่ต่างกันมาก (85, 850) บอกไม่ได้ว่าค่าใดผิด จึงเตือนทั้งคู่
// ตั้งเกณฑ์ไว้สูงโดยเจตนา (ต่างกัน ≥ 5 เท่า) — เตือนบ่อยเกินไปผู้ใช้จะเลิกสนใจคำเตือน

export const ANOMALY_RATIO = 5;          // ต่างจากค่าอ้างอิงกี่เท่าจึงเตือน
export const ANOMALY_TARGET_RATIO = 10;  // ไม่มีข้อมูลอ้างอิงเลย: เกินเป้าหมายกี่เท่าจึงเตือน
export const ANOMALY_MIN_SCALE = 10;     // ค่าเล็กมาก (ทั้งคู่ < 10) ไม่เตือน — จำนวนนับน้อยๆ แกว่งได้เป็นปกติ (1 → 6)

export interface AnomalyContext {
  others?: any[];      // ค่าเดือนอื่นของปีงบเดียวกัน (แถวเดียวกัน ไม่รวมเดือนที่ตรวจ)
  prevSame?: any;      // ค่าเดือนเดียวกันของปีงบที่แล้ว
  prevAll?: any[];     // ค่าทุกเดือนของปีงบที่แล้ว
  target?: any;        // เป้าหมาย
}
export interface Anomaly {
  kind: 'negative' | 'high' | 'low';
  basis: 'none' | 'months' | 'prev-month' | 'prev-year' | 'target';
  ref: number | null;  // ค่าอ้างอิงที่ใช้เทียบ
  message: string;     // ข้อความภาษาไทยสำหรับ tooltip/หน้ายืนยัน
}

const NUM_RE = /^-?\d+(\.\d+)?$/;
export function toNumber(v: any): number | null {
  const s = String(v ?? '').trim().replace(/,/g, '');
  return NUM_RE.test(s) ? Number(s) : null;
}
export function median(nums: number[]): number {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2))));
const positives = (list: any[] | undefined) => (list || []).map(toNumber).filter((n): n is number => n !== null && n > 0);
/** สองค่านี้ "ใกล้กัน" หรือไม่ (ต่างกันไม่ถึง ANOMALY_RATIO เท่า หรือเป็นค่าเล็กทั้งคู่) */
const isNear = (a: number, b: number) => Math.max(a, b) < ANOMALY_MIN_SCALE || (a > 0 && b > 0 && a / b < ANOMALY_RATIO && b / a < ANOMALY_RATIO);

function compare(value: number, ref: number, basis: Anomaly['basis'], label: string): Anomaly | null {
  if (!(ref > 0) || Math.max(value, ref) < ANOMALY_MIN_SCALE) return null;
  const ratio = value / ref;
  if (ratio >= ANOMALY_RATIO) {
    return { kind: 'high', basis, ref, message: `สูงกว่า${label} (${fmt(ref)}) ประมาณ ${fmt(Math.round(ratio * 10) / 10)} เท่า — ตรวจสอบว่าพิมพ์เกินหลักหรือไม่` };
  }
  if (value > 0 && ratio <= 1 / ANOMALY_RATIO) {
    return { kind: 'low', basis, ref, message: `ต่ำกว่า${label} (${fmt(ref)}) ประมาณ ${fmt(Math.round((1 / ratio) * 10) / 10)} เท่า — ตรวจสอบว่าพิมพ์ตกหลักหรือไม่` };
  }
  return null;
}

/** คืนคำเตือนถ้าค่าดูผิดปกติ, null = ปกติ/ตรวจไม่ได้ (ค่าว่าง ข้อความ "รอดำเนินการ" ฯลฯ ไม่ตรวจ) */
export function detectAnomaly(value: any, ctx: AnomalyContext = {}): Anomaly | null {
  const v = toNumber(value);
  if (v === null) return null;
  if (v < 0) return { kind: 'negative', basis: 'none', ref: null, message: 'ค่าติดลบ — ผลงานไม่ควรน้อยกว่า 0' };

  const others = positives(ctx.others);
  if (others.length > 0) {
    // ใกล้เคียงกับเดือนอื่นอย่างน้อยครึ่งหนึ่ง = ปกติ (ค่าที่ผิดของเดือนอื่นไม่ทำให้เดือนนี้ถูกเตือนไปด้วย)
    if (others.filter(o => isNear(v, o)).length * 2 >= others.length) return null;
    return compare(v, median(others), 'months', 'ค่ากลางของเดือนอื่นในปีงบนี้');
  }

  const prevSame = toNumber(ctx.prevSame);
  if (prevSame !== null && prevSame > 0) return compare(v, prevSame, 'prev-month', 'เดือนเดียวกันของปีงบที่แล้ว');
  const prevAll = positives(ctx.prevAll);
  if (prevAll.length > 0) return compare(v, median(prevAll), 'prev-year', 'ค่ากลางของปีงบที่แล้ว');

  const target = toNumber(ctx.target);
  if (target !== null && target > 0 && Math.max(v, target) >= ANOMALY_MIN_SCALE && v / target >= ANOMALY_TARGET_RATIO) {
    return { kind: 'high', basis: 'target', ref: target, message: `สูงกว่าเป้าหมาย (${fmt(target)}) ประมาณ ${fmt(Math.round((v / target) * 10) / 10)} เท่า — ตรวจสอบว่าพิมพ์เกินหลักหรือไม่` };
  }
  return null;
}
