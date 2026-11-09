// ปีงบประมาณของตัวชี้วัด (kpi_indicators.khd_fiscal_year — comma-list เช่น "2569,2570") — 9 พ.ย. 2569
// เดิมได้มาจาก KHD (report_fiscal_year_config) เท่านั้น ตอนนี้ตั้งเองได้ด้วย (ตัวชี้วัดที่ "ไม่ระบุปีงบ") และเทียบกับ KHD ได้
// ฟังก์ชันล้วน ใช้ร่วม: routes/khd.js (เทียบ/ใช้ค่า KHD/ตั้งเอง), routes/indicators.js (POST/PUT), services/khd.js (เพิ่มจาก KHD)

const YEAR_RE = /^2[5-6]\d\d$/; // พ.ศ. 2500–2699

/** รับ array หรือข้อความคั่นด้วยจุลภาค → รายการปี (ไม่ซ้ำ เรียงน้อยไปมาก) — ค่าที่ไม่ใช่ปี พ.ศ. ถูกตัดทิ้ง */
function fiscalYearsOf(input) {
    const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
    return [...new Set(raw.map(v => String(v ?? '').trim()).filter(v => YEAR_RE.test(v)))].sort();
}

/** ค่าที่เก็บในฐานข้อมูล: "2569,2570" | null (ว่าง) */
function normalizeFiscalYears(input) {
    const list = fiscalYearsOf(input);
    return list.length ? list.join(',') : null;
}

/** มีค่าที่ไม่ใช่ปี พ.ศ. ปนมา (ใช้ตอบ 400 แทนการตัดทิ้งเงียบๆ เมื่อผู้ใช้ตั้งเอง) */
function invalidFiscalYears(input) {
    const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
    return raw.map(v => String(v ?? '').trim()).filter(v => v && !YEAR_RE.test(v));
}

/** เทียบปีงบของระบบกับ KHD — KHD ไม่มีปีงบ = null (ไม่นับว่าต่าง ไม่มีค่าให้ใช้) */
function compareFiscalYears(localValue, khdYears) {
    const khd = fiscalYearsOf(khdYears || []);
    const local = fiscalYearsOf(localValue);
    return {
        local_fiscal_years: local,
        khd_fiscal_years: khd,
        fiscal_year_match: khd.length ? local.join(',') === khd.join(',') : null,
    };
}

/** แถว report_fiscal_year_config (report_id, fiscal_year) → Map report_id → ['2569','2570'] */
function buildKhdFiscalYearMap(rows) {
    const map = new Map();
    for (const r of rows || []) {
        const y = String(r.fiscal_year ?? '').trim();
        if (!YEAR_RE.test(y)) continue;
        const list = map.get(r.report_id) || [];
        if (!list.includes(y)) list.push(y);
        map.set(r.report_id, list);
    }
    for (const [k, v] of map) map.set(k, v.sort());
    return map;
}

module.exports = { fiscalYearsOf, normalizeFiscalYears, invalidFiscalYears, compareFiscalYears, buildKhdFiscalYearMap };
