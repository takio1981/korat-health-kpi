// แท็บ "ตัวชี้วัดเสี่ยง" (ระบบเตือนล่วงหน้า ตามข้อเสนอแนวคิดการพัฒนา — 8 พ.ย. 2569) ในหน้ารายงานสถิติ
// แสดงคู่ตัวชี้วัด×หน่วยบริการที่ค่าคาดการณ์ ณ สิ้นปีงบไม่ถึงเป้าหมาย (เสี่ยงสูง/เฝ้าระวัง) และขาดการรายงาน — ตามขอบเขตสิทธิ์ (GET /report/forecast)
// การคาดการณ์คำนวณที่ server ด้วยวิธีทางสถิติ (api/kpi-forecast.js) — ตัวกรองยุทธศาสตร์/หน่วยงาน/โซน/อำเภอทำที่หน้าจอจากผลชุดเดียวกัน
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import { CONDITION_SYMBOL, normalizeCondition } from '../shared/kpi-target';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { ZoneBadgeComponent } from '../shared/zone-badge';
import { zoneLabel } from '../shared/zone';
import { AiForecastPanelComponent } from '../shared/ai-forecast-panel';

export const RISK_MONTHS = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];
export const RISK_STATUS: Record<string, { label: string; cls: string; icon: string }> = {
  high: { label: 'เสี่ยงสูง', cls: 'bg-red-100 text-red-800 border-red-200', icon: 'fa-circle-exclamation' },
  watch: { label: 'เฝ้าระวัง', cls: 'bg-amber-100 text-amber-800 border-amber-200', icon: 'fa-eye' },
  no_report: { label: 'ขาดการรายงาน', cls: 'bg-slate-200 text-slate-700 border-slate-300', icon: 'fa-hourglass-half' },
  normal: { label: 'ปกติ', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: 'fa-circle-check' },
  insufficient: { label: 'ข้อมูลไม่พอ', cls: 'bg-gray-100 text-gray-600 border-gray-200', icon: 'fa-circle-question' },
};
export const CONFIDENCE_LABEL: Record<string, string> = { high: 'สูง', medium: 'ปานกลาง', low: 'ต่ำ', actual: 'ผลจริง' };

export interface RiskFilter { status: string; yut: string; dept: string; zone: string; district: string; search: string }

/** กรองรายการตามตัวกรองบนหน้าจอ (ฟังก์ชันล้วน — ทดสอบได้) */
export function filterRiskItems(items: any[], f: RiskFilter): any[] {
  const q = (f.search || '').trim().toLowerCase();
  return (items || []).filter(it =>
    (!f.status || it.status === f.status)
    && (!f.yut || String(it.yut_id ?? '0') === f.yut)
    && (!f.dept || String(it.dept_id ?? '') === f.dept)
    && (!f.zone || String(it.zone ?? '') === f.zone)
    && (!f.district || String(it.distid ?? '') === f.district)
    && (!q || String(it.indicator_name || '').toLowerCase().includes(q) || String(it.hosname || '').toLowerCase().includes(q) || String(it.hospcode || '').includes(q)));
}

/** ตัวเลือกของตัวกรอง (ไม่ซ้ำ เรียงตามชื่อ) จากรายการที่ได้ */
export function riskOptions(items: any[]) {
  const uniq = (key: (x: any) => string, name: (x: any) => string) => {
    const m = new Map<string, string>();
    for (const it of items || []) { const k = key(it); if (k && !m.has(k)) m.set(k, name(it)); }
    return [...m.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label, 'th'));
  };
  return {
    yuts: uniq(x => String(x.yut_id ?? '0'), x => x.yut_name || 'ไม่ระบุยุทธศาสตร์'),
    depts: uniq(x => (x.dept_id == null ? '' : String(x.dept_id)), x => x.dept_name || '-'),
    zones: uniq(x => (x.zone ? String(x.zone) : ''), x => zoneLabel(x.zone)),
    districts: uniq(x => (x.distid ? String(x.distid) : ''), x => x.distname || x.distid),
  };
}

@Component({
  selector: 'app-risk-view',
  standalone: true,
  imports: [CommonModule, FormsModule, FormulaBadgeComponent, ZoneBadgeComponent, AiForecastPanelComponent],
  templateUrl: './risk-view.html',
})
export class RiskViewComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  readonly months = RISK_MONTHS;
  readonly STATUS = RISK_STATUS;
  readonly CONF = CONFIDENCE_LABEL;
  readonly yearOptions = (() => { const fy = getCurrentFiscalYear(); return [String(fy), String(fy - 1), String(fy - 2)]; })();
  yearBh = String(getCurrentFiscalYear());
  through: string = '';          // '' = เดือนล่าสุดที่ควรรายงานแล้ว
  filter: RiskFilter = { status: '', yut: '', dept: '', zone: '', district: '', search: '' };

  loading = false;
  error = '';
  data: any = null;
  options = riskOptions([]);
  shownCount = 100;

  get filtered(): any[] { return filterRiskItems(this.data?.items, this.filter); }
  get pageItems(): any[] { return this.filtered.slice(0, this.shownCount); }
  /** เดือนที่เลือก "ดู ณ เดือน" ได้ (ไม่เกินเดือนล่าสุดที่ควรรายงานแล้วของปีงบนั้น) — คำนวณตอนโหลด (getter สร้าง <option> ใหม่ทุกรอบ = NG0103) */
  throughOptions: { value: string; label: string }[] = [];
  /** ตัวกรองที่ส่งให้แผง AI (ระยะที่ 4) — คืน object เดิมเมื่อค่าไม่เปลี่ยน (object ใหม่ทุกรอบ = NG0100 ที่ input binding) */
  private _aiKey = '';
  private _aiParams: any = {};
  get aiParams(): any {
    const p: any = { year_bh: this.data?.year_bh || this.yearBh };
    if (this.through !== '') p.through = this.through;
    for (const k of ['status', 'yut', 'dept', 'zone', 'district'] as const) if (this.filter[k]) p[k] = this.filter[k];
    const key = JSON.stringify(p);
    if (key !== this._aiKey) { this._aiKey = key; this._aiParams = p; }
    return this._aiParams;
  }

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    this.error = '';
    const params: any = { year_bh: this.yearBh };
    if (this.through !== '') params.through = this.through;
    this.authService.getReportForecast(params).subscribe({
      next: (res: any) => {
        this.loading = false;
        this.data = res?.success ? res : null;
        this.options = riskOptions(this.data?.items || []);
        this.throughOptions = RISK_MONTHS.slice(0, (this.data?.natural_through ?? -1) + 1).map((label, i) => ({ value: String(i), label }));
        this.shownCount = 100;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.loading = false;
        this.data = null;
        this.error = err.error?.message || 'โหลดข้อมูลตัวชี้วัดเสี่ยงไม่สำเร็จ';
        this.cdr.detectChanges();
      },
    });
  }

  onYearChange() { this.through = ''; this.load(); }
  clearFilters() { this.filter = { status: '', yut: '', dept: '', zone: '', district: '', search: '' }; this.shownCount = 100; }
  setStatus(s: string) { this.filter = { ...this.filter, status: this.filter.status === s ? '' : s }; this.shownCount = 100; }
  symbol(cond: string): string { return CONDITION_SYMBOL[normalizeCondition(cond)] || '≥'; }
}
