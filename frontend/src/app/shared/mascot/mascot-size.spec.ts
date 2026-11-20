import { SIZE_BASE, mascotPx, normalizeMascotSize, viewportScale } from './mascot-size';
import { LOGIN_SCRIPT, resolveNode, sizeChoices } from './mascot-dialog';
import { assistantMenu, assistantScript } from './mascot-assistant-script';
import { MascotService, SIZE_KEY } from './mascot.service';
import { guideRole } from './mascot-guides';

describe('ขนาดน้องโคราชดี (mascot-size)', () => {
  it('normalizeMascotSize: ค่าผิด/ว่าง = medium', () => {
    expect(normalizeMascotSize('small')).toBe('small');
    expect(normalizeMascotSize('large')).toBe('large');
    expect(normalizeMascotSize('huge')).toBe('medium');
    expect(normalizeMascotSize(undefined)).toBe('medium');
    expect(normalizeMascotSize('toString')).toBe('medium');
  });

  it('สเกลตามจอ: มือถือ 0.68 → แท็บเล็ต → จอคอม 1 แบบต่อเนื่อง', () => {
    expect(viewportScale(360, 780)).toBe(0.68);
    expect(viewportScale(1366, 768)).toBe(1);
    const ipad = viewportScale(768, 1024), ipadLand = viewportScale(1024, 768);
    expect(ipad).toBeGreaterThan(0.75); expect(ipad).toBeLessThan(0.9);
    expect(ipadLand).toBeGreaterThan(ipad); expect(ipadLand).toBeLessThan(1);
    // มือถือแนวนอน (เตี้ย) ไม่ได้สเกลเต็ม
    expect(viewportScale(844, 390)).toBeLessThan(0.85);
    // ไม่ลดลงเมื่อจอกว้างขึ้น
    let prev = 0;
    for (let w = 320; w <= 1600; w += 40) { const s = viewportScale(w, 1000); expect(s).toBeGreaterThanOrEqual(prev); prev = s; }
  });

  it('จอคอม: กลาง = ขนาดเดิม (ผู้ช่วย 146, หน้าเข้าสู่ระบบ 200) และ เล็ก < กลาง < ใหญ่', () => {
    expect(mascotPx('medium', true, 1366, 768)).toBe(146);
    expect(mascotPx('medium', false, 1366, 768)).toBe(200);
    for (const dock of [true, false]) {
      for (const [w, h] of [[375, 812], [768, 1024], [1366, 768], [1920, 1080]]) {
        const s = mascotPx('small', dock, w, h), m = mascotPx('medium', dock, w, h), l = mascotPx('large', dock, w, h);
        expect(s).toBeLessThan(m); expect(m).toBeLessThan(l);
      }
    }
    expect(mascotPx('large', true, 1920, 1080)).toBe(SIZE_BASE.dock.large);
  });

  it('มือถือ/แท็บเล็ตย่อตามสเกล และไม่เกิน 45% ของด้านสั้น', () => {
    const phone = mascotPx('large', false, 375, 667), tablet = mascotPx('large', false, 768, 1024), pc = mascotPx('large', false, 1366, 768);
    expect(phone).toBeLessThan(tablet); expect(tablet).toBeLessThan(pc);
    expect(phone).toBeLessThanOrEqual(Math.round(250 * 0.68));
    expect(phone).toBeGreaterThan(150);
    expect(mascotPx('large', false, 320, 300)).toBeLessThanOrEqual(Math.round(300 * 0.45));
    expect(mascotPx('small', true, 200, 200)).toBeGreaterThanOrEqual(64);
  });

  it('เมนูปรับขนาด: มีในหน้าเข้าสู่ระบบและผู้ช่วยในระบบ + ทำเครื่องหมายขนาดปัจจุบัน', () => {
    expect(resolveNode(LOGIN_SCRIPT, 'start', { hour: 9 })!.choices.some(c => c.next === 'size')).toBe(true);
    expect(assistantMenu({ hasSteps: false, hasVideo: false, page: 'dashboard', quiet: false }).some(c => c.next === 'size')).toBe(true);
    const sc = assistantScript(null, guideRole('user_hos'), { page: 'x', quiet: false, hasVideo: false, hasAi: false });
    expect(sc['size']).toBeTruthy(); expect(sc['sizeDone']).toBeTruthy();
    const n = resolveNode(LOGIN_SCRIPT, 'size', { hour: 9, size: 'large' })!;
    expect(n.choices.map(c => c.action).filter(Boolean)).toEqual(['size:small', 'size:medium', 'size:large', 'size:default']);
    expect(n.choices.find(c => c.action === 'size:large')!.label).toContain('(ตอนนี้)');
    expect(sizeChoices('', 'menu').find(c => c.action === 'size:default')!.label).toContain('(ตอนนี้)');
    expect(sizeChoices('', 'menu').find(c => c.action === 'size:small')!.label).not.toContain('(ตอนนี้)');
  });

  describe('MascotService.setSize', () => {
    beforeEach(() => { try { localStorage.removeItem(SIZE_KEY); } catch { /* */ } });
    it('จำในเครื่อง / default = ล้าง / ค่าผิด = ล้าง', () => {
      const s = new MascotService();
      expect(s.size$.value).toBe('');
      s.setSize('large');
      expect(s.size$.value).toBe('large'); expect(localStorage.getItem(SIZE_KEY)).toBe('large');
      expect(new MascotService().size$.value).toBe('large');
      s.setSize('');
      expect(s.size$.value).toBe(''); expect(localStorage.getItem(SIZE_KEY)).toBeNull();
      s.setSize('huge' as any);
      expect(s.size$.value).toBe('');
    });
  });
});
