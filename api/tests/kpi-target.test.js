/**
 * Unit tests: api/kpi-target.js (เงื่อนไขเป้าหมาย > ≥ < ≤ = — ร้อยละ/ผ่านเกณฑ์)
 * fixture ร่วมกับ frontend (kpi-target.cases.json) เพื่อการันตีว่าผล frontend/backend ตรงกัน
 */
const fs = require('fs');
const path = require('path');
const { normalizeCondition, hasTarget, evaluateTarget } = require('../kpi-target');

const fixturePath = path.join(__dirname, 'fixtures', 'target-cases.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('normalizeCondition', () => {
    test.each(cases.normalize.map(c => [c.name, c]))('%s', (_n, c) => {
        expect(normalizeCondition(c.in)).toBe(c.expected);
    });
});

describe('evaluateTarget', () => {
    test.each(cases.evaluate.map(c => [c.name, c]))('%s', (_n, c) => {
        const r = evaluateTarget(c.actual, c.target, c.cond);
        expect(r.pass).toBe(c.pass);
        if (c.pct === null) expect(r.pct).toBeNull();
        else expect(r.pct).toBeCloseTo(c.pct, 6);
    });
});

describe('hasTarget', () => {
    test.each(cases.has.map(c => [c.name, c]))('%s', (_n, c) => {
        expect(hasTarget(c.target, c.cond)).toBe(c.expected);
    });
});

test('fixture ของ frontend ต้องเหมือนกับ backend ทุกตัวอักษร (ผลคำนวณสองฝั่งตรงกัน)', () => {
    const fe = path.join(__dirname, '..', '..', 'frontend', 'src', 'app', 'shared', 'kpi-target.cases.json');
    expect(fs.readFileSync(fe, 'utf8').replace(/\r\n/g, '\n')).toBe(fs.readFileSync(fixturePath, 'utf8').replace(/\r\n/g, '\n'));
});
