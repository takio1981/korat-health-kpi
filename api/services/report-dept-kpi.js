// รายงานสรุปผล: สรุปข้อมูลตัวชี้วัดของกลุ่มงาน (28 พ.ย. 2569 — ผู้ใช้สั่ง)
// ฟังก์ชันล้วน (ไม่แตะฐานข้อมูล): รับแถวของรายงานรายตัวชี้วัด (reportByIndicatorRows — ตัวคำนวณเดียวกับแถบรายข้อตัวชี้วัด
// จาก kpi_summary ตามขอบเขต role) → จัดกลุ่มตามกลุ่มงาน (dept_id) — เกณฑ์ผ่านเดียวกับทั้งระบบ (นับ "คู่" ตัวชี้วัด × หน่วยบริการ)

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (n, d) => (num(d) > 0 ? Math.round(num(n) / num(d) * 10000) / 100 : 0);
const NO_DEPT = 'ไม่ระบุกลุ่มงาน';

/** จัดกลุ่มแถวรายตัวชี้วัดตามกลุ่มงาน → { summary, data: [{ dept_id, dept_name, ..., indicators: [...] }] } */
function summarizeDeptKpi(rows) {
    const groups = new Map();
    for (const r of rows || []) {
        const key = r.dept_id != null ? 'd' + r.dept_id : 'n:' + (r.dept_name || '');
        let g = groups.get(key);
        if (!g) {
            g = {
                dept_id: r.dept_id != null ? Number(r.dept_id) : null, dept_name: r.dept_name || NO_DEPT,
                total_indicators: 0, indicators_with_target: 0, pairs_with_target: 0, pairs_passed: 0,
                indicators_all_passed: 0, indicators_partial: 0, indicators_none_passed: 0, indicators_no_target: 0,
                _pctSum: 0, indicators: [],
            };
            groups.set(key, g);
        }
        const withT = num(r.hospitals_with_target);
        const passed = num(r.hospitals_passed);
        const ach = num(r.achievement_pct);
        g.total_indicators++;
        if (withT > 0) {
            g.indicators_with_target++;
            g.pairs_with_target += withT;
            g.pairs_passed += passed;
            g._pctSum += ach;
            if (ach >= 100) g.indicators_all_passed++;
            else if (ach > 0) g.indicators_partial++;
            else g.indicators_none_passed++;
        } else {
            g.indicators_no_target++;
        }
        g.indicators.push(r);
    }
    const data = [...groups.values()].map(g => {
        const { _pctSum, ...rest } = g;
        rest.pass_pct = pct(g.pairs_passed, g.pairs_with_target);
        rest.avg_indicator_pct = g.indicators_with_target > 0 ? Math.round(_pctSum / g.indicators_with_target * 100) / 100 : 0;
        rest.indicators.sort((a, b) => num(b.achievement_pct) - num(a.achievement_pct)
            || String(a.kpi_indicators_name || '').localeCompare(String(b.kpi_indicators_name || ''), 'th'));
        return rest;
    }).sort((a, b) => b.pass_pct - a.pass_pct || a.dept_name.localeCompare(b.dept_name, 'th'));

    const pairsWithTarget = data.reduce((s, g) => s + g.pairs_with_target, 0);
    const pairsPassed = data.reduce((s, g) => s + g.pairs_passed, 0);
    const withTargetDepts = data.filter(g => g.pairs_with_target > 0);
    return {
        summary: {
            total_depts: data.length,
            total_indicators: data.reduce((s, g) => s + g.total_indicators, 0),
            indicators_with_target: data.reduce((s, g) => s + g.indicators_with_target, 0),
            pairs_with_target: pairsWithTarget,
            pairs_passed: pairsPassed,
            pass_pct: pct(pairsPassed, pairsWithTarget),
            depts_ge_80: withTargetDepts.filter(g => g.pass_pct >= 80).length,
            depts_lt_50: withTargetDepts.filter(g => g.pass_pct < 50).length,
        },
        data,
    };
}

module.exports = { summarizeDeptKpi, NO_DEPT };
