// กล่อง "ถามผู้ช่วย AI" บนหน้าคู่มือ (ผู้ช่วย AI ระยะที่ 4 — 8 พ.ย. 2569) — POST /ai/help-ask
// backend ค้นเฉพาะหัวข้อคู่มือที่สิทธิ์ของผู้ถามเห็น แล้วให้ AI ตอบจากเนื้อหานั้นพร้อมอ้างหัวข้อ — กดหัวข้อ = เลื่อนไปอ่านในคู่มือ (pick)
// แสดงเฉพาะเมื่อผู้ดูแลเปิดผู้ช่วย AI และผู้ใช้เข้าสู่ระบบแล้ว — คำตอบเป็นข้อความล้วน (ไม่ใช้ innerHTML)
import { Component, EventEmitter, OnInit, Output, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';

export interface HelpSource { anchor: string; section: string | null; heading: string | null; }
export interface HelpAnswer { question: string; found: boolean; answer: string; sources: HelpSource[]; related: HelpSource[]; model: string | null; cached: boolean; }

// บรรทัดของคำตอบ (ตัดเครื่องหมาย Markdown ที่ผู้ให้บริการบางรายใส่มา)
// ผู้ให้บริการบางรายเขียนขั้นตอน "1. … 2. …" ต่อกันในบรรทัดเดียว (พบกับ Gemini) — แยกเป็นบรรทัดเมื่อไม่มีการขึ้นบรรทัดเลย
export function answerLines(text: string): string[] {
  let t = String(text || '');
  if (!/\n/.test(t) && /\s2\.\s/.test(t)) t = t.replace(/\s+(?=\d{1,2}\.\s)/g, '\n');
  return t.split(/\r?\n/).map(l => l.replace(/\*\*/g, '').replace(/^#+\s*/, '').trim()).filter(Boolean);
}

// ป้ายหัวข้อ: "หัวข้อหลัก › หัวข้อย่อย"
export function sourceLabel(s: HelpSource): string {
  return [s.section, s.heading].filter(Boolean).join(' › ') || s.anchor;
}

// หัวข้อที่เกี่ยวข้องอื่น (ไม่ซ้ำกับแหล่งอ้างอิงที่ AI ระบุ)
export function otherRelated(a: HelpAnswer): HelpSource[] {
  const key = (s: HelpSource) => s.anchor + '|' + (s.heading || '');
  const used = new Set((a.sources || []).map(key));
  return (a.related || []).filter(s => !used.has(key(s)));
}

const HISTORY_MAX = 5;

@Component({
  selector: 'app-ai-help-box',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div *ngIf="enabled" class="rounded-2xl border border-fuchsia-200 bg-gradient-to-br from-fuchsia-50 to-white shadow-sm p-4">
    <h3 class="text-sm font-bold text-fuchsia-800"><i class="fas fa-wand-magic-sparkles me-1"></i>ถามผู้ช่วย AI เกี่ยวกับการใช้งาน</h3>
    <p class="text-xs text-gray-500 mt-1">พิมพ์คำถามเป็นภาษาไทย — AI ตอบจากเนื้อหาคู่มือที่สิทธิ์ของคุณเห็นเท่านั้น พร้อมบอกหัวข้อที่ใช้ตอบ</p>
    <form class="mt-3 flex flex-col sm:flex-row gap-2" (ngSubmit)="ask()">
      <input type="text" name="aiHelpQuestion" [(ngModel)]="question" maxlength="500" [disabled]="loading"
             placeholder="เช่น ลืมรหัสผ่านทำอย่างไร / นำเข้าผลงานจาก Excel อย่างไร"
             class="flex-1 min-w-0 px-3 py-2 rounded-xl border border-fuchsia-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-300">
      <button type="submit" [disabled]="loading || question.trim().length < 3"
              class="px-4 py-2 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-sm font-bold shadow-md disabled:opacity-50 shrink-0">
        <i class="fas" [ngClass]="loading ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i> {{ loading ? 'กำลังค้นคำตอบ...' : 'ถาม' }}
      </button>
    </form>
    <div *ngIf="!history.length && !loading" class="mt-2 flex flex-wrap gap-1.5">
      <button *ngFor="let s of examples" type="button" (click)="question = s; ask()"
              class="px-2.5 py-1 rounded-full bg-white border border-fuchsia-200 text-fuchsia-700 hover:bg-fuchsia-50 text-[11px]">{{ s }}</button>
    </div>
    <div *ngIf="error" class="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2"><i class="fas fa-triangle-exclamation me-1"></i>{{ error }}</div>

    <div *ngFor="let a of history; let first = first" class="mt-3 rounded-xl bg-white border p-3"
         [ngClass]="first ? 'border-fuchsia-200' : 'border-gray-100 opacity-80'">
      <p class="text-xs font-bold text-gray-700"><i class="fas fa-circle-question text-fuchsia-500 me-1"></i>{{ a.question }}</p>
      <div class="mt-2 text-sm text-gray-800 space-y-1" [ngClass]="a.found ? '' : 'text-gray-500'">
        <p *ngFor="let l of linesOf(a)">{{ l }}</p>
      </div>
      <div *ngIf="a.sources.length" class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span class="text-gray-500">อ้างอิงคู่มือ:</span>
        <button *ngFor="let s of a.sources" type="button" (click)="pick.emit(s.anchor)"
                class="px-2 py-0.5 rounded-full bg-green-50 border border-green-200 text-green-800 hover:bg-green-100">
          <i class="fas fa-book-open me-1"></i>{{ label(s) }}</button>
      </div>
      <div *ngIf="related(a).length" class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span class="text-gray-500">หัวข้อที่เกี่ยวข้อง:</span>
        <button *ngFor="let s of related(a)" type="button" (click)="pick.emit(s.anchor)"
                class="px-2 py-0.5 rounded-full bg-gray-50 border border-gray-200 text-gray-700 hover:bg-gray-100">{{ label(s) }}</button>
      </div>
      <p *ngIf="a.model" class="pt-2 mt-2 text-[11px] text-gray-500 border-t border-fuchsia-100">
        <i class="fas fa-robot me-1"></i>ข้อความจาก AI — โปรดตรวจสอบกับเนื้อหาคู่มือก่อนดำเนินการ · รุ่น {{ a.model }}{{ a.cached ? ' (คำตอบที่สร้างไว้แล้ว)' : '' }}
      </p>
    </div>
  </div>`,
})
export class AiHelpBoxComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  /** กดหัวข้ออ้างอิง → anchor ของหัวข้อ (หน้าคู่มือเลื่อนไป section-<anchor>) */
  @Output() pick = new EventEmitter<string>();

  enabled = false;
  loading = false;
  question = '';
  error = '';
  history: HelpAnswer[] = [];
  readonly examples = ['ลืมรหัสผ่านทำอย่างไร', 'นำเข้าผลงานจาก Excel อย่างไร', 'ทำไมแก้ไขผลงานไม่ได้'];

  ngOnInit() {
    this.authService.getAiStatus().subscribe(res => { this.enabled = !!res?.enabled; this.cdr.detectChanges(); });
  }

  linesOf(a: HelpAnswer) { return answerLines(a.answer); }
  label(s: HelpSource) { return sourceLabel(s); }
  related(a: HelpAnswer) { return otherRelated(a); }

  ask() {
    const q = this.question.trim();
    if (q.length < 3 || this.loading) return;
    this.loading = true;
    this.error = '';
    this.authService.askAiHelp(q).subscribe({
      next: (res) => {
        this.loading = false;
        this.history = [{
          question: q, found: !!res?.found, answer: res?.answer || '', sources: res?.sources || [], related: res?.related || [],
          model: res?.model || null, cached: !!res?.cached,
        }, ...this.history].slice(0, HISTORY_MAX);
        this.question = '';
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.loading = false;
        this.error = err.error?.message || 'ผู้ช่วยคู่มือตอบไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }
}
