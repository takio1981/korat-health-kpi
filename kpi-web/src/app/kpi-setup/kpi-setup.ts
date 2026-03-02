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

  kpiTemplate: any[] = [];
  districts: any[] = [];
  hospitals: any[] = [];
  filteredHospitals: any[] = [];

  selectedYear: string = '';
  selectedDistrict: string = '';
  selectedHospital: string = '';

  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;

  ngOnInit() {
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

    this.selectedYear = (new Date().getFullYear() + 543 + 1).toString();
    this.loadTemplate();
    this.loadDistricts();
    this.loadHospitals();
  }

  loadTemplate() {
    this.authService.getKpiTemplate().subscribe({
      next: (res) => {
        if (res.success) {
          this.kpiTemplate = res.data.map((item: any) => ({
            ...item,
            year_bh: this.selectedYear,
            target_value: 0,
            oct: 0, nov: 0, dece: 0, jan: 0, feb: 0, mar: 0,
            apr: 0, may: 0, jun: 0, jul: 0, aug: 0, sep: 0,
            total_actual: 0
          }));
          this.cdr.detectChanges();
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
        this.filteredHospitals = [...this.hospitals];
        this.cdr.detectChanges();
      }
    });
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
        const dataToSave = this.kpiTemplate.map(item => ({
            indicator_id: item.indicator_id,
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
}
