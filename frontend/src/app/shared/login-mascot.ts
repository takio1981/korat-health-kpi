import { Component, Input } from '@angular/core';
import { MascotStageComponent } from './mascot/mascot-stage';
import { LOGIN_SCRIPT, LOGIN_TIPS } from './mascot/mascot-dialog';
import type { MascotSize } from './mascot/mascot-size';

/**
 * น้องโคราชดีในหน้าเข้าสู่ระบบ (19 พ.ย. 2569 — ระยะที่ 1): ตัวละคร 3 มิติ (three.js) บินไปมา + กล่องคำพูดแบบมังงะ
 * ทักทายครั้งเดียวต่อการเปิดเบราว์เซอร์ คลิกที่ตัวน้องเพื่อคุย บทพูดเตรียมไว้ใน LOGIN_SCRIPT (ไม่เรียก AI)
 */
export { stepFly, poseOf } from './mascot/mascot-motion';
export type { FlyState } from './mascot/mascot-motion';

@Component({
  selector: 'app-login-mascot',
  standalone: true,
  imports: [MascotStageComponent],
  template: `<app-mascot-stage [script]="script" [tips]="tips" [avoid]="avoid" [voice]="voice" [sizeDefault]="size" greetKey="kpi_mascot_greeted_login"
    [ctx]="{ thaid: thaid, providerid: providerid }"></app-mascot-stage>`,
})
export class LoginMascotComponent {
  /** ตัวเลือก CSS ของกล่องที่ห้ามบัง */
  @Input() avoid = '[data-login-card]';
  @Input() thaid = false;
  @Input() providerid = false;
  /** เสียงพูด (ค่าระบบ mascot_voice_enabled) */
  @Input() voice = true;
  /** ขนาดตั้งต้นของระบบ (mascot_size) */
  @Input() size: MascotSize = 'medium';
  script = LOGIN_SCRIPT;
  tips = LOGIN_TIPS;
}
