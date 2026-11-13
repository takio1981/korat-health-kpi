// "ให้ AI ช่วยเขียนสูตร" (ผู้ช่วย AI ระยะที่ 2 — 7 พ.ย. 2569) — ใช้ในกล่องสูตรผลงานและสูตรร้อยละของหน้าจัดการตัวชี้วัด
// AI เสนอสูตรที่ผ่านตัวตรวจของระบบแล้ว → ผู้ใช้กด "ใช้สูตรนี้" ใส่ลงช่องสูตร → เห็นผลตรวจ/ทดลองคำนวณเดิมก่อนกดบันทึกตัวชี้วัดเอง
// แสดงเฉพาะเมื่อผู้ดูแลเปิดผู้ช่วย AI
// [indicator] (13 พ.ย. 2569 — ใช้กับสูตรร้อยละ): เสนอสูตรจากข้อมูลที่กรอกไว้แล้ว (เป้าหมาย เกณฑ์ เงื่อนไข วิธีคิดผลงาน) ก่อน
//   ไม่ต้องอธิบาย — AI ตอบว่าข้อมูลไม่พอ (need_more) จึงขอคำอธิบายเพิ่ม (หรือผู้ใช้กด "อธิบายเพิ่มเติม" เอง)
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
      <div *ngIf="indicator" class="mb-1.5" id="ai-formula-context">
        <div class="text-[11px] font-bold text-fuchsia-800"><i class="fas fa-list-check mr-1"></i>AI ใช้ข้อมูลที่กรอกไว้ในตัวชี้วัดนี้</div>
        <ul class="text-[10px] text-gray-600 list-disc ml-4">
          <li *ngFor="let l of contextLines">{{ l }}</li>
        </ul>
      </div>
      <div *ngIf="question" class="mb-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-1.5" id="ai-formula-question">
        <i class="fas fa-circle-question mr-1"></i>AI ต้องการข้อมูลเพิ่ม: {{ question }}</div>
      <button *ngIf="indicator && !showDescription" type="button" (click)="showDescription = true" id="btn-ai-formula-describe"
              class="text-[10px] text-fuchsia-700 underline mb-1">อธิบายวิธีคำนวณเพิ่มเติม (ไม่บังคับ)</button>
      <ng-container *ngIf="!indicator || showDescription">
      <label class="block text-[11px] font-bold text-fuchsia-800 mb-1"><i class="fas fa-wand-magic-sparkles mr-1"></i>อธิบายวิธีคำนวณเป็นภาษาไทย{{ indicator ? ' (เพิ่มเติม)' : '' }}</label>
      <textarea [(ngModel)]="description" [ngModelOptions]="{ standalone: true }" rows="2" maxlength="500"
                [placeholder]="kind === 'pct' ? 'เช่น ร้อยละของผลงานเทียบกับประชากรกลางปี' : 'เช่น ร้อยละการลดลงของผู้เสียชีวิตเทียบค่าเฉลี่ย 5 ปี'"
                class="w-full px-2 py-1.5 border rounded-lg outline-none focus:ring-2 focus:ring-fuchsia-300 text-xs"></textarea>
      </ng-container>
      <div class="flex gap-2 mt-1">
        <button type="button" (click)="suggest()" [disabled]="loading || !canSuggest" id="btn-ai-formula-suggest"
                class="text-[11px] px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-700 text-white font-bold disabled:opacity-50">
          <i class="fas" [ngClass]="loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> {{ loading ? 'กำลังคิดสูตร...' : (indicator && !description.trim() ? 'เสนอสูตรจากข้อมูลตัวชี้วัด' : 'เสนอสูตร') }}
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
  /** ข้อมูลในหน้าต่างตัวชี้วัด (currentItem) — ส่งมา = เสนอสูตรได้โดยไม่ต้องอธิบาย */
  @Input() indicator: any = null;
  @Output() apply = new EventEmitter<string>();

  enabled = false;
  open = false;
  loading = false;
  description = '';
  formula = '';
  explanation = '';
  error = '';
  question = '';
  showDescription = false;

  /** มีคำอธิบาย ≥ 5 ตัวอักษร หรือมีข้อมูลตัวชี้วัด (ไม่มีคำอธิบาย) */
  get canSuggest(): boolean {
    const d = this.description.trim().length;
    return d >= 5 || (!!this.indicator && d === 0);
  }

  /** สรุปข้อมูลที่ส่งให้ AI (แสดงให้ผู้ใช้เห็น) — ความหมายเดียวกับ indicatorContextLines() ใน api/services/ai-formula.js */
  private _ctxKey = '';
  private _ctxLines: string[] = [];
  get contextLines(): string[] {
    const i = this.indicator;
    if (!i) return [];
    // คืน array เดิมเมื่อค่าไม่เปลี่ยน (getter ที่สร้าง array ใหม่ทุกรอบ → NG0100/NG0103 ใน *ngFor)
    const key = [i.target_percentage, i.criterion, i.target_condition, i.result_formula, i.is_cumulative, i.result_manual, i.quarter_mode, i.target_monthly].join('|');
    if (key === this._ctxKey) return this._ctxLines;
    this._ctxKey = key;
    const sym: Record<string, string> = { GTE: '≥', GT: '>', LTE: '≤', LT: '<', EQ: '=' };
    const cond = sym[i.target_condition] ? i.target_condition : 'GTE';
    const out: string[] = [];
    if (String(i.target_percentage ?? '').trim()) out.push('เป้าหมาย: ' + i.target_percentage);
    if (String(i.criterion ?? '').trim()) out.push(`เกณฑ์: ${sym[cond]} ${i.criterion}`);
    else out.push('เงื่อนไข: ' + sym[cond] + ' เป้าหมาย');
    const rf = String(i.result_formula || '').trim();
    out.push('วิธีคิดผลงาน: ' + (i.result_manual ? 'กรอกผลงานเอง' : rf ? 'สูตร ' + rf : (i.is_cumulative === 1 || i.is_cumulative === true || i.is_cumulative === '1') ? 'สะสม (รวมทุกเดือน)' : 'ค่าเดือนล่าสุด'));
    if (i.quarter_mode) out.push('วัดผลรายไตรมาส');
    if (i.target_monthly) out.push('เป้าหมายรายเดือน');
    return (this._ctxLines = out);
  }

  ngOnInit() {
    this.authService.getAiStatus().subscribe(res => { this.enabled = !!res?.enabled; this.cdr.detectChanges(); });
  }

  suggest() {
    this.loading = true;
    this.error = '';
    this.formula = '';
    this.question = '';
    const custom_vars = (this.customVars || []).filter(v => String(v?.key || '').trim());
    const body: any = { description: this.description.trim(), kind: this.kind, custom_vars, target_condition: this.targetCondition || '', indicator_name: this.indicatorName || '' };
    if (this.indicator) {
      const i = this.indicator;
      body.indicator = { target_percentage: i.target_percentage ?? '', criterion: i.criterion ?? '', target_condition: i.target_condition || '',
        result_formula: i.result_formula || '', is_cumulative: i.is_cumulative ? 1 : 0, result_manual: i.result_manual ? 1 : 0,
        quarter_mode: i.quarter_mode || '', target_monthly: i.target_monthly || '' };
    }
    this.authService.suggestAiFormula(body).subscribe({
      next: (res) => {
        this.loading = false;
        if (res?.need_more) {   // ข้อมูลไม่พอ → เปิดช่องอธิบายเพิ่ม
          this.question = res.question || 'กรุณาอธิบายวิธีคำนวณเพิ่มเติม';
          this.showDescription = true;
        } else {
          this.formula = res?.formula || '';
          this.explanation = res?.explanation || '';
        }
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
    this.question = '';
    this.showDescription = false;
  }
}
