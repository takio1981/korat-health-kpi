import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import type { BubbleKind } from './mascot-dialog';
import type { PoseName } from './mascot-pose';
import type { Mood } from './mascot-face';

/** คำสั่งให้น้องโคราชดีพูด: บทที่เตรียมไว้ (node) หรือข้อความ (text) */
export interface MascotCue {
  node?: string;
  text?: string;
  kind?: BubbleKind;
  pose?: PoseName;
  mood?: Mood;
  auto?: number;
}

const HIDE_KEY = 'kpi_mascot_assistant_off';
const QUIET_KEY = 'kpi_mascot_assistant_quiet';
const SEEN_KEY = 'kpi_mascot_seen_pages';

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
  private uid = '';

  say(cue: MascotCue) { this.cues.next(cue); }

  /** เรียกเมื่อรู้ตัวผู้ใช้ (layout) — โหลดค่าที่จำไว้ของบัญชีนั้น */
  bindUser(uid: string | number | null | undefined) {
    this.uid = uid == null ? '' : String(uid);
    this.assistantHidden$.next(lsGet(this.key(HIDE_KEY)) === '1');
  }
  setAssistantHidden(v: boolean) { lsSet(this.key(HIDE_KEY), v ? '1' : null); this.assistantHidden$.next(v); }
  toggleAssistant() { this.setAssistantHidden(!this.assistantHidden$.value); }

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
