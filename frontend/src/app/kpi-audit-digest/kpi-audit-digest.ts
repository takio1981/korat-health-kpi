import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-kpi-audit-digest',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kpi-audit-digest.html'
})
export class KpiAuditDigestComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  activeTab: 'settings' | 'records' = 'settings';
  settings: any = {
    enabled: true,
    digestEnabled: true,
    digestTime: '17:00',
    digestEmail: true,
    digestTelegram: true,
    minRecords: 1,
    lastDigestAt: '',
    lastDigestResult: ''
  };
  records: any[] = [];
  stats: any = { total: 0, unnotified: 0, today: 0, unique_users: 0 };
  filterUnnotified = false;
  isLoading = false;

  ngOnInit() {
    this.loadSettings();
    this.loadRecords();
  }

  setTab(t: typeof this.activeTab) {
    this.activeTab = t;
    if (t === 'records') this.loadRecords();
  }

  loadSettings() {
    this.authService.getKpiAuditSettings().subscribe({
      next: (res) => {
        if (res.success) {
          this.settings = res.data;
          this.cdr.detectChanges();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
    });
  }

  saveSettings() {
    this.authService.saveKpiAuditSettings(this.settings).subscribe({
      next: (res) => {
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', timer: 1500, showConfirmButton: false });
          this.loadSettings();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
    });
  }

  loadRecords() {
    this.isLoading = true;
    this.authService.getKpiAuditRecords(300, this.filterUnnotified).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.records = res.data || [];
          this.stats = res.stats || this.stats;
          this.cdr.detectChanges();
        }
      },
      error: () => { this.isLoading = false; }
    });
  }

  runDigestNow() {
    Swal.fire({
      title: 'ส่ง Digest ทันที?',
      html: `<div style="text-align:left;font-size:13px">
        ระบบจะรวบสรุปการบันทึกทั้งหมดที่ยังไม่เคยแจ้ง → ส่งไปยัง Email + Telegram ของ super_admin<br>
        และ mark records เป็น notified
      </div>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: 'ส่งเลย', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังส่ง...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.runKpiAuditDigestNow().subscribe({
        next: (res) => {
          if (res.success) {
            const r = res.result;
            if (r.skipped) {
              Swal.fire('ข้าม', `เหตุผล: ${r.reason}` + (r.records_count !== undefined ? ` (มี ${r.records_count} records, ต้องมี ${r.min})` : ''), 'info');
              return;
            }
            Swal.fire({
              icon: 'success', title: 'ส่ง Digest สำเร็จ',
              html: `<div style="text-align:left;font-size:13px">
                ผู้ใช้: <b>${r.total_users}</b> คน<br>
                รายการ: <b>${r.total_saves.toLocaleString()}</b><br>
                Email: ${r.sent_email ? '✅ ส่งแล้ว' : '— ไม่ได้ส่ง'}<br>
                Telegram: ${r.sent_telegram ? '✅ ส่งแล้ว' : '— ไม่ได้ส่ง'}
              </div>`
            });
            this.loadSettings();
            this.loadRecords();
          }
        },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
      });
    });
  }

  formatDate(d: string): string {
    if (!d) return '-';
    return new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  actionLabel(t: string): string {
    return t === 'kpi_results' ? 'บันทึกผลงาน KPI' :
           t === 'dynamic_form' ? 'บันทึก Form Builder' :
           t === 'sub_results' ? 'บันทึกผลงานย่อย' : t;
  }

  actionColor(t: string): string {
    return t === 'kpi_results' ? 'bg-emerald-100 text-emerald-700' :
           t === 'dynamic_form' ? 'bg-purple-100 text-purple-700' :
           t === 'sub_results' ? 'bg-blue-100 text-blue-700' :
           'bg-gray-100 text-gray-700';
  }

  parseLastDigest(): any {
    if (!this.settings.lastDigestResult) return null;
    try { return JSON.parse(this.settings.lastDigestResult); } catch { return null; }
  }
}
