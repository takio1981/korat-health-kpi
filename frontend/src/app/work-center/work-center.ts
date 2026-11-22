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

const MONTH_SHORT: Record<number, string> = Object.fromEntries(WC_MONTHS.map(m => [m.value, m.label]));
/** เดือนที่รอตรวจ → "ต.ค., พ.ย." */
export function monthsText(ms: number[] | null | undefined): string {
  return (ms || []).map(m => MONTH_SHORT[Number(m)] || String(m)).join(', ');
}
export const reviewKey = (r: any) => `${Number(r.indicator_id)}|${String(r.hospcode)}`;
/** แบ่งรายการเป็นชุด (ส่งทีละชุด กันคำขอใหญ่เกิน) */
export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
/** รายการอนุมัติ (ใช้ /approve-kpi เดิม): through = '' → เดือนล่าสุดที่มีผลงานของแต่ละคู่ (server ตัดสิน) */
export function buildApprovePayload(items: any[], year: string, through: number | '' | null): any[] {
  return items.map(r => {
    const o: any = { indicator_id: Number(r.indicator_id), year_bh: String(year), hospcode: String(r.hospcode) };
    if (through) o.through_month = Number(through);
    return o;
  });
}
/** รายการส่งคืนแก้ไข (ใช้ /reject-kpi เดิม — ไม่ระบุเดือน = เฉพาะเดือนที่ยังไม่อนุมัติ) */
export function buildRejectPayload(items: any[], year: string, comment: string): any[] {
  return items.map(r => ({ indicator_id: Number(r.indicator_id), year_bh: String(year), hospcode: String(r.hospcode), comment: String(comment || '').trim() }));
}
export const REVIEW_BATCH = 100;
/** ข้อความความคืบหน้าของงานส่งเตือน (GET /work-center/reminders/status) */
export function reminderProgressText(job: any): string {
  const p = job?.progress;
  if (!p || !Number(p.hospitals_total)) return 'กำลังเตรียมรายการ...';
  const h = `หน่วยบริการ ${Number(p.hospitals_done) || 0} / ${Number(p.hospitals_total)} แห่ง`;
  return Number(p.messages_total) ? `${h}<br>LINE/อีเมล ${Number(p.messages_done) || 0} / ${Number(p.messages_total)} ข้อความ` : h;
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
  readonly monthsText = monthsText;
  selected = new Set<string>();
  approveThrough: number | '' = '';
  reviewBusy = false;

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
        next: (r: any) => { this.review = r || null; this.selected.clear(); this.cdr.detectChanges(); },
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
          Swal.fire({ title: 'กำลังส่งเตือน...', html: reminderProgressText(null), allowOutsideClick: false, didOpen: () => Swal.showLoading() });
          this.authService.apiPost('/work-center/reminders/send-now', body).subscribe({
            next: () => this.pollReminderJob(),
            // กำลังส่งรอบเดิมอยู่ (เช่น กดจากอีกหน้าต่าง) = ติดตามรอบนั้นแทน
            error: (e: any) => e?.error?.code === 'REMINDER_BUSY' ? this.pollReminderJob() : Swal.fire('ผิดพลาด', e?.error?.message || 'ส่งไม่สำเร็จ', 'error'),
          });
        });
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ตรวจไม่สำเร็จ', 'error'),
    });
  }

  /** ส่งเตือนเป็นงานเบื้องหลังของ server — ดูความคืบหน้าทุก 2 วินาทีจนเสร็จ (คำขอเดียวรอทั้งรอบเคยได้ 504 จาก gateway) */
  pollReminderJob(delay = 2000) {
    this.authService.apiGet('/work-center/reminders/status').subscribe({
      next: (r: any) => {
        const job = r?.data?.job;
        if (!job || job.status === 'running') {
          if (Swal.isVisible()) Swal.update({ html: reminderProgressText(job) });
          setTimeout(() => this.pollReminderJob(delay), delay);
          return;
        }
        if (job.status === 'failed') { Swal.fire('ผิดพลาด', job.error || 'ส่งไม่สำเร็จ', 'error'); return; }
        const d = job.result || {};
        const s = d.sent || {};
        Swal.fire({ icon: 'success', title: 'ส่งเตือนแล้ว', html: `ในระบบ ${Number(s.inapp) || 0} · LINE ${Number(s.line) || 0} · อีเมล ${Number(s.email) || 0}`
          + (d.skipped_duplicate ? `<br><small>ข้ามที่เคยส่งแล้ว ${Number(d.skipped_duplicate)}</small>` : '')
          + (d.capped ? `<br><small>เกินเพดานข้อความต่อรอบ ${Number(d.capped)}</small>` : '') });
        this.loadSummary();
      },
      // เครือข่ายสะดุดชั่วคราว — งานยังทำต่อที่ server ลองดูใหม่
      error: () => setTimeout(() => this.pollReminderJob(delay), delay * 2),
    });
  }

  // ===== อนุมัติ / ส่งคืนจากคิวรอตรวจ (เส้นทางเดิม /approve-kpi, /reject-kpi — ด่านขอบเขต/สถานะเดิมทุกข้อ) =====
  get reviewItems(): any[] { return this.review?.items || []; }
  isSel(r: any) { return this.selected.has(reviewKey(r)); }
  toggleSel(r: any) { const k = reviewKey(r); if (this.selected.has(k)) this.selected.delete(k); else this.selected.add(k); }
  get allSelected(): boolean { return this.reviewItems.length > 0 && this.reviewItems.every(r => this.selected.has(reviewKey(r))); }
  toggleAll() {
    if (this.allSelected) this.selected.clear();
    else this.reviewItems.forEach(r => this.selected.add(reviewKey(r)));
  }
  get selectedItems(): any[] { return this.reviewItems.filter(r => this.selected.has(reviewKey(r))); }

  /** ส่งทีละชุดต่อกัน → รวมผล */
  runBatches(path: string, batches: any[][], done: (agg: { ok: number; skipped: number; months: number; failed: number; errors: string[] }) => void) {
    const agg = { ok: 0, skipped: 0, months: 0, failed: 0, errors: [] as string[] };
    const step = (i: number) => {
      if (i >= batches.length) { done(agg); return; }
      if (Swal.isVisible()) Swal.update({ html: `ดำเนินการแล้ว ${i} / ${batches.length} ชุด` });
      this.authService.apiPost(path, batches[i]).subscribe({
        next: (r: any) => {
          agg.ok += Number(r?.approved ?? batches[i].length) || 0;
          agg.skipped += Number(r?.skipped) || 0;
          agg.months += Number(r?.months) || 0;
          step(i + 1);
        },
        error: (e: any) => { agg.failed += batches[i].length; agg.errors.push(e?.error?.message || 'ผิดพลาด'); step(i + 1); },
      });
    };
    step(0);
  }

  private batchResultHtml(main: string, agg: { errors: string[] }) {
    return main + (agg.errors.length ? `<br><small style="color:#b91c1c">${escapeHtml(agg.errors.slice(0, 3).join(' / '))}</small>` : '');
  }

  approveSelected() {
    const items = this.selectedItems;
    if (!items.length || this.reviewBusy) return;
    const thr = this.approveThrough ? `ถึงเดือน <b>${escapeHtml(monthsText([Number(this.approveThrough)]))}</b>` : 'ถึง<b>เดือนล่าสุดที่มีผลงาน</b>ของแต่ละรายการ';
    Swal.fire({
      title: `อนุมัติ ${items.length} รายการ`, icon: 'question', showCancelButton: true,
      confirmButtonColor: '#10b981', confirmButtonText: 'อนุมัติ', cancelButtonText: 'ยกเลิก',
      html: `<div style="text-align:left;font-size:13px">อนุมัติและล็อค${thr} — เดือนหลังจากนั้นหน่วยบริการบันทึกต่อได้ทันที<br><span style="font-size:11px;color:#6b7280">รายการที่อยู่ระหว่างอุทธรณ์ ระบบจะไม่อนุมัติให้ (ใช้ "รับ/ไม่รับอุทธรณ์" ในหน้าบันทึกผลงาน)</span></div>`,
    }).then(r => {
      if (!r.isConfirmed) return;
      this.reviewBusy = true;
      Swal.fire({ title: 'กำลังอนุมัติ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.runBatches('/approve-kpi', chunk(buildApprovePayload(items, this.year, this.approveThrough), REVIEW_BATCH), (agg) => {
        this.reviewBusy = false;
        Swal.fire({
          icon: agg.errors.length ? 'warning' : 'success', title: agg.errors.length ? 'เสร็จสิ้น (มีบางชุดผิดพลาด)' : 'อนุมัติแล้ว',
          html: this.batchResultHtml(`อนุมัติ ${agg.ok} รายการ (${agg.months} เดือน)${agg.skipped ? ` · ข้าม ${agg.skipped} รายการที่ไม่มีเดือนรอตรวจ` : ''}`, agg),
        });
        this.loadSummary();
      });
    });
  }

  rejectSelected() {
    const items = this.selectedItems;
    if (!items.length || this.reviewBusy) return;
    Swal.fire({
      title: `ส่งคืนแก้ไข ${items.length} รายการ`, icon: 'warning', input: 'textarea', inputPlaceholder: 'เหตุผลการส่งคืนแก้ไข (ส่งถึงหน่วยบริการ)',
      showCancelButton: true, confirmButtonColor: '#dc2626', confirmButtonText: 'ส่งคืนแก้ไข', cancelButtonText: 'ยกเลิก',
      html: '<div style="font-size:12px;color:#6b7280">ส่งคืนเฉพาะเดือนที่ยังไม่อนุมัติ — เดือนที่อนุมัติแล้วคงล็อค</div>',
      inputValidator: (v: string) => (String(v || '').trim() ? null : 'กรุณาระบุเหตุผล'),
    }).then(r => {
      if (!r.isConfirmed) return;
      this.reviewBusy = true;
      Swal.fire({ title: 'กำลังส่งคืน...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.runBatches('/reject-kpi', chunk(buildRejectPayload(items, this.year, r.value), REVIEW_BATCH), (agg) => {
        this.reviewBusy = false;
        Swal.fire({
          icon: agg.errors.length ? 'warning' : 'success', title: agg.errors.length ? 'เสร็จสิ้น (มีบางชุดผิดพลาด)' : 'ส่งคืนแก้ไขแล้ว',
          html: this.batchResultHtml(`ส่งคืน ${items.length - agg.failed} รายการ`, agg),
        });
        this.loadSummary();
      });
    });
  }

  // ===== ปลดล็อคเดือนที่ยังไม่มีผลงาน (คู่ที่อนุมัติทั้งปีตามระบบเดิม) — super_admin =====
  checkLockedFuture() {
    const year = this.year;
    Swal.fire({ title: 'กำลังตรวจ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.apiGet('/work-center/locked-future', { year_bh: year }).subscribe({
      next: (r: any) => {
        const d = r?.data || {};
        if (!d.pairs) { Swal.fire({ icon: 'success', title: 'ไม่มีเดือนที่ล็อคค้าง', text: `ปีงบ ${year}: ทุกเดือนหลังผลงานล่าสุดเปิดบันทึกได้แล้ว` }); return; }
        const top = (d.by_indicator || []).slice(0, 8).map((t: any) => `<li>${escapeHtml(t.indicator_name)} — ${Number(t.pairs)} หน่วยบริการ</li>`).join('');
        const bm = (d.by_month || []).map((m: any) => `${escapeHtml(m.label)} ${Number(m.pairs)}`).join(' · ');
        Swal.fire({
          title: `ปลดล็อคเดือนที่ยังไม่มีผลงาน (ปีงบ ${escapeHtml(year)})`, icon: 'warning', width: 620,
          html: `<div style="text-align:left;font-size:13px">พบ <b>${Number(d.pairs)}</b> คู่ (${Number(d.indicators)} ตัวชี้วัด · ${Number(d.hospitals)} หน่วยบริการ) รวม <b>${Number(d.months)}</b> เดือน
            ที่ล็อคอยู่ ผลงานว่าง และอยู่หลังเดือนล่าสุดที่มีผลงาน (เกิดจากการอนุมัติทั้งปีแบบเดิม)
            <div style="font-size:11px;color:#6b7280;margin-top:4px">รายเดือน: ${bm}</div>
            <ul style="margin-top:6px;padding-left:18px">${top}</ul>
            <div style="font-size:11px;color:#6b7280">เดือนที่มีผลงานและเดือนว่างก่อนเดือนล่าสุดคงล็อค · ผลงานกรอกเอง (ระดับปี) ไม่แตะ</div>
            <div style="margin-top:8px">พิมพ์ปีงบ <b>${escapeHtml(year)}</b> เพื่อยืนยัน</div></div>`,
          input: 'text', inputPlaceholder: year, showCancelButton: true, confirmButtonColor: '#dc2626',
          confirmButtonText: 'ปลดล็อค', cancelButtonText: 'ยกเลิก',
          inputValidator: (v: string) => (String(v || '').trim() === String(year) ? null : `พิมพ์ ${year} ให้ตรง`),
        }).then(res => {
          if (!res.isConfirmed) return;
          Swal.fire({ title: 'กำลังปลดล็อค...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
          this.authService.apiPost('/work-center/unlock-future-months', { year_bh: year, confirm: String(res.value).trim() }).subscribe({
            next: (u: any) => { Swal.fire({ icon: 'success', title: 'ปลดล็อคแล้ว', text: u?.message || '' }); this.loadSummary(); },
            error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ปลดล็อคไม่สำเร็จ', 'error'),
          });
        });
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e?.error?.message || 'ตรวจไม่สำเร็จ', 'error'),
    });
  }
}
