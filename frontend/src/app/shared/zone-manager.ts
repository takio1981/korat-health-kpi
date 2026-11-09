// แท็บ "โซน" ในหน้าจัดการตัวชี้วัด (9 พ.ย. 2569) — ตั้งชื่อโซน, เพิ่มโซน (รหัส 1–99 อัตโนมัติ), ย้ายอำเภอไปโซนอื่น
// ย้ายอำเภอ = backend ตั้งโซนให้หน่วยบริการทุกแห่งในอำเภอ (PUT /zones/districts) — ตัวกรองโซนทุกหน้าเห็นผลทันที
// สิทธิ์: เพิ่ม = canAdd, แก้ชื่อ/ย้ายอำเภอ = canEdit (requireAction kpi-manage), ลบโซน = super_admin เท่านั้น (เฉพาะโซนว่าง)
import { Component, Input, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import { HospitalZoneService } from './zone-badge';
import { zoneLabel, inZone } from './zone';
import Swal from 'sweetalert2';

export interface ZoneRow { code: string; name: string; sort_order?: number; district_count: number; hospital_count: number; _name?: string; }
export interface DistrictZoneRow { distid: string; distname: string; zone: string; hospital_count: number; mismatch_count: number; hospital_zones: Record<string, number>; _zone?: string; }

/** รายการอำเภอที่เปลี่ยนโซน (เทียบค่าที่เลือกกับค่าเดิม) */
export function districtZoneChanges(rows: DistrictZoneRow[]): { distid: string; zone: string; from: string; distname: string; hospitals: number }[] {
  return (rows || []).filter(r => r._zone && r._zone !== r.zone)
    .map(r => ({ distid: r.distid, zone: String(r._zone), from: r.zone, distname: r.distname, hospitals: r.hospital_count }));
}

@Component({
  selector: 'app-zone-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
  <div id="zone-manager" class="space-y-6">
    <div *ngIf="loadError" class="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{{ loadError }}</div>

    <!-- โซน -->
    <section>
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 class="text-base font-bold text-gray-800"><i class="fas fa-layer-group text-violet-600 me-1"></i>โซน ({{ zones.length }})</h3>
        <button *ngIf="canAdd" type="button" id="btn-zone-add" (click)="addZone()" [disabled]="busy"
          class="px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold shadow-md disabled:opacity-50"><i class="fas fa-plus me-1"></i>เพิ่มโซน</button>
      </div>
      <p class="text-xs text-gray-500 mb-2">ชื่อโซนแสดงในตัวกรองโซนทุกหน้า (เช่น "โซน 1 · เมือง") — รหัสโซนเป็นตัวเลขที่ระบบสร้างให้ ลบได้เฉพาะโซนที่ไม่มีอำเภอ/หน่วยบริการ</p>
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-600">
            <tr><th class="px-3 py-2 text-left w-20">รหัส</th><th class="px-3 py-2 text-left">ชื่อโซน</th><th class="px-3 py-2 text-right w-24">อำเภอ</th><th class="px-3 py-2 text-right w-28">หน่วยบริการ</th><th class="px-3 py-2 w-40"></th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let z of zones" class="border-t border-gray-100">
              <td class="px-3 py-2 font-bold text-violet-700">โซน {{ z.code }}</td>
              <td class="px-3 py-2">
                <input *ngIf="canEdit" [(ngModel)]="z._name" [name]="'zname' + z.code" maxlength="100" placeholder="(ไม่มีชื่อ)"
                  class="w-full px-3 py-1.5 border border-gray-200 rounded-lg bg-white text-sm" [attr.data-zone]="z.code">
                <span *ngIf="!canEdit">{{ z.name || '-' }}</span>
              </td>
              <td class="px-3 py-2 text-right">{{ z.district_count }}</td>
              <td class="px-3 py-2 text-right">{{ z.hospital_count }}</td>
              <td class="px-3 py-2 text-right whitespace-nowrap">
                <button *ngIf="canEdit && (z._name || '') !== (z.name || '')" type="button" (click)="saveName(z)" [disabled]="busy"
                  class="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึกชื่อ</button>
                <button *ngIf="isSuperAdmin && !z.district_count && !z.hospital_count" type="button" (click)="deleteZone(z)" [disabled]="busy"
                  class="ms-1 px-3 py-1 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-bold disabled:opacity-50"><i class="fas fa-trash me-1"></i>ลบ</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- อำเภอ -->
    <section>
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 class="text-base font-bold text-gray-800"><i class="fas fa-map-location-dot text-teal-600 me-1"></i>โซนของแต่ละอำเภอ ({{ districts.length }} อำเภอ)</h3>
        <div class="flex flex-wrap items-center gap-2">
          <select [(ngModel)]="filterZone" name="zmFilter" class="px-3 py-2 border border-gray-200 rounded-xl bg-white text-sm">
            <option value="">ทุกโซน</option>
            <option *ngFor="let z of zones" [value]="z.code">{{ label(z.code) }}</option>
          </select>
          <button *ngIf="canEdit" type="button" id="btn-zone-save-districts" (click)="saveDistricts()" [disabled]="busy || !changes.length"
            class="px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-xs font-bold shadow-md disabled:opacity-50"><i class="fas fa-save me-1"></i>บันทึกการย้ายโซน ({{ changes.length }})</button>
        </div>
      </div>
      <p class="text-xs text-gray-500 mb-2">ย้ายอำเภอไปโซนอื่น = หน่วยบริการ<b>ทุกแห่ง</b>ในอำเภอนั้นเปลี่ยนโซนตาม (รวมแห่งที่เคยแก้โซนเองในแท็บหน่วยบริการ) และหน่วยบริการที่เพิ่มใหม่ในอำเภอได้โซนนี้</p>
      <div class="overflow-auto card-scroll" style="max-height: calc(100vh - 420px); min-height: 240px;">
        <table class="min-w-full text-sm">
          <thead class="bg-gray-50 text-xs text-gray-600 sticky top-0 z-10">
            <tr><th class="px-3 py-2 text-left">อำเภอ</th><th class="px-3 py-2 text-left w-64">โซน</th><th class="px-3 py-2 text-right w-28">หน่วยบริการ</th><th class="px-3 py-2 text-left">หมายเหตุ</th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let d of visibleDistricts; trackBy: trackDist" class="border-t border-gray-100" [ngClass]="{ 'bg-amber-50': d._zone !== d.zone }">
              <td class="px-3 py-2">{{ d.distname }} <span class="text-[10px] text-gray-400 font-mono">{{ d.distid }}</span></td>
              <td class="px-3 py-2">
                <select *ngIf="canEdit" [(ngModel)]="d._zone" [name]="'dz' + d.distid" [attr.data-distid]="d.distid" class="w-full px-3 py-1.5 border border-gray-200 rounded-lg bg-white text-sm">
                  <option *ngIf="!d.zone" value="">(ยังไม่กำหนด)</option>
                  <option *ngFor="let z of zones" [value]="z.code">{{ label(z.code) }}</option>
                </select>
                <span *ngIf="!canEdit">{{ label(d.zone) }}</span>
              </td>
              <td class="px-3 py-2 text-right">{{ d.hospital_count }}</td>
              <td class="px-3 py-2 text-xs">
                <span *ngIf="d._zone !== d.zone" class="text-amber-700 font-bold">{{ label(d.zone) }} → {{ label(d._zone) }}</span>
                <span *ngIf="d.mismatch_count > 0 && d._zone === d.zone" class="text-red-600" [title]="mismatchTitle(d)">
                  <i class="fas fa-triangle-exclamation me-1"></i>มีหน่วยบริการอยู่โซนอื่น {{ d.mismatch_count }} แห่ง</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>`,
})
export class ZoneManagerComponent implements OnInit {
  private authService = inject(AuthService);
  private zoneSvc = inject(HospitalZoneService);
  private cdr = inject(ChangeDetectorRef);
  @Input() canAdd = false;
  @Input() canEdit = false;
  @Input() isSuperAdmin = false;
  zones: ZoneRow[] = [];
  districts: DistrictZoneRow[] = [];
  filterZone = '';
  busy = false;
  loadError = '';

  get changes() { return districtZoneChanges(this.districts); }
  get visibleDistricts(): DistrictZoneRow[] { return this.filterZone ? this.districts.filter(d => inZone({ zone: d._zone }, this.filterZone)) : this.districts; }
  label(code: any) { return zoneLabel(code); }
  trackDist = (_: number, d: DistrictZoneRow) => d.distid;
  mismatchTitle(d: DistrictZoneRow) {
    return Object.entries(d.hospital_zones).filter(([z]) => z !== d.zone).map(([z, n]) => `${z ? zoneLabel(z) : 'ไม่ระบุโซน'}: ${n} แห่ง`).join(', ');
  }

  ngOnInit() { this.load(); }

  load() {
    this.authService.apiGet('/zones').subscribe({
      next: (res: any) => {
        this.zones = (res?.data || []).map((z: ZoneRow) => ({ ...z, _name: z.name || '' }));
        this.zoneSvc.applyZoneNames(this.zones);
        this.cdr.detectChanges();
      },
      error: (err: any) => { this.loadError = err.error?.message || 'โหลดรายการโซนไม่สำเร็จ'; this.cdr.detectChanges(); },
    });
    if (!this.canEdit) return;
    this.authService.apiGet('/zones/districts').subscribe({
      next: (res: any) => { this.districts = (res?.data || []).map((d: DistrictZoneRow) => ({ ...d, _zone: d.zone })); this.cdr.detectChanges(); },
      error: (err: any) => { this.loadError = err.error?.message || 'โหลดโซนของอำเภอไม่สำเร็จ'; this.cdr.detectChanges(); },
    });
  }

  private done(res: any) {
    this.busy = false;
    Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res?.message || 'บันทึกเรียบร้อย', timer: 2000, showConfirmButton: false });
    this.zoneSvc.reload();
    this.load();
  }
  private fail(err: any) { this.busy = false; Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error'); this.cdr.detectChanges(); }

  addZone() {
    Swal.fire({
      title: 'เพิ่มโซน', input: 'text', inputLabel: 'ชื่อโซน (ไม่บังคับ)', inputAttributes: { maxlength: '100' },
      showCancelButton: true, confirmButtonColor: '#7c3aed', confirmButtonText: 'เพิ่ม', cancelButtonText: 'ยกเลิก',
    }).then(r => {
      if (!r.isConfirmed) return;
      this.busy = true;
      this.authService.apiPost('/zones', { name: String(r.value || '').trim() }).subscribe({ next: (res: any) => this.done(res), error: (e: any) => this.fail(e) });
    });
  }

  saveName(z: ZoneRow) {
    this.busy = true;
    this.authService.apiPut('/zones/' + z.code, { name: String(z._name || '').trim() }).subscribe({ next: (res: any) => this.done(res), error: (e: any) => this.fail(e) });
  }

  deleteZone(z: ZoneRow) {
    Swal.fire({ title: `ลบ${zoneLabel(z.code)}?`, icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626', confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก' })
      .then(r => {
        if (!r.isConfirmed) return;
        this.busy = true;
        this.authService.apiDelete('/zones/' + z.code).subscribe({ next: (res: any) => this.done(res), error: (e: any) => this.fail(e) });
      });
  }

  /** ข้อความหน้ายืนยันการย้ายโซน (escape ชื่อ — มาจากฐานข้อมูล) */
  confirmHtml(): string {
    const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
    const ch = this.changes;
    const total = ch.reduce((a, c) => a + c.hospitals, 0);
    return `<div style="text-align:left;font-size:13px"><p>หน่วยบริการ <b>${total}</b> แห่งจะเปลี่ยนโซนตามอำเภอ:</p><ul style="margin-top:6px;padding-left:18px">`
      + ch.map(c => `<li>อ.${esc(c.distname)}: ${esc(c.from ? zoneLabel(c.from) : 'ไม่ระบุโซน')} → <b>${esc(zoneLabel(c.zone))}</b> (${c.hospitals} แห่ง)</li>`).join('')
      + '</ul></div>';
  }

  saveDistricts() {
    const ch = this.changes;
    if (!ch.length) return;
    Swal.fire({ title: `ย้ายโซน ${ch.length} อำเภอ?`, html: this.confirmHtml(), icon: 'question', showCancelButton: true,
      confirmButtonColor: '#10b981', confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก' }).then(r => {
      if (!r.isConfirmed) return;
      this.busy = true;
      this.authService.apiPut('/zones/districts', { changes: ch.map(c => ({ distid: c.distid, zone: c.zone })) })
        .subscribe({ next: (res: any) => this.done(res), error: (e: any) => this.fail(e) });
    });
  }
}
