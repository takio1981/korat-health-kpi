/**
 * ปลดล็อคเดือนที่ยังไม่มีผลงานหลังเดือนล่าสุด (เครื่องมือ super_admin ในศูนย์งานผู้ดูแล — 22 พ.ย. 2569)
 *
 * ที่มา: ก่อนมีการอนุมัติรายเดือน การอนุมัติล็อคทั้ง 12 เดือนของคู่ตัวชี้วัด × หน่วยบริการ → หน่วยบริการบันทึกเดือนถัดไปไม่ได้
 * เครื่องมือนี้ปลดล็อคเฉพาะ "เดือนที่ล็อคอยู่ ผลงานว่าง และอยู่หลังเดือนล่าสุดที่มีผลงาน" (นับผลงานข้อย่อย/กิจกรรมด้วย)
 *   - เดือนที่มีผลงานและเดือนว่างก่อนเดือนล่าสุด (ยืนยันว่าไม่มีข้อมูลตอนอนุมัติ) คงล็อค — ผลงานที่อนุมัติแล้วไม่เปลี่ยน
 *   - ข้ามคู่ที่ผลงาน/ร้อยละกรอกเอง (ระดับปี — อนุมัติทั้งปีตามกติกา) และเดือนที่อยู่ระหว่างอุทธรณ์
 *   - ไม่แก้อัตโนมัติ: ต้องดูตัวอย่างก่อน แล้วพิมพ์ปีงบยืนยัน (ผู้ใช้เลือกในแผน)
 */
const db = require('../db');
const { FISCAL_ORD_SQL, fiscalOrd, MONTH_TH } = require('./review-status');

const blankSql = (a) => `TRIM(COALESCE(${a}.actual_value, '')) = ''`;
const filledSql = (a) => `TRIM(COALESCE(${a}.actual_value, '')) <> ''`;
const key = (ind, hc) => `${Number(ind)}|${String(hc).trim()}`;

/** คู่ที่มีเดือนต้องปลดล็อค → [{ indicator_id, hospcode, months: [เลขเดือน] }] (เรียงตามลำดับปีงบ) */
async function findLockedFutureMonths(yearBh, conn = db) {
    const y = String(yearBh);
    const [rows] = await conn.query(
        `SELECT r.indicator_id, r.hospcode,
                MAX(CASE WHEN ${filledSql('r')} THEN ${FISCAL_ORD_SQL('r.month_bh')} ELSE 0 END) AS last_ord,
                GROUP_CONCAT(CASE WHEN r.is_locked = 1 AND COALESCE(r.status, '') <> 'Appeal' AND ${blankSql('r')} THEN r.month_bh END) AS locked_empty
         FROM kpi_results r JOIN kpi_indicators i ON i.id = r.indicator_id
         WHERE r.year_bh = ? AND i.is_active = 1
         GROUP BY r.indicator_id, r.hospcode
         HAVING locked_empty IS NOT NULL`, [y]);
    if (!rows.length) return [];
    const indIds = [...new Set(rows.map(r => Number(r.indicator_id)))];
    // ผลงานข้อย่อย/กิจกรรม: เดือนล่าสุดต่อคู่ (ตัวชี้วัดหลายระดับบันทึกที่ระดับล่าง แถวหลักอาจว่าง)
    const [subs] = await conn.query(
        `SELECT si.indicator_id, sr.hospcode, MAX(${FISCAL_ORD_SQL('sr.month_bh')}) AS o
         FROM kpi_sub_results sr JOIN kpi_sub_indicators si ON si.id = sr.sub_indicator_id
         WHERE sr.year_bh = ? AND si.indicator_id IN (?) AND ${filledSql('sr')} GROUP BY si.indicator_id, sr.hospcode
         UNION ALL
         SELECT si.indicator_id, ar.hospcode, MAX(${FISCAL_ORD_SQL('ar.month_bh')})
         FROM kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id
         WHERE ar.year_bh = ? AND si.indicator_id IN (?) AND ${filledSql('ar')} GROUP BY si.indicator_id, ar.hospcode`,
        [y, indIds, y, indIds]);
    const subLast = new Map();
    for (const s of subs) {
        const k = key(s.indicator_id, s.hospcode);
        subLast.set(k, Math.max(subLast.get(k) || 0, Number(s.o) || 0));
    }
    // ผลงาน/ร้อยละกรอกเอง = อนุมัติทั้งปีตามกติกา → ไม่แตะ
    const [manual] = await conn.query(
        `SELECT DISTINCT indicator_id, hospcode FROM kpi_base_values
         WHERE year_bh = ? AND indicator_id IN (?) AND var_key IN ('__result', '__pct') AND TRIM(COALESCE(base_value, '')) <> ''`,
        [y, indIds]);
    const manualSet = new Set(manual.map(m => key(m.indicator_id, m.hospcode)));
    const out = [];
    for (const r of rows) {
        const k = key(r.indicator_id, r.hospcode);
        if (manualSet.has(k)) continue;
        const last = Math.max(Number(r.last_ord) || 0, subLast.get(k) || 0);
        const months = String(r.locked_empty).split(',').map(Number).filter(m => m >= 1 && m <= 12 && fiscalOrd(m) > last);
        if (!months.length) continue;
        months.sort((a, b) => fiscalOrd(a) - fiscalOrd(b));
        out.push({ indicator_id: Number(r.indicator_id), hospcode: String(r.hospcode).trim(), months: [...new Set(months)] });
    }
    return out;
}

/** สรุปสำหรับหน้าจอ (ตัวอย่างก่อนยืนยัน) */
async function summarizeLockedFuture(yearBh, pairs) {
    const byInd = new Map();
    for (const p of pairs) {
        if (!byInd.has(p.indicator_id)) byInd.set(p.indicator_id, { indicator_id: p.indicator_id, pairs: 0, months: 0 });
        const g = byInd.get(p.indicator_id);
        g.pairs++; g.months += p.months.length;
    }
    const top = [...byInd.values()].sort((a, b) => b.pairs - a.pairs).slice(0, 20);
    if (top.length) {
        const [names] = await db.query('SELECT id, kpi_indicators_name FROM kpi_indicators WHERE id IN (?)', [top.map(t => t.indicator_id)]);
        const nm = new Map(names.map(n => [Number(n.id), n.kpi_indicators_name]));
        for (const t of top) t.indicator_name = nm.get(t.indicator_id) || `ตัวชี้วัด #${t.indicator_id}`;
    }
    // เดือนที่พบมากสุด (ให้ผู้ดูแลเห็นภาพ เช่น "พ.ค.–ก.ย.")
    const monthCount = {};
    for (const p of pairs) for (const m of p.months) monthCount[m] = (monthCount[m] || 0) + 1;
    return {
        year_bh: String(yearBh),
        pairs: pairs.length,
        months: pairs.reduce((s, p) => s + p.months.length, 0),
        indicators: byInd.size,
        hospitals: new Set(pairs.map(p => p.hospcode)).size,
        by_month: [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(m => monthCount[m]).map(m => ({ month_bh: m, label: MONTH_TH[m], pairs: monthCount[m] })),
        by_indicator: top,
    };
}

/** ปลดล็อคจริง (ธุรกรรมเดียว) — คำนวณรายการใหม่ภายในธุรกรรม ไม่รับรายการจาก client → { pairs, months, indicator_years } */
async function unlockFutureMonths(yearBh) {
    const y = String(yearBh);
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const pairs = await findLockedFutureMonths(y, conn);
        // รวมคำสั่งตาม (ตัวชี้วัด, ชุดเดือน) — หน่วยบริการชุดละ ≤ 500
        const groups = new Map();
        for (const p of pairs) {
            const g = `${p.indicator_id}|${p.months.join(',')}`;
            if (!groups.has(g)) groups.set(g, { indicator_id: p.indicator_id, months: p.months, hospcodes: [] });
            groups.get(g).hospcodes.push(p.hospcode);
        }
        let monthsUnlocked = 0;
        for (const g of groups.values()) {
            for (let i = 0; i < g.hospcodes.length; i += 500) {
                const hcs = g.hospcodes.slice(i, i + 500);
                const [u] = await conn.query(
                    `UPDATE kpi_results SET is_locked = 0, status = 'Pending'
                     WHERE indicator_id = ? AND year_bh = ? AND hospcode IN (?) AND month_bh IN (?)
                       AND is_locked = 1 AND COALESCE(status, '') <> 'Appeal' AND ${blankSql('kpi_results')}`,
                    [g.indicator_id, y, hcs, g.months]);
                monthsUnlocked += u.affectedRows;
                // ข้อย่อย/กิจกรรมของเดือนเดียวกัน (ว่างอยู่แล้ว — เดือนที่ระดับล่างมีผลงานไม่อยู่ในชุดนี้)
                await conn.query(
                    `UPDATE kpi_sub_results sr JOIN kpi_sub_indicators si ON si.id = sr.sub_indicator_id
                     SET sr.is_locked = 0, sr.status = 'Pending'
                     WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode IN (?) AND sr.month_bh IN (?) AND sr.is_locked = 1 AND ${blankSql('sr')}`,
                    [g.indicator_id, y, hcs, g.months]);
                await conn.query(
                    `UPDATE kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id
                     SET ar.is_locked = 0, ar.status = 'Pending'
                     WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode IN (?) AND ar.month_bh IN (?) AND ar.is_locked = 1 AND ${blankSql('ar')}`,
                    [g.indicator_id, y, hcs, g.months]);
            }
        }
        await conn.commit();
        const indicatorYears = [...new Set(pairs.map(p => p.indicator_id))].map(id => ({ indicator_id: id, year_bh: y }));
        return { pairs: pairs.length, months: monthsUnlocked, hospitals: new Set(pairs.map(p => p.hospcode)).size, indicator_years: indicatorYears };
    } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
    } finally {
        conn.release();
    }
}

module.exports = { findLockedFutureMonths, summarizeLockedFuture, unlockFutureMonths };
