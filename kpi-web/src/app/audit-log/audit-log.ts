import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './audit-log.html'
})
export class AuditLogComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  logs: any[] = [];
  filteredLogs: any[] = [];
  searchTerm: string = '';
  
  // Pagination
  currentPage: number = 1;
  pageSize: number = 20;
  totalPages: number = 0;

  isSidebarOpen: boolean = true;
  currentUserDisplay: any = null;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;
  unreadNotifCount: number = 0;
  notifications: any[] = [];
  showNotifDropdown: boolean = false;

  ngOnInit() {
    this.currentUserDisplay = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    if (!this.isAdmin) {
      Swal.fire('Access Denied', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadLogs();
    this.loadSettings();
    this.loadPendingKpiCount();
    this.loadUnreadNotifCount();
  }

  loadSettings() {
    this.authService.getSettings().subscribe({
      next: (res) => {
        if (res.success && res.data) {
          const versionSetting = res.data.find((s: any) => s.setting_key === 'system_version');
          if (versionSetting) {
            this.systemVersion = versionSetting.setting_value;
          }
        }
      }
    });
  }

  loadPendingKpiCount() {
    this.authService.getKpiResults().subscribe({
      next: (res) => {
        if (res.success) {
          this.pendingKpiCount = res.data.filter((item: any) => item.indicator_status === 'pending').length;
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadLogs() {
    this.authService.getSystemLogs().subscribe({
      next: (res) => {
        if (res.success) {
          this.logs = res.data;
          this.applyFilters();
          this.cdr.detectChanges();
        }
      },
      error: (err) => console.error('Error loading logs:', err)
    });
  }

  backupLogs() {
    Swal.fire({
      title: 'สำรองข้อมูล Logs',
      text: 'คุณต้องการสำรองข้อมูล Logs ทั้งหมดเป็นไฟล์ CSV ใช่หรือไม่?',
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#10b981',
      confirmButtonText: 'ใช่, สำรองข้อมูล',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.backupLogs().subscribe({
          next: (blob: Blob) => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `korat_kpi_logs_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            Swal.fire('สำเร็จ', 'สำรองข้อมูลเรียบร้อยแล้ว', 'success');
          },
          error: (err) => {
            console.error('Backup error:', err);
            Swal.fire('ผิดพลาด', 'ไม่สามารถสำรองข้อมูลได้', 'error');
          }
        });
      }
    });
  }

  clearLogs() {
    Swal.fire({
      title: 'ยืนยันการล้าง Logs',
      text: 'การดำเนินการนี้จะลบประวัติการใช้งานทั้งหมดและไม่สามารถเรียกคืนได้ คุณแน่ใจหรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: 'ใช่, ล้างข้อมูลทั้งหมด',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        // ให้ยืนยันอีกครั้งเพื่อความปลอดภัย
        Swal.fire({
          title: 'ยืนยันอีกครั้ง',
          text: 'กรุณาพิมพ์ "CONFIRM" เพื่อยืนยันการล้างข้อมูล',
          input: 'text',
          inputAttributes: {
            autocapitalize: 'off'
          },
          showCancelButton: true,
          confirmButtonText: 'ยืนยัน',
          cancelButtonText: 'ยกเลิก',
          showLoaderOnConfirm: true,
          preConfirm: (login) => {
            if (login !== 'CONFIRM') {
              Swal.showValidationMessage('คำยืนยันไม่ถูกต้อง');
            }
            return login === 'CONFIRM';
          },
          allowOutsideClick: () => !Swal.isLoading()
        }).then((result) => {
          if (result.isConfirmed) {
            this.authService.clearLogs().subscribe({
              next: (res) => {
                if (res.success) {
                  Swal.fire('สำเร็จ', 'ล้างข้อมูล Logs เรียบร้อยแล้ว', 'success');
                  this.loadLogs();
                }
              },
              error: (err) => {
                console.error('Clear error:', err);
                Swal.fire('ผิดพลาด', 'ไม่สามารถล้างข้อมูลได้', 'error');
              }
            });
          }
        });
      }
    });
  }

  applyFilters() {
    this.filteredLogs = this.logs.filter(log => {
      const search = this.searchTerm.toLowerCase();
      const username = log.username ? log.username.toLowerCase() : '';
      const action = log.action_type ? log.action_type.toLowerCase() : '';
      const table = log.table_name ? log.table_name.toLowerCase() : '';
      
      // แปลง JSON details เป็น string เพื่อค้นหา
      let details = '';
      try {
        details = log.new_value ? JSON.stringify(log.new_value).toLowerCase() : '';
      } catch (e) {
        details = String(log.new_value).toLowerCase();
      }
      
      return username.includes(search) || action.includes(search) || table.includes(search) || details.includes(search);
    });
    this.totalPages = Math.ceil(this.filteredLogs.length / this.pageSize);
    this.currentPage = 1;
  }

  get pagedLogs() {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredLogs.slice(startIndex, startIndex + this.pageSize);
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  // --- Change Password ---
  showChangePasswordModal: boolean = false;
  changePasswordForm: any = { currentPassword: '', newPassword: '', confirmPassword: '' };
  showCurrentPw: boolean = false;
  showNewPw: boolean = false;
  showConfirmPw: boolean = false;

  openChangePasswordModal() {
    this.changePasswordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
    this.showCurrentPw = false;
    this.showNewPw = false;
    this.showConfirmPw = false;
    this.showChangePasswordModal = true;
  }

  closeChangePasswordModal() {
    this.showChangePasswordModal = false;
  }

  saveNewPassword() {
    if (!this.changePasswordForm.currentPassword || !this.changePasswordForm.newPassword || !this.changePasswordForm.confirmPassword) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบทุกช่อง', 'warning');
      return;
    }
    if (this.changePasswordForm.newPassword !== this.changePasswordForm.confirmPassword) {
      Swal.fire('แจ้งเตือน', 'รหัสผ่านใหม่และยืนยันรหัสผ่านไม่ตรงกัน', 'warning');
      return;
    }
    if (this.changePasswordForm.newPassword.length < 6) {
      Swal.fire('แจ้งเตือน', 'รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร', 'warning');
      return;
    }
    this.authService.changePassword({
      currentPassword: this.changePasswordForm.currentPassword,
      newPassword: this.changePasswordForm.newPassword
    }).subscribe({
      next: (res) => {
        if (res.success) {
          this.closeChangePasswordModal();
          this.cdr.detectChanges();
          Swal.fire({ title: 'เปลี่ยนรหัสผ่านสำเร็จ', text: 'รหัสผ่านของคุณถูกเปลี่ยนเรียบร้อยแล้ว', icon: 'success', confirmButtonColor: '#28a745' });
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเปลี่ยนรหัสผ่านได้', 'error')
    });
  }

  loadUnreadNotifCount() {
    this.authService.getUnreadNotificationCount().subscribe({
      next: (res: any) => {
        if (res.success) {
          this.unreadNotifCount = res.count;
          this.cdr.detectChanges();
        }
      }
    });
  }

  toggleNotifDropdown() {
    this.showNotifDropdown = !this.showNotifDropdown;
    if (this.showNotifDropdown) {
      this.authService.getNotifications().subscribe({
        next: (res: any) => {
          if (res.success) {
            this.notifications = res.data;
            this.cdr.detectChanges();
          }
        }
      });
    }
  }

  markNotifAsRead(ids: number[]) {
    this.authService.markNotificationsRead({ ids }).subscribe({
      next: () => {
        this.loadUnreadNotifCount();
        this.cdr.detectChanges();
      }
    });
  }

  markAllNotifsRead() {
    this.authService.markNotificationsRead({ all: true }).subscribe({
      next: () => {
        this.unreadNotifCount = 0;
        this.notifications.forEach(n => n.is_read = 1);
        this.cdr.detectChanges();
      }
    });
  }

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}