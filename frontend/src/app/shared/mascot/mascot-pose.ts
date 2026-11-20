/**
 * ท่าทางของน้องโคราชดี 3 มิติ (ฟังก์ชันล้วน — ไม่พึ่ง three.js ทดสอบได้)
 * ค่ามุมเป็นเรเดียนในความหมายของท่าทาง (ยก/ไปข้างหน้า/งอ) — mascot-model แปลงเป็นการหมุนของข้อต่อ
 * เปลี่ยนท่า = ค่อยๆ เข้าหาค่าเป้าหมาย (blendJoints) จึงต่อเนื่องไม่กระตุก
 */
export const JOINT_KEYS = [
  'rootY', 'rootX', 'bodyPitch', 'bodyRoll', 'headPitch', 'headYaw', 'headRoll',
  'armRRaise', 'armRFwd', 'armRElbow', 'armRBend', 'armLRaise', 'armLFwd', 'armLElbow', 'armLBend',
  'legRFwd', 'legLFwd', 'legRKnee', 'legLKnee', 'legSpread', 'finger', 'cape',
] as const;
export type JointKey = typeof JOINT_KEYS[number];
export type Joints = Record<JointKey, number>;

export type PoseName = 'idle' | 'wave' | 'point' | 'aimLeft' | 'aimRight' | 'fly' | 'hover' | 'sit' | 'talk' | 'think' | 'shy' | 'cheer' | 'walk' | 'sleep' | 'drag';
export const POSE_NAMES: PoseName[] = ['idle', 'wave', 'point', 'aimLeft', 'aimRight', 'fly', 'hover', 'sit', 'talk', 'think', 'shy', 'cheer', 'walk', 'sleep', 'drag'];

export interface PoseParams {
  /** ความเร็วสัมพัทธ์ 0–1 (ท่าบิน) */
  speed?: number;
}

export function neutralJoints(): Joints {
  return Object.fromEntries(JOINT_KEYS.map(k => [k, 0])) as Joints;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** ค่าเป้าหมายของข้อต่อในท่านั้น ณ เวลา t (วินาที) */
export function poseTargets(name: PoseName, t: number, p: PoseParams = {}): Joints {
  const j = neutralJoints();
  const breathe = Math.sin(t * 2.1);
  // ท่าพื้นฐาน: ยืนผ่อนคลาย หายใจ มองซ้าย-ขวาช้าๆ
  j.bodyPitch = 0.02 * breathe;
  j.headYaw = Math.sin(t * 0.55) * 0.18;
  j.headPitch = 0.03 * Math.sin(t * 0.9);
  j.armRRaise = 0.14 + 0.03 * breathe; j.armLRaise = 0.14 + 0.03 * breathe;
  j.armRElbow = 0.25; j.armLElbow = 0.25;
  j.cape = 0.12;
  switch (name) {
    case 'idle': break;
    case 'wave': // ยกแขนข้างลำตัว ศอกพับขึ้น มือโบกซ้าย-ขวา
      j.armRRaise = 1.35; j.armRFwd = 0.2; j.armRElbow = 0.1; j.armRBend = -(1.2 + Math.sin(t * 9) * 0.45);
      j.headRoll = -0.1; j.headYaw = 0.05;
      break;
    case 'point': // ชูนิ้วชี้ข้างหัว (ท่าต้นแบบ)
      j.armRRaise = 1.0; j.armRFwd = 0.35; j.armRElbow = 0.2; j.armRBend = -1.45; j.finger = 1;
      j.headRoll = 0.08; j.headYaw = 0.12; j.bodyRoll = -0.04;
      break;
    case 'aimRight': // ยื่นแขนซ้ายของตัวละคร (ขวาของจอ) ชี้ไปที่เป้าหมาย
      j.armLRaise = 1.5; j.armLFwd = 0.3; j.armLElbow = 0.05; j.finger = 1;
      j.headYaw = 0.3; j.headRoll = -0.06; j.bodyRoll = 0.04;
      break;
    case 'aimLeft': // ยื่นแขนขวาของตัวละคร (ซ้ายของจอ) ชี้ไปที่เป้าหมาย
      j.armRRaise = 1.5; j.armRFwd = 0.3; j.armRElbow = 0.05; j.finger = 1;
      j.headYaw = -0.3; j.headRoll = 0.06; j.bodyRoll = -0.04;
      break;
    case 'fly': {
      const s = clamp01(p.speed ?? 1);
      j.bodyPitch = 0.3 + 0.85 * s;
      j.headPitch = -(0.2 + 0.55 * s);
      j.armRFwd = 2.3 + 0.5 * s; j.armRRaise = 0.25; j.armRElbow = 0.1; // แขนขวาชูไปข้างหน้า
      j.armLFwd = -0.55; j.armLRaise = 0.35; j.armLElbow = 0.3;         // แขนซ้ายลู่ไปด้านหลัง
      j.legRFwd = -0.25 - 0.15 * s; j.legLFwd = -0.05 + 0.08 * Math.sin(t * 4); j.legLKnee = 0.55; j.legRKnee = 0.1;
      j.cape = 0.55 + 0.45 * s;
      j.headYaw = 0;
      break;
    }
    case 'hover':
      j.bodyPitch = 0.08; j.armRRaise = 0.5 + 0.08 * Math.sin(t * 3); j.armLRaise = 0.5 + 0.08 * Math.sin(t * 3 + 1);
      j.legRFwd = 0.12 * Math.sin(t * 2.4); j.legLFwd = -0.12 * Math.sin(t * 2.4); j.legRKnee = 0.25; j.legLKnee = 0.25;
      j.cape = 0.35;
      break;
    case 'sit':
      j.rootY = -0.5; j.legRFwd = 1.45; j.legLFwd = 1.45; j.legSpread = 0.18; j.legRKnee = 0.15; j.legLKnee = 0.15;
      j.armRRaise = 0.35; j.armLRaise = 0.35; j.armRFwd = 0.3; j.armLFwd = 0.3; j.bodyPitch = -0.08;
      break;
    case 'talk':
      j.armLRaise = 0.45 + Math.sin(t * 3.2) * 0.2; j.armLFwd = 0.7; j.armLElbow = 1.0 + Math.sin(t * 2.3) * 0.25;
      j.headPitch = 0.05 * Math.sin(t * 4.4); j.headYaw = Math.sin(t * 0.8) * 0.1;
      break;
    case 'think':
      j.armLFwd = 1.35; j.armLRaise = 0.3; j.armLElbow = 2.05; // มือแตะคาง
      j.headRoll = 0.18; j.headPitch = -0.12; j.headYaw = 0.12;
      break;
    case 'shy': // ยกมือปิดจอ (ไม่แอบดูรหัสผ่าน)
      j.armRFwd = 2.45; j.armRRaise = -0.3; j.armRElbow = 0.75;
      j.armLFwd = 2.45; j.armLRaise = -0.3; j.armLElbow = 0.75;
      j.headPitch = 0.32; j.headYaw = 0; j.bodyPitch = 0.08;
      break;
    case 'cheer':
      j.armRRaise = 2.7; j.armLRaise = 2.7; j.armRElbow = 0.2; j.armLElbow = 0.2;
      j.rootY = Math.abs(Math.sin(t * 6)) * 0.14; j.headPitch = -0.1;
      break;
    case 'sleep': { // นอนตะแคงหันหน้าเข้าหาผู้ชม ขางอเล็กน้อย หายใจช้าๆ (เห็นหน้าหลับตา)
      const b = Math.sin(t * 1.1);
      j.rootY = 0.1; j.rootX = 0.38; j.bodyRoll = 1.48 + 0.015 * b; j.bodyPitch = 0;
      j.headPitch = 0.05; j.headYaw = 0; j.headRoll = -0.1;
      j.legRFwd = 0.55; j.legLFwd = 0.35; j.legRKnee = 0.7; j.legLKnee = 0.5; j.legSpread = 0;
      j.armRRaise = 0.25; j.armRFwd = 0.9; j.armRElbow = 1.2; // แขนล่างหนุนหัว
      j.armLRaise = 0.1; j.armLFwd = 0.5 + 0.03 * b; j.armLElbow = 0.6;
      j.cape = 0;
      break;
    }
    case 'drag': { // ถูกจับลาก: แขนชูดิ้น ขาแกว่ง
      const k = Math.sin(t * 9);
      j.armRRaise = 2.4 + 0.25 * k; j.armLRaise = 2.4 - 0.25 * k; j.armRElbow = 0.3; j.armLElbow = 0.3;
      j.legRFwd = 0.45 * k; j.legLFwd = -0.45 * k; j.legRKnee = 0.4; j.legLKnee = 0.4;
      j.headPitch = 0.06; j.headYaw = 0; j.cape = 0.5;
      break;
    }
    case 'walk': {
      const w = Math.sin(t * 7);
      j.legRFwd = 0.5 * w; j.legLFwd = -0.5 * w; j.legRKnee = Math.max(0, -w) * 0.5; j.legLKnee = Math.max(0, w) * 0.5;
      j.armRFwd = -0.4 * w; j.armLFwd = 0.4 * w; j.rootY = Math.abs(w) * 0.03;
      break;
    }
  }
  return j;
}

/** เข้าหาเป้าหมายแบบหน่วง (ไม่ขึ้นกับอัตราเฟรม) — rate สูง = เปลี่ยนท่าเร็ว */
export function blendJoints(cur: Joints, target: Joints, dt: number, rate = 7): Joints {
  const k = 1 - Math.exp(-Math.max(0, dt) * rate);
  const out = {} as Joints;
  for (const key of JOINT_KEYS) out[key] = cur[key] + (target[key] - cur[key]) * k;
  return out;
}

/** เลือกท่าจากสถานะการเคลื่อนที่ (เมื่อไม่ได้สั่งท่าเฉพาะ) */
export function autoPose(speed: number, holding: boolean): PoseName {
  if (speed > 0.35) return 'fly';
  if (speed > 0.08) return 'hover';
  return holding ? 'idle' : 'hover';
}
