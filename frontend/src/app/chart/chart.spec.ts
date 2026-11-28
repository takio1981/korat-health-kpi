import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { ChartComponent, sortRecRows } from './chart';
import { buildQualityBars, buildRecordDonut, buildMonthlyRecording, buildCompletenessHeatmap, RecRow } from './recording-builders';
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

// ===== แถบกราฟและสถิติ = รายงานการบันทึกผลงาน (28 พ.ย. 2569 — แทนกราฟผ่าน/ไม่ผ่านเกณฑ์) =====
const rec = (gkey: any, gname: string, pairs: number, recorded: number, extra: Partial<RecRow> = {}): RecRow => ({
  gkey, gname, pairs, recorded_pairs: recorded, not_recorded_pairs: pairs - recorded, recording_pct: pairs ? Math.round(recorded / pairs * 10000) / 100 : 0,
  due_cells: pairs, filled_due_cells: recorded, completeness_pct: pairs ? Math.round(recorded / pairs * 10000) / 100 : null,
  filled_cells: recorded, timed_cells: recorded, ontime_cells: recorded, timeliness_pct: recorded ? 100 : null,
  approved_cells: 0, pending_cells: recorded, returned_cells: 0, approved_pct: recorded ? 0 : null, anomaly_cells: 0,
  indicator_count: 1, hospital_count: pairs, ...extra,
});
const months = () => ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'].map((label, i) => ({
  month: 'm' + i, label, is_due: i === 0, due_pairs: i === 0 ? 4 : 0, filled_due_pairs: i === 0 ? 3 : 0, filled_pairs: i === 0 ? 3 : 0,
  completeness_pct: i === 0 ? 75 : null, filled_cells: i === 0 ? 3 : 0, timed_cells: i === 0 ? 3 : 0, ontime_cells: i === 0 ? 2 : 0, timeliness_pct: i === 0 ? 66.67 : null,
}));

describe('recording-builders', () => {
  it('buildQualityBars: 3 ชุด (บันทึก/ครบถ้วน/ทันเวลา) ตัดกลุ่มที่ไม่มีคู่ และคลิกแท่ง = ส่งแถวกลับ', () => {
    const picked: any[] = [];
    const o = buildQualityBars([rec('1', 'ก', 4, 3), rec('2', 'ข', 0, 0)], 't', r => picked.push(r));
    expect(o.series.map((x: any) => x.name)).toEqual(['ร้อยละหน่วยบริการที่บันทึก', 'ความครบถ้วนรายเดือน', 'ความทันเวลา']);
    expect(o.series[0].data).toEqual([75]);
    o.chart.events.dataPointSelection(null, null, { dataPointIndex: 0 });
    expect(picked[0].gname).toBe('ก');
    expect(buildQualityBars([], 't').series).toEqual([]);
  });
  it('buildRecordDonut: บันทึกแล้ว/ยังไม่บันทึก | ไม่มีข้อมูล = ว่าง', () => {
    expect(buildRecordDonut(rec('all', 'ทั้งหมด', 4, 3)).series).toEqual([3, 1]);
    expect(buildRecordDonut(null).series).toEqual([]);
  });
  it('buildMonthlyRecording: เดือนที่ยังไม่ถึงกำหนด = null (ไม่ลากเส้นเป็น 0)', () => {
    const o = buildMonthlyRecording(months());
    expect(o.series[1].data[0]).toBe(75);
    expect(o.series[1].data[5]).toBeNull();
  });
  it('buildCompletenessHeatmap: เดือนที่ไม่มีคู่ = -1 (เทา) แถวแรกอยู่บนสุด', () => {
    const o = buildCompletenessHeatmap([{ gname: 'ก', months: [{ label: 'ต.ค.', due: 2, filled: 1, pct: 50 }, { label: 'พ.ย.', due: 0, filled: 0, pct: null }] },
      { gname: 'ข', months: [{ label: 'ต.ค.', due: 1, filled: 1, pct: 100 }, { label: 'พ.ย.', due: 0, filled: 0, pct: null }] }], 't');
    expect(o.series[1].name).toBe('ก');
    expect(o.series[1].data.map((d: any) => d.y)).toEqual([50, -1]);
  });
  it('sortRecRows: ค้นหาทุกคำ + เรียงตัวเลข (null น้อยสุด)', () => {
    const rows = [rec('1', 'ร้อยละเบาหวาน', 4, 1, { completeness_pct: null }), rec('2', 'อัตราวัณโรค', 4, 4), rec('3', 'ร้อยละความดัน', 4, 2)];
    expect(sortRecRows(rows, 'recording_pct', 1).map(r => r.gkey)).toEqual(['1', '3', '2']);
    expect(sortRecRows(rows, 'completeness_pct', 1)[0].gkey).toBe('1');
    expect(sortRecRows(rows, 'recording_pct', -1, 'ร้อยละ').map(r => r.gkey)).toEqual(['3', '1']);
  });
});

describe('ChartComponent (รายงานการบันทึกผลงาน)', () => {
  let component: ChartComponent;
  let fixture: ComponentFixture<ChartComponent>;
  let http: HttpTestingController;
  const response = (years: string[], extra: any = {}) => ({
    success: true, year_bh: years[0] || '', through: 0, through_label: 'ต.ค.', due_day: 10,
    options: { years, yuts: [], mains: [{ id: '1', name: 'M1', yut_id: 9 }, { id: '2', name: 'M2', yut_id: 8 }], depts: [], indicators: [], districts: [], zones: [], hostypes: [] },
    overall: rec('all', 'ทั้งหมด', 4, 3), months: months(), by_dept: [rec('5', 'กลุ่มงานควบคุมโรค', 4, 3)], by_main: [], by_yut: [],
    by_indicator: [rec(11, 'ร้อยละเบาหวาน', 2, 1, { dept_name: 'ก' }), rec(12, 'อัตราวัณโรค', 2, 2, { dept_name: 'ก' })],
    by_district: [], by_zone: [], by_hostype: [], by_itype: [rec('r9', 'R9 เขต 9', 4, 3), rec('moph', 'MOPH กระทรวง', 0, 0)],
    by_hospital: [rec('H1', 'รพ.ก', 2, 2, { hospcode: '10669' }), rec('H2', 'รพ.ข', 2, 1, { hospcode: '10670' })],
    hospital_distribution: [{ key: '0', label: '0%', count: 0 }], heatmap_dept: [], ...extra,
  });
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ChartComponent], providers: testProviders }).compileComponents();
    fixture = TestBed.createComponent(ChartComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  it('ใช้ /report/recording-stats + ปีงบปัจจุบันยังไม่มีข้อมูล → ถอยไปปีล่าสุด (template วาดใหม่ทันที)', () => {
    component.selectedYear = '2599';
    fixture.detectChanges();
    component.loadStats(true);
    http.expectOne(r => r.url.includes('/report/recording-stats') && r.url.includes('year_bh=2599')).flush(response(['2569', '2568']));
    expect(component.selectedYear).toBe('2569');
    expect(() => fixture.checkNoChanges()).not.toThrow();
    http.expectOne(r => r.url.includes('year_bh=2569')).flush(response(['2569']));
    expect(component.data.year_bh).toBe('2569');
  });

  it('การ์ด/ตาราง/กราฟแสดงข้อมูลการบันทึก — ไม่มีคำว่าผ่านเกณฑ์', () => {
    component.selectedYear = '2569';
    fixture.detectChanges();
    component.loadStats();
    for (let k = 0; k < 4; k++) http.match(() => true).forEach(r => r.flush(r.request.url.includes('/report/recording-stats') ? response(['2569']) : { success: true, data: [] }));
    (component as any).cdr.markForCheck(); fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#rec-cards')?.textContent).toContain('75%');
    expect(el.querySelector('#rec-cards')?.textContent).toContain('ต.ค.');
    expect(el.querySelectorAll('#rec-dept-table tr[data-dept]').length).toBe(1);
    expect(el.querySelectorAll('#rec-ind-table tr[data-ind]').length).toBe(2);
    expect(el.querySelectorAll('#rec-hos-table tr[data-hos]').length).toBe(2);
    expect(component.indicatorRows[0].gkey).toBe(11);              // บันทึกน้อยสุดก่อน
    expect(el.querySelector('#rec-method')?.textContent).toContain('ไม่ได้ประเมินว่าผ่านหรือไม่ผ่านเกณฑ์');
    expect(component.deptBars.series.length).toBe(3);
  });

  it('ส่งตัวกรองไป API + เปลี่ยนยุทธศาสตร์ล้างหมวดหมู่/ตัวชี้วัด + ผลคำขอเก่าที่ช้ากว่าถูกทิ้ง', () => {
    component.selectedYear = '2569';
    component.selectedMain = '1'; component.selectedIndicator = '5'; component.selectedYut = '9';
    component.onFilterChange('selectedYut');
    const req = http.expectOne(r => r.url.includes('/report/recording-stats'));
    expect(req.request.url).toContain('yut_id=9');
    expect(req.request.url).not.toContain('main_id');
    expect(req.request.url).not.toContain('indicator_id');
    component.loadStats(); component.loadStats();
    const reqs = http.match(r => r.url.includes('/report/recording-stats'));
    reqs[1].flush(response(['2569'], { year_bh: 'ใหม่' }));
    reqs[0].flush(response(['2569'], { year_bh: 'เก่า' }));
    expect(component.data.year_bh).toBe('ใหม่');
  });

  it('คลิกแถวตัวชี้วัด/การ์ดประเภทตัวชี้วัด/อำเภอบนแผนที่ = กรองเจาะลึก', () => {
    component.selectedYear = '2569';
    component.loadStats();
    http.expectOne(r => r.url.includes('/report/recording-stats')).flush(response(['2569'], { by_district: [rec('3001', 'เมืองนครราชสีมา', 10, 9)] }));
    expect(component.districtMapData[0]).toEqual(expect.objectContaining({ id: '3001', pct: 90, passed: 9, total: 10 }));
    component.drillDown('selectedIndicator', '12');
    expect(http.expectOne(r => r.url.includes('indicator_id=12')).request.url).toContain('/report/recording-stats');
    component.pickItype('r9');
    http.expectOne(r => r.url.includes('itype=r9')).flush(response(['2569']));
    expect(component.activeFilterChips.some(c => c.label === 'ประเภทตัวชี้วัด')).toBe(true);
    component.onMapPick('3001');
    expect(http.expectOne(r => r.url.includes('/report/recording-stats')).request.url).toContain('distid=3001');
  });

  it('ตารางหน่วยบริการ: ค้นหา + แสดง 20/ทั้งหมด', () => {
    component.selectedYear = '2569';
    component.loadStats();
    const many = Array.from({ length: 25 }, (_, i) => rec('H' + i, 'รพ.' + i, 2, i % 3, { hospcode: String(10000 + i) }));
    http.expectOne(r => r.url.includes('/report/recording-stats')).flush(response(['2569'], { by_hospital: many }));
    expect(component.hospitalRows.length).toBe(20);
    expect(component.hospitalTotal).toBe(25);
    component.toggleHospitalAll();
    expect(component.hospitalRows.length).toBe(25);
    component.hospitalSearch = '10024'; component.onHospitalSearch();
    expect(component.hospitalRows.map(r => r['hospcode'])).toEqual(['10024']);
  });
});
