import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { AiAnomalyExplainComponent, AnomalyExplainRow, anomalyPayload, applyExplanations, AI_ANOMALY_MAX } from './ai-anomaly-explain';

// หน้าต่าง AI อธิบายค่าที่อาจผิดปกติ (ผู้ช่วย AI ระยะที่ 5 — 8 พ.ย. 2569)
const row = (i: number): AnomalyExplainRow => ({
  indicatorName: 'ตัวชี้วัด ' + i, hosname: 'รพ.สต.ทดสอบ', hospcode: '10871', monthName: 'ต.ค.', value: '850', message: 'สูงกว่าค่ากลาง',
  payload: { indicator_id: i, month: 'oct', months: { oct: '850', nov: '85' }, target: '80' },
});

describe('ai-anomaly-explain helpers', () => {
  it('anomalyPayload: ค่าครบ 12 เดือน (ว่าง = "") + เป้าหมาย + ปีงบที่แล้ว — ไม่มีรหัส/ชื่อหน่วยบริการ', () => {
    const p = anomalyPayload({ indicator_id: '7', hospcode: '10871', hosname: 'x', oct: 850, nov: null, target_value: 80 }, 'oct', { oct: '90' });
    expect(p.indicator_id).toBe(7);
    expect(Object.keys(p.months)).toHaveLength(12);
    expect(p.months['oct']).toBe('850');
    expect(p.months['nov']).toBe('');
    expect(p.target).toBe('80');
    expect(p.prev?.['oct']).toBe('90');
    expect(JSON.stringify(p)).not.toContain('10871');
    expect(anomalyPayload({ indicator_id: 1 }, 'oct').prev).toBeUndefined();
  });
  it('applyExplanations จับคู่ด้วย index ของคำขอ — ไม่มีคำอธิบาย = ข้อความว่าง', () => {
    const out = applyExplanations([row(1), row(2)], [{ index: 1, text: 'อาจพิมพ์เกินหลัก', hints: ['ถ้าหารด้วย 10 = 85'] }]);
    expect(out.map(r => [r.aiDone, r.aiText, r.hints])).toEqual([[true, '', []], [true, 'อาจพิมพ์เกินหลัก', ['ถ้าหารด้วย 10 = 85']]]);
  });
});

describe('AiAnomalyExplainComponent', () => {
  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [AiAnomalyExplainComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  it('เปิดแล้วขอคำอธิบายทันที (ไม่เกิน 20 ช่อง) แสดงเป็นข้อความล้วน + ป้ายเตือน', () => {
    const f = TestBed.createComponent(AiAnomalyExplainComponent);
    f.componentInstance.rows = Array.from({ length: AI_ANOMALY_MAX + 3 }, (_, i) => row(i + 1));
    f.detectChanges();
    const req = http.expectOne(r => r.url.endsWith('/ai/anomaly-explain'));
    expect(req.request.body.items).toHaveLength(AI_ANOMALY_MAX);
    expect(req.request.body.refresh).toBe(false);
    req.flush({ success: true, model: 'mock', cached: false, explanations: [{ index: 0, text: '<b>อาจ</b>พิมพ์เกินหลัก', hints: ['ถ้าหารด้วย 10 = 85'] }] });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('<b>อาจ</b>พิมพ์เกินหลัก');   // ไม่ตีความ HTML
    expect(el.textContent).toContain('ข้อความจาก AI');
    expect(el.textContent).toContain('ข้อสังเกตจากระบบ: ถ้าหารด้วย 10 = 85');
    expect(el.textContent).toContain('แสดง 20 ช่องแรกจาก 23 ช่อง');
    expect(el.textContent).toContain('AI ไม่ได้อธิบายช่องนี้');
  });

  it('ข้อผิดพลาดจาก server แสดงข้อความ + ปิดหน้าต่างได้', () => {
    const f = TestBed.createComponent(AiAnomalyExplainComponent);
    f.componentInstance.rows = [row(1)];
    let closed = 0;
    f.componentInstance.close.subscribe(() => closed++);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/anomaly-explain')).flush({ success: false, message: 'ผู้ช่วย AI ยังไม่เปิดใช้งาน' }, { status: 503, statusText: 'x' });
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('ผู้ช่วย AI ยังไม่เปิดใช้งาน');
    f.componentInstance.close.emit();
    expect(closed).toBe(1);
  });
});
