import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

// ป้ายสูตรคำนวณผลงาน (ไอคอนเครื่องคิดเลข + ตัวสูตร) — ใช้ต่อท้ายชื่อตัวชี้วัดในทุกหน้าที่มีรายชื่อตัวชี้วัด
// ไม่มีสูตร (null/ว่าง) = ไม่แสดงอะไรเลย
@Component({
  selector: 'app-formula-badge',
  standalone: true,
  imports: [CommonModule],
  template: `<span *ngIf="text" class="inline-flex items-center gap-1 max-w-full align-middle px-1.5 py-0.5 rounded bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200 text-[10px] font-mono font-normal leading-tight whitespace-nowrap"
      [title]="'ผลงานคำนวณตามสูตร: ' + text"><i class="fas fa-calculator text-[9px] shrink-0"></i><span class="truncate" [style.max-width]="maxWidth">{{ text }}</span></span>`
})
export class FormulaBadgeComponent {
  @Input() formula: any = null;
  @Input() maxWidth = '240px';

  get text(): string {
    return String(this.formula ?? '').trim();
  }
}
