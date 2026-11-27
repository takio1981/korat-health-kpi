import { canPullStructure, canPushStructure, diffText, khdBadge, localBadge, structMapOf, tpKey } from './kpi-table-status';

// สถานะตารางของหน้าจัดการข้อมูล KPI (ตารางเดียว — 27 พ.ย. 2569)
describe('kpi-table-status', () => {
  const local = (o: any = {}) => ({ exists: true, row_count: 40, year_rows: 32, year_filled: 10, ...o });
  const remote = (o: any = {}) => ({ exists: true, row_count: 5, key_ok: true, ...o });

  it('tpKey / structMapOf: ขีดกลาง → ขีดล่าง ตัดช่องว่าง (ตรงกับ backend)', () => {
    expect(tpKey(' kpi-main-2568-1901 ')).toBe('kpi_main_2568_1901');
    const m = structMapOf([{ table: 'a-b' }, { table: 'c' }]);
    expect(m.has('a_b')).toBe(true);
    expect(structMapOf(null).size).toBe(0);
  });

  it('localBadge: ยังไม่มี / ปีนี้ยังไม่มีแถว / ค่าว่างทั้งหมด (กรณีผู้ใช้รายงาน) / มีข้อมูล', () => {
    expect(localBadge(undefined, '2570').key).toBe('none');
    expect(localBadge({ table: 't', local: { exists: false } }, '2570').key).toBe('none');
    expect(localBadge({ table: 't', local: local({ year_rows: 0, year_filled: 0 }) }, '2570').key).toBe('empty');
    const blank = localBadge({ table: 't', local: local({ year_rows: 32, year_filled: 0 }) }, '2570');
    expect(blank.key).toBe('blank');
    expect(blank.text).toContain('ค่าว่างทั้งหมด');
    expect(blank.title).toContain('กติกาการส่ง');
    const ok = localBadge({ table: 't', local: local() }, '2570');
    expect(ok.key).toBe('ok');
    expect(ok.text).toBe('ปีงบ 2570: 32 แถว (มีข้อมูล 10)');
  });

  it('khdBadge: เชื่อมไม่ได้ ≠ ไม่มีใน KHD / คีย์ผิด / โครงสร้างต่าง / ตรงกัน', () => {
    expect(khdBadge({ table: 't', local: local(), remote: null }, false).key).toBe('unknown');
    expect(khdBadge({ table: 't', local: local(), remote: remote() }, false).key).toBe('unknown');
    expect(khdBadge({ table: 't', local: local(), remote: { exists: false } }, true).key).toBe('none');
    expect(khdBadge({ table: 't', local: local(), remote: remote({ key_ok: false }) }, true).key).toBe('bad_key');
    const diff = [{ field: 'result', issue: 'missing_in_remote' }, { field: 'q1', issue: 'missing_in_local', remote_type: 'int' }];
    const d = khdBadge({ table: 't', local: local(), remote: remote(), diff }, true);
    expect(d.key).toBe('different');
    expect(d.text).toBe('โครงสร้างต่าง 2 คอลัมน์');
    expect(d.title).toContain('result: มีในระบบ ไม่มีใน KHD');
    expect(khdBadge({ table: 't', local: local(), remote: remote(), diff: [] }, true).key).toBe('match');
  });

  it('diffText ตรงกับรูปแบบของ backend (diffTableColumns)', () => {
    expect(diffText({ field: 'a', issue: 'missing_in_local' })).toBe('a: มีใน KHD ไม่มีในระบบ');
    expect(diffText({ field: 'b', issue: 'type_mismatch', local_type: 'int', remote_type: 'varchar(10)' })).toBe('b: ชนิดต่างกัน (ระบบ int / KHD varchar(10))');
  });

  it('canPush / canPull: สร้างใน KHD ได้เมื่อมีตารางในระบบ, เพิ่มคอลัมน์ตามทิศที่ขาด', () => {
    expect(canPushStructure({ table: 't', local: local(), remote: { exists: false } }, true)).toBe(true);
    expect(canPushStructure({ table: 't', local: { exists: false }, remote: { exists: false } }, true)).toBe(false); // ต้องส่งออกก่อน
    expect(canPushStructure({ table: 't', local: local(), remote: { exists: false } }, false)).toBe(false);          // เชื่อม KHD ไม่ได้
    const toRemote = { table: 't', local: local(), remote: remote(), diff: [{ field: 'x', issue: 'missing_in_remote' }] };
    const toLocal = { table: 't', local: local(), remote: remote(), diff: [{ field: 'y', issue: 'missing_in_local' }] };
    expect(canPushStructure(toRemote, true)).toBe(true);
    expect(canPullStructure(toRemote, true)).toBe(false);
    expect(canPushStructure(toLocal, true)).toBe(false);
    expect(canPullStructure(toLocal, true)).toBe(true);
  });
});
