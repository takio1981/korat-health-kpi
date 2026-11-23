// ผู้ดูแลพิจารณาคำขอเปลี่ยนสิทธิ์การใช้งาน (Role) (23 พ.ย. 2569) — ใช้ในหน้าจัดการผู้ใช้งาน
//  1) คำขอรออนุมัติที่ท่านพิจารณาได้ (ตามขอบเขต + ระดับ — backend คัดให้) อนุมัติ/ไม่อนุมัติ (บังคับเหตุผล)
//  2) ผู้ดูแลระดับพื้นที่ (รพ./สสอ./CUP): ยื่นคำขอแทนผู้ใช้ในขอบเขต + รายการที่ยื่นไว้ (ยกเลิกได้)
import { Component, EventEmitter, Output, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';
import { AuthService } from '../services/auth';
import { roleRequestLabel, approverHint } from './my-role-request';

/** ผู้ดูแลที่ยื่นคำขอแทนผู้ใช้ได้ — ตรงกับ api services/user-role-requests.js ON_BEHALF_ROLES */
export const ROLE_ON_BEHALF = ['admin_hos', 'admin_sso', 'admin_cup'];

@Component({
  selector: 'app-role-request-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div *ngIf="showList" class="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4" (click)="showList = false">
    <div id="role-requests-modal" class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" (click)="$event.stopPropagation()">
      <div class="flex items-center justify-between p-4 border-b border-gray-100">
        <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-user-shield text-indigo-500 me-2"></i>คำขอเปลี่ยนสิทธิ์การใช้งาน</h3>
        <button type="button" (click)="showList = false" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
      </div>
      <div class="px-4 pt-3 flex gap-2">
        <button type="button" (click)="tab = 'requests'" class="px-3 py-1.5 rounded-lg text-xs font-bold border" [ngClass]="tab === 'requests' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-indigo-700 border-indigo-200'">รอท่านพิจารณา ({{ requests.length }})</button>
        <button *ngIf="canFile" type="button" (click)="tab = 'filed'" class="px-3 py-1.5 rounded-lg text-xs font-bold border" [ngClass]="tab === 'filed' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-700 border-amber-200'">ที่ท่านยื่นแทน ({{ filed.length }})</button>
      </div>
      <div class="p-4 overflow-auto card-scroll text-sm">
        <p class="text-[11px] text-gray-500 mb-2">อนุมัติได้เฉพาะผู้ใช้ในขอบเขตของท่าน และสิทธิ์ที่ขอต่ำกว่าระดับของท่าน — อนุมัติแล้วผู้ใช้ต้องเข้าสู่ระบบใหม่เพื่อใช้สิทธิ์ใหม่</p>
        <table *ngIf="tab === 'requests'" class="w-full text-xs">
          <thead class="bg-indigo-50 text-indigo-900"><tr><th class="px-2 py-2 text-left">ผู้ใช้</th><th class="px-2 py-2 text-left">ขอเปลี่ยน</th><th class="px-2 py-2 text-left">เหตุผล</th><th class="px-2 py-2"></th></tr></thead>
          <tbody>
            <tr *ngFor="let r of requests" class="border-t border-gray-100 role-req-row">
              <td class="px-2 py-2">{{ r.firstname }} {{ r.lastname }}<div class="text-[10px] text-gray-400">{{ r.username }} · {{ r.hospcode || '-' }} · {{ r.dept_name || '-' }}</div></td>
              <td class="px-2 py-2"><span class="text-gray-500">{{ label(r.from_role) }}</span><br><i class="fas fa-arrow-down text-[9px] text-gray-400"></i> <b class="text-indigo-700">{{ label(r.to_role) }}</b></td>
              <td class="px-2 py-2 text-gray-600">{{ r.request_note || '-' }}
                <div class="text-[10px] text-gray-400">{{ r.requested_at | date:'d MMM yy HH:mm' }}<span *ngIf="r.requested_by !== r.user_id"> · ยื่นแทนโดย {{ r.requested_by_name }}</span></div></td>
              <td class="px-2 py-2 text-right whitespace-nowrap">
                <button type="button" (click)="decide(r, true)" class="px-2 py-1 rounded-lg bg-green-600 text-white font-bold me-1 btn-role-approve"><i class="fas fa-check me-1"></i>อนุมัติ</button>
                <button type="button" (click)="decide(r, false)" class="px-2 py-1 rounded-lg bg-white border border-red-300 text-red-700 font-bold"><i class="fas fa-times me-1"></i>ไม่อนุมัติ</button>
              </td>
            </tr>
            <tr *ngIf="!requests.length"><td colspan="4" class="px-2 py-4 text-center text-gray-400">ไม่มีคำขอที่รอท่านพิจารณา</td></tr>
          </tbody>
        </table>
        <table *ngIf="tab === 'filed'" class="w-full text-xs">
          <thead class="bg-amber-50 text-amber-900"><tr><th class="px-2 py-2 text-left">ผู้ใช้</th><th class="px-2 py-2 text-left">ขอเปลี่ยน</th><th class="px-2 py-2 text-left">เหตุผล</th><th class="px-2 py-2"></th></tr></thead>
          <tbody>
            <tr *ngFor="let r of filed" class="border-t border-gray-100">
              <td class="px-2 py-2">{{ r.firstname }} {{ r.lastname }}<div class="text-[10px] text-gray-400">{{ r.username }}</div></td>
              <td class="px-2 py-2">{{ label(r.from_role) }} → <b>{{ label(r.to_role) }}</b></td>
              <td class="px-2 py-2 text-gray-600">{{ r.request_note }}</td>
              <td class="px-2 py-2 text-right"><button type="button" (click)="cancel(r)" class="px-2 py-1 rounded-lg bg-white border border-gray-300 text-gray-600 font-bold">ยกเลิก</button></td>
            </tr>
            <tr *ngIf="!filed.length"><td colspan="4" class="px-2 py-4 text-center text-gray-400">ยังไม่มีคำขอที่ท่านยื่นแทนและรออนุมัติ</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ยื่นคำขอแทนผู้ใช้ (ผู้ดูแลระดับพื้นที่) -->
  <div *ngIf="fileUser" class="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4" (click)="fileUser = null">
    <div id="role-request-file" class="bg-white rounded-2xl shadow-2xl w-full max-w-md" (click)="$event.stopPropagation()">
      <div class="p-4 border-b border-gray-100">
        <h3 class="text-base font-bold text-gray-800"><i class="fas fa-user-shield text-indigo-500 me-2"></i>ยื่นคำขอเปลี่ยนสิทธิ์แทนผู้ใช้</h3>
        <div class="text-xs text-gray-500">{{ fileUser.firstname }} {{ fileUser.lastname }} ({{ fileUser.username }}) · ปัจจุบัน: {{ label(fileUser.role) }}</div>
      </div>
      <div class="p-4 space-y-2 text-sm">
        <select [(ngModel)]="fileRole" id="role-file-select" class="w-full px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm">
          <option [ngValue]="''">-- เลือกสิทธิ์ที่ต้องการ --</option>
          <option *ngFor="let r of fileOptions" [ngValue]="r">{{ label(r) }}</option>
        </select>
        <textarea [(ngModel)]="fileNote" rows="2" maxlength="500" placeholder="เหตุผล (จำเป็น)" class="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm"></textarea>
        <div *ngIf="fileRole" class="text-[11px] text-indigo-700">ผู้อนุมัติ: {{ hint(fileRole) }} (ท่านอนุมัติคำขอที่ยื่นเองไม่ได้)</div>
      </div>
      <div class="p-4 border-t border-gray-100 flex justify-end gap-2">
        <button type="button" (click)="fileUser = null" class="px-4 py-2 rounded-xl bg-gray-100 text-gray-700 text-xs font-bold">ยกเลิก</button>
        <button type="button" id="btn-role-file-send" (click)="submitFile()" [disabled]="busy || !fileRole || !fileNote.trim()" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold disabled:opacity-50"><i class="fas fa-paper-plane me-1"></i>ยื่นคำขอ</button>
      </div>
    </div>
  </div>`,
})
export class RoleRequestAdminComponent {
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  @Output() changed = new EventEmitter<void>();
  @Output() pendingChange = new EventEmitter<number>();

  showList = false;
  tab: 'requests' | 'filed' = 'requests';
  requests: any[] = [];
  filed: any[] = [];
  canFile = false;
  requestable: string[] = [];
  fileUser: any = null;
  fileOptions: string[] = [];
  fileRole = '';
  fileNote = '';
  busy = false;
  label = roleRequestLabel;
  hint = approverHint;

  load() {
    this.auth.apiGet('/role-requests').subscribe({
      next: (r: any) => {
        const d = r?.data || {};
        this.requests = d.requests || []; this.filed = d.filed || [];
        this.canFile = !!d.can_file; this.requestable = d.requestable || [];
        this.pendingChange.emit(this.requests.length);
        this.cdr.detectChanges();
      },
      error: () => { this.requests = []; this.filed = []; this.cdr.detectChanges(); },
    });
  }
  openList() { this.tab = this.requests.length || !this.filed.length ? 'requests' : 'filed'; this.showList = true; this.load(); }

  decide(r: any, approve: boolean) {
    const go = (note: string) => this.auth.apiPost(`/role-requests/${r.id}/${approve ? 'approve' : 'reject'}`, { note }).subscribe({
      next: (res: any) => {
        Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res?.message || '', timer: 2200, showConfirmButton: false });
        this.load(); this.changed.emit();
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ดำเนินการไม่สำเร็จ', 'error'),
    });
    if (approve) {
      Swal.fire({
        title: 'อนุมัติการเปลี่ยนสิทธิ์', icon: 'question',
        html: `${r.firstname || ''} ${r.lastname || ''} (${r.username})<br><b>${this.label(r.from_role)} → ${this.label(r.to_role)}</b><br><span style="font-size:12px;color:#6b7280">ผู้ใช้จะถูกออกจากระบบและต้องเข้าสู่ระบบใหม่</span>`,
        showCancelButton: true, confirmButtonText: 'อนุมัติ', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#10b981',
      }).then(x => { if (x.isConfirmed) go(''); });
      return;
    }
    Swal.fire({
      title: 'ไม่อนุมัติคำขอ', input: 'textarea', inputPlaceholder: 'เหตุผล (ส่งถึงผู้ใช้)', showCancelButton: true,
      confirmButtonText: 'ไม่อนุมัติ', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626',
      inputValidator: (v: string) => (String(v || '').trim() ? null : 'กรุณาระบุเหตุผล'),
    }).then(x => { if (x.isConfirmed) go(String(x.value).trim()); });
  }

  cancel(r: any) {
    this.auth.apiPost(`/role-requests/${r.id}/cancel`, {}).subscribe({
      next: () => { this.load(); this.changed.emit(); },
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ยกเลิกไม่สำเร็จ', 'error'),
    });
  }

  openFile(user: any) {
    this.fileUser = user; this.fileRole = ''; this.fileNote = '';
    const opts = this.requestable.length ? this.requestable : ['user_hos', 'user_sso', 'user_cup', 'user_ssj', 'admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj'];
    this.fileOptions = opts.filter(r => r !== user.role);
  }
  submitFile() {
    if (!this.fileUser || !this.fileRole || !this.fileNote.trim() || this.busy) return;
    this.busy = true;
    this.auth.apiPost('/role-requests', { user_id: this.fileUser.id, role: this.fileRole, note: this.fileNote.trim() }).subscribe({
      next: (r: any) => {
        this.busy = false; this.fileUser = null;
        Swal.fire({ icon: 'success', title: 'ยื่นคำขอแล้ว', text: r?.message || '', timer: 2500, showConfirmButton: false });
        this.load(); this.changed.emit();
      },
      error: (e: any) => { this.busy = false; Swal.fire('ยื่นคำขอไม่สำเร็จ', e?.error?.message || 'เกิดข้อผิดพลาด', 'error'); this.cdr.detectChanges(); },
    });
  }
}
