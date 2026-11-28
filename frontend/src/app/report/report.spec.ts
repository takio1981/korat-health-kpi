import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { ReportComponent, filterReportRows, REPORT_SEARCH_FIELDS, REPORT_SEARCH_PLACEHOLDER, filterDeptKpiGroups, deptKpiExcelRows, REPORT_TAB_LABELS } from './report';

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
  it('รายตัวชี้วัด: ค้นชื่อ/หมวดหมู่หลัก/กลุ่มงาน ไม่สนตัวพิมพ์ ทุกคำต้องพบ', () => {
    expect(filterReportRows(inds, 'by-indicator', 'เบาหวาน')).toEqual([inds[0]]);
    expect(filterReportRows(inds, 'by-indicator', 'ems')).toEqual([inds[1]]);
    expect(filterReportRows(inds, 'by-indicator', 'ncd ควบคุมโรค')).toEqual([inds[0]]);
    expect(filterReportRows(inds, 'by-indicator', 'ncd จมน้ำ')).toEqual([]);
  });
  it('รายหน่วยบริการ: ชื่อ/รหัส/อำเภอ — รายอำเภอ/รายปี/กลุ่มงาน', () => {
    const hos = [{ hosname: 'รพ.มหาราช', hospcode: '10669', distname: 'เมือง' }, { hosname: 'รพ.สต.บ้านโพธิ์', hospcode: '03001', distname: 'โนนสูง' }];
    expect(filterReportRows(hos, 'by-hospital', '10669')).toEqual([hos[0]]);
    expect(filterReportRows(hos, 'recording-status:by-hospital', 'โนนสูง')).toEqual([hos[1]]);
    expect(filterReportRows([{ distname: 'ปักธงชัย', distid: '3021' }], 'by-district', 'ปัก').length).toBe(1);
    expect(filterReportRows([{ year_bh: '2569' }, { year_bh: '2570' }], 'by-year', '2570')).toEqual([{ year_bh: '2570' }]);
    expect(filterReportRows([{ dept_name: 'กลุ่มงานประกัน', dept_code: 'ปส' }], 'by-dept', 'ประกัน').length).toBe(1);
  });
  it('ทุกแถบมีช่องค้นหาและข้อความแนะนำ', () => {
    for (const k of ['by-indicator', 'by-hospital', 'by-district', 'by-year', 'recording-status:by-indicator', 'recording-status:by-hospital', 'by-dept', 'by-dept-kpi']) {
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

  it('สถานะการบันทึก: คำค้นแยกตามมุมมอง + แถบสรุปรายกลุ่มงานกรอง deptViewData', async () => {
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

describe('สรุปข้อมูลตัวชี้วัดของกลุ่มงาน (28 พ.ย. 2569)', () => {
  const groups = [
    { dept_id: 1, dept_name: 'กลุ่มงานควบคุมโรค', pass_pct: 80, indicators: [
      { indicator_id: 11, kpi_indicators_name: 'ร้อยละผู้ป่วยเบาหวาน', main_indicator_name: 'NCD', target_value: 20, total_actual: 30, hospital_count: 2, hospitals_with_target: 2, hospitals_passed: 2, achievement_pct: 100 },
      { indicator_id: 12, kpi_indicators_name: 'อัตราวัณโรค', main_indicator_name: 'โรคติดต่อ', target_value: 10, total_actual: 1, hospital_count: 2, hospitals_with_target: 2, hospitals_passed: 0, achievement_pct: 0 },
    ] },
    { dept_id: 2, dept_name: 'กลุ่มงานประกัน', pass_pct: 50, indicators: [
      { indicator_id: 21, kpi_indicators_name: 'ร้อยละการเบิกจ่าย', main_indicator_name: 'การเงิน', hospital_count: 1, hospitals_with_target: 2, hospitals_passed: 1, achievement_pct: 50 },
    ] },
  ];
  it('ค้นหา: ชื่อกลุ่มงานตรง = คงทุกตัวชี้วัด | ชื่อตัวชี้วัด/หมวดหมู่ = เฉพาะตัวที่ตรง | ไม่มีคำค้น = array เดิม', () => {
    expect(filterDeptKpiGroups(groups, '')).toBe(groups);
    expect(filterDeptKpiGroups(groups, 'ควบคุมโรค')[0].indicators.length).toBe(2);
    const r = filterDeptKpiGroups(groups, 'เบาหวาน');
    expect(r.map(g => g.dept_id)).toEqual([1]);
    expect(r[0].indicators.map((x: any) => x.indicator_id)).toEqual([11]);
    expect(r[0]._filtered).toBe(true);
    expect(filterDeptKpiGroups(groups, 'การเงิน').map(g => g.dept_id)).toEqual([2]);
    expect(filterDeptKpiGroups(groups, 'ควบคุมโรค วัณโรค')[0].indicators.map((x: any) => x.indicator_id)).toEqual([12]);
    expect(filterDeptKpiGroups(groups, 'ไม่มีคำนี้')).toEqual([]);
    expect(groups[0].indicators.length).toBe(2);   // ไม่แก้ข้อมูลต้นฉบับ
  });
  it('Excel: 1 แถว = 1 ตัวชี้วัด + ชื่อกลุ่มงาน + kpi_indicators_name (ให้ withTableProcess ใส่ table_process ได้)', () => {
    const rows = deptKpiExcelRows(groups);
    expect(rows.length).toBe(3);
    expect(rows[0]['กลุ่มงาน']).toBe('กลุ่มงานควบคุมโรค');
    expect(rows[2]).toEqual(expect.objectContaining({ kpi_indicators_name: 'ร้อยละการเบิกจ่าย', 'ร้อยละผ่านเกณฑ์': 50, 'คู่ที่มีเป้าหมาย': 2 }));
    expect(REPORT_TAB_LABELS['by-dept-kpi']).toBe('สรุปข้อมูลตัวชี้วัดของกลุ่มงาน');
  });
  it('โหลดแถบ: เรียก /report/by-dept-kpi + แสดงกลุ่มงาน + คลิกแถวขยายรายตัวชี้วัด', async () => {
    localStorage.setItem('kpi_user', JSON.stringify({ role: 'user_ssj' }));
    await TestBed.configureTestingModule({ imports: [ReportComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(ReportComponent);
    const http = TestBed.inject(HttpTestingController);
    const c = f.componentInstance;
    f.detectChanges();
    for (let k = 0; k < 4; k++) http.match(r => !r.url.includes('/report/by-dept-kpi')).forEach(r => r.flush({ success: true, data: [] }));
    c.selectedYear = '2570';
    c.switchTab('by-dept-kpi');
    const req = http.expectOne(r => r.url.includes('/report/by-dept-kpi'));
    expect(req.request.url).toContain('year_bh=2570');
    req.flush({ success: true, summary: { total_depts: 2, total_indicators: 3, indicators_with_target: 3, pairs_with_target: 6, pairs_passed: 3, pass_pct: 50, depts_ge_80: 1, depts_lt_50: 0 }, data: groups });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#tab-by-dept-kpi')).toBeTruthy();           // ทุกสิทธิ์เห็นแถบนี้
    expect(el.querySelector('#dept-kpi-cards')?.textContent).toContain('50%');
    const rows = el.querySelectorAll('#dept-kpi-table tr[data-dept]');
    expect(rows.length).toBe(2);
    expect(el.textContent).not.toContain('ร้อยละผู้ป่วยเบาหวาน');
    (rows[0] as HTMLElement).click();
    f.detectChanges();
    expect(el.textContent).toContain('ร้อยละผู้ป่วยเบาหวาน');
    c.onSearchChange('การเงิน');
    (c as any).cdr.markForCheck();
    f.detectChanges();
    expect(el.querySelectorAll('#dept-kpi-table tr[data-dept]').length).toBe(1);
    expect(el.textContent).toContain('ร้อยละการเบิกจ่าย');                 // ค้นชื่อตัวชี้วัด = ขยายให้เอง
    localStorage.removeItem('kpi_user');
  });
});
