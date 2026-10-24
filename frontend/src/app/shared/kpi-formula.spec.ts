import { evaluateFormula, validateFormula, activeFormula, usesPrevYear } from './kpi-formula';
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
