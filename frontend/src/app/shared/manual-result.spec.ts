import { isManualResult, isManualPct, normalizeManualPct, manualPctNumber, manualPctPass } from './manual-result';

// ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569) — normalizeManualPct ต้องตรงกับ backend api/services/manual-result.js
describe('manual-result', () => {
  it('อ่านการตั้งค่าจาก 1/0/true/false', () => {
    expect(isManualResult({ result_manual: 1 })).toBe(true);
    expect(isManualResult({ result_manual: true })).toBe(true);
    expect(isManualResult({ result_manual: 0 })).toBe(false);
    expect(isManualResult(null)).toBe(false);
    expect(isManualPct({ pct_manual: '1' })).toBe(true);
    expect(isManualPct({})).toBe(false);
  });

  it('ร้อยละที่กรอก: ตัวเลข ≥ 0, ทศนิยมได้, ลงท้าย % ได้, ว่าง = "", อื่นๆ = null', () => {
    expect(normalizeManualPct(' 95.5 ')).toBe('95.5');
    expect(normalizeManualPct('120%')).toBe('120');
    expect(normalizeManualPct('')).toBe('');
    expect(normalizeManualPct(null)).toBe('');
    expect(normalizeManualPct('-5')).toBeNull();
    expect(normalizeManualPct('ดีมาก')).toBeNull();
    expect(normalizeManualPct('1,000')).toBeNull();
  });

  it('ผ่านเกณฑ์ = ร้อยละที่กรอก ≥ 100, ยังไม่กรอก = null', () => {
    expect(manualPctNumber({ manual_pct: '99.99' })).toBe(99.99);
    expect(manualPctPass({ manual_pct: '99.99' })).toBe(false);
    expect(manualPctPass({ manual_pct: '100' })).toBe(true);
    expect(manualPctPass({ manual_pct: '' })).toBeNull();
    expect(manualPctPass({ manual_pct: 'x' })).toBeNull();
  });
});
