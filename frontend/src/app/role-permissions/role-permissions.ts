import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-role-permissions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './role-permissions.html'
})
export class RolePermissionsComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  roles: any[] = [];
  isSaving = false;

  ngOnInit() {
    this.load();
  }

  load() {
    this.authService.getRolePermissions().subscribe({
      next: (res) => {
        if (res.success) {
          this.roles = res.data || [];
          this.cdr.detectChanges();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'โหลดข้อมูลไม่สำเร็จ', 'error')
    });
  }

  isSuperAdminRole(role: string): boolean {
    return role === 'super_admin';
  }

  // preset: แก้ผลงานอย่างเดียว
  presetActualOnly(r: any) {
    if (this.isSuperAdminRole(r.role)) return;
    r.can_edit_actual = 1;
    r.can_edit_target = 0;
  }
  // preset: แก้เป้าหมาย + ผลงาน
  presetBoth(r: any) {
    if (this.isSuperAdminRole(r.role)) return;
    r.can_edit_actual = 1;
    r.can_edit_target = 1;
  }
  // preset: ดูอย่างเดียว
  presetReadonly(r: any) {
    if (this.isSuperAdminRole(r.role)) return;
    r.can_edit_actual = 0;
    r.can_edit_target = 0;
  }

  toggle(r: any, field: string) {
    if (this.isSuperAdminRole(r.role)) return;
    r[field] = r[field] ? 0 : 1;
  }

  save() {
    this.isSaving = true;
    const payload = this.roles
      .filter(r => !this.isSuperAdminRole(r.role))
      .map(r => ({
        role: r.role,
        can_edit_actual: r.can_edit_actual ? 1 : 0,
        can_edit_target: r.can_edit_target ? 1 : 0,
        can_delete: r.can_delete ? 1 : 0
      }));
    this.authService.updateRolePermissions(payload).subscribe({
      next: (res) => {
        this.isSaving = false;
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', text: 'สิทธิ์มีผลทันที (ผู้ใช้ refresh หน้าจะเห็นผล)', timer: 2000, showConfirmButton: false });
          this.load();
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isSaving = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error');
        this.cdr.detectChanges();
      }
    });
  }
}
