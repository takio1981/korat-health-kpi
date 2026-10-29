// ตารางสรุป kpi_summary (กราฟ/รายงาน): อัปเดตรายคู่ ตัวชี้วัด×ปีงบ, คิวอัปเดตอัตโนมัติ + ล็อค, ผลงานจากข้อย่อย, สูตรผลงาน, ข้อมูลปีงบที่แล้ว/ค่าฐาน
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const kpiFormula = require('../kpi-formula');
const { formulaOk } = require('./formula-vars');
const { loadSubAggregates } = require('./hierarchy');
const { applyManualToSummary } = require('./manual-result');
const { applyMonthlyTargetToSummary } = require('./monthly-target');

// ===== ผลงานจากตัวชี้วัดย่อย/กิจกรรม → kpi_summary (ตัวชี้วัด 3 ระดับ — 18 ต.ค. 2569) =====
// กราฟ/รายงานทั้ง 4 แถบ + การ์ดหน้าแรกอ่าน kpi_summary ซึ่งเดิมสร้างจาก kpi_results เท่านั้น → ตัวชี้วัดที่บันทึกผลงานที่ข้อย่อย/กิจกรรม
// ไม่ขึ้นในรายงานเลย — ฟังก์ชันนี้นำค่ารายเดือน/เป้าหมายจาก loadSubAggregates() (กติกาเดียวกับหน้าบันทึกผลงาน applySubSummaryToKpiData)
// ไปทับช่องที่ข้อย่อยมีค่า (ช่องที่ข้อย่อยไม่มีค่าคงค่าจาก kpi_results) และสร้างแถวใหม่ให้คู่ที่ไม่มีใน kpi_results
// เฉพาะตัวชี้วัดหลักแบบ 'auto' (แบบ 'manual' = ผลงานหลักกรอกเอง ข้อย่อยแสดงประกอบเท่านั้น) — ผู้เรียกต้องคำนวณ last_actual ต่อเอง
const SUMMARY_SUB_MONTHS = [['oct', 'm10'], ['nov', 'm11'], ['dece', 'm12'], ['jan', 'm01'], ['feb', 'm02'], ['mar', 'm03'],
    ['apr', 'm04'], ['may', 'm05'], ['jun', 'm06'], ['jul', 'm07'], ['aug', 'm08'], ['sep', 'm09']];

const fmtSummaryNum = (v) => (v === null || v === undefined || !isFinite(Number(v))) ? null
    : (Number.isInteger(Number(v)) ? String(Number(v)) : Number(v).toFixed(2));

async function mergeSubIntoSummary(conn, { indicatorIds, yearBh } = {}) {
    const w = ['si.is_active = 1', "i.sub_rollup_mode <> 'manual'"], p = [];
    if (indicatorIds) {
        const ids = [...new Set(indicatorIds.map(Number).filter(Boolean))];
        if (!ids.length) return 0;
        w.push('si.indicator_id IN (?)'); p.push(ids);
    }
    const [cand] = await conn.query(
        `SELECT DISTINCT si.indicator_id FROM kpi_sub_indicators si JOIN kpi_indicators i ON i.id = si.indicator_id WHERE ${w.join(' AND ')}`, p);
    let merged = 0;
    for (const { indicator_id } of cand) {
        const rows = (await loadSubAggregates(conn, { indicatorId: indicator_id, yearBh })).filter(r => r.sub_rollup_mode !== 'manual');
        for (const r of rows) {
            const vals = SUMMARY_SUB_MONTHS.map(([, mk]) => fmtSummaryNum(r[mk]));
            if (vals.every(v => v === null)) continue; // ข้อย่อยยังไม่มีผลงาน — ไม่สร้าง/ไม่แตะแถว (เหมือน HAVING ของ kpi_results)
            const target = fmtSummaryNum(r.avg_target);
            const [ex] = await conn.query('SELECT id FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                [indicator_id, r.year_bh, r.hospcode]);
            if (ex.length) {
                const sets = SUMMARY_SUB_MONTHS.map(([col]) => `${col} = COALESCE(?, ${col})`).join(', ');
                await conn.query(`UPDATE kpi_summary SET ${sets}, target_value = COALESCE(?, target_value), updated_at = NOW() WHERE id = ?`,
                    [...vals, target, ex[0].id]);
            } else {
                // สถานะ/ล็อคของคู่ที่มีเฉพาะผลงานย่อย — จากผลงานข้อย่อยและกิจกรรม (cascade จากการอนุมัติตัวชี้วัดหลัก)
                const [[st]] = await conn.query(`
                    SELECT MAX(x.status) AS status, MAX(x.is_locked) AS is_locked, SUM(x.status = 'Pending') AS pending
                    FROM (
                        SELECT sr.status, sr.is_locked FROM kpi_sub_results sr JOIN kpi_sub_indicators si ON si.id = sr.sub_indicator_id
                        WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode = ?
                        UNION ALL
                        SELECT ar.status, ar.is_locked FROM kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id
                        JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id
                        WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode = ?
                    ) x`, [indicator_id, r.year_bh, r.hospcode, indicator_id, r.year_bh, r.hospcode]);
                await conn.query(`
                    INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, main_indicator_name, kpi_indicators_name,
                        dept_id, dept_name, hosname, distid, hostype, distname, table_process, target_value,
                        oct, nov, dece, jan, feb, mar, apr, may, jun, jul, aug, sep,
                        pending_count, indicator_status, is_locked, updated_at)
                    SELECT i.id, ?, ?, IFNULL(mi.main_indicator_name, 'ยังไม่กำหนด'), i.kpi_indicators_name, i.dept_id, d.dept_name,
                        h.hosname, h.distid, h.hostype, dist.distname, i.table_process, ?,
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, NOW()
                    FROM kpi_indicators i
                    LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
                    LEFT JOIN departments d ON d.id = i.dept_id
                    LEFT JOIN chospital h ON h.hoscode = ?
                    LEFT JOIN co_district dist ON dist.distid = h.distid
                    WHERE i.id = ?`,
                    [r.year_bh, r.hospcode, target, ...vals, Number(st?.pending || 0), st?.status || 'Pending', Number(st?.is_locked || 0) ? 1 : 0,
                     r.hospcode, indicator_id]);
            }
            merged++;
        }
    }
    return merged;
}

// last_actual ของ kpi_summary (ค่าเดือนล่าสุด / ผลรวมถ้าสะสม) — SQL เดียวกับ /refresh-summary/finalize, ขอบเขตตาม indicator+ปี
async function recomputeSummaryLastActual(conn, indicatorId, yearBh) {
    await conn.query(`
        UPDATE kpi_summary s
        JOIN kpi_indicators i ON i.id = s.indicator_id AND (i.is_cumulative = 0 OR i.is_cumulative IS NULL)
        SET s.last_actual = COALESCE(
            NULLIF(s.sep,''), NULLIF(s.aug,''), NULLIF(s.jul,''), NULLIF(s.jun,''),
            NULLIF(s.may,''), NULLIF(s.apr,''), NULLIF(s.mar,''), NULLIF(s.feb,''),
            NULLIF(s.jan,''), NULLIF(s.dece,''), NULLIF(s.nov,''), NULLIF(s.oct,'')
        )
        WHERE s.indicator_id = ? AND s.year_bh = ?
    `, [indicatorId, yearBh]);
    await conn.query(`
        UPDATE kpi_summary s
        JOIN kpi_indicators i ON i.id = s.indicator_id AND i.is_cumulative = 1
        SET s.last_actual = CASE
            WHEN NULLIF(s.oct,'') IS NULL AND NULLIF(s.nov,'') IS NULL AND NULLIF(s.dece,'') IS NULL AND NULLIF(s.jan,'') IS NULL
             AND NULLIF(s.feb,'') IS NULL AND NULLIF(s.mar,'') IS NULL AND NULLIF(s.apr,'') IS NULL AND NULLIF(s.may,'') IS NULL
             AND NULLIF(s.jun,'') IS NULL AND NULLIF(s.jul,'') IS NULL AND NULLIF(s.aug,'') IS NULL AND NULLIF(s.sep,'') IS NULL
            THEN NULL
            ELSE (
                COALESCE(CAST(NULLIF(s.oct,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.nov,'') AS DECIMAL(20,4)),0) +
                COALESCE(CAST(NULLIF(s.dece,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.jan,'') AS DECIMAL(20,4)),0) +
                COALESCE(CAST(NULLIF(s.feb,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.mar,'') AS DECIMAL(20,4)),0) +
                COALESCE(CAST(NULLIF(s.apr,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.may,'') AS DECIMAL(20,4)),0) +
                COALESCE(CAST(NULLIF(s.jun,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.jul,'') AS DECIMAL(20,4)),0) +
                COALESCE(CAST(NULLIF(s.aug,'') AS DECIMAL(20,4)),0) + COALESCE(CAST(NULLIF(s.sep,'') AS DECIMAL(20,4)),0)
            )
        END
        WHERE s.indicator_id = ? AND s.year_bh = ?
    `, [indicatorId, yearBh]);
}

// อัปเดต kpi_summary อัตโนมัติทันทีหลังข้อมูลผลงานเปลี่ยน ให้กราฟ/รายงานเห็นผลโดยไม่ต้องรอ "อัปเดต Summary"
// (23 ต.ค. 2569 — เดิมเฉพาะผลงานข้อย่อย/กิจกรรม ส่วนผลงานหลัก การอนุมัติ/ส่งกลับ/ปลดล็อค ต้องกด "อัปเดต Summary" เอง)
// - fire-and-forget: ไม่หน่วงการตอบกลับ ล้มเหลวไม่กระทบการบันทึก (บันทึกลง console)
// - คิวต่อคู่ (indicator_id|year_bh): คู่เดียวกันไม่รันซ้อนกัน (refreshSummaryPairs = DELETE + INSERT ซ้อนกันแล้วชน uk_ind_year_hos)
//   มีการบันทึกเพิ่มระหว่างรัน → รันซ้ำอีกรอบหลังจบ (รวมหลายการบันทึกเป็นรอบเดียว)
// - คืน Promise ให้รอได้ — summaryRefreshIdle() รอทุกคิวที่ค้าง (ใช้ในชุดทดสอบ)
// ล็อคระดับแอปของงานที่เขียน kpi_summary แบบลบ-สร้างใหม่ (คิวอัตโนมัติ + ปุ่ม "อัปเดต Summary" batch/finalize + ลบผลงานแบบชุด)
// — งานเหล่านี้ DELETE + INSERT แถวชุดเดียวกัน ถ้ารันพร้อมกันจะชน uk_ind_year_hos (พบจริงในชุดทดสอบ 23 ต.ค. 2569) จึงให้ทำทีละงาน
let _summaryLockTail = Promise.resolve();

function withSummaryLock(fn) {
    const run = _summaryLockTail.then(() => fn());
    _summaryLockTail = run.catch(() => {});
    return run;
}

// refresh 1 คู่บน connection แยกระดับ READ COMMITTED: INSERT … SELECT จาก kpi_results ไม่ถือ shared lock ของแถวผลงาน
// (ไม่บล็อก/ไม่ deadlock กับการบันทึกผลงานที่กำลังเกิดขึ้น) — deadlock/ชนคีย์ = ลองใหม่สูงสุด 3 ครั้ง
async function refreshSummaryPairIsolated(pair) {
    for (let attempt = 1; ; attempt++) {
        const conn = await db.getConnection();
        try {
            await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await refreshKpiSummaryForIndicatorYears(conn, [pair]);
            return;
        } catch (e) {
            if (attempt >= 3 || !['ER_LOCK_DEADLOCK', 'ER_DUP_ENTRY', 'ER_LOCK_WAIT_TIMEOUT'].includes(e.code)) throw e;
            await new Promise(r => setTimeout(r, 200 * attempt));
        } finally {
            try { await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ'); } catch (e) { /* ignore */ }
            conn.release();
        }
    }
}

const _summaryRefreshQueue = new Map(); // key → { again, promise }

function scheduleSummaryRefresh(pairs) {
    const uniq = new Map();
    for (const x of pairs || []) {
        if (!x || !x.indicator_id || !x.year_bh) continue;
        const p = { indicator_id: Number(x.indicator_id), year_bh: String(x.year_bh) };
        uniq.set(`${p.indicator_id}|${p.year_bh}`, p);
    }
    const waits = [];
    for (const [key, pair] of uniq) {
        const cur = _summaryRefreshQueue.get(key);
        if (cur) { cur.again = true; waits.push(cur.promise); continue; }
        const st = { again: false, promise: null };
        _summaryRefreshQueue.set(key, st);
        st.promise = (async () => {
            try {
                do {
                    st.again = false;
                    await withSummaryLock(() => refreshSummaryPairIsolated(pair));
                } while (st.again);
            } catch (e) {
                console.error(`[summary] refresh ${key} failed:`, e.message);
            } finally {
                _summaryRefreshQueue.delete(key);
            }
        })();
        waits.push(st.promise);
    }
    return Promise.all(waits);
}

async function summaryRefreshIdle() {
    while (_summaryRefreshQueue.size) await Promise.all([..._summaryRefreshQueue.values()].map(s => s.promise));
}

// ชื่อเดิม (บันทึกผลงานข้อย่อย/กิจกรรม) — ใช้คิวเดียวกัน
const refreshSummaryAfterSubSave = scheduleSummaryRefresh;

// Re-aggregate kpi_summary เฉพาะ (indicator_id, year_bh) ที่ได้รับผลกระทบหลังลบ kpi_results บางรายการ —
// ลบแถว summary เดิมทิ้งแล้วคำนวณใหม่จาก kpi_results ที่เหลืออยู่จริง (ไม่ใช่ลบทั้งแถวทิ้งเฉยๆ เหมือน
// /kpi-results/bulk-delete เดิม เพราะ endpoint นั้นลบทั้งปีอยู่แล้วจึงลบทั้งแถว summary ได้ตรงๆ แต่ที่นี่ลบแค่
// บางเดือน เดือนอื่นในปีเดียวกันของ indicator+hospcode นั้นอาจยังมีข้อมูลอยู่) — ใช้ SQL เดียวกับ
// /refresh-summary/batch + /refresh-summary/finalize เป๊ะ แค่ scope แคบลงเฉพาะ indicator_id+year_bh ที่กระทบ
async function refreshKpiSummaryForIndicatorYears(connection, pairs) {
    pairs = [...pairs].sort((a, b) => Number(a.indicator_id) - Number(b.indicator_id) || String(a.year_bh).localeCompare(String(b.year_bh)));
    await refreshSummaryPairs(connection, pairs);
    // ข้อมูลปี Y-1 เปลี่ยน → ผลงานปี Y ของตัวชี้วัดที่สูตรอ้างข้อมูลปีที่แล้วต้องคำนวณใหม่ด้วย (เฉพาะสูตร ไม่ต้องสร้างแถวใหม่)
    const done = new Set(pairs.map(p => `${p.indicator_id}|${p.year_bh}`));
    const ids = [...new Set(pairs.map(p => Number(p.indicator_id)))];
    if (!ids.length) return;
    const [inds] = await connection.query('SELECT id, result_formula FROM kpi_indicators WHERE id IN (?)', [ids]);
    const prevIds = new Set(inds.filter(i => { const f = kpiFormula.activeFormula(i); return f && kpiFormula.usesPrevYear(f); }).map(i => Number(i.id)));
    for (const p of pairs) {
        if (!prevIds.has(Number(p.indicator_id))) continue;
        const nextYear = String(parseInt(p.year_bh, 10) + 1);
        if (done.has(`${p.indicator_id}|${nextYear}`)) continue;
        done.add(`${p.indicator_id}|${nextYear}`);
        await applyFormulaToSummary(connection, { indicatorId: p.indicator_id, yearBh: nextYear });
    }
}

async function refreshSummaryPairs(connection, pairs) {
    for (const p of pairs) {
        await connection.query('DELETE FROM kpi_summary WHERE indicator_id = ? AND year_bh = ?', [p.indicator_id, p.year_bh]);
        await connection.query(`
            INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, main_indicator_name, kpi_indicators_name,
                dept_id, dept_name, hosname, distid, hostype, distname, table_process, target_value,
                oct, nov, dece, jan, feb, mar, apr, may, jun, jul, aug, sep,
                pending_count, indicator_status, is_locked, updated_at)
            SELECT
                i.id, r.year_bh, r.hospcode,
                IFNULL(mi.main_indicator_name, 'ยังไม่กำหนด'),
                i.kpi_indicators_name, i.dept_id, d.dept_name, h.hosname, h.distid, h.hostype, dist.distname, i.table_process,
                MAX(r.target_value),
                MAX(CASE WHEN r.month_bh=10 THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=11 THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=12 THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=1  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=2  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=3  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=4  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=5  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=6  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=7  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=8  THEN r.actual_value END),
                MAX(CASE WHEN r.month_bh=9  THEN r.actual_value END),
                SUM(CASE WHEN r.status='Pending' THEN 1 ELSE 0 END),
                MAX(r.status),
                MAX(CASE WHEN r.is_locked=1 THEN 1 ELSE 0 END),
                NOW()
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            WHERE r.indicator_id = ? AND r.year_bh = ?
            GROUP BY i.id, r.year_bh, r.hospcode
            -- ผลงาน 0 นับเป็นผลงานจริง (เช่น ไม่มีผู้เสียชีวิต = 0 ราย) — เดิมตัดทิ้งทำให้คู่ที่บันทึก 0 ทั้งปีหายจากรายงาน (24 ต.ค. 2569 — ตรงกับ hasActualData ของ Export)
            HAVING MAX(CASE WHEN r.actual_value IS NOT NULL AND TRIM(r.actual_value) != '' THEN 1 ELSE 0 END) = 1
        `, [p.indicator_id, p.year_bh]);
        // ผลงานจากตัวชี้วัดย่อย/กิจกรรม (ตัวชี้วัด 3 ระดับ) — ก่อนคำนวณ last_actual
        await mergeSubIntoSummary(connection, { indicatorIds: [p.indicator_id], yearBh: p.year_bh });
        await recomputeSummaryLastActual(connection, p.indicator_id, p.year_bh);
        // เป้าหมายรายเดือน → เป้าหมายรวม (ก่อนสูตร — สูตรอ้าง target) และอีกครั้งหลังขั้นกรอกเอง (แถวที่ขั้นนั้นสร้างเพิ่ม)
        await applyMonthlyTargetToSummary(connection, { indicatorId: p.indicator_id, yearBh: p.year_bh });
        await applyFormulaToSummary(connection, { indicatorId: p.indicator_id, yearBh: p.year_bh });
        // ผลงานล่าสุด/ร้อยละ ที่กรอกเอง — ทับผลที่คำนวณ (ต้องอยู่หลังสูตรเสมอ)
        await applyManualToSummary(connection, { indicatorId: p.indicator_id, yearBh: p.year_bh });
        await applyMonthlyTargetToSummary(connection, { indicatorId: p.indicator_id, yearBh: p.year_bh });
    }
}

// === ข้อมูลปีงบที่แล้วสำหรับสูตรที่อ้าง prev_m10..prev_m09 / prev_target / prev_result / PREV_ALL ===
// - ผลงานรายเดือน + เป้าหมาย: จาก kpi_results ของปีงบ (year_bh - 1) — แหล่งข้อมูลจริง
// - prev_result: ผลงานปีที่แล้ว "แบบพื้นฐาน" = ค่าเดือนล่าสุดที่บันทึก (หรือผลรวมถ้าตั้งเป็นตัวชี้วัดสะสม) คำนวณจาก
//   kpi_results ตรงๆ — ⚠️ ห้ามใช้ kpi_summary.last_actual ของปีที่แล้ว: ถ้าสูตรอ้างปีที่แล้วเอง (เช่น อัตราเพิ่มขึ้น)
//   ผลของปีที่แล้วต้องใช้ปีก่อนหน้านั้นอีกเป็นทอดๆ → ปีแรกเป็น null แล้วลามว่างทุกปีถัดไป (พบตอนทดสอบ 8 ต.ค. 2569)
//   ต้องการวิธีอื่นให้ใช้ฟังก์ชันกับ PREV_ALL ในสูตรเอง เช่น AVG(PREV_ALL)
// คืน Map key `${indicator_id}|${hospcode}` → { year_bh, months: {oct..sep}, target, result }
const PREV_MONTH_KEYS = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];

const PREV_MONTH_NUMS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function defaultLastActual(monthsObj, isCumulative) {
    const vals = PREV_MONTH_KEYS.map(k => monthsObj[k]);
    if (isCumulative) {
        const nums = vals.filter(v => v != null && String(v).trim() !== '' && !isNaN(parseFloat(v)));
        return nums.length ? String(nums.reduce((s, v) => s + parseFloat(v), 0)) : null;
    }
    for (let i = vals.length - 1; i >= 0; i--) {
        const v = vals[i];
        if (v != null && String(v).trim() !== '' && String(v).trim() !== '0') return v;
    }
    return null;
}

// === ค่าฐาน (base) + ค่าเพิ่มเติมที่ตั้งชื่อเองของสูตร — kpi_base_values (24–25 ต.ค. 2569) ===
// คืน Map key `${indicator_id}|${year_bh}|${hospcode}` → { var_key: value } (base, pop, …) — years ว่าง = ทุกปีงบ
const baseKey = (indicatorId, yearBh, hospcode) => `${Number(indicatorId)}|${String(yearBh)}|${String(hospcode).trim()}`;

async function loadBaseValues(conn, indicatorIds, years) {
    const map = new Map();
    const ids = [...new Set((indicatorIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return map;
    const ys = [...new Set((years || []).map(String).filter(Boolean))];
    const [rows] = await conn.query(
        `SELECT indicator_id, year_bh, hospcode, var_key, base_value FROM kpi_base_values WHERE indicator_id IN (?)${ys.length ? ' AND year_bh IN (?)' : ''}`,
        ys.length ? [ids, ys] : [ids]);
    for (const r of rows) {
        const k = baseKey(r.indicator_id, r.year_bh, r.hospcode);
        if (!map.has(k)) map.set(k, {});
        map.get(k)[r.var_key || 'base'] = r.base_value;
    }
    return map;
}

async function loadPrevYearData(conn, indicatorIds, yearBh, hospcodes) {
    const map = new Map();
    const y = parseInt(yearBh, 10);
    const ids = [...new Set((indicatorIds || []).map(Number).filter(Boolean))];
    if (!ids.length || !Number.isFinite(y)) return map;
    const prevYear = String(y - 1);
    const params = [prevYear, ids];
    let hw = '';
    const hcs = [...new Set((hospcodes || []).map(h => String(h).trim()).filter(Boolean))];
    if (hcs.length) { hw = 'AND hospcode IN (?)'; params.push(hcs); }
    const monthCols = PREV_MONTH_KEYS.map((k, i) => `MAX(CASE WHEN month_bh = ${PREV_MONTH_NUMS[i]} THEN actual_value END) AS ${k}`).join(', ');
    const [rows] = await conn.query(
        `SELECT indicator_id, hospcode, MAX(target_value) AS target, ${monthCols}
         FROM kpi_results WHERE year_bh = ? AND indicator_id IN (?) ${hw} GROUP BY indicator_id, hospcode`, params);
    const [inds] = await conn.query('SELECT id, is_cumulative FROM kpi_indicators WHERE id IN (?)', [ids]);
    const cum = new Map(inds.map(i => [Number(i.id), Number(i.is_cumulative) === 1]));
    for (const r of rows) {
        const key = `${r.indicator_id}|${String(r.hospcode).trim()}`;
        const months = {};
        for (const k of PREV_MONTH_KEYS) months[k] = r[k];
        map.set(key, { year_bh: prevYear, months, target: r.target, result: defaultLastActual(months, cum.get(Number(r.indicator_id))) });
    }
    return map;
}

// คำนวณ kpi_summary.last_actual ใหม่ด้วยสูตร (result_formula) — เฉพาะตัวชี้วัดที่ตั้งสูตรไว้
// เรียกหลัง UPDATE last_actual แบบ SQL เดิม (ค่าเดือนล่าสุด / สะสม) เพื่อทับค่าเฉพาะตัวชี้วัดที่มีสูตร
// สูตรคำนวณใน SQL ไม่ได้ (เป็นภาษาของเราเอง) จึงคำนวณใน JS ด้วย kpi-formula.js ตัวเดียวกับทุกจุดในระบบ
// opts: { indicatorId?, yearBh? } — ไม่ระบุ = ทุกตัวชี้วัดที่มีสูตร / ทุกปีงบ
async function applyFormulaToSummary(conn, opts = {}) {
    const where = ["result_formula IS NOT NULL", "TRIM(result_formula) <> ''"];
    const params = [];
    if (opts.indicatorId) { where.push('id = ?'); params.push(opts.indicatorId); }
    const [inds] = await conn.query(`SELECT id, result_formula, custom_vars FROM kpi_indicators WHERE ${where.join(' AND ')}`, params);
    let updated = 0;
    for (const ind of inds) {
        const formula = kpiFormula.activeFormula(ind);
        if (!formulaOk(ind, formula)) continue; // สูตรผิด (ไม่ควรเกิด — validate ตอนบันทึกแล้ว) → คงค่าเดิม
        const sp = [ind.id];
        let yw = '';
        if (opts.yearBh) { yw = 'AND year_bh = ?'; sp.push(opts.yearBh); }
        // ข้อมูลปีที่แล้วโหลดจาก kpi_results (ไม่ขึ้นกับ summary ปีที่แล้ว) — เรียงปีไว้เพื่อโหลดครั้งเดียวต่อปี
        const [rows] = await conn.query(
            `SELECT id, year_bh, hospcode, target_value, oct, nov, dece, jan, feb, mar, apr, may, jun, jul, aug, sep
             FROM kpi_summary WHERE indicator_id = ? ${yw} ORDER BY year_bh ASC`, sp);
        const needPrev = kpiFormula.usesPrevYear(formula);
        // ค่าฐาน/ค่าเพิ่มเติม — โหลดครั้งเดียวต่อตัวชี้วัด เฉพาะสูตรที่อ้างตัวแปรที่ตั้งชื่อเอง
        const baseMap = kpiFormula.formulaVarNames(formula).length ? await loadBaseValues(conn, [ind.id], opts.yearBh ? [opts.yearBh] : null) : null;
        let prevMap = null, prevFor = null;
        for (const r of rows) {
            if (needPrev && prevFor !== r.year_bh) {
                prevMap = await loadPrevYearData(conn, [ind.id], r.year_bh);
                prevFor = r.year_bh;
            }
            const prev = needPrev ? prevMap.get(`${ind.id}|${String(r.hospcode).trim()}`) : undefined;
            const vars = baseMap ? (baseMap.get(baseKey(ind.id, r.year_bh, r.hospcode)) || {}) : undefined;
            const val = kpiFormula.evaluateFormula(formula, r, r.target_value, prev, vars);
            await conn.query('UPDATE kpi_summary SET last_actual = ? WHERE id = ?', [val, r.id]);
            updated++;
        }
    }
    return updated;
}

module.exports = { SUMMARY_SUB_MONTHS, fmtSummaryNum, mergeSubIntoSummary, recomputeSummaryLastActual, withSummaryLock, refreshSummaryPairIsolated, _summaryRefreshQueue, scheduleSummaryRefresh, summaryRefreshIdle, refreshSummaryAfterSubSave, refreshKpiSummaryForIndicatorYears, refreshSummaryPairs, PREV_MONTH_KEYS, PREV_MONTH_NUMS, defaultLastActual, baseKey, loadBaseValues, loadPrevYearData, applyFormulaToSummary };
