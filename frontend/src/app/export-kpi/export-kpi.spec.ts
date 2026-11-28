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
describe('ExportKpiComponent — ส่งข้อมูลเข้า KHD (ขั้นที่ 5 ในหน้าเดียวกัน)', () => {
  it('เลือกอัตโนมัติเฉพาะตารางพร้อมส่ง, ตาราง blocked แสดงเหตุผล และแสดงแผน เพิ่ม/อัปเดต/คงค่า KHD', async () => {
    await TestBed.configureTestingModule({ imports: [ExportKpiComponent], providers: testProviders }).compileComponents();
    const fixture = TestBed.createComponent(ExportKpiComponent);
    const c = fixture.componentInstance;
    const { HttpTestingController } = await import('@angular/common/http/testing');
    const http = TestBed.inject(HttpTestingController);
    c.exportYear = '2570';
    c.exportIndicators = [{ id: 1, kpi_indicators_name: 'ก', table_process: 'kpi_a_001', upload_excel: 0 }, { id: 2, kpi_indicators_name: 'ข', table_process: 'i_kpi_30', upload_excel: 0 }];
    c.selectedIndicatorIds = new Set([1, 2]);
    c.openSyncToKhd(false);
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

// 28 พ.ย. 2569 (ผู้ใช้แจ้ง): ตัวเลขใน card หลังตรวจสอบไม่เท่ากับจำนวนแถวเมื่อกดกรอง
describe('ExportKpiComponent — card สรุปผลตรวจสอบ = จำนวนแถวที่กรองได้', () => {
  let c: ExportKpiComponent;
  const seed = (comp: ExportKpiComponent) => {
    // 2 ตัวชี้วัดใช้ตารางเดียวกัน (เดิม card นับ 1 ตาราง แต่ตารางแสดง 2 แถว), ปิดส่งออก (เดิมนับ "ยังไม่ตรวจ" แต่ตัวกรองไม่มีข้อมูลแสดงรวม),
    // invalid_name (เดิมไม่อยู่ใน card ใด), กลุ่มงานต่างกัน (เดิม card ไม่สนตัวกรองอื่น)
    comp.exportIndicators = [
      { id: 1, kpi_indicators_name: 'ก1', table_process: 'kpi_shared', upload_excel: 0, dept_id: 1 },
      { id: 2, kpi_indicators_name: 'ก2', table_process: 'kpi-shared', upload_excel: 0, dept_id: 1 },
      { id: 3, kpi_indicators_name: 'ข', table_process: 'kpi_b', upload_excel: 0, dept_id: 1 },
      { id: 4, kpi_indicators_name: 'ค', table_process: 'kpi_c', upload_excel: 0, dept_id: 2 },
      { id: 5, kpi_indicators_name: 'ง', table_process: 'kpi_d', upload_excel: 1, dept_id: 1 },
      { id: 6, kpi_indicators_name: 'จ', table_process: 'bad name', upload_excel: 0, dept_id: 1 },
      { id: 7, kpi_indicators_name: 'ฉ', table_process: 'kpi_f', upload_excel: 0, dept_id: 1 },
    ];
    comp.checkStatusMap = new Map<number, any>([
      [1, { id: 1, status: 'has_changes', new_count: 3, changed_count: 2 }],
      [2, { id: 2, status: 'has_changes', new_count: 3, changed_count: 2 }],
      [3, { id: 3, status: 'up_to_date' }],
      [4, { id: 4, status: 'has_changes', new_count: 1, changed_count: 0 }],
      [6, { id: 6, status: 'invalid_name' }],
      [7, { id: 7, status: 'no_data' }],
    ]);
  };
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ExportKpiComponent], providers: testProviders }).compileComponents();
    c = TestBed.createComponent(ExportKpiComponent).componentInstance;
    seed(c);
  });

  const cards = ['has_changes', 'up_to_date', 'no_data', 'not_exported', 'unchecked'] as const;
  const assertCardsMatchRows = () => {
    c.filterCheckStatus = '';
    c.applyFilters();
    const s = { ...c.summary };
    expect(c.filteredExportIndicators.length).toBe(s.total);
    expect(cards.reduce((n, k) => n + s[k], 0)).toBe(s.total);
    for (const k of cards) {
      c.setCheckFilter(k);
      expect(c.filteredExportIndicators.length).toBe(s[k]);
      expect(c.selectedIndicatorIds.size).toBe(s[k]);       // กด card = เลือกเฉพาะรายการนั้น
      expect(c.summary[k]).toBe(s[k]);                       // ตัวเลขใน card ไม่เปลี่ยนเมื่อกรองตัวเอง
      c.setCheckFilter(k);                                   // กดซ้ำ = ยกเลิก
      expect(c.filteredExportIndicators.length).toBe(s.total);
    }
    return s;
  };

  it('ทุก card = จำนวนแถวเมื่อกด (ไม่มีตัวกรองอื่น)', () => {
    const s = assertCardsMatchRows();
    expect(s).toMatchObject({ total: 7, has_changes: 3, up_to_date: 1, no_data: 2, not_exported: 1, unchecked: 0 });
    expect(s.data_changes).toBe(6);            // ตารางใช้ร่วม (kpi_shared) นับครั้งเดียว: 5 + 1
    expect(s.tables.has_changes).toBe(2);
  });

  it('ทุก card = จำนวนแถวเมื่อมีตัวกรองอื่น (กลุ่มงาน) — card นับตามตัวกรอง', () => {
    c.filterDept = '1';
    const s = assertCardsMatchRows();
    expect(s).toMatchObject({ total: 6, has_changes: 2, not_exported: 1 });
    expect(s.data_changes).toBe(5);
  });

  it('ยังไม่ตรวจ: card ยังไม่ตรวจสอบ = ตัวชี้วัดที่ส่งออกได้ทั้งหมด, ปิดส่งออกแยก card', () => {
    c.checkStatusMap = new Map();
    const s = assertCardsMatchRows();
    expect(s).toMatchObject({ total: 7, unchecked: 6, not_exported: 1, has_changes: 0 });
  });

  it('กด card บนหน้าจอ = ตารางแสดงเฉพาะกลุ่มนั้น', () => {
    const fixture = TestBed.createComponent(ExportKpiComponent);
    const comp = fixture.componentInstance;
    seed(comp);
    comp.applyFilters();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const card = (k: string) => el.querySelector(`#check-cards [data-card="${k}"]`) as HTMLElement;
    expect(card('has_changes').textContent).toContain('3');
    card('not_exported').click();
    fixture.detectChanges();
    expect(el.querySelectorAll('#kpi-export-table tr[data-ind]').length).toBe(1);
    expect(el.querySelector('#kpi-export-table tr[data-ind="5"]')).toBeTruthy();
  });
});

// 28 พ.ย. 2569 (ผู้ใช้สั่ง): ส่งข้อมูลเข้า KHD = ตัวชี้วัดที่เลือกในขั้นที่ 3 แสดงในหน้าเดียวกัน (ไม่ใช่ modal ทุกตาราง)
describe('ExportKpiComponent — ขอบเขตการส่ง KHD จากรายการที่เลือก', () => {
  it('ส่ง indicator_ids ที่เลือก + ปีงบ, ปิดส่งออกแยกเป็นส่งไม่ได้, เปลี่ยนรายการ/ปีงบ = ต้องตรวจใหม่ก่อนส่ง', async () => {
    await TestBed.configureTestingModule({ imports: [ExportKpiComponent], providers: testProviders }).compileComponents();
    const fixture = TestBed.createComponent(ExportKpiComponent);
    const c = fixture.componentInstance;
    const { HttpTestingController } = await import('@angular/common/http/testing');
    const http = TestBed.inject(HttpTestingController);
    c.exportYear = '2570';
    c.isSuperAdminStrict = true;
    c.exportIndicators = [
      { id: 1, kpi_indicators_name: 'ก', table_process: 'kpi-a-001', upload_excel: 0 },
      { id: 2, kpi_indicators_name: 'ข', table_process: 'kpi_b_001', upload_excel: 1 },
      { id: 3, kpi_indicators_name: 'ค', table_process: 'kpi_c_001', upload_excel: 0 },
    ];
    c.selectedIndicatorIds = new Set([1, 2]);
    c.openSyncToKhd(false);
    const req = http.expectOne(r => r.url.endsWith('/sync-to-khd/preview'));
    expect(req.request.body).toEqual({ indicator_ids: [1], year_bh: '2570' });
    expect(c.syncScope!.tables).toEqual(['kpi_a_001']);
    expect(c.syncScope!.excluded.map(e => e.id)).toEqual([2]);
    req.flush({ success: true, year_bh: '2570', excluded: [], tables: [
      { table: 'kpi_a_001', name: 'ก', status: 'ready', local_rows: 3, remote_rows: 0, sync_columns: ['hospcode', 'byear', 'target'], plan: { insert: 3, update: 0, khd_newer: 0, no_time: 0, kept_blank: 0 } },
    ] });
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#khd-sync-panel')).toBeTruthy();
    expect(el.querySelector('#khd-sync-excluded')!.textContent).toContain('ปิดส่งออก KHD');
    expect(c.syncStale).toBe(false);
    const dirty = () => (c as any).cdr.markForCheck(); // เรียกตรง (ไม่ผ่านเหตุการณ์ในแม่แบบ) ต้องบอกว่าเปลี่ยนแล้ว
    c.toggleIndicator(3); dirty();             // เปลี่ยนรายการที่เลือกหลังตรวจแผน
    fixture.detectChanges();
    expect(c.syncStale).toBe(true);
    expect(el.querySelector('#khd-sync-stale')).toBeTruthy();
    expect((el.querySelector('#btn-khd-sync-execute') as HTMLButtonElement).disabled).toBe(true);
    c.toggleIndicator(3); dirty();
    fixture.detectChanges();
    expect(c.syncStale).toBe(false);
    expect((el.querySelector('#btn-khd-sync-execute') as HTMLButtonElement).disabled).toBe(false);
    c.exportYear = '2569';                     // เปลี่ยนปีงบ = ต้องตรวจใหม่
    expect(c.syncStale).toBe(true);
  });
});
