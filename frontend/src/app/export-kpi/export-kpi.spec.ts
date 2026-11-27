import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ExportKpiComponent } from './export-kpi';
import { testProviders } from '../testing/test-providers';

// Export 3 ระดับ (18 ต.ค. 2569): ป้าย "+ รายละเอียด" และสรุปผลตาราง <table_process>_items
describe('ExportKpiComponent — รายละเอียดข้อย่อย/กิจกรรม', () => {
  let component: ExportKpiComponent;
  let fixture: ComponentFixture<ExportKpiComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ExportKpiComponent], providers: testProviders }).compileComponents();
    fixture = TestBed.createComponent(ExportKpiComponent);
    component = fixture.componentInstance;
  });

  it('แสดงป้าย "+ รายละเอียด" เฉพาะตัวชี้วัดที่เปิดส่งออกรายละเอียด', () => {
    component.filteredExportIndicators = [
      { id: 1, kpi_indicators_name: 'ตัวชี้วัด ก', table_process: 'kpi_a_001', export_items: 1, is_active: 1 },
      { id: 2, kpi_indicators_name: 'ตัวชี้วัด ข', table_process: 'kpi_b_001', export_items: 0, is_active: 1 },
    ];
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    // 27 พ.ย. 2569: รายการเป็นตาราง (1 แถว = 1 ตัวชี้วัด) แทนรายการ label
    const rows = Array.from(el.querySelectorAll('#kpi-export-table tbody tr[data-ind]'));
    const withBadge = rows.filter(l => l.textContent?.includes('+ รายละเอียด')).map(l => l.textContent || '');
    expect(withBadge.length).toBe(1);
    expect(withBadge[0]).toContain('ตัวชี้วัด ก');
  });

  it('ตารางเดียว: แถวแสดงสถานะตารางในระบบ/KHD + ปุ่มสร้างใน KHD เฉพาะที่มีตารางในระบบแล้ว (27 พ.ย. 2569)', () => {
    component.isSuperAdminStrict = true;
    component.exportYear = '2570';
    component.exportIndicators = [
      { id: 1, kpi_indicators_name: 'ตัวชี้วัด ก', table_process: 'kpi_a_001', upload_excel: 0, is_active: 1 },
      { id: 2, kpi_indicators_name: 'ตัวชี้วัด ข', table_process: 'kpi-b-001', upload_excel: 1, is_active: 1 },
    ];
    component.structMap = new Map<string, any>([
      ['kpi_a_001', { table: 'kpi_a_001', local: { exists: true, row_count: 32, year_rows: 32, year_filled: 0 }, remote: { exists: false } }],
    ]);
    component.khdAvailable = true;
    component.refreshBadges();
    fixture.detectChanges();
    const row = (id: number) => (fixture.nativeElement as HTMLElement).querySelector(`tr[data-ind="${id}"]`) as HTMLElement;
    expect(row(1).querySelector('[data-local]')!.getAttribute('data-local')).toBe('blank');   // มีแถวแต่ค่าว่าง (กรณีผู้ใช้รายงาน)
    expect(row(1).querySelector('[data-khd]')!.getAttribute('data-khd')).toBe('none');
    expect(row(1).querySelector('[data-act="push"]')).toBeTruthy();
    expect(row(1).textContent).toContain('ส่ง KHD');
    expect(row(2).querySelector('[data-local]')!.getAttribute('data-local')).toBe('none');   // ยังไม่มีตาราง → ส่งออกแล้วสร้างให้เอง
    expect(row(2).textContent).toContain('ส่งออกแล้วสร้างให้เอง');
    expect(row(2).querySelector('[data-act="push"]')).toBeNull();
    expect(row(2).textContent).toContain('ไม่ส่ง KHD');
    // ตัวกรองสถานะตาราง
    component.filterTable = 'local:none';
    component.applyFilters();
    expect(component.filteredExportIndicators.map(i => i.id)).toEqual([2]);
  });

  it('ค้นหา: ตัวชี้วัดที่ชื่อว่างไม่ทำให้ตัวกรองล้ม + ค้นชื่อตารางแบบขีดล่างเจอตารางที่ใช้ขีดกลาง (บั๊กปุ่มค้าง "กำลังส่งออก..." 27 พ.ย. 2569)', () => {
    component.exportIndicators = [
      { id: 1, kpi_indicators_name: null, table_process: 'kpi-main-2568-2103', is_active: 1 },
      { id: 2, kpi_indicators_name: 'ตัวชี้วัด ข', table_process: null, is_active: 1 },
    ];
    component.exportSearch = 'kpi_main_2568_2103';
    expect(() => component.applyFilters()).not.toThrow();
    expect(component.filteredExportIndicators.map(i => i.id)).toEqual([1]);
    component.exportSearch = 'ตัวชี้วัด ข';
    component.applyFilters();
    expect(component.filteredExportIndicators.map(i => i.id)).toEqual([2]);
  });

  it('ค้นหาแล้วเลือกเฉพาะรายการที่แสดง — ไม่ส่งออกตัวชี้วัดที่ถูกซ่อนไปด้วย (27 พ.ย. 2569)', () => {
    component.exportIndicators = [1, 2, 3].map(id => ({ id, kpi_indicators_name: 'ตัวชี้วัด ' + id, table_process: 'kpi_t_00' + id, is_active: 1 }));
    component.selectedIndicatorIds = new Set([1, 2, 3]);   // เลือกทั้งหมดตอนโหลด
    component.exportSearch = 'kpi_t_002';
    component.onFilterChange();                            // ช่องค้นหาเรียก onFilterChange
    expect([...component.selectedIndicatorIds]).toEqual([2]);
  });

  it('ตัวกรองคุณสมบัติตัวชี้วัด: ใช้คุณสมบัติเต็มจาก GET /indicators + เลือกเฉพาะที่แสดง + ล้างตัวกรอง (27 พ.ย. 2569)', () => {
    component.exportIndicators = [
      { id: 1, kpi_indicators_name: 'ก', table_process: 'kpi_a', upload_excel: 0, is_active: 1 },
      { id: 2, kpi_indicators_name: 'ข', table_process: 'kpi_b', upload_excel: 1, is_active: 1 },
      { id: 3, kpi_indicators_name: 'ค', table_process: 'kpi_c', upload_excel: 0, is_active: 1 },
    ];
    component.metaById = new Map<number, any>([
      [1, { id: 1, r9: 1, result_formula: 'SUM(ALL)', khd_fiscal_year: '2570' }],
      [3, { id: 3, ssj: 1, is_cumulative: 1, khd_fiscal_year: '2569' }],
    ]);
    component.selectedIndicatorIds = new Set([1, 2, 3]);
    component.attrFilter.method = 'formula';
    component.onAttrFilterChange();
    expect(component.filteredExportIndicators.map(i => i.id)).toEqual([1]);
    expect([...component.selectedIndicatorIds]).toEqual([1]);
    expect(component.attrCount).toBe(1);
    component.attrFilter.method = '';
    component.attrFilter.khd = 'on';
    component.attrFilter.fy = '2569';
    component.onAttrFilterChange();
    expect(component.filteredExportIndicators.map(i => i.id)).toEqual([3]);
    component.clearFilters();
    expect(component.attrCount).toBe(0);
    expect(component.filteredExportIndicators.length).toBe(3);
  });

  it('สรุปผลส่งออกแสดงจำนวนแถวของตาราง _items และเหตุผลเมื่อข้าม', () => {
    component.exportResult = {
      success: true, summary: { inserted: 1, updated: 0, unchanged: 0, no_data: 0 },
      created_tables: [
        { table: 'kpi_a_001', total_hospcode: 1, inserted: 1, updated: 0, unchanged: 0, no_data: 0,
          items: { table: 'kpi_a_001_items', rows: 4, inserted: 3, updated: 1, unchanged: 0, removed: 1 } },
        { table: 'kpi_long', total_hospcode: 1, inserted: 0, updated: 0, unchanged: 1, no_data: 0,
          items: { skipped: 'ชื่อตารางยาวเกิน 58 ตัวอักษร — สร้างตาราง _items ไม่ได้' } },
      ],
      skipped: [],
    };
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('kpi_a_001_items');
    expect(text).toContain('4 แถว');
    expect(text).toContain('−1');
    expect(text).toContain('ชื่อตารางยาวเกิน 58 ตัวอักษร');
  });
});

describe('ExportKpiComponent — แถวตารางรายละเอียดในหน้าต่างสรุปผล', () => {
  it('itemsPopupRow: แสดงชื่อตาราง _items และจำนวน, ไม่มี items = ว่าง', async () => {
    await TestBed.configureTestingModule({ imports: [ExportKpiComponent], providers: testProviders }).compileComponents();
    const c = TestBed.createComponent(ExportKpiComponent).componentInstance;
    const esc = (s: string) => s;
    expect(c.itemsPopupRow({ table: 'a' }, esc)).toBe('');
    const html = c.itemsPopupRow({ items: { table: 'kpi_a_001_items', rows: 4, inserted: 0, updated: 1, unchanged: 3, removed: 1 } }, esc);
    expect(html).toContain('kpi_a_001_items');
    expect(html).toContain('(ลบ 1)');
    expect(c.itemsPopupRow({ items: { skipped: 'ชื่อตารางยาวเกิน' } }, esc)).toContain('ชื่อตารางยาวเกิน');
  });
});

// ส่งเข้า KHD อย่างปลอดภัย (6 พ.ย. 2569): ตารางที่คีย์ KHD ไม่ใช่ hospcode + byear = "ส่งไม่ได้" ไม่ถูกเลือกอัตโนมัติ + แสดงแผนรายแถว
describe('ExportKpiComponent — หน้าต่างส่งข้อมูลเข้า KHD', () => {
  it('เลือกอัตโนมัติเฉพาะตารางพร้อมส่ง, ตาราง blocked แสดงเหตุผล และแสดงแผน เพิ่ม/อัปเดต/คงค่า KHD', async () => {
    await TestBed.configureTestingModule({ imports: [ExportKpiComponent], providers: testProviders }).compileComponents();
    const fixture = TestBed.createComponent(ExportKpiComponent);
    const c = fixture.componentInstance;
    const { HttpTestingController } = await import('@angular/common/http/testing');
    const http = TestBed.inject(HttpTestingController);
    c.openSyncToKhd();
    http.expectOne(r => r.url.endsWith('/sync-to-khd/preview')).flush({ success: true, tables: [
      { table: 'kpi_a_001', name: 'ก', status: 'ready', local_rows: 5, remote_rows: 4, sync_columns: ['hospcode', 'byear', 'target'],
        plan: { insert: 1, update: 1, khd_newer: 2, no_time: 0, unchanged: 1, kept_blank: 1 } },
      { table: 'i_kpi_30', name: 'ข', status: 'blocked', reason: 'คีย์ของตาราง KHD ไม่ใช่ hospcode + byear (PK(province_id))', local_rows: 1, remote_rows: 4 },
    ] });
    fixture.detectChanges();
    expect([...c.syncSelectedTables]).toEqual(['kpi_a_001']);
    expect(c.getSyncCount('blocked')).toBe(1);
    const text = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(text).toContain('ส่งไม่ได้');
    expect(text).toContain('PK(province_id)');
    expect(text).toContain('+1');
    expect(text).toContain('↻1');
    expect(text).toContain('⏸2');
  });
});
