import { VoiceIndex, VoicePlayer, clipFor, envLevel, estimateMs, normVoice, speakable, voiceKey } from './mascot-voice';
import { collectVoicePhrases } from './mascot-voice-phrases';
import voiceIndex from '../../../../public/mascot/voice/index.json';

describe('mascot-voice (เสียงพูดของน้องคิดดี)', () => {
  it('voiceKey: คงที่ ไม่สนช่องว่างซ้ำ และต่างกันเมื่อข้อความต่าง', () => {
    expect(voiceKey('สวัสดี  ครับ ')).toBe(voiceKey('สวัสดี ครับ'));
    expect(voiceKey('ก')).not.toBe(voiceKey('ข'));
    expect(voiceKey('ทดสอบ')).toMatch(/^[0-9a-f]{8}-[0-9a-z]+$/);
    // ค่าคงที่ — ถ้าเปลี่ยนสูตร ไฟล์เสียงทั้งหมดจะหาไม่เจอ (ตัวสร้างไฟล์ใช้ฟังก์ชันเดียวกัน)
    expect(voiceKey('น้องคิดดี')).toBe(voiceKey('น้องคิดดี'));
  });

  it('clipFor: ประโยคที่ไม่มีไฟล์ (เช่น คำตอบ AI) ไม่ขอไฟล์ = ไม่เกิด 404 — ดัชนีอ่านไม่ได้จึงลองชื่อคีย์', () => {
    const idx = { [voiceKey('สวัสดีครับ')]: { f: 'a.mp3', ms: 500, e: '1' } } as VoiceIndex;
    expect(clipFor(idx, 'สวัสดีครับ')).toEqual({ f: 'a.mp3', ms: 500, e: '1' });
    expect(clipFor(idx, 'คำตอบจาก AI ที่สร้างตอนใช้งาน')).toBeNull();
    expect(clipFor({}, 'ก')!.f).toBe(voiceKey('ก') + '.mp3');
    expect(clipFor(null, 'ก')!.f).toBe(voiceKey('ก') + '.mp3');
    expect(clipFor(idx, 'toString')).toBeNull();
  });

  it('speakable: ขยายชื่อเดือนย่อ/คำย่อ และตัดลำดับขั้น', () => {
    expect(speakable('ตั้งแต่ ต.ค. ถึง ก.ย. ครับ')).toBe('ตั้งแต่ ตุลาคม ถึง กันยายน ครับ');
    expect(speakable('(2/6) กดปุ่ม ThaID')).toBe('กดปุ่ม ไทยดี');
    expect(speakable('เทียบกับ KHD…')).toBe('เทียบกับ เค เอช ดี');
    expect(normVoice('  ก  ข ')).toBe('ก ข');
  });

  it('envLevel / estimateMs', () => {
    const clip = { f: 'x.mp3', ms: 200, e: '09' };
    expect(envLevel(clip, 0)).toBe(0);
    expect(envLevel(clip, 50)).toBe(1);
    expect(envLevel(clip, 5000)).toBe(0);
    const idx: VoiceIndex = { [voiceKey('ก')]: clip };
    expect(estimateMs(idx, ['ก'])).toBe(320);
    expect(estimateMs(idx, ['ก', 'ข'])).toBeNull();
    expect(estimateMs(null, ['ก'])).toBeNull();
  });

  it('VoicePlayer: ประโยคที่ไม่มีไฟล์ใช้เสียงแบบสด (Gemini) ก่อนเสียงเบราว์เซอร์ — ขอทุกประโยคพร้อมกัน ส่งข้อความที่อ่านออกเสียงได้', async () => {
    const played: string[] = [];
    const RealAudio = (globalThis as any).Audio;
    (globalThis as any).Audio = class {
      onended: any = null; onerror: any = null; paused = true; currentTime = 0;
      constructor(public src: string) { played.push(src); }
      play() { this.paused = false; setTimeout(() => this.onended?.(), 0); return Promise.resolve(); }
      pause() { this.paused = true; }
    };
    try {
      const p = new VoicePlayer('voice/');
      p.index = { [voiceKey('มีไฟล์ครับ')]: { f: 'have.mp3', ms: 500, e: '5' } };
      (p as any).loadP = Promise.resolve();
      const asked: string[] = [];
      const live = vi.fn(async (t: string) => { asked.push(t); return { audio: 'QUJD', mime: 'audio/wav', ms: 300, e: '9' }; });
      p.live = () => live;
      p.speak(['คำตอบที่ 1 เรื่อง KHD', 'มีไฟล์ครับ', 'คำตอบที่ 2']);
      await vi.waitFor(() => expect(p.playing).toBe(false));
      expect(asked).toEqual(['คำตอบที่ 1 เรื่อง เค เอช ดี', 'คำตอบที่ 2']);
      expect(played).toEqual(['data:audio/wav;base64,QUJD', 'voice/have.mp3', 'data:audio/wav;base64,QUJD']);
      // ไม่มีเสียงแบบสด (ผู้ดูแลปิด / ยังไม่เข้าสู่ระบบ) = ไม่ขอ
      p.live = () => null; played.length = 0;
      p.speak(['มีไฟล์ครับ']);
      await vi.waitFor(() => expect(p.playing).toBe(false));
      expect(played).toEqual(['voice/have.mp3']);
      p.dispose();
    } finally { (globalThis as any).Audio = RealAudio; }
  });

  it('ทุกประโยคในบทพูดมีไฟล์เสียงแล้ว (แก้บทพูด → รัน node tools/video-guide/build-mascot-voice.js)', () => {
    const idx = voiceIndex as unknown as VoiceIndex;
    const missing = collectVoicePhrases().filter(p => !idx[voiceKey(p)]);
    expect(missing).toEqual([]);
    for (const c of Object.values(idx)) {
      expect(c.f).toMatch(/^[0-9a-f]{8}-[0-9a-z]+\.mp3$/);
      expect(c.ms).toBeGreaterThan(300);
      expect(c.e).toMatch(/^[0-9]+$/);
    }
  });
});
