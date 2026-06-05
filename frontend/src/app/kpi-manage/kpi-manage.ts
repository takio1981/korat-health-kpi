import { Component, OnInit, inject, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { FormBuilderComponent } from '../form-builder/form-builder';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-kpi-manage',
  standalone: true,
  imports: [CommonModule, FormsModule, FormBuilderComponent],
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

  // Modal
  showModal: boolean = false;
  isEditMode: boolean = false;
  currentItem: any = {};

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

  // รายการประเภทหน่วยบริการ (จาก chostype)
  hosTypes: any[] = [];
  // เก็บ required_off_types ใน modal เป็น array ของ code (ตอนเปิด modal แปลงจาก JSON string)
  selectedOffTypes: string[] = [];

  // === HDC Compare (ย้ายจาก kpi-manager Step 1) ===
  // ใช้ table_process เป็น key เพราะ HDC ไม่มี local.id
  hdcCompareMap: Map<string, any> = new Map();
  hdcCompareSummary: any = null;     // { total, match, different, missing_local, missing_remote, hdc_inactive, suggest_disable }
  hdcCompareLoading: boolean = false;
  hdcCompareLastRun: Date | null = null;
  // filter เพิ่มสำหรับ indicators tab — กรองตามสถานะ compare กับ HDC
  filterHdcStatus: string = '';      // '' | 'match' | 'different' | 'missing_remote' | 'not_compared' | 'inactive'

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    if (!this.isAdmin) {
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadAllData();
  }

  loadAllData() {
    this.authService.getIndicators().subscribe(res => {
      if(res.success) {
        this.indicators = res.data;
        this.filteredIndicators = [...this.indicators];
        if (this.activeTab === 'indicators') this.applyFilter();
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

  // Parse required_off_types JSON → string[] ของ hostypecode
  parseOffTypes(v: any): string[] {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(x => String(x));
    try {
      const p = JSON.parse(String(v));
      return Array.isArray(p) ? p.map(x => String(x)) : [];
    } catch { return []; }
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
        this.subList = res.data;
        this.cdr.detectChanges();
      }
    });
  }

  openSubForm(item: any = null) {
    this.isSubEdit = !!item;
    this.subCurrent = item ? { ...item } : { indicator_id: this.subParentIndicator.id, weight: 1 };
    this.showSubForm = true;
  }

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
        // HDC compare filter
        if (this.filterHdcStatus) {
          const cmp = this.getHdcCompareStatus(i);
          if (this.filterHdcStatus === 'inactive') {
            const hdc = this.hdcCompareMap.get(i.table_process || '');
            return hdc && (hdc.hdc_is_active === 0 || hdc.hdc_is_active === '0');
          }
          return cmp === this.filterHdcStatus;
        }
        return true;
      });
    } else if (this.activeTab === 'main-indicators') {
      this.filteredMainIndicators = this.mainIndicators.filter(i =>
        matchActive(i) && i.main_indicator_name && i.main_indicator_name.toLowerCase().includes(search)
      );
    } else if (this.activeTab === 'strategies') {
      this.filteredStrategies = this.strategies.filter(s =>
        matchActive(s) && s.yut_name && s.yut_name.toLowerCase().includes(search)
      );
    } else if (this.activeTab === 'departments') {
      this.filteredDepartments = this.departments.filter(d =>
        matchActive(d) && (
          (d.dept_name && d.dept_name.toLowerCase().includes(search)) ||
          (d.dept_code && d.dept_code.toLowerCase().includes(search))
        )
      );
    } else if (this.activeTab === 'hospitals') {
      this.filteredHospitals = this.hospitals.filter(h => {
        if (this.hospFilterDistid && String(h.distid) !== this.hospFilterDistid) return false;
        if (this.hospFilterHostype && String(h.hostype) !== this.hospFilterHostype) return false;
        if (!search) return true;
        return (h.hosname && h.hosname.toLowerCase().includes(search)) ||
               (h.hoscode && String(h.hoscode).toLowerCase().includes(search));
      });
    }
    this.cdr.detectChanges();
  }

  switchTab(tab: string) {
    this.activeTab = tab;
    this.searchTerm = '';
    this.filterActive = '';
    this.hospFilterDistid = '';
    this.hospFilterHostype = '';
    this.applyFilter();
  }

  openModal(item: any = null) {
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
        src.evaluation_mode = src.evaluation_mode || 'any_one';
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
        this.currentItem = { ...baseDefaults, r9: false, moph: false, ssj: false, rmw: false, other: false, weight: 1, target_condition: 'GTE', evaluation_mode: 'any_one' };
      } else {
        this.currentItem = { ...baseDefaults };
      }
    }
    this.rebuildMainForModal();
    this.showModal = true;
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
      // Serialize evaluation_mode + required_off_types (เฉพาะ any_one)
      const payload = { ...this.currentItem };
      payload.required_off_types = payload.evaluation_mode === 'any_one' && this.selectedOffTypes.length > 0
        ? this.selectedOffTypes
        : null;
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
      observable.subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire('สำเร็จ', 'บันทึกข้อมูลเรียบร้อย', 'success');
            this.closeModal();
            this.loadAllData();
          }
          this.cdr.detectChanges();
        },
        error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถบันทึกข้อมูลได้', 'error')
      });
    }
  }

  deleteItem(id: number) {
    Swal.fire({
      title: 'ยืนยันการลบ',
      text: "คุณต้องการลบข้อมูลนี้ใช่หรือไม่?",
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
            error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถลบข้อมูลได้ (อาจมีการใช้งานอยู่)', 'error')
          });
        }
      }
    });
  }

  toggleActive(item: any) {
    const newStatus = !item.is_active || item.is_active === 0;
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
  // HDC Compare — ระบบเทียบชื่อตัวชี้วัด/สถานะกับ HDC (ย้ายจาก kpi-manager)
  // ============================================================

  /** เรียก /report-compare แล้ว build map by table_process */
  runHdcCompare() {
    if (!this.isSuperAdmin) {
      Swal.fire('แจ้งเตือน', 'เฉพาะ super_admin', 'warning');
      return;
    }
    this.hdcCompareLoading = true;
    this.cdr.detectChanges();
    this.authService.reportCompare().subscribe({
      next: (res: any) => {
        this.hdcCompareLoading = false;
        if (res.success) {
          this.hdcCompareMap.clear();
          for (const it of (res.items || [])) {
            if (it.table_process) this.hdcCompareMap.set(it.table_process, it);
          }
          this.hdcCompareSummary = res.summary;
          this.hdcCompareLastRun = new Date();
          this.applyFilter();
          this.cdr.detectChanges();
        }
      },
      error: (err: any) => {
        this.hdcCompareLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเทียบกับ HDC ได้ (ตรวจ Remote DB)', 'error');
      }
    });
  }

  /** สถานะ compare ของ indicator แต่ละตัว — ใช้กับ badge + filter */
  getHdcCompareStatus(item: any): 'not_compared' | 'match' | 'different' | 'missing_remote' {
    if (!this.hdcCompareMap.size) return 'not_compared';
    const hdc = item.table_process ? this.hdcCompareMap.get(item.table_process) : null;
    if (!hdc) return 'missing_remote';
    return hdc.status === 'match' ? 'match' : (hdc.status === 'different' ? 'different' : 'missing_remote');
  }

  /** ข้อมูล HDC ดิบของ indicator (ใช้แสดง diff inline) */
  getHdcData(item: any): any | null {
    return item.table_process ? (this.hdcCompareMap.get(item.table_process) || null) : null;
  }

  /** Sync ชื่อจาก HDC → Local 1 ตัว (POST /report-compare/sync ด้วย hdc_report_id เดียว) */
  syncSingleNameFromHdc(item: any) {
    const hdc = this.getHdcData(item);
    if (!hdc || !hdc.hdc_report_id) {
      Swal.fire('แจ้งเตือน', 'ไม่พบ HDC report — กดเทียบกับ HDC ก่อน', 'info');
      return;
    }
    if (hdc.status !== 'different') {
      Swal.fire('แจ้งเตือน', 'ตัวชี้วัดนี้ตรงกับ HDC อยู่แล้ว', 'info');
      return;
    }
    Swal.fire({
      title: 'Sync ชื่อจาก HDC',
      html: `<div class="text-left text-sm space-y-2">
        <p>เปลี่ยนชื่อตัวชี้วัด Local ให้ตรงกับ HDC:</p>
        <div class="bg-rose-50 border border-rose-200 rounded p-2 text-xs">
          <p class="text-rose-700 font-bold">ปัจจุบัน (Local):</p>
          <p class="text-gray-700">${item.kpi_indicators_name}</p>
        </div>
        <div class="text-center text-gray-400"><i class="fas fa-arrow-down"></i></div>
        <div class="bg-emerald-50 border border-emerald-200 rounded p-2 text-xs">
          <p class="text-emerald-700 font-bold">ใหม่ (จาก HDC):</p>
          <p class="text-gray-700">${hdc.hdc_name}</p>
        </div>
      </div>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: '<i class="fas fa-sync mr-1"></i> Sync', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.reportCompareSync([hdc.hdc_report_id]).subscribe({
        next: (res: any) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'Sync สำเร็จ', text: res.message, timer: 2000 });
            this.loadAllData();
            this.runHdcCompare();
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
          const hdc = this.getHdcData(item);
          if (hdc) {
            hdc.local_upload_excel = res.upload_excel;
            hdc.suggest_disable_upload = (hdc.hdc_is_active === 0 || hdc.hdc_is_active === '0') && !res.upload_excel;
          }
          this.cdr.detectChanges();
        }
      },
      error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถสลับสถานะได้', 'error')
    });
  }

  /** indicator ที่ HDC inactive แต่ Local upload_excel = 0 — ใช้กับ banner + bulk action */
  get hdcInactiveSuggestItems(): any[] {
    return this.indicators.filter(i => {
      const hdc = this.getHdcData(i);
      return !!(hdc && hdc.suggest_disable_upload);
    });
  }

  bulkDisableHdcInactive() {
    const items = this.hdcInactiveSuggestItems;
    if (items.length === 0) { Swal.fire('แจ้งเตือน', 'ไม่มีรายการที่ต้องปิด', 'info'); return; }
    const ids = items.map(i => i.id);
    Swal.fire({
      title: 'ปิดส่งออกอัตโนมัติ',
      html: `<p class="text-sm">ตั้ง <code>upload_excel = 1</code> ให้ <b>${ids.length}</b> ตัวชี้วัด</p>
             <p class="text-xs text-gray-500 mt-2">HDC report เหล่านี้อยู่สถานะ inactive — ระบบจะไม่ export อัตโนมัติ</p>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-toggle-off mr-1"></i> ปิดทั้งหมด', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.bulkSetUploadExcel(ids, 1).subscribe({
        next: (res: any) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'สำเร็จ', text: `ปิดแล้ว ${res.affected} ตัวชี้วัด`, timer: 2000 });
            this.loadAllData();
            this.runHdcCompare();
          }
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปิดได้', 'error')
      });
    });
  }
}
