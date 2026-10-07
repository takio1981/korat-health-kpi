import { evaluateFormula, validateFormula, activeFormula } from './kpi-formula';
import cases from './kpi-formula.cases.json';

// fixture เดียวกับ backend (api/tests/fixtures/formula-cases.json) — ผลต้องตรงกันทุกเคส
describe('kpi-formula (frontend) — สูตรที่ถูกต้อง', () => {
  for (const c of (cases as any).valid) {
    it(c.name, () => {
      expect(validateFormula(c.formula)).toBeNull();
      expect(evaluateFormula(c.formula, c.months, c.target)).toBe(c.expect);
    });
  }
});

describe('kpi-formula (frontend) — สูตรที่ผิดต้องถูกปฏิเสธ', () => {
  for (const c of (cases as any).invalid) {
    it(c.name, () => {
      const msg = validateFormula(c.formula);
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
