import { zoneOptions, zoneLabel, inZone, setZoneNames, zoneName } from './zone';

// ตัวกรองโซนของหน่วยบริการ (chospital.zone) — ใช้ร่วมทุกหน้าที่มีตัวกรองหน่วยบริการ/อำเภอ
describe('zone', () => {
  it('zoneOptions: โซนที่พบในข้อมูล ไม่ซ้ำ เรียงตามเลข ตัดค่าว่าง', () => {
    expect(zoneOptions([{ zone: '6' }, { zone: '1' }, { zone: '6' }, { zone: null }, { zone: '' }, {}])).toEqual(['1', '6']);
    expect(zoneOptions(null as any)).toEqual([]);
  });

  it('zoneLabel', () => {
    expect(zoneLabel('3')).toBe('โซน 3');
    expect(zoneLabel('')).toBe('ไม่ระบุโซน');
  });

  // หน้าจัดการโซน (9 พ.ย. 2569): ชื่อโซน + รหัส 2 หลัก
  it('setZoneNames → zoneLabel มีชื่อโซน, โซนที่ไม่มีชื่อแสดงแค่เลข | zoneOptions เรียงเลข 2 หลักถูก', () => {
    setZoneNames([{ code: '1', name: 'เมือง' }, { code: '12', name: '' }]);
    expect(zoneLabel('1')).toBe('โซน 1 · เมือง');
    expect(zoneName('1')).toBe('เมือง');
    expect(zoneLabel('12')).toBe('โซน 12');
    expect(zoneOptions([{ zone: '12' }, { zone: '2' }, { zone: '10' }])).toEqual(['2', '10', '12']);
    setZoneNames([]);
    expect(zoneLabel('1')).toBe('โซน 1');
  });

  it('inZone: ไม่เลือกโซน = ผ่านทุกแถว, เลือกแล้วเทียบค่าโซนของแถว (รับทั้งค่าเดียวและ array)', () => {
    expect(inZone({ zone: '2' }, '')).toBe(true);
    expect(inZone({ zone: '2' }, [])).toBe(true);
    expect(inZone({ zone: '2' }, '2')).toBe(true);
    expect(inZone({ zone: '2' }, ['1', '3'])).toBe(false);
    expect(inZone({ zone: 2 }, ['2'])).toBe(true);
    expect(inZone(undefined, ['2'])).toBe(false);   // หาหน่วยบริการไม่พบ = ไม่อยู่ในโซน
  });
});
