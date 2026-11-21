import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MascotService } from './mascot/mascot.service';
import {
  FESTIVALS, Festival, FestivalDates, activeFestival, festivalMainDate, festivalRange, missingLunar,
  normalizeOutfitMode, sanitizeFestivalDates, thaiDateKey, validDate,
} from './mascot/mascot-festival';

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const GROUP_LABELS: Record<Festival['group'], string> = { thai: 'ไทย', buddhist: 'พุทธ', chinese: 'จีน', intl: 'สากล', korat: 'โคราช' };
const SOURCE_LABELS = { fixed: 'วันเดิมทุกปี', rule: 'คำนวณอัตโนมัติ', table: 'ตารางในระบบ', admin: 'ผู้ดูแลกรอก' } as const;

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
export function festivalRows(y: number, dates: FestivalDates, today: string): FestivalRow[] {
  return FESTIVALS.map(f => {
    const m = festivalMainDate(f, y, dates), r = festivalRange(f, y, dates);
    return {
      f, group: GROUP_LABELS[f.group], range: rangeText(r), source: m ? SOURCE_LABELS[m.source] : 'ยังไม่มีวันที่',
      lunar: f.kind === 'lunar', date: m?.date || '', missing: !m, today: !!r && today >= r[0] && today <= r[1],
    };
  }).sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
}

/**
 * การ์ดตั้งค่าชุดเทศกาลของน้องโคราชดี (หน้าตั้งค่าระบบ — 21 พ.ย. 2569)
 * โหมด auto/none/บังคับชุด + ปฏิทินเทศกาลรายปี (กรอกวันที่เทศกาลตามจันทรคติของปีถัดไปได้) + ลองชุด (เห็นที่น้องในหน้านี้ทันที ไม่บันทึก)
 * ค่าบันทึกพร้อมปุ่ม "บันทึกการตั้งค่า" ของหน้าตั้งค่า (mascot_outfit, mascot_festival_dates)
 */
@Component({
  selector: 'app-mascot-festival-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="bg-white rounded-lg p-3 border border-gray-200 mt-3" id="mascot-festival-card">
      <p class="text-sm font-bold text-gray-700"><i class="fas fa-gifts text-pink-500 mr-1"></i>ชุดเทศกาลของน้องโคราชดี</p>
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
      <p class="text-[11px] text-gray-400 mt-1">วันที่ตามจันทรคติ (วันพระ ลอยกระทง ตรุษจีน ไหว้พระจันทร์ กินเจ) มีในระบบถึงปีที่ราชการประกาศแล้ว — ปีถัดไปกรอกวันหลักของเทศกาลได้เอง (กินเจ = วันแรกของเทศกาล) เว้นว่าง = ใช้ค่าในระบบ</p>
    </div>
  `,
})
export class MascotFestivalCardComponent implements OnInit, OnChanges, OnDestroy {
  private mascotSvc = inject(MascotService);
  @Input() mode = 'auto';
  @Output() modeChange = new EventEmitter<string>();
  @Input() dates: FestivalDates = {};
  @Output() datesChange = new EventEmitter<FestivalDates>();

  readonly festivals = FESTIVALS;
  today = thaiDateKey();
  year = +this.today.slice(0, 4);
  years = [0, 1, 2, 3].map(k => this.year + k);
  rows: FestivalRow[] = [];
  missing: Festival[] = [];
  todayFestival: Festival | null = null;
  preview: string | null = null;

  ngOnInit() { this.ngOnChanges(); }
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
    this.rows = festivalRows(this.year, this.dates, this.today);
    this.missing = missingLunar(this.year, this.dates);
    this.todayFestival = activeFestival(this.mode, this.today, this.dates);
  }
}
