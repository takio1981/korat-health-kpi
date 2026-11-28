import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, NgZone, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { CriteriaTextPipe } from '../shared/criteria-text.pipe';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import Swal from 'sweetalert2';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { KhdQuickSendComponent, KHD_POLICY_LABEL } from '../shared/khd-quick-send';
import { IndicatorBadgesComponent, IndicatorMetaService } from '../shared/indicator-badges';
import { ITYPES } from '../shared/indicator-types';
import { AttrFilter, EMPTY_ATTR_FILTER, METHOD_OPTIONS, SOURCE_OPTIONS, activeAttrCount, fiscalYearOptions, matchAttrFilter } from './kpi-attr-filter';
import { typedConfirmSwal } from '../shared/typed-confirm';
import { StatusBadge, TableStruct, canPullStructure, canPushStructure, diffText, khdBadge, localBadge, structMapOf, tpKey } from './kpi-table-status';
import { CheckFilter, CheckSummary, EMPTY_SUMMARY, matchCheckFilter, summarizeCheck } from './check-summary';
import { KhdSyncScope, khdSyncScope, syncScopeKey as scopeKeyOf } from './khd-sync-scope';

// 27 พ.ย. 2569 (ผู้ใช้สั่ง): หน้าจัดการข้อมูล KPI รวม "ส่งออกข้อมูล KPI ↔ KHD" (เทียบโครงสร้าง) กับ "Export ลงตารางรายตัวชี้วัด" เป็นตารางเดียว
// แต่ละแถว: ป้ายการตั้งค่าตัวชี้วัด + ตารางในระบบ (ส่งออก = สร้างให้เอง) + ตารางใน KHD (สร้าง/เพิ่มคอลัมน์ ต้องพิมพ์ยืนยัน) + ข้อมูลที่เปลี่ยน
@Component({
  selector: 'app-export-kpi',
  standalone: true,
  imports: [CommonModule, FormsModule, CriteriaTextPipe, FormulaBadgeComponent, KhdQuickSendComponent, IndicatorBadgesComponent],
  templateUrl: './export-kpi.html'
})
export class ExportKpiComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  /** สร้างแบบฟอร์มบันทึกจากโครงสร้างตาราง KHD (หน้าแม่เปิด Form Builder) */
  @Output() createFormEvent = new EventEmitter<{ table: string, name: string, columns: any[] }>();

  // === สถานะโครงสร้างตาราง (GET /db-compare?year_bh=) ===
  structLoading = false;
  structMap = new Map<string, TableStruct>();
  khdAvailable = false;
  khdError = '';
  structLoadedYear = '';
  /** ป้ายต่อแถว — คำนวณตอนโหลด (ไม่ใช้ getter ใน template กัน NG0100) */
  localBadges = new Map<number, StatusBadge>();
  khdBadges = new Map<number, StatusBadge>();
  /** ตัวกรองคอลัมน์ตาราง: '' | local:none|empty|blank|ok | khd:none|different|bad_key|match|unknown */
  filterTable = '';

  // === ตัวกรองคุณสมบัติตัวชี้วัด (27 พ.ย. 2569 — ครบทุกหัวข้อตามป้ายใต้ชื่อ) — คุณสมบัติเต็มจาก IndicatorMetaService (GET /indicators) ===
  private indicatorMeta = inject(IndicatorMetaService);
  metaById = new Map<number, any>();
  attrFilter: AttrFilter = { ...EMPTY_ATTR_FILTER };
  readonly itypeOptions = ITYPES;
  readonly methodOptions = METHOD_OPTIONS;
  readonly sourceOptions = SOURCE_OPTIONS;
  /** คำนวณตอนโหลดคุณสมบัติ (ไม่ใช้ getter — กัน NG0103) */
  fyOptions: string[] = [];
  hostypeOptions: { code: string; name: string }[] = [];
  attrCount = 0;

  // === กติกาการส่ง KHD (GET/PUT /khd-sync/settings — super_admin แบบเข้ม) ===
  sendPolicy = '';
  policyLabel = '';
  policySaving = false;

  // Filters
  exportYear: string = '';
  // ส่งเข้า KHD ขั้นเดียว (22 พ.ย. 2569) — เฉพาะ super_admin (backend ตรวจแบบเข้มซ้ำ)
  isSuperAdminStrict = this.authService.getUserRole() === 'super_admin';
  yearOptions: string[] = [];
  filterMainIndicator: string = '';
  filterDept: string = '';
  filterStatus: string = '';
  filterCheckStatus: CheckFilter = '';  // กลุ่มเดียวกับ card สรุป (check-summary.ts)
  exportSearch: string = '';

  // Filter options
  mainIndicators: any[] = [];
  departments: any[] = [];

  // Indicators
  exportIndicators: any[] = [];
  filteredExportIndicators: any[] = [];
  selectedIndicatorIds: Set<number> = new Set();
  selectAll: boolean = true;

  // Check state
  checkLoading: boolean = false;
  checkResult: any = null;
  checkStatusMap: Map<number, any> = new Map();
  checkProgress = { total: 0, done: 0, percent: 0 };

  // ตัวเลขใน card — นับต่อตัวชี้วัด บนรายการที่ผ่านตัวกรองอื่นแล้ว (กด card = แถวเท่ากับตัวเลขเสมอ) อัปเดตทุก batch ระหว่างตรวจ
  summary: CheckSummary = { ...EMPTY_SUMMARY, tables: { ...EMPTY_SUMMARY.tables } };

  // UI state
  showGuide: boolean = true;

  // Export state
  exportLoading: boolean = false;
  exportResult: any = null;

  // Sync to KHD — แสดงเป็นขั้นที่ 5 ต่อท้ายในหน้าเดียวกัน (28 พ.ย. 2569 — เดิมเป็น modal แสดงทุกตารางของระบบ)
  // ขอบเขต = ตัวชี้วัดที่เลือกในขั้นที่ 3 + ปีงบในขั้นที่ 1 (ส่งเฉพาะแถว byear ของปีนั้น)
  showSyncGuide: boolean = false;
  syncPanelOpen: boolean = false;
  syncScope: KhdSyncScope | null = null;
  /** ลายเซ็นของรายการที่เลือก + ปีงบ ตอนตรวจแผน — เปลี่ยนแล้วต้องตรวจใหม่ก่อนส่ง */
  syncScopeKey = '';
  syncYear = '';
  syncPreviewData: any[] = [];
  syncLoading: boolean = false;
  syncSelectedTables = new Set<string>();
  // Filter + search สำหรับ modal sync
  syncSearch: string = '';
  syncStatusFilter: string = ''; // '' = ทั้งหมด | 'ready' | 'empty' | 'no_remote'
  syncMainIndicatorFilter: string = '';
  syncDeptFilter: string = '';

  // === Export Schedule (ตารางเวลา export อัตโนมัติ) ===
  showSettingsModal: boolean = false;
  schedules: any[] = [];
  schedulesLoading: boolean = false;
  showScheduleModal: boolean = false;
  editingSchedule: any = null;
  scheduleForm: any = {
    name: '',
    is_enabled: true,
    days: [1, 2, 3, 4, 5],
    time_of_day: '02:00',
    year_bh: '',
    indicator_scope: 'changes_only',
    indicator_ids: [] as number[],
    auto_sync_khd: false,
    notify_email: true,
    notify_telegram: false,
    notify_line: false
  };
  dayLabels = [
    { v: 1, label: 'จ.' },
    { v: 2, label: 'อ.' },
    { v: 3, label: 'พ.' },
    { v: 4, label: 'พฤ.' },
    { v: 5, label: 'ศ.' },
    { v: 6, label: 'ส.' },
    { v: 7, label: 'อา.' }
  ];

  // Logs modal
  showLogsModal: boolean = false;
  logsData: any[] = [];
  logsScheduleName: string = '';

  ngOnInit() {
    // เดิม hardcode เช็ค role !== 'super_admin' ที่นี่ — component นี้ embed อยู่ใน kpi-manager
    // (pageKey 'kpi-manager' เดียวกัน) ใช้ canAccessPage() แทนให้ตรงกับ guard ของหน้าแม่
    if (!this.authService.canAccessPage('kpi-manager')) {
      Swal.fire('Access Denied', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }

    const currentFiscalYear = getCurrentFiscalYear();
    this.exportYear = currentFiscalYear.toString();
    for (let y = currentFiscalYear + 1; y >= currentFiscalYear - 3; y--) {
      this.yearOptions.push(y.toString());
    }

    this.loadFilterOptions();
    this.loadExportableIndicators();
    this.loadSchedules();
    this.loadStructure();
    this.loadPolicy();
    this.indicatorMeta.ensure();
    this.metaSub = this.indicatorMeta.meta$.subscribe(m => {
      if (!m) return;
      this.metaById = m.byId;
      this.fyOptions = fiscalYearOptions([...m.byId.values()]);
      this.hostypeOptions = [...m.hostype.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code));
      this.applyFilters();
      this.cdr.detectChanges();
    });
  }

  private metaSub?: { unsubscribe(): void };
  ngOnDestroy() { this.metaSub?.unsubscribe(); }

  onAttrFilterChange() {
    this.attrCount = activeAttrCount(this.attrFilter);
    this.onFilterChange();
  }

  // ========== สถานะโครงสร้างตาราง ในระบบ / KHD ==========
  loadStructure() {
    this.structLoading = true;
    this.cdr.markForCheck(); // ถูกเรียกจาก callback ของคำขออื่น (zoneless) — ไม่แจ้งแล้วได้ NG0100 / หน้าจอค้างสถานะเดิม (พบจากทดสอบหน้าจอ 28 พ.ย. 2569)
    const year = this.exportYear;
    this.authService.dbCompare(year).subscribe({
      next: (res: any) => {
        this.structLoading = false;
        if (res?.success) {
          this.structMap = structMapOf(res.tables);
          this.khdAvailable = res.khd_available !== false;
          this.khdError = res.khd_error || '';
          this.structLoadedYear = year;
          this.refreshBadges();
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.structLoading = false;
        this.khdAvailable = false;
        this.khdError = err.error?.message || 'ตรวจสถานะตารางไม่สำเร็จ';
        this.refreshBadges();
        this.cdr.detectChanges();
      },
    });
  }

  structOf(ind: any): TableStruct | undefined { return this.structMap.get(tpKey(ind?.table_process)); }

  refreshBadges() {
    this.localBadges = new Map(); this.khdBadges = new Map();
    for (const ind of this.exportIndicators) {
      const s = this.structOf(ind);
      this.localBadges.set(ind.id, localBadge(s, this.exportYear));
      this.khdBadges.set(ind.id, khdBadge(s, this.khdAvailable));
    }
    this.applyFilters();
  }

  onYearChange() {
    this.checkResult = null;
    this.checkStatusMap.clear();
    this.loadStructure();
  }

  canPush(ind: any): boolean { return canPushStructure(this.structOf(ind), this.khdAvailable); }
  canPull(ind: any): boolean { return canPullStructure(this.structOf(ind), this.khdAvailable); }
  diffLines(ind: any): string[] { return (this.structOf(ind)?.diff || []).map(diffText); }

  /** ตารางที่เลือกซึ่งสร้าง/เพิ่มคอลัมน์ใน KHD ได้ (ไม่ซ้ำ table_process) */
  get pushableSelected(): string[] {
    const set = new Set<string>();
    for (const ind of this.exportIndicators) if (this.selectedIndicatorIds.has(ind.id) && this.canPush(ind)) set.add(tpKey(ind.table_process));
    return [...set];
  }

  pushOne(ind: any) { this.pushStructure([tpKey(ind.table_process)]); }
  pushSelected() { this.pushStructure(this.pushableSelected); }

  /** สร้างตาราง / เพิ่มคอลัมน์ที่ขาดใน KHD จากโครงสร้างของระบบ (POST /db-compare/create-remote — พิมพ์ยืนยัน) */
  pushStructure(tables: string[]) {
    if (!tables.length) { Swal.fire('แจ้งเตือน', 'ไม่มีตารางที่ต้องสร้างหรือเพิ่มคอลัมน์ใน KHD ในรายการที่เลือก', 'info'); return; }
    const tc = typedConfirmSwal(tables);
    const list = tables.slice(0, 15).map(t => `<code>${t.replace(/[<>&]/g, '')}</code>`).join(', ') + (tables.length > 15 ? ` และอีก ${tables.length - 15} ตาราง` : '');
    Swal.fire({
      title: 'สร้าง/ปรับตารางใน KHD',
      html: `<p class="text-sm">สร้างตารางที่ยังไม่มี หรือเพิ่มคอลัมน์ที่ขาด ใน KHD ตามโครงสร้างของระบบ <b>${tables.length}</b> ตาราง</p><p class="text-xs text-gray-500 mt-1">${list}</p>`
        + `<p class="text-xs text-red-500 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>เขียนโครงสร้างลงฐานข้อมูล KHD จริง — ไม่ลบคอลัมน์หรือข้อมูลเดิมใน KHD</p>${tc.footerHtml}`,
      input: tc.input, inputPlaceholder: tc.inputPlaceholder, inputValidator: tc.inputValidator,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#7c3aed',
      confirmButtonText: '<i class="fas fa-hammer mr-1"></i> สร้าง/ปรับใน KHD', cancelButtonText: 'ยกเลิก',
    }).then(r => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังสร้างใน KHD...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.dbCompareCreateRemote(tables, tc.expected).subscribe({
        next: (res: any) => { this.showStructureResult(res, 'KHD'); this.loadStructure(); },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'สร้างตารางใน KHD ไม่สำเร็จ', 'error'),
      });
    });
  }

  /** เพิ่มคอลัมน์ที่ KHD มีแต่ระบบไม่มี ลงตารางในระบบ (POST /db-compare/create-local — ไม่แตะ KHD) */
  pullStructure(ind: any) {
    const t = tpKey(ind.table_process);
    Swal.fire({
      title: 'เพิ่มคอลัมน์ตาม KHD', icon: 'question', showCancelButton: true, confirmButtonColor: '#2563eb',
      html: `<p class="text-sm">เพิ่มคอลัมน์ที่มีใน KHD แต่ยังไม่มีในตาราง <code>${t.replace(/[<>&]/g, '')}</code> ของระบบ</p><p class="text-xs text-gray-500 mt-1">ไม่ลบหรือเปลี่ยนคอลัมน์เดิม</p>`,
      confirmButtonText: 'เพิ่มคอลัมน์', cancelButtonText: 'ยกเลิก',
    }).then(r => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังปรับตาราง...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.dbCompareCreateLocal([t]).subscribe({
        next: (res: any) => { this.showStructureResult(res, 'ระบบ'); this.loadStructure(); },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ปรับตารางไม่สำเร็จ', 'error'),
      });
    });
  }

  /** ผลการสร้าง/ปรับตาราง — แสดงรายการที่ทำไม่ได้พร้อมเหตุผลเสมอ (เดิมแจ้ง "สำเร็จ" แม้สร้างได้ 0 ตาราง) */
  showStructureResult(res: any, where: string) {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
    const created = res?.created || [], altered = res?.altered || [], errors = res?.errors || [];
    const ok = created.length + altered.length;
    Swal.fire({
      icon: errors.length && !ok ? 'error' : errors.length ? 'warning' : ok ? 'success' : 'info',
      title: ok ? `ปรับตารางใน${where}แล้ว` : `ไม่มีการเปลี่ยนแปลงใน${where}`,
      html: `<div class="text-left text-sm">`
        + (created.length ? `<p>สร้างใหม่ ${created.length}: ${created.map(esc).join(', ')}</p>` : '')
        + (altered.length ? `<p>เพิ่มคอลัมน์ ${altered.length}: ${altered.map((a: any) => `${esc(a.table)} (+${a.added_columns})`).join(', ')}</p>` : '')
        + (!ok && !errors.length ? '<p class="text-gray-500">โครงสร้างตรงกันอยู่แล้ว</p>' : '')
        + (errors.length ? `<div class="mt-2 text-xs text-red-600">${errors.map((e: any) => `<b>${esc(e.table)}</b>: ${esc(e.error)}`).join('<br>')}</div>` : '')
        + '</div>',
    });
  }

  /** สร้างแบบฟอร์มบันทึกจากคอลัมน์ของตาราง KHD (เดิมอยู่ในขั้น DB Compare) */
  createFormFromKhd(ind: any) {
    const s = this.structOf(ind);
    if (!s?.remote?.columns?.length) { Swal.fire('แจ้งเตือน', 'ตารางนี้ไม่มีคอลัมน์จาก KHD', 'warning'); return; }
    this.createFormEvent.emit({ table: tpKey(ind.table_process), name: ind.kpi_indicators_name, columns: s.remote.columns.map((c: any) => ({ ...c, _selected: false })) });
  }

  // ========== กติกาการส่ง KHD ==========
  loadPolicy() {
    if (!this.isSuperAdminStrict) return;
    this.authService.apiGet('/khd-sync/settings').subscribe({
      next: (res: any) => { this.setPolicy(res?.data?.khd_send_policy); this.cdr.detectChanges(); },
      error: () => { /* ไม่มีสิทธิ์/อ่านไม่ได้ = ไม่แสดงแถบ */ },
    });
  }
  private setPolicy(p: string) { this.sendPolicy = p || ''; this.policyLabel = KHD_POLICY_LABEL[p] || p || ''; }

  togglePolicy() {
    const next = this.sendPolicy === 'all' ? 'approved_only' : 'all';
    Swal.fire({
      title: 'เปลี่ยนกติกาการส่ง', icon: 'question', showCancelButton: true, confirmButtonColor: '#10b981',
      html: `<p class="text-sm">เปลี่ยนเป็น <b>${KHD_POLICY_LABEL[next]}</b></p><p class="text-xs text-gray-500 mt-2">${next === 'approved_only'
        ? 'ตารางส่งออกจะเก็บเฉพาะเดือนที่อนุมัติแล้ว เดือนที่ยังไม่อนุมัติเป็นค่าว่าง (ไม่ทับค่าใน KHD)'
        : 'ตารางส่งออกเก็บเป้าหมายและผลงานทุกค่าที่บันทึก รวมเดือนที่ยังไม่อนุมัติ'} — มีผลกับการส่งออกครั้งถัดไป</p>`,
      confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก',
    }).then(r => {
      if (!r.isConfirmed) return;
      this.policySaving = true;
      this.authService.apiPut('/khd-sync/settings', { khd_send_policy: next }).subscribe({
        next: (res: any) => {
          this.policySaving = false; this.setPolicy(res?.data?.khd_send_policy || next);
          this.checkResult = null; this.checkStatusMap.clear(); this.applyFilters();
          Swal.fire({ icon: 'success', title: 'สำเร็จ', text: 'เปลี่ยนกติกาการส่งแล้ว กดตรวจสอบข้อมูลอีกครั้งเพื่อดูผล', timer: 2500, showConfirmButton: false });
          this.cdr.detectChanges();
        },
        error: (err: any) => { this.policySaving = false; Swal.fire('ผิดพลาด', err.error?.message || 'เปลี่ยนกติกาไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
      });
    });
  }

  loadFilterOptions() {
    this.authService.getMainIndicators().subscribe({
      next: (res) => {
        this.mainIndicators = res.success ? res.data : [];
        this.cdr.detectChanges();
      }
    });
    this.authService.getDepartments().subscribe({
      next: (res) => {
        this.departments = res.success ? res.data : [];
        this.cdr.detectChanges();
      }
    });
  }

  loadExportableIndicators() {
    this.authService.getExportableIndicators().subscribe({
      next: (res) => {
        if (res.success) {
          this.exportIndicators = res.data;
          this.refreshBadges();
          this.selectedIndicatorIds = new Set(this.filteredExportIndicators.map((i: any) => i.id));
          this.updateSelectAll();
        }
        this.cdr.detectChanges();
      }
    });
  }

  applyFilters() {
    let list = this.exportIndicators;

    if (this.filterMainIndicator) {
      list = list.filter((i: any) => String(i.main_indicator_id) === this.filterMainIndicator);
    }
    if (this.filterDept) {
      list = list.filter((i: any) => String(i.dept_id) === this.filterDept);
    }
    if (this.filterStatus === 'active') {
      list = list.filter((i: any) => i.is_active === 1);
    } else if (this.filterStatus === 'inactive') {
      list = list.filter((i: any) => i.is_active === 0);
    }

    // ตัวกรองคุณสมบัติตัวชี้วัด (ประเภท / ประเภทหน่วยบริการ / วิธีคิดผลงาน / แหล่งข้อมูล / ส่ง KHD / ปีงบ / รายละเอียด / เกณฑ์)
    if (this.attrFilter && activeAttrCount(this.attrFilter) > 0) {
      list = list.filter((i: any) => matchAttrFilter(i, this.metaById.get(Number(i.id)), this.attrFilter));
    }

    // ตัวกรองสถานะตาราง (ในระบบ / KHD)
    if (this.filterTable) {
      const [side, key] = this.filterTable.split(':');
      list = list.filter((i: any) => (side === 'local' ? this.localBadges : this.khdBadges).get(i.id)?.key === key);
    }

    // ค้นชื่อ/ชื่อตาราง — ชื่อตารางเทียบทั้งแบบเดิมและแบบขีดล่าง (tpKey) | รองรับชื่อว่าง
    // (27 พ.ย. 2569: เดิม i.kpi_indicators_name.toLowerCase() ล้มเมื่อชื่อเป็น null → หลังส่งออก next() หยุดกลางทาง ปุ่มค้าง "กำลังส่งออก...")
    const search = (this.exportSearch || '').toLowerCase().trim();
    if (search) {
      const searchKey = tpKey(search);
      list = list.filter((i: any) =>
        String(i.kpi_indicators_name || '').toLowerCase().includes(search) ||
        String(i.table_process || '').toLowerCase().includes(search) ||
        tpKey(i.table_process).toLowerCase().includes(searchKey)
      );
    }

    // card สรุปนับจากรายการที่ผ่านตัวกรองอื่นทั้งหมดแล้ว แล้วจึงกรองสถานะตรวจสอบด้วยกติกาเดียวกัน (check-summary.ts)
    // → ตัวเลขใน card = จำนวนแถวที่แสดงเมื่อกด card นั้นเสมอ
    this.summary = summarizeCheck(list, (id) => this.checkStatusMap.get(id));
    if (this.filterCheckStatus) {
      list = list.filter((i: any) => matchCheckFilter(i, this.checkStatusMap.get(i.id), this.filterCheckStatus));
    }

    this.filteredExportIndicators = list;
    this.updateSelectAll();
  }

  onFilterChange() {
    this.applyFilters();
    this.selectedIndicatorIds = new Set(this.filteredExportIndicators.map((i: any) => i.id));
    this.selectAll = true;
  }

  updateSelectAll() {
    this.selectAll = this.filteredExportIndicators.length > 0 &&
      this.filteredExportIndicators.every((i: any) => this.selectedIndicatorIds.has(i.id));
  }

  toggleSelectAll() {
    if (this.selectAll) {
      for (const i of this.filteredExportIndicators) this.selectedIndicatorIds.add(i.id);
    } else {
      for (const i of this.filteredExportIndicators) this.selectedIndicatorIds.delete(i.id);
    }
  }

  toggleIndicator(id: number) {
    if (this.selectedIndicatorIds.has(id)) {
      this.selectedIndicatorIds.delete(id);
    } else {
      this.selectedIndicatorIds.add(id);
    }
    this.updateSelectAll();
  }

  isIndicatorSelected(id: number): boolean {
    return this.selectedIndicatorIds.has(id);
  }

  getCheckStatus(id: number): any {
    return this.checkStatusMap.get(id);
  }

  /** กด card สรุป = กรองกลุ่มนั้น (กดซ้ำ = ยกเลิก) และเลือกเฉพาะรายการที่แสดง เหมือนตัวกรองอื่น */
  setCheckFilter(f: CheckFilter) {
    this.filterCheckStatus = this.filterCheckStatus === f ? '' : f;
    this.onFilterChange();
  }

  clearFilters() {
    this.filterMainIndicator = '';
    this.filterDept = '';
    this.filterStatus = '';
    this.filterCheckStatus = '';
    this.filterTable = '';
    this.attrFilter = { ...EMPTY_ATTR_FILTER };
    this.attrCount = 0;
    this.exportSearch = '';
    this.applyFilters();
    this.selectedIndicatorIds = new Set(this.filteredExportIndicators.map((i: any) => i.id));
    this.selectAll = true;
  }

  resetAll() {
    this.filterMainIndicator = '';
    this.filterDept = '';
    this.filterStatus = '';
    this.filterCheckStatus = '';
    this.exportSearch = '';
    this.checkResult = null;
    this.checkStatusMap.clear();
    this.checkProgress = { total: 0, done: 0, percent: 0 };
    this.exportResult = null;
    this.applyFilters();
    this.selectedIndicatorIds = new Set(this.filteredExportIndicators.map((i: any) => i.id));
    this.selectAll = true;
    this.closeSyncPanel();
  }

  // === ตรวจสอบเปรียบเทียบข้อมูล (ทีละ batch แสดง progress + เลขวิ่ง) ===
  async checkBeforeExport() {
    this.checkLoading = true;
    this.checkResult = null;
    this.checkStatusMap.clear();
    this.filterCheckStatus = '';

    const allIds = this.exportIndicators.map((i: any) => i.id);
    const batchSize = 10;
    const batches: number[][] = [];
    for (let i = 0; i < allIds.length; i += batchSize) {
      batches.push(allIds.slice(i, i + batchSize));
    }

    const total = allIds.length;
    this.checkProgress = { total, done: 0, percent: 0 };
    this.applyFilters();
    this.cdr.detectChanges();

    const allDetails: any[] = [];
    let checkDate = '';

    try {
      for (const batch of batches) {
        const res: any = await this.authService.checkKpiExport(this.exportYear, batch).toPromise();
        if (res.success) {
          checkDate = res.check_date;
          for (const d of res.details) {
            this.checkStatusMap.set(d.id, d);
            allDetails.push(d);
          }
        }
        this.checkProgress.done += batch.length;
        this.checkProgress.percent = Math.round((this.checkProgress.done / this.checkProgress.total) * 100);

        // อัปเดต card ทุก batch (กติกาเดียวกับตัวกรอง)
        this.applyFilters();
        this.cdr.detectChanges();
      }

      // สรุปทั้งหมดของปีงบ (ไม่ขึ้นกับตัวกรองที่ตั้งอยู่) — กติกาเดียวกับ card
      const all = summarizeCheck(this.exportIndicators, (id) => this.checkStatusMap.get(id));
      this.checkResult = {
        success: true,
        check_date: checkDate || new Date().toISOString(),
        year_bh: this.exportYear,
        summary: all,
        details: allDetails
      };

      this.checkLoading = false;
      this.applyFilters();
      this.cdr.detectChanges();

      const row = (label: string, n: number, color = '', tables?: number) =>
        `<tr style="${color ? `color:${color};` : ''}"><td style="padding:4px 8px;">${label}</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${n}${tables !== undefined && tables !== n ? ` <span style="font-weight:normal;font-size:11px;color:#9ca3af">(${tables} ตาราง)</span>` : ''}</td></tr>`;
      Swal.fire({
        title: 'ตรวจสอบเสร็จสิ้น',
        html: `<div style="text-align:left; font-size:14px;">
          <div style="margin-bottom:8px;">ปีงบประมาณ: <b>${this.exportYear}</b> — นับเป็นจำนวนตัวชี้วัด (ตรงกับจำนวนแถวเมื่อกด card)</div>
          <table style="width:100%; border-collapse:collapse;">
            ${row('ตัวชี้วัดทั้งหมด', all.total, '', all.tables.total)}
            ${row('ตัวชี้วัดที่เพิ่ม/แก้ไข', all.has_changes, '#ea580c', all.tables.has_changes)}
            ${row('จำนวนข้อมูลที่เปลี่ยนแปลง (แถว)', all.data_changes, '#e11d48')}
            ${row('ข้อมูลล่าสุดแล้ว', all.up_to_date, '#16a34a', all.tables.up_to_date)}
            ${row('ไม่มีข้อมูล', all.no_data, '#9ca3af', all.tables.no_data)}
            ${all.not_exported ? row('ปิดส่งออก KHD (ไม่ตรวจ)', all.not_exported, '#dc2626') : ''}
            ${all.unchecked ? row('ยังไม่ตรวจสอบ', all.unchecked, '#64748b') : ''}
          </table>
        </div>`,
        icon: all.has_changes > 0 ? 'info' : 'success',
        confirmButtonText: 'ปิด',
        confirmButtonColor: '#6366f1'
      });

    } catch (err: any) {
      this.checkLoading = false;
      this.cdr.detectChanges();
      Swal.fire('ผิดพลาด', err?.error?.message || 'ไม่สามารถตรวจสอบข้อมูลได้', 'error');
    }
  }

  selectOnlyChanged() {
    this.selectedIndicatorIds.clear();
    for (const [id, chk] of this.checkStatusMap) {
      if (chk.status === 'has_changes') {
        this.selectedIndicatorIds.add(id);
      }
    }
    this.updateSelectAll();
  }

  // === Export ===
  // แถวย่อยในหน้าต่างสรุปผล: ตารางรายละเอียดข้อย่อย/กิจกรรม <table_process>_items (Export 3 ระดับ)
  itemsPopupRow(t: any, esc: (s: string) => string): string {
    const it = t?.items;
    if (!it) return '';
    const cell = 'padding:3px 8px;border-bottom:1px solid #eee;font-size:10.5px';
    if (!it.table) return `<tr><td colspan="6" style="${cell};color:#c2410c">↳ ${esc(it.skipped || 'ข้ามตารางรายละเอียด')}</td></tr>`;
    const status = it.inserted > 0 || it.updated > 0 || it.removed > 0 ? 'อัปเดต' : 'ไม่เปลี่ยน';
    return `<tr style="background:#eef2ff">
      <td style="${cell};font-family:monospace;color:#4338ca">↳ ${esc(it.table)}</td>
      <td style="${cell};text-align:center;color:#6b7280">${status}${it.removed ? ` (ลบ ${it.removed})` : ''}</td>
      <td style="${cell};text-align:center;color:#1e40af">+${it.inserted || 0}</td>
      <td style="${cell};text-align:center;color:#c2410c">~${it.updated || 0}</td>
      <td style="${cell};text-align:center;color:#6b7280">=${it.unchanged || 0}</td>
      <td style="${cell};text-align:center">${it.rows || 0}</td>
    </tr>`;
  }

  exportKpiTables() {
    if (this.selectedIndicatorIds.size === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกตัวชี้วัดอย่างน้อย 1 รายการ', 'warning');
      return;
    }

    const count = this.selectedIndicatorIds.size;

    Swal.fire({
      title: 'ยืนยันการส่งออกข้อมูล',
      html: `จะสร้าง/อัปเดตตาราง MySQL สำหรับ <b>${count} ตัวชี้วัด</b><br>ปีงบประมาณ <b>${this.exportYear}</b><br><br><small class="text-gray-500">เฉพาะ hospcode ที่มีข้อมูล และอัปเดตเฉพาะค่าที่เปลี่ยนแปลง</small>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'ส่งออก',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#28a745'
    }).then((result) => {
      if (result.isConfirmed) {
        this.exportLoading = true;
        this.exportResult = null;
        this.cdr.detectChanges();

        const ids = Array.from(this.selectedIndicatorIds);

        this.authService.exportKpiTables(this.exportYear, ids).subscribe({
          next: (res) => {
            this.exportLoading = false;
            this.exportResult = res;

            if (res.success) {
              // ล้างผลตรวจสอบเดิม (ให้กดตรวจสอบใหม่เอง) + โหลดสถานะตารางใหม่ (ตารางที่เพิ่งสร้าง/จำนวนแถว)
              this.checkResult = null;
              this.checkStatusMap.clear();
              this.applyFilters();
              this.loadStructure();
              if (this.syncPanelOpen && !this.syncStale) this.openSyncToKhd(false); // ตารางส่งออกเปลี่ยน → แผนการส่ง KHD ต้องคำนวณใหม่
              this.cdr.detectChanges();

              // Build table list HTML — ชื่อตาราง + สถานะ + counts
              const escHtml = (s: any) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              const tablesRows = (res.created_tables || []).map((t: any) => {
                const total = (t.inserted || 0) + (t.updated || 0) + (t.unchanged || 0);
                const statusIcon = t.inserted > 0 || t.updated > 0
                  ? '<i class="fas fa-check-circle" style="color:#16a34a"></i>'
                  : '<i class="fas fa-equals" style="color:#6b7280"></i>';
                const statusText = t.inserted > 0 || t.updated > 0 ? 'อัปเดต' : 'ไม่เปลี่ยน';
                return `<tr>
                  <td style="padding:5px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px">${escHtml(t.table)}</td>
                  <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center">${statusIcon} <span style="font-size:10px;color:#6b7280">${statusText}</span></td>
                  <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center;color:#1e40af;font-weight:700">+${t.inserted || 0}</td>
                  <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center;color:#c2410c;font-weight:700">~${t.updated || 0}</td>
                  <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center;color:#6b7280">=${t.unchanged || 0}</td>
                  <td style="padding:5px 8px;border-bottom:1px solid #eee;text-align:center;font-weight:700">${total}</td>
                </tr>` + this.itemsPopupRow(t, escHtml);
              }).join('');
              const skippedRows = (res.skipped || []).map((s: any) =>
                `<tr><td colspan="2" style="padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;color:#9ca3af">${escHtml(s.table_process || s.name || '?')}</td>
                <td colspan="4" style="padding:4px 8px;border-bottom:1px solid #eee;font-size:11px;color:#9ca3af">⏭ ${escHtml(s.reason || 'ข้าม')}</td></tr>`
              ).join('');

              Swal.fire({
                title: '✓ ส่งออกสำเร็จ',
                html: `<div style="text-align:left;font-size:13px">
                  <!-- Summary cards -->
                  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px">
                    <div style="background:#dbeafe;padding:10px;border-radius:8px;text-align:center"><div style="font-size:18px;font-weight:bold;color:#1e40af">${res.summary.inserted}</div><div style="font-size:10px;color:#1e40af">เพิ่มใหม่</div></div>
                    <div style="background:#fed7aa;padding:10px;border-radius:8px;text-align:center"><div style="font-size:18px;font-weight:bold;color:#c2410c">${res.summary.updated}</div><div style="font-size:10px;color:#c2410c">อัปเดต</div></div>
                    <div style="background:#f3f4f6;padding:10px;border-radius:8px;text-align:center"><div style="font-size:18px;font-weight:bold;color:#4b5563">${res.summary.unchanged}</div><div style="font-size:10px;color:#4b5563">ไม่เปลี่ยน</div></div>
                    <div style="background:#fef3c7;padding:10px;border-radius:8px;text-align:center"><div style="font-size:18px;font-weight:bold;color:#a16207">${res.created_tables.length}</div><div style="font-size:10px;color:#a16207">ตาราง</div></div>
                  </div>

                  ${tablesRows ? `
                  <p style="font-weight:700;color:#374151;margin:8px 0 4px;font-size:12px">📋 รายการตารางที่ส่งออก (${res.created_tables.length}):</p>
                  <div style="max-height:260px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px">
                    <table style="width:100%;border-collapse:collapse;font-size:11px;background:white">
                      <thead style="position:sticky;top:0;background:#f3f4f6"><tr>
                        <th style="padding:6px 8px;text-align:left">ตาราง</th>
                        <th style="padding:6px 8px;text-align:center">สถานะ</th>
                        <th style="padding:6px 8px;text-align:center">เพิ่ม</th>
                        <th style="padding:6px 8px;text-align:center">อัปเดต</th>
                        <th style="padding:6px 8px;text-align:center">เดิม</th>
                        <th style="padding:6px 8px;text-align:center">รวม</th>
                      </tr></thead>
                      <tbody>${tablesRows}${skippedRows}</tbody>
                    </table>
                  </div>` : ''}

                  ${res.skipped.length > 0 && !tablesRows ? `<p style="color:#6b7280;font-size:11px;margin-top:8px"><i class="fas fa-forward"></i> ข้าม ${res.skipped.length} รายการ (ดูเหตุผลรายตัวด้านล่าง)</p>` : ''}
                </div>`,
                icon: 'success',
                width: 720,
                confirmButtonColor: '#16a34a',
                confirmButtonText: 'ตกลง'
              });
            } else {
              this.cdr.detectChanges();
              Swal.fire('ผิดพลาด', res.message, 'error');
            }
          },
          error: (err) => {
            this.exportLoading = false;
            this.cdr.detectChanges();
            Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถส่งออกข้อมูลได้', 'error');
          }
        });
      }
    });
  }

  // === Sync to KHD (ขั้นที่ 5 ในหน้าเดียวกัน) ===
  /** เปิด/โหลดแผนการส่งของตัวชี้วัดที่เลือกในขั้นที่ 3 + ปีงบในขั้นที่ 1 แล้วเลื่อนลงไปที่ตาราง */
  openSyncToKhd(scroll = true) {
    const scope = khdSyncScope(this.exportIndicators, this.selectedIndicatorIds);
    if (this.selectedIndicatorIds.size === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกตัวชี้วัดในขั้นที่ 3 อย่างน้อย 1 รายการ', 'warning'); return; }
    this.syncPanelOpen = true;
    this.syncScope = scope;
    this.syncScopeKey = scopeKeyOf(this.exportYear, this.selectedIndicatorIds);
    this.syncYear = this.exportYear;
    this.syncPreviewData = [];
    this.syncSelectedTables.clear();
    this.clearSyncFilters();
    this.cdr.detectChanges();
    if (scroll) setTimeout(() => document.getElementById('khd-sync-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    if (!scope.ids.length) { this.syncLoading = false; this.cdr.detectChanges(); return; } // ทุกรายการที่เลือกส่ง KHD ไม่ได้ — แสดงเหตุผล

    this.syncLoading = true;
    this.cdr.markForCheck();
    const key = this.syncScopeKey;
    this.authService.syncToKhdPreview({ indicator_ids: scope.ids, year_bh: this.exportYear }).subscribe({
      next: (res: any) => {
        if (key !== this.syncScopeKey) return; // มีการตรวจรอบใหม่แล้ว
        this.syncLoading = false;
        if (res.success) {
          this.syncPreviewData = res.tables || [];
          // เหตุผลจาก backend (ปิดใช้งาน / ยังไม่มีตารางในระบบ) ต่อท้ายเหตุผลฝั่งหน้าจอ
          const seen = new Set(scope.excluded.map(e => e.id));
          for (const e of res.excluded || []) if (!seen.has(e.id)) scope.excluded.push(e);
          this.syncPreviewData.forEach((t: any) => { if (t.status === 'ready') this.syncSelectedTables.add(t.table); });
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        if (key !== this.syncScopeKey) return;
        this.syncLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถตรวจสอบได้', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  closeSyncPanel() {
    this.syncPanelOpen = false;
    this.syncScope = null;
    this.syncScopeKey = '';
    this.syncPreviewData = [];
    this.syncSelectedTables.clear();
  }

  /** รายการที่เลือก/ปีงบเปลี่ยนหลังตรวจแผน — ต้องตรวจใหม่ก่อนส่ง (กันส่งตารางที่ไม่ตรงกับที่เลือก) */
  get syncStale(): boolean {
    return this.syncPanelOpen && this.syncScopeKey !== scopeKeyOf(this.exportYear, this.selectedIndicatorIds);
  }

  toggleSyncTable(table: string) {
    this.syncSelectedTables.has(table) ? this.syncSelectedTables.delete(table) : this.syncSelectedTables.add(table);
  }

  // เลือกทั้งหมดในรายการที่ filter อยู่ (เฉพาะ ready)
  toggleSyncAll() {
    const visibleReady = this.filteredSyncPreview.filter((t: any) => t.status === 'ready');
    if (visibleReady.length === 0) return;
    const allVisibleSelected = visibleReady.every((t: any) => this.syncSelectedTables.has(t.table));
    if (allVisibleSelected) {
      visibleReady.forEach((t: any) => this.syncSelectedTables.delete(t.table));
    } else {
      visibleReady.forEach((t: any) => this.syncSelectedTables.add(t.table));
    }
  }

  // คำนวณสถานะ checkbox "เลือกทั้งหมด" — true เมื่อทุก ready ที่มองเห็น ถูกเลือก
  get isAllSyncSelected(): boolean {
    const visibleReady = this.filteredSyncPreview.filter((t: any) => t.status === 'ready');
    return visibleReady.length > 0 && visibleReady.every((t: any) => this.syncSelectedTables.has(t.table));
  }

  // partial selection — เลือกบางส่วนใน list ที่มองเห็น
  get isPartialSyncSelected(): boolean {
    const visibleReady = this.filteredSyncPreview.filter((t: any) => t.status === 'ready');
    const selectedVisible = visibleReady.filter((t: any) => this.syncSelectedTables.has(t.table)).length;
    return selectedVisible > 0 && selectedVisible < visibleReady.length;
  }

  // กรองตาม search (table/name) + status + หมวดหมู่หลัก + กลุ่มงาน
  get filteredSyncPreview(): any[] {
    const q = (this.syncSearch || '').trim().toLowerCase();
    return this.syncPreviewData.filter((t: any) => {
      if (this.syncStatusFilter && t.status !== this.syncStatusFilter) return false;
      if (this.syncMainIndicatorFilter && !this.syncFieldIncludes(t.main_indicator_name, this.syncMainIndicatorFilter)) return false;
      if (this.syncDeptFilter && !this.syncFieldIncludes(t.dept_name, this.syncDeptFilter)) return false;
      if (!q) return true;
      return (t.table && String(t.table).toLowerCase().includes(q)) ||
             (t.name && String(t.name).toLowerCase().includes(q));
    });
  }

  // ตาราง export 1 ตารางอาจรวมหลายตัวชี้วัด → main_indicator_name/dept_name เป็น string คั่นด้วย ' | '
  private syncFieldIncludes(value: string | null | undefined, target: string): boolean {
    if (!value) return false;
    return value.split(' | ').includes(target);
  }

  // รายการหมวดหมู่หลัก/กลุ่มงานที่พบจริงในผลตรวจสอบ ใช้เติม dropdown filter
  get syncMainIndicatorOptions(): string[] {
    const set = new Set<string>();
    this.syncPreviewData.forEach((t: any) => (t.main_indicator_name || '').split(' | ').forEach((n: string) => n && set.add(n)));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }

  get syncDeptOptions(): string[] {
    const set = new Set<string>();
    this.syncPreviewData.forEach((t: any) => (t.dept_name || '').split(' | ').forEach((n: string) => n && set.add(n)));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }

  getSyncCount(status: string): number {
    return this.syncPreviewData.filter((t: any) => t.status === status).length;
  }

  hasActiveSyncFilters(): boolean {
    return !!(this.syncSearch || this.syncStatusFilter || this.syncMainIndicatorFilter || this.syncDeptFilter);
  }

  clearSyncFilters() {
    this.syncSearch = '';
    this.syncStatusFilter = '';
    this.syncMainIndicatorFilter = '';
    this.syncDeptFilter = '';
  }

  executeSyncToKhd() {
    if (this.syncStale) { Swal.fire('แจ้งเตือน', 'รายการตัวชี้วัดที่เลือกหรือปีงบเปลี่ยนไปหลังตรวจแผนการส่ง — กด "ตรวจแผนใหม่" ก่อนส่ง', 'warning'); return; }
    if (this.syncSelectedTables.size === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกตารางอย่างน้อย 1 รายการ', 'warning'); return; }
    const tables = this.syncPreviewData
      .filter((t: any) => this.syncSelectedTables.has(t.table) && t.status === 'ready')
      .map((t: any) => ({ table: t.table, sync_columns: t.sync_columns }));
    const year = this.syncYear;

    Swal.fire({
      title: 'ยืนยันส่งข้อมูลเข้า KHD',
      html: `<p class="text-sm">ส่ง <b>${tables.length}</b> ตาราง เข้า KHD เฉพาะข้อมูล<b>ปีงบ ${year}</b>?</p>
             <p class="text-xs text-teal-600 mt-2"><i class="fas fa-info-circle mr-1"></i>จับคู่ด้วย hospcode + byear — แถวที่มีแล้วทับเฉพาะเมื่อข้อมูลในระบบใหม่กว่า (update_date) และช่องว่างไม่ทับค่าใน KHD</p>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#0d9488',
      confirmButtonText: '<i class="fas fa-upload mr-1"></i> ส่งข้อมูล', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.syncLoading = true;
        this.cdr.detectChanges();
        Swal.fire({ title: 'กำลังส่งข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.syncToKhdExecute(tables, year).subscribe({
          next: (res: any) => {
            this.syncLoading = false;
            this.cdr.detectChanges();
            // แผนหลังส่ง (แถวที่ส่งแล้วกลายเป็นคงค่า) + สถานะตารางใน KHD
            this.openSyncToKhd(false);
            this.loadStructure();
            const ok = res.results?.filter((x: any) => x.status === 'success' || x.status === 'partial') || [];
            const successCount = ok.length;
            const errorCount = res.results?.filter((x: any) => x.status === 'error').length || 0;
            const totalRows = ok.reduce((s: number, x: any) => s + (Number(x.rows) || 0), 0);
            const sum = (k: string) => ok.reduce((s: number, x: any) => s + (Number(x[k]) || 0), 0);
            const skipped = res.results?.filter((x: any) => x.status === 'skipped') || [];
            Swal.fire({
              icon: errorCount > 0 ? 'warning' : 'success',
              title: 'ส่งข้อมูลเสร็จสิ้น',
              html: `<div class="text-left text-sm space-y-2">
                <div class="grid grid-cols-3 gap-2 text-center">
                  <div class="bg-green-50 border border-green-200 rounded-lg p-2"><p class="text-xl font-bold text-green-700">${successCount}</p><p class="text-[10px]">สำเร็จ</p></div>
                  <div class="bg-red-50 border border-red-200 rounded-lg p-2"><p class="text-xl font-bold text-red-600">${errorCount}</p><p class="text-[10px]">ผิดพลาด</p></div>
                  <div class="bg-blue-50 border border-blue-200 rounded-lg p-2"><p class="text-xl font-bold text-blue-700">${totalRows}</p><p class="text-[10px]">rows ทั้งหมด</p></div>
                </div>
                <p class="text-xs text-gray-600">เพิ่มใหม่ <b>${sum('inserted')}</b> · อัปเดต (ระบบใหม่กว่า) <b>${sum('updated')}</b> · คงค่า KHD <b>${sum('khd_newer') + sum('no_time')}</b> · ช่องว่างไม่ทับ <b>${sum('kept_blank')}</b> แถว</p>
                ${skipped.length > 0 ? '<div class="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-700">' +
                  skipped.map((x: any) => `<b>${x.table}</b>: ${x.reason}`).join('<br>') + '</div>' : ''}
                ${errorCount > 0 ? '<div class="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-600 mt-2">' +
                  res.results.filter((x: any) => x.status === 'error').map((x: any) => `<b>${x.table}</b>: ${x.reason}`).join('<br>') + '</div>' : ''}
              </div>`,
              confirmButtonColor: '#10b981'
            });
          },
          error: (err: any) => {
            this.syncLoading = false;
            this.cdr.detectChanges();
            Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถส่งข้อมูลได้', 'error');
          }
        });
      }
    });
  }

  // ========== Schedule management ==========
  openSettingsModal() {
    this.showSettingsModal = true;
    this.loadSchedules();
  }

  loadSchedules() {
    this.schedulesLoading = true;
    this.authService.getExportSchedules().subscribe({
      next: (res: any) => {
        this.schedules = (res.data || []).map((s: any) => ({
          ...s,
          days_arr: (s.days_of_week || '').split(',').map((d: string) => parseInt(d.trim())).filter((d: number) => !isNaN(d)),
          indicator_ids_arr: s.indicator_ids ? (() => { try { return JSON.parse(s.indicator_ids); } catch { return []; } })() : []
        }));
        this.schedulesLoading = false;
        this.cdr.detectChanges();
      },
      error: () => { this.schedulesLoading = false; this.cdr.detectChanges(); }
    });
  }

  dayShortLabel(days: number[]): string {
    if (!days || days.length === 0) return '-';
    if (days.length === 7) return 'ทุกวัน';
    if (days.length === 5 && [1,2,3,4,5].every(d => days.includes(d))) return 'จ.-ศ.';
    return days.sort((a,b) => a-b).map(d => this.dayLabels.find(x => x.v === d)?.label || d).join(',');
  }

  openCreateSchedule() {
    this.editingSchedule = null;
    this.scheduleForm = {
      name: '',
      is_enabled: true,
      days: [1, 2, 3, 4, 5],
      time_of_day: '02:00',
      year_bh: this.exportYear,
      indicator_scope: 'changes_only',
      indicator_ids: [],
      auto_sync_khd: false,
      notify_email: true,
      notify_telegram: false,
      notify_line: false
    };
    this.showScheduleModal = true;
  }

  openEditSchedule(s: any) {
    this.editingSchedule = s;
    const scope = s.indicator_scope
      || (s.indicator_ids_arr && s.indicator_ids_arr.length > 0 ? 'selected' : 'all');
    this.scheduleForm = {
      name: s.name,
      is_enabled: !!s.is_enabled,
      days: [...(s.days_arr || [])],
      time_of_day: s.time_of_day || '02:00',
      year_bh: s.year_bh || '',
      indicator_scope: scope,
      indicator_ids: [...(s.indicator_ids_arr || [])],
      auto_sync_khd: !!s.auto_sync_khd,
      notify_email: !!s.notify_email,
      notify_telegram: !!s.notify_telegram,
      notify_line: !!s.notify_line
    };
    this.showScheduleModal = true;
  }

  toggleScheduleDay(d: number) {
    const idx = this.scheduleForm.days.indexOf(d);
    if (idx >= 0) this.scheduleForm.days.splice(idx, 1);
    else this.scheduleForm.days.push(d);
  }

  isScheduleDay(d: number): boolean {
    return this.scheduleForm.days.includes(d);
  }

  saveSchedule() {
    const f = this.scheduleForm;
    if (!f.name || !f.name.trim()) { Swal.fire('แจ้งเตือน', 'กรุณาตั้งชื่อ schedule', 'warning'); return; }
    if (!f.days || f.days.length === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกวันอย่างน้อย 1 วัน', 'warning'); return; }
    if (!f.time_of_day || !/^\d{2}:\d{2}$/.test(f.time_of_day)) { Swal.fire('แจ้งเตือน', 'กรุณาระบุเวลา (HH:MM)', 'warning'); return; }

    const payload = {
      name: f.name.trim(),
      is_enabled: f.is_enabled,
      days_of_week: f.days.sort((a: number, b: number) => a - b).join(','),
      time_of_day: f.time_of_day,
      year_bh: f.year_bh || null,
      indicator_scope: f.indicator_scope,
      indicator_ids: f.indicator_scope === 'selected' ? (f.indicator_ids || []) : null,
      auto_sync_khd: f.auto_sync_khd,
      notify_email: f.notify_email,
      notify_telegram: f.notify_telegram,
      notify_line: f.notify_line
    };

    const obs = this.editingSchedule
      ? this.authService.updateExportSchedule(this.editingSchedule.id, payload)
      : this.authService.createExportSchedule(payload);

    Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    obs.subscribe({
      next: () => {
        Swal.fire({ icon: 'success', title: 'สำเร็จ', timer: 1500, showConfirmButton: false });
        this.showScheduleModal = false;
        this.loadSchedules();
      },
      error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error')
    });
  }

  deleteSchedule(s: any) {
    Swal.fire({
      title: 'ยืนยันการลบ', text: `ลบ schedule "${s.name}"?`, icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#dc2626', confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.authService.deleteExportSchedule(s.id).subscribe({
          next: () => { Swal.fire({ icon: 'success', title: 'ลบแล้ว', timer: 1500, showConfirmButton: false }); this.loadSchedules(); },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ลบไม่สำเร็จ', 'error')
        });
      }
    });
  }

  runScheduleNow(s: any) {
    Swal.fire({
      title: 'รันตอนนี้?', text: `รัน "${s.name}" ทันที และส่งแจ้งเตือนตามการตั้งค่า?`, icon: 'question',
      showCancelButton: true, confirmButtonColor: '#0d9488', confirmButtonText: 'รัน', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        Swal.fire({ title: 'กำลังรัน... (อาจใช้เวลาสักครู่)', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.runExportScheduleNow(s.id).subscribe({
          next: (res: any) => {
            const r = res.result || {};
            const sm = r.summary || {};
            const syncBlock = r.sync
              ? `<hr class="my-2"/>
                 <p class="font-bold text-teal-700"><i class="fas fa-cloud-upload-alt mr-1"></i>Sync ไปยัง KHD</p>
                 <p>สำเร็จ: ${r.sync.summary.success}/${r.sync.summary.total} ตาราง (${r.sync.summary.rows} rows)</p>
                 ${r.sync.summary.error > 0 ? `<p class="text-red-600">ผิดพลาด: ${r.sync.summary.error}</p>` : ''}`
              : '';
            Swal.fire({
              icon: 'success', title: 'รันสำเร็จ',
              html: `<div class="text-left text-sm space-y-1">
                <p><b>เพิ่มใหม่ (Inserted):</b> ${sm.inserted || 0} แถว</p>
                <p><b>อัปเดต (Updated):</b> ${sm.updated || 0} แถว</p>
                <p><b>ไม่เปลี่ยน (Unchanged):</b> ${sm.unchanged || 0} แถว</p>
                <p><b>ไม่มีข้อมูล (No data):</b> ${sm.no_data || 0} แถว</p>
                ${syncBlock}
              </div>`
            });
            this.loadSchedules();
          },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'รันไม่สำเร็จ', 'error')
        });
      }
    });
  }

  openLogs(s: any) {
    this.logsScheduleName = s.name;
    this.showLogsModal = true;
    this.logsData = [];
    this.authService.getExportScheduleLogs(s.id).subscribe({
      next: (res: any) => { this.logsData = res.data || []; this.cdr.detectChanges(); },
      error: () => { this.logsData = []; this.cdr.detectChanges(); }
    });
  }

  formatDateTime(d: string): string {
    if (!d) return '-';
    try { return new Date(d).toLocaleString('th-TH'); } catch { return d; }
  }

  copySelectedIntoSchedule() {
    this.scheduleForm.indicator_ids = Array.from(this.selectedIndicatorIds);
  }

  goToSettings() {
    this.showScheduleModal = false;
    this.showSettingsModal = false;
    this.router.navigate(['/settings']);
  }
}
