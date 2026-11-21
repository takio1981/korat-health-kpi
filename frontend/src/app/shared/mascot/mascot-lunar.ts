/**
 * คำนวณวันเทศกาลตามจันทรคติอัตโนมัติ (22 พ.ย. 2569 — ผู้ใช้สั่ง: ปรับวันที่เปลี่ยนชุดอัตโนมัติเมื่อขึ้นปีใหม่) — ฟังก์ชันล้วน ไม่ใช้เครือข่าย
 *
 * 1) จากวันอาสาฬหบูชา (ทางการ): เดือนจันทรคติไทยหลังเดือน 8 ยาวตายตัว (เดือน 8 = 30, 9 = 29, 10 = 30, 11 = 29 วัน — อธิกวารเพิ่มที่เดือน 7 ก่อนหน้า)
 *    → เข้าพรรษา = +1, ออกพรรษา (ขึ้น 15 ค่ำ เดือน 11) = +89, ลอยกระทง (ขึ้น 15 ค่ำ เดือน 12) = +118 — ตรวจกับวันจริง พ.ศ. 2563–2570 ตรงทุกปี
 *    (มาฆบูชา/วิสาขบูชา/อาสาฬหบูชา คำนวณไม่ได้แน่นอน — อธิกมาส/อธิกวารตามประกาศ จึงใช้ปฏิทินวันหยุดราชการ)
 * 2) เทศกาลจีน (ดาราศาสตร์ — Meeus, Astronomical Algorithms บทที่ 25 และ 49): เดือนจีนเริ่มวันเดือนดับ (เวลาปักกิ่ง UTC+8)
 *    เลขเดือนตามจงชี่ที่อยู่ในเดือนนั้น: เดือน 1 มี 雨水 (ดวงอาทิตย์ 330°), เดือน 8 มีวันศารทวิษุวัต (180°), เดือน 9 มี 霜降 (210°)
 *    → ตรุษจีน = วันแรกเดือน 1, ไหว้พระจันทร์ = 15 ค่ำเดือน 8, กินเจ = วันแรกเดือน 9 — ตรวจกับวันจริงในชุดทดสอบ
 */

const RAD = Math.PI / 180;
const sinD = (d: number) => Math.sin(d * RAD);

/** JD (เวลา TT ≈ UT ต่างกันราว 1 นาที — ไม่มีผลกับวันที่) → YYYY-MM-DD ตามเขตเวลา tzHours */
export function jdToDate(jd: number, tzHours: number): string {
  const ms = (jd - 2440587.5) * 86400000 + tzHours * 3600000;
  return new Date(ms).toISOString().slice(0, 10);
}
function dateToJd(d: string): number {
  return Date.parse(d + 'T00:00:00Z') / 86400000 + 2440587.5;
}
function addDays(d: string, n: number): string {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

/** เวลาเดือนดับครั้งที่ k นับจาก ม.ค. 2000 (JDE) — Meeus บทที่ 49 (ไม่รวมพจน์ดาวเคราะห์ ซึ่งต่างไม่ถึง 1 นาที) */
export function newMoonJde(k: number): number {
  const T = k / 1236.85, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const M = 2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3;
  const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4;
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;
  const O = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;
  jde += -0.4072 * sinD(Mp) + 0.17241 * E * sinD(M) + 0.01608 * sinD(2 * Mp) + 0.01039 * sinD(2 * F)
    + 0.00739 * E * sinD(Mp - M) - 0.00514 * E * sinD(Mp + M) + 0.00208 * E * E * sinD(2 * M)
    - 0.00111 * sinD(Mp - 2 * F) - 0.00057 * sinD(Mp + 2 * F) + 0.00056 * E * sinD(2 * Mp + M)
    - 0.00042 * sinD(3 * Mp) + 0.00042 * E * sinD(M + 2 * F) + 0.00038 * E * sinD(M - 2 * F)
    - 0.00024 * E * sinD(2 * Mp - M) - 0.00017 * sinD(O) - 0.00007 * sinD(Mp + 2 * M)
    + 0.00004 * sinD(2 * Mp - 2 * F) + 0.00004 * sinD(3 * M) + 0.00003 * sinD(Mp + M - 2 * F)
    + 0.00003 * sinD(2 * Mp + 2 * F) - 0.00003 * sinD(Mp + M + 2 * F) + 0.00003 * sinD(Mp - M + 2 * F)
    - 0.00002 * sinD(Mp - M - 2 * F) - 0.00002 * sinD(3 * Mp + M) + 0.00002 * sinD(4 * Mp);
  return jde;
}

/** ลองจิจูดปรากฏของดวงอาทิตย์ (องศา) — Meeus บทที่ 25 แบบความแม่นต่ำ (~0.01°) */
export function sunLongitude(jd: number): number {
  const T = (jd - 2451545) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sinD(M) + (0.019993 - 0.000101 * T) * sinD(2 * M) + 0.000289 * sinD(3 * M);
  const om = 125.04 - 1934.136 * T;
  const lam = L0 + C - 0.00569 - 0.00478 * sinD(om);
  return ((lam % 360) + 360) % 360;
}

/** เวลา (JD) ที่ดวงอาทิตย์อยู่ที่ลองจิจูด target ใกล้วันที่ประมาณ approxJd */
export function solarTermJd(target: number, approxJd: number): number {
  let jd = approxJd;
  for (let i = 0; i < 30; i++) {
    const d = ((target - sunLongitude(jd) + 540) % 360) - 180; // -180..180
    jd += d * 365.2422 / 360;
    if (Math.abs(d) < 1e-6) break;
  }
  return jd;
}

/** วันเดือนดับ (เวลาปักกิ่ง) ที่เริ่มเดือนจีนซึ่งมีวันที่ termDate อยู่ */
function chineseMonthStart(termJd: number): string {
  const termDate = jdToDate(termJd, 8);
  let k = Math.floor((termJd - 2451550.09766) / 29.530588861) + 1;
  for (let i = 0; i < 4; i++) { // หาเดือนดับล่าสุดที่วันที่ (ปักกิ่ง) ไม่เกินวันจงชี่
    const d = jdToDate(newMoonJde(k), 8);
    if (d <= termDate) return d;
    k--;
  }
  return jdToDate(newMoonJde(k), 8);
}

/** วันหลักของเทศกาลจีนในปี ค.ศ. y */
export function chineseFestivalDates(y: number): { cny: string; midautumn: string; vegetarian: string } {
  const near = (m: number, d: number) => dateToJd(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const m1 = chineseMonthStart(solarTermJd(330, near(2, 19)));
  const m8 = chineseMonthStart(solarTermJd(180, near(9, 23)));
  const m9 = chineseMonthStart(solarTermJd(210, near(10, 23)));
  return { cny: m1, midautumn: addDays(m8, 14), vegetarian: m9 };
}

/** เข้าพรรษา / ออกพรรษา / ลอยกระทง จากวันอาสาฬหบูชาของปีเดียวกัน */
export function datesFromAsalha(asalha: string): { khaophansa: string; okphansa: string; loykrathong: string } {
  return { khaophansa: addDays(asalha, 1), okphansa: addDays(asalha, 89), loykrathong: addDays(asalha, 118) };
}
