import { detectAnomaly, median, toNumber } from './anomaly';

describe('anomaly: เตือนค่าผลงานที่อาจผิดปกติ', () => {
  it('ตัวช่วย: toNumber / median', () => {
    expect(toNumber(' 1,250.5 ')).toBe(1250.5);
    expect(toNumber('รอดำเนินการ')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 2])).toBe(3);
  });

  it('พิมพ์เกินหลัก (850 แทน 85) → เตือนว่าสูงกว่าค่ากลางของเดือนอื่น', () => {
    const a = detectAnomaly('850', { others: ['85', '88', '', '90'] });
    expect(a?.kind).toBe('high');
    expect(a?.basis).toBe('months');
    expect(a?.ref).toBe(88);
    expect(a?.message).toContain('สูงกว่า');
    expect(a?.message).toContain('88');
  });

  it('พิมพ์ตกหลัก (8 แทน 85) → เตือนว่าต่ำกว่า', () => {
    const a = detectAnomaly('8', { others: ['85', '88'] });
    expect(a?.kind).toBe('low');
    expect(a?.message).toContain('ต่ำกว่า');
  });

  it('ค่าที่แกว่งตามปกติไม่เตือน (ต่างไม่ถึง 5 เท่า) — กันเตือนบ่อยจนผู้ใช้เลิกสนใจ', () => {
    expect(detectAnomaly('120', { others: ['85', '88', '90'] })).toBeNull();
    expect(detectAnomaly('40', { others: ['85', '88', '90'] })).toBeNull();
    expect(detectAnomaly('430', { others: ['88'] })).toBeNull();      // 4.9 เท่า
    expect(detectAnomaly('440', { others: ['88'] })?.kind).toBe('high'); // 5 เท่าพอดี
  });

  // Regression (พบจากการทดสอบหน้าจอจริง): แถวที่มี 85, 88, 850 — เดิมเทียบค่ากลางของ "เดือนอื่น" ตรงๆ ทำให้ 85 และ 88 ถูกเตือนว่า "ต่ำ" ไปด้วย
  it('แถวที่มีค่าผิดอยู่ 1 เดือน: เตือนเฉพาะเดือนที่ผิด ไม่เตือนเดือนที่ปกติ', () => {
    expect(detectAnomaly('850', { others: ['85', '88'] })?.kind).toBe('high');
    expect(detectAnomaly('85', { others: ['88', '850'] })).toBeNull();
    expect(detectAnomaly('88', { others: ['85', '850'] })).toBeNull();
    // 12 เดือน มีค่าผิด 1 เดือน — เดือนปกติไม่ถูกเตือน
    const normal = ['80', '82', '85', '88', '90', '86', '84', '83', '87', '89'];
    expect(detectAnomaly('85', { others: [...normal, '8500'] })).toBeNull();
    expect(detectAnomaly('8500', { others: [...normal, '85'] })?.kind).toBe('high');
  });

  it('มีเพียง 2 ค่าที่ต่างกันมาก → บอกไม่ได้ว่าค่าใดผิด จึงเตือนทั้งคู่', () => {
    expect(detectAnomaly('850', { others: ['85'] })?.kind).toBe('high');
    expect(detectAnomaly('85', { others: ['850'] })?.kind).toBe('low');
  });

  it('จำนวนนับน้อยๆ ไม่เตือน (1 → 6) และค่า 0 ไม่เตือน', () => {
    expect(detectAnomaly('6', { others: ['1', '1', '2'] })).toBeNull();
    expect(detectAnomaly('0', { others: ['85', '90'] })).toBeNull();
  });

  it('ค่าว่าง / ข้อความ ("รอดำเนินการ") ไม่ตรวจ — ค่าติดลบเตือนเสมอ', () => {
    expect(detectAnomaly('', { others: ['85'] })).toBeNull();
    expect(detectAnomaly('รอดำเนินการ', { others: ['85'] })).toBeNull();
    expect(detectAnomaly('-5', {})?.kind).toBe('negative');
  });

  it('ยังไม่มีเดือนอื่นในปีนี้ → เทียบเดือนเดียวกันของปีงบที่แล้ว แล้วจึงค่ากลางของปีที่แล้ว', () => {
    const a = detectAnomaly('850', { others: ['', '0'], prevSame: '80', prevAll: ['80', '82'] });
    expect(a?.basis).toBe('prev-month');
    expect(a?.message).toContain('เดือนเดียวกันของปีงบที่แล้ว');
    const b = detectAnomaly('850', { others: [], prevSame: '', prevAll: ['80', '90', '100'] });
    expect(b?.basis).toBe('prev-year');
    expect(b?.ref).toBe(90);
    expect(detectAnomaly('95', { others: [], prevSame: '80' })).toBeNull();
  });

  it('มีเดือนอื่นในปีนี้แล้ว → ไม่ใช้ปีที่แล้ว (นิยาม/เป้าหมายอาจเปลี่ยนข้ามปี)', () => {
    expect(detectAnomaly('900', { others: ['850', '880'], prevSame: '80' })).toBeNull();
  });

  it('ไม่มีข้อมูลอ้างอิงเลย → เตือนเมื่อเกินเป้าหมาย 10 เท่า', () => {
    const a = detectAnomaly('850', { target: '80' });
    expect(a?.basis).toBe('target');
    expect(detectAnomaly('500', { target: '80' })).toBeNull();
    expect(detectAnomaly('850', {})).toBeNull();
    expect(detectAnomaly('850', { target: 'ผ่าน' })).toBeNull();
  });
});
