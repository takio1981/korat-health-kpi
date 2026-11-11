import * as XLSX from 'xlsx';
import {
  SUB_EXCEL_HEADERS, buildSubTemplateAoa, parseSubImportAoa, planSubImport, applySubChanges, subFieldLabel, subTemplateFileName,
} from './kpi-sub-excel';

const CTX = { indicator_name: 'ตัวชี้วัดหลัก', hospcode: '00123', hosname: 'รพ.ทดสอบ', year_bh: '2570' };
const sub = (id: number, target: string, actuals: any = {}) =>
  ({ id, sub_indicator_code: 'S' + id, sub_indicator_name: 'ข้อย่อย ' + id, _target: target, _actuals: { ...actuals } });

/** เขียนเป็นไฟล์ .xlsx จริงแล้วอ่านกลับ (เหมือนผู้ใช้เปิดแก้ใน Excel) */
function roundTrip(aoa: any[][]): any[][] {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 's');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const wb2 = XLSX.read(new Uint8Array(buf), { type: 'array' });
  return XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, raw: true, defval: '' }) as any[][];
}

describe('kpi-sub-excel: แบบฟอร์ม → นำเข้า', () => {
  it('แบบฟอร์มมีค่าปัจจุบัน และนำเข้าไฟล์ที่ไม่ได้แก้ = ไม่มีช่องที่เปลี่ยน', () => {
    const subs = [sub(1, '100', { 10: '90' }), sub(2, '80', { 10: 'รอดำเนินการ' }), sub(3, '60')];
    const aoa = buildSubTemplateAoa(subs, CTX);
    expect(aoa[2].slice(0, 6)).toEqual([SUB_EXCEL_HEADERS.sub_id, 'hospcode', 'ปีงบประมาณ', 'รหัส', 'ตัวชี้วัดย่อย', 'เป้าหมาย']);
    expect(aoa[3][5]).toBe(100);          // ตัวเลขเขียนเป็น number
    expect(aoa[3][6]).toBe(90);
    expect(aoa[4][6]).toBe('รอดำเนินการ');
    const parsed = parseSubImportAoa(roundTrip(aoa));
    expect(parsed.error).toBeUndefined();
    expect(parsed.rows.length).toBe(3);
    const plan = planSubImport(parsed.rows, subs, CTX);
    expect(plan.changes.length).toBe(0);
    expect(plan.unmatchedRows).toEqual([]);
  });

  it('กรอกเฉพาะบางข้อ/บางเดือน → เปลี่ยนเฉพาะช่องที่กรอก ช่องว่างไม่ทับค่าเดิม', () => {
    const subs = [sub(1, '100', { 10: '90' }), sub(2, '80'), sub(3, '60', { 11: '30' })];
    const aoa = buildSubTemplateAoa(subs, CTX);
    aoa[4][7] = 75;        // ข้อ 2 เดือน พ.ย.
    aoa[5][5] = 70;        // ข้อ 3 เป้าหมาย
    aoa[3][6] = '';        // ลบค่าในไฟล์ = ไม่เปลี่ยนค่าเดิม (ยังเป็น 90)
    aoa[5][7] = '';
    const plan = planSubImport(parseSubImportAoa(roundTrip(aoa)).rows, subs, CTX);
    expect(plan.changes.map(c => [c.sub.id, c.field, c.oldVal, c.newVal])).toEqual([[2, '11', '', '75'], [3, 'target', '60', '70']]);
    expect(applySubChanges(plan.changes)).toBe(2);
    expect(subs[1]._actuals[11]).toBe('75');
    expect(subs[2]._target).toBe('70');
    expect(subs[0]._actuals[10]).toBe('90');
    expect(subs[2]._actuals[11]).toBe('30');
  });

  it('กรอก 0 ได้ (ทับค่าที่ยกมาจากเดือนก่อน) และค่าตัวเลขเท่าเดิมไม่นับเป็นการเปลี่ยน', () => {
    const subs = [sub(1, '100', { 10: '90.0' })];
    const aoa = buildSubTemplateAoa(subs, CTX);
    aoa[3][6] = 90;        // 90 = 90.0
    aoa[3][7] = 0;
    const plan = planSubImport(parseSubImportAoa(roundTrip(aoa)).rows, subs, CTX);
    expect(plan.same).toBeGreaterThanOrEqual(1);
    expect(plan.changes.map(c => [c.field, c.newVal])).toEqual([['11', '0']]);
  });

  it('ไฟล์ของหน่วยบริการ/ปีงบประมาณอื่น หรือข้อย่อยของตัวชี้วัดอื่น → ไม่นำเข้า', () => {
    const subs = [sub(1, '100'), sub(2, '80')];
    const aoa = buildSubTemplateAoa(subs, { ...CTX, hospcode: '00999' });
    aoa[3][6] = 50; aoa[4][6] = 60;
    const plan = planSubImport(parseSubImportAoa(roundTrip(aoa)).rows, subs, CTX);
    expect(plan.changes.length).toBe(0);
    expect(plan.unmatchedRows.length).toBe(2);

    const other = buildSubTemplateAoa([sub(77, '100', { 10: '5' })], CTX);
    expect(planSubImport(parseSubImportAoa(other).rows, subs, CTX).unmatchedRows.length).toBe(1);

    const wrongYear = buildSubTemplateAoa(subs, { ...CTX, year_bh: '2569' });
    wrongYear[3][6] = 50;
    expect(planSubImport(parseSubImportAoa(wrongYear).rows, subs, CTX).changes.length).toBe(0);
  });

  it('Excel ตัดเลข 0 นำหน้ารหัสหน่วยบริการ → ยังจับคู่ได้ | แถวซ้ำใช้แถวแรก | ข้อความยาวเกินถูกข้าม', () => {
    const subs = [sub(1, '100'), sub(2, '80')];
    const aoa = buildSubTemplateAoa(subs, CTX);
    aoa[3][1] = 123;                         // '00123' ถูก Excel แปลงเป็นตัวเลข
    aoa[3][6] = 40;
    aoa[4][6] = 'ก'.repeat(101);
    aoa.push([1, '00123', '2570', 'S1', 'ซ้ำ', '', 99]);
    const plan = planSubImport(parseSubImportAoa(aoa).rows, subs, CTX);
    expect(plan.changes.map(c => [c.sub.id, c.newVal])).toEqual([[1, '40']]);
    expect(plan.duplicateRows.length).toBe(1);
    expect(plan.tooLong).toBe(1);
  });

  it('ไฟล์ที่ไม่ใช่แบบฟอร์ม → แจ้งข้อผิดพลาด', () => {
    expect(parseSubImportAoa([['a', 'b'], [1, 2]]).error).toContain('sub_indicator_id');
    expect(parseSubImportAoa([[SUB_EXCEL_HEADERS.sub_id, 'อื่นๆ'], [1, 2]]).error).toContain('เดือน');
    expect(subFieldLabel('target')).toBe('เป้าหมาย');
    expect(subFieldLabel('10')).toBe('ต.ค.');
  });
});

// ชื่อไฟล์แบบฟอร์มผลงานตัวชี้วัดย่อย (6 พ.ย. 2569 — เดิม KPI_ผลงานตัวชี้วัดย่อย_<รหัส>_<หน่วยบริการ>_<ปี> ไม่รู้ว่าเป็น KPI ข้ออะไร)
describe('kpi-sub-excel: subTemplateFileName', () => {
  it('มีเลขข้อ + ชื่อตัวชี้วัดหลัก + ปีงบ + หน่วยบริการ', () => {
    expect(subTemplateFileName({ item_no: '2', indicator_name: 'ร้อยละผู้ป่วยเบาหวาน: คุมน้ำตาลได้', indicator_id: 15, year_bh: '2570', hospcode: '10871' }))
      .toBe('KPI_ผลงานตัวชี้วัดย่อย_ข้อ2_ร้อยละผู้ป่วยเบาหวาน คุมน้ำตาลได้_ปีงบ2570_10871.xlsx');
  });
  it('ไม่มีเลขข้อ = ไม่ใส่ส่วน "ข้อ", ไม่มีชื่อ = ใช้รหัสตัวชี้วัด, ชื่อยาวย่อที่ 60 ตัวอักษร', () => {
    expect(subTemplateFileName({ ...CTX, item_no: '' })).toBe('KPI_ผลงานตัวชี้วัดย่อย_ตัวชี้วัดหลัก_ปีงบ2570_00123.xlsx');
    expect(subTemplateFileName({ indicator_id: 9, year_bh: '2570', hospcode: '00123' })).toBe('KPI_ผลงานตัวชี้วัดย่อย_ตัวชี้วัด 9_ปีงบ2570_00123.xlsx');
    const long = subTemplateFileName({ indicator_name: 'ก'.repeat(80), year_bh: '2570', hospcode: '1' });
    expect(long).toContain('ก'.repeat(60) + '…_ปีงบ2570');
  });

  it('ตัวชี้วัดบันทึกรายไตรมาส: เดือนกลางไตรมาสไม่นำเข้า (นับ offQuarter) — บันทึกรายเดือนนำเข้าได้ทุกเดือน (11 พ.ย. 2569)', () => {
    const subs = [sub(1, '100')];
    const aoa = buildSubTemplateAoa(subs, CTX);
    aoa[3][7] = 5;    // พ.ย.
    aoa[3][8] = 6;    // ธ.ค.
    const rows = parseSubImportAoa(roundTrip(aoa)).rows;
    const q = planSubImport(rows, subs, { ...CTX, quarter_mode: 'quarter' });
    expect(q.changes.map(c => c.field)).toEqual(['12']);
    expect(q.offQuarter).toBe(1);
    expect(planSubImport(rows, subs, { ...CTX, quarter_mode: 'month_sum' }).changes.length).toBe(2);
  });
});
