import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { KpiManageComponent, resultMethodOf, applyResultMethod } from './kpi-manage';
import { testProviders } from '../testing/test-providers';

describe('KpiManageComponent', () => {
  let component: KpiManageComponent;
  let fixture: ComponentFixture<KpiManageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KpiManageComponent],
      providers: testProviders,
    }).compileComponents();

    fixture = TestBed.createComponent(KpiManageComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // ---- รหัสของตัวชี้วัดสร้างให้อัตโนมัติ (11 ต.ค. 2569) — เดิมผู้ใช้ต้องคิด/กรอก รหัสอ้างอิง + รหัสตัวชี้วัด + ชื่อตาราง เอง ----
  describe('รหัสอัตโนมัติใน modal เพิ่มตัวชี้วัด', () => {
    let http: HttpTestingController;
    const flushSuggest = (tp: string) => {
      const req = http.expectOne(r => r.url.includes('/indicators/suggest-code'));
      req.flush({ success: true, data: { table_process: tp, kpi_indicators_code: tp.replace(/_/g, '-') } });
      return req;
    };

    beforeEach(() => {
      http = TestBed.inject(HttpTestingController);
      component.activeTab = 'indicators';
      component.indicators = [{ id: 7, kpi_indicators_name: 'ตัวเดิม', table_process: 'kpi_ncd_001' }];
    });

    it('เปิดเพิ่มใหม่ → ขอรหัสจากระบบมาแสดง และเปลี่ยนหน่วยงานแล้วขอใหม่ตามหน่วยงาน', () => {
      component.openModal();
      expect(component.codeAuto).toBe(true);
      expect(component.showCodeFields).toBe(false);
      flushSuggest('kpi_gen_001');
      expect(component.currentItem.table_process).toBe('kpi_gen_001');
      expect(component.currentItem.kpi_indicators_code).toBe('kpi-gen-001');

      component.currentItem.dept_id = 5;
      component.onDeptChangeInModal();
      const req = flushSuggest('kpi_ncd_002');
      expect(req.request.url).toContain('dept_id=5');
      expect(component.currentItem.table_process).toBe('kpi_ncd_002');
    });

    it('บันทึกโหมดอัตโนมัติ → ส่งรหัสว่างให้ backend สร้างรหัสจริง (กันลำดับชนกัน)', () => {
      component.openModal();
      flushSuggest('kpi_gen_001');
      component.currentItem.kpi_indicators_name = 'ตัวชี้วัดใหม่';
      component.saveItem();
      const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/indicators'));
      expect(req.request.body.table_process).toBe('');
      expect(req.request.body.kpi_indicators_code).toBe('');
    });

    it('พิมพ์รหัสเอง → เลิกโหมดอัตโนมัติ ไม่ถูกทับเมื่อเปลี่ยนหน่วยงาน และส่งค่าที่พิมพ์', () => {
      component.openModal();
      flushSuggest('kpi_gen_001');
      component.currentItem.table_process = 'my_table';
      component.onCodeManualEdit();
      component.currentItem.dept_id = 5;
      component.onDeptChangeInModal();
      http.expectNone(r => r.url.includes('/indicators/suggest-code'));
      component.saveItem();
      const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/indicators'));
      expect(req.request.body.table_process).toBe('my_table');
    });

    it('แก้ไขตัวเดิม → ไม่ขอรหัสใหม่ และเตือนเมื่อชื่อตารางซ้ำกับตัวชี้วัดอื่น', () => {
      component.openModal({ id: 9, kpi_indicators_name: 'อีกตัว', table_process: 'KPI_NCD_001' });
      http.expectNone(r => r.url.includes('/indicators/suggest-code'));
      expect(component.codeAuto).toBe(false);
      expect(component.tableProcessDuplicateName).toBe('ตัวเดิม');
      component.currentItem.table_process = 'kpi_ncd_009';
      expect(component.tableProcessDuplicateName).toBeNull();
      // ตัวเอง (id เดียวกัน) ไม่นับว่าซ้ำ
      component.openModal({ id: 7, kpi_indicators_name: 'ตัวเดิม', table_process: 'kpi_ncd_001' });
      expect(component.tableProcessDuplicateName).toBeNull();
    });
  });

  // ---- 19 ต.ค. 2569: ตัวชี้วัดหลายระดับ — หน้าต่างตัวชี้วัดย่อยเป็นต้นไม้ ----
  describe('ตัวชี้วัดย่อยหลายระดับ', () => {
    let http: HttpTestingController;
    beforeEach(() => {
      http = TestBed.inject(HttpTestingController);
      component.subParentIndicator = { id: 7, item_no: '3' };
      component.loadSubList(7);
      http.expectOne(r => r.url.includes('/sub-indicators')).flush({ success: true, max_levels: 4, data: [
        { id: 1, parent_sub_id: null, sub_indicator_name: 'ก', is_active: 1, activity_count: 0, child_count: 1 },
        { id: 11, parent_sub_id: 1, sub_indicator_name: 'ข', is_active: 1, activity_count: 2, child_count: 0 },
        { id: 2, parent_sub_id: null, sub_indicator_name: 'ค', is_active: 1, activity_count: 0, child_count: 0 },
      ] });
    });

    it('เรียงเป็นต้นไม้พร้อมเลขข้อ และปุ่มเพิ่มข้อย่อยแสดงเฉพาะเมื่อยังไม่ถึงระดับสูงสุด', () => {
      expect(component.subList.map((s: any) => s._no)).toEqual(['3.1', '3.1.1', '3.2']);
      expect(component.subLevel(component.subList[1])).toBe(3);
      expect(component.canAddChildSub(component.subList[0])).toBe(true);    // ข้อลูกจะอยู่ระดับ 3
      expect(component.canAddChildSub(component.subList[1])).toBe(false);   // ระดับ 4 สงวนไว้ให้กิจกรรม
      component.subMaxLevels = 5;
      expect(component.canAddChildSub(component.subList[1])).toBe(true);
    });

    it('เพิ่มข้อย่อยลูก → ส่ง parent_sub_id / เลขข้อกิจกรรมต่อจากข้อลูก', () => {
      component.openSubForm(null, component.subList[0]);
      expect(component.subCurrent.parent_sub_id).toBe(1);
      expect(component.subFormParent.id).toBe(1);
      component.subCurrent.sub_indicator_name = 'ใหม่';
      component.saveSub();
      expect(http.expectOne(r => r.method === 'POST' && r.url.includes('/sub-indicators')).request.body.parent_sub_id).toBe(1);
      component.openActModal(component.subList[0], 0);
      http.expectOne(r => r.url.includes('/sub-activities')).flush({ success: true, data: [] });
      expect(component.actNo({}, 0)).toBe('3.1.2');   // ข้อลูก 3.1.1 มาก่อน
    });
  });

  // ---- 19 ต.ค. 2569: ปรับเกณฑ์ให้เท่ากับ KHD ----
  describe('เกณฑ์ต่างจาก KHD', () => {
    beforeEach(() => {
      component.activeTab = 'indicators';
      component.indicators = [
        { id: 1, kpi_indicators_name: 'ก', table_process: 'tp1', is_active: 1, criterion: '70', target_condition: 'GTE' },
        { id: 2, kpi_indicators_name: 'ข', table_process: 'tp2', is_active: 1, criterion: '80', target_condition: 'GTE' },
      ];
      component.khdCompareMap = new Map<string, any>([
        ['tp1', { status: 'match', table_process: 'tp1', criteria_match: false, khd_target_percentage: '85', khd_target_condition: 'LTE', khd_fiscal_year: '2570' }],
        ['tp2', { status: 'match', table_process: 'tp2', criteria_match: true }],
      ]);
    });

    it('นับ/กรองเฉพาะตัวที่เกณฑ์ต่างกัน และแสดงเกณฑ์ของ KHD ที่จะใช้', () => {
      expect(component.khdCounts.criteria).toBe(1);
      expect(component.khdCriteriaDiffItems.map(i => i.id)).toEqual([1]);
      component.filterKhdStatus = 'criteria';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toEqual([1]);
      expect(component.getKhdCriteriaText(component.getKhdData(component.indicators[0]))).toContain('85');
    });

    it('เรียก API ด้วยรายการตัวชี้วัดและปีงบที่เทียบ', () => {
      const http = TestBed.inject(HttpTestingController);
      (component as any).authService.applyKhdCriteria([1], '2570').subscribe();
      const req = http.expectOne(r => r.method === 'POST' && r.url.includes('/indicators/apply-khd-criteria'));
      expect(req.request.body).toEqual({ ids: [1], year_bh: '2570' });
    });
  });

  // ---- 19 ต.ค. 2569: จับคู่ข้อมูล KHD (หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์) ----
  describe('จับคู่ข้อมูล KHD', () => {
    let http: HttpTestingController;
    beforeEach(() => { http = TestBed.inject(HttpTestingController); component.isSuperAdmin = true; });

    const items = () => [
      { khd_value: 'NCD', report_count: 3, missing_count: 1, resolved: { status: 'auto', local_id: 6, local_name: 'กลุ่มงาน NCD' }, mapping: null },
      { khd_value: 'ทต.', report_count: 2, missing_count: 2, resolved: { status: 'unmatched', local_id: null, local_name: null }, mapping: null },
    ];

    it('เปิดหน้าต่าง → โหลดค่าของ KHD ตามประเภท แสดงเฉพาะที่ยังไม่จับคู่เป็นค่าเริ่มต้น', () => {
      component.openKhdMapping('dept');
      http.expectOne(r => r.url.includes('/khd-mappings?kind=dept')).flush({ success: true, items: items(), options: [{ id: 6, name: 'กลุ่มงาน NCD' }], summary: { total: 2, unmatched: 1, auto: 1 } });
      expect(component.khdMapOpen).toBe(true);
      expect(component.khdMapVisibleItems.map(i => i.khd_value)).toEqual(['ทต.']);
      component.khdMapOnlyUnmatched = false;
      expect(component.khdMapItems.find(i => i.khd_value === 'NCD')._pick).toBe(6);   // ค่าตั้งต้นของตัวเลือก = ที่จับคู่ได้ปัจจุบัน
      component.khdMapSearch = 'ncd';
      expect(component.khdMapVisibleItems.map(i => i.khd_value)).toEqual(['NCD']);
    });

    it('จับคู่ / ไม่ต้องจับคู่ ส่งค่าที่ถูกต้องและอัปเดตสถานะในตารางทันที', () => {
      component.openKhdMapping('dept');
      http.expectOne(r => r.url.includes('/khd-mappings')).flush({ success: true, items: items(), options: [], summary: {} });
      const row = component.khdMapItems[1];
      component.saveKhdMap(row, { localId: 13 });
      const req = http.expectOne(r => r.method === 'PUT' && r.url.includes('/khd-mappings'));
      expect(req.request.body).toEqual({ kind: 'dept', khd_value: 'ทต.', local_id: 13, ignore: false });
      req.flush({ success: true, resolved: { status: 'mapped', local_id: 13, local_name: 'กลุ่มงาน 13' } });
      expect(row.resolved.status).toBe('mapped');
      expect(component.khdMapSummary).toEqual(expect.objectContaining({ unmatched: 0, mapped: 1, auto: 1 }));

      component.saveKhdMap(row, { ignore: true });
      expect(http.expectOne(r => r.method === 'PUT').request.body).toEqual({ kind: 'dept', khd_value: 'ทต.', local_id: null, ignore: true });
    });

    it('ตาราง "ยังไม่มีในระบบ": นับรายการที่ยังจับคู่ไม่ครบ และป้ายแสดงค่าที่จะได้', () => {
      component.khdCompareMap = new Map<string, any>([
        ['a', { status: 'missing_local', khd_report_id: 1, khd_resolved: { unmatched: ['yut'] } }],
        ['b', { status: 'missing_local', khd_report_id: 2, khd_resolved: { unmatched: [] } }],
      ]);
      component.khdMissingLocalSelected = new Set([2]);
      expect(component.khdMissingUnmatchedCount).toBe(1);
      expect(component.khdBulkSelectedUnmatchedCount).toBe(0);
      expect(component.khdResolvedBadge({ status: 'auto', local_id: 6, local_name: 'NCD' })?.text).toBe('NCD');
      expect(component.khdResolvedBadge({ status: 'empty', local_id: null })).toBeNull();
      expect(component.khdResolvedBadge({ status: 'unmatched', local_id: null })?.text).toBe('ยังไม่จับคู่');
    });

    it('บันทึกตัวชี้วัด: ส่งยุทธศาสตร์ที่เลือก (main_yut) ไปด้วย', () => {
      component.activeTab = 'indicators';
      component.openModal({ id: 5, kpi_indicators_name: 'x', yut_id: 3, evaluation_mode: 'all_required' });
      expect(component.selectedYutInModal).toBe(3);
      component.saveItem();
      const req = http.expectOne(r => r.method === 'PUT' && r.url.includes('/indicators/5'));
      expect(req.request.body.main_yut).toBe(3);
      expect(req.request.body.yut_id).toBeUndefined();
    });
  });

  // ---- 19 ต.ค. 2569: ปุ่ม "ไปตั้งค่า" จากหน้าต่างเพิ่มตัวชี้วัดให้หน่วยบริการ → เปิดหน้าต่างแก้ไขตัวชี้วัดนั้นทันที ----
  it('?editIndicator=<id> เปิดหน้าต่างแก้ไขตัวชี้วัดนั้นหลังโหลดรายการ (ครั้งเดียว)', () => {
    component.canEditData = true;
    component.pendingEditIndicatorId = 9;
    component.indicators = [{ id: 8, kpi_indicators_name: 'อื่น' }, { id: 9, kpi_indicators_name: 'ยังไม่ตั้งประเภท', evaluation_mode: null }];
    component.openPendingIndicatorEdit();
    expect(component.showModal).toBe(true);
    expect(component.isEditMode).toBe(true);
    expect(component.currentItem.id).toBe(9);
    expect(component.pendingEditIndicatorId).toBeNull();
    component.showModal = false;
    component.openPendingIndicatorEdit();
    expect(component.showModal).toBe(false);
  });

  it('?editIndicator ไม่มีสิทธิ์แก้ไข → ไม่เปิดหน้าต่าง', () => {
    component.canEditData = false;
    component.pendingEditIndicatorId = 9;
    component.indicators = [{ id: 9, kpi_indicators_name: 'x' }];
    component.openPendingIndicatorEdit();
    expect(component.showModal).toBe(false);
  });

  // ---- ตัวชี้วัด 3 ระดับ (18 ต.ค. 2569): เลขข้อ + กิจกรรมใต้ตัวชี้วัดย่อย ----
  describe('กิจกรรมของตัวชี้วัดย่อย', () => {
    let http: HttpTestingController;
    beforeEach(() => { http = TestBed.inject(HttpTestingController); });

    it('เลขข้อ: ข้อย่อยต่อจากเลขข้อหลัก กิจกรรมต่อจากเลขข้อย่อย (กำหนดเองได้)', () => {
      component.subParentIndicator = { id: 1, item_no: '2' };
      expect(component.subNo({}, 0)).toBe('2.1');
      expect(component.subNo({ item_no: '2.9' }, 1)).toBe('2.9');
      component.openActModal({ id: 5, item_no: null }, 2);
      http.expectOne(r => r.url.includes('/sub-activities?sub_indicator_id=5')).flush({ success: true, data: [] });
      expect(component.actParentNo).toBe('2.3');
      expect(component.actNo({}, 0)).toBe('2.3.1');
    });

    it('ฟอร์มกิจกรรมใหม่ตั้งต้นเป็นแบบตัวเลข และส่งข้อมูลที่กรอกไปบันทึก', () => {
      component.subParentIndicator = { id: 1 };
      component.openActModal({ id: 5 }, 0);
      http.expectOne(r => r.url.includes('/sub-activities')).flush({ success: true, data: [{ id: 1 }] });
      component.openActForm();
      expect(component.actCurrent).toEqual(expect.objectContaining({ sub_indicator_id: 5, value_type: 'number', sort_order: 2 }));
      component.actCurrent.activity_name = 'จัดประชุม';
      component.saveAct();
      const req = http.expectOne(r => r.method === 'POST' && r.url.includes('/sub-activities'));
      expect(req.request.body.activity_name).toBe('จัดประชุม');
    });

    it('ฟอร์มข้อย่อยตั้งต้นเป็น "กรอกเอง" (พฤติกรรมเดิม)', () => {
      component.subParentIndicator = { id: 1 };
      component.openSubForm();
      expect(component.subCurrent.rollup_mode).toBe('manual');
      component.openSubForm({ id: 3, rollup_mode: 'auto' });
      expect(component.subCurrent.rollup_mode).toBe('auto');
    });
  });

  // Export 3 ระดับ (18 ต.ค. 2569): ตัวเลือกส่งออกรายละเอียด ค่าตั้งต้นปิด และแปลงค่าจากฐานข้อมูลเป็น boolean
  it('ตัวเลือก "ส่งออกรายละเอียดตัวชี้วัดย่อย/กิจกรรม" ค่าตั้งต้นปิด และโหลดค่าเดิมได้', () => {
    component.activeTab = 'indicators';
    component.openModal();
    expect(component.currentItem.export_items).toBe(false);
    component.openModal({ id: 9, kpi_indicators_name: 'x', export_items: 1 });
    expect(component.currentItem.export_items).toBe(true);
  });
  describe('เงื่อนไขเป้าหมาย + วิธีคิดผลงาน', () => {
    it('dropdown เงื่อนไขมีครบ 5 แบบ (≥ > ≤ < =)', () => {
      expect(component.TARGET_CONDITION_OPTIONS.map(o => o.v)).toEqual(['GTE', 'GT', 'LTE', 'LT', 'EQ']);
      component.currentItem = { target_condition: 'LTE' };
      expect(component.conditionHelp.pct).toContain('เป้าหมาย ÷ ผลงาน');
    });

    it('วิธีคิดผลงาน ↔ is_cumulative + result_formula ไปกลับได้', () => {
      expect(resultMethodOf({ result_formula: '', is_cumulative: 0 })).toBe('last');
      expect(resultMethodOf({ result_formula: null, is_cumulative: 1 })).toBe('sum');
      expect(resultMethodOf({ result_formula: 'avg( ALL )' })).toBe('avg');
      expect(resultMethodOf({ result_formula: '(m10+m11)/2' })).toBe('custom');
      const it: any = { result_formula: '', is_cumulative: true };
      applyResultMethod(it, 'max');
      expect(it).toEqual({ result_formula: 'MAX(ALL)', is_cumulative: false });
      applyResultMethod(it, 'sum');
      expect(it).toEqual({ result_formula: '', is_cumulative: true });
      applyResultMethod(it, 'custom');
      expect(it).toEqual({ result_formula: '', is_cumulative: false });
    });

    it('เลือก "สูตรกำหนดเอง" แล้วไม่สลับกลับเองแม้สูตรยังว่าง', () => {
      component.currentItem = { result_formula: 'AVG(ALL)', is_cumulative: 0 };
      expect(component.resultMethod).toBe('avg');
      component.resultMethod = 'custom';
      expect(component.resultMethod).toBe('custom');
      expect(component.currentItem.result_formula).toBe('');
      component.currentItem = { result_formula: '', is_cumulative: 0 };
      expect(component.resultMethod).toBe('last');
    });

    it('ทดลองคำนวณสูตรใช้ร้อยละตามเงื่อนไข', () => {
      component.currentItem = { result_formula: 'AVG(ALL)', target_condition: 'LTE' };
      component.formulaTestMonths = { m10: '4' };
      component.formulaTestTarget = '8';
      expect(component.formulaTestResult?.pct).toBe(200);
    });
  });
});
