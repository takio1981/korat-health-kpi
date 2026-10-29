// ชิ้นส่วน SQL ที่ใช้ร่วมกัน: ตัวชี้วัดที่เปิดใช้งาน, เงื่อนไขเป้าหมาย (ต้องตรงกับ kpi-target.js)
// ย้ายจาก server.js (ระยะ 1 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

// === แสดงเฉพาะตัวชี้วัดที่เปิดใช้งาน (is_active = 1) ===
// ทุก endpoint ที่แสดงตัวชี้วัด/ผลงานให้ผู้ใช้ทั่วไป (dashboard, กราฟ, รายงาน, สถิติ, export) ต้องต่อเงื่อนไขนี้
// ยกเว้น: หน้าจัดการตัวชี้วัด (GET /indicators?include_inactive=1), เครื่องมือจัดการข้อมูล (kpi-results/manage,
// db-compare, report-compare, export-debug) และประวัติ (kpi-replies, audit logs, digest)
// กรองตอน "อ่าน" (ไม่ใช่ตอนสร้าง kpi_summary) → เปิด/ปิดตัวชี้วัดแล้วมีผลทันทีโดยไม่ต้อง refresh summary
const activeIndicatorSql = (col) => `${col} IN (SELECT id FROM kpi_indicators WHERE is_active = 1)`;

// เงื่อนไขเป้าหมาย (target_condition: GTE/GT/LTE/LT/EQ) ฝั่ง SQL — ต้องให้ผลตรงกับ kpi-target.js (hasTarget/evaluateTarget) — 22 ต.ค. 2569
// เดิมทุกจุดนับ "ผ่าน" ด้วย last_actual >= target_value อย่างเดียว ตัวชี้วัด "ยิ่งน้อยยิ่งดี" (≤ / <) จึงนับผิดทั้งระบบ
// condExpr: i.target_condition เมื่อ JOIN kpi_indicators อยู่แล้ว ไม่งั้นใช้ targetCondOf('s') (subquery ตาม indicator_id)
// ⚠️ ห้ามใส่ "?" ในข้อความ SQL (mysql2 ตีความเป็น placeholder) — ใช้ {0,1}
const targetCondOf = (alias) => `(SELECT ti.target_condition FROM kpi_indicators ti WHERE ti.id = ${alias}.indicator_id)`;
const _tDec = (col) => `CAST(NULLIF(TRIM(${col}),'') AS DECIMAL(20,4))`;
const _tCond = (condExpr) => `UPPER(TRIM(COALESCE(${condExpr},'')))`;
// มีเป้าหมาย: GTE/GT (และไม่ได้ตั้ง) = เป้าหมาย > 0 (วิธีเดิม) | LTE/LT/EQ = เป้าหมายเป็นตัวเลข ≥ 0
// pctCol (ไม่บังคับ — kpi_summary.manual_pct, 29 ต.ค. 2569): ไม่ใช่ NULL = ตัวชี้วัดที่กรอกร้อยละเอง → "มีเป้าหมาย" = กรอกร้อยละแล้ว,
// "ผ่าน" = ร้อยละที่กรอก ≥ 100 (ไม่คำนวณจากผลงาน/เป้าหมาย — ผู้ใช้เลือก) | NULL = คำนวณตามเงื่อนไขเป้าหมายเหมือนเดิม
const _pctHas = (pctCol) => `TRIM(${pctCol}) REGEXP '^[0-9]+([.][0-9]+){0,1}$'`;
function targetHasSql(tCol, condExpr, pctCol) {
    const base = `(CASE WHEN ${_tCond(condExpr)} IN ('LTE','LT','EQ') THEN (TRIM(${tCol}) REGEXP '^[0-9]' AND ${_tDec(tCol)} >= 0) ELSE ${_tDec(tCol)} > 0 END)`;
    return pctCol ? `(CASE WHEN ${pctCol} IS NULL THEN ${base} ELSE ${_pctHas(pctCol)} END)` : base;
}
// ผ่านเกณฑ์: มีเป้าหมาย + ผลงานเป็นตัวเลข + เทียบตามเงื่อนไข
function targetPassSql(aCol, tCol, condExpr, pctCol) {
    const a = _tDec(aCol), t = _tDec(tCol);
    const base = `(${targetHasSql(tCol, condExpr)} AND TRIM(${aCol}) REGEXP '^-{0,1}[0-9]' AND (CASE ${_tCond(condExpr)}` +
        ` WHEN 'GT' THEN ${a} > ${t} WHEN 'LTE' THEN ${a} <= ${t} WHEN 'LT' THEN ${a} < ${t} WHEN 'EQ' THEN ${a} = ${t} ELSE ${a} >= ${t} END))`;
    return pctCol ? `(CASE WHEN ${pctCol} IS NULL THEN ${base} ELSE (${_pctHas(pctCol)} AND ${_tDec(pctCol)} >= 100) END)` : base;
}

// ตรวจสอบชื่อตาราง/คอลัมน์ (ป้องกัน SQL Injection) — ย้ายจาก server.js (ส่วน Form Builder) 25 ต.ค. 2569
const isValidIdentifier = (name) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name);

module.exports = { activeIndicatorSql, targetCondOf, targetHasSql, targetPassSql, isValidIdentifier };
