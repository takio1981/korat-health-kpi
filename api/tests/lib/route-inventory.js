/**
 * รายการเส้นทาง API (method + path + ชื่อ middleware ตามลำดับ) อ่านจาก stack ของ Express — ใช้ตรวจว่าการแยก server.js
 * เป็นโมดูลไม่ทำให้เส้นทางหาย/สลับลำดับ/middleware เปลี่ยน (เช่น `/users/sync-mapping` ต้องมาก่อน `/users/:id`)
 * สร้าง fixture ใหม่ (เฉพาะเมื่อตั้งใจเพิ่ม/แก้ route): `node tests/lib/route-inventory.js --write`
 */
function layerEntries(stack, prefix) {
    const out = [];
    for (const layer of stack) {
        if (layer.route) {
            const r = layer.route;
            const methods = Object.keys(r.methods || {}).filter(m => r.methods[m]).map(m => m.toUpperCase()).sort();
            // ตัวสุดท้าย = handler ของเส้นทาง (ชื่อไม่มีความหมาย) — ตัวก่อนหน้า = middleware ตามลำดับ
            const mw = (r.stack || []).map((l, i, arr) => (i === arr.length - 1 ? 'handler' : (l.name || '<anonymous>')));
            out.push(`${methods.join(',')} ${prefix}${r.path} :: ${mw.join(' > ')}`);
        } else {
            out.push(`USE ${prefix}${layer.name || '<anonymous>'}`);
        }
    }
    return out;
}

function routeInventory(app, apiRouter) {
    const appStack = (app.router || app._router).stack;
    return { app: layerEntries(appStack, ''), api: layerEntries(apiRouter.stack, '/khupskpi/api') };
}

module.exports = { routeInventory };

if (require.main === module && process.argv.includes('--write')) {
    process.env.NODE_ENV = 'test';
    require('../setup');
    const { app, apiRouter } = require('../../server');
    const inv = routeInventory(app, apiRouter);
    const file = require('path').join(__dirname, '..', 'fixtures', 'route-inventory.json');
    require('fs').writeFileSync(file, JSON.stringify(inv, null, 1) + '\n');
    console.log(`เขียน ${file}: app ${inv.app.length} | api ${inv.api.length}`);
    process.exit(0);
}
