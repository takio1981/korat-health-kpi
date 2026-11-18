import { Component, EventEmitter, Injectable, Input, OnChanges, OnInit, Output, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

/**
 * วิดีโอคู่มือแยกตามสิทธิ์ (18 พ.ย. 2569) — ไฟล์อยู่นอก build ที่ <base href>videos/<สิทธิ์>/<หัวข้อ>.mp4
 * (nginx เสิร์ฟจากโฟลเดอร์ videos/ บนเซิร์ฟเวอร์ — สร้างด้วย tools/video-guide) + videos/manifest.json บอกว่ามีไฟล์ใดบ้าง
 * ไม่มี manifest / ไม่มีวิดีโอของหัวข้อ = ไม่แสดงปุ่ม (ไม่มีลิงก์เสีย)
 */
export interface HelpVideo { title: string; role: string; section: string; file: string; duration: number; size?: number; updated?: string; }
export interface HelpVideoManifest { generated?: string; videos: Record<string, HelpVideo>; }

export const VIDEO_ROLE_LABELS: Record<string, string> = {
  public: 'ทุกสิทธิ์',
  super_admin: 'ผู้ดูแลระบบสูงสุด', admin_ssj: 'ผู้ดูแล สสจ.', admin_cup: 'ผู้ดูแล CUP', admin_hos: 'ผู้ดูแลโรงพยาบาล',
  admin_sso: 'ผู้ดูแล สสอ.', user_cup: 'ผู้ใช้ CUP', user_hos: 'ผู้ใช้โรงพยาบาล', user_sso: 'ผู้ใช้ สสอ.', user_ssj: 'ผู้ใช้ สสจ.',
};

/** วิดีโอของหัวข้อสำหรับสิทธิ์นั้น — ไม่มีของสิทธิ์ = ใช้วิดีโอร่วม (public) ของหัวข้อเดียวกัน */
export function findHelpVideo(m: HelpVideoManifest | null | undefined, role: string, section: string): HelpVideo | null {
  const v = m?.videos || {};
  const own = (k: string) => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null);
  return (role && own(`${role}/${section}`)) || own(`public/${section}`);
}

/** รายการวิดีโอที่สิทธิ์นั้นดูได้ เรียงตามลำดับหัวข้อในคู่มือ (sectionOrder) */
export function helpVideosFor(m: HelpVideoManifest | null | undefined, role: string, sectionOrder: string[]): HelpVideo[] {
  return sectionOrder.map(s => findHelpVideo(m, role, s)).filter((x): x is HelpVideo => !!x);
}

export function formatVideoDuration(sec: number): string {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** URL ของโฟลเดอร์วิดีโอ อิง <base href> (production = /khupskpi/videos/) */
export function videosBaseUrl(baseUri: string = document.baseURI): string {
  return new URL('videos/', baseUri).href;
}

/** ชื่อไฟล์ใน manifest มาจากเครื่องมือสร้างวิดีโอ — ยอมรับเฉพาะ <สิทธิ์>/<หัวข้อ>.mp4 กันลิงก์ออกนอกโฟลเดอร์ */
export function safeVideoFile(file: string): string | null {
  return /^[a-z_]+\/[a-z0-9-]+\.mp4$/.test(String(file || '')) ? file : null;
}

@Injectable({ providedIn: 'root' })
export class HelpVideoService {
  private http = inject(HttpClient);
  private cache$?: Observable<HelpVideoManifest>;

  manifest(): Observable<HelpVideoManifest> {
    if (!this.cache$) {
      this.cache$ = this.http.get<HelpVideoManifest>(videosBaseUrl() + 'manifest.json?t=' + Math.floor(Date.now() / 600000)).pipe(
        map(m => (m && typeof m.videos === 'object' && m.videos ? m : { videos: {} })),
        catchError(() => of({ videos: {} } as HelpVideoManifest)),
        shareReplay(1),
      );
    }
    return this.cache$;
  }

  url(v: HelpVideo): string | null {
    const f = safeVideoFile(v.file);
    return f ? videosBaseUrl() + f : null;
  }
}

/** ปุ่ม "วิดีโอคู่มือ" ในแต่ละหัวข้อของคู่มือ — กดแล้วเล่นในหน้า */
@Component({
  selector: 'app-help-video',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="video && src" class="help-video mb-4 rounded-xl border border-rose-200 bg-rose-50 overflow-hidden" [class.mx-6]="inset" [class.mt-4]="inset">
      <button type="button" (click)="open = !open" [attr.aria-expanded]="open"
              class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-rose-100 transition-colors">
        <span class="w-8 h-8 rounded-full bg-rose-500 text-white flex items-center justify-center shrink-0"><i class="fas" [ngClass]="open ? 'fa-times' : 'fa-play'"></i></span>
        <span class="flex-1 min-w-0">
          <span class="block text-sm font-bold text-rose-700">วิดีโอคู่มือ: {{ video.title }}</span>
          <span class="block text-xs text-rose-500">สิทธิ์: {{ roleLabel(video.role) }} · ความยาว {{ duration(video.duration) }} · ภาษาไทยพร้อมคำบรรยาย</span>
        </span>
        <a [href]="src" target="_blank" rel="noopener" (click)="$event.stopPropagation()" class="text-xs text-rose-600 hover:underline shrink-0" title="เปิดวิดีโอในแท็บใหม่"><i class="fas fa-external-link-alt mr-1"></i>เปิดแท็บใหม่</a>
      </button>
      <video *ngIf="open" [src]="src" controls autoplay preload="metadata" playsinline class="w-full bg-black max-h-[70vh]"></video>
    </div>`,
})
export class HelpVideoComponent implements OnInit, OnChanges {
  private svc = inject(HelpVideoService);
  private cdr = inject(ChangeDetectorRef);
  @Input() section = '';
  @Input() role = '';
  /** หัวข้อที่ไม่มี padding (หัวการ์ดแบบเต็มกว้าง) */
  @Input() inset = false;
  private manifest: HelpVideoManifest | null = null;
  video: HelpVideo | null = null;
  src: string | null = null;
  open = false;
  roleLabel = (r: string) => VIDEO_ROLE_LABELS[r] || r;
  duration = formatVideoDuration;

  ngOnInit() { this.svc.manifest().subscribe(m => { this.manifest = m; this.resolve(); this.cdr.markForCheck(); }); }
  ngOnChanges() { this.resolve(); }

  /** เปิดวิดีโอ (จากรายการวิดีโอด้านบนของคู่มือ) */
  play() { if (this.video) { this.open = true; this.cdr.markForCheck(); } }

  private resolve() {
    const v = findHelpVideo(this.manifest, this.role, this.section);
    if (v?.file !== this.video?.file) this.open = false;
    this.video = v;
    this.src = v ? this.svc.url(v) : null;
  }
}

/** รายการวิดีโอทั้งหมดของสิทธิ์ (ด้านบนของหน้าคู่มือ) */
@Component({
  selector: 'app-help-video-list',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div *ngIf="videos.length" class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <i class="fas fa-film text-rose-500"></i>
        <h3 class="font-bold text-gray-800 text-sm">วิดีโอคู่มือการใช้งาน ({{ videos.length }} เรื่อง · รวม {{ totalText }})</h3>
        <span class="text-xs text-gray-400">สิทธิ์: {{ roleLabel(role) }}</span>
        <ng-content></ng-content>
      </div>
      <div class="flex flex-wrap gap-2">
        <button *ngFor="let v of videos" type="button" (click)="pick.emit(v.section)"
                class="px-3 py-1.5 rounded-xl text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100">
          <i class="fas fa-play-circle mr-1"></i>{{ v.title }} <span class="text-rose-400">{{ duration(v.duration) }}</span>
        </button>
      </div>
    </div>`,
})
export class HelpVideoListComponent implements OnInit, OnChanges {
  private svc = inject(HelpVideoService);
  private cdr = inject(ChangeDetectorRef);
  @Input() role = '';
  @Input() sections: string[] = [];
  @Output() pick = new EventEmitter<string>();
  private manifest: HelpVideoManifest | null = null;
  videos: HelpVideo[] = [];
  totalText = '';
  roleLabel = (r: string) => VIDEO_ROLE_LABELS[r] || r;
  duration = formatVideoDuration;

  ngOnInit() { this.svc.manifest().subscribe(m => { this.manifest = m; this.resolve(); this.cdr.markForCheck(); }); }
  ngOnChanges() { this.resolve(); }

  private resolve() {
    this.videos = helpVideosFor(this.manifest, this.role, this.sections);
    const sec = this.videos.reduce((s, v) => s + (Number(v.duration) || 0), 0);
    this.totalText = sec >= 3600 ? `${Math.floor(sec / 3600)} ชม. ${Math.round((sec % 3600) / 60)} นาที` : `${Math.round(sec / 60)} นาที`;
  }
}
