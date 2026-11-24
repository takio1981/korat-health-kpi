// จับคู่ตัวชี้วัดของระบบ (kpi_indicators) กับรายงาน KHD ของปีงบ (24 พ.ย. 2569 — ผู้ใช้สั่ง)
// ตารางหลัก = KHD report_fiscal_year_config ของปีงบ (ค่าตั้งต้น = ปีงบปัจจุบัน) JOIN reports ด้วย report_id
//   เฉพาะ reports.data_source = 'excel' (= key_in ของระบบ — 24 พ.ย. 2569 ผู้ใช้สั่ง; รายงาน hdc ไม่นำมาเทียบ)
// ลำดับจับคู่ (ตัวชี้วัด 1 ตัว = รายงาน 1 รายการ): kpi_indicators_id ("รหัสอ้างอิง") = report_id → khd_report_id = report_id → table_process เดียวกัน
//   (ชื่อเดียวกันแต่ table_process ต่าง = pairByNameDifferentTp ใน routes/khd.js ขั้นสุดท้าย)
// ใช้ร่วมกันทั้ง GET /report-compare และทุกปุ่มปรับค่า (apply-khd-*) — ห้ามจับคู่ด้วย table_process แยกเองในเส้นทางใหม่

const normName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const normCode = (s) => String(s ?? '').trim().toLowerCase().replace(/-/g, '_');
const tpOf = (v) => String(v ?? '').trim();
/** "รหัสอ้างอิง" ของตัวชี้วัด → เลข report_id | null (ว่าง/ไม่ใช่ตัวเลข) */
function refOf(local) {
    const v = String(local?.kpi_indicators_id ?? '').trim();
    return /^\d+$/.test(v) ? Number(v) : null;
}
const linkOf = (local) => (local?.khd_report_id === null || local?.khd_report_id === undefined || local?.khd_report_id === '' ? null : Number(local.khd_report_id));

const FY_COLS = ['target_percentage', 'target_condition', 'is_active', 'r9', 'moph', 'ssj', 'rmw'];
const YEAR_REPORTS_SQL = `SELECT r.*, f.fiscal_year AS fy_fiscal_year, ${FY_COLS.map(c => `f.${c} AS fy_${c}`).join(', ')}
     FROM report_fiscal_year_config f JOIN reports r ON r.report_id = f.report_id
     WHERE f.fiscal_year = ? AND r.data_source = 'excel' ORDER BY r.report_id`;

/**
 * รายงาน KHD ของปีงบ → { khdRows (แถว reports), fyConfigMap: Map(report_id → ค่าของปีงบ รูปเดียวกับแถว report_fiscal_year_config) }
 * (คอลัมน์ชื่อซ้ำ 2 ตาราง — แยกด้วย alias fy_*)
 */
async function loadKhdYearReports(remote, yearBh) {
    const [rows] = await remote.query(YEAR_REPORTS_SQL, [String(yearBh)]);
    const khdRows = [], fyConfigMap = new Map();
    for (const row of rows) {
        const r = {}, fy = { report_id: row.report_id, fiscal_year: row.fy_fiscal_year };
        for (const [k, v] of Object.entries(row)) {
            if (k.startsWith('fy_')) { if (k !== 'fy_fiscal_year') fy[k.slice(3)] = v; } else r[k] = v;
        }
        khdRows.push(r);
        fyConfigMap.set(row.report_id, fy);
    }
    return { khdRows, fyConfigMap };
}

/**
 * จับคู่ (ฟังก์ชันล้วน) — locals เรียงตาม id ก่อน (ตัวที่เก่ากว่าได้สิทธิ์ก่อนเมื่อชี้รายงานเดียวกัน)
 * → { pairs: [{ khd, local, match_by, ref_match, link_match, ref_conflict, name_match, tp_match }], unmatchedKhd, unmatchedLocals }
 *   ref_conflict = รหัสอ้างอิงกับ khd_report_id ชี้คนละรายงานที่อยู่ในปีงบทั้งคู่
 */
function matchLocalsToKhd(locals, khdRows) {
    const ls = [...(locals || [])].sort((a, b) => Number(a.id) - Number(b.id));
    const byRid = new Map();
    for (const k of khdRows || []) byRid.set(Number(k.report_id), k);
    const khdOf = new Map(), localOf = new Map(), by = new Map();
    const claim = (l, k, how) => { khdOf.set(l, k); localOf.set(k, l); by.set(l, how); };
    // 1) รหัสอ้างอิง 2) khd_report_id
    for (const [how, get] of [['kpi_indicators_id', refOf], ['khd_report_id', linkOf]]) {
        for (const l of ls) {
            if (khdOf.has(l)) continue;
            const id = get(l);
            const k = id === null ? null : byRid.get(id);
            if (k && !localOf.has(k)) claim(l, k, how);
        }
    }
    // 3) table_process เดียวกัน — KHD หลายรายงานใช้ table_process ร่วมกันได้: ชื่อตรง (+ รหัสรายงานตรง) → รหัสรายงานตรง → รายการท้ายสุด (พฤติกรรมเดิม)
    const byTp = new Map();
    for (const k of khdRows || []) {
        const tp = tpOf(k.table_process);
        if (!tp || localOf.has(k)) continue;
        if (!byTp.has(tp)) byTp.set(tp, []);
        byTp.get(tp).push(k);
    }
    for (const l of ls) {
        const tp = tpOf(l.table_process);
        if (khdOf.has(l) || !tp) continue;
        const rows = (byTp.get(tp) || []).filter(k => !localOf.has(k));
        if (!rows.length) continue;
        const named = rows.filter(k => normName(k.report_name) === normName(l.kpi_indicators_name));
        const code = (r) => normCode(r.report_code) === normCode(tp);
        claim(l, named.find(code) || named[0] || rows.find(code) || rows[rows.length - 1], 'table_process');
    }
    const pairs = [];
    for (const l of ls) {
        const k = khdOf.get(l);
        if (!k) continue;
        const rid = Number(k.report_id), ref = refOf(l), link = linkOf(l);
        pairs.push({
            khd: k, local: l, match_by: by.get(l),
            ref_match: ref === rid, link_match: link === rid,
            ref_conflict: ref !== null && link !== null && ref !== link && byRid.has(ref) && byRid.has(link),
            name_match: normName(k.report_name) === normName(l.kpi_indicators_name),
            tp_match: tpOf(k.table_process) === tpOf(l.table_process),
        });
    }
    return {
        pairs,
        unmatchedKhd: (khdRows || []).filter(k => !localOf.has(k)),
        unmatchedLocals: ls.filter(l => !khdOf.has(l)),
    };
}

/**
 * สำหรับปุ่มปรับค่า: ตัวชี้วัดที่เลือก → Map(local.id → { khd, fy, match_by }) ของรายงาน KHD ปีงบ yearBh
 * จับคู่กับตัวชี้วัด**ทั้งระบบ** (ไม่ใช่เฉพาะที่เลือก) — ให้ผลเดียวกับ GET /report-compare (ตัวที่เลือกอาจแพ้ตัวอื่นที่ชี้รายงานเดียวกัน)
 */
async function findKhdForLocals(remote, db, ids, yearBh) {
    const { khdRows, fyConfigMap } = await loadKhdYearReports(remote, yearBh);
    const [all] = await db.query('SELECT id, kpi_indicators_name, kpi_indicators_id, khd_report_id, table_process FROM kpi_indicators');
    const want = new Set((ids || []).map(Number));
    const out = new Map();
    for (const p of matchLocalsToKhd(all, khdRows).pairs) {
        if (want.has(Number(p.local.id))) out.set(Number(p.local.id), { khd: p.khd, fy: fyConfigMap.get(p.khd.report_id) || null, match_by: p.match_by, pair: p });
    }
    return out;
}

const notInYearReason = (yearBh) => `ไม่อยู่ในปีงบ ${yearBh} ของ KHD`;

module.exports = { loadKhdYearReports, matchLocalsToKhd, findKhdForLocals, refOf, linkOf, normName, normCode, notInYearReason, YEAR_REPORTS_SQL };
