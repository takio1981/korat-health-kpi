import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MascotService } from './mascot/mascot.service';
import { AuthService } from '../services/auth';
import {
  FESTIVALS, Festival, FestivalDates, FestivalExtra, activeFestival, festivalMainDate, festivalRange, missingLunar,
  normalizeOutfitMode, sanitizeFestivalDates, thaiDateKey, validDate,
} from './mascot/mascot-festival';

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const GROUP_LABELS: Record<Festival['group'], string> = { thai: 'ไทย', buddhist: 'พุทธ', chinese: 'จีน', intl: 'สากล', korat: 'โคราช' };
const SOURCE_LABELS = {
  fixed: 'วันเดิมทุกปี', rule: 'คำนวณอัตโนมัติ', table: 'ตารางในระบบ', admin: 'ผู้ดูแลกรอก',
  auto: 'ปฏิทินวันหยุดราชการ (อัตโนมัติ)', derived: 'คำนวณจากวันอาสาฬหบูชา', astro: 'คำนวณตามปฏิทินจีน (ดาราศาสตร์)',
} as const;

/** วันที่ + เวลาไทยแบบสั้น สำหรับสถานะการดึงปฏิทิน */
export function thaiDateTimeText(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  const th = new Date(t.getTime() + 7 * 3600000).toISOString();
  return `${thaiDateText(th.slice(0, 10))} ${th.slice(11, 16)} น.`;
}
export function isHttpsUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === 'https:' && !!x.hostname; } catch { return false; }
}

/** "2026-11-23" → "23 พ.ย. 2569" */
export function thaiDateText(d: string): string {
  if (!validDate(d)) return '';
  const [y, m, dd] = d.split('-').map(Number);
  return `${dd} ${TH_MONTHS[m - 1]} ${y + 543}`;
}
export function rangeText(r: [string, string] | null): string {
  if (!r) return '';
  return r[0] === r[1] ? thaiDateText(r[0]) : `${thaiDateText(r[0])} – ${thaiDateText(r[1])}`;
}

export interface FestivalRow {
  f: Festival; group: string; range: string; source: string; lunar: boolean; date: string; missing: boolean; today: boolean;
}

/** แถวปฏิทินเทศกาลของปี ค.ศ. y (ฟังก์ชันล้วน — ทดสอบได้) */
export function festivalRows(y: number, dates: FestivalDates, today: string, ext: FestivalExtra = {}): FestivalRow[] {
  return FESTIVALS.map(f => {
    const m = festivalMainDate(f, y, dates, ext), r = festivalRange(f, y, dates, ext);
    return {
      f, group: GROUP_LABELS[f.group], range: rangeText(r), source: m ? SOURCE_LABELS[m.source] : 'ยังไม่มีวันที่',
      lunar: f.kind === 'lunar', date: m?.date || '', missing: !m, today: !!r && today >= r[0] && today <= r[1],
    };
  }).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
}

/**
 * การ์ดตั้งค่าชุดเทศกาลของน้องคิดดี (หน้าตั้งค่าระบบ — 21 พ.ย. 2569)
 * โหมด auto/none/บังคับชุด + ปฏิทินเทศกาลรายปี (กรอกวันที่เทศกาลตามจันทรคติของปีถัดไปได้) + ลองชุด (เห็นที่น้องในหน้านี้ทันที ไม่บันทึก)
 * ค่าบันทึกพร้อมปุ่ม "บันทึกการตั้งค่า" ของหน้าตั้งค่า (mascot_outfit, mascot_festival_dates)
 */
@Component({
  selector: 'app-mascot-festival-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="bg-white rounded-lg p-3 border border-gray-200 mt-3" id="mascot-festival-card">
      <p class="text-sm font-bold text-gray-700"><i class="fas fa-gifts text-pink-500 mr-1"></i>ชุดเทศกาลของน้องคิดดี</p>
      <p class="text-xs text-gray-500 mt-0.5">น้องเปลี่ยนชุดและเครื่องประดับเองตามเทศกาลไทยและสากล (คิดตามวันที่เวลาไทย) และกล่าวอวยพรวันละครั้ง — กดปุ่ม <i class="fas fa-eye"></i> เพื่อลองชุด (น้องมุมขวาล่างเปลี่ยนชุดทันที ยังไม่บันทึก)</p>
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <label for="mascot-outfit-mode" class="text-xs font-bold text-gray-600">การแต่งตัว</label>
        <select id="mascot-outfit-mode" class="text-sm border border-gray-200 rounded-lg px-2 py-1 bg-white" [ngModel]="mode" (ngModelChange)="setMode($event)">
          <option value="auto">ตามเทศกาลอัตโนมัติ (แนะนำ)</option>
          <option value="none">ชุดปกติเสมอ (ปิดชุดเทศกาล)</option>
          <option *ngFor="let f of festivals" [value]="f.id">ใส่ชุด{{ f.name }}ตลอด</option>
        </select>
        <span class="text-xs px-2 py-0.5 rounded-full" [ngClass]="todayFestival ? 'bg-pink-100 text-pink-700' : 'bg-gray-100 text-gray-500'" id="mascot-festival-today">
          วันนี้: {{ todayFestival ? todayFestival.name : 'ชุดปกติ' }}
        </span>
        <button *ngIf="preview" type="button" id="btn-festival-preview-stop" (click)="setPreview(null)"
                class="text-xs px-2 py-1 rounded-lg bg-amber-100 text-amber-800 font-bold"><i class="fas fa-rotate-left mr-1"></i>เลิกลองชุด</button>
      </div>
      <div class="mt-3 rounded-lg border border-teal-100 bg-teal-50 p-2" id="mascot-festival-auto-box">
        <label class="inline-flex items-center cursor-pointer gap-2">
          <input type="checkbox" id="mascot-festival-auto" class="w-4 h-4 accent-teal-600" [ngModel]="autoOn" (ngModelChange)="setAuto($event)">
          <span class="text-xs font-bold text-gray-700">ปรับวันที่เปลี่ยนชุดอัตโนมัติเมื่อขึ้นปีใหม่</span>
        </label>
        <p class="text-[11px] text-gray-500 mt-0.5 ml-6">ระบบดึงวันหยุดราชการ (มาฆบูชา วิสาขบูชา อาสาฬหบูชา ตรุษจีน) จากปฏิทินสาธารณะเมื่อขึ้นปีใหม่ และทุก 7 วัน (ราชการประกาศปีถัดไประหว่างปี)
          แล้วคำนวณวันที่เหลือเอง: เข้าพรรษา ออกพรรษา ลอยกระทง จากวันอาสาฬหบูชา, ไหว้พระจันทร์ กินเจ ตามปฏิทินจีน — วันที่ที่ผู้ดูแลกรอกเองมาก่อนเสมอ</p>
        <div class="ml-6 mt-1 flex flex-wrap items-center gap-2 text-[11px]" id="mascot-festival-auto-status">
          <span *ngIf="status && status.fetched_at" class="text-teal-700"><i class="fas fa-circle-check mr-1"></i>อัปเดตล่าสุด {{ fetchedText }} ({{ status.count }} รายการ)</span>
          <span *ngIf="status && !status.fetched_at && !status.error" class="text-gray-500">ยังไม่เคยดึงปฏิทิน</span>
          <span *ngIf="status && status.error" class="text-red-600"><i class="fas fa-triangle-exclamation mr-1"></i>ครั้งล่าสุดไม่สำเร็จ: {{ status.error }}</span>
          <button type="button" id="btn-festival-refresh" (click)="refreshNow()" [disabled]="refreshing"
                  class="px-2 py-0.5 rounded-lg bg-teal-600 text-white font-bold disabled:opacity-50">
            <i class="fas" [ngClass]="refreshing ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> อัปเดตวันที่ตอนนี้</button>
          <button type="button" class="text-gray-500 underline" (click)="showUrl = !showUrl">แหล่งปฏิทิน</button>
        </div>
        <div *ngIf="showUrl" class="ml-6 mt-1">
          <input type="url" id="mascot-festival-ics-url" class="w-full text-[11px] border border-gray-200 rounded px-2 py-1 bg-white"
                 [ngModel]="icsUrl" (ngModelChange)="setUrl($event)" [placeholder]="status?.default_url || 'https://…/basic.ics'" aria-label="ที่อยู่ไฟล์ปฏิทินวันหยุด (iCalendar)">
          <p class="text-[11px] mt-0.5" [ngClass]="icsUrl && !urlOk ? 'text-red-600' : 'text-gray-400'">
            ไฟล์ iCalendar (.ics) แบบ https เว้นว่าง = ปฏิทินวันหยุดในไทยของ Google — มีผลหลังกดบันทึกการตั้งค่า</p>
        </div>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <label for="mascot-festival-year" class="text-xs font-bold text-gray-600">ปฏิทินเทศกาลปี</label>
        <select id="mascot-festival-year" class="text-sm border border-gray-200 rounded-lg px-2 py-1 bg-white" [ngModel]="year" (ngModelChange)="setYear(+$event)">
          <option *ngFor="let y of years" [value]="y">พ.ศ. {{ y + 543 }}</option>
        </select>
        <span *ngIf="missing.length" class="text-xs text-amber-700" id="mascot-festival-missing">
          <i class="fas fa-triangle-exclamation mr-1"></i>ยังไม่มีวันที่ {{ missing.length }} เทศกาล (ตามจันทรคติ — ราชการประกาศล่วงหน้า) กรอกได้ในตารางด้านล่าง
        </span>
      </div>
      <div class="mt-2 overflow-x-auto card-scroll" style="max-height: 340px">
        <table class="w-full text-xs">
          <thead class="sticky top-0 bg-gray-50 text-gray-500">
            <tr><th class="text-left px-2 py-1">เทศกาล</th><th class="text-left px-2 py-1">ช่วงที่ใส่ชุด</th><th class="text-left px-2 py-1">ที่มาของวันที่</th><th class="px-2 py-1">ลองชุด</th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let r of rows; trackBy: trackRow" class="border-t border-gray-100" [ngClass]="{ 'bg-pink-50': r.today }" [attr.data-festival]="r.f.id">
              <td class="px-2 py-1">
                <span class="font-bold text-gray-700">{{ r.f.name }}</span>
                <span class="ml-1 px-1.5 rounded bg-gray-100 text-gray-500">{{ r.group }}</span>
              </td>
              <td class="px-2 py-1 whitespace-nowrap">
                <span *ngIf="!r.missing">{{ r.range }}</span>
                <span *ngIf="r.missing" class="text-amber-700">ยังไม่มีวันที่</span>
              </td>
              <td class="px-2 py-1">
                <ng-container *ngIf="r.lunar; else fixedSrc">
                  <input type="date" class="border border-gray-200 rounded px-1 py-0.5 bg-white" [attr.aria-label]="'วันหลักของ' + r.f.name"
                         [min]="year + '-01-01'" [max]="year + '-12-31'" [value]="r.date" (change)="setDate(r.f.id, $any($event.target).value)">
                  <span class="ml-1 text-gray-400">{{ r.source }}</span>
                </ng-container>
                <ng-template #fixedSrc><span class="text-gray-400">{{ r.source }}</span></ng-template>
              </td>
              <td class="px-2 py-1 text-center">
                <button type="button" class="w-7 h-7 rounded-lg" [ngClass]="preview === r.f.id ? 'bg-pink-500 text-white' : 'bg-pink-50 text-pink-600 hover:bg-pink-100'"
                        [title]="'ลองชุด' + r.f.name" [attr.aria-label]="'ลองชุด' + r.f.name" (click)="setPreview(preview === r.f.id ? null : r.f.id)"><i class="fas fa-eye"></i></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-[11px] text-gray-400 mt-1">กรอกวันหลักของเทศกาลตามจันทรคติเองได้ (กินเจ = วันแรกของเทศกาล) เว้นว่าง = ใช้วันที่อัตโนมัติ/ค่าในระบบ</p>
    </div>
  `,
})
export class MascotFestivalCardComponent implements OnInit, OnChanges, OnDestroy {
  private mascotSvc = inject(MascotService);
  @Input() mode = 'auto';
  @Output() modeChange = new EventEmitter<string>();
  @Input() dates: FestivalDates = {};
  @Output() datesChange = new EventEmitter<FestivalDates>();
  /** ปรับวันที่อัตโนมัติ (mascot_festival_auto) + ที่อยู่ปฏิทิน (mascot_festival_ics_url, ว่าง = ค่าตั้งต้น) */
  @Input() autoOn = true;
  @Output() autoOnChange = new EventEmitter<boolean>();
  @Input() icsUrl = '';
  @Output() icsUrlChange = new EventEmitter<string>();
  private auth = inject(AuthService);
  status: { fetched_at: string | null; error: string | null; count: number; default_url: string; dates: FestivalDates } | null = null;
  /** วันที่จากปฏิทินวันหยุดราชการที่ระบบดึงมาแล้ว (ใช้ร่วมกับหน้าตั้งค่าตอนบันทึก) */
  autoDates: FestivalDates = {};
  refreshing = false;
  showUrl = false;
  get urlOk() { return !this.icsUrl || isHttpsUrl(this.icsUrl); }
  get fetchedText() { return thaiDateTimeText(this.status?.fetched_at); }
  private get ext(): FestivalExtra { return this.autoOn ? { auto: this.autoDates, compute: true } : {}; }

  readonly festivals = FESTIVALS;
  today = thaiDateKey();
  year = +this.today.slice(0, 4);
  years = [0, 1, 2, 3].map(k => this.year + k);
  rows: FestivalRow[] = [];
  missing: Festival[] = [];
  todayFestival: Festival | null = null;
  preview: string | null = null;

  ngOnInit() { this.ngOnChanges(); this.loadStatus(); }
  /** ค่าจากหน้าตั้งค่ามาถึงทีหลัง (โหลด settings แบบ async) */
  ngOnChanges() { this.mode = normalizeOutfitMode(this.mode); this.dates = sanitizeFestivalDates(this.dates); this.refresh(); }
  ngOnDestroy() { this.mascotSvc.outfitPreview$.next(null); }

  setMode(m: string) {
    this.mode = normalizeOutfitMode(m);
    this.modeChange.emit(this.mode);
    this.setPreview(this.mode); // เห็นผลที่น้องทันที (ยังไม่บันทึก)
    this.refresh();
  }
  setYear(y: number) { this.year = y; this.refresh(); }
  setAuto(v: boolean) { this.autoOn = !!v; this.autoOnChange.emit(this.autoOn); this.pushPreviewConfig(); this.refresh(); }
  setUrl(v: string) { this.icsUrl = (v || '').trim(); this.icsUrlChange.emit(this.icsUrl); }

  loadStatus() {
    this.auth.apiGet('/mascot/festival-dates/status').subscribe({
      next: (r: any) => {
        this.status = r?.success ? r : null;
        this.autoDates = sanitizeFestivalDates(r?.dates);
        this.refresh();
      },
      error: () => { this.status = null; },
    });
  }
  refreshNow() {
    this.refreshing = true;
    this.auth.apiPost('/mascot/festival-dates/refresh', {}).subscribe({
      next: () => { this.refreshing = false; this.loadStatus(); this.pushPreviewConfig(); },
      // ข้อผิดพลาดถูกบันทึกในสถานะ (status.error) — โหลดสถานะใหม่เพื่อแสดง
      error: () => { this.refreshing = false; this.loadStatus(); },
    });
  }
  /** ให้น้องในหน้านี้ใช้ค่าปรับวันที่อัตโนมัติที่เลือก (ยังไม่บันทึก) */
  private pushPreviewConfig() {
    const cfg = this.mascotSvc.outfit$.value;
    this.mascotSvc.setOutfitConfig(cfg.mode, cfg.dates, this.autoOn, this.autoDates);
  }
  setPreview(id: string | null) { this.preview = id && id !== 'auto' ? id : null; this.mascotSvc.outfitPreview$.next(id); }
  setDate(id: string, d: string) {
    const ys = String(this.year), next: FestivalDates = JSON.parse(JSON.stringify(this.dates));
    if (d && validDate(d) && d.startsWith(ys)) (next[ys] ||= {})[id] = d;
    else if (next[ys]) { delete next[ys][id]; if (!Object.keys(next[ys]).length) delete next[ys]; }
    this.dates = sanitizeFestivalDates(next);
    this.datesChange.emit(this.dates);
    this.refresh();
  }
  trackRow = (_: number, r: FestivalRow) => r.f.id;

  private refresh() {
    this.rows = festivalRows(this.year, this.dates, this.today, this.ext);
    this.missing = missingLunar(this.year, this.dates, this.ext);
    this.todayFestival = activeFestival(this.mode, this.today, this.dates, this.ext);
  }
}
