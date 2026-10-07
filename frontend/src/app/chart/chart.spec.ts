import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { ChartComponent } from './chart';
import { testProviders } from '../testing/test-providers';
import { buildPctBar, buildHeatmap, buildMonthlyCombo, buildOverallDonut, pctColor, wrapLabel, ChartGroupRow } from './chart-builders';

const row = (gkey: any, gname: string, with_target: number, passed: number, no_target = 0): ChartGroupRow => ({
  gkey, gname, pairs: with_target + no_target, with_target, passed, not_passed: with_target - passed, no_target,
  achievement_pct: with_target ? Math.round(passed / with_target * 10000) / 100 : 0, recording_pct: 100,
  indicator_count: 1, hospital_count: 1, pending_pairs: 0,
});
const month = (label: string, recorded: number, eligible: number, passed: number) =>
  ({ month: label, label, recorded, eligible, passed, pass_pct: eligible ? Math.round(passed / eligible * 10000) / 100 : 0, recording_pct: 100 });

describe('chart-builders', () => {
  it('buildPctBar ใช้ร้อยละผ่านเกณฑ์แบบนับคู่ และตัดกลุ่มที่ไม่มีเป้าหมายออก', () => {
    const o = buildPctBar([row(1, 'A', 4, 3), row(2, 'B', 0, 0, 5)], 't');
    expect(o.series[0].data).toEqual([75]);
    expect(o.xaxis.categories).toEqual([['A']]);
    expect(o.colors).toEqual([pctColor(75)]);
  });

  it('buildPctBar คลิกแท่ง → ส่งแถวที่ถูกต้องกลับ (เจาะลึก)', () => {
    let picked: any = null;
    const rows = [row(1, 'A', 0, 0, 1), row(7, 'B', 2, 2)];
    const o = buildPctBar(rows, 't', r => picked = r);
    o.chart.events.dataPointSelection(null, null, { dataPointIndex: 0 });
    expect(picked.gkey).toBe(7); // index 0 ของกราฟ = แถวแรกที่มีเป้าหมาย ไม่ใช่แถวแรกของ input
  });

  it('wrapLabel: ชื่อยาวที่ขึ้นต้นเหมือนกันยังแยกออก (ไม่ตัดทิ้งเหลือบรรทัดเดียว)', () => {
    const a = wrapLabel('อำเภอที่ผ่านเกณฑ์การใช้ยาอย่างสมเหตุผล (RDU District) ระดับ 1 ภาพรวม');
    const b = wrapLabel('อำเภอที่ผ่านเกณฑ์การใช้ยาอย่างสมเหตุผล (RDU District) ระดับ 2 ภาพรวม');
    expect(a.length).toBeGreaterThan(1);
    expect(a.join(' ')).not.toBe(b.join(' '));
    expect(wrapLabel('x'.repeat(500)).length).toBe(3);
    expect(wrapLabel('x'.repeat(500))[2].endsWith('…')).toBe(true);
  });

  it('pctColor ตามเกณฑ์ 80 / 50', () => {
    expect(pctColor(80)).toBe(pctColor(100));
    expect(pctColor(79.99)).not.toBe(pctColor(80));
    expect(pctColor(49.99)).not.toBe(pctColor(50));
  });

  it('buildHeatmap: เดือนที่ไม่มีข้อมูลเป็น -1 (แยกจาก 0% จริง) และแถวแรกอยู่บนสุด', () => {
    const months = [month('ต.ค.', 2, 2, 0), month('พ.ย.', 0, 0, 0)];
    const o = buildHeatmap([{ gname: 'X', months }, { gname: 'Y', months }], 't', 'pass');
    expect(o.series.map((s: any) => s.name)).toEqual(['Y', 'X']);
    expect(o.series[0].data.map((d: any) => d.y)).toEqual([0, -1]);
  });

  it('buildMonthlyCombo: เดือนที่ไม่มีคู่เทียบเกณฑ์ได้ → null (ไม่ลากเส้นเป็น 0)', () => {
    const o = buildMonthlyCombo([month('ต.ค.', 3, 2, 1), month('พ.ย.', 1, 0, 0)]);
    expect(o.series[1].data).toEqual([50, null]);
    expect(buildMonthlyCombo([month('ต.ค.', 0, 0, 0)]).series).toEqual([]);
  });

  it('buildOverallDonut ไม่มีข้อมูล → series ว่าง', () => {
    expect(buildOverallDonut(null).series).toEqual([]);
    expect(buildOverallDonut(row(0, 'all', 4, 3, 1)).series).toEqual([3, 1, 1]);
  });
});

describe('ChartComponent', () => {
  let component: ChartComponent;
  let fixture: ComponentFixture<ChartComponent>;
  let http: HttpTestingController;

  const response = (years: string[], extra: any = {}) => ({
    success: true, year_bh: years[0] || '',
    options: { years, yuts: [], mains: [{ id: 1, name: 'M1', yut_id: 9 }, { id: 2, name: 'M2', yut_id: 8 }], depts: [], indicators: [], districts: [], hostypes: [] },
    overall: row(0, 'all', 4, 3), monthly: [], by_yut: [], by_main: [], by_dept: [], by_indicator: [], by_district: [], by_hostype: [],
    heatmap_main: [], heatmap_dept: [], distribution: [], ...extra,
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChartComponent], providers: testProviders }).compileComponents();
    fixture = TestBed.createComponent(ChartComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('ปีงบปัจจุบันยังไม่มีข้อมูล → ถอยไปปีล่าสุดที่มีข้อมูลอัตโนมัติ', () => {
    component.selectedYear = '2599';
    component.loadChartStats(true);
    http.expectOne(r => r.url.includes('/report/chart-stats') && r.url.includes('year_bh=2599')).flush(response(['2569', '2568']));
    expect(component.selectedYear).toBe('2569');
    http.expectOne(r => r.url.includes('year_bh=2569')).flush(response(['2569', '2568']));
    expect(component.data.year_bh).toBe('2569');
  });

  it('ส่งตัวกรองทุกมิติไปที่ API และเปลี่ยนยุทธศาสตร์แล้วล้างหมวดหมู่/ตัวชี้วัด', () => {
    component.selectedYear = '2569';
    component.selectedMain = '1'; component.selectedIndicator = '5';
    component.selectedYut = '9';
    component.onFilterChange('selectedYut');
    const req = http.expectOne(r => r.url.includes('/report/chart-stats'));
    expect(req.request.url).toContain('yut_id=9');
    expect(req.request.url).not.toContain('main_id');
    expect(req.request.url).not.toContain('indicator_id');
  });

  it('ตัวเลือกหมวดหมู่กรองตามยุทธศาสตร์ที่เลือก', () => {
    component.options = response(['2569']).options;
    component.selectedYut = '8';
    expect(component.mainOptions.map(m => m.name)).toEqual(['M2']);
  });

  it('ผลของคำขอเก่าที่มาช้ากว่าถูกทิ้ง (ไม่ทับผลล่าสุด)', () => {
    component.selectedYear = '2569';
    component.loadChartStats();
    component.loadChartStats();
    const reqs = http.match(r => r.url.includes('/report/chart-stats'));
    reqs[1].flush(response(['2569'], { year_bh: 'ใหม่' }));
    reqs[0].flush(response(['2569'], { year_bh: 'เก่า' }));
    expect(component.data.year_bh).toBe('ใหม่');
  });
});
