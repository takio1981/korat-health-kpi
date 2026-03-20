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
  liveCounters = { total: 0, has_changes: 0, up_to_date: 0, no_data: 0, unchecked: 0 };
  // Display counters (เลขวิ่ง animated)
  displayCounters = { total: 0, has_changes: 0, up_to_date: 0, no_data: 0, unchecked: 0 };

  // UI state
  showGuide: boolean = true;

  // Export state
  exportLoading: boolean = false;
  exportResult: any = null;

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
          this.displayCounters = { total, has_changes: 0, up_to_date: 0, no_data: 0, unchecked: total };
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
  private updateLiveCounters() {
    let hasChanges = 0, upToDate = 0, noData = 0;
    for (const [, chk] of this.checkStatusMap) {
      if (chk.status === 'has_changes') hasChanges++;
      else if (chk.status === 'up_to_date') upToDate++;
      else noData++;
    }
    const total = this.exportIndicators.length;
    this.liveCounters = { total, has_changes: hasChanges, up_to_date: upToDate, no_data: noData, unchecked: total - hasChanges - upToDate - noData };
  }

  // Animated counter: นับจาก current ไปหา target
  private animateCounters(target: { total: number; has_changes: number; up_to_date: number; no_data: number; unchecked: number }) {
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
    this.liveCounters = { total, has_changes: 0, up_to_date: 0, no_data: 0, unchecked: total };
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
    this.liveCounters = { total, has_changes: 0, up_to_date: 0, no_data: 0, unchecked: total };
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

      // สรุปผล
      const totalChanges = allDetails.filter(r => r.status === 'has_changes').length;
      const totalUpToDate = allDetails.filter(r => r.status === 'up_to_date').length;
      const totalNoData = allDetails.filter(r => r.no_data).length;

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
            <tr style="color:#ea580c;"><td style="padding:4px 8px;">มีการเปลี่ยนแปลง</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${totalChanges}</td></tr>
            <tr style="color:#16a34a;"><td style="padding:4px 8px;">ข้อมูลล่าสุดแล้ว</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${totalUpToDate}</td></tr>
            <tr style="color:#9ca3af;"><td style="padding:4px 8px;">ไม่มีข้อมูล</td><td style="padding:4px 8px; text-align:right; font-weight:bold;">${totalNoData}</td></tr>
          </table>
        </div>`,
        icon: totalChanges > 0 ? 'info' : 'success',
        confirmButtonText: 'ปิด',
        confirmButtonColor: '#6366f1'
      }).then(() => {
        this.zone.run(() => {
          const finalCounters = { total, has_changes: totalChanges, up_to_date: totalUpToDate, no_data: totalNoData, unchecked: 0 };
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
}
