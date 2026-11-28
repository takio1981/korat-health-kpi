/**
 * ความพร้อมของตัวชี้วัด (ระยะ 5 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 * บอกผู้ดูแลว่าตัวชี้วัดใด "ยังไม่พร้อม" ใช้งาน/ส่ง KHD และต้องแก้ช่องไหน — ตรวจแบบกฎ อ่านอย่างเดียว ไม่แก้ข้อมูลเอง
 *   block = ใช้งานไม่ได้จริง (ไม่มีชื่อ, ยังไม่ตั้งประเภทหน่วยบริการ = เพิ่มให้หน่วยบริการไม่ได้, ชื่อตารางส่งออกผิด/ไม่มี, สูตรคำนวณไม่ได้)
 *   warn  = ควรตรวจ (ไม่มีเป้าหมาย/เกณฑ์/กลุ่มงาน/หมวดหมู่หลัก, ยังไม่ได้เพิ่มให้หน่วยบริการในปีงบนี้, ปีงบของตัวชี้วัดไม่รวมปีนี้)
 *   info  = ข้อมูลประกอบ (ปิดส่งออก KHD, ยังไม่เชื่อมรายงาน KHD)
 *   สถานะรายงานใน KHD (warn: รายงานปิดใช้งานในปีงบนี้ / ไม่พบรายงานที่เชื่อมไว้) อ่านจากสำเนา khd_reports_snapshot (services/khd-snapshot.js)
 *   — ไม่อ่าน KHD ทุกคำขอ; ยังไม่มีสำเนา = ไม่ตรวจข้อนี้
 * ผู้ใช้เลือก (แผน): ตัวชี้วัดที่ยังไม่ตั้งประเภทหน่วยบริการ "คงการส่งออกเดิม + ขึ้นเตือน" — ไม่บล็อกการส่งออก
 */
const db = require('../db');
const { indicatorTypeSetting } = require('./indicator-scope');
const { formulaOk } = require('./formula-vars');
const { fiscalYearsOf } = require('./fiscal-years');
const { loadSnapshotMap, effectiveKhdActive, getSnapshotStatus } = require('./khd-snapshot');

const LEVEL_ORDER = { block: 3, warn: 2, info: 1, ok: 0 };
// field = id ของช่องในหน้าต่างแก้ไขตัวชี้วัด (kpi-manage) ที่ต้องแก้ — หน้าจอเลื่อนไปช่องนั้น
const RULES = {
    no_name: { level: 'block', text: 'ไม่มีชื่อตัวชี้วัด', field: 'indicator-name' },
    hostype_unset: { level: 'block', text: 'ยังไม่ตั้งประเภทหน่วยบริการ (เพิ่มให้หน่วยบริการไม่ได้)', field: 'indicator-eval-mode' },
    no_table: { level: 'block', text: 'ไม่มีชื่อตารางส่งออก (table_process)', field: 'indicator-table-process' },
    bad_table: { level: 'block', text: 'ชื่อตารางส่งออกไม่ถูกต้อง (ส่งออกไม่ได้)', field: 'indicator-table-process' },
    bad_formula: { level: 'block', text: 'สูตรคำนวณผลงานคำนวณไม่ได้', field: 'indicator-formula' },
    no_target: { level: 'warn', text: 'ยังไม่ตั้งเป้าหมาย (ค่าเริ่มต้น)', field: 'indicator-target' },
    no_criterion: { level: 'warn', text: 'ยังไม่ตั้งเกณฑ์', field: 'indicator-criterion' },
    no_dept: { level: 'warn', text: 'ยังไม่ระบุกลุ่มงาน', field: 'indicator-dept' },
    no_main: { level: 'warn', text: 'ยังไม่ระบุหมวดหมู่หลัก', field: 'indicator-main' },
    not_assigned: { level: 'warn', text: 'ยังไม่ได้เพิ่มให้หน่วยบริการในปีงบนี้', field: null },
    year_mismatch: { level: 'warn', text: 'ปีงบของตัวชี้วัดไม่รวมปีงบนี้', field: 'indicator-fiscal-year' },
    khd_inactive: { level: 'warn', text: 'รายงานใน KHD ปิดใช้งานในปีงบนี้ (ส่งไปแล้ว KHD อาจไม่แสดง)', field: null },
    khd_report_missing: { level: 'warn', text: 'ไม่พบรายงานที่เชื่อมไว้ใน KHD (อาจถูกลบ/เปลี่ยนรหัส)', field: null },
    khd_off: { level: 'info', text: 'ปิดส่งออก KHD', field: null },
    no_khd_link: { level: 'info', text: 'ยังไม่เชื่อมรายงาน KHD', field: null },
};
const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/** ตรวจ 1 ตัวชี้วัด (ฟังก์ชันล้วน) — ctx = { year_bh, assigned: จำนวนหน่วยบริการที่มีแถวในปีงบนี้, khd: Map สำเนารายงาน KHD | null } → { level, issues } */
function evaluateReadiness(ind, ctx = {}) {
    const codes = [];
    if (blank(ind.kpi_indicators_name)) codes.push('no_name');
    if (indicatorTypeSetting(ind) === 'unset') codes.push('hostype_unset');
    if (blank(ind.table_process)) codes.push('no_table');
    else if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(String(ind.table_process).trim().replace(/-/g, '_'))) codes.push('bad_table');
    const f = typeof ind.result_formula === 'string' ? ind.result_formula.trim() : '';
    if (f && !formulaOk(ind, f)) codes.push('bad_formula');
    if (blank(ind.target_percentage) && !ind.target_monthly) codes.push('no_target');
    if (blank(ind.criterion)) codes.push('no_criterion');
    if (blank(ind.dept_id)) codes.push('no_dept');
    if (blank(ind.main_indicator_id)) codes.push('no_main');
    if (ctx.year_bh && Number(ctx.assigned || 0) === 0) codes.push('not_assigned');
    const years = fiscalYearsOf(ind.khd_fiscal_year);
    if (ctx.year_bh && years.length && !years.includes(String(ctx.year_bh))) codes.push('year_mismatch');
    if (Number(ind.upload_excel) === 1) codes.push('khd_off');
    else if (blank(ind.khd_report_id)) codes.push('no_khd_link');
    else if (ctx.khd) {
        const snap = ctx.khd.get(Number(ind.khd_report_id));
        if (!snap) codes.push('khd_report_missing');
        else if (effectiveKhdActive(snap, ctx.year_bh) === 0) codes.push('khd_inactive');
    }
    const issues = codes.map(code => ({ code, ...RULES[code] }));
    const level = issues.reduce((lv, i) => (LEVEL_ORDER[i.level] > LEVEL_ORDER[lv] ? i.level : lv), 'ok');
    return { level, issues };
}

/** ความพร้อมของตัวชี้วัดที่เปิดใช้งาน (ตามกลุ่มงานถ้าระบุ) ในปีงบ → { year_bh, counts, items } */
async function indicatorReadiness({ yearBh, deptId = null, includeInactive = false } = {}) {
    const where = [];
    const params = [];
    if (!includeInactive) where.push('i.is_active = 1');
    if (deptId != null) { where.push('i.dept_id = ?'); params.push(deptId); }
    const [inds] = await db.query(
        `SELECT i.id, i.kpi_indicators_name, i.dept_id, i.main_indicator_id, i.table_process, i.result_formula, i.custom_vars,
                i.target_percentage, i.target_monthly, i.criterion, i.evaluation_mode, i.required_off_types, i.upload_excel,
                i.khd_report_id, i.khd_fiscal_year, i.is_active
         FROM kpi_indicators i ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.id`, params);
    const assigned = new Map();
    if (yearBh && inds.length) {
        const [rows] = await db.query(
            'SELECT indicator_id, COUNT(DISTINCT hospcode) AS n FROM kpi_results WHERE year_bh = ? AND indicator_id IN (?) GROUP BY indicator_id',
            [String(yearBh), inds.map(i => i.id)]);
        for (const r of rows) assigned.set(Number(r.indicator_id), Number(r.n));
    }
    let khdMap = null, khdStatus = null;
    try { [khdMap, khdStatus] = await Promise.all([loadSnapshotMap(), getSnapshotStatus()]); } catch (_) { khdMap = null; }
    const counts = { ok: 0, info: 0, warn: 0, block: 0 };
    const byCode = {};
    const items = inds.map(ind => {
        const r = evaluateReadiness(ind, { year_bh: yearBh, assigned: assigned.get(Number(ind.id)) || 0, khd: khdMap });
        counts[r.level]++;
        for (const i of r.issues) byCode[i.code] = (byCode[i.code] || 0) + 1;
        return { id: Number(ind.id), level: r.level, assigned: assigned.get(Number(ind.id)) || 0, issues: r.issues };
    });
    return {
        year_bh: yearBh ? String(yearBh) : null, counts, by_code: byCode, items,
        khd_snapshot: { available: !!khdMap, refreshed_at: khdStatus && khdStatus.refreshed_at || null, count: khdStatus && khdStatus.count || 0, error: khdStatus && khdStatus.error || null },
    };
}

module.exports = { evaluateReadiness, indicatorReadiness, READINESS_RULES: RULES };
