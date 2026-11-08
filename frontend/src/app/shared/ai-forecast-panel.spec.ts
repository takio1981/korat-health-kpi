import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { AiForecastPanelComponent } from './ai-forecast-panel';

// แผง AI อธิบายตัวชี้วัดเสี่ยง (ระบบเตือนล่วงหน้า ระยะที่ 4 — 8 พ.ย. 2569)
describe('AiForecastPanelComponent', () => {
  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [AiForecastPanelComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  const make = (enabled: boolean) => {
    const f = TestBed.createComponent(AiForecastPanelComponent);
    f.componentRef.setInput('params', { year_bh: '2570', status: 'high' });
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled });
    f.detectChanges();
    return f;
  };

  it('ผู้ช่วย AI ปิด = ไม่แสดงแผง', () => {
    expect((make(false).nativeElement as HTMLElement).querySelector('#ai-forecast-panel')).toBeNull();
  });

  it('ส่งตัวกรองปัจจุบัน → แสดงข้อความล้วน + ป้ายเตือน | ตัวกรองเปลี่ยน = ล้างคำอธิบายเดิม | ค่าเดิม = ไม่ล้าง', () => {
    const f = make(true);
    f.componentInstance.generate();
    const req = http.expectOne(r => r.url.endsWith('/report/forecast/ai-explain'));
    expect(req.request.body).toEqual({ year_bh: '2570', status: 'high', refresh: false });
    req.flush({ success: true, summary: '■ ภาพรวม\n• มีแนวโน้ม <b>ไม่บรรลุ</b>', model: 'mock', cached: false });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('มีแนวโน้ม <b>ไม่บรรลุ</b>');
    expect(el.textContent).toContain('ข้อความจาก AI');
    f.componentRef.setInput('params', { year_bh: '2570', status: 'high' });   // object ใหม่ ค่าเดิม
    f.detectChanges();
    expect(f.componentInstance.summary).not.toBe('');
    f.componentRef.setInput('params', { year_bh: '2570', status: 'watch' });
    f.detectChanges();
    expect(f.componentInstance.summary).toBe('');
  });

  it('ไม่มีรายการเสี่ยง = แจ้งว่าไม่ต้องอธิบาย', () => {
    const f = make(true);
    f.componentInstance.generate();
    http.expectOne(r => r.url.endsWith('/report/forecast/ai-explain')).flush({ success: true, no_risk: true, summary: '' });
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('ไม่มีรายการเสี่ยงตามตัวกรองนี้');
  });
});
