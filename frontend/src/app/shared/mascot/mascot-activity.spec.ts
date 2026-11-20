import { HOME_KEY, groundYOf, loadHome, planRest, saveHome } from './mascot-activity';
import { assistantMenu } from './mascot-assistant-script';
import { POSE_NAMES, poseTargets } from './mascot-pose';

// กิจกรรมของน้องโคราชดี (20 พ.ย. 2569): ไอพ่น / ลงเดิน / นั่ง / นอน / ลากด้วยเมาส์
describe('mascot-activity', () => {
  beforeEach(() => localStorage.removeItem(HOME_KEY));

  it('groundYOf: เท้าแตะขอบล่างจอ (อยู่ในจอเสมอ)', () => {
    expect(groundYOf(768, 200)).toBeCloseTo(768 - 6 - 39);
    expect(groundYOf(768, 200)).toBeLessThan(768);
  });

  it('planRest: แผนพักมีกิจกรรมบนพื้นเท่านั้น — หน้า login มีนั่ง/นอนทุกแผน', () => {
    for (const r of [0, 0.2, 0.5, 0.8, 0.99]) {
      const p = planRest(() => r, false);
      expect(p.length).toBeGreaterThan(0);
      expect(p.every(a => ['walk', 'sit', 'sleep'].includes(a))).toBe(true);
      expect(p.some(a => a === 'sit' || a === 'sleep')).toBe(true);
    }
    expect(planRest(() => 0.1, true)).toEqual(['walk']);
    expect(planRest(() => 0.9, true)).toEqual(['sit', 'sleep']);
  });

  it('ตำแหน่งจอดที่ลากไว้: บันทึก/อ่าน/ล้าง และข้อมูลเสียหรือเกินจอ = ไม่ใช้', () => {
    expect(loadHome()).toBeNull();
    saveHome({ fx: 0.5, fy: 0.4, ground: false });
    expect(loadHome()).toEqual({ fx: 0.5, fy: 0.4, ground: false });
    saveHome(null);
    expect(loadHome()).toBeNull();
    localStorage.setItem(HOME_KEY, '{bad'); expect(loadHome()).toBeNull();
    localStorage.setItem(HOME_KEY, JSON.stringify({ fx: 3, fy: 0.2 })); expect(loadHome()).toBeNull();
  });

  it('ท่านอน/ถูกลาก มีครบ และท่านอนนอนตะแคง (หันหน้าเข้าหาผู้ชม)', () => {
    expect(POSE_NAMES).toContain('sleep');
    expect(POSE_NAMES).toContain('drag');
    const s = poseTargets('sleep', 0);
    expect(Math.abs(s.bodyRoll)).toBeGreaterThan(1.3);
    expect(poseTargets('drag', 0).armRRaise).toBeGreaterThan(2);
  });

  it('เมนูผู้ช่วยมี "กลับไปมุมขวาล่าง" เฉพาะเมื่อถูกลากไปที่อื่น', () => {
    const base = { hasSteps: false, hasVideo: false, page: 'x', quiet: false };
    expect(assistantMenu({ ...base, movedHome: true }).some(c => c.action === 'home:reset')).toBe(true);
    expect(assistantMenu(base).some(c => c.action === 'home:reset')).toBe(false);
  });
});
