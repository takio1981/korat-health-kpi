import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import type { BubbleKind } from './mascot-dialog';
import type { PoseName } from './mascot-pose';
import type { Mood } from './mascot-face';
import { AI_SAY } from './mascot-phrases';
import { MASCOT_SIZES, MascotSize } from './mascot-size';
import { FestivalDates, normalizeOutfitMode, sanitizeFestivalDates } from './mascot-festival';

export interface OutfitConfig { mode: string; dates: FestivalDates }

/** คำสั่งให้น้องโคราชดีพูด: บทที่เตรียมไว้ (node) หรือข้อความ (text) */
export interface MascotCue {
  node?: string;
  text?: string;
  kind?: BubbleKind;
  pose?: PoseName;
  mood?: Mood;
  auto?: number;
  /** บินไปชี้ element นี้ (เฉพาะเมื่ออยู่ในจอ) */
  pointEl?: HTMLElement | null;
}

/** element อยู่ในจอ (เห็นอย่างน้อยครึ่ง) — ไม่อยู่ = พูดอย่างเดียว ไม่บินไปชี้ */
export function inViewport(el: HTMLElement | null | undefined): boolean {
  if (!el || typeof window === 'undefined') return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const vh = window.innerHeight, vw = window.innerWidth;
  const visH = Math.min(r.bottom, vh) - Math.max(r.top, 0), visW = Math.min(r.right, vw) - Math.max(r.left, 0);
  return visH > Math.min(r.height, vh) * 0.5 && visW > 0;
}

const HIDE_KEY = 'kpi_mascot_assistant_off';
const QUIET_KEY = 'kpi_mascot_assistant_quiet';
const SEEN_KEY = 'kpi_mascot_seen_pages';
const VOICE_OFF_KEY = 'kpi_mascot_voice_off';
export const SIZE_KEY = 'kpi_mascot_size';

function readSize(): MascotSize | '' {
  const v = lsGet(SIZE_KEY);
  return v && (MASCOT_SIZES as string[]).includes(v) ? v as MascotSize : '';
}

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ไม่มีที่เก็บ */ } }

/**
 * ช่องทางให้ส่วนอื่นของระบบสั่งน้องโคราชดีพูด (เช่น หน้าเข้าสู่ระบบแจ้งเข้าสู่ระบบไม่สำเร็จ)
 * + สถานะผู้ช่วยในระบบ (ระยะที่ 2): ผู้ใช้ซ่อนเอง / ไม่ต้องทักเมื่อเข้าหน้าใหม่ / หน้าที่เคยทักแล้ว — เก็บในเครื่องแยกตามบัญชี
 * ไม่มีตัวละครแสดงอยู่ = คำสั่งพูดถูกทิ้ง (ไม่มีผลข้างเคียง)
 */
@Injectable({ providedIn: 'root' })
export class MascotService {
  readonly cues = new Subject<MascotCue>();
  /** ผู้ใช้ซ่อนผู้ช่วยในเครื่องนี้ */
  readonly assistantHidden$ = new BehaviorSubject<boolean>(false);
  /** ผู้ใช้ปิดเสียงพูดของน้องในเครื่องนี้ (ไม่แยกบัญชี — ใช้ได้ทั้งก่อนและหลังเข้าสู่ระบบ) */
  readonly voiceMuted$ = new BehaviorSubject<boolean>(lsGet(VOICE_OFF_KEY) === '1');
  /** ขนาดที่ผู้ใช้เลือกในเครื่องนี้ ('' = ตามค่าตั้งต้นของระบบ) — ไม่แยกบัญชี ใช้ได้ทั้งหน้าเข้าสู่ระบบและหลังเข้าสู่ระบบ */
  readonly size$ = new BehaviorSubject<MascotSize | ''>(readSize());
  /** ชุดเทศกาลจากค่าระบบ (maintenance-status): mode = auto | none | id เทศกาล, dates = วันที่จันทรคติที่ผู้ดูแลกรอก */
  readonly outfit$ = new BehaviorSubject<OutfitConfig>({ mode: 'auto', dates: {} });
  /** ลองชุดในหน้าตั้งค่า (ไม่บันทึก) — null = ไม่ลอง */
  readonly outfitPreview$ = new BehaviorSubject<string | null>(null);
  private uid = '';

  say(cue: MascotCue) { this.cues.next(cue); }

  // ===== ตัวแทนผู้ช่วย AI (ระยะที่ 3) — แผง AI เรียกตอนเริ่ม/สำเร็จ/ล้มเหลว (ไม่มีผู้ช่วยแสดงอยู่ = ไม่มีผล) =====
  aiThinking(text: string = AI_SAY.thinking) {
    this.say({ text, kind: 'think', pose: 'think', mood: 'think', auto: 2600 });
  }
  aiDone(text: string, el?: HTMLElement | null) {
    this.say({ text, pose: 'point', mood: 'happy', auto: 5500, pointEl: inViewport(el) ? el : null });
  }
  aiFailed(text: string = AI_SAY.failed) {
    this.say({ text, kind: 'shout', pose: 'think', mood: 'sad', auto: 5000 });
  }

  /** เรียกเมื่อรู้ตัวผู้ใช้ (layout) — โหลดค่าที่จำไว้ของบัญชีนั้น */
  bindUser(uid: string | number | null | undefined) {
    this.uid = uid == null ? '' : String(uid);
    this.assistantHidden$.next(lsGet(this.key(HIDE_KEY)) === '1');
  }
  setAssistantHidden(v: boolean) { lsSet(this.key(HIDE_KEY), v ? '1' : null); this.assistantHidden$.next(v); }
  toggleAssistant() { this.setAssistantHidden(!this.assistantHidden$.value); }
  setVoiceMuted(v: boolean) { lsSet(VOICE_OFF_KEY, v ? '1' : null); this.voiceMuted$.next(v); }
  /** ค่าชุดเทศกาลจาก maintenance-status (ตรวจค่าแล้ว) — ไม่เปลี่ยน = ไม่แจ้งซ้ำ */
  setOutfitConfig(mode: unknown, dates: unknown) {
    const next: OutfitConfig = { mode: normalizeOutfitMode(mode), dates: sanitizeFestivalDates(dates) };
    const cur = this.outfit$.value;
    if (cur.mode !== next.mode || JSON.stringify(cur.dates) !== JSON.stringify(next.dates)) this.outfit$.next(next);
  }
  /** '' = กลับไปใช้ค่าตั้งต้นของระบบ */
  setSize(v: MascotSize | '') {
    const s = (MASCOT_SIZES as string[]).includes(v) ? v : '';
    lsSet(SIZE_KEY, s || null); this.size$.next(s);
  }

  get quiet(): boolean { return lsGet(this.key(QUIET_KEY)) === '1'; }
  setQuiet(v: boolean) { lsSet(this.key(QUIET_KEY), v ? '1' : null); }

  seen(page: string): boolean { return this.seenList().includes(page); }
  markSeen(page: string) {
    const l = this.seenList();
    if (!l.includes(page)) lsSet(this.key(SEEN_KEY), JSON.stringify([...l, page].slice(-60)));
  }
  private seenList(): string[] {
    try { const v = JSON.parse(lsGet(this.key(SEEN_KEY)) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
  }
  private key(k: string) { return this.uid ? `${k}_${this.uid}` : k; }
}
