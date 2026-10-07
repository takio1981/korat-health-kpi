import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { FormsModule } from '@angular/forms';
import { ReportComponent } from '../report/report';
import { ApexBoxComponent } from '../shared/apex-box';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import {
  ChartGroupRow, ChartMonthRow, buildPctBar, buildStatusStack, buildOverallDonut, buildOverallRadial,
  buildMonthlyCombo, buildHeatmap, buildDistribution, pctColor
} from './chart-builders';

type FilterKey = 'selectedYut' | 'selectedMain' | 'selectedDept' | 'selectedIndicator' | 'selectedDistrict' | 'selectedHostype';

@Component({
  selector: 'app-chart',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, ReportComponent, ApexBoxComponent],
  templateUrl: './chart.html'
})
export class ChartComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  activeView: 'chart' | 'report' = 'chart';
  isLoading = true;
  loadError = '';

  // ตัวกรอง (ค่า = id จาก /report/chart-stats options; '0' = "ไม่ระบุ")
  selectedYear = '';
  selectedYut = '';
  selectedMain = '';
  selectedDept = '';
  selectedIndicator = '';
  selectedDistrict = '';
  selectedHostype = '';

  options: any = { years: [], yuts: [], mains: [], depts: [], indicators: [], districts: [], hostypes: [] };
  data: any = null; // ผลดิบจาก API

  // options ของแต่ละกราฟ
  donutChart: any = {}; radialChart: any = {};
  yutPctChart: any = {}; yutStackChart: any = {};
  mainPctChart: any = {}; mainStackChart: any = {};
  deptPctChart: any = {}; deptStackChart: any = {};
  indicatorChart: any = {}; distributionChart: any = {};
  monthlyChart: any = {};
  heatMainChart: any = {}; heatDeptChart: any = {};
  districtChart: any = {}; hostypeChart: any = {};

  heatMetric: 'pass' | 'record' = 'pass';
  indicatorView: 'all' | 'top' | 'bottom' = 'all';
  indicatorSearch = '';
  tableSort: { key: string; dir: 1 | -1 } = { key: 'achievement_pct', dir: -1 };
  districtMapData: any[] = [];

  // การ์ดสถิติ (GET /dashboard-stats เดิม)
  stats: any = { successRate: 0, recordedCount: 0, totalDepts: 0, pendingCount: 0, rank: 0, totalHospitals: 0 };
  private animationTimer: any;
  private reqSeq = 0;

  ngOnInit() {
    const currentUrl = this.router.url;
    if (currentUrl === '/' || currentUrl === '') { this.router.navigate(['/dashboard']); return; }
    this.selectedYear = String(getCurrentFiscalYear());
    this.loadChartStats(true);
  }

  ngOnDestroy() {
    if (this.animationTimer) clearInterval(this.animationTimer);
  }

  private buildParams(): any {
    const p: any = {};
    if (this.selectedYear) p.year_bh = this.selectedYear;
    if (this.selectedYut) p.yut_id = this.selectedYut;
    if (this.selectedMain) p.main_id = this.selectedMain;
    if (this.selectedDept) p.dept_id = this.selectedDept;
    if (this.selectedIndicator) p.indicator_id = this.selectedIndicator;
    if (this.selectedDistrict) p.distid = this.selectedDistrict;
    if (this.selectedHostype) p.hostype = this.selectedHostype;
    return p;
  }

  // first = โหลดครั้งแรก: ถ้าปีงบปัจจุบันยังไม่มีข้อมูล ให้ถอยไปปีล่าสุดที่มีข้อมูล
  loadChartStats(first = false) {
    const seq = ++this.reqSeq;
    this.isLoading = true;
    this.loadError = '';
    this.authService.getReportChartStats(this.buildParams()).subscribe({
      next: (res) => {
        if (seq !== this.reqSeq) return; // ผลของคำขอเก่าที่ช้ากว่า — ทิ้ง
        if (res?.success) {
          this.options = res.options;
          if (first && res.options.years.length && !res.options.years.includes(this.selectedYear)) {
            this.selectedYear = res.options.years[0];
            this.loadChartStats();
            return;
          }
          this.data = res;
          this.buildCharts();
          this.loadDashboardStats();
        }
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        if (seq !== this.reqSeq) return;
        this.isLoading = false;
        this.loadError = err.error?.message || 'ไม่สามารถโหลดข้อมูลกราฟได้';
        this.cdr.detectChanges();
      }
    });
  }

  buildCharts() {
    const d = this.data;
    if (!d) return;
    const pick = (key: FilterKey, field: string) => (row: ChartGroupRow) => this.drillDown(key, String(row[field]));
    this.donutChart = buildOverallDonut(d.overall);
    this.radialChart = buildOverallRadial(d.overall);
    this.yutPctChart = buildPctBar(d.by_yut, 'ร้อยละผ่านเกณฑ์ แยกตามยุทธศาสตร์', pick('selectedYut', 'gkey'));
    this.yutStackChart = buildStatusStack(d.by_yut, 'จำนวนคู่ผ่าน/ไม่ผ่านเกณฑ์ แยกตามยุทธศาสตร์', false, pick('selectedYut', 'gkey'));
    this.mainPctChart = buildPctBar(d.by_main, 'ร้อยละผ่านเกณฑ์ แยกตามหมวดหมู่หลัก', pick('selectedMain', 'gkey'));
    this.mainStackChart = buildStatusStack(d.by_main, 'จำนวนคู่ผ่าน/ไม่ผ่านเกณฑ์ แยกตามหมวดหมู่หลัก', true, pick('selectedMain', 'gkey'));
    this.deptPctChart = buildPctBar(d.by_dept, 'ร้อยละผ่านเกณฑ์ แยกตามหน่วยงาน', pick('selectedDept', 'gkey'));
    this.deptStackChart = buildStatusStack(d.by_dept, 'จำนวนคู่ผ่าน/ไม่ผ่านเกณฑ์ แยกตามหน่วยงาน', true, pick('selectedDept', 'gkey'));
    this.distributionChart = buildDistribution(d.distribution);
    this.monthlyChart = buildMonthlyCombo(d.monthly);
    this.districtChart = buildPctBar(d.by_district, 'ร้อยละผ่านเกณฑ์ แยกตามอำเภอ', pick('selectedDistrict', 'gkey'));
    this.hostypeChart = buildPctBar(d.by_hostype, 'ร้อยละผ่านเกณฑ์ แยกตามประเภทหน่วยบริการ', pick('selectedHostype', 'gkey'));
    this.districtMapData = (d.by_district as ChartGroupRow[])
      .filter(r => r.gkey && r.with_target > 0)
      .map(r => ({ id: r.gkey, name: r.gname, pct: r.achievement_pct, passed: r.passed, total: r.with_target }));
    this.buildHeatmaps();
    this.buildIndicatorChart();
  }

  buildHeatmaps() {
    if (!this.data) return;
    const label = this.heatMetric === 'pass' ? 'ร้อยละผ่านเกณฑ์รายเดือน' : 'ร้อยละคู่ที่มีผลงานรายเดือน';
    this.heatMainChart = buildHeatmap(this.data.heatmap_main, `${label} — หมวดหมู่หลัก × เดือน`, this.heatMetric);
    this.heatDeptChart = buildHeatmap(this.data.heatmap_dept, `${label} — หน่วยงาน × เดือน`, this.heatMetric);
  }

  setHeatMetric(m: 'pass' | 'record') {
    this.heatMetric = m;
    this.buildHeatmaps();
    this.cdr.detectChanges();
  }

  get indicatorRows(): ChartGroupRow[] {
    if (!this.data) return [];
    const q = this.indicatorSearch.trim().toLowerCase();
    let rows: ChartGroupRow[] = this.data.by_indicator.filter((r: ChartGroupRow) => r.with_target > 0);
    if (q) rows = rows.filter(r => String(r.gname).toLowerCase().includes(q));
    if (this.indicatorView === 'top') rows = rows.slice(0, 10);
    if (this.indicatorView === 'bottom') rows = [...rows].sort((a, b) => a.achievement_pct - b.achievement_pct || b.with_target - a.with_target).slice(0, 10);
    return rows;
  }

  buildIndicatorChart() {
    const titles = { all: 'ร้อยละผ่านเกณฑ์ รายตัวชี้วัด (ทั้งหมด)', top: 'ตัวชี้วัด 10 อันดับผลสำเร็จสูงสุด', bottom: 'ตัวชี้วัด 10 อันดับที่ต้องเร่งรัด (ต่ำสุด)' };
    this.indicatorChart = buildPctBar(this.indicatorRows, titles[this.indicatorView], (row) => this.drillDown('selectedIndicator', String(row.gkey)));
  }

  setIndicatorView(v: 'all' | 'top' | 'bottom') {
    this.indicatorView = v;
    this.buildIndicatorChart();
    this.cdr.detectChanges();
  }

  onIndicatorSearch() {
    this.buildIndicatorChart();
    this.cdr.detectChanges();
  }

  // ตารางรายละเอียดรายตัวชี้วัด (รวมตัวที่ไม่มีเป้าหมาย)
  get tableRows(): ChartGroupRow[] {
    if (!this.data) return [];
    const q = this.indicatorSearch.trim().toLowerCase();
    const rows: ChartGroupRow[] = this.data.by_indicator.filter((r: ChartGroupRow) => !q || String(r.gname).toLowerCase().includes(q));
    const { key, dir } = this.tableSort;
    return [...rows].sort((a, b) => {
      const va = a[key], vb = b[key];
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va ?? '').localeCompare(String(vb ?? ''), 'th') * dir;
    });
  }

  sortTable(key: string) {
    this.tableSort = this.tableSort.key === key ? { key, dir: (this.tableSort.dir * -1) as 1 | -1 } : { key, dir: key === 'gname' ? 1 : -1 };
  }

  // คลิกแท่งกราฟ → กรองเจาะลึก
  drillDown(key: FilterKey, value: string) {
    (this as any)[key] = value;
    if (key === 'selectedYut') { this.selectedMain = ''; this.selectedIndicator = ''; }
    if (key === 'selectedMain' || key === 'selectedDept') this.selectedIndicator = '';
    this.loadChartStats();
  }

  // ตัวเลือกแบบลำดับขั้น: หมวดหมู่ตามยุทธศาสตร์, ตัวชี้วัดตามหมวดหมู่/หน่วยงาน
  get mainOptions(): any[] {
    return this.options.mains.filter((m: any) => !this.selectedYut || String(m.yut_id ?? '0') === this.selectedYut);
  }
  get indicatorOptions(): any[] {
    return this.options.indicators.filter((i: any) =>
      (!this.selectedMain || String(i.main_id ?? '0') === this.selectedMain) &&
      (!this.selectedDept || String(i.dept_id ?? '0') === this.selectedDept));
  }

  onFilterChange(changed?: FilterKey | 'selectedYear') {
    if (changed === 'selectedYut') { this.selectedMain = ''; this.selectedIndicator = ''; }
    if (changed === 'selectedMain' || changed === 'selectedDept') this.selectedIndicator = '';
    this.loadChartStats();
  }

  clearFilters() {
    this.selectedYut = this.selectedMain = this.selectedDept = this.selectedIndicator = this.selectedDistrict = this.selectedHostype = '';
    this.indicatorSearch = '';
    this.loadChartStats();
  }

  get activeFilterChips(): { key: FilterKey; label: string; value: string }[] {
    const name = (list: any[], id: string) => list.find((x: any) => String(x.id ?? '0') === id)?.name || (id === '0' ? 'ไม่ระบุ' : id);
    const chips: { key: FilterKey; label: string; value: string }[] = [];
    if (this.selectedYut) chips.push({ key: 'selectedYut', label: 'ยุทธศาสตร์', value: name(this.options.yuts, this.selectedYut) });
    if (this.selectedMain) chips.push({ key: 'selectedMain', label: 'หมวดหมู่', value: name(this.options.mains, this.selectedMain) });
    if (this.selectedDept) chips.push({ key: 'selectedDept', label: 'หน่วยงาน', value: name(this.options.depts, this.selectedDept) });
    if (this.selectedIndicator) chips.push({ key: 'selectedIndicator', label: 'ตัวชี้วัด', value: name(this.options.indicators, this.selectedIndicator) });
    if (this.selectedDistrict) chips.push({ key: 'selectedDistrict', label: 'อำเภอ', value: name(this.options.districts, this.selectedDistrict) });
    if (this.selectedHostype) chips.push({ key: 'selectedHostype', label: 'ประเภท', value: name(this.options.hostypes, this.selectedHostype) });
    return chips;
  }

  removeChip(key: FilterKey) {
    (this as any)[key] = '';
    this.onFilterChange(key);
  }

  // === การ์ดสถิติ (ตามปีงบที่เลือก) ===
  loadDashboardStats() {
    if (!this.selectedYear) return;
    this.authService.getDashboardStats(this.selectedYear).subscribe({
      next: (res) => { if (res?.success) this.animateStats(res.data); },
      error: (err) => console.error('Error loading stats:', err)
    });
  }

  animateStats(target: any) {
    if (this.animationTimer) clearInterval(this.animationTimer);
    const steps = 60, interval = 1500 / steps;
    const keys = ['successRate', 'recordedCount', 'totalDepts', 'pendingCount', 'rank', 'totalHospitals'];
    const start: any = {};
    keys.forEach(k => start[k] = Number(this.stats[k]) || 0);
    let step = 0;
    this.animationTimer = setInterval(() => {
      step++;
      const ease = 1 - Math.pow(1 - step / steps, 4);
      keys.forEach(k => {
        const v = start[k] + (Number(target[k]) - start[k]) * ease;
        this.stats[k] = k === 'successRate' ? v.toFixed(1) : Math.round(v);
      });
      if (step >= steps) { clearInterval(this.animationTimer); this.stats = target; }
      this.cdr.detectChanges();
    }, interval);
  }

  // === แผนที่อำเภอ ===
  getDistrictColor(pct: number): string { return pctColor(pct); }
  getDistrictBg(pct: number): string {
    if (pct >= 80) return 'bg-green-100 border-green-400 text-green-800';
    if (pct >= 50) return 'bg-yellow-100 border-yellow-400 text-yellow-800';
    return 'bg-red-100 border-red-400 text-red-800';
  }
  countDistricts(level: string): number {
    if (level === 'green') return this.districtMapData.filter(d => d.pct >= 80).length;
    if (level === 'yellow') return this.districtMapData.filter(d => d.pct >= 50 && d.pct < 80).length;
    return this.districtMapData.filter(d => d.pct < 50).length;
  }

  pctClass(p: number): string {
    if (p >= 80) return 'text-emerald-700 bg-emerald-50';
    if (p >= 50) return 'text-amber-700 bg-amber-50';
    return 'text-red-700 bg-red-50';
  }

  goBack() { this.router.navigate(['/dashboard']); }
}
