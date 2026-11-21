/**
 * รวมทุกประโยคที่น้องโคราชดีพูดจากบทที่เตรียมไว้ (ฟังก์ชันล้วน) — ใช้ 2 ที่:
 * tools/video-guide/build-mascot-voice.js สร้างไฟล์เสียงให้ครบ, mascot-voice.spec.ts ตรวจว่าไม่มีประโยคใดขาดไฟล์เสียง
 * (เพิ่ม/แก้ข้อความในบทพูด → ต้องรันตัวสร้างไฟล์เสียงใหม่ ไม่งั้น spec ล้ม)
 */
import { LOGIN_SCRIPT, LOGIN_TIPS, resolveNode } from './mascot-dialog';
import { PAGE_GUIDES, guideFor, guideRole } from './mascot-guides';
import { assistantScript } from './mascot-assistant-script';
import { AI_SAY } from './mascot-phrases';
import { FESTIVALS } from './mascot-festival';
import { normVoice, speakable, voiceKey } from './mascot-voice';

export { normVoice, speakable, voiceKey };

export const VOICE_ROLES = ['super_admin', 'admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso', 'user_cup', 'user_hos', 'user_sso', 'user_ssj'];

export function collectVoicePhrases(): string[] {
  const out = new Set<string>();
  const add = (t: string | undefined | null) => { const n = normVoice(t || ''); if (n) out.add(n); };
  for (const hour of [8, 14, 18, 23]) for (const thaid of [false, true]) for (const providerid of [false, true]) {
    for (const id of Object.keys(LOGIN_SCRIPT)) {
      const n = resolveNode(LOGIN_SCRIPT, id, { hour, thaid, providerid });
      (n?.voice?.length ? n.voice : [n?.text]).forEach(add);
    }
  }
  LOGIN_TIPS.forEach(add);
  for (const role of VOICE_ROLES) {
    const r = guideRole(role);
    for (const page of [...Object.keys(PAGE_GUIDES), '__none']) {
      const g = guideFor(page);
      for (const quiet of [false, true]) {
        const script = assistantScript(g, r, { page, quiet, hasVideo: true, hasAi: true });
        for (const id of Object.keys(script)) {
          if (id === 'step') continue;
          const n = resolveNode(script, id, { hour: 10 });
          (n?.voice?.length ? n.voice : [n?.text]).forEach(add);
        }
      }
      (g?.steps?.(r) || []).forEach(st => add(st.text));
    }
  }
  Object.values(AI_SAY).forEach(add);
  FESTIVALS.forEach(f => add(f.greet));
  return [...out].sort();
}
