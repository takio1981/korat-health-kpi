// ส่งเข้า KHD ขั้นเดียว + กติกาการส่ง + ประวัติ/ย้อนกลับ (ระยะ 3 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569) — super_admin เท่านั้น (backend ตรวจซ้ำแบบเข้ม)
// ขั้นตอน: กด "ส่งเข้า KHD (เฉพาะที่เปลี่ยน)" → ระบบตรวจ/เตรียมข้อมูล (ไม่แตะ KHD) → หน้าต่างสรุปสิ่งที่จะส่ง → ยืนยันครั้งเดียว → ผล + ย้อนกลับได้จากประวัติ
import { Component, Input, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

export const KHD_POLICY_LABEL: Record<string, string> = {
  approved_only: 'ส่งเฉพาะเดือนที่อนุมัติแล้ว (แนะนำ)',
  all: 'ส่งทุกค่าที่บันทึก (รวมที่ยังไม่อนุมัติ)',
};
const TRIGGER_TEXT: Record<string, string> = {
  manual: 'ส่งเอง', schedule: 'ตารางเวลา', quick: 'ส่งขั้นเดียว', db_compare: 'DB Compare', rollback: 'ย้อนกลับ',
};
const STATUS_TEXT: Record<string, string> = {
  running: 'กำลังส่ง', success: 'สำเร็จ', partial: 'สำเร็จบางส่วน', failed: 'ล้มเหลว',
  rolled_back: 'ย้อนกลับแล้ว', partially_rolled_back: 'ย้อนกลับบางส่วน',
};
export const triggerText = (t: string) => TRIGGER_TEXT[t] || t || '-';
export const runStatusText = (s: string) => STATUS_TEXT[s] || s || '-';

export function escapeHtml(v: any): string {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

/** ย้อนกลับได้ไหม (ปุ่มในประวัติ) — backend ตรวจ "รอบล่าสุดของทุกตาราง" ซ้ำ */
export function canRollback(run: any): boolean {
  return !!run && run.trigger_type !== 'rollback' && ['success', 'partial'].includes(run.status)
    && (Number(run.rows_updated) > 0 || Number(run.rows_inserted) > 0);
}

/** HTML สรุปสิ่งที่จะส่ง (หน้าต่างยืนยัน) — ข้อความทุกช่องผ่าน escapeHtml */
export function quickPreviewHtml(p: any): string {
  const t = p?.totals || {};
  const ready = (p?.tables || []).filter((x: any) => x.status === 'ready');
  const blocked = (p?.tables || []).filter((x: any) => x.status === 'blocked');
  const rows = ready.slice(0, 50).map((x: any) =>
    `<tr><td style="text-align:left;padding:2px 6px">${escapeHtml(x.table)}</td><td>${Number(x.insert) || 0}</td><td>${Number(x.update) || 0}</td><td>${Number(x.kept_blank) || 0}</td></tr>`).join('');
  const more = ready.length > 50 ? `<div style="font-size:11px;color:#6b7280">…และอีก ${ready.length - 50} ตาราง</div>` : '';
  const blk = blocked.length
    ? `<div style="margin-top:8px;font-size:12px;color:#b45309;text-align:left"><b>ส่งไม่ได้ ${blocked.length} ตาราง</b> (ไม่กระทบตารางอื่น): ${blocked.slice(0, 5).map((b: any) => `${escapeHtml(b.table)} — ${escapeHtml(b.reason)}`).join('; ')}${blocked.length > 5 ? ' …' : ''}</div>`
    : '';
  return `<div style="text-align:left;font-size:13px">
    <div>ปีงบประมาณ <b>${escapeHtml(p?.year_bh)}</b> · กติกา: <b>${escapeHtml(KHD_POLICY_LABEL[p?.policy] || p?.policy)}</b></div>
    <div style="margin-top:4px">เตรียมตารางส่งออกในระบบ: ตัวชี้วัดที่ข้อมูลเปลี่ยน <b>${Number(p?.export?.indicators_changed) || 0}</b> ตัว</div>
    <div style="margin-top:4px">จะส่งเข้า KHD <b>${Number(t.tables_to_send) || 0}</b> ตาราง — เพิ่มแถวใหม่ <b>${Number(t.insert) || 0}</b> · ปรับปรุง <b>${Number(t.update) || 0}</b> แถว</div>
    <div style="font-size:11px;color:#6b7280;margin-top:2px">ตารางที่ส่งครบแล้วและไม่เปลี่ยน ${Number(t.tables_up_to_date) || 0} · ค่าใน KHD ใหม่กว่า (ไม่ทับ) ${Number(t.khd_newer) || 0} แถว · ค่าว่างไม่ทับค่าใน KHD</div>
    ${ready.length ? `<table style="width:100%;margin-top:8px;font-size:12px;text-align:center;border-collapse:collapse"><thead><tr style="background:#eef2ff"><th style="text-align:left;padding:2px 6px">ตาราง</th><th>เพิ่ม</th><th>ปรับปรุง</th><th>ค่าว่างไม่ทับ</th></tr></thead><tbody>${rows}</tbody></table>${more}` : ''}
    ${blk}
    <div style="margin-top:8px;font-size:11px;color:#4338ca">ระบบบันทึกค่าก่อน-หลังทุกช่อง ย้อนกลับได้จากประวัติการส่ง</div>
  </div>`;
}

const UA_MONTH: Record<number, string> = { 10: 'ต.ค.', 11: 'พ.ย.', 12: 'ธ.ค.', 1: 'ม.ค.', 2: 'ก.พ.', 3: 'มี.ค.', 4: 'เม.ย.', 5: 'พ.ค.', 6: 'มิ.ย.', 7: 'ก.ค.', 8: 'ส.ค.', 9: 'ก.ย.' };
const UA_KIND: Record<string, string> = { pending: 'รอตรวจในระบบ', rejected: 'ส่งคืนแก้ไขในระบบ', empty: 'ระบบไม่มีผลงาน' };

/** HTML รายงาน "ค่าใน KHD ที่ระบบยังไม่อนุมัติ" (อ่านอย่างเดียว) — ข้อความทุกช่องผ่าน escapeHtml */
export function unapprovedReportHtml(d: any): string {
  const t = d?.totals || {};
  if (!Number(t.cells)) {
    return `<div style="font-size:13px">ปีงบ <b>${escapeHtml(d?.year_bh)}</b>: ไม่พบค่าใน KHD ของเดือนที่ระบบยังไม่อนุมัติ (ตรวจ ${Number(d?.tables_checked) || 0} ตาราง)${d?.partial ? ' — ตรวจไม่ครบ (หมดเวลา)' : ''}</div>`;
  }
  const rows = (d.tables || []).slice(0, 40).map((x: any) =>
    `<tr><td style="text-align:left;padding:2px 6px">${escapeHtml(x.table)}<div style="font-size:10px;color:#6b7280">${escapeHtml((x.indicator_names || []).join(', '))}</div></td><td>${Number(x.cells) || 0}</td><td>${Number(x.hospitals) || 0}</td><td>${Number(x.by_kind?.pending) || 0}</td><td>${Number(x.by_kind?.rejected) || 0}</td><td>${Number(x.by_kind?.empty) || 0}</td></tr>`).join('');
  const s0 = (d.tables || [])[0]?.sample || [];
  const sample = s0.slice(0, 5).map((c: any) => `${escapeHtml(c.hospcode)} ${escapeHtml(UA_MONTH[c.month_bh] || c.month_bh)}: KHD ${escapeHtml(c.khd_value)} / ระบบ ${escapeHtml(c.local_value ?? '-')} (${escapeHtml(UA_KIND[c.kind] || c.kind)})`).join('<br>');
  return `<div style="text-align:left;font-size:13px">
    <div>ปีงบ <b>${escapeHtml(d.year_bh)}</b>: KHD มีค่า <b>${Number(t.cells)}</b> ช่อง ใน <b>${Number(d.tables_with_unapproved) || 0}</b> ตาราง ที่ระบบยังไม่อนุมัติเดือนนั้น
      (รอตรวจ ${Number(t.pending) || 0} · ส่งคืนแก้ไข ${Number(t.rejected) || 0} · ระบบไม่มีผลงาน ${Number(t.empty) || 0} · ค่าเท่ากับในระบบ ${Number(t.same_as_local) || 0})</div>
    <div style="font-size:11px;color:#6b7280;margin-top:2px">ค่าเหล่านี้ส่งไปก่อนใช้กติกา "ส่งเฉพาะที่อนุมัติ" — ระบบไม่ล้างค่าใน KHD เอง: อนุมัติในระบบแล้วส่งใหม่ ค่าที่อนุมัติจะทับให้</div>
    <table style="width:100%;margin-top:8px;font-size:12px;text-align:center;border-collapse:collapse"><thead><tr style="background:#eef2ff"><th style="text-align:left;padding:2px 6px">ตาราง</th><th>ช่อง</th><th>หน่วยบริการ</th><th>รอตรวจ</th><th>ส่งคืน</th><th>ระบบไม่มี</th></tr></thead><tbody>${rows}</tbody></table>
    ${(d.tables || []).length > 40 ? `<div style="font-size:11px;color:#6b7280">…และอีก ${(d.tables || []).length - 40} ตาราง</div>` : ''}
    ${sample ? `<div style="font-size:11px;color:#4338ca;margin-top:6px">ตัวอย่าง (${escapeHtml(d.tables[0].table)}):<br>${sample}</div>` : ''}
    ${d.partial ? '<div style="font-size:11px;color:#b45309;margin-top:4px">ตรวจไม่ครบทุกตาราง (เกินเพดานเวลาต่อรอบ)</div>' : ''}
  </div>`;
}

@Component({
  selector: 'app-khd-quick-send',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div id="khd-quick-send" class="mb-4 p-4 rounded-2xl border border-indigo-200 bg-indigo-50">
    <div class="flex flex-wrap items-center gap-2">
      <h4 class="text-sm font-bold text-indigo-900"><i class="fas fa-paper-plane me-1"></i>ส่งเข้า KHD ขั้นเดียว</h4>
      <span class="text-xs text-indigo-700">ปีงบ {{ year }} · {{ policyLabel }}</span>
      <div class="flex-1"></div>
      <button type="button" id="btn-khd-quick-send" (click)="startQuickSend()" [disabled]="busy || !year"
              class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-md disabled:opacity-50">
        <i class="fas fa-paper-plane me-1"></i>ส่งเข้า KHD (เฉพาะที่เปลี่ยน)
      </button>
      <button type="button" id="btn-khd-unapproved" (click)="showUnapproved()" [disabled]="busy || !year" class="px-3 py-2 rounded-xl bg-white border border-indigo-200 text-indigo-700 text-xs font-bold hover:bg-indigo-100 disabled:opacity-50" title="อ่าน KHD อย่างเดียว: ค่าที่ส่งไปก่อนแล้วแต่ระบบยังไม่อนุมัติเดือนนั้น">
        <i class="fas fa-magnifying-glass me-1"></i>ค่าใน KHD ที่ยังไม่อนุมัติ
      </button>
      <button type="button" (click)="toggleHistory()" class="px-3 py-2 rounded-xl bg-white border border-indigo-200 text-indigo-700 text-xs font-bold hover:bg-indigo-100">
        <i class="fas fa-clock-rotate-left me-1"></i>ประวัติการส่ง
      </button>
      <button type="button" (click)="showSettings = !showSettings" class="px-3 py-2 rounded-xl bg-white border border-indigo-200 text-indigo-700 text-xs font-bold hover:bg-indigo-100">
        <i class="fas fa-sliders me-1"></i>ตั้งค่า
      </button>
    </div>
    <p class="text-[11px] text-indigo-700 mt-1">ตรวจการเปลี่ยนแปลง → เตรียมตารางส่งออก → แสดงสิ่งที่จะส่ง → ยืนยันครั้งเดียว · ครั้งละงานเดียว · ค่าว่างไม่ทับ KHD · ไม่ลบ/ไม่สร้างตารางใน KHD</p>

    <div *ngIf="showSettings && s" id="khd-sync-settings" class="mt-3 p-3 rounded-xl bg-white border border-indigo-100 text-sm space-y-3">
      <div>
        <div class="text-xs font-bold text-gray-700 mb-1">กติกาการส่งข้อมูลเข้า KHD</div>
        <label *ngFor="let p of policies" class="flex items-center gap-2 text-xs text-gray-700 mb-1">
          <input type="radio" name="khdPolicy" [value]="p" [(ngModel)]="s.khd_send_policy"> {{ policyText(p) }}
        </label>
        <div class="text-[11px] text-gray-500">"เฉพาะที่อนุมัติ": เดือนที่ยังไม่อนุมัติเป็นค่าว่างในตารางส่งออก → ไม่ทับค่าเดิมใน KHD, KHD ได้ค่าใหม่เมื่ออนุมัติแล้ว</div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
        <label>แถวต่อชุด <input type="number" min="10" max="500" [(ngModel)]="s.khd_sync_batch_size" name="kBatch" class="mt-1 w-full px-2 py-1 border border-gray-200 rounded-lg bg-white"></label>
        <label>พักระหว่างชุด (ms) <input type="number" min="0" max="5000" [(ngModel)]="s.khd_sync_pause_ms" name="kPause" class="mt-1 w-full px-2 py-1 border border-gray-200 rounded-lg bg-white"></label>
        <label>เพดานแถวต่อรอบ <input type="number" min="100" max="500000" [(ngModel)]="s.khd_sync_max_rows" name="kRows" class="mt-1 w-full px-2 py-1 border border-gray-200 rounded-lg bg-white"></label>
        <label>เพดานเวลาต่อรอบ (วินาที) <input type="number" min="30" max="3600" [(ngModel)]="s.khd_sync_max_seconds" name="kSec" class="mt-1 w-full px-2 py-1 border border-gray-200 rounded-lg bg-white"></label>
        <label>รอ KHD ตอบต่อคำสั่ง (ms) <input type="number" min="5000" max="120000" [(ngModel)]="s.khd_query_timeout_ms" name="kTo" class="mt-1 w-full px-2 py-1 border border-gray-200 rounded-lg bg-white"></label>
        <label>เก็บบันทึกค่าก่อน-หลัง (วัน) <input type="number" min="7" max="3650" [(ngModel)]="s.khd_sync_audit_keep_days" name="kKeep" class="mt-1 w-full px-2 py-1 border border-gray-200 rounded-lg bg-white"></label>
      </div>
      <button type="button" id="btn-khd-settings-save" (click)="saveSettings()" [disabled]="busy" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึกการตั้งค่า</button>
    </div>

    <div *ngIf="showHistory" id="khd-sync-history" class="mt-3 bg-white rounded-xl border border-indigo-100 overflow-auto card-scroll" style="max-height: 320px">
      <table class="w-full text-xs">
        <thead class="bg-indigo-100 text-indigo-900 sticky top-0 z-20"><tr>
          <th class="px-2 py-1 text-left">รอบ</th><th class="px-2 py-1 text-left">เวลา</th><th class="px-2 py-1">ที่มา</th><th class="px-2 py-1">ปีงบ</th>
          <th class="px-2 py-1">ตาราง</th><th class="px-2 py-1">เพิ่ม</th><th class="px-2 py-1">ปรับปรุง</th><th class="px-2 py-1">สถานะ</th><th class="px-2 py-1"></th>
        </tr></thead>
        <tbody>
          <tr *ngFor="let r of runs" class="border-t border-gray-100">
            <td class="px-2 py-1">#{{ r.id }}<span *ngIf="r.rollback_of" class="text-gray-400"> (ของ #{{ r.rollback_of }})</span></td>
            <td class="px-2 py-1 whitespace-nowrap">{{ r.started_at | date:'d MMM yy HH:mm' }}</td>
            <td class="px-2 py-1 text-center">{{ trigger(r.trigger_type) }}<div class="text-gray-400">{{ r.username }}</div></td>
            <td class="px-2 py-1 text-center">{{ r.year_bh || '-' }}</td>
            <td class="px-2 py-1 text-center">{{ r.tables_success }}/{{ r.tables_total }}</td>
            <td class="px-2 py-1 text-center">{{ r.rows_inserted }}</td>
            <td class="px-2 py-1 text-center">{{ r.rows_updated }}</td>
            <td class="px-2 py-1 text-center" [title]="r.error_msg || ''">{{ status(r.status) }}</td>
            <td class="px-2 py-1 text-center">
              <button *ngIf="rollbackable(r)" type="button" (click)="rollback(r)" class="px-2 py-1 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 font-bold"><i class="fas fa-rotate-left me-1"></i>ย้อนกลับ</button>
            </td>
          </tr>
          <tr *ngIf="!runs.length"><td colspan="9" class="px-2 py-3 text-center text-gray-400">ยังไม่มีประวัติการส่ง</td></tr>
        </tbody>
      </table>
    </div>
  </div>`,
})
export class KhdQuickSendComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);
  @Input() year = '';
  s: any = null;
  policies = ['approved_only', 'all'];
  showSettings = false;
  showHistory = false;
  runs: any[] = [];
  busy = false;
  readonly trigger = triggerText;
  readonly status = runStatusText;
  readonly rollbackable = canRollback;

  get policyLabel(): string { return this.s ? (KHD_POLICY_LABEL[this.s.khd_send_policy] || this.s.khd_send_policy) : ''; }
  policyText(p: string) { return KHD_POLICY_LABEL[p] || p; }

  ngOnInit() { this.loadSettings(); }

  loadSettings() {
    this.authService.apiGet('/khd-sync/settings').subscribe({
      next: (r: any) => { if (r?.success) { this.s = { ...r.data }; if (Array.isArray(r.policies)) this.policies = r.policies; } this.cdr.detectChanges(); },
      error: () => { this.cdr.detectChanges(); },
    });
  }

  saveSettings() {
    if (!this.s) return;
    this.busy = true;
    this.authService.apiPut('/khd-sync/settings', this.s).subscribe({
      next: (r: any) => {
        this.busy = false;
        if (r?.success) { this.s = { ...r.data }; Swal.fire({ icon: 'success', title: 'สำเร็จ', text: r.message, timer: 2000, showConfirmButton: false }); }
        this.cdr.detectChanges();
      },
      error: (e: any) => { this.busy = false; Swal.fire('ผิดพลาด', e.error?.message || 'บันทึกไม่สำเร็จ', 'error'); this.cdr.detectChanges(); },
    });
  }

  toggleHistory() {
    this.showHistory = !this.showHistory;
    if (this.showHistory) this.loadRuns();
  }

  loadRuns() {
    this.authService.apiGet('/khd-sync/runs', { limit: 30 }).subscribe({
      next: (r: any) => { this.runs = r?.data || []; this.cdr.detectChanges(); },
      error: () => { this.runs = []; this.cdr.detectChanges(); },
    });
  }

  startQuickSend() {
    if (this.busy || !this.year) return;
    this.busy = true;
    Swal.fire({ title: 'กำลังตรวจสอบสิ่งที่จะส่ง...', html: 'ตรวจการเปลี่ยนแปลงและเตรียมตารางส่งออกในระบบ (ยังไม่แตะ KHD)', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.apiPost('/khd-sync/quick', { year_bh: this.year, dry_run: true }).subscribe({
      next: (p: any) => this.confirmSend(p),
      error: (e: any) => this.fail(e),
    });
  }

  private confirmSend(p: any) {
    if (!p?.plan_token) {
      this.busy = false;
      Swal.fire({ icon: 'info', title: 'ไม่มีข้อมูลที่ต้องส่ง', html: quickPreviewHtml(p) });
      this.cdr.detectChanges();
      return;
    }
    Swal.fire({
      title: 'ยืนยันส่งเข้า KHD', html: quickPreviewHtml(p), icon: 'question', width: 640,
      showCancelButton: true, confirmButtonColor: '#4f46e5', confirmButtonText: 'ส่งเข้า KHD', cancelButtonText: 'ยกเลิก',
    }).then(r => {
      if (!r.isConfirmed) { this.busy = false; this.cdr.detectChanges(); return; }
      Swal.fire({ title: 'กำลังส่งเข้า KHD...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.apiPost('/khd-sync/quick', { year_bh: this.year, dry_run: false, plan_token: p.plan_token }).subscribe({
        next: (res: any) => this.done(res),
        error: (e: any) => {
          if (e.status === 409 && e.error?.code === 'PLAN_CHANGED' && e.error?.preview) {
            Swal.fire({ icon: 'warning', title: 'ข้อมูลเปลี่ยนไปหลังตรวจสอบ', text: 'กรุณาตรวจสิ่งที่จะส่งอีกครั้ง', timer: 2500, showConfirmButton: false })
              .then(() => this.confirmSend(e.error.preview));
            return;
          }
          this.fail(e);
        },
      });
    });
  }

  private done(res: any) {
    this.busy = false;
    const s = res?.summary || {};
    const ok = res?.success !== false;
    Swal.fire({
      icon: ok ? 'success' : 'warning', title: ok ? 'ส่งเข้า KHD แล้ว' : 'ส่งได้บางส่วน',
      html: `${escapeHtml(res?.message || '')}<br><small>รอบ #${escapeHtml(res?.run_id ?? '-')} · เพิ่ม ${Number(s.inserted) || 0} · ปรับปรุง ${Number(s.updated) || 0} แถว — ย้อนกลับได้จาก "ประวัติการส่ง"</small>`,
    });
    if (this.showHistory) this.loadRuns();
    this.cdr.detectChanges();
  }

  private fail(e: any) {
    this.busy = false;
    const msg = e?.error?.code === 'KHD_SYNC_BUSY' ? 'มีงานส่งข้อมูลเข้า KHD กำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' : (e?.error?.message || 'ส่งไม่สำเร็จ');
    Swal.fire('ผิดพลาด', msg, 'error');
    this.cdr.detectChanges();
  }

  rollback(run: any) {
    Swal.fire({
      title: `ย้อนกลับรอบ #${run.id}`, icon: 'warning',
      html: `<div style="text-align:left;font-size:13px">คืนค่าเดิมใน KHD เฉพาะช่องที่ยังเป็นค่าที่ระบบเขียน (มีผู้แก้ต่อ = ข้าม) · แถวที่เพิ่มใหม่ไม่ลบ<br>พิมพ์เลขรอบ <b>${Number(run.id)}</b> เพื่อยืนยัน</div>`,
      input: 'text', inputPlaceholder: String(run.id), showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: 'ย้อนกลับ', cancelButtonText: 'ยกเลิก',
      inputValidator: (v: string) => (String(v).trim() === String(run.id) ? null : `พิมพ์ ${run.id} ให้ตรง`),
    }).then(r => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังย้อนกลับ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.apiPost(`/khd-sync/runs/${run.id}/rollback`, { confirm: String(run.id) }).subscribe({
        next: (res: any) => {
          const d = res?.data || {};
          Swal.fire({ icon: d.status === 'rolled_back' ? 'success' : 'warning', title: runStatusText(d.status),
            html: `คืนค่า ${Number(d.reverted_rows) || 0} แถว · ข้าม (มีผู้แก้ต่อ) ${Number(d.skipped_changed) || 0} · แถวที่เพิ่มคงไว้ ${Number(d.kept_inserts) || 0}` });
          this.loadRuns();
        },
        error: (e: any) => Swal.fire('ย้อนกลับไม่ได้', e.error?.message || 'เกิดข้อผิดพลาด', 'error'),
      });
    });
  }

  /** รายงานอ่านอย่างเดียว: ค่าใน KHD ของเดือนที่ระบบยังไม่อนุมัติ */
  showUnapproved(refresh = false) {
    if (this.busy || !this.year) return;
    this.busy = true;
    Swal.fire({ title: 'กำลังอ่านข้อมูลจาก KHD...', html: 'อ่านอย่างเดียว ทีละตาราง (ไม่เขียน KHD)', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.apiPost('/khd-sync/unapproved-report', { year_bh: this.year, refresh }).subscribe({
      next: (r: any) => {
        this.busy = false;
        const d = r?.data || {};
        Swal.fire({
          title: 'ค่าใน KHD ที่ระบบยังไม่อนุมัติ', html: unapprovedReportHtml(d), width: 720, icon: Number(d?.totals?.cells) ? 'info' : 'success',
          showDenyButton: !!r?.data?.cached, denyButtonText: 'ตรวจใหม่', denyButtonColor: '#4f46e5', confirmButtonText: 'ปิด',
          footer: r?.data?.cached ? 'ผลที่ตรวจไว้ไม่เกิน 10 นาที' : '',
        }).then(x => { if (x.isDenied) this.showUnapproved(true); });
        this.cdr.detectChanges();
      },
      error: (e: any) => this.fail(e),
    });
  }
}
