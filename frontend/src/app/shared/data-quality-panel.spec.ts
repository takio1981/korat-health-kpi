import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { DataQualityPanelComponent, filterIssues } from './data-quality-panel';

// แผงตรวจคุณภาพข้อมูล (ผู้ช่วย AI ระยะที่ 5 — 8 พ.ย. 2569) — หน้าจัดการข้อมูลผลงาน
const scanRes = (total: number) => ({
  success: true, year_bh: '2570', total, truncated: false,
  scanned: { indicators: 3, pairs: 4, cells: 20 },
  counts: { negative: total ? 1 : 0, high: total ? 1 : 0, low: 0, text: 0, pct_over: 0 },
  issues: total ? [
    { kind: 'negative', kind_label: 'ค่าติดลบ', indicator_name: 'ก', hospcode: '10871', hosname: 'รพ.ก', month_name: 'ต.ค.', value: '-5', message: 'ค่าติดลบ' },
    { kind: 'high', kind_label: 'สูงผิดปกติ', indicator_name: 'ข', hospcode: '10872', hosname: 'รพ.ข', month_name: 'ธ.ค.', value: '850', message: 'สูงกว่า' },
  ] : [],
});

describe('data-quality-panel', () => {
  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [DataQualityPanelComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  const make = (enabled: boolean) => {
    const f = TestBed.createComponent(DataQualityPanelComponent);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled });
    f.detectChanges();
    return f;
  };
  const scan = (f: any, total: number) => {
    f.componentInstance.yearBh = '2570';
    f.componentInstance.scan();
    const req = http.expectOne((r: any) => r.url.includes('/kpi-results/manage/data-quality'));
    expect(req.request.url).toContain('year_bh=2570');
    req.flush(scanRes(total));
    f.detectChanges();
  };

  it('filterIssues กรองตามประเภท', () => {
    expect(filterIssues(scanRes(2).issues, 'high').map(i => i.value)).toEqual(['850']);
    expect(filterIssues(scanRes(2).issues, '')).toHaveLength(2);
  });

  it('ตรวจแล้วแสดงจำนวน/ตาราง — กรองตามประเภท — ปุ่ม AI แสดงเมื่อเปิดผู้ช่วยและพบรายการ', () => {
    const f = make(true);
    scan(f, 2);
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('พบที่ควรตรวจสอบ 2 ช่อง');
    expect(el.querySelectorAll('tbody tr')).toHaveLength(2);
    f.componentInstance.setKind('high');
    (f.componentInstance as any).cdr.detectChanges();
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(el.querySelector('#btn-dq-ai')).toBeTruthy();
    f.componentInstance.explain();
    const req = http.expectOne(r => r.url.endsWith('/ai/data-quality-explain'));
    expect(req.request.body).toEqual({ year_bh: '2570', refresh: false });
    req.flush({ success: true, summary: '■ ภาพรวม\n• พบค่าติดลบ <i>1</i> ช่อง', model: 'mock', cached: false });
    f.detectChanges();
    expect(el.textContent).toContain('สรุปโดย AI');
    expect(el.textContent).toContain('พบค่าติดลบ <i>1</i> ช่อง');   // ข้อความล้วน ไม่ตีความ HTML
    expect(el.textContent).toContain('ข้อความจาก AI');
  });

  it('ไม่พบรายการ = ไม่มีปุ่ม AI', () => {
    const f = make(true);
    scan(f, 0);
    expect((f.nativeElement as HTMLElement).textContent).toContain('ไม่พบค่าที่อาจผิดปกติ');
    expect((f.nativeElement as HTMLElement).querySelector('#btn-dq-ai')).toBeNull();
  });

  it('ปิดผู้ช่วย AI = ตรวจได้ แต่ไม่มีปุ่ม AI', () => {
    const g = make(false);
    scan(g, 2);
    expect((g.nativeElement as HTMLElement).textContent).toContain('พบที่ควรตรวจสอบ 2 ช่อง');
    expect((g.nativeElement as HTMLElement).querySelector('#btn-dq-ai')).toBeNull();
  });
});
