// การ์ดตั้งค่า "อนุมัติผู้สมัครใหม่อัตโนมัติ + ส่งผู้ใช้ใหม่ขึ้น KHD" (13 พ.ย. 2569) — ฝังในหน้าตั้งค่าระบบ (super_admin)
// โหลด/บันทึกผ่าน /user-approval/settings เอง | "ตรวจตอนนี้" / "ส่งขึ้น KHD ตอนนี้" ผ่าน POST /user-approval/run
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

export interface UserApprovalSettings { autoApprove: boolean; delay: number; syncOnApprove: boolean; syncSchedule: boolean; syncTime: string; }

/** "5 นาที" / "2 ชั่วโมง" / "1 วัน 3 ชั่วโมง" */
export function delayText(min: number): string {
  const m = Number(min) || 0;
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  return [d ? `${d} วัน` : '', h ? `${h} ชั่วโมง` : '', r ? `${r} นาที` : ''].filter(Boolean).join(' ') || '0 นาที';
}

/** ผลการทำงานครั้งล่าสุด */
export function userApprovalLastRunText(r: any): string {
  if (!r) return 'ยังไม่เคยทำงาน';
  const when = r.at ? new Date(r.at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  if (r.task === 'approve') return `${when} — อนุมัติอัตโนมัติ ${r.approved ?? 0} บัญชี${r.manual ? ' (กดตรวจเอง)' : ''}`;
  return `${when} — ส่งขึ้น KHD สำเร็จ ${r.synced ?? 0} · ไม่สำเร็จ ${r.failed ?? 0}${r.manual ? ' (กดส่งเอง)' : ''}`;
}

@Component({
  selector: 'app-user-approval-settings-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div id="user-approval-settings-card">
    <h3 class="text-base font-bold text-gray-800"><i class="fas fa-user-check text-emerald-600 me-1"></i>อนุมัติผู้สมัครใหม่อัตโนมัติ + ส่งผู้ใช้ใหม่ขึ้น KHD</h3>
    <p class="text-xs text-gray-500 mt-1">อนุมัติผู้ที่ลงทะเบียน (ทุกบทบาท) เมื่อครบเวลาที่ตั้งหลังลงทะเบียน และแจ้ง super_admin ทุกครั้ง — ใช้กับผู้ที่ลงทะเบียนหลังเปิดฟังก์ชันนี้
      (ผู้ที่รออนุมัติอยู่ก่อนหน้ายังต้องอนุมัติเอง) · การส่งขึ้น KHD ใช้การตั้งค่า Mapping/คอลัมน์ที่ไม่ต้องส่ง ของหน้า Data Synchronization เดิม</p>
    <div *ngIf="loadError" class="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{{ loadError }}</div>
    <div *ngIf="s" class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <div class="md:col-span-2 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3">
        <label class="flex items-center gap-2 font-bold text-gray-700">
          <input type="checkbox" id="uaAuto" [(ngModel)]="s.autoApprove" name="uaAuto" class="w-4 h-4"> อนุมัติผู้สมัครใหม่อัตโนมัติ
        </label>
        <label class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-700">
          อนุมัติเมื่อครบ
          <input type="number" id="uaDelay" min="1" max="10080" [(ngModel)]="s.delay" name="uaDelay" class="w-24 px-2 py-1 border border-gray-200 rounded-lg bg-white text-sm">
          นาทีหลังลงทะเบียน <span class="text-gray-400">({{ delayText(s.delay) }} — เช่น ลงทะเบียน 12:00 ตั้ง 5 นาที = อนุมัติ 12:05 โดยประมาณ ระบบตรวจทุก 30 วินาที)</span>
        </label>
        <p *ngIf="s.autoApprove" class="mt-2 text-[11px] text-amber-700"><i class="fas fa-triangle-exclamation me-1"></i>อนุมัติทุกบทบาทรวมผู้ดูแล (admin) โดยไม่มีคนตรวจ — ตรวจรายชื่อจากการแจ้งเตือน และปิดใช้งานบัญชีที่ไม่ถูกต้องได้ที่หน้าจัดการผู้ใช้</p>
      </div>
      <div class="md:col-span-2 rounded-xl border border-sky-200 bg-sky-50/40 p-3 space-y-2">
        <div class="font-bold text-gray-700"><i class="fas fa-cloud-arrow-up text-sky-600 me-1"></i>ส่งข้อมูลผู้ใช้ใหม่ขึ้น KHD อัตโนมัติ</div>
        <label class="flex items-center gap-2 text-xs text-gray-700"><input type="checkbox" id="uaSyncNow" [(ngModel)]="s.syncOnApprove" name="uaSyncNow"> ส่งทันทีหลังอนุมัติ (ทั้งอนุมัติอัตโนมัติและผู้ดูแลกดอนุมัติ)</label>
        <label class="flex flex-wrap items-center gap-2 text-xs text-gray-700"><input type="checkbox" id="uaSyncSch" [(ngModel)]="s.syncSchedule" name="uaSyncSch"> ส่งตามรอบทุกวัน เวลา
          <input type="time" id="uaSyncTime" [(ngModel)]="s.syncTime" name="uaSyncTime" class="px-2 py-1 border border-gray-200 rounded-lg bg-white text-sm">
          <span class="text-gray-400">(ส่งผู้ใช้ใหม่ที่อนุมัติแล้วแต่ยังส่งไม่สำเร็จ — ส่งซ้ำได้ไม่เกิน 20 ครั้งต่อคน)</span></label>
      </div>
      <div *ngIf="status" class="md:col-span-2 flex flex-wrap gap-3 text-xs" id="ua-status">
        <span class="px-2 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">รอถึงเวลาอนุมัติอัตโนมัติ <b>{{ status.waiting_auto }}</b> คน</span>
        <span class="px-2 py-1 rounded-lg bg-gray-50 border border-gray-200 text-gray-700">รออนุมัติทั้งหมด <b>{{ status.pending_all }}</b> คน</span>
        <span class="px-2 py-1 rounded-lg border" [ngClass]="status.khd_failed ? 'bg-red-50 border-red-200 text-red-700' : 'bg-gray-50 border-gray-200 text-gray-700'">ส่งขึ้น KHD ไม่สำเร็จ (รอส่งซ้ำ) <b>{{ status.khd_failed }}</b> คน</span>
      </div>
    </div>
    <div *ngIf="s" class="mt-3 flex flex-wrap gap-2 items-center">
      <button type="button" (click)="save()" [disabled]="busy" id="btn-ua-save" class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-md disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึกการตั้งค่า</button>
      <button type="button" (click)="run('approve')" [disabled]="busy || !s.autoApprove" id="btn-ua-run-approve" class="px-4 py-2 rounded-xl bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50 text-xs font-bold disabled:opacity-50"><i class="fas fa-user-check me-1"></i>ตรวจอนุมัติตอนนี้</button>
      <button type="button" (click)="run('sync')" [disabled]="busy" id="btn-ua-run-sync" class="px-4 py-2 rounded-xl bg-white border border-sky-300 text-sky-700 hover:bg-sky-50 text-xs font-bold disabled:opacity-50"><i class="fas fa-cloud-arrow-up me-1"></i>ส่งผู้ใช้ใหม่ขึ้น KHD ตอนนี้</button>
      <span class="text-xs text-gray-500">ทำงานครั้งล่าสุด: {{ lastRun }}</span>
    </div>
  </div>`,
})
export class UserApprovalSettingsCardComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  readonly delayText = delayText;
  s: UserApprovalSettings | null = null;
  status: any = null;
  lastRun = '';
  loadError = '';
  busy = false;

  ngOnInit() { this.load(); }

  load() {
    this.authService.apiGet('/user-approval/settings').subscribe({
      next: (res: any) => {
        this.s = res?.data ? { ...res.data } : null;
        this.status = res?.status || null;
        this.lastRun = userApprovalLastRunText(res?.status?.last_run);
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.loadError = err.error?.message || 'โหลดการตั้งค่าไม่สำเร็จ'; this.cdr.detectChanges(); },
    });
  }

  payload(): UserApprovalSettings {
    const s = this.s!;
    return { autoApprove: !!s.autoApprove, delay: Number(s.delay), syncOnApprove: !!s.syncOnApprove, syncSchedule: !!s.syncSchedule, syncTime: String(s.syncTime || '') };
  }

  save() {
    if (!this.s) return;
    const p = this.payload();
    if (!Number.isInteger(p.delay) || p.delay < 1 || p.delay > 10080) { Swal.fire('ข้อมูลไม่ถูกต้อง', 'ระยะเวลาหลังลงทะเบียนต้องเป็นจำนวนเต็ม 1–10080 นาที', 'warning'); return; }
    this.busy = true;
    this.authService.apiPut('/user-approval/settings', p).subscribe({
      next: () => { this.busy = false; Swal.fire({ icon: 'success', title: 'สำเร็จ', text: 'บันทึกการตั้งค่าแล้ว', timer: 2000, showConfirmButton: false }); this.load(); },
      error: (err: any) => { this.busy = false; Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }

  run(task: 'approve' | 'sync') {
    this.busy = true;
    this.authService.apiPost('/user-approval/run', { task }).subscribe({
      next: (res: any) => {
        this.busy = false;
        const text = task === 'approve' ? res.message : `ส่งสำเร็จ ${res.synced ?? 0} คน · ไม่สำเร็จ ${res.failed ?? 0} คน${res.message ? ' — ' + res.message : ''}`;
        Swal.fire({ icon: 'success', title: 'ดำเนินการแล้ว', text, timer: 3000, showConfirmButton: false });
        this.load();
      },
      error: (err: any) => { this.busy = false; Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }
}
