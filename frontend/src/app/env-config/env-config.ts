import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-env-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './env-config.html'
})
export class EnvConfigComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  configItems: any[] = [];
  editValues: any = {};
  isLoading = false;
  activeGroup = 'all';
  showSensitive: any = {};

  groups = [
    { id: 'all', label: 'ทั้งหมด', icon: 'fa-list', color: 'gray' },
    { id: 'database', label: 'Database', icon: 'fa-database', color: 'green' },
    { id: 'email', label: 'Email SMTP', icon: 'fa-envelope', color: 'amber' },
    { id: 'notification', label: 'แจ้งเตือน', icon: 'fa-bell', color: 'blue' },
    { id: 'app', label: 'แอปพลิเคชัน', icon: 'fa-cog', color: 'purple' },
    { id: 'hdc', label: 'HDC Database', icon: 'fa-cloud', color: 'teal' }
  ];

  ngOnInit() {
    if (this.authService.getUserRole() !== 'super_admin') {
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadConfig();
  }

  loadConfig() {
    this.isLoading = true;
    this.authService.getEnvConfig().subscribe({
      next: (res: any) => {
        this.isLoading = false;
        if (res.success) {
          this.configItems = res.data;
          this.editValues = {};
          this.configItems.forEach((item: any) => { this.editValues[item.key] = ''; });
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.isLoading = false; Swal.fire('ผิดพลาด', err.error?.message || 'โหลดไม่ได้', 'error'); }
    });
  }

  get filteredItems(): any[] {
    if (this.activeGroup === 'all') return this.configItems;
    return this.configItems.filter(i => i.group === this.activeGroup);
  }

  getGroupColor(group: string): string {
    return this.groups.find(g => g.id === group)?.color || 'gray';
  }

  getSourceBadge(source: string) {
    if (source === 'db') return { text: 'DB', class: 'bg-blue-100 text-blue-700' };
    if (source === 'env') return { text: '.env', class: 'bg-green-100 text-green-700' };
    return { text: 'ไม่มี', class: 'bg-red-100 text-red-600' };
  }

  hasChanges(): boolean {
    return Object.values(this.editValues).some(v => v !== '');
  }

  changedCount(): number {
    return Object.values(this.editValues).filter(v => v !== '').length;
  }

  saveConfig() {
    const settings = Object.entries(this.editValues)
      .filter(([_, v]) => v !== '')
      .map(([key, value]) => ({ key, value }));

    if (settings.length === 0) { Swal.fire('แจ้งเตือน', 'ไม่มีรายการที่เปลี่ยนแปลง', 'info'); return; }

    Swal.fire({
      title: 'ยืนยันบันทึก',
      html: `<p>บันทึก <b>${settings.length}</b> รายการลงฐานข้อมูล</p>
             <p class="text-xs text-amber-600 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>ค่าที่บันทึกจะ override .env | บางค่ามีผลหลัง restart server</p>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#16a34a',
      confirmButtonText: '<i class="fas fa-save mr-1"></i> บันทึก', cancelButtonText: 'ยกเลิก'
    }).then((r) => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.saveEnvConfig(settings).subscribe({
        next: (res: any) => {
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
          this.loadConfig();
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่ได้', 'error')
      });
    });
  }
}
