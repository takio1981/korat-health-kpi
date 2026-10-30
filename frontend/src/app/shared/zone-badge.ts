import { Component, Injectable, Input, OnChanges, OnDestroy, OnInit, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BehaviorSubject, Subscription } from 'rxjs';
import { AuthService } from '../services/auth';

/**
 * ตาราง รหัสหน่วยบริการ → โซน (GET /hospital-zones) โหลดครั้งเดียวต่อการเข้าใช้ แล้วแชร์ให้ป้ายโซนทุกหน้า
 * โหลดไม่สำเร็จ = ลองใหม่ได้เมื่อมีป้ายถูกสร้างครั้งถัดไป (ไม่แสดงป้ายระหว่างนั้น)
 */
@Injectable({ providedIn: 'root' })
export class HospitalZoneService {
  private authService = inject(AuthService);
  private loading = false;
  private loaded = false;
  readonly zones$ = new BehaviorSubject<Record<string, string>>({});

  load() {
    if (this.loaded || this.loading || !localStorage.getItem('kpi_token')) return;
    this.loading = true;
    this.authService.getHospitalZones().subscribe({
      next: (res: any) => {
        this.loading = false;
        if (res?.success) { this.loaded = true; this.zones$.next(res.data || {}); }
      },
      error: () => { this.loading = false; }
    });
  }

  zoneOf(hospcode: any): string {
    return this.zones$.value[String(hospcode ?? '').trim()] || '';
  }
}

/** ป้าย "โซน N" ต่อท้ายชื่อหน่วยบริการ — ระบุ [zone] ตรงๆ ได้ (เช่นแถวจาก /hospitals) ไม่งั้นหาจาก [hospcode] */
@Component({
  selector: 'app-zone-badge',
  standalone: true,
  imports: [CommonModule],
  template: `<span *ngIf="value" class="inline-flex items-center px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 border border-violet-200 text-[10px] font-bold whitespace-nowrap align-middle shrink-0"
    [title]="'โซน ' + value"><i class="fas fa-layer-group mr-1 text-[9px]"></i>โซน {{ value }}</span>`
})
export class ZoneBadgeComponent implements OnInit, OnChanges, OnDestroy {
  @Input() hospcode: any = '';
  @Input() zone: any = '';
  value = '';
  private svc = inject(HospitalZoneService);
  private cdr = inject(ChangeDetectorRef);
  private sub?: Subscription;

  ngOnInit() {
    this.sub = this.svc.zones$.subscribe(() => {
      const before = this.value;
      this.resolve();
      if (this.value !== before) this.cdr.markForCheck();
    });
    if (!String(this.zone ?? '').trim()) this.svc.load();
  }

  ngOnChanges() { this.resolve(); }

  ngOnDestroy() { this.sub?.unsubscribe(); }

  private resolve() {
    const z = String(this.zone ?? '').trim();
    this.value = z || this.svc.zoneOf(this.hospcode);
  }
}
