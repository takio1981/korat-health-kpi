import { Component, OnInit, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { Router, RouterModule, RouterOutlet, NavigationEnd, ActivatedRoute } from '@angular/router';
import { AuthService } from '../services/auth';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';
import { filter, map, mergeMap } from 'rxjs/operators';
import { Title } from '@angular/platform-browser';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, RouterOutlet],
  templateUrl: './layout.html',
  styleUrls: ['./layout.css']
})
export class LayoutComponent implements OnInit {
  private router = inject(Router);
  private activatedRoute = inject(ActivatedRoute);
  private titleService = inject(Title);
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);

  pageTitle: string = '';

  isSidebarOpen: boolean = true;
  isLoading: boolean = false;
  isAdmin: boolean = false;       // admin_ssj + super_admin (ส่วนกลาง)
  isAnyAdmin: boolean = false;    // admin_cup + admin_ssj + super_admin (ทุกระดับ admin)
  isSuperAdmin: boolean = false;
  currentUser: any = null;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;
  pendingStats: any = { deptCount: 0, hosCount: 0, indicatorCount: 0 };

  showChangePasswordModal: boolean = false;
  changePasswordForm: any = { currentPassword: '', newPassword: '', confirmPassword: '' };
  showCurrentPw: boolean = false;
  showNewPw: boolean = false;
  showConfirmPw: boolean = false;

  notifications: any[] = [];
  unreadNotifCount: number = 0;
  showNotifDropdown: boolean = false;

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin_ssj', 'super_admin'].includes(role);
    this.isAnyAdmin = ['admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj', 'super_admin'].includes(role);
    this.isSuperAdmin = role === 'super_admin';
    this.loadSettings();
    this.loadPendingCount();
    this.loadUnreadNotifCount();
    this.checkLoginNotifications();

    // Subscribe shared unread count → update badge realtime
    this.authService.unreadCount$.subscribe(count => {
      this.unreadNotifCount = count;
      this.cdr.detectChanges();
    });

    // Subscribe shared pending stats → update badge realtime
    this.authService.pendingStats$.subscribe(stats => {
      this.pendingStats = stats;
      this.pendingKpiCount = stats.indicatorCount || 0;
      this.cdr.detectChanges();
    });

    // Set title from current route immediately (for initial navigation)
    let currentRoute = this.activatedRoute;
    while (currentRoute.firstChild) currentRoute = currentRoute.firstChild;
    const initialTitle = currentRoute.snapshot.data['title'];
    if (initialTitle) {
      this.pageTitle = initialTitle;
      this.titleService.setTitle('Korat Health KPI | ' + this.pageTitle);
    }

    // Listen for future navigation changes
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      map(() => this.activatedRoute),
      map(route => {
        while (route.firstChild) route = route.firstChild;
        return route;
      }),
      filter(route => route.outlet === 'primary'),
      mergeMap(route => route.data)
    ).subscribe(data => {
      this.pageTitle = data['title'] || 'Dashboard';
      this.titleService.setTitle('Korat Health KPI | ' + this.pageTitle);
    });
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

  loadPendingCount() {
    if (this.isAdmin) {
      this.authService.refreshPendingStats();
    }
  }

  logout() {
    Swal.fire({
      title: 'ยืนยันการออกจากระบบ',
      text: "คุณต้องการออกจากระบบใช่หรือไม่?",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#3085d6',
      cancelButtonColor: '#d33',
      confirmButtonText: 'ใช่, ออกจากระบบ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        sessionStorage.removeItem('welcomeShown');
        this.authService.logout();
        this.router.navigate(['/login']);
      }
    });
  }

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

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  refreshDashboard(): void {
    window.location.reload();
  }

  // ========== Notification Methods ==========
  loadUnreadNotifCount() {
    this.authService.refreshUnreadCount();
  }

  loadNotifications() {
    this.authService.getNotifications().subscribe({
      next: (res) => {
        if (res.success) {
          this.notifications = res.data;
          this.cdr.detectChanges();
        }
      },
      error: (err) => console.error('Error loading notifications:', err)
    });
  }

  toggleNotifDropdown() {
    this.showNotifDropdown = !this.showNotifDropdown;
    if (this.showNotifDropdown) {
      this.loadNotifications();
    }
  }

  markAsRead(ids: number[]) {
    this.authService.markNotificationsRead({ ids }).subscribe({
      next: () => {
        this.authService.refreshUnreadCount();
        this.loadNotifications();
      }
    });
  }

  markAllAsRead() {
    this.authService.markNotificationsRead({ all: true }).subscribe({
      next: () => {
        this.notifications.forEach(n => n.is_read = 1);
        this.authService.refreshUnreadCount();
        this.cdr.detectChanges();
      }
    });
  }

  checkLoginNotifications() {
    const welcomeShown = sessionStorage.getItem('welcomeShown');
    if (welcomeShown) return;

    this.authService.getUnreadNotificationCount().subscribe({
      next: (res) => {
        if (res.success && res.count > 0) {
          Swal.fire({
            title: 'การแจ้งเตือน',
            html: `คุณมีการแจ้งเตือนที่ยังไม่ได้อ่าน <b>${res.count}</b> รายการ`,
            icon: 'info',
            confirmButtonText: 'ดูรายละเอียด',
            showCancelButton: true,
            cancelButtonText: 'ปิด',
            confirmButtonColor: '#10b981'
          }).then((result) => {
            if (result.isConfirmed) {
              this.router.navigate(['/notifications']);
            }
          });
          sessionStorage.setItem('welcomeShown', 'true');
        }
      }
    });
  }
}
