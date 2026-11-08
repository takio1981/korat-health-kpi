import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { ForecastSettingsCardComponent, lastRunText } from './forecast-settings-card';

// การ์ดตั้งค่าระบบเตือนล่วงหน้า (ระยะที่ 3 — 8 พ.ย. 2569)
const settings = { watch_pct: 10, digest_enabled: false, digest_day: 1, digest_time: '08:00', digest_inapp: true, digest_email: true, digest_telegram: true, digest_ai: false };

describe('forecast-settings-card', () => {
  it('lastRunText: ยังไม่เคยส่ง / ไม่ส่งเพราะไม่มีความเสี่ยง / ส่งแล้วพร้อมช่องทาง', () => {
    expect(lastRunText(null)).toBe('ยังไม่เคยส่ง');
    expect(lastRunText({ skipped: true, reason: 'no_risk', ran_at: '2026-11-09T01:00:00Z' })).toContain('ไม่มีคู่เสี่ยงสูง');
    const t = lastRunText({ year_bh: '2570', counts: { high: 4 }, inapp: 3, sent_email: true, sent_telegram: false, ai: true, ran_at: '2026-11-09T01:00:00Z' });
    expect(t).toContain('เสี่ยงสูง 4 คู่');
    expect(t).toContain('ในระบบ 3 คน, อีเมล');
    expect(t).not.toContain('Telegram');
    expect(t).toContain('มีสรุป AI');
  });

  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [ForecastSettingsCardComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  it('โหลดค่า → บันทึกส่งค่าเป็นตัวเลข → ดูตัวอย่างแสดงข้อความ (ไม่ส่งจริง)', () => {
    const f = TestBed.createComponent(ForecastSettingsCardComponent);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled: false });
    http.expectOne(r => r.url.endsWith('/forecast/settings')).flush({ success: true, data: { ...settings }, last_run: null });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('ยังไม่เคยส่ง');
    expect(el.textContent).not.toContain('แนบสรุปโดย AI');           // ผู้ช่วย AI ปิด
    f.componentInstance.s.watch_pct = '15';
    f.componentInstance.save();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/forecast/settings'));
    expect(put.request.body.watch_pct).toBe(15);
    f.componentInstance.run(true);
    const run = http.expectOne(r => r.url.endsWith('/forecast/digest/run'));
    expect(run.request.body).toEqual({ preview: true });
    run.flush({ success: true, preview: true, text: '⚠️ สรุปตัวชี้วัดเสี่ยงรายสัปดาห์ — ปีงบ 2570' });
    f.detectChanges();
    expect(el.querySelector('#fc-preview')?.textContent).toContain('ปีงบ 2570');
  });
});
