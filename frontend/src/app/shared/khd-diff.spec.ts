import { buildKhdDiffRows, typesChangeText, hostypeChangeText, khdDiffAoa } from './khd-diff';

// รายละเอียดความแตกต่างหลังเทียบกับ KHD (9 พ.ย. 2569)
describe('khd-diff', () => {
  const names = { '05': 'รพ.ศูนย์', '07': 'รพ.ชุมชน', '18': 'รพ.สต.' };

  it('typesChangeText: เฉพาะประเภทที่ต่าง', () => {
    expect(typesChangeText({ r9: 1, moph: 0, ssj: 1 }, { r9: 0, moph: 1, ssj: 1, rmw: 0, other: 0 })).toBe('R9: มี → ไม่มี, MOPH: ไม่มี → มี');
    expect(typesChangeText({ r9: 1 }, { r9: 1 })).toBe('');
  });

  it('hostypeChangeText: เปลี่ยนโหมด / เพิ่ม-เอาออกรายการ', () => {
    expect(hostypeChangeText(null, null, 'any_one', ['05'], names)).toBe('โหมด: ยังไม่ตั้ง → เฉพาะบางประเภท');
    expect(hostypeChangeText('any_one', '["05","18"]', 'any_one', ['05', '07'], names)).toBe('เพิ่ม: รพ.ชุมชน (07) · เอาออก: รพ.สต. (18)');
  });

  it('buildKhdDiffRows: 1 แถวต่อหัวข้อที่ต่าง ข้ามตัวที่ไม่ได้เทียบ/ไม่มีใน KHD | khdDiffAoa มีหัวตาราง', () => {
    const items = [
      { id: 1, kpi_indicators_name: 'ก', table_process: 'tp1', criterion: '80', target_condition: 'GTE', r9: 1, evaluation_mode: 'any_one', required_off_types: '["05","18"]', upload_excel: 0 },
      { id: 2, kpi_indicators_name: 'ข', table_process: 'tp2' },
      { id: 3, kpi_indicators_name: 'ค', table_process: 'tp3' },
    ];
    const khd: Record<string, any> = {
      tp1: { status: 'different', khd_name: 'ก (KHD)', criteria_match: false, types_match: false, khd_types: { r9: 0, moph: 1 }, khd_types_source: 'fiscal_year_config',
        hostype_match: false, khd_eval_mode: 'any_one', khd_off_types: ['05', '07'], khd_is_active: 0 },
      tp2: { status: 'missing_remote' },
    };
    const rows = buildKhdDiffRows(items, {
      getKhd: (i: any) => khd[i.table_process], criteriaText: (i: any) => '≥ ' + i.criterion + '%', khdCriteriaText: () => '≥ 90%', hosNames: names,
    });
    expect(rows.map(r => r.kind)).toEqual(['name', 'criteria', 'types', 'hostype', 'status']);
    expect(rows.find(r => r.kind === 'name')).toEqual(expect.objectContaining({ local: 'ก', khd: 'ก (KHD)' }));
    expect(rows.find(r => r.kind === 'criteria')).toEqual(expect.objectContaining({ local: '≥ 80%', khd: '≥ 90%' }));
    expect(rows.find(r => r.kind === 'types')!.detail).toBe('R9: มี → ไม่มี, MOPH: ไม่มี → มี (KHD: ค่าของปีงบ)');
    expect(rows.find(r => r.kind === 'hostype')).toEqual(expect.objectContaining({ local: 'รพ.ศูนย์ (05), รพ.สต. (18)', khd: 'รพ.ศูนย์ (05), รพ.ชุมชน (07)' }));
    expect(rows.find(r => r.kind === 'status')!.detail).toBe('แนะนำปิดส่งออก KHD');
    const aoa = khdDiffAoa(rows, '2570');
    expect(aoa[0][5]).toBe('ใน KHD (ปีงบ 2570)');
    expect(aoa).toHaveLength(6);
  });
});
