/**
 * บทสนทนาของผู้ช่วยน้องโคราชดีทุกหน้า (ฟังก์ชันล้วน — ไม่พึ่ง Angular) ใช้ทั้งคอมโพเนนต์ผู้ช่วยและตัวสร้างไฟล์เสียง
 * (tools/video-guide/build-mascot-voice.js) — `voice` = ประโยคที่พูดจริง (ข้อความในกล่องอาจมีชื่อหน้า/ลำดับขั้นเพิ่ม)
 */
import type { DialogChoice, DialogScript } from './mascot-dialog';
import { GuideRole, PageGuide, introOf } from './mascot-guides';

export const ASK_PROMPT = 'อยากรู้เรื่องไหน พิมพ์ถามได้เลยครับ ผมจะค้นจากคู่มือการใช้งานตามสิทธิ์ของท่าน';
export const MENU_TAIL = 'มีอะไรให้ผมช่วยไหมครับ?';
export const FIRST_TAIL = 'ให้ผมแนะนำการใช้งานไหมครับ?';
export const NO_GUIDE_INTRO = 'ผมน้องโคราชดี ผู้ช่วยประจำระบบครับ';

/** ตัวเลือกในเมนูหลักของผู้ช่วย */
export function assistantMenu(o: { hasSteps: boolean; hasVideo: boolean; page: string; quiet: boolean; hasAi?: boolean; movedHome?: boolean }): DialogChoice[] {
  return [
    ...(o.hasSteps ? [{ label: 'แนะนำหน้านี้ทีละขั้น', action: 'tour:start' }] : []),
    ...(o.hasAi ? [{ label: 'ถามน้องโคราชดี (AI)', action: 'ask' }] : []),
    ...(o.hasVideo ? [{ label: 'ดูวิดีโอคู่มือหน้านี้', action: 'video' }] : []),
    ...(o.page !== 'help' ? [{ label: 'เปิดคู่มือการใช้งาน', action: 'nav:/help' }] : []),
    { label: o.quiet ? 'ทักทายเมื่อเข้าหน้าใหม่' : 'ไม่ต้องทักเมื่อเข้าหน้าใหม่', action: 'quiet' },
    ...(o.movedHome ? [{ label: 'กลับไปมุมขวาล่าง', action: 'home:reset' }] : []),
    { label: 'ซ่อนน้องโคราชดี', action: 'hide' },
    { label: 'ปิด', next: 'bye' },
  ];
}

/** ตัวเลือกของขั้นที่ i จากทั้งหมด n ขั้น */
export function stepChoices(i: number, n: number): DialogChoice[] {
  const last = i >= n - 1;
  return [
    ...(i > 0 ? [{ label: 'ย้อนกลับ', action: 'tour:prev' }] : []),
    last ? { label: 'จบการแนะนำ', action: 'tour:end' } : { label: 'ถัดไป', action: 'tour:next' },
    ...(!last ? [{ label: 'พอแล้ว', action: 'tour:end' }] : []),
  ];
}

export function assistantScript(g: PageGuide | null, r: GuideRole, o: { page: string; quiet: boolean; hasVideo: boolean; hasAi: boolean; movedHome?: boolean }): DialogScript {
  const hasSteps = !!g?.steps && g.steps(r).length > 0;
  const menu = assistantMenu({ hasSteps, hasVideo: o.hasVideo, page: o.page, quiet: o.quiet, hasAi: o.hasAi, movedHome: o.movedHome });
  const intro = g ? introOf(g, r) : NO_GUIDE_INTRO;
  return {
    start: { text: `${intro} ${MENU_TAIL}`, voice: [intro, MENU_TAIL], pose: 'wave', mood: 'happy', choices: menu },
    first: {
      text: g ? `หน้า${g.title} — ${intro} ${FIRST_TAIL}` : intro,
      voice: g ? [intro, FIRST_TAIL] : [intro],
      kind: 'think', pose: 'wave', mood: 'happy',
      choices: [
        ...(hasSteps ? [{ label: 'แนะนำเลย', action: 'tour:start' }] : []),
        ...(o.hasVideo ? [{ label: 'ดูวิดีโอคู่มือ', action: 'video' }] : []),
        { label: 'ไว้ทีหลัง', next: 'later' },
        { label: 'ไม่ต้องทักอีก', action: 'quiet:on' },
      ],
    },
    later: { text: 'ได้เลยครับ คลิกที่ตัวผมเมื่อต้องการให้ช่วยนะครับ', pose: 'wave', auto: 3200 },
    bye: { text: 'ได้เลยครับ ผมอยู่ตรงนี้ คลิกที่ตัวผมได้ทุกเมื่อครับ', pose: 'wave', mood: 'happy', auto: 3000 },
    tourEnd: { text: 'จบการแนะนำแล้วครับ! สงสัยตรงไหนคลิกที่ตัวผมได้เลย', kind: 'shout', pose: 'cheer', mood: 'happy', auto: 3500 },
    noStep: { text: 'ตอนนี้ยังไม่เห็นปุ่มที่จะแนะนำในหน้านี้ ลองเลือกข้อมูลหรือรอให้หน้าโหลดเสร็จก่อนนะครับ', pose: 'think', mood: 'think', auto: 5000 },
    quietOn: { text: 'รับทราบครับ ผมจะไม่ทักเมื่อเข้าหน้าใหม่ แต่ยังอยู่ตรงนี้ถ้าต้องการให้ช่วย', pose: 'idle', auto: 4000 },
    quietOff: { text: 'ได้ครับ เข้าหน้าใหม่เมื่อไหร่ผมจะทักทายนะครับ', pose: 'wave', mood: 'happy', auto: 3500 },
    hide: { text: 'ไปพักก่อนนะครับ เรียกผมกลับได้ที่เมนูโปรไฟล์มุมขวาบนครับ', pose: 'wave', mood: 'happy', auto: 2600 },
    step: { text: '', choices: [] },
    ask: {
      text: ASK_PROMPT, pose: 'talk', mood: 'happy', input: { placeholder: 'เช่น บันทึกผลงานรายไตรมาสอย่างไร' },
      choices: [{ label: 'ปิด', next: 'bye' }],
    },
  };
}
