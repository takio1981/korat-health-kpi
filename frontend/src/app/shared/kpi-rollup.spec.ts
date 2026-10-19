import { activityValue, rollupMonthly, monthKey, itemNumber, rollupTree } from './kpi-rollup';
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

describe('kpi-rollup (frontend) — rollupTree (fixture ร่วมกับ backend)', () => {
  for (const c of (cases as any).tree) {
    it(c.name, () => {
      const r = rollupTree(c.nodes, c.values);
      for (const [k, months] of Object.entries(c.expected as any)) {
        for (const [mk, v] of Object.entries(months as any)) expect([k, mk, r[k].months[mk]]).toEqual([k, mk, v]);
      }
      expect(Object.keys(r).filter(k => r[k].rolled).sort()).toEqual([...c.rolled].sort());
    });
  }
});

describe('kpi-rollup (frontend) — itemNumber (fixture ร่วมกับ backend)', () => {
  for (const c of (cases as any).itemNumber) {
    it(c.name, () => expect(itemNumber(c.explicit, c.parent, c.index)).toBe(c.expected));
  }
});
