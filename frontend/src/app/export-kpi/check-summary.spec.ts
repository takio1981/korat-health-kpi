import { checkCategoryOf, matchCheckFilter, summarizeCheck } from './check-summary';
import { khdSyncScope, syncScopeKey } from './khd-sync-scope';

describe('check-summary', () => {
  it('checkCategoryOf: ปิดส่งออกมาก่อน, ไม่มีผลตรวจ = ยังไม่ตรวจ, invalid_name = ไม่มีข้อมูล', () => {
    expect(checkCategoryOf({ upload_excel: 1 }, { status: 'has_changes' })).toBe('not_exported');
    expect(checkCategoryOf({ upload_excel: 0 }, undefined)).toBe('unchecked');
    expect(checkCategoryOf({}, { status: 'has_changes' })).toBe('has_changes');
    expect(checkCategoryOf({}, { status: 'up_to_date' })).toBe('up_to_date');
    expect(checkCategoryOf({}, { status: 'no_data' })).toBe('no_data');
    expect(checkCategoryOf({}, { status: 'invalid_name' })).toBe('no_data');
    expect(matchCheckFilter({}, undefined, '')).toBe(true);
    expect(matchCheckFilter({}, undefined, 'no_data')).toBe(false); // เดิมตัวชี้วัดที่ไม่มีผลตรวจไปอยู่ในตัวกรองไม่มีข้อมูล
  });

  it('summarizeCheck: นับต่อตัวชี้วัด, ผลรวมกลุ่ม = ทั้งหมด, data_changes นับตารางร่วมครั้งเดียว, จำนวนตาราง', () => {
    const list = [
      { id: 1, table_process: 'kpi_s' }, { id: 2, table_process: 'kpi-s' }, { id: 3, table_process: 'kpi_t' }, { id: 4, table_process: 'kpi_u', upload_excel: 1 },
    ];
    const m = new Map<number, any>([
      [1, { status: 'has_changes', new_count: 2, changed_count: 1 }],
      [2, { status: 'has_changes', new_count: 2, changed_count: 1 }],
      [3, { status: 'has_changes', new_count: 0, changed_count: 4 }],
    ]);
    const s = summarizeCheck(list, id => m.get(id));
    expect(s).toMatchObject({ total: 4, has_changes: 3, data_changes: 7, not_exported: 1, up_to_date: 0, no_data: 0, unchecked: 0 });
    expect(s.tables).toMatchObject({ total: 3, has_changes: 2, not_exported: 1 });
  });
});

describe('khd-sync-scope', () => {
  it('เฉพาะที่เลือก, ชื่อตารางขีดกลาง → ขีดล่าง ไม่ซ้ำ, ปิดส่งออก/ชื่อผิด = ส่งไม่ได้', () => {
    const inds = [
      { id: 1, table_process: 'kpi-a' }, { id: 2, table_process: 'kpi_a' }, { id: 3, table_process: 'kpi_b', upload_excel: 1 },
      { id: 4, table_process: '9bad' }, { id: 5, table_process: 'kpi_c' },
    ];
    const s = khdSyncScope(inds, new Set([1, 2, 3, 4]));
    expect(s.ids).toEqual([1, 2]);
    expect(s.tables).toEqual(['kpi_a']);
    expect(s.excluded.map(e => e.id)).toEqual([3, 4]);
    expect(s.excluded[0].reason).toContain('ปิดส่งออก KHD');
    expect(s.excluded[1].reason).toContain('ชื่อตาราง');
    expect(syncScopeKey('2570', new Set([3, 1]))).toBe(syncScopeKey('2570', new Set([1, 3])));
    expect(syncScopeKey('2570', new Set([1]))).not.toBe(syncScopeKey('2569', new Set([1])));
  });
});
