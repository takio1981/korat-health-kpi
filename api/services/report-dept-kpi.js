// รายงานสรุปผล: สรุปข้อมูลตัวชี้วัดของกลุ่มงาน (28 พ.ย. 2569 — ผู้ใช้สั่ง)
// ฟังก์ชันล้วน (ไม่แตะฐานข้อมูล): รับแถวของรายงานรายตัวชี้วัด (reportByIndicatorRows — ทุกหน่วยบริการที่ต้องกรอก ทั้งที่มีผลงานและยังไม่มี
// จาก services/report-pairs.js ตามขอบเขต role) → จัดกลุ่มตามกลุ่มงาน (dept_id)
// เน้นการบันทึกผลงาน ไม่ดูผ่าน/ไม่ผ่านเกณฑ์ (ผู้ใช้สั่ง): ร้อยละการบันทึก = คู่ที่มีผลงาน ÷ คู่ที่ต้องกรอก,
//   ร้อยละผลงานของตัวชี้วัด = ผลงานรวม ÷ เป้าหมายรวม (achievement_pct ของแถว) — กลุ่มงานแสดงค่าเฉลี่ยของตัวชี้วัดที่มีเป้าหมาย

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
                total_indicators: 0, total_pairs: 0, recorded_pairs: 0,
                indicators_all_recorded: 0, indicators_partial: 0, indicators_none_recorded: 0,
                indicators_with_target: 0, _pctSum: 0, indicators: [],
            };
            groups.set(key, g);
        }
        const total = num(r.hospital_count);
        const rec = num(r.recorded_hospitals);
        g.total_indicators++;
        g.total_pairs += total;
        g.recorded_pairs += rec;
        if (total > 0 && rec >= total) g.indicators_all_recorded++;
        else if (rec > 0) g.indicators_partial++;
        else g.indicators_none_recorded++;
        if (num(r.target_value) > 0) { g.indicators_with_target++; g._pctSum += num(r.achievement_pct); }
        g.indicators.push(r);
    }
    const data = [...groups.values()].map(g => {
        const { _pctSum, ...rest } = g;
        rest.recording_pct = pct(g.recorded_pairs, g.total_pairs);
        rest.avg_indicator_pct = g.indicators_with_target > 0 ? Math.round(_pctSum / g.indicators_with_target * 100) / 100 : 0;
        rest.indicators.sort((a, b) => (num(b.recorded_hospitals) / Math.max(1, num(b.hospital_count))) - (num(a.recorded_hospitals) / Math.max(1, num(a.hospital_count)))
            || String(a.kpi_indicators_name || '').localeCompare(String(b.kpi_indicators_name || ''), 'th'));
        return rest;
    }).sort((a, b) => b.recording_pct - a.recording_pct || a.dept_name.localeCompare(b.dept_name, 'th'));

    const totalPairs = data.reduce((s, g) => s + g.total_pairs, 0);
    const recordedPairs = data.reduce((s, g) => s + g.recorded_pairs, 0);
    const withPairs = data.filter(g => g.total_pairs > 0);
    return {
        summary: {
            total_depts: data.length,
            total_indicators: data.reduce((s, g) => s + g.total_indicators, 0),
            total_pairs: totalPairs,
            recorded_pairs: recordedPairs,
            recording_pct: pct(recordedPairs, totalPairs),
            depts_ge_80: withPairs.filter(g => g.recording_pct >= 80).length,
            depts_lt_50: withPairs.filter(g => g.recording_pct < 50).length,
        },
        data,
    };
}

module.exports = { summarizeDeptKpi, NO_DEPT };
