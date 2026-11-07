// แผง "สรุปโดย AI" (7 พ.ย. 2569) — หน้ากราฟและสถิติ: สรุปผลตามตัวกรองปัจจุบัน (POST /report/ai-summary)
// แสดงเฉพาะเมื่อผู้ดูแลเปิดผู้ช่วย AI — ผลเป็นข้อความล้วน (ไม่ใช้ innerHTML) พร้อมป้ายเตือนให้ตรวจสอบ
import { Component, Input, OnChanges, OnInit, SimpleChanges, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth';

// แบ่งข้อความสรุปเป็นบรรทัดสำหรับแสดงผล: ■ = หัวข้อ, • = รายการย่อย
export function summaryLines(text: string): { kind: 'head' | 'item' | 'text'; text: string }[] {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    if (l.startsWith('■')) return { kind: 'head' as const, text: l.replace(/^■\s*/, '') };
    if (/^[•\-*]\s+/.test(l)) return { kind: 'item' as const, text: l.replace(/^[•\-*]\s+/, '') };
    return { kind: 'text' as const, text: l.replace(/\*\*/g, '') };
  });
}

@Component({
  selector: 'app-ai-summary-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
  <div *ngIf="enabled" class="mb-6 rounded-2xl border border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 to-white shadow-sm p-4">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <h3 class="text-sm font-bold text-fuchsia-800"><i class="fas fa-wand-magic-sparkles me-1"></i>สรุปโดย AI</h3>
      <div class="flex gap-2">
        <button type="button" (click)="generate(!!summary)" [disabled]="loading"
                class="px-3 py-1.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-xs font-bold shadow-md disabled:opacity-50">
          <i class="fas" [ngClass]="loading ? 'fa-spinner fa-spin' : (summary ? 'fa-rotate' : 'fa-wand-magic-sparkles')"></i>
          {{ loading ? 'กำลังสรุป...' : (summary ? 'สรุปใหม่' : 'สร้างสรุป') }}
        </button>
        <button *ngIf="summary" type="button" (click)="copy()"
                class="px-3 py-1.5 rounded-xl bg-white border border-fuchsia-300 text-fuchsia-700 hover:bg-fuchsia-50 text-xs font-bold">
          <i class="fas" [ngClass]="copied ? 'fa-check' : 'fa-copy'"></i> {{ copied ? 'คัดลอกแล้ว' : 'คัดลอก' }}
        </button>
      </div>
    </div>
    <p *ngIf="!summary && !loading && !error" class="text-xs text-gray-500 mt-2">
      กด "สร้างสรุป" เพื่อให้ AI สรุปตัวเลขตามตัวกรองที่เลือกเป็นข้อความสำหรับรายงานผู้บริหาร (ใช้เฉพาะตัวเลขรวมตามสิทธิ์ของคุณ)
    </p>
    <div *ngIf="error" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"><i class="fas fa-triangle-exclamation me-1"></i>{{ error }}</div>
    <div *ngIf="summary" class="mt-3 text-sm text-gray-800 space-y-1">
      <ng-container *ngFor="let l of lines">
        <p *ngIf="l.kind === 'head'" class="font-bold text-fuchsia-900 pt-2">{{ l.text }}</p>
        <p *ngIf="l.kind === 'item'" class="ps-4 relative"><span class="absolute start-0 text-fuchsia-500">•</span>{{ l.text }}</p>
        <p *ngIf="l.kind === 'text'">{{ l.text }}</p>
      </ng-container>
      <p class="pt-2 text-[11px] text-gray-500 border-t border-fuchsia-100 mt-3">
        <i class="fas fa-robot me-1"></i>ข้อความจาก AI — โปรดตรวจสอบกับตัวเลขในหน้านี้ก่อนนำไปใช้
        · รุ่น {{ model }} · {{ generatedAt | date:'d/M/yyyy HH:mm' }}{{ cached ? ' (ผลที่สร้างไว้แล้ว)' : '' }}
      </p>
    </div>
  </div>`,
})
export class AiSummaryPanelComponent implements OnInit, OnChanges {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  /** ตัวกรองเดียวกับที่ใช้โหลดหน้ากราฟ (buildParams ของ ChartComponent) */
  @Input() params: any = {};

  enabled = false;
  loading = false;
  summary = '';
  lines: ReturnType<typeof summaryLines> = [];
  model = '';
  generatedAt = '';
  cached = false;
  error = '';
  copied = false;

  ngOnInit() {
    this.authService.getAiStatus().subscribe(res => { this.enabled = !!res?.enabled; this.cdr.detectChanges(); });
  }

  // ตัวกรองเปลี่ยน = สรุปเดิมไม่ตรงกับตัวเลขบนหน้าแล้ว — ล้างทิ้ง
  ngOnChanges(changes: SimpleChanges) {
    if (changes['params'] && !changes['params'].firstChange) this.reset();
  }

  reset() {
    this.summary = ''; this.lines = []; this.error = ''; this.copied = false;
  }

  generate(refresh = false) {
    this.loading = true;
    this.error = '';
    this.authService.getAiReportSummary(this.params || {}, refresh).subscribe({
      next: (res) => {
        this.loading = false;
        this.summary = res?.summary || '';
        this.lines = summaryLines(this.summary);
        this.model = res?.model || '';
        this.generatedAt = res?.generated_at || '';
        this.cached = !!res?.cached;
        this.copied = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.loading = false;
        this.error = err.error?.message || 'สร้างสรุปด้วย AI ไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }

  copy() {
    navigator.clipboard?.writeText(this.summary).then(() => { this.copied = true; this.cdr.detectChanges(); }).catch(() => {});
  }
}
