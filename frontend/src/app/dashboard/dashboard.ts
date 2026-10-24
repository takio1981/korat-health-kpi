import { Component, OnInit, OnDestroy, AfterViewInit, inject, ChangeDetectorRef, NgZone, ElementRef, HostListener } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { ToastService } from '../services/toast.service';
import { NgApexchartsModule } from 'ng-apexcharts';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';
import { HttpErrorResponse } from '@angular/common/http';
import { InitScrollLeftDirective } from './init-scroll-left.directive';
import { CriteriaTextPipe } from '../shared/criteria-text.pipe';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import { activeFormula, validateFormula, evaluateFormula } from '../shared/kpi-formula';
import { CustomVarDef, customVarDefsFor, customValuesOf, evaluatePct, pctFormulaOf, parseCustomVars } from '../shared/custom-vars';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { indicatorTypeSetting, autoTargetHostypes, resolveAddKpiTargets, HOSTYPE_NAMES } from '../shared/indicator-scope';
import { EXCEL_MONTHS, ChangePlan, EditPerms, buildTemplateAoa, parseImportAoa, planImport, parseClipboardGrid, isMultiCell, planPaste, applyCellChanges, itemKey } from '../shared/kpi-excel';
import { Anomaly, detectAnomaly } from '../shared/anomaly';
import { SUB_EXCEL_MONTHS, SubChangePlan, buildSubTemplateAoa, parseSubImportAoa, planSubImport, applySubChanges, subFieldLabel } from '../shared/kpi-sub-excel';
import { activityValue, rollupMonthly, itemNumber, rollupTree, RollupNode } from '../shared/kpi-rollup';
import { orderSubTree } from '../shared/sub-tree';
import { evaluateTarget, normalizeCondition, CONDITION_SYMBOL, CONDITION_LABEL } from '../shared/kpi-target';

// ตัวชี้วัดหลายระดับ — แถวลูกใต้แถวตัวชี้วัดหลักในตารางบันทึกผลงาน (ข้อย่อย 1.1 / ข้อย่อยระดับถัดไป 1.1.1 … / กิจกรรม)
export interface HierRow {
  kind: 'sub' | 'activity';
  id: number;
  subId: number;            // ข้อย่อยของแถวนี้ (แถวกิจกรรม = ข้อย่อยแม่)
  parentSubId: number | null; // ข้อย่อยแม่ของแถวข้อย่อย (null = ระดับบนสุด) — แถวกิจกรรม = ข้อย่อยแม่
  level: number;            // 1 = ข้อย่อยระดับบนสุด, 2 = ระดับถัดไป … (กิจกรรม = ระดับข้อแม่ + 1)
  no: string;
  name: string;
  valueType: 'number' | 'check';
  auto: boolean;            // ข้อย่อยที่คำนวณจากระดับล่าง (มีข้อลูก/กิจกรรมเปิดใช้งาน) — กรอกเองไม่ได้
  target: string;
  locked: boolean;
  months: { [k: string]: string };   // oct … sep
  _orig: { [k: string]: string };
}
// เดือนตามปีงบ: คีย์ในตาราง ↔ เลขเดือน ↔ คีย์ของ kpi-rollup
export const HIER_MONTHS: { key: string; m: number; mk: string }[] = [
  { key: 'oct', m: 10, mk: 'm10' }, { key: 'nov', m: 11, mk: 'm11' }, { key: 'dece', m: 12, mk: 'm12' },
  { key: 'jan', m: 1, mk: 'm01' }, { key: 'feb', m: 2, mk: 'm02' }, { key: 'mar', m: 3, mk: 'm03' },
  { key: 'apr', m: 4, mk: 'm04' }, { key: 'may', m: 5, mk: 'm05' }, { key: 'jun', m: 6, mk: 'm06' },
  { key: 'jul', m: 7, mk: 'm07' }, { key: 'aug', m: 8, mk: 'm08' }, { key: 'sep', m: 9, mk: 'm09' },
];

// แปลงข้อมูลจาก GET /hierarchy-results เป็นแถวลูกแบบ pre-order (ข้อย่อย → ข้อลูกของมัน … → กิจกรรมของข้อนั้น) แล้วคำนวณข้อที่คำนวณจากระดับล่าง
// เลขข้อ: ข้อลูกใช้ลำดับ 1..n ก่อน กิจกรรมต่อท้าย (ตรงกับ backend buildItemExportRows) — ฟังก์ชันล้วน (ทดสอบได้)
export function buildHierRows(data: any, parentNo: string): HierRow[] {
  const rows: HierRow[] = [];
  const subs: any[] = data?.subs || [];
  const acts: any[] = data?.activities || [];
  const toMonths = (src: any) => {
    const o: { [k: string]: string } = {};
    for (const hm of HIER_MONTHS) o[hm.key] = src?.months?.[hm.m] ?? '';
    return o;
  };
  const pid = (s: any) => (s.parent_sub_id === null || s.parent_sub_id === undefined || s.parent_sub_id === '') ? null : Number(s.parent_sub_id);
  const childSubs = (p: number | null) => subs.filter(s => pid(s) === p);
  const subActs = (id: number) => acts.filter(a => Number(a.sub_indicator_id) === id);
  const walk = (p: number | null, pNo: string, level: number, seen: Set<number>) => {
    childSubs(p).forEach((s: any, si: number) => {
      const id = Number(s.id);
      if (seen.has(id)) return;
      seen.add(id);
      const no = itemNumber(s.item_no, pNo, si);
      const kids = childSubs(id);
      const myActs = subActs(id);
      const sm = toMonths(s);
      rows.push({ kind: 'sub', id, subId: id, parentSubId: p, level, no, name: s.sub_indicator_name, valueType: 'number',
        auto: s.rollup_mode === 'auto' && kids.length + myActs.length > 0, target: s.target ?? s.target_percentage ?? '', locked: !!s.locked,
        months: sm, _orig: { ...sm } });
      walk(id, no, level + 1, seen);
      myActs.forEach((a: any, ai: number) => {
        const am = toMonths(a);
        rows.push({ kind: 'activity', id: Number(a.id), subId: id, parentSubId: id, level: level + 1, no: itemNumber(a.item_no, no, kids.length + ai),
          name: a.activity_name, valueType: a.value_type === 'check' ? 'check' : 'number', auto: false,
          target: a.value_type === 'check' ? '' : (a.target ?? a.target_percentage ?? ''), locked: !!a.locked, months: am, _orig: { ...am } });
      });
    });
  };
  walk(null, parentNo, 1, new Set<number>());
  recomputeHierRows(rows);
  return rows;
}

// ข้อที่คำนวณจากระดับล่าง = kpiRollup.rollupTree() (กิจกรรมทำแล้ว = 100 / ยังไม่ทำ = 0) — กติกาเดียวกับ backend loadEffectiveSubMonthly()
export function recomputeHierRows(rows: HierRow[]) {
  const nodes: RollupNode[] = rows.map(r => r.kind === 'sub'
    ? { key: 's' + r.id, parentKey: r.parentSubId === null ? null : 's' + r.parentSubId, kind: 'sub', auto: r.auto }
    : { key: 'a' + r.id, parentKey: 's' + r.subId, kind: 'activity', valueType: r.valueType });
  const values: { [key: string]: { [mk: string]: unknown } } = {};
  for (const r of rows) {
    const v: { [mk: string]: unknown } = {};
    for (const hm of HIER_MONTHS) v[hm.mk] = r.months[hm.key];
    values[(r.kind === 'sub' ? 's' : 'a') + r.id] = v;
  }
  const tree = rollupTree(nodes, values);
  for (const r of rows) {
    const t = r.kind === 'sub' ? tree['s' + r.id] : null;
    if (!t || !t.rolled) continue;
    for (const hm of HIER_MONTHS) {
      const v = t.months[hm.mk];
      r.months[hm.key] = v === null ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2));
    }
  }
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, NgApexchartsModule, InitScrollLeftDirective, CriteriaTextPipe, FormulaBadgeComponent],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit, OnDestroy, AfterViewInit {
  private authService = inject(AuthService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);
  private el = inject(ElementRef);

  // === Column Sort ===
  sortField: string = '';
  sortDir: 'asc' | 'desc' = 'asc';

  toggleSort(field: string) {
    if (this.sortField === field) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortField = field;
      this.sortDir = 'asc';
    }
    this.applyFilters();
  }

  // === เลือกคอลัมน์ที่แสดง (จำตามบัญชีผู้ใช้ ผ่าน /my-ui-prefs/dashboard_columns) ===
  // "ชื่อตัวชี้วัด" ไม่อยู่ในรายการ — แสดงเสมอเพื่อให้รู้ว่าแต่ละแถวคือตัวชี้วัดใด
  readonly COLUMN_OPTIONS: { key: string; label: string }[] = [
    { key: 'main', label: 'หมวดหมู่หลัก' },
    { key: 'actions', label: 'จัดการ' },
    { key: 'criteria', label: 'เกณฑ์' },
    { key: 'hospital', label: 'หน่วยบริการ' },
    { key: 'target', label: 'เป้าหมาย' },
    { key: 'lastActual', label: 'ผลงานล่าสุด' },
    { key: 'pct', label: 'ร้อยละ' },
  ];
  colVisible: Record<string, boolean> = this.defaultColVisible();
  showColumnMenu = false;

  private defaultColVisible(): Record<string, boolean> {
    const v: Record<string, boolean> = {};
    this.COLUMN_OPTIONS.forEach(c => v[c.key] = true);
    ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].forEach(m => v[m] = true);
    return v;
  }

  get visibleMonths(): { key: string; name: string }[] {
    return this.FISCAL_MONTHS.filter(m => this.colVisible[m.key]);
  }

  get visibleMonthKeys(): string[] {
    return this.visibleMonths.map(m => m.key);
  }

  get hiddenColumnCount(): number {
    return Object.values(this.colVisible).filter(x => !x).length;
  }

  private loadColumnPrefs() {
    this.authService.getUiPref('dashboard_columns').subscribe({
      next: (res) => {
        if (res?.success && res.data && typeof res.data === 'object') {
          // merge กับค่าเริ่มต้น — คอลัมน์ใหม่ที่เพิ่มภายหลังจะแสดงเป็นค่าเริ่มต้น
          const merged = this.defaultColVisible();
          Object.keys(merged).forEach(k => { if (typeof res.data[k] === 'boolean') merged[k] = res.data[k]; });
          this.colVisible = merged;
          this.cdr.detectChanges();
          this.setCssVars();
        }
      },
      error: () => {} // โหลดไม่ได้ → ใช้ค่าเริ่มต้น (แสดงทุกคอลัมน์)
    });
  }

  toggleColumn(key: string) {
    this.colVisible = { ...this.colVisible, [key]: !this.colVisible[key] };
    this.onColumnsChanged();
  }

  setAllMonths(show: boolean) {
    const next = { ...this.colVisible };
    this.FISCAL_MONTHS.forEach(m => next[m.key] = show);
    this.colVisible = next;
    this.onColumnsChanged();
  }

  resetColumns() {
    this.colVisible = this.defaultColVisible();
    this.onColumnsChanged();
  }

  private _saveColumnsTimer: any = null;
  private onColumnsChanged() {
    this.cdr.detectChanges();
    this.setCssVars();
    // หน่วงการบันทึก — ติ๊กหลายช่องติดกันจะยิง API ครั้งเดียว
    clearTimeout(this._saveColumnsTimer);
    this._saveColumnsTimer = setTimeout(() => {
      this.authService.saveUiPref('dashboard_columns', this.colVisible).subscribe({
        error: (err) => Swal.fire({ toast: true, position: 'top-end', icon: 'error', timer: 3000, showConfirmButton: false,
          title: err.error?.message || 'บันทึกการตั้งค่าคอลัมน์ไม่สำเร็จ' })
      });
    }, 600);
  }

  // === ค่า "กำลังดำเนินการ" ในช่องผลงานรายเดือน (ปุ่ม ⏳ — เก็บเป็นข้อความใน actual_value) ===
  // เดิมใช้คำว่า "รอดำเนินการ" (เปลี่ยน 19 ต.ค. 2569 ตามที่ผู้ใช้ขอ) — ค่าเดิมยังนับเป็นสถานะเดียวกัน และ server.js แปลงข้อมูลเดิมให้ตอน startup
  readonly PENDING_TEXT = 'กำลังดำเนินการ';
  readonly LEGACY_PENDING_TEXT = 'รอดำเนินการ';

  isPendingValue(v: any): boolean {
    const s = String(v ?? '').trim();
    return s === this.PENDING_TEXT || s === this.LEGACY_PENDING_TEXT;
  }

  togglePending(item: any, month: string) {
    item[month] = this.isPendingValue(item[month]) ? '' : this.PENDING_TEXT;
    this.onValueChange(item, month);
  }

  // === Column Resize ===
  colWidths: Record<string, number> = { col1: 180, col2: 280, col4: 220 };
  private _resizeState: { col: string; startX: number; startW: number } | null = null;

  // ความกว้างคงที่ของคอลัมน์ที่ไม่ resize: จัดการ(64) เกณฑ์(64) เป้าหมาย(90) ผลงานล่าสุด(90) ร้อยละ(80)
  // คอลัมน์ที่ซ่อนอยู่นับความกว้างเป็น 0 — ตำแหน่ง left ของคอลัมน์ frozen ถัดไปจึงเลื่อนชิดกันพอดี
  private setCssVars() {
    const wrapper = this.el.nativeElement.querySelector('.kpi-table-wrapper');
    if (!wrapper) return;
    const v = this.colVisible;
    const c1 = v['main'] ? this.colWidths['col1'] : 0;     // หมวดหมู่หลัก
    const c2 = v['actions'] ? 64 : 0;                       // จัดการ (fixed)
    const c3 = this.colWidths['col2'];                      // ชื่อตัวชี้วัด (แสดงเสมอ)
    const c4 = v['criteria'] ? 64 : 0;                      // เกณฑ์ (fixed)
    const c5 = v['hospital'] ? this.colWidths['col4'] : 0; // หน่วยบริการ
    const c6 = v['target'] ? 90 : 0;                        // เป้าหมาย (fixed)
    const c7 = v['lastActual'] ? 90 : 0;                    // ผลงานล่าสุด (fixed)
    wrapper.style.setProperty('--col1-w', c1 + 'px');
    wrapper.style.setProperty('--col3-w', c3 + 'px');
    wrapper.style.setProperty('--col5-w', c5 + 'px');
    wrapper.style.setProperty('--col2-left', c1 + 'px');
    wrapper.style.setProperty('--col3-left', (c1 + c2) + 'px');
    wrapper.style.setProperty('--col4-left', (c1 + c2 + c3) + 'px');
    wrapper.style.setProperty('--col5-left', (c1 + c2 + c3 + c4) + 'px');
    wrapper.style.setProperty('--col6-left', (c1 + c2 + c3 + c4 + c5) + 'px');
    wrapper.style.setProperty('--col7-left', (c1 + c2 + c3 + c4 + c5 + c6) + 'px');
    wrapper.style.setProperty('--col8-left', (c1 + c2 + c3 + c4 + c5 + c6 + c7) + 'px');
  }

  private loadColWidths() {
    try {
      const saved = localStorage.getItem('khups_col_widths');
      if (saved) Object.assign(this.colWidths, JSON.parse(saved));
    } catch {}
  }

  private saveColWidths() {
    try { localStorage.setItem('khups_col_widths', JSON.stringify(this.colWidths)); } catch {}
  }

  startResize(event: MouseEvent, col: string) {
    event.preventDefault();
    event.stopPropagation();
    const minW: Record<string, number> = { col1: 100, col2: 150, col4: 100 };
    this._resizeState = { col, startX: event.clientX, startW: this.colWidths[col] };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      if (!this._resizeState) return;
      const delta = e.clientX - this._resizeState.startX;
      this.colWidths[this._resizeState.col] = Math.max(minW[this._resizeState.col] ?? 80, this._resizeState.startW + delta);
      this.setCssVars();
    };
    const onUp = () => {
      this._resizeState = null;
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.saveColWidths();
    };
    this.ngZone.runOutsideAngular(() => {
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  ngAfterViewInit() {
    this.loadColWidths();
    setTimeout(() => this.setCssVars(), 0);
  }

  kpiData: any[] = [];
  filteredData: any[] = [];
  searchTerm: string = '';
  // main/indicator เป็น string (ค่าเดียว) — ยังคงเดิม
  selectedMain: string = '';
  selectedIndicator: string = '';
  selectedYear: string = '';
  // ตัวกรอง multi-select (array)
  selectedDepts: string[] = [];
  selectedStatuses: string[] = [];
  selectedHospitals: string[] = [];
  selectedDistricts: string[] = [];
  selectedTypes: string[] = [];
  selectedHosTypes: string[] = [];
  selectedIndicatorOffTypes: string[] = [];

  // === Saved Views (Filter Preset) — เก็บใน localStorage per-user ===
  savedViews: any[] = [];
  showSaveViewModal: boolean = false;
  newViewName: string = '';

  // Backward-compat getters (ใช้ในส่วนอื่นของโค้ดที่ยังไม่ได้แก้)
  get selectedDept(): string { return this.selectedDepts[0] || ''; }
  set selectedDept(v: string) { this.selectedDepts = v ? [v] : []; }
  get selectedStatus(): string { return this.selectedStatuses[0] || ''; }
  set selectedStatus(v: string) { this.selectedStatuses = v ? [v] : []; }
  get selectedHospital(): string { return this.selectedHospitals[0] || ''; }
  set selectedHospital(v: string) { this.selectedHospitals = v ? [v] : []; }
  get selectedDistrict(): string { return this.selectedDistricts[0] || ''; }
  set selectedDistrict(v: string) { this.selectedDistricts = v ? [v] : []; }
  get selectedType(): string { return this.selectedTypes[0] || ''; }
  set selectedType(v: string) { this.selectedTypes = v ? [v] : []; }
  get selectedHosType(): string { return this.selectedHosTypes[0] || ''; }
  set selectedHosType(v: string) { this.selectedHosTypes = v ? [v] : []; }
  // UI: dropdown ไหนกำลังเปิด
  openFilterDropdown: string = '';
  showManageMenu: boolean = false;

  // ปิด dropdown "จัดการตัวชี้วัด" เมื่อคลิกนอกกรอบ
  @HostListener('document:click', ['$event'])
  onDocumentClickManageMenu(event: MouseEvent) {
    if (this.showColumnMenu) {
      const colMenu = this.el.nativeElement.querySelector('.column-menu-container');
      if (colMenu && !colMenu.contains(event.target as Node)) this.showColumnMenu = false;
    }
    if (!this.showManageMenu) return;
    const container = this.el.nativeElement.querySelector('.manage-menu-container');
    if (container && !container.contains(event.target as Node)) {
      this.showManageMenu = false;
    }
  }

  // จำนวนรายการ pending (รอตรวจสอบ)
  get pendingCount(): number {
    return this.filteredData.filter(i => Number(i.pending_count) > 0).length;
  }
  // จำนวนรายการ locked
  get lockedCount(): number {
    return this.filteredData.filter(i => Number(i.is_locked) === 1).length;
  }
  // จำนวนรายการตรวจสอบแล้ว (pending_count = 0 + มีผลงาน)
  get reviewedCount(): number {
    return this.filteredData.filter(i => Number(i.pending_count) === 0 && String(i.last_actual ?? '').trim() !== '').length;
  }

  // === Multi-select helpers ===
  toggleFilterItem(arr: string[], value: string): string[] {
    const idx = arr.indexOf(value);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(value);
    return arr;
  }

  isFilterSelected(arr: string[], value: string): boolean {
    return arr.includes(value);
  }

  // แสดงชื่อที่เลือก — 1 ตัว="ชื่อ", >1 ตัว="N รายการ", ว่าง="ทั้งหมด"
  filterLabel(arr: string[], placeholder: string = 'ทั้งหมด'): string {
    if (arr.length === 0) return placeholder;
    if (arr.length === 1) return arr[0];
    return `เลือก ${arr.length} รายการ`;
  }

  // แสดงชื่อประเภท รพ. — 1 ตัว="ชื่อประเภท", >1 ตัว="N รายการ" (map code → name จาก hosTypeList)
  hosTypeLabel(placeholder: string = 'ประเภท รพ.: ทั้งหมด'): string {
    if (this.selectedHosTypes.length === 0) return placeholder;
    if (this.selectedHosTypes.length === 1) {
      const code = this.selectedHosTypes[0];
      const found = (this.hosTypeList || []).find((ht: any) => ht.hostypecode === code)
        || (this._allHosTypes || []).find((ht: any) => ht.hostypecode === code);
      return found?.hostypename || code;
    }
    return `เลือก ${this.selectedHosTypes.length} รายการ`;
  }

  // แสดงชื่อ "ตัวชี้วัดของ" (map code → name)
  indicatorOffTypeLabel(placeholder: string = 'ตัวชี้วัดของ: ทั้งหมด'): string {
    if (this.selectedIndicatorOffTypes.length === 0) return placeholder;
    if (this.selectedIndicatorOffTypes.length === 1) {
      const code = this.selectedIndicatorOffTypes[0];
      const found = (this._allHosTypes || []).find((ht: any) => ht.hostypecode === code);
      return found?.hostypename || code;
    }
    return `เลือก ${this.selectedIndicatorOffTypes.length} รายการ`;
  }

  toggleDropdown(name: string) {
    this.openFilterDropdown = this.openFilterDropdown === name ? '' : name;
  }

  // ตำแหน่งกล่อง dropdown "View ของฉัน" (คำนวณสดทุกครั้งที่เปิด กัน left-0/right-0 ตายตัวล้นขอบจอ)
  savedViewsLeftPx: number = 0;
  savedViewsWidthPx: number = 288;

  toggleSavedViewsDropdown(event: MouseEvent) {
    const willOpen = this.openFilterDropdown !== 'savedViews';
    this.openFilterDropdown = willOpen ? 'savedViews' : '';
    if (!willOpen) return;
    const wrapper = (event.currentTarget as HTMLElement).closest('.saved-views-container') as HTMLElement;
    if (!wrapper) return;
    const margin = 8;
    const width = Math.min(288, window.innerWidth - margin * 2);
    const wrapperRect = wrapper.getBoundingClientRect();
    const maxViewportLeft = Math.max(margin, window.innerWidth - width - margin);
    const clampedViewportLeft = Math.min(Math.max(wrapperRect.left, margin), maxViewportLeft);
    this.savedViewsWidthPx = width;
    this.savedViewsLeftPx = clampedViewportLeft - wrapperRect.left;
  }

  clearFilterArr(arr: string[]) {
    arr.splice(0, arr.length);
  }

  // เลือกทั้งหมด/ยกเลิกทั้งหมด (toggle) — ใช้ร่วมกับ checkbox "เลือกทั้งหมด" ในทุก dropdown multi-select
  isAllFilterSelected(arr: string[], allValues: string[]): boolean {
    return allValues.length > 0 && arr.length === allValues.length && allValues.every(v => arr.includes(v));
  }
  toggleSelectAllFilterArr(arr: string[], allValues: string[]) {
    if (this.isAllFilterSelected(arr, allValues)) arr.splice(0, arr.length);
    else arr.splice(0, arr.length, ...allValues);
  }
  // รายการ code ล้วนๆ สำหรับ dropdown ที่เก็บเป็น object (ใช้กับ "เลือกทั้งหมด" ใน template)
  get hosTypeCodes(): string[] { return this.hosTypeList.map((h: any) => h.hostypecode); }
  get indOffTypeCodes(): string[] { return this._allHosTypes.map((h: any) => h.hostypecode); }
  readonly statusFilterValues: string[] = ['pass', 'fail', 'pending', 'reviewed', 'has_target_actual', 'no_target', 'no_actual', 'no_target_no_actual'];
  readonly typeFilterValues: string[] = ['r9', 'moph', 'ssj', 'rmw', 'other'];

  showFilters: boolean = true;
  showGuide: boolean = false;
  mainCategories: string[] = [];
  indicatorNames: string[] = [];
  deptNames: string[] = [];
  filterYears: string[] = [];
  hospitalNames: string[] = [];
  districtNames: string[] = [];
  hosTypeList: any[] = [];

  // Raw data for cascading filters
  private _allHospitals: any[] = [];
  private _allIndicators: any[] = [];
  private _allDistricts: any[] = [];
  _allHosTypes: any[] = [];
  addKpiYears: string[] = [];
  addKpiSelectedYear: string = '';
  addKpiDistrictList: any[] = [];
  addKpiHospitalList: any[] = [];      // หน่วยบริการในขอบเขตของผู้ใช้ (ปลายทางที่เป็นไปได้)
  addKpiDeptList: any[] = [];
  addKpiExistingCount: number = 0;
  addKpiTotalTemplateCount: number = 0;

  // === Multi-select filters (เหมือนตัวกรองหน้า dashboard) ===
  addKpiSelDistricts: string[] = [];   // distid ที่เลือก (ว่าง = ทั้งหมด) — จำกัดปลายทางที่ระบบหาให้อัตโนมัติ
  addKpiSelDepts: string[] = [];       // dept id ที่เลือก (filter ตัวชี้วัด)
  addKpiOpenDropdown: string = '';     // dropdown ที่เปิดอยู่ใน modal

  isEditing: boolean = false;
  showAddModal: boolean = false;
  newKpiList: any[] = [];
  // Add KPI: filter หมวดหมู่หลัก + selection
  addKpiMainList: string[] = [];
  addKpiSelMains: string[] = [];          // multi-filter หมวดหมู่ (ว่าง = ทั้งหมด)
  addKpiSelectedIds = new Set<number>();

  // Review mode — เลือกรายการตรวจสอบ
  isReviewMode: boolean = false;
  reviewSelected = new Set<string>(); // key: indicator_id_year_bh_hospcode

  // Delete mode — เลือกรายการเพื่อลบออก
  isDeleteMode: boolean = false;
  deleteSelected = new Set<string>(); // key: indicator_id_year_bh_hospcode

  showTrendModal: boolean = false;
  selectedKpiName: string = '';
  selectedKpiCriteria: string = '';
  kpiTrendOptions: any = {};

  // Sub-Indicator Result Modal (ใน dashboard สำหรับบันทึกผลงานย่อย)
  showSubResultModal: boolean = false;
  // Modal-local state (ไม่กระทบ dashboard main)
  subEditMode: boolean = false;
  subDeleteMode: boolean = false;
  subDeleteSelected: Set<number> = new Set();
  subResultContext: any = null; // { indicator_id, indicator_name, hospcode, hosname, year_bh, month_bh }
  subResultList: any[] = []; // sub-indicators พร้อมผลงาน
  subMonthOptions = [
    { v: 10, name: 'ต.ค.' }, { v: 11, name: 'พ.ย.' }, { v: 12, name: 'ธ.ค.' },
    { v: 1, name: 'ม.ค.' }, { v: 2, name: 'ก.พ.' }, { v: 3, name: 'มี.ค.' },
    { v: 4, name: 'เม.ย.' }, { v: 5, name: 'พ.ค.' }, { v: 6, name: 'มิ.ย.' },
    { v: 7, name: 'ก.ค.' }, { v: 8, name: 'ส.ค.' }, { v: 9, name: 'ก.ย.' }
  ];
  // map indicator_id → sub count (แสดงปุ่มบนแถว)
  subIndicatorCountMap: Map<number, number> = new Map();
  // map "indicator_id|hospcode|year" → { sub_count, total_actual, avg_pct }
  subSummaryMap: Map<string, any> = new Map();

  isLoading: boolean = false;
  // Search status / progress
  searchStage: string = '';
  searchProgress: number = 0;
  searchStartedAt: number = 0;
  searchDurationMs: number = 0;
  searchFinished: boolean = false;
  searchCountdown: number = 0;
  appliedFilters: { label: string; value: string; color: string }[] = [];
  showSearchStatus: boolean = false;
  private _progressTimer: any = null;
  private animationTimer: any;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  isAdminCup: boolean = false;
  isLocalAdmin: boolean = false;
  isDistrictScope: boolean = false;
  currentUser: any = null;

  currentPage: number = 1;
  pageSize: number = 20;
  totalPages: number = 0;

  showRejectModal: boolean = false;
  rejectComment: string = '';
  rejectingItem: any = null;
  rejectSelectedMonths: string[] = [];
  rejectMonthOptions = [
    { key: 'oct', name: 'ต.ค.' }, { key: 'nov', name: 'พ.ย.' }, { key: 'dece', name: 'ธ.ค.' },
    { key: 'jan', name: 'ม.ค.' }, { key: 'feb', name: 'ก.พ.' }, { key: 'mar', name: 'มี.ค.' },
    { key: 'apr', name: 'เม.ย.' }, { key: 'may', name: 'พ.ค.' }, { key: 'jun', name: 'มิ.ย.' },
    { key: 'jul', name: 'ก.ค.' }, { key: 'aug', name: 'ส.ค.' }, { key: 'sep', name: 'ก.ย.' }
  ];
  showRejectionHistoryModal: boolean = false;
  rejectionHistory: any[] = [];
  rejectionHistoryFull: any[] = [];

  showReplyModal: boolean = false;
  replyingItem: any = null;
  replyMessage: string = '';
  replyRejectionInfo: any = null;

  // Data Entry Lock
  dataEntryLock: any = { is_locked: false, lock_reason: '' };
  targetEditLocked: boolean = false;

  // Role Permissions (จาก /my-permissions) — default ให้สิทธิ์เต็มกัน lock พลาด
  myPerms: any = { can_edit_actual: true, can_edit_target: true, can_delete: false };

  // Target Edit Requests
  targetEditRequests: any[] = [];

  // แก้ไขเฉพาะข้อ (จากอุทธรณ์ที่ได้รับอนุมัติ)
  editingSingleItem: any = null;

  // (state แก้ไขเป้าหมายรายข้อเก็บไว้บน item._editingTarget ตรงๆ)

  // Appeal (อุทธรณ์)
  appealSettings: any = { is_open: false };
  appealReason: string = '';

  // Dynamic Form Modal
  showDynamicFormModal: boolean = false;
  dynamicFormItem: any = null;
  dynamicFormSchema: any = null;
  dynamicFormTab: 'form' | 'list' = 'form';
  dynamicFormData: any = {};
  dynamicFormUsedMonths: number[] = []; // เดือนที่คีย์ไปแล้ว
  isDynamicFormSaving: boolean = false;
  isDynamicDataLoading: boolean = false;
  dynamicDataList: any[] = [];
  availableYears: string[] = [];

  // 12-month table state (form tab)
  dynamicMonthlyRows: { [month: number]: any } = {};   // month_bh → row data
  dynamicMonthlyOriginal: { [month: number]: any } = {}; // snapshot ก่อน edit
  dynamicEditMode: boolean = false;
  dynamicBatchProgress: number = 0;
  dynamicBatchTotal: number = 0;

  stats: any = {
    successRate: 0,
    recordedCount: 0,
    totalDepts: 0,
    pendingCount: 0,
    rank: 0,
    totalHospitals: 0
  };

  ngOnDestroy() {
    // คืนค่า sidebar เมื่อออกจากหน้า dashboard (กันล็อค)
    this.authService.setFocusMode(false);
  }

  private handleSsoCallback() {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('sso_token');
    const ssoUser = params.get('sso_user');
    if (!ssoToken || !ssoUser) return;
    // เคลียร์ query string ออกจาก URL ก่อนใช้งาน
    window.history.replaceState({}, '', window.location.pathname);
    try {
      const userInfo = JSON.parse(atob(decodeURIComponent(ssoUser)));
      this.authService.saveToken(ssoToken);
      this.authService.saveUser(userInfo);
      this.authService.startTokenExpiryWatcher();
      Swal.fire({
        icon: 'success',
        title: 'เข้าสู่ระบบสำเร็จ',
        text: `ยินดีต้อนรับ คุณ${userInfo.firstname || ''} ${userInfo.lastname || ''} (ThaiD)`,
        timer: 1500,
        showConfirmButton: false
      });
    } catch {
      Swal.fire('ผิดพลาด', 'ไม่สามารถอ่านข้อมูล SSO ได้', 'error');
    }
  }

  ngOnInit() {
    this.handleSsoCallback();
    this.currentUser = this.authService.getUser();
    if (this.authService.isLoggedIn()) this.loadColumnPrefs();
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin_ssj', 'super_admin'].includes(role);      // admin ส่วนกลาง
    this.isSuperAdmin = role === 'super_admin';
    this.isAdminCup = role === 'admin_cup';                          // admin อำเภอ
    this.isLocalAdmin = ['admin_hos', 'admin_sso', 'admin_cup'].includes(role); // admin พื้นที่ทุกระดับ
    this.isDistrictScope = ['user_cup', 'admin_cup'].includes(role); // เห็นทั้งอำเภอ

    // Fallback: ดึง hospcode/dept_id จาก JWT token กรณี user object ไม่มี (login เก่า)
    if (this.currentUser && !this.currentUser.hospcode) {
      try {
        const token = localStorage.getItem('kpi_token');
        if (token) {
          const payload = JSON.parse(atob(token.split('.')[1]));
          if (payload.hospcode) this.currentUser.hospcode = payload.hospcode;
          if (payload.deptId) this.currentUser.dept_id = payload.deptId;
        }
      } catch (e) { /* ignore */ }
    }

    // ตั้งค่า filter เริ่มต้นตาม role เพื่อลดภาระโหลดข้อมูล
    this.setDefaultFilters();
    this.setDefaultYear();
    this.extractFilterLists();

    // super_admin + admin_ssj ไม่โหลดข้อมูลอัตโนมัติ — ให้เลือกตัวกรองก่อน
    if (!this.isSuperAdmin && !this.isAdmin) {
      this.loadKpiData();
    }
    this.loadSavedViews();    // โหลด preset filter ของ user
    this.loadAppealSettings();
    this.loadDataEntryLock();
    this.loadMyPermissions();
    this.loadSubIndicatorCounts();
    this.loadSubResultSummary();
    if (this.isAdmin || this.isLocalAdmin) this.loadTargetEditRequests();
  }

  loadDataEntryLock() {
    this.authService.getDataEntryLock().subscribe({
      next: (res) => {
        if (res.success) {
          this.dataEntryLock = res.data;
          this.targetEditLocked = res.data.target_edit_locked === true;
        }
      }
    });
  }

  loadMyPermissions() {
    this.authService.getMyPermissions().subscribe({
      next: (res) => {
        if (res.success && res.permissions) {
          this.myPerms = res.permissions;
          this.cdr.detectChanges();
        }
      },
      error: () => { /* fallback: คงสิทธิ์เต็ม */ }
    });
  }

  // admin ทุกระดับไม่ถูกล็อค, user ถูกล็อคเมื่อเปิดล็อค
  get isEntryLocked(): boolean {
    if (this.isAdmin || this.isLocalAdmin) return false;
    return this.dataEntryLock.is_locked === true; // ป้องกันค่าที่ไม่ใช่ boolean จาก API (เคยได้ '' แล้วเกิด NG0100)
  }

  // แก้ไขเป้าหมายได้เมื่อ: role มีสิทธิ์ (can_edit_target) + ไม่ถูก global lock
  get canEditTarget(): boolean {
    if (this.isSuperAdmin) return true;
    return this.myPerms.can_edit_target !== false && !this.targetEditLocked;
  }

  // แก้ไขผลงาน (actual) ได้ตามสิทธิ์ role
  get canEditActual(): boolean {
    if (this.isSuperAdmin) return true;
    return this.myPerms.can_edit_actual !== false;
  }

  // admin_cup / admin_ssj / super_admin เห็นปุ่มขอแก้ไขเป้าหมายเมื่อล็อค
  get canRequestTargetEdit(): boolean {
    return this.targetEditLocked && (this.isAdmin || this.isLocalAdmin);
  }

  loadAppealSettings() {
    this.authService.getAppealSettings().subscribe({
      next: (res) => {
        if (res.success) this.appealSettings = res.data;
      }
    });
  }

  closeSearchStatus() {
    this.showSearchStatus = false;
    try { Swal.close(); } catch { }
  }

  // Escape HTML เพื่อกัน XSS ใน SweetAlert content
  private escHtml(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // สร้าง HTML ของ search status panel (ใช้ใน SweetAlert)
  private buildSearchStatusHtml(): string {
    const filtersHtml = this.appliedFilters.map(f => {
      const label = this.escHtml(f.label);
      const value = this.escHtml(f.value);
      return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${f.color}">
        <span style="opacity:.7">${label}:</span>
        <span style="font-weight:700;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${value}">${value}</span>
      </span>`;
    }).join(' ');

    // ส่วนบน: progress bar (ระหว่างโหลด) หรือ สรุป+นับถอยหลัง (เสร็จแล้ว)
    let topSection = '';
    if (!this.searchFinished) {
      // กำลังโหลด: progress bar
      topSection = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:12px;color:#6b7280">${this.escHtml(this.searchStage)}</span>
          <span style="font-size:11px;color:#6b7280;font-weight:700">${this.searchProgress}%</span>
        </div>
        <div style="width:100%;background:#e5e7eb;border-radius:9999px;height:10px;overflow:hidden;margin-bottom:12px">
          <div style="height:10px;border-radius:9999px;background:#3b82f6;width:${this.searchProgress}%;transition:width .3s"></div>
        </div>
      `;
    } else {
      // เสร็จแล้ว: สรุปเวลา + นับถอยหลัง (ไม่มี progress bar)
      const hasData = this.kpiData.length > 0;
      const accent = hasData ? '#10b981' : '#f59e0b';
      const summaryLine = hasData
        ? `ข้อมูลพร้อมใช้งาน <b>${this.filteredData.length}</b> / ${this.kpiData.length} รายการ`
        : 'ไม่พบข้อมูลตามตัวกรอง';
      topSection = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:12px;color:#374151">${summaryLine}</span>
          <span style="font-size:11px;color:#6b7280">
            <i class="fas fa-clock" style="margin-right:3px"></i>ใช้เวลา ${(this.searchDurationMs / 1000).toFixed(2)} วินาที
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:#f9fafb;border:1px dashed ${accent};border-radius:10px;margin-bottom:12px">
          <i class="fas fa-hourglass-half" style="color:${accent}"></i>
          <span style="font-size:12px;color:#374151">ปิดอัตโนมัติใน</span>
          <span style="font-size:16px;font-weight:700;color:${accent};min-width:20px;text-align:center">${this.searchCountdown}</span>
          <span style="font-size:12px;color:#374151">วินาที</span>
        </div>
      `;
    }

    return `
      <div style="text-align:left">
        ${topSection}
        ${this.appliedFilters.length > 0 ? `
        <div style="padding-top:8px;border-top:1px solid #e5e7eb">
          <div style="font-size:10px;font-weight:700;color:#6b7280;margin-bottom:6px">
            <i class="fas fa-filter" style="margin-right:4px"></i>ตัวกรองที่ใช้ (${this.appliedFilters.length}):
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${filtersHtml}</div>
        </div>` : ''}
      </div>
    `;
  }

  private _searchAutoCloseTimer: any = null;
  private _searchCountdownInterval: any = null;

  private openSearchStatusSwal() {
    // เปิด modal ครั้งเดียว — update title+html+button ด้วย DOM (ไม่ใช้ Swal.update)
    Swal.fire({
      title: '<i class="fas fa-search" style="color:#3b82f6"></i> กำลังค้นหาข้อมูล...',
      html: this.buildSearchStatusHtml(),
      width: 560,
      // กันปิดก่อนโหลดเสร็จ
      allowOutsideClick: false,
      allowEscapeKey: false,
      // แสดงปุ่ม "ปิด" ตั้งแต่ต้น แต่ซ่อนผ่าน CSS — โชว์เมื่อโหลดเสร็จ (ไม่ต้อง Swal.update)
      showConfirmButton: true,
      confirmButtonText: 'ปิด',
      confirmButtonColor: '#3b82f6',
      didOpen: () => {
        const actions = Swal.getActions();
        if (actions) (actions as HTMLElement).style.display = 'none';
      },
    });
  }

  private updateSearchStatusSwal() {
    if (!Swal.isVisible()) return;
    const container = Swal.getHtmlContainer();
    if (container) container.innerHTML = this.buildSearchStatusHtml();
  }

  // จบการค้นหา: update title + html + แสดงปุ่มปิด + นับถอยหลัง 5 วินาที — modal เดียวตลอด
  private finishSearchStatusSwal(final: { success: boolean; message: string }) {
    if (!Swal.isVisible()) return;
    const hasData = this.kpiData.length > 0;
    const color = hasData ? '#10b981' : (final.success ? '#f59e0b' : '#ef4444');
    const iconHtml = final.success
      ? (hasData
          ? `<i class="fas fa-check-circle" style="color:#10b981"></i>`
          : `<i class="fas fa-exclamation-triangle" style="color:#f59e0b"></i>`)
      : `<i class="fas fa-times-circle" style="color:#ef4444"></i>`;

    // mark finished → buildSearchStatusHtml จะ render summary+countdown (ไม่มี progress bar)
    this.searchFinished = true;
    this.searchCountdown = 5;

    // 1) Update title ผ่าน DOM
    const titleEl = Swal.getTitle();
    if (titleEl) titleEl.innerHTML = `${iconHtml} ${this.escHtml(final.message)}`;

    // 2) Update body content (mode: finished → summary + countdown)
    this.updateSearchStatusSwal();

    // 3) แสดงปุ่มปิด (ที่ซ่อนไว้) + เปลี่ยนสี
    const actions = Swal.getActions();
    if (actions) (actions as HTMLElement).style.display = '';
    const btn = Swal.getConfirmButton() as HTMLButtonElement | null;
    if (btn) {
      btn.textContent = 'ปิด';
      btn.style.backgroundColor = color;
    }

    // 4) Countdown tick ทุก 1 วินาที — update DOM แล้วปิดเมื่อถึง 0
    this.clearSearchTimers();
    this._searchCountdownInterval = setInterval(() => {
      this.searchCountdown--;
      if (this.searchCountdown <= 0) {
        this.clearSearchTimers();
        if (Swal.isVisible()) Swal.close();
      } else {
        this.updateSearchStatusSwal();
      }
    }, 1000);
  }

  private clearSearchTimers() {
    if (this._searchCountdownInterval) { clearInterval(this._searchCountdownInterval); this._searchCountdownInterval = null; }
    if (this._searchAutoCloseTimer) { clearTimeout(this._searchAutoCloseTimer); this._searchAutoCloseTimer = null; }
  }

  // คำนวณตัวกรองที่ใช้งาน → แสดงใน search status panel
  private computeAppliedFilters(): { label: string; value: string; color: string }[] {
    const out: { label: string; value: string; color: string }[] = [];
    if (this.selectedYear) out.push({ label: 'ปีงบฯ', value: this.selectedYear, color: 'bg-green-100 text-green-700' });
    if (this.selectedDistricts.length > 0) out.push({ label: 'อำเภอ', value: this.selectedDistricts.join(', '), color: 'bg-teal-100 text-teal-700' });
    if (this.selectedHosTypes.length > 0) out.push({ label: 'ประเภท รพ.', value: this.hosTypeLabel(), color: 'bg-cyan-100 text-cyan-700' });
    if (this.selectedHospitals.length > 0) out.push({ label: 'หน่วยบริการ', value: this.selectedHospitals.length === 1 ? this.selectedHospitals[0] : `${this.selectedHospitals.length} รพ.`, color: 'bg-blue-100 text-blue-700' });
    if (this.selectedDepts.length > 0) out.push({ label: 'หน่วยงาน', value: this.selectedDepts.length === 1 ? this.selectedDepts[0] : `${this.selectedDepts.length} หน่วยงาน`, color: 'bg-amber-100 text-amber-700' });
    if (this.selectedMain) out.push({ label: 'หมวดหมู่', value: this.selectedMain, color: 'bg-indigo-100 text-indigo-700' });
    if (this.selectedIndicator) out.push({ label: 'ตัวชี้วัด', value: this.selectedIndicator, color: 'bg-indigo-100 text-indigo-700' });
    if (this.selectedIndicatorOffTypes.length > 0) out.push({ label: 'ตัวชี้วัดของ', value: this.indicatorOffTypeLabel(), color: 'bg-cyan-100 text-cyan-700' });
    if (this.selectedTypes.length > 0) out.push({ label: 'ประเภท KPI', value: this.selectedTypes.join('/').toUpperCase(), color: 'bg-gray-100 text-gray-700' });
    if (this.selectedStatuses.length > 0) out.push({ label: 'สถานะ', value: `${this.selectedStatuses.length} สถานะ`, color: 'bg-rose-100 text-rose-700' });
    if (this.searchTerm?.trim()) out.push({ label: 'ค้นหา', value: this.searchTerm.trim(), color: 'bg-gray-100 text-gray-700' });
    return out;
  }

  private animateProgress(to: number, durationMs: number = 600) {
    if (this._progressTimer) clearInterval(this._progressTimer);
    const start = this.searchProgress;
    const diff = to - start;
    const steps = 20;
    const stepMs = durationMs / steps;
    let i = 0;
    this._progressTimer = setInterval(() => {
      i++;
      this.searchProgress = Math.min(to, Math.round(start + (diff * i / steps)));
      this.cdr.detectChanges();
      // อัปเดต SweetAlert content ให้ progress bar สมูท
      if (Swal.isVisible()) this.updateSearchStatusSwal();
      if (i >= steps) {
        clearInterval(this._progressTimer);
        this._progressTimer = null;
      }
    }, stepMs);
  }

  loadKpiData(silent: boolean = false) {
    this.isLoading = true;
    // เปิด search status panel (SweetAlert modal) + reset progress — ข้ามถ้า silent
    this.clearSearchTimers();
    this.showSearchStatus = !silent;
    this.searchFinished = false;
    this.searchStage = 'กำลังค้นหาข้อมูล...';
    this.searchProgress = 0;
    this.searchStartedAt = Date.now();
    this.searchDurationMs = 0;
    this.searchCountdown = 0;
    this.appliedFilters = this.computeAppliedFilters();
    if (!silent) this.openSearchStatusSwal();
    if (!silent) this.animateProgress(30, 400);
    if (!this.selectedYear) this.setDefaultYear();
    // ส่ง filter ไปกรองที่ backend — multi-select ใช้ comma-separated
    const filters: any = { year: this.selectedYear };

    if (this.selectedHospitals.length > 0) {
      const codes = this.selectedHospitals
        .map(n => this._allHospitals.find((h: any) => h.hosname === n)?.hoscode)
        .filter(Boolean);
      if (codes.length > 0) filters.hospcode = codes.join(',');
    }
    if (this.selectedDepts.length > 0) filters.dept = this.selectedDepts.join(',');
    if (this.selectedDistricts.length > 0) filters.district = this.selectedDistricts.join(',');
    if (this.selectedIndicator) filters.indicator = this.selectedIndicator;
    if (this.selectedMain) filters.main = this.selectedMain;
    // ส่ง hostype → backend ใช้ subquery ผ่าน chospital.hostype
    if (this.selectedHosTypes.length > 0) filters.hostype = this.selectedHosTypes.join(',');
    // ส่ง indicator_off_type → backend filter kpi_indicators.required_off_types
    if (this.selectedIndicatorOffTypes.length > 0) filters.indicator_off_type = this.selectedIndicatorOffTypes.join(',');
    this.authService.getKpiResults(filters).subscribe({
      next: (res) => {
        this.isLoading = false;
        this.searchStage = 'กำลังประมวลผลข้อมูล...';
        if (!silent) this.animateProgress(70, 300);
        if (!silent) this.updateSearchStatusSwal();
        if (res && res.success) {
          this.kpiData = res.data;
          this.kpiData.forEach(item => {
            item.target_value = item.target_value != null ? String(item.target_value) : '';
            item.last_actual = String(item.last_actual ?? '');
            item.total_actual = parseFloat(item.last_actual) || 0;
            item.pending_count = Number(item.pending_count) || 0;
            ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].forEach(m => item[m] = item[m] != null ? String(item[m]) : '');
          });

          this.filteredData = res.data;
          // คงปีงบที่ผู้ใช้เลือกไว้ — เดิม reset เป็นปีงบปัจจุบันทุกครั้ง ทำให้ค้นหาปีย้อนหลังแล้ว
          // applyFilters() กรอง matchYear ทิ้งหมดจนแสดง 0 รายการ ทั้งที่ backend คืนข้อมูลมาแล้ว
          if (!this.selectedYear) this.setDefaultYear();
          this.extractFilterLists();

          // ตั้ง filter เริ่มต้นตาม role ของผู้ใช้ (เฉพาะครั้งแรก)
          if (this._defaultHospcode) {
            const matchHos = this.hospitalNames.find(n => {
              const item = this.kpiData.find(d => d.hosname === n && d.hospcode === this._defaultHospcode);
              return !!item;
            });
            if (matchHos) this.selectedHospital = matchHos;
            this._defaultHospcode = '';
          } else if (this._defaultDistrictScope) {
            const user = this.currentUser;
            if (user?.hospcode) {
              const myItem = this.kpiData.find(d => d.hospcode === user.hospcode);
              if (myItem?.distname) this.selectedDistrict = myItem.distname;
            }
            this._defaultDistrictScope = false;
          }

          this.applyFilters();
          this.loadDashboardStats();
          this.loadDynamicFormMonths();
          // รีโหลด sub summary → จะ apply override หลังโหลดเสร็จ
          this.loadSubResultSummary();
          // Finalize progress panel
          this.searchDurationMs = Date.now() - this.searchStartedAt;
          this.searchProgress = 100;
          const msg = this.kpiData.length > 0
            ? `พบข้อมูล ${this.kpiData.length} รายการ`
            : 'ไม่พบข้อมูล';
          this.searchStage = msg;
          this.cdr.detectChanges();
          if (!silent) this.finishSearchStatusSwal({ success: true, message: msg });

          if (!silent && this.kpiData.length === 0) this.showNoDataAlert();
        }
      },
      error: (err) => {
        this.isLoading = false;
        // ระบุประเภท error: timeout/504 vs อื่น
        const isTimeout = err?.name === 'TimeoutError' || err?.status === 504 || err?.status === 408;
        const errMsg = isTimeout
          ? 'การค้นหาใช้เวลานานเกินไป (Timeout) — กรุณาเลือกตัวกรองให้ละเอียดขึ้น (เช่น เลือกอำเภอ หน่วยงาน หรือตัวชี้วัด)'
          : 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
        this.searchStage = errMsg;
        this.searchProgress = 0;
        this.searchDurationMs = Date.now() - this.searchStartedAt;
        this.cdr.detectChanges();
        if (!silent) this.finishSearchStatusSwal({ success: false, message: errMsg });
        console.error('Error loading KPI:', err);
      }
    });
  }

  private showNoDataAlert() {
    const role = this.authService.getUserRole();
    const isAdmin = ['super_admin', 'admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso'].includes(role);
    const adminTip = isAdmin
      ? `<div class="bg-green-50 border border-green-200 rounded-lg p-3 mt-3 text-left">
          <p class="font-bold text-green-800 text-xs mb-1"><i class="fas fa-lightbulb mr-1"></i>คำแนะนำสำหรับ Admin</p>
          <ol class="list-decimal ml-4 text-xs text-green-700 space-y-1">
            <li>ไปที่เมนู <b>"จัดการตัวชี้วัด"</b> → ตรวจสอบว่ามีตัวชี้วัดที่เปิดใช้งาน</li>
            <li>ไปที่ <b>"สร้าง KPI ปีงบใหม่"</b> → เพิ่มตัวชี้วัดให้แต่ละหน่วยบริการ (Bulk Add)</li>
            <li>ตรวจสอบว่าหน่วยบริการมี <b>hospcode</b> ตรงกับตาราง chospital</li>
            <li>ตรวจสอบ <b>ปีงบประมาณ</b> ที่เลือก — ข้อมูลอาจอยู่ปีอื่น</li>
          </ol>
        </div>` : '';

    Swal.fire({
      icon: 'info',
      title: 'ไม่พบข้อมูล',
      html: `<div class="text-sm text-gray-600">
        <p>ไม่พบข้อมูลตัวชี้วัดตามเงื่อนไขที่เลือก</p>
        <div class="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3 text-left">
          <p class="font-bold text-blue-800 text-xs mb-1"><i class="fas fa-search mr-1"></i>ลองตรวจสอบ</p>
          <ul class="list-disc ml-4 text-xs text-blue-700 space-y-1">
            <li>เปลี่ยน <b>ปีงบประมาณ</b> (อาจยังไม่มีข้อมูลในปีที่เลือก)</li>
            <li>ลองเลือก <b>อำเภอ</b> หรือ <b>ประเภท รพ.</b> ที่ต่างออกไป</li>
            <li>ปรับ <b>ตัวกรอง</b> ให้แคบลง แล้วกด <b>"ค้นหา"</b></li>
          </ul>
        </div>
        ${adminTip}
      </div>`,
      confirmButtonColor: '#6366f1'
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

  get pagedData() {
    const pageItems = [...this.filteredData];
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

  setDefaultYear() {
    this.selectedYear = String(getCurrentFiscalYear());
  }

  private _filterListsLoaded = false;

  extractFilterLists() {
    const currentBhYear = getCurrentFiscalYear();
    this.filterYears = [currentBhYear + 1, currentBhYear, currentBhYear - 1, currentBhYear - 2].map(String);

    if (!this._filterListsLoaded) {
      this._filterListsLoaded = true;
      // Backend (/departments, /hospitals, /districts) กรองรายการตาม role scope ให้แล้ว (dept/hospcode/อำเภอ ตัวเอง
      // สำหรับ role ที่ scope แบบนั้น — ดู ROLE_SCOPE_OWN_DEPT/ROLE_SCOPE_HOSPCODE/ROLE_SCOPE_DISTRICT ใน server.js)
      // ฝั่งนี้แค่ auto-select ให้อัตโนมัติเมื่อเหลือตัวเลือกเดียว (แปลว่าถูกล็อคจริง) — ไม่ hardcode รายชื่อ role ซ้ำที่นี่
      // กันปัญหาเดิมที่ลืมเพิ่ม role ใหม่ (เช่น user_hos/user_sso/user_cup) ตอนแก้จุดเดียวแต่อีกจุดไม่ได้แก้ตาม
      this.authService.getDepartments().subscribe(res => {
        if (res.success) {
          this.deptNames = res.data.map((d: any) => d.dept_name);
          if (this.deptNames.length === 1) this.selectedDept = this.deptNames[0];
          this.cdr.detectChanges();
        }
      });
      this.authService.getHospitals().subscribe(res => {
        if (res.success) {
          this._allHospitals = res.data;
          this.hospitalNames = res.data.map((h: any) => h.hosname).filter(Boolean).sort();
          if (this.hospitalNames.length === 1) this.selectedHospital = this.hospitalNames[0];
          this.cdr.detectChanges();
        }
      });
      this.authService.getDistricts().subscribe(res => {
        if (res.success) {
          this._allDistricts = res.data;
          this.districtNames = res.data.map((d: any) => d.distname).filter(Boolean).sort();
          if (this.districtNames.length === 1) this.selectedDistrict = this.districtNames[0];
          this.cdr.detectChanges();
        }
      });
      this.authService.getIndicators().subscribe(res => {
        if (res.success) {
          this._allIndicators = res.data;
          this.indicatorNames = Array.from(new Set<string>(res.data.map((i: any) => i.kpi_indicators_name)));
          this.mainCategories = Array.from(new Set<string>(res.data.map((i: any) => i.main_indicator_name).filter(Boolean)));
          this.cdr.detectChanges();
        }
      });
      this.authService.getHosTypes().subscribe(res => {
        if (res.success) {
          this._allHosTypes = res.data;
          this.hosTypeList = res.data;
          this.cdr.detectChanges();
        }
      });
    }
  }

  // === Cascading filter logic (bidirectional: district ↔ hostype ↔ hospital) ===

  // กรองรายชื่อหน่วยบริการตาม districts[] + hosTypes[] (multi)
  private rebuildHospitalList() {
    let filtered = this._allHospitals;
    if (this.selectedDistricts.length > 0) {
      const distIds = this._allDistricts
        .filter((d: any) => this.selectedDistricts.includes(d.distname))
        .map((d: any) => d.distid);
      filtered = filtered.filter((h: any) => distIds.includes(h.distid));
    }
    if (this.selectedHosTypes.length > 0) {
      filtered = filtered.filter((h: any) => this.selectedHosTypes.includes(h.hostype));
    }
    this.hospitalNames = filtered.map((h: any) => h.hosname).filter(Boolean).sort();
    // ลบรายการที่เลือกไว้แต่ไม่อยู่ในรายการใหม่
    this.selectedHospitals = this.selectedHospitals.filter(n => this.hospitalNames.includes(n));
  }

  // กรองประเภท รพ. ตาม districts[] — นับจำนวนหน่วยบริการ
  private rebuildHosTypeList() {
    let hospitals = this._allHospitals;
    if (this.selectedDistricts.length > 0) {
      const distIds = this._allDistricts
        .filter((d: any) => this.selectedDistricts.includes(d.distname))
        .map((d: any) => d.distid);
      hospitals = hospitals.filter((h: any) => distIds.includes(h.distid));
    }
    const countMap = new Map<string, number>();
    for (const h of hospitals) {
      if (h.hostype) countMap.set(h.hostype, (countMap.get(h.hostype) || 0) + 1);
    }
    this.hosTypeList = this._allHosTypes
      .filter((ht: any) => countMap.has(ht.hostypecode))
      .map((ht: any) => ({ ...ht, hospital_count: countMap.get(ht.hostypecode) || 0 }));
    this.selectedHosTypes = this.selectedHosTypes.filter(c => this.hosTypeList.some((ht: any) => ht.hostypecode === c));
  }

  // กรองอำเภอตาม hosTypes[] — แสดงเฉพาะอำเภอที่มี hostype นั้น
  private rebuildDistrictList() {
    if (this.selectedHosTypes.length > 0) {
      const distsWithType = new Set(
        this._allHospitals.filter((h: any) => this.selectedHosTypes.includes(h.hostype)).map((h: any) => h.distid)
      );
      this.districtNames = this._allDistricts
        .filter((d: any) => distsWithType.has(d.distid))
        .map((d: any) => d.distname).filter(Boolean).sort();
      this.selectedDistricts = this.selectedDistricts.filter(n => this.districtNames.includes(n));
    } else {
      this.districtNames = this._allDistricts.map((d: any) => d.distname).filter(Boolean).sort();
    }
  }

  onDistrictCascade() {
    this.rebuildHosTypeList();
    this.rebuildHospitalList();
  }

  onHosTypeCascade() {
    this.rebuildDistrictList();
    this.rebuildHospitalList();
  }

  onHospitalCascade() {
    if (this.selectedHospital && this._allIndicators.length > 0) {
      const matchHos = this._allHospitals.find((h: any) => h.hosname === this.selectedHospital);
      if (matchHos) {
        // ถ้ามี dept match จาก kpiData
        const matchItem = this.kpiData.find((d: any) => d.hosname === this.selectedHospital);
        if (matchItem?.dept_name) {
          const deptInds = this._allIndicators.filter((i: any) => i.dept_name === matchItem.dept_name);
          this.indicatorNames = Array.from(new Set<string>(deptInds.map((i: any) => i.kpi_indicators_name)));
          this.mainCategories = Array.from(new Set<string>(deptInds.map((i: any) => i.main_indicator_name).filter(Boolean)));
        }
      }
    } else {
      this.indicatorNames = Array.from(new Set<string>(this._allIndicators.map((i: any) => i.kpi_indicators_name)));
      this.mainCategories = Array.from(new Set<string>(this._allIndicators.map((i: any) => i.main_indicator_name).filter(Boolean)));
    }
    if (this.selectedIndicator && !this.indicatorNames.includes(this.selectedIndicator)) this.selectedIndicator = '';
    if (this.selectedMain && !this.mainCategories.includes(this.selectedMain)) this.selectedMain = '';
  }

  onDeptCascade() {
    if (this.selectedDept && this._allIndicators.length > 0) {
      const deptInds = this._allIndicators.filter((i: any) => i.dept_name === this.selectedDept);
      this.indicatorNames = Array.from(new Set<string>(deptInds.map((i: any) => i.kpi_indicators_name)));
      this.mainCategories = Array.from(new Set<string>(deptInds.map((i: any) => i.main_indicator_name).filter(Boolean)));
    } else {
      this.indicatorNames = Array.from(new Set<string>(this._allIndicators.map((i: any) => i.kpi_indicators_name)));
      this.mainCategories = Array.from(new Set<string>(this._allIndicators.map((i: any) => i.main_indicator_name).filter(Boolean)));
    }
    if (this.selectedIndicator && !this.indicatorNames.includes(this.selectedIndicator)) this.selectedIndicator = '';
    if (this.selectedMain && !this.mainCategories.includes(this.selectedMain)) this.selectedMain = '';
  }

  // === กดปุ่ม "ค้นหา" → ตรวจว่าเลือกตัวกรองหรือยัง ===
  doSearch() {
    // admin_ssj / user_ssj มี dept ล็อคอัตโนมัติ → ไม่นับเป็นตัวกรองที่ผู้ใช้เลือกเอง
    const role = this.authService.getUserRole();
    const isLockedDept = ['admin_ssj', 'user_ssj'].includes(role);
    const hasFilter = this.selectedDistricts.length > 0 || this.selectedHospitals.length > 0
      || (!isLockedDept && this.selectedDepts.length > 0)
      || this.selectedHosTypes.length > 0 || this.selectedIndicatorOffTypes.length > 0
      || this.selectedMain || this.selectedIndicator
      || this.selectedTypes.length > 0 || this.selectedStatuses.length > 0;

    if (!hasFilter) {
      Swal.fire({
        title: 'กรุณาเลือกตัวกรอง',
        html: `<p class="text-sm text-gray-600">เลือกอย่างน้อย 1 เงื่อนไข เช่น อำเภอ, ประเภท รพ., หน่วยงาน หรือตัวชี้วัด<br>เพื่อจำกัดขอบเขตข้อมูลก่อนค้นหา</p>`,
        icon: 'info',
        confirmButtonText: 'ตกลง',
        confirmButtonColor: '#6366f1',
      });
      return;
    }
    this.loadKpiData();
    this.loadDashboardStats();
  }

  // === โหลดข้อมูลทั้งหมด (ทีละอำเภอ + progress จริง) ===
  async loadAllData() {
    const startTime = Date.now();
    const districts = this._allDistricts.length > 0 ? this._allDistricts : [{ distname: '' }];
    const total = districts.length;
    let allData: any[] = [];

    Swal.fire({
      title: 'กำลังโหลดข้อมูลทั้งหมด...',
      html: `<div class="text-left text-sm space-y-2">
        <div class="flex items-center gap-2"><i class="fas fa-spinner fa-spin text-green-500"></i> <span id="load-step">เตรียมข้อมูล...</span></div>
        <div class="flex items-center gap-2 text-gray-400"><i class="fas fa-clock"></i> เวลา: <b id="load-timer">0</b> วินาที</div>
        <div class="w-full bg-gray-200 rounded-full h-3 mt-2">
          <div id="load-progress" class="bg-green-500 h-3 rounded-full transition-all duration-300" style="width: 0%"></div>
        </div>
      </div>`,
      allowOutsideClick: false,
      showConfirmButton: false,
      didOpen: () => {
        const iv = setInterval(() => {
          const el = document.getElementById('load-timer');
          if (el) el.textContent = String(Math.floor((Date.now() - startTime) / 1000));
          if (!Swal.isVisible()) clearInterval(iv);
        }, 1000);
      }
    });

    try {
      if (!this.selectedYear) this.setDefaultYear();
      for (let i = 0; i < districts.length; i++) {
        const dist = districts[i];
        const pct = Math.round(((i + 1) / total) * 100);
        const stepEl = document.getElementById('load-step');
        const progEl = document.getElementById('load-progress');
        if (stepEl) stepEl.textContent = `อำเภอ ${i + 1}/${total}: ${dist.distname || 'ทั้งหมด'}`;
        if (progEl) progEl.style.width = pct + '%';

        const filters: any = { year: this.selectedYear };
        if (dist.distname) filters.district = dist.distname;

        const res: any = await this.authService.getKpiResults(filters).toPromise();
        if (res?.success && res.data) {
          res.data.forEach((item: any) => {
            item.target_value = item.target_value != null ? String(item.target_value) : '';
            item.last_actual = String(item.last_actual ?? '');
            item.total_actual = parseFloat(item.last_actual) || 0;
            item.pending_count = Number(item.pending_count) || 0;
            ['oct','nov','dece','jan','feb','mar','apr','may','jun','jul','aug','sep'].forEach(m => item[m] = item[m] != null ? String(item[m]) : '');
          });
          allData = allData.concat(res.data);
        }
      }

      this.kpiData = allData;
      this.filteredData = allData;
      this.applyFilters();
      this.loadSubResultSummary();
      this.cdr.detectChanges();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (allData.length === 0) {
        this.showNoDataAlert();
      } else {
        Swal.fire({
          icon: 'success',
          title: 'โหลดข้อมูลสำเร็จ',
          html: `<div class="text-sm"><b>${allData.length}</b> รายการ จาก <b>${total}</b> อำเภอ (${elapsed} วินาที)</div>`,
          timer: 3000, showConfirmButton: false
        });
      }
    } catch (err: any) {
      Swal.fire('ผิดพลาด', err?.error?.message || 'ไม่สามารถโหลดข้อมูลได้', 'error');
    }
  }

  onYearChange() {
    this.loadKpiData();
    this.loadDashboardStats();
  }

  onFilterChange() {
    this.loadKpiData();
  }

  setDefaultFilters() {
    const role = this.authService.getUserRole();
    const user = this.currentUser;
    if (!user) return;

    // ทุก role กรองตาม hospcode/อำเภอ ของตัวเองเป็นค่าเริ่มต้น
    if (['admin_hos', 'admin_sso', 'user_hos', 'user_sso'].includes(role)) {
      this._defaultHospcode = user.hospcode || '';
    } else if (['admin_cup', 'user_cup'].includes(role)) {
      this._defaultDistrictScope = true;
    }
    // super_admin / admin_ssj → backend limit 500 + กรองตาม year เริ่มต้น (ไม่ lock filter)
  }

  private _defaultHospcode: string = '';
  private _defaultDistrictScope: boolean = false;

  clearFilters() {
    this.searchTerm = '';
    this.selectedMain = '';
    this.selectedIndicator = '';
    this.setDefaultYear();
    this.selectedStatuses = [];
    this.selectedHospitals = [];
    this.selectedDistricts = [];
    this.selectedTypes = [];
    this.selectedHosTypes = [];
    this.selectedIndicatorOffTypes = [];
    // reset cascade lists กลับเป็น "ทั้งหมดเท่าที่ backend scope ให้ตาม role" (ดู extractFilterLists())
    this.districtNames = this._allDistricts.map((d: any) => d.distname).filter(Boolean).sort();
    this.hospitalNames = this._allHospitals.map((h: any) => h.hosname).filter(Boolean).sort();
    this.hosTypeList = this._allHosTypes;
    this.indicatorNames = Array.from(new Set<string>(this._allIndicators.map((i: any) => i.kpi_indicators_name)));
    this.mainCategories = Array.from(new Set<string>(this._allIndicators.map((i: any) => i.main_indicator_name).filter(Boolean)));
    // auto-select กลับเมื่อเหลือตัวเลือกเดียว (role ถูกล็อคจาก backend) — ไม่ hardcode รายชื่อ role ซ้ำที่นี่
    this.selectedDepts = this.deptNames.length === 1 ? [this.deptNames[0]] : [];
    this.selectedDistricts = this.districtNames.length === 1 ? [this.districtNames[0]] : [];
    this.selectedHospitals = this.hospitalNames.length === 1 ? [this.hospitalNames[0]] : [];
    // เคลียร์ข้อมูล → กลับหน้า "กรุณาเลือกตัวกรอง"
    this.kpiData = [];
    this.filteredData = [];
    this.cdr.detectChanges();
  }

  // ============== Saved Views (Filter Preset) ==============
  private savedViewsKey(): string {
    const uid = this.authService.getUser()?.id || 'anon';
    return `kpi_views_user_${uid}`;
  }
  loadSavedViews() {
    try {
      const raw = localStorage.getItem(this.savedViewsKey());
      this.savedViews = raw ? JSON.parse(raw) : [];
    } catch { this.savedViews = []; }
  }
  /** เปิด modal บันทึก view ปัจจุบัน */
  openSaveViewModal() {
    this.newViewName = '';
    this.showSaveViewModal = true;
    this.cdr.detectChanges();
  }
  /** บันทึก view (filter + year ปัจจุบัน) ลง localStorage */
  saveCurrentView() {
    const name = (this.newViewName || '').trim();
    if (!name) { this.toast.warning('กรุณาตั้งชื่อ View'); return; }
    const view = {
      id: Date.now(),
      name,
      created_at: new Date().toISOString(),
      filters: {
        year: this.selectedYear,
        districts: [...this.selectedDistricts],
        hosTypes: [...this.selectedHosTypes],
        hospitals: [...this.selectedHospitals],
        depts: [...this.selectedDepts],
        indicatorOffTypes: [...this.selectedIndicatorOffTypes],
        statuses: [...this.selectedStatuses],
        types: [...this.selectedTypes],
        main: this.selectedMain,
        indicator: this.selectedIndicator,
        search: this.searchTerm
      }
    };
    this.loadSavedViews();
    this.savedViews.unshift(view);
    if (this.savedViews.length > 20) this.savedViews = this.savedViews.slice(0, 20);
    localStorage.setItem(this.savedViewsKey(), JSON.stringify(this.savedViews));
    this.showSaveViewModal = false;
    this.toast.success(`บันทึก "${name}" แล้ว`);
    this.cdr.detectChanges();
  }
  /** โหลด view ที่บันทึกไว้ + ค้นหาทันที */
  applySavedView(v: any) {
    const f = v.filters || {};
    if (f.year) this.selectedYear = f.year;
    this.selectedDistricts = [...(f.districts || [])];
    this.selectedHosTypes = [...(f.hosTypes || [])];
    this.selectedHospitals = [...(f.hospitals || [])];
    this.selectedDepts = [...(f.depts || [])];
    this.selectedIndicatorOffTypes = [...(f.indicatorOffTypes || [])];
    this.selectedStatuses = [...(f.statuses || [])];
    this.selectedTypes = [...(f.types || [])];
    this.selectedMain = f.main || '';
    this.selectedIndicator = f.indicator || '';
    this.searchTerm = f.search || '';
    this.toast.info(`โหลด View "${v.name}"`);
    this.loadKpiData();
    this.loadDashboardStats();
  }
  deleteSavedView(v: any) {
    this.savedViews = this.savedViews.filter(x => x.id !== v.id);
    localStorage.setItem(this.savedViewsKey(), JSON.stringify(this.savedViews));
    this.toast.success(`ลบ View "${v.name}" แล้ว`);
    this.cdr.detectChanges();
  }

  applyFilters() {
    this.filteredData = this.kpiData.filter(item => {
      const deptName = item.dept_name || '';
      const year = item.year_bh || '';
      const mainindicatorName = item.main_indicator_name || '';
      const indicatorName = item.kpi_indicators_name || '';
      const recorderName = item.recorder_name || '';
      const hosname = item.hosname || '';
      const distname = item.distname || '';
      const search = this.searchTerm.toLowerCase();
      const matchSearch = indicatorName.toLowerCase().includes(search) ||
                        recorderName.toLowerCase().includes(search) ||
                        deptName.toLowerCase().includes(search) ||
                        mainindicatorName.toLowerCase().includes(search) ||
                        hosname.toLowerCase().includes(search) ||
                        distname.toLowerCase().includes(search);
      const matchMain = this.selectedMain === '' || item.main_indicator_name === this.selectedMain;
      const matchIndicator = this.selectedIndicator === '' || item.kpi_indicators_name === this.selectedIndicator;
      const matchdept = this.selectedDepts.length === 0 || this.selectedDepts.includes(item.dept_name);
      const matchYear = this.selectedYear === '' || item.year_bh === this.selectedYear;
      const matchHospital = this.selectedHospitals.length === 0 || this.selectedHospitals.includes(item.hosname);
      const matchDistrict = this.selectedDistricts.length === 0 || this.selectedDistricts.includes(item.distname);
      const matchHosType = this.selectedHosTypes.length === 0 || this.selectedHosTypes.includes(item.hostype);
      const tv = String(item.target_value ?? '').trim();
      const la = String(item.last_actual ?? '').trim();
      const hasTarget = tv !== '' && tv !== '0';
      const hasActual = la !== '' && la !== '0';
      const statusMatches = (s: string) =>
        (s === 'pass' && hasTarget && this.isTargetMet(item)) ||
        (s === 'fail' && hasTarget && !this.isTargetMet(item)) ||
        (s === 'pending' && item.pending_count > 0) ||
        (s === 'reviewed' && Number(item.pending_count) === 0 && hasActual) ||
        (s === 'has_target_actual' && hasTarget && hasActual) ||
        (s === 'no_target' && !hasTarget) ||
        (s === 'no_actual' && hasTarget && !hasActual) ||
        (s === 'no_target_no_actual' && !hasTarget && !hasActual);
      const matchStatus = this.selectedStatuses.length === 0 || this.selectedStatuses.some(statusMatches);
      const typeMatches = (t: string) =>
        (t === 'r9' && item.r9 === 1) || (t === 'moph' && item.moph === 1) ||
        (t === 'ssj' && item.ssj === 1) || (t === 'rmw' && item.rmw === 1) ||
        (t === 'other' && item.other === 1);
      const matchType = this.selectedTypes.length === 0 || this.selectedTypes.some(typeMatches);
      return matchSearch && matchMain && matchIndicator && matchdept && matchYear && matchStatus && matchHospital && matchDistrict && matchHosType && matchType;
    });
    if (this.sortField) {
      const dir = this.sortDir === 'asc' ? 1 : -1;
      const numFields = new Set(['target_value', 'last_actual', '_pct']);
      this.filteredData.sort((a, b) => {
        let va: any, vb: any;
        if (this.sortField === '_pct') {
          va = this.calcPercent(a);
          vb = this.calcPercent(b);
        } else {
          va = a[this.sortField] ?? '';
          vb = b[this.sortField] ?? '';
        }
        if (numFields.has(this.sortField)) {
          return (parseFloat(va) - parseFloat(vb)) * dir;
        }
        return String(va).localeCompare(String(vb), 'th') * dir;
      });
    } else {
      this.filteredData.sort((a, b) => {
        if (b.year_bh !== a.year_bh) return b.year_bh.localeCompare(a.year_bh);
        if (a.main_indicator_name < b.main_indicator_name) return -1;
        if (a.main_indicator_name > b.main_indicator_name) return 1;
        return a.kpi_indicators_name.localeCompare(b.kpi_indicators_name);
      });
    }
    this.totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    this.currentPage = 1;
    this.cdr.detectChanges();
  }

  toggleEditMode() {
    if (!this.isEditing) {
      // ถ้า item ถูก override ด้วย sub-summary AVG → คืนค่า raw ก่อนให้แก้ไข
      // (ไม่งั้น edit กับ save ไม่ตรงกัน เพราะ save ส่งค่าไปบันทึกเป็น kpi_results จริงของ main indicator)
      this.filteredData.forEach(item => {
        if (item._fromSubSummary && item._mainOriginal) {
          Object.assign(item, item._mainOriginal);
          item._fromSubSummary = false;
        }
        item._anomaly = null;
        item._original = { ...item };
      });
      this.isEditing = true;
      this.loadPrevYearMonths();
      this.authService.setFocusMode(true);
      Swal.fire({
        icon: 'info',
        title: 'เข้าสู่โหมดแก้ไข',
        text: 'คุณสามารถแก้ไขตัวเลขในตารางได้แล้ว',
        timer: 5000,
        timerProgressBar: true,
        showConfirmButton: false
      });
    } else {
      this.resetData(false);
      this.restoreHier();
      this.isEditing = false;
      this.authService.setFocusMode(this.isDeleteMode);
      // ออกจากโหมดแก้ไข → re-apply sub summary AVG กลับขึ้นจอ
      this.applySubSummaryToKpiData();
    }
  }

  saveKpiData() {
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const monthNames: any = {
      oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
      apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
    };
    const changedItems = this.filteredData.filter(item => {
      if (!item._original) return false;
      if (String(item.target_value ?? '') !== String(item._original.target_value ?? '')) return true;
      if (this.isCustomChanged(item)) return true;
      return months.some(m => String(item[m] ?? '') !== String(item._original[m] ?? ''));
    });
    // ช่องที่แก้ไขในแถวลูก (ข้อย่อย/กิจกรรม — ตัวชี้วัด 3 ระดับ) บันทึกพร้อมกันด้วยปุ่มเดียวกัน
    const hierChanges = this.collectHierChanges();

    if (changedItems.length === 0 && hierChanges.length === 0) {
      Swal.fire({ icon: 'info', title: 'ไม่มีข้อมูลที่เปลี่ยนแปลง', text: 'ไม่พบรายการที่มีการแก้ไข', confirmButtonText: 'ตกลง' });
      return;
    }

    // ตรวจสอบคะแนนที่น้อยกว่าเดิม
    const decreasedList: string[] = [];
    for (const item of changedItems) {
      for (const m of months) {
        const oldVal = parseFloat(item._original[m]);
        const newVal = parseFloat(item[m]);
        if (!isNaN(oldVal) && oldVal > 0 && !isNaN(newVal) && newVal < oldVal) {
          decreasedList.push(`<b>${item.kpi_indicators_name}</b> ${monthNames[m]}: ${item._original[m]} → ${item[m]}`);
        }
      }
    }
    // ถ้ามีค่าน้อยกว่าเดิม → แจ้งเตือนยืนยัน/ยกเลิก ก่อน
    const proceedToSave = () => {
      // Helper: สร้าง badge สถานะ (เพิ่ม/ลด/ลบ/ใหม่/แก้ไข)
      const statusBadge = (oldRaw: any, newRaw: any) => {
        const oldStr = String(oldRaw ?? '').trim();
        const newStr = String(newRaw ?? '').trim();
        const oldEmpty = oldStr === '' || oldStr === '0' || oldStr === 'null';
        const newEmpty = newStr === '' || newStr === 'null';
        if (newEmpty && !oldEmpty) {
          return `<span style="color:#6b7280;font-weight:700"><i class="fas fa-minus"></i> ลบ</span>`;
        }
        if (oldEmpty && !newEmpty) {
          return `<span style="color:#16a34a;font-weight:700"><i class="fas fa-plus-circle"></i> เพิ่ม</span>`;
        }
        const oldNum = parseFloat(oldStr);
        const newNum = parseFloat(newStr);
        if (!isNaN(oldNum) && !isNaN(newNum)) {
          if (newNum > oldNum) return `<span style="color:#16a34a;font-weight:700"><i class="fas fa-arrow-up"></i> เพิ่มขึ้น</span>`;
          if (newNum < oldNum) return `<span style="color:#dc2626;font-weight:700"><i class="fas fa-arrow-down"></i> ลดลง</span>`;
          return `<span style="color:#6b7280"><i class="fas fa-equals"></i></span>`;
        }
        return `<span style="color:#d97706;font-weight:700"><i class="fas fa-pen"></i> แก้ไข</span>`;
      };
      const fmt = (v: any) => {
        const s = String(v ?? '').trim();
        if (s === '' || s === 'null') return '<span style="color:#9ca3af">—</span>';
        return s;
      };

      // สร้างแถวตารางสรุปการแก้ไข
      const rows: string[] = [];
      for (const item of changedItems) {
        const kpiName = item.kpi_indicators_name || '';
        // target_value
        if (String(item.target_value ?? '') !== String(item._original.target_value ?? '')) {
          rows.push(`<tr>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${kpiName}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#4f46e5;font-weight:700">เป้าหมาย</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${fmt(item._original.target_value)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${fmt(item.target_value)}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${statusBadge(item._original.target_value, item.target_value)}</td>
          </tr>`);
        }
        // ค่าฐาน/ค่าเพิ่มเติมของสูตร (cv_<key>)
        for (const v of this.customVarDefs(item)) {
          if (!this.isCustomFieldChanged(item, v.key)) continue;
          const f = 'cv_' + v.key;
          rows.push(`<tr>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${kpiName}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#0369a1;font-weight:700">${v.label}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${fmt(item._original[f])}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${fmt(item[f])}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${statusBadge(item._original[f], item[f])}</td>
          </tr>`);
        }
        // monthly values
        for (const m of months) {
          if (String(item[m] ?? '') !== String(item._original[m] ?? '')) {
            rows.push(`<tr>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${kpiName}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${monthNames[m]}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${fmt(item._original[m])}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${fmt(item[m])}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${statusBadge(item._original[m], item[m])}</td>
            </tr>`);
          }
        }
      }
      for (const c of hierChanges) {
        const label = `${this.escHtml(c.row.no)} ${this.escHtml(c.row.name)}${c.item.hosname ? ' (' + this.escHtml(c.item.hosname) + ')' : ''}`;
        rows.push(`<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;color:#4338ca">${c.row.kind === 'activity' ? '↳ ' : '▸ '}${label}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${monthNames[c.m]}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${fmt(this.hierDisplay(c.row, c.oldVal))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${fmt(this.hierDisplay(c.row, c.newVal))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${c.row.valueType === 'check' ? '' : statusBadge(c.oldVal, c.newVal)}</td>
        </tr>`);
      }

      const summaryTable = `
        <div style="max-height:280px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:10px">
          <table style="width:100%;border-collapse:collapse;font-size:12px;background:white">
            <thead style="position:sticky;top:0;background:#f3f4f6;z-index:1">
              <tr>
                <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">รายการ</th>
                <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">เดือน</th>
                <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">ค่าเดิม</th>
                <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">ค่าใหม่</th>
                <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">สถานะ</th>
              </tr>
            </thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </div>`;

      // Clean data - ส่งเฉพาะ fields ที่ backend ต้องการ ไม่ส่ง _original
      const cleanData = changedItems.map(item => ({
        indicator_id: item.indicator_id,
        year_bh: item.year_bh,
        hospcode: item.hospcode,
        target_value: item.target_value,
        oct: item.oct, nov: item.nov, dece: item.dece,
        jan: item.jan, feb: item.feb, mar: item.mar,
        apr: item.apr, may: item.may, jun: item.jun,
        jul: item.jul, aug: item.aug, sep: item.sep,
        // ค่าฐาน/ค่าเพิ่มเติม — ส่งเฉพาะช่องที่แก้ (ไม่ส่ง = backend ไม่เปลี่ยนค่าเดิม)
        ...this.customPayload(item)
      }));

      // ตรวจสอบว่ามีรายการที่สถานะ "รอตอบกลับ" (Resubmit) หรือไม่
      const resubmitItems = changedItems.filter(item =>
        item.indicator_status === 'resubmit' || item.indicator_status === 'Resubmit'
      );
      const hasResubmitItems = resubmitItems.length > 0 && !this.isAdmin;

      // สร้าง HTML สำหรับส่วนตอบกลับ (ถ้ามีรายการ Resubmit)
      const replySection = hasResubmitItems
        ? `<div class="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
             <div class="flex items-center gap-2 mb-2">
               <input type="checkbox" id="swal-reply-check" checked style="accent-color:#3b82f6;width:16px;height:16px;">
               <label for="swal-reply-check" class="font-bold text-blue-700 text-sm cursor-pointer">
                 <i class="fas fa-reply mr-1"></i>นำข้อมูลที่แก้ไขไปตอบกลับด้วย (${resubmitItems.length} รายการ)
               </label>
             </div>
             <div id="swal-reply-area">
               <textarea id="swal-reply-message" rows="3" placeholder="ข้อความตอบกลับ (ไม่บังคับ)..."
                 style="width:100%;padding:8px;border:1px solid #93c5fd;border-radius:8px;font-size:13px;margin-top:4px;"></textarea>
             </div>
           </div>`
        : '';

      // ค่าที่อาจผิดปกติ (เตือนเท่านั้น — ผู้ใช้ยืนยันบันทึกได้)
      const anomalies = this.anomalyList.filter(a => changedItems.includes(a.item));
      const escA = (v: any) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
      const anomalySection = anomalies.length === 0 ? '' : `
        <div id="swal-anomaly-box" style="margin-bottom:10px;padding:10px 12px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px">
          <div style="font-weight:700;color:#b91c1c;margin-bottom:4px"><i class="fas fa-exclamation-triangle"></i> พบค่าที่อาจผิดปกติ ${anomalies.length} ช่อง — กรุณาตรวจสอบก่อนบันทึก</div>
          <ul style="list-style:disc;margin-left:18px;font-size:12px;color:#7f1d1d;max-height:110px;overflow-y:auto">
            ${anomalies.slice(0, 20).map(a => `<li><b>${escA(a.item.kpi_indicators_name)}</b>${a.item.hosname ? ' (' + escA(a.item.hosname) + ')' : ''} ${a.monthName} = <b>${escA(a.value)}</b> : ${escA(a.message)}</li>`).join('')}
            ${anomalies.length > 20 ? `<li>… และอีก ${anomalies.length - 20} ช่อง</li>` : ''}
          </ul>
        </div>`;

      Swal.fire({
        title: 'ยืนยันการบันทึก',
        html: `<div style="text-align:left;font-size:13px">
                ${anomalySection}
                <p style="margin-bottom:8px;font-weight:700;color:#374151">
                  พบการเปลี่ยนแปลง <span style="color:#4f46e5">${rows.length}</span> รายการ จาก ${new Set([
                    ...cleanData.map(d => `${d.indicator_id}|${d.hospcode}|${d.year_bh}`),
                    ...hierChanges.map(c => c.key),
                  ]).size} ตัวชี้วัด
                </p>
                ${summaryTable}
                ${replySection}
                <p style="margin-top:12px;color:#6b7280">ต้องการบันทึกใช่หรือไม่?</p>
               </div>`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        confirmButtonText: 'บันทึก',
        cancelButtonText: 'ยกเลิก',
        width: 780,
        didOpen: () => {
          const checkbox = document.getElementById('swal-reply-check') as HTMLInputElement;
          const replyArea = document.getElementById('swal-reply-area');
          if (checkbox && replyArea) {
            checkbox.addEventListener('change', () => {
              replyArea.style.display = checkbox.checked ? 'block' : 'none';
            });
          }
        },
        preConfirm: () => {
          if (hasResubmitItems) {
            const checkbox = document.getElementById('swal-reply-check') as HTMLInputElement;
            const replyMsg = (document.getElementById('swal-reply-message') as HTMLTextAreaElement)?.value || '';
            return { wantReply: checkbox?.checked || false, replyMessage: replyMsg.trim() };
          }
          return { wantReply: false, replyMessage: '' };
        }
      }).then((result) => {
        if (result.isConfirmed) {
          const replyInfo = result.value;
          const runMain = () => {
            if (replyInfo && replyInfo.wantReply) {
              this.saveDataWithReply(cleanData, resubmitItems, replyInfo.replyMessage);
            } else {
              if (hasResubmitItems) {
                const resubmitIds = new Set(resubmitItems.map(r => `${r.indicator_id}_${r.year_bh}_${r.hospcode}`));
                cleanData.forEach((item: any) => {
                  const key = `${item.indicator_id}_${item.year_bh}_${item.hospcode}`;
                  if (resubmitIds.has(key)) {
                    item.preserve_status = 'Resubmit';
                  }
                });
              }
              this.saveDataToBackend(cleanData, false);
            }
          };
          if (hierChanges.length === 0) { runMain(); return; }
          // บันทึกแถวลูกก่อน (ตรวจล็อค/สิทธิ์ที่ backend) แล้วค่อยบันทึกแถวหลักตามเดิม
          Swal.fire({ title: 'กำลังบันทึกข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
          this.saveHierChanges(hierChanges).then(ok => {
            if (!ok) return;
            if (cleanData.length > 0) { runMain(); return; }
            Swal.fire('สำเร็จ', 'บันทึกผลงานตัวชี้วัดย่อย/กิจกรรมเรียบร้อยแล้ว', 'success');
            this.isEditing = false;
            this.authService.setFocusMode(this.isDeleteMode);
            this.reloadExpandedHier();
            this.loadKpiData(true);
          });
        }
      });
    };

    if (decreasedList.length > 0) {
      Swal.fire({
        icon: 'warning',
        title: 'พบคะแนนที่น้อยกว่าเดิม',
        html: `<div class="text-left text-sm max-h-60 overflow-y-auto">
                <p class="mb-2 text-gray-600">กรุณาตรวจสอบรายการต่อไปนี้:</p>
                <ul class="list-disc pl-5 space-y-1 text-red-600">${decreasedList.map(d => `<li>${d}</li>`).join('')}</ul>
               </div>`,
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        confirmButtonText: 'ยืนยัน บันทึก',
        cancelButtonColor: '#6b7280',
        cancelButtonText: 'ยกเลิก กลับไปตรวจสอบ'
      }).then((result) => {
        if (result.isConfirmed) {
          proceedToSave();
        }
      });
    } else {
      proceedToSave();
    }
  }

  saveDataWithReply(data: any[], resubmitItems: any[], replyMessage: string) {
    Swal.fire({
      title: 'กำลังบันทึกข้อมูลและตอบกลับ...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    // บันทึกข้อมูลก่อน
    this.authService.updateKpiResults(data).subscribe({
      next: (res) => {
        // หลังบันทึกสำเร็จ → ส่งตอบกลับทีละรายการ
        const replyMsg = replyMessage || 'แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว';
        const replyObservables = resubmitItems.map(item => {
          const replyData = {
            indicator_id: item.indicator_id,
            year_bh: item.year_bh,
            hospcode: item.hospcode,
            message: replyMsg
          };
          return this.authService.replyKpi(replyData);
        });

        if (replyObservables.length === 0) {
          this.toast.success('บันทึกข้อมูลเรียบร้อยแล้ว');
          this.isEditing = false;
          this.authService.setFocusMode(this.isDeleteMode);
          this.loadKpiData();
          this.loadDashboardStats();
          return;
        }

        // ส่งตอบกลับทั้งหมด
        let completed = 0;
        let hasError = false;
        for (const obs of replyObservables) {
          obs.subscribe({
            next: () => {
              completed++;
              if (completed === replyObservables.length && !hasError) {
                this.toast.success(`บันทึกข้อมูลและตอบกลับเรียบร้อยแล้ว (${resubmitItems.length} รายการ)`);
                this.isEditing = false;
                this.authService.setFocusMode(this.isDeleteMode);
                this.loadKpiData();
                this.loadDashboardStats();
              }
            },
            error: (err: any) => {
              hasError = true;
              console.error('Reply error:', err);
              Swal.fire('แจ้งเตือน', 'บันทึกข้อมูลสำเร็จ แต่การตอบกลับบางรายการผิดพลาด', 'warning');
              this.isEditing = false;
              this.loadKpiData();
              this.loadDashboardStats();
            }
          });
        }
      },
      error: (err) => {
        Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถบันทึกข้อมูลได้', 'error');
        console.error(err);
      }
    });
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
        this.reloadExpandedHier();
        this.authService.setFocusMode(this.isDeleteMode);
        this.showAddModal = false;
        this.loadKpiData();
        this.loadDashboardStats();
      },
      error: (err) => {
        Swal.fire('เกิดข้อผิดพลาด', err.error?.message || 'ไม่สามารถบันทึกข้อมูลได้', 'error');
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
              this.toast.success('รับรองและล็อคข้อมูลเรียบร้อยแล้ว');
              this.loadKpiData();
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
            this.toast.success('อนุมัติข้อมูลเรียบร้อยแล้ว');
            this.selectedStatus = '';
            this.loadKpiData();
            this.loadDashboardStats();
          },
          error: (err) => Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถอนุมัติข้อมูลได้', 'error')
        });
      }
    });
  }

  // === Review Mode — เลือกรายการแล้วอนุมัติ/ตีกลับ ===
  toggleReviewMode() {
    this.isReviewMode = !this.isReviewMode;
    if (!this.isReviewMode) this.reviewSelected.clear();
    if (this.isReviewMode) { this.isDeleteMode = false; this.deleteSelected.clear(); }
  }

  reviewKey(item: any): string {
    return `${item.indicator_id}_${item.year_bh}_${item.hospcode}`;
  }

  // === Delete Mode ===
  toggleDeleteMode() {
    this.isDeleteMode = !this.isDeleteMode;
    if (!this.isDeleteMode) this.deleteSelected.clear();
    if (this.isDeleteMode) { this.isReviewMode = false; this.reviewSelected.clear(); }
    this.authService.setFocusMode(this.isDeleteMode || this.isEditing);
  }

  toggleDeleteItem(item: any) {
    const key = this.reviewKey(item);
    this.deleteSelected.has(key) ? this.deleteSelected.delete(key) : this.deleteSelected.add(key);
  }

  toggleDeleteAll() {
    if (this.deleteSelected.size === this.filteredData.length) this.deleteSelected.clear();
    else this.filteredData.forEach(i => this.deleteSelected.add(this.reviewKey(i)));
  }

  get deleteAllChecked(): boolean {
    return this.filteredData.length > 0 && this.deleteSelected.size === this.filteredData.length;
  }

  isDeleteSelected(item: any): boolean {
    return this.deleteSelected.has(this.reviewKey(item));
  }

  confirmBulkDelete() {
    const items = this.filteredData.filter(i => this.deleteSelected.has(this.reviewKey(i)));
    if (items.length === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกรายการที่จะลบ', 'warning');
      return;
    }
    // สรุปรายการที่จะลบ
    const summaryHtml = items.slice(0, 20).map(i =>
      `<li class="text-xs text-gray-600"><b>${i.kpi_indicators_name}</b> — ${i.hosname || i.hospcode} (ปี ${i.year_bh})</li>`
    ).join('');
    const moreText = items.length > 20 ? `<p class="text-xs text-gray-400 mt-1">... และอีก ${items.length - 20} รายการ</p>` : '';

    Swal.fire({
      title: 'ยืนยันการลบข้อมูล',
      html: `<div class="text-left">
        <div class="bg-red-50 border-l-4 border-red-500 p-3 mb-3 rounded">
          <p class="text-sm text-red-700 font-bold"><i class="fas fa-exclamation-triangle mr-1"></i>คำเตือน</p>
          <ul class="text-xs text-red-600 mt-1 list-disc ml-5 space-y-0.5">
            <li>ข้อมูลใน <b>kpi_results</b> ของรายการที่เลือกจะถูกลบ (ผลงานรายเดือน + เป้าหมาย)</li>
            <li>ข้อมูลใน <b>kpi_sub_results</b> ที่เกี่ยวข้องจะถูกลบด้วย</li>
            <li>ข้อมูลใน <b>kpi_summary</b> ของ cell นั้นจะถูกลบ</li>
            <li class="font-bold">การลบนี้ไม่สามารถกู้คืนได้</li>
          </ul>
        </div>
        <p class="text-sm font-bold text-gray-700 mb-1">รายการที่จะลบ (${items.length} รายการ):</p>
        <ul class="max-h-48 overflow-y-auto border border-gray-200 rounded p-2 bg-gray-50 list-disc ml-5 space-y-0.5">
          ${summaryHtml}
        </ul>
        ${moreText}
      </div>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: `<i class="fas fa-trash mr-1"></i> ยืนยันลบ ${items.length} รายการ`,
      cancelButtonText: 'ยกเลิก',
      width: '600px'
    }).then(r => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังลบ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      const payload = items.map(i => ({
        indicator_id: Number(i.indicator_id),
        year_bh: String(i.year_bh),
        hospcode: String(i.hospcode)
      }));
      this.authService.bulkDeleteKpiResults(payload).subscribe({
        next: (res: any) => {
          Swal.fire({
            icon: 'success', title: 'ลบสำเร็จ',
            html: `<p class="text-sm">${res.message}</p>`,
            timer: 3000
          });
          this.isDeleteMode = false;
          this.deleteSelected.clear();
          this.loadKpiData();
        },
        error: (e: any) => Swal.fire('ผิดพลาด', e.error?.message || 'ลบไม่สำเร็จ', 'error')
      });
    });
  }

  toggleReviewItem(item: any) {
    const key = this.reviewKey(item);
    this.reviewSelected.has(key) ? this.reviewSelected.delete(key) : this.reviewSelected.add(key);
  }

  toggleReviewAll() {
    const pending = this.filteredData.filter(i => i.pending_count > 0);
    if (this.reviewSelected.size === pending.length) {
      this.reviewSelected.clear();
    } else {
      pending.forEach(i => this.reviewSelected.add(this.reviewKey(i)));
    }
  }

  get reviewAllChecked(): boolean {
    const pending = this.filteredData.filter(i => i.pending_count > 0);
    return pending.length > 0 && this.reviewSelected.size === pending.length;
  }

  approveSelected() {
    if (this.reviewSelected.size === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกรายการอย่างน้อย 1 รายการ', 'warning'); return; }
    const items = this.filteredData.filter(i => this.reviewSelected.has(this.reviewKey(i)));
    Swal.fire({
      title: 'ยืนยันการตรวจสอบ',
      html: `<p class="text-sm">อนุมัติ <b>${items.length}</b> รายการที่เลือก?</p>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#16a34a',
      confirmButtonText: '<i class="fas fa-check-double mr-1"></i> อนุมัติที่เลือก', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        Swal.fire({ title: 'กำลังอนุมัติ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const approvals = items.map(i => ({ indicator_id: i.indicator_id, year_bh: i.year_bh, hospcode: i.hospcode }));
        this.authService.approveKpiResults(approvals).subscribe({
          next: () => {
            Swal.fire({ icon: 'success', title: 'อนุมัติสำเร็จ', text: `อนุมัติ ${items.length} รายการเรียบร้อย`, timer: 2000, showConfirmButton: false });
            this.isReviewMode = false; this.reviewSelected.clear();
            this.loadKpiData(); this.loadDashboardStats();
          },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถอนุมัติได้', 'error')
        });
      }
    });
  }

  rejectSelected() {
    if (this.reviewSelected.size === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกรายการอย่างน้อย 1 รายการ', 'warning'); return; }
    const items = this.filteredData.filter(i => this.reviewSelected.has(this.reviewKey(i)));
    Swal.fire({
      title: 'ตีกลับรายการที่เลือก',
      html: `<p class="text-sm">ตีกลับ <b>${items.length}</b> รายการ?</p>`,
      input: 'textarea', inputLabel: 'เหตุผล (ไม่บังคับ)', inputPlaceholder: 'ระบุเหตุผลในการตีกลับ...',
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-undo-alt mr-1"></i> ตีกลับที่เลือก', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        Swal.fire({ title: 'กำลังตีกลับ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        const rejections = items.map(i => ({ indicator_id: i.indicator_id, year_bh: i.year_bh, hospcode: i.hospcode, comment: r.value || '' }));
        this.authService.rejectKpiResults(rejections).subscribe({
          next: () => {
            Swal.fire({ icon: 'success', title: 'ตีกลับสำเร็จ', text: `ตีกลับ ${items.length} รายการเรียบร้อย`, timer: 2000, showConfirmButton: false });
            this.isReviewMode = false; this.reviewSelected.clear();
            this.loadKpiData(); this.loadDashboardStats();
          },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถตีกลับได้', 'error')
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
              this.toast.success('ปลดล็อคข้อมูลเรียบร้อยแล้ว');
              this.loadKpiData();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
        });
      }
    });
  }

  bulkAddAllKpi() {
    this.calculateAddKpiYears();
    // Step 1: เลือกปี
    Swal.fire({
      title: 'เพิ่ม KPI ทุกหน่วยบริการ',
      html: '<p class="text-sm text-gray-600">เลือกปีงบประมาณ แล้วระบบจะตรวจสอบข้อมูลก่อน</p>',
      input: 'select',
      inputOptions: this.addKpiYears.reduce((acc: any, y: string) => { acc[y] = y; return acc; }, {}),
      inputValue: this.selectedYear || this.addKpiYears[0],
      showCancelButton: true, confirmButtonColor: '#4f46e5',
      confirmButtonText: '<i class="fas fa-search mr-1"></i> ตรวจสอบ', cancelButtonText: 'ยกเลิก'
    }).then(r1 => {
      if (!r1.isConfirmed) return;
      const year = r1.value;
      // Step 2: Preview
      Swal.fire({ title: 'กำลังตรวจสอบ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.bulkAddKpiPreview(year).subscribe({
        next: (p: any) => {
          Swal.fire({
            title: 'สรุปก่อนเพิ่ม KPI',
            html: `<div class="text-left text-sm space-y-2">
              <div class="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <table class="w-full text-xs">
                  <tr><td class="py-1 text-gray-600">ปีงบประมาณ</td><td class="font-bold">${p.year_bh}</td></tr>
                  <tr><td class="py-1 text-gray-600">ตัวชี้วัด (active)</td><td class="font-bold">${p.indicatorCount} รายการ</td></tr>
                  <tr><td class="py-1 text-gray-600">หน่วยบริการ (รพ./สสอ./รพ.สต.)</td><td class="font-bold">${p.hospitalCount} แห่ง</td></tr>
                  <tr><td class="py-1 text-gray-600">ชุดที่เป็นไปได้ทั้งหมด</td><td class="font-bold">${p.totalPossible.toLocaleString()}</td></tr>
                  <tr><td class="py-1 text-gray-600">มีอยู่แล้ว</td><td class="font-bold text-gray-500">${p.existingCount.toLocaleString()}</td></tr>
                  <tr class="border-t"><td class="py-1 text-green-700 font-bold">ต้องเพิ่มใหม่</td><td class="font-bold text-green-700">${p.toAdd.toLocaleString()} ชุด (${(p.toAdd * 12).toLocaleString()} records)</td></tr>
                </table>
              </div>
              ${p.toAdd === 0 ? '<p class="text-green-600 text-xs"><i class="fas fa-check-circle mr-1"></i>มีข้อมูลครบทุกชุดแล้ว ไม่ต้องเพิ่ม</p>' : '<p class="text-xs text-amber-600"><i class="fas fa-info-circle mr-1"></i>เพิ่มเฉพาะที่ยังไม่มี ข้อมูลเดิมจะไม่ถูกแก้ไข</p>'}
            </div>`,
            icon: p.toAdd > 0 ? 'question' : 'success',
            showCancelButton: p.toAdd > 0, confirmButtonColor: p.toAdd > 0 ? '#4f46e5' : '#10b981',
            confirmButtonText: p.toAdd > 0 ? `<i class="fas fa-layer-group mr-1"></i> เพิ่ม ${p.toAdd.toLocaleString()} ชุด` : 'ตกลง',
            cancelButtonText: 'ยกเลิก'
          }).then(r2 => {
            if (r2.isConfirmed && p.toAdd > 0) {
              Swal.fire({ title: 'กำลังเพิ่มข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
              this.authService.bulkAddKpi(year).subscribe({
                next: (res: any) => {
                  Swal.fire({ icon: 'success', title: 'เพิ่มสำเร็จ',
                    html: `เพิ่มใหม่ <b>${res.inserted}</b> ชุด (${res.totalRecords} records)<br>ข้าม <b>${res.skipped}</b> ชุดที่มีอยู่แล้ว`,
                    confirmButtonColor: '#10b981' });
                  this.loadKpiData();
                },
                error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเพิ่มได้', 'error')
              });
            }
          });
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถตรวจสอบได้', 'error')
      });
    });
  }

  unlockAll() {
    if (!this.selectedYear) this.setDefaultYear();
    Swal.fire({
      title: 'ปลดล็อคทั้งหมด',
      html: `<p class="text-sm">ปลดล็อคข้อมูลทั้งหมดในปี <b>${this.selectedYear}</b> เพื่อให้หน่วยงานแก้ไขได้?</p>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#f59e0b',
      confirmButtonText: '<i class="fas fa-lock-open mr-1"></i> ปลดล็อคทั้งหมด', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        Swal.fire({ title: 'กำลังปลดล็อค...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.unlockAllKpi(this.selectedYear).subscribe({
          next: (res: any) => {
            Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, confirmButtonColor: '#10b981' });
            this.loadKpiData();
          },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปลดล็อคได้', 'error')
        });
      }
    });
  }

  openAddModal() {
    this._addKpiTemplate = null;
    this.newKpiList = [];
    this.addKpiSelectedIds = new Set<number>();
    this.addKpiSelMains = [];
    this.addKpiSearch = '';
    this.addKpiShowMonths = false;
    this._addKpiDefaultAll = !(this.isAdmin || this.isLocalAdmin);
    this.calculateAddKpiYears();
    if (this.addKpiYears.includes(this.selectedYear)) {
      this.addKpiSelectedYear = this.selectedYear;
    } else {
      this.addKpiSelectedYear = this.addKpiYears[0];
    }
    if (this.isAdmin || this.isLocalAdmin) {
      this.addKpiSelDistricts = [];
      this.addKpiSelDepts = [];
      this.addKpiOpenDropdown = '';
      this.loadAddKpiDistrictsAndHospitals();
    } else {
      // user ทั่วไป — ปลายทางคือหน่วยบริการตัวเอง
      this.addKpiHospitalList = this.currentUser?.hospcode ? [{ hoscode: this.currentUser.hospcode, hosname: this.currentUser.service_unit || this.currentUser.hospcode, hostype: '' }] : [];
      this.loadAddKpiList();
    }
  }

  loadAddKpiDistrictsAndHospitals() {
    Swal.fire({ title: 'กำลังโหลดข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    // โหลด 3 รายการพร้อมกัน: อำเภอ, หน่วยบริการ, หน่วยงาน
    this.authService.getDistricts().subscribe({
      next: (distRes) => {
        if (distRes.success) this.addKpiDistrictList = distRes.data;
        this.authService.getHospitals().subscribe({
          next: (hosRes) => {
            if (hosRes.success) this.addKpiHospitalList = hosRes.data;
            this.authService.getDepartments().subscribe({
              next: (deptRes) => {
                Swal.close();
                if (deptRes.success) this.addKpiDeptList = deptRes.data;

                // Local admin: จำกัดขอบเขตหน่วยบริการ (backend ตรวจซ้ำที่ /update-kpi)
                if (this.isLocalAdmin && this.currentUser?.hospcode) {
                  const myHos = this.addKpiHospitalList.find((h: any) => h.hoscode === this.currentUser.hospcode);
                  if (this.isAdminCup && myHos?.distid) {
                    // admin_cup: ทุกหน่วยบริการในอำเภอตัวเอง
                    this.addKpiSelDistricts = [myHos.distid];
                    this.addKpiDistrictList = this.addKpiDistrictList.filter((d: any) => d.distid === myHos.distid);
                    this.addKpiHospitalList = this.addKpiHospitalList.filter((h: any) => h.distid === myHos.distid);
                  } else {
                    // admin_hos / admin_sso: หน่วยบริการตัวเองเท่านั้น
                    this.addKpiHospitalList = this.addKpiHospitalList.filter((h: any) => h.hoscode === this.currentUser.hospcode);
                    if (myHos?.distid) {
                      this.addKpiSelDistricts = [myHos.distid];
                      this.addKpiDistrictList = this.addKpiDistrictList.filter((d: any) => d.distid === myHos.distid);
                    }
                  }
                }

                setTimeout(() => {
                  this.showAddModal = true;
                  this.newKpiList = [];
                  this.loadAddKpiList();
                  this.cdr.detectChanges();
                }, 150);
              },
              error: () => { Swal.close(); Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลหน่วยงานได้', 'error'); }
            });
          },
          error: () => { Swal.close(); Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลหน่วยบริการได้', 'error'); }
        });
      },
      error: () => { Swal.close(); Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลอำเภอได้', 'error'); }
    });
  }

  // === Modal dropdown helpers (multi-select เหมือนหน้า dashboard) ===
  toggleAddKpiDropdown(name: string) {
    this.addKpiOpenDropdown = this.addKpiOpenDropdown === name ? '' : name;
  }
  // toggle 1 รายการใน array
  toggleAddKpiFilter(arr: string[], value: string) {
    const i = arr.indexOf(value);
    if (i >= 0) arr.splice(i, 1); else arr.push(value);
  }
  isAddKpiFilterSel(arr: string[], value: string): boolean {
    return arr.includes(value);
  }
  clearAddKpiArr(arr: string[]) { arr.splice(0, arr.length); }

  // อำเภอ: map distid → distname
  addKpiDistrictLabel(): string {
    if (this.addKpiSelDistricts.length === 0) return 'อำเภอ: ทั้งหมด';
    if (this.addKpiSelDistricts.length === 1) {
      const d = this.addKpiDistrictList.find((x: any) => x.distid === this.addKpiSelDistricts[0]);
      return d?.distname || this.addKpiSelDistricts[0];
    }
    return `อำเภอ: ${this.addKpiSelDistricts.length} อำเภอ`;
  }
  // หน่วยงาน: map id → dept_name
  addKpiDeptLabel(): string {
    if (this.addKpiSelDepts.length === 0) return 'หน่วยงาน: ทั้งหมด';
    if (this.addKpiSelDepts.length === 1) {
      const d = this.addKpiDeptList.find((x: any) => String(x.id) === this.addKpiSelDepts[0]);
      return d?.dept_name || this.addKpiSelDepts[0];
    }
    return `หน่วยงาน: ${this.addKpiSelDepts.length} หน่วยงาน`;
  }

  // เลือกทั้งหมด — หน่วยงาน
  toggleAllAddKpiDepts() {
    const allSel = this.addKpiDeptList.length > 0 && this.addKpiDeptList.every((d: any) => this.addKpiSelDepts.includes(String(d.id)));
    if (allSel) this.addKpiSelDepts = [];
    else this.addKpiSelDepts = this.addKpiDeptList.map((d: any) => String(d.id));
    this.loadAddKpiList();
  }
  isAllAddKpiDepts(): boolean {
    return this.addKpiDeptList.length > 0 && this.addKpiDeptList.every((d: any) => this.addKpiSelDepts.includes(String(d.id)));
  }

  // === Cascade handlers ===
  onAddKpiDistrictChange() {
    this.loadAddKpiList();
  }
  onAddKpiDeptChange() {
    this.loadAddKpiList();
  }

  // ---- เพิ่มตัวชี้วัดให้หน่วยบริการ (19 ต.ค. 2569): ไม่ต้องเลือกหน่วยบริการ — ระบบหาปลายทางเองจาก "ประเภทหน่วยบริการ" ที่ตั้งไว้ในตัวชี้วัด
  //      (shared/indicator-scope.ts resolveAddKpiTargets) ตัวชี้วัดที่ยังไม่ได้ตั้งประเภท = เลือกไม่ได้ ต้องไปตั้งค่าที่หน้าจัดการตัวชี้วัดก่อน
  addKpiSearch = '';
  addKpiShowMonths = false;          // ซ่อนช่องผลงาน 12 เดือนเป็นค่าเริ่มต้น (ส่วนใหญ่เพิ่มตัวชี้วัดก่อน แล้วบันทึกผลงานทีหลัง)
  addKpiUnsetCount = 0;              // ตัวชี้วัดที่ยังไม่ได้ตั้งประเภทหน่วยบริการ
  addKpiNoTargetCount = 0;           // ตั้งประเภทแล้วแต่ไม่มีหน่วยบริการประเภทนั้นในขอบเขต/อำเภอที่เลือก
  private _addKpiTemplate: any[] | null = null;
  private _addKpiDefaultAll = false; // ผู้ใช้ทั่วไป (หน่วยบริการเดียว): เลือกทุกตัวที่เพิ่มได้ให้ตอนเปิดครั้งแรก
  private static readonly ADD_KPI_UNITS_PER_REQUEST = 30;

  get addKpiAllHosTypes(): any[] {
    return (this._allHosTypes && this._allHosTypes.length) ? this._allHosTypes : (this.hosTypeList || []);
  }
  get addKpiSelectedItems(): any[] {
    return this.newKpiList.filter((i: any) => this.addKpiSelectedIds.has(Number(i.indicator_id)));
  }
  /** ขอบเขตเป็นหน่วยบริการเดียวของผู้ใช้เอง (ผู้ใช้ทั่วไป / admin_hos / admin_sso) */
  get addKpiSingleUnit(): boolean {
    return !(this.isAdmin || this.isLocalAdmin) || (this.isLocalAdmin && !this.isAdminCup);
  }
  /** เพิ่มให้หน่วยบริการได้หรือไม่ (ตั้งประเภทแล้ว + มีหน่วยบริการปลายทางอย่างน้อย 1 แห่ง) */
  isAddKpiSelectable(item: any): boolean {
    return item?._setting !== 'unset' && (item?._targets?.length || 0) > 0;
  }
  /** จำนวนคู่ (ตัวชี้วัด × หน่วยบริการ) และหน่วยบริการ (ไม่ซ้ำ) ที่จะเพิ่ม */
  get addKpiPairCount(): number {
    return this.addKpiSelectedItems.reduce((n: number, i: any) => n + (i._targets?.length || 0), 0);
  }
  get addKpiUnitCount(): number {
    return new Set(this.addKpiSelectedItems.flatMap((i: any) => i._targets || [])).size;
  }
  addKpiTargetTitle(item: any): string {
    const names = (item._targets || []).slice(0, 15).map((hc: string) => this.addKpiHospitalList.find((h: any) => String(h.hoscode) === hc)?.hosname || hc);
    const more = (item._targets?.length || 0) - names.length;
    return names.join(', ') + (more > 0 ? ` และอีก ${more} แห่ง` : '');
  }
  addKpiTypeNames(codes: string[] | null): string {
    return (codes || []).map(c => this.addKpiAllHosTypes.find((ht: any) => String(ht.hostypecode) === c)?.hostypename || HOSTYPE_NAMES[c] || c).join(', ');
  }
  /** ประเภทของหน่วยบริการปลายทางจริงของแถวนี้ (ไม่แสดงประเภทที่ไม่มีในขอบเขต เช่น รพ.ศูนย์ สำหรับ admin_cup) */
  addKpiTargetTypeNames(item: any): string {
    const types = new Set<string>((item._targets || []).map((hc: string) => String(this.addKpiHospitalList.find((h: any) => String(h.hoscode) === hc)?.hostype || '')));
    return this.addKpiTypeNames((item._autoTypes || []).filter((t: string) => types.has(t)));
  }
  /** ไปตั้งค่าประเภทหน่วยบริการของตัวชี้วัด — เฉพาะผู้ที่แก้ไขตัวชี้วัดได้ */
  get canSetupIndicatorType(): boolean {
    return this.authService.canAccessPage('kpi-manage') && this.authService.canPerformAction('kpi-manage', 'edit');
  }
  goSetupIndicatorType(item: any) {
    this.closeAddModal();
    this.router.navigate(['/kpi-manage'], { queryParams: { editIndicator: item.indicator_id } });
  }

  calculateAddKpiYears() {
    const currentThaiYear = getCurrentFiscalYear();
    this.addKpiYears = [];
    for (let i = 0; i < 4; i++) {
      this.addKpiYears.push((currentThaiYear + i).toString());
    }
  }

  loadAddKpiList() {
    if (this._addKpiTemplate) {
      this.buildAddKpiList(this._addKpiTemplate);
      this.showAddModal = true;
      this.cdr.detectChanges();
      return;
    }
    Swal.fire({
      title: 'กำลังโหลดข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });
    this.authService.getKpiTemplate().subscribe({
      next: (res) => {
        if (res.success) {
          this._addKpiTemplate = res.data || [];
          this.buildAddKpiList(this._addKpiTemplate!);
          Swal.close();
          if (!this.showAddModal) {
            setTimeout(() => {
              this.showAddModal = true;
              this.cdr.detectChanges();
            }, 150);
          } else {
            this.cdr.detectChanges();
          }
        } else {
          Swal.close();
        }
      },
      error: () => {
        Swal.close();
        Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลตัวชี้วัดได้', 'error');
      }
    });
  }

  // สร้างรายการตัวชี้วัดจากแม่แบบ + ตัวกรองปัจจุบัน — คงค่าที่กรอกไว้/รายการที่ติ๊กไว้เดิม และคำนวณหน่วยบริการปลายทางของแต่ละตัว
  private buildAddKpiList(template: any[]) {
    const adminMode = this.isAdmin || this.isLocalAdmin;
    const single = this.addKpiSingleUnit;
    const singleHc = single ? String(this.addKpiHospitalList[0]?.hoscode || this.currentUser?.hospcode || '') : '';

    // กรองตัวชี้วัดตามหน่วยงาน (multi-select)
    let allForDept = template;
    if (adminMode) {
      if (this.addKpiSelDepts.length > 0) {
        allForDept = allForDept.filter((item: any) => this.addKpiSelDepts.includes(String(item.dept_id)));
      }
    } else if (this.currentUser?.dept_name) {
      // user ทั่วไป → กรองตาม dept ตัวเอง
      allForDept = allForDept.filter((item: any) => item.dept_name === this.currentUser.dept_name);
    }
    this.addKpiTotalTemplateCount = allForDept.length;

    // หน่วยบริการเดียว → ซ่อนตัวที่หน่วยบริการนี้มีอยู่แล้วในปีงบนั้น (หลายแห่ง → backend ข้ามคู่ที่มีอยู่แล้วและสรุปผลให้)
    let available = allForDept;
    if (single && singleHc) {
      const existingIds = new Set(this.kpiData
        .filter(k => String(k.year_bh) === String(this.addKpiSelectedYear) && (!adminMode || String(k.hospcode) === singleHc))
        .map(k => Number(k.indicator_id)));
      available = allForDept.filter((item: any) => !existingIds.has(Number(item.indicator_id)));
    }
    this.addKpiExistingCount = allForDept.length - available.length;

    const opts = { districts: single ? [] : this.addKpiSelDistricts, singleUnit: single };
    const valueFields = ['target_value', 'oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'total_actual', 'last_actual'];
    const prevRows = new Map<number, any>(this.newKpiList.map((i: any) => [Number(i.indicator_id), i]));
    this.newKpiList = available.map((item: any) => {
      // ค่าเริ่มต้นของเป้าหมาย = เป้าหมายที่ตั้งไว้ในตัวชี้วัด — เก็บใน _original ด้วย เพื่อไฮไลต์เฉพาะช่องที่ผู้ใช้แก้จริง
      const defaultTarget = item.target_percentage != null ? String(item.target_percentage) : '';
      const row: any = {
        ...item,
        year_bh: this.addKpiSelectedYear,
        hospcode: singleHc,
        target_value: defaultTarget,
        oct: '', nov: '', dece: '', jan: '', feb: '', mar: '',
        apr: '', may: '', jun: '', jul: '', aug: '', sep: '',
        total_actual: 0,
        last_actual: '',
        _setting: indicatorTypeSetting(item),
        _autoTypes: autoTargetHostypes(item),
        _targets: resolveAddKpiTargets(item, this.addKpiHospitalList, opts),
        _original: { target_value: defaultTarget, oct: '', nov: '', dece: '', jan: '', feb: '', mar: '', apr: '', may: '', jun: '', jul: '', aug: '', sep: '' }
      };
      const prev = prevRows.get(Number(item.indicator_id));
      if (prev) valueFields.forEach(f => row[f] = prev[f]);   // คงค่าที่ผู้ใช้กรอกไว้ก่อนเปลี่ยนตัวกรอง
      return row;
    });
    this.addKpiUnsetCount = this.newKpiList.filter((i: any) => i._setting === 'unset').length;
    this.addKpiNoTargetCount = this.newKpiList.filter((i: any) => i._setting !== 'unset' && !i._targets.length).length;
    // รายการหมวดหมู่หลักสำหรับ filter
    this.addKpiMainList = Array.from(new Set<string>(this.newKpiList.map((i: any) => i.main_indicator_name).filter(Boolean))).sort();
    this.addKpiSelMains = this.addKpiSelMains.filter(m => this.addKpiMainList.includes(m));   // ว่าง = แสดงทุกหมวดหมู่
    // การเลือก: admin เริ่มจากไม่เลือก / ผู้ใช้หน่วยบริการเดียว เลือกทุกตัวที่เพิ่มได้ตอนเปิดครั้งแรก — หลังจากนั้นคงที่ติ๊กไว้ (ตัดตัวที่เลือกไม่ได้แล้วออก)
    const selectable = new Set<number>(this.newKpiList.filter((i: any) => this.isAddKpiSelectable(i)).map((i: any) => Number(i.indicator_id)));
    if (this._addKpiDefaultAll) {
      this.addKpiSelectedIds = selectable;
      this._addKpiDefaultAll = false;
    } else {
      this.addKpiSelectedIds = new Set<number>(Array.from(this.addKpiSelectedIds).filter(id => selectable.has(id)));
    }
  }

  closeAddModal() {
    this.showAddModal = false;
    this.addKpiOpenDropdown = '';
    this.addKpiSelMains = [];
    this.addKpiSearch = '';
    this.cdr.detectChanges();
  }

  // === Add-KPI filter + selection helpers ===
  get filteredNewKpiList(): any[] {
    let list = this.newKpiList;
    if (this.addKpiSelMains.length > 0) list = list.filter((i: any) => this.addKpiSelMains.includes(i.main_indicator_name));
    const q = String(this.addKpiSearch || '').trim().toLowerCase();
    if (q) {
      list = list.filter((i: any) => [i.kpi_indicators_name, i.main_indicator_name, i.dept_name, i.table_process]
        .some(v => String(v ?? '').toLowerCase().includes(q)));
    }
    return list;
  }

  // === Category multi-filter (dropdown checkbox) ===
  addKpiMainLabel(): string {
    if (this.addKpiSelMains.length === 0) return 'หมวดหมู่: ทั้งหมด';
    if (this.addKpiSelMains.length === 1) return this.addKpiSelMains[0];
    return `หมวดหมู่: ${this.addKpiSelMains.length} รายการ`;
  }
  toggleAllAddKpiMains() {
    const allSel = this.addKpiMainList.length > 0 && this.addKpiMainList.every(m => this.addKpiSelMains.includes(m));
    if (allSel) this.addKpiSelMains = [];
    else this.addKpiSelMains = [...this.addKpiMainList];
  }
  isAllAddKpiMains(): boolean {
    return this.addKpiMainList.length > 0 && this.addKpiMainList.every(m => this.addKpiSelMains.includes(m));
  }

  isAddKpiSelected(item: any): boolean {
    return this.addKpiSelectedIds.has(Number(item.indicator_id));
  }

  toggleAddKpi(item: any) {
    if (!this.isAddKpiSelectable(item)) return;
    const id = Number(item.indicator_id);
    if (this.addKpiSelectedIds.has(id)) this.addKpiSelectedIds.delete(id);
    else this.addKpiSelectedIds.add(id);
  }

  // "เลือกทั้งหมด" — เฉพาะรายการที่แสดงและเพิ่มได้ (ข้ามตัวที่ยังไม่ได้ตั้งประเภท/ไม่มีหน่วยบริการปลายทาง)
  isAllAddKpiSelected(): boolean {
    const visible = this.filteredNewKpiList.filter((i: any) => this.isAddKpiSelectable(i));
    return visible.length > 0 && visible.every((i: any) => this.addKpiSelectedIds.has(Number(i.indicator_id)));
  }

  toggleAllAddKpi() {
    const visible = this.filteredNewKpiList.filter((i: any) => this.isAddKpiSelectable(i));
    if (this.isAllAddKpiSelected()) visible.forEach((i: any) => this.addKpiSelectedIds.delete(Number(i.indicator_id)));
    else visible.forEach((i: any) => this.addKpiSelectedIds.add(Number(i.indicator_id)));
  }

  /** แบ่งคู่ (ตัวชี้วัด × หน่วยบริการ) เป็นคำขอ — ผู้ดูแล: ครั้งละไม่เกิน N หน่วยบริการ แถวระบุ hospcode / ผู้ใช้: คำขอเดียวของหน่วยตัวเอง */
  buildAddKpiBatches(selected: any[]): { hospcodes: string[]; rows: any[] }[] {
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const payload = (item: any, hc: string) => {
      const r: any = { indicator_id: item.indicator_id, year_bh: this.addKpiSelectedYear, hospcode: hc, target_value: String(item.target_value ?? '').trim() };
      months.forEach(m => r[m] = String(item[m] ?? '').trim());
      return r;
    };
    const byHc = new Map<string, any[]>();
    for (const item of selected) {
      for (const hc of (item._targets || [])) {
        if (!byHc.has(hc)) byHc.set(hc, []);
        byHc.get(hc)!.push(payload(item, hc));
      }
    }
    const hcs = [...byHc.keys()];
    const size = DashboardComponent.ADD_KPI_UNITS_PER_REQUEST;
    const batches: { hospcodes: string[]; rows: any[] }[] = [];
    for (let i = 0; i < hcs.length; i += size) {
      const part = hcs.slice(i, i + size);
      batches.push({ hospcodes: part, rows: part.flatMap(hc => byHc.get(hc)!) });
    }
    return batches;
  }

  saveNewKpis() {
    const selected = this.addKpiSelectedItems.filter((i: any) => this.isAddKpiSelectable(i));
    if (selected.length === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกตัวชี้วัดที่จะเพิ่มอย่างน้อย 1 รายการ', 'warning');
      return;
    }
    const batches = this.buildAddKpiBatches(selected);
    const pairCount = batches.reduce((n, b) => n + b.rows.length, 0);
    const unitCount = batches.reduce((n, b) => n + b.hospcodes.length, 0);

    // สรุปปลายทางรายประเภทหน่วยบริการ
    const byType = new Map<string, number>();
    const allTargets = new Set<string>(selected.flatMap((i: any) => i._targets));
    allTargets.forEach(hc => {
      const ht = String(this.addKpiHospitalList.find((h: any) => String(h.hoscode) === hc)?.hostype || '');
      const name = ht ? this.addKpiTypeNames([ht]) : 'หน่วยบริการของท่าน';
      byType.set(name, (byType.get(name) || 0) + 1);
    });
    const typeHtml = [...byType.entries()].map(([n, c]) => `• ${n}: <b>${c.toLocaleString()}</b> แห่ง`).join('<br>');

    Swal.fire({
      title: 'ยืนยันการบันทึก',
      html: `<div class="text-left text-sm">
        <p class="text-gray-600">เพิ่มตัวชี้วัด <b>${selected.length}</b> รายการ ให้หน่วยบริการตามประเภทที่ตั้งไว้ในตัวชี้วัด</p>
        <p class="text-gray-500 text-xs mt-1">ปีงบประมาณ: <b>${this.addKpiSelectedYear}</b></p>
        <p class="text-gray-600 mt-2 font-semibold">หน่วยบริการปลายทาง ${unitCount.toLocaleString()} แห่ง — รวม ${pairCount.toLocaleString()} คู่</p>
        <div class="text-xs text-gray-500 mt-1 max-h-32 overflow-auto bg-gray-50 rounded p-2">${typeHtml}</div>
        <p class="text-[11px] text-gray-400 mt-2">* คู่ที่หน่วยบริการมีตัวชี้วัดนั้นอยู่แล้วจะถูกข้ามอัตโนมัติ</p>
      </div>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#10b981',
      confirmButtonText: '<i class="fas fa-save mr-1"></i> บันทึก',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) this.executeAddKpiBatches(batches);
    });
  }

  private executeAddKpiBatches(batches: { hospcodes: string[]; rows: any[] }[]) {
    const adminMode = this.isAdmin || this.isLocalAdmin;
    const totalUnits = batches.reduce((n, b) => n + b.hospcodes.length, 0);
    let doneUnits = 0, inserted = 0, skipped = 0, skippedType = 0, skippedUnset = 0, failUnits = 0;
    const errors: string[] = [];
    const progress = () => Swal.update({ html: `<div class="text-sm text-gray-600">บันทึกแล้ว <b>${doneUnits.toLocaleString()}</b> / ${totalUnits.toLocaleString()} หน่วยบริการ</div>` });
    Swal.fire({
      title: 'กำลังบันทึกข้อมูล...',
      html: `<div class="text-sm text-gray-600">บันทึกแล้ว <b>0</b> / ${totalUnits.toLocaleString()} หน่วยบริการ</div>`,
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    // ส่งทีละชุดแบบ sequential (กัน DB pool/lock ตึง)
    const saveOne = (idx: number) => {
      if (idx >= batches.length) {
        let msg = `เพิ่มตัวชี้วัดใหม่ ${inserted.toLocaleString()} คู่ ให้ ${(totalUnits - failUnits).toLocaleString()} หน่วยบริการ`;
        if (skipped) msg += `<br>ข้ามที่มีอยู่แล้ว ${skipped.toLocaleString()}`;
        if (skippedType) msg += `<br>ข้ามที่ไม่ตรงประเภทหน่วยบริการ ${skippedType.toLocaleString()}`;
        if (skippedUnset) msg += `<br>ข้ามตัวชี้วัดที่ยังไม่ได้ตั้งประเภทหน่วยบริการ ${skippedUnset.toLocaleString()}`;
        this.showAddModal = false;
        // โหลดตารางใหม่หลังผู้ใช้ปิดสรุปผล — เดิมโหลดทันที แล้วกล่อง "ไม่พบข้อมูล" ของการโหลดตารางทับสรุปผลการเพิ่ม
        const done = failUnits > 0
          ? Swal.fire('เสร็จสิ้น (มีบางส่วนผิดพลาด)', msg + `<br><span class="text-red-600 text-xs">ล้มเหลว ${failUnits} แห่ง: ${errors.slice(0, 3).join(', ')}</span>`, 'warning')
          : Swal.fire('สำเร็จ', msg, 'success');
        done.then(() => { this.loadKpiData(); this.loadDashboardStats(); });
        return;
      }
      const b = batches[idx];
      // ผู้ดูแล: แถวระบุ hospcode (หลายหน่วยบริการต่อคำขอ) / ผู้ใช้: หน่วยบริการตัวเอง
      const target = adminMode ? (b.hospcodes.length === 1 ? b.hospcodes[0] : '') : '';
      this.authService.updateKpiResults(b.rows, target, 'setup_insert_new').subscribe({
        next: (res) => {
          inserted += Number(res.inserted) || 0;
          skipped += Number(res.skipped) || 0;
          skippedType += Number(res.skipped_type) || 0;
          skippedUnset += Number(res.skipped_unset) || 0;
          doneUnits += b.hospcodes.length;
          progress();
          saveOne(idx + 1);
        },
        error: (err) => {
          failUnits += b.hospcodes.length;
          doneUnits += b.hospcodes.length;
          errors.push(err.error?.message || err.message || 'ผิดพลาด');
          console.error('[AddKPI] save batch failed:', err.error?.message || err.message);
          saveOne(idx + 1);
        }
      });
    };
    saveOne(0);
  }

  // === Add KPI Modal: ตรวจสอบการแก้ไข / Undo / Reset ===
  isAddKpiModified(item: any, field: string): boolean {
    if (!item._original) return false;
    return String(item[field] ?? '') !== String(item._original[field] ?? '');
  }

  isAddKpiRowModified(item: any): boolean {
    if (!item._original) return false;
    const fields = ['target_value', 'oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    return fields.some(f => String(item[f] ?? '') !== String(item._original[f] ?? ''));
  }

  undoAddKpiRow(item: any) {
    if (!item._original) return;
    const fields = ['target_value', 'oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    fields.forEach(f => item[f] = item._original[f]);
    item.last_actual = '';
    item.total_actual = 0;
    this.cdr.detectChanges();
  }

  resetAddKpi() {
    Swal.fire({
      title: 'คืนค่าเริ่มต้น',
      text: 'ต้องการคืนค่าที่แก้ไขทั้งหมดกลับเป็นค่าเริ่มต้น (เป้าหมายตามที่ตั้งไว้ในตัวชี้วัด และล้างผลงานรายเดือน) ใช่หรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#f59e0b',
      confirmButtonText: '<i class="fas fa-undo mr-1"></i> ใช่, คืนค่า',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.newKpiList.forEach((item: any) => this.undoAddKpiRow(item));
        Swal.fire({ icon: 'success', title: 'คืนค่าเรียบร้อยแล้ว', toast: true, position: 'top-end', timer: 2000, showConfirmButton: false });
      }
    });
  }

  openTrendModal(item: any) {
    this.selectedKpiName = item.kpi_indicators_name;
    this.selectedKpiCriteria = new CriteriaTextPipe().transform(item);
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const labels = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];

    // แยกข้อมูลตัวเลข vs ข้อความ
    const rawData = months.map(m => String(item[m] ?? '').trim());
    const numericData = rawData.map(v => { const n = parseFloat(v); return isNaN(n) ? null : n; });
    const hasTextValues = rawData.some(v => v !== '' && isNaN(parseFloat(v)));

    // สร้าง annotations สำหรับเดือนที่เป็นข้อความ (แสดงเป็น label บนกราฟ)
    const pointAnnotations = rawData.map((v, i) => {
      if (v !== '' && isNaN(parseFloat(v))) {
        return { x: labels[i], y: 0, marker: { size: 0 }, label: { text: v, borderColor: '#9333ea', style: { background: '#f3e8ff', color: '#7e22ce', fontSize: '11px', fontWeight: 'bold', padding: { left: 6, right: 6, top: 3, bottom: 3 } } } };
      }
      return null;
    }).filter(a => a !== null);

    // เป้าหมาย: ถ้าเป็นตัวเลข → เส้นปะ, ถ้าเป็นข้อความ → annotation label
    const targetRaw = String(item.target_value ?? '').trim();
    const targetNum = parseFloat(targetRaw);
    const hasNumericTarget = !isNaN(targetNum) && targetNum !== 0;

    // Series: ผลงาน + เส้นเป้าหมาย (ถ้าเป็นตัวเลข)
    const series: any[] = [{ name: 'ผลงาน', data: numericData }];
    const strokeWidth: number[] = [3];
    const strokeDash: number[] = [0];
    const colors: string[] = ['#10B981'];

    if (hasNumericTarget) {
      series.push({ name: 'เป้าหมาย (' + targetRaw + ')', data: Array(12).fill(targetNum) });
      strokeWidth.push(2);
      strokeDash.push(6);
      colors.push('#EF4444');
    }

    // Y-axis annotation สำหรับเป้าหมายที่เป็นข้อความ
    const yAnnotations: any[] = [];
    if (!hasNumericTarget && targetRaw) {
      // เป้าหมายเป็นข้อความ → แสดง label ที่แกน Y
      yAnnotations.push({
        y: 0, borderColor: '#9333ea', strokeDashArray: 4,
        label: { text: 'เป้าหมาย: ' + targetRaw, borderColor: '#9333ea', position: 'front',
          style: { background: '#f3e8ff', color: '#7e22ce', fontSize: '12px', fontWeight: 'bold', padding: { left: 8, right: 8, top: 4, bottom: 4 } }
        }
      });
    }

    this.kpiTrendOptions = {
      series,
      chart: {
        height: 350,
        type: 'line',
        zoom: { enabled: false },
        fontFamily: 'Sarabun, sans-serif',
        toolbar: { show: false }
      },
      dataLabels: {
        enabled: true,
        enabledOnSeries: [0],
        formatter: (val: any) => val !== null && val !== undefined ? val : ''
      },
      stroke: { curve: 'smooth', width: strokeWidth, dashArray: strokeDash },
      title: {
        text: 'แนวโน้มผลงานรายเดือน' + (hasTextValues ? ' (ข้อความแสดงเป็น label)' : ''),
        align: 'left'
      },
      grid: { row: { colors: ['#f3f3f3', 'transparent'], opacity: 0.5 } },
      xaxis: { categories: labels },
      yaxis: { labels: { formatter: (val: any) => val !== null && val !== undefined ? val : '' } },
      colors,
      markers: { size: [5, 0], hover: { size: 7 } },
      legend: { show: series.length > 1, position: 'top' },
      annotations: { points: pointAnnotations, yaxis: yAnnotations },
      tooltip: {
        y: {
          formatter: (val: any, opts: any) => {
            if (opts.seriesIndex === 1) return val;
            const txt = rawData[opts.dataPointIndex];
            if (val === null && txt) return txt;
            return val !== null && val !== undefined ? val : '-';
          }
        }
      }
    };
    this.showTrendModal = true;
  }

  closeTrendModal() {
    this.showTrendModal = false;
  }

  // === Sub-Indicator Result Modal ===
  loadSubIndicatorCounts() {
    this.authService.getSubIndicators().subscribe({
      next: (res: any) => {
        if (res.success) {
          this.subIndicatorCountMap.clear();
          for (const s of res.data) {
            if (Number(s.is_active) === 1) {
              this.subIndicatorCountMap.set(s.indicator_id, (this.subIndicatorCountMap.get(s.indicator_id) || 0) + 1);
            }
          }
          this.cdr.detectChanges();
        }
      }
    });
  }

  // โหลด aggregate จาก kpi_sub_results สำหรับปี+hospcode ที่เห็น
  loadSubResultSummary() {
    const year = this.selectedYear;
    const hc = this.currentUser?.hospcode && !this.isAdmin && !this.isSuperAdmin ? this.currentUser.hospcode : '';
    this.authService.getSubResultSummary(year, hc).subscribe((res: any) => {
      if (res.success) {
        this.subSummaryMap.clear();
        for (const r of res.data) {
          // คำนวณ last_actual + avg_pct จาก monthly values (JS)
          const months = ['m09','m08','m07','m06','m05','m04','m03','m02','m01','m12','m11','m10'];
          let lastActual: any = null;
          for (const m of months) {
            const v = r[m];
            if (v !== null && v !== undefined && String(v).trim() !== '' && parseFloat(v) !== 0) {
              lastActual = v; break;
            }
          }
          r.last_actual = lastActual;
          const _cond = this.kpiData.find((k: any) => Number(k.indicator_id) === Number(r.indicator_id))?.target_condition;
          const _ev = lastActual != null ? evaluateTarget(lastActual, r.avg_target, _cond) : null;
          r.avg_pct = _ev && _ev.pct !== null ? this.formatNum(_ev.pct) : null;
          const key = `${r.indicator_id}|${r.hospcode}|${r.year_bh}`;
          this.subSummaryMap.set(key, r);
        }
        this.applySubSummaryToKpiData();
        this.cdr.detectChanges();
      }
    });
  }

  getSubSummary(item: any): any {
    return this.subSummaryMap.get(`${item.indicator_id}|${item.hospcode}|${item.year_bh}`);
  }

  // Merge sub aggregate → main indicator row (override target + monthly + last_actual)
  applySubSummaryToKpiData() {
    if (!this.kpiData || this.kpiData.length === 0) return;
    // ห้าม override ระหว่างโหมดแก้ไข — ไม่งั้น user's edit จะถูกล้างกลับเป็น AVG
    if (this.isEditing) return;
    for (const item of this.kpiData) {
      const sum = this.getSubSummary(item);
      if (!sum) continue;
      // ตัวชี้วัดหลักแบบ "กรอกเอง" (ตัวชี้วัด 3 ระดับ) — ข้อย่อยแสดงประกอบเท่านั้น ไม่นำค่ามาทับแถวหลัก
      if (sum.sub_rollup_mode === 'manual') continue;
      // เก็บ original ไว้สำรองก่อน override (เผื่อ reset)
      if (!item._mainOriginal) {
        item._mainOriginal = {
          target_value: item.target_value, last_actual: item.last_actual,
          oct: item.oct, nov: item.nov, dece: item.dece, jan: item.jan, feb: item.feb,
          mar: item.mar, apr: item.apr, may: item.may, jun: item.jun, jul: item.jul, aug: item.aug, sep: item.sep
        };
      }
      // override ด้วยค่าเฉลี่ยจาก sub (ผลรวม ÷ จำนวนข้อย่อยที่เปิดใช้งานทั้งหมด — ข้อที่ไม่ได้บันทึก = 0) — format จำนวนเต็ม/2 ทศนิยม
      if (sum.avg_target != null) item.target_value = this.formatNum(sum.avg_target);
      const monthMap: any = { oct:'m10', nov:'m11', dece:'m12', jan:'m01', feb:'m02', mar:'m03', apr:'m04', may:'m05', jun:'m06', jul:'m07', aug:'m08', sep:'m09' };
      for (const k of Object.keys(monthMap)) {
        const v = sum[monthMap[k]];
        if (v != null) item[k] = this.formatNum(v);
      }
      const formula = activeFormula(item);
      if (formula && !validateFormula(formula, parseCustomVars(item.custom_vars).map(v => v.key))) {
        // ตัวชี้วัดที่ตั้งสูตร: ผลงาน = สูตรบนค่าเฉลี่ยรายเดือนจาก sub (แทนค่าเดือนล่าสุดของ AVG)
        const val = evaluateFormula(formula, item, item.target_value, item.prev_year, customValuesOf(item));
        item.last_actual = val ?? '';
        item.total_actual = val === null ? 0 : parseFloat(val) || 0;
      } else if (sum.last_actual != null) {
        item.last_actual = this.formatNum(sum.last_actual);
        item.total_actual = parseFloat(sum.last_actual) || 0;
      }
      item._fromSubSummary = true;
    }
    this.filteredData = [...this.kpiData];
    this.applyFilters();
  }

  getSubCount(indicatorId: number): number {
    return this.subIndicatorCountMap.get(indicatorId) || 0;
  }

  // ===== ตัวชี้วัด 3 ระดับ: แถวลูกในตารางบันทึกผลงาน (กด ▶ ที่แถวหลักเพื่อขยายข้อย่อย 1.1 / กิจกรรม 1.1.1) =====
  hierExpanded = new Set<string>();
  hierData = new Map<string, HierRow[]>();
  hierLoading = new Set<string>();
  readonly HIER_MONTH_NAME: { [k: string]: string } = {
    oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
    apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
  };

  hierKey(item: any): string {
    return `${item.indicator_id}|${item.hospcode}|${item.year_bh || this.selectedYear}`;
  }

  isHierExpanded(item: any): boolean {
    return this.hierExpanded.has(this.hierKey(item));
  }

  hierRows(item: any): HierRow[] {
    return this.isHierExpanded(item) ? (this.hierData.get(this.hierKey(item)) || []) : [];
  }

  // จำนวนแถวรวมแถวลูกที่ขยายอยู่ — ใช้กับ rowspan ของคอลัมน์หมวดหมู่หลัก (ครอบแถวลูกด้วย ไม่งั้นตารางเลื่อน)
  hierRowSpan(list: any[], index: number): number {
    const item = list[index];
    let span = item?.rowSpan || 0;
    for (let j = index; j < index + (item?.rowSpan || 0) && j < list.length; j++) span += this.hierRows(list[j]).length;
    return span;
  }

  toggleHier(item: any) {
    const key = this.hierKey(item);
    if (this.hierExpanded.has(key)) { this.hierExpanded.delete(key); this.cdr.detectChanges(); return; }
    this.hierExpanded.add(key);
    if (!this.hierData.has(key)) this.loadHier(key, item.item_no);
    this.cdr.detectChanges();
  }

  loadHier(key: string, parentNo: string = '') {
    const [indicatorId, hospcode, year] = key.split('|');
    this.hierLoading.add(key);
    this.authService.getHierarchyResults(Number(indicatorId), year, hospcode).subscribe({
      next: (res: any) => {
        this.hierLoading.delete(key);
        if (res.success) this.hierData.set(key, buildHierRows(res.data, res.data.item_no || parentNo || ''));
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.hierLoading.delete(key);
        this.hierExpanded.delete(key);
        Swal.fire('ผิดพลาด', err.error?.message || 'โหลดตัวชี้วัดย่อยไม่สำเร็จ', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  // โหลดแถวลูกที่ขยายอยู่ใหม่ทั้งหมด (หลังบันทึก)
  reloadExpandedHier() {
    this.hierData.clear();
    for (const key of this.hierExpanded) this.loadHier(key);
  }

  canEditHierRow(item: any, row: HierRow): boolean {
    return this.isEditing && !item.is_locked && this.canEditActual && !row.locked && !row.auto && !this.isEntryLocked;
  }

  onHierChange(item: any) {
    const rows = this.hierData.get(this.hierKey(item));
    if (rows) recomputeHierRows(rows);
  }

  // กิจกรรมแบบทำแล้ว/ยังไม่ทำ: กดวน ว่าง → ทำแล้ว (1) → ยังไม่ทำ (0) → ว่าง
  cycleHierCheck(item: any, row: HierRow, m: string) {
    if (!this.canEditHierRow(item, row)) return;
    const v = String(row.months[m] ?? '');
    row.months[m] = v === '1' ? '0' : v === '0' ? '' : '1';
    this.onHierChange(item);
  }

  isHierModified(row: HierRow, m: string): boolean {
    return !row.auto && String(row.months[m] ?? '') !== String(row._orig[m] ?? '');
  }

  hierLastValue(row: HierRow): string {
    for (let i = HIER_MONTHS.length - 1; i >= 0; i--) {
      const v = String(row.months[HIER_MONTHS[i].key] ?? '').trim();
      if (v !== '') return row.valueType === 'check' ? (v === '1' ? 'ทำแล้ว' : 'ยังไม่ทำ') : v;
    }
    return '';
  }

  // ===== ค่าฐาน (base) + ค่าเพิ่มเติมที่ตั้งชื่อเอง (custom_vars) — kpi_base_values (24–25 ต.ค. 2569) =====
  // ช่องกรอกใต้เป้าหมาย (สิทธิ์เดียวกับเป้าหมาย) — ค่าอยู่ในแถวเป็น cv_<key> | cache ตามข้อความ custom_vars + สูตร (template เรียกบ่อย)
  private _cvDefsCache = new Map<string, CustomVarDef[]>();
  customVarDefs(item: any): CustomVarDef[] {
    const k = `${item?.custom_vars ?? ''}|${item?.result_formula ?? ''}|${item?.pct_formula ?? ''}`;
    let d = this._cvDefsCache.get(k);
    if (!d) { d = customVarDefsFor(item); if (this._cvDefsCache.size > 300) this._cvDefsCache.clear(); this._cvDefsCache.set(k, d); }
    return d;
  }
  isCustomFieldChanged(item: any, key: string): boolean {
    return !!item?._original && String(item['cv_' + key] ?? '').trim() !== String(item._original['cv_' + key] ?? '').trim();
  }
  isCustomChanged(item: any): boolean {
    return this.customVarDefs(item).some(v => this.isCustomFieldChanged(item, v.key));
  }
  customPayload(item: any): Record<string, string> {
    const out: Record<string, string> = {};
    for (const v of this.customVarDefs(item)) if (this.isCustomFieldChanged(item, v.key)) out['cv_' + v.key] = String(item['cv_' + v.key] ?? '').trim();
    return out;
  }
  onCustomChange(item: any): void {
    this.onValueChange(item, '');
  }

  // แถวลูกใช้เงื่อนไขเป้าหมายของตัวชี้วัดหลัก (cond = item.target_condition)
  hierPct(row: HierRow, cond?: any): string {
    if (row.valueType === 'check') return '';
    const last = this.hierLastValue(row);
    if (isNaN(parseFloat(last))) return '';
    const r = evaluateTarget(last, row.target, cond);
    return r.pct === null ? '' : r.pct.toFixed(2);
  }

  // ช่องที่แก้ไขในแถวลูกทั้งหมด → รายการสำหรับหน้ายืนยัน + payload ของ POST /hierarchy-results/save
  collectHierChanges(): { key: string; item: any; row: HierRow; m: string; oldVal: string; newVal: string }[] {
    const out: { key: string; item: any; row: HierRow; m: string; oldVal: string; newVal: string }[] = [];
    for (const item of this.filteredData) {
      const key = this.hierKey(item);
      const rows = this.hierData.get(key);
      if (!rows) continue;
      for (const row of rows) {
        if (row.auto) continue;
        for (const hm of HIER_MONTHS) {
          if (this.isHierModified(row, hm.key)) {
            out.push({ key, item, row, m: hm.key, oldVal: String(row._orig[hm.key] ?? ''), newVal: String(row.months[hm.key] ?? '') });
          }
        }
      }
    }
    return out;
  }

  hierDisplay(row: HierRow, v: string): string {
    if (row.valueType !== 'check') return v;
    return v === '1' ? 'ทำแล้ว' : v === '0' ? 'ยังไม่ทำ' : '';
  }

  // บันทึกช่องที่แก้ไขของแถวลูก แยกตามหน่วยบริการ × ปีงบ — คืน true เมื่อสำเร็จทั้งหมด
  async saveHierChanges(changes: { key: string; item: any; row: HierRow; m: string; newVal: string }[]): Promise<boolean> {
    const groups = new Map<string, { year_bh: string; hospcode: string; sub: any[]; activity: any[] }>();
    for (const c of changes) {
      const [, hospcode, year] = c.key.split('|');
      const gk = `${hospcode}|${year}`;
      if (!groups.has(gk)) groups.set(gk, { year_bh: year, hospcode, sub: [], activity: [] });
      const month_bh = HIER_MONTHS.find(h => h.key === c.m)!.m;
      const g = groups.get(gk)!;
      if (c.row.kind === 'sub') g.sub.push({ sub_indicator_id: c.row.id, month_bh, actual_value: c.newVal });
      else g.activity.push({ activity_id: c.row.id, month_bh, actual_value: c.newVal });
    }
    try {
      for (const g of groups.values()) {
        await new Promise<void>((resolve, reject) => this.authService.saveHierarchyResults(g).subscribe({ next: () => resolve(), error: (e: any) => reject(e) }));
      }
      return true;
    } catch (e: any) {
      Swal.fire('บันทึกตัวชี้วัดย่อย/กิจกรรมไม่สำเร็จ', e?.error?.message || e?.message || 'เกิดข้อผิดพลาด', 'error');
      return false;
    }
  }

  restoreHier() {
    for (const rows of this.hierData.values()) {
      for (const r of rows) if (!r.auto) r.months = { ...r._orig };
      recomputeHierRows(rows);
    }
  }

  openSubResultModal(item: any) {
    this.subResultContext = {
      indicator_id: item.indicator_id,
      indicator_name: item.kpi_indicators_name,
      item_no: item.item_no || '',
      hospcode: item.hospcode,
      hosname: item.hosname,
      year_bh: item.year_bh || this.selectedYear,
      is_locked: item.is_locked,
      target_condition: item.target_condition
    };
    // Reset modal-local state ทุกครั้งที่เปิด modal ใหม่
    this.subEditMode = false;
    this.subDeleteMode = false;
    this.subDeleteSelected.clear();
    this.showSubResultModal = true;
    this.loadSubResultList();
  }

  closeSubResultModal() {
    this.showSubResultModal = false;
    this.subResultContext = null;
    this.subResultList = [];
    this.subEditMode = false;
    this.subDeleteMode = false;
    this.subDeleteSelected.clear();
    // Full silent refresh — โหลด kpiData ใหม่ + sub summary + sub counts
    // (silent=true → ไม่โชว์ SweetAlert search status modal)
    this.loadSubIndicatorCounts();
    this.loadSubResultSummary();
    this.loadKpiData(true);
  }

  // Toggle modal-local edit mode (ไม่กระทบ dashboard main)
  toggleSubEditMode() {
    this.subEditMode = !this.subEditMode;
    if (this.subEditMode) this.subDeleteMode = false;
  }

  // Toggle modal-local delete mode
  toggleSubDeleteMode() {
    this.subDeleteMode = !this.subDeleteMode;
    if (this.subDeleteMode) this.subEditMode = false;
    if (!this.subDeleteMode) this.subDeleteSelected.clear();
  }

  toggleSubDeleteItem(subId: number) {
    if (this.subDeleteSelected.has(subId)) this.subDeleteSelected.delete(subId);
    else this.subDeleteSelected.add(subId);
  }

  isSubDeleteSelected(subId: number): boolean {
    return this.subDeleteSelected.has(subId);
  }

  toggleSubDeleteAll() {
    if (this.subDeleteSelected.size === this.subResultList.length) {
      this.subDeleteSelected.clear();
    } else {
      this.subResultList.forEach(s => this.subDeleteSelected.add(s.id));
    }
  }

  get subDeleteAllChecked(): boolean {
    return this.subResultList.length > 0 && this.subDeleteSelected.size === this.subResultList.length;
  }

  // ยืนยันและลบตัวชี้วัดย่อยที่เลือก (super_admin only)
  confirmDeleteSubIndicators() {
    if (this.subDeleteSelected.size === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกตัวชี้วัดย่อยอย่างน้อย 1 รายการ', 'warning');
      return;
    }
    const selectedSubs = this.subResultList.filter(s => this.subDeleteSelected.has(s.id));
    const listHtml = selectedSubs.map(s => `<li>${this.escHtml(s.sub_indicator_name)}</li>`).join('');
    Swal.fire({
      title: 'ยืนยันการลบตัวชี้วัดย่อย',
      html: `<div class="text-left text-sm">
        <p class="text-red-600 font-bold mb-2">จะลบตัวชี้วัดย่อย ${selectedSubs.length} รายการ:</p>
        <ul class="list-disc ml-5 text-xs text-gray-700 max-h-40 overflow-y-auto">${listHtml}</ul>
        <p class="mt-3 text-amber-700 text-xs"><i class="fas fa-exclamation-triangle mr-1"></i>การลบจะลบผลงานย่อย (kpi_sub_results) ด้วย — <b>ไม่สามารถกู้คืนได้</b></p>
      </div>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: '<i class="fas fa-trash mr-1"></i> ลบ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626',
    }).then(r => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังลบ...', allowOutsideClick: false, didOpen: () => Swal.showLoading(null) });
      const requests = Array.from(this.subDeleteSelected).map(id =>
        this.authService.deleteSubIndicator(id).toPromise().catch((e: any) => ({ error: e, id }))
      );
      Promise.all(requests).then(results => {
        const errors = results.filter((x: any) => x && x.error);
        const ok = results.length - errors.length;
        Swal.fire({
          icon: errors.length > 0 ? 'warning' : 'success',
          title: errors.length > 0 ? `ลบสำเร็จ ${ok}/${results.length} รายการ` : 'ลบเรียบร้อย',
          text: errors.length > 0 ? 'บางรายการลบไม่สำเร็จ' : `ลบตัวชี้วัดย่อย ${ok} รายการสำเร็จ`,
          timer: 2000, showConfirmButton: false
        });
        // โหลด sub-indicators ใหม่ + reset modal state
        this.subDeleteMode = false;
        this.subDeleteSelected.clear();
        this.loadSubResultList();
        this.loadSubIndicatorCounts();
      });
    });
  }

  // คำนวณเฉลี่ย (AVG) ของ sub-results ใน modal ปัจจุบัน — คำนวณ local ทันที
  // ใช้สำหรับแสดง "ผลงานรวม" + "%" ใน modal ให้ update ทันทีหลังบันทึก (ไม่ต้องรอ server)
  getSubModalAverage(): { avgTarget: string; avgActual: string; avgPct: string; count: number; metPct: number } {
    if (!this.subResultList || this.subResultList.length === 0) {
      return { avgTarget: '-', avgActual: '-', avgPct: '-', count: 0, metPct: 0 };
    }
    const targets: number[] = [];
    for (const s of this.subResultList.filter((x: any) => !(Number(x._level) > 0))) {
      const t = parseFloat(String(s._target ?? ''));
      if (isFinite(t) && t !== 0) targets.push(t);
    }
    const avg = (arr: number[]) => arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : NaN;
    const at = avg(targets);
    // ผลงาน = ค่าของเดือนล่าสุดที่มีการบันทึก (ดู getSubMonthlyAggregates) — ต้องตรงกับ loadSubAggregates() ฝั่ง backend
    let aa = NaN;
    const monthly = this.getSubMonthlyAggregates();
    for (const m of [...this.subMonthColumns].reverse()) {
      if (monthly[m] !== null && monthly[m] !== undefined) { aa = monthly[m] as number; break; }
    }
    const ev = (isFinite(at) && isFinite(aa)) ? evaluateTarget(aa, at, this.subResultContext?.target_condition) : null;
    const pct = ev && ev.pct !== null ? ev.pct : NaN;
    return {
      avgTarget: isFinite(at) ? this.formatNum(at) : '-',
      avgActual: isFinite(aa) ? this.formatNum(aa) : '-',
      avgPct: isFinite(pct) ? this.formatNum(pct) : '-',
      count: this.subResultList.length,
      metPct: isFinite(pct) ? pct : 0,
    };
  }

  // ผลงานรวมรายเดือนของตัวชี้วัดหลักจากข้อย่อย = ผลรวม "ผลงานล่าสุดของแต่ละข้อ ณ เดือนนั้น" ÷ จำนวนข้อย่อยทั้งหมด
  // ข้อที่ไม่ได้บันทึกในเดือนนั้นใช้ค่าล่าสุดของเดือนก่อนหน้า (ยังไม่เคยบันทึก = 0) → ข้อที่ผ่านแล้วไม่ต้องบันทึกซ้ำ
  // เดือนที่ไม่มีข้อใดบันทึกเลย = null — ต้องตรงกับ loadSubAggregates() ฝั่ง backend
  getSubMonthlyAggregates(): { [month: number]: number | null } {
    const out: { [month: number]: number | null } = {};
    // ผลงานหลักคิดจากข้อย่อยระดับบนสุดเท่านั้น (ข้อลูกมีผลผ่านข้อแม่ที่คำนวณจากระดับล่าง) — ตรงกับ backend loadSubAggregates()
    const list = (this.subResultList || []).filter((s: any) => !(Number(s._level) > 0));
    const latest = new Map<number, number>();
    for (const m of this.subMonthColumns) {
      let has = false;
      list.forEach((s: any, idx: number) => {
        const raw = String(s._actuals?.[m] ?? '').trim();
        if (/^-?(\d+(\.\d+)?|\.\d+)$/.test(raw)) { latest.set(idx, parseFloat(raw)); has = true; }
      });
      if (!has || list.length === 0) { out[m] = null; continue; }
      let sum = 0;
      latest.forEach(v => sum += v);
      out[m] = sum / list.length;
    }
    return out;
  }

  getSubMonthAggregate(m: number): string {
    const v = this.getSubMonthlyAggregates()[m];
    return v === null || v === undefined ? '' : this.formatNum(v);
  }

  // ลำดับเดือนตามปีงบประมาณ ต.ค.→ก.ย.
  subMonthColumns = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  subMonthLabels: { [k: number]: string } = {
    10: 'ต.ค.', 11: 'พ.ย.', 12: 'ธ.ค.', 1: 'ม.ค.', 2: 'ก.พ.', 3: 'มี.ค.',
    4: 'เม.ย.', 5: 'พ.ค.', 6: 'มิ.ย.', 7: 'ก.ค.', 8: 'ส.ค.', 9: 'ก.ย.'
  };

  // Format: จำนวนเต็มแสดงไม่มีทศนิยม, มีเศษแสดง 2 ตำแหน่ง
  formatNum(v: any): string {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(String(v));
    if (!isFinite(n)) return String(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  // 12 เดือนตามลำดับปีงบประมาณ (ต.ค. → ก.ย.) — public เพื่อใช้ใน template
  readonly FISCAL_MONTHS: { key: string; name: string }[] = [
    { key: 'oct', name: 'ต.ค.' }, { key: 'nov', name: 'พ.ย.' }, { key: 'dece', name: 'ธ.ค.' },
    { key: 'jan', name: 'ม.ค.' }, { key: 'feb', name: 'ก.พ.' }, { key: 'mar', name: 'มี.ค.' },
    { key: 'apr', name: 'เม.ย.' }, { key: 'may', name: 'พ.ค.' }, { key: 'jun', name: 'มิ.ย.' },
    { key: 'jul', name: 'ก.ค.' }, { key: 'aug', name: 'ส.ค.' }, { key: 'sep', name: 'ก.ย.' },
  ];

  private hasMonthData(v: any): boolean {
    const s = String(v ?? '').trim();
    return s !== '' && s !== '0' && s !== 'null';
  }

  // ดึง N เดือนล่าสุดที่มีข้อมูล (ตามลำดับปีงบประมาณ) สำหรับแสดงบน mobile/tablet
  // ถ้ามีน้อยกว่า count เดือน จะ pad ด้วยเดือนล่าสุดตามลำดับเพื่อให้ครบจำนวนช่อง
  getRecentMonths(item: any, count: number = 4): { key: string; name: string }[] {
    const withData = this.FISCAL_MONTHS.filter(m => this.hasMonthData(item[m.key]));
    if (withData.length >= count) return withData.slice(-count);
    if (withData.length === 0) return this.FISCAL_MONTHS.slice(0, count);
    // เติมด้วย fiscal tail เดือนที่ล่าสุด (ไม่ว่า empty ก็ตาม)
    return this.FISCAL_MONTHS.slice(-count);
  }

  // คำนวณ scrollLeft (px) ให้ mobile card เลื่อนไปยัง "6 เดือนล่าสุดที่มีข้อมูล"
  // cellWidth: ความกว้างแต่ละช่องเดือน (รวม gap)
  getMobileMonthScroll(item: any, visibleCount: number = 6, cellWidth: number = 70, gap: number = 8): number {
    let lastIdx = -1;
    for (let i = 0; i < this.FISCAL_MONTHS.length; i++) {
      if (this.hasMonthData(item[this.FISCAL_MONTHS[i].key])) lastIdx = i;
    }
    if (lastIdx < 0) return 0; // ไม่มีข้อมูลเลย → เริ่มจาก ต.ค.
    // ให้ช่องที่ `lastIdx` อยู่ขวาสุดของ viewport (แสดง visibleCount ช่องก่อนหน้า)
    const startIdx = Math.max(0, lastIdx - (visibleCount - 1));
    return startIdx * (cellWidth + gap);
  }

  // คำนวณ scrollLeft (px) ให้ตาราง desktop เลื่อนไปยัง "3 เดือนล่าสุดที่มีข้อมูล" (รวมทุกแถวที่แสดงอยู่)
  // ยังเลื่อนดูเดือนอื่น ต.ค.-ก.ย. ได้ตามปกติ เพราะแค่ตั้งตำแหน่งเริ่มต้น ไม่ล็อคสกอร์ล
  getDesktopMonthScroll(visibleCount: number = 3, cellWidth: number = 75): number {
    let lastIdx = -1;
    for (const item of this.pagedData) {
      // นับตามเดือนที่แสดงอยู่จริง (ผู้ใช้อาจซ่อนบางเดือนไว้)
      const months = this.visibleMonths;
      for (let i = 0; i < months.length; i++) {
        if (i > lastIdx && this.hasMonthData(item[months[i].key])) lastIdx = i;
      }
    }
    if (lastIdx < 0) return 0; // ไม่มีข้อมูลเลย → เริ่มจาก ต.ค.
    const startIdx = Math.max(0, lastIdx - (visibleCount - 1));
    return startIdx * cellWidth;
  }

  // ค่าเดือนล่าสุดที่มีผลงาน (ลำดับย้อนกลับ ก.ย.→ต.ค.) — format จำนวนเต็ม/2 ตำแหน่ง
  getSubLastActual(sub: any): string {
    if (!sub?._actuals) return '';
    const rev = [...this.subMonthColumns].reverse();
    for (const m of rev) {
      const v = sub._actuals[m];
      if (v !== null && v !== undefined && String(v).trim() !== '') return this.formatNum(v);
    }
    return '';
  }

  // % เทียบเป้าหมาย — int ถ้าเต็ม, 2 ทศนิยมถ้ามีเศษ
  getSubPct(sub: any): string {
    const actualRaw = (() => {
      if (!sub?._actuals) return null;
      const rev = [...this.subMonthColumns].reverse();
      for (const m of rev) {
        const v = sub._actuals[m];
        if (v !== null && v !== undefined && String(v).trim() !== '') return v;
      }
      return null;
    })();
    const actual = parseFloat(actualRaw as any);
    const target = parseFloat(sub?._target);
    if (!isFinite(actual) || !isFinite(target) || target === 0) return '';
    return this.formatNum((actual / target) * 100);
  }

  // ===== นำเข้าผลงานตัวชี้วัดย่อยจาก Excel (12 ต.ค. 2569) — ตรรกะอยู่ใน shared/kpi-sub-excel.ts =====
  // เติมค่าลงตารางในหน้าต่างเท่านั้น ผู้ใช้ตรวจแล้วกด "บันทึกทั้งหมด" ผ่าน saveSubResults() เดิม (สิทธิ์/การล็อคตรวจที่ /sub-results/upsert)

  /** ดาวน์โหลดแบบฟอร์ม Excel ของข้อย่อยในหน้าต่างนี้ (พร้อมค่าปัจจุบัน) */
  downloadSubExcelTemplate() {
    const ctx = this.subResultContext;
    if (!ctx || !this.subResultList.length) { this.toast.warning('ไม่มีตัวชี้วัดย่อยให้ดาวน์โหลดแบบฟอร์ม'); return; }
    import('xlsx').then(XLSX => {
      const aoa = buildSubTemplateAoa(this.subResultList, ctx);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 55 }, { wch: 10 }, ...SUB_EXCEL_MONTHS.map(() => ({ wch: 8 }))];
      const last = aoa[2].length - 1;
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: last } }, { s: { r: 1, c: 0 }, e: { r: 1, c: last } }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ผลงานย่อย');
      XLSX.writeFile(wb, `KPI_ผลงานตัวชี้วัดย่อย_${ctx.indicator_id}_${ctx.hospcode}_${ctx.year_bh}.xlsx`);
    });
  }

  /** เลือกไฟล์ Excel/CSV → อ่านแผ่นงานแรก → importSubAoa() */
  onSubExcelFileSelected(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (input) input.value = '';              // เลือกไฟล์เดิมซ้ำได้
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { Swal.fire('ไฟล์ใหญ่เกินไป', 'รองรับไฟล์ไม่เกิน 10 MB', 'warning'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      import('xlsx').then(XLSX => {
        try {
          const wb = XLSX.read(new Uint8Array(reader.result as ArrayBuffer), { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          this.importSubAoa(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as any[][], file.name);
        } catch (e: any) {
          Swal.fire('อ่านไฟล์ไม่ได้', 'ไฟล์ไม่ใช่ Excel/CSV ที่ถูกต้อง หรือไฟล์เสียหาย', 'error');
        }
      });
    };
    reader.onerror = () => Swal.fire('อ่านไฟล์ไม่ได้', 'ไม่สามารถเปิดไฟล์ที่เลือก', 'error');
    reader.readAsArrayBuffer(file);
  }

  /** สรุปสิ่งที่จะเปลี่ยนจากไฟล์ให้ผู้ใช้ยืนยัน แล้วเติมลงตารางในหน้าต่าง (ยังไม่บันทึก) */
  importSubAoa(aoa: any[][], fileName = '') {
    const ctx = this.subResultContext;
    if (!this.subEditMode || !ctx) return;
    const parsed = parseSubImportAoa(aoa);
    if (parsed.error) { Swal.fire('นำเข้าไม่ได้', parsed.error, 'error'); return; }
    const plan = planSubImport(parsed.rows, this.subResultList, ctx);
    const html = this.buildSubImportPreviewHtml(plan, parsed.rows.length, fileName);
    if (plan.changes.length === 0) {
      Swal.fire({ icon: 'info', title: 'ไม่มีค่าที่ต้องเปลี่ยน', html, confirmButtonText: 'ตกลง', width: 720 });
      return;
    }
    Swal.fire({
      title: 'ตรวจสอบก่อนนำเข้า', html, icon: 'question', width: 780,
      showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: `<i class="fas fa-file-import mr-1"></i> เติมลงตาราง ${plan.changes.length.toLocaleString()} ช่อง`, cancelButtonText: 'ยกเลิก'
    }).then(r => { if (r.isConfirmed) this.applySubImportPlan(plan); });
  }

  /** HTML สรุปผลการอ่านไฟล์ (แยกเป็นฟังก์ชันเพื่อทดสอบได้โดยไม่ต้องเปิดหน้าต่าง) */
  buildSubImportPreviewHtml(plan: SubChangePlan, fileRows: number, fileName = ''): string {
    const esc = (v: any) => this.escHtml(String(v ?? ''));
    const line = (n: number, text: string, color: string) => n > 0 ? `<li style="color:${color}">${text} <b>${n.toLocaleString()}</b></li>` : '';
    const rows = plan.changes.slice(0, 30).map(c => `<tr>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb">${esc(c.sub.sub_indicator_name)}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${subFieldLabel(c.field)}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#6b7280">${esc(c.oldVal) || '—'}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${esc(c.newVal)}</td>
      </tr>`).join('');
    const table = plan.changes.length === 0 ? '' : `
      <div style="max-height:240px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:10px;margin-top:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px;background:white">
          <thead style="position:sticky;top:0;background:#f3f4f6"><tr>
            <th style="padding:6px 8px;text-align:left">ตัวชี้วัดย่อย</th><th style="padding:6px 8px">ช่อง</th>
            <th style="padding:6px 8px">ค่าเดิม</th><th style="padding:6px 8px">ค่าใหม่</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${plan.changes.length > 30 ? `<p style="font-size:11px;color:#6b7280;margin-top:4px">แสดง 30 จาก ${plan.changes.length.toLocaleString()} ช่อง</p>` : ''}`;
    return `<div style="text-align:left;font-size:13px">
      ${fileName ? `<p style="color:#6b7280;font-size:12px;margin-bottom:6px"><i class="fas fa-file-excel" style="color:#16a34a"></i> ${esc(fileName)} — ${fileRows.toLocaleString()} แถว</p>` : ''}
      <ul style="list-style:disc;margin-left:18px;line-height:1.7">
        <li style="color:#047857">ช่องที่จะเปลี่ยนค่า <b>${plan.changes.length.toLocaleString()}</b></li>
        ${line(plan.same, 'ค่าเท่าเดิม (ไม่เปลี่ยน)', '#6b7280')}
        ${line(plan.tooLong, 'ข้าม — ข้อความยาวเกิน 100 ตัวอักษร', '#b45309')}
        ${line(plan.unmatchedRows.length, 'ข้าม — แถวที่ไม่ใช่ข้อย่อยของตัวชี้วัดนี้ หรือเป็นของหน่วยบริการ/ปีงบประมาณอื่น', '#b91c1c')}
        ${line(plan.duplicateRows.length, 'ข้าม — แถวซ้ำในไฟล์ (ใช้แถวแรก)', '#b45309')}
      </ul>
      ${plan.unmatchedRows.length ? `<p style="font-size:11px;color:#b91c1c;margin-top:2px">แถวที่ไม่ตรง: ${plan.unmatchedRows.slice(0, 15).join(', ')}${plan.unmatchedRows.length > 15 ? ' …' : ''} — ตรวจว่าเป็นไฟล์ของตัวชี้วัด หน่วยบริการ และปีงบประมาณเดียวกับหน้าต่างนี้</p>` : ''}
      ${table}
      <p style="margin-top:10px;font-size:12px;color:#6b7280">ช่องว่างในไฟล์ไม่ทับค่าเดิม • ข้อมูลจะถูก<b>เติมลงตารางเท่านั้น ยังไม่บันทึก</b> — ตรวจสอบแล้วกด "บันทึกทั้งหมด"</p>
    </div>`;
  }

  /** เติมค่าตามแผนลงตารางในหน้าต่าง (การ์ดสรุป/แถวผลงานรวมรายเดือนคำนวณใหม่เอง) + แจ้งผล */
  applySubImportPlan(plan: SubChangePlan) {
    const touched = applySubChanges(plan.changes);
    this.cdr.detectChanges();
    if (plan.changes.length === 0) { this.toast.warning('ไม่มีช่องที่นำเข้าได้'); return; }
    this.toast.success(`นำเข้าแล้ว ${plan.changes.length.toLocaleString()} ช่อง ใน ${touched.toLocaleString()} ข้อย่อย — ตรวจสอบแล้วกด "บันทึกทั้งหมด"`);
  }

  // สำหรับเก็บค่าเดิมตอนโหลด — ใช้ตรวจว่าเปลี่ยนไหมก่อนบันทึก
  private _subOriginal: Map<string, { target: string; actual: string }> = new Map();

  loadSubResultList() {
    const ctx = this.subResultContext;
    if (!ctx) return;
    this._subOriginal.clear();
    this.authService.getSubIndicators(ctx.indicator_id).subscribe((res: any) => {
      if (!res.success) return;
      // ข้อย่อยทุกระดับเรียงเป็นต้นไม้ (ปิดข้อแม่ = ซ่อนทั้งสาย) — _level ใช้เยื้อง, ผลงานรวมคิดจากข้อระดับบนสุด
      const subs = orderSubTree(res.data, ctx.item_no || '', true);
      this.authService.getSubResults({ indicator_id: ctx.indicator_id, year_bh: ctx.year_bh, hospcode: ctx.hospcode }).subscribe((r2: any) => {
        // pivot: key = sub_id_month → { target_value, actual_value }
        const resultMap = new Map<string, any>();
        if (r2.success) for (const r of r2.data) resultMap.set(`${r.sub_indicator_id}_${r.month_bh}`, r);

        this.subResultList = subs.map((s: any) => {
          // target ระดับ sub (ใช้ร่วมทุกเดือน → ดึงจาก month 10 ก่อน แล้ว fallback ไป sub.target_percentage)
          const m10Row = resultMap.get(`${s.id}_10`);
          const _target = m10Row?.target_value ?? s.target_percentage ?? '';
          // สร้าง map เดือน → actual_value
          const monthActuals: { [k: number]: string } = {};
          for (const m of this.subMonthColumns) {
            const row = resultMap.get(`${s.id}_${m}`);
            monthActuals[m] = row?.actual_value ?? '';
            this._subOriginal.set(`${s.id}_${m}`, {
              target: row?.target_value ?? '',
              actual: row?.actual_value ?? ''
            });
          }
          // ข้อย่อยที่คำนวณจากระดับล่าง (ข้อลูก/กิจกรรม) — อ่านอย่างเดียวในหน้าต่างนี้ ค่าเติมจากการคำนวณด้านล่าง
          const _auto = s.rollup_mode === 'auto' && Number(s.activity_count || 0) + Number(s._childSubCount || 0) > 0;
          return { ...s, _target, _actuals: monthActuals, _auto };
        });
        this.cdr.detectChanges();
        if (this.subResultList.some((s: any) => s._auto)) {
          this.authService.getHierarchyResults(ctx.indicator_id, ctx.year_bh, ctx.hospcode).subscribe({
            next: (r3: any) => {
              if (!r3.success || this.subResultContext !== ctx) return;
              const rows = buildHierRows(r3.data, '');
              for (const s of this.subResultList) {
                const hr = s._auto ? rows.find(r => r.kind === 'sub' && r.id === Number(s.id)) : null;
                if (!hr) continue;
                for (const hm of HIER_MONTHS) s._actuals[hm.m] = hr.months[hm.key];
              }
              this.cdr.detectChanges();
            }
          });
        }
      });
    });
  }

  async saveSubResults() {
    const ctx = this.subResultContext;
    if (!ctx) return;

    // รวบรวมการเปลี่ยนแปลง: sub_id + field + old + new
    type Change = { subName: string; field: string; oldVal: string; newVal: string; payload: any };
    const changes: Change[] = [];

    for (const s of this.subResultList) {
      if (s._auto) continue; // คำนวณจากกิจกรรม — ไม่บันทึกจากหน้าต่างนี้ (backend ก็ปฏิเสธ)
      for (const m of this.subMonthColumns) {
        const actualNew = (s._actuals[m] ?? '').toString().trim();
        const orig = this._subOriginal.get(`${s.id}_${m}`) || { target: '', actual: '' };
        const targetNew = (s._target ?? '').toString().trim();
        const actualChanged = actualNew !== orig.actual;
        const targetChanged = targetNew !== orig.target;
        const hasValue = actualNew !== '' || targetNew !== '';
        if ((actualChanged || targetChanged) && hasValue) {
          // แยกรายการ target (เก็บครั้งเดียวต่อ sub) และแต่ละเดือนที่เปลี่ยน
          if (actualChanged) {
            changes.push({
              subName: s.sub_indicator_name,
              field: this.subMonthLabels[m] || 'เดือน ' + m,
              oldVal: orig.actual,
              newVal: actualNew,
              payload: { sub_indicator_id: s.id, year_bh: ctx.year_bh, hospcode: ctx.hospcode, month_bh: m, target_value: targetNew || null, actual_value: actualNew || null, status: 'Pending' }
            });
          } else if (targetChanged) {
            // target เปลี่ยนอย่างเดียว — ยังต้อง upsert ของ month นี้ (เก็บ target)
            changes.push({
              subName: s.sub_indicator_name,
              field: 'เป้าหมาย',
              oldVal: orig.target,
              newVal: targetNew,
              payload: { sub_indicator_id: s.id, year_bh: ctx.year_bh, hospcode: ctx.hospcode, month_bh: m, target_value: targetNew || null, actual_value: actualNew || null, status: 'Pending' }
            });
          }
        }
      }
    }

    if (changes.length === 0) {
      Swal.fire({ icon: 'info', title: 'ไม่มีการเปลี่ยนแปลง', timer: 1500, showConfirmButton: false });
      return;
    }

    // Helper: status badge (ใช้แบบเดียวกับหน้า dashboard หลัก)
    const statusBadge = (oldRaw: any, newRaw: any) => {
      const oldStr = String(oldRaw ?? '').trim();
      const newStr = String(newRaw ?? '').trim();
      const oldEmpty = oldStr === '' || oldStr === '0';
      const newEmpty = newStr === '' || newStr === '0';
      if (newEmpty && !oldEmpty) return `<span style="color:#6b7280;font-weight:700"><i class="fas fa-minus"></i> ลบ</span>`;
      if (oldEmpty && !newEmpty) return `<span style="color:#16a34a;font-weight:700"><i class="fas fa-plus-circle"></i> เพิ่ม</span>`;
      const oldNum = parseFloat(oldStr);
      const newNum = parseFloat(newStr);
      if (!isNaN(oldNum) && !isNaN(newNum)) {
        if (newNum > oldNum) return `<span style="color:#16a34a;font-weight:700"><i class="fas fa-arrow-up"></i> เพิ่มขึ้น</span>`;
        if (newNum < oldNum) return `<span style="color:#dc2626;font-weight:700"><i class="fas fa-arrow-down"></i> ลดลง</span>`;
        return `<span style="color:#6b7280"><i class="fas fa-equals"></i></span>`;
      }
      return `<span style="color:#d97706;font-weight:700"><i class="fas fa-pen"></i> แก้ไข</span>`;
    };
    const fmt = (v: any) => {
      const s = String(v ?? '').trim();
      return (s === '' || s === 'null') ? '<span style="color:#9ca3af">—</span>' : this.escHtml(s);
    };

    const rows = changes.map(c => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${this.escHtml(c.subName)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#4f46e5;font-weight:700">${this.escHtml(c.field)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${fmt(c.oldVal)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${fmt(c.newVal)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${statusBadge(c.oldVal, c.newVal)}</td>
    </tr>`).join('');

    const summaryTable = `
      <div style="max-height:280px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:10px">
        <table style="width:100%;border-collapse:collapse;font-size:12px;background:white">
          <thead style="position:sticky;top:0;background:#f3f4f6;z-index:1">
            <tr>
              <th style="padding:8px;text-align:left;border-bottom:2px solid #d1d5db">ตัวชี้วัดย่อย</th>
              <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">เดือน</th>
              <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">ค่าเดิม</th>
              <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">ค่าใหม่</th>
              <th style="padding:8px;text-align:center;border-bottom:2px solid #d1d5db">สถานะ</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    const confirmResult = await Swal.fire({
      title: 'ยืนยันการบันทึก',
      html: `<div style="text-align:left;font-size:13px">
              <p style="margin-bottom:8px;font-weight:700;color:#374151">
                พบการเปลี่ยนแปลง <span style="color:#4f46e5">${changes.length}</span> รายการ
              </p>
              ${summaryTable}
              <p style="margin-top:12px;color:#6b7280">ต้องการบันทึกใช่หรือไม่?</p>
             </div>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#10b981',
      confirmButtonText: 'บันทึก',
      cancelButtonText: 'ยกเลิก',
      width: 780,
    });

    if (!confirmResult.isConfirmed) return;

    Swal.fire({ title: `กำลังบันทึก ${changes.length} รายการ...`, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
      const calls = changes.map(c => this.authService.upsertSubResult(c.payload).toPromise());
      const results = await Promise.allSettled(calls);
      const ok = results.filter(r => r.status === 'fulfilled').length;
      const fail = results.length - ok;
      Swal.fire({
        icon: fail > 0 ? 'warning' : 'success',
        title: fail > 0 ? `บันทึก ${ok}/${results.length} รายการ` : 'บันทึกสำเร็จ',
        html: `<p class="text-sm">บันทึก <b>${ok}</b> รายการ${fail > 0 ? `, ล้มเหลว <b class="text-red-500">${fail}</b>` : ''}</p>`,
        timer: 2500, showConfirmButton: false
      });
      // คำนวณ AVG ใหม่ทั้ง modal + dashboard
      this.loadSubResultSummary();
      this.loadSubResultList(); // reload inputs + reset _subOriginal
      this.loadKpiData(true);   // silent reload → main row sync
      this.subEditMode = false; // กลับ read-only
    } catch (e: any) {
      Swal.fire('ผิดพลาด', e?.message || 'บันทึกไม่สำเร็จ', 'error');
    }
  }

  resetData(confirm: boolean = true) {
    const restore = () => {
      this.filteredData.forEach(item => {
        if (item._original) {
          Object.assign(item, item._original);
        }
        item._anomaly = null;
      });
      this.restoreHier();
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
    const fiscalOrder = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    let lastActual = '';
    const formula = activeFormula(item);
    if (formula && !validateFormula(formula, parseCustomVars(item.custom_vars).map(v => v.key))) {
      // ตัวชี้วัดที่ตั้งสูตรคำนวณผลงาน — evaluator เดียวกับ backend (ผลตรงกับ kpi_summary/Export)
      lastActual = evaluateFormula(formula, item, item.target_value, item.prev_year, customValuesOf(item)) ?? '';
    } else if (Number(item.is_cumulative) === 1) {
      // ตัวชี้วัดสะสม: รวมค่าตัวเลขทุกเดือนที่มีข้อมูล
      const nums = fiscalOrder.map(m => parseFloat(item[m])).filter(n => !isNaN(n));
      lastActual = nums.length > 0 ? String(nums.reduce((s, n) => s + n, 0)) : '';
    } else {
      for (const m of fiscalOrder) {
        const v = String(item[m] ?? '').trim();
        if (v && v !== '0') lastActual = v;
      }
    }
    item.last_actual = lastActual;
    item.total_actual = parseFloat(lastActual) || 0;
    this.refreshAnomalies(item);
  }

  // =====================================================================================================
  // เตือนค่าที่อาจผิดปกติ (เช่น พิมพ์ 850 แทน 85) — เตือนเท่านั้น ไม่ห้ามบันทึก | ตรรกะอยู่ใน shared/anomaly.ts
  // ตรวจเฉพาะช่องที่ถูกแก้ในรอบนี้ (ต่างจาก _original) เทียบกับเดือนอื่นของแถวเดียวกัน → ปีงบที่แล้ว → เป้าหมาย
  // =====================================================================================================
  /** ผลงานรายเดือนของปีงบที่แล้ว — key = itemKey(ตัวชี้วัด, หน่วยบริการ, ปีงบของแถวปัจจุบัน) */
  prevYearMonths = new Map<string, any>();

  /** โหลดผลงานปีงบที่แล้ว (จาก kpi_summary ตามขอบเขตสิทธิ์) ของแถวที่แสดงอยู่ — เรียกตอนเข้าโหมดแก้ไข */
  loadPrevYearMonths() {
    this.prevYearMonths = new Map<string, any>();
    const years = Array.from(new Set(this.filteredData.map(i => String(i.year_bh ?? '')).filter(y => /^\d{4}$/.test(y)))).slice(0, 3);
    const hospcodes = Array.from(new Set(this.filteredData.map(i => String(i.hospcode ?? '').trim()).filter(Boolean)));
    for (const year of years) {
      // หน่วยบริการจำนวนมาก (ผู้ดูแลดูทั้งจังหวัด) → ไม่ส่งรายการ ให้ backend คืนตามขอบเขตสิทธิ์ทั้งหมด
      this.authService.getPrevYearMonths(year, hospcodes.length <= 100 ? hospcodes : []).subscribe({
        next: (res: any) => {
          if (!res?.success) return;
          for (const r of res.data || []) this.prevYearMonths.set(itemKey(r.indicator_id, r.hospcode, year), r);
          // แถวที่ถูกแก้ไปแล้วก่อนข้อมูลมาถึง → ตรวจซ้ำด้วยข้อมูลอ้างอิงที่ครบขึ้น
          this.filteredData.forEach(item => { if (item._anomaly !== undefined && this.isRowModified(item)) this.refreshAnomalies(item); });
          this.cdr.detectChanges();
        },
        error: () => { /* ไม่มีข้อมูลอ้างอิงปีที่แล้ว — ยังเตือนจากเดือนอื่น/เป้าหมายได้ */ }
      });
    }
  }

  private isRowModified(item: any): boolean {
    if (!item?._original) return false;
    return EXCEL_MONTHS.some(m => String(item[m.key] ?? '') !== String(item._original[m.key] ?? ''));
  }

  private refreshAnomalies(item: any) {
    if (!item || !item._original) return;
    const keys = EXCEL_MONTHS.map(m => m.key);
    const prev = this.prevYearMonths.get(itemKey(item.indicator_id, item.hospcode, item.year_bh));
    const found: Record<string, Anomaly> = {};
    for (const m of keys) {
      if (String(item[m] ?? '') === String(item._original[m] ?? '')) continue;
      const a = detectAnomaly(item[m], {
        others: keys.filter(k => k !== m).map(k => item[k]),
        prevSame: prev ? prev[m] : null,
        prevAll: prev ? keys.map(k => prev[k]) : [],
        target: item.target_value,
      });
      if (a) found[m] = a;
    }
    item._anomaly = Object.keys(found).length > 0 ? found : null;
  }

  /** รายการช่องที่ถูกเตือนในตารางที่แก้ไขอยู่ (ใช้แสดงจำนวนบนแถบเครื่องมือและในหน้ายืนยันการบันทึก) */
  get anomalyList(): { item: any; month: string; monthName: string; value: string; message: string }[] {
    const out: { item: any; month: string; monthName: string; value: string; message: string }[] = [];
    for (const item of this.filteredData) {
      if (!item._anomaly) continue;
      for (const m of EXCEL_MONTHS) {
        const a: Anomaly | undefined = item._anomaly[m.key];
        if (a) out.push({ item, month: m.key, monthName: m.label, value: String(item[m.key] ?? ''), message: a.message });
      }
    }
    return out;
  }
  get anomalyCount(): number {
    let n = 0;
    for (const item of this.filteredData) if (item._anomaly) n += Object.keys(item._anomaly).length;
    return n;
  }

  // =====================================================================================================
  // นำเข้า / วางผลงานจาก Excel (โหมดแก้ไข) — เติมค่าลงตารางให้ตรวจก่อน แล้วผู้ใช้กด "บันทึก" เองตามขั้นตอนปกติ
  // (สิทธิ์/การล็อค/การยืนยัน ใช้เส้นทางบันทึกเดิมทั้งหมด) | ตรรกะอยู่ใน shared/kpi-excel.ts
  // =====================================================================================================
  get editPerms(): EditPerms {
    return { canEditActual: this.canEditActual, canEditTarget: this.canEditTarget };
  }

  /** ดาวน์โหลดแบบฟอร์ม Excel ของแถวที่แสดงอยู่ (พร้อมค่าปัจจุบัน) — กรอกแล้วนำเข้ากลับได้ */
  downloadExcelTemplate() {
    const items = this.filteredData;
    if (!items.length) { this.toast.warning('ไม่มีรายการในตาราง — ค้นหาข้อมูลก่อนดาวน์โหลดแบบฟอร์ม'); return; }
    import('xlsx').then(XLSX => {
      // คอลัมน์ค่าฐาน/ค่าเพิ่มเติม = รวมทุกชื่อที่แถวในตารางใช้ (แถวที่ไม่มีชื่อนั้นเว้นว่าง)
      const vars: CustomVarDef[] = [];
      for (const it of items) for (const v of this.customVarDefs(it)) if (!vars.some(x => x.key === v.key)) vars.push(v);
      const aoa = buildTemplateAoa(items, { vars });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 30 }, { wch: 55 }, { wch: 28 }, { wch: 22 }, { wch: 10 }, ...EXCEL_MONTHS.map(() => ({ wch: 8 }))];
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: aoa[1].length - 1 } }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ผลงาน');
      const hos = new Set(items.map(i => String(i.hospcode)));
      XLSX.writeFile(wb, `KPI_บันทึกผลงาน_${this.selectedYear || 'all'}_${hos.size === 1 ? Array.from(hos)[0] : hos.size + 'หน่วย'}.xlsx`);
    });
  }

  /** เลือกไฟล์ Excel/CSV → อ่านแผ่นงานแรก → importAoa() */
  onExcelFileSelected(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (input) input.value = '';              // เลือกไฟล์เดิมซ้ำได้
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { Swal.fire('ไฟล์ใหญ่เกินไป', 'รองรับไฟล์ไม่เกิน 10 MB', 'warning'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      import('xlsx').then(XLSX => {
        try {
          const wb = XLSX.read(new Uint8Array(reader.result as ArrayBuffer), { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          this.importAoa(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as any[][], file.name);
        } catch (e: any) {
          Swal.fire('อ่านไฟล์ไม่ได้', 'ไฟล์ไม่ใช่ Excel/CSV ที่ถูกต้อง หรือไฟล์เสียหาย', 'error');
        }
      });
    };
    reader.onerror = () => Swal.fire('อ่านไฟล์ไม่ได้', 'ไม่สามารถเปิดไฟล์ที่เลือก', 'error');
    reader.readAsArrayBuffer(file);
  }

  /** สรุปสิ่งที่จะเปลี่ยนจากไฟล์ให้ผู้ใช้ยืนยัน แล้วเติมลงตาราง (ยังไม่บันทึก) */
  importAoa(aoa: any[][], fileName = '') {
    if (!this.isEditing) return;
    const parsed = parseImportAoa(aoa);
    if (parsed.error) { Swal.fire('นำเข้าไม่ได้', parsed.error, 'error'); return; }
    const plan = planImport(parsed.rows, this.filteredData, this.editPerms);
    const html = this.buildImportPreviewHtml(plan, parsed.rows.length, fileName);
    if (plan.changes.length === 0) {
      Swal.fire({ icon: 'info', title: 'ไม่มีค่าที่ต้องเปลี่ยน', html, confirmButtonText: 'ตกลง', width: 720 });
      return;
    }
    Swal.fire({
      title: 'ตรวจสอบก่อนนำเข้า', html, icon: 'question', width: 780,
      showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: `<i class="fas fa-file-import mr-1"></i> เติมลงตาราง ${plan.changes.length.toLocaleString()} ช่อง`, cancelButtonText: 'ยกเลิก'
    }).then(r => { if (r.isConfirmed) this.applyChangePlan(plan, 'นำเข้า'); });
  }

  /** HTML สรุปผลการอ่านไฟล์ (แยกเป็นฟังก์ชันเพื่อทดสอบได้โดยไม่ต้องเปิดหน้าต่าง) */
  buildImportPreviewHtml(plan: ChangePlan, fileRows: number, fileName = ''): string {
    const esc = (v: any) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
    const label = (f: string) => f === 'target_value' ? 'เป้าหมาย' : f.startsWith('cv_') ? (f === 'cv_base' ? 'ค่าฐาน' : f.slice(3)) : (EXCEL_MONTHS.find(m => m.key === f)?.label || f);
    const line = (n: number, text: string, color: string) => n > 0 ? `<li style="color:${color}">${text} <b>${n.toLocaleString()}</b></li>` : '';
    const rows = plan.changes.slice(0, 30).map(c => `<tr>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb">${esc(c.item.kpi_indicators_name)}<div style="color:#9ca3af;font-size:10px">${esc(c.item.hosname || c.item.hospcode)}</div></td>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:center">${label(c.field)}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:center;color:#6b7280">${esc(c.oldVal) || '—'}</td>
        <td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700">${esc(c.newVal)}</td>
      </tr>`).join('');
    const table = plan.changes.length === 0 ? '' : `
      <div style="max-height:240px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:10px;margin-top:8px">
        <table style="width:100%;border-collapse:collapse;font-size:12px;background:white">
          <thead style="position:sticky;top:0;background:#f3f4f6"><tr>
            <th style="padding:6px 8px;text-align:left">ตัวชี้วัด / หน่วยบริการ</th><th style="padding:6px 8px">ช่อง</th>
            <th style="padding:6px 8px">ค่าเดิม</th><th style="padding:6px 8px">ค่าใหม่</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${plan.changes.length > 30 ? `<p style="font-size:11px;color:#6b7280;margin-top:4px">แสดง 30 จาก ${plan.changes.length.toLocaleString()} ช่อง — ทุกช่องที่เปลี่ยนจะเป็นสีส้มในตารางให้ตรวจอีกครั้ง</p>` : ''}`;
    return `<div style="text-align:left;font-size:13px">
      ${fileName ? `<p style="color:#6b7280;font-size:12px;margin-bottom:6px"><i class="fas fa-file-excel" style="color:#16a34a"></i> ${esc(fileName)} — ${fileRows.toLocaleString()} แถว</p>` : ''}
      <ul style="list-style:disc;margin-left:18px;line-height:1.7">
        <li style="color:#047857">ช่องที่จะเปลี่ยนค่า <b>${plan.changes.length.toLocaleString()}</b></li>
        ${line(plan.same, 'ค่าเท่าเดิม (ไม่เปลี่ยน)', '#6b7280')}
        ${line(plan.locked, 'ข้าม — แถวถูกล็อค', '#b45309')}
        ${line(plan.noPerm, 'ข้าม — ไม่มีสิทธิ์แก้ไขช่องนั้น', '#b45309')}
        ${line(plan.tooLong, 'ข้าม — ข้อความยาวเกิน 100 ตัวอักษร', '#b45309')}
        ${line(plan.unmatchedRows.length, 'ข้าม — แถวในไฟล์ที่ไม่ตรงกับรายการในตารางที่แสดงอยู่', '#b91c1c')}
        ${line(plan.duplicateRows.length, 'ข้าม — แถวซ้ำในไฟล์ (ใช้แถวแรก)', '#b45309')}
      </ul>
      ${plan.unmatchedRows.length ? `<p style="font-size:11px;color:#b91c1c;margin-top:2px">แถวที่ไม่ตรง: ${plan.unmatchedRows.slice(0, 15).join(', ')}${plan.unmatchedRows.length > 15 ? ' …' : ''} — ตรวจปีงบประมาณ/ตัวกรองของตาราง หรือดาวน์โหลดแบบฟอร์มใหม่</p>` : ''}
      ${table}
      <p style="margin-top:10px;font-size:12px;color:#6b7280">ช่องว่างในไฟล์ไม่ทับค่าเดิม • ข้อมูลจะถูก<b>เติมลงตารางเท่านั้น ยังไม่บันทึก</b> — ตรวจแล้วกดปุ่ม "บันทึก"</p>
    </div>`;
  }

  /** เติมค่าตามแผน + คำนวณผลงานล่าสุด/คำเตือนของแถวที่ถูกแก้ + แจ้งผล */
  applyChangePlan(plan: ChangePlan, verb: string) {
    const touched = applyCellChanges(plan.changes);
    touched.forEach(item => this.onValueChange(item, 'oct'));
    this.cdr.detectChanges();
    const skipped = plan.locked + plan.noPerm + plan.tooLong + plan.overflow;
    const warn = this.anomalyCount;
    let msg = `${verb}แล้ว ${plan.changes.length.toLocaleString()} ช่อง ใน ${touched.length.toLocaleString()} รายการ`;
    if (skipped > 0) msg += ` (ข้าม ${skipped.toLocaleString()} ช่องที่ล็อค/ไม่มีสิทธิ์/เกินตาราง)`;
    if (plan.changes.length === 0) { this.toast.warning(skipped > 0 ? `ไม่มีช่องที่${verb}ได้ — ข้าม ${skipped.toLocaleString()} ช่องที่ล็อค/ไม่มีสิทธิ์/เกินตาราง` : `ไม่มีค่าที่ต้องเปลี่ยน`); return; }
    if (warn > 0) this.toast.warning(`${msg} — พบค่าที่อาจผิดปกติ ${warn} ช่อง (สีแดง) กรุณาตรวจสอบก่อนบันทึก`);
    else this.toast.success(`${msg} — ตรวจสอบแล้วกด "บันทึก"`);
  }

  /** วางหลายช่องที่คัดลอกจาก Excel ลงตารางแก้ไข เริ่มจากช่องที่วาง ไล่ลงและไปทางขวา (วางช่องเดียว = พฤติกรรมปกติของเบราว์เซอร์) */
  onCellPaste(ev: ClipboardEvent, item: any, field: string) {
    if (!this.isEditing) return;
    const grid = parseClipboardGrid(ev.clipboardData?.getData('text/plain') ?? '');
    if (!isMultiCell(grid)) return;
    ev.preventDefault();
    const rows = this.filteredData;
    // คอลัมน์ที่แก้ไขได้ตามลำดับที่แสดง: เป้าหมาย → เดือนที่แสดงอยู่ (ข้ามคอลัมน์ผลงานล่าสุด/ร้อยละ ที่คั่นกลางบนจอ)
    const fields = [...(this.colVisible['target'] ? ['target_value'] : []), ...this.visibleMonthKeys];
    const startRow = rows.indexOf(item), startCol = fields.indexOf(field);
    if (startRow < 0 || startCol < 0) return;
    this.applyChangePlan(planPaste(grid, rows, startRow, fields.slice(startCol), this.editPerms), 'วาง');
  }

  // ร้อยละ/ผ่านเกณฑ์ ตามเงื่อนไขเป้าหมายของตัวชี้วัด (target_condition ≥ > ≤ < =) — shared/kpi-target.ts (สำเนาเดียวกับ backend) — 22 ต.ค. 2569
  //   ≥ / > : ผลงาน ÷ เป้าหมาย × 100 (เดิม) | ≤ / < : เป้าหมาย ÷ ผลงาน × 100 (ผลงาน 0 = 100) | = : ค่าน้อย ÷ ค่ามาก × 100
  // ไม่มีเป้าหมาย/ผลงาน → ร้อยละ 0 และไม่ระบายแดง (เหมือนเดิม)
  calcPercent(item: any): number {
    // ตัวชี้วัดที่ตั้งสูตรร้อยละ (pct_formula) — ใช้สูตรแทน (ผ่าน/ไม่ผ่านยังเทียบผลงานกับเป้าหมายตามเงื่อนไข)
    if (pctFormulaOf(item)) return evaluatePct(item) ?? 0;
    return evaluateTarget(item.last_actual, item.target_value, item.target_condition).pct ?? 0;
  }

  isTargetMet(item: any): boolean {
    const r = evaluateTarget(item.last_actual, item.target_value, item.target_condition);
    // ไม่มีเป้าหมาย → ไม่แสดงสีแดง | มีเป้าหมายแต่ยังไม่มีผลงาน → ไม่ผ่าน (เหมือนเดิม)
    if (r.pass === null) return !String(item.target_value ?? '').trim() || !!String(item.last_actual ?? '').trim();
    return r.pass;
  }

  // สัญลักษณ์เงื่อนไขหน้าค่าเป้าหมาย (เช่น "≤") — แสดงเฉพาะเมื่อตั้งเงื่อนไขไว้ (ไม่ได้ตั้ง = ≥ ไม่แสดง กันรก)
  conditionSymbol(item: any): string {
    const raw = String(item?.target_condition ?? '').trim();
    return raw ? CONDITION_SYMBOL[normalizeCondition(raw)] : '';
  }
  conditionTitle(item: any): string {
    const c = normalizeCondition(item?.target_condition);
    const how = c === 'LTE' || c === 'LT' ? 'ร้อยละ = เป้าหมาย ÷ ผลงาน × 100 (ยิ่งน้อยยิ่งดี)'
      : c === 'EQ' ? 'ร้อยละ = ค่าน้อย ÷ ค่ามาก × 100 (ความใกล้เคียงเป้าหมาย)' : 'ร้อยละ = ผลงาน ÷ เป้าหมาย × 100';
    return `ผ่านเมื่อผลงาน${CONDITION_LABEL[c]}เป้าหมาย — ${how}`;
  }

  // แปลง hostypecode → ตัวย่อสั้น (เช่น '07' → 'รพช.')
  private readonly HOS_TYPE_ABBR: { [k: string]: string } = {
    '01': 'สสจ.', '02': 'สสอ.', '03': 'สอ.', '04': 'สบช.',
    '05': 'รพศ.', '06': 'รพท.', '07': 'รพช.',
    '08': 'ศสช.', '09': 'ศสช.', '10': 'ศว.',
    '11': 'รพ.นอกสป.', '12': 'รพ.นอกสธ.', '13': 'ศบส.',
    '14': 'ศสช.', '15': 'รพ.เอกชน', '16': 'คลินิก',
    '17': 'รพ.สาขา', '18': 'รพ.สต.',
  };
  getHosTypeAbbr(code: any): string {
    const c = String(code ?? '').trim();
    return this.HOS_TYPE_ABBR[c] || c;
  }

  // ดึง badge "ตัวชี้วัดของ" — แสดงขอบเขตหน่วยบริการที่ตัวชี้วัดใช้
  // evaluation_mode='all_required' → ทุกประเภท
  // evaluation_mode='any_one' + required_off_types=["05","06","07"] → รายชื่อประเภท
  getIndicatorOffTypeBadge(item: any): { label: string; title: string; color: string } | null {
    const mode = item?.evaluation_mode;
    if (mode === 'all_required') {
      return { label: 'ทุกประเภท', title: 'ตัวชี้วัดของ: ทุกประเภทหน่วยบริการ', color: 'bg-purple-100 text-purple-700 border border-purple-200' };
    }
    if (mode !== 'any_one') return null;
    let codes: string[] = [];
    try {
      const raw = item?.required_off_types;
      if (Array.isArray(raw)) codes = raw.map((x: any) => String(x));
      else if (raw) { const p = JSON.parse(String(raw)); if (Array.isArray(p)) codes = p.map((x: any) => String(x)); }
    } catch { codes = []; }
    if (codes.length === 0) return null;
    const names = codes.map(c => {
      const ht = (this._allHosTypes || []).find((x: any) => x.hostypecode === c);
      return ht?.hostypename || c;
    });
    const label = codes.length <= 2 ? names.join(', ') : `${codes.length} ประเภท`;
    const title = `ตัวชี้วัดของ: ${names.join(', ')}`;
    return { label, title, color: 'bg-cyan-100 text-cyan-700 border border-cyan-200' };
  }

  // badge "สะสม" — is_cumulative=1 → ผลงานล่าสุดคำนวณจาก SUM ทุกเดือนในปีงบ แทนค่าเดือนล่าสุด
  getCumulativeBadge(item: any): { label: string; title: string; color: string; icon: string; formula?: string } | null {
    const formula = activeFormula(item);
    if (formula) {
      // มีสูตร → แสดง badge "สูตร" แทน "สะสม" (สูตรมีลำดับความสำคัญเหนือ is_cumulative)
      // สูตรอ้างปีงบที่แล้ว → บอกปีและผลงานปีที่แล้วที่ใช้คำนวณ (backend แนบมาใน prev_year)
      let title = `ผลงานคำนวณตามสูตร: ${formula}`;
      const prev = item?.prev_year;
      if (prev) {
        title += prev.result != null && String(prev.result).trim() !== ''
          ? `\nใช้ข้อมูลปีงบ ${prev.year_bh}: ผลงานปีที่แล้ว = ${prev.result}`
          : `\nสูตรอ้างข้อมูลปีงบ ${prev.year_bh} แต่ยังไม่มีผลงานของปีนั้น`;
      }
      return { label: 'สูตร', title, color: 'bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200', icon: 'fa-calculator', formula };
    }
    if (Number(item?.is_cumulative) !== 1) return null;
    return { label: 'สะสม', title: 'ผลงานเดือนล่าสุด = ผลรวมสะสมตั้งแต่ตุลาคมถึงเดือนนี้', color: 'bg-violet-100 text-violet-700 border border-violet-200', icon: 'fa-layer-group' };
  }

  // badge แหล่งที่มาข้อมูล — 3 สถานะ ตาม kpi_indicators.data_source/khd_report_id (link ถาวรกับ KHD reports.report_id ผ่าน table_process)
  // key_in = KHD data_source='excel' (คีย์เอง), hdc = KHD data_source='hdc' (ดึงอัตโนมัติ), local-only = ไม่พบเทียบเคียงกับ KHD เลย
  getSourceBadge(item: any): { label: string; icon: string; color: string; title: string } {
    if (item?.khd_report_id && item?.data_source === 'hdc') {
      return { label: 'hdc', icon: 'fa-server', color: 'bg-indigo-100 text-indigo-700 border border-indigo-200', title: 'ข้อมูลจาก HDC (ดึงอัตโนมัติ)' };
    }
    if (item?.khd_report_id && item?.data_source === 'excel') {
      return { label: 'key_in', icon: 'fa-keyboard', color: 'bg-sky-100 text-sky-700 border border-sky-200', title: 'คีย์ข้อมูลเอง (key_in)' };
    }
    return { label: 'local-only', icon: 'fa-desktop', color: 'bg-gray-100 text-gray-500 border border-gray-200', title: 'ไม่พบเทียบเคียงกับ KHD (local-only)' };
  }

  // ดึงประเภทตัวชี้วัด (R9, MOPH, SSJ, RMW, Other)
  getIndicatorTypes(item: any): Array<{type: string, color: string, label: string}> {
    const types: Array<{type: string, color: string, label: string}> = [];

    if (item.r9 && String(item.r9).trim()) {
      types.push({ type: 'r9', color: 'bg-blue-100 text-blue-700', label: 'R9' });
    }
    if (item.moph && String(item.moph).trim()) {
      types.push({ type: 'moph', color: 'bg-red-100 text-red-700', label: 'MOPH' });
    }
    if (item.ssj && String(item.ssj).trim()) {
      types.push({ type: 'ssj', color: 'bg-green-100 text-green-700', label: 'SSJ' });
    }
    if (item.rmw && String(item.rmw).trim()) {
      types.push({ type: 'rmw', color: 'bg-yellow-100 text-yellow-700', label: 'RMW' });
    }
    if (item.other && String(item.other).trim()) {
      types.push({ type: 'other', color: 'bg-gray-100 text-gray-700', label: 'อื่นๆ' });
    }

    return types;
  }

  isModified(item: any, month: string): boolean {
    if (!item._original) return false;
    return item[month] != item._original[month];
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  openRejectModal(item: any) {
    this.rejectingItem = item;
    this.rejectComment = '';
    this.rejectSelectedMonths = [];
    this.showRejectModal = true;
  }

  toggleRejectMonth(key: string) {
    const idx = this.rejectSelectedMonths.indexOf(key);
    if (idx >= 0) {
      this.rejectSelectedMonths.splice(idx, 1);
    } else {
      this.rejectSelectedMonths.push(key);
    }
  }

  confirmReject() {
    if (this.rejectSelectedMonths.length === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกเดือนที่ต้องแก้ไขอย่างน้อย 1 เดือน', 'warning');
      return;
    }
    if (!this.rejectComment.trim()) {
      Swal.fire('แจ้งเตือน', 'กรุณาระบุเหตุผลการส่งคืนแก้ไข', 'warning');
      return;
    }
    const data = {
      indicator_id: this.rejectingItem.indicator_id,
      year_bh: this.rejectingItem.year_bh,
      hospcode: this.rejectingItem.hospcode,
      comment: this.rejectComment,
      reject_months: this.rejectSelectedMonths
    };
    this.authService.rejectKpi(data).subscribe({
      next: (res) => {
        if (res.success) {
          this.showRejectModal = false;
          this.toast.success('ส่งคืนแก้ไขเรียบร้อยแล้ว');
          this.loadKpiData();
        }
      },
      error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งคืนแก้ไขได้')
    });
  }

  rejectAll() {
    const pendingItems = this.filteredData.filter(item => item.pending_count > 0);
    if (pendingItems.length === 0) return;

    // สร้าง month checkboxes HTML
    const monthOpts = [
      { key: 'oct', name: 'ต.ค.' }, { key: 'nov', name: 'พ.ย.' }, { key: 'dece', name: 'ธ.ค.' },
      { key: 'jan', name: 'ม.ค.' }, { key: 'feb', name: 'ก.พ.' }, { key: 'mar', name: 'มี.ค.' },
      { key: 'apr', name: 'เม.ย.' }, { key: 'may', name: 'พ.ค.' }, { key: 'jun', name: 'มิ.ย.' },
      { key: 'jul', name: 'ก.ค.' }, { key: 'aug', name: 'ส.ค.' }, { key: 'sep', name: 'ก.ย.' }
    ];
    const monthCheckboxes = monthOpts.map(m =>
      `<label style="display:inline-flex;align-items:center;gap:4px;margin:4px 6px;font-size:13px;cursor:pointer;">
        <input type="checkbox" name="reject_month" value="${m.key}" style="accent-color:#ef4444;"> ${m.name}
      </label>`
    ).join('');

    Swal.fire({
      title: 'ส่งคืนแก้ไขทั้งหมด',
      html: `<div class="text-left">
        <p class="text-sm text-gray-600 mb-2">จำนวน ${pendingItems.length} รายการ</p>
        <label class="block text-sm font-bold text-gray-700 mb-1">เดือนที่ต้องแก้ไข <span class="text-red-500">*</span></label>
        <div style="display:flex;flex-wrap:wrap;margin-bottom:12px;">${monthCheckboxes}</div>
        <label class="block text-sm font-bold text-gray-700 mb-1">เหตุผลการส่งคืนแก้ไข <span class="text-red-500">*</span></label>
        <textarea id="swal-reject-comment" rows="3" placeholder="กรุณาระบุเหตุผล..." style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;"></textarea>
      </div>`,
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: `ส่งคืนทั้งหมด (${pendingItems.length})`,
      cancelButtonText: 'ยกเลิก',
      width: 520,
      preConfirm: () => {
        const checkedMonths = Array.from(document.querySelectorAll('input[name="reject_month"]:checked')).map((el: any) => el.value);
        const comment = (document.getElementById('swal-reject-comment') as HTMLTextAreaElement)?.value || '';
        if (checkedMonths.length === 0) { Swal.showValidationMessage('กรุณาเลือกเดือนที่ต้องแก้ไข'); return false; }
        if (!comment.trim()) { Swal.showValidationMessage('กรุณาระบุเหตุผล'); return false; }
        return { months: checkedMonths, comment: comment.trim() };
      }
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        const rejections = pendingItems.map(item => ({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          comment: result.value.comment,
          reject_months: result.value.months
        }));
        this.authService.rejectKpi(rejections).subscribe({
          next: (res) => {
            this.toast.success(`ส่งคืนแก้ไขเรียบร้อยแล้ว ${pendingItems.length} รายการ`);
            this.selectedStatus = '';
            this.loadKpiData();
            this.loadDashboardStats();
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งคืนแก้ไขได้')
        });
      }
    });
  }

  private handleApiError(err: HttpErrorResponse, defaultMsg: string) {
    if (err.status === 401 || err.status === 403) {
      Swal.fire({
        icon: 'warning',
        title: 'เซสชันหมดอายุ',
        text: 'กรุณาเข้าสู่ระบบใหม่',
        confirmButtonText: 'เข้าสู่ระบบ'
      }).then(() => {
        this.authService.logout();
        this.router.navigate(['/login']);
      });
    } else {
      Swal.fire('ผิดพลาด', err.error?.message || defaultMsg, 'error');
    }
  }

  viewRejectionHistory(item: any) {
    this.authService.getRejectionComments(item.indicator_id, item.year_bh, item.hospcode).subscribe({
      next: (res) => {
        if (res.success) {
          const monthNames: any = {
            oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
            apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
          };
          const allHistory = res.data.map((h: any) => ({
            ...h,
            reject_months_display: h.reject_months
              ? h.reject_months.split(',').map((m: string) => monthNames[m.trim()] || m.trim()).join(', ')
              : ''
          }));
          // แสดงเฉพาะรายการล่าสุด (1 รายการ)
          this.rejectionHistory = allHistory.slice(0, 1);
          this.rejectionHistoryFull = allHistory;
          this.showRejectionHistoryModal = true;
          this.cdr.detectChanges();

          // หน่วยบริการ: เมื่อดูประวัติตีกลับจากช่องสถานะ ให้ mark notification เป็นอ่านแล้วด้วย
          if (!this.isAdmin) {
            this.markRelatedNotificationsRead(item);
          }
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', 'ไม่สามารถดึงข้อมูลได้', 'error')
    });
  }

  markRelatedNotificationsRead(item: any) {
    // ดึง notifications ที่เกี่ยวข้องกับตัวชี้วัดนี้แล้ว mark as read
    this.authService.getNotifications().subscribe({
      next: (res) => {
        if (res.success) {
          const unreadIds = res.data
            .filter((n: any) => !n.is_read && n.type === 'reject' &&
              n.indicator_id === item.indicator_id &&
              n.year_bh === item.year_bh)
            .map((n: any) => n.id);
          if (unreadIds.length > 0) {
            this.authService.markNotificationsRead({ ids: unreadIds }).subscribe({
              next: () => {
                this.authService.refreshUnreadCount();
                // โหลดข้อมูลใหม่เพื่ออัปเดตสถานะ (Rejected → Resubmit)
                this.loadKpiData();
              }
            });
          }
        }
      }
    });
  }

  goToNotificationsReject() {
    this.showRejectionHistoryModal = false;
    this.router.navigate(['/notifications'], { queryParams: { filter: 'reject' } });
  }

  openReplyModal(item: any) {
    this.replyingItem = item;
    this.replyMessage = '';
    this.replyRejectionInfo = null;
    // โหลดเหตุผลตีกลับล่าสุด
    this.authService.getRejectionComments(item.indicator_id, item.year_bh, item.hospcode).subscribe({
      next: (res) => {
        if (res.success && res.data.length > 0) {
          const latest = res.data.find((h: any) => h.type === 'reject') || res.data[0];
          const monthNames: any = {
            oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
            apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
          };
          this.replyRejectionInfo = {
            ...latest,
            reject_months_display: latest.reject_months
              ? latest.reject_months.split(',').map((m: string) => monthNames[m.trim()] || m.trim()).join(', ')
              : ''
          };
        }
        this.showReplyModal = true;
        this.cdr.detectChanges();
      },
      error: () => {
        this.showReplyModal = true;
        this.cdr.detectChanges();
      }
    });
  }

  confirmReply() {
    const data = {
      indicator_id: this.replyingItem.indicator_id,
      year_bh: this.replyingItem.year_bh,
      hospcode: this.replyingItem.hospcode,
      message: this.replyMessage
    };
    this.authService.replyKpi(data).subscribe({
      next: (res) => {
        if (res.success) {
          this.showReplyModal = false;
          this.toast.success('ส่งตอบกลับเรียบร้อยแล้ว สถานะเปลี่ยนเป็น "รอตรวจสอบ"');
          this.loadKpiData();
        }
      },
      error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งตอบกลับได้')
    });
  }

  // === Target Edit Request Workflow ===

  loadTargetEditRequests() {
    this.authService.getTargetEditRequests().subscribe({
      next: (res) => {
        if (res.success) {
          this.targetEditRequests = res.data;
          this.cdr.detectChanges();
        }
      }
    });
  }

  getTargetEditRequest(item: any): any {
    return this.targetEditRequests.find(r =>
      r.indicator_id == item.indicator_id &&
      r.year_bh == item.year_bh &&
      r.hospcode == item.hospcode
    ) || null;
  }

  requestTargetEdit(item: any) {
    Swal.fire({
      title: 'ขอแก้ไขเป้าหมาย',
      html: `<p class="text-sm font-semibold">${item.kpi_indicators_name}</p><p class="text-xs text-gray-500 mt-1">ปีงบ ${item.year_bh} | ${item.hosname || item.hospcode}</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'ส่งคำขอ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#f97316'
    }).then((result) => {
      if (!result.isConfirmed) return;
      this.authService.requestTargetEdit({
        indicator_id: item.indicator_id,
        year_bh: item.year_bh,
        hospcode: item.hospcode
      }).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'ส่งคำขอแล้ว', text: 'รอการอนุมัติจาก Admin', timer: 2000, showConfirmButton: false });
            this.loadTargetEditRequests();
            this.authService.refreshUnreadCount();
          } else {
            Swal.fire('ผิดพลาด', res.message, 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งคำขอได้')
      });
    });
  }

  approveTargetRequest(request: any) {
    Swal.fire({
      title: 'อนุมัติคำขอแก้ไขเป้าหมาย?',
      html: `<p class="text-sm">จาก: <b>${request.requested_by_name || request.username || ''}</b></p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'อนุมัติ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#16a34a'
    }).then((result) => {
      if (!result.isConfirmed) return;
      this.authService.approveTargetEditRequest(request.id).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'อนุมัติแล้ว', timer: 1500, showConfirmButton: false });
            this.loadTargetEditRequests();
            this.authService.refreshUnreadCount();
          } else {
            Swal.fire('ผิดพลาด', res.message, 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถอนุมัติได้')
      });
    });
  }

  rejectTargetRequest(request: any) {
    Swal.fire({
      title: 'ปฏิเสธคำขอแก้ไขเป้าหมาย?',
      input: 'text',
      inputLabel: 'เหตุผลการปฏิเสธ (ถ้ามี)',
      inputPlaceholder: 'ระบุเหตุผล...',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'ปฏิเสธ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626'
    }).then((result) => {
      if (!result.isConfirmed) return;
      this.authService.rejectTargetEditRequest(request.id, result.value || '').subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'ปฏิเสธแล้ว', timer: 1500, showConfirmButton: false });
            this.loadTargetEditRequests();
            this.authService.refreshUnreadCount();
          } else {
            Swal.fire('ผิดพลาด', res.message, 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถปฏิเสธได้')
      });
    });
  }

  // helper: ตรวจสอบว่าควรแสดง input ช่องเป้าหมายหรือไม่
  canShowTargetInput(item: any): boolean {
    if (item.is_locked) return false;
    if (this.isEditing && this.canEditTarget) return true;
    if (this.isSingleEditing(item)) return true;
    if (this.isEditingTarget(item)) return true;
    return false;
  }

  // === แก้ไขเป้าหมายรายข้อ (ทุกสิทธิ์เมื่อไม่ล็อค / ผ่านอนุมัติเมื่อล็อค) ===

  startEditTarget(item: any) {
    item._originalTarget = item.target_value;
    item._editingTarget = true;
    this.cdr.detectChanges();
  }

  isEditingTarget(item: any): boolean {
    return item._editingTarget === true;
  }

  cancelEditTarget(item: any) {
    item.target_value = item._originalTarget;
    item._editingTarget = false;
    this.cdr.detectChanges();
  }

  saveTargetOnly(item: any) {
    if (String(item.target_value ?? '') === String(item._originalTarget ?? '')) {
      Swal.fire({ icon: 'info', title: 'ไม่มีการเปลี่ยนแปลง', text: 'ค่าเป้าหมายไม่ได้รับการแก้ไข', timer: 1500, showConfirmButton: false });
      item._editingTarget = false;
      this.cdr.detectChanges();
      return;
    }
    const oldVal = item._originalTarget;
    const newVal = item.target_value;

    Swal.fire({
      title: 'ยืนยันแก้ไขเป้าหมาย',
      html: `<p class="text-sm"><b>${item.kpi_indicators_name}</b></p><p class="mt-2">เป้าหมาย: <b>${oldVal}</b> → <b class="text-orange-600">${newVal}</b></p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'บันทึก',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#f97316'
    }).then((result) => {
      if (!result.isConfirmed) return;
      const payload = [{
        indicator_id: item.indicator_id,
        year_bh: item.year_bh,
        hospcode: item.hospcode,
        target_value: item.target_value,
        oct: item.oct, nov: item.nov, dece: item.dece,
        jan: item.jan, feb: item.feb, mar: item.mar,
        apr: item.apr, may: item.may, jun: item.jun,
        jul: item.jul, aug: item.aug, sep: item.sep
      }];
      this.authService.updateKpiResults(payload).subscribe({
        next: (res) => {
          if (res.success) {
            item._originalTarget = item.target_value;
            item._editingTarget = false;
            this.cdr.detectChanges();
            // ปิด request ถ้ามีการอนุมัติไว้
            const request = this.getTargetEditRequest(item);
            if (request && request.status === 'approved') {
              this.authService.completeTargetEditRequest(request.id).subscribe({
                next: () => {
                  this.loadTargetEditRequests();
                  this.authService.refreshUnreadCount();
                }
              });
            }
            Swal.fire({ icon: 'success', title: 'บันทึกเป้าหมายแล้ว', timer: 1500, showConfirmButton: false });
          } else {
            Swal.fire('ผิดพลาด', res.message || 'ไม่สามารถบันทึกได้', 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถบันทึกเป้าหมายได้')
      });
    });
  }

  // === แก้ไขเฉพาะข้อ (จากอุทธรณ์ที่ได้รับอนุมัติ) ===

  startEditSingle(item: any) {
    item._anomaly = null;
    item._original = { ...item };
    this.editingSingleItem = item;
    Swal.fire({ icon: 'info', title: 'แก้ไขข้อที่อุทธรณ์', text: `กำลังแก้ไข: ${item.kpi_indicators_name}`, timer: 1500, showConfirmButton: false });
  }

  isSingleEditing(item: any): boolean {
    return this.editingSingleItem &&
      this.editingSingleItem.indicator_id === item.indicator_id &&
      this.editingSingleItem.year_bh === item.year_bh &&
      this.editingSingleItem.hospcode === item.hospcode;
  }

  cancelEditSingle() {
    if (this.editingSingleItem && this.editingSingleItem._original) {
      const orig = this.editingSingleItem._original;
      Object.assign(this.editingSingleItem, orig);
      this.editingSingleItem._anomaly = null;
    }
    this.editingSingleItem = null;
  }

  saveSingleItem() {
    const item = this.editingSingleItem;
    if (!item || !item._original) return;

    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const hasChange = String(item.target_value ?? '') !== String(item._original.target_value ?? '') ||
      months.some(m => String(item[m] ?? '') !== String(item._original[m] ?? ''));

    if (!hasChange) {
      Swal.fire('ไม่มีการเปลี่ยนแปลง', 'ไม่พบข้อมูลที่แก้ไข', 'info');
      return;
    }

    const cleanData = [{
      indicator_id: item.indicator_id,
      year_bh: item.year_bh,
      hospcode: item.hospcode,
      target_value: item.target_value,
      oct: item.oct, nov: item.nov, dece: item.dece,
      jan: item.jan, feb: item.feb, mar: item.mar,
      apr: item.apr, may: item.may, jun: item.jun,
      jul: item.jul, aug: item.aug, sep: item.sep
    }];

    Swal.fire({
      title: 'ยืนยันบันทึกและส่งตรวจสอบ',
      html: `<p class="text-sm">บันทึกข้อมูล <b>${item.kpi_indicators_name}</b> และส่งให้ Admin ตรวจสอบรับรอง</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'บันทึกและส่งตรวจสอบ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#10b981'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        this.authService.updateKpiResults(cleanData).subscribe({
          next: (res) => {
            if (res.success) {
              // แจ้ง admin ว่าแก้ไขข้อมูลอุทธรณ์เสร็จแล้ว
              this.authService.notifyAppealEdited({
                indicator_id: item.indicator_id,
                year_bh: item.year_bh,
                hospcode: item.hospcode
              }).subscribe();

              this.editingSingleItem = null;
              this.toast.success('บันทึกข้อมูลและแจ้ง Admin ให้ตรวจสอบรับรองเรียบร้อยแล้ว');
              this.loadKpiData();
            } else {
              Swal.fire('ผิดพลาด', res.message, 'error');
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถบันทึกข้อมูลได้')
        });
      }
    });
  }

  // === ระบบอุทธรณ์ ===

  openAppealModal(item: any) {
    this.appealReason = '';
    Swal.fire({
      title: 'ยื่นอุทธรณ์ขอแก้ไขคะแนน',
      html: `<div class="text-left text-sm mb-3">
        <p class="font-bold">${item.kpi_indicators_name}</p>
        <p class="text-gray-500">ปี ${item.year_bh} | ${item.hosname || item.hospcode}</p>
      </div>`,
      input: 'textarea',
      inputLabel: 'เหตุผลในการยื่นอุทธรณ์',
      inputPlaceholder: 'ระบุเหตุผลที่ต้องการขอแก้ไขคะแนน...',
      inputValidator: (value) => !value ? 'กรุณาระบุเหตุผล' : null,
      showCancelButton: true,
      confirmButtonText: 'ยื่นอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#7c3aed'
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        this.authService.appealKpi({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          reason: result.value
        }).subscribe({
          next: (res) => {
            if (res.success) {
              this.toast.success('ยื่นอุทธรณ์เรียบร้อยแล้ว รอ Admin พิจารณา');
              this.loadKpiData();
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถยื่นอุทธรณ์ได้')
        });
      }
    });
  }

  approveAppeal(item: any) {
    Swal.fire({
      title: 'อนุมัติอุทธรณ์',
      html: `<p class="text-sm">อนุมัติอุทธรณ์ <b>${item.kpi_indicators_name}</b><br>ข้อมูลจะถูกปลดล็อคให้หน่วยบริการแก้ไขได้</p>`,
      input: 'textarea',
      inputLabel: 'ความเห็น (ไม่บังคับ)',
      inputPlaceholder: 'ระบุความเห็นเพิ่มเติม...',
      showCancelButton: true,
      confirmButtonText: 'อนุมัติอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#16a34a'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.approveAppeal({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          comment: result.value || ''
        }).subscribe({
          next: (res) => {
            if (res.success) {
              this.toast.success('อนุมัติอุทธรณ์เรียบร้อย ข้อมูลถูกปลดล็อคแล้ว');
              this.loadKpiData();
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถอนุมัติอุทธรณ์ได้')
        });
      }
    });
  }

  rejectAppeal(item: any) {
    Swal.fire({
      title: 'ปฏิเสธอุทธรณ์',
      html: `<p class="text-sm">ปฏิเสธอุทธรณ์ <b>${item.kpi_indicators_name}</b><br>ข้อมูลจะยังคงถูกล็อคไว้</p>`,
      input: 'textarea',
      inputLabel: 'เหตุผลในการปฏิเสธ',
      inputPlaceholder: 'ระบุเหตุผลที่ปฏิเสธอุทธรณ์...',
      inputValidator: (value) => !value ? 'กรุณาระบุเหตุผล' : null,
      showCancelButton: true,
      confirmButtonText: 'ปฏิเสธอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626'
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        this.authService.rejectAppeal({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          comment: result.value
        }).subscribe({
          next: (res) => {
            if (res.success) {
              this.toast.success('ปฏิเสธอุทธรณ์เรียบร้อย');
              this.loadKpiData();
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถปฏิเสธอุทธรณ์ได้')
        });
      }
    });
  }

  // ============================================================
  // === Dynamic Form Modal (แบบฟอร์มบันทึกข้อมูล KPI) ===
  // ============================================================

  // โหลดเดือนที่มีข้อมูลจาก dynamic form สำหรับแต่ละ item ที่มี form schema
  private monthBhToKey: any = { 10: 'oct', 11: 'nov', 12: 'dece', 1: 'jan', 2: 'feb', 3: 'mar', 4: 'apr', 5: 'may', 6: 'jun', 7: 'jul', 8: 'aug', 9: 'sep' };

  loadDynamicFormMonths() {
    const items = this.kpiData.filter(i => i.table_process && i.has_form_schema);
    if (!items.length) return;

    // Reset _formMonths ทุกแถวก่อน
    for (const item of items) item._formMonths = {};

    // group by year_bh เพื่อยิง batch ต่อปี (ปกติ filter เลือกปีเดียว = 1 batch)
    const byYear = new Map<string, any[]>();
    for (const item of items) {
      const y = String(item.year_bh || '');
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push(item);
    }

    for (const [year, group] of byYear.entries()) {
      const payload = group.map(it => ({
        table_process: it.table_process,
        hospcode: String(it.hospcode || '')
      }));
      this.authService.getDynamicDataMonthsBatch(year, payload).subscribe({
        next: (res) => {
          if (!res?.success || !res.data) return;
          const map = res.data as Record<string, number[]>;
          for (const item of group) {
            const k = `${item.table_process}|${item.hospcode}`;
            const months = map[k] || [];
            for (const mb of months) {
              const key = this.monthBhToKey[Number(mb)];
              if (key) item._formMonths[key] = true;
            }
          }
          this.cdr.detectChanges();
        }
      });
    }
  }

  hasFormData(item: any, month: string): boolean {
    return item._formMonths && item._formMonths[month];
  }

  openDynamicForm(item: any) {
    // ตรวจสอบล็อค (user ถูกล็อค + item ถูกล็อค)
    if (this.isEntryLocked) {
      Swal.fire('ล็อคการคีย์', this.dataEntryLock.lock_reason || 'ระบบปิดการคีย์ข้อมูลชั่วคราว', 'warning');
      return;
    }
    if (item.is_locked) {
      Swal.fire('ล็อคข้อมูล', 'ตัวชี้วัดนี้ถูกล็อคแล้ว ไม่สามารถคีย์ข้อมูลได้', 'warning');
      return;
    }

    this.dynamicFormItem = item;
    this.dynamicFormTab = 'form';
    this.dynamicFormData = {};
    this.dynamicDataList = [];
    this.dynamicFormSchema = null;
    this.dynamicFormUsedMonths = [];
    this.dynamicMonthlyRows = {};
    this.dynamicMonthlyOriginal = {};
    this.dynamicEditMode = false;
    // สร้าง availableYears (ปีงบฯ ± 2 ปีปัจจุบัน)
    const currentYear = getCurrentFiscalYear();
    this.availableYears = [
      String(currentYear + 1), String(currentYear), String(currentYear - 1), String(currentYear - 2)
    ];
    this.dynamicFormData.year_bh = item.year_bh || String(currentYear);
    this.dynamicFormData.hospcode = item.hospcode || this.currentUser?.hospcode;
    this.dynamicFormData.indicator_id = item.indicator_id;

    // โหลด schema
    this.authService.getFormSchemaByIndicator(item.indicator_id).subscribe({
      next: (res) => {
        if (res.success && res.data) {
          this.dynamicFormSchema = res.data;
          this.showDynamicFormModal = true;
          // โหลดข้อมูลรายเดือนทั้ง 12 เดือน + เดือนที่คีย์ไปแล้ว
          this.loadDynamicMonthlyRows();
          this.loadDynamicFormUsedMonths();
          this.cdr.detectChanges();
        } else {
          Swal.fire('แจ้งเตือน', 'ยังไม่มีแบบฟอร์มสำหรับตัวชี้วัดนี้', 'info');
        }
      },
      error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดแบบฟอร์มได้', 'error')
    });
  }

  // โหลดข้อมูล 12 เดือน (year+hospcode+indicator) → map by month_bh
  loadDynamicMonthlyRows() {
    if (!this.dynamicFormSchema?.table_process) return;
    this.isDynamicDataLoading = true;
    const params: any = {
      hospcode: this.dynamicFormData.hospcode || this.dynamicFormItem.hospcode,
      year_bh: this.dynamicFormData.year_bh,
      indicator_id: this.dynamicFormItem.indicator_id
    };
    this.authService.getDynamicData(this.dynamicFormSchema.table_process, params).subscribe({
      next: (res) => {
        this.isDynamicDataLoading = false;
        const rowsByMonth: { [m: number]: any } = {};
        if (res.success && Array.isArray(res.data)) {
          for (const row of res.data) {
            const m = Number(row.month_bh);
            if (m >= 1 && m <= 12) rowsByMonth[m] = { ...row };
          }
          this.dynamicDataList = res.data;
        }
        // เติม placeholder เปล่าให้ครบทุกเดือน
        for (const m of this.subMonthColumns) {
          if (!rowsByMonth[m]) rowsByMonth[m] = {};
        }
        this.dynamicMonthlyRows = rowsByMonth;
        this.cdr.detectChanges();
      },
      error: () => { this.isDynamicDataLoading = false; this.cdr.detectChanges(); }
    });
  }

  toggleDynamicEditMode() {
    if (this.dynamicEditMode) {
      // กำลังออกจาก edit → discard changes (ถ้าไม่ได้ save)
      this.dynamicMonthlyRows = JSON.parse(JSON.stringify(this.dynamicMonthlyOriginal));
      this.dynamicEditMode = false;
    } else {
      // เข้า edit mode → snapshot
      this.dynamicMonthlyOriginal = JSON.parse(JSON.stringify(this.dynamicMonthlyRows));
      this.dynamicEditMode = true;
    }
    this.cdr.detectChanges();
  }

  // ตรวจว่าแถวเดือน m มีการกรอกค่าใด ๆ
  hasMonthlyRowData(m: number): boolean {
    const row = this.dynamicMonthlyRows[m] || {};
    return (this.dynamicFormSchema?.fields || []).some((f: any) => {
      const v = row[f.field_name];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
  }

  // เปรียบเทียบกับ snapshot — แถวนี้มีการเปลี่ยนแปลงไหม?
  isMonthlyRowChanged(m: number): boolean {
    const cur = this.dynamicMonthlyRows[m] || {};
    const old = (this.dynamicMonthlyOriginal[m] || {}) as any;
    return (this.dynamicFormSchema?.fields || []).some((f: any) => {
      const a = cur[f.field_name] ?? '';
      const b = old[f.field_name] ?? '';
      return String(a) !== String(b);
    });
  }

  // คำนวณ % สำหรับ score_option field — แสดงในตาราง
  getScoreOptionPct(field: any, value: any): number | null {
    if (!value) return null;
    const opts = this.parseFieldOptions(field.field_options);
    const match = opts.find((o: any) => (typeof o === 'object' ? String(o.label) : String(o)) === String(value));
    if (match && typeof match === 'object' && match.percentage != null) {
      const n = Number(match.percentage);
      return isNaN(n) ? null : n;
    }
    return null;
  }

  // option labels เฉพาะ score_option → array of {label, percentage}
  getScoreOptions(field: any): any[] {
    return this.parseFieldOptions(field.field_options);
  }

  switchDynamicFormTab(tab: 'form' | 'list') {
    this.dynamicFormTab = tab;
    if (tab === 'list') this.loadDynamicDataList();
    this.cdr.detectChanges();
  }

  loadDynamicFormUsedMonths() {
    if (!this.dynamicFormSchema?.table_process) return;
    this.authService.getDynamicDataMonths(this.dynamicFormSchema.table_process, {
      hospcode: this.dynamicFormData.hospcode,
      year_bh: this.dynamicFormData.year_bh
    }).subscribe({
      next: (res) => {
        this.dynamicFormUsedMonths = res.success ? res.data.map((m: any) => Number(m)) : [];
        this.cdr.detectChanges();
      }
    });
  }

  loadDynamicDataList() {
    if (!this.dynamicFormSchema?.table_process) return;
    this.isDynamicDataLoading = true;
    const params: any = {
      // ใช้ hospcode จาก dynamicFormData (ค่าที่ใช้บันทึก) ไม่ใช่ item.hospcode
      // — กรณี user ไม่ใช่ admin: backend forces user.hospcode → list ต้อง match ค่าที่ save จริง
      hospcode: this.dynamicFormData.hospcode || this.dynamicFormItem.hospcode,
      year_bh: this.dynamicFormData.year_bh,
      indicator_id: this.dynamicFormItem.indicator_id  // กรองเฉพาะของตัวชี้วัดนี้ (รับ NULL ด้วยใน backend)
    };
    this.authService.getDynamicData(this.dynamicFormSchema.table_process, params).subscribe({
      next: (res) => {
        this.isDynamicDataLoading = false;
        if (res.success) this.dynamicDataList = res.data;
        this.cdr.detectChanges();
      },
      error: () => { this.isDynamicDataLoading = false; this.cdr.detectChanges(); }
    });
  }

  // Batch save: ส่งเฉพาะแถวที่มีการเปลี่ยนแปลง — ทีละเดือน
  async saveDynamicFormData() {
    if (!this.dynamicFormSchema?.table_process) return;
    const fields = this.dynamicFormSchema.fields || [];
    const changedMonths = this.subMonthColumns.filter(m => this.isMonthlyRowChanged(m));
    if (changedMonths.length === 0) {
      Swal.fire({ icon: 'info', title: 'ไม่มีการเปลี่ยนแปลง', timer: 1500, showConfirmButton: false });
      return;
    }
    // ตรวจ required สำหรับแถวที่กรอกข้อมูล
    for (const m of changedMonths) {
      const row = this.dynamicMonthlyRows[m] || {};
      const hasAny = fields.some((f: any) => {
        const v = row[f.field_name];
        return v !== undefined && v !== null && String(v).trim() !== '';
      });
      if (!hasAny) continue;
      const missing = fields.filter((f: any) => f.is_required && (row[f.field_name] === undefined || row[f.field_name] === null || String(row[f.field_name]).trim() === ''));
      if (missing.length > 0) {
        Swal.fire('ข้อมูลไม่ครบ', `เดือน ${this.subMonthLabels[m]}: กรุณากรอก ${missing.map((f: any) => f.field_label).join(', ')}`, 'warning');
        return;
      }
    }

    this.isDynamicFormSaving = true;
    this.dynamicBatchTotal = changedMonths.length;
    this.dynamicBatchProgress = 0;
    const errors: string[] = [];

    for (const m of changedMonths) {
      const row = this.dynamicMonthlyRows[m] || {};
      const payload: any = {
        ...row,
        year_bh: this.dynamicFormData.year_bh,
        hospcode: this.dynamicFormData.hospcode,
        indicator_id: this.dynamicFormData.indicator_id,
        month_bh: m
      };
      try {
        const res: any = await this.authService.saveDynamicData(this.dynamicFormSchema.table_process, payload).toPromise();
        if (res?.success) {
          this.dynamicBatchProgress++;
          if (res.id && !payload.id) {
            this.dynamicMonthlyRows[m].id = res.id;
          }
        } else {
          errors.push(`${this.subMonthLabels[m]}: ${res?.message || 'ไม่ทราบสาเหตุ'}`);
        }
      } catch (e: any) {
        errors.push(`${this.subMonthLabels[m]}: ${e?.error?.message || e?.message || 'เกิดข้อผิดพลาด'}`);
      }
      this.cdr.detectChanges();
    }

    this.isDynamicFormSaving = false;
    if (errors.length === 0) {
      Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', text: `บันทึก ${changedMonths.length} เดือน`, timer: 2000, showConfirmButton: false });
      this.dynamicEditMode = false;
      this.dynamicMonthlyOriginal = JSON.parse(JSON.stringify(this.dynamicMonthlyRows));
      this.loadDynamicFormUsedMonths();
      this.loadKpiData(true);
    } else {
      Swal.fire('บันทึกไม่ครบ', `สำเร็จ ${this.dynamicBatchProgress}/${changedMonths.length} เดือน\n\n${errors.join('\n')}`, 'warning');
    }
    this.cdr.detectChanges();
  }

  resetDynamicForm() {
    const year = this.dynamicFormData.year_bh;
    const hospcode = this.dynamicFormData.hospcode;
    const indicator_id = this.dynamicFormData.indicator_id;
    this.dynamicFormData = { year_bh: year, hospcode, indicator_id };
  }

  editDynamicRow(row: any) {
    // กลับไปแท็บ form (ตาราง 12 เดือน) — ข้อมูลของ row จะอยู่ที่ dynamicMonthlyRows[row.month_bh] อยู่แล้ว
    this.dynamicFormTab = 'form';
    if (!this.dynamicEditMode) this.toggleDynamicEditMode();
    this.cdr.detectChanges();
  }

  deleteDynamicRow(row: any) {
    if (!this.dynamicFormSchema?.table_process) return;
    Swal.fire({
      title: 'ลบข้อมูล?',
      text: 'ต้องการลบรายการนี้ใช่หรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: 'ลบ',
      cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.authService.deleteDynamicData(this.dynamicFormSchema.table_process, row.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'ลบเรียบร้อย', timer: 1200, showConfirmButton: false });
              this.loadDynamicDataList();
              this.loadDynamicMonthlyRows();
              this.loadDynamicFormUsedMonths();
            }
          }
        });
      }
    });
  }

  // Cache: raw string → parsed array (เพื่อ stable reference กัน NG0103 infinite CD)
  private _parsedOptionsCache = new Map<string, any[]>();
  parseFieldOptions(raw: any): any[] {
    if (Array.isArray(raw)) return raw;
    if (!raw) return [];
    const key = String(raw);
    const cached = this._parsedOptionsCache.get(key);
    if (cached) return cached;
    let result: any[] = [];
    try { result = JSON.parse(key); if (!Array.isArray(result)) result = []; } catch { result = []; }
    this._parsedOptionsCache.set(key, result);
    return result;
  }

  closeDynamicForm() {
    this.showDynamicFormModal = false;
    this.dynamicFormItem = null;
    this.dynamicFormSchema = null;
    this.dynamicFormData = {};
    this.dynamicDataList = [];
    this.dynamicMonthlyRows = {};
    this.dynamicMonthlyOriginal = {};
    this.dynamicEditMode = false;
  }

  // เมื่อเปลี่ยนปีงบฯ → reload ข้อมูลรายเดือน
  onDynamicYearChange() {
    if (this.dynamicEditMode) {
      Swal.fire({ icon: 'warning', title: 'อยู่ในโหมดแก้ไข', text: 'กรุณาบันทึกหรือยกเลิกแก้ไขก่อนเปลี่ยนปีงบฯ', timer: 2500, showConfirmButton: false });
      return;
    }
    this.loadDynamicMonthlyRows();
    this.loadDynamicFormUsedMonths();
  }
}
