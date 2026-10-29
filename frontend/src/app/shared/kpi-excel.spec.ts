import * as XLSX from 'xlsx';
import {
  EXCEL_HEADERS, EXCEL_MONTHS, buildTemplateAoa, normalizeCell, parseImportAoa, planImport,
  parseClipboardGrid, isMultiCell, planPaste, applyCellChanges,
} from './kpi-excel';

const PERMS = { canEditActual: true, canEditTarget: true };
function row(id: number, hospcode: string, extra: any = {}) {
  return {
    indicator_id: id, hospcode, year_bh: '2570', main_indicator_name: 'หมวด ก', kpi_indicators_name: 'ตัวชี้วัด ' + id, hosname: 'หน่วย ' + hospcode,
    target_value: '80', is_locked: 0,
    oct: '', nov: '', dece: '', jan: '', feb: '', mar: '', apr: '', may: '', jun: '', jul: '', aug: '', sep: '',
    ...extra,
  };
}

describe('kpi-excel: normalizeCell', () => {
  it('ตัวเลขจาก Excel → ข้อความที่ระบบเก็บ (ไม่มีเศษทศนิยมลอย)', () => {
    expect(normalizeCell(85)).toBe('85');
    expect(normalizeCell(0.1 + 0.2)).toBe('0.3');
    expect(normalizeCell(97.06)).toBe('97.06');
    expect(normalizeCell(0)).toBe('0');
  });
  it('ข้อความ: ตัดช่องว่าง, จุลภาคคั่นหลักพัน, ขีดแทนค่าว่าง — ข้อความอื่นคงเดิม', () => {
    expect(normalizeCell('  85 ')).toBe('85');
    expect(normalizeCell('1,234.5')).toBe('1234.5');
    expect(normalizeCell('12,34')).toBe('12,34');          // ไม่ใช่รูปแบบหลักพัน — ไม่แตะ
    expect(normalizeCell('-')).toBe('');
    expect(normalizeCell(null)).toBe('');
    expect(normalizeCell('รอดำเนินการ')).toBe('รอดำเนินการ');
    expect(normalizeCell('-5')).toBe('-5');
  });
});

describe('kpi-excel: แบบฟอร์ม → นำเข้า', () => {
  it('แบบฟอร์มมีแถวคำอธิบาย + หัวตาราง + ค่าเดิม และอ่านกลับได้ครบ (ผ่านไฟล์ .xlsx จริง)', () => {
    const items = [row(1, '10666', { oct: '85', nov: '90.5' }), row(2, '00123', { target_value: '60', is_locked: 1 })];
    const aoa = buildTemplateAoa(items);
    expect(aoa[1].slice(0, 3)).toEqual([EXCEL_HEADERS.indicator_id, EXCEL_HEADERS.hospcode, EXCEL_HEADERS.year_bh]);
    expect(aoa[1].length).toBe(8 + 12);
    expect(aoa[2][7]).toBe(80);            // เป้าหมายเขียนเป็นตัวเลข
    expect(aoa[2][8]).toBe(85);
    expect(aoa[3][1]).toBe('00123');       // รหัสหน่วยบริการเป็นข้อความ (คงเลข 0 นำหน้า)
    expect(String(aoa[3][6])).toContain('ล็อค');

    // เขียน-อ่านไฟล์จริงด้วยไลบรารี xlsx (เส้นทางเดียวกับหน้าจอ)
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'ผลงาน');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const back = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const read = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1, raw: true, defval: '' }) as any[][];
    const parsed = parseImportAoa(read);
    expect(parsed.error).toBeUndefined();
    expect(parsed.fields).toEqual(['target_value', ...EXCEL_MONTHS.map(m => m.key)]);
    expect(parsed.rows.length).toBe(2);
    expect(parsed.rows[0]).toMatchObject({ indicator_id: 1, hospcode: '10666', year_bh: '2570' });
    expect(parsed.rows[0].values['oct']).toBe('85');
    expect(parsed.rows[0].values['nov']).toBe('90.5');
    expect(parsed.rows[1].hospcode).toBe('00123');
  });

  it('รหัสหน่วยบริการที่ Excel ตัดเลข 0 นำหน้า → เติมกลับเป็น 5 หลัก', () => {
    const parsed = parseImportAoa([['indicator_id', 'hospcode', 'ปีงบประมาณ', 'ต.ค.'], [7, 123, 2570, 50]]);
    expect(parsed.rows[0].hospcode).toBe('00123');
    expect(parsed.rows[0].year_bh).toBe('2570');
  });

  it('สลับ/ลบคอลัมน์ได้ (จับคู่ตามชื่อหัว) และข้ามแถวว่าง', () => {
    const parsed = parseImportAoa([
      ['บันทึกเพิ่มเติมของผู้ใช้'],
      ['พ.ย.', 'hospcode', 'ตัวชี้วัด', 'indicator_id', 'ปีงบประมาณ'],
      [12, '10666', 'x', 5, '2570'],
      ['', '', '', '', ''],
      ['รวม', '', '', '', ''],
    ]);
    expect(parsed.fields).toEqual(['nov']);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0]).toMatchObject({ rowNo: 3, indicator_id: 5, hospcode: '10666' });
    expect(parsed.rows[0].values).toEqual({ nov: '12' });
  });

  it('ไฟล์ที่ไม่ใช่แบบฟอร์ม → แจ้งข้อผิดพลาด ไม่นำเข้า', () => {
    expect(parseImportAoa([['ชื่อ', 'ค่า'], ['a', 1]]).error).toContain('ไม่พบหัวตาราง');
    expect(parseImportAoa([['indicator_id', 'hospcode', 'ต.ค.'], [1, '10666', 5]]).error).toContain('ปีงบประมาณ');
    expect(parseImportAoa([['indicator_id', 'hospcode', 'ปีงบประมาณ'], [1, '10666', 2570]]).error).toContain('เป้าหมายหรือเดือน');
    expect(parseImportAoa([]).error).toBeTruthy();
  });
});

describe('kpi-excel: planImport', () => {
  const file = (rows: any[][]) => parseImportAoa([['indicator_id', 'hospcode', 'ปีงบประมาณ', 'เป้าหมาย', 'ต.ค.', 'พ.ย.'], ...rows]).rows;

  it('เปลี่ยนเฉพาะช่องที่มีค่าและต่างจากเดิม — ช่องว่างไม่ทับค่าเดิม, ค่าเท่าเดิมไม่นับ', () => {
    const items = [row(1, '10666', { oct: '85', nov: '70' })];
    const plan = planImport(file([[1, '10666', 2570, 80.0, 90, '']]), items, PERMS);
    expect(plan.changes.map(c => [c.field, c.oldVal, c.newVal])).toEqual([['oct', '85', '90']]);
    expect(plan.same).toBe(1);                 // เป้าหมาย 80 เท่าเดิม
    applyCellChanges(plan.changes);
    expect(items[0].oct).toBe('90');
    expect(items[0].nov).toBe('70');           // ช่องว่างในไฟล์ → คงค่าเดิม
  });

  it('ข้ามแถวที่ล็อค / ไม่มีสิทธิ์ / ไม่อยู่ในตาราง / ปีงบไม่ตรง / แถวซ้ำ / ยาวเกิน', () => {
    const items = [row(1, '10666'), row(2, '10666', { is_locked: 1 }), row(3, '10666')];
    const rows = file([
      [1, '10666', 2570, 90, 10, ''],          // เป้าหมาย: ไม่มีสิทธิ์, ต.ค.: เปลี่ยน
      [2, '10666', 2570, '', 20, 30],          // ล็อค 2 ช่อง
      [9, '10666', 2570, '', 5, ''],           // ไม่มีในตาราง
      [3, '10666', 2569, '', 5, ''],           // ปีงบไม่ตรง
      [1, '10666', 2570, '', 99, ''],          // ซ้ำ — ใช้แถวแรก
      [3, '10666', 2570, '', 'x'.repeat(101), 7],
    ]);
    const plan = planImport(rows, items, { canEditActual: true, canEditTarget: false });
    expect(plan.changes.map(c => `${c.item.indicator_id}.${c.field}=${c.newVal}`)).toEqual(['1.oct=10', '3.nov=7']);
    expect(plan.noPerm).toBe(1);
    expect(plan.locked).toBe(2);
    expect(plan.unmatchedRows).toEqual([4, 5]);
    expect(plan.duplicateRows).toEqual([6]);
    expect(plan.tooLong).toBe(1);
  });

  it('ไม่มีสิทธิ์แก้ผลงาน → ไม่เปลี่ยนช่องเดือนเลย', () => {
    const plan = planImport(file([[1, '10666', 2570, 70, 10, 20]]), [row(1, '10666')], { canEditActual: false, canEditTarget: true });
    expect(plan.changes.map(c => c.field)).toEqual(['target_value']);
    expect(plan.noPerm).toBe(2);
  });
});

describe('kpi-excel: วางจากคลิปบอร์ด', () => {
  it('แยกตาราง (แท็บ/ขึ้นบรรทัด) และรู้ว่าเป็นหลายช่องหรือช่องเดียว', () => {
    expect(parseClipboardGrid('1\t2\r\n3\t4\r\n')).toEqual([['1', '2'], ['3', '4']]);
    expect(parseClipboardGrid('85')).toEqual([['85']]);
    expect(isMultiCell(parseClipboardGrid('85'))).toBe(false);
    expect(isMultiCell(parseClipboardGrid('85\n'))).toBe(false);
    expect(isMultiCell(parseClipboardGrid('1\t2'))).toBe(true);
    expect(isMultiCell(parseClipboardGrid('1\n2'))).toBe(true);
  });

  it('วางไล่ลงและไปทางขวาจากช่องเริ่ม — ข้ามแถวล็อค นับช่องที่เกินตาราง', () => {
    const items = [row(1, 'A'), row(2, 'A', { is_locked: 1 }), row(3, 'A')];
    const grid = parseClipboardGrid('10\t11\t12\n20\t21\t22\n30\t\t32\n40\t41\t42');
    const plan = planPaste(grid, items, 0, ['aug', 'sep'], PERMS);     // เริ่มที่ ส.ค. เหลือ 2 คอลัมน์
    applyCellChanges(plan.changes);
    expect([items[0].aug, items[0].sep]).toEqual(['10', '11']);
    expect([items[1].aug, items[1].sep]).toEqual(['', '']);            // ล็อค
    expect([items[2].aug, items[2].sep]).toEqual(['30', '']);          // ช่องว่างไม่ทับ
    expect(plan.locked).toBe(2);
    expect(plan.overflow).toBe(3 + 3);                                 // คอลัมน์ที่ 3 ของ 3 แถวที่มีค่า + แถวที่ 4 ทั้งแถว
  });

  it('applyCellChanges คืนรายการแถวที่ถูกแก้แบบไม่ซ้ำ', () => {
    const items = [row(1, 'A'), row(2, 'A')];
    const plan = planPaste([['1', '2'], ['3', '4']], items, 0, ['oct', 'nov'], PERMS);
    expect(applyCellChanges(plan.changes).length).toBe(2);
  });
});

describe('kpi-excel — ค่าฐาน (base ของสูตร)', () => {
  it('แบบฟอร์มมีคอลัมน์ "ค่าฐาน" ต่อจากเป้าหมายเมื่อ withBase (แถวที่ไม่มีค่าฐานเว้นว่าง)', () => {
    const items = [row(1, '00222', { cv_base: '21.2' }), row(2, '00223')];
    const aoa = buildTemplateAoa(items, { withBase: true });
    const head = aoa[1] as string[];
    expect(head.indexOf(EXCEL_HEADERS.base)).toBe(head.indexOf(EXCEL_HEADERS.target) + 1);
    expect(aoa[2][head.indexOf(EXCEL_HEADERS.base)]).toBe(21.2);
    expect(aoa[3][head.indexOf(EXCEL_HEADERS.base)]).toBe('');
    expect((buildTemplateAoa(items)[1] as string[]).includes(EXCEL_HEADERS.base)).toBe(false);
  });

  it('นำเข้าค่าฐาน: เฉพาะแถวที่ตัวชี้วัดใช้ค่าฐาน + สิทธิ์เดียวกับเป้าหมาย', () => {
    const withBase = row(1, '00222', { cv_base: null });
    const noBase = row(2, '00223');
    const aoa = buildTemplateAoa([withBase, noBase], { withBase: true });
    const h = (aoa[1] as string[]).indexOf(EXCEL_HEADERS.base);
    aoa[2][h] = 4.6; aoa[3][h] = 9;
    const parsed = parseImportAoa(aoa);
    expect(parsed.fields).toContain('cv_base');
    const plan = planImport(parsed.rows, [withBase, noBase], PERMS);
    expect(plan.changes.map(c => [c.item.indicator_id, c.field, c.newVal])).toEqual([[1, 'cv_base', '4.6']]);
    const denied = planImport(parsed.rows, [withBase, noBase], { canEditActual: true, canEditTarget: false });
    expect(denied.changes).toEqual([]);
    expect(denied.noPerm).toBe(1);
  });
});

describe('kpi-excel — ค่าเพิ่มเติมที่ตั้งชื่อเอง', () => {
  it('คอลัมน์ "ชื่อ [key]" ต่อจากเป้าหมาย + นำเข้าเป็น cv_<key>', () => {
    const it1 = row(1, '00222', { cv_pop: '25000' });
    const aoa = buildTemplateAoa([it1], { vars: [{ key: 'pop', label: 'ประชากร' }] });
    const head = aoa[1] as string[];
    const h = head.indexOf('ประชากร [pop]');
    expect(h).toBe(head.indexOf(EXCEL_HEADERS.target) + 1);
    expect(aoa[2][h]).toBe(25000);
    aoa[2][h] = 30000;
    const parsed = parseImportAoa(aoa);
    expect(parsed.fields).toContain('cv_pop');
    expect(planImport(parsed.rows, [it1], PERMS).changes.map(c => [c.field, c.newVal])).toEqual([['cv_pop', '30000']]);
  });
});

describe('kpi-excel — ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569)', () => {
  it('มีคอลัมน์เมื่อมีแถวที่ตั้งกรอกเอง (แถวอื่นเว้นว่าง) + นำเข้าเฉพาะแถวที่ตั้งกรอกเอง + สิทธิ์เดียวกับผลงาน', () => {
    const m1 = row(1, '00222', { result_manual: 1, pct_manual: 1, manual_result: '65', manual_pct: '95.5' });
    const p2 = row(2, '00222');
    const aoa = buildTemplateAoa([m1, p2]);
    const head = aoa[1] as string[];
    const cr = head.indexOf(EXCEL_HEADERS.manualResult), cp = head.indexOf(EXCEL_HEADERS.manualPct);
    expect(cr).toBe(head.indexOf(EXCEL_HEADERS.target) + 1);
    expect(cp).toBe(cr + 1);
    expect([aoa[2][cr], aoa[2][cp], aoa[3][cr], aoa[3][cp]]).toEqual([65, 95.5, '', '']);
    aoa[2][cr] = 70; aoa[2][cp] = 101; aoa[3][cr] = 5; aoa[3][cp] = 5;   // แถวที่ 2 ไม่ได้ตั้งกรอกเอง → ข้าม
    const parsed = parseImportAoa(aoa);
    expect(parsed.fields).toEqual(expect.arrayContaining(['manual_result', 'manual_pct']));
    expect(planImport(parsed.rows, [m1, p2], PERMS).changes.map(c => [c.item.indicator_id, c.field, c.newVal]))
      .toEqual([[1, 'manual_result', '70'], [1, 'manual_pct', '101']]);
    expect(planImport(parsed.rows, [m1, p2], { canEditActual: false, canEditTarget: true }).noPerm).toBe(2);
    // ไม่มีแถวที่ตั้งกรอกเอง → ไม่มีคอลัมน์
    expect((buildTemplateAoa([p2])[1] as string[]).includes(EXCEL_HEADERS.manualResult)).toBe(false);
  });
});
