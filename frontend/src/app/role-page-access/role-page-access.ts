import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-role-page-access',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './role-page-access.html'
})
export class RolePageAccessComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  isLoading = false;
  isSaving = false;
  showGuide = false;
  searchTerm = '';

  roles: string[] = [];
  pages: { key: string; label: string }[] = [];
  // matrix[pageKey][role] = boolean
  matrix: { [pageKey: string]: { [role: string]: boolean } } = {};

  roleLabels: { [k: string]: string } = {
    admin_ssj: 'admin_ssj — ผู้ดูแลส่วนกลาง (สสจ.)',
    admin_cup: 'admin_cup — ผู้ดูแลอำเภอ',
    admin_hos: 'admin_hos — ผู้ดูแล รพ.',
    admin_sso: 'admin_sso — ผู้ดูแล สสอ.',
    user_cup: 'user_cup — ผู้ใช้งานอำเภอ',
    user_hos: 'user_hos — ผู้ใช้งาน รพ.',
    user_sso: 'user_sso — ผู้ใช้งาน สสอ.',
    user_ssj: 'user_ssj — ผู้ใช้งาน สสจ.',
  };

  ngOnInit() {
    this.load();
  }

  load() {
    this.isLoading = true;
    this.authService.getRolePageAccess().subscribe({
      next: (res: any) => {
        this.isLoading = false;
        if (res.success) {
          this.roles = res.roles;
          this.pages = res.pages;
          const m: { [pageKey: string]: { [role: string]: boolean } } = {};
          for (const p of this.pages) {
            m[p.key] = {};
            for (const r of this.roles) m[p.key][r] = false;
          }
          for (const row of res.data) {
            if (!m[row.page_key]) m[row.page_key] = {};
            m[row.page_key][row.role] = !!row.is_enabled;
          }
          this.matrix = m;
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.isLoading = false;
        this.cdr.detectChanges();
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถโหลดข้อมูลได้', 'error');
      }
    });
  }

  toggle(pageKey: string, role: string) {
    this.matrix[pageKey][role] = !this.matrix[pageKey][role];
  }

  toggleAllForPage(pageKey: string) {
    const allOn = this.roles.every(r => this.matrix[pageKey]?.[r]);
    this.roles.forEach(r => this.matrix[pageKey][r] = !allOn);
  }

  isAllOnForPage(pageKey: string): boolean {
    return this.roles.every(r => this.matrix[pageKey]?.[r]);
  }

  toggleAllForRole(role: string) {
    const allOn = this.pages.every(p => this.matrix[p.key]?.[role]);
    this.pages.forEach(p => this.matrix[p.key][role] = !allOn);
  }

  isAllOnForRole(role: string): boolean {
    return this.pages.every(p => this.matrix[p.key]?.[role]);
  }

  get filteredPages() {
    const q = this.searchTerm.trim().toLowerCase();
    if (!q) return this.pages;
    return this.pages.filter(p => p.label.toLowerCase().includes(q) || p.key.toLowerCase().includes(q));
  }

  save() {
    Swal.fire({
      title: 'ยืนยันบันทึกสิทธิ์การเข้าถึงหน้า',
      html: '<p class="text-sm text-gray-600">การเปลี่ยนแปลงจะมีผลทันทีกับผู้ใช้งานที่ login อยู่ในระบบ (ทั้งเมนูที่เห็นและสิทธิ์เรียกใช้งานจริง)</p>',
      icon: 'question', showCancelButton: true, confirmButtonColor: '#4f46e5',
      confirmButtonText: '<i class="fas fa-save mr-1"></i>บันทึก', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      const items: { role: string; page_key: string; is_enabled: boolean }[] = [];
      for (const page of this.pages) {
        for (const role of this.roles) {
          items.push({ role, page_key: page.key, is_enabled: !!this.matrix[page.key]?.[role] });
        }
      }
      this.isSaving = true;
      this.cdr.detectChanges();
      this.authService.saveRolePageAccess(items).subscribe({
        next: (res: any) => {
          this.isSaving = false;
          this.cdr.detectChanges();
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
        },
        error: (err: any) => {
          this.isSaving = false;
          this.cdr.detectChanges();
          Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถบันทึกได้', 'error');
        }
      });
    });
  }
}
