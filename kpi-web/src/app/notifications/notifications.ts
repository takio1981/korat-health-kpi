import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './notifications.html',
  styleUrl: './notifications.css'
})
export class NotificationsComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  notifications: any[] = [];
  filteredNotifications: any[] = [];
  activeFilter: string = 'all';
  isLoading: boolean = false;

  isSidebarOpen: boolean = true;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  currentUser: any = null;
  currentUserDisplay: any = null;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;
  unreadNotifCount: number = 0;

  showChangePasswordModal: boolean = false;
  changePasswordForm: any = { currentPassword: '', newPassword: '', confirmPassword: '' };
  showCurrentPw: boolean = false;
  showNewPw: boolean = false;
  showConfirmPw: boolean = false;

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    this.currentUserDisplay = this.currentUser;
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin', 'super_admin'].includes(role);
    this.isSuperAdmin = role === 'super_admin';
    this.loadNotifications();
    this.loadPendingCount();
    this.loadSettings();
    this.loadUnreadNotifCount();
  }

  loadNotifications() {
    this.isLoading = true;
    this.authService.getNotifications().subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.notifications = res.data;
          this.applyFilter();
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error loading notifications:', err);
      }
    });
  }

  applyFilter() {
    if (this.activeFilter === 'all') {
      this.filteredNotifications = this.notifications;
    } else if (this.activeFilter === 'unread') {
      this.filteredNotifications = this.notifications.filter(n => !n.is_read);
    } else if (this.activeFilter === 'approve') {
      this.filteredNotifications = this.notifications.filter(n => n.type === 'approve');
    } else if (this.activeFilter === 'reject') {
      this.filteredNotifications = this.notifications.filter(n => n.type === 'reject');
    }
  }

  setFilter(filter: string) {
    this.activeFilter = filter;
    this.applyFilter();
  }

  markAsRead(notif: any) {
    if (notif.is_read) return;
    this.authService.markNotificationsRead({ ids: [notif.id] }).subscribe({
      next: () => {
        notif.is_read = 1;
        this.loadUnreadNotifCount();
        this.cdr.detectChanges();
      }
    });
  }

  markAllAsRead() {
    this.authService.markNotificationsRead({ all: true }).subscribe({
      next: () => {
        this.notifications.forEach(n => n.is_read = 1);
        this.unreadNotifCount = 0;
        this.applyFilter();
        this.cdr.detectChanges();
        Swal.fire('สำเร็จ', 'อ่านการแจ้งเตือนทั้งหมดแล้ว', 'success');
      }
    });
  }

  loadUnreadNotifCount() {
    this.authService.getUnreadNotificationCount().subscribe({
      next: (res) => {
        if (res.success) this.unreadNotifCount = res.count;
        this.cdr.detectChanges();
      }
    });
  }

  loadPendingCount() {
    if (this.isAdmin) {
      this.authService.getPendingKpiCount().subscribe({
        next: (res) => {
          if (res.success) this.pendingKpiCount = res.count;
          this.cdr.detectChanges();
        }
      });
    }
  }

  loadSettings() {
    this.authService.getSettings().subscribe({
      next: (res) => {
        if (res.success && res.data) {
          const v = res.data.find((s: any) => s.setting_key === 'system_version');
          if (v) this.systemVersion = v.setting_value;
        }
        this.cdr.detectChanges();
      }
    });
  }

  getTimeAgo(dateStr: string): string {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'เมื่อสักครู่';
    if (diffMin < 60) return `${diffMin} นาทีที่แล้ว`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} ชั่วโมงที่แล้ว`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay} วันที่แล้ว`;
    return `${Math.floor(diffDay / 30)} เดือนที่แล้ว`;
  }

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  openChangePasswordModal() {
    this.showChangePasswordModal = true;
    this.changePasswordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
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
          Swal.fire({
            title: 'เปลี่ยนรหัสผ่านสำเร็จ',
            text: res.message,
            icon: 'success',
            showConfirmButton: true,
            showDenyButton: true,
            confirmButtonText: 'ตกลง',
            denyButtonText: 'กลับหน้า Login',
            denyButtonColor: '#3b82f6'
          }).then((result) => {
            if (result.isDenied) {
              this.authService.logout();
              this.router.navigate(['/login']);
            }
          });
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเปลี่ยนรหัสผ่านได้', 'error')
    });
  }
}
