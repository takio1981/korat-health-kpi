import { normalizeCondition, hasTarget, evaluateTarget, aggregateMonthlyTarget } from './kpi-target';
import cases from './kpi-target.cases.json';

// fixture เดียวกับ backend (api/tests/fixtures/target-cases.json) — ผลต้องตรงกันทุกเคส
describe('kpi-target (frontend) — normalizeCondition', () => {
  for (const c of (cases as any).normalize) {
    it(c.name, () => expect(normalizeCondition(c.in)).toBe(c.expected));
  }
});

describe('kpi-target (frontend) — evaluateTarget', () => {
  for (const c of (cases as any).evaluate) {
    it(c.name, () => {
      const r = evaluateTarget(c.actual, c.target, c.cond);
      expect(r.pass).toBe(c.pass);
      if (c.pct === null) expect(r.pct).toBeNull();
      else expect(r.pct as number).toBeCloseTo(c.pct, 6);
    });
  }
});

describe('kpi-target (frontend) — hasTarget', () => {
  for (const c of (cases as any).has) {
    it(c.name, () => expect(hasTarget(c.target, c.cond)).toBe(c.expected));
  }
});

describe('kpi-target (frontend) — aggregateMonthlyTarget (เป้าหมายรายเดือน)', () => {
  for (const c of (cases as any).monthly) {
    it(c.name, () => expect(aggregateMonthlyTarget(c.mode, c.actuals, c.targets)).toBe(c.expected));
  }
});
