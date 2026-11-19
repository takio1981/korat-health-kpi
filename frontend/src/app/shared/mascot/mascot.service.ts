import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
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

/**
 * ช่องทางให้ส่วนอื่นของระบบสั่งน้องโคราชดีพูด (เช่น หน้าเข้าสู่ระบบแจ้งเข้าสู่ระบบไม่สำเร็จ)
 * ไม่มีตัวละครแสดงอยู่ = คำสั่งถูกทิ้ง (ไม่มีผลข้างเคียง)
 */
@Injectable({ providedIn: 'root' })
export class MascotService {
  readonly cues = new Subject<MascotCue>();
  say(cue: MascotCue) { this.cues.next(cue); }
}
