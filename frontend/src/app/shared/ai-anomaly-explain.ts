// หน้าต่าง "AI อธิบายค่าที่อาจผิดปกติ" (ผู้ช่วย AI ระยะที่ 5 — 8 พ.ย. 2569) — หน้าบันทึกผลงาน โหมดแก้ไข
// ส่งค่ารายเดือนของแถวที่ถูกเตือน (ยังไม่บันทึก) ให้ POST /ai/anomaly-explain — server คำนวณคำเตือนใหม่เองและไม่ส่งรหัสหน่วยบริการเข้า prompt
// เตือนเท่านั้น ไม่แก้ค่า ไม่ห้ามบันทึก — ผลเป็นข้อความล้วน (ไม่ใช้ innerHTML) พร้อมป้ายเตือนให้ตรวจสอบ
import { Component, EventEmitter, Input, OnInit, Output, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth';
import { ZoneBadgeComponent } from './zone-badge';
import { EXCEL_MONTHS } from './kpi-excel';

export const AI_ANOMALY_MAX = 20; // เท่ากับ MAX_ANOMALY_ITEMS ของ backend

export interface AnomalyExplainRow {
  indicatorName: string;
  hosname: string;
  hospcode: string;
  monthName: string;
  value: string;
  message: string;          // คำเตือนของหน้าจอ (แสดงผลเท่านั้น — server คำนวณใหม่เอง)
  payload: { indicator_id: number; month: string; months: Record<string, string>; target: string; prev?: Record<string, string> };
  aiText?: string;
  hints?: string[];         // ข้อสังเกตที่ server คำนวณได้แน่นอน (เช่น เท่ากับผลรวมของเดือนก่อนหน้า)
  aiDone?: boolean;
}

/** ข้อมูลที่ส่งให้ server ของ 1 ช่องที่ถูกเตือน: ค่าทุกเดือนของแถว (รวมค่าที่ยังไม่บันทึก) + เป้าหมาย + ปีงบที่แล้ว (ถ้ามี) */
export function anomalyPayload(item: any, month: string, prev?: any): AnomalyExplainRow['payload'] {
  const pick = (src: any) => Object.fromEntries(EXCEL_MONTHS.map(m => [m.key, String(src?.[m.key] ?? '')]));
  const p: AnomalyExplainRow['payload'] = { indicator_id: Number(item.indicator_id), month, months: pick(item), target: String(item.target_value ?? '') };
  if (prev) p.prev = pick(prev);
  return p;
}

/** ใส่คำอธิบายจาก server ลงแถวตาม index (ลำดับในคำขอ) — แถวที่ไม่มีคำอธิบาย = aiDone แต่ข้อความว่าง */
export function applyExplanations(rows: AnomalyExplainRow[], explanations: any[]): AnomalyExplainRow[] {
  const byIdx = new Map<number, any>();
  for (const e of explanations || []) if (Number.isInteger(e?.index)) byIdx.set(e.index, e);
  return rows.map((r, i) => {
    const e = byIdx.get(i);
    return { ...r, aiText: String(e?.text || ''), hints: Array.isArray(e?.hints) ? e.hints.map(String) : [], aiDone: true };
  });
}

@Component({
  selector: 'app-ai-anomaly-explain',
  standalone: true,
  imports: [CommonModule, ZoneBadgeComponent],
  template: `
  <div class="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" (click)="close.emit()">
    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" (click)="$event.stopPropagation()">
      <div class="px-5 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <h3 class="text-sm font-bold text-fuchsia-800"><i class="fas fa-wand-magic-sparkles me-1"></i>AI อธิบายค่าที่อาจผิดปกติ ({{ shown.length }} ช่อง)</h3>
        <button type="button" (click)="close.emit()" class="w-8 h-8 rounded-lg hover:bg-gray-100 text-gray-500" title="ปิด"><i class="fas fa-times"></i></button>
      </div>
      <div class="p-4 overflow-y-auto card-scroll space-y-3">
        <p class="text-xs text-gray-500">
          ระบบส่งชื่อตัวชี้วัดและตัวเลขรายเดือนของช่องที่ถูกเตือนให้ AI (ไม่ส่งรหัส/ชื่อหน่วยบริการ) — คำอธิบายเป็นข้อเสนอให้ตรวจทานเท่านั้น ยังแก้ไขและบันทึกได้ตามปกติ
          <span *ngIf="rows.length > shown.length" class="text-amber-700"> · แสดง {{ shown.length }} ช่องแรกจาก {{ rows.length }} ช่อง</span>
        </p>
        <div *ngIf="error" class="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"><i class="fas fa-triangle-exclamation me-1"></i>{{ error }}</div>
        <div *ngFor="let r of shown" class="rounded-xl border border-gray-200 p-3">
          <div class="text-sm font-bold text-gray-800">{{ r.indicatorName }}</div>
          <div class="text-xs text-gray-600 mt-0.5">
            {{ r.hosname || r.hospcode }} <app-zone-badge [hospcode]="r.hospcode"></app-zone-badge>
            · {{ r.monthName }} · ค่าที่บันทึก <b class="text-red-700">{{ r.value }}</b>
          </div>
          <div class="text-xs text-red-700 mt-1"><i class="fas fa-exclamation-triangle me-1"></i>{{ r.message }}</div>
          <div *ngFor="let h of r.hints" class="text-xs text-teal-700 mt-0.5"><i class="fas fa-calculator me-1"></i>ข้อสังเกตจากระบบ: {{ h }}</div>
          <div class="mt-2 text-sm rounded-lg px-3 py-2"
               [ngClass]="r.aiText ? 'bg-fuchsia-50 border border-fuchsia-200 text-gray-800' : 'bg-gray-50 text-gray-500'">
            <ng-container *ngIf="loading && !r.aiDone"><i class="fas fa-spinner fa-spin me-1 text-fuchsia-600"></i>กำลังให้ AI อธิบาย...</ng-container>
            <ng-container *ngIf="r.aiDone && r.aiText"><i class="fas fa-robot me-1 text-fuchsia-600"></i>{{ r.aiText }}</ng-container>
            <ng-container *ngIf="r.aiDone && !r.aiText">AI ไม่ได้อธิบายช่องนี้ (ค่าอาจไม่เข้าเกณฑ์คำเตือนแล้ว)</ng-container>
            <ng-container *ngIf="!loading && !r.aiDone">—</ng-container>
          </div>
        </div>
      </div>
      <div class="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-2 flex-wrap">
        <span class="text-[11px] text-gray-500"><i class="fas fa-robot me-1"></i>ข้อความจาก AI — โปรดตรวจสอบกับเอกสารต้นทางก่อนแก้ไข<span *ngIf="model"> · รุ่น {{ model }}{{ cached ? ' (ผลที่สร้างไว้แล้ว)' : '' }}</span></span>
        <div class="flex gap-2">
          <button type="button" (click)="explain(true)" [disabled]="loading"
                  class="px-3 py-1.5 rounded-xl bg-white border border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-50 text-xs font-bold disabled:opacity-50">
            <i class="fas fa-rotate me-1"></i>อธิบายใหม่
          </button>
          <button type="button" (click)="close.emit()" class="px-3 py-1.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs font-bold shadow-md">ปิด</button>
        </div>
      </div>
    </div>
  </div>`,
})
export class AiAnomalyExplainComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  @Input() rows: AnomalyExplainRow[] = [];
  @Output() close = new EventEmitter<void>();

  shown: AnomalyExplainRow[] = [];
  loading = false;
  error = '';
  model = '';
  cached = false;

  ngOnInit() {
    this.shown = this.rows.slice(0, AI_ANOMALY_MAX);
    this.explain(false);
  }

  explain(refresh: boolean) {
    if (!this.shown.length) return;
    this.loading = true;
    this.error = '';
    this.shown = this.shown.map(r => ({ ...r, aiDone: false, aiText: '' }));
    this.authService.explainAnomalies(this.shown.map(r => r.payload), refresh).subscribe({
      next: (res) => {
        this.loading = false;
        this.shown = applyExplanations(this.shown, res?.explanations || []);
        this.model = res?.model || '';
        this.cached = !!res?.cached;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.loading = false;
        this.error = err.error?.message || 'AI อธิบายค่าที่อาจผิดปกติไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }
}
