// โซน (9 พ.ย. 2569 — หน้าจัดการโซน): ชื่อโซน (ตาราง zones) + โซนของอำเภอ (ตาราง district_zones) ในฐานข้อมูล แทน DISTRICT_ZONES ที่ hardcode
// chospital.zone ยังเป็นค่าที่ตัวกรอง/รายงานทุกจุดใช้ (core/zones.js zoneFilter) — ย้ายอำเภอ = อัปเดต chospital ทุกแห่งในอำเภอ (routes/lookups.js)
const db = require('../db');
const { zoneOfDistrict } = require('../core/zones');

let _cache = null; // { at, zones: [{code,name,sort_order}], districtZone: Map<distid, code> }

async function loadZoneData({ fresh = false } = {}) {
    if (!fresh && _cache && _cache.at > Date.now() - 60000) return _cache;
    const [zones] = await db.query('SELECT code, name, sort_order FROM zones ORDER BY sort_order, CAST(code AS UNSIGNED)');
    const [dz] = await db.query('SELECT distid, zone_code FROM district_zones');
    _cache = { at: Date.now(), zones, districtZone: new Map(dz.map(r => [String(r.distid), String(r.zone_code)])) };
    return _cache;
}
const invalidateZoneCache = () => { _cache = null; };

/** โซนของอำเภอจากฐานข้อมูล — อ่านไม่ได้/ไม่มีแถว = ค่าตั้งต้นเดิม (DISTRICT_ZONES) */
async function zoneOfDistrictDb(distid) {
    try {
        const { districtZone } = await loadZoneData();
        const z = districtZone.get(String(distid || ''));
        if (z) return z;
    } catch (_) { /* ตารางยังไม่พร้อม */ }
    return zoneOfDistrict(distid);
}

/** Map distid → โซน (ใช้ทีละมากๆ เช่น services/forecast.js) */
async function districtZoneMap() {
    try { return (await loadZoneData()).districtZone; } catch (_) { return new Map(); }
}

async function zoneExists(code) {
    const { zones } = await loadZoneData();
    return zones.some(z => String(z.code) === String(code));
}

module.exports = { loadZoneData, invalidateZoneCache, zoneOfDistrictDb, districtZoneMap, zoneExists };
