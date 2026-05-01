import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { ThemeService } from '../services/theme.service';
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
  themeService = inject(ThemeService);

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
    { value: 'user_hos', label: 'User รพ. — ผู้ใช้งาน (โรงพยาบาล)' },
    { value: 'user_sso', label: 'User รพ.สต. — ผู้ใช้งาน (รพ.สต.)' },
    { value: 'user_cup', label: 'User CUP — ผู้ใช้งาน (อำเภอ)' },
    { value: 'user_ssj', label: 'User SSJ — ผู้ใช้งาน (สสจ.)' },
    { value: 'admin_hos', label: 'Admin รพ. — ผู้ดูแล (โรงพยาบาล)' },
    { value: 'admin_sso', label: 'Admin รพ.สต. — ผู้ดูแล (รพ.สต.)' },
    { value: 'admin_cup', label: 'Admin CUP — ผู้ดูแล (อำเภอ)' },
    { value: 'admin_ssj', label: 'Admin SSJ — ผู้ดูแล (สสจ.)' }
  ];

  confirmPassword: string = '';
  showPassword: boolean = false;
  showConfirmPassword: boolean = false;
  isSubmitting: boolean = false;

  // === Registration method selection (modal เลือก 3 วิธี) ===
  // 'choose' = แสดง modal เลือกวิธี | 'manual' = แสดง form กรอกเอง
  registerMode: 'choose' | 'manual' = 'choose';

  selectManualRegister() {
    this.registerMode = 'manual';
  }

  registerWithThaID() {
    this.showSsoUnavailable('ThaID', 'fa-id-card', '#1e40af');
  }

  registerWithProviderID() {
    this.showSsoUnavailable('ProviderID (กระทรวงสาธารณสุข)', 'fa-user-md', '#0284c7');
  }

  private showSsoUnavailable(providerName: string, icon: string, color: string) {
    Swal.fire({
      iconHtml: `<i class="fas ${icon}" style="color:${color}"></i>`,
      title: 'ฟีเจอร์รอการเปิดใช้งาน',
      html: `<div style="text-align:left;font-size:13px;line-height:1.7">
        <p>การลงทะเบียนด้วย <b style="color:${color}">${providerName}</b> ขณะนี้อยู่ระหว่างขั้นตอนขอใช้บริการกับหน่วยงานเจ้าของระบบ</p>
        <p class="text-gray-500" style="margin-top:8px"><i class="fas fa-info-circle mr-1"></i>กรุณาลงทะเบียนด้วยตัวเอง (กรอกแบบฟอร์ม) ไปก่อน</p>
      </div>`,
      confirmButtonText: 'รับทราบ',
      confirmButtonColor: '#10b981'
    });
  }

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
    if (!/[a-z]/.test(pw)) return 'รหัสผ่านต้องมีตัวอักษรพิมพ์เล็ก (a-z) อย่างน้อย 1 ตัว';
    if (!/[A-Z]/.test(pw)) return 'รหัสผ่านต้องมีตัวอักษรพิมพ์ใหญ่ (A-Z) อย่างน้อย 1 ตัว';
    if (!/[0-9]/.test(pw)) return 'รหัสผ่านต้องมีตัวเลข (0-9) อย่างน้อย 1 ตัว';
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) return 'รหัสผ่านต้องมีอักขระพิเศษอย่างน้อย 1 ตัว';
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(pw)) {
      return 'รหัสผ่านมีอักขระที่ไม่อนุญาต';
    }
    return null;
  }

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

  validatePhone(phone: string): boolean {
    if (!phone) return false;
    return phone.replace(/\D/g, '').length === 10;
  }

  onSubmit() {
    // ตรวจสอบข้อมูลครบถ้วน
    if (!this.formData.username || !this.formData.password ||
        !this.formData.firstname || !this.formData.lastname ||
        !this.formData.hospcode || !this.formData.phone || !this.formData.cid || !this.formData.dept_id) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง (รวมเลขบัตรประชาชนและหน่วยงาน)', 'warning');
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
