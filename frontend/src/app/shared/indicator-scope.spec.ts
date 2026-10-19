import { indicatorHostypes, indicatorAllowsHostype, indicatorTypeSetting, autoTargetHostypes, resolveAddKpiTargets, AUTO_ALL_HOSTYPES } from './indicator-scope';

// ขอบเขตประเภทหน่วยบริการของตัวชี้วัด — ต้องให้ผลตรงกับ indicatorTypeSetting()/indicatorAllowsHostype() ใน api/server.js
describe('indicator-scope', () => {
  const only18 = { evaluation_mode: 'any_one', required_off_types: '["18"]' };
  const hosp = { evaluation_mode: 'any_one', required_off_types: ['05', '06', '07'] };
  const all = { evaluation_mode: 'all_required', required_off_types: null };
  const unset = { evaluation_mode: 'any_one', required_off_types: null };

  it('any_one + มีรายการประเภท → เฉพาะประเภทที่ระบุ (รับทั้ง JSON string และ array)', () => {
    expect(indicatorHostypes(only18)).toEqual(['18']);
    expect(indicatorHostypes(hosp)).toEqual(['05', '06', '07']);
    expect(indicatorAllowsHostype(only18, '18')).toBe(true);
    expect(indicatorAllowsHostype(only18, '07')).toBe(false);
    expect(indicatorAllowsHostype(hosp, 7 as any)).toBe(false);   // เทียบแบบ string ตรงตัว ('7' ≠ '07')
  });

  it('สถานะการตั้งค่า: types / all / unset (ว่าง, any_one ไม่มีรายการ, JSON เสีย)', () => {
    expect(indicatorTypeSetting(only18)).toBe('types');
    expect(indicatorTypeSetting(all)).toBe('all');
    expect(indicatorTypeSetting(unset)).toBe('unset');
    expect(indicatorTypeSetting({ evaluation_mode: null })).toBe('unset');
    expect(indicatorTypeSetting({ evaluation_mode: 'any_one', required_off_types: '[]' })).toBe('unset');
    expect(indicatorTypeSetting({ evaluation_mode: 'any_one', required_off_types: '{bad' })).toBe('unset');
    expect(indicatorTypeSetting(null)).toBe('unset');
  });

  // 19 ต.ค. 2569 — เดิม "ยังไม่ได้ตั้ง" = ใช้ได้ทุกประเภท ทำให้เพิ่มตัวชี้วัดให้หน่วยบริการทุกแห่งโดยไม่ได้ตั้งใจ
  it('ยังไม่ได้ตั้งประเภท → ใช้กับหน่วยบริการใดไม่ได้ / ทุกประเภท → ใช้ได้ทุกประเภท', () => {
    expect(indicatorAllowsHostype(unset, '18')).toBe(false);
    expect(indicatorAllowsHostype(null, '07')).toBe(false);
    expect(indicatorAllowsHostype(all, '02')).toBe(true);
  });

  it('ไม่ทราบประเภทหน่วยบริการ → อนุญาตเฉพาะตัวที่ตั้งค่าแล้ว (backend ตัดสินอีกชั้น)', () => {
    expect(indicatorAllowsHostype(only18, '')).toBe(true);
    expect(indicatorAllowsHostype(only18, null)).toBe(true);
    expect(indicatorAllowsHostype(unset, '')).toBe(false);
  });

  it('ประเภทที่เพิ่มอัตโนมัติ: any_one = รายการที่ตั้ง / all_required = 4 ประเภทหลัก / unset = null', () => {
    expect(autoTargetHostypes(only18)).toEqual(['18']);
    expect(autoTargetHostypes(all)).toEqual(['05', '06', '07', '18']);
    expect(AUTO_ALL_HOSTYPES).toEqual(['05', '06', '07', '18']);
    expect(autoTargetHostypes(unset)).toBeNull();
  });

  describe('resolveAddKpiTargets', () => {
    const hospitals = [
      { hoscode: 'H07', hostype: '07', distid: '3001' },
      { hoscode: 'S18a', hostype: '18', distid: '3001' },
      { hoscode: 'S18b', hostype: '18', distid: '3002' },
      { hoscode: 'O02', hostype: '02', distid: '3001' },   // สสอ. — ไม่อยู่ใน 4 ประเภทหลัก
    ];

    it('หลายแห่ง: เลือกตามประเภทที่ตั้งไว้ + จำกัดอำเภอได้', () => {
      expect(resolveAddKpiTargets(only18, hospitals)).toEqual(['S18a', 'S18b']);
      expect(resolveAddKpiTargets(only18, hospitals, { districts: ['3002'] })).toEqual(['S18b']);
      expect(resolveAddKpiTargets(all, hospitals)).toEqual(['H07', 'S18a', 'S18b']);
      expect(resolveAddKpiTargets(unset, hospitals)).toEqual([]);
    });

    it('หน่วยบริการเดียวของผู้ใช้: all_required ได้ทุกประเภท (เช่น สสอ.) / any_one ต้องตรง / unset ไม่ได้', () => {
      const mine = [hospitals[3]];
      expect(resolveAddKpiTargets(all, mine, { singleUnit: true })).toEqual(['O02']);
      expect(resolveAddKpiTargets(only18, mine, { singleUnit: true })).toEqual([]);
      expect(resolveAddKpiTargets(unset, mine, { singleUnit: true })).toEqual([]);
      expect(resolveAddKpiTargets(only18, [{ hoscode: 'X', hostype: '' }], { singleUnit: true })).toEqual(['X']);
    });
  });
});
