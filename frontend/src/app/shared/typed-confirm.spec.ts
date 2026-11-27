import { confirmTextFor, typedConfirmSwal } from './typed-confirm';

describe('typed-confirm — ยืนยันปุ่มเสี่ยงด้วยการพิมพ์ (22 พ.ย. 2569)', () => {
  it('ข้อความที่ต้องพิมพ์ตรงกับ server (core/validate.js typedConfirmText)', () => {
    expect(confirmTextFor(['kpi_tab_001'])).toBe('kpi_tab_001');
    expect(confirmTextFor(['a', 'b', 'c'])).toBe('3 ตาราง');
  });
  it('ตรวจค่าที่พิมพ์: ตรง = ผ่าน (ตัดช่องว่าง) / ไม่ตรง = ข้อความเตือน', () => {
    const tc = typedConfirmSwal(['kpi_tab_001']);
    expect(tc.expected).toBe('kpi_tab_001');
    expect(tc.inputValidator(' kpi_tab_001 ')).toBeNull();
    expect(tc.inputValidator('kpi_tab_002')).toContain('kpi_tab_001');
    expect(tc.inputValidator('')).toContain('kpi_tab_001');
    expect(typedConfirmSwal(['<b>x</b>']).footerHtml).not.toContain('<b>x</b>');
  });
});
