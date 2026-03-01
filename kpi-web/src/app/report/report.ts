import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { NgApexchartsModule, ApexOptions } from 'ng-apexcharts';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-report',
  standalone: true,
  imports: [CommonModule, RouterModule, NgApexchartsModule, FormsModule],
  templateUrl: './report.html',
  styleUrl: './report.css'
})
export class ReportComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  // Sidebar & Header
  isSidebarOpen: boolean = true;
  isLoading: boolean = false;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  currentUser: any = null;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;

  unreadNotifCount: number = 0;
  notifications: any[] = [];
  showNotifDropdown: boolean = false;

  // Change Password Modal
  showChangePasswordModal: boolean = false;
  changePasswordForm: any = { currentPassword: '', newPassword: '', confirmPassword: '' };
  showCurrentPw: boolean = false;
  showNewPw: boolean = false;
  showConfirmPw: boolean = false;

  // Report Tab
  activeTab: string = 'by-indicator';

  // Filters
  selectedYear: string = '';
  selectedDeptId: string = '';
  selectedDistId: string = '';
  filterYears: string[] = [];
  departments: any[] = [];
  districts: any[] = [];

  // Report Data
  reportData: any[] = [];

  // Summary Stats
  summaryStats = {
    totalIndicators: 0,
    totalHospitals: 0,
    avgAchievement: 0,
    totalTarget: 0,
    totalActual: 0
  };

  // Charts
  public barChartOptions: Partial<ApexOptions> | any = {
    series: [], chart: { type: 'bar', height: 400, fontFamily: 'Sarabun, sans-serif' }
  };
  public pieChartOptions: Partial<ApexOptions> | any = {
    series: [], chart: { type: 'pie', height: 350, fontFamily: 'Sarabun, sans-serif' }
  };

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    this.loadSettings();
    this.loadPendingKpiCount();
    this.loadUnreadNotifCount();
    this.loadFilters();
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

  loadSettings() {
    this.authService.getSettings().subscribe({
      next: (res) => {
        if (res.success && res.data) {
          const v = res.data.find((s: any) => s.setting_key === 'system_version');
          if (v) this.systemVersion = v.setting_value;
        }
      }
    });
  }

  loadFilters() {
    this.authService.getDepartments().subscribe({
      next: (res) => { if (res.success) this.departments = res.data; }
    });
    this.authService.getDistricts().subscribe({
      next: (res) => { if (res.success) this.districts = res.data; }
    });
    // Get available years from kpi_results
    this.authService.getKpiResults().subscribe({
      next: (res) => {
        if (res.success) {
          this.filterYears = [...new Set(res.data.map((item: any) => String(item.year_bh)))].sort().reverse() as string[];
          this.setDefaultYear();
          this.loadReport();
        }
      }
    });
  }

  setDefaultYear() {
    const currentYear = (new Date().getFullYear() + 543).toString();
    if (this.filterYears.includes('2569')) {
      this.selectedYear = '2569';
    } else if (this.filterYears.includes(currentYear)) {
      this.selectedYear = currentYear;
    } else if (this.filterYears.length > 0) {
      this.selectedYear = this.filterYears[0];
    }
  }

  switchTab(tab: string) {
    this.activeTab = tab;
    this.loadReport();
  }

  onFilterChange() {
    this.loadReport();
  }

  clearFilters() {
    this.selectedYear = this.filterYears.length > 0 ? this.filterYears[0] : '';
    this.selectedDeptId = '';
    this.selectedDistId = '';
    this.loadReport();
  }

  loadReport() {
    this.isLoading = true;
    const params: any = {};
    if (this.selectedYear) params.year_bh = this.selectedYear;
    if (this.selectedDeptId) params.dept_id = this.selectedDeptId;
    if (this.selectedDistId) params.distid = this.selectedDistId;

    let observable;
    switch (this.activeTab) {
      case 'by-indicator': observable = this.authService.getReportByIndicator(params); break;
      case 'by-hospital': observable = this.authService.getReportByHospital(params); break;
      case 'by-district': observable = this.authService.getReportByDistrict(params); break;
      case 'by-year': observable = this.authService.getReportByYear(params); break;
      default: observable = this.authService.getReportByIndicator(params);
    }

    observable.subscribe({
      next: (res: any) => {
        this.isLoading = false;
        if (res.success) {
          this.reportData = res.data;
          this.calculateSummary();
          this.updateChart();
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.isLoading = false;
        console.error('Report error:', err);
        this.cdr.detectChanges();
      }
    });
  }

  calculateSummary() {
    if (this.activeTab === 'by-indicator') {
      this.summaryStats.totalIndicators = this.reportData.length;
      this.summaryStats.totalHospitals = new Set(this.reportData.map(d => d.hospital_count)).size;
      this.summaryStats.totalTarget = this.reportData.reduce((s, d) => s + (Number(d.target_value) || 0), 0);
      this.summaryStats.totalActual = this.reportData.reduce((s, d) => s + (Number(d.total_actual) || 0), 0);
      this.summaryStats.avgAchievement = this.summaryStats.totalTarget > 0
        ? Math.round((this.summaryStats.totalActual / this.summaryStats.totalTarget) * 10000) / 100 : 0;
    } else if (this.activeTab === 'by-hospital') {
      this.summaryStats.totalHospitals = this.reportData.length;
      this.summaryStats.totalIndicators = this.reportData.reduce((s, d) => s + (Number(d.indicator_count) || 0), 0);
      this.summaryStats.totalTarget = this.reportData.reduce((s, d) => s + (Number(d.total_target) || 0), 0);
      this.summaryStats.totalActual = this.reportData.reduce((s, d) => s + (Number(d.total_actual) || 0), 0);
      this.summaryStats.avgAchievement = this.reportData.length > 0
        ? Math.round(this.reportData.reduce((s, d) => s + (Number(d.achievement_pct) || 0), 0) / this.reportData.length * 100) / 100 : 0;
    } else if (this.activeTab === 'by-district') {
      this.summaryStats.totalHospitals = this.reportData.reduce((s, d) => s + (Number(d.hospital_count) || 0), 0);
      this.summaryStats.totalIndicators = this.reportData.reduce((s, d) => s + (Number(d.indicator_count) || 0), 0);
      this.summaryStats.totalTarget = this.reportData.reduce((s, d) => s + (Number(d.total_target) || 0), 0);
      this.summaryStats.totalActual = this.reportData.reduce((s, d) => s + (Number(d.total_actual) || 0), 0);
      this.summaryStats.avgAchievement = this.reportData.length > 0
        ? Math.round(this.reportData.reduce((s, d) => s + (Number(d.achievement_pct) || 0), 0) / this.reportData.length * 100) / 100 : 0;
    } else {
      this.summaryStats.totalIndicators = this.reportData.reduce((s, d) => s + (Number(d.indicator_count) || 0), 0);
      this.summaryStats.totalHospitals = this.reportData.reduce((s, d) => s + (Number(d.hospital_count) || 0), 0);
      this.summaryStats.totalTarget = this.reportData.reduce((s, d) => s + (Number(d.total_target) || 0), 0);
      this.summaryStats.totalActual = this.reportData.reduce((s, d) => s + (Number(d.total_actual) || 0), 0);
      this.summaryStats.avgAchievement = this.reportData.length > 0
        ? Math.round(this.reportData.reduce((s, d) => s + (Number(d.achievement_pct) || 0), 0) / this.reportData.length * 100) / 100 : 0;
    }
  }

  updateChart() {
    switch (this.activeTab) {
      case 'by-indicator': {
        const data = this.reportData.slice(0, 20);
        const labels = data.map(d => (d.kpi_indicators_name || '').substring(0, 35));
        this.barChartOptions = {
          series: [
            { name: 'เป้าหมาย', data: data.map(d => Number(d.target_value) || 0) },
            { name: 'ผลงานรวม', data: data.map(d => Number(d.total_actual) || 0) }
          ],
          chart: { type: 'bar', height: 450, fontFamily: 'Sarabun, sans-serif' },
          plotOptions: { bar: { horizontal: false, columnWidth: '55%', borderRadius: 4 } },
          dataLabels: { enabled: false },
          stroke: { show: true, width: 2, colors: ['transparent'] },
          xaxis: { categories: labels, labels: { rotate: -45, style: { fontSize: '10px' } } },
          yaxis: { title: { text: 'คะแนน' }, labels: { formatter: (v: number) => v.toFixed(2) } },
          colors: ['#fbbf24', '#10b981'],
          title: { text: 'เปรียบเทียบ เป้าหมาย VS ผลงาน (รายตัวชี้วัด)', align: 'left' },
          tooltip: { y: { formatter: (v: any) => Number(v).toFixed(2) + ' คะแนน' } }
        };
        break;
      }
      case 'by-hospital': {
        const data = this.reportData.slice(0, 25);
        this.barChartOptions = {
          series: [{ name: '%สำเร็จ', data: data.map(d => Number(d.achievement_pct) || 0) }],
          chart: { type: 'bar', height: Math.max(400, data.length * 28), fontFamily: 'Sarabun, sans-serif' },
          plotOptions: { bar: { horizontal: true, barHeight: '70%', borderRadius: 4 } },
          dataLabels: { enabled: true, formatter: (v: any) => v.toFixed(2) + '%' },
          xaxis: { title: { text: '%ผลสำเร็จ' }, max: 200 },
          yaxis: { labels: { style: { fontSize: '11px' } } },
          colors: ['#10b981'],
          title: { text: 'อัตราผลสำเร็จ (%สำเร็จ) แยกรายหน่วยบริการ', align: 'left' },
          labels: data.map(d => (d.hosname || d.hospcode || '').substring(0, 30))
        };
        break;
      }
      case 'by-district': {
        const labels = this.reportData.map(d => d.distname || d.distid || '');
        const values = this.reportData.map(d => Number(d.achievement_pct) || 0);
        const actuals = this.reportData.map(d => Number(d.total_actual) || 0);
        this.barChartOptions = {
          series: [{ name: '%สำเร็จ', data: values }],
          chart: { type: 'bar', height: 400, fontFamily: 'Sarabun, sans-serif' },
          plotOptions: { bar: { columnWidth: '60%', borderRadius: 4 } },
          dataLabels: { enabled: true, formatter: (v: any) => v.toFixed(2) + '%' },
          xaxis: { categories: labels, labels: { rotate: -45, style: { fontSize: '10px' } } },
          yaxis: { title: { text: '%ผลสำเร็จ' } },
          colors: ['#3b82f6'],
          title: { text: 'อัตราผลสำเร็จ (%สำเร็จ) แยกรายอำเภอ', align: 'left' }
        };
        this.pieChartOptions = {
          series: actuals,
          chart: { type: 'pie', height: 380, fontFamily: 'Sarabun, sans-serif' },
          labels: labels,
          title: { text: 'สัดส่วนผลงานรวมแยกรายอำเภอ', align: 'left' },
          tooltip: { y: { formatter: (v: any) => Number(v).toFixed(2) } },
          dataLabels: { formatter: (v: any) => v.toFixed(1) + '%' },
          responsive: [{ breakpoint: 480, options: { chart: { width: 280 }, legend: { position: 'bottom' } } }]
        };
        break;
      }
      case 'by-year': {
        const labels = this.reportData.map(d => 'ปี ' + d.year_bh);
        this.barChartOptions = {
          series: [
            { name: 'เป้าหมายรวม', data: this.reportData.map(d => Number(d.total_target) || 0) },
            { name: 'ผลงานรวม', data: this.reportData.map(d => Number(d.total_actual) || 0) }
          ],
          chart: { type: 'bar', height: 400, fontFamily: 'Sarabun, sans-serif' },
          plotOptions: { bar: { columnWidth: '50%', borderRadius: 4 } },
          dataLabels: { enabled: true, formatter: (v: any) => Number(v).toFixed(2) },
          xaxis: { categories: labels },
          yaxis: { title: { text: 'คะแนน' }, labels: { formatter: (v: number) => v.toFixed(2) } },
          colors: ['#fbbf24', '#10b981'],
          title: { text: 'เปรียบเทียบ เป้าหมาย VS ผลงาน (รายปีงบประมาณ)', align: 'left' },
          tooltip: { y: { formatter: (v: any) => Number(v).toFixed(2) + ' คะแนน' } }
        };
        break;
      }
    }
  }

  exportExcel() {
    import('xlsx').then(XLSX => {
      const tabNames: any = {
        'by-indicator': 'รายข้อตัวชี้วัด',
        'by-hospital': 'รายหน่วยบริการ',
        'by-district': 'รายอำเภอ',
        'by-year': 'รายปีงบประมาณ'
      };
      const ws = XLSX.utils.json_to_sheet(this.reportData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, tabNames[this.activeTab] || 'Report');
      XLSX.writeFile(wb, `KPI_Report_${tabNames[this.activeTab]}_${this.selectedYear || 'all'}.xlsx`);
    });
  }

  printReport() {
    window.print();
  }

  // Change Password
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
