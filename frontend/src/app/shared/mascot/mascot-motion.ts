/**
 * การเคลื่อนที่ของน้องโคราชดี (ฟังก์ชันล้วน — ทดสอบได้) ย้ายจาก login-mascot.ts (19 พ.ย. 2569)
 */
export interface FlyState { x: number; y: number; z: number; vx: number; vy: number; vz: number; tx: number; ty: number; tz: number; hold: number; }

/** ขั้นการเคลื่อนที่ 1 เฟรม (ฟังก์ชันล้วน — ทดสอบได้): บังคับเลี้ยวเข้าหาจุดหมาย จำกัดความเร็ว ถึงแล้วลอยค้างชั่วครู่ */
export function stepFly(s: FlyState, dt: number, w: number, h: number, size: number, rnd: () => number = Math.random): FlyState {
  const n = { ...s };
  const maxV = Math.max(90, Math.min(w, h) * 0.22);
  const dx = n.tx - n.x, dy = n.ty - n.y, dist = Math.hypot(dx, dy);
  if (n.hold > 0) {
    n.hold -= dt;
    n.vx *= Math.pow(0.08, dt); n.vy *= Math.pow(0.08, dt);
  } else if (dist < 24) {
    n.hold = rnd() < 0.45 ? 0.8 + rnd() * 1.6 : 0;
    const m = size * 0.7;
    n.tx = m + rnd() * Math.max(1, w - 2 * m);
    n.ty = m + rnd() * Math.max(1, h - 2 * m - size * 0.6);
    n.tz = rnd();
  } else {
    const ax = (dx / dist) * maxV * 1.6, ay = (dy / dist) * maxV * 1.6;
    n.vx += ax * dt; n.vy += ay * dt;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > maxV) { n.vx *= maxV / sp; n.vy *= maxV / sp; }
  }
  n.vz += ((n.tz - n.z) * 1.2 - n.vz) * Math.min(1, dt * 2);
  n.x += n.vx * dt; n.y += n.vy * dt; n.z = Math.min(1, Math.max(0, n.z + n.vz * dt));
  // อยู่ในจอเสมอ (จอถูกย่อ/หมุน)
  n.x = Math.min(Math.max(n.x, size * 0.3), Math.max(size * 0.3, w - size * 0.3));
  n.y = Math.min(Math.max(n.y, size * 0.3), Math.max(size * 0.3, h - size * 0.9));
  return n;
}

/** ท่าทาง 3 มิติจากความเร็ว: หันตามทิศบิน (rotateY) เอียงตอนเลี้ยว (rotateZ) ก้ม-เงยตามแนวตั้ง (rotateX) */
export function poseOf(vx: number, vy: number, maxV: number) {
  const c = (v: number) => Math.max(-1, Math.min(1, v / maxV));
  return { yaw: c(vx) * 38, bank: c(vx) * 14, pitch: -c(vy) * 18 + 6, thrust: Math.min(1, Math.hypot(vx, vy) / maxV) };
}
