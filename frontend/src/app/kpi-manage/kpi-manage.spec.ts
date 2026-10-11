import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { KpiManageComponent } from './kpi-manage';
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
});
