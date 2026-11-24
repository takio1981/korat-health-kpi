// <app-festival-backdrop> ลายน้ำพื้นหลังตามเทศกาล (24 พ.ย. 2569) — ใช้เทศกาลเดียวกับชุดของน้องคิดดีเสมอ
// (MascotService.outfit$: auto | none | id + วันที่ที่ผู้ดูแลตั้ง/ดึงอัตโนมัติ, outfitPreview$ = ลองชุดในหน้าตั้งค่า)
// วางเป็นชั้นแรกของพื้นหลังใน layout.html และ login.html (absolute inset-0, pointer-events none — ไม่บังการคลิก)
// ตรวจวันที่ใหม่ทุก 1 นาทีนอก Angular zone (ข้ามเที่ยงคืนแล้วเปลี่ยนลายเอง) | ปิดได้ที่หน้าตั้งค่าระบบ (#festival-backdrop-enabled)
import { Component, OnDestroy, OnInit, ChangeDetectorRef, NgZone, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { MascotService } from './mascot/mascot.service';
import { activeFestival, thaiDateKey } from './mascot/mascot-festival';
import { backdropStyle } from './festival-backdrop-theme';

@Component({
  selector: 'app-festival-backdrop',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'absolute inset-0 pointer-events-none overflow-hidden', 'aria-hidden': 'true' },
  template: `<div *ngIf="layerStyle" class="fb-layer" [ngStyle]="layerStyle" [attr.data-festival]="festivalId"></div>`,
  styles: [`
    .fb-layer { position: absolute; inset: 0; opacity: .14; }
    /* โหมดมืด: ลวดลายสีเข้มบนพื้นมืดมองไม่เห็น → สว่างขึ้น (ตรวจด้วยภาพตัวอย่างทั้ง 2 โหมด) */
    :host-context(.dark) .fb-layer { opacity: .16; filter: brightness(2.2) saturate(.8); }
    @media print { .fb-layer { display: none; } }
  `],
})
export class FestivalBackdropComponent implements OnInit, OnDestroy {
  private mascot = inject(MascotService);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);
  private sub = new Subscription();
  private timer: any = null;
  festivalId: string | null = null;
  layerStyle: { [k: string]: string } | null = null;

  ngOnInit() {
    this.sub.add(this.mascot.outfit$.subscribe(() => this.refresh()));
    this.sub.add(this.mascot.outfitPreview$.subscribe(() => this.refresh()));
    this.sub.add(this.mascot.backdropOn$.subscribe(() => this.refresh()));
    this.zone.runOutsideAngular(() => { this.timer = setInterval(() => this.zone.run(() => this.refresh()), 60000); });
  }
  ngOnDestroy() { this.sub.unsubscribe(); if (this.timer) clearInterval(this.timer); }

  /** เทศกาลที่ควรแสดงตอนนี้ — ลองชุด (หน้าตั้งค่า) มาก่อน แล้วจึงค่าระบบ (กติกาเดียวกับ mascot-stage wantedFestival) */
  refresh() {
    const cfg = this.mascot.outfit$.value, pv = this.mascot.outfitPreview$.value;
    const f = this.mascot.backdropOn$.value ? activeFestival(pv ?? cfg.mode, thaiDateKey(), cfg.dates, this.mascot.outfitExtra(cfg)) : null;
    const id = f?.id || null;
    if (id === this.festivalId && (this.layerStyle !== null) === (id !== null)) return;
    this.festivalId = id;
    this.layerStyle = backdropStyle(id);
    this.cdr.markForCheck();
  }
}
