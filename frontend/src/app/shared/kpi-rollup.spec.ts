import { activityValue, rollupMonthly, monthKey, itemNumber } from './kpi-rollup';
import cases from './kpi-rollup.cases.json';

// fixture เดียวกับ backend (api/tests/fixtures/rollup-cases.json) — ผลต้องตรงกันทุกเคส
describe('kpi-rollup (frontend) — activityValue', () => {
  for (const c of (cases as any).activity) {
    it(c.name, () => expect(activityValue(c.type, c.raw)).toBe(c.expected));
  }
});

describe('kpi-rollup (frontend) — rollupMonthly', () => {
  for (const c of (cases as any).rollup) {
    it(c.name, () => expect(rollupMonthly(c.count, c.months)).toEqual(c.expected));
  }
});

it('monthKey', () => {
  expect(monthKey(10)).toBe('m10');
  expect(monthKey(1)).toBe('m01');
});

it('itemNumber: กำหนดเองก่อน ไม่งั้นต่อจากเลขข้อแม่', () => {
  expect(itemNumber('2.5', '1', 0)).toBe('2.5');
  expect(itemNumber('', '1', 1)).toBe('1.2');
  expect(itemNumber(null, '1.2', 0)).toBe('1.2.1');
  expect(itemNumber(undefined, '', 2)).toBe('3');
});
