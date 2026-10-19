import { orderSubTree } from './sub-tree';

// เรียงข้อย่อยหลายระดับเป็นต้นไม้ (19 ต.ค. 2569)
describe('orderSubTree', () => {
  const subs = [
    { id: 1, parent_sub_id: null, item_no: null, is_active: 1 },
    { id: 2, parent_sub_id: null, item_no: null, is_active: 1 },
    { id: 11, parent_sub_id: 1, item_no: null, is_active: 1 },
    { id: 12, parent_sub_id: 1, item_no: '1.9', is_active: 1 },
    { id: 111, parent_sub_id: 11, item_no: null, is_active: 1 },
    { id: 21, parent_sub_id: 2, item_no: null, is_active: 0 },
    { id: 211, parent_sub_id: 21, item_no: null, is_active: 1 },
  ];

  it('pre-order + ระดับ + เลขข้อตามสายข้อแม่ (กำหนดเองได้) + จำนวนข้อลูก', () => {
    const t = orderSubTree(subs, '1');
    expect(t.map(x => x.id)).toEqual([1, 11, 111, 12, 2, 21, 211]);
    expect(t.map(x => x._level)).toEqual([0, 1, 2, 1, 0, 1, 2]);
    expect(t.map(x => x._no)).toEqual(['1.1', '1.1.1', '1.1.1.1', '1.9', '1.2', '1.2.1', '1.2.1.1']);
    expect(t.find(x => x.id === 1)!._childSubCount).toBe(2);
  });

  it('เฉพาะที่เปิดใช้งาน: ปิดข้อแม่ = ซ่อนทั้งสาย', () => {
    expect(orderSubTree(subs, '1', true).map(x => x.id)).toEqual([1, 11, 111, 12, 2]);
  });

  it('ข้อมูลเดิม (ไม่มี parent_sub_id) = ระดับบนสุดทั้งหมด เลขข้อเหมือนเดิม', () => {
    expect(orderSubTree([{ id: 5 }, { id: 6 }], '2').map(x => [x._no, x._level])).toEqual([['2.1', 0], ['2.2', 0]]);
  });
});
