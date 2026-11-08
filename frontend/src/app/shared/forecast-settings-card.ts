// การ์ดตั้งค่า "ระบบเตือนล่วงหน้า" (ข้อเสนอแนวคิด — 8 พ.ย. 2569) ระยะที่ 3 — ฝังในหน้าตั้งค่าระบบ (super_admin)
// เกณฑ์เฝ้าระวัง + สรุปตัวชี้วัดเสี่ยงรายสัปดาห์ (วัน/เวลา/ช่องทาง) — โหลด/บันทึกผ่าน /forecast/settings เอง, ดูตัวอย่าง/ส่งทันทีผ่าน /forecast/digest/run
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

export const DIGEST_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

/** ข้อความผลการส่งครั้งล่าสุด */
export function lastRunText(r: any): string {
  if (!r) return 'ยังไม่เคยส่ง';
  const when = r.ran_at ? new Date(r.ran_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  if (r.skipped) return `${when} — ไม่ส่ง (${r.reason === 'no_risk' ? 'ไม่มีคู่เสี่ยงสูง/ขาดการรายงาน' : r.reason})`;
  const ch = [r.inapp ? `ในระบบ ${r.inapp} คน` : '', r.sent_email ? 'อีเมล' : '', r.sent_telegram ? 'Telegram' : ''].filter(Boolean).join(', ') || 'ไม่มีช่องทางที่ส่งได้';
  return `${when} — ปีงบ ${r.year_bh} เสี่ยงสูง ${r.counts?.high ?? 0} คู่ · ส่ง: ${ch}${r.ai ? ' · มีสรุป AI' : ''}`;
}

@Component({
  selector: 'app-forecast-settings-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div id="forecast-settings-card">
    <h3 class="text-base font-bold text-gray-800"><i class="fas fa-triangle-exclamation text-red-500 me-1"></i>ระบบเตือนล่วงหน้า (ตัวชี้วัดเสี่ยง)</h3>
    <p class="text-xs text-gray-500 mt-1">ระดับความเสี่ยงคำนวณจากค่าคาดการณ์ผลงาน ณ สิ้นปีงบ (ดูรายการที่เมนูรายงานสถิติ แท็บ "ตัวชี้วัดเสี่ยง") — สรุปรายสัปดาห์ส่งเฉพาะเมื่อมีคู่เสี่ยงสูงหรือขาดการรายงาน</p>
    <div *ngIf="loadError" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{{ loadError }}</div>
    <div *ngIf="s" class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <label class="block">
        <span class="text-xs font-bold text-gray-600">เกณฑ์ "เฝ้าระวัง" — ค่าคาดการณ์ต่ำกว่าเป้าหมายไม่เกิน (%)</span>
        <input type="number" min="1" max="50" [(ngModel)]="s.watch_pct" name="fcWatch" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white">
        <span class="text-[11px] text-gray-400">ต่ำกว่าเกินค่านี้ = เสี่ยงสูง (ข้อเสนอแนวคิด: 10%)</span>
      </label>
      <div class="flex items-center gap-2 pt-5">
        <input type="checkbox" id="fcEnabled" [(ngModel)]="s.digest_enabled" name="fcEnabled" class="w-4 h-4">
        <label for="fcEnabled" class="font-bold text-gray-700">ส่งสรุปตัวชี้วัดเสี่ยงรายสัปดาห์อัตโนมัติ</label>
      </div>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">วันที่ส่ง</span>
        <select [(ngModel)]="s.digest_day" name="fcDay" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white">
          <option *ngFor="let d of days; let i = index" [ngValue]="i">วัน{{ d }}</option>
        </select>
      </label>
      <label class="block">
        <span class="text-xs font-bold text-gray-600">เวลา (เวลาไทย)</span>
        <input type="time" [(ngModel)]="s.digest_time" name="fcTime" class="mt-1 w-full px-3 py-2 border border-gray-200 rounded-xl bg-white">
      </label>
      <div class="md:col-span-2 flex flex-wrap gap-4 text-xs text-gray-700">
        <label class="flex items-center gap-1"><input type="checkbox" [(ngModel)]="s.digest_inapp" name="fcInapp"> แจ้งเตือนในระบบ (super_admin ภาพรวม · admin_ssj เฉพาะหน่วยงานตน)</label>
        <label class="flex items-center gap-1"><input type="checkbox" [(ngModel)]="s.digest_email" name="fcEmail"> อีเมลผู้ดูแล</label>
        <label class="flex items-center gap-1"><input type="checkbox" [(ngModel)]="s.digest_telegram" name="fcTg"> Telegram</label>
        <label class="flex items-center gap-1" *ngIf="aiEnabled"><input type="checkbox" [(ngModel)]="s.digest_ai" name="fcAi"> แนบสรุปโดย AI</label>
      </div>
    </div>
    <div *ngIf="s" class="mt-3 flex flex-wrap gap-2 items-center">
      <button type="button" (click)="save()" [disabled]="busy" id="btn-fc-save" class="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-md disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึกการตั้งค่า</button>
      <button type="button" (click)="run(true)" [disabled]="busy" id="btn-fc-preview" class="px-4 py-2 rounded-xl bg-white border border-gray-300 hover:bg-gray-50 text-xs font-bold disabled:opacity-50"><i class="fas fa-eye me-1"></i>ดูตัวอย่างสรุป</button>
      <button type="button" (click)="run(false)" [disabled]="busy" class="px-4 py-2 rounded-xl bg-white border border-red-300 text-red-700 hover:bg-red-50 text-xs font-bold disabled:opacity-50"><i class="fas fa-paper-plane me-1"></i>ส่งทันที</button>
      <span class="text-xs text-gray-500">ส่งครั้งล่าสุด: {{ lastRun }}</span>
    </div>
    <pre *ngIf="preview" class="mt-3 text-xs bg-gray-50 border border-gray-200 rounded-xl p-3 whitespace-pre-wrap font-sans" id="fc-preview">{{ preview }}</pre>
  </div>`,
})
export class ForecastSettingsCardComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  readonly days = DIGEST_DAYS;
  s: any = null;
  lastRun = '';
  loadError = '';
  busy = false;
  preview = '';
  aiEnabled = false;

  ngOnInit() {
    this.load();
    this.authService.getAiStatus().subscribe((r: any) => { this.aiEnabled = !!r?.enabled; this.cdr.detectChanges(); });
  }

  load() {
    this.authService.apiGet('/forecast/settings').subscribe({
      next: (res: any) => { this.s = res?.data || null; this.lastRun = lastRunText(res?.last_run); this.cdr.detectChanges(); },
      error: (err: any) => { this.loadError = err.error?.message || 'โหลดการตั้งค่าระบบเตือนล่วงหน้าไม่สำเร็จ'; this.cdr.detectChanges(); },
    });
  }

  save() {
    this.busy = true;
    this.authService.apiPut('/forecast/settings', { ...this.s, watch_pct: Number(this.s.watch_pct), digest_day: Number(this.s.digest_day) }).subscribe({
      next: (res: any) => { this.busy = false; Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false }); this.cdr.detectChanges(); },
      error: (err: any) => { this.busy = false; Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }

  run(preview: boolean) {
    const go = () => {
      this.busy = true;
      this.authService.apiPost('/forecast/digest/run', { preview }).subscribe({
        next: (res: any) => {
          this.busy = false;
          if (preview) this.preview = res.skipped ? 'ไม่มีคู่เสี่ยงสูงหรือขาดการรายงานในปีงบปัจจุบัน — จะไม่ส่งสรุป' : res.text;
          else { this.lastRun = lastRunText(res); Swal.fire({ icon: 'success', title: 'ดำเนินการแล้ว', text: this.lastRun, timer: 2500, showConfirmButton: false }); }
          this.cdr.detectChanges();
        },
        error: (err: any) => { this.busy = false; Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
      });
    };
    if (preview) { go(); return; }
    Swal.fire({ title: 'ส่งสรุปตัวชี้วัดเสี่ยงทันที?', text: 'ส่งตามช่องทางที่บันทึกไว้ (ไม่ขึ้นกับสวิตช์ส่งอัตโนมัติ)', icon: 'question', showCancelButton: true,
      confirmButtonColor: '#10b981', confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก' }).then(r => { if (r.isConfirmed) go(); });
  }
}
