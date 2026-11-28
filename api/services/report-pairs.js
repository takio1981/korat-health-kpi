// รายงานสรุปผล: คู่ตัวชี้วัด × หน่วยบริการ "ที่ต้องกรอก" ทั้งหมด (28 พ.ย. 2569 — ผู้ใช้สั่ง)
// ยอดรวมเป้าหมาย/ผลงาน/ร้อยละของทุกแถบ = ทุกหน่วยบริการที่ถูกเพิ่มตัวชี้วัดแล้ว (มีแถวใน kpi_results ของปีงบนั้น) ทั้งที่มีผลงานและยังไม่มี
//   - มีผลงาน      = แถวใน kpi_summary (คำนวณผลงานล่าสุด/สะสม/สูตร/กรอกเอง/ข้อย่อย/เป้าหมายรายเดือนไว้แล้ว)
//   - ยังไม่มีผลงาน = คู่ใน kpi_results ที่ไม่มีแถวใน kpi_summary (summary เก็บเฉพาะคู่ที่มีผลงาน) → ผลงาน = ว่าง (นับ 0)
//     เป้าหมาย: target_monthly 'cumulative' = รวมเป้าทุกเดือน | 'latest' = เป้าเดือนสุดท้ายที่มีค่า (กติกา aggregateMonthlyTarget เมื่อยังไม่มีผลงาน)
//               นอกนั้น = ค่าสูงสุด (เป้าหมายเดียวทั้งปี) — เป้าหมายที่ไม่ใช่ตัวเลข = ไม่นับ
// ใช้: FROM ${src.sql} s — คอลัมน์ชื่อเดียวกับ kpi_summary (+ is_recorded) เงื่อนไขขอบเขต/ตัวกรองเดิม (s.dept_id, s.distid, s.hostype, s.hospcode …) ใช้ได้ตรง
// ⚠️ params ของ src ต้องมาก่อน params ของ WHERE: db.query(sql, [...src.params, ...params])

const NUM = (col) => `TRIM(${col}) REGEXP '^-{0,1}[0-9]+([.][0-9]+){0,1}$'`;
// ⚠️ chospital/co_district เป็น utf8mb3_general_ci (kpi_* เป็น utf8mb4_unicode_ci) — UNION ต้องแปลงให้ตรงกัน ไม่งั้น 'Illegal mix of collations'
const U = (x) => `CONVERT(${x} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;
const MONTHS = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];

/** แหล่งข้อมูลคู่ที่ต้องกรอก — year = ปีงบ (ไม่ส่ง = ทุกปี เช่น แถบรายปีงบ) */
function reportPairsSql(year) {
    const yS = year ? 'WHERE s.year_bh = ?' : '';
    const yR = year ? 'r.year_bh = ? AND' : '';
    const params = year ? [String(year), String(year)] : [];
    const tNum = NUM('r.target_value');
    const sql = `(
        SELECT s.indicator_id, s.year_bh, s.hospcode, s.kpi_indicators_name, s.main_indicator_name, s.dept_id, s.dept_name,
               s.hosname, s.distid, s.distname, s.hostype, s.target_value, s.last_actual, ${MONTHS.map(m => 's.' + m).join(', ')},
               s.pending_count, s.indicator_status, s.is_locked, s.manual_pct, 1 AS is_recorded
        FROM kpi_summary s ${yS}
        UNION ALL
        SELECT u.indicator_id, u.year_bh, u.hospcode, i.kpi_indicators_name, mi.main_indicator_name, i.dept_id, d.dept_name,
               ${U('h.hosname')} AS hosname, ${U('h.distid')} AS distid, ${U('cd.distname')} AS distname, ${U('h.hostype')} AS hostype, ${U('u.target_value')} AS target_value, NULL AS last_actual, ${MONTHS.map(m => 'NULL AS ' + m).join(', ')},
               0 AS pending_count, u.indicator_status, u.is_locked, NULL AS manual_pct, 0 AS is_recorded
        FROM (
            SELECT r.indicator_id, r.year_bh, r.hospcode,
                   CASE MAX(ri.target_monthly)
                     WHEN 'cumulative' THEN CAST(SUM(CASE WHEN ${tNum} THEN CAST(r.target_value AS DECIMAL(20,4)) END) AS CHAR)
                     WHEN 'latest' THEN SUBSTRING_INDEX(GROUP_CONCAT(CASE WHEN ${tNum} THEN TRIM(r.target_value) END
                                          ORDER BY MOD(CAST(r.month_bh AS UNSIGNED) + 2, 12) DESC SEPARATOR '|'), '|', 1)
                     ELSE CAST(MAX(CASE WHEN ${tNum} THEN CAST(r.target_value AS DECIMAL(20,4)) END) AS CHAR)
                   END AS target_value,
                   MIN(r.status) AS indicator_status, MIN(r.is_locked) AS is_locked
            FROM kpi_results r
            JOIN kpi_indicators ri ON ri.id = r.indicator_id
            WHERE ${yR} NOT EXISTS (SELECT 1 FROM kpi_summary s2 WHERE s2.indicator_id = r.indicator_id AND s2.year_bh = r.year_bh AND s2.hospcode = r.hospcode)
            GROUP BY r.indicator_id, r.year_bh, r.hospcode
        ) u
        JOIN kpi_indicators i ON i.id = u.indicator_id
        LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
        LEFT JOIN departments d ON d.id = i.dept_id
        LEFT JOIN chospital h ON h.hoscode = CONVERT(u.hospcode USING utf8mb3) COLLATE utf8mb3_general_ci
        LEFT JOIN co_district cd ON cd.distid = h.distid
    )`;
    return { sql, params };
}

/** SQL ยอดรวม (ใช้ใน SELECT ของทุกแถบ) — alias s = reportPairsSql */
const SUM_TARGET = `SUM(CASE WHEN ${NUM('s.target_value')} THEN CAST(s.target_value AS DECIMAL(20,4)) ELSE 0 END)`;
const SUM_ACTUAL = `SUM(CASE WHEN ${NUM('s.last_actual')} THEN CAST(s.last_actual AS DECIMAL(20,4)) ELSE 0 END)`;
/** ร้อยละ = ผลงานรวม ÷ เป้าหมายรวม × 100 (เป้าหมายรวม 0 = 0) — ไม่ใช่ร้อยละผ่านเกณฑ์ */
const RATIO_PCT = `CASE WHEN ${SUM_TARGET} = 0 THEN 0 ELSE ROUND(${SUM_ACTUAL} / ${SUM_TARGET} * 100, 2) END`;
/** มีผลงานแล้ว (ค่า 0 นับเป็นผลงาน) */
const RECORDED = `(s.is_recorded = 1 AND NULLIF(TRIM(s.last_actual), '') IS NOT NULL)`;

module.exports = { reportPairsSql, SUM_TARGET, SUM_ACTUAL, RATIO_PCT, RECORDED, NUM };
