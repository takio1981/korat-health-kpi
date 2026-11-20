/**
 * บทสนทนาของน้องโคราชดี (ฟังก์ชันล้วน — ไม่เรียก AI) + รูปกล่องคำพูดแบบมังงะ (SVG path)
 * บทพูดหน้าเข้าสู่ระบบเป็นบทที่เตรียมไว้ (ผู้ใช้เลือก 19 พ.ย. 2569: ไม่เปิดช่อง AI ให้ผู้ที่ยังไม่เข้าสู่ระบบ)
 */
import type { PoseName } from './mascot-pose';
import type { Mood } from './mascot-face';

export type BubbleKind = 'speech' | 'shout' | 'think';

export interface DialogCtx { hour: number; thaid?: boolean; providerid?: boolean; }
export interface DialogChoice { label: string; next?: string; action?: string; }
export interface DialogNode {
  text: string | ((c: DialogCtx) => string);
  kind?: BubbleKind;
  pose?: PoseName;
  mood?: Mood;
  choices?: DialogChoice[] | ((c: DialogCtx) => DialogChoice[]);
  /** ปิดเองหลังพิมพ์ครบ (มิลลิวินาที) — ไม่มี choices เท่านั้น */
  auto?: number;
  /** บินไปชี้ที่ element นี้ (CSS selector) */
  pointAt?: string;
  /** แสดงช่องพิมพ์ข้อความ (ส่งแล้ว stage ส่งคำสั่ง ask:<ข้อความ>) */
  input?: { placeholder: string };
  /** หมายเหตุตัวเล็กใต้ข้อความ (เช่น ป้าย "ข้อความจาก AI — โปรดตรวจสอบ") */
  note?: string;
  /** ประโยคที่พูดออกเสียง (ไม่ระบุ = ข้อความในกล่อง) — แยกเป็นช่วงเพื่อใช้ไฟล์เสียงที่สร้างไว้ร่วมกันได้ */
  voice?: string[] | ((c: DialogCtx) => string[]);
}
export type DialogScript = Record<string, DialogNode>;

export interface ResolvedNode {
  id: string; text: string; kind: BubbleKind; pose: PoseName; mood: Mood;
  choices: DialogChoice[]; auto: number | null; pointAt: string | null;
  input?: { placeholder: string } | null; note?: string | null;
  /** ประโยคที่พูดออกเสียง (ไม่มี = ข้อความในกล่อง) */
  voice?: string[];
}

export function resolveNode(script: DialogScript, id: string, ctx: DialogCtx): ResolvedNode | null {
  if (!Object.prototype.hasOwnProperty.call(script, id)) return null;
  const n = script[id];
  const choices = (typeof n.choices === 'function' ? n.choices(ctx) : n.choices) || [];
  return {
    id,
    text: typeof n.text === 'function' ? n.text(ctx) : n.text,
    kind: n.kind || 'speech',
    pose: n.pose || 'talk',
    mood: n.mood || 'normal',
    choices,
    auto: choices.length || n.input ? null : (n.auto ?? 6000),
    pointAt: n.pointAt || null,
    input: n.input || null,
    note: n.note || null,
    voice: typeof n.voice === 'function' ? n.voice(ctx) : n.voice,
  };
}

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'สวัสดีตอนเช้าครับ!';
  if (hour >= 12 && hour < 17) return 'สวัสดีตอนบ่ายครับ!';
  if (hour >= 17 && hour < 21) return 'สวัสดีตอนเย็นครับ!';
  return 'สวัสดีครับ! ทำงานดึกจังเลยนะครับ';
}

/** แยกตัวอักษรแบบไม่ตัดสระ/วรรณยุกต์ไทยออกจากพยัญชนะ (ใช้กับการพิมพ์ทีละตัว) */
export function graphemes(text: string): string[] {
  const Seg = (Intl as any).Segmenter;
  if (Seg) return Array.from(new Seg('th', { granularity: 'grapheme' }).segment(text), (s: any) => s.segment as string);
  return Array.from(text);
}

const MENU: DialogChoice[] = [
  { label: 'เข้าสู่ระบบยังไง?', next: 'login' },
  { label: 'ยังไม่มีบัญชี', next: 'register' },
  { label: 'ลืมรหัสผ่าน', next: 'forgot' },
  { label: 'ระบบนี้คืออะไร?', next: 'about' },
  { label: 'ไว้ก่อนนะ', next: 'bye' },
];

export const LOGIN_SCRIPT: DialogScript = {
  start: {
    text: c => `${greetingFor(c.hour)} ผมน้องโคราชดี ผู้ช่วยประจำระบบบันทึกผลงาน KPI ด้านสุขภาพ วันนี้ให้ผมช่วยอะไรดีครับ?`,
    pose: 'wave', mood: 'happy', choices: MENU,
  },
  menu: { text: 'อยากรู้เรื่องไหนอีกครับ?', pose: 'talk', choices: MENU },
  login: {
    text: c => 'กรอก "ชื่อผู้ใช้" กับ "รหัสผ่าน" ตรงนี้ แล้วกดปุ่ม "เข้าสู่ระบบ" ได้เลยครับ'
      + (c.thaid || c.providerid ? ' หรือจะใช้ปุ่มเข้าสู่ระบบด้านล่างก็ได้นะครับ' : ''),
    pose: 'point', pointAt: '#username',
    choices: c => [
      ...(c.thaid ? [{ label: 'ใช้ ThaID ได้ไหม?', next: 'thaid' }] : []),
      { label: 'เข้าใจแล้ว', next: 'ok' },
      { label: 'ถามเรื่องอื่น', next: 'menu' },
    ],
  },
  thaid: {
    text: 'ถ้าลงทะเบียนด้วยเลขบัตรประชาชนไว้แล้ว กดปุ่ม ThaID แล้วยืนยันตัวตนด้วยแอป ThaID ได้เลย ไม่ต้องจำรหัสผ่านครับ',
    pose: 'point', pointAt: '#btn-thaid',
    choices: [{ label: 'เข้าใจแล้ว', next: 'ok' }, { label: 'ถามเรื่องอื่น', next: 'menu' }],
  },
  register: {
    text: 'กดปุ่ม "ลงทะเบียน" กรอกข้อมูลให้ครบ แล้วรอผู้ดูแลอนุมัติ เมื่ออนุมัติแล้วก็เข้าสู่ระบบได้เลยครับ',
    pose: 'point', pointAt: '#btn-register-link',
    choices: [{ label: 'ไปหน้าลงทะเบียน', action: 'nav:/register' }, { label: 'ถามเรื่องอื่น', next: 'menu' }, { label: 'ขอบคุณ', next: 'ok' }],
  },
  forgot: {
    text: 'กด "ลืมรหัสผ่าน?" ใต้ช่องรหัสผ่าน ระบบจะช่วยตั้งรหัสผ่านใหม่ให้ หรือติดต่อผู้ดูแลระบบของหน่วยงานท่านก็ได้ครับ',
    pose: 'point', pointAt: '#btn-forgot-password',
    choices: [{ label: 'เข้าใจแล้ว', next: 'ok' }, { label: 'ถามเรื่องอื่น', next: 'menu' }],
  },
  about: {
    text: 'ระบบนี้ใช้บันทึกและติดตามผลงานตัวชี้วัดด้านสุขภาพของหน่วยบริการทั้งจังหวัดนครราชสีมา มีทั้งกราฟ รายงาน และผู้ช่วย AI ครับ',
    pose: 'talk', mood: 'happy',
    choices: [{ label: 'ดูคู่มือการใช้งาน', action: 'nav:/help-public' }, { label: 'ถามเรื่องอื่น', next: 'menu' }, { label: 'ขอบคุณ', next: 'ok' }],
  },
  ok: { text: 'เยี่ยมเลยครับ! ขอให้ทำงานสนุกนะครับ', kind: 'shout', pose: 'cheer', mood: 'happy', auto: 3200 },
  bye: { text: 'ได้เลยครับ ถ้าต้องการให้ช่วย คลิกที่ตัวผมได้ทุกเมื่อนะครับ', pose: 'wave', mood: 'happy', auto: 3800 },
  shy: { text: 'ปิดตาแล้วครับ ผมไม่แอบดูรหัสผ่านแน่นอน', pose: 'shy', mood: 'shy', auto: 2600 },
  loginError: {
    text: 'อุ๊ย! เข้าสู่ระบบไม่สำเร็จ ลองตรวจชื่อผู้ใช้ ตัวพิมพ์เล็ก-ใหญ่ และปุ่ม Caps Lock ดูนะครับ',
    kind: 'shout', pose: 'think', mood: 'surprised', auto: 6500,
  },
};

/** เกร็ดความรู้ที่พูดเป็นระยะระหว่างบินเล่น (กล่องความคิด) */
export const LOGIN_TIPS: string[] = [
  'รู้ไหมครับ? บันทึกผลงานแล้ว ผู้ดูแลจะตรวจสอบและอนุมัติให้ครับ',
  'ผลงานรายเดือนนำเข้าจาก Excel ได้ด้วยนะครับ',
  'ดูคู่มือการใช้งานได้ โดยไม่ต้องเข้าสู่ระบบครับ',
  'กดปุ่มหุ่นยนต์มุมขวาบน ถ้าอยากให้ผมพักก่อนครับ',
];

// ===================== รูปกล่องคำพูด =====================
export interface Pt { x: number; y: number; }

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * เส้นขอบกล่องคำพูดขนาด w×h (มุมซ้ายบน = 0,0) + หาง/ฟองความคิดชี้ไปที่ tail (พิกัดเดียวกัน อยู่นอกกล่อง)
 * speech = สี่เหลี่ยมมุมมน + หางสามเหลี่ยม | shout = ขอบหยักแบบตะโกน | think = เมฆ (ฟองวงกลมเล็กๆ วาดแยก — thinkDots)
 */
export function bubblePath(kind: BubbleKind, w: number, h: number, tail: Pt): string {
  if (kind === 'shout') return burstPath(w, h, tail);
  if (kind === 'think') return cloudPath(w, h);
  const r = Math.min(18, h / 2, w / 2);
  // หางออกจากขอบที่ใกล้จุดปลายที่สุด (ล่าง/บน/ซ้าย/ขวา)
  const side = tailSide(w, h, tail);
  const base = 14;
  const parts: string[] = [];
  parts.push(`M${f(r)} 0`);
  if (side === 'top') { const cx = clampN(tail.x, r + base, w - r - base); parts.push(`L${f(cx - base / 2)} 0 L${f(tail.x)} ${f(tail.y)} L${f(cx + base / 2)} 0`); }
  parts.push(`L${f(w - r)} 0 Q${f(w)} 0 ${f(w)} ${f(r)}`);
  if (side === 'right') { const cy = clampN(tail.y, r + base, h - r - base); parts.push(`L${f(w)} ${f(cy - base / 2)} L${f(tail.x)} ${f(tail.y)} L${f(w)} ${f(cy + base / 2)}`); }
  parts.push(`L${f(w)} ${f(h - r)} Q${f(w)} ${f(h)} ${f(w - r)} ${f(h)}`);
  if (side === 'bottom') { const cx = clampN(tail.x, r + base, w - r - base); parts.push(`L${f(cx + base / 2)} ${f(h)} L${f(tail.x)} ${f(tail.y)} L${f(cx - base / 2)} ${f(h)}`); }
  parts.push(`L${f(r)} ${f(h)} Q0 ${f(h)} 0 ${f(h - r)}`);
  if (side === 'left') { const cy = clampN(tail.y, r + base, h - r - base); parts.push(`L0 ${f(cy + base / 2)} L${f(tail.x)} ${f(tail.y)} L0 ${f(cy - base / 2)}`); }
  parts.push(`L0 ${f(r)} Q0 0 ${f(r)} 0 Z`);
  return parts.join(' ');
}

export function tailSide(w: number, h: number, t: Pt): 'top' | 'bottom' | 'left' | 'right' {
  if (t.y > h) return 'bottom';
  if (t.y < 0) return 'top';
  return t.x < 0 ? 'left' : 'right';
}

const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** ขอบหยัก: จุดสลับนอก-ใน รอบวงรีที่ครอบกล่อง (ซี่ยาวสุดชี้ไปที่ tail) */
function burstPath(w: number, h: number, tail: Pt): string {
  const cx = w / 2, cy = h / 2, n = 22;
  const ax = w / 2 + 10, ay = h / 2 + 10;
  const tailAng = Math.atan2(tail.y - cy, tail.x - cx);
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const outer = i % 2 === 0;
    let kx = outer ? 1.08 + 0.06 * ((i * 7) % 3) / 2 : 0.94, ky = kx;
    const d = Math.abs(Math.atan2(Math.sin(a - tailAng), Math.cos(a - tailAng)));
    let px = cx + Math.cos(a) * ax * kx, py = cy + Math.sin(a) * ay * ky;
    if (outer && d < Math.PI / n) { px = tail.x; py = tail.y; }
    pts.push(`${i === 0 ? 'M' : 'L'}${f(px)} ${f(py)}`);
  }
  return pts.join(' ') + ' Z';
}

/** เมฆ: ส่วนโค้งนูนต่อกันรอบกล่อง */
function cloudPath(w: number, h: number): string {
  const nx = Math.max(3, Math.round(w / 46)), ny = Math.max(2, Math.round(h / 40));
  const d: string[] = [`M0 0`];
  const arc = (x: number, y: number, r: number) => `A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y)}`;
  const sx = w / nx, sy = h / ny;
  for (let i = 1; i <= nx; i++) d.push(arc(i * sx, 0, sx * 0.62));
  for (let i = 1; i <= ny; i++) d.push(arc(w, i * sy, sy * 0.62));
  for (let i = nx - 1; i >= 0; i--) d.push(arc(i * sx, h, sx * 0.62));
  for (let i = ny - 1; i >= 0; i--) d.push(arc(0, i * sy, sy * 0.62));
  return d.join(' ') + ' Z';
}

/** ฟองความคิด 3 ฟอง จากขอบกล่องไปหาตัวละคร */
export function thinkDots(w: number, h: number, tail: Pt): { x: number; y: number; r: number }[] {
  const start = { x: clampN(tail.x, 12, w - 12), y: clampN(tail.y, 0, h) };
  if (tail.y > h) start.y = h + 6; else if (tail.y < 0) start.y = -6;
  else start.x = tail.x < 0 ? -6 : w + 6;
  return [0.25, 0.58, 0.88].map((k, i) => ({ x: start.x + (tail.x - start.x) * k, y: start.y + (tail.y - start.y) * k, r: 7 - i * 2 }));
}
