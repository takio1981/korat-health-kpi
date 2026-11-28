import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { KpiManageComponent, resultMethodOf, applyResultMethod, quarterModeParts, quarterModeFrom, setQuarterMode } from './kpi-manage';
import { testProviders } from '../testing/test-providers';
import Swal from 'sweetalert2';

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

  // ---- ความพร้อมของตัวชี้วัด (22 พ.ย. 2569 — ระยะ 5 lean งานผู้ดูแล) ----
  describe('ความพร้อมของตัวชี้วัด', () => {
    it('โหลด /indicators/readiness → ป้ายเฉพาะ block/warn, ตัวกรอง และนับตัวชี้วัดที่ยังไม่ตั้งประเภท', () => {
      const http = TestBed.inject(HttpTestingController);
      component.loadReadiness();
      http.expectOne(r => r.url.includes('/indicators/readiness')).flush({ success: true, data: {
        counts: { ok: 1, info: 1, warn: 1, block: 1 }, by_code: { hostype_unset: 1, not_assigned: 2 },
        items: [
          { id: 1, level: 'block', issues: [{ code: 'hostype_unset', level: 'block', text: 'ยังไม่ตั้งประเภทหน่วยบริการ', field: 'indicator-eval-mode' }, { code: 'not_assigned', level: 'warn', text: 'ยังไม่ได้เพิ่ม', field: null }] },
          { id: 2, level: 'warn', issues: [{ code: 'no_criterion', level: 'warn', text: 'ยังไม่ตั้งเกณฑ์', field: 'indicator-criterion' }] },
          { id: 3, level: 'info', issues: [{ code: 'no_khd_link', level: 'info', text: 'ยังไม่เชื่อม', field: null }] },
          { id: 4, level: 'ok', issues: [] },
        ] } });
      expect(component.readinessCounts).toEqual({ block: 1, warn: 1, hostype_unset: 1, not_assigned: 2 });
      expect(component.readinessOf({ id: 1 })).toMatchObject({ level: 'block', count: 1 });
      expect(component.readinessOf({ id: 2 })).toMatchObject({ level: 'warn', count: 1 });
      expect(component.readinessOf({ id: 3 })).toBeNull();
      expect(component.readinessOf({ id: 4 })).toBeNull();
      expect(component.readinessTitle(component.readinessOf({ id: 1 })!)).toContain('ยังไม่ตั้งประเภทหน่วยบริการ');
      component.filterReadiness = 'block';
      expect([1, 2, 3, 4].filter(id => component.matchReadiness({ id }))).toEqual([1]);
      component.filterReadiness = 'not_assigned';
      expect([1, 2, 3, 4].filter(id => component.matchReadiness({ id }))).toEqual([1]);
      component.filterReadiness = '';
      expect([1, 2, 3, 4].filter(id => component.matchReadiness({ id }))).toEqual([1, 2, 3, 4]);
    });

    it('สถานะรายงาน KHD จากสำเนา: นับ/กรองรายงานที่ปิดใช้งานหรือไม่พบ + ข้อความเวลาที่อ่าน', () => {
      const http = TestBed.inject(HttpTestingController);
      component.loadReadiness();
      http.expectOne(r => r.url.includes('/indicators/readiness')).flush({ success: true, data: {
        counts: { warn: 2 }, by_code: { khd_inactive: 1, khd_report_missing: 1 },
        khd_snapshot: { available: true, refreshed_at: '2026-11-22T02:00:00Z', count: 150, error: null },
        items: [
          { id: 1, level: 'warn', issues: [{ code: 'khd_inactive', level: 'warn', text: 'รายงานใน KHD ปิดใช้งานในปีงบนี้', field: null }] },
          { id: 2, level: 'warn', issues: [{ code: 'khd_report_missing', level: 'warn', text: 'ไม่พบรายงาน', field: null }] },
          { id: 3, level: 'warn', issues: [{ code: 'no_criterion', level: 'warn', text: 'ยังไม่ตั้งเกณฑ์', field: 'indicator-criterion' }] },
        ] } });
      expect(component.readinessKhdCount).toBe(2);
      expect(component.khdSnapshotText).toContain('สถานะรายงาน KHD ณ');
      component.filterReadiness = 'khd_status';
      expect([1, 2, 3].filter(id => component.matchReadiness({ id }))).toEqual([1, 2]);
      component.khdSnapshot = { available: false, refreshed_at: null, count: 0, error: null };
      expect(component.khdSnapshotText).toBe('ยังไม่ได้อ่านสถานะรายงานจาก KHD');
    });
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

    it('เปิดเพิ่มใหม่ → ขอรหัสจากระบบมาแสดง และเปลี่ยนกลุ่มงานแล้วขอใหม่ตามกลุ่มงาน', () => {
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

    it('พิมพ์รหัสเอง → เลิกโหมดอัตโนมัติ ไม่ถูกทับเมื่อเปลี่ยนกลุ่มงาน และส่งค่าที่พิมพ์', () => {
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

  // ---- 24 พ.ย. 2569: จับคู่ด้วย report_id ↔ รหัสอ้างอิง (ตารางหลัก report_fiscal_year_config) ----
  describe('รหัสอ้างอิงเทียบกับ KHD', () => {
    beforeEach(() => {
      component.activeTab = 'indicators';
      component.indicators = [
        { id: 1, kpi_indicators_name: 'ก', table_process: 'tp1', kpi_indicators_id: '500', is_active: 1 },
        { id: 2, kpi_indicators_name: 'ข', table_process: 'tp_same', kpi_indicators_id: '123', is_active: 1 },
        { id: 3, kpi_indicators_name: 'ค', table_process: 'tp_same', kpi_indicators_id: '602', khd_report_id: 9, is_active: 1 },
        { id: 4, kpi_indicators_name: 'ง', table_process: 'tp4', kpi_indicators_id: '9', is_active: 1 },
      ];
      // คีย์ตามตัวชี้วัด (L<id>) — 2 ตัวชี้วัด table_process เดียวกันได้ผลเทียบคนละรายการ (เดิมคีย์ table_process ทับกัน)
      component.khdCompareMap = new Map<string, any>([
        ['L1', { status: 'match', local_id: 1, khd_report_id: 500, match_by: 'kpi_indicators_id', khd_data_source: 'excel' }],
        // ยังไม่จับคู่ — รหัสที่แนะนำ 601 / คู่ 602 แต่ลิงก์ khd_report_id ชี้รายงานอื่น (คีย์จับคู่ = รหัสอ้างอิง — 26 พ.ย. 2569)
        ['L2', { status: 'missing_remote', local_id: 2, khd_report_id: null, ref_suggest: { report_id: 601, report_name: 'ข', by: 'name' } }],
        ['L3', { status: 'tp_different', local_id: 3, khd_report_id: 602, match_by: 'kpi_indicators_id', khd_data_source: 'excel', ref_conflict: true }],
        ['L4', { status: 'missing_remote', local_id: 4, khd_report_id: null, khd_other_year: ['2569'] }],
        ['K700', { status: 'missing_local', khd_report_id: 700 }],
      ]);
    });

    it('khdRefState / นับ / กรอง "รหัสอ้างอิงไม่ตรง"', () => {
      const [a, b, c, d] = component.indicators;
      expect([component.khdRefState(a), component.khdRefState(b), component.khdRefState(c), component.khdRefState(d)]).toEqual(['match', 'mismatch', 'conflict', null]);
      expect(component.khdRefTarget(b)).toBe(601);
      expect(component.khdRefTarget(c)).toBe(602);
      expect(component.khdCounts.ref).toBe(2);
      expect(component.khdMissingLocalItems.map((x: any) => x.khd_report_id)).toEqual([700]);
      component.filterKhdStatus = 'ref';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toEqual([2, 3]);
      expect(component.khdMatchByText(b)).toBe('แนะนำจากชื่อที่ตรงกัน');
    });

    it('ใช้รหัส KHD: ส่งเฉพาะตัวที่ไม่ตรง + ปีงบที่เทียบ แล้วอัปเดตค่าปัจจุบัน', async () => {
      const Swal = (await import('sweetalert2')).default;
      const sw = vi.spyOn(Swal, 'fire').mockResolvedValue({ isConfirmed: true } as any);
      const http = TestBed.inject(HttpTestingController);
      component.khdCompareYear = '2570';
      component.applyKhdRef(component.indicators);
      await Promise.resolve(); await Promise.resolve();
      const req = http.expectOne(r => r.method === 'POST' && r.url.includes('/indicators/apply-khd-ref'));
      expect(req.request.body).toEqual({ ids: [2, 3], year_bh: '2570' });
      req.flush({ success: true, message: 'ok', updated: [{ id: 2, after: { kpi_indicators_id: '601', khd_report_id: 601, data_source: 'excel' } }], skipped: [] });
      expect(component.indicators[1].kpi_indicators_id).toBe('601');
      expect(component.khdRefState(component.indicators[1])).toBe('match');
      sw.mockRestore();
    });
  });

  // ---- 9 พ.ย. 2569: ประเภทตัวชี้วัด / ประเภทหน่วยบริการ ต่างจาก KHD ----
  describe('ประเภทตัวชี้วัด/ประเภทหน่วยบริการต่างจาก KHD', () => {
    beforeEach(() => {
      component.activeTab = 'indicators';
      component.hosTypes = [{ hostypecode: '05', hostypename: 'รพ.ศูนย์' }, { hostypecode: '07', hostypename: 'รพ.ชุมชน' }];
      component.indicators = [
        { id: 1, kpi_indicators_name: 'ก', table_process: 'tp1', is_active: 1, r9: 1, moph: 0, evaluation_mode: 'all_required', required_off_types: null },
        { id: 2, kpi_indicators_name: 'ข', table_process: 'tp2', is_active: 1, r9: 0, moph: 1, evaluation_mode: 'any_one', required_off_types: '["07"]' },
      ];
      component.khdCompareMap = new Map<string, any>([
        ['tp1', { status: 'match', table_process: 'tp1', types_match: false, khd_types: { r9: 0, moph: 1, ssj: 1, rmw: 0, other: 0 }, hostype_match: true }],
        ['tp2', { status: 'match', table_process: 'tp2', types_match: true, hostype_match: false, khd_eval_mode: 'any_one', khd_off_types: ['05', '07'] }],
      ]);
    });

    it('นับ/กรองแยก 2 อย่าง และแสดงค่าของระบบเทียบกับ KHD', () => {
      expect(component.khdCounts.types).toBe(1);
      expect(component.khdCounts.hostype).toBe(1);
      component.filterKhdStatus = 'types';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toEqual([1]);
      component.filterKhdStatus = 'hostype';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toEqual([2]);
      expect(component.localTypesText(component.indicators[0])).toBe('R9');
      expect(component.khdTypesText(component.getKhdData(component.indicators[0]))).toBe('MOPH, SSJ');
      expect(component.localHostypeText(component.indicators[1])).toBe('รพ.ชุมชน (07)');
      expect(component.khdHostypeText(component.getKhdData(component.indicators[1]))).toBe('รพ.ศูนย์ (05), รพ.ชุมชน (07)');
    });

    it('หน้าต่างรายละเอียดความแตกต่าง: นับตามหัวข้อ กรองหัวข้อ/ค้นหา และเปิดเฉพาะตัวชี้วัดเดียวได้', () => {
      component.openKhdDiff();
      expect(component.showKhdDiff).toBe(true);
      expect(component.khdDiffCounts).toEqual({ all: 2, types: 1, hostype: 1 });
      component.khdDiffKind = 'hostype';
      component.refreshKhdDiff();
      expect(component.khdDiffRows.map(r => r.id)).toEqual([2]);
      component.khdDiffKind = '';
      component.khdDiffSearch = 'tp1';
      component.refreshKhdDiff();
      expect(component.khdDiffRows.map(r => r.kind)).toEqual(['types']);
      component.openKhdDiff(component.indicators[1]);
      expect(component.khdDiffAll.map(r => r.id)).toEqual([2]);
    });

    it('ใช้ค่า KHD ทั้งหมดรายหัวข้อ: นับตามสิทธิ์ ส่งเฉพาะ id ของหัวข้อนั้น และหลายหัวข้อเรียกตามลำดับ (16 พ.ย. 2569)', async () => {
      component.canEditData = true;
      component.canAddData = false;
      component.isSuperAdmin = false;
      component.openKhdDiff();
      expect(component.khdApplyCounts).toEqual(expect.objectContaining({ all: 2, types: 1, hostype: 1, name: 0, status: 0 }));
      component.khdDiffSearch = 'tp2';
      component.refreshKhdDiff();
      expect(component.khdApplyCounts['all']).toBe(1);   // ตามการค้นหา
      component.khdDiffSearch = '';
      component.refreshKhdDiff();
      component.canEditData = false;
      component.refreshKhdDiff();
      expect(component.khdApplyCounts['all']).toBe(0);   // ไม่มีสิทธิ์แก้ไข = ไม่มีปุ่ม
      component.canEditData = true;
      component.refreshKhdDiff();

      const http = TestBed.inject(HttpTestingController);
      const swal = vi.spyOn(Swal, 'fire').mockResolvedValue({} as any);
      const reload = vi.spyOn(component, 'loadAllData').mockImplementation(() => {});
      const compare = vi.spyOn(component, 'runKhdCompare').mockImplementation(() => {});
      fixture.detectChanges();   // ngOnInit (เรียก loadAllData) ก่อนวัด
      reload.mockClear();
      const done = component.runKhdApplyKinds(['types', 'hostype']);
      const r1 = http.expectOne(r => r.url.includes('/indicators/apply-khd-types'));
      expect(r1.request.body).toEqual(expect.objectContaining({ ids: [1], parts: ['types'] }));
      r1.flush({ success: true, message: 'ปรับ 1 ตัว' });
      await new Promise(r => setTimeout(r, 0));
      const r2 = http.expectOne(r => r.url.includes('/indicators/apply-khd-types'));
      expect(r2.request.body).toEqual(expect.objectContaining({ ids: [2], parts: ['hostype'] }));
      r2.flush({ success: false, message: 'KHD ไม่ตั้งค่า' });
      await done;
      const last = swal.mock.calls[swal.mock.calls.length - 1][0] as any;
      expect(last.title).toBe('ปรับได้บางส่วน');
      expect(last.html).toContain('ประเภทตัวชี้วัด: ปรับ 1 ตัว');
      expect(last.html).toContain('ประเภทหน่วยบริการ: ไม่สำเร็จ — KHD ไม่ตั้งค่า');
      expect(reload).toHaveBeenCalledTimes(1);
      expect(compare).toHaveBeenCalledTimes(1);
      swal.mockRestore();
    });

    it('สถานะใน KHD: ปิดส่งออกได้เฉพาะตัวที่ยังส่งออก (ต้องมีสิทธิ์เพิ่ม) ส่งออกปิดแล้ว = ไม่มีปุ่ม', async () => {
      component.indicators.push(
        { id: 41, kpi_indicators_name: 'ส่งออกอยู่', table_process: 'tp41', is_active: 1, upload_excel: 0 },
        { id: 42, kpi_indicators_name: 'ปิดแล้ว', table_process: 'tp42', is_active: 1, upload_excel: 1 });
      component.khdCompareMap.set('tp41', { status: 'match', table_process: 'tp41', khd_is_active: 0 });
      component.khdCompareMap.set('tp42', { status: 'match', table_process: 'tp42', khd_is_active: 0 });
      component.canAddData = false;
      component.openKhdDiff();
      expect(component.khdDiffCounts['status']).toBe(2);
      expect(component.khdApplyCounts['status']).toBe(0);
      component.canAddData = true;
      component.refreshKhdDiff();
      expect(component.khdApplyCounts['status']).toBe(1);
      const http = TestBed.inject(HttpTestingController);
      const p = component.runKhdApplyKind('status', component.khdDiffAll.filter(r => r.kind === 'status' && r.applicable !== false));
      const req = http.expectOne(r => r.url.includes('/indicators/bulk-upload-excel'));
      expect(req.request.body).toEqual(expect.objectContaining({ ids: [41], upload_excel: 1 }));
      req.flush({ success: true, affected: 1 });
      expect(await p).toBe('ปิดส่งออก KHD 1 ตัว');
    });

    it('table_process ทั้งหัวข้อ: เรียกทีละตัว ตัวที่ server ปฏิเสธถูกข้ามพร้อมเหตุผล', async () => {
      component.indicators.push(
        { id: 51, kpi_indicators_name: 'ก', table_process: 'tp51', is_active: 1 },
        { id: 52, kpi_indicators_name: 'ข', table_process: 'tp52', is_active: 1 });
      component.khdCompareMap.set('tp51', { status: 'tp_different', table_process: 'tp51', khd_table_process: 'k51', khd_report_id: 91 });
      component.khdCompareMap.set('tp52', { status: 'tp_different', table_process: 'tp52', khd_table_process: 'k52', khd_report_id: 92 });
      component.canEditData = true;
      component.openKhdDiff();
      const http = TestBed.inject(HttpTestingController);
      const p = component.runKhdApplyKind('table_process', component.khdDiffAll.filter(r => r.kind === 'table_process'));
      const a = http.expectOne(r => r.url.includes('/apply-khd-table-process'));
      expect(a.request.body).toEqual({ id: 51, khd_report_id: 91 });
      a.flush({ success: true });
      await new Promise(r => setTimeout(r, 0));
      const b = http.expectOne(r => r.url.includes('/apply-khd-table-process'));
      expect(b.request.body).toEqual({ id: 52, khd_report_id: 92 });
      b.flush({ success: false, message: 'มีตารางชื่อเดิมอยู่' }, { status: 409, statusText: 'Conflict' });
      expect(await p).toBe('เปลี่ยน 1 ตัว · ข้าม 1 ตัว (tp52: มีตารางชื่อเดิมอยู่)');
    });

    it('table_process ต่างกัน: นับ/กรองเป็นสถานะแยก และส่ง id + khd_report_id ไปเปลี่ยน', () => {
      component.indicators.push({ id: 3, kpi_indicators_name: 'ค', table_process: 'tp3_local', is_active: 1 });
      component.khdCompareMap.set('tp3_local', { status: 'tp_different', table_process: 'tp3_local', khd_table_process: 'tp3_khd', khd_report_id: 77 });
      expect(component.getKhdCompareStatus(component.indicators[2])).toBe('tp_different');
      expect(component.khdCounts.tp_different).toBe(1);
      component.filterKhdStatus = 'tp_different';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toEqual([3]);
      const http = TestBed.inject(HttpTestingController);
      (component as any).authService.applyKhdTableProcess(3, 77).subscribe();
      const req = http.expectOne(r => r.method === 'POST' && r.url.includes('/indicators/apply-khd-table-process'));
      expect(req.request.body).toEqual({ id: 3, khd_report_id: 77 });
    });

    it('table_process ต่างกัน: ทุกคู่ใช้ table_process ของ KHD ได้ (รวมที่ใช้ร่วมกับตัวชี้วัดอื่น) + แถบสรุปเปิดหน้าต่างเฉพาะหัวข้อ (26 พ.ย. 2569)', () => {
      component.indicators.push(
        { id: 31, kpi_indicators_name: 'ก', table_process: 'tp31', is_active: 1 },
        { id: 32, kpi_indicators_name: 'ข', table_process: 'tp32', is_active: 1 });
      component.khdCompareMap.set('tp31', { status: 'tp_different', table_process: 'tp31', khd_table_process: 'kx', khd_report_id: 81 });
      component.khdCompareMap.set('tp32', { status: 'tp_different', table_process: 'tp32', khd_table_process: 'ks', khd_report_id: 82, khd_tp_shared: 3, khd_tp_used_by: { id: 1, name: 'ค', count: 1 } });
      expect(component.khdTpCounts).toEqual({ apply: 2 });
      component.openKhdTpDiff();
      expect(component.khdDiffKind).toBe('table_process');
      expect(component.khdDiffRows.map(r => [r.id, r.applicable])).toEqual([[31, undefined], [32, undefined]]);
      const swal = vi.spyOn(Swal, 'fire').mockResolvedValue({} as any);
      component.applyKhdTableProcess(component.indicators.find((i: any) => i.id === 32));
      expect(swal).toHaveBeenCalledWith(expect.objectContaining({ title: 'ใช้ table_process ของ KHD' }));
      swal.mockRestore();
    });

    it('ปีงบประมาณ: นับ/กรอง "ปีงบต่างกัน" จากค่าปัจจุบัน + กรองไม่ระบุปีงบ + ปรับค่าในรายการทันทีหลังบันทึก', () => {
      component.indicators.push(
        { id: 4, kpi_indicators_name: 'ง', table_process: 'tp4', is_active: 1, khd_fiscal_year: '2570' },
        { id: 5, kpi_indicators_name: 'จ', table_process: 'tp5', is_active: 1, khd_fiscal_year: null });
      component.khdCompareMap.set('tp4', { status: 'match', table_process: 'tp4', khd_fiscal_years: ['2569', '2570'] });
      component.khdCompareMap.set('tp5', { status: 'match', table_process: 'tp5', khd_fiscal_years: [] });   // KHD ไม่มีปีงบ = ไม่นับต่าง
      expect(component.khdFiscalYearMatch(component.indicators.find((i: any) => i.id === 4))).toBe(false);
      expect(component.khdFiscalYearMatch(component.indicators.find((i: any) => i.id === 5))).toBeNull();
      expect(component.khdCounts.fiscal_year).toBe(1);
      component.filterKhdStatus = 'fiscal_year';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toEqual([4]);
      component.filterKhdStatus = '';
      component.filterFiscalYear = '__none';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toContain(5);
      expect(component.filteredIndicators.map((i: any) => i.id)).not.toContain(4);
      component.applyFiscalYearUpdates([{ id: 4, after: '2569,2570' }, { id: 5, after: '2570' }]);
      expect(component.khdCounts.fiscal_year).toBe(0);
      expect(component.filteredIndicators.map((i: any) => i.id)).not.toContain(5);
      const http = TestBed.inject(HttpTestingController);
      (component as any).authService.setIndicatorFiscalYear([5], ['2570'], 'add').subscribe();
      expect(http.expectOne(r => r.method === 'POST' && r.url.includes('/indicators/set-fiscal-year')).request.body).toEqual({ ids: [5], years: ['2570'], mode: 'add' });
      (component as any).authService.applyKhdFiscalYear([4]).subscribe();
      expect(http.expectOne(r => r.method === 'POST' && r.url.includes('/indicators/apply-khd-fiscal-year')).request.body).toEqual({ ids: [4] });
    });

    it('ปีงบประมาณในหน้าต่างตัวชี้วัด: เลือก/ยกเลิก แล้วส่ง khd_fiscal_year', () => {
      component.setModalFiscalYears(['2565']);
      expect(component.modalFiscalYearChoices).toContain('2565');
      component.toggleModalFiscalYear('2570');
      component.toggleModalFiscalYear('2565');
      expect(component.modalFiscalYears).toEqual(['2570']);
    });

    it('ปีงบประมาณแบบ dropdown: ตัวเลือก = ปีที่ยังไม่ได้เลือก, เพิ่ม/เอาออกแล้วตัวเลือกเปลี่ยนตาม', () => {
      component.setModalFiscalYears(['2570']);
      expect(component.modalFiscalYearAvailable).not.toContain('2570');
      const other = component.modalFiscalYearAvailable[0];
      component.addModalFiscalYear(other);
      component.addModalFiscalYear('');        // ตัวเลือกว่าง ("+ เลือกปีงบประมาณ") = ไม่เปลี่ยน
      expect(component.modalFiscalYears).toEqual([other, '2570'].sort());
      expect(component.modalFiscalYearAvailable).not.toContain(other);
      component.removeModalFiscalYear('2570');
      expect(component.modalFiscalYears).toEqual([other]);
      expect(component.modalFiscalYearAvailable).toContain('2570');
    });

    it('กลุ่มงาน/หมวดหมู่หลัก: นับ/กรอง ชิปแยก แถวในหน้าต่างรายละเอียด และปรับค่าในรายการทันทีหลังบันทึก (11 พ.ย. 2569)', () => {
      component.departments = [{ id: 1, dept_name: 'กลุ่มงาน ก' }, { id: 2, dept_name: 'กลุ่มงาน ข' }];
      component.mainIndicators = [{ id: 10, main_indicator_name: 'หมวด ก' }];
      component.indicators.push(
        { id: 6, kpi_indicators_name: 'ฉ', table_process: 'tp6', is_active: 1, dept_id: 1, main_indicator_id: null },
        { id: 7, kpi_indicators_name: 'ช', table_process: 'tp7', is_active: 1, dept_id: 1, main_indicator_id: 10 });
      component.khdCompareMap.set('tp6', { status: 'match', table_process: 'tp6', khd_dept_status: 'auto', khd_dept_id: 2, khd_dept_name: 'กลุ่มงาน ข', khd_dept_value: 'NCD',
        khd_main_status: 'mapped', khd_main_id: 10, khd_main_name: 'หมวด ก', khd_main_value: 'หมวด ก' });
      component.khdCompareMap.set('tp7', { status: 'match', table_process: 'tp7', khd_dept_status: 'unmatched', khd_dept_id: null, khd_dept_value: 'XYZ',
        khd_main_status: 'auto', khd_main_id: 10, khd_main_name: 'หมวด ก' });
      expect(component.khdCounts.dept).toBe(1);
      expect(component.khdCounts.main).toBe(1);
      expect(component.khdOrgUnmatchedCount).toBe(1);
      component.filterKhdStatus = 'dept';
      component.applyFilter();
      expect(component.filteredIndicators.map((i: any) => i.id)).toEqual([6]);
      expect(component.localOrgText(component.indicators.find((i: any) => i.id === 6), 'dept')).toBe('กลุ่มงาน ก');
      component.openKhdDiff(component.indicators.find((i: any) => i.id === 6));
      expect(component.khdDiffAll.map(r => r.kind)).toEqual(['dept', 'main']);
      component.applyOrgUpdates([{ id: 6, after: { dept_id: 2, main_indicator_id: 10 } }]);
      expect(component.khdCounts.dept).toBe(0);
      expect(component.khdCounts.main).toBe(0);
      expect(component.indicators.find((i: any) => i.id === 6).dept_name).toBe('กลุ่มงาน ข');
      expect(component.khdDiffAll.length).toBe(0);
      const http = TestBed.inject(HttpTestingController);
      (component as any).authService.applyKhdOrg([6], ['dept']).subscribe();
      expect(http.expectOne(r => r.method === 'POST' && r.url.includes('/indicators/apply-khd-org')).request.body).toEqual({ ids: [6], parts: ['dept'] });
    });

    it('เรียก API ด้วยรายการ ปีงบ และส่วนที่จะปรับ', () => {
      const http = TestBed.inject(HttpTestingController);
      (component as any).authService.applyKhdTypes([2], '2570', ['hostype']).subscribe();
      const req = http.expectOne(r => r.method === 'POST' && r.url.includes('/indicators/apply-khd-types'));
      expect(req.request.body).toEqual({ ids: [2], year_bh: '2570', parts: ['hostype'] });
    });
  });

  // ---- 19 ต.ค. 2569: จับคู่ข้อมูล KHD (กลุ่มงาน / หมวดหมู่หลัก / ยุทธศาสตร์) ----
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

    // ผู้ช่วย AI ระยะที่ 3 (7 พ.ย. 2569): ข้อเสนอแนบที่แถว — "ใช้" แค่เลือกในช่อง ไม่บันทึกเอง
    it('AI แนะนำการจับคู่: แนบข้อเสนอที่แถว, "ใช้" เลือกรายการโดยไม่ส่งคำขอบันทึก, สลับแท็บแล้วข้อเสนอเดิมถูกล้าง', () => {
      component.openKhdMapping('dept');
      http.expectOne(r => r.url.includes('/khd-mappings')).flush({ success: true, items: items(), options: [{ id: 6, name: 'กลุ่มงาน NCD' }, { id: 13, name: 'กลุ่มงาน 13' }], summary: { total: 2, unmatched: 1, auto: 1 } });
      component.suggestKhdMapAi();
      const req = http.expectOne(r => r.method === 'POST' && r.url.includes('/ai/khd-mapping-suggest'));
      expect(req.request.body).toEqual({ kind: 'dept' });
      req.flush({ success: true, total: 1, truncated: false, suggestions: [{ khd_value: 'ทต.', local_id: 13, local_name: 'กลุ่มงาน 13', confidence: 72, reason: 'ชื่อใกล้เคียง' }] });
      const row = component.khdMapItems[1];
      expect(row._ai).toEqual(expect.objectContaining({ local_id: 13, confidence: 72 }));
      expect(row._pick).toBeNull();                 // ยังไม่เลือกให้จนกว่าจะกด "ใช้"
      expect(component.khdMapAiNote).toContain('1 จาก 1');
      component.useKhdAi(row);
      expect(row._pick).toBe(13);
      http.expectNone(r => r.method === 'PUT');      // ไม่บันทึกเอง
      component.loadKhdMapping('yut');
      expect(component.khdMapAiNote).toBe('');
    });

    it('AI แนะนำการจับคู่: ข้อผิดพลาดแสดงในหน้าต่าง / id ที่ไม่อยู่ในตัวเลือกกด "ใช้" ไม่ได้', () => {
      component.openKhdMapping('dept');
      http.expectOne(r => r.url.includes('/khd-mappings')).flush({ success: true, items: items(), options: [{ id: 6, name: 'กลุ่มงาน NCD' }], summary: { unmatched: 1 } });
      component.suggestKhdMapAi();
      http.expectOne(r => r.url.includes('/ai/khd-mapping-suggest')).flush({ success: false, message: 'ใช้ผู้ช่วย AI ครบโควตาของวันนี้แล้ว' }, { status: 429, statusText: 'Too Many' });
      expect(component.khdMapAiError).toContain('โควตา');
      const row = component.khdMapItems[1];
      row._ai = { khd_value: 'ทต.', local_id: 99, local_name: 'x', confidence: 90 };
      component.useKhdAi(row);
      expect(row._pick).toBeNull();
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

    it('หน่วยนับผลงาน: เปิดแก้ไขได้ค่าเดิม → บันทึกส่ง unit + มีตัวเลือกหน่วยทั่วไป (13 พ.ย. 2569)', () => {
      component.activeTab = 'indicators';
      component.openModal({ id: 6, kpi_indicators_name: 'x', unit: 'ราย', evaluation_mode: 'all_required' });
      expect(component.currentItem.unit).toBe('ราย');
      component.currentItem.unit = 'แห่ง';
      component.saveItem();
      const req = http.expectOne(r => r.method === 'PUT' && r.url.includes('/indicators/6'));
      expect(req.request.body.unit).toBe('แห่ง');
      expect(component.UNIT_OPTIONS).toEqual(expect.arrayContaining(['ร้อยละ', 'ราย', 'แห่ง']));
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
      expect(it).toEqual({ result_formula: 'MAX(ALL)', is_cumulative: false, result_manual: false });
      applyResultMethod(it, 'sum');
      expect(it).toEqual({ result_formula: '', is_cumulative: true, result_manual: false });
      applyResultMethod(it, 'custom');
      expect(it).toEqual({ result_formula: '', is_cumulative: false, result_manual: false });
    });

    it('วิธีคิดผลงาน "กรอกเอง" ↔ result_manual (ล้างสูตร/สะสม) — 29 ต.ค. 2569', () => {
      expect(resultMethodOf({ result_manual: 1, result_formula: 'AVG(ALL)' })).toBe('manual');
      expect(resultMethodOf({ result_manual: 0, result_formula: '' })).toBe('last');
      const it: any = { result_formula: 'SUM(m10, m11)', is_cumulative: true, result_manual: false };
      applyResultMethod(it, 'manual');
      expect(it).toEqual({ result_formula: '', is_cumulative: false, result_manual: true });
      applyResultMethod(it, 'last');
      expect(it.result_manual).toBe(false);
      expect(component.RESULT_METHODS.some(m => m.v === 'manual')).toBe(true);
    });

    it('กรอกร้อยละเอง → ไม่ตรวจสูตรร้อยละ (สูตรค้างที่ผิดไม่บล็อกการบันทึก)', () => {
      component.currentItem = { pct_formula: 'result /', custom_vars: [], pct_manual: false };
      expect(component.pctFormulaError).toBeTruthy();
      component.currentItem.pct_manual = true;
      expect(component.pctFormulaError).toBeNull();
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
      expect(component.formulaTestResult?.pct).toBe(100);   // ≤ ไม่เกินเป้าหมาย = 100%
      component.formulaTestMonths = { m10: '10' };
      expect(component.formulaTestResult?.pct).toBe(80);
    });
  });
  describe('ค่าฐาน (base) ในกล่องสูตร', () => {
    it('ทดลองคำนวณสูตรที่ใช้ค่าฐาน + วิธีคิดผลงานเป็นสูตรกำหนดเอง', () => {
      component.currentItem = { result_formula: '(base - SUM(ALL)) / base * 100', target_condition: 'GTE' };
      expect(component.formulaUsesBase).toBe(true);
      expect(component.resultMethod).toBe('custom');
      component.formulaTestMonths = { m10: '14' };
      component.formulaTestTarget = '30';
      component.formulaTestBase = '173.8';
      expect(component.formulaTestResult?.value).toBe('91.94');
      component.currentItem = { result_formula: 'AVG(ALL)' };
      expect(component.formulaUsesBase).toBe(false);
    });
  });
  describe('ค่าเพิ่มเติม + สูตรร้อยละ ในหน้าต่างตัวชี้วัด', () => {
    it('ตรวจชื่อค่าเพิ่มเติม + สูตรอ้างชื่อที่ประกาศ + สูตรร้อยละใช้ result', () => {
      component.currentItem = { custom_vars: [{ key: 'pop', label: 'ประชากร' }], result_formula: 'SUM(ALL) / pop * 100000', pct_formula: '' };
      expect(component.customVarsError).toBeNull();
      expect(component.formulaError).toBeNull();
      component.currentItem.custom_vars.push({ key: 'result', label: 'x' });
      expect(component.customVarsError).toContain('result');
      component.currentItem.custom_vars.pop();
      component.currentItem.pct_formula = 'result / popx';
      expect(component.pctFormulaError).toContain('popx');
      component.currentItem.pct_formula = '(target - result) / target * 100 + 100';
      expect(component.pctFormulaError).toBeNull();
      component.currentItem.custom_vars = [];
      expect(component.formulaError).toContain('pop');
    });

    it('ทดลองคำนวณ: ค่าเพิ่มเติม + ร้อยละตามสูตรร้อยละ', () => {
      component.currentItem = { custom_vars: [{ key: 'pop', label: 'ประชากร' }], result_formula: 'SUM(ALL) / pop * 100000', pct_formula: '(target - result) / target * 100 + 100' };
      component.formulaTestMonths = { m10: '1' };
      component.formulaTestTarget = '5.5';
      component.formulaTestVars = { pop: '25000' };
      expect(component.formulaTestVarKeys).toEqual(['pop']);
      expect(component.formulaTestResult?.value).toBe('4');
      expect(component.formulaTestResult?.pct).toBe(127.27);
      expect(component.pctTestResult).toBe(127.27);
    });

    it('ทดลองสูตรร้อยละที่ใช้ค่ารายเดือน (ไม่มีสูตรผลงาน) → มีช่องรายเดือนและคำนวณได้ (13 พ.ย. 2569)', () => {
      component.currentItem = { custom_vars: [], result_formula: '', pct_formula: '(SUM(ALL) - target ) / target * 100' };
      component.formulaTestResultInput = '2';
      component.formulaTestTarget = '3';
      expect(component.pctUsesMonths).toBe(true);
      expect(component.pctTestResult).toBeNull();   // เดิม: กรอกแค่ผลงาน/เป้าหมาย ค่ารายเดือนว่าง = คำนวณไม่ได้
      component.formulaTestMonths = { m10: '2', m11: '4' };
      expect(component.pctTestResult).toBe(100);    // (6 - 3) / 3 * 100
      component.currentItem.pct_formula = 'result / target * 100';
      expect(component.pctUsesMonths).toBe(false);
      component.currentItem.pct_formula = '(m10 + m11) / target * 100';
      expect(component.pctUsesMonths).toBe(true);
      component.currentItem.pct_formula = 'result / prev_result * 100';
      expect([component.pctUsesMonths, component.pctUsesPrev]).toEqual([false, true]);
    });
  });

  describe('รอบการวัดผล (quarter_mode — 10 พ.ย. 2569)', () => {
    it('quarterModeParts ↔ quarterModeFrom', () => {
      expect(quarterModeParts('')).toEqual({ period: 'month', entry: 'month', agg: 'sum' });
      expect(quarterModeParts('quarter')).toEqual({ period: 'quarter', entry: 'quarter', agg: 'sum' });
      expect(quarterModeParts('month_avg')).toEqual({ period: 'quarter', entry: 'month', agg: 'avg' });
      expect(quarterModeFrom({ period: 'month', entry: 'quarter', agg: 'avg' })).toBe('');
      expect(quarterModeFrom({ period: 'quarter', entry: 'quarter', agg: 'avg' })).toBe('quarter');
      expect(quarterModeFrom({ period: 'quarter', entry: 'month', agg: 'last' })).toBe('month_last');
    });

    it('เปลี่ยนรอบการวัดผล → วิธีคิดผลงาน "ค่าไตรมาสล่าสุด" ตามค่าของไตรมาส (วิธีอื่นที่ตั้งไว้คงเดิม)', () => {
      const it: any = { result_formula: '', is_cumulative: false, quarter_mode: '' };
      setQuarterMode(it, 'month_sum');
      expect(it.result_formula).toBe('LASTQ(SUM)');
      expect(resultMethodOf(it)).toBe('quarter');
      setQuarterMode(it, 'month_avg');
      expect(it.result_formula).toBe('LASTQ(AVG)');
      setQuarterMode(it, 'quarter');
      expect(it.result_formula).toBe('');
      expect(resultMethodOf(it)).toBe('last');
      const cum: any = { result_formula: '', is_cumulative: true, quarter_mode: '' };
      setQuarterMode(cum, 'month_sum');
      expect(cum.result_formula).toBe('');
      expect(resultMethodOf(cum)).toBe('sum');
    });

    it('ตัวเลือกในหน้าต่าง: รายไตรมาส + บันทึกรายเดือน + เฉลี่ย → quarter_mode และรายการวิธีคิดผลงานมี "ค่าไตรมาสล่าสุด"', () => {
      component.currentItem = { result_formula: '', is_cumulative: false, quarter_mode: '' };
      expect(component.resultMethodOptions).toBe(component.RESULT_METHODS);
      component.quarterPeriod = 'quarter';
      expect(component.currentItem.quarter_mode).toBe('month_sum');   // ค่าตั้งต้น = บันทึกรายเดือนเหมือนเดิม รวม 3 เดือน
      component.quarterEntry = 'quarter';
      expect(component.currentItem.quarter_mode).toBe('quarter');
      component.quarterEntry = 'month';
      component.quarterAgg = 'avg';
      expect(component.currentItem.quarter_mode).toBe('month_avg');
      expect(component.resultMethod).toBe('quarter');
      expect(component.resultMethodOptions).toBe(component.RESULT_METHODS_QUARTER);
      component.quarterPeriod = 'month';
      expect(component.currentItem.quarter_mode).toBe('');
      expect(component.currentItem.result_formula).toBe('');
    });
  });
});
