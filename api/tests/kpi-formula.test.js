/**
 * Unit tests: สูตรคำนวณผลงาน (api/kpi-formula.js) — ไม่ใช้ database
 * fixture ร่วมกับ frontend (kpi-formula.cases.json) เพื่อการันตีว่าผล frontend/backend ตรงกัน
 */
const fs = require('fs');
const path = require('path');
const { evaluateFormula, validateFormula, activeFormula, usesPrevYear } = require('../kpi-formula');

const fixturePath = path.join(__dirname, 'fixtures', 'formula-cases.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('evaluateFormula — สูตรที่ถูกต้อง', () => {
    test.each(cases.valid.map(c => [c.name, c]))('%s', (_n, c) => {
        expect(validateFormula(c.formula, c.allowed, c.allowExtra)).toBeNull();
        expect(evaluateFormula(c.formula, c.months, c.target, c.prev, c.vars ?? c.base)).toBe(c.expect);
    });
});

test('usesPrevYear: ตรวจว่าสูตรอ้างข้อมูลปีงบที่แล้วหรือไม่ (ใช้ตัดสินว่าต้องโหลดข้อมูลปีที่แล้ว)', () => {
    expect(usesPrevYear('AVG(ALL)')).toBe(false);
    expect(usesPrevYear('m10 + target')).toBe(false);
    expect(usesPrevYear('LAST(ALL) - prev_result')).toBe(true);
    expect(usesPrevYear('-(prev_target)')).toBe(true);
    expect(usesPrevYear('SUM(m10, prev_m1)')).toBe(true);
    expect(usesPrevYear('AVG(PREV_ALL)')).toBe(true);
    expect(usesPrevYear('สูตรผิด(')).toBe(false);
});

describe('validateFormula — สูตรที่ผิดต้องถูกปฏิเสธพร้อมข้อความ', () => {
    test.each(cases.invalid.map(c => [c.name, c]))('%s', (_n, c) => {
        const msg = validateFormula(c.formula, c.allowed, c.allowExtra);
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(0);
    });
});

test('activeFormula: ว่าง/ไม่มี = null, มีค่า = trim แล้ว', () => {
    expect(activeFormula({})).toBeNull();
    expect(activeFormula({ result_formula: '  ' })).toBeNull();
    expect(activeFormula({ result_formula: ' AVG(ALL) ' })).toBe('AVG(ALL)');
});

test('fixture ของ frontend ต้องเหมือนกับ backend ทุกตัวอักษร (ผลคำนวณสองฝั่งตรงกัน)', () => {
    const fe = path.join(__dirname, '..', '..', 'frontend', 'src', 'app', 'shared', 'kpi-formula.cases.json');
    expect(fs.readFileSync(fe, 'utf8').replace(/\r\n/g, '\n')).toBe(fs.readFileSync(fixturePath, 'utf8').replace(/\r\n/g, '\n'));
});

test('usesBase: ตรวจว่าสูตรอ้างค่าฐาน (base) หรือไม่', () => {
    const { usesBase } = require('../kpi-formula');
    expect(usesBase('(base - SUM(ALL)) / base * 100')).toBe(true);
    expect(usesBase('-BASE + m10')).toBe(true);
    expect(usesBase('AVG(ALL)')).toBe(false);
    expect(usesBase('target - m10')).toBe(false);
    expect(usesBase('สูตรผิด(')).toBe(false);
});

test('isValidVarKey / formulaVarNames: ชื่อค่าเพิ่มเติมที่ตั้งเองได้ และตัวแปรที่สูตรใช้', () => {
    const { isValidVarKey, formulaVarNames } = require('../kpi-formula');
    for (const ok of ['pop', 'base', 'den_1', 'x']) expect(isValidVarKey(ok)).toBe(true);
    for (const bad of ['', 'Pop', '1pop', 'result', 'target', 'sum', 'all', 'prev_x', 'm10', 'm5', 'constructor', '__proto__', 'a'.repeat(21), 'ป๊อป']) expect(isValidVarKey(bad)).toBe(false);
    expect(formulaVarNames('(base - SUM(ALL)) / base * 100 + pop - target + prev_result').sort()).toEqual(['base', 'pop']);
});

describe('ตัวชี้วัดวัดผลรายไตรมาส (quarter_mode — 10 พ.ย. 2569)', () => {
    const { quarterValues, isQuarterEntryMonth, quarterResultFormula, normalizeQuarterMode } = require('../kpi-formula');
    const m = { oct: '1', nov: '2', dece: '3', jan: '10', feb: '', mar: '20', jun: 'กำลังดำเนินการ' };
    test('quarterValues ตามโหมด', () => {
        expect(quarterValues('month_sum', m)).toEqual(['6', '30', null, null]);
        expect(quarterValues('month_avg', m)).toEqual(['2', '15', null, null]);
        expect(quarterValues('month_last', m)).toEqual(['3', '20', null, null]);
        expect(quarterValues('quarter', { nov: '9', dece: '4', jun: '7' })).toEqual(['4', null, '7', null]);   // เฉพาะเดือนสุดท้ายของไตรมาส
        expect(quarterValues('', m)).toEqual([null, null, null, null]);
    });
    test('isQuarterEntryMonth: โหมดบันทึกรายไตรมาสกรอกได้เฉพาะ ธ.ค./มี.ค./มิ.ย./ก.ย.', () => {
        expect(['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].filter(k => isQuarterEntryMonth('quarter', k))).toEqual(['dece', 'mar', 'jun', 'sep']);
        expect([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(k => isQuarterEntryMonth('quarter', k))).toEqual([12, 3, 6, 9]);
        expect(isQuarterEntryMonth('quarter', 'm09')).toBe(true);
        expect(isQuarterEntryMonth('month_sum', 'nov')).toBe(true);
        expect(isQuarterEntryMonth(null, 'nov')).toBe(true);
    });
    test('quarterResultFormula / normalizeQuarterMode', () => {
        expect(quarterResultFormula('month_sum')).toBe('LASTQ(SUM)');
        expect(quarterResultFormula('month_avg')).toBe('LASTQ(AVG)');
        expect(quarterResultFormula('month_last')).toBeNull();
        expect(quarterResultFormula('quarter')).toBeNull();
        expect(normalizeQuarterMode(' Quarter ')).toBe('quarter');
        expect(normalizeQuarterMode('xyz')).toBe('');
    });
});
