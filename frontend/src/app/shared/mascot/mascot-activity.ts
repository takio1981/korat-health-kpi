/**
 * กิจกรรมของน้องคิดดี (20 พ.ย. 2569 — ผู้ใช้สั่ง: บินมีไอพ่นใต้เท้า, ลงเดิน, นั่งพัก, นอนหลับ, ลากด้วยเมาส์ไปวางตรงไหนก็ได้)
 * ฟังก์ชันล้วน (ทดสอบได้) — ตัวควบคุมอยู่ใน mascot-stage (updateActivity / nextAct / ลาก)
 */
export type Activity = 'air' | 'hover' | 'land' | 'stand' | 'walk' | 'sit' | 'sleep';

/** ตำแหน่ง y ของตัวละครเมื่อเท้าแตะขอบล่างจอ (เท้าอยู่ราว 81.5% ของภาพหลังเว้นที่ให้ไอพ่น, จุดอ้างอิง 62% — ดู frame()) */
export function groundYOf(viewportH: number, size: number): number {
  return viewportH - 6 - size * 0.195;
}

/** แผนพักบนพื้น 1 รอบ: เดินแล้วนั่งหรือนอน (ผู้ช่วยในระบบ: บางรอบเดินอย่างเดียว) */
export function planRest(rnd: () => number = Math.random, dock = false): Activity[] {
  const r = rnd();
  if (dock) {
    if (r < 0.3) return ['walk'];                 // เดินออกไปแล้วเดินกลับ
    if (r < 0.65) return ['sit'];
    return ['sit', 'sleep'];
  }
  if (r < 0.35) return ['walk', 'sit'];
  if (r < 0.7) return ['walk', 'sleep'];
  return ['sit', 'walk', 'sleep'];
}

/** ตำแหน่งจอดที่ผู้ใช้ลากไว้ (สัดส่วนของจอ) — เก็บในเครื่อง */
export const HOME_KEY = 'kpi_mascot_home';
export function loadHome(): { fx: number; fy: number; ground: boolean } | null {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_KEY) || 'null');
    if (v && Number.isFinite(v.fx) && Number.isFinite(v.fy) && v.fx >= 0 && v.fx <= 1 && v.fy >= 0 && v.fy <= 1) return { fx: v.fx, fy: v.fy, ground: !!v.ground };
  } catch { /* ข้อมูลเสีย = ไม่ใช้ */ }
  return null;
}
export function saveHome(h: { fx: number; fy: number; ground: boolean } | null) {
  try { if (h) localStorage.setItem(HOME_KEY, JSON.stringify(h)); else localStorage.removeItem(HOME_KEY); } catch { /* ไม่มีที่เก็บ */ }
}
