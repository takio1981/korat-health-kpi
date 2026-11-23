// ขอเปลี่ยนสิทธิ์การใช้งาน (Role) (23 พ.ย. 2569) — ผู้ใช้เลือก Role + เหตุผล → ผู้ดูแลตามขอบเขตอนุมัติ
// เปิดจากเมนูโปรไฟล์ (layout) — backend: GET|POST /my-role-request, POST /role-requests/:id/cancel
import { Component, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';
import { AuthService } from '../services/auth';

/** ชื่อสิทธิ์ที่แสดงในคำขอ (ตรงกับหน้าสิทธิ์การเข้าถึงหน้า) */
export const ROLE_REQUEST_LABELS: Record<string, string> = {
  user_hos: 'ผู้ใช้งาน รพ. (user_hos)', user_sso: 'ผู้ใช้งาน สสอ. (user_sso)', user_cup: 'ผู้ใช้งานอำเภอ (user_cup)', user_ssj: 'ผู้ใช้งาน สสจ. (user_ssj)',
  admin_hos: 'ผู้ดูแล รพ. (admin_hos)', admin_sso: 'ผู้ดูแล สสอ. (admin_sso)', admin_cup: 'ผู้ดูแลอำเภอ (admin_cup)', admin_ssj: 'ผู้ดูแล สสจ. (admin_ssj)',
  super_admin: 'ผู้ดูแลระบบสูงสุด (super_admin)', user: 'ผู้ใช้งาน (user)',
};
export const roleRequestLabel = (r: string) => ROLE_REQUEST_LABELS[r] || r || '-';
export const ROLE_REQUEST_STATUS: Record<string, string> = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิกแล้ว' };

/** ผู้อนุมัติที่เป็นไปได้ของสิทธิ์ที่ขอ (ข้อความอธิบาย — backend ตรวจขอบเขตจริง) */
export function approverHint(toRole: string): string {
  const rank: Record<string, number> = { admin_hos: 2, admin_sso: 2, admin_cup: 3, admin_ssj: 4 };
  const r = rank[toRole] || 1;
  const list = [r < 2 ? 'ผู้ดูแล รพ./สสอ. ของหน่วยบริการ' : '', r < 3 ? 'ผู้ดูแลอำเภอ' : '', r < 4 ? 'ผู้ดูแล สสจ. ของกลุ่มงาน' : '', 'ผู้ดูแลระบบสูงสุด'].filter(Boolean);
  return list.join(' / ');
}

@Component({
  selector: 'app-my-role-request',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div *ngIf="show" class="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4" (click)="close()">
    <div id="my-role-request-modal" class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto card-scroll" (click)="$event.stopPropagation()">
      <div class="flex items-center justify-between p-4 border-b border-gray-100">
        <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-user-shield text-indigo-500 me-2"></i>ขอเปลี่ยนสิทธิ์การใช้งาน</h3>
        <button type="button" (click)="close()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
      </div>
      <div class="p-4 space-y-3 text-sm" *ngIf="data; else loadingTpl">
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">สิทธิ์ปัจจุบัน</span>
          <span class="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold">{{ label(data.role) }}</span>
        </div>
        <div *ngIf="!data.eligible" class="text-xs text-gray-500 bg-gray-50 rounded-lg p-2">บัญชีผู้ดูแลระบบสูงสุดไม่ใช้การขอเปลี่ยนสิทธิ์</div>

        <div *ngIf="data.pending as p" id="my-role-pending" class="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-1">
          <div class="text-xs font-bold text-amber-800"><i class="fas fa-hourglass-half me-1"></i>คำขอรออนุมัติ: {{ label(p.from_role) }} → {{ label(p.to_role) }}</div>
          <div class="text-[11px] text-amber-900">เหตุผล: {{ p.request_note }}</div>
          <div class="text-[11px] text-amber-700">ผู้อนุมัติ: {{ hint(p.to_role) }} — อนุมัติแล้วต้องเข้าสู่ระบบใหม่</div>
          <button type="button" id="btn-my-role-cancel" (click)="cancel(p)" class="text-[11px] text-gray-600 underline">ยกเลิกคำขอ</button>
        </div>

        <div *ngIf="data.eligible && !data.pending" id="my-role-form" class="rounded-xl border border-indigo-100 bg-indigo-50 p-3 space-y-2">
          <select [(ngModel)]="reqRole" id="my-role-select" class="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm">
            <option [ngValue]="''">-- เลือกสิทธิ์ที่ต้องการ --</option>
            <option *ngFor="let r of data.requestable" [ngValue]="r">{{ label(r) }}</option>
          </select>
          <textarea [(ngModel)]="reqNote" rows="2" maxlength="500" placeholder="เหตุผล (จำเป็น) เช่น ได้รับมอบหมายให้ดูแลข้อมูลของอำเภอ" class="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm"></textarea>
          <div *ngIf="reqRole" class="text-[11px] text-indigo-700">ผู้อนุมัติ: {{ hint(reqRole) }}</div>
          <button type="button" id="btn-my-role-request" (click)="request()" [disabled]="!reqRole || !reqNote.trim() || busy" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold disabled:opacity-50"><i class="fas fa-paper-plane me-1"></i>ส่งคำขอ</button>
        </div>

        <div *ngIf="history.length" class="space-y-1">
          <div class="text-xs font-bold text-gray-600">ประวัติคำขอ</div>
          <div *ngFor="let x of history" class="flex items-start gap-2 text-[11px] border-t border-gray-100 pt-1 role-req-history">
            <div class="min-w-0">
              <div class="text-gray-700">{{ label(x.from_role) }} → {{ label(x.to_role) }}</div>
              <div class="text-red-600" *ngIf="x.status === 'rejected' && x.decision_note">เหตุผลที่ไม่อนุมัติ: {{ x.decision_note }}</div>
            </div>
            <span class="ms-auto px-2 py-0.5 rounded-full font-bold whitespace-nowrap"
                  [ngClass]="x.status === 'approved' ? 'bg-green-100 text-green-700' : x.status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'">{{ statusLabel(x.status) }}</span>
          </div>
        </div>
      </div>
      <ng-template #loadingTpl><div class="p-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin me-1"></i>กำลังโหลด...</div></ng-template>
    </div>
  </div>`,
})
export class MyRoleRequestComponent {
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  show = false;
  data: any = null;
  history: any[] = [];
  reqRole = '';
  reqNote = '';
  busy = false;
  label = roleRequestLabel;
  hint = approverHint;
  statusLabel = (s: string) => ROLE_REQUEST_STATUS[s] || s;

  open() { this.show = true; this.load(); }
  close() { this.show = false; this.cdr.detectChanges(); }

  load() {
    this.data = null;
    this.auth.apiGet('/my-role-request').subscribe({
      next: (r: any) => {
        this.data = r?.data || null;
        this.history = (this.data?.requests || []).filter((x: any) => x.status !== 'pending');
        this.reqRole = ''; this.reqNote = '';
        this.cdr.detectChanges();
      },
      error: (e: any) => { this.show = false; Swal.fire('ผิดพลาด', e?.error?.message || 'โหลดข้อมูลไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }

  request() {
    if (!this.reqRole || !this.reqNote.trim() || this.busy) return;
    this.busy = true;
    this.auth.apiPost('/my-role-request', { role: this.reqRole, note: this.reqNote.trim() }).subscribe({
      next: (r: any) => { this.busy = false; this.load(); Swal.fire({ icon: 'success', title: 'ส่งคำขอแล้ว', text: r?.message || '', timer: 2500, showConfirmButton: false }); },
      error: (e: any) => { this.busy = false; Swal.fire('ส่งคำขอไม่สำเร็จ', e?.error?.message || 'เกิดข้อผิดพลาด', 'error'); this.cdr.detectChanges(); },
    });
  }

  cancel(p: any) {
    this.auth.apiPost(`/role-requests/${p.id}/cancel`, {}).subscribe({
      next: () => this.load(),
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ยกเลิกไม่สำเร็จ', 'error'),
    });
  }
}
