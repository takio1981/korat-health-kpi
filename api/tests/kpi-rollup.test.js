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

describe('rollupTree (ตัวชี้วัดหลายระดับ — 19 ต.ค. 2569)', () => {
    const { rollupTree } = require('../kpi-rollup');
    test.each(cases.tree.map(c => [c.name, c]))('%s', (_n, c) => {
        const r = rollupTree(c.nodes, c.values);
        for (const [k, months] of Object.entries(c.expected)) {
            for (const [mk, v] of Object.entries(months)) expect([k, mk, r[k].months[mk]]).toEqual([k, mk, v]);
        }
        expect(Object.keys(r).filter(k => r[k].rolled).sort()).toEqual([...c.rolled].sort());
    });
});

describe('itemNumber', () => {
    const { itemNumber } = require('../kpi-rollup');
    test.each(cases.itemNumber.map(c => [c.name, c]))('%s', (_n, c) => {
        expect(itemNumber(c.explicit, c.parent, c.index)).toBe(c.expected);
    });
});
