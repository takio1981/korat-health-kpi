import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { findHelpVideo, helpVideosFor, formatVideoDuration, safeVideoFile, videosBaseUrl, HelpVideoComponent, HelpVideoListComponent, HelpVideoManifest } from './help-video';

// วิดีโอคู่มือแยกตามสิทธิ์ (18 พ.ย. 2569)
const M: HelpVideoManifest = {
  videos: {
    'public/login': { title: 'การเข้าสู่ระบบ', role: 'public', section: 'login', file: 'public/login.mp4', duration: 75 },
    'user_hos/dashboard': { title: 'บันทึกผลงานตัวชี้วัด', role: 'user_hos', section: 'dashboard', file: 'user_hos/dashboard.mp4', duration: 129 },
    'admin_ssj/dashboard': { title: 'บันทึกผลงานตัวชี้วัด', role: 'admin_ssj', section: 'dashboard', file: 'admin_ssj/dashboard.mp4', duration: 140 },
  },
};

describe('help-video helpers', () => {
  it('findHelpVideo ใช้วิดีโอของสิทธิ์ก่อน ไม่มีจึงใช้วิดีโอร่วม (public)', () => {
    expect(findHelpVideo(M, 'user_hos', 'dashboard')?.file).toBe('user_hos/dashboard.mp4');
    expect(findHelpVideo(M, 'admin_ssj', 'dashboard')?.file).toBe('admin_ssj/dashboard.mp4');
    expect(findHelpVideo(M, 'user_hos', 'login')?.file).toBe('public/login.mp4');
    expect(findHelpVideo(M, 'user_sso', 'dashboard')).toBeNull();
    expect(findHelpVideo(null, 'user_hos', 'dashboard')).toBeNull();
    expect(findHelpVideo(M, '__proto__', 'x')).toBeNull();
  });
  it('helpVideosFor เรียงตามลำดับหัวข้อ และข้ามหัวข้อที่ไม่มีวิดีโอ', () => {
    expect(helpVideosFor(M, 'user_hos', ['overview', 'login', 'dashboard', 'users']).map(v => v.file)).toEqual(['public/login.mp4', 'user_hos/dashboard.mp4']);
  });
  it('formatVideoDuration = นาที:วินาที', () => {
    expect(formatVideoDuration(129)).toBe('2:09');
    expect(formatVideoDuration(0)).toBe('0:00');
    expect(formatVideoDuration(NaN as any)).toBe('0:00');
  });
  it('safeVideoFile รับเฉพาะ <สิทธิ์>/<หัวข้อ>.mp4 (กันลิงก์ออกนอกโฟลเดอร์)', () => {
    expect(safeVideoFile('user_hos/dashboard.mp4')).toBe('user_hos/dashboard.mp4');
    expect(safeVideoFile('../api/.env')).toBeNull();
    expect(safeVideoFile('https://evil.example/x.mp4')).toBeNull();
    expect(safeVideoFile('user_hos/../x.mp4')).toBeNull();
  });
  it('videosBaseUrl อิง base href ของระบบ', () => {
    expect(videosBaseUrl('https://apikorat.moph.go.th/khupskpi/')).toBe('https://apikorat.moph.go.th/khupskpi/videos/');
  });
});

describe('HelpVideoComponent / HelpVideoListComponent', () => {
  let http: HttpTestingController;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HelpVideoComponent, HelpVideoListComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  const flushManifest = (body: any, status = 200) => {
    const req = http.expectOne(r => r.url.includes('videos/manifest.json'));
    if (status === 200) req.flush(body); else req.flush('nope', { status, statusText: 'Not Found' });
  };

  it('มีวิดีโอ = แสดงปุ่ม กดแล้วเล่นในหน้า', () => {
    const f = TestBed.createComponent(HelpVideoComponent);
    f.componentInstance.section = 'dashboard'; f.componentInstance.role = 'user_hos';
    f.detectChanges();
    flushManifest(M);
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent).toContain('วิดีโอคู่มือ: บันทึกผลงานตัวชี้วัด');
    expect(el.textContent).toContain('2:09');
    expect(el.querySelector('video')).toBeNull();
    (el.querySelector('button') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('video')?.getAttribute('src')).toContain('videos/user_hos/dashboard.mp4');
  });

  it('ไม่มี manifest (404) หรือไม่มีวิดีโอของหัวข้อ = ไม่แสดงอะไร', () => {
    const f = TestBed.createComponent(HelpVideoComponent);
    f.componentInstance.section = 'dashboard'; f.componentInstance.role = 'user_hos';
    f.detectChanges();
    flushManifest(null, 404);
    f.detectChanges();
    expect(f.nativeElement.querySelector('.help-video')).toBeNull();
  });

  it('รายการวิดีโอด้านบน กดแล้วส่งชื่อหัวข้อ', () => {
    const f = TestBed.createComponent(HelpVideoListComponent);
    f.componentInstance.role = 'user_hos'; f.componentInstance.sections = ['login', 'dashboard'];
    const picked: string[] = [];
    f.componentInstance.pick.subscribe(s => picked.push(s));
    f.detectChanges();
    flushManifest(M);
    f.componentInstance.ngOnChanges();
    f.detectChanges();
    const btns = f.nativeElement.querySelectorAll('button');
    expect(btns.length).toBe(2);
    expect(f.nativeElement.textContent).toContain('2 เรื่อง');
    (btns[1] as HTMLButtonElement).click();
    expect(picked).toEqual(['dashboard']);
  });
});
