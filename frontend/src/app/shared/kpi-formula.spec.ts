import { evaluateFormula, validateFormula, activeFormula, usesPrevYear, quarterValues, isQuarterEntryMonth, quarterResultFormula } from './kpi-formula';
import cases from './kpi-formula.cases.json';

// fixture เดียวกับ backend (api/tests/fixtures/formula-cases.json) — ผลต้องตรงกันทุกเคส
describe('kpi-formula (frontend) — สูตรที่ถูกต้อง', () => {
  for (const c of (cases as any).valid) {
    it(c.name, () => {
      expect(validateFormula(c.formula, c.allowed, c.allowExtra)).toBeNull();
      expect(evaluateFormula(c.formula, c.months, c.target, c.prev, c.vars ?? c.base)).toBe(c.expect);
    });
  }
});

it('usesPrevYear ตรงกับ backend', () => {
  expect(usesPrevYear('AVG(ALL)')).toBe(false);
  expect(usesPrevYear('LAST(ALL) - prev_result')).toBe(true);
  expect(usesPrevYear('SUM(m10, prev_m1)')).toBe(true);
  expect(usesPrevYear('AVG(PREV_ALL)')).toBe(true);
});

describe('kpi-formula (frontend) — สูตรที่ผิดต้องถูกปฏิเสธ', () => {
  for (const c of (cases as any).invalid) {
    it(c.name, () => {
      const msg = validateFormula(c.formula, c.allowed, c.allowExtra);
      expect(typeof msg).toBe('string');
      expect((msg as string).length).toBeGreaterThan(0);
    });
  }
});

it('activeFormula: ว่าง = null, มีค่า = trim', () => {
  expect(activeFormula({})).toBeNull();
  expect(activeFormula({ result_formula: '  ' })).toBeNull();
  expect(activeFormula({ result_formula: ' AVG(ALL) ' })).toBe('AVG(ALL)');
});


// ตัวชี้วัดวัดผลรายไตรมาส (10 พ.ย. 2569) — ค่าเดียวกับ api/tests/kpi-formula.test.js
describe('kpi-formula (frontend) — ไตรมาส', () => {
  const m = { oct: '1', nov: '2', dece: '3', jan: '10', feb: '', mar: '20', jun: 'กำลังดำเนินการ' };
  it('quarterValues ตามโหมด', () => {
    expect(quarterValues('month_sum', m)).toEqual(['6', '30', null, null]);
    expect(quarterValues('month_avg', m)).toEqual(['2', '15', null, null]);
    expect(quarterValues('month_last', m)).toEqual(['3', '20', null, null]);
    expect(quarterValues('quarter', { nov: '9', dece: '4', jun: '7' })).toEqual(['4', null, '7', null]);
    expect(quarterValues('', m)).toEqual([null, null, null, null]);
  });
  it('isQuarterEntryMonth / quarterResultFormula', () => {
    expect(['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].filter(k => isQuarterEntryMonth('quarter', k))).toEqual(['dece', 'mar', 'jun', 'sep']);
    expect(isQuarterEntryMonth('month_sum', 'nov')).toBe(true);
    expect(quarterResultFormula('month_sum')).toBe('LASTQ(SUM)');
    expect(quarterResultFormula('quarter')).toBeNull();
  });
});
