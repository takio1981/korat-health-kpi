/**
 * Route inventory — ตาข่ายกันพังของการแยก server.js เป็นโมดูล (25 ต.ค. 2569)
 * เส้นทาง API ทุกตัว (method + path + middleware ตามลำดับ) และลำดับการประกาศ ต้องเท่ากับ fixture
 * ลำดับสำคัญจริง: Express จับเส้นทางตามลำดับประกาศ (เช่น `/users/sync-mapping` ต้องอยู่ก่อน `/users/:id`)
 * เปลี่ยน route โดยตั้งใจ → สร้าง fixture ใหม่: `node tests/lib/route-inventory.js --write` แล้วตรวจ diff ก่อน commit
 */
const path = require('path');
const { routeInventory } = require('./lib/route-inventory');
const expected = require(path.join(__dirname, 'fixtures', 'route-inventory.json'));

const { app, apiRouter } = require('../server');

test('เส้นทางของ app (middleware ระดับบนสุด + callback SSO) เท่าเดิมทุกลำดับ', () => {
    expect(routeInventory(app, apiRouter).app).toEqual(expected.app);
});

test('เส้นทาง API ทั้งหมด เท่าเดิมทุกตัวทุกลำดับ', () => {
    const actual = routeInventory(app, apiRouter).api;
    expect(actual.length).toBe(expected.api.length);
    expect(actual).toEqual(expected.api);
});

test('ไม่มี method+path ซ้ำ (ตัวหลังจะไม่ถูกเรียกเลย)', () => {
    const keys = routeInventory(app, apiRouter).api.filter(e => !e.startsWith('USE ')).map(e => e.split(' :: ')[0]);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dup).toEqual([]);
});
