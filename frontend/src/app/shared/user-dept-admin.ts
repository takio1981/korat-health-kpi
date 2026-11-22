// ผู้ดูแลจัดการกลุ่มงานเพิ่มเติมของผู้ใช้ (22 พ.ย. 2569) — ใช้ในหน้าจัดการผู้ใช้งาน
//  1) คำขอกลุ่มงาน: อนุมัติ/ไม่อนุมัติ (บังคับเหตุผล) + รายชื่อผู้ใช้ที่ได้รับกลุ่มงานแล้ว (เอาออกได้)
//  2) กำหนดให้ผู้ใช้รายคน: ติ๊กกลุ่มงานเพิ่มเติม (อนุมัติทันที)
// ขอบเขต (backend ตรวจซ้ำ): super_admin = ทุกกลุ่มงาน, admin_ssj = กลุ่มงานของตนเอง
import { Component, EventEmitter, Output, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';
import { AuthService } from '../services/auth';
import { ROLE_MULTI_DEPT } from './my-departments';

/** กลุ่มงานเพิ่มเติมที่จะส่ง (PUT dept_ids) = ที่อนุมัติอยู่ + ติ๊กใหม่ − ที่เอาติ๊กออก (ไม่รวมกลุ่มงานหลัก) */
export function desiredDeptIds(approved: number[], checked: Set<number>, options: number[], primary: number | null): number[] {
  const opt = new Set(options.map(Number));
  const keep = approved.map(Number).filter(d => !opt.has(d));       // นอกตัวเลือกของผู้ดูแล = คงเดิม
  const sel = [...checked].map(Number).filter(d => opt.has(d));
  return [...new Set([...keep, ...sel])].filter(d => d !== Number(primary)).sort((a, b) => a - b);
}
export const canHaveExtraDepts = (role: string) => ROLE_MULTI_DEPT.includes(role);

@Component({
  selector: 'app-user-dept-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <!-- คำขอกลุ่มงาน + ผู้ใช้ที่ได้รับกลุ่มงานแล้ว -->
  <div *ngIf="showRequests" class="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4" (click)="showRequests = false">
    <div id="dept-requests-modal" class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col" (click)="$event.stopPropagation()">
      <div class="flex items-center justify-between p-4 border-b border-gray-100">
        <h3 class="text-lg font-bold text-gray-800"><i class="fas fa-building text-blue-500 me-2"></i>กลุ่มงานเพิ่มเติมของผู้ใช้</h3>
        <button type="button" (click)="showRequests = false" class="text-gray-400 hover:text-gray-600"><i class="fas fa-times"></i></button>
      </div>
      <div class="px-4 pt-3 flex gap-2">
        <button type="button" (click)="tab = 'requests'" class="px-3 py-1.5 rounded-lg text-xs font-bold border" [ngClass]="tab === 'requests' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-700 border-amber-200'">คำขอรออนุมัติ ({{ requests.length }})</button>
        <button type="button" (click)="tab = 'members'" class="px-3 py-1.5 rounded-lg text-xs font-bold border" [ngClass]="tab === 'members' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-blue-700 border-blue-200'">ได้รับกลุ่มงานแล้ว ({{ members.length }})</button>
      </div>
      <div class="p-4 overflow-auto card-scroll text-sm">
        <table *ngIf="tab === 'requests'" class="w-full text-xs">
          <thead class="bg-amber-50 text-amber-900"><tr><th class="px-2 py-2 text-left">ผู้ใช้</th><th class="px-2 py-2 text-left">ขอกลุ่มงาน</th><th class="px-2 py-2 text-left">เหตุผล</th><th class="px-2 py-2"></th></tr></thead>
          <tbody>
            <tr *ngFor="let r of requests" class="border-t border-gray-100 dept-req-row">
              <td class="px-2 py-2">{{ r.firstname }} {{ r.lastname }}<div class="text-[10px] text-gray-400">{{ r.username }} · {{ r.role }} · หลัก: {{ r.primary_dept_name || '-' }}</div></td>
              <td class="px-2 py-2 font-bold text-gray-800">{{ r.dept_name }}</td>
              <td class="px-2 py-2 text-gray-600">{{ r.request_note || '-' }}<div class="text-[10px] text-gray-400">{{ r.requested_at | date:'d MMM yy HH:mm' }}</div></td>
              <td class="px-2 py-2 text-right whitespace-nowrap">
                <button type="button" (click)="decide(r, true)" class="px-2 py-1 rounded-lg bg-green-600 text-white font-bold me-1"><i class="fas fa-check me-1"></i>อนุมัติ</button>
                <button type="button" (click)="decide(r, false)" class="px-2 py-1 rounded-lg bg-white border border-red-300 text-red-700 font-bold"><i class="fas fa-times me-1"></i>ไม่อนุมัติ</button>
              </td>
            </tr>
            <tr *ngIf="!requests.length"><td colspan="4" class="px-2 py-4 text-center text-gray-400">ไม่มีคำขอรออนุมัติ</td></tr>
          </tbody>
        </table>
        <table *ngIf="tab === 'members'" class="w-full text-xs">
          <thead class="bg-blue-50 text-blue-900"><tr><th class="px-2 py-2 text-left">กลุ่มงานเพิ่มเติม</th><th class="px-2 py-2 text-left">ผู้ใช้</th><th class="px-2 py-2 text-left">กลุ่มงานหลัก</th><th class="px-2 py-2"></th></tr></thead>
          <tbody>
            <tr *ngFor="let m of members" class="border-t border-gray-100">
              <td class="px-2 py-2 font-bold text-gray-800">{{ m.dept_name }}</td>
              <td class="px-2 py-2">{{ m.firstname }} {{ m.lastname }}<div class="text-[10px] text-gray-400">{{ m.username }} · {{ m.role }}</div></td>
              <td class="px-2 py-2 text-gray-600">{{ m.primary_dept_name || '-' }}</td>
              <td class="px-2 py-2 text-right"><button type="button" (click)="removeMember(m)" class="px-2 py-1 rounded-lg bg-white border border-red-300 text-red-700 font-bold"><i class="fas fa-user-minus me-1"></i>เอาออก</button></td>
            </tr>
            <tr *ngIf="!members.length"><td colspan="4" class="px-2 py-4 text-center text-gray-400">ยังไม่มีผู้ใช้ที่ได้รับกลุ่มงานเพิ่มเติม</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- กำหนดกลุ่มงานเพิ่มเติมให้ผู้ใช้รายคน -->
  <div *ngIf="editUser" class="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4" (click)="editUser = null">
    <div id="user-dept-editor" class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col" (click)="$event.stopPropagation()">
      <div class="p-4 border-b border-gray-100">
        <h3 class="text-base font-bold text-gray-800"><i class="fas fa-building text-blue-500 me-2"></i>กลุ่มงานเพิ่มเติม</h3>
        <div class="text-xs text-gray-500">{{ editUser.firstname }} {{ editUser.lastname }} ({{ editUser.username }}) · กลุ่มงานหลัก: {{ editData?.primary?.dept_name || '-' }}</div>
      </div>
      <div class="p-4 overflow-auto card-scroll text-sm space-y-1" *ngIf="editData; else edLoading">
        <p class="text-[11px] text-gray-500 mb-2">ผู้ใช้เห็นและบันทึกผลงานตัวชี้วัดของกลุ่มงานที่ติ๊กได้ทันที (กลุ่มงานหลักเปลี่ยนที่ "แก้ไข")</p>
        <label *ngFor="let d of editOptions" class="flex items-center gap-2 px-2 py-1 rounded hover:bg-blue-50 cursor-pointer">
          <input type="checkbox" class="user-dept-cb" [checked]="checked.has(d.id)" (change)="toggle(d.id)">
          <span>{{ d.dept_name }}</span>
          <span *ngIf="statusOf(d.id) === 'pending'" class="ms-auto text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold">ผู้ใช้ขอไว้</span>
        </label>
        <div *ngIf="!editOptions.length" class="text-xs text-gray-400">ไม่มีกลุ่มงานที่ท่านกำหนดได้</div>
      </div>
      <ng-template #edLoading><div class="p-6 text-center text-gray-400 text-sm"><i class="fas fa-spinner fa-spin"></i></div></ng-template>
      <div class="p-4 border-t border-gray-100 flex justify-end gap-2">
        <button type="button" (click)="editUser = null" class="px-4 py-2 rounded-xl bg-gray-100 text-gray-700 text-xs font-bold">ยกเลิก</button>
        <button type="button" id="btn-user-dept-save" (click)="saveUser()" [disabled]="busy || !editData" class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึก</button>
      </div>
    </div>
  </div>`,
})
export class UserDeptAdminComponent {
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  @Output() changed = new EventEmitter<void>();
  /** จำนวนคำขอรออนุมัติ — ส่งให้หน้าแม่แสดงตัวเลขบนปุ่ม */
  @Output() pendingChange = new EventEmitter<number>();

  showRequests = false;
  tab: 'requests' | 'members' = 'requests';
  requests: any[] = [];
  members: any[] = [];
  editUser: any = null;
  editData: any = null;
  editOptions: { id: number; dept_name: string }[] = [];
  checked = new Set<number>();
  busy = false;
  private allDepts: { id: number; dept_name: string }[] = [];

  /** จำนวนคำขอรออนุมัติ (ปุ่มในหน้าจัดการผู้ใช้) */
  get pendingCount() { return this.requests.length; }

  loadRequests() {
    this.auth.apiGet('/user-dept-requests').subscribe({
      next: (r: any) => { this.requests = r?.data?.requests || []; this.members = r?.data?.members || []; this.pendingChange.emit(this.requests.length); this.cdr.detectChanges(); },
      error: () => { this.requests = []; this.members = []; this.cdr.detectChanges(); },
    });
  }
  openRequests() { this.tab = this.requests.length ? 'requests' : 'members'; this.showRequests = true; this.loadRequests(); }

  decide(r: any, approve: boolean) {
    const go = (note: string) => this.auth.apiPost(`/user-dept-requests/${r.id}/${approve ? 'approve' : 'reject'}`, { note }).subscribe({
      next: () => { this.loadRequests(); this.changed.emit(); },
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ดำเนินการไม่สำเร็จ', 'error'),
    });
    if (approve) { go(''); return; }
    Swal.fire({
      title: 'ไม่อนุมัติคำขอ', input: 'textarea', inputPlaceholder: 'เหตุผล (ส่งถึงผู้ใช้)', showCancelButton: true,
      confirmButtonText: 'ไม่อนุมัติ', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626',
      inputValidator: (v: string) => (String(v || '').trim() ? null : 'กรุณาระบุเหตุผล'),
    }).then(x => { if (x.isConfirmed) go(String(x.value).trim()); });
  }

  removeMember(m: any) {
    Swal.fire({
      title: 'เอากลุ่มงานออก', text: `${m.firstname || ''} ${m.lastname || ''} จะไม่เห็นและบันทึกตัวชี้วัดของกลุ่มงาน "${m.dept_name}" อีก`,
      showCancelButton: true, confirmButtonText: 'เอาออก', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#dc2626',
    }).then(x => {
      if (!x.isConfirmed) return;
      this.auth.apiGet(`/users/${m.user_id}/departments`).subscribe({
        next: (r: any) => {
          const approved = (r?.data?.extras || []).filter((e: any) => e.status === 'approved').map((e: any) => Number(e.dept_id));
          this.auth.apiPut(`/users/${m.user_id}/departments`, { dept_ids: approved.filter((d: number) => d !== Number(m.dept_id)) }).subscribe({
            next: () => { this.loadRequests(); this.changed.emit(); },
            error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ไม่สำเร็จ', 'error'),
          });
        },
        error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ไม่สำเร็จ', 'error'),
      });
    });
  }

  openForUser(user: any) {
    this.editUser = user; this.editData = null; this.checked = new Set();
    const loadDepts = this.allDepts.length ? null : this.auth.apiGet('/departments');
    const fill = () => this.auth.apiGet(`/users/${user.id}/departments`).subscribe({
      next: (r: any) => {
        const d = r?.data;
        this.editData = d;
        const g: number[] | null = d?.grantable ?? null;
        const primary = d?.primary?.dept_id ?? null;
        this.editOptions = this.allDepts.filter(x => (g === null || g.includes(x.id)) && x.id !== Number(primary));
        this.checked = new Set((d?.extras || []).filter((e: any) => e.status === 'approved').map((e: any) => Number(e.dept_id)));
        this.cdr.detectChanges();
      },
      error: (e: any) => { this.editUser = null; Swal.fire('ผิดพลาด', e?.error?.message || 'โหลดไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
    if (!loadDepts) { fill(); return; }
    loadDepts.subscribe({
      next: (r: any) => { this.allDepts = (r?.data || []).map((x: any) => ({ id: Number(x.id), dept_name: x.dept_name })); fill(); },
      error: () => fill(),
    });
  }
  toggle(id: number) { if (this.checked.has(id)) this.checked.delete(id); else this.checked.add(id); }
  statusOf(id: number): string { return (this.editData?.extras || []).find((e: any) => Number(e.dept_id) === id)?.status || ''; }

  saveUser() {
    if (!this.editData || this.busy) return;
    const approved = (this.editData.extras || []).filter((e: any) => e.status === 'approved').map((e: any) => Number(e.dept_id));
    const ids = desiredDeptIds(approved, this.checked, this.editOptions.map(o => o.id), this.editData.primary?.dept_id ?? null);
    this.busy = true;
    this.auth.apiPut(`/users/${this.editUser.id}/departments`, { dept_ids: ids }).subscribe({
      next: (r: any) => {
        this.busy = false; this.editUser = null;
        Swal.fire({ icon: 'success', title: 'สำเร็จ', text: r?.message || 'บันทึกแล้ว', timer: 1800, showConfirmButton: false });
        this.loadRequests(); this.changed.emit();
      },
      error: (e: any) => { this.busy = false; Swal.fire('ผิดพลาด', e?.error?.message || 'บันทึกไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }
}
