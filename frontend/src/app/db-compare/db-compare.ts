import { Component, OnInit, inject, ChangeDetectorRef, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-db-compare',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './db-compare.html'
})
export class DbCompareComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  @Output() createFormEvent = new EventEmitter<{ table: string, name: string, columns: any[] }>();

  showGuide = true;
  isLoading = false;
  compareResult: any = null;
  selectedTables = new Set<string>();
  filterStatus = '';
  searchTerm = '';
  expandedTable = '';

  // === ตัวกรองรายการ (เหมือน Phase B) ===
  filterMainIndicator: string = '';
  filterDept: string = '';
  filterActive: string = '';     // '' | 'active' | 'inactive'
  mainIndicators: any[] = [];
  departments: any[] = [];

  ngOnInit() {
    // access control อยู่ที่ kpi-manager parent component
    this.loadFilterOptions();
  }

  loadFilterOptions() {
    this.authService.getMainIndicators().subscribe({
      next: (res: any) => { if (res.success) this.mainIndicators = res.data; this.cdr.detectChanges(); }
    });
    this.authService.getDepartments().subscribe({
      next: (res: any) => { if (res.success) this.departments = res.data; this.cdr.detectChanges(); }
    });
  }

  clearFilters() {
    this.filterStatus = '';
    this.searchTerm = '';
    this.filterMainIndicator = '';
    this.filterDept = '';
    this.filterActive = '';
  }

  runCompare() {
    this.isLoading = true;
    this.compareResult = null;
    this.selectedTables.clear();
    this.authService.dbCompare().subscribe({
      next: (res: any) => {
        this.isLoading = false;
        if (res.success) this.compareResult = res;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.isLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเชื่อมต่อได้', 'error');
      }
    });
  }

  get filteredTables(): any[] {
    if (!this.compareResult?.tables) return [];
    return this.compareResult.tables.filter((t: any) => {
      const matchStatus = !this.filterStatus || t.status === this.filterStatus;
      const matchSearch = !this.searchTerm ||
        t.table.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
        t.name.toLowerCase().includes(this.searchTerm.toLowerCase());
      const matchMain = !this.filterMainIndicator || String(t.main_indicator_id) === this.filterMainIndicator;
      const matchDept = !this.filterDept || String(t.dept_id) === this.filterDept;
      const matchActive = !this.filterActive
        || (this.filterActive === 'active' && (t.is_active === 1 || t.is_active === true))
        || (this.filterActive === 'inactive' && (t.is_active === 0 || t.is_active === false));
      return matchStatus && matchSearch && matchMain && matchDept && matchActive;
    });
  }

  toggleSelect(table: string) {
    this.selectedTables.has(table) ? this.selectedTables.delete(table) : this.selectedTables.add(table);
  }

  selectAll() {
    this.filteredTables.forEach(t => this.selectedTables.add(t.table));
  }

  selectNone() {
    this.selectedTables.clear();
  }

  selectByStatus(status: string) {
    this.filteredTables.filter(t => t.status === status).forEach(t => this.selectedTables.add(t.table));
  }

  toggleExpand(table: string) {
    this.expandedTable = this.expandedTable === table ? '' : table;
  }

  getStatusBadge(status: string) {
    switch (status) {
      case 'match': return { text: 'ตรงกัน', bg: 'bg-green-100 text-green-800', icon: 'fa-check-circle text-green-500' };
      case 'different': return { text: 'ต่างกัน', bg: 'bg-amber-100 text-amber-800', icon: 'fa-exclamation-triangle text-amber-500' };
      case 'missing_local': return { text: 'ไม่มีใน Local', bg: 'bg-blue-100 text-blue-800', icon: 'fa-arrow-down text-blue-500' };
      case 'missing_remote': return { text: 'ไม่มีใน HDC', bg: 'bg-purple-100 text-purple-800', icon: 'fa-arrow-up text-purple-500' };
      case 'missing_both': return { text: 'ไม่มีทั้งสอง', bg: 'bg-gray-100 text-gray-600', icon: 'fa-ban text-gray-400' };
      default: return { text: status, bg: 'bg-gray-100 text-gray-600', icon: 'fa-question text-gray-400' };
    }
  }

  createLocal() {
    const tables = [...this.selectedTables];
    if (tables.length === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกตารางอย่างน้อย 1 ตาราง', 'warning'); return; }
    Swal.fire({
      title: 'ยืนยันสร้าง/แก้ไข',
      html: `<p>สร้าง/แก้ไข <b>${tables.length}</b> ตารางใน Local DB ให้ตรงกับ HDC</p>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#2563eb',
      confirmButtonText: '<i class="fas fa-hammer mr-1"></i> สร้าง/แก้ไข', cancelButtonText: 'ยกเลิก'
    }).then((r) => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังสร้าง...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.dbCompareCreateLocal(tables).subscribe({
        next: (res: any) => {
          Swal.fire({ icon: 'success', title: 'สำเร็จ', html: res.message, timer: 3000 });
          this.runCompare();
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถสร้างได้', 'error')
      });
    });
  }

  emitCreateForm(t: any) {
    if (!t.remote?.columns || t.remote.columns.length === 0) {
      Swal.fire('แจ้งเตือน', 'ตารางนี้ไม่มี columns จาก HDC', 'warning');
      return;
    }
    this.createFormEvent.emit({
      table: t.table,
      name: t.name,
      columns: t.remote.columns.map((c: any) => ({ ...c, _selected: false }))
    });
  }

  syncData() {
    const tables = [...this.selectedTables];
    if (tables.length === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกตารางอย่างน้อย 1 ตาราง', 'warning'); return; }
    Swal.fire({
      title: 'ยืนยัน Sync ข้อมูล',
      html: `<p>ดึงข้อมูลจาก HDC มาใส่ Local <b>${tables.length}</b> ตาราง</p><p class="text-xs text-red-500 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>ข้อมูลเดิมที่มี key ซ้ำจะถูกเขียนทับ</p>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#16a34a',
      confirmButtonText: '<i class="fas fa-sync mr-1"></i> Sync ข้อมูล', cancelButtonText: 'ยกเลิก'
    }).then((r) => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลัง Sync...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.dbCompareSyncData(tables).subscribe({
        next: (res: any) => {
          const detail = res.synced?.map((s: any) => `${s.table}: ${s.rows} rows`).join('<br>') || '';
          Swal.fire({ icon: 'success', title: 'Sync สำเร็จ', html: `${res.message}<br><div class="text-xs mt-2 text-gray-500">${detail}</div>` });
          this.runCompare();
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถ Sync ได้', 'error')
      });
    });
  }

  createRemote() {
    const tables = [...this.selectedTables];
    if (tables.length === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกตารางอย่างน้อย 1 ตาราง', 'warning'); return; }
    Swal.fire({
      title: 'ยืนยันสร้าง/แก้ไขใน HDC',
      html: `<p>สร้าง/แก้ไข <b>${tables.length}</b> ตารางใน HDC ให้ตรงกับ Local</p><p class="text-xs text-red-500 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>ต้องมีสิทธิ์ write ใน HDC — ตรวจสอบให้ดีก่อนยืนยัน</p>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#7c3aed',
      confirmButtonText: '<i class="fas fa-hammer mr-1"></i> สร้างใน HDC', cancelButtonText: 'ยกเลิก'
    }).then((r) => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังสร้างใน HDC...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.dbCompareCreateRemote(tables).subscribe({
        next: (res: any) => {
          const errDetail = res.errors?.length ? `<br><div class="text-xs mt-2 text-red-500">${res.errors.map((e: any) => `${e.table}: ${e.error}`).join('<br>')}</div>` : '';
          Swal.fire({ icon: 'success', title: 'สำเร็จ', html: `${res.message}${errDetail}`, timer: 4000 });
          this.runCompare();
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถสร้างใน HDC ได้', 'error')
      });
    });
  }

  syncToHDC() {
    const tables = [...this.selectedTables];
    if (tables.length === 0) { Swal.fire('แจ้งเตือน', 'กรุณาเลือกตารางอย่างน้อย 1 ตาราง', 'warning'); return; }
    Swal.fire({
      title: 'ยืนยัน Sync → HDC',
      html: `<p>ส่งข้อมูลจาก Local ไปยัง HDC <b>${tables.length}</b> ตาราง</p><p class="text-xs text-red-500 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>ข้อมูลใน HDC ที่ key ซ้ำจะถูกเขียนทับ — ต้องมีสิทธิ์ write ใน HDC</p>`,
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-cloud-upload-alt mr-1"></i> Sync → HDC', cancelButtonText: 'ยกเลิก'
    }).then((r) => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลัง Sync ไป HDC...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.dbCompareSyncToHDC(tables).subscribe({
        next: (res: any) => {
          const detail = res.synced?.map((s: any) => `${s.table}: ${s.rows} rows`).join('<br>') || '';
          const errDetail = res.errors?.length ? `<br><div class="text-xs mt-2 text-red-500">${res.errors.map((e: any) => `${e.table}: ${e.error}`).join('<br>')}</div>` : '';
          Swal.fire({ icon: 'success', title: 'Sync → HDC สำเร็จ', html: `${res.message}<br><div class="text-xs mt-2 text-gray-500">${detail}</div>${errDetail}` });
          this.runCompare();
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถ Sync ไป HDC ได้', 'error')
      });
    });
  }
}
