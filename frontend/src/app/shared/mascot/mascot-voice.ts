/**
 * เสียงพูดของน้องโคราชดี (20 พ.ย. 2569 — ผู้ใช้เลือก: ไฟล์เสียงสร้างล่วงหน้า + เสียงเบราว์เซอร์สำรอง, เปิดเสียงเป็นค่าตั้งต้น มีปุ่มปิด)
 * — ประโยคที่เตรียมไว้: ไฟล์ public/mascot/voice/<key>.mp3 เสียง th-TH-NiwatNeural (ตัวเดียวกับวิดีโอคู่มือ) สร้างด้วย
 *   tools/video-guide/build-mascot-voice.js + index.json (ความยาว + ซองความดัง 25 ครั้ง/วินาที → ปากขยับตามเสียงจริง)
 * — ข้อความที่ไม่มีไฟล์ (เช่น คำตอบจาก AI) = เสียงภาษาไทยของเบราว์เซอร์ (speechSynthesis) ถ้าเครื่องไม่มีเสียงไทย = ไม่อ่าน
 * — เบราว์เซอร์ไม่ยอมเล่นเสียงก่อนผู้ใช้คลิกหน้าเว็บ: เก็บประโยคไว้ แล้วเริ่มพูดเมื่อผู้ใช้คลิก/กดแป้นครั้งแรก
 */
export interface VoiceClip { f: string; ms: number; e: string; }
export type VoiceIndex = Record<string, VoiceClip>;

export const VOICE_BASE = 'mascot/voice/';
export const VOICE_FPS = 25;

/** ข้อความมาตรฐานก่อนทำคีย์ (ช่องว่างซ้ำ/หัวท้าย) */
export function normVoice(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** คีย์ไฟล์เสียงของข้อความ (FNV-1a 32 บิต + ความยาว) — ตัวสร้างไฟล์ใช้ฟังก์ชันเดียวกัน */
export function voiceKey(text: string): string {
  const s = normVoice(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0') + '-' + s.length.toString(36);
}

const SAY_AS: [RegExp, string][] = [
  [/ต\.ค\./g, 'ตุลาคม'], [/พ\.ย\./g, 'พฤศจิกายน'], [/ธ\.ค\./g, 'ธันวาคม'], [/ม\.ค\./g, 'มกราคม'], [/ก\.พ\./g, 'กุมภาพันธ์'],
  [/มี\.ค\./g, 'มีนาคม'], [/เม\.ย\./g, 'เมษายน'], [/พ\.ค\./g, 'พฤษภาคม'], [/มิ\.ย\./g, 'มิถุนายน'], [/ก\.ค\./g, 'กรกฎาคม'],
  [/ส\.ค\./g, 'สิงหาคม'], [/ก\.ย\./g, 'กันยายน'], [/รพ\.สต\./g, 'โรงพยาบาลส่งเสริมสุขภาพตำบล'], [/สสจ\./g, 'สำนักงานสาธารณสุขจังหวัด'],
  [/\bThaID\b/g, 'ไทยดี'], [/\bProviderID\b/g, 'โพรไวเดอร์ไอดี'], [/\bKHD\b/g, 'เค เอช ดี'],
  [/[—–…"“”]/g, ' '], [/\s*\(\d+\/\d+\)\s*/g, ' '],
];
/** ข้อความสำหรับอ่านออกเสียง (ขยายคำย่อ/ตัดสัญลักษณ์) */
export function speakable(text: string): string {
  let s = normVoice(text);
  for (const [re, to] of SAY_AS) s = s.replace(re, to);
  return normVoice(s);
}

/** ระดับเสียง (0..1) ณ เวลา ms จากซองความดังของไฟล์ */
export function envLevel(clip: VoiceClip, ms: number): number {
  const i = Math.floor((ms / 1000) * VOICE_FPS);
  const c = clip.e.charCodeAt(Math.max(0, Math.min(clip.e.length - 1, i))) - 48;
  return i < 0 || i >= clip.e.length || !(c >= 0 && c <= 9) ? 0 : c / 9;
}

/** เวลารวมโดยประมาณ (ms) ของช่วงประโยค — มีช่วงที่ไม่มีไฟล์ = null */
export function estimateMs(index: VoiceIndex | null, segs: string[]): number | null {
  if (!index) return null;
  let t = 0;
  for (const s of segs) { const c = index[voiceKey(s)]; if (!c) return null; t += c.ms + 120; }
  return t;
}

/**
 * ไฟล์เสียงของประโยค: อยู่ในดัชนี = ไฟล์นั้น | ดัชนีโหลดได้แต่ไม่มีประโยคนี้ = null (ใช้เสียงเบราว์เซอร์ ไม่ขอไฟล์)
 * | ดัชนีว่าง/โหลดไม่ได้ = ลองเปิดไฟล์ตามชื่อคีย์ (ไฟล์อาจมีอยู่แม้อ่านดัชนีไม่ได้)
 */
export function clipFor(index: VoiceIndex | null, seg: string): VoiceClip | null {
  const key = voiceKey(seg);
  if (index && Object.prototype.hasOwnProperty.call(index, key)) return index[key];
  if (index && Object.keys(index).length) return null;
  return { f: key + '.mp3', ms: 0, e: '' };
}

/** เล่นเสียงประโยคตามลำดับ (ไฟล์ก่อน ไม่มีไฟล์ = เสียงเบราว์เซอร์) */
export class VoicePlayer {
  index: VoiceIndex | null = null;
  playing = false;
  private loadP: Promise<void> | null = null;
  private audio: HTMLAudioElement | null = null;
  private clip: VoiceClip | null = null;
  private synth = false;
  private gen = 0;
  private unlocked = false;
  private pending: string[] | null = null;
  private onGesture = () => {
    this.unlocked = true;
    document.removeEventListener('pointerdown', this.onGesture, true);
    document.removeEventListener('keydown', this.onGesture, true);
    if (this.pending) { const p = this.pending; this.pending = null; this.speak(p); }
  };

  constructor(private base = VOICE_BASE) {
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', this.onGesture, true);
      document.addEventListener('keydown', this.onGesture, true);
    }
  }

  load(): Promise<void> {
    if (!this.loadP) {
      this.loadP = fetch(this.base + 'index.json', { cache: 'no-cache' })
        .then(r => (r.ok ? r.json() : {}))
        .then(j => { this.index = j && typeof j === 'object' ? j as VoiceIndex : {}; })
        .catch(() => { this.index = {}; });
    }
    return this.loadP;
  }

  estimate(segs: string[]): number | null { return estimateMs(this.index, segs); }

  /** ระดับปาก: 0..1 จากไฟล์, -1 = กำลังพูดด้วยเสียงเบราว์เซอร์ (ใช้การขยับปากจำลอง), 0 = เงียบ */
  level(): number {
    if (this.synth) return -1;
    if (!this.audio || !this.clip || this.audio.paused) return 0;
    if (!this.clip.e) return -1; // ไฟล์ที่ไม่มีในดัชนี (ไม่มีซองความดัง) = ขยับปากจำลอง
    return envLevel(this.clip, this.audio.currentTime * 1000);
  }

  speak(segs: string[]) {
    this.stop();
    const list = segs.map(normVoice).filter(Boolean);
    if (!list.length) return;
    const my = ++this.gen;
    this.playing = true;
    const run = async () => {
      await this.load();
      for (const seg of list) {
        if (my !== this.gen) return;
        const clip = clipFor(this.index, seg);
        // ไม่มีไฟล์ (ข้อความที่สร้างตอนใช้งาน เช่น คำตอบ AI) = เสียงเบราว์เซอร์ทันที — ไม่ขอไฟล์ที่ไม่มี (เดิมขอทุกครั้ง → 404 ใน console)
        let ok: true | 'blocked' | 'missing' = clip ? await this.playClip(clip, my) : 'missing';
        if (ok === 'missing' && my === this.gen) ok = await this.playSynth(seg, my);
        if (ok === 'blocked') { if (my === this.gen) { this.pending = list; this.playing = false; } return; }
      }
      if (my === this.gen) this.playing = false;
    };
    run();
  }

  stop() {
    this.gen++;
    this.pending = null;
    this.playing = false;
    if (this.audio) { try { this.audio.pause(); } catch { /* */ } this.audio = null; }
    this.clip = null;
    if (this.synth) { try { window.speechSynthesis?.cancel(); } catch { /* */ } this.synth = false; }
  }

  dispose() {
    this.stop();
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', this.onGesture, true);
      document.removeEventListener('keydown', this.onGesture, true);
    }
  }

  private playClip(clip: VoiceClip, my: number): Promise<true | 'blocked' | 'missing'> {
    return new Promise(resolve => {
      let a: HTMLAudioElement;
      try { a = new Audio(this.base + clip.f); } catch { resolve(true); return; }
      this.audio = a; this.clip = clip;
      const done = () => { if (this.audio === a) { this.audio = null; this.clip = null; } resolve(true); };
      a.onended = done;
      a.onerror = () => { if (this.audio === a) { this.audio = null; this.clip = null; } resolve('missing'); };
      a.play().catch(err => {
        if (this.audio === a) { this.audio = null; this.clip = null; }
        resolve(err?.name === 'NotAllowedError' && !this.unlocked ? 'blocked' : err?.name === 'NotSupportedError' ? 'missing' : true);
      });
      // กันค้าง (ไฟล์โหลดไม่ขึ้น)
      setTimeout(() => { if (this.audio === a && my === this.gen && a.paused && a.currentTime === 0) done(); }, (clip.ms || 15000) + 4000);
    });
  }

  private playSynth(text: string, my: number): Promise<true | 'blocked'> {
    return new Promise(resolve => {
      const ss = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
      const U = typeof window !== 'undefined' ? (window as any).SpeechSynthesisUtterance : undefined;
      if (!ss || !U) { resolve(true); return; }
      if (!this.unlocked) { resolve('blocked'); return; }
      const voice = ss.getVoices().find(v => /^th/i.test(v.lang));
      if (!voice) { resolve(true); return; } // ไม่มีเสียงไทย = ไม่อ่าน (เสียงภาษาอื่นอ่านไทยไม่ได้)
      const u = new U(speakable(text));
      u.lang = 'th-TH'; u.voice = voice; u.rate = 1;
      this.synth = true;
      const end = () => { if (my === this.gen) this.synth = false; resolve(true); };
      u.onend = end; u.onerror = end;
      try { ss.speak(u); } catch { end(); }
    });
  }
}
