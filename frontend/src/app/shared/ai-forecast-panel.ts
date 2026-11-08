// แผง "AI อธิบายตัวชี้วัดเสี่ยง" (ระบบเตือนล่วงหน้า ระยะที่ 4 — 8 พ.ย. 2569) ในแท็บตัวชี้วัดเสี่ยง
// ส่งเฉพาะปีงบ/เดือน/ตัวกรอง — server คำนวณรายการเสี่ยงใหม่ตามขอบเขตสิทธิ์เอง (POST /report/forecast/ai-explain)
// ระดับความเสี่ยงคำนวณด้วยวิธีทางสถิติ AI อธิบายเท่านั้น — ข้อความล้วน (ไม่ใช้ innerHTML) + ป้ายเตือนให้ตรวจสอบ
import { Component, Input, OnChanges, OnInit, SimpleChanges, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth';
import { summaryLines } from './ai-summary-panel';

@Component({
  selector: 'app-ai-forecast-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
  <div *ngIf="enabled" class="rounded-2xl border border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 to-white shadow-sm p-4" id="ai-forecast-panel">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <h4 class="text-sm font-bold text-fuchsia-800"><i class="fas fa-wand-magic-sparkles me-1"></i>AI อธิบายตัวชี้วัดเสี่ยง</h4>
      <button type="button" (click)="generate(!!summary)" [disabled]="loading" id="btn-ai-forecast"
              class="px-3 py-1.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs font-bold shadow-md disabled:opacity-50">
        <i class="fas" [ngClass]="loading ? 'fa-spinner fa-spin' : (summary ? 'fa-rotate' : 'fa-wand-magic-sparkles')"></i>
        {{ loading ? 'กำลังเรียบเรียง...' : (summary ? 'อธิบายใหม่' : 'ให้ AI อธิบาย') }}
      </button>
    </div>
    <p *ngIf="!summary && !loading && !error && !noRisk" class="text-xs text-gray-500 mt-2">
      ให้ AI เรียบเรียงรายการเสี่ยงตามตัวกรองที่เลือกเป็นคำอธิบายภาษาไทย (ตัวชี้วัดที่ควรเร่งรัด พื้นที่ที่ควรติดตาม การรายงานข้อมูล ข้อเสนอแนะ) — ส่งเฉพาะจำนวนและชื่อตัวชี้วัด/อำเภอ ไม่ส่งรายชื่อหน่วยบริการ
    </p>
    <p *ngIf="noRisk" class="text-xs text-emerald-700 mt-2">ไม่มีรายการเสี่ยงตามตัวกรองนี้ — ไม่ต้องให้ AI อธิบาย</p>
    <div *ngIf="error" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"><i class="fas fa-triangle-exclamation me-1"></i>{{ error }}</div>
    <div *ngIf="summary" class="mt-3 text-sm text-gray-800 space-y-1">
      <ng-container *ngFor="let l of lines">
        <p *ngIf="l.kind === 'head'" class="font-bold text-fuchsia-900 pt-2">{{ l.text }}</p>
        <p *ngIf="l.kind === 'item'" class="ps-4 relative"><span class="absolute start-0 text-fuchsia-500">•</span>{{ l.text }}</p>
        <p *ngIf="l.kind === 'text'">{{ l.text }}</p>
      </ng-container>
      <p class="pt-2 text-[11px] text-gray-500 border-t border-fuchsia-100 mt-3">
        <i class="fas fa-robot me-1"></i>ข้อความจาก AI — อธิบายจากผลคาดการณ์เชิงสถิติ (ไม่ใช่ผลการประเมิน) โปรดตรวจกับตารางในหน้านี้ก่อนนำไปใช้ · รุ่น {{ model }}{{ cached ? ' (ผลที่สร้างไว้แล้ว)' : '' }}
      </p>
    </div>
  </div>`,
})
export class AiForecastPanelComponent implements OnInit, OnChanges {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  /** { year_bh, through?, status?, yut?, dept?, zone?, district? } — เปลี่ยน = ล้างคำอธิบายเดิม */
  @Input() params: any = {};

  enabled = false;
  loading = false;
  summary = '';
  lines: ReturnType<typeof summaryLines> = [];
  model = '';
  cached = false;
  error = '';
  noRisk = false;
  private lastKey = '';

  ngOnInit() {
    this.authService.getAiStatus().subscribe((res: any) => { this.enabled = !!res?.enabled; this.cdr.detectChanges(); });
  }

  ngOnChanges(changes: SimpleChanges) {
    // getter ของหน้าแม่สร้าง object ใหม่ทุกรอบ — ล้างเฉพาะเมื่อค่าเปลี่ยนจริง
    const key = JSON.stringify(this.params || {});
    if (changes['params'] && key !== this.lastKey) {
      if (this.lastKey) { this.summary = ''; this.lines = []; this.error = ''; this.noRisk = false; }
      this.lastKey = key;
    }
  }

  generate(refresh = false) {
    this.loading = true;
    this.error = '';
    this.noRisk = false;
    this.authService.apiPost('/report/forecast/ai-explain', { ...(this.params || {}), refresh }).subscribe({
      next: (res: any) => {
        this.loading = false;
        this.noRisk = !!res?.no_risk;
        this.summary = res?.summary || '';
        this.lines = summaryLines(this.summary);
        this.model = res?.model || '';
        this.cached = !!res?.cached;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.loading = false;
        this.error = err.error?.message || 'AI อธิบายตัวชี้วัดเสี่ยงไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }
}
