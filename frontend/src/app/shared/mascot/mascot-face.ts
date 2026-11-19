/**
 * ใบหน้าบนจอของน้องโคราชดี — วาดลง canvas แล้วใช้เป็น texture ของจอ (ตาโต ม่านตาสีเขียวน้ำทะเล แก้มชมพู ปากชมพู ตามภาพต้นแบบ)
 * วาดใหม่เฉพาะเมื่อค่าเปลี่ยนเกินเกณฑ์ (faceChanged) ประหยัดการส่ง texture เข้า GPU
 */
export type Mood = 'normal' | 'happy' | 'surprised' | 'shy' | 'think' | 'wink' | 'sad';
export const MOODS: Mood[] = ['normal', 'happy', 'surprised', 'shy', 'think', 'wink', 'sad'];

export interface FaceState {
  /** 0 = ลืมตา, 1 = หลับตา */
  blink: number;
  /** 0 = ปิดปาก (ยิ้ม), 1 = อ้าปากสุด (ขณะพูด) */
  mouth: number;
  /** ทิศที่มอง -1..1 */
  lookX: number;
  lookY: number;
  mood: Mood;
}

export const FACE_W = 512;
export const FACE_H = 358;

export function neutralFace(): FaceState { return { blink: 0, mouth: 0, lookX: 0, lookY: 0, mood: 'normal' }; }

/** ค่าเปลี่ยนพอจะต้องวาดใหม่หรือไม่ */
export function faceChanged(a: FaceState | null, b: FaceState): boolean {
  if (!a) return true;
  return a.mood !== b.mood || Math.abs(a.blink - b.blink) > 0.04 || Math.abs(a.mouth - b.mouth) > 0.04
    || Math.abs(a.lookX - b.lookX) > 0.03 || Math.abs(a.lookY - b.lookY) > 0.03;
}

/** ช่วงกะพริบตาตามเวลา: ทุก ~3.2 วินาที หลับตา 0.16 วินาที (บางรอบกะพริบสองครั้ง) */
export function blinkAt(t: number): number {
  const period = 3.2, d = 0.16;
  const ph = t % period;
  const one = (x: number) => (x >= 0 && x < d ? Math.sin((x / d) * Math.PI) : 0);
  return Math.max(one(ph), Math.floor(t / period) % 3 === 1 ? one(ph - 0.28) : 0);
}

const TEAL = '#35c9b8';

export function drawFace(ctx: CanvasRenderingContext2D, s: FaceState, w = FACE_W, h = FACE_H) {
  ctx.clearRect(0, 0, w, h);
  // พื้นจอ: ดำเงา ไล่แสงตรงกลาง + แถบสะท้อนแสงเฉียง
  const bg = ctx.createRadialGradient(w * 0.45, h * 0.4, h * 0.1, w * 0.5, h * 0.5, w * 0.62);
  bg.addColorStop(0, '#262d31'); bg.addColorStop(1, '#0a0c0e');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.07; ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(w * 0.05, 0); ctx.lineTo(w * 0.38, 0); ctx.lineTo(w * 0.12, h); ctx.lineTo(-w * 0.2, h); ctx.closePath(); ctx.fill();
  ctx.restore();

  const ex = [w * 0.29, w * 0.71], ey = h * 0.47;
  const rx = w * 0.118, ry = h * 0.205;
  const mood = s.mood;
  const sur = mood === 'surprised' ? 1.12 : 1;

  // คิ้ว
  ctx.strokeStyle = TEAL; ctx.lineCap = 'round'; ctx.lineWidth = 7;
  for (const [i, x] of ex.entries()) {
    const side = i === 0 ? -1 : 1;
    let lift = mood === 'surprised' ? -16 : mood === 'sad' ? 6 : 0;
    let tilt = mood === 'think' ? (i === 0 ? -10 : 8) : mood === 'sad' ? -side * 9 : 0;
    if (mood === 'shy') lift = 4;
    ctx.beginPath();
    ctx.moveTo(x - rx * 0.75, ey - ry * 1.3 + lift + tilt * -side * 0.5);
    ctx.quadraticCurveTo(x, ey - ry * 1.52 + lift, x + rx * 0.75, ey - ry * 1.3 + lift + tilt * side * 0.5);
    ctx.stroke();
  }

  // ตา
  const closedArc = (x: number, up: boolean) => {
    ctx.beginPath(); ctx.lineWidth = 9; ctx.strokeStyle = TEAL;
    if (up) { ctx.moveTo(x - rx * 0.8, ey + 6); ctx.quadraticCurveTo(x, ey - ry * 0.9, x + rx * 0.8, ey + 6); }
    else { ctx.moveTo(x - rx * 0.8, ey - 4); ctx.quadraticCurveTo(x, ey + ry * 0.55, x + rx * 0.8, ey - 4); }
    ctx.stroke();
  };
  for (const [i, x] of ex.entries()) {
    if (mood === 'happy') { closedArc(x, true); continue; }
    if (mood === 'shy') { closedArc(x, false); continue; }
    if (mood === 'wink' && i === 1) { closedArc(x, true); continue; }
    const open = Math.max(0, 1 - s.blink);
    if (open < 0.12) { closedArc(x, false); continue; }
    ctx.save();
    ctx.translate(x, ey); ctx.scale(sur, open * sur);
    // ขอบตาขาว
    ctx.fillStyle = '#e8fbf8';
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    // ม่านตา
    const lx = s.lookX * rx * 0.2, ly = s.lookY * ry * 0.18;
    const ir = ctx.createRadialGradient(lx - rx * 0.15, ly - ry * 0.2, rx * 0.1, lx, ly, rx * 0.86);
    ir.addColorStop(0, '#7af0e2'); ir.addColorStop(0.55, '#21a99b'); ir.addColorStop(1, '#0c6f66');
    ctx.fillStyle = ir;
    ctx.beginPath(); ctx.ellipse(lx, ly, rx * 0.84, ry * 0.86, 0, 0, Math.PI * 2); ctx.fill();
    // รูม่านตา
    ctx.fillStyle = '#092a28';
    ctx.beginPath(); ctx.ellipse(lx, ly + ry * 0.05, rx * 0.42, ry * 0.46, 0, 0, Math.PI * 2); ctx.fill();
    // แสงสะท้อน
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(lx + rx * 0.3, ly - ry * 0.34, rx * 0.26, ry * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(lx - rx * 0.32, ly + ry * 0.36, rx * 0.11, ry * 0.1, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // แก้ม
  ctx.fillStyle = mood === 'shy' ? 'rgba(255,120,150,0.9)' : 'rgba(255,128,155,0.7)';
  for (const x of [w * 0.135, w * 0.865]) {
    ctx.beginPath(); ctx.ellipse(x, h * 0.7, w * 0.05, h * 0.042, 0, 0, Math.PI * 2); ctx.fill();
  }

  // ปาก
  const mx = w * 0.5, my = h * 0.74;
  const m = Math.max(0, Math.min(1, s.mouth));
  if (mood === 'surprised') {
    ctx.fillStyle = '#c63a52';
    ctx.beginPath(); ctx.ellipse(mx, my + 4, w * 0.03, h * (0.04 + 0.03 * m), 0, 0, Math.PI * 2); ctx.fill();
  } else if (m < 0.06 && mood !== 'happy') {
    // ยิ้มปิดปาก
    ctx.strokeStyle = '#ff9fb2'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(mx - w * 0.045, my - 2);
    if (mood === 'sad') ctx.quadraticCurveTo(mx, my - h * 0.05, mx + w * 0.045, my - 2);
    else ctx.quadraticCurveTo(mx, my + h * 0.055, mx + w * 0.045, my - 2);
    ctx.stroke();
  } else {
    // ปากอ้า (ยิ้มกว้าง/กำลังพูด) — ครึ่งวงรีมีลิ้น
    const mw = w * (0.05 + 0.02 * m), mh = h * (0.035 + 0.075 * Math.max(m, mood === 'happy' ? 0.45 : 0));
    ctx.save();
    ctx.beginPath(); ctx.moveTo(mx - mw, my - 4);
    ctx.quadraticCurveTo(mx, my - 10, mx + mw, my - 4);
    ctx.quadraticCurveTo(mx + mw * 0.95, my + mh, mx, my + mh);
    ctx.quadraticCurveTo(mx - mw * 0.95, my + mh, mx - mw, my - 4);
    ctx.closePath();
    ctx.fillStyle = '#b8304a'; ctx.fill();
    ctx.clip();
    ctx.fillStyle = '#ff8fa6';
    ctx.beginPath(); ctx.ellipse(mx, my + mh * 1.05, mw * 0.62, mh * 0.55, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

/** ระดับการอ้าปากขณะพูด (จำลองพยางค์) */
export function talkMouth(t: number): number {
  const v = 0.5 + 0.5 * Math.sin(t * 17) * Math.sin(t * 5.3 + 1);
  return Math.max(0, Math.min(1, v * 1.1));
}
