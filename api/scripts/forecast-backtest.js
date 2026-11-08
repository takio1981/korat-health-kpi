// ทดสอบย้อนหลัง (Backtesting) แบบจำลองคาดการณ์ของระบบเตือนล่วงหน้า — อ่านฐานข้อมูลอย่างเดียว (SELECT เท่านั้น)
// ใช้: node scripts/forecast-backtest.js [ปีงบ=2569] [เดือนตัด 0–11 = 5 (มี.ค.)] [--json]
//   คาดการณ์จากข้อมูลถึงเดือนตัด เทียบผลผ่าน/ไม่ผ่านจริงเมื่อสิ้นปีงบ (ข้อมูลจาก kpi_summary — ตารางเดียวกับรายงาน) แยกตามวิธี
//   ข้อเสนอแนวคิด: ความแม่นยำของการจำแนกผลการบรรลุเป้าหมาย ณ สิ้นปีงบ ≥ ร้อยละ 80
const path = require('path');
if (!process.env.DB_NAME) require('dotenv').config({ path: path.join(__dirname, '..', '.env.dev'), quiet: true });
const db = require('../db');
const { evaluateBacktest: evaluate, METHODS, MONTH_KEYS } = require('../kpi-forecast');

const SUM_COLS = MONTH_KEYS; // kpi_summary ใช้ชื่อเดียวกัน (oct … dece … sep)

async function loadPairs(year) {
    const [rows] = await db.query(`
        SELECT s.indicator_id, s.hospcode, s.target_value, ${SUM_COLS.map(c => 's.' + c).join(', ')},
               i.target_condition, i.is_cumulative, i.result_formula, i.target_monthly, i.result_manual
        FROM kpi_summary s JOIN kpi_indicators i ON i.id = s.indicator_id
        WHERE s.year_bh = ? AND i.is_active = 1`, [String(year)]);
    return rows.map(r => ({
        key: `${r.indicator_id}|${r.hospcode}`,
        months: Object.fromEntries(MONTH_KEYS.map(k => [k, r[k]])),
        target: r.target_value, condition: r.target_condition, cumulative: r.is_cumulative,
        formula: r.result_formula, targetMonthly: null, manual: Number(r.result_manual) === 1,
    }));
}

async function run(year = 2569, cutoff = 5) {
    const pairs = await loadPairs(year);
    const results = METHODS.map(m => evaluate(pairs, cutoff, m));
    return { year_bh: String(year), cutoff, pairs: pairs.length, results };
}

if (require.main === module) {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
    run(Number(args[0] || 2569), Number(args[1] ?? 5)).then((out) => {
        if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
        else {
            console.log(`ปีงบ ${out.year_bh} | ตัดที่เดือน ${MONTH_KEYS[out.cutoff]} | คู่ทั้งหมด ${out.pairs}`);
            for (const r of out.results) console.log(`  ${r.method.padEnd(7)} เทียบได้ ${r.compared} คู่ | ถูก ${r.accuracy_pct}% | เตือนครบ ${r.warn_recall_pct}% | เตือนแม่น ${r.warn_precision_pct}% (TP ${r.tp} FN ${r.fn} FP ${r.fp} TN ${r.tn})`);
        }
        process.exit(0);
    }).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { run, loadPairs };
