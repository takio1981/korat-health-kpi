import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './user-management.html'
})
export class UserManagementComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  users: any[] = [];
  filteredUsers: any[] = []; 
  
  searchTerm: string = '';
  selectedRole: string = '';
  selectedDept: string = '';
  currentUserDisplay: any = null; 

  currentPage: number = 1;
  pageSize: number = 10;
  totalPages: number = 0;

  departments: any[] = [];
  hospitals: any[] = []; 
  districts: any[] = []; 
  filteredHospitals: any[] = []; 
  selectedDistrictId: string = ''; 
  isSidebarOpen: boolean = true;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;

  unreadNotifCount: number = 0;
  notifications: any[] = [];
  showNotifDropdown: boolean = false;

  showModal: boolean = false;
  isEditMode: boolean = false;
  currentUser: any = { id: null, username: '', password: '', role: 'user', dept_id: '', firstname: '', lastname: '', hospcode: '', phone: '' };

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
    this.loadUsers();
    this.loadDepartments();
    this.loadHospitals();
    this.loadDistricts();
    this.loadSettings();
    this.loadPendingKpiCount();
    this.loadUnreadNotifCount();
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

  loadUsers() {
    this.authService.getUsers().subscribe({
      next: (res) => {
        if (res.success) {
          this.users = res.data;
          this.applyFilters();
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadDepartments() {
    this.authService.getDepartments().subscribe({
      next: (res) => {
        if (res.success) this.departments = res.data;
      }
    });
  }

  loadHospitals() {
    this.authService.getHospitals().subscribe({
      next: (res) => {
        if (res.success) this.hospitals = res.data;
      }
    });
  }

  loadDistricts() {
    this.authService.getDistricts().subscribe({
      next: (res) => {
        if (res.success) this.districts = res.data;
      }
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

  onDistrictChange() {
    this.filteredHospitals = this.hospitals.filter(h => h.distid === this.selectedDistrictId);
    this.currentUser.hospcode = '';
    this.cdr.detectChanges();
  }

  applyFilters() {
    this.filteredUsers = this.users.filter(user => {
      const search = this.searchTerm.toLowerCase();
      const matchSearch = (user.username && user.username.toLowerCase().includes(search)) ||
                          (user.dept_name && user.dept_name.toLowerCase().includes(search)) ||
                          (user.firstname && user.firstname.toLowerCase().includes(search)) ||
                          (user.lastname && user.lastname.toLowerCase().includes(search));
      
      const matchRole = this.selectedRole === '' || user.role === this.selectedRole;
      const matchDept = this.selectedDept === '' || (user.dept_id && user.dept_id.toString() === this.selectedDept);

      return matchSearch && matchRole && matchDept;
    });

    this.totalPages = Math.ceil(this.filteredUsers.length / this.pageSize);
    this.currentPage = 1;
  }

  get pagedUsers() {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredUsers.slice(startIndex, startIndex + this.pageSize);
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  openModal(user: any = null) {
    this.showModal = true;
    if (user) {
      this.isEditMode = true;
      this.currentUser = { ...user, password: '' };
      
      const currentHospital = this.hospitals.find(h => h.hoscode === user.hospcode);
      if (currentHospital) {
        this.selectedDistrictId = currentHospital.distid;
        this.filteredHospitals = this.hospitals.filter(h => h.distid === this.selectedDistrictId);
      } else {
        this.selectedDistrictId = '';
        this.filteredHospitals = this.hospitals;
      }
    } else {
      this.isEditMode = false;
      this.currentUser = { id: null, username: '', password: '', role: 'user', dept_id: '', firstname: '', lastname: '', hospcode: '', phone: '' };
      this.selectedDistrictId = '';
      this.filteredHospitals = [];
    }
  }

  closeModal() {
    this.showModal = false;
  }

  saveUser() {
    if (!this.currentUser.username || 
        (!this.isEditMode && !this.currentUser.password) ||
        !this.currentUser.firstname ||
        !this.currentUser.lastname ||
        !this.currentUser.phone ||
        !this.currentUser.role) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง', 'warning');
      return;
    }

    if (this.isEditMode) {
      this.authService.updateUser(this.currentUser.id, this.currentUser).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire('สำเร็จ', 'แก้ไขข้อมูลผู้ใช้งานเรียบร้อย', 'success').then(() => {
              this.loadUsers();
              this.closeModal();
            });
          }
        },
        error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถแก้ไขข้อมูลได้', 'error')
      });
    } else {
      this.authService.createUser(this.currentUser).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire('สำเร็จ', 'สร้างผู้ใช้งานใหม่เรียบร้อย', 'success').then(() => {
              this.loadUsers();
              this.closeModal();
            });
          }
        },
        error: (err) => Swal.fire('ผิดพลาด', err.error.message || 'ไม่สามารถสร้างผู้ใช้งานได้', 'error')
      });
    }
  }

  deleteUser(id: number) {
    Swal.fire({
      title: 'ยืนยันการลบ',
      text: "คุณต้องการลบผู้ใช้งานนี้ใช่หรือไม่?",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      confirmButtonText: 'ลบผู้ใช้งาน',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.deleteUser(id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('ลบสำเร็จ', 'ผู้ใช้งานถูกลบออกจากระบบแล้ว', 'success');
              this.loadUsers();
            }
          },
          error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถลบผู้ใช้งานได้', 'error')
        });
      }
    });
  }

  resetPassword(user: any) {
    Swal.fire({
      title: 'รีเซ็ตรหัสผ่าน',
      text: `คุณต้องการรีเซ็ตรหัสผ่านของ ${user.username} เป็น "password123" ใช่หรือไม่?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#f59e0b',
      cancelButtonColor: '#d33',
      confirmButtonText: 'ใช่, รีเซ็ตเลย',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.resetPassword(user.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', res.message, 'success');
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถรีเซ็ตรหัสผ่านได้', 'error')
        });
      }
    });
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

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
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
}
