import { Component, OnInit, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { NgApexchartsModule } from 'ng-apexcharts';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, NgApexchartsModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit {
  private router = inject(Router);
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);

  kpiData: any[] = [];
  filteredData: any[] = [];
  searchTerm: string = '';
  selectedMain: string = '';
  selectedIndicator: string = '';
  selectedDept: string = '';
  selectedYear: string = '';
  selectedStatus: string = '';

  mainCategories: string[] = [];
  indicatorNames: string[] = [];
  deptNames: string[] = [];
  filterYears: string[] = [];
  addKpiYears: string[] = [];
  addKpiSelectedYear: string = '';

  isEditing: boolean = false;
  showAddModal: boolean = false;
  newKpiList: any[] = [];

  showTrendModal: boolean = false;
  selectedKpiName: string = '';
  kpiTrendOptions: any = {};
  
  isSidebarOpen: boolean = true;
  isLoading: boolean = false;
  private animationTimer: any;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  currentUser: any = null;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;

  currentPage: number = 1;
  pageSize: number = 20;
  totalPages: number = 0;

  showChangePasswordModal: boolean = false;
  changePasswordForm: any = { currentPassword: '', newPassword: '', confirmPassword: '' };
  showCurrentPw: boolean = false;
  showNewPw: boolean = false;
  showConfirmPw: boolean = false;

  stats: any = {
    successRate: 0,
    recordedCount: 0,
    totalDepts: 0,
    pendingCount: 0,
    rank: 1
  };

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin', 'super_admin'].includes(role);
    this.isSuperAdmin = role === 'super_admin';
    this.loadKpiData();
    this.loadSettings();
    this.loadPendingCount();
  }

  loadKpiData() {
    this.isLoading = true;
    this.authService.getKpiResults().subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res && res.success) {
          this.kpiData = res.data;
          this.kpiData.forEach(item => {
            item.target_value = Number(item.target_value) || 0;
            item.total_actual = Number(item.total_actual) || 0;
            item.pending_count = Number(item.pending_count) || 0;
            ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].forEach(m => item[m] = Number(item[m]) || 0);
          });

          this.filteredData = res.data;
          this.setDefaultYear();
          this.applyFilters();
          this.loadDashboardStats();
          this.extractFilterLists();
          this.cdr.detectChanges(); 
        }
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error loading KPI:', err);
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

  loadDashboardStats() {
    if (!this.selectedYear) return;
    this.authService.getDashboardStats(this.selectedYear).subscribe({
      next: (res) => {
        if (res && res.success) {
          this.animateStats(res.data);
        }
      },
      error: (err) => console.error('Error loading stats:', err)
    });
  }

  loadPendingCount() {
    if (this.isAdmin) {
      this.authService.getPendingKpiCount().subscribe({
        next: (res) => {
          if (res.success) {
            this.pendingKpiCount = res.count;
          }
        },
        error: (err) => console.error('Error loading pending count:', err)
      });
    }
  }

  animateStats(target: any) {
    if (this.animationTimer) clearInterval(this.animationTimer);
    const duration = 1500;
    const steps = 60;
    const interval = duration / steps;
    const start = { 
      successRate: Number(this.stats.successRate) || 0,
      recordedCount: Number(this.stats.recordedCount) || 0,
      totalDepts: Number(this.stats.totalDepts) || 0,
      pendingCount: Number(this.stats.pendingCount) || 0,
      rank: Number(this.stats.rank) || 1
    };
    const end = target;
    let currentStep = 0;
    this.animationTimer = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;
      const ease = 1 - Math.pow(1 - progress, 4);
      this.stats.successRate = (start.successRate + (Number(end.successRate) - start.successRate) * ease).toFixed(1);
      this.stats.recordedCount = Math.round(start.recordedCount + (Number(end.recordedCount) - start.recordedCount) * ease);
      this.stats.totalDepts = Math.round(start.totalDepts + (Number(end.totalDepts) - start.totalDepts) * ease);
      this.stats.pendingCount = Math.round(start.pendingCount + (Number(end.pendingCount) - start.pendingCount) * ease);
      this.stats.rank = Math.round(start.rank + (Number(end.rank) - start.rank) * ease);
      if (currentStep >= steps) {
        clearInterval(this.animationTimer);
        this.stats = end;
      }
      this.cdr.detectChanges();
    }, interval);
  }

  get pagedData() {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    const pageItems = this.filteredData.slice(startIndex, startIndex + this.pageSize);
    for (let i = 0; i < pageItems.length; i++) {
      if (i === 0 || pageItems[i].main_indicator_name !== pageItems[i - 1].main_indicator_name) {
        let span = 1;
        for (let j = i + 1; j < pageItems.length; j++) {
          if (pageItems[j].main_indicator_name === pageItems[i].main_indicator_name) {
            span++;
          } else {
            break;
          }
        }
        pageItems[i].rowSpan = span;
      } else {
        pageItems[i].rowSpan = 0;
      }
    }
    return pageItems;
  }

  // ฟังก์ชันหาปีงบประมาณปัจจุบัน
  setDefaultYear() {
    const today = new Date();
    let year = today.getFullYear();
    if (today.getMonth() >= 9) { // เดือน 10 (ดัชนี 9) เป็นต้นไป คือปีงบประมาณถัดไป
      year += 1;
    }
    this.selectedYear = (year + 543).toString();
  }

  extractFilterLists() {
    this.mainCategories = [...new Set(this.kpiData.map(item => item.main_indicator_name))];
    this.indicatorNames = [...new Set(this.kpiData.map(item => item.kpi_indicators_name))];
    this.deptNames = [...new Set(this.kpiData.map(item => item.dept_name))];
    this.filterYears = [...new Set(this.kpiData.map(item => item.year_bh))].sort().reverse();
  }

  onYearChange() {
    this.applyFilters();
    this.loadDashboardStats();
  }

  filterPending() {
    this.selectedStatus = 'pending';
    this.applyFilters();
  }

  applyFilters() {
    this.filteredData = this.kpiData.filter(item => {
      const deptName = item.dept_name || '';
      const year = item.year_bh || '';
      const mainindicatorName = item.main_indicator_name || '';
      const indicatorName = item.kpi_indicators_name || '';
      const recorderName = item.recorder_name || '';
      const search = this.searchTerm.toLowerCase();
      const matchSearch = indicatorName.toLowerCase().includes(search) ||
                        recorderName.toLowerCase().includes(search) ||
                        deptName.toLowerCase().includes(search) ||
                        mainindicatorName.toLowerCase().includes(search);
      const matchMain = this.selectedMain === '' || item.main_indicator_name === this.selectedMain;
      const matchIndicator = this.selectedIndicator === '' || item.kpi_indicators_name === this.selectedIndicator;
      const matchdept = this.selectedDept === '' || item.dept_name === this.selectedDept;
      const matchYear = this.selectedYear === '' || item.year_bh === this.selectedYear;
      const matchStatus = this.selectedStatus === '' || 
                          (this.selectedStatus === 'pass' && item.total_actual >= item.target_value) ||
                          (this.selectedStatus === 'fail' && item.total_actual < item.target_value) ||
                          (this.selectedStatus === 'pending' && item.pending_count > 0);
      return matchSearch && matchMain && matchIndicator && matchdept && matchYear && matchStatus;
    });
    this.filteredData.sort((a, b) => {
      if (b.year_bh !== a.year_bh) return b.year_bh.localeCompare(a.year_bh);
      if (a.main_indicator_name < b.main_indicator_name) return -1;
      if (a.main_indicator_name > b.main_indicator_name) return 1;
      return a.kpi_indicators_name.localeCompare(b.kpi_indicators_name);
    });
    this.totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    this.currentPage = 1;
  }

  toggleEditMode() {
    if (!this.isEditing) {
      this.filteredData.forEach(item => {
        item._original = { ...item };
      });
      this.isEditing = true;
      Swal.fire({
        icon: 'info',
        title: 'เข้าสู่โหมดแก้ไข',
        text: 'คุณสามารถแก้ไขตัวเลขในตารางได้แล้ว',
        timer: 1500,
        showConfirmButton: false
      });
    } else {
      this.resetData(false);
      this.isEditing = false;
    }
  }

  saveKpiData() {
    const invalidItems = this.filteredData.filter(item => Number(item.target_value) === 0);
    if (invalidItems.length > 0) {
      Swal.fire({
        icon: 'warning',
        title: 'พบค่าเป้าหมายเป็น 0',
        text: `มีข้อมูล ${invalidItems.length} รายการ ที่ค่าเป้าหมายเป็น 0 ซึ่งจะทำให้คำนวณ % ไม่ได้ กรุณาแก้ไขก่อนบันทึก`,
        confirmButtonText: 'ตกลง, ไปแก้ไข'
      });
      return;
    }
    this.saveDataToBackend(this.filteredData, false);
  }

  saveDataToBackend(data: any[], isNew: boolean) {
    Swal.fire({
      title: 'กำลังบันทึกข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });
    this.authService.updateKpiResults(data).subscribe({
      next: (res) => {
        Swal.fire('สำเร็จ', isNew ? 'เพิ่มตัวชี้วัดเรียบร้อยแล้ว' : 'บันทึกผล KPI เรียบร้อยแล้ว', 'success');
        this.isEditing = false;
        this.showAddModal = false;
        this.loadKpiData();
        this.loadDashboardStats();
      },
      error: (err) => {
        Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถบันทึกข้อมูลได้', 'error');
        console.error(err);
      }
    });
  }

  approveKpi(item: any) {
    Swal.fire({
      title: 'ยืนยันการรับรอง',
      text: `คุณต้องการรับรองและล็อคข้อมูลของ ${item.kpi_indicators_name} ใช่หรือไม่?`,
      icon: 'info',
      showCancelButton: true,
      confirmButtonColor: '#10b981',
      confirmButtonText: 'ใช่, รับรองข้อมูล',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.approveKpi(item.indicator_id, item.year_bh, item.hospcode).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'รับรองและล็อคข้อมูลเรียบร้อยแล้ว', 'success');
              this.loadKpiData();
              this.loadPendingCount();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
        });
      }
    });
  }

  approveAll() {
    const pendingItems = this.filteredData.filter(item => item.pending_count > 0);
    if (pendingItems.length === 0) return;
    Swal.fire({
      title: 'ยืนยันการอนุมัติ',
      text: `คุณต้องการอนุมัติรายการที่รอตรวจสอบจำนวน ${pendingItems.length} รายการใช่หรือไม่?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#198754',
      cancelButtonColor: '#d33',
      confirmButtonText: 'ใช่, อนุมัติทั้งหมด',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        const approvals = pendingItems.map(item => ({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode
        }));
        this.authService.approveKpiResults(approvals).subscribe({
          next: (res) => {
            Swal.fire('สำเร็จ', 'อนุมัติข้อมูลเรียบร้อยแล้ว', 'success');
            this.loadKpiData();
            this.loadDashboardStats();
            this.loadPendingCount();
          },
          error: (err) => Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถอนุมัติข้อมูลได้', 'error')
        });
      }
    });
  }

  unlockKpi(item: any) {
    Swal.fire({
      title: 'ยืนยันการปลดล็อค',
      text: `คุณต้องการปลดล็อคข้อมูลของ ${item.kpi_indicators_name} เพื่อให้หน่วยงานแก้ไขได้ใช่หรือไม่?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#f59e0b',
      confirmButtonText: 'ใช่, ปลดล็อค',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.unlockKpi(item.indicator_id, item.year_bh, item.hospcode).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'ปลดล็อคข้อมูลเรียบร้อยแล้ว', 'success');
              this.loadKpiData();
              this.loadPendingCount();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
        });
      }
    });
  }

  openAddModal() {
    this.calculateAddKpiYears();
    if (this.addKpiYears.includes(this.selectedYear)) {
      this.addKpiSelectedYear = this.selectedYear;
    } else {
      this.addKpiSelectedYear = this.addKpiYears[0];
    }
    this.loadAddKpiList();
  }

  calculateAddKpiYears() {
    const today = new Date();
    let year = today.getFullYear();
    if (today.getMonth() >= 9) { 
      year += 1;
    }
    const currentThaiYear = year + 543;
    this.addKpiYears = [];
    for (let i = 0; i < 4; i++) {
      this.addKpiYears.push((currentThaiYear + i).toString());
    }
  }

  loadAddKpiList() {
    Swal.fire({
      title: 'กำลังโหลดข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });
    this.authService.getKpiTemplate().subscribe({
      next: (res) => {
        Swal.close();
        if (res.success) {
          const existingIds = new Set(
            this.kpiData
              .filter(k => k.year_bh === this.addKpiSelectedYear)
              .map(k => k.indicator_id)
          );
          let available = res.data.filter((item: any) => !existingIds.has(item.indicator_id));
          if (!this.isAdmin && this.currentUser?.dept_name) {
             available = available.filter((item: any) => item.dept_name === this.currentUser.dept_name);
          }
          this.newKpiList = available.map((item: any) => ({
            ...item,
            year_bh: this.addKpiSelectedYear,
            target_value: 0,
            oct: 0, nov: 0, dece: 0, jan: 0, feb: 0, mar: 0,
            apr: 0, may: 0, jun: 0, jul: 0, aug: 0, sep: 0,
            total_actual: 0
          }));
          this.ngZone.run(() => {
            this.showAddModal = true;
            setTimeout(() => {
              this.cdr.detectChanges();
            }, 50);
          });
        }
      },
      error: () => {
        Swal.close();
        Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลตัวชี้วัดได้', 'error');
      }
    });
  }

  closeAddModal() {
    this.showAddModal = false;
    this.cdr.detectChanges();
  }

  saveNewKpis() {
     const itemsToSave = this.newKpiList.filter(item => item.target_value > 0 || item.total_actual > 0);
     if (itemsToSave.length === 0) {
        Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลอย่างน้อย 1 รายการ (เป้าหมาย หรือ ผลงาน)', 'warning');
        return;
     }
     this.saveDataToBackend(itemsToSave, true);
  }

  openTrendModal(item: any) {
    this.selectedKpiName = item.kpi_indicators_name;
    const data = [
      item.oct, item.nov, item.dece, item.jan, item.feb, item.mar,
      item.apr, item.may, item.jun, item.jul, item.aug, item.sep
    ];
    this.kpiTrendOptions = {
      series: [{
        name: "ผลงาน",
        data: data
      }],
      chart: {
        height: 350,
        type: "line",
        zoom: { enabled: false },
        fontFamily: 'Prompt, sans-serif',
        toolbar: { show: false }
      },
      dataLabels: { enabled: true },
      stroke: { curve: "smooth", width: 3 },
      title: { text: "แนวโน้มผลงานรายเดือน", align: "left" },
      grid: { row: { colors: ["#f3f3f3", "transparent"], opacity: 0.5 } },
      xaxis: {
        categories: ["ต.ค.", "พ.ย.", "ธ.ค.", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย."],
      },
      colors: ['#10B981'],
      markers: { size: 5, hover: { size: 7 } }
    };
    this.showTrendModal = true;
  }

  closeTrendModal() {
    this.showTrendModal = false;
  }

  resetData(confirm: boolean = true) {
    const restore = () => {
      this.filteredData.forEach(item => {
        if (item._original) {
          Object.assign(item, item._original);
        }
      });
      this.cdr.detectChanges();
    };
    if (confirm) {
      Swal.fire({
        title: 'ยืนยันการคืนค่า',
        text: "ข้อมูลที่แก้ไขจะถูกย้อนกลับเป็นค่าเริ่มต้น",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'ใช่, คืนค่า',
        cancelButtonText: 'ยกเลิก'
      }).then((result) => {
        if (result.isConfirmed) {
          restore();
          Swal.fire({ icon: 'success', title: 'คืนค่าข้อมูลเรียบร้อยแล้ว', toast: true, position: 'top-end', timer: 3000, showConfirmButton: false });
        }
      });
    } else {
      restore();
    }
  }

  onValueChange(item: any, month: string) {
    if (item[month] < 0) {
      item[month] = 0;
    }
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    let sum = 0;
    for (const m of months) {
      sum += Number(item[m]) || 0;
    }
    item.total_actual = sum;
  }

  isModified(item: any, month: string): boolean {
    if (!item._original) return false;
    return item[month] != item._original[month];
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

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }
}
