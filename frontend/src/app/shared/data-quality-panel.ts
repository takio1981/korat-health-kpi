// แผง "ตรวจคุณภาพข้อมูล" (ผู้ช่วย AI ระยะที่ 5 — 8 พ.ย. 2569) — หน้าจัดการข้อมูลผลงานตัวชี้วัด (super_admin)
// ตรวจแบบกฎทั้งปีงบ (GET /kpi-results/manage/data-quality — ไม่ใช้ AI) แล้วให้ AI สรุปรูปแบบ/สาเหตุที่เป็นไปได้/สิ่งที่ควรตรวจ (POST /ai/data-quality-explain)
// อ่านอย่างเดียว ไม่แก้ข้อมูล — ข้อความจาก AI แสดงเป็นข้อความล้วน (ไม่ใช้ innerHTML) พร้อมป้ายเตือนให้ตรวจสอบ
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import { getCurrentFiscalYear } from './fiscal-year.util';
import { summaryLines } from './ai-summary-panel';
import { ZoneBadgeComponent } from './zone-badge';
import { FormulaBadgeComponent } from './formula-badge';

export const DQ_KINDS: { key: string; label: string; cls: string }[] = [
  { key: 'negative', label: 'ค่าติดลบ', cls: 'bg-red-100 text-red-800 border-red-200' },
  { key: 'high', label: 'สูงผิดปกติ', cls: 'bg-orange-100 text-orange-800 border-orange-200' },
  { key: 'low', label: 'ต่ำผิดปกติ', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'text', label: 'ข้อความในตัวชี้วัดตัวเลข', cls: 'bg-sky-100 text-sky-800 border-sky-200' },
  { key: 'pct_over', label: 'ร้อยละเกิน 100', cls: 'bg-violet-100 text-violet-800 border-violet-200' },
];
export const DQ_PAGE = 50;

/** กรองรายการตามประเภท ('' = ทุกประเภท) */
export function filterIssues(issues: any[], kind: string): any[] {
  return kind ? (issues || []).filter(i => i.kind === kind) : (issues || []);
}

@Component({
  selector: 'app-data-quality-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, ZoneBadgeComponent, FormulaBadgeComponent],
  template: `
  <div class="p-4 md:p-6 border-b border-gray-100" id="data-quality-panel">
    <div class="flex items-center gap-2 flex-wrap">
      <h5 class="text-sm font-bold text-gray-800 me-2"><i class="fas fa-stethoscope text-teal-600 me-1"></i>ตรวจคุณภาพข้อมูล</h5>
      <select [(ngModel)]="yearBh" name="dqYear" class="px-3 py-1.5 border border-gray-200 rounded-xl text-sm bg-white">
        <option *ngFor="let y of yearOptions" [value]="y">ปีงบ {{ y }}</option>
      </select>
      <button type="button" (click)="scan()" [disabled]="loading" id="btn-dq-scan"
              class="px-3 py-1.5 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold shadow-md disabled:opacity-50">
        <i class="fas" [ngClass]="loading ? 'fa-spinner fa-spin' : 'fa-magnifying-glass-chart'"></i> {{ loading ? 'กำลังตรวจ...' : 'ตรวจคุณภาพข้อมูล' }}
      </button>
      <button *ngIf="result && result.total > 0 && aiEnabled" type="button" (click)="explain(!!summary)" [disabled]="aiLoading" id="btn-dq-ai"
              class="px-3 py-1.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs font-bold shadow-md disabled:opacity-50">
        <i class="fas" [ngClass]="aiLoading ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'"></i>
        {{ aiLoading ? 'AI กำลังสรุป...' : (summary ? 'ให้ AI สรุปใหม่' : 'ให้ AI สรุปและอธิบาย') }}
      </button>
    </div>
    <p *ngIf="!result && !loading && !error" class="text-xs text-gray-500 mt-2">
      ตรวจผลงานที่บันทึกแล้วทั้งปีงบด้วยกฎของระบบ: ค่าติดลบ, ค่าที่ต่างจากเดือนอื่น/ปีงบที่แล้ว/เป้าหมายมากผิดปกติ (≥ 5 เท่า), ข้อความในตัวชี้วัดที่ผลงานส่วนใหญ่เป็นตัวเลข
      และตัวชี้วัดร้อยละที่ผลงานเกิน 100 — อ่านอย่างเดียว ไม่แก้ข้อมูล
    </p>
    <div *ngIf="error" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"><i class="fas fa-triangle-exclamation me-1"></i>{{ error }}</div>

    <ng-container *ngIf="result">
      <p class="text-xs text-gray-600 mt-3">
        ปีงบ {{ result.year_bh }}: ตรวจ {{ result.scanned.cells | number }} ช่องผลงาน ({{ result.scanned.indicators | number }} ตัวชี้วัด, {{ result.scanned.pairs | number }} คู่ตัวชี้วัด×หน่วยบริการ)
        — <b [ngClass]="result.total ? 'text-red-700' : 'text-emerald-700'">{{ result.total ? ('พบที่ควรตรวจสอบ ' + (result.total | number) + ' ช่อง') : 'ไม่พบค่าที่อาจผิดปกติ' }}</b>
      </p>
      <div *ngIf="result.total" class="flex gap-2 flex-wrap mt-2">
        <button type="button" (click)="setKind('')" class="px-2.5 py-1 rounded-full border text-xs font-bold"
                [ngClass]="kind === '' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-700 border-gray-200'">ทั้งหมด {{ result.total | number }}</button>
        <ng-container *ngFor="let k of kinds">
          <button *ngIf="result.counts[k.key]" type="button" (click)="setKind(k.key)" class="px-2.5 py-1 rounded-full border text-xs font-bold"
                  [ngClass]="kind === k.key ? 'ring-2 ring-offset-1 ring-gray-400 ' + k.cls : k.cls">{{ k.label }} {{ result.counts[k.key] | number }}</button>
        </ng-container>
      </div>

      <!-- สรุปโดย AI -->
      <div *ngIf="summary || aiError" class="mt-3 rounded-2xl border border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 to-white p-4">
        <h6 class="text-sm font-bold text-fuchsia-800"><i class="fas fa-wand-magic-sparkles me-1"></i>สรุปโดย AI</h6>
        <div *ngIf="aiError" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"><i class="fas fa-triangle-exclamation me-1"></i>{{ aiError }}</div>
        <div *ngIf="summary" class="mt-2 text-sm text-gray-800 space-y-1">
          <ng-container *ngFor="let l of lines">
            <p *ngIf="l.kind === 'head'" class="font-bold text-fuchsia-900 pt-2">{{ l.text }}</p>
            <p *ngIf="l.kind === 'item'" class="ps-4 relative"><span class="absolute start-0 text-fuchsia-500">•</span>{{ l.text }}</p>
            <p *ngIf="l.kind === 'text'">{{ l.text }}</p>
          </ng-container>
          <p class="pt-2 text-[11px] text-gray-500 border-t border-fuchsia-100 mt-3">
            <i class="fas fa-robot me-1"></i>ข้อความจาก AI — สรุปจากผลตรวจแบบกฎ (ไม่ได้ยืนยันว่าค่าผิดจริง) โปรดตรวจกับรายการด้านล่างและเอกสารต้นทาง
            · รุ่น {{ model }}{{ cached ? ' (ผลที่สร้างไว้แล้ว)' : '' }}
          </p>
        </div>
      </div>

      <div *ngIf="result.total" class="mt-3 overflow-auto card-scroll rounded-xl border border-gray-100" style="max-height: 50vh">
        <table class="w-full text-xs">
          <thead class="bg-gray-100 text-gray-600 sticky top-0 z-20">
            <tr>
              <th class="px-2 py-2 text-left">ประเภท</th>
              <th class="px-2 py-2 text-left">ตัวชี้วัด</th>
              <th class="px-2 py-2 text-left">หน่วยบริการ</th>
              <th class="px-2 py-2 text-center">เดือน</th>
              <th class="px-2 py-2 text-right">ค่า</th>
              <th class="px-2 py-2 text-left">เหตุผล</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let i of pageItems" class="border-t border-gray-100 align-top">
              <td class="px-2 py-1.5"><span class="px-2 py-0.5 rounded-full border whitespace-nowrap" [ngClass]="kindCls(i.kind)">{{ i.kind_label }}</span></td>
              <td class="px-2 py-1.5">{{ i.indicator_name }} <app-formula-badge [formula]="i.result_formula"></app-formula-badge>
                <div *ngIf="i.dept_name" class="text-[10px] text-gray-400">{{ i.dept_name }}</div></td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ i.hosname || i.hospcode }} <app-zone-badge [hospcode]="i.hospcode"></app-zone-badge></td>
              <td class="px-2 py-1.5 text-center">{{ i.month_name }}</td>
              <td class="px-2 py-1.5 text-right font-bold text-red-700">{{ i.value }}</td>
              <td class="px-2 py-1.5 text-gray-600">{{ i.message }}
                <div *ngFor="let h of i.hints" class="text-[11px] text-teal-700 mt-0.5"><i class="fas fa-calculator me-1"></i>{{ h }}</div></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div *ngIf="filtered.length > shownCount || result.truncated" class="mt-2 flex items-center gap-2 text-xs text-gray-500">
        <span>แสดง {{ pageItems.length | number }} จาก {{ filtered.length | number }} รายการ{{ result.truncated ? ' (ระบบส่งรายการ ' + (result.issues.length | number) + ' รายการแรกจาก ' + (result.total | number) + ')' : '' }}</span>
        <button *ngIf="filtered.length > shownCount" type="button" (click)="shownCount = shownCount + pageSize" class="px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 font-bold">แสดงเพิ่ม</button>
      </div>
    </ng-container>
  </div>`,
})
export class DataQualityPanelComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  readonly kinds = DQ_KINDS;
  readonly pageSize = DQ_PAGE;
  readonly yearOptions: string[] = (() => { const fy = getCurrentFiscalYear(); return [String(fy + 1), String(fy), String(fy - 1), String(fy - 2)]; })();
  yearBh = String(getCurrentFiscalYear());

  aiEnabled = false;
  loading = false;
  error = '';
  result: any = null;
  kind = '';
  shownCount = DQ_PAGE;

  aiLoading = false;
  aiError = '';
  summary = '';
  lines: ReturnType<typeof summaryLines> = [];
  model = '';
  cached = false;

  get filtered(): any[] { return filterIssues(this.result?.issues, this.kind); }
  get pageItems(): any[] { return this.filtered.slice(0, this.shownCount); }
  kindCls(k: string): string { return DQ_KINDS.find(x => x.key === k)?.cls || 'bg-gray-100 text-gray-700 border-gray-200'; }

  ngOnInit() {
    this.authService.getAiStatus().subscribe((res: any) => { this.aiEnabled = !!res?.enabled; this.cdr.detectChanges(); });
  }

  setKind(k: string) { this.kind = k; this.shownCount = DQ_PAGE; }

  scan() {
    this.loading = true;
    this.error = '';
    this.summary = ''; this.lines = []; this.aiError = '';
    this.authService.getDataQuality(this.yearBh).subscribe({
      next: (res: any) => {
        this.loading = false;
        this.result = res?.success ? res : null;
        this.kind = '';
        this.shownCount = DQ_PAGE;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.loading = false;
        this.result = null;
        this.error = err.error?.message || 'ตรวจคุณภาพข้อมูลไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }

  explain(refresh = false) {
    if (!this.result) return;
    this.aiLoading = true;
    this.aiError = '';
    this.authService.explainDataQuality(this.result.year_bh, refresh).subscribe({
      next: (res: any) => {
        this.aiLoading = false;
        this.summary = res?.summary || '';
        this.lines = summaryLines(this.summary);
        this.model = res?.model || '';
        this.cached = !!res?.cached;
        if (res?.no_issues) this.aiError = 'ไม่พบค่าที่อาจผิดปกติแล้ว — ลองกด "ตรวจคุณภาพข้อมูล" ใหม่';
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.aiLoading = false;
        this.aiError = err.error?.message || 'AI สรุปผลตรวจคุณภาพข้อมูลไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }
}
