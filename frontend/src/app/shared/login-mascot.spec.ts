import { stepFly, poseOf, FlyState } from './login-mascot';

const base = (o: Partial<FlyState> = {}): FlyState => ({ x: 100, y: 100, z: 0.5, vx: 0, vy: 0, vz: 0, tx: 500, ty: 100, tz: 0.5, hold: 0, ...o });

describe('login-mascot stepFly', () => {
  it('บินเข้าหาจุดหมาย และไม่เกินความเร็วสูงสุด', () => {
    let s = base();
    for (let i = 0; i < 60; i++) s = stepFly(s, 1 / 60, 1200, 800, 78, () => 0.5);
    expect(s.x).toBeGreaterThan(100);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(Math.max(90, 800 * 0.22) + 1e-6);
  });

  it('ถึงจุดหมายแล้วเลือกจุดใหม่ภายในจอ', () => {
    const s = stepFly(base({ x: 500, y: 100 }), 1 / 60, 1200, 800, 78, () => 0.99);
    expect(s.tx).toBeGreaterThan(0); expect(s.tx).toBeLessThan(1200);
    expect(s.ty).toBeGreaterThan(0); expect(s.ty).toBeLessThan(800);
    expect(s.hold).toBe(0); // rnd 0.99 ≥ 0.45 = ไม่ลอยค้าง
  });

  it('อยู่ในจอเสมอแม้จอถูกย่อ และความลึกอยู่ในช่วง 0–1', () => {
    const s = stepFly(base({ x: 5000, y: 5000, z: 3, tz: 5 }), 0.05, 400, 300, 58);
    expect(s.x).toBeLessThanOrEqual(400); expect(s.y).toBeLessThanOrEqual(300);
    expect(s.z).toBeLessThanOrEqual(1); expect(s.z).toBeGreaterThanOrEqual(0);
  });
});

describe('login-mascot poseOf', () => {
  it('บินไปทางขวา = หันขวาและเอียง, หยุดนิ่ง = หันหน้าตรง', () => {
    const r = poseOf(200, 0, 200);
    expect(r.yaw).toBeCloseTo(38); expect(r.bank).toBeCloseTo(14); expect(r.thrust).toBe(1);
    const still = poseOf(0, 0, 200);
    expect(still.yaw).toBe(0); expect(still.thrust).toBe(0);
  });
  it('ความเร็วเกินจำกัดไม่หมุนเกินช่วง', () => {
    expect(poseOf(-9999, 0, 100).yaw).toBeCloseTo(-38);
  });
});
