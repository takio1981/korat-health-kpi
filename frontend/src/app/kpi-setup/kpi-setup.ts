import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-kpi-setup',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kpi-setup.html'
})
export class KpiSetupComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  kpiTemplateAll: any[] = [];
  kpiTemplate: any[] = [];
  departments: any[] = [];
  districts: any[] = [];
  hospitals: any[] = [];
  filteredHospitals: any[] = [];

  selectedYear: string = '';
  selectedDistrict: string = '';
  selectedHospital: string = '';
  selectedDept: string = '';

  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  loggedInUser: any = null;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    this.loggedInUser = this.authService.getUser();

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

    this.selectedYear = (new Date().getFullYear() + 543 + 1).toString();

    // admin_ssj: ล็อค dept_id เป็นหน่วยงานของตัวเอง
    if (!this.isSuperAdmin && this.loggedInUser?.dept_id) {
      this.selectedDept = this.loggedInUser.dept_id.toString();
    }

    this.loadTemplate();
    this.loadDepartments();
    this.loadDistricts();
    this.loadHospitals();
  }

  loadTemplate() {
    this.authService.getKpiTemplate().subscribe({
      next: (res) => {
        if (res.success) {
          this.kpiTemplateAll = res.data;
          this.applyDeptFilter();
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadDepartments() {
    this.authService.getDepartments().subscribe(res => {
      if (res.success) {
        this.departments = res.data;
        this.cdr.detectChanges();
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
        this.filteredHospitals = [...this.hospitals];
        this.cdr.detectChanges();
      }
    });
  }

  applyDeptFilter() {
    let filtered = this.kpiTemplateAll;
    if (this.selectedDept) {
      filtered = filtered.filter(item => String(item.dept_id) === this.selectedDept);
    }
    this.kpiTemplate = filtered.map((item: any) => ({
      ...item,
      year_bh: this.selectedYear,
      target_value: 0,
      oct: 0, nov: 0, dece: 0, jan: 0, feb: 0, mar: 0,
      apr: 0, may: 0, jun: 0, jul: 0, aug: 0, sep: 0,
      total_actual: 0
    }));
    this.cdr.detectChanges();
  }

  onDeptChange() {
    this.applyDeptFilter();
  }

  onDistrictChange() {
    if (this.selectedDistrict) {
      this.filteredHospitals = this.hospitals.filter(h => h.distid === this.selectedDistrict);
    } else {
      this.filteredHospitals = [...this.hospitals];
    }
    this.selectedHospital = '';
    this.cdr.detectChanges();
  }

  onYearChange() {
    this.kpiTemplate.forEach(item => item.year_bh = this.selectedYear);
    this.cdr.detectChanges();
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

    if (this.kpiTemplate.length === 0) {
      Swal.fire({
        title: 'แจ้งเตือน',
        text: 'ไม่มีตัวชี้วัดสำหรับบันทึก',
        icon: 'warning',
        confirmButtonColor: '#f39c12',
        confirmButtonText: 'ตกลง'
      });
      return;
    }

    // หาชื่อหน่วยบริการ
    const selectedHos = this.filteredHospitals.find(h => h.hoscode === this.selectedHospital);
    const hosName = selectedHos ? `${selectedHos.hoscode}: ${selectedHos.hosname}` : this.selectedHospital;
    const deptName = this.selectedDept
      ? this.departments.find(d => String(d.id) === this.selectedDept)?.dept_name || 'ทั้งหมด'
      : 'ทั้งหมด';

    Swal.fire({
      title: 'เลือกรูปแบบการบันทึก',
      html: `<div class="text-left text-sm">
        <p class="mb-2 text-gray-600">บันทึกข้อมูล KPI ปี <b>${this.selectedYear}</b></p>
        <p class="mb-1 text-gray-600">หน่วยบริการ: <b>${hosName}</b></p>
        <p class="mb-3 text-gray-600">หน่วยงาน: <b>${deptName}</b></p>
        <p class="text-gray-500 text-xs">จำนวนตัวชี้วัด: <b>${this.kpiTemplate.length}</b> รายการ</p>
      </div>`,
      icon: 'question',
      showCancelButton: true,
      showDenyButton: true,
      confirmButtonColor: '#10b981',
      denyButtonColor: '#3b82f6',
      cancelButtonColor: '#6b7280',
      confirmButtonText: '<i class="fas fa-plus-circle mr-1"></i> เพิ่มทั้งหมด (เขียนทับ)',
      denyButtonText: '<i class="fas fa-filter mr-1"></i> เพิ่มเฉพาะที่ยังไม่มี',
      cancelButtonText: 'ยกเลิก',
      width: 520
    }).then((result) => {
      if (result.isConfirmed) {
        this.doSaveOverwrite();
      } else if (result.isDenied) {
        this.doSaveInsertNew();
      }
    });
  }

  private doSaveOverwrite() {
    // ตรวจสอบข้อมูลที่มีอยู่ก่อน เพื่อแจ้งเตือนการเขียนทับ
    Swal.fire({
      title: 'กำลังตรวจสอบข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    this.authService.checkKpiSetup(this.selectedHospital, this.selectedYear, this.selectedDept).subscribe({
      next: (res) => {
        Swal.close();
        if (res.success && res.data.scoredIndicators > 0) {
          // มีข้อมูลคะแนนอยู่แล้ว → แจ้งเตือน
          Swal.fire({
            title: 'พบข้อมูลที่มีอยู่แล้ว',
            html: `<div class="text-left text-sm">
              <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3">
                <p class="text-yellow-800 font-bold mb-1"><i class="fas fa-exclamation-triangle mr-1"></i> พบข้อมูลที่มีคะแนนอยู่แล้ว</p>
                <ul class="text-yellow-700 text-xs ml-4 list-disc space-y-1">
                  <li>ตัวชี้วัดที่มีข้อมูล: <b>${res.data.totalExisting}</b> รายการ</li>
                  <li>ตัวชี้วัดที่มีคะแนน: <b>${res.data.scoredIndicators}</b> รายการ</li>
                  <li>คะแนนรวม: <b>${Number(res.data.totalScore).toLocaleString()}</b></li>
                </ul>
              </div>
              <p class="text-red-600 font-bold text-xs">การเขียนทับจะแทนที่ข้อมูลทั้งหมดของตัวชี้วัดเหล่านี้</p>
            </div>`,
            icon: 'warning',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonColor: '#ef4444',
            denyButtonColor: '#3b82f6',
            cancelButtonColor: '#6b7280',
            confirmButtonText: '<i class="fas fa-edit mr-1"></i> ยืนยัน เขียนทับ',
            denyButtonText: '<i class="fas fa-filter mr-1"></i> เพิ่มเฉพาะที่ยังไม่มี',
            cancelButtonText: 'ยกเลิก',
            width: 520
          }).then((result2) => {
            if (result2.isConfirmed) {
              this.executeSave('setup_overwrite');
            } else if (result2.isDenied) {
              this.executeSave('setup_insert_new');
            }
          });
        } else {
          // ไม่มีข้อมูลเดิม → บันทึกเลย
          this.executeSave('setup_overwrite');
        }
      },
      error: () => {
        Swal.close();
        // ถ้าตรวจสอบไม่ได้ ให้ถามอีกครั้ง
        Swal.fire({
          title: 'ไม่สามารถตรวจสอบข้อมูลเดิมได้',
          text: 'ต้องการบันทึกต่อหรือไม่?',
          icon: 'warning',
          showCancelButton: true,
          confirmButtonColor: '#10b981',
          confirmButtonText: 'บันทึกต่อ',
          cancelButtonText: 'ยกเลิก'
        }).then((r) => {
          if (r.isConfirmed) {
            this.executeSave('setup_overwrite');
          }
        });
      }
    });
  }

  private doSaveInsertNew() {
    this.executeSave('setup_insert_new');
  }

  private executeSave(mode: 'setup_overwrite' | 'setup_insert_new') {
    Swal.fire({
      title: 'กำลังบันทึกข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    const dataToSave = this.kpiTemplate.map(item => ({
      indicator_id: item.indicator_id,
      year_bh: this.selectedYear,
      target_value: item.target_value,
      oct: item.oct, nov: item.nov, dece: item.dece,
      jan: item.jan, feb: item.feb, mar: item.mar,
      apr: item.apr, may: item.may, jun: item.jun,
      jul: item.jul, aug: item.aug, sep: item.sep
    }));

    this.authService.updateKpiResults(dataToSave, this.selectedHospital, mode).subscribe({
      next: (res) => {
        const modeLabel = mode === 'setup_overwrite' ? 'เขียนทับ' : 'เพิ่มเฉพาะที่ยังไม่มี';
        let message = res.message || `บันทึกตัวชี้วัด ${dataToSave.length} รายการเรียบร้อยแล้ว`;
        if (res.inserted !== undefined) {
          message = mode === 'setup_insert_new'
            ? `เพิ่มตัวชี้วัดใหม่ ${res.inserted} รายการ (ข้าม ${res.skipped || 0} รายการที่มีอยู่แล้ว)`
            : `บันทึกตัวชี้วัดทั้งหมด ${res.inserted} รายการเรียบร้อยแล้ว (${modeLabel})`;
        }
        Swal.fire({
          title: 'สำเร็จ',
          text: message,
          icon: 'success',
          confirmButtonColor: '#28a745',
          confirmButtonText: 'ตกลง'
        });
      },
      error: (err) => Swal.fire({
        title: 'ผิดพลาด',
        text: err.error?.message || 'ไม่สามารถบันทึกข้อมูลได้',
        icon: 'error',
        confirmButtonColor: '#d33',
        confirmButtonText: 'ตกลง'
      })
    });
  }

  bulkAddAllHospitals() {
    if (!this.selectedYear) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกปีงบประมาณ', 'warning');
      return;
    }
    const deptLabel = this.isSuperAdmin
      ? 'ทุกหน่วยงาน'
      : (this.departments.find(d => d.id?.toString() === this.selectedDept)?.dept_name || 'หน่วยงานของคุณ');
    Swal.fire({
      title: 'เพิ่ม KPI ทุกหน่วยบริการ',
      html: `<p class="text-sm text-gray-600">เพิ่มตัวชี้วัดของ <b>${deptLabel}</b> ให้ <b>ทุกหน่วยบริการ</b> ในปี <b>${this.selectedYear}</b></p>
             <p class="text-xs text-amber-600 mt-2"><i class="fas fa-info-circle mr-1"></i>เพิ่มเฉพาะที่ยังไม่มี ข้อมูลเดิมจะไม่ถูกแก้ไข</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#4f46e5',
      confirmButtonText: '<i class="fas fa-layer-group mr-1"></i> เพิ่มทั้งหมด',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'กำลังเพิ่มข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.bulkAddKpi(this.selectedYear, this.isSuperAdmin ? '' : this.selectedDept).subscribe({
          next: (r: any) => {
            Swal.fire({
              icon: 'success',
              title: 'เพิ่ม KPI สำเร็จ',
              html: `<div class="text-left text-sm space-y-2">
                <div class="bg-green-50 border border-green-200 rounded-lg p-3">
                  <p class="font-bold text-green-800 mb-1"><i class="fas fa-check-circle mr-1"></i>สรุปผลการเพิ่มข้อมูล</p>
                  <table class="w-full text-xs">
                    <tr><td class="py-1 text-gray-600">ปีงบประมาณ</td><td class="font-bold">${r.year_bh}</td></tr>
                    <tr><td class="py-1 text-gray-600">ตัวชี้วัด</td><td class="font-bold">${r.indicatorCount} รายการ</td></tr>
                    <tr><td class="py-1 text-gray-600">หน่วยบริการ</td><td class="font-bold">${r.hospitalCount} แห่ง</td></tr>
                  </table>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="bg-blue-50 border border-blue-200 rounded-lg p-2 text-center">
                    <p class="text-xl font-bold text-blue-700">${r.inserted}</p>
                    <p class="text-[10px] text-blue-600">ชุดที่เพิ่มใหม่</p>
                  </div>
                  <div class="bg-gray-50 border border-gray-200 rounded-lg p-2 text-center">
                    <p class="text-xl font-bold text-gray-500">${r.skipped}</p>
                    <p class="text-[10px] text-gray-500">ชุดที่ข้าม (มีอยู่แล้ว)</p>
                  </div>
                </div>
                <p class="text-xs text-gray-400"><i class="fas fa-database mr-1"></i>สร้างทั้งหมด ${r.totalRecords} records (12 เดือน × ${r.inserted} ชุด)</p>
              </div>`,
              confirmButtonColor: '#10b981'
            });
          },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเพิ่มข้อมูลได้', 'error')
        });
      }
    });
  }
}
