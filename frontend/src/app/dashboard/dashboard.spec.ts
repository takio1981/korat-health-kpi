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

  // การตั้งค่าคอลัมน์หน่วงการบันทึกด้วย timer — ล้างทิ้งหลังแต่ละ test กันยิง API หลัง TestBed ถูกทำลาย
  afterEach(() => clearTimeout((component as any)._saveColumnsTimer));

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

  // Regression (11 ต.ค. 2569): ผลงานจากตัวชี้วัดย่อยต้องหารด้วยจำนวนข้อย่อยทั้งหมด (ข้อที่ไม่ได้บันทึก = 0)
  // เดิมหารเฉพาะข้อที่มีการบันทึก → บันทึก 2 จาก 3 ข้อ (90, 60) ได้ 75 แทน 50
  it('สรุปในหน้าต่างบันทึกผลงานย่อย หารด้วยจำนวนข้อย่อยทั้งหมด', () => {
    component.subResultList = [
      { _target: '100', _actuals: { 10: '90', 11: '' } },
      { _target: '80', _actuals: { 10: '60', 11: '' } },
      { _target: '60', _actuals: { 10: '', 11: '' } },
    ];
    const sum = component.getSubModalAverage();
    expect(sum.avgActual).toBe('50');
    expect(sum.avgTarget).toBe('80');
    expect(sum.avgPct).toBe('62.50');

    // เดือนล่าสุดที่มีข้อใดข้อหนึ่งบันทึก = เดือนที่ใช้ และยังหารด้วย 3
    component.subResultList[2]._actuals[11] = '30';
    expect(component.getSubModalAverage().avgActual).toBe('10');
  });

  it('ยังไม่มีข้อย่อยใดบันทึกเลย → ผลงานแสดง "-" (ไม่ใช่ 0)', () => {
    component.subResultList = [{ _target: '100', _actuals: {} }, { _target: '100', _actuals: {} }];
    expect(component.getSubModalAverage().avgActual).toBe('-');
  });

  // ---- เพิ่มตัวชี้วัดให้หน่วยบริการ (11 ต.ค. 2569) ----
  describe('หน้าต่างเพิ่มตัวชี้วัดให้หน่วยบริการ', () => {
    const tpl = (id: number, extra: any = {}) => ({
      indicator_id: id, kpi_indicators_name: 'ตัวชี้วัด ' + id, main_indicator_name: 'หมวด ก', dept_id: 1, dept_name: 'กลุ่มงาน ก',
      target_percentage: '80', table_process: 'kpi_t_' + id, ...extra,
    });
    const item = (id: number) => component.newKpiList.find((i: any) => Number(i.indicator_id) === id);

    beforeEach(() => {
      fixture.detectChanges();
      component.isAdmin = true;
      component.isLocalAdmin = false;
      component.kpiData = [];
      component.hosTypeList = component._allHosTypes = [
        { hostypecode: '07', hostypename: 'โรงพยาบาลชุมชน' }, { hostypecode: '18', hostypename: 'รพ.สต.' },
      ];
      component.addKpiHospitalList = [
        { hoscode: 'A', hosname: 'รพ.ก', hostype: '07', distid: '3001' },
        { hoscode: 'B', hosname: 'รพ.สต.ข', hostype: '18', distid: '3001' },
        { hoscode: 'C', hosname: 'รพ.สต.ค', hostype: '18', distid: '3002' },
      ];
      component.addKpiFilteredHospitals = [...component.addKpiHospitalList];
      component.addKpiSelHospcodes = [];
      component.addKpiSelHosTypes = [];
      component.addKpiSelDistricts = [];
      component.addKpiSelDepts = [];
      component.addKpiSelectedYear = '2570';
      component.addKpiSelectedIds = new Set<number>();
      component.newKpiList = [];
      (component as any)._addKpiDefaultAll = false;
      (component as any)._addKpiTemplate = [
        tpl(1, { evaluation_mode: 'any_one', required_off_types: '["18"]', result_formula: 'SUM(ALL)' }),
        tpl(2, { evaluation_mode: 'all_required' }),
        tpl(3, { evaluation_mode: 'any_one', required_off_types: '["07"]', kpi_indicators_name: 'อัตราการคัดกรอง' }),
      ];
      component.showAddModal = true;
      component.loadAddKpiList();
    });

    // เดิม: เปิดมาติ๊กทุกตัวให้ → ผู้ดูแลกดบันทึกแล้วเพิ่มทุกตัวชี้วัดให้ทุกหน่วยบริการโดยไม่ตั้งใจ
    it('ผู้ดูแล: เริ่มจากไม่เลือกตัวชี้วัดใด และยังไม่จำกัดประเภทหน่วยบริการ', () => {
      expect(component.newKpiList.length).toBe(3);
      expect(component.addKpiSelectedIds.size).toBe(0);
      expect(component.addKpiAllowedHostypes).toBeNull();
      expect(component.addKpiHosTypeOptions.length).toBe(2);
    });

    // เดิม: รายการหน่วยบริการไม่สนใจประเภทที่ตั้งไว้ในตัวชี้วัด — เลือก รพ. ให้ตัวชี้วัดของ รพ.สต. ได้
    it('เลือกตัวชี้วัด → รายการหน่วยบริการ/ตัวกรองประเภทเหลือเฉพาะประเภทที่ตั้งไว้ และตัดหน่วยบริการที่ไม่ตรงออกจากที่เลือก', () => {
      component.addKpiSelHospcodes = ['A', 'B'];
      component.toggleAddKpi(item(1));
      expect(component.addKpiAllowedHostypes).toEqual(['18']);
      expect(component.addKpiFilteredHospitals.map((h: any) => h.hoscode)).toEqual(['B', 'C']);
      expect(component.addKpiSelHospcodes).toEqual(['B']);
      expect(component.addKpiHosTypeOptions.map((h: any) => h.hostypecode)).toEqual(['18']);
      expect(component.addKpiAllowedHostypeNames()).toBe('รพ.สต.');

      // เลือกเพิ่มตัวที่ใช้ได้ทุกประเภท → กลับมาไม่จำกัด
      component.toggleAddKpi(item(2));
      expect(component.addKpiAllowedHostypes).toBeNull();
      expect(component.addKpiFilteredHospitals.length).toBe(3);
    });

    it('เลือกหน่วยบริการก่อน → ซ่อนตัวชี้วัดที่ไม่ได้ตั้งไว้สำหรับประเภทของหน่วยบริการนั้น', () => {
      component.addKpiSelHospcodes = ['A'];   // รพช. (07)
      component.onAddKpiHospitalChange();
      expect(component.newKpiList.map((i: any) => i.indicator_id)).toEqual([2, 3]);
      expect(component.addKpiTypeHiddenCount).toBe(1);
    });

    it('เปลี่ยนตัวกรองแล้วคงค่าที่กรอกและรายการที่ติ๊กไว้ + ค้นหาตัวชี้วัดได้', () => {
      component.toggleAddKpi(item(2));
      item(2).target_value = '55';
      component.addKpiSelHospcodes = ['B', 'C'];
      component.onAddKpiHospitalChange();
      expect(item(2).target_value).toBe('55');          // เดิม: โหลดใหม่แล้วค่ากลับเป็น 80
      expect(component.isAddKpiSelected(item(2))).toBe(true);

      component.addKpiSelHospcodes = [];
      component.onAddKpiHospitalChange();
      component.addKpiSearch = 'คัดกรอง';
      expect(component.filteredNewKpiList.map((i: any) => i.indicator_id)).toEqual([3]);
      component.addKpiSearch = 'KPI_T_1';
      expect(component.filteredNewKpiList.map((i: any) => i.indicator_id)).toEqual([1]);
    });

    it('แสดงป้ายสูตรในรายการ และซ่อนช่องผลงานรายเดือนเป็นค่าเริ่มต้น', () => {
      fixture.detectChanges();
      const title = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('h3')).find(h => (h.textContent || '').includes('เพิ่มตัวชี้วัดให้หน่วยบริการ'))!;
      const el = title.closest('.fixed') as HTMLElement;   // เฉพาะหน้าต่างเพิ่มตัวชี้วัด (ตารางหลักมีหัวเดือนอยู่แล้ว)
      expect(el.querySelector('app-formula-badge i.fa-calculator')).toBeTruthy();
      expect(el.textContent).toContain('SUM(ALL)');
      expect(el.textContent).not.toContain('ต.ค.');
      component.addKpiShowMonths = true;
      (component as any).cdr.detectChanges();
      expect(el.textContent).toContain('ต.ค.');
    });
  });

  it('ป้าย "สูตร" ในตารางหลักแนบตัวสูตรไว้แสดงต่อท้าย', () => {
    const badge = component.getCumulativeBadge({ result_formula: 'SUM(ALL)' });
    expect(badge?.formula).toBe('SUM(ALL)');
    expect(component.getCumulativeBadge({ is_cumulative: 1 })?.formula).toBeUndefined();
  });
});
