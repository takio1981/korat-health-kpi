// กลุ่มงานของฉัน (22 พ.ย. 2569) — ผู้ใช้ทั่วไปดูกลุ่มงานหลัก + เพิ่มเติม, ขอกลุ่มงานเพิ่ม (ผู้ดูแลอนุมัติ), ยกเลิกคำขอ
// เปิดจากเมนูโปรไฟล์ (layout) — backend: GET /my-departments, POST /my-departments/request | cancel
import { Component, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';
import { AuthService } from '../services/auth';

/** สิทธิ์ที่มีกลุ่มงานเพิ่มเติมได้ — ตรงกับ api core/access.js ROLE_MULTI_DEPT */
export const ROLE_MULTI_DEPT = ['user_ssj', 'user_hos', 'user_sso', 'user_cup', 'user'];
export const DEPT_STATUS_LABEL: Record<string, string> = { approved: 'ใช้งานได้', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ' };

@Component({
  selector: 'app-my-departments',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div *ngIf="show" class="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4" (click)="close()">
    <div id="my-departments-modal" class="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-auto card-scroll" (click)="$event.stopPropagation()">
      <div class="flex items-center justify-between p-4 border-b border-gray-100">
        <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-building text-blue-500 me-2"></i>กลุ่มงานของฉัน</h3>
        <button type="button" (click)="close()" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
      </div>
      <div class="p-4 space-y-3 text-sm" *ngIf="data; else loadingTpl">
        <p class="text-xs text-gray-500">ท่านเห็นและบันทึกผลงานตัวชี้วัดได้ทุกกลุ่มงานในรายการที่ "ใช้งานได้" — กรณีดูแลตัวชี้วัดข้ามกลุ่มงาน ขอเพิ่มกลุ่มงานได้ (ผู้ดูแลอนุมัติ)</p>
        <div class="rounded-xl border border-gray-100 divide-y divide-gray-100">
          <div class="flex items-center gap-2 px-3 py-2" *ngIf="data.primary">
            <span class="font-bold text-gray-800">{{ data.primary.dept_name || ('กลุ่มงาน #' + data.primary.dept_id) }}</span>
            <span class="ms-auto px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[11px] font-bold">กลุ่มงานหลัก</span>
          </div>
          <div *ngFor="let x of data.extras" class="flex items-center gap-2 px-3 py-2 my-dept-row">
            <div class="min-w-0">
              <div class="font-medium text-gray-800">{{ x.dept_name }}</div>
              <div class="text-[11px] text-gray-500" *ngIf="x.request_note">เหตุผลที่ขอ: {{ x.request_note }}</div>
              <div class="text-[11px] text-red-600" *ngIf="x.status === 'rejected' && x.decision_note">เหตุผลที่ไม่อนุมัติ: {{ x.decision_note }}</div>
            </div>
            <span class="ms-auto px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap"
                  [ngClass]="x.status === 'approved' ? 'bg-blue-100 text-blue-700' : x.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'">{{ statusLabel(x.status) }}</span>
            <button *ngIf="x.status !== 'approved'" type="button" (click)="cancel(x)" class="text-[11px] text-gray-500 underline whitespace-nowrap">{{ x.status === 'pending' ? 'ยกเลิกคำขอ' : 'ลบ' }}</button>
          </div>
        </div>
        <div *ngIf="!data.eligible" class="text-xs text-gray-500 bg-gray-50 rounded-lg p-2">สิทธิ์ของท่าน (ผู้ดูแล) ไม่ใช้กลุ่มงานเพิ่มเติม</div>
        <div *ngIf="data.eligible" class="rounded-xl border border-blue-100 bg-blue-50 p-3 space-y-2" id="my-dept-request">
          <div class="text-xs font-bold text-blue-800">ขอเพิ่มกลุ่มงาน</div>
          <select [(ngModel)]="reqDept" class="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm" id="my-dept-select">
            <option [ngValue]="null">-- เลือกกลุ่มงาน --</option>
            <option *ngFor="let d of data.available" [ngValue]="d.id">{{ d.dept_name }}</option>
          </select>
          <textarea [(ngModel)]="reqNote" rows="2" maxlength="500" placeholder="เหตุผล เช่น รับผิดชอบตัวชี้วัด ... ของกลุ่มงานนี้" class="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm"></textarea>
          <button type="button" id="btn-my-dept-request" (click)="request()" [disabled]="!reqDept || busy" class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"><i class="fas fa-paper-plane me-1"></i>ส่งคำขอ</button>
          <div class="text-[11px] text-blue-700">ผู้อนุมัติ: ผู้ดูแลระบบสูงสุด หรือผู้ดูแล สสจ. ของกลุ่มงานนั้น — อนุมัติแล้วโหลดหน้าใหม่เพื่อเห็นตัวชี้วัด</div>
        </div>
      </div>
      <ng-template #loadingTpl><div class="p-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin me-1"></i>กำลังโหลด...</div></ng-template>
    </div>
  </div>`,
})
export class MyDepartmentsComponent {
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  show = false;
  data: any = null;
  reqDept: number | null = null;
  reqNote = '';
  busy = false;
  statusLabel = (s: string) => DEPT_STATUS_LABEL[s] || s;

  open() { this.show = true; this.load(); }
  close() { this.show = false; this.cdr.detectChanges(); }

  load() {
    this.data = null;
    this.auth.apiGet('/my-departments').subscribe({
      next: (r: any) => { this.data = r?.data || null; this.reqDept = null; this.reqNote = ''; this.cdr.detectChanges(); },
      error: (e: any) => { this.show = false; Swal.fire('ผิดพลาด', e?.error?.message || 'โหลดข้อมูลไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }

  request() {
    if (!this.reqDept || this.busy) return;
    this.busy = true;
    this.auth.apiPost('/my-departments/request', { dept_id: this.reqDept, note: this.reqNote }).subscribe({
      next: (r: any) => { this.busy = false; Swal.fire({ icon: 'success', title: 'ส่งคำขอแล้ว', text: r?.message || '', timer: 2500, showConfirmButton: false }); this.load(); },
      error: (e: any) => { this.busy = false; Swal.fire('ส่งคำขอไม่สำเร็จ', e?.error?.message || 'เกิดข้อผิดพลาด', 'error'); this.cdr.detectChanges(); },
    });
  }

  cancel(x: any) {
    this.auth.apiPost('/my-departments/cancel', { dept_id: x.dept_id }).subscribe({
      next: () => this.load(),
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ยกเลิกไม่สำเร็จ', 'error'),
    });
  }
}
