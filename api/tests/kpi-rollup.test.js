/**
 * Unit tests: api/kpi-rollup.js (ผลงานระดับบนจากระดับล่าง — ตัวชี้วัด 3 ระดับ)
 * fixture ร่วมกับ frontend (kpi-rollup.cases.json) เพื่อการันตีว่าผล frontend/backend ตรงกัน
 */
const fs = require('fs');
const path = require('path');
const { activityValue, rollupMonthly } = require('../kpi-rollup');

const fixturePath = path.join(__dirname, 'fixtures', 'rollup-cases.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('activityValue', () => {
    test.each(cases.activity.map(c => [c.name, c]))('%s', (_n, c) => {
        expect(activityValue(c.type, c.raw)).toBe(c.expected);
    });
});

describe('rollupMonthly', () => {
    test.each(cases.rollup.map(c => [c.name, c]))('%s', (_n, c) => {
        expect(rollupMonthly(c.count, c.months)).toEqual(c.expected);
    });
});

test('fixture ของ frontend ต้องเหมือนกับ backend ทุกตัวอักษร (ผลคำนวณสองฝั่งตรงกัน)', () => {
    const fe = path.join(__dirname, '..', '..', 'frontend', 'src', 'app', 'shared', 'kpi-rollup.cases.json');
    expect(fs.readFileSync(fe, 'utf8').replace(/\r\n/g, '\n')).toBe(fs.readFileSync(fixturePath, 'utf8').replace(/\r\n/g, '\n'));
});
