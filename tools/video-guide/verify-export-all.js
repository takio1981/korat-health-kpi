// ตรวจความถูกต้องของตารางส่งออกทั้งหมดในฐานทดสอบ เทียบกับ kpi_results (27 พ.ย. 2569 — หน้าจัดการข้อมูล KPI)
// node verify-export-all.js [ปีงบ] — อ่านอย่างเดียว | ตรวจเฉพาะตัวชี้วัดแบบพื้นฐาน (ผลงาน = ค่าเดือนล่าสุด, เป้าหมายเดียวทั้งปี)
// ตัวชี้วัดที่คำนวณพิเศษ (สูตร/สะสม/เป้ารายเดือน/รายไตรมาส/กรอกเอง/ข้อย่อย/แบบฟอร์ม) มีชุดทดสอบ jest ของตัวเอง — นับแยกว่า "ข้าม"
const { withDb } = require('./lib/db');
const YEAR = process.argv[2] || '2570';
const MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const col = (m) => 'm' + String(m).padStart(2, '0');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const same = (a, b) => (num(a) === null && num(b) === null) || (num(a) !== null && num(b) !== null && Math.abs(num(a) - num(b)) < 1e-9) || String(a ?? '') === String(b ?? '');

(async () => {
    await withDb(async c => {
        const [inds] = await c.query(`SELECT id, kpi_indicators_name, REPLACE(TRIM(table_process), '-', '_') tp, result_formula, is_cumulative, target_monthly, quarter_mode,
                                             result_manual, (SELECT COUNT(*) FROM kpi_sub_indicators s WHERE s.indicator_id = i.id AND s.is_active = 1) subs
                                      FROM kpi_indicators i WHERE is_active = 1 AND table_process <> ''`);
        const [tables] = await c.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
        const exists = new Set(tables.map(x => x.t));
        const [forms] = await c.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'form\\_%'");
        const formSet = new Set(forms.map(x => x.t.slice(5)));
        const byTp = new Map();
        for (const i of inds) { if (!byTp.has(i.tp)) byTp.set(i.tp, []); byTp.get(i.tp).push(i); }
        let checked = 0, skipped = 0, noTable = 0, cells = 0, hosRows = 0;
        const bad = [], skipReasons = {};
        for (const [tp, list] of byTp) {
            const i = list[0];
            const reason = list.length > 1 ? 'ใช้ตารางร่วมหลายตัวชี้วัด' : i.result_formula ? 'สูตร' : +i.is_cumulative ? 'สะสม' : i.target_monthly ? 'เป้ารายเดือน'
                : i.quarter_mode ? 'รายไตรมาส' : +i.result_manual ? 'กรอกเอง' : i.subs > 0 ? 'ข้อย่อย' : formSet.has(tp) ? 'แบบฟอร์ม' : null;
            const [src] = await c.query("SELECT hospcode, month_bh, target_value, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ?", [i.id, YEAR]);
            const hasActual = src.some(r => r.actual_value !== null && r.actual_value !== '');
            if (!hasActual) continue;
            if (reason) { skipped++; skipReasons[reason] = (skipReasons[reason] || 0) + 1; continue; }
            if (!exists.has(tp)) { noTable++; continue; }
            const [exp] = await c.query(`SELECT * FROM \`${tp}\` WHERE byear = ?`, [YEAR]);
            checked++;
            const byHos = new Map();
            for (const r of src) { const h = String(r.hospcode).trim(); if (!byHos.has(h)) byHos.set(h, []); byHos.get(h).push(r); }
            for (const [h, rs] of byHos) {
                const row = exp.find(e => String(e.hospcode).trim() === h);
                const any = rs.some(r => r.actual_value !== null && r.actual_value !== '');
                if (!row) { if (any) bad.push(`${tp} ${h}: ไม่มีแถวในตารางส่งออก`); continue; }
                hosRows++;
                for (const m of MONTHS) {
                    const s = rs.find(r => Number(r.month_bh) === m);
                    cells++;
                    if (!same(row[col(m)], s ? s.actual_value : null)) bad.push(`${tp} ${h} ${col(m)}: ${row[col(m)]} ≠ ${s ? s.actual_value : null}`);
                }
                const latest = [...MONTHS].reverse().map(m => rs.find(r => Number(r.month_bh) === m)).find(r => r && r.actual_value !== null && r.actual_value !== '');
                if (!same(row.result, latest ? latest.actual_value : null)) bad.push(`${tp} ${h} result: ${row.result} ≠ ${latest ? latest.actual_value : null}`);
                const tvals = rs.map(r => r.target_value).filter(v => v !== null && v !== '');
                if (tvals.length && !tvals.some(v => same(row.target, v))) bad.push(`${tp} ${h} target: ${row.target} ∉ {${[...new Set(tvals)].join(',')}}`);
            }
        }
        console.log(`ปีงบ ${YEAR}: ตรวจ ${checked} ตาราง · ${hosRows} หน่วยบริการ · ${cells} ช่องรายเดือน (+ target/result ทุกแถว)`);
        console.log(`ข้ามตัวชี้วัดคำนวณพิเศษ ${skipped}: ${JSON.stringify(skipReasons)} | มีผลงานแต่ยังไม่ส่งออก ${noTable}`);
        console.log(bad.length ? `✗ ไม่ตรง ${bad.length} จุด:\n  ` + bad.slice(0, 20).join('\n  ') : '✓ ค่าในตารางส่งออกตรงกับ kpi_results ทุกจุด');
        process.exitCode = bad.length ? 1 : 0;
    });
})().catch(e => { console.error(e); process.exit(1); });
