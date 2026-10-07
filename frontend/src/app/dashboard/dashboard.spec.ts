import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { DashboardComponent } from './dashboard';
import { testProviders } from '../testing/test-providers';

function row(year: string, extra: any = {}) {
  return {
    indicator_id: 1, year_bh: year, hospcode: '10871', hosname: 'รพ.ทดสอบ', distname: 'เมือง',
    dept_name: 'กลุ่มงานทดสอบ', main_indicator_name: 'หมวดทดสอบ', kpi_indicators_name: 'ตัวชี้วัดทดสอบ',
    target_value: '80', last_actual: '', pending_count: 0,
    oct: '', nov: '', dece: '', jan: '', feb: '', mar: '', apr: '', may: '', jun: '', jul: '', aug: '', sep: '',
    ...extra,
  };
}

describe('DashboardComponent', () => {
  let component: DashboardComponent;
  let fixture: ComponentFixture<DashboardComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: testProviders,
    }).compileComponents();

    fixture = TestBed.createComponent(DashboardComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // Regression (2 ต.ค. 2569): ค้นหาปีงบย้อนหลังแล้วปีงบเด้งกลับเป็นปีปัจจุบัน → แสดง 0 รายการทั้งที่มีข้อมูล
  it('ค้นหาปีงบย้อนหลังแล้วคงปีที่เลือก และแสดงข้อมูลที่โหลดมา', () => {
    component.selectedYear = '2560';
    component.loadKpiData(true);
    const req = http.expectOne(r => r.url.includes('/kpi-results'));
    expect(req.request.url).toContain('year=2560');
    req.flush({ success: true, data: [row('2560'), row('2560', { indicator_id: 2 })] });

    expect(component.selectedYear).toBe('2560');
    expect(component.filteredData.length).toBe(2);
  });

  // ตัวเลือก "รอดำเนินการ" รายเดือน (5 ต.ค. 2569)
  it('togglePending ตั้งค่า/ล้างค่า "รอดำเนินการ" และคำนวณผลงานล่าสุดใหม่', () => {
    const item = row('2569', { oct: '50' });
    component.togglePending(item, 'nov');
    expect(item.nov).toBe('รอดำเนินการ');
    expect(component.isPendingValue(item.nov)).toBe(true);
    expect(item.last_actual).toBe('รอดำเนินการ');

    component.togglePending(item, 'nov');
    expect(item.nov).toBe('');
    expect(item.last_actual).toBe('50');
  });

  it('isPendingValue ไม่นับค่าอื่นเป็นรอดำเนินการ', () => {
    expect(component.isPendingValue('50')).toBe(false);
    expect(component.isPendingValue('')).toBe(false);
    expect(component.isPendingValue(null)).toBe(false);
    expect(component.isPendingValue(' รอดำเนินการ ')).toBe(true);
  });

  // สูตรคำนวณผลงานเฉพาะตัวชี้วัด (7 ต.ค. 2569)
  it('ตัวชี้วัดที่มีสูตร: แก้ค่ารายเดือนแล้วผลงานคำนวณตามสูตร (ไม่ใช่ค่าเดือนล่าสุด)', () => {
    const item = row('2569', { result_formula: 'AVG(ALL)', oct: '10', nov: '20' });
    item.dece = '30';
    component.onValueChange(item, 'dece');
    expect(item.last_actual).toBe('20');
  });

  it('สูตรมีลำดับเหนือ is_cumulative และแสดง badge "สูตร"', () => {
    const item = row('2569', { result_formula: 'MAX(ALL)', is_cumulative: 1, oct: '10', nov: '50', dece: '20' });
    component.onValueChange(item, 'dece');
    expect(item.last_actual).toBe('50');
    expect(component.getCumulativeBadge(item)?.label).toBe('สูตร');
  });

  it('ไม่มีสูตร: ผลงาน = ค่าเดือนล่าสุดเหมือนเดิม', () => {
    const item = row('2569', { oct: '10', nov: '20', dece: '30' });
    component.onValueChange(item, 'dece');
    expect(item.last_actual).toBe('30');
    expect(component.getCumulativeBadge(item)).toBeNull();
  });

  // เลือกคอลัมน์ที่แสดง (5 ต.ค. 2569)
  it('ค่าเริ่มต้นแสดงทุกคอลัมน์และครบ 12 เดือน', () => {
    expect(component.hiddenColumnCount).toBe(0);
    expect(component.visibleMonthKeys.length).toBe(12);
  });

  it('ซ่อนเดือนแล้ว visibleMonthKeys ตัดเดือนนั้นออกตามลำดับปีงบ', () => {
    component.toggleColumn('oct');
    component.toggleColumn('main');
    expect(component.visibleMonthKeys[0]).toBe('nov');
    expect(component.visibleMonthKeys.length).toBe(11);
    expect(component.hiddenColumnCount).toBe(2);

    component.resetColumns();
    expect(component.hiddenColumnCount).toBe(0);
  });

  it('setAllMonths(false) ซ่อนทุกเดือน แต่ไม่กระทบคอลัมน์หลัก', () => {
    component.setAllMonths(false);
    expect(component.visibleMonthKeys.length).toBe(0);
    expect(component.colVisible['target']).toBe(true);
  });
});
