/**
 * Unit tests: สูตรคำนวณผลงาน (api/kpi-formula.js) — ไม่ใช้ database
 * fixture ร่วมกับ frontend (kpi-formula.cases.json) เพื่อการันตีว่าผล frontend/backend ตรงกัน
 */
const fs = require('fs');
const path = require('path');
const { evaluateFormula, validateFormula, activeFormula } = require('../kpi-formula');

const fixturePath = path.join(__dirname, 'fixtures', 'formula-cases.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('evaluateFormula — สูตรที่ถูกต้อง', () => {
    test.each(cases.valid.map(c => [c.name, c]))('%s', (_n, c) => {
        expect(validateFormula(c.formula)).toBeNull();
        expect(evaluateFormula(c.formula, c.months, c.target)).toBe(c.expect);
    });
});

describe('validateFormula — สูตรที่ผิดต้องถูกปฏิเสธพร้อมข้อความ', () => {
    test.each(cases.invalid.map(c => [c.name, c]))('%s', (_n, c) => {
        const msg = validateFormula(c.formula);
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
