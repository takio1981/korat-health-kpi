import { buildKhdDiffRows, typesChangeText, hostypeChangeText, khdDiffAoa, fiscalYearList, fiscalYearMatch, fiscalYearChangeText, fiscalYearChoices, khdOrgMatch, khdOrgUnmatched, khdTpKind, khdTpDetail } from './khd-diff';

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

// ปีงบประมาณเทียบกับ KHD (9 พ.ย. 2569)
describe('khd-diff fiscal year', () => {
  it('fiscalYearList / fiscalYearMatch / fiscalYearChangeText / fiscalYearChoices', () => {
    expect(fiscalYearList('2570, 2569,2570,x')).toEqual(['2569', '2570']);
    expect(fiscalYearList(['2571', 2570])).toEqual(['2570', '2571']);
    expect(fiscalYearMatch('2570,2569', ['2569', '2570'])).toBe(true);
    expect(fiscalYearMatch(null, ['2570'])).toBe(false);
    expect(fiscalYearMatch('2570', [])).toBeNull();
    expect(fiscalYearChangeText('2568,2570', ['2569', '2570'])).toBe('เพิ่ม: 2569 · เอาออก: 2568');
    expect(fiscalYearChoices(2570, ['2560'])).toEqual(['2572', '2571', '2570', '2569', '2568', '2560']);
  });
  it('buildKhdDiffRows: แถวปีงบ (ค่าปัจจุบันของตัวชี้วัด) — KHD ไม่มีปีงบ = ไม่มีแถว', () => {
    const items = [
      { id: 1, kpi_indicators_name: 'ก', table_process: 'a', khd_fiscal_year: null },
      { id: 2, kpi_indicators_name: 'ข', table_process: 'b', khd_fiscal_year: '2570' },
    ];
    const khd: Record<string, any> = { a: { status: 'match', khd_fiscal_years: ['2570'] }, b: { status: 'match', khd_fiscal_years: [] } };
    const rows = buildKhdDiffRows(items, { getKhd: (i: any) => khd[i.table_process], criteriaText: () => '-', khdCriteriaText: () => '-' });
    expect(rows).toEqual([expect.objectContaining({ id: 1, kind: 'fiscal_year', local: 'ไม่ระบุปีงบ', khd: '2570', detail: 'เพิ่ม: 2570' })]);
  });
});

// table_process เทียบกับ KHD (9 พ.ย. 2569): ชื่อเดียวกันแต่ table_process ต่าง / table_process เดียวกันแต่ชื่อต่าง
describe('khd-diff table_process', () => {
  it('tp_different → แถว table_process (ระบบ ↔ KHD) | different → แถวชื่อบอกว่า table_process เดียวกัน', () => {
    const items = [
      { id: 7, kpi_indicators_name: 'ร้อยละ ก', table_process: 'kpi_local_7' },
      { id: 8, kpi_indicators_name: 'ร้อยละ ข', table_process: 'kpi_same_8' },
    ];
    const khd: Record<string, any> = {
      kpi_local_7: { status: 'tp_different', khd_table_process: 'kpi_khd_7', khd_report_id: 501, report_code: 'R-7' },
      kpi_same_8: { status: 'different', khd_name: 'ร้อยละ ข (ใหม่)' },
    };
    const rows = buildKhdDiffRows(items, { getKhd: (i: any) => khd[i.table_process], criteriaText: () => '-', khdCriteriaText: () => '-' });
    expect(rows).toEqual([
      expect.objectContaining({ id: 7, kind: 'table_process', local: 'kpi_local_7', khd: 'kpi_khd_7', detail: 'ชื่อเดียวกัน (KHD #501 · รหัส R-7)' }),
      expect.objectContaining({ id: 8, kind: 'name', local: 'ร้อยละ ข', khd: 'ร้อยละ ข (ใหม่)', detail: 'table_process เดียวกัน: kpi_same_8' }),
    ]);
  });
});


// หน่วยงาน / หมวดหมู่หลัก เทียบกับ KHD (11 พ.ย. 2569)
describe('khd-diff หน่วยงาน/หมวดหมู่หลัก', () => {
  const k = (extra: any) => ({ status: 'match', khd_dept_status: 'auto', khd_dept_id: 2, khd_dept_name: 'กลุ่มงาน ข', khd_dept_value: 'NCD',
    khd_main_status: 'mapped', khd_main_id: 10, khd_main_name: 'หมวด ก', khd_main_value: 'หมวด ก (37)', ...extra });
  it('khdOrgMatch: เทียบค่าปัจจุบัน — จับคู่ไม่ได้/ไม่ระบุ/ยังไม่เทียบ = null', () => {
    expect(khdOrgMatch({ dept_id: 2 }, k({}), 'dept')).toBe(true);
    expect(khdOrgMatch({ dept_id: '1' }, k({}), 'dept')).toBe(false);
    expect(khdOrgMatch({ main_indicator_id: null }, k({}), 'main')).toBe(false);
    expect(khdOrgMatch({ dept_id: 1 }, k({ khd_dept_status: 'unmatched', khd_dept_id: null }), 'dept')).toBeNull();
    expect(khdOrgMatch({ dept_id: 1 }, k({ khd_dept_status: 'empty' }), 'dept')).toBeNull();
    expect(khdOrgMatch({ dept_id: 1 }, null, 'dept')).toBeNull();
    expect(khdOrgMatch({ dept_id: 1 }, k({ status: 'missing_remote' }), 'dept')).toBeNull();
    expect(khdOrgUnmatched(k({ khd_main_status: 'unmatched' }), 'main')).toBe(true);
  });
  it('buildKhdDiffRows: แถวหน่วยงาน/หมวดหมู่หลัก ระบบ ↔ KHD พร้อมค่าใน KHD และวิธีจับคู่', () => {
    const items = [{ id: 1, kpi_indicators_name: 'ก', table_process: 'a', dept_id: 1, main_indicator_id: null }];
    const rows = buildKhdDiffRows(items, { getKhd: () => k({}), criteriaText: () => '-', khdCriteriaText: () => '-',
      deptName: (id: any) => ({ 1: 'กลุ่มงาน ก', 2: 'กลุ่มงาน ข' } as any)[id], mainName: () => '' });
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'dept', local: 'กลุ่มงาน ก', khd: 'กลุ่มงาน ข', detail: 'ค่าใน KHD: "NCD" (จับคู่อัตโนมัติ)' }),
      expect.objectContaining({ kind: 'main', local: 'ไม่ระบุ', khd: 'หมวด ก', detail: 'ค่าใน KHD: "หมวด ก (37)" (จับคู่ที่ตั้งไว้)' }),
    ]);
  });
});

// ชื่อเดียวกันแต่ table_process ต่าง — ใช้ได้ / ต้องแก้ที่ KHD / ชื่อตรงหลายรายการ / อาจซ้ำในระบบ (11 พ.ย. 2569)
describe('khd-diff table_process — สถานะของคู่', () => {
  const items = [1, 2, 3, 4].map(id => ({ id, kpi_indicators_name: 'ก', table_process: 'tp_' + id }));
  const khd: Record<string, any> = {
    tp_1: { status: 'tp_different', khd_report_id: 11, khd_table_process: 'kpi_x' },
    tp_2: { status: 'tp_different', khd_report_id: 12, report_code: 'tp-2', khd_table_process: 'kpi_shared', khd_tp_shared: 6, khd_code_matches_tp: true, khd_tp_used_by: { id: 9, name: 'ข' } },
    tp_3: { status: 'tp_different', khd_report_id: null, tp_ambiguous: true, tp_candidates: [{ report_id: 21, table_process: 'a' }, { report_id: 22, table_process: 'b' }] },
    tp_4: { status: 'tp_different', tp_note: 'linked_other', tp_candidates: [{ report_id: 31, table_process: 'c', used_by_id: 5 }] },
  };
  it('khdTpKind + ข้อความอธิบาย', () => {
    expect(['tp_1', 'tp_2', 'tp_3', 'tp_4'].map(t => khdTpKind(khd[t]))).toEqual(['apply', 'khd_fix', 'ambiguous', 'linked_other']);
    expect(khdTpKind({ status: 'match' })).toBeNull();
    expect(khdTpDetail(khd['tp_2'])).toBe('ชื่อเดียวกัน (KHD #12 · รหัส tp-2) · รหัสรายงาน KHD ตรงกับ table_process ของระบบ · KHD ใช้ table_process นี้ร่วมกัน 6 รายงาน · ตัวชี้วัด #9 ข ของระบบใช้ table_process นี้แล้ว → ควรแก้ table_process ของรายงานนี้ที่ KHD');
    expect(khdTpDetail(khd['tp_4'])).toContain('#31 c (ใช้กับตัวชี้วัด #5 ในระบบ)');
  });
  it('แถวในหน้าต่างรายละเอียด: ใช้ได้เฉพาะคู่ที่ปรับได้ ที่เหลือมีหมายเหตุแทนปุ่ม', () => {
    const rows = buildKhdDiffRows(items, { getKhd: (i: any) => khd[i.table_process], criteriaText: () => '-', khdCriteriaText: () => '-' });
    expect(rows.map(r => [r.id, r.khd, r.applicable, r.note])).toEqual([
      [1, 'kpi_x', undefined, undefined], [2, 'kpi_shared', false, 'แก้ที่ KHD'], [3, 'a, b', false, 'ตรวจสอบเอง'], [4, 'c', false, 'ตรวจสอบเอง']]);
  });
});
