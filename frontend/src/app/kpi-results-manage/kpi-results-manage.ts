import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import Swal from 'sweetalert2';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { ZoneBadgeComponent } from '../shared/zone-badge';
import { DataQualityPanelComponent } from '../shared/data-quality-panel';

// month_bh encoding ที่ระบบใช้จริงทั้งระบบ: 10,11,12,1,2,...,9 (ปีงบเริ่ม ต.ค.=10) — เรียงตามปีงบ (ต.ค. ก่อน)
const FISCAL_MONTHS = [
  { value: 10, label: 'ต.ค.' }, { value: 11, label: 'พ.ย.' }, { value: 12, label: 'ธ.ค.' },
  { value: 1, label: 'ม.ค.' }, { value: 2, label: 'ก.พ.' }, { value: 3, label: 'มี.ค.' },
  { value: 4, label: 'เม.ย.' }, { value: 5, label: 'พ.ค.' }, { value: 6, label: 'มิ.ย.' },
  { value: 7, label: 'ก.ค.' }, { value: 8, label: 'ส.ค.' }, { value: 9, label: 'ก.ย.' }
];

@Component({
  selector: 'app-kpi-results-manage',
  standalone: true,
  imports: [CommonModule, FormsModule, FormulaBadgeComponent, ZoneBadgeComponent, DataQualityPanelComponent],
  templateUrl: './kpi-results-manage.html'
})
export class KpiResultsManageComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);

  readonly months = FISCAL_MONTHS;
  readonly yearOptions: string[] = (() => {
    const fy = getCurrentFiscalYear();
    return [String(fy + 1), String(fy), String(fy - 1), String(fy - 2), String(fy - 3)];
  })();

  // Filters
  dateFrom = '';
  dateTo = '';
  yearBh = '';
  monthFrom: number | null = null;
  monthTo: number | null = null;

  // Table
  data: any[] = [];
  total = 0;
  page = 1;
  pageSize = 50;
  pages = 0;
  loading = false;
  hasSearched = false; // ยังไม่เคยกดค้นหาเลย — แสดงข้อความ "กรุณาเลือกตัวกรอง" แทนตาราง (เหมือน Dashboard admin_ssj/super_admin)

  // Selection — คงไว้ข้ามหน้า (ล้างเมื่อค้นหาใหม่/ล้างตัวกรอง/ลบเสร็จ)
  selectedIds = new Set<number>();
  selectingAll = false;
  /** ส่งลบครั้งละกี่รายการ (backend รับสูงสุด 2000 — MANAGE_DELETE_BATCH_MAX) */
  readonly deleteBatchSize = 1000;

  ngOnInit() {
    // ต้องเช็คตรงๆ เสมอ แม้ route จะมี pageAccessGuard แล้วก็ตาม (กันบั๊กแบบที่เคยเจอใน 9 component ก่อนหน้า)
    if (!this.authService.canAccessPage('kpi-results-manage')) {
      Swal.fire('ไม่มีสิทธิ์เข้าถึง', 'หน้านี้สำหรับ super_admin เท่านั้น', 'warning');
      this.router.navigate(['/dashboard']);
      return;
    }
  }

  get isAllSelected(): boolean {
    return this.data.length > 0 && this.data.every(r => this.selectedIds.has(r.id));
  }
  get isPartialSelected(): boolean {
    const selectedVisible = this.data.filter(r => this.selectedIds.has(r.id)).length;
    return selectedVisible > 0 && selectedVisible < this.data.length;
  }
  toggleSelect(id: number) {
    this.selectedIds.has(id) ? this.selectedIds.delete(id) : this.selectedIds.add(id);
  }
  toggleSelectAll() {
    if (this.isAllSelected) this.data.forEach(r => this.selectedIds.delete(r.id));
    else this.data.forEach(r => this.selectedIds.add(r.id));
  }

  /** เลือกครบทุกแถวที่ค้นหาได้ (ทุกหน้า) แล้ว */
  get isAllMatchingSelected(): boolean {
    return this.total > 0 && this.selectedIds.size >= this.total;
  }
  get isPartialMatchingSelected(): boolean {
    return this.selectedIds.size > 0 && !this.isAllMatchingSelected;
  }

  /** checkbox "เลือกทั้งหมดที่ค้นหาได้ทุกหน้า" — ขอรหัสทุกแถวที่ตรงเงื่อนไขจาก server (เงื่อนไขเดียวกับตาราง) — 12 พ.ย. 2569 */
  toggleSelectAllMatching() {
    if (this.isAllMatchingSelected || this.isPartialMatchingSelected) {
      this.selectedIds.clear();
      this.cdr.detectChanges();
      return;
    }
    this.selectingAll = true;
    this.authService.apiGet('/kpi-results/manage/ids', this.filterParams()).subscribe({
      next: (res: any) => {
        this.selectingAll = false;
        if (res.success) {
          this.selectedIds = new Set<number>(res.ids);
          if (res.truncated) {
            Swal.fire('เลือกได้บางส่วน', `ผลการค้นหามีมากกว่า ${Number(res.max).toLocaleString()} รายการ — เลือกไว้ ${Number(res.max).toLocaleString()} รายการล่าสุด กรุณากรองให้แคบลงเพื่อเลือกส่วนที่เหลือ`, 'info');
          }
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.selectingAll = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'เลือกทั้งหมดไม่สำเร็จ', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  /** เงื่อนไขค้นหาปัจจุบัน (ใช้ทั้งโหลดตารางและเลือกทั้งหมด) */
  filterParams(): any {
    const params: any = {};
    if (this.dateFrom) params.date_from = this.dateFrom;
    if (this.dateTo) params.date_to = this.dateTo;
    if (this.yearBh) params.year_bh = this.yearBh;
    if (this.monthFrom && this.monthTo) { params.month_from = this.monthFrom; params.month_to = this.monthTo; }
    return params;
  }

  applyFilters() {
    if (!this.dateFrom && !this.dateTo && !this.yearBh) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกช่วงวันที่ หรือ ปีงบ อย่างน้อย 1 อย่างก่อนค้นหา', 'warning');
      return;
    }
    this.hasSearched = true;
    this.loadData(true);
  }

  clearFilters() {
    this.dateFrom = '';
    this.dateTo = '';
    this.yearBh = '';
    this.monthFrom = null;
    this.monthTo = null;
    this.data = [];
    this.total = 0;
    this.pages = 0;
    this.hasSearched = false;
    this.selectedIds.clear();
  }

  loadData(resetPage = false) {
    if (resetPage) { this.page = 1; this.selectedIds.clear(); }   // เปลี่ยนหน้า = คงรายการที่เลือกไว้
    this.loading = true;
    const params: any = { ...this.filterParams(), page: this.page, limit: this.pageSize };

    this.authService.apiGet('/kpi-results/manage', params).subscribe({
      next: (res: any) => {
        this.loading = false;
        if (res.success) {
          this.data = res.data;
          this.total = res.total;
          this.pages = Math.ceil(res.total / this.pageSize);
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.loading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'โหลดข้อมูลไม่สำเร็จ', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  goPage(p: number) {
    if (p < 1 || p > this.pages) return;
    this.page = p;
    this.loadData();
  }

  pagesArray(): number[] {
    const total = this.pages;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const p = this.page;
    const arr: number[] = [1];
    if (p > 3) arr.push(-1);
    for (let i = Math.max(2, p - 1); i <= Math.min(total - 1, p + 1); i++) arr.push(i);
    if (p < total - 2) arr.push(-1);
    arr.push(total);
    return arr;
  }

  monthLabel(monthBh: any): string {
    return this.months.find(m => m.value === Number(monthBh))?.label || String(monthBh);
  }

  statusBadge(status: string): string {
    const map: Record<string, string> = {
      Pending: 'bg-yellow-100 text-yellow-800',
      approved: 'bg-green-100 text-green-800',
      rejected: 'bg-red-100 text-red-800'
    };
    return map[status] || 'bg-gray-100 text-gray-700';
  }

  confirmBulkDelete() {
    const ids = [...this.selectedIds];
    if (ids.length === 0) return;
    const preview = this.data.filter(r => this.selectedIds.has(r.id)).slice(0, 10)
      .map(r => `<div>${r.kpi_indicators_name} — ${r.hosname || r.hospcode} — ${this.monthLabel(r.month_bh)}/${r.year_bh}</div>`)
      .join('');
    Swal.fire({
      title: 'ยืนยันลบข้อมูลผลงาน',
      html: `<p class="text-sm text-red-600 font-bold mb-2"><i class="fas fa-exclamation-triangle mr-1"></i>ลบถาวร ไม่สามารถกู้คืนได้ — จะลบ ${ids.length} รายการ</p>
             <div class="text-xs text-left max-h-40 overflow-y-auto bg-gray-50 rounded-lg p-2">${preview}${ids.length > 10 ? `<div class="mt-1 text-gray-400">และอีก ${ids.length - 10} รายการ...</div>` : ''}</div>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-trash-alt mr-1"></i> ลบถาวร', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.deleteInBatches(ids);
    });
  }

  /** ลบเป็นชุด (ครั้งละ deleteBatchSize) ตามลำดับ — เลือกทั้งหมดที่ค้นหาได้อาจมีหลายพันรายการ */
  async deleteInBatches(ids: number[]) {
    const batches: number[][] = [];
    for (let i = 0; i < ids.length; i += this.deleteBatchSize) batches.push(ids.slice(i, i + this.deleteBatchSize));
    let deletedKpi = 0, deletedSub = 0, done = 0;
    Swal.fire({ title: 'กำลังลบ...', html: `0 / ${ids.length.toLocaleString()} รายการ`, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    try {
      for (const b of batches) {
        const res: any = await firstValueFrom(this.authService.apiPost('/kpi-results/manage/bulk-delete', { ids: b }));
        deletedKpi += res.deletedKpi || 0; deletedSub += res.deletedSub || 0; done += b.length;
        Swal.update({ html: `${done.toLocaleString()} / ${ids.length.toLocaleString()} รายการ` });
      }
      Swal.fire({ icon: 'success', title: 'ลบสำเร็จ', text: `ลบสำเร็จ — kpi_results ${deletedKpi}, kpi_sub_results ${deletedSub}`, timer: 2500, showConfirmButton: false });
    } catch (err: any) {
      Swal.fire('ผิดพลาด', (err?.error?.message || 'ลบไม่สำเร็จ') + (done ? ` (ลบไปแล้ว ${done.toLocaleString()} รายการ)` : ''), 'error');
    }
    this.selectedIds.clear();
    this.loadData();
  }
}
