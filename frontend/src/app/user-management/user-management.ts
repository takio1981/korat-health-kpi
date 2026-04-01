import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
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
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  users: any[] = [];
  filteredUsers: any[] = [];

  searchTerm: string = '';
  selectedRole: string = '';
  selectedDept: string = '';
  selectedHospcode: string = '';

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
  pendingCount: number = 0;
  maintenanceMode: boolean = false;
  maintenanceMessage: string = 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน';

  // Password & validation
  confirmPassword: string = '';
  showPassword: boolean = false;
  showConfirmPassword: boolean = false;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj', 'super_admin'].includes(role);
    this.isSuperAdmin = role === 'super_admin';
    this.loggedInUser = this.authService.getUser();

    // อ่าน query param ?status=pending จาก URL (เช่น navigate มาจากหน้าแจ้งเตือน)
    this.route.queryParams.subscribe(params => {
      if (params['status']) {
        this.selectedStatus = params['status'];
      }
    });

    this.loadUsers();
    this.loadDepartments();
    this.loadHospitals();
    this.loadDistricts();
    if (this.isSuperAdmin) this.loadMaintenanceStatus();
  }

  loadUsers() {
    this.authService.getUsers().subscribe({
      next: (res) => {
        if (res.success) {
          this.users = res.data;
          this.pendingCount = this.users.filter(u => u.is_approved === 0).length;
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
      const fullname = ((user.firstname || '') + ' ' + (user.lastname || '')).toLowerCase();
      const matchSearch = !search ||
                          (user.username && user.username.toLowerCase().includes(search)) ||
                          fullname.includes(search) ||
                          (user.role && user.role.toLowerCase().includes(search)) ||
                          (user.dept_name && user.dept_name.toLowerCase().includes(search)) ||
                          (user.hosname && user.hosname.toLowerCase().includes(search)) ||
                          (user.hospcode && user.hospcode.includes(search)) ||
                          (user.phone && user.phone.includes(search)) ||
                          (user.email && user.email.toLowerCase().includes(search));

      const matchRole = this.selectedRole === '' || user.role === this.selectedRole;
      const matchDept = this.selectedDept === '' || (user.dept_id && user.dept_id.toString() === this.selectedDept);
      const matchHosp = this.selectedHospcode === '' || user.hospcode === this.selectedHospcode;
      const matchStatus = this.selectedStatus === '' ||
                          (this.selectedStatus === 'pending' && user.is_approved === 0) ||
                          (this.selectedStatus === 'approved' && user.is_approved === 1) ||
                          (this.selectedStatus === 'rejected' && user.is_approved === -1);

      return matchSearch && matchRole && matchDept && matchHosp && matchStatus;
    });

    this.totalPages = Math.ceil(this.filteredUsers.length / this.pageSize);
    this.currentPage = 1;
  }

  get pagedUsers() {
    return this.filteredUsers;
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

  // === National ID formatting & validation ===
  onNationalIdInput(event: any) {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 13) value = value.substring(0, 13);
    this.currentUser.cid = value;
    event.target.value = this.formatNationalIdDisplay(value);
  }

  formatNationalIdDisplay(id: string): string {
    if (!id) return '';
    const d = id.replace(/\D/g, '');
    if (d.length <= 1) return d;
    if (d.length <= 5) return d.substring(0, 1) + '-' + d.substring(1);
    if (d.length <= 10) return d.substring(0, 1) + '-' + d.substring(1, 5) + '-' + d.substring(5);
    if (d.length <= 12) return d.substring(0, 1) + '-' + d.substring(1, 5) + '-' + d.substring(5, 10) + '-' + d.substring(10);
    return d.substring(0, 1) + '-' + d.substring(1, 5) + '-' + d.substring(5, 10) + '-' + d.substring(10, 12) + '-' + d.substring(12);
  }

  validateNationalId(id: string): boolean {
    if (!/^\d{13}$/.test(id)) return false;
    const digits = id.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) { sum += digits[i] * (13 - i); }
    return (11 - (sum % 11)) % 10 === digits[12];
  }

  // === Username validation ===
  validateUsername(name: string): string | null {
    if (!name) return null;
    if (name.length < 6) return 'ชื่อผู้ใช้งานต้องมีอย่างน้อย 6 ตัวอักษร';
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(name)) {
      return 'ชื่อผู้ใช้งานต้องเป็น a-z, A-Z, 0-9 หรืออักขระพิเศษเท่านั้น';
    }
    return null;
  }

  // === Password strength ===
  getPasswordStrength(pw: string): { level: number; text: string; color: string } {
    if (!pw) return { level: 0, text: '', color: '' };
    let score = 0;
    if (pw.length >= 6) score++;
    if (/[a-z]/.test(pw)) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) score++;
    if (pw.length >= 10) score++;
    if (score <= 2) return { level: score, text: 'อ่อน', color: 'bg-red-500' };
    if (score <= 4) return { level: score, text: 'ปานกลาง', color: 'bg-yellow-500' };
    return { level: score, text: 'แข็งแรง', color: 'bg-green-500' };
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

  // === Password validation (เหมือน register) ===
  validatePassword(pw: string): string | null {
    if (!pw) return null;
    if (pw.length < 6) return 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร';
    if (!/[a-z]/.test(pw)) return 'รหัสผ่านต้องมีตัวอักษรพิมพ์เล็ก (a-z) อย่างน้อย 1 ตัว';
    if (!/[A-Z]/.test(pw)) return 'รหัสผ่านต้องมีตัวอักษรพิมพ์ใหญ่ (A-Z) อย่างน้อย 1 ตัว';
    if (!/[0-9]/.test(pw)) return 'รหัสผ่านต้องมีตัวเลข (0-9) อย่างน้อย 1 ตัว';
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) return 'รหัสผ่านต้องมีอักขระพิเศษอย่างน้อย 1 ตัว';
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(pw)) {
      return 'รหัสผ่านมีอักขระที่ไม่อนุญาต';
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
        !this.currentUser.hospcode ||
        !this.currentUser.cid ||
        !this.currentUser.dept_id ||
        !this.currentUser.role) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง (รวมเลขบัตรประชาชน, หน่วยบริการ, หน่วยงาน)', 'warning');
      return;
    }

    // ตรวจสอบ username (เหมือน register)
    const usernameError = this.validateUsername(this.currentUser.username);
    if (usernameError) {
      Swal.fire('แจ้งเตือน', usernameError, 'warning');
      return;
    }

    // ตรวจสอบเลขบัตรประชาชน (Check Digit Modulus 11)
    if (!this.validateNationalId(this.currentUser.cid)) {
      Swal.fire('แจ้งเตือน', 'เลขบัตรประชาชนไม่ถูกต้อง (ตรวจสอบ 13 หลักและ Check Digit แล้ว)', 'warning');
      return;
    }

    // ตรวจสอบ email (ถ้ากรอก)
    if (this.currentUser.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.currentUser.email)) {
      Swal.fire('แจ้งเตือน', 'รูปแบบอีเมลไม่ถูกต้อง', 'warning');
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
      html: `<p>ปฏิเสธผู้ใช้งาน <b>${user.firstname} ${user.lastname}</b> (${user.username})</p>
             <p class="text-sm text-gray-500 mt-1">${user.email ? 'จะส่ง Email แจ้งไปที่ ' + user.email : '<span class="text-amber-500">ไม่มี Email — ไม่สามารถแจ้งผลทาง Email ได้</span>'}</p>`,
      input: 'textarea',
      inputLabel: 'เหตุผลในการปฏิเสธ (จะส่งให้ผู้สมัครทาง Email)',
      inputPlaceholder: 'ระบุเหตุผล เช่น ข้อมูลไม่ครบถ้วน, ไม่มีสิทธิ์ใช้งาน...',
      inputAttributes: { 'aria-label': 'เหตุผลในการปฏิเสธ' },
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-times mr-1"></i> ปฏิเสธ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        const reason = result.value || '';
        this.authService.rejectUser(user.id, reason).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'ปฏิเสธแล้ว', text: user.email ? 'ส่ง Email แจ้งผลเรียบร้อย' : '', timer: 2000, showConfirmButton: false });
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปฏิเสธได้', 'error')
        });
      }
    });
  }

  approveAllPending() {
    const pendingUsers = this.users.filter(u => u.is_approved === 0);
    if (pendingUsers.length === 0) return;
    Swal.fire({
      title: 'อนุมัติทั้งหมด',
      html: `<p>ยืนยันอนุมัติผู้ใช้งานที่รออนุมัติทั้งหมด <b>${pendingUsers.length}</b> คน?</p>
             <div class="mt-2 max-h-40 overflow-y-auto text-left text-xs text-gray-600">
               ${pendingUsers.map(u => `<div class="py-0.5">• ${u.firstname} ${u.lastname} (${u.username})</div>`).join('')}
             </div>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#16a34a',
      confirmButtonText: `<i class="fas fa-check-double mr-1"></i> อนุมัติ ${pendingUsers.length} คน`,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        let done = 0, fail = 0;
        const total = pendingUsers.length;
        Swal.fire({ title: 'กำลังอนุมัติ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        pendingUsers.forEach(u => {
          this.authService.approveUser(u.id).subscribe({
            next: () => { done++; if (done + fail === total) this.onBatchComplete(done, fail); },
            error: () => { fail++; if (done + fail === total) this.onBatchComplete(done, fail); }
          });
        });
      }
    });
  }

  rejectAllPending() {
    const pendingUsers = this.users.filter(u => u.is_approved === 0);
    if (pendingUsers.length === 0) return;
    Swal.fire({
      title: 'ปฏิเสธทั้งหมด',
      html: `<p class="text-red-600">ยืนยันปฏิเสธผู้ใช้งานที่รออนุมัติทั้งหมด <b>${pendingUsers.length}</b> คน?</p>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: `<i class="fas fa-times-circle mr-1"></i> ปฏิเสธ ${pendingUsers.length} คน`,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        let done = 0, fail = 0;
        const total = pendingUsers.length;
        Swal.fire({ title: 'กำลังปฏิเสธ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        pendingUsers.forEach(u => {
          this.authService.rejectUser(u.id).subscribe({
            next: () => { done++; if (done + fail === total) this.onBatchComplete(done, fail, 'ปฏิเสธ'); },
            error: () => { fail++; if (done + fail === total) this.onBatchComplete(done, fail, 'ปฏิเสธ'); }
          });
        });
      }
    });
  }

  private onBatchComplete(done: number, fail: number, action: string = 'อนุมัติ') {
    this.loadUsers();
    if (fail === 0) {
      Swal.fire({ icon: 'success', title: `${action}ทั้งหมดสำเร็จ`, text: `${action}แล้ว ${done} คน`, timer: 2000, showConfirmButton: false });
    } else {
      Swal.fire({ icon: 'warning', title: `${action}เสร็จสิ้น`, text: `สำเร็จ ${done} คน, ล้มเหลว ${fail} คน` });
    }
  }

  allowReRegister(user: any) {
    Swal.fire({
      title: 'เปิดให้สมัครใหม่',
      html: `<p>ลบ account ที่ถูกปฏิเสธของ <b>${user.firstname} ${user.lastname}</b> (${user.username})</p>
             <p class="text-sm text-gray-500 mt-2">ผู้ใช้จะสามารถลงทะเบียนด้วยเลขบัตรประชาชนเดิมได้อีกครั้ง</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#3b82f6',
      confirmButtonText: '<i class="fas fa-user-plus mr-1"></i> ยืนยัน ลบและเปิดให้สมัครใหม่',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.deleteUser(user.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'เปิดให้สมัครใหม่แล้ว', text: 'ผู้ใช้สามารถลงทะเบียนใหม่ได้', timer: 2000, showConfirmButton: false });
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
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

  loadMaintenanceStatus() {
    this.authService.getMaintenanceStatus().subscribe({
      next: (res: any) => {
        this.maintenanceMode = res.maintenance;
        this.maintenanceMessage = res.message || 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน';
        this.cdr.detectChanges();
      }
    });
  }

  toggleMaintenanceMode() {
    const willEnable = !this.maintenanceMode;
    if (willEnable) {
      Swal.fire({
        title: 'เปิดโหมดปิดปรับปรุงระบบ',
        html: '<p class="text-sm text-gray-600 mb-2">ผู้ใช้งานทั้งหมด (ยกเว้น super_admin) จะเห็นหน้าแจ้งเตือนและไม่สามารถใช้งานได้</p>',
        input: 'textarea',
        inputLabel: 'ข้อความแจ้งเตือน',
        inputValue: this.maintenanceMessage,
        inputPlaceholder: 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#dc2626',
        confirmButtonText: '<i class="fas fa-lock mr-1"></i> เปิดโหมดปิดปรับปรุง',
        cancelButtonText: 'ยกเลิก'
      }).then((result) => {
        if (result.isConfirmed) {
          const msg = result.value || this.maintenanceMessage;
          this.authService.setMaintenanceMode(true, msg).subscribe({
            next: (res) => {
              if (res.success) {
                this.maintenanceMode = true;
                this.maintenanceMessage = msg;
                Swal.fire({ icon: 'success', title: res.message, timer: 2000, showConfirmButton: false });
                this.cdr.detectChanges();
              }
            },
            error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
          });
        }
      });
    } else {
      Swal.fire({
        title: 'ปิดโหมดปิดปรับปรุง',
        text: 'เปิดให้ผู้ใช้งานทุกคนกลับเข้าใช้ระบบได้ตามปกติ',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#16a34a',
        confirmButtonText: '<i class="fas fa-unlock mr-1"></i> เปิดระบบ',
        cancelButtonText: 'ยกเลิก'
      }).then((result) => {
        if (result.isConfirmed) {
          this.authService.setMaintenanceMode(false, this.maintenanceMessage).subscribe({
            next: (res) => {
              if (res.success) {
                this.maintenanceMode = false;
                Swal.fire({ icon: 'success', title: res.message, timer: 2000, showConfirmButton: false });
                this.cdr.detectChanges();
              }
            },
            error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
          });
        }
      });
    }
  }

  bulkToggleActive(activate: boolean) {
    const actionText = activate ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
    const nonSuperCount = this.users.filter(u => u.role !== 'super_admin').length;
    Swal.fire({
      title: `${actionText}ผู้ใช้งานทั้งหมด`,
      html: `<p>ยืนยัน<b>${actionText}</b>ผู้ใช้งานทั้งหมด <b>${nonSuperCount}</b> คน?</p>
             <p class="text-xs text-gray-500 mt-1">(ยกเว้น super_admin)</p>
             ${!activate ? '<p class="text-sm text-red-500 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>ผู้ใช้งานทุกคนจะไม่สามารถเข้าสู่ระบบได้</p>' : ''}`,
      icon: activate ? 'question' : 'warning',
      showCancelButton: true,
      confirmButtonColor: activate ? '#16a34a' : '#dc2626',
      confirmButtonText: `<i class="fas ${activate ? 'fa-toggle-on' : 'fa-toggle-off'} mr-1"></i> ${actionText}ทั้งหมด`,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'กำลังดำเนินการ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.bulkToggleActive(activate).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
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
