import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
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

  currentPage: number = 1;
  pageSize: number = 10;
  totalPages: number = 0;

  departments: any[] = [];
  hospitals: any[] = [];
  districts: any[] = [];
  filteredHospitals: any[] = [];
  selectedDistrictId: string = '';

  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  loggedInUser: any = null;

  showModal: boolean = false;
  isEditMode: boolean = false;
  currentUser: any = { id: null, username: '', password: '', role: 'user', dept_id: '', firstname: '', lastname: '', hospcode: '', phone: '', email: '', cid: '' };

  selectedStatus: string = '';

  // Password & validation
  confirmPassword: string = '';
  showPassword: boolean = false;
  showConfirmPassword: boolean = false;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    this.loggedInUser = this.authService.getUser();

    this.loadUsers();
    this.loadDepartments();
    this.loadHospitals();
    this.loadDistricts();
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
        if (res.success) { this.departments = res.data; this.cdr.detectChanges(); }
      }
    });
  }

  loadHospitals() {
    this.authService.getHospitals().subscribe({
      next: (res) => {
        if (res.success) { this.hospitals = res.data; this.cdr.detectChanges(); }
      }
    });
  }

  loadDistricts() {
    this.authService.getDistricts().subscribe({
      next: (res) => {
        if (res.success) { this.districts = res.data; this.cdr.detectChanges(); }
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
                          (user.lastname && user.lastname.toLowerCase().includes(search)) ||
                          (user.email && user.email.toLowerCase().includes(search));

      const matchRole = this.selectedRole === '' || user.role === this.selectedRole;
      const matchDept = this.selectedDept === '' || (user.dept_id && user.dept_id.toString() === this.selectedDept);
      const matchStatus = this.selectedStatus === '' ||
                          (this.selectedStatus === 'pending' && user.is_approved === 0) ||
                          (this.selectedStatus === 'approved' && user.is_approved === 1) ||
                          (this.selectedStatus === 'rejected' && user.is_approved === -1);

      return matchSearch && matchRole && matchDept && matchStatus;
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
    this.confirmPassword = '';
    this.showPassword = false;
    this.showConfirmPassword = false;
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
      this.currentUser = {
        id: null, username: '', password: '', role: 'user',
        dept_id: this.isAdmin ? '' : (this.loggedInUser?.dept_id || ''),
        firstname: '', lastname: '', hospcode: '', phone: '', email: '', cid: ''
      };
      this.selectedDistrictId = '';
      this.filteredHospitals = [];
    }
  }

  closeModal() {
    this.showModal = false;
  }

  // === Phone formatting ===
  onPhoneInput(event: any) {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 10) value = value.substring(0, 10);
    this.currentUser.phone = value;
    event.target.value = this.formatPhoneDisplay(value);
  }

  formatPhoneDisplay(phone: string): string {
    if (!phone) return '';
    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 2) return digits;
    if (digits.length <= 6) return digits.substring(0, 2) + '-' + digits.substring(2);
    return digits.substring(0, 2) + '-' + digits.substring(2, 6) + '-' + digits.substring(6, 10);
  }

  // === Password validation ===
  validatePassword(pw: string): string | null {
    if (!pw) return null;
    if (pw.length < 6) return 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร';
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(pw)) {
      return 'รหัสผ่านต้องเป็น a-z, A-Z, 0-9 หรืออักขระพิเศษเท่านั้น';
    }
    return null;
  }

  // === Phone validation ===
  validatePhone(phone: string): boolean {
    if (!phone) return false;
    const digits = phone.replace(/\D/g, '');
    return digits.length === 10;
  }

  saveUser() {
    // ตรวจสอบข้อมูลครบถ้วน
    if (!this.currentUser.username ||
        !this.currentUser.firstname ||
        !this.currentUser.lastname ||
        !this.currentUser.phone ||
        !this.currentUser.role) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง', 'warning');
      return;
    }

    // ตรวจสอบเบอร์โทร 10 หลัก
    if (!this.validatePhone(this.currentUser.phone)) {
      Swal.fire('แจ้งเตือน', 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก', 'warning');
      return;
    }

    // ตรวจสอบ password สำหรับสร้างใหม่
    if (!this.isEditMode) {
      if (!this.currentUser.password) {
        Swal.fire('แจ้งเตือน', 'กรุณากรอกรหัสผ่าน', 'warning');
        return;
      }
      const pwError = this.validatePassword(this.currentUser.password);
      if (pwError) {
        Swal.fire('แจ้งเตือน', pwError, 'warning');
        return;
      }
      if (this.currentUser.password !== this.confirmPassword) {
        Swal.fire('แจ้งเตือน', 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน', 'warning');
        return;
      }
    }

    // ตรวจสอบ password สำหรับแก้ไข (ถ้ากรอก)
    if (this.isEditMode && this.currentUser.password) {
      const pwError = this.validatePassword(this.currentUser.password);
      if (pwError) {
        Swal.fire('แจ้งเตือน', pwError, 'warning');
        return;
      }
      if (this.currentUser.password !== this.confirmPassword) {
        Swal.fire('แจ้งเตือน', 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน', 'warning');
        return;
      }
    }

    // Strip dashes from phone before saving
    const userData = { ...this.currentUser, phone: this.currentUser.phone.replace(/\D/g, '') };

    if (this.isEditMode) {
      this.authService.updateUser(userData.id, userData).subscribe({
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
      this.authService.createUser(userData).subscribe({
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

  approveUser(user: any) {
    Swal.fire({
      title: 'อนุมัติการลงทะเบียน',
      html: `<p>ยืนยันอนุมัติผู้ใช้งาน <b>${user.firstname} ${user.lastname}</b> (${user.username})</p>
             <p class="text-sm text-gray-500 mt-1">สิทธิ์: ${user.role} | หน่วยบริการ: ${user.hosname || user.hospcode}</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#16a34a',
      confirmButtonText: 'อนุมัติ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.approveUser(user.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'อนุมัติแล้ว', timer: 1500, showConfirmButton: false });
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถอนุมัติได้', 'error')
        });
      }
    });
  }

  rejectUser(user: any) {
    Swal.fire({
      title: 'ปฏิเสธการลงทะเบียน',
      html: `<p>ยืนยันปฏิเสธผู้ใช้งาน <b>${user.firstname} ${user.lastname}</b> (${user.username})?</p>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: 'ปฏิเสธ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.rejectUser(user.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'ปฏิเสธแล้ว', timer: 1500, showConfirmButton: false });
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปฏิเสธได้', 'error')
        });
      }
    });
  }

  toggleActive(user: any) {
    const willActivate = user.is_active === 0;
    const actionText = willActivate ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
    Swal.fire({
      title: `${actionText}บัญชีผู้ใช้`,
      html: `<p>ยืนยัน<b>${actionText}</b>บัญชี <b>${user.firstname} ${user.lastname}</b> (${user.username})?</p>
             ${!willActivate ? '<p class="text-sm text-orange-500 mt-1">ผู้ใช้งานนี้จะไม่สามารถเข้าสู่ระบบได้</p>' : ''}`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: willActivate ? '#16a34a' : '#d97706',
      confirmButtonText: actionText,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.toggleUserActive(user.id, willActivate).subscribe({
          next: (res) => {
            if (res.success) {
              user.is_active = willActivate ? 1 : 0;
              Swal.fire({ icon: 'success', title: res.message, timer: 1500, showConfirmButton: false });
              this.cdr.detectChanges();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเปลี่ยนสถานะได้', 'error')
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
}
