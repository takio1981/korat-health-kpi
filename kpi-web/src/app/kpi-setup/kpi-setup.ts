import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-kpi-setup',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './kpi-setup.html'
})
export class KpiSetupComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  kpiTemplate: any[] = [];
  districts: any[] = [];
  hospitals: any[] = [];
  filteredHospitals: any[] = [];

  selectedYear: string = '';
  selectedDistrict: string = '';
  selectedHospital: string = '';

  isSidebarOpen: boolean = true;
  currentUserDisplay: any = null;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;

  ngOnInit() {
    this.currentUserDisplay = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';

    if (!this.isAdmin) {
      Swal.fire({
        title: 'Access Denied',
        text: 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้',
        icon: 'error',
        confirmButtonColor: '#d33',
        confirmButtonText: 'ตกลง'
      });
      this.router.navigate(['/dashboard']);
      return;
    }

    this.selectedYear = (new Date().getFullYear() + 543 + 1).toString(); // ปีปัจจุบัน + 1
    this.loadTemplate();
    this.loadDistricts();
    this.loadHospitals();
    this.loadSettings();
    this.loadPendingKpiCount();
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

  loadTemplate() {
    this.authService.getKpiTemplate().subscribe({
      next: (res) => {
        if (res.success) {
          this.kpiTemplate = res.data.map((item: any) => ({
            ...item,
            year_bh: this.selectedYear, // กำหนดปีงบประมาณ
            target_value: 0, // ค่าเริ่มต้น
            oct: 0, nov: 0, dece: 0, jan: 0, feb: 0, mar: 0,
            apr: 0, may: 0, jun: 0, jul: 0, aug: 0, sep: 0,
            total_actual: 0
          }));
          this.cdr.detectChanges(); // ✅ บังคับอัปเดตหน้าจอทันทีเมื่อข้อมูลมา
        }
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

  loadDistricts() {
    this.authService.getDistricts().subscribe(res => {
      if (res.success) {
        this.districts = res.data;
        this.cdr.detectChanges();
      }
    });
  }

  loadHospitals() {
    this.authService.getHospitals().subscribe(res => {
      if (res.success) {
        this.hospitals = res.data;
        this.filteredHospitals = [...this.hospitals]; // ✅ เริ่มต้นให้แสดงทั้งหมด
        this.cdr.detectChanges();
      }
    });
  }

  onDistrictChange() {
    if (this.selectedDistrict) {
      this.filteredHospitals = this.hospitals.filter(h => h.distid === this.selectedDistrict);
    } else {
      this.filteredHospitals = [...this.hospitals]; // ถ้าเลือกทั้งหมด ให้แสดงทุกโรงพยาบาล
    }
    this.selectedHospital = '';
    this.cdr.detectChanges(); // อัปเดต Dropdown หน่วยบริการ
  }

  onValueChange(item: any, month: string) {
    if (item[month] < 0) item[month] = 0;
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    let sum = 0;
    for (const m of months) {
      sum += Number(item[m]) || 0;
    }
    item.total_actual = sum;
  }

  saveSetup() {
    if (!this.selectedHospital) {
      Swal.fire({
        title: 'แจ้งเตือน',
        text: 'กรุณาเลือกหน่วยบริการก่อนบันทึก',
        icon: 'warning',
        confirmButtonColor: '#f39c12',
        confirmButtonText: 'ตกลง'
      });
      return;
    }

    Swal.fire({
      title: 'ยืนยันการบันทึก',
      text: `คุณต้องการบันทึกข้อมูล KPI ปี ${this.selectedYear} สำหรับหน่วยบริการนี้ใช่หรือไม่?`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'บันทึก',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#28a745',
      cancelButtonColor: '#d33'
    }).then((result) => {
      if (result.isConfirmed) {
        // ✅ สร้าง Object ใหม่สำหรับส่งไปบันทึก โดยตัด field ที่เป็นข้อความออก (ลดขนาด Payload)
        const dataToSave = this.kpiTemplate.map(item => ({
            indicator_id: item.indicator_id, // ส่งเฉพาะรหัส
            year_bh: this.selectedYear,
            target_value: item.target_value,
            oct: item.oct, nov: item.nov, dece: item.dece,
            jan: item.jan, feb: item.feb, mar: item.mar,
            apr: item.apr, may: item.may, jun: item.jun,
            jul: item.jul, aug: item.aug, sep: item.sep
        }));

        this.authService.updateKpiResults(dataToSave, this.selectedHospital).subscribe({
          next: (res) => {
            Swal.fire({
              title: 'สำเร็จ',
              text: 'บันทึกข้อมูลเรียบร้อยแล้ว',
              icon: 'success',
              confirmButtonColor: '#28a745',
              confirmButtonText: 'ตกลง'
            });
          },
          error: (err) => Swal.fire({
            title: 'ผิดพลาด',
            text: 'ไม่สามารถบันทึกข้อมูลได้',
            icon: 'error',
            confirmButtonColor: '#d33',
            confirmButtonText: 'ตกลง'
          })
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

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
