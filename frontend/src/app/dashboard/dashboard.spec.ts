import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { DashboardComponent } from './dashboard';
import { testProviders } from '../testing/test-providers';
import { parseImportAoa, planImport, buildTemplateAoa } from '../shared/kpi-excel';
import { parseSubImportAoa, planSubImport } from '../shared/kpi-sub-excel';
import { buildHierRows, recomputeHierRows } from './dashboard';

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
    // (12 ต.ค. 2569) ข้อที่ไม่ได้กรอกในเดือนนั้นใช้ผลงานล่าสุดของข้อนั้น: (90 + 60 + 30) / 3 = 60 — เดิมได้ 10
    expect(component.getSubModalAverage().avgActual).toBe('60');
  });

  // Regression (12 ต.ค. 2569): ไม่ต้องกรอกครบทุกข้อทุกเดือน — ข้อที่ผ่านแล้วใช้ผลงานล่าสุดของข้อนั้นไปคำนวณ
  it('ผลงานรวมรายเดือนยกยอดผลงานล่าสุดของแต่ละข้อย่อย', () => {
    component.subResultList = [
      { _target: '100', _actuals: { 10: '100' } },            // ผ่านตั้งแต่ ต.ค. ไม่กรอกอีก
      { _target: '100', _actuals: { 10: '40', 12: '70' } },    // กรอกเฉพาะเดือนที่ค่าเปลี่ยน
      { _target: '100', _actuals: { 12: '0', 1: 'รอดำเนินการ' } },
    ];
    const m = component.getSubMonthlyAggregates();
    expect(m[10]).toBeCloseTo(140 / 3, 6);
    expect(m[11]).toBeNull();                 // ไม่มีข้อใดกรอกเลย = ว่าง (ไม่ใช่ยกยอดทั้งเดือน)
    expect(m[12]).toBeCloseTo(170 / 3, 6);    // 100 (ยกยอด) + 70 + 0
    expect(m[1]).toBeNull();                  // ข้อความไม่นับเป็นการบันทึกผลงาน
    expect(component.getSubMonthAggregate(12)).toBe('56.67');
    expect(component.getSubModalAverage().avgActual).toBe('56.67');
    // กรอก 0 = ผลงานของข้อนั้นเป็น 0 จริง (ทับค่าที่ยกยอดมา)
    component.subResultList[0]._actuals[1] = '0';
    expect(component.getSubMonthlyAggregates()[1]).toBeCloseTo(70 / 3, 6);
  });

  it('ยังไม่มีข้อย่อยใดบันทึกเลย → ผลงานแสดง "-" (ไม่ใช่ 0)', () => {
    component.subResultList = [{ _target: '100', _actuals: {} }, { _target: '100', _actuals: {} }];
    expect(component.getSubModalAverage().avgActual).toBe('-');
  });

  // ---- นำเข้าผลงานตัวชี้วัดย่อยจาก Excel (12 ต.ค. 2569) ----
  describe('นำเข้า Excel ในหน้าต่างบันทึกผลงานตัวชี้วัดย่อย', () => {
    const HEAD = ['sub_indicator_id', 'hospcode', 'ปีงบประมาณ', 'รหัส', 'ตัวชี้วัดย่อย', 'เป้าหมาย', 'ต.ค.', 'พ.ย.'];
    beforeEach(() => {
      component.subResultContext = { indicator_id: 9, indicator_name: 'หลัก', hospcode: '00123', hosname: 'รพ.ก', year_bh: '2570' };
      component.subResultList = [
        { id: 1, sub_indicator_name: 'ข้อ <1>', _target: '100', _actuals: { 10: '90' } },
        { id: 2, sub_indicator_name: 'ข้อ 2', _target: '100', _actuals: {} },
        { id: 3, sub_indicator_name: 'ข้อ 3', _target: '100', _actuals: {} },
      ];
    });

    it('ไม่อยู่ในโหมดแก้ไข → ไม่นำเข้า', () => {
      component.subEditMode = false;
      component.importSubAoa([HEAD, [2, '00123', '2570', '', '', '', '', 60]]);
      expect(component.subResultList[1]._actuals[11]).toBeUndefined();
    });

    it('เติมเฉพาะช่องที่กรอก แล้วผลงานรวมรายเดือนใช้ผลงานล่าสุดของแต่ละข้อ', () => {
      const parsed = parseSubImportAoa([HEAD, [1, '00123', '2570', '', '', '', '', ''], [2, '00123', '2570', '', '', '', '', 60], [99, '00123', '2570', '', '', '', 5, 5]]);
      const p = planSubImport(parsed.rows, component.subResultList, component.subResultContext);
      const html = component.buildSubImportPreviewHtml(p, parsed.rows.length, 'a.xlsx');
      expect(html).toContain('ข้อ 2');
      expect(html).toContain('พ.ย.');
      expect(html).toContain('ข้าม — แถวที่ไม่ใช่ข้อย่อยของตัวชี้วัดนี้');
      component.applySubImportPlan(p);
      expect(component.subResultList[1]._actuals[11]).toBe('60');
      expect(component.subResultList[0]._actuals[10]).toBe('90');           // ช่องว่างในไฟล์ไม่ทับค่าเดิม
      expect(component.getSubMonthAggregate(11)).toBe('50');                 // (90 ยกมา + 60 + 0) / 3
    });

    it('ชื่อข้อย่อยในหน้าสรุปถูก escape (กัน HTML แทรก)', () => {
      const p = planSubImport(parseSubImportAoa([HEAD, [1, '00123', '2570', '', '', '', 95, '']]).rows, component.subResultList, component.subResultContext);
      const html = component.buildSubImportPreviewHtml(p, 1);
      expect(html).toContain('ข้อ &lt;1&gt;');
      expect(html).not.toContain('ข้อ <1>');
    });
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
      // เป้าหมายเริ่มต้นจากตัวชี้วัดไม่นับว่า "ถูกแก้" (เดิมทุกแถวขึ้นไฮไลต์สีเหลืองตั้งแต่เปิด) — แก้แล้วจึงไฮไลต์ และคืนค่าได้
      expect(item(2).target_value).toBe('80');
      expect(component.isAddKpiModified(item(2), 'target_value')).toBe(false);
      item(2).target_value = '70';
      expect(component.isAddKpiRowModified(item(2))).toBe(true);
      component.undoAddKpiRow(item(2));
      expect(item(2).target_value).toBe('80');

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

  // ---- นำเข้า/วางจาก Excel และเตือนค่าผิดปกติ (โหมดแก้ไข) — 11 ต.ค. 2569 ----
  describe('นำเข้า/วางจาก Excel และเตือนค่าผิดปกติ', () => {
    const paste = (text: string) => {
      let prevented = false;
      const ev: any = { clipboardData: { getData: () => text }, preventDefault: () => { prevented = true; } };
      return { ev, wasPrevented: () => prevented };
    };
    const editRow = (id: number, extra: any = {}) => {
      const it: any = row('2570', { indicator_id: id, hospcode: '10871', is_locked: 0, kpi_indicators_name: 'ตัวชี้วัด ' + id, ...extra });
      it._original = { ...it };
      return it;
    };

    beforeEach(() => {
      fixture.detectChanges();
      component.isSuperAdmin = true;             // มีสิทธิ์แก้ทั้งเป้าหมายและผลงาน
      component.isEditing = true;
      component.selectedYear = '2570';
      component.filteredData = [editRow(1, { oct: '85', nov: '88' }), editRow(2, { is_locked: 1 }), editRow(3)];
      component.prevYearMonths = new Map<string, any>();
    });

    it('วางหลายช่องจาก Excel: เติมไล่ลง/ไปทางขวาจากช่องที่วาง ข้ามแถวล็อค และคำนวณผลงานล่าสุดใหม่', () => {
      const [a, b, c] = component.filteredData;
      const p = paste('90\t91\r\n20\t21\r\n30\t31\r\n');
      component.onCellPaste(p.ev, a, 'dece');
      expect(p.wasPrevented()).toBe(true);
      expect([a.dece, a.jan]).toEqual(['90', '91']);
      expect([b.dece, b.jan]).toEqual(['', '']);          // แถวล็อค — ไม่ถูกแก้
      expect([c.dece, c.jan]).toEqual(['30', '31']);
      expect(a.last_actual).toBe('91');                   // ผลงานล่าสุด = เดือนล่าสุดที่มีค่า
      expect(component.isModified(c, 'jan')).toBe(true);
    });

    it('วางที่ช่องเป้าหมาย: คอลัมน์ถัดไปคือเดือนแรกที่แสดงอยู่ (ข้ามคอลัมน์ผลงานล่าสุด/ร้อยละ และเดือนที่ซ่อน)', () => {
      const c = component.filteredData[2];
      component.colVisible = { ...component.colVisible, oct: false };
      component.onCellPaste(paste('70\t11\t12').ev, c, 'target_value');
      expect(c.target_value).toBe('70');
      expect([c.oct, c.nov, c.dece]).toEqual(['', '11', '12']);
    });

    it('วางช่องเดียว หรือไม่ได้อยู่โหมดแก้ไข → ปล่อยให้เบราว์เซอร์วางตามปกติ', () => {
      const a = component.filteredData[0];
      const one = paste('99');
      component.onCellPaste(one.ev, a, 'dece');
      expect(one.wasPrevented()).toBe(false);
      expect(a.dece).toBe('');
      component.isEditing = false;
      const multi = paste('1\t2');
      component.onCellPaste(multi.ev, a, 'dece');
      expect(multi.wasPrevented()).toBe(false);
      expect(a.dece).toBe('');
    });

    it('นำเข้าไฟล์: เติมเฉพาะแถวที่ตรงกับตารางและไม่ล็อค — สรุปก่อนนำเข้าบอกจำนวนที่เปลี่ยน/ข้าม', () => {
      const aoa = buildTemplateAoa(component.filteredData) as any[][];
      aoa[2][10] = 95;                 // แถวตัวชี้วัด 1: ธ.ค. = 95
      aoa[3][8] = 50;                  // แถวตัวชี้วัด 2 (ล็อค): ต.ค. = 50
      aoa[4][7] = 60;                  // แถวตัวชี้วัด 3: เป้าหมาย 80 → 60
      aoa.push([999, '10871', '2570', '', 'ไม่มีในตาราง', '', '', '', 5]);
      const parsed = parseImportAoa(aoa);
      const plan = planImport(parsed.rows, component.filteredData, component.editPerms);
      const html = component.buildImportPreviewHtml(plan, parsed.rows.length, 'ทดสอบ.xlsx');
      expect(html).toContain('ช่องที่จะเปลี่ยนค่า <b>2</b>');
      expect(html).toContain('แถวถูกล็อค <b>1</b>');
      expect(html).toContain('ไม่ตรงกับรายการในตารางที่แสดงอยู่ <b>1</b>');
      expect(html).toContain('ยังไม่บันทึก');

      component.applyChangePlan(plan, 'นำเข้า');
      const [a, b, c] = component.filteredData;
      expect(a.dece).toBe('95');
      expect(b.oct).toBe('');
      expect(c.target_value).toBe('60');
      expect(a.oct).toBe('85');        // ค่าเดิมในไฟล์เท่าเดิม — ไม่ถูกนับว่าเปลี่ยน
      expect(component.isModified(a, 'oct')).toBe(false);
    });

    it('ไม่ได้อยู่โหมดแก้ไข → การนำเข้าไม่เปลี่ยนข้อมูลในตาราง', () => {
      component.isEditing = false;
      component.importAoa(buildTemplateAoa([{ ...component.filteredData[0], dece: '77' }]) as any[][]);
      expect(component.filteredData[0].dece).toBe('');
    });

    it('พิมพ์ค่าเกินหลัก (850 ขณะเดือนอื่น 85, 88) → เตือนในช่องนั้น และหายเมื่อแก้กลับ/คืนค่า', () => {
      const a = component.filteredData[0];
      a.dece = '850';
      component.onValueChange(a, 'dece');
      expect(a._anomaly?.dece?.kind).toBe('high');
      expect(component.anomalyCount).toBe(1);
      expect(component.anomalyList[0]).toMatchObject({ month: 'dece', monthName: 'ธ.ค.', value: '850' });

      a.dece = '90';
      component.onValueChange(a, 'dece');
      expect(a._anomaly).toBeNull();
      expect(component.anomalyCount).toBe(0);

      a.dece = '850';
      component.onValueChange(a, 'dece');
      component.resetData(false);
      expect(a.dece).toBe('');
      expect(component.anomalyCount).toBe(0);
    });

    it('ค่าเดิมที่มีอยู่ก่อนแก้ไขไม่ถูกเตือนย้อนหลัง (เตือนเฉพาะช่องที่แก้ในรอบนี้)', () => {
      const odd = editRow(9, { oct: '85', nov: '900', dece: '88' });
      component.filteredData = [odd];
      odd.jan = '90';
      component.onValueChange(odd, 'jan');
      expect(odd._anomaly).toBeNull();                  // พ.ย. = 900 เป็นค่าเดิม ไม่ได้แก้ในรอบนี้ จึงไม่ถูกเตือน
    });

    it('เข้าโหมดแก้ไข: ขอผลงานปีงบที่แล้วของหน่วยบริการที่แสดงอยู่ — ระหว่างรอใช้เป้าหมายเป็นค่าอ้างอิง', () => {
      const c = component.filteredData[2];
      component.loadPrevYearMonths();
      const req = http.expectOne(r => r.url.includes('/kpi-summary/prev-year-months'));
      expect(req.request.url).toContain('year_bh=2570');
      expect(req.request.url).toContain('hospcodes=10871');
      c.oct = '500';
      component.onValueChange(c, 'oct');
      expect(c._anomaly).toBeNull();                    // เป้าหมาย 80: 500 ยังไม่ถึง 10 เท่า
      c.oct = '800';
      component.onValueChange(c, 'oct');
      expect(c._anomaly?.oct?.basis).toBe('target');    // 10 เท่าของเป้าหมาย
    });

    it('ข้อมูลปีงบที่แล้วมาถึงหลังพิมพ์ → ตรวจซ้ำและเตือน', () => {
      const c = component.filteredData[2];
      c.target_value = '';
      c._original = { ...c };
      component.loadPrevYearMonths();
      const req = http.expectOne(r => r.url.includes('/kpi-summary/prev-year-months'));
      c.oct = '750';
      component.onValueChange(c, 'oct');
      expect(c._anomaly).toBeNull();                    // ไม่มีเดือนอื่น ไม่มีเป้าหมาย ยังไม่มีข้อมูลปีที่แล้ว
      req.flush({ success: true, year_bh: '2569', data: [{ indicator_id: 3, hospcode: '10871', oct: '75', nov: '80' }] });
      expect(c._anomaly?.oct?.basis).toBe('prev-month');
      expect(c._anomaly?.oct?.message).toContain('เดือนเดียวกันของปีงบที่แล้ว');
    });

    it('แสดงปุ่ม Excel และไอคอนเตือนในตารางโหมดแก้ไข', () => {
      const a = component.filteredData[0];
      component.kpiData = component.filteredData;
      a.dece = '850';
      component.onValueChange(a, 'dece');
      (component as any).cdr.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.textContent).toContain('แบบฟอร์ม Excel');
      expect(el.textContent).toContain('นำเข้า Excel');
      expect(el.textContent).toContain('ค่าอาจผิดปกติ 1 ช่อง');
      expect(el.querySelector('input[type=file][accept*=".xlsx"]')).toBeTruthy();
    });
  });

  // ---- ตัวชี้วัด 3 ระดับ (18 ต.ค. 2569): แถวลูกข้อย่อย 1.1 / กิจกรรม 1.1.1 ----
  describe('ตัวชี้วัด 3 ระดับ (แถวลูกในตาราง)', () => {
    const hierData = () => ({
      item_no: '1', sub_rollup_mode: 'auto',
      subs: [
        { id: 11, sub_indicator_name: 'ข้อย่อยจากกิจกรรม', item_no: null, rollup_mode: 'auto', target: null, target_percentage: '100', months: { 10: '999' }, locked: false },
        { id: 12, sub_indicator_name: 'ข้อย่อยกรอกเอง', item_no: '1.9', rollup_mode: 'manual', target: '80', months: { 10: '60' }, locked: false },
      ],
      activities: [
        { id: 101, sub_indicator_id: 11, activity_name: 'กิจกรรมตัวเลข', item_no: null, value_type: 'number', months: { 10: '80' }, locked: false },
        { id: 102, sub_indicator_id: 11, activity_name: 'กิจกรรมทำแล้ว', item_no: null, value_type: 'check', months: { 10: '1', 11: '0' }, locked: false },
      ],
    });

    it('สร้างแถวลูกพร้อมเลขข้อ และข้อย่อย auto คำนวณจากกิจกรรม (ไม่ใช้ค่าที่กรอกเองเดิม)', () => {
      const rows = buildHierRows(hierData(), '1');
      expect(rows.map(r => r.no)).toEqual(['1.1', '1.1.1', '1.1.2', '1.9']);
      const auto = rows[0];
      expect(auto.auto).toBe(true);
      expect(auto.months['oct']).toBe('90');   // (80 + 100) / 2
      expect(auto.months['nov']).toBe('40');   // (80 ยกยอด + 0) / 2
      expect(auto.months['dece']).toBe('');
      expect(rows[3].auto).toBe(false);
      expect(rows[3].months['oct']).toBe('60');
    });

    it('กรอกกิจกรรม → ข้อย่อยคำนวณใหม่ทันที และนับเป็นช่องที่แก้ไข (ข้อ auto ไม่นับ)', () => {
      const item = row('2570', { indicator_id: 5, sub_rollup_mode: 'auto' });
      component.filteredData = [item];
      const key = component.hierKey(item);
      const rows = buildHierRows(hierData(), '1');
      component.hierData.set(key, rows);
      rows[2].months['dece'] = '1';
      recomputeHierRows(rows);
      expect(rows[0].months['dece']).toBe('90'); // (80 + 100) / 2
      const changes = component.collectHierChanges();
      expect(changes.length).toBe(1);
      expect(changes[0].row.id).toBe(102);
      expect(changes[0].newVal).toBe('1');
      component.restoreHier();
      expect(rows[2].months['dece']).toBe('');
      expect(component.collectHierChanges().length).toBe(0);
    });

    it('ช่องกิจกรรม/ข้อ auto แก้ได้ตามสิทธิ์: ข้อ auto และแถวที่ล็อคแก้ไม่ได้', () => {
      const item = row('2570');
      const rows = buildHierRows(hierData(), '1');
      component.isEditing = true;
      component.myPerms = { ...component.myPerms, can_edit_actual: true };
      expect(component.canEditHierRow(item, rows[0])).toBe(false);  // คำนวณจากกิจกรรม
      expect(component.canEditHierRow(item, rows[1])).toBe(true);
      rows[1].locked = true;
      expect(component.canEditHierRow(item, rows[1])).toBe(false);
      expect(component.canEditHierRow({ ...item, is_locked: 1 }, rows[3])).toBe(false);
    });

    it('กดช่องทำแล้ววน ว่าง → ทำแล้ว → ยังไม่ทำ → ว่าง', () => {
      const item = row('2570');
      component.filteredData = [item];
      const rows = buildHierRows(hierData(), '1');
      component.hierData.set(component.hierKey(item), rows);
      component.isEditing = true;
      component.myPerms = { ...component.myPerms, can_edit_actual: true };
      const chk = rows[2];
      component.cycleHierCheck(item, chk, 'jan');
      expect(chk.months['jan']).toBe('1');
      component.cycleHierCheck(item, chk, 'jan');
      expect(chk.months['jan']).toBe('0');
      component.cycleHierCheck(item, chk, 'jan');
      expect(chk.months['jan']).toBe('');
    });

    it('rowspan ของหมวดหมู่หลักรวมแถวลูกที่ขยายอยู่', () => {
      const a = row('2570', { indicator_id: 1, rowSpan: 2 });
      const b = row('2570', { indicator_id: 2, rowSpan: 0 });
      component.hierData.set(component.hierKey(b), buildHierRows(hierData(), ''));
      expect(component.hierRowSpan([a, b], 0)).toBe(2);
      component.hierExpanded.add(component.hierKey(b));
      expect(component.hierRowSpan([a, b], 0)).toBe(6);
    });

    it('ตัวชี้วัดหลักแบบกรอกเอง: ไม่นำค่าจากข้อย่อยมาทับแถวหลัก', () => {
      const manual = row('2570', { indicator_id: 7, oct: '55' });
      const auto = row('2570', { indicator_id: 8, oct: '55' });
      component.kpiData = [manual, auto];
      component.filteredData = [manual, auto];
      component.subSummaryMap.set('7|10871|2570', { sub_rollup_mode: 'manual', m10: 90, avg_target: 100, last_actual: 90 });
      component.subSummaryMap.set('8|10871|2570', { sub_rollup_mode: 'auto', m10: 90, avg_target: 100, last_actual: 90 });
      component.applySubSummaryToKpiData();
      expect(manual.oct).toBe('55');
      expect(auto.oct).toBe('90');
    });
  });
});
