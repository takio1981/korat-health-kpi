/**
 * แถบสีคุณสมบัติของตัวชี้วัด (20 พ.ย. 2569 — ผู้ใช้สั่ง: หน้ารายงานสถิติแสดงแถบสีแบบเดียวกับหน้าบันทึกผลงาน/จัดการตัวชี้วัด ครบทุกตัวชี้วัด)
 * สีและข้อความเดียวกับ dashboard (getIndicatorTypes, getIndicatorOffTypeBadge, getCumulativeBadge, quarterBadgeText, getSourceBadge)
 * และ kpi-manage (getFiscalYearBadge) — `<app-indicator-badges [id]="row.indicator_id">` อ่านคุณสมบัติจาก GET /indicators ครั้งเดียวต่อการเข้าใช้
 * (IndicatorMetaService แคชร่วมทุกแถว) ไม่ต้องแก้ SQL ของรายงานแต่ละเส้นทาง — ขอบเขตตัวชี้วัดตามสิทธิ์เดียวกับรายงาน
 */
import { ChangeDetectorRef, Component, Injectable, Input, OnChanges, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BehaviorSubject, Subscription, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AuthService } from '../services/auth';
import { normalizeQuarterMode } from './kpi-formula';

export interface IndicatorBadge { key: string; label: string; title: string; color: string; icon?: string; }

const parseCodes = (raw: any): string[] => {
  try {
    if (Array.isArray(raw)) return raw.map(String);
    if (raw) { const p = JSON.parse(String(raw)); if (Array.isArray(p)) return p.map(String); }
  } catch { /* ข้อมูลเสีย = ไม่มีรายการ */ }
  return [];
};
const flag = (v: any) => v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '0';

/** แถบสีของตัวชี้วัด (ฟังก์ชันล้วน — ทดสอบได้) — hostypeName = ชื่อประเภทหน่วยบริการจากรหัส */
export function indicatorBadges(ind: any, hostypeName: (code: string) => string = c => c, opts: { formula?: boolean } = {}): IndicatorBadge[] {
  if (!ind) return [];
  const out: IndicatorBadge[] = [];
  // ประเภทตัวชี้วัด
  const types: [string, string, string, string][] = [
    ['r9', 'R9', 'bg-blue-100 text-blue-700', 'R9 เขต 9'], ['moph', 'MOPH', 'bg-red-100 text-red-700', 'MOPH กระทรวง'],
    ['ssj', 'SSJ', 'bg-green-100 text-green-700', 'SSJ สสจ.'], ['rmw', 'RMW', 'bg-yellow-100 text-yellow-700', 'RMW ผู้ว่าฯ'],
    ['other', 'อื่นๆ', 'bg-gray-100 text-gray-700', 'อื่น ๆ'],
  ];
  for (const [k, label, color, title] of types) if (flag(ind[k])) out.push({ key: 'type-' + k, label, color, title: 'ประเภทตัวชี้วัด: ' + title });
  // ตัวชี้วัดของ (ประเภทหน่วยบริการที่ต้องรายงาน)
  if (ind.evaluation_mode === 'all_required') {
    out.push({ key: 'off', label: 'ทุกประเภท', title: 'ตัวชี้วัดของ: ทุกประเภทหน่วยบริการ', color: 'bg-purple-100 text-purple-700 border border-purple-200', icon: 'fa-hospital' });
  } else if (ind.evaluation_mode === 'any_one') {
    const codes = parseCodes(ind.required_off_types);
    if (codes.length) {
      const names = codes.map(hostypeName);
      out.push({ key: 'off', label: codes.length <= 2 ? names.join(', ') : `${codes.length} ประเภท`, title: `ตัวชี้วัดของ: ${names.join(', ')}`,
        color: 'bg-cyan-100 text-cyan-700 border border-cyan-200', icon: 'fa-hospital' });
    }
  }
  // หน่วยนับ
  if (ind.unit && String(ind.unit).trim()) out.push({ key: 'unit', label: 'หน่วย: ' + ind.unit, title: 'หน่วยนับผลงาน', color: 'bg-stone-100 text-stone-700 border border-stone-200', icon: 'fa-ruler' });
  // วิธีคิดผลงาน
  const formula = ind.result_formula && String(ind.result_formula).trim();
  if (formula) {
    if (opts.formula) out.push({ key: 'calc', label: 'สูตร', title: 'ผลงานคำนวณตามสูตร: ' + formula, color: 'bg-fuchsia-100 text-fuchsia-700 border border-fuchsia-200', icon: 'fa-calculator' });
  } else if (Number(ind.result_manual) === 1 || Number(ind.pct_manual) === 1) {
    const what = [Number(ind.result_manual) === 1 ? 'ผลงานล่าสุด' : '', Number(ind.pct_manual) === 1 ? 'ร้อยละ' : ''].filter(Boolean).join(' และ ');
    out.push({ key: 'calc', label: 'กรอกเอง', title: `${what}กรอกเอง ไม่คำนวณจากผลงานรายเดือน`, color: 'bg-teal-100 text-teal-700 border border-teal-200', icon: 'fa-pen-to-square' });
  } else if (Number(ind.is_cumulative) === 1) {
    out.push({ key: 'calc', label: 'สะสม', title: 'ผลงานเดือนล่าสุด = ผลรวมสะสมตั้งแต่ตุลาคมถึงเดือนนี้', color: 'bg-violet-100 text-violet-700 border border-violet-200', icon: 'fa-layer-group' });
  }
  // รอบการวัดผล
  const q = normalizeQuarterMode(ind.quarter_mode);
  if (q) out.push({ key: 'quarter', label: q === 'quarter' ? 'รายไตรมาส' : 'ไตรมาส (บันทึกรายเดือน)', title: 'วัดผลรายไตรมาส', color: 'bg-sky-100 text-sky-700 border border-sky-200', icon: 'fa-calendar-week' });
  if (ind.target_monthly === 'latest' || ind.target_monthly === 'cumulative') {
    out.push({ key: 'tmonth', label: ind.target_monthly === 'cumulative' ? 'เป้ารายเดือน (สะสม)' : 'เป้ารายเดือน', title: 'เป้าหมายกำหนดรายเดือน',
      color: 'bg-emerald-100 text-emerald-700 border border-emerald-200', icon: 'fa-bullseye' });
  }
  // แหล่งที่มาข้อมูล (ทุกตัวชี้วัดมีเสมอ)
  if (ind.khd_report_id && ind.data_source === 'hdc') out.push({ key: 'src', label: 'hdc', title: 'ข้อมูลจาก HDC (ดึงอัตโนมัติ)', color: 'bg-indigo-100 text-indigo-700 border border-indigo-200', icon: 'fa-server' });
  else if (ind.khd_report_id && ind.data_source === 'excel') out.push({ key: 'src', label: 'key_in', title: 'คีย์ข้อมูลเอง (key_in)', color: 'bg-sky-100 text-sky-700 border border-sky-200', icon: 'fa-keyboard' });
  else out.push({ key: 'src', label: 'local-only', title: 'ไม่พบเทียบเคียงกับ KHD (local-only)', color: 'bg-gray-100 text-gray-500 border border-gray-200', icon: 'fa-desktop' });
  // ปีงบประมาณของตัวชี้วัด
  const years = String(ind.khd_fiscal_year || '').split(',').map(s => s.trim()).filter(s => /^\d{4}$/.test(s));
  if (years.length) out.push({ key: 'fy', label: 'ปีงบ ' + years.join(', '), title: 'ปีงบประมาณ: ' + years.join(', '), color: 'bg-teal-50 text-teal-700 border border-teal-200', icon: 'fa-calendar-alt' });
  return out;
}

/**
 * แถวรายงาน → ใส่คอลัมน์ table_process ต่อจากชื่อตัวชี้วัด (ไฟล์ Excel ของรายงานสถิติ — 26 พ.ย. 2569)
 * ค่าจากแถว (table_process) ก่อน แล้วจึงจากคุณสมบัติตัวชี้วัด (lookup ด้วย indicator_id ?? id) | แถวที่ไม่มีชื่อตัวชี้วัด = คงเดิม
 */
export function withTableProcess(rows: any[], lookup: (id: number) => any): any[] {
  return (rows || []).map(r => {
    if (!r || typeof r !== 'object' || !('kpi_indicators_name' in r)) return r;
    const id = Number(r.indicator_id ?? r.id);
    const tp = r.table_process ?? (Number.isFinite(id) ? lookup(id)?.table_process : null) ?? '';
    const out: any = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === 'table_process') continue;
      out[k] = v;
      if (k === 'kpi_indicators_name') out.table_process = tp;
    }
    return out;
  });
}

/** คุณสมบัติตัวชี้วัด (GET /indicators) + ชื่อประเภทหน่วยบริการ — โหลดครั้งเดียวแล้วแชร์ทุกแถบสี */
@Injectable({ providedIn: 'root' })
export class IndicatorMetaService {
  private auth = inject(AuthService);
  readonly meta$ = new BehaviorSubject<{ byId: Map<number, any>; hostype: Map<string, string> } | null>(null);
  private loading = false;

  ensure() {
    if (this.meta$.value || this.loading) return;
    this.loading = true;
    forkJoin({
      ind: this.auth.getIndicators().pipe(catchError(() => of(null))),
      ht: this.auth.getHosTypes().pipe(catchError(() => of(null))),
    }).subscribe(({ ind, ht }) => {
      this.loading = false;
      const rows: any[] = Array.isArray(ind) ? ind : (ind?.data || []);
      const hts: any[] = Array.isArray(ht) ? ht : (ht?.data || []);
      this.meta$.next({
        byId: new Map(rows.map(r => [Number(r.id), r])),
        hostype: new Map(hts.map(h => [String(h.hostypecode), String(h.hostypename)])),
      });
    });
  }
  /** โหลดใหม่ครั้งถัดไป (เช่น หลังแก้ตัวชี้วัด) */
  invalidate() { this.meta$.next(null); }
}

@Component({
  selector: 'app-indicator-badges',
  standalone: true,
  imports: [CommonModule],
  // table_process ใต้ชื่อตัวชี้วัด (26 พ.ย. 2569 — ผู้ใช้สั่ง: ทุกเมนูของหน้ารายงานสถิติ) — [tp]="false" = ไม่แสดง
  template: `<span class="inline-flex flex-wrap items-center gap-1 align-middle" *ngIf="badges.length || tableProcess">
    <span *ngIf="tableProcess" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold whitespace-nowrap leading-none bg-slate-100 text-slate-600 border border-slate-200"
          title="table_process (ชื่อตารางส่งออก)" data-badge="tp"><i class="fas fa-table text-[8px]"></i>{{ tableProcess }}</span>
    <span *ngFor="let b of badges; trackBy: track" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold whitespace-nowrap leading-none"
          [ngClass]="b.color" [title]="b.title" [attr.data-badge]="b.key"><i *ngIf="b.icon" class="fas text-[8px]" [ngClass]="b.icon"></i>{{ b.label }}</span>
  </span>`,
})
export class IndicatorBadgesComponent implements OnInit, OnChanges, OnDestroy {
  /** id ตัวชี้วัด (อ่านคุณสมบัติจาก IndicatorMetaService) */
  @Input() id: any = null;
  /** แถวที่มีคุณสมบัติอยู่แล้ว (ไม่ต้องรอโหลด) — ใช้แทน id ได้ */
  @Input() ind: any = null;
  /** แสดงแถบ "สูตร" ด้วย (ค่าตั้งต้นไม่แสดง — หน้าที่ใช้มีป้ายสูตร app-formula-badge อยู่แล้ว) */
  @Input() formula = false;
  /** แสดงชื่อ table_process (ค่าตั้งต้น = แสดง) */
  @Input() tp = true;
  badges: IndicatorBadge[] = [];
  tableProcess = '';
  private meta = inject(IndicatorMetaService);
  private cdr = inject(ChangeDetectorRef);
  private sub: Subscription | null = null;
  private last: any = null;

  ngOnInit() {
    this.meta.ensure();
    this.sub = this.meta.meta$.subscribe(m => { this.last = m; this.compute(); this.cdr.markForCheck(); });
  }
  ngOnChanges() { this.compute(); }
  ngOnDestroy() { this.sub?.unsubscribe(); }
  track = (_: number, b: IndicatorBadge) => b.key;

  private compute() {
    const m = this.last;
    const fromMeta = this.id != null && m ? m.byId.get(Number(this.id)) : null;
    const ind = fromMeta ? { ...fromMeta, ...(this.ind || {}) } : this.ind;
    this.badges = indicatorBadges(ind, c => m?.hostype.get(c) || c, { formula: this.formula });
    this.tableProcess = this.tp && ind?.table_process ? String(ind.table_process).trim() : '';
  }
}
