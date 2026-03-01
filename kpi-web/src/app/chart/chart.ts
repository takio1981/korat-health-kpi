import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { NgApexchartsModule, ApexOptions } from "ng-apexcharts";
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-chart',
  standalone: true,
  imports: [CommonModule, RouterModule, NgApexchartsModule, FormsModule],
  templateUrl: './chart.html'
})
export class ChartComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  kpiData: any[] = [];
  filteredData: any[] = []; // เก็บข้อมูลที่ผ่านการกรองแล้ว

  // ตัวแปรสำหรับตัวกรอง
  selectedMain: string = '';
  selectedIndicator: string = '';
  selectedDept: string = '';
  selectedYear: string = '';

  // รายการใน Dropdown
  mainCategories: string[] = [];
  indicatorNames: string[] = [];
  deptNames: string[] = [];
  filterYears: string[] = [];

  // ตัวแปร Config สำหรับ ApexCharts
  public barChartOptions: Partial<ApexOptions> | any = {
    series: [],
    chart: {
      type: "bar",
      height: 450,
      fontFamily: 'Sarabun, sans-serif'
    }
  };
  public trendChartOptions: Partial<ApexOptions> | any = {
    series: [],
    chart: {
      type: "line",
      height: 350,
      fontFamily: 'Sarabun, sans-serif'
    }
  };
  public pieChartOptions: Partial<ApexOptions> | any = {
    series: [],
    chart: {
      type: "pie",
      height: 350,
      fontFamily: 'Sarabun, sans-serif'
    }
  };

  // ตัวแปรสำหรับ Stats
  stats: any = {
    successRate: 0,
    recordedCount: 0,
    totalDepts: 0,
    pendingCount: 0,
    rank: 1
  };
  private animationTimer: any;

  isSidebarOpen: boolean = true; // ตัวแปรควบคุม Sidebar
  isLoading: boolean = true; // เริ่มต้นเป็น true เพื่อรอโหลดข้อมูล และป้องกันกราฟเรนเดอร์ก่อนข้อมูลมา
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  currentUser: any = null;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;

  // Change Password Modal
  showChangePasswordModal: boolean = false;
  changePasswordForm: any = { currentPassword: '', newPassword: '', confirmPassword: '' };
  showCurrentPw: boolean = false;
  showNewPw: boolean = false;
  showConfirmPw: boolean = false;

  ngOnInit() {
    this.loadKpiData();
    this.currentUser = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    this.loadSettings();
    this.loadPendingKpiCount();

    // ตรวจสอบว่าเคยแสดงข้อความต้อนรับไปหรือยังใน Session นี้
    if (!sessionStorage.getItem('welcomeShown')) {
      Swal.fire({
        title: `ยินดีต้อนรับ คุณ${this.currentUser?.firstname || ''} ${this.currentUser?.lastname || ''}`,
        text: 'เข้าสู่ระบบบันทึกข้อมูลผลการดำเนินงาน KPI สำเร็จแล้ว',
        icon: 'success',
        timer: 3000,
        showConfirmButton: false
      });
      sessionStorage.setItem('welcomeShown', 'true');
    }
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
          const versionSetting = res.data.find((s: any) => s.setting_key === 'system_version');
          if (versionSetting) {
            this.systemVersion = versionSetting.setting_value;
          }
        }
      }
    });
  }

  loadKpiData() {
    this.isLoading = true;
    this.authService.getKpiResults().subscribe({
      next: (res) => {
        if (res && res.success) {
          this.kpiData = res.data;
          // แปลงข้อมูลเป็นตัวเลข
          this.kpiData.forEach(item => {
            item.target_value = Number(item.target_value) || 0;
            item.total_actual = Number(item.total_actual) || 0;
            item.year_bh = String(item.year_bh); // บังคับแปลงปีเป็น String เพื่อความเสถียรในการกรอง
            ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].forEach(m => item[m] = Number(item[m]) || 0);
          });
          
          this.filteredData = [...this.kpiData]; // เริ่มต้นให้ข้อมูลแสดงทั้งหมด
          this.extractFilterLists();
          this.setDefaultYear();
          this.applyFilters(); // กรองและวาดกราฟครั้งแรก
          this.loadDashboardStats(); // โหลดข้อมูลสถิติ
        }
        this.isLoading = false; // ย้ายมาปิด Loading ตรงนี้ หลังจากเตรียมข้อมูลกราฟเสร็จแล้ว
        this.cdr.detectChanges(); // สั่งอัปเดตหน้าจอทันที
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error loading KPI:', err);
        this.cdr.detectChanges(); // สั่งอัปเดตหน้าจอแม้เกิดข้อผิดพลาด
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

  extractFilterLists() {
    this.mainCategories = [...new Set(this.kpiData.map(item => item.main_indicator_name))];
    this.indicatorNames = [...new Set(this.kpiData.map(item => item.kpi_indicators_name))];
    this.deptNames = [...new Set(this.kpiData.map(item => item.dept_name))];
    this.filterYears = [...new Set(this.kpiData.map(item => item.year_bh))].sort().reverse();
  }

  setDefaultYear() {
    const currentYear = (new Date().getFullYear() + 543).toString();
    
    // ลำดับการเลือก: ปี 2569 -> ปีปัจจุบัน -> ปีล่าสุดที่มีข้อมูล
    if (this.filterYears.includes('2569')) {
      this.selectedYear = '2569';
    } else if (this.filterYears.includes(currentYear)) {
      this.selectedYear = currentYear;
    } else if (this.filterYears.length > 0) {
      this.selectedYear = this.filterYears[0];
    } else {
      this.selectedYear = '';
    }
  }

  applyFilters() {
    this.filteredData = this.kpiData.filter(item => {
      const matchMain = this.selectedMain === '' || item.main_indicator_name === this.selectedMain;
      const matchIndicator = this.selectedIndicator === '' || item.kpi_indicators_name === this.selectedIndicator;
      const matchDept = this.selectedDept === '' || item.dept_name === this.selectedDept;
      const matchYear = this.selectedYear === '' || item.year_bh === this.selectedYear;
      
      return matchMain && matchIndicator && matchDept && matchYear;
    });
    
    // อัปเดตกราฟด้วยข้อมูลที่กรองแล้ว
    this.updateChart();
    this.loadDashboardStats(); // อัปเดต Stats เมื่อมีการกรอง (ถ้าต้องการให้ Stats เปลี่ยนตามปีที่เลือก)
    this.cdr.detectChanges(); // บังคับอัปเดตหน้าจอทันทีหลังจากคำนวณกราฟเสร็จ
  }

  updateChart() {
    // 1. เตรียมข้อมูลสำหรับกราฟ (Group by Main Category)
    const categoryData: any = {};
    
    // ใช้ filteredData แทน kpiData
    this.filteredData.forEach(item => {
      const key = item.main_indicator_name || 'อื่นๆ';
      if (!categoryData[key]) {
        categoryData[key] = { target: 0, actual: 0 };
      }
      categoryData[key].target += Number(item.target_value) || 0;
      categoryData[key].actual += Number(item.total_actual) || 0;
    });

    const labels = Object.keys(categoryData);
    const targets = labels.map(l => categoryData[l].target);
    const actuals = labels.map(l => categoryData[l].actual);

    // 1. Bar Chart Config (เป้าหมาย VS ผลงาน)
    this.barChartOptions = {
      series: [
        { name: "เป้าหมาย (Target)", data: targets },
        { name: "ผลงานรวม (Result)", data: actuals }
      ],
      chart: {
        type: "bar",
        height: 450, // เพิ่มความสูง
        fontFamily: 'Sarabun, sans-serif'
      },
      plotOptions: {
        bar: {
          horizontal: false,
          columnWidth: "55%",
          borderRadius: 4
        }
      },
      dataLabels: { enabled: false },
      stroke: { show: true, width: 2, colors: ["transparent"] },
      xaxis: { categories: labels },
      yaxis: { 
        title: { text: "คะแนน" },
        labels: { formatter: (val: number) => val.toFixed(2) } // ปรับแกน Y เป็น 2 ตำแหน่ง
      },
      fill: { opacity: 1 },
      colors: ['#fbbf24', '#10b981'], // สีเหลือง, สีเขียว
      title: { text: 'เปรียบเทียบ เป้าหมาย VS ผลงานรวม (แยกตามหมวดหมู่)', align: 'left' },
      tooltip: { // ปรับ Tooltip เป็น 2 ตำแหน่ง
        y: { formatter: function(val: any) { return Number(val).toFixed(2) + " คะแนน"; } }
      }
    };

    // กราฟเส้น
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const monthLabels = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];
    
    const monthlyActuals = months.map(m => this.filteredData.reduce((sum, item) => sum + (Number(item[m]) || 0), 0));
    const totalTarget = this.filteredData.reduce((sum, item) => sum + (Number(item.target_value) || 0), 0);
    const avgTarget = totalTarget / 12;
    const targetLine = new Array(12).fill(avgTarget);

    // 2. Line Chart Config (แนวโน้มรายเดือน)
    this.trendChartOptions = {
      series: [
        { name: "ผลงานรายเดือน", data: monthlyActuals },
        { name: "ค่าเฉลี่ยเป้าหมาย", data: targetLine }
      ],
      chart: { type: "line", height: 350, fontFamily: 'Sarabun, sans-serif' },
      stroke: { width: [4, 2], curve: 'smooth', dashArray: [0, 5] },
      labels: monthLabels,
      colors: ['#10b981', '#fbbf24'],
      title: { text: 'แนวโน้มผลงานรายเดือน (ต.ค. - ก.ย.)', align: 'left' },
      dataLabels: { // เพิ่มการแสดงตัวเลขบนกราฟและปรับทศนิยม 2 ตำแหน่ง
        enabled: true,
        formatter: function (val: any) {
          return Number(val).toFixed(2);
        }
      },
      tooltip: { // ปรับ Tooltip เป็น 2 ตำแหน่ง
        y: { formatter: function(val: any) { return Number(val).toFixed(2); } }
      },
      yaxis: { // ปรับแกน Y เป็น 2 ตำแหน่ง
        labels: { formatter: (val: number) => Number(val).toFixed(2) }
      }
    };

    // กราฟวงกลม (Pie Chart) แสดงสัดส่วนตามหน่วยงาน
    const deptData: any = {};
    this.filteredData.forEach(item => {
      const key = item.dept_name || 'ไม่ระบุ';
      if (!deptData[key]) deptData[key] = 0;
      deptData[key] += Number(item.total_actual) || 0;
    });

    const pieLabels = Object.keys(deptData);
    const pieValues = Object.values(deptData);

    // 3. Pie Chart Config (สัดส่วนหน่วยงาน)
    this.pieChartOptions = {
      series: pieValues,
      chart: { type: "pie", height: 350, fontFamily: 'Sarabun, sans-serif' },
      labels: pieLabels,
      title: { text: 'สัดส่วนผลงานแยกตามหน่วยงาน', align: 'left' },
      tooltip: { // ปรับ Tooltip เป็น 2 ตำแหน่ง
        y: { formatter: function(val: any) { return Number(val).toFixed(2); } }
      },
      dataLabels: { // ปรับตัวเลขบนกราฟ Pie เป็น 2 ตำแหน่ง
        formatter: function (val: any, opts: any) {
            return val.toFixed(2) + "%";
        }
      },
      responsive: [{
        breakpoint: 480,
        options: {
          chart: { width: 200 },
          legend: { position: "bottom" }
        }
      }]
    };
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

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  toggleSidebar() {
    this.isSidebarOpen = !this.isSidebarOpen;
  }

  goBack() {
    this.router.navigate(['/dashboard']);
  }
}
