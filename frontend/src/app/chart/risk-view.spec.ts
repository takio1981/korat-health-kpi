import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { RiskViewComponent, filterRiskItems, riskOptions } from './risk-view';

// แท็บตัวชี้วัดเสี่ยง (ระบบเตือนล่วงหน้า ระยะที่ 2 — 8 พ.ย. 2569)
const items = [
  { indicator_id: 1, indicator_name: 'อัตราตาย', hospcode: '10871', hosname: 'รพ.ก', distid: '3001', distname: 'เมือง', zone: '1', dept_id: 5, dept_name: 'NCD', yut_id: 2, yut_name: 'PP', status: 'high', projected: '40', target: '80', condition: 'GTE', pct: 50, confidence: 'medium', last_actual: '45', last_month: 'มี.ค.' },
  { indicator_id: 2, indicator_name: 'ร้อยละคัดกรอง', hospcode: '10872', hosname: 'รพ.ข', distid: '3002', distname: 'ครบุรี', zone: '2', dept_id: 6, dept_name: 'ส่งเสริม', yut_id: null, yut_name: null, status: 'watch', projected: '75', target: '80', condition: 'GTE', pct: 93.75, confidence: 'high', last_actual: '76', last_month: 'มี.ค.' },
  { indicator_id: 3, indicator_name: 'อุบัติเหตุ', hospcode: '10873', hosname: 'รพ.ค', distid: '3001', distname: 'เมือง', zone: '1', dept_id: 5, dept_name: 'NCD', yut_id: 2, yut_name: 'PP', status: 'no_report', missing_months: 3, projected: null, target: null, pct: null, confidence: null, last_actual: '1', last_month: 'ธ.ค.' },
];
const response = (extra: any = {}) => ({
  success: true, year_bh: '2570', through: 5, natural_through: 5, through_label: 'มี.ค.', year_closed: false, watch_pct: 10,
  pairs: 10, forecastable: 6, risk_pct: 33.33, counts: { high: 1, watch: 1, no_report: 1, normal: 4, insufficient: 3 },
  items, by_indicator: [{ indicator_id: 1, name: 'อัตราตาย', high: 1, watch: 0, no_report: 0 }], truncated: false, total_items: 3, ...extra,
});

describe('risk-view helpers', () => {
  const none = { status: '', yut: '', dept: '', zone: '', district: '', search: '' };
  it('filterRiskItems กรองตามระดับ/ยุทธศาสตร์ (ไม่ระบุ = 0)/หน่วยงาน/โซน/อำเภอ/คำค้น', () => {
    expect(filterRiskItems(items, { ...none, status: 'high' }).map(i => i.indicator_id)).toEqual([1]);
    expect(filterRiskItems(items, { ...none, yut: '0' }).map(i => i.indicator_id)).toEqual([2]);
    expect(filterRiskItems(items, { ...none, zone: '1', district: '3001' }).map(i => i.indicator_id)).toEqual([1, 3]);
    expect(filterRiskItems(items, { ...none, search: 'รพ.ข' }).map(i => i.indicator_id)).toEqual([2]);
    expect(filterRiskItems(items, { ...none, search: '10873' }).map(i => i.indicator_id)).toEqual([3]);
  });
  it('riskOptions ไม่ซ้ำ + ไม่ระบุยุทธศาสตร์', () => {
    const o = riskOptions(items);
    expect(o.yuts.map(x => x.label).sort()).toEqual(['PP', 'ไม่ระบุยุทธศาสตร์'].sort());
    expect(o.districts.length).toBe(2);
    expect(o.zones.map(x => x.id)).toEqual(['1', '2']);
  });
});

describe('RiskViewComponent', () => {
  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [RiskViewComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  it('โหลดปีงบปัจจุบัน แสดงการ์ดระดับ + ตาราง + ร้อยละที่คาด — กดการ์ดเพื่อกรอง', () => {
    const f = TestBed.createComponent(RiskViewComponent);
    f.detectChanges();
    const req = http.expectOne(r => r.url.includes('/report/forecast'));
    expect(req.request.url).toContain('year_bh=');
    req.flush(response());
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.textContent).toContain('ใช้ข้อมูลถึงเดือน มี.ค.');
    expect(el.textContent).toContain('33.33%');
    expect(el.querySelectorAll('tbody tr').length).toBe(3);
    expect(el.textContent).toContain('ว่าง 3 เดือน');
    expect(el.textContent).toContain('≥ 80');
    (el.querySelector('[data-status="high"]') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
  });

  // พบจากการทดสอบหน้าจอ: ปีงบที่ปิดแล้วแต่ดู ณ มี.ค. เดิมขึ้น "= ผลจริง" ทั้งที่ใช้ข้อมูลถึง มี.ค. เท่านั้น
  it('ปีงบที่ปิดแล้ว: ดู ณ เดือน = ย้อนดู (ไม่ใช่ผลจริง) | ข้อมูลล่าสุด = ผลจริง', () => {
    const f = TestBed.createComponent(RiskViewComponent);
    f.detectChanges();
    http.expectOne(r => r.url.includes('/report/forecast')).flush(response({ year_closed: true, natural_through: 11, through: 5 }));
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('ย้อนดู — ใช้ข้อมูลถึงเดือนนี้เท่านั้น');
    expect((f.nativeElement as HTMLElement).textContent).not.toContain('= ผลจริง');
    f.componentInstance.load();
    http.expectOne(r => r.url.includes('/report/forecast')).flush(response({ year_closed: true, natural_through: 11, through: 11, through_label: 'ก.ย.' }));
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('ปีงบสิ้นสุดแล้ว = ผลจริง');
  });

  it('เปลี่ยน "ดู ณ เดือน" → ส่ง through | ยังคาดการณ์ไม่ได้ = แนะนำให้ย้อนดูปีงบที่แล้ว', () => {
    const f = TestBed.createComponent(RiskViewComponent);
    f.detectChanges();
    http.expectOne(r => r.url.includes('/report/forecast')).flush(response({ forecastable: 0, items: [], risk_pct: null }));
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('ต้องมีผลงานอย่างน้อย 3 เดือน');
    expect(f.componentInstance.throughOptions.map(o => o.label)).toEqual(['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.']);
    expect((f.nativeElement as HTMLElement).textContent).not.toContain('ย้อนดู — ใช้ข้อมูล');
    f.componentInstance.through = '2';
    f.componentInstance.load();
    expect(http.expectOne(r => r.url.includes('/report/forecast')).request.url).toContain('through=2');
  });
});
