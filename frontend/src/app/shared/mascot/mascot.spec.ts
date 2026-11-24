import { JOINT_KEYS, POSE_NAMES, autoPose, blendJoints, neutralJoints, poseTargets } from './mascot-pose';
import { blinkAt, faceChanged, neutralFace, talkMouth } from './mascot-face';
import { LOGIN_SCRIPT, bubblePath, graphemes, greetingFor, resolveNode, tailSide, thinkDots } from './mascot-dialog';
import { webglAvailable } from './mascot-stage';

describe('mascot-pose', () => {
  it('ทุกท่าคืนค่าครบทุกข้อต่อ และเป็นตัวเลขจำกัด', () => {
    for (const p of POSE_NAMES) for (const t of [0, 0.37, 5.2]) {
      const j = poseTargets(p, t, { speed: 0.6 });
      for (const k of JOINT_KEYS) expect(Number.isFinite(j[k])).toBe(true);
    }
  });
  it('ท่าชี้นิ้วแสดงนิ้ว ท่าอื่นไม่แสดง', () => {
    expect(poseTargets('point', 0).finger).toBe(1);
    expect(poseTargets('idle', 0).finger).toBe(0);
  });
  it('ท่าบิน: เร็วขึ้น = โน้มตัวไปข้างหน้ามากขึ้นและผ้าคลุมปลิวมากขึ้น', () => {
    const slow = poseTargets('fly', 0, { speed: 0.1 }), fast = poseTargets('fly', 0, { speed: 1 });
    expect(fast.bodyPitch).toBeGreaterThan(slow.bodyPitch);
    expect(fast.cape).toBeGreaterThan(slow.cape);
  });
  it('blendJoints เข้าหาเป้าหมายต่อเนื่อง ไม่เกินเป้า และ dt = 0 ไม่เปลี่ยน', () => {
    const a = neutralJoints(), b = { ...neutralJoints(), armRRaise: 2 };
    expect(blendJoints(a, b, 0).armRRaise).toBe(0);
    const m = blendJoints(a, b, 0.05).armRRaise;
    expect(m).toBeGreaterThan(0); expect(m).toBeLessThan(2);
    expect(blendJoints(a, b, 10).armRRaise).toBeCloseTo(2, 3);
  });
  it('autoPose: เร็ว = บิน, ช้า = ลอย, หยุดนิ่ง = ยืน', () => {
    expect(autoPose(0.8, false)).toBe('fly');
    expect(autoPose(0.2, false)).toBe('hover');
    expect(autoPose(0, true)).toBe('idle');
  });
});

describe('mascot-face', () => {
  it('กะพริบตาเป็นช่วงสั้นๆ ค่าอยู่ใน 0–1', () => {
    let closed = 0;
    for (let t = 0; t < 10; t += 0.01) { const b = blinkAt(t); expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThanOrEqual(1); if (b > 0.5) closed++; }
    expect(closed).toBeGreaterThan(0); expect(closed).toBeLessThan(100);
  });
  it('faceChanged: ค่าเปลี่ยนเล็กน้อยไม่วาดใหม่ อารมณ์เปลี่ยน = วาดใหม่', () => {
    const a = neutralFace();
    expect(faceChanged(null, a)).toBe(true);
    expect(faceChanged(a, { ...a, mouth: 0.01 })).toBe(false);
    expect(faceChanged(a, { ...a, mood: 'happy' })).toBe(true);
  });
  it('talkMouth อยู่ใน 0–1', () => {
    for (let t = 0; t < 3; t += 0.05) { const m = talkMouth(t); expect(m).toBeGreaterThanOrEqual(0); expect(m).toBeLessThanOrEqual(1); }
  });
});

describe('mascot-dialog', () => {
  it('ทักทายตามช่วงเวลา', () => {
    expect(greetingFor(8)).toContain('เช้า');
    expect(greetingFor(14)).toContain('บ่าย');
    expect(greetingFor(18)).toContain('เย็น');
    expect(greetingFor(23)).toContain('ดึก');
  });
  it('บทเริ่มต้นมีคำทักทาย + ตัวเลือก, บทที่ไม่มี = null, ชื่อของ Object.prototype ไม่ใช่บท', () => {
    const n = resolveNode(LOGIN_SCRIPT, 'start', { hour: 9 })!;
    expect(n.text).toContain('น้องคิดดี');
    expect(n.choices.length).toBeGreaterThan(2);
    expect(n.auto).toBeNull();
    expect(resolveNode(LOGIN_SCRIPT, 'nope', { hour: 9 })).toBeNull();
    expect(resolveNode(LOGIN_SCRIPT, 'toString', { hour: 9 })).toBeNull();
  });
  it('ตัวเลือก ThaID แสดงเฉพาะเมื่อเปิด ThaID', () => {
    const off = resolveNode(LOGIN_SCRIPT, 'login', { hour: 9 })!;
    const on = resolveNode(LOGIN_SCRIPT, 'login', { hour: 9, thaid: true })!;
    expect(off.choices.some(c => c.next === 'thaid')).toBe(false);
    expect(on.choices.some(c => c.next === 'thaid')).toBe(true);
    expect(on.pointAt).toBe('#username');
  });
  it('ทุกตัวเลือกชี้ไปบทที่มีอยู่จริง หรือเป็นคำสั่งที่รู้จัก', () => {
    for (const id of Object.keys(LOGIN_SCRIPT)) {
      const n = resolveNode(LOGIN_SCRIPT, id, { hour: 10, thaid: true, providerid: true })!;
      for (const c of n.choices) {
        if (c.next) expect(LOGIN_SCRIPT[c.next]).toBeTruthy();
        else expect(c.action).toMatch(/^(nav:\/|size:(small|medium|large|default)$)/);
      }
    }
  });
  it('graphemes ไม่แยกสระ/วรรณยุกต์ไทยออกจากพยัญชนะ', () => {
    const g = graphemes('น้องคิดดี');
    expect(g.join('')).toBe('น้องคิดดี');
    expect(g).toContain('น้');
    expect(g).toContain('ดี');
  });
  it('bubblePath: หางชี้ไปที่ตัวละคร (ปลายหางอยู่ในเส้น)', () => {
    const d = bubblePath('speech', 200, 80, { x: 30, y: 120 });
    expect(d.startsWith('M')).toBe(true);
    expect(d).toContain('L30 120');
    expect(tailSide(200, 80, { x: 30, y: 120 })).toBe('bottom');
    expect(tailSide(200, 80, { x: -40, y: 40 })).toBe('left');
    expect(bubblePath('shout', 200, 80, { x: -40, y: 40 })).toContain('L-40 40');
    expect(bubblePath('think', 200, 80, { x: 0, y: 0 })).toContain('A');
  });
  it('thinkDots: ฟองเล็กลงเรื่อยๆ เข้าหาตัวละคร', () => {
    const dots = thinkDots(200, 80, { x: 20, y: 140 });
    expect(dots.length).toBe(3);
    expect(dots[0].r).toBeGreaterThan(dots[2].r);
    expect(dots[2].y).toBeGreaterThan(dots[0].y);
  });
});

describe('mascot-stage', () => {
  it('jsdom ไม่มี WebGL → ใช้ภาพนิ่งแทน', () => {
    expect(webglAvailable()).toBe(false);
  });
});
