import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

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
  imports: [CommonModule, FormsModule],
  templateUrl: './kpi-results-manage.html'
})
export class KpiResultsManageComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);

  readonly months = FISCAL_MONTHS;
  readonly yearOptions: string[] = (() => {
    const fy = new Date().getFullYear() + 543 + (new Date().getMonth() >= 9 ? 1 : 0);
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

  // Selection
  selectedIds = new Set<number>();

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
    if (resetPage) this.page = 1;
    this.loading = true;
    this.selectedIds.clear();
    const params: any = { page: this.page, limit: this.pageSize };
    if (this.dateFrom) params.date_from = this.dateFrom;
    if (this.dateTo) params.date_to = this.dateTo;
    if (this.yearBh) params.year_bh = this.yearBh;
    if (this.monthFrom && this.monthTo) { params.month_from = this.monthFrom; params.month_to = this.monthTo; }

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
      Swal.fire({ title: 'กำลังลบ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.apiPost('/kpi-results/manage/bulk-delete', { ids }).subscribe({
        next: (res: any) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'ลบสำเร็จ', text: res.message, timer: 2500, showConfirmButton: false });
            this.loadData();
          }
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ลบไม่สำเร็จ', 'error')
      });
    });
  }
}
