import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { ReportComponent, filterReportRows, REPORT_SEARCH_FIELDS, REPORT_SEARCH_PLACEHOLDER } from './report';

describe('รายงานสรุปผล — ค้นหาในแต่ละแถบ (ฟังก์ชันล้วน)', () => {
  const inds = [
    { kpi_indicators_name: 'ร้อยละผู้ป่วยเบาหวาน', main_indicator_name: 'NCD', dept_name: 'กลุ่มงานควบคุมโรค' },
    { kpi_indicators_name: 'อัตราการจมน้ำ', main_indicator_name: 'อุบัติเหตุ', dept_name: 'EMS' },
  ];
  it('ไม่มีคำค้น = คืนรายการเดิม', () => {
    expect(filterReportRows(inds, 'by-indicator', '')).toBe(inds);
    expect(filterReportRows(inds, 'by-indicator', '   ')).toBe(inds);
    expect(filterReportRows(null as any, 'by-indicator', 'x')).toEqual([]);
  });
  it('รายตัวชี้วัด: ค้นชื่อ/หมวดหมู่หลัก/หน่วยงาน ไม่สนตัวพิมพ์ ทุกคำต้องพบ', () => {
    expect(filterReportRows(inds, 'by-indicator', 'เบาหวาน')).toEqual([inds[0]]);
    expect(filterReportRows(inds, 'by-indicator', 'ems')).toEqual([inds[1]]);
    expect(filterReportRows(inds, 'by-indicator', 'ncd ควบคุมโรค')).toEqual([inds[0]]);
    expect(filterReportRows(inds, 'by-indicator', 'ncd จมน้ำ')).toEqual([]);
  });
  it('รายหน่วยบริการ: ชื่อ/รหัส/อำเภอ — รายอำเภอ/รายปี/หน่วยงาน', () => {
    const hos = [{ hosname: 'รพ.มหาราช', hospcode: '10669', distname: 'เมือง' }, { hosname: 'รพ.สต.บ้านโพธิ์', hospcode: '03001', distname: 'โนนสูง' }];
    expect(filterReportRows(hos, 'by-hospital', '10669')).toEqual([hos[0]]);
    expect(filterReportRows(hos, 'recording-status:by-hospital', 'โนนสูง')).toEqual([hos[1]]);
    expect(filterReportRows([{ distname: 'ปักธงชัย', distid: '3021' }], 'by-district', 'ปัก').length).toBe(1);
    expect(filterReportRows([{ year_bh: '2569' }, { year_bh: '2570' }], 'by-year', '2570')).toEqual([{ year_bh: '2570' }]);
    expect(filterReportRows([{ dept_name: 'กลุ่มงานประกัน', dept_code: 'ปส' }], 'by-dept', 'ประกัน').length).toBe(1);
  });
  it('ทุกแถบมีช่องค้นหาและข้อความแนะนำ', () => {
    for (const k of ['by-indicator', 'by-hospital', 'by-district', 'by-year', 'recording-status:by-indicator', 'recording-status:by-hospital', 'by-dept']) {
      expect(REPORT_SEARCH_FIELDS[k]?.length).toBeGreaterThan(0);
      expect(REPORT_SEARCH_PLACEHOLDER[k]).toBeTruthy();
    }
  });
});

describe('ReportComponent — กล่องค้นหา', () => {
  const setup = async () => {
    localStorage.setItem('kpi_user', JSON.stringify({ role: 'super_admin' }));
    await TestBed.configureTestingModule({ imports: [ReportComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(ReportComponent);
    return { f, http: TestBed.inject(HttpTestingController) };
  };
  afterEach(() => localStorage.removeItem('kpi_user'));

  it('คำค้นกรองตาราง แยกตามแถบ และสลับแถบแล้วคำค้นเดิมยังอยู่', async () => {
    const { f, http } = await setup();
    const c = f.componentInstance;
    c.reportData = [{ kpi_indicators_name: 'ร้อยละ ก' }, { kpi_indicators_name: 'อัตรา ข' }];
    c.applySearch();
    expect(c.viewData.length).toBe(2);
    c.onSearchChange('อัตรา');
    expect(c.viewData).toEqual([{ kpi_indicators_name: 'อัตรา ข' }]);
    f.detectChanges();
    http.match(() => true).forEach(r => r.flush({ success: true, data: [] }));
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#report-search-count')?.textContent).toContain('จาก 2');

    c.activeTab = 'by-hospital';
    expect(c.searchQuery).toBe('');
    c.activeTab = 'by-indicator';
    expect(c.searchQuery).toBe('อัตรา');
    c.onSearchChange('');
    expect(c.viewData.length).toBe(2);
  });

  it('สถานะการบันทึก: คำค้นแยกตามมุมมอง + แถบสรุปรายหน่วยงานกรอง deptViewData', async () => {
    const { f } = await setup();
    const c = f.componentInstance;
    c.activeTab = 'recording-status';
    c.monitorView = 'by-hospital';
    c.reportData = [{ hosname: 'รพ.ก', hospcode: '10669' }, { hosname: 'รพ.ข', hospcode: '10670' }];
    c.onSearchChange('10670');
    expect(c.viewData.map((r: any) => r.hospcode)).toEqual(['10670']);
    c.monitorView = 'by-indicator';
    expect(c.searchQuery).toBe('');

    c.activeTab = 'by-dept';
    c.deptSummaryData = [{ dept_name: 'กลุ่มงาน NCD' }, { dept_name: 'กลุ่มงานประกัน' }];
    c.onSearchChange('ncd');
    expect(c.deptViewData).toEqual([{ dept_name: 'กลุ่มงาน NCD' }]);
  });
});
