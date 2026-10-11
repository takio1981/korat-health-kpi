import { indicatorHostypes, indicatorAllowsHostype, unionHostypes } from './indicator-scope';

// ขอบเขตประเภทหน่วยบริการของตัวชี้วัด — ต้องให้ผลตรงกับ indicatorAllowsHostype() ใน api/server.js
describe('indicator-scope', () => {
  const only18 = { evaluation_mode: 'any_one', required_off_types: '["18"]' };
  const hosp = { evaluation_mode: 'any_one', required_off_types: ['05', '06', '07'] };
  const all = { evaluation_mode: 'all_required', required_off_types: '["18"]' };
  const unset = { evaluation_mode: 'any_one', required_off_types: null };

  it('any_one + มีรายการประเภท → เฉพาะประเภทที่ระบุ (รับทั้ง JSON string และ array)', () => {
    expect(indicatorHostypes(only18)).toEqual(['18']);
    expect(indicatorHostypes(hosp)).toEqual(['05', '06', '07']);
    expect(indicatorAllowsHostype(only18, '18')).toBe(true);
    expect(indicatorAllowsHostype(only18, '07')).toBe(false);
    expect(indicatorAllowsHostype(hosp, 7 as any)).toBe(false);   // เทียบแบบ string ตรงตัว ('7' ≠ '07')
  });

  it('all_required / ไม่ได้ตั้ง / JSON เสีย → ใช้ได้ทุกประเภท', () => {
    expect(indicatorHostypes(all)).toBeNull();
    expect(indicatorHostypes(unset)).toBeNull();
    expect(indicatorHostypes({ evaluation_mode: 'any_one', required_off_types: '[]' })).toBeNull();
    expect(indicatorHostypes({ evaluation_mode: 'any_one', required_off_types: '{bad' })).toBeNull();
    expect(indicatorAllowsHostype(all, '07')).toBe(true);
    expect(indicatorAllowsHostype(null, '07')).toBe(true);
  });

  it('ไม่ทราบประเภทหน่วยบริการ → อนุญาต (backend ตัดสินอีกชั้น)', () => {
    expect(indicatorAllowsHostype(only18, '')).toBe(true);
    expect(indicatorAllowsHostype(only18, null)).toBe(true);
  });

  it('unionHostypes รวมประเภทของทุกตัวที่เลือก — มีตัวที่ใช้ได้ทุกประเภท/ไม่ได้เลือก = ไม่จำกัด', () => {
    expect(unionHostypes([only18, hosp])).toEqual(['05', '06', '07', '18']);
    expect(unionHostypes([only18, only18])).toEqual(['18']);
    expect(unionHostypes([only18, all])).toBeNull();
    expect(unionHostypes([])).toBeNull();
  });
});
