import { typesText, hostypeText } from './khd-types';

// ข้อความเทียบประเภทตัวชี้วัด/ประเภทหน่วยบริการกับ KHD (9 พ.ย. 2569)
describe('khd-types', () => {
  it('typesText: เฉพาะที่เป็น 1 (null/"0"/ว่าง = ไม่ใช่), ไม่มีเลย = ไม่ระบุ', () => {
    expect(typesText({ r9: 1, moph: '0', ssj: null, rmw: 1, other: '' })).toBe('R9, RMW');
    expect(typesText({ r9: 0 })).toBe('ไม่ระบุ');
    expect(typesText(null)).toBe('ไม่ระบุ');
  });
  it('hostypeText: ทุกประเภท / รายการประเภท (เรียง ไม่ซ้ำ รับ JSON string) / ยังไม่ตั้ง', () => {
    const names = { '05': 'รพ.ศูนย์' };
    expect(hostypeText('all_required', '["05"]', names)).toBe('ทุกประเภท');
    expect(hostypeText('any_one', '["07","05","07"]', names)).toBe('รพ.ศูนย์ (05), 07');
    expect(hostypeText('any_one', [], names)).toBe('ยังไม่ตั้ง');
    expect(hostypeText(null, ['05'])).toBe('ยังไม่ตั้ง');
    expect(hostypeText('any_one', 'not-json')).toBe('ยังไม่ตั้ง');
  });
});
