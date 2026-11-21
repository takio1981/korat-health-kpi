// ศูนย์งานผู้ดูแล (ระยะ 4 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
// หน้าเดียวบอก "อะไรรออนุมัติ / ใครยังไม่ส่งผลงานเดือนนี้ / คุณภาพข้อมูล / ส่ง KHD" ตามขอบเขตสิทธิ์ — ทุกการเปลี่ยนข้อมูลใช้เส้นทางเดิม (ด่านเดิม)
import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import Swal from 'sweetalert2';
import { AuthService } from '../services/auth';
import { getCurrentFiscalYear } from '../shared/fiscal-year.util';
import { ZoneBadgeComponent } from '../shared/zone-badge';
import { FormulaBadgeComponent } from '../shared/formula-badge';
import { KhdQuickSendComponent, runStatusText, triggerText, KHD_POLICY_LABEL, escapeHtml } from '../shared/khd-quick-send';

export const WC_MONTHS: { value: number; label: string }[] = [
  { value: 10, label: 'ต.ค.' }, { value: 11, label: 'พ.ย.' }, { value: 12, label: 'ธ.ค.' }, { value: 1, label: 'ม.ค.' },
  { value: 2, label: 'ก.พ.' }, { value: 3, label: 'มี.ค.' }, { value: 4, label: 'เม.ย.' }, { value: 5, label: 'พ.ค.' },
  { value: 6, label: 'มิ.ย.' }, { value: 7, label: 'ก.ค.' }, { value: 8, label: 'ส.ค.' }, { value: 9, label: 'ก.ย.' },
];
// ตรงกับ KIND_LABEL ใน api/services/data-quality.js
export const DQ_LABEL: Record<string, string> = { negative: 'ค่าติดลบ', high: 'สูงผิดปกติ', low: 'ต่ำผิดปกติ', text: 'เป็นข้อความในตัวชี้วัดตัวเลข', pct_over: 'ร้อยละเกิน 100' };

/** ข้อความจำนวนวันถึงกำหนดส่ง */
export function daysLeftText(n: number | null | undefined): string {
  if (n === null || n === undefined || isNaN(Number(n))) return '';
  const d = Number(n);
  if (d > 0) return `อีก ${d} วัน`;
  if (d === 0) return 'ครบกำหนดวันนี้';
  return `เลยกำหนด ${-d} วัน`;
}
/** ปีงบที่เลือกได้ (ปีปัจจุบัน + 2 ปีก่อนหน้า) */
export function fiscalYearChoices(now: Date = new Date()): string[] {
  const y = getCurrentFiscalYear(now);
  return [y, y - 1, y - 2].map(String);
}
/** ลิงก์ไปหน้าบันทึกผลงาน: ค้นหาด้วยรหัสหน่วยบริการ + ชื่อตัวชี้วัด (ตัดยาว) ภายในขอบเขตสิทธิ์เดิม */
export function dashboardQuery(hospcode: string | null, indicatorName: string | null, year: string): { q: string; year: string } {
  const name = String(indicatorName || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { q: [hospcode || '', name].filter(Boolean).join(' ').trim(), year };
}

@Component({
  selector: 'app-work-center',
  standalone: true,
  imports: [CommonModule, FormsModule, ZoneBadgeComponent, FormulaBadgeComponent, KhdQuickSendComponent],
  templateUrl: './work-center.html',
})
export class WorkCenterComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);

  readonly months = WC_MONTHS;
  readonly years = fiscalYearChoices();
  readonly daysLeft = daysLeftText;
  readonly runStatus = runStatusText;
  readonly trigger = triggerText;
  readonly dqLabel = DQ_LABEL;
  year = '';
  month: number | null = null;
  summary: any = null;
  loading = false;
  loadError = '';
  isSuperAdmin = false;
  tab: 'missing' | 'review' = 'missing';
  missingGroup: 'hospital' | 'indicator' = 'hospital';
  missing: any = null;
  review: any = null;
  dq: any = null;
  dqLoading = false;
  reminder: any = null;
  dayChoices = [7, 3, 2, 1, 0];
  showReminder = false;

  ngOnInit() {
    if (!this.authService.canAccessPage('work-center')) { this.router.navigate(['/dashboard']); return; }
    this.isSuperAdmin = this.authService.getUserRole() === 'super_admin';
    this.loadSummary();
  }

  policyLabel(p: string) { return KHD_POLICY_LABEL[p] || p; }

  loadSummary() {
    this.loading = true; this.loadError = '';
    const params: any = {};
    if (this.year) params.year_bh = this.year;
    if (this.month) params.month_bh = this.month;
    this.authService.apiGet('/work-center/summary', params).subscribe({
      next: (r: any) => {
        this.loading = false;
        this.summary = r?.data || null;
        if (this.summary) { this.year = this.summary.year_bh; this.month = this.summary.month_bh; }
        this.loadTab();
        this.cdr.detectChanges();
      },
      error: (e: any) => { this.loading = false; this.loadError = e?.error?.message || 'โหลดข้อมูลไม่สำเร็จ'; this.cdr.detectChanges(); },
    });
  }

  setTab(t: 'missing' | 'review') { this.tab = t; this.loadTab(); }
  setGroup(g: 'hospital' | 'indicator') { this.missingGroup = g; this.missing = null; this.loadTab(); }

  loadTab() {
    if (this.tab === 'missing') {
      this.authService.apiGet('/work-center/missing', { year_bh: this.year, month_bh: this.month, group: this.missingGroup }).subscribe({
        next: (r: any) => { this.missing = r?.data || null; this.cdr.detectChanges(); },
        error: () => { this.missing = null; this.cdr.detectChanges(); },
      });
    } else {
      this.authService.apiGet('/work-center/review-queue', { year_bh: this.year }).subscribe({
        next: (r: any) => { this.review = r || null; this.cdr.detectChanges(); },
        error: () => { this.review = null; this.cdr.detectChanges(); },
      });
    }
  }

  openDashboard(hospcode: string | null, indicatorName: string | null) {
    this.router.navigate(['/dashboard'], { queryParams: dashboardQuery(hospcode, indicatorName, this.year) });
  }

  openManage() { this.router.navigate(['/kpi-results-manage']); }

  loadDataQuality(refresh = false) {
    this.dqLoading = true;
    this.authService.apiGet('/work-center/data-quality', { year_bh: this.year, refresh: refresh ? 1 : undefined }).subscribe({
      next: (r: any) => { this.dqLoading = false; this.dq = r?.data || null; this.cdr.detectChanges(); },
      error: (e: any) => { this.dqLoading = false; Swal.fire('ผิดพลาด', e?.error?.message || 'ตรวจไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }
  dqKinds(): { key: string; n: number }[] {
    const c = this.dq?.counts || {};
    return Object.keys(c).filter(k => Number(c[k]) > 0).map(k => ({ key: k, n: Number(c[k]) }));
  }

  toggleReminder() {
    this.showReminder = !this.showReminder;
    if (this.showReminder && !this.reminder) {
      this.authService.apiGet('/work-center/reminder-settings').subscribe({
        next: (r: any) => { this.reminder = r?.data ? { ...r.data, reminder_channels: { ...r.data.reminder_channels } } : null; this.cdr.detectChanges(); },
      });
    }
  }
  hasDay(d: number) { return (this.reminder?.reminder_days_before || []).includes(d); }
  toggleDay(d: number) {
    const s = new Set<number>(this.reminder.reminder_days_before || []);
    if (s.has(d)) s.delete(d); else s.add(d);
    this.reminder.reminder_days_before = [...s].sort((a, b) => b - a);
  }
  saveReminder() {
    const r = this.reminder;
    const body = {
      reminder_enabled: !!r.reminder_enabled, reminder_due_day: Number(r.reminder_due_day), reminder_days_before: r.reminder_days_before,
      reminder_time: r.reminder_time, reminder_channels: r.reminder_channels, reminder_max_messages: Number(r.reminder_max_messages),
    };
    this.authService.apiPut('/work-center/reminder-settings', body).subscribe({
      next: (res: any) => {
        this.reminder = { ...res.data, reminder_channels: { ...res.data.reminder_channels } };
        Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
        this.loadSummary();
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'บันทึกไม่สำเร็จ', 'error'),
    });
  }

  /** ดูตัวอย่างแล้วยืนยันส่งเตือนทันที (เดือนที่เลือก) */
  sendReminderNow() {
    const body = { year_bh: this.year, month_bh: this.month };
    Swal.fire({ title: 'กำลังตรวจ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.apiPost('/work-center/reminders/preview', body).subscribe({
      next: (p: any) => {
        const d = p?.data || {};
        if (!d.hospitals) { Swal.fire({ icon: 'info', title: 'ทุกหน่วยบริการส่งผลงานแล้ว', text: `เดือน ${d.month_label || ''}` }); return; }
        const ch = d.channels || {};
        const sample = (d.sample || []).map((s: any) => `<li>${escapeHtml(s.hosname || s.hospcode)} — ${Number(s.count)} ตัวชี้วัด</li>`).join('');
        Swal.fire({
          title: `ส่งเตือนผลงานเดือน ${escapeHtml(d.month_label)}`, icon: 'question', showCancelButton: true,
          confirmButtonText: 'ส่งเตือน', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#10b981',
          html: `<div style="text-align:left;font-size:13px">หน่วยบริการที่ยังไม่ส่ง <b>${Number(d.hospitals)}</b> แห่ง (${Number(d.pairs)} คู่) · กำหนดส่ง ${escapeHtml(d.due_date)}
            <br>ช่องทาง: ${[ch.inapp ? 'ในระบบ' : '', ch.line ? 'LINE' : '', ch.email ? 'อีเมล' : ''].filter(Boolean).join(', ') || '-'}
            <ul style="margin-top:6px;padding-left:18px">${sample}</ul>
            <div style="font-size:11px;color:#6b7280">สั่งซ้ำวันเดียวกันจะไม่ส่งซ้ำถึงหน่วยบริการเดิม</div></div>`,
        }).then(r => {
          if (!r.isConfirmed) return;
          this.authService.apiPost('/work-center/reminders/send-now', body).subscribe({
            next: (res: any) => {
              const s = res?.data?.sent || {};
              Swal.fire({ icon: 'success', title: 'ส่งเตือนแล้ว', html: `ในระบบ ${Number(s.inapp) || 0} · LINE ${Number(s.line) || 0} · อีเมล ${Number(s.email) || 0}${res?.data?.skipped_duplicate ? `<br><small>ข้ามที่เคยส่งแล้ว ${Number(res.data.skipped_duplicate)}</small>` : ''}` });
              this.loadSummary();
            },
            error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ส่งไม่สำเร็จ', 'error'),
          });
        });
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ตรวจไม่สำเร็จ', 'error'),
    });
  }
}
