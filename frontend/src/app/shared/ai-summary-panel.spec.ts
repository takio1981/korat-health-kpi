import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { AiSummaryPanelComponent, summaryLines } from './ai-summary-panel';

// แผงสรุปโดย AI ในหน้ากราฟ (7 พ.ย. 2569)
describe('summaryLines', () => {
  it('แยกหัวข้อ (■) รายการย่อย (•) และตัด ** ของ Markdown', () => {
    expect(summaryLines('■ ภาพรวม\nผ่าน **50%**\n• อำเภอ ก\n- อำเภอ ข\n\n')).toEqual([
      { kind: 'head', text: 'ภาพรวม' }, { kind: 'text', text: 'ผ่าน 50%' },
      { kind: 'item', text: 'อำเภอ ก' }, { kind: 'item', text: 'อำเภอ ข' },
    ]);
    expect(summaryLines('')).toEqual([]);
  });
});

describe('AiSummaryPanelComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [AiSummaryPanelComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  const make = (enabled: boolean) => {
    const f = TestBed.createComponent(AiSummaryPanelComponent);
    f.componentRef.setInput('params', { year_bh: '2569', distid: '3001' });
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled });
    f.detectChanges();
    return f;
  };

  it('ผู้ช่วย AI ปิดอยู่ = ไม่แสดงแผง', () => {
    const f = make(false);
    expect(f.nativeElement.textContent).not.toContain('สรุปโดย AI');
  });

  it('สร้างสรุป: ส่งตัวกรองปัจจุบัน แสดงข้อความล้วนพร้อมป้ายเตือน (ไม่ตีความ HTML จาก AI)', () => {
    const f = make(true);
    f.componentInstance.generate();
    const req = http.expectOne(r => r.url.endsWith('/report/ai-summary'));
    expect(req.request.body).toEqual({ year_bh: '2569', distid: '3001', refresh: false });
    req.flush({ success: true, summary: '■ ภาพรวม\n• <b>อำเภอ</b> ผ่าน 60%', model: 'm', generated_at: '2026-11-07T01:00:00Z', cached: false });
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent).toContain('<b>อำเภอ</b> ผ่าน 60%');
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('ข้อความจาก AI — โปรดตรวจสอบ');
  });

  it('ตัวกรองเปลี่ยน = ล้างสรุปเดิม, ข้อผิดพลาดแสดงข้อความจากระบบ', () => {
    const f = make(true);
    f.componentInstance.generate();
    http.expectOne(r => r.url.endsWith('/report/ai-summary')).flush({ success: true, summary: '■ ภาพรวม' });
    f.componentRef.setInput('params', { year_bh: '2570' });
    f.detectChanges();
    expect(f.componentInstance.summary).toBe('');
    f.componentInstance.generate();
    http.expectOne(r => r.url.endsWith('/report/ai-summary')).flush({ success: false, message: 'ใช้ผู้ช่วย AI ครบ 200 ครั้งของวันนี้แล้ว' }, { status: 429, statusText: 'Too Many' });
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('ใช้ผู้ช่วย AI ครบ 200 ครั้งของวันนี้แล้ว');
  });

  // ---- รายงานสรุปผลรายแถบ (15 พ.ย. 2569) ----
  it('โหมด report-tab: หัวข้อตามแถบ + ส่งแถบ/ตัวกรองไป /report/ai-tab-summary', () => {
    const f = TestBed.createComponent(AiSummaryPanelComponent);
    f.componentRef.setInput('mode', 'report-tab');
    f.componentRef.setInput('heading', 'AI วิเคราะห์และสรุป — รายอำเภอ');
    f.componentRef.setInput('params', { tab: 'by-district', year_bh: '2570', zone: '1' });
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled: true });
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent).toContain('AI วิเคราะห์และสรุป — รายอำเภอ');
    expect(el.textContent).toContain('วิเคราะห์และสรุป');
    (el.querySelector('button') as HTMLButtonElement).click();
    const req = http.expectOne(r => r.url.endsWith('/report/ai-tab-summary'));
    expect(req.request.body).toEqual({ tab: 'by-district', year_bh: '2570', zone: '1', refresh: false });
    req.flush({ success: true, summary: '■ ภาพรวม\n• อำเภอ ก ผ่าน 80%', model: 'm', generated_at: '2026-11-15T01:00:00Z' });
    f.detectChanges();
    expect(el.textContent).toContain('อำเภอ ก ผ่าน 80%');
    http.expectNone(r => r.url.endsWith('/report/ai-summary'));
  });

  it('สลับแถบระหว่างรอคำตอบ = ทิ้งคำตอบของแถบเดิม (ไม่แสดงสรุปผิดแถบ)', () => {
    const f = TestBed.createComponent(AiSummaryPanelComponent);
    f.componentRef.setInput('mode', 'report-tab');
    f.componentRef.setInput('params', { tab: 'by-indicator', year_bh: '2570' });
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled: true });
    f.componentInstance.generate();
    const old = http.expectOne(r => r.url.endsWith('/report/ai-tab-summary'));
    f.componentRef.setInput('params', { tab: 'by-hospital', year_bh: '2570' });
    f.detectChanges();
    expect(f.componentInstance.loading).toBe(false);
    old.flush({ success: true, summary: '■ สรุปของแถบรายตัวชี้วัด' });
    f.detectChanges();
    expect(f.componentInstance.summary).toBe('');
    expect(f.nativeElement.textContent).not.toContain('สรุปของแถบรายตัวชี้วัด');
  });
});
