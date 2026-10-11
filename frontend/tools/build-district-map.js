/**
 * สร้างรูปร่างแผนที่ 32 อำเภอของ จ.นครราชสีมา สำหรับหน้ากราฟ (app-district-map)
 *   → frontend/src/app/shared/korat-district-shapes.ts  (ไฟล์ผลลัพธ์ commit ไว้แล้ว — รันสคริปต์นี้เฉพาะเมื่อขอบเขตอำเภอเปลี่ยน)
 *
 * แหล่งข้อมูล (ดาวน์โหลดเองก่อนรัน — ไม่เก็บไฟล์ต้นทางใน repo เพราะมีขนาดใหญ่):
 *   1) ขอบเขตอำเภอ (ADM2, simplified GeoJSON) — geoBoundaries gbOpen THA ADM2
 *      https://www.geoboundaries.org/api/current/gbOpen/THA/ADM2/   (ช่อง simplifiedGeometryGeoJSON)
 *      ที่มา: Royal Thai Survey Department, OCHA ROAP — สัญญาอนุญาต CC BY 3.0 IGO
 *   2) ทะเบียนชื่อ/รหัสอำเภอ (tha_admin_boundaries.xlsx แผ่น tha_admin2) — HDX "Thailand - Subnational Administrative Boundaries"
 *      https://data.humdata.org/dataset/cod-ab-tha   ที่มา: Royal Thai Survey Department — สัญญาอนุญาต CC BY-IGO
 *
 * วิธีรัน:  node tools/build-district-map.js <adm2_simplified.geojson> <tha_admin_boundaries.xlsx>
 *
 * การจับคู่: อำเภอใน gazetteer (adm1_pcode = TH30) ↔ รูปร่างที่ "ชื่ออังกฤษตรงกัน และครอบจุดกึ่งกลางของอำเภอ" ต้องได้ 1 ต่อ 1 ครบ 32 อำเภอ
 * (ชื่ออำเภอซ้ำข้ามจังหวัดได้ เช่น เฉลิมพระเกียรติ — จึงต้องใช้จุดกึ่งกลางยืนยัน) รหัสอำเภอ = P-code ตัด "TH" (TH3001 → 3001) ตรงกับ co_district.distid
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const [geoPath, gazPath] = process.argv.slice(2);
if (!geoPath || !gazPath) { console.error('usage: node tools/build-district-map.js <adm2.geojson> <tha_admin_boundaries.xlsx>'); process.exit(1); }
const PROVINCE_PCODE = 'TH30';
const WIDTH = 1000;   // ความกว้าง viewBox

const adm2 = JSON.parse(fs.readFileSync(geoPath, 'utf8'));
const gaz = XLSX.utils.sheet_to_json(XLSX.readFile(gazPath).Sheets['tha_admin2'], { defval: '' }).filter(r => String(r.adm1_pcode) === PROVINCE_PCODE);

const polys = (g) => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
function inRing(p, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (((r[i][1] > p[1]) !== (r[j][1] > p[1])) && (p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0])) c = !c;
  }
  return c;
}
const inGeom = (p, g) => polys(g).some(poly => inRing(p, poly[0]) && !poly.slice(1).some(h => inRing(p, h)));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');

const districts = [];
for (const r of gaz) {
  const center = [Number(r.center_lon), Number(r.center_lat)];
  const hit = adm2.features.filter(f => norm(f.properties.shapeName) === norm(r.adm2_name) && inGeom(center, f.geometry));
  if (hit.length !== 1) throw new Error(`จับคู่ไม่ได้: ${r.adm2_pcode} ${r.adm2_name} (พบ ${hit.length} รูปร่าง)`);
  districts.push({ distid: String(r.adm2_pcode).replace(/^TH/, ''), name: String(r.adm2_name1), center, geometry: hit[0].geometry });
}
if (districts.length !== 32 || new Set(districts.map(d => d.distid)).size !== 32) throw new Error('ต้องได้ 32 อำเภอไม่ซ้ำ — ได้ ' + districts.length);
districts.sort((a, b) => a.distid.localeCompare(b.distid));

// ฉายพิกัดแบบ equirectangular (ปรับสัดส่วนด้วย cos ของละติจูดกลาง) → พิกัด viewBox
let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
for (const d of districts) for (const poly of polys(d.geometry)) for (const ring of poly) for (const [lon, lat] of ring) {
  minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
}
const k = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
const PAD = 8;
const scale = (WIDTH - 2 * PAD) / ((maxLon - minLon) * k);
const HEIGHT = Math.ceil((maxLat - minLat) * scale + 2 * PAD);
const px = ([lon, lat]) => [PAD + (lon - minLon) * k * scale, PAD + (maxLat - lat) * scale];
const r1 = (n) => Math.round(n * 10) / 10;
const num = (n) => String(r1(n));

function ringPath(ring) {
  // จุดแรกแบบสัมบูรณ์ ที่เหลือเป็นระยะสัมพัทธ์ (สั้นกว่า) — คำนวณจากตำแหน่งที่ปัดแล้วเพื่อไม่ให้ความคลาดเคลื่อนสะสม
  let out = '', cx = 0, cy = 0, first = true;
  for (const pt of ring.slice(0, -1)) {   // GeoJSON ปิดวงด้วยจุดซ้ำ — ใช้ Z แทน
    const [x, y] = px(pt).map(r1);
    if (first) { out += `M${num(x)},${num(y)}`; first = false; }
    else {
      const dx = r1(x - cx), dy = r1(y - cy);
      if (dx === 0 && dy === 0) continue;
      out += `l${num(dx)},${num(dy)}`;
    }
    cx = x; cy = y;
  }
  return out + 'Z';
}

const shapes = districts.map(d => {
  const [cx, cy] = px(d.center);
  return { distid: d.distid, name: d.name, cx: r1(cx), cy: r1(cy), d: polys(d.geometry).map(poly => poly.map(ringPath).join('')).join('') };
});

const out = `// สร้างอัตโนมัติด้วย frontend/tools/build-district-map.js — ห้ามแก้ด้วยมือ
// ขอบเขตอำเภอ จ.นครราชสีมา 32 อำเภอ (พิกัดฉายลง viewBox แล้ว) — distid ตรงกับ co_district.distid
// ที่มาข้อมูล: Royal Thai Survey Department, OCHA ROAP ผ่าน geoBoundaries (gbOpen THA ADM2) — CC BY 3.0 IGO
// ชื่อ/รหัส/จุดกึ่งกลางอำเภอ: HDX "Thailand - Subnational Administrative Boundaries" — CC BY-IGO
export interface DistrictShape { distid: string; name: string; cx: number; cy: number; d: string; }
export const DISTRICT_MAP_WIDTH = ${WIDTH};
export const DISTRICT_MAP_HEIGHT = ${HEIGHT};
export const DISTRICT_MAP_ATTRIBUTION = 'ขอบเขตอำเภอ: กรมแผนที่ทหาร / OCHA ROAP ผ่าน geoBoundaries (CC BY 3.0 IGO)';
export const DISTRICT_SHAPES: DistrictShape[] = [
${shapes.map(s => `  { distid: '${s.distid}', name: '${s.name}', cx: ${s.cx}, cy: ${s.cy}, d: '${s.d}' },`).join('\n')}
];
`;
const target = path.join(__dirname, '..', 'src', 'app', 'shared', 'korat-district-shapes.ts');
fs.writeFileSync(target, out);
console.log(`เขียน ${target} — ${shapes.length} อำเภอ, viewBox ${WIDTH}×${HEIGHT}, ${(out.length / 1024).toFixed(1)} KB`);
