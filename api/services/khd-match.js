// จับคู่ตัวชี้วัดของระบบ (kpi_indicators) กับรายงาน KHD ของปีงบ (24 พ.ย. 2569 — ผู้ใช้สั่ง)
// ตารางหลัก = KHD report_fiscal_year_config ของปีงบ (ค่าตั้งต้น = ปีงบปัจจุบัน) JOIN reports ด้วย report_id
//   เฉพาะ reports.data_source = 'excel' (= key_in ของระบบ — 24 พ.ย. 2569 ผู้ใช้สั่ง; รายงาน hdc ไม่นำมาเทียบ)
// คีย์จับคู่ = report_id ของ KHD (reports.report_id = report_fiscal_year_config.report_id) ↔ kpi_indicators.kpi_indicators_id ("รหัสอ้างอิง") **อย่างเดียว**
//   (26 พ.ย. 2569 ผู้ใช้สั่ง — report_id ไม่ซ้ำกัน แต่ table_process ซ้ำกันได้: หลายตัวชี้วัด/รายงานใช้ตารางส่งออกเดียวกัน จึงห้ามใช้ table_process/ชื่อเป็นคีย์)
//   ตัวชี้วัดที่รหัสอ้างอิงยังไม่ตรง = ไม่จับคู่ (ไม่เทียบหัวข้ออื่น) แต่มี "รหัสที่แนะนำ" (suggestions) จาก khd_report_id → ชื่อที่ตรงกันรายการเดียว ให้กด "ใช้รหัส KHD"
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
 * จับคู่ (ฟังก์ชันล้วน) — รหัสอ้างอิง (kpi_indicators_id) = report_id เท่านั้น, ตัวชี้วัด 1 ตัว = รายงาน 1 รายการ
 * (รหัสเดียวกันหลายตัว — กันไว้ที่ apply-khd-ref แล้ว — ตัวที่ id น้อยได้คู่ ที่เหลือ refTaken)
 * → { pairs: [{ khd, local, match_by: 'kpi_indicators_id', ref_match, link_match, ref_conflict, name_match, tp_match }],
 *     unmatchedKhd, unmatchedLocals, suggestions: Map(local → { khd, by: 'khd_report_id' | 'name' }), refTaken: Map(local → local ที่ได้คู่) }
 *   ref_conflict = khd_report_id ชี้รายงานอื่นของปีงบ (ลิงก์เก่าค้าง) | table_process ไม่ใช้จับคู่ (tp_match = ข้อมูลประกอบเท่านั้น)
 */
function matchLocalsToKhd(locals, khdRows) {
    const ls = [...(locals || [])].sort((a, b) => Number(a.id) - Number(b.id));
    const byRid = new Map();
    for (const k of khdRows || []) byRid.set(Number(k.report_id), k);
    const khdOf = new Map(), localOf = new Map(), refTaken = new Map();
    for (const l of ls) {
        const id = refOf(l);
        const k = id === null ? null : byRid.get(id);
        if (!k) continue;
        if (localOf.has(k)) { refTaken.set(l, localOf.get(k)); continue; }
        khdOf.set(l, k); localOf.set(k, l);
    }
    const pairs = [];
    for (const l of ls) {
        const k = khdOf.get(l);
        if (!k) continue;
        const rid = Number(k.report_id), link = linkOf(l);
        pairs.push({
            khd: k, local: l, match_by: 'kpi_indicators_id',
            ref_match: true, link_match: link === rid,
            ref_conflict: link !== null && link !== rid && byRid.has(link),
            name_match: normName(k.report_name) === normName(l.kpi_indicators_name),
            tp_match: tpOf(k.table_process) === tpOf(l.table_process),
        });
    }
    const unmatchedKhd = (khdRows || []).filter(k => !localOf.has(k));
    const unmatchedLocals = ls.filter(l => !khdOf.has(l));
    // รหัสที่แนะนำ (ยังไม่จับคู่ — ผู้ดูแลกด "ใช้รหัส KHD" ก่อน): khd_report_id เดิม → ชื่อตรงกันรายการเดียวทั้ง 2 ฝั่ง | ไม่ใช้ table_process
    const suggestions = new Map(), used = new Set();
    for (const l of unmatchedLocals) {
        if (refTaken.has(l)) continue;
        const k = byRid.get(linkOf(l));
        if (k && !localOf.has(k) && !used.has(k)) { suggestions.set(l, { khd: k, by: 'khd_report_id' }); used.add(k); }
    }
    const nameCount = (arr, f) => { const m = new Map(); for (const x of arr) { const n = normName(f(x)); if (n) m.set(n, (m.get(n) || 0) + 1); } return m; };
    const freeKhd = unmatchedKhd.filter(k => !used.has(k));
    const freeLocals = unmatchedLocals.filter(l => !suggestions.has(l) && !refTaken.has(l));
    const kn = nameCount(freeKhd, k => k.report_name), ln = nameCount(freeLocals, l => l.kpi_indicators_name);
    for (const l of freeLocals) {
        const n = normName(l.kpi_indicators_name);
        if (!n || kn.get(n) !== 1 || ln.get(n) !== 1) continue;
        suggestions.set(l, { khd: freeKhd.find(k => normName(k.report_name) === n), by: 'name' });
    }
    return { pairs, unmatchedKhd, unmatchedLocals, suggestions, refTaken };
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

/** ใช้รหัส KHD: ตัวชี้วัดที่เลือก → Map(local.id → { khd, by }) = คู่ที่ลิงก์ khd_report_id ไม่ตรง + รหัสที่แนะนำ (จับคู่กับตัวชี้วัดทั้งระบบ) */
async function findRefTargets(remote, db, ids, yearBh) {
    const { khdRows } = await loadKhdYearReports(remote, yearBh);
    const [all] = await db.query('SELECT id, kpi_indicators_name, kpi_indicators_id, khd_report_id, table_process FROM kpi_indicators');
    const want = new Set((ids || []).map(Number));
    const m = matchLocalsToKhd(all, khdRows), out = new Map();
    for (const p of m.pairs) if (want.has(Number(p.local.id))) out.set(Number(p.local.id), { khd: p.khd, by: 'kpi_indicators_id' });
    for (const [l, s] of m.suggestions) if (want.has(Number(l.id))) out.set(Number(l.id), s);
    for (const [l, owner] of m.refTaken) if (want.has(Number(l.id))) out.set(Number(l.id), { taken_by: owner });
    return out;
}

module.exports = { loadKhdYearReports, matchLocalsToKhd, findKhdForLocals, findRefTargets, refOf, linkOf, normName, normCode, notInYearReason, YEAR_REPORTS_SQL };
