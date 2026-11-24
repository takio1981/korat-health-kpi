import { Component, Input } from '@angular/core';

/**
 * ป้ายรูปน้องคิดดี — ตัวแทนของผู้ช่วย AI ในหัวแผง AI ทุกแผง (19 พ.ย. 2569 ระยะที่ 3)
 * ใช้ภาพเต็มตัวเดียวกับตัวละคร ตัดเฉพาะส่วนหัว (object-position) ไม่มีไฟล์ภาพเพิ่ม
 */
@Component({
  selector: 'app-mascot-avatar',
  standalone: true,
  template: `<img src="mascot/korat-d-fly.webp" alt="น้องคิดดี" title="น้องคิดดี — ผู้ช่วย AI" draggable="false"
    class="inline-block align-middle rounded-full object-cover bg-teal-50 ring-2 ring-white shadow-sm"
    [style.width.px]="size" [style.height.px]="size" style="object-position: 50% 4%; vertical-align: -0.3em;">`,
  host: { class: 'inline-block me-1' },
})
export class MascotAvatarComponent {
  @Input() size = 22;
}
