// เป้าหมายรายเดือน (target_monthly — 29 ต.ค. 2569)
// ตัวชี้วัดที่ตั้งเป้าหมายรายเดือน: เป้าหมายแต่ละเดือนอยู่ใน kpi_results.target_value ของเดือนนั้น
// kpi_summary.target_value = "เป้าหมายรวม" ตาม aggregateMonthlyTarget() (api/kpi-target.js — สำเนาเดียวกับหน้าบันทึกผลงาน)
// แทน MAX(target_value) ของขั้น INSERT — รายงาน/การ์ดสถิติ/กราฟ จึงเทียบผลงานกับเป้าหมายรวมเดียวกับหน้าบันทึกผลงาน
const { TARGET_MONTHLY_MODES, aggregateMonthlyTarget } = require('../kpi-target');

const MONTH_NUMS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const SUMMARY_MONTHS = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];

// เรียกหลังขั้น INSERT + รวมผลงานข้อย่อย และก่อน applyFormulaToSummary (สูตรอ้าง target) — opts: { indicatorId?, yearBh? }
// คู่ที่ไม่มีเป้าหมายรายเดือนใน kpi_results เลย (เช่น เป้าหมายมาจากข้อย่อย) = คงค่าเดิม
async function applyMonthlyTargetToSummary(conn, opts = {}) {
    const where = ['target_monthly IN (?)'];
    const params = [TARGET_MONTHLY_MODES];
    if (opts.indicatorId) { where.push('id = ?'); params.push(opts.indicatorId); }
    const [inds] = await conn.query(`SELECT id, target_monthly FROM kpi_indicators WHERE ${where.join(' AND ')}`, params);
    let updated = 0;
    for (const ind of inds) {
        const p = [ind.id];
        let yw = '';
        if (opts.yearBh) { yw = ' AND year_bh = ?'; p.push(opts.yearBh); }
        const [tRows] = await conn.query(`SELECT year_bh, hospcode, month_bh, target_value FROM kpi_results WHERE indicator_id = ?${yw}`, p);
        const tMap = new Map();
        for (const r of tRows) {
            const key = `${r.year_bh}|${String(r.hospcode).trim()}`;
            if (!tMap.has(key)) tMap.set(key, new Array(12).fill(null));
            const i = MONTH_NUMS.indexOf(Number(r.month_bh));
            if (i >= 0) tMap.get(key)[i] = r.target_value;
        }
        const [sRows] = await conn.query(`SELECT id, year_bh, hospcode, ${SUMMARY_MONTHS.join(', ')} FROM kpi_summary WHERE indicator_id = ?${yw}`, p);
        for (const s of sRows) {
            const t = tMap.get(`${s.year_bh}|${String(s.hospcode).trim()}`);
            if (!t || !t.some(v => v !== null && v !== undefined && String(v).trim() !== '')) continue;
            const v = aggregateMonthlyTarget(ind.target_monthly, SUMMARY_MONTHS.map(k => s[k]), t);
            await conn.query('UPDATE kpi_summary SET target_value = ? WHERE id = ?', [v, s.id]);
            updated++;
        }
    }
    return updated;
}

module.exports = { applyMonthlyTargetToSummary };
