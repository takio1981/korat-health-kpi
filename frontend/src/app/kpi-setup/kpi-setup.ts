import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { CriteriaTextPipe } from '../shared/criteria-text.pipe';
import { getNextFiscalYear } from '../shared/fiscal-year.util';
import Swal from 'sweetalert2';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { zoneOptions, zoneLabel, inZone } from '../shared/zone';
import { normalizeQuarterMode, isQuarterEntryMonth, quarterValues } from '../shared/kpi-formula';

const SETUP_MONTHS = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
const QUARTER_END: Record<string, number> = { dece: 1, mar: 2, jun: 3, sep: 4 };
/** หน่วยบริการต่อคำขอเมื่อเลือกหลายแห่ง (เท่ากับหน้าบันทึกผลงาน ADD_KPI_UNITS_PER_REQUEST) */
export const SETUP_UNITS_PER_REQUEST = 30;

/** แบ่งแถวตัวชี้วัด × หน่วยบริการเป็นคำขอ ชุดละ ≤ size หน่วยบริการ — แถวระบุ hospcode (โหมด setup_insert_new ของผู้ดูแล) */
export function buildSetupBatches(rows: any[], hospcodes: string[], size = SETUP_UNITS_PER_REQUEST): { hospcodes: string[]; rows: any[] }[] {
  const out: { hospcodes: string[]; rows: any[] }[] = [];
  const hcs = [...new Set(hospcodes.map(String))];
  for (let i = 0; i < hcs.length; i += size) {
    const part = hcs.slice(i, i + size);
    out.push({ hospcodes: part, rows: part.flatMap(hc => rows.map(r => ({ ...r, hospcode: hc }))) });
  }
  return out;
}

@Component({
  selector: 'app-kpi-setup',
  standalone: true,
  imports: [CommonModule, FormsModule, CriteriaTextPipe, FormulaBadgeComponent],
  templateUrl: './kpi-setup.html'
})
export class KpiSetupComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  kpiTemplateAll: any[] = [];
  kpiTemplate: any[] = [];
  departments: any[] = [];
  districts: any[] = [];
  hospitals: any[] = [];
  filteredHospitals: any[] = [];

  selectedYear: string = '';
  selectedZone: string = '';
  selectedDistrict: string = '';
  /** หน่วยบริการที่เลือก (หลายแห่งได้ — 22 พ.ย. 2569) คงไว้เมื่อเปลี่ยนตัวกรองโซน/อำเภอ */
  selectedHospitals = new Set<string>();
  hosSearch = '';
  showHosPicker = false;
  pickerList: any[] = [];
  zoneLabel = zoneLabel;
  selectedDept: string = '';

  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  loggedInUser: any = null;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    this.loggedInUser = this.authService.getUser();

    // เดิม hardcode เช็ค isAdmin ตรงๆ ที่นี่ ซ้ำซ้อนกับ pageAccessGuard ที่ route และขัดกับระบบ
    // Role × Page Access — ใช้ canAccessPage() แทนให้ตรงกับ guard (isAdmin/isSuperAdmin ยังเก็บไว้
    // ใช้ในส่วนอื่นของ component เหมือนเดิม เช่น การล็อค dept dropdown ด้านล่าง)
    if (!this.authService.canAccessPage('kpi-setup')) {
      Swal.fire({
        title: 'Access Denied',
        text: 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้',
        icon: 'error',
        confirmButtonColor: '#d33',
        confirmButtonText: 'ตกลง'
      });
      this.router.navigate(['/dashboard']);
      return;
    }

    // เดิมใช้ getFullYear()+543+1 ตรงๆ ไม่คำนึงเดือน ทำให้ช่วง ต.ค.-ธ.ค. ของทุกปี default ผิดเป็นปีงบปัจจุบัน
    // แทนที่จะเป็นปีงบถัดไปที่ควรตั้งค่าใหม่ (getCurrentFiscalYear ผ่านช่วง ต.ค.-ธ.ค. ขยับ +1 ไปแล้วในตัว
    // การ +1 ซ้ำแบบเดิมจึงกลายเป็นปีงบปัจจุบันแทนที่จะเป็นปีงบถัดไป)
    this.selectedYear = String(getNextFiscalYear());

    // admin_ssj: ล็อค dept_id เป็นกลุ่มงานของตัวเอง
    if (!this.isSuperAdmin && this.loggedInUser?.dept_id) {
      this.selectedDept = this.loggedInUser.dept_id.toString();
    }

    this.loadTemplate();
    this.loadDepartments();
    this.loadDistricts();
    this.loadHospitals();
  }

  loadTemplate() {
    this.authService.getKpiTemplate().subscribe({
      next: (res) => {
        if (res.success) {
          this.kpiTemplateAll = res.data;
          this.applyDeptFilter();
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadDepartments() {
    this.authService.getDepartments().subscribe(res => {
      if (res.success) {
        this.departments = res.data;
        this.cdr.detectChanges();
      }
    });
  }

  loadDistricts() {
    this.authService.getDistricts().subscribe(res => {
      if (res.success) {
        this.districts = res.data;
        this.cdr.detectChanges();
      }
    });
  }

  loadHospitals() {
    this.authService.getHospitals().subscribe(res => {
      if (res.success) {
        this.hospitals = res.data;
        this.filteredHospitals = [...this.hospitals];
        this.refreshPicker();
        this.cdr.detectChanges();
      }
    });
  }

  applyDeptFilter() {
    let filtered = this.kpiTemplateAll;
    if (this.selectedDept) {
      filtered = filtered.filter(item => String(item.dept_id) === this.selectedDept);
    }
    this.kpiTemplate = filtered.map((item: any) => {
      const row: any = { ...item, year_bh: this.selectedYear, target_value: item.target_percentage != null ? item.target_percentage : 0, total_actual: 0 };
      // ตัวชี้วัดบันทึกรายไตรมาส: เดือนกลางไตรมาสว่าง (ไม่ใช่ 0) — กรอกได้เฉพาะ ธ.ค./มี.ค./มิ.ย./ก.ย. (backend ล้างซ้ำ)
      for (const m of SETUP_MONTHS) row[m] = this.isQuarterOff(item, m) ? '' : 0;
      return row;
    });
    this.cdr.detectChanges();
  }

  // ===== วัดผลรายไตรมาส (quarter_mode — 11 พ.ย. 2569) — กติกาเดียวกับหน้าบันทึกผลงาน =====
  isQuarterOff(item: any, m: string): boolean {
    return normalizeQuarterMode(item?.quarter_mode) === 'quarter' && SETUP_MONTHS.includes(m) && !isQuarterEntryMonth('quarter', m);
  }
  quarterBadgeText(item: any): string {
    const m = normalizeQuarterMode(item?.quarter_mode);
    return !m ? '' : m === 'quarter' ? 'รายไตรมาส' : 'ไตรมาส (บันทึกรายเดือน)';
  }
  /** ใต้ช่องเดือนสุดท้ายของไตรมาส: "ไตรมาส N" (บันทึกรายไตรมาส) / "ไตรมาส N: ค่า" (บันทึกรายเดือน) */
  quarterText(item: any, m: string): string {
    const mode = normalizeQuarterMode(item?.quarter_mode);
    const q = QUARTER_END[m];
    if (!mode || !q) return '';
    if (mode === 'quarter') return 'ไตรมาส ' + q;
    return 'ไตรมาส ' + q + ': ' + (quarterValues(mode, item)[q - 1] ?? '-');
  }

  onDeptChange() {
    this.applyDeptFilter();
  }

  get zoneList(): string[] { return zoneOptions(this.districts); }
  get zoneDistricts(): any[] { return this.districts.filter(d => inZone(d, this.selectedZone)); }

  onZoneChange() {
    if (this.selectedDistrict && !this.zoneDistricts.some(d => d.distid === this.selectedDistrict)) this.selectedDistrict = '';
    this.onDistrictChange();
  }

  onDistrictChange() {
    this.filteredHospitals = this.hospitals.filter(h =>
      inZone(h, this.selectedZone) && (!this.selectedDistrict || h.distid === this.selectedDistrict));
    this.refreshPicker();
    this.cdr.detectChanges();
  }

  // ===== เลือกหน่วยบริการหลายแห่ง =====
  /** รายการในหน้าต่างเลือก = หน่วยบริการตามโซน/อำเภอ + คำค้น (คำนวณตอนเปลี่ยน ไม่ใช่ getter — กัน NG0103) */
  refreshPicker() {
    const q = this.hosSearch.trim().toLowerCase();
    this.pickerList = !q ? this.filteredHospitals
      : this.filteredHospitals.filter(h => String(h.hoscode).includes(q) || String(h.hosname || '').toLowerCase().includes(q));
  }
  isHosSel(hc: string) { return this.selectedHospitals.has(String(hc)); }
  toggleHos(hc: string) {
    const k = String(hc);
    if (this.selectedHospitals.has(k)) this.selectedHospitals.delete(k); else this.selectedHospitals.add(k);
  }
  selectAllShown() { this.pickerList.forEach(h => this.selectedHospitals.add(String(h.hoscode))); }
  clearHospitals() { this.selectedHospitals.clear(); }
  get selectedHospitalList(): string[] { return [...this.selectedHospitals]; }
  hosLabel(hc: string): string {
    const h = this.hospitals.find(x => String(x.hoscode) === String(hc));
    return h ? `${h.hoscode}: ${h.hosname}` : String(hc);
  }
  get hosPickerText(): string {
    const n = this.selectedHospitals.size;
    if (!n) return '-- เลือกหน่วยบริการ --';
    if (n === 1) return this.hosLabel(this.selectedHospitalList[0]);
    return `เลือกแล้ว ${n} แห่ง`;
  }

  onYearChange() {
    this.kpiTemplate.forEach(item => item.year_bh = this.selectedYear);
    this.cdr.detectChanges();
  }

  onValueChange(item: any, month: string) {
    if (this.isQuarterOff(item, month)) { item[month] = ''; return; }
    if (item[month] < 0) item[month] = 0;
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    let sum = 0;
    for (const m of months) {
      sum += Number(item[m]) || 0;
    }
    item.total_actual = sum;
  }

  saveSetup() {
    if (!this.selectedHospitals.size) {
      Swal.fire({
        title: 'แจ้งเตือน',
        text: 'กรุณาเลือกหน่วยบริการก่อนบันทึก',
        icon: 'warning',
        confirmButtonColor: '#f39c12',
        confirmButtonText: 'ตกลง'
      });
      return;
    }

    if (this.kpiTemplate.length === 0) {
      Swal.fire({
        title: 'แจ้งเตือน',
        text: 'ไม่มีตัวชี้วัดสำหรับบันทึก',
        icon: 'warning',
        confirmButtonColor: '#f39c12',
        confirmButtonText: 'ตกลง'
      });
      return;
    }

    const deptName = this.selectedDept
      ? this.departments.find(d => String(d.id) === this.selectedDept)?.dept_name || 'ทั้งหมด'
      : 'ทั้งหมด';
    // หลายหน่วยบริการ: เพิ่มเฉพาะที่ยังไม่มีเท่านั้น (เขียนทับทำทีละหน่วยบริการ — ป้องกันทับผลงานหลายแห่งพร้อมกัน)
    if (this.selectedHospitals.size > 1) { this.confirmInsertMany(deptName); return; }
    const hosName = this.hosLabel(this.selectedHospitalList[0]);

    Swal.fire({
      title: 'เลือกรูปแบบการบันทึก',
      html: `<div class="text-left text-sm">
        <p class="mb-2 text-gray-600">บันทึกข้อมูล KPI ปี <b>${this.selectedYear}</b></p>
        <p class="mb-1 text-gray-600">หน่วยบริการ: <b>${hosName}</b></p>
        <p class="mb-3 text-gray-600">กลุ่มงาน: <b>${deptName}</b></p>
        <p class="text-gray-500 text-xs">จำนวนตัวชี้วัด: <b>${this.kpiTemplate.length}</b> รายการ</p>
      </div>`,
      icon: 'question',
      showCancelButton: true,
      showDenyButton: true,
      confirmButtonColor: '#10b981',
      denyButtonColor: '#3b82f6',
      cancelButtonColor: '#6b7280',
      confirmButtonText: '<i class="fas fa-plus-circle mr-1"></i> เพิ่มทั้งหมด (เขียนทับ)',
      denyButtonText: '<i class="fas fa-filter mr-1"></i> เพิ่มเฉพาะที่ยังไม่มี',
      cancelButtonText: 'ยกเลิก',
      width: 520
    }).then((result) => {
      if (result.isConfirmed) {
        this.doSaveOverwrite();
      } else if (result.isDenied) {
        this.doSaveInsertNew();
      }
    });
  }

  private doSaveOverwrite() {
    // ตรวจสอบข้อมูลที่มีอยู่ก่อน เพื่อแจ้งเตือนการเขียนทับ
    Swal.fire({
      title: 'กำลังตรวจสอบข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    this.authService.checkKpiSetup(this.selectedHospitalList[0], this.selectedYear, this.selectedDept).subscribe({
      next: (res) => {
        Swal.close();
        if (res.success && res.data.scoredIndicators > 0) {
          // มีข้อมูลคะแนนอยู่แล้ว → แจ้งเตือน
          Swal.fire({
            title: 'พบข้อมูลที่มีอยู่แล้ว',
            html: `<div class="text-left text-sm">
              <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-3">
                <p class="text-yellow-800 font-bold mb-1"><i class="fas fa-exclamation-triangle mr-1"></i> พบข้อมูลที่มีคะแนนอยู่แล้ว</p>
                <ul class="text-yellow-700 text-xs ml-4 list-disc space-y-1">
                  <li>ตัวชี้วัดที่มีข้อมูล: <b>${res.data.totalExisting}</b> รายการ</li>
                  <li>ตัวชี้วัดที่มีคะแนน: <b>${res.data.scoredIndicators}</b> รายการ</li>
                  <li>คะแนนรวม: <b>${Number(res.data.totalScore).toLocaleString()}</b></li>
                </ul>
              </div>
              <p class="text-red-600 font-bold text-xs">การเขียนทับจะแทนที่ข้อมูลทั้งหมดของตัวชี้วัดเหล่านี้</p>
            </div>`,
            icon: 'warning',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonColor: '#ef4444',
            denyButtonColor: '#3b82f6',
            cancelButtonColor: '#6b7280',
            confirmButtonText: '<i class="fas fa-edit mr-1"></i> ยืนยัน เขียนทับ',
            denyButtonText: '<i class="fas fa-filter mr-1"></i> เพิ่มเฉพาะที่ยังไม่มี',
            cancelButtonText: 'ยกเลิก',
            width: 520
          }).then((result2) => {
            if (result2.isConfirmed) {
              this.executeSave('setup_overwrite');
            } else if (result2.isDenied) {
              this.executeSave('setup_insert_new');
            }
          });
        } else {
          // ไม่มีข้อมูลเดิม → บันทึกเลย
          this.executeSave('setup_overwrite');
        }
      },
      error: () => {
        Swal.close();
        // ถ้าตรวจสอบไม่ได้ ให้ถามอีกครั้ง
        Swal.fire({
          title: 'ไม่สามารถตรวจสอบข้อมูลเดิมได้',
          text: 'ต้องการบันทึกต่อหรือไม่?',
          icon: 'warning',
          showCancelButton: true,
          confirmButtonColor: '#10b981',
          confirmButtonText: 'บันทึกต่อ',
          cancelButtonText: 'ยกเลิก'
        }).then((r) => {
          if (r.isConfirmed) {
            this.executeSave('setup_overwrite');
          }
        });
      }
    });
  }

  private doSaveInsertNew() {
    this.executeSave('setup_insert_new');
  }

  private executeSave(mode: 'setup_overwrite' | 'setup_insert_new') {
    Swal.fire({
      title: 'กำลังบันทึกข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    const dataToSave = this.setupRows();

    this.authService.updateKpiResults(dataToSave, this.selectedHospitalList[0], mode).subscribe({
      next: (res) => {
        const modeLabel = mode === 'setup_overwrite' ? 'เขียนทับ' : 'เพิ่มเฉพาะที่ยังไม่มี';
        let message = res.message || `บันทึกตัวชี้วัด ${dataToSave.length} รายการเรียบร้อยแล้ว`;
        if (res.inserted !== undefined) {
          message = mode === 'setup_insert_new'
            ? `เพิ่มตัวชี้วัดใหม่ ${res.inserted} รายการ (ข้าม ${res.skipped || 0} รายการที่มีอยู่แล้ว)`
              + (res.skipped_type ? ` — ข้ามที่ไม่ตรงประเภทหน่วยบริการ ${res.skipped_type}` : '')
              + (res.skipped_unset ? ` — ข้ามตัวชี้วัดที่ยังไม่ได้ตั้งประเภทหน่วยบริการ ${res.skipped_unset} (ตั้งค่าที่หน้าจัดการตัวชี้วัด)` : '')
            : `บันทึกตัวชี้วัดทั้งหมด ${res.inserted} รายการเรียบร้อยแล้ว (${modeLabel})`;
        }
        Swal.fire({
          title: 'สำเร็จ',
          text: message,
          icon: 'success',
          confirmButtonColor: '#28a745',
          confirmButtonText: 'ตกลง'
        });
      },
      error: (err) => Swal.fire({
        title: 'ผิดพลาด',
        text: err.error?.message || 'ไม่สามารถบันทึกข้อมูลได้',
        icon: 'error',
        confirmButtonColor: '#d33',
        confirmButtonText: 'ตกลง'
      })
    });
  }

  /** แถวที่ส่ง (ไม่มี hospcode) */
  setupRows(): any[] {
    return this.kpiTemplate.map(item => ({
      indicator_id: item.indicator_id,
      year_bh: this.selectedYear,
      target_value: item.target_value,
      oct: item.oct, nov: item.nov, dece: item.dece,
      jan: item.jan, feb: item.feb, mar: item.mar,
      apr: item.apr, may: item.may, jun: item.jun,
      jul: item.jul, aug: item.aug, sep: item.sep
    }));
  }

  private confirmInsertMany(deptName: string) {
    const n = this.selectedHospitals.size;
    const list = this.selectedHospitalList.slice(0, 8).map(hc => this.hosLabel(hc).replace(/[&<>"']/g, '')).join('<br>');
    Swal.fire({
      title: `เพิ่มตัวชี้วัดให้ ${n} หน่วยบริการ`,
      html: `<div class="text-left text-sm">
        <p class="mb-1 text-gray-600">ปีงบ <b>${this.selectedYear}</b> · กลุ่มงาน: <b>${deptName}</b> · ตัวชี้วัด <b>${this.kpiTemplate.length}</b> รายการ</p>
        <div class="text-xs text-gray-500 bg-gray-50 rounded p-2 max-h-32 overflow-auto">${list}${n > 8 ? `<br>…และอีก ${n - 8} แห่ง` : ''}</div>
        <p class="text-xs text-amber-700 mt-2"><i class="fas fa-info-circle mr-1"></i>เลือกหลายแห่ง = เพิ่มเฉพาะที่ยังไม่มี (ข้อมูลเดิมไม่ถูกแก้ไข) — ข้ามตัวชี้วัดที่ไม่ตรงประเภทหน่วยบริการ/ยังไม่ตั้งประเภท · ต้องการเขียนทับให้เลือกทีละหน่วยบริการ</p>
      </div>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: '<i class="fas fa-filter mr-1"></i> เพิ่มเฉพาะที่ยังไม่มี', cancelButtonText: 'ยกเลิก', width: 560,
    }).then(r => { if (r.isConfirmed) this.executeInsertMany(); });
  }

  private executeInsertMany() {
    const batches = buildSetupBatches(this.setupRows(), this.selectedHospitalList);
    const total = this.selectedHospitals.size;
    let done = 0, inserted = 0, skipped = 0, skippedType = 0, skippedUnset = 0, failUnits = 0;
    const errors: string[] = [];
    Swal.fire({ title: 'กำลังบันทึกข้อมูล...', html: `บันทึกแล้ว <b>0</b> / ${total} หน่วยบริการ`, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    const step = (i: number) => {
      if (i >= batches.length) {
        let msg = `เพิ่มตัวชี้วัดใหม่ ${inserted} คู่ ให้ ${total - failUnits} หน่วยบริการ`;
        if (skipped) msg += `<br>ข้ามที่มีอยู่แล้ว ${skipped}`;
        if (skippedType) msg += `<br>ข้ามที่ไม่ตรงประเภทหน่วยบริการ ${skippedType}`;
        if (skippedUnset) msg += `<br>ข้ามตัวชี้วัดที่ยังไม่ได้ตั้งประเภทหน่วยบริการ ${skippedUnset}`;
        if (failUnits) msg += `<br><span class="text-red-600 text-xs">ล้มเหลว ${failUnits} แห่ง: ${errors.slice(0, 3).join(', ').replace(/[<>]/g, '')}</span>`;
        Swal.fire(failUnits ? 'เสร็จสิ้น (มีบางส่วนผิดพลาด)' : 'สำเร็จ', msg, failUnits ? 'warning' : 'success');
        return;
      }
      const b = batches[i];
      this.authService.updateKpiResults(b.rows, b.hospcodes.length === 1 ? b.hospcodes[0] : '', 'setup_insert_new').subscribe({
        next: (res: any) => {
          inserted += Number(res.inserted) || 0; skipped += Number(res.skipped) || 0;
          skippedType += Number(res.skipped_type) || 0; skippedUnset += Number(res.skipped_unset) || 0;
          done += b.hospcodes.length;
          Swal.update({ html: `บันทึกแล้ว <b>${done}</b> / ${total} หน่วยบริการ` });
          step(i + 1);
        },
        error: (err: any) => {
          failUnits += b.hospcodes.length; done += b.hospcodes.length;
          errors.push(err.error?.message || err.message || 'ผิดพลาด');
          step(i + 1);
        },
      });
    };
    step(0);
  }

  bulkAddAllHospitals() {
    if (!this.selectedYear) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกปีงบประมาณ', 'warning');
      return;
    }
    const deptLabel = this.isSuperAdmin
      ? 'ทุกกลุ่มงาน'
      : (this.departments.find(d => d.id?.toString() === this.selectedDept)?.dept_name || 'กลุ่มงานของคุณ');
    Swal.fire({
      title: 'เพิ่ม KPI ทุกหน่วยบริการ',
      html: `<p class="text-sm text-gray-600">เพิ่มตัวชี้วัดของ <b>${deptLabel}</b> ให้ <b>ทุกหน่วยบริการ</b> ในปี <b>${this.selectedYear}</b></p>
             <p class="text-xs text-amber-600 mt-2"><i class="fas fa-info-circle mr-1"></i>เพิ่มเฉพาะที่ยังไม่มี ข้อมูลเดิมจะไม่ถูกแก้ไข</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#4f46e5',
      confirmButtonText: '<i class="fas fa-layer-group mr-1"></i> เพิ่มทั้งหมด',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'กำลังเพิ่มข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.bulkAddKpi(this.selectedYear, this.isSuperAdmin ? '' : this.selectedDept).subscribe({
          next: (r: any) => {
            Swal.fire({
              icon: 'success',
              title: 'เพิ่ม KPI สำเร็จ',
              html: `<div class="text-left text-sm space-y-2">
                <div class="bg-green-50 border border-green-200 rounded-lg p-3">
                  <p class="font-bold text-green-800 mb-1"><i class="fas fa-check-circle mr-1"></i>สรุปผลการเพิ่มข้อมูล</p>
                  <table class="w-full text-xs">
                    <tr><td class="py-1 text-gray-600">ปีงบประมาณ</td><td class="font-bold">${r.year_bh}</td></tr>
                    <tr><td class="py-1 text-gray-600">ตัวชี้วัด</td><td class="font-bold">${r.indicatorCount} รายการ</td></tr>
                    <tr><td class="py-1 text-gray-600">หน่วยบริการ</td><td class="font-bold">${r.hospitalCount} แห่ง</td></tr>
                    ${r.skipped_unset ? `<tr><td class="py-1 text-yellow-700">ข้าม (ยังไม่ตั้งประเภทหน่วยบริการ)</td><td class="font-bold text-yellow-700">${r.skipped_unset} ตัวชี้วัด</td></tr>` : ''}
                  </table>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <div class="bg-blue-50 border border-blue-200 rounded-lg p-2 text-center">
                    <p class="text-xl font-bold text-blue-700">${r.inserted}</p>
                    <p class="text-[10px] text-blue-600">ชุดที่เพิ่มใหม่</p>
                  </div>
                  <div class="bg-gray-50 border border-gray-200 rounded-lg p-2 text-center">
                    <p class="text-xl font-bold text-gray-500">${r.skipped}</p>
                    <p class="text-[10px] text-gray-500">ชุดที่ข้าม (มีอยู่แล้ว)</p>
                  </div>
                </div>
                <p class="text-xs text-gray-400"><i class="fas fa-database mr-1"></i>สร้างทั้งหมด ${r.totalRecords} records (12 เดือน × ${r.inserted} ชุด)</p>
              </div>`,
              confirmButtonColor: '#10b981'
            });
          },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเพิ่มข้อมูลได้', 'error')
        });
      }
    });
  }
}
