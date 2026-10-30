// โซนของหน่วยบริการ (chospital.zone '1'–'6') — ผู้ใช้กำหนดตามอำเภอ 30 ต.ค. 2569 (ทุกหน่วยบริการในอำเภอเดียวกันอยู่โซนเดียวกัน)
// DISTRICT_ZONES ใช้ backfill ตอน migration (เฉพาะแถวที่ zone ยังว่าง) และเป็นค่าตั้งต้นเมื่อเพิ่มหน่วยบริการใหม่
const DISTRICT_ZONES = {
    1: ['3001', '3019', '3032', '3006', '3016'],          // เมืองนครราชสีมา ขามทะเลสอ เฉลิมพระเกียรติ จักราช ห้วยแถลง
    2: ['3002', '3007', '3014', '3025', '3003', '3022'],  // ครบุรี โชคชัย ปักธงชัย วังน้ำเขียว เสิงสาง หนองบุญมาก
    3: ['3017', '3015', '3024', '3029', '3027'],          // ชุมพวง พิมาย โนนแดง ลำทะเมนชัย เมืองยาง
    4: ['3023', '3030', '3012', '3031', '3013', '3005'],  // แก้งสนามนาง บัวลาย บัวใหญ่ สีดา ประทาย บ้านเหลื่อม
    5: ['3009', '3010', '3028', '3011', '3004'],          // โนนไทย โนนสูง พระทองคำ ขามสะแกแสง คง
    6: ['3008', '3026', '3021', '3020', '3018'],          // ด่านขุนทด เทพารักษ์ ปากช่อง สีคิ้ว สูงเนิน
};

function zoneOfDistrict(distid) {
    const d = String(distid || '');
    for (const [z, list] of Object.entries(DISTRICT_ZONES)) if (list.includes(d)) return z;
    return null;
}

// ค่าพารามิเตอร์ zone จาก query ("1" หรือ "1,3") → null = ไม่ได้กรอง | [] = ส่งมาแต่ไม่มีค่าที่ถูกต้อง (ผู้เรียกให้ผลว่าง) | ['1','3']
function parseZones(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    return [...new Set(String(value).split(',').map(v => v.trim()).filter(v => /^[1-9]$/.test(v)))];
}

// เงื่อนไข SQL + พารามิเตอร์ของตัวกรองโซน — col = คอลัมน์อำเภอ (kind 'dist') หรือรหัสหน่วยบริการ (kind 'hos')
// ใช้ subquery กับ chospital (ไม่ JOIN ตรง — kpi_summary/kpi_results คนละ collation กับ chospital)
function zoneFilter(col, zones, kind = 'dist') {
    if (zones === null) return null;
    if (zones.length === 0) return { sql: '1 = 0', params: [] };
    const sub = kind === 'hos'
        ? 'SELECT zh.hoscode FROM chospital zh WHERE zh.zone IN (?)'
        : 'SELECT zh.distid FROM chospital zh WHERE zh.zone IN (?)';
    return { sql: `${col} IN (${sub})`, params: [zones] };
}

// เพิ่มตัวกรองโซนลงรายการเงื่อนไข (where clauses + params) เมื่อมีพารามิเตอร์ zone — ใช้ร่วมทุก endpoint รายงาน/ข้อมูล
function addZoneFilter(clauses, params, col, value, kind = 'dist') {
    const zf = zoneFilter(col, parseZones(value), kind);
    if (zf) { clauses.push(zf.sql); params.push(...zf.params); }
}

module.exports = { DISTRICT_ZONES, zoneOfDistrict, parseZones, zoneFilter, addZoneFilter };
