import { getCurrentFiscalYear, getNextFiscalYear } from './fiscal-year.util';

// ปีงบประมาณ: 1 ต.ค. - 30 ก.ย. นับชื่อตามปี พ.ศ. ที่ปีงบสิ้นสุด — เคยเป็นบั๊กหลายจุดช่วง ต.ค.-ธ.ค.
describe('fiscal-year.util', () => {
  it('30 ก.ย. 2569 ยังเป็นปีงบ 2569', () => {
    expect(getCurrentFiscalYear(new Date(2026, 8, 30))).toBe(2569);
  });

  it('1 ต.ค. 2569 ขึ้นปีงบ 2570', () => {
    expect(getCurrentFiscalYear(new Date(2026, 9, 1))).toBe(2570);
  });

  it('31 ธ.ค. 2569 ยังเป็นปีงบ 2570 (ช่วงที่เคยคำนวณผิด)', () => {
    expect(getCurrentFiscalYear(new Date(2026, 11, 31))).toBe(2570);
  });

  it('1 ม.ค. 2570 เป็นปีงบ 2570', () => {
    expect(getCurrentFiscalYear(new Date(2027, 0, 1))).toBe(2570);
  });

  it('ปีงบถัดไป = ปีงบปัจจุบัน + 1 (ใช้ใน kpi-setup)', () => {
    expect(getNextFiscalYear(new Date(2026, 9, 5))).toBe(2571);
    expect(getNextFiscalYear(new Date(2026, 5, 1))).toBe(2570);
  });
});
