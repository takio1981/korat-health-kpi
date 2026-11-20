import { ITYPES, itypeInfo, itypesOfRow } from './indicator-types';
import { buildTypeMonthly } from '../chart/chart-builders';
import { filterRiskItems } from '../chart/risk-view';

// ประเภทตัวชี้วัดในหน้ารายงานสถิติ (20 พ.ย. 2569)
describe('indicator-types', () => {
  it('ครบ 5 ประเภทหลัก + ไม่ระบุประเภท คีย์ตรงกับ backend', () => {
    expect(ITYPES.map(t => t.key)).toEqual(['r9', 'moph', 'ssj', 'rmw', 'other', 'none']);
    expect(itypeInfo('r9')?.label).toBe('R9 เขต 9');
    expect(itypeInfo('rmw')?.label).toBe('RMW ผู้ว่าฯ');
    expect(itypeInfo('xx')).toBeUndefined();
  });
  it('itypesOfRow: หลายประเภท / ไม่มีธง = none', () => {
    expect(itypesOfRow({ r9: 1, moph: '1', ssj: 0 })).toEqual(['r9', 'moph']);
    expect(itypesOfRow({})).toEqual(['none']);
  });
  it('buildTypeMonthly: เส้นละประเภท สีตามป้าย ตัดประเภทที่ไม่มีข้อมูลรายเดือน เดือนไม่มีคู่ = null', () => {
    const m = (e: number, p: number) => ({ month: 'oct', label: 'ต.ค.', recorded: e, eligible: e, passed: p, pass_pct: e ? (p / e) * 100 : 0, recording_pct: 0 });
    const o = buildTypeMonthly([
      { gname: 'R9 เขต 9', color: '#2563eb', months: [m(2, 1), m(0, 0)] },
      { gname: 'RMW ผู้ว่าฯ', color: '#ca8a04', months: [m(0, 0), m(0, 0)] },
    ]);
    expect(o.series.map((s: any) => s.name)).toEqual(['R9 เขต 9']);
    expect(o.series[0].data).toEqual([50, null]);
    expect(o.colors).toEqual(['#2563eb']);
    expect(buildTypeMonthly([]).series).toEqual([]);
  });
  it('แถบตัวชี้วัดเสี่ยง: กรองตามประเภทตัวชี้วัด', () => {
    const items = [{ indicator_id: 1, itypes: ['r9', 'moph'] }, { indicator_id: 2, itypes: ['none'] }];
    const f = { status: '', yut: '', dept: '', zone: '', district: '', search: '' };
    expect(filterRiskItems(items, { ...f, itype: 'moph' }).map(i => i.indicator_id)).toEqual([1]);
    expect(filterRiskItems(items, { ...f, itype: 'none' }).map(i => i.indicator_id)).toEqual([2]);
    expect(filterRiskItems(items, f).length).toBe(2);
  });
});
