import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-report-compare',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './report-compare.html'
})
export class ReportCompareComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  showGuide = true;
  isLoading = false;
  isSyncing = false;
  compareResult: any = null;
  selectedItems = new Set<number>();
  filterStatus = '';
  searchTerm = '';

  ngOnInit() {}

  runCompare() {
    this.isLoading = true;
    this.compareResult = null;
    this.selectedItems.clear();
    this.authService.reportCompare().subscribe({
      next: (res: any) => {
        this.isLoading = false;
        if (res.success) this.compareResult = res;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.isLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเชื่อมต่อ HDC ได้', 'error');
      }
    });
  }

  get filteredItems(): any[] {
    if (!this.compareResult?.items) return [];
    return this.compareResult.items.filter((item: any) => {
      const matchStatus = !this.filterStatus || item.status === this.filterStatus;
      const matchSearch = !this.searchTerm ||
        (item.hdc_name || '').toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        (item.local_name || '').toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        (item.table_process || '').toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        (item.report_code || '').toLowerCase().includes(this.searchTerm.toLowerCase());
      return matchStatus && matchSearch;
    });
  }

  toggleSelect(id: number) {
    this.selectedItems.has(id) ? this.selectedItems.delete(id) : this.selectedItems.add(id);
  }

  selectAll() { this.filteredItems.forEach(t => this.selectedItems.add(t.hdc_report_id || t.local_id)); }
  selectNone() { this.selectedItems.clear(); }
  selectByStatus(status: string) {
    this.filteredItems.filter(t => t.status === status).forEach(t => this.selectedItems.add(t.hdc_report_id || t.local_id));
  }

  getStatusBadge(status: string) {
    switch (status) {
      case 'match': return { text: 'ตรงกัน', bg: 'bg-green-100 text-green-800', icon: 'fa-check-circle text-green-500' };
      case 'different': return { text: 'ข้อมูลต่างกัน', bg: 'bg-amber-100 text-amber-800', icon: 'fa-exclamation-triangle text-amber-500' };
      case 'missing_local': return { text: 'ไม่มีใน Local', bg: 'bg-blue-100 text-blue-800', icon: 'fa-arrow-down text-blue-500' };
      case 'missing_remote': return { text: 'ไม่มีใน HDC', bg: 'bg-purple-100 text-purple-800', icon: 'fa-arrow-up text-purple-500' };
      default: return { text: status, bg: 'bg-gray-100 text-gray-600', icon: 'fa-question text-gray-400' };
    }
  }

  syncSelected() {
    const ids = [...this.selectedItems];
    if (ids.length === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกรายการอย่างน้อย 1 รายการ', 'warning'); return; }
    const items = this.compareResult.items.filter((i: any) => ids.includes(i.hdc_report_id || i.local_id));
    const syncableItems = items.filter((i: any) => i.status === 'missing_local' || i.status === 'different');
    if (syncableItems.length === 0) { Swal.fire('แจ้งเตือน', 'ไม่มีรายการที่ต้อง Sync (เฉพาะ "ไม่มีใน Local" หรือ "ข้อมูลต่างกัน")', 'info'); return; }
    Swal.fire({
      title: 'ยืนยัน Sync ข้อมูล',
      html: `<p>Sync <b>${syncableItems.length}</b> รายการจาก HDC มาใส่ Local</p>
             <p class="text-xs text-amber-600 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>รายการที่มีอยู่แล้วจะถูกอัปเดต</p>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#16a34a',
      confirmButtonText: '<i class="fas fa-sync mr-1"></i> Sync ข้อมูล', cancelButtonText: 'ยกเลิก'
    }).then((r) => {
      if (!r.isConfirmed) return;
      this.isSyncing = true;
      Swal.fire({ title: 'กำลัง Sync...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      const hdcIds = syncableItems.map((i: any) => i.hdc_report_id).filter(Boolean);
      this.authService.reportCompareSync(hdcIds).subscribe({
        next: (res: any) => {
          this.isSyncing = false;
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'Sync สำเร็จ', html: res.message, timer: 3000 });
            this.runCompare();
          }
        },
        error: (err: any) => {
          this.isSyncing = false;
          Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถ Sync ได้', 'error');
        }
      });
    });
  }
}
