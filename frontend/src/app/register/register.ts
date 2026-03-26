import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './register.html'
})
export class RegisterComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  formData: any = {
    username: '',
    password: '',
    firstname: '',
    lastname: '',
    hospcode: '',
    phone: '',
    email: '',
    dept_id: '',
    cid: '',
    role: 'user'
  };

  roleOptions = [
    { value: 'user', label: 'User — ผู้ใช้งานทั่วไป (บันทึก KPI)' },
    { value: 'admin_cup', label: 'Admin CUP — ผู้ดูแลหน่วยบริการ' },
    { value: 'admin_ssj', label: 'Admin SSJ — ผู้ดูแลส่วนกลาง (สสจ.)' }
  ];

  confirmPassword: string = '';
  showPassword: boolean = false;
  showConfirmPassword: boolean = false;
  isSubmitting: boolean = false;

  departments: any[] = [];
  hospitals: any[] = [];
  districts: any[] = [];
  filteredHospitals: any[] = [];
  selectedDistrictId: string = '';

  ngOnInit() {
    this.loadDepartments();
    this.loadHospitals();
    this.loadDistricts();
  }

  loadDepartments() {
    this.authService.getPublicDepartments().subscribe({
      next: (res) => {
        if (res.success) {
          this.departments = res.data;
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadHospitals() {
    this.authService.getPublicHospitals().subscribe({
      next: (res) => {
        if (res.success) {
          this.hospitals = res.data;
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadDistricts() {
    this.authService.getPublicDistricts().subscribe({
      next: (res) => {
        if (res.success) {
          this.districts = res.data;
          this.cdr.detectChanges();
        }
      }
    });
  }

  onDistrictChange() {
    this.filteredHospitals = this.hospitals.filter(h => h.distid === this.selectedDistrictId);
    this.formData.hospcode = '';
    this.cdr.detectChanges();
  }

  // === National ID formatting ===
  onNationalIdInput(event: any) {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 13) value = value.substring(0, 13);
    this.formData.cid = value;
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
    // Check Digit — Modulus 11
    const digits = id.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += digits[i] * (13 - i);
    }
    const checkDigit = (11 - (sum % 11)) % 10;
    return checkDigit === digits[12];
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

  // === Phone formatting ===
  onPhoneInput(event: any) {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 10) value = value.substring(0, 10);
    this.formData.phone = value;
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

  validatePhone(phone: string): boolean {
    if (!phone) return false;
    return phone.replace(/\D/g, '').length === 10;
  }

  onSubmit() {
    // ตรวจสอบข้อมูลครบถ้วน
    if (!this.formData.username || !this.formData.password ||
        !this.formData.firstname || !this.formData.lastname ||
        !this.formData.hospcode || !this.formData.phone || !this.formData.cid) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง', 'warning');
      return;
    }

    // ตรวจสอบ username
    const usernameError = this.validateUsername(this.formData.username);
    if (usernameError) {
      Swal.fire('แจ้งเตือน', usernameError, 'warning');
      return;
    }

    // ตรวจสอบ email (ถ้ากรอก)
    if (this.formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.formData.email)) {
      Swal.fire('แจ้งเตือน', 'รูปแบบอีเมลไม่ถูกต้อง', 'warning');
      return;
    }

    // ตรวจสอบ cid (13 หลัก + Check Digit Modulus 11)
    if (!this.validateNationalId(this.formData.cid)) {
      Swal.fire('แจ้งเตือน', 'เลขบัตรประชาชนไม่ถูกต้อง (ตรวจสอบ 13 หลักและ Check Digit แล้ว)', 'warning');
      return;
    }

    // ตรวจสอบ password
    const pwError = this.validatePassword(this.formData.password);
    if (pwError) {
      Swal.fire('แจ้งเตือน', pwError, 'warning');
      return;
    }

    // ตรวจสอบ confirm password
    if (this.formData.password !== this.confirmPassword) {
      Swal.fire('แจ้งเตือน', 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน', 'warning');
      return;
    }

    // ตรวจสอบเบอร์โทร
    if (!this.validatePhone(this.formData.phone)) {
      Swal.fire('แจ้งเตือน', 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก', 'warning');
      return;
    }

    this.isSubmitting = true;
    const submitData = { ...this.formData, phone: this.formData.phone.replace(/\D/g, '') };

    this.authService.register(submitData).subscribe({
      next: (res) => {
        this.isSubmitting = false;
        if (res.success) {
          Swal.fire({
            icon: 'success',
            title: 'ลงทะเบียนสำเร็จ',
            html: '<p>ระบบได้รับคำขอของคุณแล้ว</p><p class="text-sm text-gray-500 mt-1">กรุณารอการอนุมัติจากผู้ดูแลระบบก่อนเข้าสู่ระบบ</p>',
            confirmButtonColor: '#10b981',
            confirmButtonText: 'รับทราบ'
          }).then(() => {
            this.router.navigate(['/login']);
          });
        }
      },
      error: (err) => {
        this.isSubmitting = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถลงทะเบียนได้ กรุณาลองใหม่', 'error');
      }
    });
  }
}
