// ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569 — ผู้ใช้เลือก: ตั้งแยก 2 ตัวเลือกต่อตัวชี้วัด, ผ่านเกณฑ์ = ร้อยละที่กรอก ≥ 100,
// ช่องรายเดือนยังกรอกได้แต่ไม่นำมาคำนวณ, ยังไม่กรอก = ว่าง ไม่ใช้ค่าที่คำนวณแทน)
// - kpi_indicators.result_manual / pct_manual (0/1)
// - ค่าที่กรอกต่อคู่ ตัวชี้วัด × หน่วยบริการ × ปีงบ เก็บใน kpi_base_values ด้วย var_key พิเศษ '__result' / '__pct'
//   (ขึ้นต้นด้วย "_" — ชื่อค่าเพิ่มเติมที่ผู้ใช้ตั้งต้องขึ้นต้นด้วย a-z จึงไม่ชนกัน และ /update-kpi รับ cv_<key> เฉพาะ a-z)
// - kpi_summary.last_actual = ผลงานที่กรอก (result_manual), kpi_summary.manual_pct = ร้อยละที่กรอก ('' = ยังไม่กรอก, NULL = ตัวชี้วัดคำนวณร้อยละเอง)
//   → targetHasSql/targetPassSql (core/sql.js) ใช้ manual_pct เมื่อไม่ใช่ NULL
const db = require('../db');

const MANUAL_RESULT_KEY = '__result';
const MANUAL_PCT_KEY = '__pct';
const isManualResult = (ind) => Number(ind && ind.result_manual) === 1;
const isManualPct = (ind) => Number(ind && ind.pct_manual) === 1;
const manualKey = (indicatorId, yearBh, hospcode) => `${Number(indicatorId)}|${String(yearBh)}|${String(hospcode).trim()}`;

// Map manualKey → { result, pct } (เฉพาะค่าที่กรอกแล้ว)
async function loadManualValues(conn, indicatorIds, years) {
    const map = new Map();
    const ids = [...new Set((indicatorIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return map;
    const ys = [...new Set((years || []).map(String).filter(Boolean))];
    const [rows] = await conn.query(
        `SELECT indicator_id, year_bh, hospcode, var_key, base_value FROM kpi_base_values
         WHERE var_key IN (?, ?) AND indicator_id IN (?)${ys.length ? ' AND year_bh IN (?)' : ''}`,
        ys.length ? [MANUAL_RESULT_KEY, MANUAL_PCT_KEY, ids, ys] : [MANUAL_RESULT_KEY, MANUAL_PCT_KEY, ids]);
    for (const r of rows) {
        const k = manualKey(r.indicator_id, r.year_bh, r.hospcode);
        if (!map.has(k)) map.set(k, { result: null, pct: null });
        map.get(k)[r.var_key === MANUAL_RESULT_KEY ? 'result' : 'pct'] = r.base_value;
    }
    return map;
}

// ร้อยละที่กรอกต้องเป็นตัวเลข (ทศนิยมได้, ติดลบไม่ได้) — คืนข้อความที่ normalize แล้ว หรือ null = ไม่ถูกต้อง ('' = ว่าง)
function normalizeManualPct(v) {
    const s = String(v ?? '').trim().replace(/%$/, '').trim();
    if (!s) return '';
    return /^\d+(\.\d+)?$/.test(s) ? s : null;
}

// เขียนค่าที่กรอกเองลง kpi_summary ของตัวชี้วัด (× ปีงบ) — เรียกหลัง applyFormulaToSummary เสมอ (ค่าที่กรอกเองมาก่อนสูตร)
// คู่ที่มีแต่ค่าที่กรอกเอง (ยังไม่มีผลงานรายเดือน) จะไม่มีแถวจากขั้น INSERT ปกติ (HAVING ผลงานรายเดือน) → สร้างแถวให้จาก kpi_results ของคู่นั้น
async function applyManualToSummary(conn, opts = {}) {
    const where = ['(result_manual = 1 OR pct_manual = 1)'];
    const params = [];
    if (opts.indicatorId) { where.push('id = ?'); params.push(opts.indicatorId); }
    const [inds] = await conn.query(`SELECT id, result_manual, pct_manual FROM kpi_indicators WHERE ${where.join(' AND ')}`, params);
    // ตัวชี้วัดที่ไม่ได้กรอกร้อยละเองต้องเป็น NULL (ใช้การคำนวณตามเงื่อนไขเป้าหมาย) — ล้างค่าค้างเมื่อเปลี่ยนการตั้งค่ากลับ
    if (opts.indicatorId && !inds.length) {
        await conn.query(`UPDATE kpi_summary SET manual_pct = NULL WHERE indicator_id = ?${opts.yearBh ? ' AND year_bh = ?' : ''} AND manual_pct IS NOT NULL`,
            opts.yearBh ? [opts.indicatorId, opts.yearBh] : [opts.indicatorId]);
    } else if (!opts.indicatorId) {
        await conn.query(`UPDATE kpi_summary s JOIN kpi_indicators i ON i.id = s.indicator_id SET s.manual_pct = NULL
            WHERE COALESCE(i.pct_manual, 0) = 0 AND s.manual_pct IS NOT NULL${opts.yearBh ? ' AND s.year_bh = ?' : ''}`, opts.yearBh ? [opts.yearBh] : []);
    }
    let updated = 0;
    for (const ind of inds) {
        const vals = await loadManualValues(conn, [ind.id], opts.yearBh ? [opts.yearBh] : null);
        // สร้างแถวให้คู่ที่มีค่าที่กรอกเองแต่ยังไม่มีแถวใน summary (ข้อมูลหน่วยบริการ/เป้าหมาย/สถานะจาก kpi_results ของคู่นั้น)
        for (const [k, v] of vals) {
            const [, yb, hc] = k.split('|');
            const has = (isManualResult(ind) && String(v.result ?? '').trim()) || (isManualPct(ind) && String(v.pct ?? '').trim());
            if (!has) continue;
            const [ex] = await conn.query('SELECT id FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [ind.id, yb, hc]);
            if (ex.length) continue;
            await conn.query(`
                INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, main_indicator_name, kpi_indicators_name,
                    dept_id, dept_name, hosname, distid, hostype, distname, table_process, target_value,
                    pending_count, indicator_status, is_locked, updated_at)
                SELECT i.id, r.year_bh, r.hospcode, IFNULL(mi.main_indicator_name, 'ยังไม่กำหนด'), i.kpi_indicators_name, i.dept_id, d.dept_name,
                    h.hosname, h.distid, h.hostype, dist.distname, i.table_process, MAX(r.target_value),
                    SUM(CASE WHEN r.status='Pending' THEN 1 ELSE 0 END), MAX(r.status), MAX(CASE WHEN r.is_locked=1 THEN 1 ELSE 0 END), NOW()
                FROM kpi_results r
                JOIN kpi_indicators i ON r.indicator_id = i.id
                LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
                LEFT JOIN departments d ON d.id = i.dept_id
                LEFT JOIN chospital h ON r.hospcode = h.hoscode
                LEFT JOIN co_district dist ON dist.distid = h.distid
                WHERE r.indicator_id = ? AND r.year_bh = ? AND r.hospcode = ?
                GROUP BY i.id, r.year_bh, r.hospcode`, [ind.id, yb, hc]);
        }
        const sp = [ind.id];
        let yw = '';
        if (opts.yearBh) { yw = 'AND year_bh = ?'; sp.push(opts.yearBh); }
        const [rows] = await conn.query(`SELECT id, year_bh, hospcode FROM kpi_summary WHERE indicator_id = ? ${yw}`, sp);
        for (const r of rows) {
            const v = vals.get(manualKey(ind.id, r.year_bh, r.hospcode)) || {};
            const sets = [], p = [];
            if (isManualResult(ind)) { sets.push('last_actual = ?'); p.push(String(v.result ?? '').trim() || null); }
            sets.push('manual_pct = ?');
            p.push(isManualPct(ind) ? (String(v.pct ?? '').trim()) : null);
            await conn.query(`UPDATE kpi_summary SET ${sets.join(', ')} WHERE id = ?`, [...p, r.id]);
            updated++;
        }
    }
    return updated;
}

module.exports = { MANUAL_RESULT_KEY, MANUAL_PCT_KEY, isManualResult, isManualPct, manualKey, loadManualValues, normalizeManualPct, applyManualToSummary };
