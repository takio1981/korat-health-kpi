/**
 * ชุดเทศกาลของน้องโคราชดี (21 พ.ย. 2569 — ผู้ใช้สั่ง: เปลี่ยนชุด/เครื่องประดับตามเทศกาลไทยและสากลให้ครบ)
 * ฟังก์ชันล้วน (ทดสอบได้) — ปฏิทินเทศกาล + ชุดของแต่ละเทศกาล (ตัวสร้างโมเดลอยู่ใน mascot-outfit.ts)
 *
 * วันที่ 3 แบบ:
 *  - fixed  = วันเดิมทุกปี (ปีใหม่ วาเลนไทน์ ย่าโม สงกรานต์ วันแม่ ฮาโลวีน วันพ่อ คริสต์มาส)
 *  - rule   = คำนวณได้ (วันเด็ก = เสาร์ที่ 2 ของ ม.ค., อีสเตอร์ = สูตรเกรกอเรียน)
 *  - lunar  = ตามจันทรคติไทย/จีน — ราชการประกาศล่วงหน้าเพียง 1–2 ปี จึงเก็บเป็นตาราง LUNAR_DATES (ตรวจกับประกาศ/ปฏิทินแล้ว)
 *             + ผู้ดูแลระบบกรอกปีถัดไปเองได้ที่หน้าตั้งค่าระบบ (system_settings.mascot_festival_dates) — ปีที่ไม่มีวันที่ = ไม่เปลี่ยนชุด
 * วันที่ทั้งหมดคิดตามเวลาประเทศไทย (UTC+7)
 */

export type HatKind = 'party' | 'propeller' | 'hearts' | 'chinese' | 'sunglasses' | 'witch' | 'santa' | 'bunny';
export type NeckKind = 'bowtie' | 'jasmine' | 'marigold';
export type ShellKind = 'flower' | 'chinese' | 'santa';
export type PropKind = 'sparkler' | 'balloon' | 'rose' | 'angpao' | 'lotus' | 'candle' | 'waterGun' | 'jasmine'
  | 'lantern' | 'pumpkin' | 'krathong' | 'canna' | 'gift' | 'egg';

export interface OutfitSpec {
  /** สีผ้าคลุม (ไม่ระบุ = สีเดิม) */
  cape?: number;
  /** เสื้อกั๊ก (เปิดด้านหน้า — ยังเห็นปุ่มและตราสำนักงาน) */
  shell?: ShellKind;
  hat?: HatKind;
  neck?: NeckKind;
  /** ผ้าขาวม้าพาดเฉียงไหล่ */
  sash?: boolean;
  /** ธงเจสีเหลืองตัวอักษร "เจ" ปักข้างหัว */
  flag?: boolean;
  /** ของที่ถือในมือซ้าย (ฝั่งขวาของผู้ชม — มือขวาใช้ชี้/โบก) */
  prop?: PropKind;
}

export type FestivalKind = 'fixed' | 'rule' | 'lunar';

export interface Festival {
  id: string;
  name: string;
  /** สากล / ไทย / จีน / พุทธ / โคราช — ใช้จัดกลุ่มในหน้าตั้งค่า */
  group: 'thai' | 'buddhist' | 'chinese' | 'intl' | 'korat';
  kind: FestivalKind;
  /** fixed: [เดือน, วัน] ของวันหลัก */
  md?: [number, number];
  /** ช่วงแสดงชุดเทียบกับวันหลัก (วัน) */
  before: number;
  after: number;
  /** คำอวยพร (พูดออกเสียง — ไฟล์เสียงสร้างล่วงหน้า ห้ามใช้อีโมจิ) */
  greet: string;
  outfit: OutfitSpec;
}

/** ลำดับ = ลำดับความสำคัญเมื่อช่วงวันซ้อนกัน (ตัวแรกชนะ) */
export const FESTIVALS: Festival[] = [
  // ----- วันสำคัญทางพุทธศาสนา (จันทรคติไทย)
  { id: 'makha', name: 'วันมาฆบูชา', group: 'buddhist', kind: 'lunar', before: 1, after: 0,
    greet: 'วันนี้วันมาฆบูชาครับ ร่วมทำบุญ ทำจิตใจให้ผ่องใสกันนะครับ', outfit: { cape: 0xe8c96a, neck: 'jasmine', prop: 'lotus' } },
  { id: 'visakha', name: 'วันวิสาขบูชา', group: 'buddhist', kind: 'lunar', before: 1, after: 0,
    greet: 'วันนี้วันวิสาขบูชาครับ ขอให้ทุกท่านมีความสุขสงบในจิตใจนะครับ', outfit: { cape: 0xe8c96a, neck: 'jasmine', prop: 'lotus' } },
  { id: 'asalha', name: 'วันอาสาฬหบูชา', group: 'buddhist', kind: 'lunar', before: 1, after: 0,
    greet: 'วันนี้วันอาสาฬหบูชาครับ ร่วมเวียนเทียน ทำบุญกันนะครับ', outfit: { cape: 0xe8c96a, neck: 'jasmine', prop: 'lotus' } },
  { id: 'khaophansa', name: 'วันเข้าพรรษา', group: 'buddhist', kind: 'lunar', before: 0, after: 0,
    greet: 'วันนี้วันเข้าพรรษาครับ ร่วมถวายเทียนพรรษา และตั้งใจลด ละ เลิก สิ่งไม่ดีต่อสุขภาพกันนะครับ', outfit: { cape: 0xe8a33d, neck: 'jasmine', prop: 'candle' } },
  { id: 'okphansa', name: 'วันออกพรรษา', group: 'buddhist', kind: 'lunar', before: 0, after: 1,
    greet: 'วันออกพรรษาแล้วครับ ร่วมตักบาตรเทโว ทำบุญกันนะครับ', outfit: { cape: 0xe8c96a, neck: 'jasmine', prop: 'lotus' } },
  // ----- จีน
  { id: 'cny', name: 'วันตรุษจีน', group: 'chinese', kind: 'lunar', before: 1, after: 2,
    greet: 'ซินเจียยู่อี่ ซินนี้ฮวดไช้ครับ! ขอให้ร่ำรวย สุขภาพแข็งแรงตลอดปีนะครับ', outfit: { cape: 0xc8102e, shell: 'chinese', hat: 'chinese', prop: 'angpao' } },
  { id: 'midautumn', name: 'วันไหว้พระจันทร์', group: 'chinese', kind: 'lunar', before: 1, after: 0,
    greet: 'วันไหว้พระจันทร์ครับ ขนมไหว้พระจันทร์อร่อย แต่ทานพอดี ๆ นะครับ', outfit: { cape: 0xd97706, hat: 'bunny', prop: 'lantern' } },
  { id: 'vegetarian', name: 'เทศกาลกินเจ', group: 'chinese', kind: 'lunar', before: 0, after: 8,
    greet: 'ช่วงเทศกาลกินเจครับ ทานผักให้หลากหลาย ระวังของทอดและอาหารเค็มด้วยนะครับ', outfit: { cape: 0xf4c430, flag: true } },
  // ----- ไทย
  { id: 'loykrathong', name: 'วันลอยกระทง', group: 'thai', kind: 'lunar', before: 1, after: 0,
    greet: 'คืนนี้วันลอยกระทงครับ ลอยกระทงจากวัสดุธรรมชาติ ช่วยกันรักษาแม่น้ำลำคลองกันนะครับ', outfit: { cape: 0xd4a017, neck: 'marigold', prop: 'krathong' } },
  // ----- โคราช (วันเดิมทุกปี)
  { id: 'yamo', name: 'งานฉลองวันแห่งชัยชนะของท้าวสุรนารี', group: 'korat', kind: 'fixed', md: [3, 23], before: 0, after: 11,
    greet: 'ช่วงงานฉลองวันแห่งชัยชนะของท้าวสุรนารีครับ ชาวโคราชร่วมงานย่าโมกันนะครับ', outfit: { cape: 0x7b2d8e, neck: 'marigold', sash: true } },
  // ----- วันเดิมทุกปี
  { id: 'newyear', name: 'วันขึ้นปีใหม่', group: 'intl', kind: 'fixed', md: [1, 1], before: 2, after: 1,
    greet: 'สวัสดีปีใหม่ครับ! ขอให้ทุกท่านมีความสุข สุขภาพแข็งแรงตลอดปีนะครับ', outfit: { cape: 0x283593, hat: 'party', neck: 'bowtie', prop: 'sparkler' } },
  { id: 'valentine', name: 'วันวาเลนไทน์', group: 'intl', kind: 'fixed', md: [2, 14], before: 1, after: 0,
    greet: 'สุขสันต์วันวาเลนไทน์ครับ! รักตัวเอง รักสุขภาพ และรักคนรอบข้างนะครับ', outfit: { cape: 0xe2557a, hat: 'hearts', prop: 'rose' } },
  { id: 'songkran', name: 'วันสงกรานต์', group: 'thai', kind: 'fixed', md: [4, 13], before: 1, after: 3,
    greet: 'สุขสันต์วันสงกรานต์ครับ! เล่นน้ำอย่างปลอดภัย เมาไม่ขับ และกลับบ้านไปรดน้ำขอพรผู้ใหญ่กันนะครับ', outfit: { cape: 0x00a6d6, shell: 'flower', hat: 'sunglasses', prop: 'waterGun' } },
  { id: 'motherday', name: 'วันแม่แห่งชาติ', group: 'thai', kind: 'fixed', md: [8, 12], before: 2, after: 0,
    greet: 'วันแม่แห่งชาติครับ กลับไปกอดคุณแม่ และชวนท่านตรวจสุขภาพประจำปีกันนะครับ', outfit: { cape: 0x5aa9e6, neck: 'jasmine', prop: 'jasmine' } },
  { id: 'halloween', name: 'วันฮาโลวีน', group: 'intl', kind: 'fixed', md: [10, 31], before: 2, after: 0,
    greet: 'สุขสันต์วันฮาโลวีนครับ! ขนมหวานอร่อย แต่อย่าลืมแปรงฟันนะครับ', outfit: { cape: 0x3b0a5e, hat: 'witch', prop: 'pumpkin' } },
  { id: 'fatherday', name: 'วันพ่อแห่งชาติ', group: 'thai', kind: 'fixed', md: [12, 5], before: 2, after: 0,
    greet: 'วันพ่อแห่งชาติครับ กลับไปกอดคุณพ่อ และชวนท่านดูแลสุขภาพกันนะครับ', outfit: { cape: 0xf2c94c, prop: 'canna' } },
  { id: 'christmas', name: 'วันคริสต์มาส', group: 'intl', kind: 'fixed', md: [12, 25], before: 3, after: 1,
    greet: 'เมอร์รีคริสต์มาสครับ! ขอให้มีความสุขกับช่วงเทศกาลนะครับ', outfit: { cape: 0xb91c1c, shell: 'santa', hat: 'santa', prop: 'gift' } },
  // ----- คำนวณได้
  { id: 'childrenday', name: 'วันเด็กแห่งชาติ', group: 'thai', kind: 'rule', before: 0, after: 0,
    greet: 'สุขสันต์วันเด็กครับ! เด็ก ๆ กินผัก ออกกำลังกาย และนอนหลับให้พอนะครับ', outfit: { cape: 0x2f80ed, hat: 'propeller', prop: 'balloon' } },
  { id: 'easter', name: 'วันอีสเตอร์', group: 'intl', kind: 'rule', before: 1, after: 0,
    greet: 'สุขสันต์วันอีสเตอร์ครับ!', outfit: { cape: 0x8fd19e, hat: 'bunny', prop: 'egg' } },
];

/**
 * วันหลักของเทศกาลตามจันทรคติ (ค.ศ. → id → YYYY-MM-DD) — ตรวจแล้ว 21 พ.ย. 2569:
 * พุทธ 2569–2570 ตามประกาศวันหยุด (มาฆะ 3 มี.ค. 69/21 ก.พ. 70, วิสาขะ 31 พ.ค. 69/20 พ.ค. 70, อาสาฬหะ 29 ก.ค. 69/18 ก.ค. 70,
 * ลอยกระทง 24 พ.ย. 69 และ 13 พ.ย. 70 = ออกพรรษา + 1 เดือนจันทรคติ) | ตรุษจีน 2569–2573 | เทศกาลกินเจ 2569 = 10–18 ต.ค.
 * ปีอื่น/เทศกาลที่ไม่มีในตาราง = ผู้ดูแลระบบกรอกที่หน้าตั้งค่าระบบ
 */
export const LUNAR_DATES: Record<string, Record<string, string>> = {
  '2026': { cny: '2026-02-17', makha: '2026-03-03', visakha: '2026-05-31', asalha: '2026-07-29', khaophansa: '2026-07-30',
    midautumn: '2026-09-25', vegetarian: '2026-10-10', okphansa: '2026-10-26', loykrathong: '2026-11-24' },
  '2027': { cny: '2027-02-06', makha: '2027-02-21', visakha: '2027-05-20', asalha: '2027-07-18', khaophansa: '2027-07-19',
    midautumn: '2027-09-15', vegetarian: '2027-09-30', okphansa: '2027-10-15', loykrathong: '2027-11-13' },
  '2028': { cny: '2028-01-26' },
  '2029': { cny: '2029-02-13' },
  '2030': { cny: '2030-02-03' },
};

export type FestivalDates = Record<string, Record<string, string>>;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function festivalById(id: string): Festival | null {
  return FESTIVALS.find(f => f.id === id) || null;
}

/** ตรวจ/ทำความสะอาดตารางวันที่ที่ผู้ดูแลกรอก: เฉพาะปี 2000–2199, เทศกาลแบบ lunar, วันที่จริง */
export function sanitizeFestivalDates(v: unknown): FestivalDates {
  let src: any = v;
  if (typeof src === 'string') { try { src = JSON.parse(src); } catch { return {}; } }
  const out: FestivalDates = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
  for (const y of Object.keys(src)) {
    if (!/^2[01]\d\d$/.test(y)) continue;
    const row = src[y];
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    for (const id of Object.keys(row)) {
      const f = festivalById(id);
      const d = row[id];
      if (!f || f.kind !== 'lunar' || typeof d !== 'string' || !validDate(d) || d.slice(0, 4) !== y) continue;
      (out[y] ||= {})[id] = d;
    }
  }
  return out;
}

export function validDate(d: string): boolean {
  const m = DATE_RE.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}

/** วันที่ตามเวลาไทย (YYYY-MM-DD) */
export function thaiDateKey(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** อีสเตอร์ (ปฏิทินเกรกอเรียน — Anonymous Gregorian algorithm) */
export function easterDate(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}

/** วันเด็กแห่งชาติ = วันเสาร์ที่ 2 ของเดือนมกราคม */
export function childrenDay(y: number): string {
  const dow = new Date(Date.UTC(y, 0, 1)).getUTCDay(); // 0 = อาทิตย์
  const firstSat = 1 + ((6 - dow + 7) % 7);
  return ymd(y, 1, firstSat + 7);
}

export interface FestivalSource { date: string; source: 'fixed' | 'rule' | 'table' | 'admin' }

/** วันหลักของเทศกาลในปี ค.ศ. y (null = ยังไม่มีวันที่ในปีนั้น) */
export function festivalMainDate(f: Festival, y: number, dates: FestivalDates = {}): FestivalSource | null {
  if (f.kind === 'fixed' && f.md) return { date: ymd(y, f.md[0], f.md[1]), source: 'fixed' };
  if (f.kind === 'rule') return { date: f.id === 'easter' ? easterDate(y) : childrenDay(y), source: 'rule' };
  const ys = String(y);
  if (own(dates, ys) && own(dates[ys], f.id) && validDate(dates[ys][f.id])) return { date: dates[ys][f.id], source: 'admin' };
  if (own(LUNAR_DATES, ys) && own(LUNAR_DATES[ys], f.id)) return { date: LUNAR_DATES[ys][f.id], source: 'table' };
  return null;
}

/** ช่วงที่แสดงชุด [เริ่ม, สิ้นสุด] ของเทศกาลที่วันหลักอยู่ในปี y */
export function festivalRange(f: Festival, y: number, dates: FestivalDates = {}): [string, string] | null {
  const m = festivalMainDate(f, y, dates);
  return m ? [addDays(m.date, -f.before), addDays(m.date, f.after)] : null;
}

/** เทศกาลของวันนี้ (เวลาไทย) — ช่วงของปีก่อน/ปีถัดไปที่คร่อมปี (ปีใหม่) นับด้วย */
export function festivalOn(dateKey: string, dates: FestivalDates = {}): Festival | null {
  if (!validDate(dateKey)) return null;
  const y = +dateKey.slice(0, 4);
  for (const f of FESTIVALS) {
    for (const yy of [y - 1, y, y + 1]) {
      const r = festivalRange(f, yy, dates);
      if (r && dateKey >= r[0] && dateKey <= r[1]) return f;
    }
  }
  return null;
}

/** โหมดชุดจากค่าระบบ: 'auto' (ตามเทศกาล — ค่าตั้งต้น) | 'none' (ชุดปกติเสมอ) | id เทศกาล (ใส่ชุดนั้นตลอด) */
export function normalizeOutfitMode(v: unknown): string {
  if (v === 'none' || v === 'auto') return v;
  return typeof v === 'string' && festivalById(v) ? v : 'auto';
}

/** เทศกาลที่จะแสดงตอนนี้ (null = ชุดปกติ) */
export function activeFestival(mode: string, dateKey: string, dates: FestivalDates = {}): Festival | null {
  const m = normalizeOutfitMode(mode);
  if (m === 'none') return null;
  if (m !== 'auto') return festivalById(m);
  return festivalOn(dateKey, dates);
}

/** ปี ค.ศ. ที่ยังไม่มีวันที่ของเทศกาลจันทรคติบางรายการ (ใช้เตือนในหน้าตั้งค่า) */
export function missingLunar(y: number, dates: FestivalDates = {}): Festival[] {
  return FESTIVALS.filter(f => f.kind === 'lunar' && !festivalMainDate(f, y, dates));
}
