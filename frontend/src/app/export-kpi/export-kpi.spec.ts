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
    const labels = Array.from(el.querySelectorAll('label')).filter(l => l.textContent?.includes('ตัวชี้วัด'));
    const withBadge = labels.filter(l => l.textContent?.includes('+ รายละเอียด')).map(l => l.textContent || '');
    expect(withBadge.length).toBe(1);
    expect(withBadge[0]).toContain('ตัวชี้วัด ก');
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
