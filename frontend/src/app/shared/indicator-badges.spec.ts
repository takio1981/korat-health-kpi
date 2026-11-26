import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { IndicatorBadgesComponent, indicatorBadges, withTableProcess } from './indicator-badges';
import { testProviders } from '../testing/test-providers';

// แถบสีคุณสมบัติตัวชี้วัดในหน้ารายงานสถิติ (20 พ.ย. 2569) — สี/ข้อความเดียวกับหน้าบันทึกผลงาน
describe('indicatorBadges', () => {
  const keys = (ind: any, o: any = {}) => indicatorBadges(ind, c => ({ '07': 'รพช.', '18': 'รพ.สต.' } as any)[c] || c, o).map(b => b.key);

  it('ครบทุกแถบตามคุณสมบัติ เรียงแบบหน้าบันทึกผลงาน', () => {
    const ind = { r9: 1, moph: 1, ssj: 0, rmw: '', other: null, evaluation_mode: 'any_one', required_off_types: '["07","18"]', unit: 'ร้อยละ',
      is_cumulative: 1, quarter_mode: 'quarter', target_monthly: 'latest', khd_report_id: 12, data_source: 'excel', khd_fiscal_year: '2569,2570' };
    expect(keys(ind)).toEqual(['type-r9', 'type-moph', 'off', 'unit', 'calc', 'quarter', 'tmonth', 'src', 'fy']);
    const b = indicatorBadges(ind, c => ({ '07': 'รพช.', '18': 'รพ.สต.' } as any)[c] || c);
    expect(b.find(x => x.key === 'off')?.label).toBe('รพช., รพ.สต.');
    expect(b.find(x => x.key === 'calc')?.label).toBe('สะสม');
    expect(b.find(x => x.key === 'src')?.label).toBe('key_in');
    expect(b.find(x => x.key === 'fy')?.label).toBe('ปีงบ 2569, 2570');
  });

  it('ทุกตัวชี้วัดมีแถบแหล่งที่มาเสมอ (local-only / hdc)', () => {
    expect(indicatorBadges({}).map(b => b.label)).toEqual(['local-only']);
    expect(indicatorBadges({ khd_report_id: 5, data_source: 'hdc' }).map(b => b.label)).toEqual(['hdc']);
    expect(indicatorBadges(null)).toEqual([]);
  });

  it('ตัวชี้วัดของ: ทุกประเภท / เกิน 2 ประเภทย่อ / JSON เสีย = ไม่แสดง', () => {
    expect(indicatorBadges({ evaluation_mode: 'all_required' })[0].label).toBe('ทุกประเภท');
    expect(indicatorBadges({ evaluation_mode: 'any_one', required_off_types: '["05","06","07"]' })[0].label).toBe('3 ประเภท');
    expect(keys({ evaluation_mode: 'any_one', required_off_types: '{bad' })).toEqual(['src']);
  });

  it('วิธีคิดผลงาน: สูตรมาก่อน (แสดงเมื่อขอ) > กรอกเอง > สะสม', () => {
    expect(keys({ result_formula: 'SUM(ALL)', is_cumulative: 1 })).toEqual(['src']);
    expect(indicatorBadges({ result_formula: 'SUM(ALL)' }, undefined, { formula: true })[0].label).toBe('สูตร');
    expect(indicatorBadges({ result_manual: 1, is_cumulative: 1 })[0].label).toBe('กรอกเอง');
  });
});

describe('IndicatorBadgesComponent', () => {
  it('อ่านคุณสมบัติจาก GET /indicators ครั้งเดียว แล้วแสดงแถบตาม id', async () => {
    await TestBed.configureTestingModule({ imports: [IndicatorBadgesComponent], providers: testProviders }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const f1 = TestBed.createComponent(IndicatorBadgesComponent);
    f1.componentInstance.id = 7; f1.detectChanges();
    const f2 = TestBed.createComponent(IndicatorBadgesComponent);
    f2.componentInstance.id = 8; f2.detectChanges();
    http.expectOne(r => r.url.endsWith('/indicators')).flush([{ id: 7, r9: 1, unit: 'ราย', table_process: 'kpi_ncd_001' }, { id: 8, rmw: 1 }]);
    http.expectOne(r => r.url.endsWith('/hostype')).flush([]);
    f1.detectChanges(); f2.detectChanges();
    expect(f1.nativeElement.textContent).toContain('R9');
    expect(f1.nativeElement.textContent).toContain('หน่วย: ราย');
    expect(f2.nativeElement.textContent).toContain('RMW');
    expect(f2.nativeElement.textContent).toContain('local-only');
    // table_process ใต้ชื่อตัวชี้วัด (26 พ.ย. 2569) — ไม่มีค่า = ไม่แสดง, [tp]=false = ไม่แสดง
    expect(f1.nativeElement.querySelector('[data-badge="tp"]')?.textContent.trim()).toBe('kpi_ncd_001');
    expect(f2.nativeElement.querySelector('[data-badge="tp"]')).toBeNull();
    f1.componentRef.setInput('tp', false); f1.detectChanges();
    expect(f1.nativeElement.querySelector('[data-badge="tp"]')).toBeNull();
  });
});

describe('withTableProcess (ไฟล์ Excel รายงานสถิติ)', () => {
  it('ใส่ table_process ต่อจากชื่อตัวชี้วัด — ค่าในแถวมาก่อน, ไม่มีชื่อตัวชี้วัด = คงเดิม', () => {
    const meta: Record<number, any> = { 1: { table_process: 'kpi_a' }, 2: { table_process: 'kpi_b' } };
    const out = withTableProcess([
      { indicator_id: 1, kpi_indicators_name: 'ก', total: 5 },
      { id: 2, kpi_indicators_name: 'ข', table_process: 'kpi_row' },
      { indicator_id: 9, kpi_indicators_name: 'ค' },
      { dept_name: 'กลุ่มงาน', total: 3 },
    ], id => meta[id]);
    expect(Object.keys(out[0])).toEqual(['indicator_id', 'kpi_indicators_name', 'table_process', 'total']);
    expect(out.map(r => r.table_process)).toEqual(['kpi_a', 'kpi_row', '', undefined]);
    expect(Object.keys(out[3])).toEqual(['dept_name', 'total']);
  });
});
