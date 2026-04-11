import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { NgApexchartsModule, ApexOptions } from "ng-apexcharts";
import { FormsModule } from '@angular/forms';
import { ReportComponent } from '../report/report';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-chart',
  standalone: true,
  imports: [CommonModule, RouterModule, NgApexchartsModule, FormsModule, ReportComponent],
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

  activeView: 'chart' | 'report' = 'chart';

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

  // ตัวแปรสำหรับแผนที่อำเภอ
  districtMapData: any[] = [];

  // ตัวแปรสำหรับ Stats
  stats: any = {
    successRate: 0,
    recordedCount: 0,
    totalDepts: 0,
    pendingCount: 0,
    rank: 0,
    totalHospitals: 0
  };
  private animationTimer: any;
  isLoading: boolean = true;
  isPublicView: boolean = false;

  ngOnInit() {
    this.isPublicView = !this.authService.isLoggedIn();
    if (!this.isPublicView) {
      // logged in: ถ้าเปิด root path ให้ redirect ไป dashboard
      const currentUrl = this.router.url;
      if (currentUrl === '/' || currentUrl === '') {
        this.router.navigate(['/dashboard']);
        return;
      }
    }
    this.loadKpiData();
  }

  loadKpiData() {
    this.isLoading = true;
    const source$ = this.isPublicView
      ? this.authService.getPublicKpiResults()
      : this.authService.getKpiSummary({ year: this.selectedYear });
    source$.subscribe({
      next: (res) => {
        if (res && res.success) {
          this.kpiData = res.data;
          // แปลงข้อมูล (รองรับทั้งตัวเลขและข้อความ)
          this.kpiData.forEach(item => {
            item.target_value = item.target_value != null ? String(item.target_value) : '';
            item.last_actual = String(item.last_actual ?? '');
            item.total_actual = parseFloat(item.last_actual) || 0;
            item.target_num = parseFloat(item.target_value) || 0;
            item.year_bh = String(item.year_bh);
            ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].forEach(m => {
              item[m + '_raw'] = item[m] != null ? String(item[m]) : '';
              item[m] = parseFloat(item[m]) || 0;
            });
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
    const stats$ = this.isPublicView
      ? this.authService.getPublicDashboardStats(this.selectedYear)
      : this.authService.getDashboardStats(this.selectedYear);
    stats$.subscribe({
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
      rank: Number(this.stats.rank) || 0,
      totalHospitals: Number(this.stats.totalHospitals) || 0
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
      this.stats.totalHospitals = Math.round(start.totalHospitals + (Number(end.totalHospitals) - start.totalHospitals) * ease);

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
    this.updateDistrictMap();
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
      categoryData[key].target += item.target_num;
      categoryData[key].actual += item.total_actual;
    });

    const labels = Object.keys(categoryData);
    const targets = labels.map(l => categoryData[l].target);
    const actuals = labels.map(l => categoryData[l].actual);

    // 1. Bar Chart Config (เป้าหมาย VS ผลงาน)
    // คำนวณ % ผลงาน/เป้าหมาย
    const pctData = labels.map((_: any, i: number) => {
      const t = targets[i] || 0;
      const a = actuals[i] || 0;
      return t > 0 ? Math.round((a / t) * 100) : 0;
    });

    this.barChartOptions = {
      series: [
        { name: "% ผลงาน/เป้าหมาย", data: pctData },
      ],
      chart: {
        type: "bar",
        height: Math.max(450, labels.length * 40),
        fontFamily: 'Sarabun, sans-serif',
        toolbar: { show: true }
      },
      plotOptions: {
        bar: {
          horizontal: true,
          barHeight: "65%",
          borderRadius: 4,
          dataLabels: { position: 'top' },
          colors: {
            ranges: [
              { from: 0, to: 49.99, color: '#ef4444' },
              { from: 50, to: 79.99, color: '#f59e0b' },
              { from: 80, to: 200, color: '#10b981' }
            ]
          }
        }
      },
      dataLabels: {
        enabled: true,
        formatter: function(val: any) { return val + '%'; },
        offsetX: 20,
        style: { fontSize: '11px', fontWeight: 'bold' }
      },
      stroke: { show: false },
      xaxis: {
        categories: labels,
        max: 120,
        labels: { formatter: (val: any) => val + '%' },
        title: { text: '% ผลงาน/เป้าหมาย' }
      },
      yaxis: { labels: { style: { fontSize: '11px' }, maxWidth: 250 } },
      fill: { opacity: 1 },
      colors: ['#10b981'],
      title: { text: 'เปรียบเทียบ % ผลงาน/เป้าหมาย (แยกตามหมวดหมู่)', align: 'left' },
      tooltip: {
        custom: function({ series, seriesIndex, dataPointIndex, w }: any) {
          const name = w.globals.labels[dataPointIndex];
          const pct = series[seriesIndex][dataPointIndex];
          return `<div style="padding:8px 12px"><b>${name}</b><br>ผลงาน: <b>${pct}%</b></div>`;
        }
      },
      annotations: {
        xaxis: [{ x: 80, borderColor: '#16a34a', strokeDashArray: 4, label: { text: 'เป้าหมาย 80%', style: { color: '#16a34a', fontSize: '11px' } } }]
      }
    };

    // กราฟเส้น
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const monthLabels = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];
    
    const monthlyActuals = months.map(m => this.filteredData.reduce((sum, item) => sum + (item[m] || 0), 0));
    const totalTarget = this.filteredData.reduce((sum, item) => sum + item.target_num, 0);
    const avgTarget = totalTarget / 12;
    const targetLine = new Array(12).fill(avgTarget);

    // 2. Line Chart Config (แนวโน้มรายเดือน)
    this.trendChartOptions = {
      series: [
        { name: "ผลงานรายเดือน", data: monthlyActuals },
        { name: "ค่าเฉลี่ยเป้าหมาย", data: targetLine }
      ],
      chart: { type: "area", height: 400, fontFamily: 'Sarabun, sans-serif', toolbar: { show: true } },
      fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0.05, stops: [0, 100] } },
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
      deptData[key] += item.total_actual;
    });

    // กรองเฉพาะ dept ที่มีค่า > 0 (Pie ไม่แสดง 0)
    const pieLabels = Object.keys(deptData).filter(k => deptData[k] > 0);
    const pieValues = pieLabels.map(k => deptData[k]);

    // 3. Pie Chart Config (สัดส่วนหน่วยงาน)
    this.pieChartOptions = {
      series: pieValues,
      chart: { type: "donut", height: 400, fontFamily: 'Sarabun, sans-serif' },
      labels: pieLabels,
      title: { text: 'สัดส่วนผลงานแยกตามหน่วยงาน', align: 'left' },
      plotOptions: {
        pie: {
          donut: {
            size: '55%',
            labels: {
              show: true,
              name: { show: true, fontSize: '14px', fontWeight: 'bold' },
              value: { show: true, fontSize: '16px', formatter: (val: any) => Number(val).toFixed(2) },
              total: { show: true, label: 'ผลงานรวม', fontSize: '13px', formatter: (w: any) => w.globals.seriesTotals.reduce((a: number, b: number) => a + b, 0).toFixed(2) }
            }
          }
        }
      },
      legend: { position: 'bottom', fontSize: '12px' },
      tooltip: {
        y: { formatter: function(val: any) { return Number(val).toFixed(2); } }
      },
      dataLabels: {
        enabled: true,
        formatter: function (val: any) { return val.toFixed(1) + "%"; },
        style: { fontSize: '11px' }
      },
      responsive: [{
        breakpoint: 640,
        options: {
          chart: { height: 350 },
          legend: { position: "bottom" }
        }
      }]
    };
  }

  updateDistrictMap() {
    // สร้างข้อมูลรายอำเภอจาก filteredData (ใช้ distname จาก kpiData)
    const distMap: any = {};
    this.filteredData.forEach(item => {
      const key = item.distname || 'ไม่ระบุ';
      if (!distMap[key]) distMap[key] = { target: 0, actual: 0 };
      distMap[key].target += item.target_num || 0;
      distMap[key].actual += item.total_actual || 0;
    });

    this.districtMapData = Object.keys(distMap)
      .filter(k => k !== 'ไม่ระบุ')
      .map(name => {
        const d = distMap[name];
        const pct = d.target > 0 ? Math.round((d.actual / d.target) * 10000) / 100 : 0;
        return { name, target: d.target, actual: d.actual, pct };
      })
      .sort((a, b) => b.pct - a.pct);
  }

  getDistrictColor(pct: number): string {
    if (pct >= 80) return '#16a34a'; // เขียว
    if (pct >= 50) return '#eab308'; // เหลือง
    return '#dc2626'; // แดง
  }

  countDistricts(level: string): number {
    if (level === 'green') return this.districtMapData.filter((d: any) => d.pct >= 80).length;
    if (level === 'yellow') return this.districtMapData.filter((d: any) => d.pct >= 50 && d.pct < 80).length;
    return this.districtMapData.filter((d: any) => d.pct < 50).length;
  }

  getDistrictBg(pct: number): string {
    if (pct >= 80) return 'bg-green-100 border-green-400 text-green-800';
    if (pct >= 50) return 'bg-yellow-100 border-yellow-400 text-yellow-800';
    return 'bg-red-100 border-red-400 text-red-800';
  }

  goBack() {
    this.router.navigate(['/dashboard']);
  }
}
