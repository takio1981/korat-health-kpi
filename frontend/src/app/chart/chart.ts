import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { FormsModule } from '@angular/forms';
import { ReportComponent } from '../report/report';
import { ApexBoxComponent } from '../shared/apex-box';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { DistrictMapComponent } from '../shared/district-map';
import { RiskViewComponent } from './risk-view';
import { AiSummaryPanelComponent } from '../shared/ai-summary-panel';
import { ZoneBadgeComponent } from '../shared/zone-badge';
import { zoneLabel, inZone } from '../shared/zone';
import {
  RecRow, buildQualityBars, buildRecordStack, buildRecordDonut, buildQualityRadial, buildReviewDonut,
  buildMonthlyRecording, buildCompletenessHeatmap, buildHospitalDistribution, pctColor
} from './recording-builders';
import { ITYPES, itypeInfo } from '../shared/indicator-types';
import { IndicatorBadgesComponent } from '../shared/indicator-badges';

type FilterKey = 'selectedYut' | 'selectedMain' | 'selectedDept' | 'selectedIndicator' | 'selectedZone' | 'selectedDistrict' | 'selectedHostype' | 'selectedItype';

/** ค้นหา/เรียงตารางรายงานการบันทึก (ฟังก์ชันล้วน) — คีย์ที่เป็นตัวเลข null = น้อยสุด */
export function sortRecRows(rows: RecRow[], key: string, dir: 1 | -1, q = ''): RecRow[] {
  const words = String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const list = words.length ? rows.filter(r => { const h = [r.gname, r['hospcode'], r['dept_name'], r['distname']].map(v => String(v ?? '')).join(' ').toLowerCase(); return words.every(w => h.includes(w)); }) : rows;
  return [...list].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'number' || typeof vb === 'number' || va == null || vb == null) return ((va ?? -1) - (vb ?? -1)) * dir;
    return String(va).localeCompare(String(vb), 'th') * dir;
  });
}

// แถบ "กราฟและสถิติ" = รายงานการบันทึกผลงานตัวชี้วัดของหน่วยบริการ เชิงปริมาณ + คุณภาพ (28 พ.ย. 2569 — ผู้ใช้สั่ง แทนกราฟผ่าน/ไม่ผ่านเกณฑ์ทั้งหมด)
// ข้อมูล: GET /report/recording-stats (services/recording-stats.js)
@Component({
  selector: 'app-chart',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, ReportComponent, IndicatorBadgesComponent, ApexBoxComponent, FormulaBadgeComponent, DistrictMapComponent, AiSummaryPanelComponent, RiskViewComponent, ZoneBadgeComponent],
  templateUrl: './chart.html'
})
export class ChartComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  activeView: 'chart' | 'report' | 'risk' = 'chart';
  isLoading = true;
  loadError = '';

  selectedYear = '';
  selectedYut = '';
  selectedMain = '';
  selectedDept = '';
  selectedIndicator = '';
  selectedZone = '';
  selectedDistrict = '';
  selectedHostype = '';
  selectedItype = '';
  zoneLabel = zoneLabel;
  readonly itypes = ITYPES;
  itypeInfo = itypeInfo;

  options: any = { years: [], yuts: [], mains: [], depts: [], indicators: [], districts: [], zones: [], hostypes: [] };
  data: any = null;
  riskOpened = false;
  openRisk() { this.riskOpened = true; this.activeView = 'risk'; }
  aiParams: any = {};

  // กราฟ
  recordDonut: any = {}; qualityRadial: any = {}; reviewDonut: any = {}; hospitalDist: any = {};
  deptBars: any = {}; deptStack: any = {};
  indicatorBars: any = {};
  monthlyChart: any = {}; heatDept: any = {};
  districtBars: any = {}; hostypeBars: any = {}; zoneBars: any = {}; itypeBars: any = {};
  /** การ์ดประเภทตัวชี้วัด — คำนวณตอนโหลด (ไม่ใช่ getter กัน NG0103) */
  itypeRows: any[] = [];
  districtMapData: any[] = [];
  districtView: 'map' | 'cards' = 'map';

  // ตาราง (คำนวณตอนโหลด/เปลี่ยนการเรียง — ไม่ใช่ getter)
  indicatorView: 'low' | 'high' = 'low';
  indicatorSearch = '';
  indicatorSort: { key: string; dir: 1 | -1 } = { key: 'recording_pct', dir: 1 };
  indicatorRows: RecRow[] = [];
  deptSort: { key: string; dir: 1 | -1 } = { key: 'recording_pct', dir: 1 };
  deptRows: RecRow[] = [];
  hospitalSearch = '';
  hospitalSort: { key: string; dir: 1 | -1 } = { key: 'recording_pct', dir: 1 };
  hospitalAll = false;
  hospitalRows: RecRow[] = [];
  hospitalTotal = 0;
  private reqSeq = 0;

  ngOnInit() {
    const currentUrl = this.router.url;
    if (currentUrl === '/' || currentUrl === '') { this.router.navigate(['/dashboard']); return; }
    this.selectedYear = String(getCurrentFiscalYear());
    this.loadStats(true);
  }

  buildParams(): any {
    const p: any = {};
    if (this.selectedYear) p.year_bh = this.selectedYear;
    if (this.selectedYut) p.yut_id = this.selectedYut;
    if (this.selectedMain) p.main_id = this.selectedMain;
    if (this.selectedDept) p.dept_id = this.selectedDept;
    if (this.selectedIndicator) p.indicator_id = this.selectedIndicator;
    if (this.selectedZone) p.zone = this.selectedZone;
    if (this.selectedDistrict) p.distid = this.selectedDistrict;
    if (this.selectedHostype) p.hostype = this.selectedHostype;
    if (this.selectedItype) p.itype = this.selectedItype;
    return p;
  }

  /** first = โหลดครั้งแรก: ปีงบปัจจุบันยังไม่มีข้อมูล → ปีล่าสุดที่มีข้อมูล */
  loadStats(first = false) {
    const seq = ++this.reqSeq;
    this.isLoading = true;
    this.loadError = '';
    this.authService.getReportRecordingStats(this.buildParams()).subscribe({
      next: (res) => {
        if (seq !== this.reqSeq) return;
        if (res?.success) {
          this.options = res.options || this.options;
          if (first && res.options?.years?.length && !res.options.years.includes(this.selectedYear)) {
            this.selectedYear = res.options.years[0];
            this.cdr.detectChanges();
            this.loadStats();
            return;
          }
          this.data = res;
          this.aiParams = { ...this.buildParams(), year_bh: res.year_bh };
          this.buildCharts();
        }
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        if (seq !== this.reqSeq) return;
        this.isLoading = false;
        this.loadError = err.error?.message || 'ไม่สามารถโหลดข้อมูลการบันทึกผลงานได้';
        this.cdr.detectChanges();
      }
    });
  }

  buildCharts() {
    const d = this.data;
    if (!d) return;
    const pick = (key: FilterKey) => (row: RecRow) => this.drillDown(key, String(row.gkey));
    this.recordDonut = buildRecordDonut(d.overall);
    this.qualityRadial = buildQualityRadial(d.overall);
    this.reviewDonut = buildReviewDonut(d.overall);
    this.hospitalDist = buildHospitalDistribution(d.hospital_distribution);
    this.deptBars = buildQualityBars(d.by_dept, 'การบันทึกผลงาน แยกตามกลุ่มงาน (เรียงจากบันทึกน้อยสุด)', pick('selectedDept'));
    this.deptStack = buildRecordStack(d.by_dept, 'จำนวนคู่ที่บันทึกแล้ว / ยังไม่บันทึก แยกตามกลุ่มงาน', pick('selectedDept'));
    this.monthlyChart = buildMonthlyRecording(d.months);
    this.heatDept = buildCompletenessHeatmap(d.heatmap_dept, 'ความครบถ้วนรายเดือน — กลุ่มงาน × เดือน');
    this.districtBars = buildQualityBars(d.by_district, 'การบันทึกผลงาน แยกตามอำเภอ', pick('selectedDistrict'));
    this.hostypeBars = buildQualityBars(d.by_hostype, 'การบันทึกผลงาน แยกตามประเภทหน่วยบริการ', pick('selectedHostype'));
    this.zoneBars = buildQualityBars(d.by_zone, 'การบันทึกผลงาน แยกตามโซน', pick('selectedZone'));
    this.itypeRows = ((d.by_itype || []) as RecRow[]).map(r => ({ ...r, color: itypeInfo(String(r.gkey))?.color || '#64748b', short: itypeInfo(String(r.gkey))?.short || r.gname }));
    this.itypeBars = buildQualityBars(this.itypeRows.filter(r => r.pairs > 0), 'การบันทึกผลงาน แยกตามประเภทตัวชี้วัด', pick('selectedItype'));
    this.districtMapData = ((d.by_district || []) as RecRow[]).filter(r => r.gkey && r.gkey !== '0' && r.pairs > 0)
      .map(r => ({ id: r.gkey, name: r.gname, pct: r.recording_pct, passed: r.recorded_pairs, total: r.pairs }));
    this.refreshIndicators();
    this.refreshDepts();
    this.refreshHospitals();
  }

  // ===== รายตัวชี้วัด =====
  refreshIndicators() {
    if (!this.data) return;
    const sorted = sortRecRows(this.data.by_indicator || [], this.indicatorSort.key, this.indicatorSort.dir, this.indicatorSearch);
    this.indicatorRows = sorted;
    const forChart = sortRecRows(this.data.by_indicator || [], 'recording_pct', this.indicatorView === 'low' ? 1 : -1, this.indicatorSearch).slice(0, 15);
    const title = this.indicatorView === 'low' ? 'ตัวชี้วัด 15 อันดับที่บันทึกน้อยที่สุด (ควรเร่งรัด)' : 'ตัวชี้วัด 15 อันดับที่บันทึกครบที่สุด';
    this.indicatorBars = buildQualityBars(forChart, title, (row) => this.drillDown('selectedIndicator', String(row.gkey)));
  }
  setIndicatorView(v: 'low' | 'high') { this.indicatorView = v; this.refreshIndicators(); }
  onIndicatorSearch() { this.refreshIndicators(); }
  sortIndicators(key: string) { this.indicatorSort = this.nextSort(this.indicatorSort, key); this.refreshIndicators(); }

  // ===== กลุ่มงาน =====
  refreshDepts() { if (this.data) this.deptRows = sortRecRows(this.data.by_dept || [], this.deptSort.key, this.deptSort.dir); }
  sortDepts(key: string) { this.deptSort = this.nextSort(this.deptSort, key); this.refreshDepts(); }

  // ===== หน่วยบริการ =====
  refreshHospitals() {
    if (!this.data) return;
    const all = sortRecRows(this.data.by_hospital || [], this.hospitalSort.key, this.hospitalSort.dir, this.hospitalSearch);
    this.hospitalTotal = all.length;
    this.hospitalRows = this.hospitalAll ? all : all.slice(0, 20);
  }
  onHospitalSearch() { this.refreshHospitals(); }
  sortHospitals(key: string) { this.hospitalSort = this.nextSort(this.hospitalSort, key); this.refreshHospitals(); }
  toggleHospitalAll() { this.hospitalAll = !this.hospitalAll; this.refreshHospitals(); }

  private nextSort(cur: { key: string; dir: 1 | -1 }, key: string): { key: string; dir: 1 | -1 } {
    return cur.key === key ? { key, dir: (cur.dir * -1) as 1 | -1 } : { key, dir: key === 'gname' ? 1 : -1 };
  }
  sortIcon(cur: { key: string; dir: 1 | -1 }, key: string): string {
    return cur.key !== key ? 'fa-sort text-gray-300' : (cur.dir === 1 ? 'fa-sort-up' : 'fa-sort-down');
  }

  pickItype(key: string) { this.drillDown('selectedItype', this.selectedItype === key ? '' : key); }
  onMapPick(distid: string) { this.drillDown('selectedDistrict', String(this.selectedDistrict) === String(distid) ? '' : String(distid)); }

  drillDown(key: FilterKey, value: string) {
    (this as any)[key] = value;
    if (key === 'selectedYut') { this.selectedMain = ''; this.selectedIndicator = ''; }
    if (key === 'selectedMain' || key === 'selectedDept') this.selectedIndicator = '';
    this.loadStats();
  }

  get mainOptions(): any[] { return (this.options.mains || []).filter((m: any) => !this.selectedYut || String(m.yut_id ?? '0') === this.selectedYut); }
  get districtOptions(): any[] { return (this.options.districts || []).filter((d: any) => inZone(d, this.selectedZone)); }
  get indicatorOptions(): any[] {
    return (this.options.indicators || []).filter((i: any) =>
      (!this.selectedMain || String(i.main_id ?? '0') === this.selectedMain) &&
      (!this.selectedDept || String(i.dept_id ?? '0') === this.selectedDept));
  }

  onFilterChange(changed?: FilterKey | 'selectedYear') {
    if (changed === 'selectedYut') { this.selectedMain = ''; this.selectedIndicator = ''; }
    if (changed === 'selectedMain' || changed === 'selectedDept') this.selectedIndicator = '';
    if (changed === 'selectedZone' && this.selectedDistrict && !this.districtOptions.some((d: any) => String(d.id) === String(this.selectedDistrict))) this.selectedDistrict = '';
    this.loadStats();
  }

  clearFilters() {
    this.selectedYut = this.selectedMain = this.selectedDept = this.selectedIndicator = this.selectedZone = this.selectedDistrict = this.selectedHostype = this.selectedItype = '';
    this.indicatorSearch = ''; this.hospitalSearch = '';
    this.loadStats();
  }

  get activeFilterChips(): { key: FilterKey; label: string; value: string }[] {
    const name = (list: any[], id: string) => (list || []).find((x: any) => String(x.id ?? '0') === id)?.name || (id === '0' ? 'ไม่ระบุ' : id);
    const chips: { key: FilterKey; label: string; value: string }[] = [];
    if (this.selectedYut) chips.push({ key: 'selectedYut', label: 'ยุทธศาสตร์', value: name(this.options.yuts, this.selectedYut) });
    if (this.selectedMain) chips.push({ key: 'selectedMain', label: 'หมวดหมู่', value: name(this.options.mains, this.selectedMain) });
    if (this.selectedDept) chips.push({ key: 'selectedDept', label: 'กลุ่มงาน', value: name(this.options.depts, this.selectedDept) });
    if (this.selectedIndicator) chips.push({ key: 'selectedIndicator', label: 'ตัวชี้วัด', value: name(this.options.indicators, this.selectedIndicator) });
    if (this.selectedZone) chips.push({ key: 'selectedZone', label: 'โซน', value: zoneLabel(this.selectedZone) });
    if (this.selectedDistrict) chips.push({ key: 'selectedDistrict', label: 'อำเภอ', value: name(this.options.districts, this.selectedDistrict) });
    if (this.selectedHostype) chips.push({ key: 'selectedHostype', label: 'ประเภท', value: name(this.options.hostypes, this.selectedHostype) });
    if (this.selectedItype) chips.push({ key: 'selectedItype', label: 'ประเภทตัวชี้วัด', value: itypeInfo(this.selectedItype)?.label || this.selectedItype });
    return chips;
  }
  removeChip(key: FilterKey) { (this as any)[key] = ''; this.onFilterChange(key); }

  pctText(v: number | null | undefined): string { return v == null ? '–' : `${v}%`; }
  pctColor(v: number | null | undefined): string { return v == null ? '#94a3b8' : pctColor(v); }
  pctClass(v: number | null | undefined): string {
    if (v == null) return 'text-gray-400';
    if (v >= 80) return 'text-emerald-700 bg-emerald-50';
    if (v >= 50) return 'text-amber-700 bg-amber-50';
    return 'text-red-700 bg-red-50';
  }
  getDistrictBg(pct: number): string {
    if (pct >= 80) return 'bg-green-100 border-green-400 text-green-800';
    if (pct >= 50) return 'bg-yellow-100 border-yellow-400 text-yellow-800';
    return 'bg-red-100 border-red-400 text-red-800';
  }

  goBack() { this.router.navigate(['/dashboard']); }
}
