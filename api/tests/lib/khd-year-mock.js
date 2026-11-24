// KHD จำลองสำหรับคำสั่งของ services/khd-match.js (24 พ.ย. 2569) — ใช้ใน jest.mock('../db-remote') ของชุดทดสอบ khd-*
// khdYearQuery(s, params, reports, fy) → [rows] เมื่อเป็นคำสั่งที่รู้จัก ไม่งั้น null (ให้ชุดทดสอบจัดการคำสั่งอื่นต่อ)
//   reports = แถวตาราง reports, fy = แถว report_fiscal_year_config ({ report_id, fiscal_year, target_percentage, target_condition, is_active, r9, moph, ssj, rmw })
const FY_COLS = ['target_percentage', 'target_condition', 'is_active', 'r9', 'moph', 'ssj', 'rmw'];

function khdYearQuery(s, params, reports, fy) {
    if (/FROM report_fiscal_year_config f JOIN reports r ON r\.report_id = f\.report_id WHERE f\.fiscal_year = \?/.test(s)) {
        const year = String(params[0]);
        const rows = fy.filter(f => String(f.fiscal_year) === year).map(f => {
            const r = reports.find(x => Number(x.report_id) === Number(f.report_id));
            if (!r) return null;
            const row = { ...r, fy_fiscal_year: f.fiscal_year };
            for (const c of FY_COLS) row['fy_' + c] = f[c] === undefined ? null : f[c];
            return row;
        }).filter(Boolean).sort((a, b) => a.report_id - b.report_id);
        return [rows];
    }
    if (/^SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config WHERE report_id IN \(\?\)/.test(s.trim()))
        return [fy.filter(f => params[0].map(Number).includes(Number(f.report_id))).map(f => ({ report_id: f.report_id, fiscal_year: f.fiscal_year }))];
    if (/^SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config$/.test(s.trim()))
        return [fy.map(f => ({ report_id: f.report_id, fiscal_year: f.fiscal_year }))];
    return null;
}

module.exports = { khdYearQuery };
