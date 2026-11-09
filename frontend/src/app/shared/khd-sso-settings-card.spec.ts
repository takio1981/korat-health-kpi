import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { vi } from 'vitest';
import Swal from 'sweetalert2';
import { testProviders } from '../testing/test-providers';
import { KhdSsoSettingsCardComponent, isSsoUrl, khdLinkExample } from './khd-sso-settings-card';

// การ์ดตั้งค่าเข้าสู่ระบบอัตโนมัติจาก KHD (9 พ.ย. 2569) — URL ตั้งได้ เผื่อเปลี่ยนในอนาคต
const defaults = { url: 'https://khd.moph.go.th/', login_url: 'https://apikorat.moph.go.th/khupskpi/login', audience: 'khupskpi' };
const data = { enabled: false, url: defaults.url, login_url: defaults.login_url, issuer: '', audience: '', effective_issuer: 'khd.moph.go.th', has_secret: false, max_age_seconds: 300, defaults };

describe('khd-sso-settings-card', () => {
  it('isSsoUrl: https ได้, http ได้เฉพาะ localhost, อย่างอื่นไม่ได้ | khdLinkExample', () => {
    expect(isSsoUrl('https://khd.moph.go.th/')).toBe(true);
    expect(isSsoUrl('http://khd.moph.go.th/')).toBe(false);
    expect(isSsoUrl('http://localhost:4510/khupskpi/login')).toBe(true);
    expect(isSsoUrl('javascript:alert(1)')).toBe(false);
    expect(isSsoUrl('')).toBe(false);
    expect(khdLinkExample('https://a.go.th/khupskpi/login')).toBe('https://a.go.th/khupskpi/login?khd_token=<JWT>');
    expect(khdLinkExample('https://a.go.th/login?x=1')).toBe('https://a.go.th/login?x=1&khd_token=<JWT>');
  });

  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [KhdSsoSettingsCardComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('โหลดค่า → แก้ URL ระบบ KHD แล้ว issuer ที่แสดงเปลี่ยนตาม → URL ผิดบันทึกไม่ได้ → สร้างรหัสลับแสดงครั้งเดียว', () => {
    vi.spyOn(Swal, 'fire').mockReturnValue(Promise.resolve({ isConfirmed: true } as any));
    const f = TestBed.createComponent(KhdSsoSettingsCardComponent);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/auth/khd/settings')).flush({ success: true, data: { ...data } });
    f.detectChanges();
    const c = f.componentInstance;
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('ยังไม่ได้สร้าง');
    expect(el.textContent).toContain('https://apikorat.moph.go.th/khupskpi/login?khd_token=<JWT>');

    c.s.url = 'https://khd2.moph.go.th/app';
    expect(c.issuerPreview).toBe('khd2.moph.go.th');
    c.s.url = 'ftp://x';
    expect(c.canSave).toBe(false);
    c.resetUrls();
    expect(c.s.url).toBe(defaults.url);

    c.s.enabled = true;
    c.generate();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/auth/khd/settings'));
    expect(put.request.body).toEqual({ enabled: true, url: defaults.url, login_url: defaults.login_url, issuer: '', audience: '', generate_secret: true });
    put.flush({ success: true, message: 'บันทึกแล้ว', data: { ...data, enabled: true, has_secret: true }, secret: 'S'.repeat(64) });
    f.detectChanges();
    expect(el.querySelector('#khd-sso-new-secret')?.textContent).toContain('S'.repeat(64));
    expect(el.textContent).toContain('ตั้งแล้ว');
    http.verify();
  });
});
