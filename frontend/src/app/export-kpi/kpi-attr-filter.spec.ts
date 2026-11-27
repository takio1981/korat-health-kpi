import { EMPTY_ATTR_FILTER, activeAttrCount, fiscalYearOptions, hostypeSettingOf, matchAttrFilter, methodsOf, sourceOf } from './kpi-attr-filter';

const f = (o: any) => ({ ...EMPTY_ATTR_FILTER, ...o });

describe('kpi-attr-filter', () => {
  it('ประเภทตัวชี้วัด — ธงหลายประเภท / ไม่ระบุ', () => {
    expect(matchAttrFilter({ r9: 1, ssj: 1 }, null, f({ itype: 'ssj' }))).toBe(true);
    expect(matchAttrFilter({ r9: 1 }, null, f({ itype: 'moph' }))).toBe(false);
    expect(matchAttrFilter({}, null, f({ itype: 'none' }))).toBe(true);
  });

  it('ประเภทหน่วยบริการ — all / unset / รายประเภท (all_required นับทุกประเภท)', () => {
    expect(hostypeSettingOf({ evaluation_mode: 'all_required' })).toBe('all');
    expect(hostypeSettingOf({ evaluation_mode: 'any_one', required_off_types: '[]' })).toBe('unset');
    expect(hostypeSettingOf({ evaluation_mode: 'any_one', required_off_types: '["07"]' })).toBe('types');
    const any07 = { evaluation_mode: 'any_one', required_off_types: '["07","18"]' };
    expect(matchAttrFilter(any07, null, f({ hostype: 't:18' }))).toBe(true);
    expect(matchAttrFilter(any07, null, f({ hostype: 't:05' }))).toBe(false);
    expect(matchAttrFilter({ evaluation_mode: 'all_required' }, null, f({ hostype: 't:05' }))).toBe(true);
    expect(matchAttrFilter({}, null, f({ hostype: 'unset' }))).toBe(true);
    expect(matchAttrFilter({ evaluation_mode: 'any_one', required_off_types: 'เสีย' }, null, f({ hostype: 'unset' }))).toBe(true);
  });

  it('วิธีคิดผลงาน', () => {
    expect(methodsOf({})).toEqual(['latest']);
    expect(methodsOf({ is_cumulative: 1 })).toEqual(['cumulative']);
    expect(methodsOf({ result_formula: 'SUM(ALL)', is_cumulative: 1, quarter_mode: 'month_sum' })).toEqual(['formula', 'quarter']);
    expect(methodsOf({ result_manual: 1 })).toEqual(['manual']);
    expect(methodsOf({ target_monthly: 'latest' })).toEqual(['monthly', 'latest']);
  });

  it('แหล่งข้อมูล / ส่ง KHD / ปีงบ / ข้อย่อย / เกณฑ์ — คุณสมบัติเต็ม (meta) มาก่อนค่าในแถว', () => {
    expect(sourceOf({})).toBe('local');
    expect(sourceOf({ khd_report_id: 5, data_source: 'hdc' })).toBe('hdc');
    expect(sourceOf({ khd_report_id: 5, data_source: 'excel' })).toBe('key_in');
    const ind = { id: 1, upload_excel: 0 };
    const meta = { khd_fiscal_year: '2569,2570', export_items: 1, criterion: '80' };
    expect(matchAttrFilter(ind, meta, f({ khd: 'on', fy: '2570', items: 'on', criterion: 'set' }))).toBe(true);
    expect(matchAttrFilter(ind, meta, f({ khd: 'off' }))).toBe(false);
    expect(matchAttrFilter(ind, meta, f({ fy: '__none' }))).toBe(false);
    expect(matchAttrFilter(ind, { criterion: ' ' }, f({ criterion: 'unset' }))).toBe(true);
    expect(matchAttrFilter({ upload_excel: 0 }, { upload_excel: 1 }, f({ khd: 'on' }))).toBe(false);
  });

  it('นับตัวกรองที่ใช้ + ตัวเลือกปีงบเรียงใหม่ → เก่า', () => {
    expect(activeAttrCount(EMPTY_ATTR_FILTER)).toBe(0);
    expect(activeAttrCount(f({ itype: 'r9', fy: '2570' }))).toBe(2);
    expect(fiscalYearOptions([{ khd_fiscal_year: '2569,2570' }, { khd_fiscal_year: '2568' }, {}])).toEqual(['2570', '2569', '2568']);
  });
});
