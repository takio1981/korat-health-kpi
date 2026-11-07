// "ให้ AI ช่วยเขียนสูตร" (ผู้ช่วย AI ระยะที่ 2 — 7 พ.ย. 2569) — ใช้ในกล่องสูตรผลงานและสูตรร้อยละของหน้าจัดการตัวชี้วัด
// AI เสนอสูตรที่ผ่านตัวตรวจของระบบแล้ว → ผู้ใช้กด "ใช้สูตรนี้" ใส่ลงช่องสูตร → เห็นผลตรวจ/ทดลองคำนวณเดิมก่อนกดบันทึกตัวชี้วัดเอง
// แสดงเฉพาะเมื่อผู้ดูแลเปิดผู้ช่วย AI
import { Component, EventEmitter, Input, OnInit, Output, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';

@Component({
  selector: 'app-ai-formula-helper',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div *ngIf="enabled" class="mt-2">
    <button *ngIf="!open" type="button" (click)="open = true"
            class="text-[11px] px-2 py-1 rounded-lg bg-fuchsia-50 border border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-100 font-bold">
      <i class="fas fa-wand-magic-sparkles mr-1"></i>ให้ AI ช่วยเขียนสูตร
    </button>
    <div *ngIf="open" class="rounded-lg border border-fuchsia-200 bg-white p-2.5">
      <label class="block text-[11px] font-bold text-fuchsia-800 mb-1"><i class="fas fa-wand-magic-sparkles mr-1"></i>อธิบายวิธีคำนวณเป็นภาษาไทย</label>
      <textarea [(ngModel)]="description" [ngModelOptions]="{ standalone: true }" rows="2" maxlength="500"
                [placeholder]="kind === 'pct' ? 'เช่น ร้อยละของผลงานเทียบกับประชากรกลางปี' : 'เช่น ร้อยละการลดลงของผู้เสียชีวิตเทียบค่าเฉลี่ย 5 ปี'"
                class="w-full px-2 py-1.5 border rounded-lg outline-none focus:ring-2 focus:ring-fuchsia-300 text-xs"></textarea>
      <div class="flex gap-2 mt-1">
        <button type="button" (click)="suggest()" [disabled]="loading || description.trim().length < 5"
                class="text-[11px] px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white font-bold disabled:opacity-50">
          <i class="fas" [ngClass]="loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> {{ loading ? 'กำลังคิดสูตร...' : 'เสนอสูตร' }}
        </button>
        <button type="button" (click)="close()" class="text-[11px] px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold">ปิด</button>
      </div>
      <div *ngIf="error" class="mt-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded p-1.5"><i class="fas fa-triangle-exclamation mr-1"></i>{{ error }}</div>
      <div *ngIf="formula" class="mt-2 rounded border border-fuchsia-100 bg-fuchsia-50/60 p-2">
        <div class="font-mono text-sm text-fuchsia-900 break-all">{{ formula }}</div>
        <div *ngIf="explanation" class="text-[11px] text-gray-700 mt-1">{{ explanation }}</div>
        <div class="flex items-center gap-2 mt-1.5 flex-wrap">
          <button type="button" (click)="use()" class="text-[11px] px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold">
            <i class="fas fa-check mr-1"></i>ใช้สูตรนี้
          </button>
          <span class="text-[10px] text-gray-500"><i class="fas fa-robot mr-1"></i>ข้อความจาก AI — ระบบตรวจไวยากรณ์แล้ว โปรดตรวจความหมายและทดลองคำนวณก่อนบันทึก</span>
        </div>
      </div>
    </div>
  </div>`,
})
export class AiFormulaHelperComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  @Input() kind: 'result' | 'pct' = 'result';
  @Input() customVars: { key: string; label: string }[] = [];
  @Input() targetCondition = '';
  @Input() indicatorName = '';
  @Output() apply = new EventEmitter<string>();

  enabled = false;
  open = false;
  loading = false;
  description = '';
  formula = '';
  explanation = '';
  error = '';

  ngOnInit() {
    this.authService.getAiStatus().subscribe(res => { this.enabled = !!res?.enabled; this.cdr.detectChanges(); });
  }

  suggest() {
    this.loading = true;
    this.error = '';
    this.formula = '';
    const custom_vars = (this.customVars || []).filter(v => String(v?.key || '').trim());
    this.authService.suggestAiFormula({ description: this.description.trim(), kind: this.kind, custom_vars, target_condition: this.targetCondition || '', indicator_name: this.indicatorName || '' }).subscribe({
      next: (res) => {
        this.loading = false;
        this.formula = res?.formula || '';
        this.explanation = res?.explanation || '';
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.loading = false;
        this.error = err.error?.message || 'AI ช่วยเขียนสูตรไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }

  use() {
    this.apply.emit(this.formula);
    this.close();
  }

  close() {
    this.open = false;
    this.formula = '';
    this.explanation = '';
    this.error = '';
  }
}
