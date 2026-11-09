// เทียบ/ปรับ "ประเภทตัวชี้วัด" และ "ประเภทหน่วยบริการ" กับ KHD (9 พ.ย. 2569) — ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
// ประเภทตัวชี้วัด = r9 / moph / ssj / rmw / other (KHD reports + override รายปีงบใน report_fiscal_year_config: r9, moph, ssj, rmw)
// ประเภทหน่วยบริการ = evaluation_mode ('all_required' ทุกประเภท | 'any_one' เฉพาะประเภทใน required_off_types) — ความหมายเดียวกับ indicatorTypeSetting()
const { normalizeOffTypes, normalizeEvalMode } = require('./indicator-fields');

const TYPE_KEYS = ['r9', 'moph', 'ssj', 'rmw', 'other'];
const TYPE_LABEL = { r9: 'R9', moph: 'MOPH', ssj: 'SSJ', rmw: 'RMW', other: 'อื่นๆ' };
const FY_TYPE_KEYS = ['r9', 'moph', 'ssj', 'rmw']; // คอลัมน์ที่ report_fiscal_year_config override ได้

const flag = (v) => (v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '0') ? 0 : 1;

/** ประเภทตัวชี้วัดของ KHD ที่ใช้จริงในปีงบ: ค่าปีงบ (ไม่ใช่ null) ก่อน แล้วจึงค่าทั่วไปใน reports */
function khdIndicatorTypes(khd, fy) {
    const out = {};
    for (const k of TYPE_KEYS) {
        const v = (fy && FY_TYPE_KEYS.includes(k) && fy[k] !== null && fy[k] !== undefined) ? fy[k] : khd?.[k];
        out[k] = flag(v);
    }
    return out;
}
const localIndicatorTypes = (local) => Object.fromEntries(TYPE_KEYS.map(k => [k, flag(local?.[k])]));
const typesEqual = (a, b) => TYPE_KEYS.every(k => a[k] === b[k]);
const typesText = (t) => TYPE_KEYS.filter(k => t[k]).map(k => TYPE_LABEL[k]).join(', ') || 'ไม่ระบุ';

/** ประเภทหน่วยบริการแบบเทียบได้ — { mode, types (เรียงแล้ว), key } — key: 'all' | 'any:05,06' | 'unset' */
function hostypeSetting(evalMode, offTypes) {
    const mode = normalizeEvalMode(evalMode);
    const json = normalizeOffTypes(offTypes);
    const types = json ? [...new Set(JSON.parse(json).map(x => String(x).trim()).filter(Boolean))].sort() : [];
    if (mode === 'all_required') return { mode, types, key: 'all' };
    if (mode === 'any_one' && types.length) return { mode, types, key: 'any:' + types.join(',') };
    return { mode, types, key: 'unset' };
}

/** ผลเทียบของตัวชี้วัด 1 ตัว (local = แถว kpi_indicators, khd = แถว reports, fy = แถว report_fiscal_year_config ของปีงบ หรือ null) */
function compareKhdTypes(khd, fy, local) {
    const khdTypes = khdIndicatorTypes(khd, fy);
    const locTypes = localIndicatorTypes(local);
    const khdHos = hostypeSetting(khd?.evaluation_mode, khd?.required_off_types);
    const locHos = hostypeSetting(local?.evaluation_mode, local?.required_off_types);
    return {
        khd_types: khdTypes, local_types: locTypes, types_match: typesEqual(khdTypes, locTypes),
        khd_types_source: fy && FY_TYPE_KEYS.some(k => fy[k] !== null && fy[k] !== undefined) ? 'fiscal_year_config' : 'reports',
        khd_eval_mode: khdHos.mode, khd_off_types: khdHos.types,
        local_eval_mode: locHos.mode, local_off_types: locHos.types,
        // KHD ยังไม่ได้ตั้ง (unset) = ไม่นับว่าต่างกัน (ไม่มีค่าให้นำมาใช้)
        hostype_match: khdHos.key === 'unset' ? null : khdHos.key === locHos.key,
    };
}

/** ค่าที่จะบันทึกลง kpi_indicators ตามส่วนที่เลือก ('types' | 'hostype') — null = ไม่มีค่าให้ปรับ */
function khdTypeUpdate(khd, fy, part) {
    if (part === 'types') return khdIndicatorTypes(khd, fy);
    if (part === 'hostype') {
        const h = hostypeSetting(khd?.evaluation_mode, khd?.required_off_types);
        if (h.key === 'unset') return null;
        return { evaluation_mode: h.mode, required_off_types: h.types.length ? JSON.stringify(h.types) : null };
    }
    return null;
}

module.exports = { TYPE_KEYS, TYPE_LABEL, FY_TYPE_KEYS, khdIndicatorTypes, localIndicatorTypes, hostypeSetting, compareKhdTypes, khdTypeUpdate, typesText };
