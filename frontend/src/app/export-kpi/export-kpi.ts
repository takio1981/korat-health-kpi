import { Component, OnInit, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-export-kpi',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './export-kpi.html'
})
export class ExportKpiComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  // Filters
  exportYear: string = '';
  yearOptions: string[] = [];
  filterMainIndicator: string = '';
  filterDept: string = '';
  filterStatus: string = '';
  filterCheckStatus: string = '';  // '' | 'has_changes' | 'up_to_date' | 'no_data'
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

  // Live counters (อัปเดตระหว่างตรวจสอบ)
  // has_changes = จำนวนตัวชี้วัดที่มีการเปลี่ยนแปลง
  // data_changes = จำนวนแถวข้อมูลรวมที่เพิ่ม/แก้ไข (new_count + changed_count)
  liveCounters = { total: 0, has_changes: 0, data_changes: 0, up_to_date: 0, no_data: 0, unchecked: 0 };
  displayCounters = { total: 0, has_changes: 0, data_changes: 0, up_to_date: 0, no_data: 0, unchecked: 0 };

  // UI state
  showGuide: boolean = true;

  // Export state
  exportLoading: boolean = false;
  exportResult: any = null;

  // Sync to HDC
  showSyncGuide: boolean = true;
  showSyncModal: boolean = false;
  syncPreviewData: any[] = [];
  syncLoading: boolean = false;
  syncSelectedTables = new Set<string>();

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
    auto_sync_hdc: false,
    notify_email: true,
    notify_telegram: false
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
    const role = this.authService.getUserRole();
    if (role !== 'super_admin') {
      Swal.fire('Access Denied', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }

    const now = new Date();
    const thaiYear = now.getFullYear() + 543;
    const currentFiscalYear = now.getMonth() >= 9 ? thaiYear + 1 : thaiYear;
    this.exportYear = currentFiscalYear.toString();
    for (let y = currentFiscalYear + 1; y >= currentFiscalYear - 3; y--) {
      this.yearOptions.push(y.toString());
    }

    this.loadFilterOptions();
    this.loadExportableIndicators();
    this.loadSchedules();
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
          this.applyFilters();
          this.selectedIndicatorIds = new Set(this.filteredExportIndicators.map((i: any) => i.id));
          this.updateSelectAll();
          // ตั้ง displayCounters เริ่มต้น
          const total = res.data.length;
          this.displayCounters = { total, has_changes: 0, data_changes: 0, up_to_date: 0, no_data: 0, unchecked: total };
          this.liveCounters = { ...this.displayCounters };
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

    // กรองตามสถานะตรวจสอบ (ถ้ามีผลการตรวจสอบแล้ว)
    if (this.filterCheckStatus && this.checkStatusMap.size > 0) {
      list = list.filter((i: any) => {
        const chk = this.checkStatusMap.get(i.id);
        if (!chk) return this.filterCheckStatus === 'no_data';
        return chk.status === this.filterCheckStatus;
      });
    }

    const search = this.exportSearch.toLowerCase().trim();
    if (search) {
      list = list.filter((i: any) =>
        i.kpi_indicators_name.toLowerCase().includes(search) ||
        i.table_process.toLowerCase().includes(search)
      );
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

  // อัปเดต liveCounters จาก checkStatusMap (เรียกทุกรอบ batch)
  // นับตาม unique table_process (หลาย indicator ที่ใช้ table_process เดียวกันนับเป็น 1)
  private updateLiveCounters() {
    // Map indicator_id → table_process
    const idToTp = new Map<number, string>();
    for (const ind of this.exportIndicators) idToTp.set(ind.id, ind.table_process);

    const changedTables = new Set<string>();
    const upToDateTables = new Set<string>();
    const noDataTables = new Set<string>();
    // data_changes: นับจากแต่ละ table_process (หนึ่งครั้ง) เพราะ indicators ที่ share table มีค่าเดียวกัน
    const dataChangesPerTable = new Map<string, number>();

    for (const [id, chk] of this.checkStatusMap) {
      const tp = idToTp.get(id);
      if (!tp) continue;
      if (chk.status === 'has_changes') {
        changedTables.add(tp);
        if (!dataChangesPerTable.has(tp)) {
          dataChangesPerTable.set(tp, (chk.new_count || 0) + (chk.changed_count || 0));
        }
      } else if (chk.status === 'up_to_date') {
        if (!changedTables.has(tp)) upToDateTables.add(tp);
      } else {
        if (!changedTables.has(tp) && !upToDateTables.has(tp)) noDataTables.add(tp);
      }
    }

    const total = this.exportIndicators.length;
    const hasChanges = changedTables.size;
    const dataChanges = Array.from(dataChangesPerTable.values()).reduce((s, n) => s + n, 0);
    const upToDate = upToDateTables.size;
    const noData = noDataTables.size;
    this.liveCounters = { total, has_changes: hasChanges, data_changes: dataChanges, up_to_date: upToDate, no_data: noData, unchecked: total - this.checkStatusMap.size };
  }

  // Animated counter: นับจาก current ไปหา target
  private animateCounters(target: { total: number; has_changes: number; data_changes: number; up_to_date: number; no_data: number; unchecked: number }) {
    const duration = 600; // ms
    const steps = 30;
    const interval = duration / steps;
    const start = { ...this.displayCounters };
    let step = 0;

    const timer = setInterval(() => {
      step++;
      const progress = step / steps;
      this.displayCounters = {
        total: Math.round(start.total + (target.total - start.total) * progress),
        has_changes: Math.round(start.has_changes + (target.has_changes - start.has_changes) * progress),
        data_changes: Math.round(start.data_changes + (target.data_changes - start.data_changes) * progress),
        up_to_date: Math.round(start.up_to_date + (target.up_to_date - start.up_to_date) * progress),
        no_data: Math.round(start.no_data + (target.no_data - start.no_data) * progress),
        unchecked: Math.round(start.unchecked + (target.unchecked - start.unchecked) * progress)
      };
      this.cdr.detectChanges();
      if (step >= steps) {
        clearInterval(timer);
        this.displayCounters = { ...target };
        this.cdr.detectChanges();
      }
    }, interval);
  }

  clearFilters() {
    this.filterMainIndicator = '';
    this.filterDept = '';
    this.filterStatus = '';
    this.filterCheckStatus = '';
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
    const total = this.exportIndicators.length;
    this.liveCounters = { total, has_changes: 0, data_changes: 0, up_to_date: 0, no_data: 0, unchecked: total };
    this.animateCounters(this.liveCounters);
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
    this.liveCounters = { total, has_changes: 0, data_changes: 0, up_to_date: 0, no_data: 0, unchecked: total };
    this.displayCounters = { ...this.liveCounters };
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

        // อัปเดต live counters ทุก batch
        this.updateLiveCounters();
        this.displayCounters = { ...this.liveCounters };
        this.cdr.detectChanges();
      }

      // สรุปผล — dedupe ตาม table_process (หลาย indicator ใช้ table เดียวกันนับเป็น 1)
      const idToTp = new Map<number, string>();
      for (const ind of this.exportIndicators) idToTp.set(ind.id, ind.table_process);

      const changedSet = new Set<string>(), upToDateSet = new Set<string>(), noDataSet = new Set<string>();
      const dataChangesPerTp = new Map<string, number>();
      for (const r of allDetails) {
        const tp = idToTp.get(r.id);
        if (!tp) continue;
        if (r.status === 'has_changes') {
          changedSet.add(tp);
          if (!dataChangesPerTp.has(tp)) dataChangesPerTp.set(tp, (r.new_count || 0) + (r.changed_count || 0));
        } else if (r.status === 'up_to_date') {
          if (!changedSet.has(tp)) upToDateSet.add(tp);
        } else {
          if (!changedSet.has(tp) && !upToDateSet.has(tp)) noDataSet.add(tp);
        }
      }
      const totalChanges = changedSet.size;
      const totalUpToDate = upToDateSet.size;
      const totalNoData = noDataSet.size;
      const totalDataChanges = Array.from(dataChangesPerTp.values()).reduce((s, n) => s + n, 0);

      this.checkResult = {
        success: true,
        check_date: checkDate || new Date().toISOString(),
        year_bh: this.exportYear,
        summary: { total: allDetails.length, has_changes: totalChanges, up_to_date: totalUpToDate, no_data: totalNoData },
        details: allDetails
      };

      this.checkLoading = false;
      this.applyFilters();
      this.cdr.detectChanges();

      // SweetAlert สรุปผล — หลังปิด alert ให้ animate counters ใน NgZone
      Swal.fire({
        title: 'ตรวจสอบเสร็จสิ้น',
        html: `<div style="text-align:left; font-size:14px;">
          <div style="margin-bottom:8px;">ปีงบประมาณ: <b>${this.exportYear}</b></div>
          <table style="width:100%; border-collapse:collapse;">
            <tr><td style="padding:4px 8px;">ตัวชี้วัดทั้งหมด</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${allDetails.length}</td></tr>
            <tr style="color:#ea580c;"><td style="padding:4px 8px;">ตัวชี้วัดที่เพิ่ม/แก้ไข</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${totalChanges}</td></tr>
            <tr style="color:#e11d48;"><td style="padding:4px 8px;">จำนวนข้อมูลที่เปลี่ยนแปลง</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${totalDataChanges}</td></tr>
            <tr style="color:#16a34a;"><td style="padding:4px 8px;">ข้อมูลล่าสุดแล้ว</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${totalUpToDate}</td></tr>
            <tr style="color:#9ca3af;"><td style="padding:4px 8px;">ไม่มีข้อมูล</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${totalNoData}</td></tr>
          </table>
        </div>`,
        icon: totalChanges > 0 ? 'info' : 'success',
        confirmButtonText: 'ปิด',
        confirmButtonColor: '#6366f1'
      }).then(() => {
        this.zone.run(() => {
          const finalCounters = { total, has_changes: totalChanges, data_changes: totalDataChanges, up_to_date: totalUpToDate, no_data: totalNoData, unchecked: 0 };
          this.animateCounters(finalCounters);
        });
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
              // ล้างผลตรวจสอบเดิม (ให้กดตรวจสอบใหม่เอง)
              this.checkResult = null;
              this.checkStatusMap.clear();
              this.applyFilters();
              this.cdr.detectChanges();

              Swal.fire({
                title: 'สำเร็จ',
                html: `ดำเนินการสำเร็จ <b>${res.created_tables.length}</b> ตาราง` +
                  (res.skipped.length > 0 ? `<br>ข้าม <b>${res.skipped.length}</b> รายการ` : '') +
                  `<br>เพิ่มใหม่: <b>${res.summary.inserted}</b> | อัปเดต: <b>${res.summary.updated}</b> | ไม่เปลี่ยนแปลง: <b>${res.summary.unchanged}</b>`,
                icon: 'success',
                confirmButtonColor: '#28a745'
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

  // === Sync to HDC ===
  openSyncToHdc() {
    this.syncLoading = true;
    this.showSyncModal = true;
    this.syncPreviewData = [];
    this.syncSelectedTables.clear();
    this.cdr.detectChanges();

    this.authService.syncToHdcPreview().subscribe({
      next: (res: any) => {
        this.syncLoading = false;
        if (res.success) {
          this.syncPreviewData = res.tables;
          res.tables.forEach((t: any) => { if (t.status === 'ready') this.syncSelectedTables.add(t.table); });
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.syncLoading = false;
        this.showSyncModal = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถตรวจสอบได้', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  toggleSyncTable(table: string) {
    this.syncSelectedTables.has(table) ? this.syncSelectedTables.delete(table) : this.syncSelectedTables.add(table);
  }

  toggleSyncAll() {
    const ready = this.syncPreviewData.filter((t: any) => t.status === 'ready');
    if (this.syncSelectedTables.size === ready.length) {
      this.syncSelectedTables.clear();
    } else {
      ready.forEach((t: any) => this.syncSelectedTables.add(t.table));
    }
  }

  executeSyncToHdc() {
    if (this.syncSelectedTables.size === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกตารางอย่างน้อย 1 รายการ', 'warning'); return; }
    const tables = this.syncPreviewData
      .filter((t: any) => this.syncSelectedTables.has(t.table))
      .map((t: any) => ({ table: t.table, sync_columns: t.sync_columns }));

    Swal.fire({
      title: 'ยืนยันส่งข้อมูลเข้า HDC',
      html: `<p class="text-sm">ส่ง <b>${tables.length}</b> ตาราง เข้า HDC?</p>
             <p class="text-xs text-teal-600 mt-2"><i class="fas fa-info-circle mr-1"></i>ระบบจะอัปเดตเฉพาะข้อมูลที่ตรง key — ข้อมูลเดิมใน HDC ที่ไม่ซ้ำจะยังคงอยู่</p>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#0d9488',
      confirmButtonText: '<i class="fas fa-upload mr-1"></i> ส่งข้อมูล', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.syncLoading = true;
        this.cdr.detectChanges();
        Swal.fire({ title: 'กำลังส่งข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.syncToHdcExecute(tables).subscribe({
          next: (res: any) => {
            this.syncLoading = false;
            this.showSyncModal = false;
            this.cdr.detectChanges();
            const successCount = res.results?.filter((x: any) => x.status === 'success').length || 0;
            const errorCount = res.results?.filter((x: any) => x.status === 'error').length || 0;
            const totalRows = res.results?.filter((x: any) => x.status === 'success').reduce((s: number, x: any) => s + x.rows, 0) || 0;
            Swal.fire({
              icon: errorCount > 0 ? 'warning' : 'success',
              title: 'ส่งข้อมูลเสร็จสิ้น',
              html: `<div class="text-left text-sm space-y-2">
                <div class="grid grid-cols-3 gap-2 text-center">
                  <div class="bg-green-50 border border-green-200 rounded-lg p-2"><p class="text-xl font-bold text-green-700">${successCount}</p><p class="text-[10px]">สำเร็จ</p></div>
                  <div class="bg-red-50 border border-red-200 rounded-lg p-2"><p class="text-xl font-bold text-red-600">${errorCount}</p><p class="text-[10px]">ผิดพลาด</p></div>
                  <div class="bg-blue-50 border border-blue-200 rounded-lg p-2"><p class="text-xl font-bold text-blue-700">${totalRows}</p><p class="text-[10px]">rows ทั้งหมด</p></div>
                </div>
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
      notify_email: true,
      notify_telegram: false
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
      auto_sync_hdc: !!s.auto_sync_hdc,
      notify_email: !!s.notify_email,
      notify_telegram: !!s.notify_telegram
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
      auto_sync_hdc: f.auto_sync_hdc,
      notify_email: f.notify_email,
      notify_telegram: f.notify_telegram
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
                 <p class="font-bold text-teal-700"><i class="fas fa-cloud-upload-alt mr-1"></i>Sync ไปยัง HDC</p>
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
