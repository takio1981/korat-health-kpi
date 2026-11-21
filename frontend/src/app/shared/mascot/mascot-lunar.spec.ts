import { chineseFestivalDates, datesFromAsalha, jdToDate, newMoonJde, sunLongitude } from './mascot-lunar';
import { FESTIVALS, festivalMainDate, festivalOn, missingLunar } from './mascot-festival';
import { festivalRows } from '../mascot-festival-card';

// ปรับวันที่ชุดเทศกาลอัตโนมัติ (22 พ.ย. 2569) — ค่าที่คาดหวังคือวันจริงที่ประกาศ/ใช้ในแต่ละปี
const fest = (id: string) => FESTIVALS.find(f => f.id === id)!;

describe('mascot-lunar', () => {
  it('เดือนดับ / ลองจิจูดดวงอาทิตย์ (ตรวจกับค่าในหนังสือ Meeus)', () => {
    // ตัวอย่าง 49.a: เดือนดับ ก.พ. 1977 (k = -283) JDE 2443192.65118 — ไม่รวมพจน์ดาวเคราะห์ ต่างราว 1 นาที (ไม่เกิน 3 นาที)
    expect(Math.abs(newMoonJde(-283) - 2443192.65118)).toBeLessThan(0.002);
    // ตัวอย่าง 25.a: 13 ต.ค. 1992 0h TD ลองจิจูดปรากฏ 199.909°
    expect(Math.abs(sunLongitude(2448908.5) - 199.909)).toBeLessThan(0.01);
    expect(jdToDate(2451545.0, 0)).toBe('2000-01-01');
  });

  it('ตรุษจีน / ไหว้พระจันทร์ / กินเจ ตรงวันจริง', () => {
    const cny: Record<number, string> = { 2021: '2021-02-12', 2022: '2022-02-01', 2023: '2023-01-22', 2024: '2024-02-10', 2025: '2025-01-29',
      2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26', 2029: '2029-02-13', 2030: '2030-02-03', 2031: '2031-01-23', 2032: '2032-02-11', 2033: '2033-01-31' };
    const mid: Record<number, string> = { 2021: '2021-09-21', 2022: '2022-09-10', 2023: '2023-09-29', 2024: '2024-09-17', 2025: '2025-10-06',
      2026: '2026-09-25', 2027: '2027-09-15', 2028: '2028-10-03', 2029: '2029-09-22', 2030: '2030-09-12' };
    const veg: Record<number, string> = { 2024: '2024-10-03', 2025: '2025-10-21', 2026: '2026-10-10' };
    for (const y of Object.keys(cny).map(Number)) expect(chineseFestivalDates(y).cny).toBe(cny[y]);
    for (const y of Object.keys(mid).map(Number)) expect(chineseFestivalDates(y).midautumn).toBe(mid[y]);
    for (const y of Object.keys(veg).map(Number)) expect(chineseFestivalDates(y).vegetarian).toBe(veg[y]);
  });

  it('ออกพรรษา / ลอยกระทง จากวันอาสาฬหบูชา ตรงทุกปี 2563–2570', () => {
    const real: [string, string, string][] = [
      ['2020-07-05', '2020-10-02', '2020-10-31'], ['2022-07-13', '2022-10-10', '2022-11-08'], ['2023-08-01', '2023-10-29', '2023-11-27'],
      ['2024-07-20', '2024-10-17', '2024-11-15'], ['2025-07-10', '2025-10-07', '2025-11-05'], ['2026-07-29', '2026-10-26', '2026-11-24'],
      ['2027-07-18', '2027-10-15', '2027-11-13'],
    ];
    for (const [a, ok, loy] of real) {
      const d = datesFromAsalha(a);
      expect(d.okphansa).toBe(ok); expect(d.loykrathong).toBe(loy);
    }
    expect(datesFromAsalha('2027-07-18').khaophansa).toBe('2027-07-19');
  });

  it('ลำดับแหล่งวันที่: ผู้ดูแล → ปฏิทินอัตโนมัติ → ตาราง → คำนวณ (เปิดอัตโนมัติเท่านั้น)', () => {
    const auto = { 2028: { asalha: '2028-07-06', makha: '2028-02-10' } };
    // ปิดอัตโนมัติ: ไม่มีวันที่ปี 2571
    expect(festivalMainDate(fest('loykrathong'), 2028)).toBeNull();
    // เปิด: ลอยกระทงคำนวณจากอาสาฬหบูชาที่ดึงมา
    expect(festivalMainDate(fest('loykrathong'), 2028, {}, { auto, compute: true })).toEqual({ date: '2028-11-01', source: 'derived' });
    expect(festivalMainDate(fest('makha'), 2028, {}, { auto, compute: true })).toEqual({ date: '2028-02-10', source: 'auto' });
    expect(festivalMainDate(fest('makha'), 2028, { 2028: { makha: '2028-02-11' } }, { auto, compute: true })!.source).toBe('admin');
    // ผู้ดูแลกรอกอาสาฬหบูชาเอง → ลอยกระทงคำนวณตามค่าที่กรอก
    expect(festivalMainDate(fest('loykrathong'), 2028, { 2028: { asalha: '2028-07-07' } }, { auto, compute: true })!.date).toBe('2028-11-02');
    // ปฏิทินจีน: ตารางมาก่อนคำนวณ (2034 แก้ปัญหาปี 2033)
    expect(festivalMainDate(fest('cny'), 2034, {}, { compute: true })).toEqual({ date: '2034-02-19', source: 'table' });
    expect(festivalMainDate(fest('midautumn'), 2028, {}, { compute: true })).toEqual({ date: '2028-10-03', source: 'astro' });
    expect(festivalOn('2028-11-01', {}, { auto, compute: true })?.id).toBe('loykrathong');
    // ยังไม่มีอาสาฬหบูชาของปี = วันพุทธยังขาด แต่เทศกาลจีนมีครบ
    const miss = missingLunar(2029, {}, { compute: true }).map(f => f.id);
    expect(miss).toEqual(expect.arrayContaining(['makha', 'visakha', 'asalha', 'khaophansa', 'okphansa', 'loykrathong']));
    expect(miss).not.toContain('midautumn');
    expect(miss).not.toContain('vegetarian');
  });

  it('ป้ายที่มาของวันที่ในหน้าตั้งค่า', () => {
    const rows = festivalRows(2028, {}, '2028-01-01', { auto: { 2028: { asalha: '2028-07-06' } }, compute: true });
    const src = (id: string) => rows.find(r => r.f.id === id)!.source;
    expect(src('asalha')).toBe('ปฏิทินวันหยุดราชการ (อัตโนมัติ)');
    expect(src('loykrathong')).toBe('คำนวณจากวันอาสาฬหบูชา');
    expect(src('vegetarian')).toBe('คำนวณตามปฏิทินจีน (ดาราศาสตร์)');
    expect(src('makha')).toBe('ยังไม่มีวันที่');
  });
});
