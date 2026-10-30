import { Component, OnInit, inject, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { FormBuilderComponent } from '../form-builder/form-builder';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import { validateFormula, evaluateFormula, usesPrevYear, usesBase, formulaVarNames, isValidVarKey, FORMULA_FUNCTIONS } from '../shared/kpi-formula';
import { parseCustomVars } from '../shared/custom-vars';
import { itemNumber } from '../shared/kpi-rollup';
import { orderSubTree } from '../shared/sub-tree';
import Swal from 'sweetalert2';
import * as XLSX from 'xlsx';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { TARGET_CONDITIONS, CONDITION_SYMBOL, CONDITION_LABEL, normalizeCondition, evaluateTarget, normalizeTargetMonthly } from '../shared/kpi-target';

// วิธีคิด "ผลงาน" แบบสำเร็จรูป ↔ is_cumulative + result_formula (ฟังก์ชันล้วน — ทดสอบใน kpi-manage.spec.ts)
// 'manual' = ผู้บันทึกกรอกผลงานล่าสุดเอง (kpi_indicators.result_manual — 29 ต.ค. 2569)
export type ResultMethod = 'last' | 'sum' | 'avg' | 'max' | 'min' | 'custom' | 'manual';
const RESULT_METHOD_FORMULA: Partial<Record<ResultMethod, string>> = { avg: 'AVG(ALL)', max: 'MAX(ALL)', min: 'MIN(ALL)' };
export function resultMethodOf(item: any): ResultMethod {
  if (item?.result_manual === true || Number(item?.result_manual) === 1) return 'manual';
  const f = String(item?.result_formula || '').replace(/\s+/g, '').toUpperCase();
  if (!f) return item?.is_cumulative ? 'sum' : 'last';
  const hit = (Object.keys(RESULT_METHOD_FORMULA) as ResultMethod[]).find(k => RESULT_METHOD_FORMULA[k] === f);
  return hit || 'custom';
}
export function applyResultMethod(item: any, m: ResultMethod): void {
  if (m === 'manual') {
    // กรอกเอง — ไม่ใช้สูตร/สะสม (ช่องรายเดือนยังกรอกได้แต่ไม่นำมาคำนวณ)
    item.result_manual = true;
    item.result_formula = '';
    item.is_cumulative = false;
    return;
  }
  item.result_manual = false;
  if (m === 'custom') {
    // คงสูตรเดิมถ้าเป็นสูตรกำหนดเองอยู่แล้ว — ถ้าเป็นสูตรสำเร็จรูปให้ล้างเพื่อเริ่มพิมพ์เอง
    if (resultMethodOf(item) !== 'custom') item.result_formula = '';
    item.is_cumulative = false;
    return;
  }
  item.result_formula = RESULT_METHOD_FORMULA[m] || '';
  item.is_cumulative = m === 'sum';
}

@Component({
  selector: 'app-kpi-manage',
  standalone: true,
  imports: [CommonModule, FormsModule, FormBuilderComponent, FormulaBadgeComponent],
  templateUrl: './kpi-manage.html'
})
export class KpiManageComponent implements OnInit {
  @ViewChild('formBuilder') formBuilder?: FormBuilderComponent;
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  activeTab: string = 'indicators';
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;

  // Data Lists
  indicators: any[] = [];
  mainIndicators: any[] = [];
  strategies: any[] = [];
  departments: any[] = [];
  hospitals: any[] = [];
  districts: any[] = [];

  // Filtered Lists
  filteredIndicators: any[] = [];
  filteredMainIndicators: any[] = [];
  filteredStrategies: any[] = [];
  filteredDepartments: any[] = [];
  filteredHospitals: any[] = [];
  // Extra hospital filter — distid + hostype
  hospFilterDistid: string = '';
  hospFilterHostype: string = '';
  searchTerm: string = '';
  filterActive: string = ''; // '' = ทั้งหมด, '1' = เปิดใช้งาน, '0' = ปิดใช้งาน
  // Extra indicators filter — หมวดหมู่หลัก + หน่วยงาน (ค่าเป็น string ของ id เพื่อ match [value] ของ <select>)
  filterMainIndicator: string = '';
  filterDept: string = '';
  // กรองปีงบประมาณ — ค่าเดียวจาก dropdown, match กับ khd_fiscal_year ของแต่ละตัวชี้วัด (comma-list เช่น "2569,2570")
  filterFiscalYear: string = '';

  // Modal
  showModal: boolean = false;
  isEditMode: boolean = false;
  currentItem: any = {};
  // ตั้งค่าเมื่อเปิด modal จากปุ่ม "คัดลอกไปปีใหม่" — เก็บ id ของตัวชี้วัดต้นทาง เพื่อถามปิดใช้งานหลังบันทึกสำเร็จ
  private _cloneSourceId: number | null = null;

  // Cascade: selected yut → filter main_indicators
  selectedYutInModal: number | null = null;
  filteredMainForModal: any[] = [];

  // Sub-Indicator Modal
  showSubModal: boolean = false;
  subParentIndicator: any = null;
  subList: any[] = [];
  subCurrent: any = {};
  isSubEdit: boolean = false;
  showSubForm: boolean = false;
  // นับจำนวน sub-indicator ต่อ indicator_id (แสดงบาดจ์บนแถว)
  subCountMap: Map<number, number> = new Map();

  // นำเข้าตัวชี้วัดย่อยจาก Excel (scoped ต่อ subParentIndicator เดียวกับ showSubModal)
  showSubImportModal: boolean = false;
  subImportStep: 1 | 2 = 1;
  subImportRows: any[] = [];
  subImportErrors: { rowIndex: number; col: string; field: string; message: string }[] = [];
  subImportLoading = false;
  subImportResult: { inserted: number; errors: any[] } | null = null;

  get subImportValidRows(): any[] {
    const errorRows = new Set(this.subImportErrors.map(e => e.rowIndex));
    return this.subImportRows.filter((_, i) => !errorRows.has(i));
  }

  // รายการประเภทหน่วยบริการ (จาก chostype)
  hosTypes: any[] = [];
  // เก็บ required_off_types ใน modal เป็น array ของ code (ตอนเปิด modal แปลงจาก JSON string)
  selectedOffTypes: string[] = [];

  // === KHD Compare (ย้ายจาก kpi-manager Step 1) ===
  // ใช้ table_process เป็น key เพราะ KHD ไม่มี local.id
  khdCompareMap: Map<string, any> = new Map();
  khdCompareSummary: any = null;     // { total, match, different, missing_local, missing_remote, khd_inactive, suggest_disable }
  khdCompareLoading: boolean = false;
  khdLinkSyncLoading: boolean = false;
  khdCompareLastRun: Date | null = null;
  // ปีงบที่ใช้เทียบเกณฑ์กับ KHD (report_fiscal_year_config.fiscal_year) — เดิม frontend ไม่เคยส่งปีงบไปเลย
  // ทำให้เทียบได้แค่ปีงบ "ปัจจุบัน" ตามวันที่เท่านั้น ทั้งที่ remote มีข้อมูลมากกว่า 1 ปีงบพร้อมกันจริง (เช่น 2569+2570)
  khdCompareYear: string = String(getCurrentFiscalYear());
  khdCompareYearOptions: string[] = (() => {
    const fy = getCurrentFiscalYear();
    return [String(fy + 1), String(fy), String(fy - 1)];
  })();
  // filter เพิ่มสำหรับ indicators tab — กรองตามสถานะ compare กับ KHD
  filterKhdStatus: string = '';      // '' | 'match' | 'different' | 'missing_remote' | 'not_compared' | 'inactive'
  // filter ตามสถานะการบันทึกผลงาน (ใช้ร่วมกับ filterKhdStatus ได้ — คนละมิติกัน)
  filterResultStatus: string = '';   // '' | 'has_results' | 'no_results'
  khdAddModal: { open: boolean; item: any; deptId: number|null; mainIndicatorId: number|null; yearBh: string } = {
    open: false, item: null, deptId: null, mainIndicatorId: null, yearBh: this.khdCompareYear
  };
  khdAddLoading: boolean = false;
  // เลือก checkbox หลายตัวจากตาราง "KHD มีแต่ยังไม่มีใน Local" — key คือ khd_report_id
  khdMissingLocalSelected: Set<number> = new Set();
  khdBulkAddModal: { open: boolean; deptId: number|null; mainIndicatorId: number|null; yearBh: string } = {
    open: false, deptId: null, mainIndicatorId: null, yearBh: this.khdCompareYear
  };
  khdBulkAddLoading: boolean = false;

  // ยุทธศาสตร์ compare
  stratCompareLoading = false;
  stratCompareSummary: any = null;
  stratCompareItems: any[] = [];
  // หน่วยงาน compare
  deptCompareLoading = false;
  deptCompareSummary: any = null;
  deptCompareItems: any[] = [];
  // KHD compare filter (ใช้ร่วมทุก tab — reset เมื่อ switch tab)
  khdCompareFilter = '';
  // หมวดหมู่หลัก compare
  mainIndCompareLoading = false;
  mainIndCompareSummary: any = null;
  mainIndCompareItems: any[] = [];
  mainIndCompareSource = '';
  // modal เพิ่มหมวดหมู่หลักจาก KHD
  mainIndAddModal: { open: boolean; khd_name: string; yutId: number|null } = { open: false, khd_name: '', yutId: null };
  mainIndAddLoading = false;
  // หน่วยบริการ compare
  hospCompareLoading = false;
  hospCompareSummary: any = null;
  hospCompareItems: any[] = [];
  hospCompareError = '';

  // modal เพิ่มจาก KHD (ใช้ร่วมกัน ยุทธศาสตร์ + หน่วยงาน)
  simpleAddModal: { open: boolean; tab: string; itemName: string; deptCode: string } = { open: false, tab: '', itemName: '', deptCode: '' };
  simpleAddLoading = false;
  // modal เพิ่มหน่วยบริการ
  hospAddModal: { open: boolean; item: any } = { open: false, item: null };
  hospAddLoading = false;

  // === Excel Import ===
  showImportModal = false;
  importStep: 1 | 2 = 1;
  importRows: any[] = [];
  importErrors: { rowIndex: number; col: string; field: string; message: string }[] = [];
  importLoading = false;
  importResult: { inserted: number; errors: any[] } | null = null;

  get importValidRows(): any[] {
    const errorRows = new Set(this.importErrors.map(e => e.rowIndex));
    return this.importRows.filter((_, i) => !errorRows.has(i));
  }

  // สิทธิ์เพิ่ม/แก้ไขข้อมูล — ตั้งค่าได้จากหน้า "สิทธิ์การเข้าถึงหน้า" (super_admin) แยกจาก isSuperAdmin เดิม
  // (canPerformAction คืน true เสมอถ้า role เป็น super_admin อยู่แล้ว ไม่ต้อง OR isSuperAdmin ซ้ำ)
  canAddData: boolean = false;
  canEditData: boolean = false;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    this.canAddData = this.authService.canPerformAction('kpi-manage', 'add');
    this.canEditData = this.authService.canPerformAction('kpi-manage', 'edit');
    // เดิม hardcode เช็ค isAdmin ตรงๆ ที่นี่ ซ้ำซ้อนกับ pageAccessGuard ที่ route และขัดกับระบบ
    // Role × Page Access — ใช้ canAccessPage() แทนให้ตรงกับ guard
    if (!this.authService.canAccessPage('kpi-manage')) {
      this.router.navigate(['/dashboard']);
      return;
    }
    // ?editIndicator=<id> — มาจากปุ่ม "ไปตั้งค่า" ในหน้าต่างเพิ่มตัวชี้วัดให้หน่วยบริการ (ตัวชี้วัดที่ยังไม่ได้ตั้งประเภทหน่วยบริการ)
    const editId = Number(this.router.parseUrl(this.router.url).queryParams['editIndicator']);
    this.pendingEditIndicatorId = editId > 0 ? editId : null;
    this.loadAllData();
  }

  pendingEditIndicatorId: number | null = null;

  /** เปิดหน้าต่างแก้ไขตัวชี้วัดที่ขอมาทาง query แล้วเลื่อนไปกล่อง "เกณฑ์การประเมิน" (ประเภทหน่วยบริการ) */
  openPendingIndicatorEdit() {
    const id = this.pendingEditIndicatorId;
    if (!id) return;
    this.pendingEditIndicatorId = null;
    this.router.navigate([], { queryParams: {}, replaceUrl: true });
    const item = this.indicators.find((i: any) => Number(i.id) === id);
    if (!item || !this.canEditData) return;
    this.activeTab = 'indicators';
    this.openModal(item);
    this.cdr.detectChanges();
    setTimeout(() => document.getElementById('indicator-eval-mode')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 200);
  }

  loadAllData() {
    this.authService.getIndicators(true).subscribe(res => {
      if(res.success) {
        this.indicators = res.data;
        this.filteredIndicators = [...this.indicators];
        if (this.activeTab === 'indicators') this.applyFilter();
        this.openPendingIndicatorEdit();
      }
      this.cdr.detectChanges();
    });
    this.authService.getMainIndicators().subscribe(res => {
      if(res.success) {
        this.mainIndicators = res.data;
        this.filteredMainIndicators = [...this.mainIndicators];
        if (this.activeTab === 'main-indicators') this.applyFilter();
      }
      this.cdr.detectChanges();
    });
    this.authService.getMainYut().subscribe(res => {
      if(res.success) {
        this.strategies = res.data;
        this.filteredStrategies = [...this.strategies];
        if (this.activeTab === 'strategies') this.applyFilter();
      }
      this.cdr.detectChanges();
    });
    this.authService.getDepartments().subscribe(res => {
      if(res.success) {
        this.departments = res.data;
        this.filteredDepartments = [...this.departments];
        if (this.activeTab === 'departments') this.applyFilter();
      }
      this.cdr.detectChanges();
    });
    // โหลด sub-indicator count ทั้งหมด
    this.authService.getSubIndicators().subscribe(res => {
      if (res.success) {
        this.subCountMap.clear();
        for (const s of res.data) {
          this.subCountMap.set(s.indicator_id, (this.subCountMap.get(s.indicator_id) || 0) + 1);
        }
        this.cdr.detectChanges();
      }
    });
    // โหลดประเภทหน่วยบริการ (chostype)
    this.authService.getHosTypes().subscribe(res => {
      if (res.success) { this.hosTypes = res.data; this.cdr.detectChanges(); }
    });
    // โหลด hospitals
    this.authService.getHospitals().subscribe(res => {
      if (res.success) {
        this.hospitals = res.data;
        this.filteredHospitals = [...this.hospitals];
        if (this.activeTab === 'hospitals') this.applyFilter();
        this.cdr.detectChanges();
      }
    });
    // โหลด districts (สำหรับ dropdown ใน modal + filter)
    this.authService.getDistricts().subscribe(res => {
      if (res.success) { this.districts = res.data; this.cdr.detectChanges(); }
    });
  }

  // เลื่อนหน้าจอไปยัง section ที่ระบุ (ใช้กับชิปสรุป "KHD มีแต่ยังไม่มีใน Local")
  scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Parse required_off_types JSON → string[] ของ hostypecode
  parseOffTypes(v: any): string[] {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(x => String(x));
    try {
      const p = JSON.parse(String(v));
      return Array.isArray(p) ? p.map(x => String(x)) : [];
    } catch { return []; }
  }

  // สัญลักษณ์เงื่อนไข: GTE→≥, LTE→≤, EQ→=
  private readonly CONDITION_SYMBOL: { [k: string]: string } = { GTE: '≥', LTE: '≤', EQ: '=' };
  getConditionSymbol(condition: any): string {
    return this.CONDITION_SYMBOL[String(condition || '')] || '';
  }

  // เงื่อนไข+เกณฑ์ รวมเป็นข้อความเดียว เช่น "≥ 80%" — item.criterion (ไม่ใช่ target_percentage/เป้าหมาย)
  getCriteriaText(item: any): string {
    const pct = item?.criterion;
    if (pct == null || pct === '') return '-';
    const sym = this.getConditionSymbol(item?.target_condition);
    return `${sym ? sym + ' ' : ''}${pct}%`;
  }

  // เกณฑ์ของ KHD (จาก getKhdData) — เทียบคู่กับ getCriteriaText(item) ของ Local
  getKhdCriteriaText(khd: any): string {
    const text = this.getCriteriaText({ criterion: khd?.khd_target_percentage, target_condition: khd?.khd_target_condition });
    // khd_fiscal_year มีค่าเมื่อเกณฑ์มาจาก report_fiscal_year_config ปีงบที่กำลังเทียบโดยตรง (ไม่ใช่ fallback จาก reports)
    // แสดงกำกับไว้กันสับสนว่าเกณฑ์นี้อ้างอิงปีไหน เพราะกดเปลี่ยน dropdown ปีงบแล้วค่าอาจไม่เหมือนเดิม
    return khd?.khd_fiscal_year ? `${text} (ปีงบ ${khd.khd_fiscal_year})` : text;
  }

  // ดึงประเภทตัวชี้วัด (R9, MOPH, SSJ, RMW, Other) — badge สีต่างกัน
  getIndicatorTypes(item: any): Array<{ type: string; color: string; label: string }> {
    const types: Array<{ type: string; color: string; label: string }> = [];
    if (item?.r9 && String(item.r9).trim() && item.r9 !== '0') types.push({ type: 'r9', color: 'bg-blue-100 text-blue-700', label: 'R9' });
    if (item?.moph && String(item.moph).trim() && item.moph !== '0') types.push({ type: 'moph', color: 'bg-red-100 text-red-700', label: 'MOPH' });
    if (item?.ssj && String(item.ssj).trim() && item.ssj !== '0') types.push({ type: 'ssj', color: 'bg-green-100 text-green-700', label: 'SSJ' });
    if (item?.rmw && String(item.rmw).trim() && item.rmw !== '0') types.push({ type: 'rmw', color: 'bg-yellow-100 text-yellow-700', label: 'RMW' });
    if (item?.other && String(item.other).trim() && item.other !== '0') types.push({ type: 'other', color: 'bg-gray-100 text-gray-700', label: 'อื่นๆ' });
    return types;
  }

  // แปลง khd_fiscal_year (comma-list เช่น "2569,2570") เป็น array — ใช้ทั้งกรองและแสดง badge
  getFiscalYears(item: any): string[] {
    if (!item?.khd_fiscal_year) return [];
    return String(item.khd_fiscal_year).split(',').map((y: string) => y.trim()).filter(Boolean);
  }

  // รายการปีงบทั้งหมดที่พบจริงในตัวชี้วัดที่โหลดมา (สำหรับ dropdown กรอง) — เรียงปีล่าสุดก่อน
  get fiscalYearOptions(): string[] {
    const set = new Set<string>();
    for (const i of this.indicators) { for (const y of this.getFiscalYears(i)) set.add(y); }
    return Array.from(set).sort((a, b) => Number(b) - Number(a));
  }

  // badge ปีงบประมาณ — จาก khd_fiscal_year (ดึงจาก KHD report_fiscal_year_config) แสดงทุกตัวชี้วัดเสมอ
  // (ไม่พบข้อมูล = "ไม่ระบุปีงบ" เทา — ตัวชี้วัดที่ไม่ได้ผูกกับ KHD หรือยังไม่เคยกด "เชื่อมโยง KHD Link")
  getFiscalYearBadge(item: any): { label: string; title: string; color: string } {
    const years = this.getFiscalYears(item);
    if (years.length === 0) {
      return { label: 'ไม่ระบุปีงบ', title: 'ไม่พบข้อมูลปีงบประมาณจาก KHD — ลองกด "เชื่อมโยง KHD Link"', color: 'bg-gray-50 border-gray-200 text-gray-500' };
    }
    return { label: `ปีงบ ${years.join(', ')}`, title: `พบใน KHD report_fiscal_year_config ปีงบ: ${years.join(', ')}`, color: 'bg-teal-50 border-teal-200 text-teal-700' };
  }

  // badge แหล่งที่มาข้อมูล — 3 สถานะ ตาม data_source/khd_report_id (link ถาวรกับ KHD reports.report_id ผ่าน table_process)
  // key_in = KHD data_source='excel' (คีย์เอง), hdc = KHD data_source='hdc' (ดึงอัตโนมัติ), local-only = ไม่พบเทียบเคียงกับ KHD เลย
  getSourceBadge(item: any): { label: string; icon: string; color: string; title: string } {
    if (item?.khd_report_id && item?.data_source === 'hdc') {
      return { label: 'hdc', icon: 'fa-server', color: 'bg-indigo-50 border-indigo-200 text-indigo-700', title: 'ข้อมูลจาก HDC (ดึงอัตโนมัติ)' };
    }
    if (item?.khd_report_id && item?.data_source === 'excel') {
      return { label: 'key_in', icon: 'fa-keyboard', color: 'bg-sky-50 border-sky-200 text-sky-700', title: 'คีย์ข้อมูลเอง (key_in)' };
    }
    return { label: 'local-only', icon: 'fa-desktop', color: 'bg-gray-50 border-gray-200 text-gray-500', title: 'ไม่พบเทียบเคียงกับ KHD (local-only)' };
  }

  // ประเภทหน่วยบริการ — 'all_required' = ทุกประเภท, 'any_one' + required_off_types = รายชื่อ
  getOffTypeBadge(item: any): { label: string; title: string } | null {
    const mode = item?.evaluation_mode;
    if (mode === 'all_required') return { label: 'ทุกประเภท', title: 'บังคับทุกประเภทหน่วยบริการ' };
    if (mode !== 'any_one') return null;
    const codes = this.parseOffTypes(item?.required_off_types);
    if (codes.length === 0) return null;
    const names = codes.map(c => this.hosTypes.find((h: any) => h.hostypecode === c)?.hostypename || c);
    const label = codes.length <= 2 ? names.join(', ') : `${codes.length} ประเภท`;
    return { label, title: names.join(', ') };
  }

  toggleOffType(code: string) {
    const i = this.selectedOffTypes.indexOf(code);
    if (i >= 0) this.selectedOffTypes.splice(i, 1);
    else this.selectedOffTypes.push(code);
  }

  isOffTypeSelected(code: string): boolean {
    return this.selectedOffTypes.includes(code);
  }

  getSubCount(indicatorId: number): number {
    return this.subCountMap.get(indicatorId) || 0;
  }

  // === Sub-Indicator Modal ===
  openSubModal(indicator: any) {
    this.subParentIndicator = indicator;
    this.showSubModal = true;
    this.showSubForm = false;
    this.subCurrent = {};
    this.isSubEdit = false;
    this.loadSubList(indicator.id);
  }

  closeSubModal() {
    this.showSubModal = false;
    this.subParentIndicator = null;
    this.subList = [];
  }

  // เปิด Form Builder modal สำหรับตัวชี้วัดที่เลือก (ใช้กับปุ่ม icon ในคอลัมน์ จัดการ)
  openFormBuilder(item: any) {
    if (!item?.table_process) {
      Swal.fire({
        icon: 'warning',
        title: 'ยังไม่ได้กำหนดชื่อตาราง',
        text: 'กรุณากำหนด "ชื่อตาราง (table_process)" ในการแก้ไขตัวชี้วัดก่อน จึงจะสร้างแบบฟอร์มได้',
        confirmButtonText: 'ตกลง'
      });
      return;
    }
    this.formBuilder?.openForIndicator(item);
  }

  loadSubList(indicatorId: number) {
    this.authService.getSubIndicators(indicatorId).subscribe(res => {
      if (res.success) {
        // ข้อย่อยหลายระดับเรียงเป็นต้นไม้ (pre-order) พร้อมระดับ/เลขข้อ — 19 ต.ค. 2569
        this.subList = orderSubTree(res.data, this.subParentIndicator?.item_no || '');
        this.subMaxLevels = Number(res.max_levels) || 4;
        this.cdr.detectChanges();
      }
    });
  }

  /** parent = ข้อย่อยแม่ (เพิ่มข้อย่อยระดับถัดไป) — ไม่ระบุ = ข้อย่อยระดับบนสุด */
  openSubForm(item: any = null, parent: any = null) {
    this.isSubEdit = !!item;
    this.subCurrent = item
      ? { ...item, rollup_mode: item.rollup_mode === 'auto' ? 'auto' : 'manual', item_no: item.item_no || '' }
      : { indicator_id: this.subParentIndicator.id, parent_sub_id: parent ? parent.id : null, weight: 1, rollup_mode: 'manual', item_no: '' };
    const pid = this.subCurrent.parent_sub_id;
    this.subFormParent = pid ? (this.subList.find((x: any) => Number(x.id) === Number(pid)) || parent) : null;
    this.showSubForm = true;
  }

  // ===== ตัวชี้วัดหลายระดับ (19 ต.ค. 2569) — ระดับ: หลัก = 1, ข้อย่อยบนสุด = 2 (_level 0) …, ระดับสุดท้ายสงวนไว้ให้กิจกรรม =====
  subMaxLevels = 4;
  subFormParent: any = null;
  /** ระดับจริงของข้อย่อย (หลัก = 1) */
  subLevel(s: any): number { return Number(s?._level || 0) + 2; }
  /** เพิ่มข้อย่อยลูกได้เมื่อระดับของข้อลูก ≤ จำนวนระดับสูงสุด − 1 (เหลือที่ให้กิจกรรม) */
  canAddChildSub(s: any): boolean { return this.subLevel(s) + 1 <= this.subMaxLevels - 1; }

  saveSub() {
    if (!this.subCurrent.sub_indicator_name) {
      Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อตัวชี้วัดย่อย', 'warning');
      return;
    }
    const obs = this.isSubEdit
      ? this.authService.updateSubIndicator(this.subCurrent.id, this.subCurrent)
      : this.authService.createSubIndicator(this.subCurrent);
    obs.subscribe({
      next: (res: any) => {
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'สำเร็จ', timer: 1500, showConfirmButton: false });
          this.showSubForm = false;
          this.loadSubList(this.subParentIndicator.id);
          this.loadAllData();
        }
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e.error?.message || 'ไม่สามารถบันทึกได้', 'error')
    });
  }

  deleteSub(id: number) {
    Swal.fire({
      title: 'ยืนยันลบตัวชี้วัดย่อย', icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#d33',
      confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.authService.deleteSubIndicator(id).subscribe({
          next: (res: any) => {
            if (res.success) {
              this.loadSubList(this.subParentIndicator.id);
              this.loadAllData();
            }
          }
        });
      }
    });
  }

  toggleSubActive(item: any) {
    const newStatus = !item.is_active || item.is_active === 0;
    this.authService.toggleSubIndicatorActive(item.id, newStatus).subscribe({
      next: (res: any) => { if (res.success) { item.is_active = newStatus ? 1 : 0; this.cdr.detectChanges(); } }
    });
  }

  // === ตัวชี้วัด 3 ระดับ: เลขข้อ + กิจกรรมใต้ตัวชี้วัดย่อย (หลัก 1 → ย่อย 1.1 → กิจกรรม 1.1.1) ===
  showActModal = false;
  showActForm = false;
  isActEdit = false;
  actParentSub: any = null;
  actParentNo = '';
  actList: any[] = [];
  actCurrent: any = {};

  subNo(s: any, i: number): string {
    return s?._no || itemNumber(s?.item_no, this.subParentIndicator?.item_no, i);
  }

  // เลขข้อกิจกรรมต่อจากข้อย่อยลูกของข้อเดียวกัน (ข้อลูก 1..n ก่อน กิจกรรมต่อท้าย — ตรงกับตารางบันทึกผลงานและการส่งออก)
  actNo(a: any, i: number): string {
    return itemNumber(a?.item_no, this.actParentNo, this.actChildSubCount + i);
  }
  actChildSubCount = 0;

  openActModal(sub: any, index: number) {
    this.actParentSub = sub;
    this.actParentNo = this.subNo(sub, index);
    this.actChildSubCount = Number(sub?._childSubCount || 0);
    this.showActModal = true;
    this.showActForm = false;
    this.actList = [];
    this.loadActList();
  }

  closeActModal() {
    this.showActModal = false;
    this.actParentSub = null;
    if (this.subParentIndicator) this.loadSubList(this.subParentIndicator.id); // จำนวนกิจกรรมในรายการข้อย่อย
  }

  loadActList() {
    if (!this.actParentSub) return;
    this.authService.getSubActivities(this.actParentSub.id).subscribe({
      next: (res: any) => { if (res.success) { this.actList = res.data; this.cdr.detectChanges(); } },
      error: (e: any) => Swal.fire('ผิดพลาด', e.error?.message || 'โหลดกิจกรรมไม่สำเร็จ', 'error')
    });
  }

  openActForm(item: any = null) {
    this.isActEdit = !!item;
    this.actCurrent = item ? { ...item } : { sub_indicator_id: this.actParentSub.id, value_type: 'number', sort_order: this.actList.length + 1, is_active: 1 };
    this.showActForm = true;
  }

  saveAct() {
    if (!String(this.actCurrent.activity_name || '').trim()) {
      Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อกิจกรรม', 'warning');
      return;
    }
    const obs = this.isActEdit
      ? this.authService.updateSubActivity(this.actCurrent.id, this.actCurrent)
      : this.authService.createSubActivity(this.actCurrent);
    obs.subscribe({
      next: (res: any) => {
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'สำเร็จ', timer: 1500, showConfirmButton: false });
          this.showActForm = false;
          this.loadActList();
        }
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e.error?.message || 'ไม่สามารถบันทึกได้', 'error')
    });
  }

  toggleActActive(item: any) {
    const newStatus = !(Number(item.is_active) === 1);
    this.authService.toggleSubActivityActive(item.id, newStatus).subscribe({
      next: (res: any) => { if (res.success) { item.is_active = newStatus ? 1 : 0; this.cdr.detectChanges(); } }
    });
  }

  deleteAct(id: number) {
    Swal.fire({
      title: 'ยืนยันลบกิจกรรม', icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#d33',
      confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.deleteSubActivity(id).subscribe({
        next: (res: any) => { if (res.success) this.loadActList(); },
        error: (e: any) => Swal.fire('ลบไม่ได้', e.error?.message || 'เกิดข้อผิดพลาด', 'error')
      });
    });
  }

  // === นำเข้าตัวชี้วัดย่อยจาก Excel (mirror pattern ของ downloadTemplate/onExcelFileSelected/confirmImport ของตัวชี้วัดหลัก) ===
  openSubImportModal() {
    this.showSubImportModal = true;
    this.subImportStep = 1;
    this.subImportRows = [];
    this.subImportErrors = [];
    this.subImportResult = null;
    this.cdr.detectChanges();
  }

  closeSubImportModal() {
    this.showSubImportModal = false;
    if (this.subImportResult && this.subImportResult.inserted > 0 && this.subParentIndicator) {
      this.loadSubList(this.subParentIndicator.id);
      this.loadAllData();
    }
  }

  downloadSubTemplate() {
    const COLS = [
      { key: 'sub_indicator_name', desc: 'ชื่อตัวชี้วัดย่อย (จำเป็น — ห้ามเว้นว่าง)', example: 'เกณฑ์ข้อที่ 1 มีการแต่งตั้งคณะทำงาน' },
      { key: 'sub_indicator_code', desc: 'รหัสตัวชี้วัดย่อย (ไม่จำเป็น)', example: 'SUB-001' },
      { key: 'target_percentage', desc: 'เป้าหมาย % เช่น 80 (ไม่จำเป็น)', example: '80' },
      { key: 'weight',             desc: 'น้ำหนัก (ตัวเลข ค่าเริ่มต้น 1)', example: '1' },
      { key: 'sort_order',         desc: 'ลำดับการแสดงผล (ตัวเลข ค่าเริ่มต้น 0)', example: '1' },
      { key: 'description',        desc: 'รายละเอียดเพิ่มเติม (ไม่จำเป็น)', example: '' },
    ];
    const wb = XLSX.utils.book_new();
    const wsData: any[][] = [
      COLS.map(c => c.key),
      COLS.map(c => c.desc),
      COLS.map(c => c.example),
      ...Array(20).fill(null).map(() => new Array(COLS.length).fill('')),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = COLS.map((c, i) => ({ wch: i === 0 ? 45 : 20 }));
    XLSX.utils.book_append_sheet(wb, ws, 'นำเข้าตัวชี้วัดย่อย');
    XLSX.writeFile(wb, 'template_นำเข้าตัวชี้วัดย่อย.xlsx');
  }

  onSubExcelFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' }) as any[][];

        if (rawRows.length < 4) {
          Swal.fire('ข้อมูลไม่เพียงพอ', 'ไฟล์ต้องมีข้อมูลตั้งแต่แถวที่ 4 เป็นต้นไป (แถว 1=ชื่อคอลัมน์, 2=คำอธิบาย, 3=ตัวอย่าง)', 'warning');
          return;
        }

        const headers: string[] = rawRows[0].map((h: any) => String(h).trim());
        const dataRows = rawRows.slice(3).filter((row: any[]) => row.some(c => c !== '' && c !== null && c !== undefined));

        if (dataRows.length === 0) {
          Swal.fire('ไม่มีข้อมูล', 'ไม่พบข้อมูลในไฟล์ (กรอกข้อมูลตั้งแต่แถวที่ 4 เป็นต้นไป)', 'warning');
          return;
        }

        this.subImportRows = [];
        this.subImportErrors = [];
        const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

        dataRows.forEach((raw: any[], i: number) => {
          const obj: any = {};
          headers.forEach((h, hi) => { obj[h] = raw[hi] !== undefined ? String(raw[hi]).trim() : ''; });

          const rowNum = i + 4;
          const addErr = (colIdx: number, field: string, msg: string) => {
            this.subImportErrors.push({ rowIndex: i, col: COL_LETTERS[colIdx] || String(colIdx + 1), field, message: `แถวที่ ${rowNum}, คอลัมน์ ${COL_LETTERS[colIdx] || colIdx + 1} (${field}): ${msg}` });
          };

          if (!obj.sub_indicator_name) addErr(0, 'sub_indicator_name', 'ชื่อตัวชี้วัดย่อยไม่สามารถเว้นว่างได้');
          if (obj.weight && isNaN(Number(obj.weight))) addErr(3, 'weight', `"${obj.weight}" ต้องเป็นตัวเลข`);
          if (obj.sort_order && isNaN(Number(obj.sort_order))) addErr(4, 'sort_order', `"${obj.sort_order}" ต้องเป็นตัวเลข`);

          this.subImportRows.push(obj);
        });

        this.subImportStep = 2;
        this.cdr.detectChanges();
      } catch (err: any) {
        Swal.fire('อ่านไฟล์ไม่ได้', 'ไม่สามารถอ่านไฟล์ Excel ได้: ' + (err.message || err), 'error');
      }
      input.value = '';
    };
    reader.readAsArrayBuffer(file);
  }

  rowHasSubError(rowIndex: number): boolean {
    return this.subImportErrors.some(e => e.rowIndex === rowIndex);
  }

  getSubRowErrors(rowIndex: number): string[] {
    return this.subImportErrors.filter(e => e.rowIndex === rowIndex).map(e => e.message);
  }

  confirmSubImport() {
    const validRows = this.subImportValidRows;
    if (validRows.length === 0) {
      Swal.fire('ไม่มีข้อมูลที่ถูกต้อง', 'ทุกแถวมีข้อผิดพลาด กรุณาแก้ไขไฟล์แล้วอัปโหลดใหม่', 'warning');
      return;
    }
    if (!this.subParentIndicator) return;
    this.subImportLoading = true;
    this.cdr.detectChanges();
    this.authService.bulkImportSubIndicators(this.subParentIndicator.id, validRows).subscribe({
      next: (res: any) => {
        this.subImportLoading = false;
        this.subImportResult = { inserted: res.inserted, errors: res.errors || [] };
        this.subImportStep = 1;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.subImportLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาดในการนำเข้า', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  applyFilter() {
    const search = this.searchTerm.toLowerCase();
    const activeFilter = this.filterActive;

    const matchActive = (item: any) => {
      if (activeFilter === '') return true;
      const isActive = item.is_active !== undefined ? Number(item.is_active) : 1;
      return activeFilter === '1' ? isActive === 1 : isActive === 0;
    };

    if (this.activeTab === 'indicators') {
      this.filteredIndicators = this.indicators.filter(i => {
        if (!matchActive(i)) return false;
        const matchSearch = (i.kpi_indicators_name && i.kpi_indicators_name.toLowerCase().includes(search))
          || (i.kpi_indicators_code && i.kpi_indicators_code.toLowerCase().includes(search));
        if (!matchSearch) return false;
        if (this.filterMainIndicator && String(i.main_indicator_id) !== this.filterMainIndicator) return false;
        if (this.filterDept && String(i.dept_id) !== this.filterDept) return false;
        if (this.filterFiscalYear && !this.getFiscalYears(i).includes(this.filterFiscalYear)) return false;
        // KHD compare filter
        if (this.filterKhdStatus) {
          const cmp = this.getKhdCompareStatus(i);
          if (this.filterKhdStatus === 'criteria') {
            if (this.getKhdData(i)?.criteria_match !== false) return false;
          } else if (this.filterKhdStatus === 'inactive') {
            const khd = this.khdCompareMap.get(i.table_process || '');
            if (!(khd && (khd.khd_is_active === 0 || khd.khd_is_active === '0'))) return false;
          } else if (cmp !== this.filterKhdStatus) {
            return false;
          }
        }
        // Result status filter (มีผลงาน / ยังไม่มีผลงาน)
        if (this.filterResultStatus === 'has_results' && !(i.result_count > 0)) return false;
        if (this.filterResultStatus === 'no_results' && i.result_count > 0) return false;
        return true;
      });
    } else if (this.activeTab === 'main-indicators') {
      this.filteredMainIndicators = this.mainIndicators.filter(i => {
        if (!matchActive(i)) return false;
        if (search && !(i.main_indicator_name && i.main_indicator_name.toLowerCase().includes(search))) return false;
        if (this.khdCompareFilter && this.mainIndCompareSummary) {
          const cmp = this.mainIndCompareItems.find(c => c.local_id === i.id);
          const status = cmp ? cmp.status : (this.mainIndCompareSource === 'khd_table' ? 'missing_remote' : 'local_only');
          if (status !== this.khdCompareFilter) return false;
        }
        return true;
      });
    } else if (this.activeTab === 'strategies') {
      this.filteredStrategies = this.strategies.filter(s => {
        if (!matchActive(s)) return false;
        if (search && !(s.yut_name && s.yut_name.toLowerCase().includes(search))) return false;
        if (this.khdCompareFilter && this.stratCompareSummary) {
          const cmp = this.stratCompareItems.find(c => c.local_id === s.id);
          const status = cmp ? cmp.status : 'missing_remote';
          if (status !== this.khdCompareFilter) return false;
        }
        return true;
      });
    } else if (this.activeTab === 'departments') {
      this.filteredDepartments = this.departments.filter(d => {
        if (!matchActive(d)) return false;
        if (search && !((d.dept_name && d.dept_name.toLowerCase().includes(search)) || (d.dept_code && d.dept_code.toLowerCase().includes(search)))) return false;
        if (this.khdCompareFilter && this.deptCompareSummary) {
          const cmp = this.deptCompareItems.find(c => c.local_id === d.id);
          const status = cmp ? cmp.status : 'missing_remote';
          if (status !== this.khdCompareFilter) return false;
        }
        return true;
      });
    } else if (this.activeTab === 'hospitals') {
      this.filteredHospitals = this.hospitals.filter(h => {
        if (this.hospFilterDistid && String(h.distid) !== this.hospFilterDistid) return false;
        if (this.hospFilterHostype && String(h.hostype) !== this.hospFilterHostype) return false;
        if (search && !((h.hosname && h.hosname.toLowerCase().includes(search)) || (h.hoscode && String(h.hoscode).toLowerCase().includes(search)))) return false;
        if (this.khdCompareFilter && this.hospCompareSummary) {
          const cmp = this.hospCompareItems.find(c => String(c.hoscode).trim() === String(h.hoscode).trim());
          const status = cmp ? cmp.status : 'missing_remote';
          if (status !== this.khdCompareFilter) return false;
        }
        return true;
      });
    }
    this.cdr.detectChanges();
  }

  // รายการที่กำลังแสดงผลตาม activeTab ปัจจุบัน — ใช้แทนการเขียน ternary ซ้ำในเทมเพลต
  get currentList(): any[] {
    switch (this.activeTab) {
      case 'indicators': return this.filteredIndicators;
      case 'main-indicators': return this.filteredMainIndicators;
      case 'strategies': return this.filteredStrategies;
      case 'departments': return this.filteredDepartments;
      default: return this.filteredHospitals;
    }
  }

  // ใช้ตัดสินข้อความ empty-state: "ไม่พบข้อมูลที่ค้นหา" (มีตัวกรองอยู่) vs "ยังไม่มีข้อมูล" (list ว่างจริงๆ)
  hasActiveFilter(): boolean {
    if (this.searchTerm) return true;
    if (this.activeTab === 'indicators') return !!(this.filterActive || this.filterMainIndicator || this.filterDept || this.filterFiscalYear);
    if (this.activeTab === 'hospitals') return !!(this.hospFilterDistid || this.hospFilterHostype);
    return !!this.filterActive;
  }

  switchTab(tab: string) {
    this.activeTab = tab;
    this.searchTerm = '';
    this.filterActive = '';
    this.filterMainIndicator = '';
    this.filterDept = '';
    this.filterFiscalYear = '';
    this.hospFilterDistid = '';
    this.hospFilterHostype = '';
    this.khdCompareFilter = '';
    this.applyFilter();
  }

  // === สูตรคำนวณผลงานเฉพาะตัวชี้วัด (result_formula) — ใช้ evaluator เดียวกับ dashboard (shared/kpi-formula.ts)
  //     ซึ่งตรงกับ backend (api/kpi-formula.js) ทุกเคส ผลทดลองคำนวณในหน้านี้จึงตรงกับที่ระบบคำนวณจริง
  readonly FORMULA_MONTHS: { v: string; l: string }[] = [
    { v: 'm10', l: 'ต.ค.' }, { v: 'm11', l: 'พ.ย.' }, { v: 'm12', l: 'ธ.ค.' }, { v: 'm01', l: 'ม.ค.' },
    { v: 'm02', l: 'ก.พ.' }, { v: 'm03', l: 'มี.ค.' }, { v: 'm04', l: 'เม.ย.' }, { v: 'm05', l: 'พ.ค.' },
    { v: 'm06', l: 'มิ.ย.' }, { v: 'm07', l: 'ก.ค.' }, { v: 'm08', l: 'ส.ค.' }, { v: 'm09', l: 'ก.ย.' },
  ];
  readonly FORMULA_FUNCTIONS = FORMULA_FUNCTIONS;
  readonly FORMULA_EXAMPLES: { f: string; d: string }[] = [
    { f: 'AVG(ALL)', d: 'ค่าเฉลี่ยทุกเดือนที่มีผลงาน' },
    { f: '(base - SUM(ALL)) / base * 100', d: 'ร้อยละการลดลงจากค่าฐานของหน่วยบริการ (เช่น ค่าเฉลี่ย 5 ปีของผู้เสียชีวิตจากการจมน้ำ) — บันทึกรายเดือนเป็นจำนวน' },
    { f: 'SUM(ALL)', d: 'ผลรวมทุกเดือน' },
    { f: 'MAX(ALL)', d: 'ค่าสูงสุด' },
    { f: '(m10+m11+m12)/3', d: 'เฉลี่ยไตรมาส 1' },
    { f: 'SUM(m10,m11,m12)', d: 'รวมไตรมาส 1' },
    { f: '(LAST(ALL) - prev_result) / prev_result * 100', d: 'ร้อยละการเปลี่ยนแปลงเทียบผลงานปีงบที่แล้ว' },
    { f: 'SUM(ALL) + SUM(PREV_ALL)', d: 'ผลรวมสะสมต่อเนื่อง 2 ปีงบ' },
    { f: 'LAST(ALL) - LAST(PREV_ALL)', d: 'ผลต่างจากค่าเดือนล่าสุดของปีที่แล้ว' },
  ];
  formulaTestMonths: Record<string, string> = {};
  formulaTestTarget = '';
  formulaTestBase = '';   // ค่าฐาน (base) สำหรับทดลองคำนวณ — แสดงเมื่อสูตรใช้ base
  // ข้อมูลปีงบที่แล้วสำหรับทดลองคำนวณ (แสดงเฉพาะเมื่อสูตรอ้าง prev_* / PREV_ALL)
  formulaTestPrevMonths: Record<string, string> = {};
  formulaTestPrevTarget = '';
  formulaTestPrevResult = '';

  get formulaUsesPrev(): boolean {
    const f = String(this.currentItem?.result_formula || '').trim();
    return !!f && !this.formulaError && usesPrevYear(f);
  }

  // สูตรผลงาน/สูตรร้อยละอ้างค่าฐาน (base) ของหน่วยบริการ — แสดงช่องทดลองค่าฐาน + คำอธิบาย
  get formulaUsesBase(): boolean {
    const f = String(this.currentItem?.result_formula || '').trim();
    const p = String(this.currentItem?.pct_formula || '').trim();
    return (!!f && !this.formulaError && usesBase(f)) || (!!p && !this.pctFormulaError && usesBase(p));
  }

  // ===== ค่าเพิ่มเติมของหน่วยบริการที่ตั้งชื่อเอง (custom_vars) + สูตรร้อยละ (pct_formula) — 25 ต.ค. 2569 =====
  // ชื่อ (key) ใช้ในสูตร ค่าของแต่ละหน่วยบริการกรอกที่หน้าบันทึกผลงาน (ใต้เป้าหมาย) หรือนำเข้า Excel — base (ค่าฐาน) ใช้ได้เสมอ
  readonly MAX_CUSTOM_VARS = 10;
  formulaTestVars: Record<string, string> = {};   // ค่าเพิ่มเติมสำหรับทดลองคำนวณ (base ใช้ formulaTestBase)
  formulaTestResultInput = '';                     // ผลงานสำหรับทดลองสูตรร้อยละ เมื่อไม่ได้ตั้งสูตรผลงาน
  get customVarKeys(): string[] {
    return (this.currentItem?.custom_vars || []).map((v: any) => String(v?.key || '').trim().toLowerCase()).filter((k: string) => isValidVarKey(k));
  }
  get customVarsError(): string | null {
    const seen = new Set<string>();
    for (const v of (this.currentItem?.custom_vars || [])) {
      const k = String(v?.key || '').trim().toLowerCase();
      if (!k && !String(v?.label || '').trim()) continue;
      if (!isValidVarKey(k)) return `ชื่อ "${k || '(ว่าง)'}" ใช้ไม่ได้ — ภาษาอังกฤษตัวเล็ก a-z ตามด้วย a-z 0-9 _ ไม่เกิน 20 ตัว และห้ามซ้ำชื่อในตัว (target, result, m10, prev_…, sum …)`;
      if (seen.has(k)) return `ชื่อ "${k}" ซ้ำกัน`;
      seen.add(k);
    }
    return seen.size > this.MAX_CUSTOM_VARS ? `ค่าเพิ่มเติมได้ไม่เกิน ${this.MAX_CUSTOM_VARS} ค่า` : null;
  }
  addCustomVar(): void {
    if (!Array.isArray(this.currentItem.custom_vars)) this.currentItem.custom_vars = [];
    this.currentItem.custom_vars.push({ key: '', label: '' });
  }
  removeCustomVar(i: number): void {
    this.currentItem.custom_vars.splice(i, 1);
  }
  get hasPctFormula(): boolean {
    return !!String(this.currentItem?.pct_formula || '').trim();
  }
  get pctFormulaError(): string | null {
    if (this.currentItem?.pct_manual) return null;   // กรอกร้อยละเอง — ไม่ใช้สูตรร้อยละ (ส่งเป็นค่าว่าง)
    const p = String(this.currentItem?.pct_formula || '').trim();
    return p ? validateFormula(p, this.customVarKeys, ['result']) : null;
  }
  // ค่าเพิ่มเติมที่สูตรผลงาน/สูตรร้อยละใช้ (ยกเว้น base ที่มีช่องแยก และ result) — แสดงช่องทดลองค่า
  get formulaTestVarKeys(): string[] {
    const out = new Set<string>();
    for (const f of [this.currentItem?.result_formula, this.currentItem?.pct_formula]) {
      const s = String(f || '').trim();
      if (s) formulaVarNames(s).forEach(n => { if (n !== 'base' && n !== 'result') out.add(n); });
    }
    return [...out];
  }
  customVarLabel(key: string): string {
    return (this.currentItem?.custom_vars || []).find((v: any) => String(v?.key || '').toLowerCase() === key)?.label || key;
  }
  private get formulaTestVarValues(): Record<string, any> {
    return { ...this.formulaTestVars, base: this.formulaTestBase };
  }
  // ทดลองสูตรร้อยละ: ผลงาน = ผลทดลองสูตรผลงาน (ถ้ามี) ไม่งั้นใช้ค่าที่กรอก
  get pctTestResult(): number | null {
    const p = String(this.currentItem?.pct_formula || '').trim();
    if (!p || this.pctFormulaError) return null;
    const result = this.hasFormula && !this.formulaError ? this.formulaTestResult?.value : this.formulaTestResultInput;
    const v = evaluateFormula(p, this.formulaTestMonths, this.formulaTestTarget, {
      months: this.formulaTestPrevMonths, target: this.formulaTestPrevTarget, result: this.formulaTestPrevResult,
    }, { ...this.formulaTestVarValues, result });
    return v === null ? null : Number(v);
  }
  insertPctToken(token: string, input: HTMLInputElement) {
    const cur = String(this.currentItem.pct_formula || '');
    const start = input.selectionStart ?? cur.length;
    const end = input.selectionEnd ?? cur.length;
    const text = FORMULA_FUNCTIONS.includes(token) ? `${token}(ALL)` : token;
    this.currentItem.pct_formula = cur.slice(0, start) + text + cur.slice(end);
    setTimeout(() => { input.focus(); const p = start + text.length; input.setSelectionRange(p, p); });
  }

  get hasFormula(): boolean {
    return !!String(this.currentItem?.result_formula || '').trim();
  }

  // null = สูตรถูกต้องหรือไม่ได้ตั้งสูตร
  get formulaError(): string | null {
    const f = String(this.currentItem?.result_formula || '').trim();
    return f ? validateFormula(f, this.customVarKeys) : null;
  }

  get formulaTestResult(): { value: string | null; pct: number | null } | null {
    const f = String(this.currentItem?.result_formula || '').trim();
    if (!f || this.formulaError) return null;
    const value = evaluateFormula(f, this.formulaTestMonths, this.formulaTestTarget, {
      months: this.formulaTestPrevMonths, target: this.formulaTestPrevTarget, result: this.formulaTestPrevResult,
    }, this.formulaTestVarValues);
    // ร้อยละ: สูตรร้อยละ (ถ้าตั้ง) ไม่งั้นตามเงื่อนไขเป้าหมายที่เลือก (≥ > ≤ < =) — กฎเดียวกับหน้าบันทึกผลงาน
    const p = String(this.currentItem?.pct_formula || '').trim();
    if (p && !this.pctFormulaError) {
      const pv = value === null ? null : evaluateFormula(p, this.formulaTestMonths, this.formulaTestTarget, null, { ...this.formulaTestVarValues, result: value });
      return { value, pct: pv === null ? null : Number(pv) };
    }
    const r = value === null ? null : evaluateTarget(value, this.formulaTestTarget, this.currentItem?.target_condition);
    return { value, pct: r && r.pct !== null ? Math.round(r.pct * 100) / 100 : null };
  }

  // ===== เงื่อนไขเป้าหมาย (target_condition) + วิธีคิดผลงาน (22 ต.ค. 2569) =====
  readonly TARGET_CONDITION_OPTIONS = TARGET_CONDITIONS.map(c => ({ v: c, l: `${CONDITION_SYMBOL[c]} ${CONDITION_LABEL[c]}` }));

  // คำอธิบายใต้ dropdown เงื่อนไข: ผ่านเมื่อใด + วิธีคิดร้อยละ พร้อมตัวอย่างตัวเลข
  get conditionHelp(): { pass: string; pct: string; example: string } {
    const c = normalizeCondition(this.currentItem?.target_condition);
    const sym = CONDITION_SYMBOL[c];
    if (c === 'LTE' || c === 'LT') return {
      pass: `ผ่านเมื่อผลงาน ${sym} เป้าหมาย (ยิ่งน้อยยิ่งดี)`,
      pct: 'ร้อยละ = เป้าหมาย ÷ ผลงาน × 100 (ผลงาน 0 = 100%)',
      example: `เป้าหมาย 8: ผลงาน 4 = 200% ผ่าน, ผลงาน 8 = 100% ${c === 'LTE' ? 'ผ่าน' : 'ไม่ผ่าน'}, ผลงาน 10 = 80% ไม่ผ่าน`,
    };
    if (c === 'EQ') return {
      pass: 'ผ่านเมื่อผลงานเท่ากับเป้าหมายพอดี',
      pct: 'ร้อยละ = ค่าน้อย ÷ ค่ามาก × 100 (ความใกล้เคียงเป้าหมาย)',
      example: 'เป้าหมาย 100: ผลงาน 100 = 100% ผ่าน, ผลงาน 90 = 90%, ผลงาน 125 = 80% ไม่ผ่าน',
    };
    return {
      pass: `ผ่านเมื่อผลงาน ${sym} เป้าหมาย${this.currentItem?.target_condition ? '' : ' (ไม่ระบุ = ≥)'}`,
      pct: 'ร้อยละ = ผลงาน ÷ เป้าหมาย × 100',
      example: `เป้าหมาย 80: ผลงาน 90 = 112.5% ผ่าน, ผลงาน 80 = 100% ${c === 'GT' ? 'ไม่ผ่าน' : 'ผ่าน'}, ผลงาน 40 = 50% ไม่ผ่าน`,
    };
  }

  // วิธีคิด "ผลงาน" แบบสำเร็จรูป — เป็นแค่ทางลัดของ is_cumulative + result_formula เดิม (ไม่มีคอลัมน์ใหม่)
  readonly RESULT_METHODS: { v: ResultMethod; l: string; d: string }[] = [
    { v: 'last', l: 'ค่าเดือนล่าสุด', d: 'ผลงาน = ค่าของเดือนล่าสุดที่บันทึก (ค่าตั้งต้น)' },
    { v: 'sum', l: 'ผลรวมสะสม', d: 'ผลงาน = รวมทุกเดือนในปีงบ (ตัวชี้วัดนับสะสม เช่น จำนวนราย)' },
    { v: 'avg', l: 'ค่าเฉลี่ย', d: 'ผลงาน = ค่าเฉลี่ยของเดือนที่มีผลงาน — สูตร AVG(ALL)' },
    { v: 'max', l: 'ค่าสูงสุด', d: 'ผลงาน = ค่าสูงสุดของเดือนที่มีผลงาน — สูตร MAX(ALL)' },
    { v: 'min', l: 'ค่าต่ำสุด', d: 'ผลงาน = ค่าต่ำสุดของเดือนที่มีผลงาน — สูตร MIN(ALL)' },
    { v: 'custom', l: 'สูตรกำหนดเอง', d: 'กำหนดสูตรเองในกล่องสูตรคำนวณผลงานด้านล่าง' },
    { v: 'manual', l: 'กรอกเอง (ไม่คำนวณ)', d: 'ผู้บันทึกกรอก "ผลงานล่าสุด" เองในหน้าบันทึกผลงาน — ช่องรายเดือนยังกรอกได้แต่ไม่นำมาคำนวณ, ยังไม่กรอก = ว่าง' },
  ];
  private _resultMethodCustomFor: any = null; // จำว่าเลือก "สูตรกำหนดเอง" ไว้สำหรับรายการนี้ (กันสลับกลับเองเมื่อสูตรยังว่าง)

  get resultMethod(): ResultMethod {
    if (this._resultMethodCustomFor && this._resultMethodCustomFor === this.currentItem) return 'custom';
    return resultMethodOf(this.currentItem);
  }
  set resultMethod(m: ResultMethod) {
    if (!this.currentItem) return;
    this._resultMethodCustomFor = m === 'custom' ? this.currentItem : null;
    applyResultMethod(this.currentItem, m);
  }
  get resultMethodDesc(): string {
    return this.RESULT_METHODS.find(x => x.v === this.resultMethod)?.d || '';
  }

  // แทรกตัวแปร/ฟังก์ชันที่ตำแหน่งเคอร์เซอร์ในช่องสูตร
  insertFormulaToken(token: string, input: HTMLInputElement) {
    const cur = String(this.currentItem.result_formula || '');
    const start = input.selectionStart ?? cur.length;
    const end = input.selectionEnd ?? cur.length;
    // ปุ่มฟังก์ชันแทรกพร้อม (ALL) — ปุ่ม "PREV_ALL" แทรกเฉพาะคำ (ใช้เป็นอาร์กิวเมนต์ของฟังก์ชัน)
    const text = FORMULA_FUNCTIONS.includes(token) ? `${token}(ALL)` : token;
    this.currentItem.result_formula = cur.slice(0, start) + text + cur.slice(end);
    setTimeout(() => {
      input.focus();
      const pos = start + text.length;
      input.setSelectionRange(pos, pos);
    });
  }

  // รหัสของตัวชี้วัด (modal เพิ่ม/แก้ไข): เพิ่มใหม่ = ระบบสร้างให้อัตโนมัติ (codeAuto) จนกว่าผู้ใช้จะพิมพ์แก้เอง
  codeAuto = false;
  showCodeFields = false;
  codeSuggestLoading = false;

  // ชื่อตัวชี้วัดอื่นที่ใช้ชื่อตาราง (table_process) เดียวกับที่กรอกอยู่ — null = ไม่ซ้ำ (เตือนเฉยๆ ไม่บล็อก: ข้อมูลเดิมมีที่ตั้งใจใช้ร่วมกัน)
  get tableProcessDuplicateName(): string | null {
    const tp = String(this.currentItem?.table_process || '').trim().toLowerCase();
    if (!tp || this.activeTab !== 'indicators') return null;
    const dup = this.indicators.find((i: any) =>
      String(i.table_process || '').trim().toLowerCase() === tp && Number(i.id) !== Number(this.currentItem?.id));
    return dup ? String(dup.kpi_indicators_name || '') : null;
  }

  // ขอรหัสที่ระบบแนะนำ (ตามหน่วยงานที่เลือก) มาแสดงตัวอย่าง — รหัสจริงสร้างที่ backend ตอนบันทึกอีกครั้ง (กันชนกัน)
  refreshSuggestedCodes() {
    if (this.isEditMode || !this.codeAuto || this.activeTab !== 'indicators') return;
    this.codeSuggestLoading = true;
    this.authService.suggestIndicatorCode(this.currentItem?.dept_id ?? null).subscribe({
      next: (res: any) => {
        this.codeSuggestLoading = false;
        if (res?.success && this.showModal && this.codeAuto && !this.isEditMode) {
          this.currentItem.table_process = res.data.table_process;
          this.currentItem.kpi_indicators_code = res.data.kpi_indicators_code;
        }
        this.cdr.detectChanges();
      },
      error: () => { this.codeSuggestLoading = false; this.cdr.detectChanges(); }
    });
  }

  onDeptChangeInModal() {
    this.refreshSuggestedCodes();
  }

  onCodeManualEdit() {
    this.codeAuto = false;
  }

  useSuggestedCodes() {
    this.codeAuto = true;
    this.refreshSuggestedCodes();
  }

  openModal(item: any = null) {
    this.codeAuto = !item && this.activeTab === 'indicators';
    this.showCodeFields = false;
    this.codeSuggestLoading = false;
    this.formulaTestMonths = {};
    this.formulaTestTarget = String(item?.target_percentage ?? '');
    this.formulaTestBase = '';
    this.formulaTestVars = {};
    this.formulaTestResultInput = '';
    this.formulaTestPrevMonths = {};
    this.formulaTestPrevTarget = '';
    this.formulaTestPrevResult = '';
    this.isEditMode = !!item;
    if (item) {
      const src = { ...item };
      src.is_active = Number(src.is_active ?? 1);
      src.sort_order = Number(src.sort_order ?? 0);
      if (this.activeTab === 'indicators') {
        src.r9 = Number(src.r9) === 1;
        src.moph = Number(src.moph) === 1;
        src.ssj = Number(src.ssj) === 1;
        src.rmw = Number(src.rmw) === 1;
        src.other = Number(src.other) === 1;
        src.is_cumulative = Number(src.is_cumulative) === 1;
        src.use_sub_indicator_export = Number(src.use_sub_indicator_export) === 1;
        src.result_formula = src.result_formula || '';
        src.custom_vars = parseCustomVars(src.custom_vars).map(v => ({ ...v }));   // ค่าเพิ่มเติมที่ตั้งชื่อเอง (แก้ไขในหน้าต่าง)
        src.pct_formula = src.pct_formula || '';
        src.result_manual = Number(src.result_manual) === 1;   // ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569)
        src.pct_manual = Number(src.pct_manual) === 1;
        src.target_monthly = normalizeTargetMonthly(src.target_monthly);   // เป้าหมายรายเดือน (29 ต.ค. 2569) — '' = เป้าหมายเดียวทั้งปี
        src.evaluation_mode = src.evaluation_mode || 'any_one';
        src.sub_rollup_mode = src.sub_rollup_mode === 'manual' ? 'manual' : 'auto';
        src.item_no = src.item_no || '';
        src.export_items = Number(src.export_items) === 1;
        this.selectedOffTypes = this.parseOffTypes(src.required_off_types);
        // auto-set yut_id จาก main_indicator ที่เลือก
        this.selectedYutInModal = src.yut_id ? Number(src.yut_id) : null;
      }
      this.currentItem = src;
    } else {
      const baseDefaults = { is_active: 1, sort_order: 0 };
      if (this.activeTab === 'indicators') {
        this.selectedYutInModal = null;
        this.selectedOffTypes = [];
        this.currentItem = { ...baseDefaults, r9: false, moph: false, ssj: false, rmw: false, other: false, is_cumulative: false, use_sub_indicator_export: false, result_formula: '', custom_vars: [], pct_formula: '', result_manual: false, pct_manual: false, target_monthly: '', weight: 1, target_condition: 'GTE', evaluation_mode: 'any_one', sub_rollup_mode: 'auto', item_no: '', export_items: false };
      } else {
        this.currentItem = { ...baseDefaults };
      }
    }
    this.rebuildMainForModal();
    this.showModal = true;
    this.refreshSuggestedCodes();
  }

  // คัดลอกตัวชี้วัดไปปีใหม่ — เปิด modal พร้อม pre-fill ข้อมูลเดิม แต่บันทึกเป็นแถวใหม่ (กันย้อนเปลี่ยนชื่อของปีเก่า)
  cloneItem(item: any) {
    this.openModal(item);
    this.isEditMode = false;           // บังคับให้ saveItem() ยิง POST (สร้างใหม่) ไม่ใช่ PUT
    delete this.currentItem.id;        // ตัด id ออก กัน saveItem() หลุดไปอัปเดตแถวเดิม
    this.currentItem.kpi_indicators_name = (item.kpi_indicators_name || '') + ' (คัดลอก)'; // ชื่อชั่วคราว — ต้องแก้ก่อนบันทึก
    this._cloneSourceId = item.id;
    this.showCodeFields = true;
  }

  // เมื่อเลือกยุทธศาสตร์ → กรอง main_indicators dropdown
  onYutChangeInModal() {
    this.currentItem.main_indicator_id = null;
    this.rebuildMainForModal();
  }

  private rebuildMainForModal() {
    if (this.selectedYutInModal) {
      this.filteredMainForModal = this.mainIndicators.filter((m: any) => Number(m.yut_id) === Number(this.selectedYutInModal));
    } else {
      this.filteredMainForModal = this.mainIndicators;
    }
  }

  // เมื่อเลือก main_indicator → auto-set yut_id
  onMainIndicatorChangeInModal() {
    const mid = this.currentItem.main_indicator_id;
    if (mid) {
      const mi = this.mainIndicators.find((m: any) => Number(m.id) === Number(mid));
      if (mi?.yut_id) this.selectedYutInModal = Number(mi.yut_id);
    }
  }

  closeModal() {
    this.showModal = false;
    this.currentItem = {};
  }

  saveItem() {
    let observable;
    const id = this.currentItem.id;

    if (this.activeTab === 'indicators') {
      // สูตรคำนวณผลงานผิด → ไม่ส่งไป backend (backend ก็ปฏิเสธด้วย 400 อยู่แล้ว แต่แจ้งตรงนี้ชัดกว่า)
      if (this.customVarsError) {
        Swal.fire('ค่าเพิ่มเติมไม่ถูกต้อง', this.customVarsError, 'warning');
        return;
      }
      if (this.formulaError) {
        Swal.fire('สูตรคำนวณผลงานไม่ถูกต้อง', this.formulaError, 'warning');
        return;
      }
      if (this.pctFormulaError) {
        Swal.fire('สูตรร้อยละไม่ถูกต้อง', this.pctFormulaError, 'warning');
        return;
      }
      // Serialize evaluation_mode + required_off_types (เฉพาะ any_one)
      const payload = { ...this.currentItem };
      // ยุทธศาสตร์ของตัวชี้วัดโดยตรง — ใช้แสดงเมื่อไม่มีหมวดหมู่หลัก (มีหมวดหมู่ = ยุทธศาสตร์ตามหมวดหมู่)
      payload.main_yut = this.selectedYutInModal ?? null;
      delete payload.yut_id; delete payload.yut_name;
      payload.result_formula = String(payload.result_formula || '').trim() || null;
      payload.custom_vars = (payload.custom_vars || [])
        .map((v: any) => ({ key: String(v?.key || '').trim().toLowerCase(), label: String(v?.label || '').trim() }))
        .filter((v: any) => v.key);
      payload.pct_formula = String(payload.pct_formula || '').trim() || null;
      // ผลงานล่าสุด / ร้อยละ แบบกรอกเอง — กรอกร้อยละเองแล้วไม่ใช้สูตรร้อยละ
      payload.result_manual = payload.result_manual ? 1 : 0;
      payload.pct_manual = payload.pct_manual ? 1 : 0;
      if (payload.pct_manual) payload.pct_formula = null;
      payload.target_monthly = normalizeTargetMonthly(payload.target_monthly);   // เป้าหมายรายเดือน — '' = เป้าหมายเดียวทั้งปี
      payload.required_off_types = payload.evaluation_mode === 'any_one' && this.selectedOffTypes.length > 0
        ? this.selectedOffTypes
        : null;
      // รหัสอัตโนมัติ: ส่งค่าว่างให้ backend สร้างรหัสจริงตอนบันทึก (ค่าที่แสดงเป็นเพียงตัวอย่าง อาจมีคนอื่นใช้ลำดับนั้นไปก่อน)
      if (!this.isEditMode && this.codeAuto) {
        payload.table_process = '';
        payload.kpi_indicators_code = '';
      }
      observable = this.isEditMode ? this.authService.updateIndicator(id, payload) : this.authService.createIndicator(payload);
    } else if (this.activeTab === 'main-indicators') {
      observable = this.isEditMode ? this.authService.updateMainIndicator(id, this.currentItem) : this.authService.createMainIndicator(this.currentItem);
    } else if (this.activeTab === 'strategies') {
      observable = this.isEditMode ? this.authService.updateMainYut(id, this.currentItem) : this.authService.createMainYut(this.currentItem);
    } else if (this.activeTab === 'departments') {
      observable = this.isEditMode ? this.authService.updateDepartment(id, this.currentItem) : this.authService.createDepartment(this.currentItem);
    } else if (this.activeTab === 'hospitals') {
      // hoscode = primary key (string)
      const payload: any = {
        hoscode: this.currentItem.hoscode,
        hosname: this.currentItem.hosname,
        hostype: this.currentItem.hostype,
        provcode: this.currentItem.provcode,
        distcode: this.currentItem.distcode
      };
      observable = this.isEditMode
        ? this.authService.updateHospital(this.currentItem.hoscode, payload)
        : this.authService.createHospital(payload);
    }

    if (observable) {
      const cloneSourceId = this._cloneSourceId;
      this._cloneSourceId = null;
      observable.subscribe({
        next: (res) => {
          if (res.success) {
            this.closeModal();
            this.loadAllData();
            if (cloneSourceId && !this.isEditMode) {
              // มาจากปุ่ม "คัดลอกไปปีใหม่" — ถามว่าจะปิดใช้งานตัวเดิมไหม (ข้อมูลปีเก่าไม่หายแน่นอน)
              Swal.fire({
                title: 'บันทึกตัวชี้วัดใหม่สำเร็จ',
                text: 'ต้องการปิดใช้งานตัวชี้วัดเดิมหรือไม่ (เนื่องจากถูกแทนที่ด้วยตัวใหม่แล้ว)',
                icon: 'question', showCancelButton: true,
                confirmButtonText: 'ปิดใช้งานตัวเดิม', cancelButtonText: 'ไม่ — เก็บไว้ทั้งคู่'
              }).then(r => {
                if (r.isConfirmed) {
                  this.authService.toggleIndicatorActive(cloneSourceId, false).subscribe({
                    next: (r2: any) => { if (r2.success) { this.loadAllData(); } },
                    error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถปิดใช้งานตัวเดิมได้', 'error')
                  });
                }
              });
            } else {
              Swal.fire('สำเร็จ', res.table_process ? `บันทึกข้อมูลเรียบร้อย (ชื่อตาราง: ${res.table_process})` : 'บันทึกข้อมูลเรียบร้อย', 'success');
            }
          }
          this.cdr.detectChanges();
        },
        error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถบันทึกข้อมูลได้', 'error')
      });
    }
  }

  deleteItem(id: number) {
    const item = this.activeTab === 'indicators' ? this.indicators.find(i => i.id === id) : null;
    const resultCount = item?.result_count || 0;
    Swal.fire({
      title: 'ยืนยันการลบ',
      html: resultCount > 0
        ? `<p>ตัวชี้วัดนี้มี<b>ผลงานบันทึกแล้ว ${resultCount} รายการ</b></p><p class="text-red-600 text-sm mt-1">ระบบจะไม่อนุญาตให้ลบ กรุณา "ปิดใช้งาน" แทน</p>`
        : 'คุณต้องการลบข้อมูลนี้ใช่หรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      confirmButtonText: 'ลบ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        let observable;
        if (this.activeTab === 'indicators') observable = this.authService.deleteIndicator(id);
        else if (this.activeTab === 'main-indicators') observable = this.authService.deleteMainIndicator(id);
        else if (this.activeTab === 'strategies') observable = this.authService.deleteMainYut(id);
        else if (this.activeTab === 'departments') observable = this.authService.deleteDepartment(id);
        else if (this.activeTab === 'hospitals') observable = this.authService.deleteHospital(String(id));

        if (observable) {
          observable.subscribe({
            next: (res) => {
              if (res.success) {
                Swal.fire('ลบสำเร็จ', 'ข้อมูลถูกลบแล้ว', 'success');
                this.loadAllData();
              }
              this.cdr.detectChanges();
            },
            error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถลบข้อมูลได้ (อาจมีการใช้งานอยู่)', 'error')
          });
        }
      }
    });
  }

  toggleActive(item: any) {
    const newStatus = !item.is_active || item.is_active === 0;
    const doToggle = () => {
      let observable;
      if (this.activeTab === 'indicators') {
        observable = this.authService.toggleIndicatorActive(item.id, newStatus);
      } else if (this.activeTab === 'main-indicators') {
        observable = this.authService.toggleMainIndicatorActive(item.id, newStatus);
      } else if (this.activeTab === 'strategies') {
        observable = this.authService.toggleStrategyActive(item.id, newStatus);
      } else if (this.activeTab === 'departments') {
        observable = this.authService.toggleDepartmentActive(item.id, newStatus);
      }

      if (observable) {
        observable.subscribe({
          next: (res) => {
            if (res.success) {
              item.is_active = newStatus ? 1 : 0;
              this.applyFilter();
            }
          },
          error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถเปลี่ยนสถานะได้', 'error')
        });
      }
    };

    // ปิดใช้งานตัวชี้วัดที่มีผลงานแล้ว — เตือนก่อน แต่ยังดำเนินการต่อได้ถ้ายืนยัน
    if (this.activeTab === 'indicators' && !newStatus && item.result_count > 0) {
      Swal.fire({
        title: 'ยืนยันการปิดใช้งาน',
        html: `<p>ตัวชี้วัดนี้มี<b>ผลงานบันทึกแล้ว ${item.result_count} รายการ</b></p><p class="text-sm text-gray-500 mt-1">การปิดใช้งานไม่ลบข้อมูลเดิม แต่จะซ่อนตัวชี้วัดนี้จากรายการหลัก</p>`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#f59e0b',
        confirmButtonText: 'ปิดใช้งาน',
        cancelButtonText: 'ยกเลิก'
      }).then(r => { if (r.isConfirmed) doToggle(); });
    } else {
      doToggle();
    }
  }

  // แสดงรายละเอียดหน่วยบริการ+ปีที่มีผลงานบันทึกแล้วของตัวชี้วัด
  openResultSummary(item: any) {
    this.authService.getIndicatorResultSummary(item.id).subscribe({
      next: (res: any) => {
        if (!res.success) { Swal.fire('ผิดพลาด', res.message || 'ไม่สามารถโหลดข้อมูลได้', 'error'); return; }
        const rows = res.data || [];
        const tableRows = rows.map((r: any) => `
          <tr class="border-b border-gray-100">
            <td class="px-2 py-1.5 text-left">${r.hosname || r.hospcode}</td>
            <td class="px-2 py-1.5 text-center">${r.year_bh}</td>
            <td class="px-2 py-1.5 text-center">${r.month_count}</td>
          </tr>`).join('');
        Swal.fire({
          title: item.kpi_indicators_name,
          html: `
            <div class="text-left max-h-80 overflow-y-auto">
              <table class="w-full text-xs">
                <thead class="bg-gray-50 sticky top-0">
                  <tr>
                    <th class="px-2 py-1.5 text-left">หน่วยบริการ</th>
                    <th class="px-2 py-1.5 text-center">ปีงบ</th>
                    <th class="px-2 py-1.5 text-center">จำนวนเดือน</th>
                  </tr>
                </thead>
                <tbody>${tableRows || '<tr><td colspan="3" class="px-2 py-4 text-center text-gray-400">ไม่พบข้อมูล</td></tr>'}</tbody>
              </table>
            </div>`,
          confirmButtonText: 'ปิด',
          confirmButtonColor: '#10b981',
          width: 500
        });
      },
      error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลได้', 'error')
    });
  }

  getActiveCount(): number {
    if (this.activeTab === 'indicators') return this.indicators.filter(i => Number(i.is_active) === 1).length;
    if (this.activeTab === 'main-indicators') return this.mainIndicators.filter(i => Number(i.is_active) === 1).length;
    if (this.activeTab === 'strategies') return this.strategies.filter(i => Number(i.is_active) === 1).length;
    if (this.activeTab === 'departments') return this.departments.filter(i => Number(i.is_active) === 1).length;
    if (this.activeTab === 'hospitals') return this.hospitals.length;
    return 0;
  }

  getInactiveCount(): number {
    if (this.activeTab === 'indicators') return this.indicators.filter(i => Number(i.is_active) === 0).length;
    if (this.activeTab === 'main-indicators') return this.mainIndicators.filter(i => Number(i.is_active) === 0).length;
    if (this.activeTab === 'strategies') return this.strategies.filter(i => Number(i.is_active) === 0).length;
    if (this.activeTab === 'departments') return this.departments.filter(i => Number(i.is_active) === 0).length;
    return 0;
  }

  // ============================================================
  // KHD Compare — ระบบเทียบชื่อตัวชี้วัด/สถานะกับ KHD (ย้ายจาก kpi-manager)
  // ============================================================

  /** เรียก /report-compare แล้ว build map by table_process */
  runKhdCompare() {
    if (!this.isSuperAdmin) {
      Swal.fire('แจ้งเตือน', 'เฉพาะ super_admin', 'warning');
      return;
    }
    this.khdCompareLoading = true;
    this.cdr.detectChanges();
    this.authService.reportCompare(this.khdCompareYear).subscribe({
      next: (res: any) => {
        this.khdCompareLoading = false;
        if (res.success) {
          this.khdCompareMap.clear();
          for (const it of (res.items || [])) {
            if (it.table_process) this.khdCompareMap.set(it.table_process, it);
          }
          this.khdCompareSummary = res.summary;
          this.khdCompareLastRun = new Date();
          this.khdMissingLocalSelected.clear();
          this.applyFilter();
          this.cdr.detectChanges();
        }
      },
      error: (err: any) => {
        this.khdCompareLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเทียบกับ KHD ได้ (ตรวจ Remote DB)', 'error');
      }
    });
  }

  /** เชื่อมโยง kpi_indicators.khd_report_id + data_source ถาวรกับ KHD reports (ทุกตัวชี้วัด ทั้ง hdc/excel/local-only) */
  syncKhdLink() {
    if (!this.isSuperAdmin) return;
    this.khdLinkSyncLoading = true;
    this.cdr.detectChanges();
    this.authService.syncKhdLink().subscribe({
      next: (res: any) => {
        this.khdLinkSyncLoading = false;
        if (res.success) {
          Swal.fire('สำเร็จ', res.message, 'success');
          this.authService.getIndicators(true).subscribe((r: any) => {
            if (r.success) { this.indicators = r.data; this.applyFilter(); this.cdr.detectChanges(); }
          });
        } else {
          Swal.fire('ผิดพลาด', res.message, 'error');
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.khdLinkSyncLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเชื่อมโยง KHD ได้ (ตรวจ Remote DB)', 'error');
      }
    });
  }

  /** สถานะ compare ของ indicator แต่ละตัว — ใช้กับ badge + filter */
  getKhdCompareStatus(item: any): 'not_compared' | 'match' | 'different' | 'missing_remote' {
    if (!this.khdCompareMap.size) return 'not_compared';
    const khd = item.table_process ? this.khdCompareMap.get(item.table_process) : null;
    if (!khd) return 'missing_remote';
    return khd.status === 'match' ? 'match' : (khd.status === 'different' ? 'different' : 'missing_remote');
  }

  /** ข้อมูล KHD ดิบของ indicator (ใช้แสดง diff inline) */
  getKhdData(item: any): any | null {
    return item.table_process ? (this.khdCompareMap.get(item.table_process) || null) : null;
  }

  /** Sync ชื่อจาก KHD → Local 1 ตัว (POST /report-compare/sync ด้วย khd_report_id เดียว) */
  syncSingleNameFromKhd(item: any) {
    const khd = this.getKhdData(item);
    if (!khd || !khd.khd_report_id) {
      Swal.fire('แจ้งเตือน', 'ไม่พบ KHD report — กดเทียบกับ KHD ก่อน', 'info');
      return;
    }
    if (khd.status !== 'different') {
      Swal.fire('แจ้งเตือน', 'ตัวชี้วัดนี้ตรงกับ KHD อยู่แล้ว', 'info');
      return;
    }
    Swal.fire({
      title: 'Sync ชื่อจาก KHD',
      html: `<div class="text-left text-sm space-y-2">
        <p>เปลี่ยนชื่อตัวชี้วัด Local ให้ตรงกับ KHD:</p>
        <div class="bg-rose-50 border border-rose-200 rounded p-2 text-xs">
          <p class="text-rose-700 font-bold">ปัจจุบัน (Local):</p>
          <p class="text-gray-700">${item.kpi_indicators_name}</p>
        </div>
        <div class="text-center text-gray-400"><i class="fas fa-arrow-down"></i></div>
        <div class="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs">
          <p class="text-emerald-700 font-bold">ใหม่ (จาก KHD):</p>
          <p class="text-gray-700">${khd.khd_name}</p>
        </div>
      </div>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: '<i class="fas fa-sync mr-1"></i> Sync', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.reportCompareSync([khd.khd_report_id]).subscribe({
        next: (res: any) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'Sync สำเร็จ', text: res.message, timer: 2000 });
            this.loadAllData();
            this.runKhdCompare();
          }
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'Sync ไม่ได้', 'error')
      });
    });
  }

  /** Toggle upload_excel ราย indicator */
  toggleUploadExcel(item: any) {
    if (!this.isSuperAdmin) return;
    const newVal = (item.upload_excel === 1 || item.upload_excel === '1') ? 0 : 1;
    this.authService.setUploadExcel(item.id, newVal as 0 | 1).subscribe({
      next: (res: any) => {
        if (res.success) {
          item.upload_excel = res.upload_excel;
          // ถ้ามี compare data — อัพเดท suggest_disable ด้วย
          const khd = this.getKhdData(item);
          if (khd) {
            khd.local_upload_excel = res.upload_excel;
            khd.suggest_disable_upload = (khd.khd_is_active === 0 || khd.khd_is_active === '0') && !res.upload_excel;
          }
          this.cdr.detectChanges();
        }
      },
      error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถสลับสถานะได้', 'error')
    });
  }

  /**
   * นับ Local-centric counts สำหรับ chips —
   * backend summary นับ KHD-centric (ถ้า KHD มีแถวซ้ำ tp เดียวกัน จะนับซ้ำ) ทำให้เลขชิป ≠ จำนวนที่ filter ตารางได้
   * ตัวนี้ iterate this.indicators (ที่ table แสดงจริง) — ตรงกันการนับ
   */
  get khdCounts() {
    const counts = { match: 0, different: 0, missing_remote: 0, inactive: 0, criteria: 0, total: 0 };
    if (!this.khdCompareMap.size) return counts;
    for (const i of this.indicators) {
      counts.total++;
      const cmp = this.getKhdCompareStatus(i);
      if (cmp === 'match') counts.match++;
      else if (cmp === 'different') counts.different++;
      else if (cmp === 'missing_remote') counts.missing_remote++;
      const khd = this.getKhdData(i);
      if (khd && (khd.khd_is_active === 0 || khd.khd_is_active === '0')) counts.inactive++;
      if (khd?.criteria_match === false) counts.criteria++;
    }
    return counts;
  }

  // นับจำนวนตัวชี้วัดที่มี/ยังไม่มีผลงาน — ไม่ต้องรอ compare กับ KHD ก่อน (result_count มาจาก GET /indicators โดยตรง)
  get resultStatusCounts() {
    const counts = { has: 0, no: 0 };
    for (const i of this.indicators) {
      if (i.result_count > 0) counts.has++; else counts.no++;
    }
    return counts;
  }

  /** indicator ที่ KHD inactive แต่ Local upload_excel = 0 — ใช้กับ banner + bulk action */
  get khdInactiveSuggestItems(): any[] {
    return this.indicators.filter(i => {
      const khd = this.getKhdData(i);
      return !!(khd && khd.suggest_disable_upload);
    });
  }

  get khdMissingLocalItems(): any[] {
    const result: any[] = [];
    this.khdCompareMap.forEach((val) => {
      if (val.status === 'missing_local') result.push(val);
    });
    return result;
  }

  get stratMissingLocalItems() { return this.stratCompareItems.filter(i => i.status === 'missing_local'); }
  get deptMissingLocalItems() { return this.deptCompareItems.filter(i => i.status === 'missing_local'); }
  get hospMissingLocalItems() { return this.hospCompareItems.filter(i => i.status === 'missing_local'); }
  get hospDifferentItems() { return this.hospCompareItems.filter(i => i.status === 'different'); }
  get mainIndMissingLocalItems() { return this.mainIndCompareItems.filter(i => i.status === 'missing_local'); }

  getMainIndCoverage(item: any): any | null {
    return this.mainIndCompareItems.find(c => c.local_id === item.id) || null;
  }
  getStratCompare(item: any): any | null {
    const norm = (s: string) => (s || '').trim().toLowerCase();
    return this.stratCompareItems.find(c => norm(c.local_yut_name) === norm(item.yut_name)) || null;
  }
  getDeptCompare(item: any): any | null {
    const norm = (s: string) => (s || '').trim().toLowerCase();
    return this.deptCompareItems.find(c => norm(c.local_dept_name) === norm(item.dept_name)) || null;
  }

  runStrategyCompare() {
    if (!this.isSuperAdmin) return;
    this.stratCompareLoading = true;
    this.authService.reportCompareStrategies().subscribe({
      next: (res: any) => {
        this.stratCompareLoading = false;
        if (res.success) { this.stratCompareSummary = res.summary; this.stratCompareItems = res.items; this.khdCompareFilter = ''; this.applyFilter(); }
        else Swal.fire('ผิดพลาด', res.message, 'error');
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.stratCompareLoading = false; Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error'); }
    });
  }

  runDeptCompare() {
    if (!this.isSuperAdmin) return;
    this.deptCompareLoading = true;
    this.authService.reportCompareDepartments().subscribe({
      next: (res: any) => {
        this.deptCompareLoading = false;
        if (res.success) { this.deptCompareSummary = res.summary; this.deptCompareItems = res.items; this.khdCompareFilter = ''; this.applyFilter(); }
        else Swal.fire('ผิดพลาด', res.message, 'error');
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.deptCompareLoading = false; Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error'); }
    });
  }

  runMainIndCompare() {
    if (!this.isSuperAdmin) return;
    this.mainIndCompareLoading = true;
    this.authService.reportCompareMainIndicators().subscribe({
      next: (res: any) => {
        this.mainIndCompareLoading = false;
        if (res.success) { this.mainIndCompareSummary = res.summary; this.mainIndCompareItems = res.items; this.mainIndCompareSource = res.source || ''; this.khdCompareFilter = ''; this.applyFilter(); }
        else Swal.fire('ผิดพลาด', res.message, 'error');
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.mainIndCompareLoading = false; Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error'); }
    });
  }

  runHospCompare() {
    if (!this.isSuperAdmin) return;
    this.hospCompareLoading = true;
    this.hospCompareError = '';
    this.authService.reportCompareHospitals().subscribe({
      next: (res: any) => {
        this.hospCompareLoading = false;
        if (res.success) { this.hospCompareSummary = res.summary; this.hospCompareItems = res.items; this.khdCompareFilter = ''; this.applyFilter(); }
        else { this.hospCompareError = res.message; }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.hospCompareLoading = false;
        this.hospCompareError = err.error?.message || 'เกิดข้อผิดพลาด';
        this.cdr.detectChanges();
      }
    });
  }

  openSimpleAdd(tab: string, name: string) {
    this.simpleAddModal = { open: true, tab, itemName: name, deptCode: '' };
  }

  confirmSimpleAdd() {
    const m = this.simpleAddModal;
    if (!m.itemName?.trim()) return;
    this.simpleAddLoading = true;
    const obs = m.tab === 'strategies'
      ? this.authService.reportCompareAddStrategy(m.itemName)
      : this.authService.reportCompareAddDepartment(m.itemName, m.deptCode);
    obs.subscribe({
      next: (res: any) => {
        this.simpleAddLoading = false;
        if (res.success) {
          this.simpleAddModal.open = false;
          Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
          this.loadAllData();
          if (m.tab === 'strategies') this.runStrategyCompare(); else this.runDeptCompare();
        } else Swal.fire('ผิดพลาด', res.message, 'error');
      },
      error: (err: any) => { this.simpleAddLoading = false; Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error'); }
    });
  }

  openHospAdd(item: any) {
    this.hospAddModal = { open: true, item };
  }

  confirmHospAdd() {
    const m = this.hospAddModal;
    if (!m.item?.hoscode) return;
    this.hospAddLoading = true;
    this.authService.reportCompareAddHospital(m.item.hoscode).subscribe({
      next: (res: any) => {
        this.hospAddLoading = false;
        if (res.success) {
          this.hospAddModal.open = false;
          Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
          this.loadAllData();
          this.runHospCompare();
        } else Swal.fire('ผิดพลาด', res.message, 'error');
      },
      error: (err: any) => { this.hospAddLoading = false; Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error'); }
    });
  }

  openMainIndAdd(item: any) {
    this.mainIndAddModal = { open: true, khd_name: item.khd_name, yutId: null };
  }

  confirmMainIndAdd() {
    const m = this.mainIndAddModal;
    if (!m.khd_name?.trim()) return;
    this.mainIndAddLoading = true;
    this.authService.reportCompareAddMainIndicator(m.khd_name, m.yutId).subscribe({
      next: (res: any) => {
        this.mainIndAddLoading = false;
        if (res.success) {
          this.mainIndAddModal.open = false;
          Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
          this.loadAllData();
          this.runMainIndCompare();
        } else Swal.fire('ผิดพลาด', res.message, 'error');
      },
      error: (err: any) => { this.mainIndAddLoading = false; Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error'); }
    });
  }

  // ===== จับคู่ข้อมูล KHD ↔ Local (หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์) — 19 ต.ค. 2569 =====
  // ตัวชี้วัดที่เพิ่มจาก KHD ใช้ค่าที่จับคู่ได้ก่อนค่าที่เลือกในหน้าต่างเพิ่มเสมอ (ผู้ใช้เลือกแบบนี้)
  readonly khdMapKinds = [
    { key: 'dept', label: 'หน่วยงาน', icon: 'fa-building' },
    { key: 'main', label: 'หมวดหมู่หลัก', icon: 'fa-folder-tree' },
    { key: 'yut', label: 'ยุทธศาสตร์', icon: 'fa-chess' },
  ];
  khdMapOpen = false;
  khdMapKind = 'dept';
  khdMapLoading = false;
  khdMapItems: any[] = [];
  khdMapOptions: any[] = [];
  khdMapSummary: any = null;
  khdMapOnlyUnmatched = true;
  khdMapSearch = '';
  khdMapSaving = '';   // khd_value ที่กำลังบันทึก

  openKhdMapping(kind: string = 'dept') {
    if (!this.isSuperAdmin) return;
    this.khdMapOpen = true;
    this.loadKhdMapping(kind);
  }

  closeKhdMapping() {
    this.khdMapOpen = false;
    // ผลการจับคู่เปลี่ยน → โหลดตารางเทียบ KHD ใหม่ให้แถว "ยังไม่มีในระบบ" แสดงค่าที่จะได้ล่าสุด
    if (this.khdCompareSummary) this.runKhdCompare();
  }

  loadKhdMapping(kind: string) {
    this.khdMapKind = kind;
    this.khdMapLoading = true;
    this.khdMapItems = [];
    this.authService.getKhdMappings(kind).subscribe({
      next: (res: any) => {
        this.khdMapLoading = false;
        if (res.success) {
          this.khdMapItems = (res.items || []).map((i: any) => ({ ...i, _pick: i.resolved?.local_id ?? null }));
          this.khdMapOptions = res.options || [];
          this.khdMapSummary = res.summary;
        } else Swal.fire('ผิดพลาด', res.message, 'error');
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.khdMapLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  get khdMapVisibleItems(): any[] {
    const q = this.khdMapSearch.trim().toLowerCase();
    return this.khdMapItems.filter(i =>
      (!this.khdMapOnlyUnmatched || i.resolved?.status === 'unmatched') &&
      (!q || [i.khd_value, i.khd_label, i.resolved?.local_name].some(v => String(v || '').toLowerCase().includes(q))));
  }

  khdMapStatusLabel(status: string): { text: string; cls: string } {
    switch (status) {
      case 'mapped': return { text: 'จับคู่แล้ว', cls: 'bg-emerald-100 text-emerald-700' };
      case 'auto': return { text: 'ตรงกันอัตโนมัติ', cls: 'bg-sky-100 text-sky-700' };
      case 'ignored': return { text: 'ไม่ต้องจับคู่', cls: 'bg-gray-100 text-gray-500' };
      case 'empty': return { text: 'ไม่มีค่า', cls: 'bg-gray-100 text-gray-400' };
      default: return { text: 'ยังไม่จับคู่', cls: 'bg-rose-100 text-rose-700' };
    }
  }

  /** บันทึกการจับคู่ 1 ค่า — localId = จับคู่, ignore = ไม่ต้องจับคู่, ไม่ส่งทั้งคู่ = กลับไปใช้การจับคู่อัตโนมัติ */
  saveKhdMap(item: any, opts: { localId?: number | null; ignore?: boolean } = {}) {
    this.khdMapSaving = item.khd_value;
    this.authService.saveKhdMapping({ kind: this.khdMapKind, khd_value: item.khd_value, local_id: opts.localId ?? null, ignore: !!opts.ignore }).subscribe({
      next: (res: any) => {
        this.khdMapSaving = '';
        if (res.success) {
          item.resolved = res.resolved;
          item._pick = res.resolved?.local_id ?? null;
          item.mapping = (opts.localId || opts.ignore) ? { local_id: opts.localId ?? null } : null;
          this.recountKhdMapSummary();
        } else Swal.fire('ผิดพลาด', res.message, 'error');
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.khdMapSaving = '';
        Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  private recountKhdMapSummary() {
    const s: any = { total: this.khdMapItems.length, unmatched: 0, auto: 0, mapped: 0, ignored: 0 };
    this.khdMapItems.forEach(i => { s[i.resolved?.status] = (s[i.resolved?.status] || 0) + 1; });
    this.khdMapSummary = s;
  }

  /** สร้างรายการใหม่ในระบบจากค่าของ KHD แล้วจับคู่ทันที (เมื่อไม่มีรายการเดิมที่ตรงความหมาย) */
  createLocalFromKhd(item: any) {
    const kind = this.khdMapKind;
    const label = this.khdMapKinds.find(k => k.key === kind)?.label || '';
    const suggested = kind === 'dept' ? (item.khd_label || item.khd_value) : item.khd_value;
    Swal.fire({
      title: `สร้าง${label}ใหม่จาก KHD`,
      input: 'text', inputValue: suggested, inputLabel: `ชื่อ${label}`,
      showCancelButton: true, confirmButtonColor: '#0891b2', confirmButtonText: 'สร้างและจับคู่', cancelButtonText: 'ยกเลิก',
      inputValidator: (v: string) => (!v || !v.trim()) ? 'กรุณาระบุชื่อ' : null,
    }).then(r => {
      if (!r.isConfirmed) return;
      const name = String(r.value).trim();
      const obs = kind === 'dept' ? this.authService.reportCompareAddDepartment(name, item.khd_value)
        : kind === 'yut' ? this.authService.reportCompareAddStrategy(name)
        : this.authService.reportCompareAddMainIndicator(name, null);
      obs.subscribe({
        next: (res: any) => {
          if (!res.success) { Swal.fire('ผิดพลาด', res.message, 'error'); return; }
          this.saveKhdMap(item, { localId: res.id });
          this.loadAllData();
          this.authService.getKhdMappings(kind).subscribe((r2: any) => { if (r2.success) { this.khdMapOptions = r2.options || []; this.cdr.detectChanges(); } });
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error')
      });
    });
  }

  /** ป้ายแสดงค่าที่ตัวชี้วัดจาก KHD จะได้ในระบบ (ใช้ในตาราง "ยังไม่มีในระบบ" และหน้าต่างเพิ่ม) */
  khdResolvedBadge(r: any): { text: string; cls: string; title: string } | null {
    if (!r || r.status === 'empty') return null;   // KHD ไม่มีค่า — ไม่ต้องแสดงลูกศร
    if (r.local_id) return { text: r.local_name, cls: 'text-emerald-700', title: r.status === 'mapped' ? 'จับคู่ที่ตั้งไว้' : 'ตรงกันอัตโนมัติ' };
    if (r.status === 'unmatched') return { text: 'ยังไม่จับคู่', cls: 'text-rose-600 font-bold', title: 'ตั้งค่าที่ปุ่ม "จับคู่ข้อมูล KHD"' };
    if (r.status === 'ignored') return { text: 'ไม่ต้องจับคู่', cls: 'text-gray-400', title: '' };
    return null;
  }

  get khdMissingUnmatchedCount(): number {
    return this.khdMissingLocalItems.filter(i => i.khd_resolved?.unmatched?.length).length;
  }
  get khdBulkSelectedUnmatchedCount(): number {
    return this.khdMissingLocalItems.filter(i => this.khdMissingLocalSelected.has(i.khd_report_id) && i.khd_resolved?.unmatched?.length).length;
  }

  openAddFromKhd(item: any) {
    this.khdAddModal = { open: true, item, deptId: null, mainIndicatorId: null, yearBh: this.khdCompareYear };
  }

  confirmAddFromKhd() {
    const m = this.khdAddModal;
    if (!m.item?.khd_report_id) return;
    this.khdAddLoading = true;
    this.authService.reportCompareAddFromKhd(m.item.khd_report_id, m.deptId, m.mainIndicatorId, m.yearBh).subscribe({
      next: (res: any) => {
        this.khdAddLoading = false;
        if (res.success) {
          this.khdAddModal.open = false;
          if (res.resolved?.unmatched?.length) {
            Swal.fire({ icon: 'warning', title: 'เพิ่มแล้ว — บางค่ายังจับคู่ไม่ได้',
              text: `${res.message} แต่หน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์บางช่องใน KHD ยังจับคู่ไม่ได้ (ใช้ค่าที่เลือกแทนหรือเว้นว่าง) — ตรวจสอบที่ปุ่ม "จับคู่ข้อมูล KHD"` });
          } else {
            Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
          }
          this.loadAllData();
          this.runKhdCompare();
        } else {
          Swal.fire('ผิดพลาด', res.message, 'error');
        }
      },
      error: (err: any) => {
        this.khdAddLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error');
      }
    });
  }

  // === Checkbox เลือกหลายตัวจากตาราง "KHD มีแต่ยังไม่มีใน Local" + เพิ่มเข้าระบบทีเดียว ===
  toggleMissingLocalSelect(item: any) {
    const id = item.khd_report_id;
    if (this.khdMissingLocalSelected.has(id)) this.khdMissingLocalSelected.delete(id);
    else this.khdMissingLocalSelected.add(id);
  }

  toggleMissingLocalSelectAll() {
    if (this.isMissingLocalAllSelected) {
      this.khdMissingLocalSelected.clear();
    } else {
      this.khdMissingLocalSelected = new Set(this.khdMissingLocalItems.map(i => i.khd_report_id));
    }
  }

  get isMissingLocalAllSelected(): boolean {
    const items = this.khdMissingLocalItems;
    return items.length > 0 && items.every(i => this.khdMissingLocalSelected.has(i.khd_report_id));
  }

  get isMissingLocalPartialSelected(): boolean {
    return this.khdMissingLocalSelected.size > 0 && !this.isMissingLocalAllSelected;
  }

  openBulkAddFromKhd() {
    if (this.khdMissingLocalSelected.size === 0) return;
    this.khdBulkAddModal = { open: true, deptId: null, mainIndicatorId: null, yearBh: this.khdCompareYear };
  }

  confirmBulkAddFromKhd() {
    const ids = Array.from(this.khdMissingLocalSelected);
    if (ids.length === 0) return;
    const m = this.khdBulkAddModal;
    this.khdBulkAddLoading = true;
    this.authService.reportCompareBulkAddFromKhd(ids, m.deptId, m.mainIndicatorId, m.yearBh).subscribe({
      next: (res: any) => {
        this.khdBulkAddLoading = false;
        if (res.success) {
          this.khdBulkAddModal.open = false;
          this.khdMissingLocalSelected.clear();
          const esc = (t: string) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
          const skippedText = res.skipped > 0 ? `<p class="text-xs text-amber-600 mt-2">ข้าม ${res.skipped} รายการ: ${(res.skippedNames || []).map(esc).join(', ')}</p>` : '';
          const unmatched = res.unmatchedNames || [];
          const unmatchedText = unmatched.length > 0
            ? `<p class="text-xs text-rose-600 mt-2">${unmatched.length} รายการมีหน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ใน KHD ที่ยังจับคู่ไม่ได้ (ใช้ค่าที่เลือกในหน้าต่างแทน หรือเว้นว่าง) — ตรวจสอบที่ปุ่ม "จับคู่ข้อมูล KHD"</p>` : '';
          Swal.fire({ icon: 'success', title: 'สำเร็จ', html: `<p>${esc(res.message)}</p>${skippedText}${unmatchedText}` });
          this.loadAllData();
          this.runKhdCompare();
        } else {
          Swal.fire('ผิดพลาด', res.message, 'error');
        }
      },
      error: (err: any) => {
        this.khdBulkAddLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error');
      }
    });
  }

  openImportModal() {
    this.showImportModal = true;
    this.importStep = 1;
    this.importRows = [];
    this.importErrors = [];
    this.importResult = null;
    this.cdr.detectChanges();
  }

  closeImportModal() {
    this.showImportModal = false;
    if (this.importResult && this.importResult.inserted > 0) {
      this.authService.getIndicators(true).subscribe(r => {
        if (r.success) { this.indicators = r.data; this.applyFilter(); }
        this.cdr.detectChanges();
      });
    }
  }

  downloadTemplate() {
    const COLS = [
      { key: 'kpi_indicators_name', desc: 'ชื่อตัวชี้วัด (จำเป็น — ห้ามเว้นว่าง)', example: 'ร้อยละผู้ป่วยความดันโลหิตสูงที่ควบคุมได้' },
      { key: 'kpi_indicators_id',   desc: 'รหัสอ้างอิง เช่น 1901 (ไม่จำเป็น)', example: '1901' },
      { key: 'kpi_indicators_code', desc: 'รหัสตัวชี้วัดย่อ เช่น KPI001 (ไม่จำเป็น)', example: 'KPI-NCD-001' },
      { key: 'main_indicator_name', desc: 'ชื่อหมวดหมู่หลัก — ต้องตรงกับระบบ (ดูชีต "หมวดหมู่หลัก")', example: this.mainIndicators[0]?.main_indicator_name || 'งานควบคุมโรค' },
      { key: 'dept_name',           desc: 'ชื่อหน่วยงาน — ต้องตรงกับระบบ (ดูชีต "หน่วยงาน")', example: this.departments[0]?.dept_name || 'กลุ่มงานโรคไม่ติดต่อ' },
      { key: 'target_percentage',   desc: 'เป้าหมาย % เช่น 80 (ตัวเลข ไม่มีเครื่องหมาย)', example: '80' },
      { key: 'target_condition',    desc: 'เงื่อนไข: GTE=มากกว่าเท่ากับ / GT=มากกว่า / LTE=น้อยกว่าเท่ากับ / LT=น้อยกว่า / EQ=เท่ากับ', example: 'GTE' },
      { key: 'weight',              desc: 'น้ำหนัก (ตัวเลข ค่าเริ่มต้น 1)', example: '1' },
      { key: 'table_process',       desc: 'ชื่อตาราง MySQL: ขึ้นต้นด้วยตัวอักษร a-z ใช้ได้ a-z 0-9 _ เท่านั้น', example: 'kpi_ncd_001' },
      { key: 'r9',                  desc: 'ตัวชี้วัดระดับเขต 9 (1=ใช่, 0=ไม่ใช่)', example: '0' },
      { key: 'moph',                desc: 'ตัวชี้วัดกระทรวงสาธารณสุข (1=ใช่, 0=ไม่ใช่)', example: '1' },
      { key: 'ssj',                 desc: 'ตัวชี้วัด สสจ.นครราชสีมา (1=ใช่, 0=ไม่ใช่)', example: '1' },
      { key: 'rmw',                 desc: 'ตัวชี้วัดผู้ว่าราชการจังหวัด (1=ใช่, 0=ไม่ใช่)', example: '0' },
      { key: 'other',               desc: 'ตัวชี้วัดอื่นๆ (1=ใช่, 0=ไม่ใช่)', example: '0' },
      { key: 'evaluation_mode',     desc: 'โหมดประเมิน: any_one=เฉพาะบางประเภท / all_required=ทุกประเภทบังคับ', example: 'any_one' },
      { key: 'required_off_types',  desc: 'รหัสหน่วยบริการ คั่นด้วย , เช่น 05,06,07 (ใช้เมื่อ evaluation_mode=any_one เท่านั้น)', example: '05,06,07' },
      { key: 'description',         desc: 'รายละเอียดเพิ่มเติม (ไม่จำเป็น)', example: 'ตรวจสอบจาก KHD ทุกเดือน' },
      { key: 'criterion',           desc: 'เกณฑ์ % (จับคู่กับ target_condition เพื่อเทียบกับ KHD) — คนละอันกับ target_percentage/เป้าหมาย', example: '80' },
    ];

    const wb = XLSX.utils.book_new();

    // Sheet 1: data template
    const wsData: any[][] = [
      COLS.map(c => c.key),   // row 1: headers (field names)
      COLS.map(c => c.desc),  // row 2: descriptions
      COLS.map(c => c.example), // row 3: example
      ...Array(20).fill(null).map(() => new Array(COLS.length).fill('')),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = COLS.map((c, i) => ({ wch: i === 0 ? 45 : (i === 3 || i === 4 || i === 15 || i === 16) ? 38 : 18 }));
    XLSX.utils.book_append_sheet(wb, ws, 'นำเข้าตัวชี้วัด');

    // Sheet 2: main indicators reference
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['main_indicator_name (ใส่ในคอลัมน์ D)', 'ยุทธศาสตร์'],
      ...this.mainIndicators.map(m => [m.main_indicator_name, m.yut_name || '']),
    ]);
    ws2['!cols'] = [{ wch: 50 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'หมวดหมู่หลัก');

    // Sheet 3: departments reference
    const ws3 = XLSX.utils.aoa_to_sheet([
      ['dept_name (ใส่ในคอลัมน์ E)', 'รหัสหน่วยงาน'],
      ...this.departments.map(d => [d.dept_name, d.dept_code || '']),
    ]);
    ws3['!cols'] = [{ wch: 40 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'หน่วยงาน');

    // Sheet 4: hostype reference
    const ws4 = XLSX.utils.aoa_to_sheet([
      ['hostypecode (ใส่ใน required_off_types คั่นด้วย ,)', 'ประเภทสถานบริการ'],
      ...this.hosTypes.map(h => [h.hostypecode, h.hostypename]),
    ]);
    ws4['!cols'] = [{ wch: 20 }, { wch: 35 }];
    XLSX.utils.book_append_sheet(wb, ws4, 'รหัสหน่วยบริการ');

    XLSX.writeFile(wb, 'template_นำเข้าตัวชี้วัด.xlsx');
  }

  onExcelFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e: any) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '' }) as any[][];

        if (rawRows.length < 4) {
          Swal.fire('ข้อมูลไม่เพียงพอ', 'ไฟล์ต้องมีข้อมูลตั้งแต่แถวที่ 4 เป็นต้นไป (แถว 1=ชื่อคอลัมน์, 2=คำอธิบาย, 3=ตัวอย่าง)', 'warning');
          return;
        }

        const headers: string[] = rawRows[0].map((h: any) => String(h).trim());
        const dataRows = rawRows.slice(3).filter((row: any[]) => row.some(c => c !== '' && c !== null && c !== undefined));

        if (dataRows.length === 0) {
          Swal.fire('ไม่มีข้อมูล', 'ไม่พบข้อมูลในไฟล์ (กรอกข้อมูลตั้งแต่แถวที่ 4 เป็นต้นไป)', 'warning');
          return;
        }

        this.importRows = [];
        this.importErrors = [];
        const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

        dataRows.forEach((raw: any[], i: number) => {
          const obj: any = {};
          headers.forEach((h, hi) => { obj[h] = raw[hi] !== undefined ? String(raw[hi]).trim() : ''; });

          const rowNum = i + 4;
          const addErr = (colIdx: number, field: string, msg: string) => {
            this.importErrors.push({ rowIndex: i, col: COL_LETTERS[colIdx] || String(colIdx + 1), field, message: `แถวที่ ${rowNum}, คอลัมน์ ${COL_LETTERS[colIdx] || colIdx + 1} (${field}): ${msg}` });
          };

          if (!obj.kpi_indicators_name) addErr(0, 'kpi_indicators_name', 'ชื่อตัวชี้วัดไม่สามารถเว้นว่างได้');
          if (obj.table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(obj.table_process))
            addErr(8, 'table_process', 'ต้องขึ้นต้นด้วยตัวอักษร ใช้ได้เฉพาะ a-z 0-9 _');
          if (obj.target_condition && !['GTE','GT','LTE','LT','EQ'].includes(obj.target_condition.toUpperCase()))
            addErr(6, 'target_condition', `"${obj.target_condition}" ไม่ถูกต้อง ต้องเป็น GTE, GT, LTE, LT หรือ EQ`);
          if (obj.evaluation_mode && !['any_one','all_required'].includes(obj.evaluation_mode))
            addErr(14, 'evaluation_mode', `"${obj.evaluation_mode}" ไม่ถูกต้อง ต้องเป็น any_one หรือ all_required`);

          if (obj.main_indicator_name) {
            const found = this.mainIndicators.find(m => m.main_indicator_name.trim() === obj.main_indicator_name.trim());
            if (found) obj.main_indicator_id = found.id;
            else addErr(3, 'main_indicator_name', `ไม่พบหมวดหมู่ "${obj.main_indicator_name}" ในระบบ`);
          }

          if (obj.dept_name) {
            const found = this.departments.find(d => d.dept_name.trim() === obj.dept_name.trim());
            if (found) obj.dept_id = found.id;
            else addErr(4, 'dept_name', `ไม่พบหน่วยงาน "${obj.dept_name}" ในระบบ`);
          }

          ['r9','moph','ssj','rmw','other'].forEach(flag => {
            obj[flag] = obj[flag] === '1' || obj[flag] === 1 || obj[flag] === 'true' || obj[flag] === 'ใช่';
          });

          if (obj.required_off_types)
            obj.required_off_types = String(obj.required_off_types).split(',').map((s: string) => s.trim()).filter(Boolean);

          this.importRows.push(obj);
        });

        this.importStep = 2;
        this.cdr.detectChanges();
      } catch (err: any) {
        Swal.fire('อ่านไฟล์ไม่ได้', 'ไม่สามารถอ่านไฟล์ Excel ได้: ' + (err.message || err), 'error');
      }
      input.value = '';
    };
    reader.readAsArrayBuffer(file);
  }

  rowHasError(rowIndex: number): boolean {
    return this.importErrors.some(e => e.rowIndex === rowIndex);
  }

  getRowErrors(rowIndex: number): string[] {
    return this.importErrors.filter(e => e.rowIndex === rowIndex).map(e => e.message);
  }

  confirmImport() {
    const validRows = this.importValidRows;
    if (validRows.length === 0) {
      Swal.fire('ไม่มีข้อมูลที่ถูกต้อง', 'ทุกแถวมีข้อผิดพลาด กรุณาแก้ไขไฟล์แล้วอัปโหลดใหม่', 'warning');
      return;
    }
    this.importLoading = true;
    this.cdr.detectChanges();
    this.authService.bulkImportIndicators(validRows).subscribe({
      next: (res: any) => {
        this.importLoading = false;
        this.importResult = { inserted: res.inserted, errors: res.errors || [] };
        this.importStep = 1;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.importLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาดในการนำเข้า', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  // ===== ปรับเกณฑ์ให้เท่ากับ KHD (19 ต.ค. 2569) — เฉพาะตัวที่ผลเทียบล่าสุดบอกว่าเกณฑ์ต่างกัน; ค่าที่บันทึกจริง server อ่านจาก KHD ใหม่ =====
  get khdCriteriaDiffItems(): any[] {
    return this.indicators.filter(i => this.getKhdData(i)?.criteria_match === false);
  }

  applyKhdCriteria(items: any[]) {
    if (!items.length) { Swal.fire('แจ้งเตือน', 'ไม่มีตัวชี้วัดที่เกณฑ์ต่างจาก KHD', 'info'); return; }
    const esc = (t: any) => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
    const list = items.slice(0, 10).map(i =>
      `<tr><td class="text-left pr-2 py-0.5">${esc(i.kpi_indicators_name)}</td><td class="whitespace-nowrap px-1 text-amber-700">${esc(this.getCriteriaText(i))}</td>` +
      `<td class="px-1">→</td><td class="whitespace-nowrap text-orange-700 font-bold">${esc(this.getKhdCriteriaText(this.getKhdData(i)))}</td></tr>`).join('');
    const more = items.length > 10 ? `<p class="text-xs text-gray-500 mt-1">... และอีก ${items.length - 10} ตัว</p>` : '';
    Swal.fire({
      title: 'ปรับเกณฑ์ให้เท่ากับ KHD',
      html: `<p class="text-sm">ปรับ <b>เกณฑ์ + เงื่อนไข</b> ของ <b>${items.length}</b> ตัวชี้วัดให้เท่ากับ KHD ปีงบ <b>${esc(this.khdCompareYear)}</b></p>
             <div class="max-h-60 overflow-auto mt-2"><table class="w-full text-xs">${list}</table></div>${more}
             <p class="text-[11px] text-gray-500 mt-2">ไม่เปลี่ยน "เป้าหมาย" — ตัวที่ KHD ไม่มีเกณฑ์จะถูกข้าม</p>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#ea580c',
      confirmButtonText: '<i class="fas fa-bullseye mr-1"></i> ปรับเกณฑ์', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.applyKhdCriteria(items.map(i => i.id), this.khdCompareYear).subscribe({
        next: (res: any) => {
          if (!res.success) { Swal.fire('ผิดพลาด', res.message, 'error'); return; }
          Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2500, showConfirmButton: false });
          this.loadAllData();
          this.runKhdCompare();
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปรับเกณฑ์ได้', 'error')
      });
    });
  }

  bulkDisableKhdInactive() {
    const items = this.khdInactiveSuggestItems;
    if (items.length === 0) { Swal.fire('แจ้งเตือน', 'ไม่มีรายการที่ต้องปิด', 'info'); return; }
    const ids = items.map(i => i.id);
    Swal.fire({
      title: 'ปิดส่งออกอัตโนมัติ',
      html: `<p class="text-sm">ปิด "ส่งออก KHD" ให้ <b>${ids.length}</b> ตัวชี้วัด</p>
             <p class="text-xs text-gray-500 mt-2">KHD report เหล่านี้อยู่สถานะ inactive — ระบบจะไม่ export อัตโนมัติ</p>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-toggle-off mr-1"></i> ปิดทั้งหมด', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.bulkSetUploadExcel(ids, 1).subscribe({
        next: (res: any) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'สำเร็จ', text: `ปิดแล้ว ${res.affected} ตัวชี้วัด`, timer: 2000 });
            this.loadAllData();
            this.runKhdCompare();
          }
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปิดได้', 'error')
      });
    });
  }
}
