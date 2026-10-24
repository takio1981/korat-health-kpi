import { parseCustomVars, customVarDefsFor, customValuesOf, evaluatePct } from './custom-vars';

describe('custom-vars — ค่าเพิ่มเติมที่ตั้งชื่อเอง + สูตรร้อยละ', () => {
  it('parseCustomVars: รับ JSON/array ตัดชื่อผิด/ซ้ำ ชื่อที่แสดงว่าง = key', () => {
    expect(parseCustomVars('[{"key":"pop","label":"ประชากร"},{"key":"pop"},{"key":"Bad-1"},{"key":"den"}]'))
      .toEqual([{ key: 'pop', label: 'ประชากร' }, { key: 'den', label: 'den' }]);
    expect(parseCustomVars('ไม่ใช่ JSON')).toEqual([]);
    expect(parseCustomVars(null)).toEqual([]);
  });

  it('customVarDefsFor: base ขึ้นเองเมื่อสูตร (ผลงานหรือร้อยละ) อ้าง base', () => {
    expect(customVarDefsFor({ result_formula: 'AVG(ALL)' })).toEqual([]);
    expect(customVarDefsFor({ result_formula: '(base - SUM(ALL)) / base * 100' }).map(d => d.key)).toEqual(['base']);
    expect(customVarDefsFor({ pct_formula: 'result / base * 100', custom_vars: [{ key: 'pop', label: 'ประชากร' }] }).map(d => d.key)).toEqual(['base', 'pop']);
    expect(customValuesOf({ custom_vars: [{ key: 'pop', label: 'ป' }], cv_pop: '100' })).toEqual({ pop: '100' });
  });

  it('evaluatePct: ใช้ result + target + ค่าเพิ่มเติม — ไม่ตั้งสูตร = null', () => {
    const item = { pct_formula: '(target - result) / target * 100 + 100', target_value: '5.5', last_actual: '4.4' };
    expect(evaluatePct(item)).toBe(120);
    expect(evaluatePct({ ...item, last_actual: '' })).toBeNull();
    expect(evaluatePct({ last_actual: '4' })).toBeNull();
    expect(evaluatePct({ pct_formula: 'result / pop * 100', custom_vars: [{ key: 'pop' }], cv_pop: '8', last_actual: '2' })).toBe(25);
  });
});
