/**
 * ประเภทตัวชี้วัด (20 พ.ย. 2569 — ผู้ใช้สั่ง: หน้ารายงานสถิติแยกตาม R9 เขต 9 / MOPH กระทรวง / SSJ สสจ. / RMW ผู้ว่าฯ / อื่น ๆ ให้ครบทุกประเภท)
 * ธงในตาราง kpi_indicators: r9, moph, ssj, rmw, other (TINYINT) — ตัวชี้วัดหนึ่งตัวอยู่ได้หลายประเภท, ไม่มีธงใดเลย = "ไม่ระบุประเภท" (none)
 * พารามิเตอร์ itype = คีย์คั่นด้วยจุลภาค (เลือกหลายประเภท = อยู่ในประเภทใดก็ได้) — คีย์ที่ไม่รู้จักทั้งหมด = ไม่มีข้อมูล (1 = 0)
 */
const ITYPE_KEYS = ['r9', 'moph', 'ssj', 'rmw', 'other'];
const ITYPE_ALL = [...ITYPE_KEYS, 'none'];
const ITYPE_LABELS = { r9: 'R9 เขต 9', moph: 'MOPH กระทรวง', ssj: 'SSJ สสจ.', rmw: 'RMW ผู้ว่าฯ', other: 'อื่น ๆ', none: 'ไม่ระบุประเภท' };

/** เงื่อนไข SQL ของประเภท (ชื่อคอลัมน์มาจากรายการคงที่เท่านั้น — ไม่มีค่าจากผู้ใช้ใน SQL) */
function itypeCond(key, alias = 'i') {
    if (key === 'none') return '(' + ITYPE_KEYS.map(k => `COALESCE(${alias}.\`${k}\`, 0) <> 1`).join(' AND ') + ')';
    if (!ITYPE_KEYS.includes(key)) throw new Error('unknown itype ' + key);
    return `COALESCE(${alias}.\`${key}\`, 0) = 1`;
}

/** คีย์ที่ถูกต้องจากพารามิเตอร์ (ไม่ซ้ำ, เรียงตามลำดับมาตรฐาน) — ไม่ส่ง = null */
function parseItypes(value) {
    if (value === undefined || value === null || value === '') return null;
    const want = new Set(String(value).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    return ITYPE_ALL.filter(k => want.has(k));
}

/** เพิ่มเงื่อนไขกรองประเภทตัวชี้วัดของคอลัมน์ indicator id (ใช้ subquery — ไม่ขึ้นกับ alias ของคิวรีเดิม) */
function addItypeFilter(clauses, col, value) {
    const keys = parseItypes(value);
    if (keys === null) return;
    if (!keys.length) { clauses.push('1 = 0'); return; }
    clauses.push(`${col} IN (SELECT ki.id FROM kpi_indicators ki WHERE ${keys.map(k => itypeCond(k, 'ki')).join(' OR ')})`);
}

/** ประเภทของตัวชี้วัดจากแถวที่มีธง r9..other → ['r9', 'moph'] หรือ ['none'] */
function itypesOf(row) {
    const ks = ITYPE_KEYS.filter(k => Number(row?.[k]) === 1);
    return ks.length ? ks : ['none'];
}

/** ข้อความตัวกรองสำหรับคำอธิบาย (AI/หัวรายงาน) */
function itypeLabel(value) {
    const keys = parseItypes(value);
    return keys && keys.length ? keys.map(k => ITYPE_LABELS[k]).join(', ') : null;
}

module.exports = { ITYPE_KEYS, ITYPE_ALL, ITYPE_LABELS, itypeCond, parseItypes, addItypeFilter, itypesOf, itypeLabel };
