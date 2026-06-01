import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { ToastService } from '../services/toast.service';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-error-logs',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './error-logs.html'
})
export class ErrorLogsComponent implements OnInit {
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  private cdr = inject(ChangeDetectorRef);

  rows: any[] = [];
  stats: any = { total: 0, unresolved: 0, frontend_open: 0, backend_open: 0, fatal_open: 0, today: 0 };
  filterSource: string = '';
  filterSeverity: string = '';
  filterResolved: string = '0';   // default = unresolved
  loading: boolean = false;
  expanded = new Set<number>();

  private headers() {
    const token = localStorage.getItem('kpi_token');
    return new HttpHeaders({ 'Authorization': `Bearer ${token}` });
  }

  ngOnInit() { this.load(); }

  load() {
    this.loading = true;
    const params: any = { limit: 200 };
    if (this.filterSource) params.source = this.filterSource;
    if (this.filterSeverity) params.severity = this.filterSeverity;
    if (this.filterResolved !== '') params.resolved = this.filterResolved;
    const qs = new URLSearchParams(params).toString();
    this.http.get(`${environment.apiUrl}/admin/error-logs?${qs}`, { headers: this.headers() }).subscribe({
      next: (res: any) => {
        this.loading = false;
        if (res.success) {
          this.rows = res.data || [];
          this.stats = res.stats || this.stats;
          this.cdr.detectChanges();
        }
      },
      error: () => { this.loading = false; }
    });
  }

  toggle(id: number) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
  }
  isExpanded(id: number) { return this.expanded.has(id); }

  resolve(row: any) {
    this.http.post(`${environment.apiUrl}/admin/error-logs/${row.id}/resolve`, {}, { headers: this.headers() }).subscribe({
      next: () => {
        this.toast.success('Mark resolved');
        row.resolved = 1;
        this.cdr.detectChanges();
      },
      error: () => this.toast.error('ไม่สามารถ resolve ได้')
    });
  }

  clearResolved() {
    Swal.fire({
      title: 'ลบ error ที่ resolved แล้วทั้งหมด?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'ลบ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.http.delete<any>(`${environment.apiUrl}/admin/error-logs/clear-resolved`, { headers: this.headers() }).subscribe({
        next: (res) => {
          this.toast.success(`ลบ ${res.deleted || 0} รายการ`);
          this.load();
        },
        error: () => this.toast.error('ไม่สามารถลบได้')
      });
    });
  }

  sourceColor(s: string): string {
    return s === 'backend' ? 'bg-red-100 text-red-700' :
           s === 'frontend' ? 'bg-purple-100 text-purple-700' :
           s === 'http' ? 'bg-amber-100 text-amber-700' :
           'bg-gray-100 text-gray-700';
  }
  severityColor(s: string): string {
    return s === 'fatal' ? 'bg-red-600 text-white' :
           s === 'warning' ? 'bg-amber-500 text-white' :
           'bg-rose-500 text-white';
  }
  formatDate(d: string): string {
    if (!d) return '-';
    return new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }
}
