import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DISTRICT_MAP_ATTRIBUTION, DISTRICT_MAP_HEIGHT, DISTRICT_MAP_WIDTH, DISTRICT_SHAPES, DistrictShape } from './korat-district-shapes';

export interface DistrictDatum { id: any; name: string; pct: number; passed: number; total: number; }

export const MAP_COLOR_PASS = '#10b981';   // ≥ 80%
export const MAP_COLOR_MID = '#f59e0b';    // 50–79%
export const MAP_COLOR_FAIL = '#ef4444';   // < 50%
export const MAP_COLOR_NONE = '#e5e7eb';   // ไม่มีข้อมูล / นอกขอบเขตสิทธิ์

export function districtColor(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || isNaN(Number(pct))) return MAP_COLOR_NONE;
  if (pct >= 80) return MAP_COLOR_PASS;
  if (pct >= 50) return MAP_COLOR_MID;
  return MAP_COLOR_FAIL;
}

// แผนที่ระบายสี (choropleth) ผลงานรายอำเภอ จ.นครราชสีมา — วาดด้วย SVG จากรูปร่างที่ฝังมากับแอป (korat-district-shapes.ts)
// ไม่เรียกแผนที่ฐาน/บริการภายนอกใดๆ จึงใช้ได้ในเครือข่ายภายในและไม่ต้องตั้งค่า CSP เพิ่ม
// สี = ร้อยละผ่านเกณฑ์ (เกณฑ์เดียวกับกราฟทั้งหน้า) | เทา = ไม่มีข้อมูลในขอบเขตสิทธิ์/ตัวกรอง | คลิกอำเภอที่มีข้อมูล = กรองอำเภอนั้น
@Component({
  selector: 'app-district-map',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col lg:flex-row gap-4 items-start">
      <div class="w-full lg:flex-1 min-w-0">
        <svg [attr.viewBox]="viewBox" class="w-full h-auto max-h-[640px] select-none" role="img" aria-label="แผนที่ผลงานรายอำเภอ จังหวัดนครราชสีมา">
          <g *ngFor="let s of shapes" class="district" [attr.data-distid]="s.distid"
             [style.cursor]="datum(s.distid) ? 'pointer' : 'default'"
             (mouseenter)="hovered = s" (mouseleave)="hovered = null" (click)="onPick(s)">
            <path [attr.d]="s.d" fill-rule="evenodd" stroke="#ffffff" stroke-linejoin="round"
                  [attr.fill]="fill(s.distid)" [attr.stroke-width]="1.5"
                  [attr.fill-opacity]="hovered && hovered.distid !== s.distid ? 0.78 : 1"></path>
            <title>{{ tooltip(s) }}</title>
          </g>
          <!-- เส้นขอบอำเภอที่กำลังกรอง/ชี้อยู่ — วาดทับชั้นบนสุดเพื่อไม่ให้ถูกอำเภอข้างเคียงบัง -->
          <path *ngIf="selectedShape as sel" class="selected-outline" [attr.d]="sel.d" fill="none" stroke="#1e3a8a" stroke-width="4" stroke-linejoin="round" pointer-events="none"></path>
          <path *ngIf="hovered as hov" [attr.d]="hov.d" fill="none" stroke="#111827" stroke-width="2.5" stroke-linejoin="round" pointer-events="none"></path>
          <g pointer-events="none" font-family="Sarabun, sans-serif" text-anchor="middle">
            <text *ngFor="let s of shapes" [attr.x]="s.cx" [attr.y]="s.cy" font-size="15" font-weight="700"
                  [attr.fill]="datum(s.distid) ? '#111827' : '#9ca3af'" stroke="#ffffff" stroke-width="3.5" paint-order="stroke" stroke-linejoin="round">
              <tspan [attr.x]="s.cx" dy="0">{{ s.name }}</tspan>
              <tspan *ngIf="datum(s.distid) as d" [attr.x]="s.cx" dy="16" font-size="14">{{ d.pct | number:'1.0-0' }}%</tspan>
            </text>
          </g>
        </svg>
        <p class="text-[10px] text-gray-400 mt-1">{{ attribution }}</p>
      </div>

      <div class="w-full lg:w-64 shrink-0 space-y-3">
        <div class="rounded-xl border border-gray-200 bg-gray-50/70 p-3 min-h-[112px]">
          <ng-container *ngIf="(hovered || selectedShape) as s; else hint">
            <p class="text-sm font-bold text-gray-800"><i class="fas fa-map-marker-alt text-green-600 mr-1"></i>อ.{{ s.name }}</p>
            <ng-container *ngIf="datum(s.distid) as d; else noData">
              <p class="text-3xl font-extrabold leading-tight" [style.color]="fill(s.distid)">{{ d.pct | number:'1.0-1' }}%</p>
              <p class="text-xs text-gray-600">ผ่านเกณฑ์ <b>{{ d.passed | number }}</b> จาก <b>{{ d.total | number }}</b> คู่ที่มีเป้าหมาย</p>
              <p class="text-[11px] text-gray-400 mt-1">คลิกที่อำเภอเพื่อ{{ isSelected(s.distid) ? 'ยกเลิกการกรอง' : 'กรองทั้งหน้าเฉพาะอำเภอนี้' }}</p>
            </ng-container>
            <ng-template #noData><p class="text-xs text-gray-500 mt-1">ไม่มีข้อมูลที่มีเป้าหมายในขอบเขตสิทธิ์/ตัวกรองที่เลือก</p></ng-template>
          </ng-container>
          <ng-template #hint>
            <p class="text-xs text-gray-500"><i class="fas fa-hand-pointer mr-1"></i>ชี้ที่อำเภอเพื่อดูรายละเอียด<br>คลิกเพื่อกรองทั้งหน้าเฉพาะอำเภอนั้น</p>
          </ng-template>
        </div>
        <div class="text-xs font-bold space-y-1.5">
          <div class="flex items-center gap-2"><span class="w-4 h-4 rounded inline-block" [style.background]="colors.pass"></span>≥ 80% <span class="ml-auto text-gray-500">{{ count('pass') }} อำเภอ</span></div>
          <div class="flex items-center gap-2"><span class="w-4 h-4 rounded inline-block" [style.background]="colors.mid"></span>50–79% <span class="ml-auto text-gray-500">{{ count('mid') }} อำเภอ</span></div>
          <div class="flex items-center gap-2"><span class="w-4 h-4 rounded inline-block" [style.background]="colors.fail"></span>&lt; 50% <span class="ml-auto text-gray-500">{{ count('fail') }} อำเภอ</span></div>
          <div class="flex items-center gap-2 font-normal text-gray-500"><span class="w-4 h-4 rounded inline-block border border-gray-300" [style.background]="colors.none"></span>ไม่มีข้อมูล <span class="ml-auto">{{ count('none') }} อำเภอ</span></div>
        </div>
      </div>
    </div>`
})
export class DistrictMapComponent implements OnChanges {
  @Input() data: DistrictDatum[] = [];
  /** distid ของอำเภอที่กำลังกรองอยู่ ('' = ไม่กรอง) */
  @Input() selected: any = '';
  /** คลิกอำเภอที่มีข้อมูล → ส่ง distid (หน้าแม่ตัดสินใจกรอง/ยกเลิกเอง) */
  @Output() pick = new EventEmitter<string>();

  readonly shapes: DistrictShape[] = DISTRICT_SHAPES;
  readonly viewBox = `0 0 ${DISTRICT_MAP_WIDTH} ${DISTRICT_MAP_HEIGHT}`;
  readonly attribution = DISTRICT_MAP_ATTRIBUTION;
  readonly colors = { pass: MAP_COLOR_PASS, mid: MAP_COLOR_MID, fail: MAP_COLOR_FAIL, none: MAP_COLOR_NONE };
  hovered: DistrictShape | null = null;
  private byId = new Map<string, DistrictDatum>();

  ngOnChanges() {
    this.byId = new Map((this.data || []).map(d => [String(d.id), d]));
  }

  datum(distid: string): DistrictDatum | null {
    return this.byId.get(String(distid)) || null;
  }
  fill(distid: string): string {
    const d = this.datum(distid);
    return districtColor(d ? d.pct : null);
  }
  isSelected(distid: string): boolean {
    return !!this.selected && String(this.selected) === String(distid);
  }
  get selectedShape(): DistrictShape | null {
    return this.selected ? (this.shapes.find(s => s.distid === String(this.selected)) || null) : null;
  }
  tooltip(s: DistrictShape): string {
    const d = this.datum(s.distid);
    return d ? `อ.${s.name} — ผ่านเกณฑ์ ${d.pct}% (${d.passed}/${d.total} คู่)` : `อ.${s.name} — ไม่มีข้อมูล`;
  }
  count(level: 'pass' | 'mid' | 'fail' | 'none'): number {
    const target = this.colors[level];
    return this.shapes.filter(s => this.fill(s.distid) === target).length;
  }
  onPick(s: DistrictShape) {
    if (this.datum(s.distid)) this.pick.emit(s.distid);
  }
}
