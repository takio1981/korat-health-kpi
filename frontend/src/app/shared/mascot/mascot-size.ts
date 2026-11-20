/**
 * ขนาดของน้องโคราชดี (20 พ.ย. 2569 — ผู้ใช้สั่ง: ตั้งได้ 3 ขนาด เล็ก/กลาง/ใหญ่ และย่อ-ขยายตามขนาดจอมือถือ/แท็บเล็ตตามสเกล)
 * ฟังก์ชันล้วน (ทดสอบได้) — ค่าตั้งต้นของระบบ = system_settings.mascot_size (maintenance-status), ผู้ใช้เลือกเองได้ในเมนูของน้อง (MascotService.size$)
 */
export type MascotSize = 'small' | 'medium' | 'large';

export const MASCOT_SIZES: MascotSize[] = ['small', 'medium', 'large'];
export const SIZE_LABELS: Record<MascotSize, string> = { small: 'เล็ก', medium: 'กลาง', large: 'ใหญ่' };

/** ขนาด (px) บนจอคอมพิวเตอร์ — ผู้ช่วยในระบบ (dock) เล็กกว่าตัวที่บินในหน้าเข้าสู่ระบบ; "กลาง" = ขนาดเดิมก่อนมีตัวเลือก */
export const SIZE_BASE: Record<'dock' | 'roam', Record<MascotSize, number>> = {
  dock: { small: 112, medium: 146, large: 186 },
  roam: { small: 150, medium: 200, large: 250 },
};

/** จอเล็กสุด/ใหญ่สุดของสเกล (px ของความกว้างที่ใช้คำนวณ) และสเกลต่ำสุด */
export const SCALE_MIN_W = 375;
export const SCALE_FULL_W = 1280;
export const SCALE_MIN = 0.68;

export function normalizeMascotSize(v: unknown, fallback: MascotSize = 'medium'): MascotSize {
  return typeof v === 'string' && (MASCOT_SIZES as string[]).includes(v) ? v as MascotSize : fallback;
}

/**
 * สเกลตามขนาดจอแบบต่อเนื่อง: มือถือ (กว้าง ≤ 375) = 0.68 → แท็บเล็ต (768 ≈ 0.82, 1024 ≈ 0.91) → จอคอม (≥ 1280) = 1
 * ใช้ความกว้างที่จำกัดด้วยความสูง (สูง × 1.8 — จอโน้ตบุ๊ก 1366×768 ยังได้สเกลเต็ม) — มือถือแนวนอนที่เตี้ยไม่ได้ตัวใหญ่เต็มจอ
 */
export function viewportScale(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return 1;
  const e = Math.min(w, h * 1.8);
  const k = (e - SCALE_MIN_W) / (SCALE_FULL_W - SCALE_MIN_W);
  return Math.round((SCALE_MIN + (1 - SCALE_MIN) * Math.max(0, Math.min(1, k))) * 1000) / 1000;
}

/** ขนาดจริง (px) ของตัวละคร — ไม่เกิน 45% ของด้านสั้นของจอ (จอเล็กมากไม่บังทั้งหน้า) */
export function mascotPx(size: MascotSize, dock: boolean, w: number, h: number): number {
  const base = SIZE_BASE[dock ? 'dock' : 'roam'][normalizeMascotSize(size)];
  const px = base * viewportScale(w, h);
  const cap = w > 0 && h > 0 ? Math.min(w, h) * 0.45 : px;
  return Math.max(64, Math.round(Math.min(px, cap)));
}
