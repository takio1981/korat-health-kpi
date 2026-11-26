// เส้นทาง: เทียบตัวชี้วัดกับ KHD (report-compare), ใช้เกณฑ์ KHD, จับคู่ข้อมูล KHD
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const khdMapping = require('../khd-mapping');
const { _actorLabel } = require('../services/indicator-fields');
const { apiRouter } = require('../core/router');
const { currentFiscalYear } = require('../core/fiscal-year');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { insertIndicatorFromKhd, loadKhdResolver, listKhdMappings, KHD_MAP_COLUMN } = require('../services/khd');
const { getRemotePool } = require('../db-remote');
const { notifyLineAction } = require('../core/notify');
const { requireAction } = require('../core/access');
const { compareKhdTypes, khdTypeUpdate, khdIndicatorTypes, hostypeSetting } = require('../services/khd-types');
const { isValidIdentifier } = require('../core/sql');
const { compareFiscalYears, buildKhdFiscalYearMap, normalizeFiscalYears, invalidFiscalYears } = require('../services/fiscal-years');
const { compareKhdOrg, khdOrgUpdate, KHD_ORG_PARTS } = require('../services/khd-org');
const { scheduleSummaryRefresh } = require('../services/summary');
const { loadKhdYearReports, matchLocalsToKhd, findKhdForLocals, findRefTargets, refOf, linkOf, notInYearReason } = require('../services/khd-match');

// === Test Telegram (super_admin) ===
// ============================================================
// === Structure Compare: Local DB vs Remote KHD DB ===
// ============================================================

// GET /report-compare — เปรียบเทียบรายงาน KHD ของปีงบ (report_fiscal_year_config JOIN reports, key_in) กับ kpi_indicators
// คีย์ = report_id ↔ kpi_indicators_id ("รหัสอ้างอิง") อย่างเดียว (26 พ.ย. 2569) — table_process ซ้ำกันได้ จึงไม่ใช้จับคู่ (services/khd-match.js)
const normCode = (s) => String(s ?? '').trim().toLowerCase().replace(/-/g, '_');

apiRouter.get('/report-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        // ปีงบประมาณที่ใช้เทียบเกณฑ์ — จาก query param หรือ default ปีงบปัจจุบัน (ต.ค. ขึ้นปีใหม่)
        const currentFY = String(currentFiscalYear()); // เวลาไทย (core/fiscal-year)
        const year_bh = req.query.year_bh ? String(req.query.year_bh) : currentFY;

        // ตารางหลัก = รายงานของปีงบใน KHD report_fiscal_year_config JOIN reports (24 พ.ย. 2569) — เฉพาะ data_source = 'excel' (key_in)
        // เดิม: reports ทั้งหมดเฉพาะ excel + LENGTH(report_code) = LENGTH(table_process) จับคู่ด้วย table_process (เห็นรายงานทุกปีปนกัน)
        const { khdRows, fyConfigMap } = await loadKhdYearReports(remoteDb, year_bh);
        // ปีงบทั้งหมดที่ KHD ตั้งค่าไว้ให้แต่ละรายงาน (เทียบกับปีงบของตัวชี้วัด — 9 พ.ย. 2569)
        const [fyAllRows] = await remoteDb.query('SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config');
        const khdYearsMap = buildKhdFiscalYearMap(fyAllRows);

        // ดึง kpi_indicators จาก Local (เพิ่ม dept_id, main_indicator_id, upload_excel, เกณฑ์ + data_source/khd_report_id เพื่อ frontend)
        const [localRows] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process, i.kpi_indicators_code, i.kpi_indicators_id, i.is_active,
                   i.dept_id, i.main_indicator_id, i.upload_excel,
                   i.criterion, i.target_condition, i.data_source, i.khd_report_id,
                   i.r9, i.moph, i.ssj, i.rmw, i.other, i.evaluation_mode, i.required_off_types, i.khd_fiscal_year AS local_fy,
                   d.dept_name, mi.main_indicator_name
            FROM kpi_indicators i
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            ORDER BY i.id
        `);
        const khdResolver = await loadKhdResolver(db); // จับคู่หน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ของแถวที่ยังไม่มีใน Local
        // จับคู่: รหัสอ้างอิง (kpi_indicators_id) = report_id อย่างเดียว (services/khd-match.js) — ที่เหลือมีรหัสที่แนะนำ (suggestions)
        const matched = matchLocalsToKhd(localRows, khdRows);
        const khdByTp = new Map();
        khdRows.forEach(r => { const tp = String(r.table_process || '').trim(); if (tp) { if (!khdByTp.has(tp)) khdByTp.set(tp, []); khdByTp.get(tp).push(r); } });
        // ตัวชี้วัดของระบบที่ใช้ table_process เดียวกัน (ข้อมูลประกอบ — ใช้ตารางส่งออกร่วมกันได้)
        const localByTp = new Map();
        localRows.forEach(r => { const tp = String(r.table_process || '').trim(); if (tp) { if (!localByTp.has(tp)) localByTp.set(tp, []); localByTp.get(tp).push(r); } });
        const suggestedFor = new Map();   // รายงาน KHD → ตัวชี้วัดที่แนะนำรหัสนี้
        for (const [l, s] of matched.suggestions) suggestedFor.set(s.khd, l);

        const items = [];
        let match = 0, different = 0, missing_local = 0, missing_remote = 0, criteria_different = 0;
        let khd_inactive_count = 0, suggest_disable_count = 0, types_different = 0, hostype_different = 0, fiscal_year_different = 0;
        let dept_different = 0, main_different = 0, org_unmatched = 0, ref_different = 0, ref_conflict = 0;

        // Helper: ถ้า KHD report inactive (=0) แต่ Local ยัง upload_excel=0 → suggest = ปิด upload_excel
        const computeSuggest = (khdIsActive, localUploadExcel) => {
            const inactive = khdIsActive === 0 || khdIsActive === '0';
            const stillAutoExport = !localUploadExcel || localUploadExcel === 0;
            return inactive && stillAutoExport;
        };

        // Helper: ค่าเกณฑ์ที่ใช้จริง — ใช้ report_fiscal_year_config (ปีที่กำลังเทียบ) ถ้ามี ไม่งั้น fallback ไปที่ reports (base value)
        const getEffectiveKhdCriteria = (khd, fyConfig) => {
            if (fyConfig && fyConfig.target_percentage != null) {
                return { target_percentage: fyConfig.target_percentage, target_condition: fyConfig.target_condition, source: 'fiscal_year_config' };
            }
            return { target_percentage: khd.target_percentage, target_condition: khd.target_condition, source: 'reports' };
        };
        const refFields = (khd, local) => {
            const rid = Number(khd.report_id), ref = refOf(local), link = linkOf(local);
            const conflict = ref !== null && link !== null && ref !== link && fyConfigMap.has(ref) && fyConfigMap.has(link);
            if (conflict) ref_conflict++;
            return { local_kpi_indicators_id: local.kpi_indicators_id ?? null, local_khd_report_id: local.khd_report_id ?? null,
                ref_match: ref === rid, link_match: link === rid, ref_conflict: conflict };
        };

        // ค่าเทียบทุกหัวข้อของคู่ รายงาน KHD × ตัวชี้วัด (ใช้ทั้งคู่ที่จับคู่ด้วยรหัส/table_process และคู่ชื่อเดียวกันแต่ table_process ต่าง)
        const pairFields = (khd, local) => {
            const tp = khd.table_process;
            const fyConfig = fyConfigMap.get(khd.report_id) || null;
            const effective = getEffectiveKhdCriteria(khd, fyConfig);
            const effectiveIsActive = (fyConfig && fyConfig.is_active != null) ? fyConfig.is_active : khd.is_active;
                // criteria_match: เทียบ criterion (numeric-aware) + target_condition — local.criterion คือ "เกณฑ์" จริง (แยกจาก target_percentage/เป้าหมาย แล้ว)
                const pctMatch = Number(effective.target_percentage) === Number(local.criterion)
                    || (effective.target_percentage == null && local.criterion == null);
                const condMatch = String(effective.target_condition || '') === String(local.target_condition || '');
                const criteria_match = pctMatch && condMatch;
                if (!criteria_match) criteria_different++;

                // ประเภทตัวชี้วัด + ประเภทหน่วยบริการ (9 พ.ย. 2569) — services/khd-types.js
                const typeCmp = compareKhdTypes(khd, fyConfig, local);
                if (!typeCmp.types_match) types_different++;
                if (typeCmp.hostype_match === false) hostype_different++;
                const fyCmp = compareFiscalYears(local.local_fy, khdYearsMap.get(khd.report_id));
                if (fyCmp.fiscal_year_match === false) fiscal_year_different++;
                // หน่วยงาน + หมวดหมู่หลัก (11 พ.ย. 2569) — services/khd-org.js (ตัวจับคู่ค่าข้อความ KHD → id ของระบบ)
                const orgCmp = compareKhdOrg(khdResolver, khd, local);
                if (orgCmp.dept_match === false) dept_different++;
                if (orgCmp.main_match === false) main_different++;
                if (orgCmp.khd_dept_status === 'unmatched' || orgCmp.khd_main_status === 'unmatched') org_unmatched++;

                const suggest = computeSuggest(effectiveIsActive, local.upload_excel);
                if (suggest) suggest_disable_count++;
                if (effectiveIsActive === 0 || effectiveIsActive === '0') khd_inactive_count++;
                return {
                    khd_report_id: khd.report_id, khd_name: khd.report_name, khd_dept: khd.dept, khd_main_yut: khd.main_yut,
                    report_code: khd.report_code, table_process: tp, khd_is_active: effectiveIsActive,
                    khd_data_source: khd.data_source,
                    khd_target_percentage: effective.target_percentage, khd_target_condition: effective.target_condition,
                    khd_criteria_source: effective.source, khd_fiscal_year: fyConfig ? year_bh : null,
                    local_id: local.id, local_name: local.kpi_indicators_name, local_dept: local.dept_name,
                    local_dept_id: local.dept_id, local_main_indicator_id: local.main_indicator_id, local_is_active: local.is_active,
                    local_upload_excel: local.upload_excel || 0,
                    local_criterion: local.criterion, local_target_condition: local.target_condition,
                    local_data_source: local.data_source,
                    criteria_match,
                    ...typeCmp,
                    ...fyCmp,
                    ...orgCmp,
                    ...refFields(khd, local),
                    local_main_indicator_name: local.main_indicator_name || null,
                    suggest_disable_upload: suggest
                };
        };

        // คู่ที่จับได้ (รหัสอ้างอิง = report_id)
        for (const p of matched.pairs) {
            const { khd, local } = p;
            const fields = pairFields(khd, local);
            if (p.tp_match) {
                const nameMatch = (khd.report_name || '').trim() === (local.kpi_indicators_name || '').trim();
                if (nameMatch) match++; else different++;
                items.push({ status: nameMatch ? 'match' : 'different', match_by: p.match_by, ...fields });
            } else {
                // จับคู่ด้วยรหัสแต่ table_process ต่างกัน — ปุ่ม "ใช้ table_process ของ KHD" (table_process ใช้ร่วมกับตัวชี้วัดอื่นได้)
                const khdTp = String(khd.table_process || '').trim();
                const sharing = khdTp ? (localByTp.get(khdTp) || []).filter(x => x.id !== local.id) : [];
                items.push({
                    status: 'tp_different', match_by: p.match_by, ...fields, name_match: p.name_match,
                    table_process: local.table_process, khd_table_process: khd.table_process,
                    khd_tp_shared: khdTp && (khdByTp.get(khdTp) || []).length > 1 ? khdByTp.get(khdTp).length : 0,
                    khd_tp_used_by: sharing.length ? { id: sharing[0].id, name: sharing[0].kpi_indicators_name, count: sharing.length } : null,
                    khd_code_matches_tp: normCode(khd.report_code) === normCode(local.table_process),
                });
            }
        }
        // รายงานของปีงบที่ยังไม่มีในระบบ
        for (const khd of matched.unmatchedKhd) {
            const tp = khd.table_process;
            const fyConfig = fyConfigMap.get(khd.report_id) || null;
            const effective = getEffectiveKhdCriteria(khd, fyConfig);
            const effectiveIsActive = (fyConfig && fyConfig.is_active != null) ? fyConfig.is_active : khd.is_active;
            const tpKey = String(tp || '').trim();
            const sharedN = tpKey ? (khdByTp.get(tpKey) || []).length : 0;
            const usedBy = tpKey ? (localByTp.get(tpKey) || [])[0] : null;
            const sug = suggestedFor.get(khd);
            items.push({
                _khd: khd,
                khd_tp_shared: sharedN > 1 ? sharedN : 0,   // จำนวนรายงาน KHD ที่ใช้ table_process เดียวกัน (> 1 = ข้อมูลใน KHD ซ้ำ)
                khd_tp_used_by: usedBy ? { id: usedBy.id, name: usedBy.kpi_indicators_name } : null,
                suggested_for: sug ? { id: sug.id, name: sug.kpi_indicators_name } : null,   // ตัวชี้วัดที่น่าจะเป็นรายงานนี้ (ยังไม่ตั้งรหัสอ้างอิง)
                status: 'missing_local',
                khd_report_id: khd.report_id, khd_name: khd.report_name, khd_dept: khd.dept, khd_main_yut: khd.main_yut,
                khd_main_indicator: khd.main_indicator || null,
                khd_resolved: khdResolver.resolveIndicator(khd),
                // ประเภทตัวชี้วัด/หน่วยบริการของ KHD (แสดงในรายการที่ยังไม่มีใน Local — เพิ่มเข้าระบบแล้วได้ค่าเหล่านี้)
                khd_types: khdIndicatorTypes(khd, fyConfig), khd_eval_mode: hostypeSetting(khd.evaluation_mode, khd.required_off_types).mode,
                khd_off_types: hostypeSetting(khd.evaluation_mode, khd.required_off_types).types,
                khd_fiscal_years: khdYearsMap.get(khd.report_id) || [],
                report_code: khd.report_code, table_process: tp, khd_is_active: effectiveIsActive,
                khd_data_source: khd.data_source,
                khd_target_percentage: effective.target_percentage, khd_target_condition: effective.target_condition,
                khd_criteria_source: effective.source, khd_fiscal_year: fyConfig ? year_bh : null,
                local_id: null, local_name: null,
                local_dept_id: null, local_main_indicator_id: null, local_is_active: null,
                local_upload_excel: null,
                local_criterion: null, local_target_condition: null, local_data_source: null,
                criteria_match: null,
                suggest_disable_upload: false
            });
            if (effectiveIsActive === 0 || effectiveIsActive === '0') khd_inactive_count++;
            missing_local++;
        }
        // ตัวชี้วัดของระบบที่ไม่อยู่ในปีงบนี้ของ KHD (missing_remote) — khd_other_year = ปีงบอื่นที่ KHD ตั้งรายงานตามรหัสอ้างอิง/khd_report_id ไว้
        // ตัวชี้วัด hdc ของระบบ (data_source = 'hdc') ไม่นำมาเทียบ — ไม่ใช่ key_in (ไม่แสดงเป็น "ไม่อยู่ในปีงบ KHD")
        const localHdc = matched.unmatchedLocals.filter(l => String(l.data_source || '').trim().toLowerCase() === 'hdc');
        for (const local of matched.unmatchedLocals) {
            if (localHdc.includes(local)) continue;
            const otherYears = [...new Set([refOf(local), linkOf(local)].filter(x => x !== null).flatMap(id => khdYearsMap.get(id) || []))].sort();
            const sug = matched.suggestions.get(local), taken = matched.refTaken.get(local);
            if (sug) ref_different++;
            items.push({
                _local: local,
                status: 'missing_remote',
                khd_report_id: null, khd_name: null, khd_dept: null, khd_main_yut: null,
                report_code: null, table_process: local.table_process, khd_is_active: null,
                khd_data_source: null, khd_target_percentage: null, khd_target_condition: null,
                khd_criteria_source: null, khd_fiscal_year: null,
                khd_other_year: otherYears,
                // รหัสที่แนะนำ (กด "ใช้รหัส KHD") / รหัสอ้างอิงซ้ำกับตัวชี้วัดอื่นที่ได้คู่แล้ว
                ref_suggest: sug ? { report_id: sug.khd.report_id, report_name: sug.khd.report_name, table_process: sug.khd.table_process || null, by: sug.by } : null,
                ref_taken_by: taken ? { id: taken.id, name: taken.kpi_indicators_name } : null,
                local_id: local.id, local_name: local.kpi_indicators_name, local_dept: local.dept_name,
                local_dept_id: local.dept_id, local_main_indicator_id: local.main_indicator_id, local_is_active: local.is_active,
                local_kpi_indicators_id: local.kpi_indicators_id ?? null, local_khd_report_id: local.khd_report_id ?? null,
                local_upload_excel: local.upload_excel || 0,
                local_criterion: local.criterion, local_target_condition: local.target_condition,
                local_data_source: local.data_source,
                local_fiscal_years: compareFiscalYears(local.local_fy, []).local_fiscal_years,
                criteria_match: null,
                suggest_disable_upload: false
            });
            missing_remote++;
        }
        const tpDiff = items.filter(it => it.status === 'tp_different').length;
        for (const it of items) { delete it._khd; delete it._local; }
        res.json({
            success: true,
            khd_count: khdRows.length, local_count: localRows.length,
            summary: {
                total: items.length, match, different, missing_local, missing_remote, tp_different: tpDiff,
                khd_inactive: khd_inactive_count, suggest_disable: suggest_disable_count,
                criteria_different, types_different, hostype_different, fiscal_year_different,
                dept_different, main_different, org_unmatched, year_bh,
                // ตารางหลัก = รายงานของปีงบใน KHD (24 พ.ย. 2569)
                khd_year_total: khdRows.length,
                khd_year_active: [...fyConfigMap.values()].filter(f => !(f.is_active === 0 || f.is_active === '0')).length,
                by_source: { excel: khdRows.length }, local_hdc_skipped: localHdc.length,
                ref_different, ref_conflict, not_in_year: missing_remote, ref_taken: matched.refTaken.size,
                match_by: matched.pairs.reduce((m, p) => { m[p.match_by] = (m[p.match_by] || 0) + 1; return m; }, {}),
            },
            items
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /indicators/:id/upload-excel — toggle upload_excel (0=auto export, 1=skip)
apiRouter.put('/indicators/:id/upload-excel', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const id = Number(req.params.id);
        const v = req.body?.upload_excel;
        const val = (v === 1 || v === '1' || v === true) ? 1 : 0;
        const [r] = await db.query('UPDATE kpi_indicators SET upload_excel = ? WHERE id = ?', [val, id]);
        if (r.affectedRows === 0) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัด' });
        // LINE notify
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `🔁 เปลี่ยน upload_excel\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${id}\n` +
                `📋 ${val ? '1 = ข้าม export (ลง Excel เอง)' : '0 = ส่งออกอัตโนมัติ'}`
            );
        } catch (_) {}
        res.json({ success: true, id, upload_excel: val, message: val ? 'ตั้งเป็น "ไม่ส่งออกอัตโนมัติ" แล้ว' : 'ตั้งเป็น "ส่งออกอัตโนมัติได้" แล้ว' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/bulk-upload-excel — set upload_excel แบบ batch (ใช้ตอน "ปิดทั้งหมดที่ KHD inactive")
// POST /indicators/apply-khd-criteria — ปรับ "เกณฑ์" (criterion + target_condition) ของตัวชี้วัดให้เท่ากับ KHD (19 ต.ค. 2569)
// body { ids: number[], year_bh } — อ่านเกณฑ์จาก KHD ใหม่ที่ฝั่ง server เสมอ (ไม่เชื่อค่าจาก client) ด้วยการจับคู่เดียวกับ GET /report-compare
// (services/khd-match.js: รายงานของปีงบที่เลือก จับคู่ด้วยรหัสอ้างอิง → khd_report_id → table_process — 24 พ.ย. 2569) และเกณฑ์ของปีงบที่เลือก
// (report_fiscal_year_config ก่อน แล้วจึง reports) — ไม่แตะ "เป้าหมาย" (target_percentage) และข้ามตัวที่ KHD ไม่มีเกณฑ์ (ไม่ล้างค่าเดิม)
apiRouter.post('/indicators/apply-khd-criteria', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    const yearBh = req.body?.year_bh ? String(req.body.year_bh) : String(currentFiscalYear()); // ปีงบปัจจุบัน (เวลาไทย)
    const fmt = (v) => (v === null || v === undefined || String(v).trim() === '') ? null
        : (Number.isFinite(Number(v)) ? String(Number(v)) : String(v).trim());
    try {
        const [locals] = await db.query('SELECT id, kpi_indicators_name, table_process, criterion, target_condition FROM kpi_indicators WHERE id IN (?)', [ids]);
        // จับคู่เดียวกับ GET /report-compare: รายงานของปีงบ (report_fiscal_year_config) ด้วยรหัสอ้างอิง → khd_report_id → table_process (24 พ.ย. 2569)
        const found = await findKhdForLocals(remoteDb, db, ids, yearBh);
        const updated = [], skipped = [];
        for (const l of locals) {
            const m = found.get(Number(l.id));
            if (!m) { skipped.push({ id: l.id, reason: notInYearReason(yearBh) }); continue; }
            const khd = m.khd, fyc = m.fy;
            // ค่าของปีงบ (report_fiscal_year_config) ก่อน แล้วจึง reports — กติกาเดียวกับ getKhdEffectiveCriteriaFor
            const eff = fyc && fyc.target_percentage != null
                ? { target_percentage: fyc.target_percentage, target_condition: fyc.target_condition }
                : { target_percentage: khd.target_percentage, target_condition: khd.target_condition };
            const criterion = fmt(eff.target_percentage);
            const cond = eff.target_condition ? String(eff.target_condition) : null;
            if (criterion === null) { skipped.push({ id: l.id, reason: 'KHD ไม่มีเกณฑ์' }); continue; }
            if (fmt(l.criterion) === criterion && String(l.target_condition || '') === String(cond || '')) { skipped.push({ id: l.id, reason: 'ตรงกันอยู่แล้ว' }); continue; }
            await db.query('UPDATE kpi_indicators SET criterion = ?, target_condition = ? WHERE id = ?', [criterion, cond, l.id]);
            updated.push({ id: l.id, name: l.kpi_indicators_name, before: { criterion: l.criterion, target_condition: l.target_condition }, after: { criterion, target_condition: cond } });
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'APPLY_KHD_CRITERIA', 'kpi_indicators', JSON.stringify({ year_bh: yearBh, updated, skipped }).slice(0, 60000), req.ip]);
        res.json({ success: true, message: `ปรับเกณฑ์ให้เท่ากับ KHD ${updated.length} ตัวชี้วัด` + (skipped.length ? ` (ข้าม ${skipped.length})` : ''), updated, skipped, year_bh: yearBh });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/apply-khd-types — ปรับ "ประเภทตัวชี้วัด" (r9/moph/ssj/rmw/other) และ/หรือ "ประเภทหน่วยบริการ" (evaluation_mode + required_off_types)
// ให้เท่ากับ KHD (9 พ.ย. 2569) — body { ids, year_bh, parts: ['types'|'hostype'] } — server อ่านค่าจาก KHD ใหม่เสมอ (ไม่เชื่อค่าจาก client)
// ด้วยการจับคู่เดียวกับ GET /report-compare + ค่าปีงบ (report_fiscal_year_config) ก่อนค่าทั่วไป | KHD ไม่ได้ตั้งประเภทหน่วยบริการ = ข้าม (ไม่ล้างค่าเดิม)
apiRouter.post('/indicators/apply-khd-types', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    const parts = Array.isArray(req.body?.parts) ? [...new Set(req.body.parts.filter(p => p === 'types' || p === 'hostype'))] : [];
    if (parts.length === 0) return res.status(400).json({ success: false, message: 'กรุณาระบุสิ่งที่จะปรับ (ประเภทตัวชี้วัด / ประเภทหน่วยบริการ)' });
    const yearBh = req.body?.year_bh ? String(req.body.year_bh) : String(currentFiscalYear());
    try {
        const [locals] = await db.query(`SELECT id, kpi_indicators_name, table_process, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types
            FROM kpi_indicators WHERE id IN (?)`, [ids]);
        const found = await findKhdForLocals(remoteDb, db, ids, yearBh);   // จับคู่เดียวกับ GET /report-compare (24 พ.ย. 2569)
        const updated = [], skipped = [];
        let hostypeChanged = false;
        for (const l of locals) {
            const m = found.get(Number(l.id));
            if (!m) { skipped.push({ id: l.id, reason: notInYearReason(yearBh) }); continue; }
            const khd = m.khd, fy = m.fy;
            const cmp = compareKhdTypes(khd, fy, l);
            const set = {};
            if (parts.includes('types') && !cmp.types_match) Object.assign(set, khdTypeUpdate(khd, fy, 'types'));
            if (parts.includes('hostype') && cmp.hostype_match === false) Object.assign(set, khdTypeUpdate(khd, fy, 'hostype'));
            if (!Object.keys(set).length) {
                skipped.push({ id: l.id, reason: parts.includes('hostype') && cmp.hostype_match === null && cmp.types_match ? 'KHD ไม่ได้ตั้งประเภทหน่วยบริการ' : 'ตรงกันอยู่แล้ว' });
                continue;
            }
            const cols = Object.keys(set);
            await db.query(`UPDATE kpi_indicators SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => set[c]), l.id]);
            if ('evaluation_mode' in set) hostypeChanged = true;
            updated.push({ id: l.id, name: l.kpi_indicators_name, before: Object.fromEntries(cols.map(c => [c, l[c]])), after: set });
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'APPLY_KHD_TYPES', 'kpi_indicators', JSON.stringify({ year_bh: yearBh, parts, updated, skipped }).slice(0, 60000), req.ip]);
        const what = parts.map(p => p === 'types' ? 'ประเภทตัวชี้วัด' : 'ประเภทหน่วยบริการ').join(' + ');
        res.json({ success: true, message: `ปรับ${what}ให้เท่ากับ KHD ${updated.length} ตัวชี้วัด` + (skipped.length ? ` (ข้าม ${skipped.length})` : ''),
            updated, skipped, year_bh: yearBh, hostype_changed: hostypeChanged });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/apply-khd-org { ids, parts: ['dept'|'main'] } — ปรับ "หน่วยงาน" (dept_id) และ/หรือ "หมวดหมู่หลัก" (main_indicator_id) ให้ตรงกับ KHD (11 พ.ย. 2569)
// server อ่านค่าจาก KHD ใหม่เสมอ (ไม่เชื่อค่าจาก client) + แปลงด้วยตัวจับคู่เดียวกับ GET /report-compare — KHD ไม่ได้ระบุ / ยังจับคู่ไม่ได้ = ข้าม (ไม่ล้างค่าเดิม)
// ยุทธศาสตร์ตามหมวดหมู่หลักอัตโนมัติ (COALESCE(mi.yut_id, i.main_yut)) | คำนวณตารางสรุปใหม่ (kpi_summary เก็บ dept_id/ชื่อหมวดหมู่ไว้)
apiRouter.post('/indicators/apply-khd-org', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    const parts = Array.isArray(req.body?.parts) ? [...new Set(req.body.parts.filter(p => KHD_ORG_PARTS.includes(p)))] : [];
    if (parts.length === 0) return res.status(400).json({ success: false, message: 'กรุณาระบุสิ่งที่จะปรับ (หน่วยงาน / หมวดหมู่หลัก)' });
    const yearBh = req.body?.year_bh ? String(req.body.year_bh) : String(currentFiscalYear());
    try {
        const [locals] = await db.query('SELECT id, kpi_indicators_name, table_process, dept_id, main_indicator_id FROM kpi_indicators WHERE id IN (?)', [ids]);
        const found = await findKhdForLocals(remoteDb, db, ids, yearBh);   // จับคู่เดียวกับ GET /report-compare (24 พ.ย. 2569)
        const resolver = await loadKhdResolver(db);
        const updated = [], skipped = [];
        for (const l of locals) {
            const m = found.get(Number(l.id));
            if (!m) { skipped.push({ id: l.id, reason: notInYearReason(yearBh) }); continue; }
            const khd = m.khd;
            const { set, reason } = khdOrgUpdate(resolver, khd, l, parts);
            const cols = Object.keys(set);
            if (!cols.length) { skipped.push({ id: l.id, reason }); continue; }
            await db.query(`UPDATE kpi_indicators SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, [...cols.map(c => set[c]), l.id]);
            updated.push({ id: l.id, name: l.kpi_indicators_name, before: Object.fromEntries(cols.map(c => [c, l[c]])), after: set, ...(reason ? { note: reason } : {}) });
        }
        if (updated.length) {
            // ตารางสรุปเก็บหน่วยงาน/ชื่อหมวดหมู่ไว้ (ใช้กรองตามสิทธิ์และในรายงาน) → คำนวณใหม่ทุกปีงบที่มี
            const [pairs] = await db.query('SELECT DISTINCT indicator_id, year_bh FROM kpi_summary WHERE indicator_id IN (?)', [updated.map(u => u.id)]);
            scheduleSummaryRefresh(pairs);
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'APPLY_KHD_ORG', 'kpi_indicators', JSON.stringify({ parts, updated, skipped }).slice(0, 60000), req.ip]);
        const what = parts.map(p => p === 'dept' ? 'หน่วยงาน' : 'หมวดหมู่หลัก').join(' + ');
        res.json({ success: true, message: `ปรับ${what}ให้ตรงกับ KHD ${updated.length} ตัวชี้วัด` + (skipped.length ? ` (ข้าม ${skipped.length})` : ''), updated, skipped });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/apply-khd-fiscal-year { ids } — ปรับ "ปีงบประมาณ" (khd_fiscal_year) ให้เท่ากับปีงบที่ KHD ตั้งค่าไว้ใน report_fiscal_year_config (9 พ.ย. 2569)
// server อ่าน KHD ใหม่เสมอ ด้วยการจับคู่เดียวกับ GET /report-compare | KHD ไม่มีปีงบ = ข้าม (ไม่ล้างค่าเดิม)
apiRouter.post('/indicators/apply-khd-fiscal-year', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    const yearBh = req.body?.year_bh ? String(req.body.year_bh) : String(currentFiscalYear());
    try {
        const [locals] = await db.query('SELECT id, kpi_indicators_name, table_process, khd_fiscal_year FROM kpi_indicators WHERE id IN (?)', [ids]);
        const found = await findKhdForLocals(remoteDb, db, ids, yearBh);   // จับคู่เดียวกับ GET /report-compare (24 พ.ย. 2569)
        let yearsMap = new Map();
        const rids = [...new Set([...found.values()].map(m => m.khd.report_id))];
        if (rids.length) {
            const [fy] = await remoteDb.query('SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config WHERE report_id IN (?)', [rids]);
            yearsMap = buildKhdFiscalYearMap(fy);
        }
        const updated = [], skipped = [];
        for (const l of locals) {
            const m = found.get(Number(l.id));
            if (!m) { skipped.push({ id: l.id, reason: notInYearReason(yearBh) }); continue; }
            const khd = m.khd;
            const cmp = compareFiscalYears(l.khd_fiscal_year, yearsMap.get(khd.report_id));
            if (cmp.fiscal_year_match === null) { skipped.push({ id: l.id, reason: 'KHD ไม่ได้ตั้งปีงบ' }); continue; }
            if (cmp.fiscal_year_match) { skipped.push({ id: l.id, reason: 'ตรงกันอยู่แล้ว' }); continue; }
            const after = cmp.khd_fiscal_years.join(',');
            await db.query('UPDATE kpi_indicators SET khd_fiscal_year = ? WHERE id = ?', [after, l.id]);
            updated.push({ id: l.id, name: l.kpi_indicators_name, before: l.khd_fiscal_year, after });
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'APPLY_KHD_FISCAL_YEAR', 'kpi_indicators', JSON.stringify({ updated, skipped }).slice(0, 60000), req.ip]);
        res.json({ success: true, message: `ปรับปีงบประมาณให้เท่ากับ KHD ${updated.length} ตัวชี้วัด` + (skipped.length ? ` (ข้าม ${skipped.length})` : ''), updated, skipped });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/apply-khd-ref { ids, year_bh } — "ใช้รหัส KHD" (24 พ.ย. 2569): ตั้งรหัสอ้างอิง (kpi_indicators_id) + khd_report_id + data_source
// = รายงาน KHD ของปีงบ: คู่ที่จับได้แล้ว (แก้ลิงก์ khd_report_id ให้ตรง) หรือรหัสที่แนะนำ (findRefTargets — server คำนวณใหม่ ไม่เชื่อค่าจาก client)
// ไม่มีรายงานที่แนะนำ / ตรงอยู่แล้ว / ตัวชี้วัดอื่นใช้รหัสนี้แล้ว = ข้าม (ไม่เขียนทับ)
apiRouter.post('/indicators/apply-khd-ref', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    if (ids.length > 1000) return res.status(400).json({ success: false, message: 'เลือกได้ไม่เกิน 1000 ตัวชี้วัดต่อครั้ง' });
    const yearBh = req.body?.year_bh ? String(req.body.year_bh) : String(currentFiscalYear());
    try {
        const [locals] = await db.query('SELECT id, kpi_indicators_name, kpi_indicators_id, khd_report_id, data_source FROM kpi_indicators WHERE id IN (?)', [ids]);
        const found = await findRefTargets(remoteDb, db, ids, yearBh);
        const updated = [], skipped = [];
        for (const l of locals) {
            const m = found.get(Number(l.id));
            if (m?.taken_by) { skipped.push({ id: l.id, reason: `รหัส ${refOf(l)} ใช้โดยตัวชี้วัด #${m.taken_by.id} แล้ว` }); continue; }
            if (!m) { skipped.push({ id: l.id, reason: `ไม่พบรายงานที่ตรงกันใน KHD ปีงบ ${yearBh} (ตั้งรหัสอ้างอิงเองในหน้าต่างตัวชี้วัด)` }); continue; }
            const rid = Number(m.khd.report_id);
            if (refOf(l) === rid && linkOf(l) === rid) { skipped.push({ id: l.id, reason: 'ตรงกันอยู่แล้ว' }); continue; }
            // กันซ้ำ (ตัวจับคู่ให้รหัสอ้างอิงมาก่อนอยู่แล้ว — เผื่อข้อมูลเปลี่ยนระหว่างคำขอ)
            const [dup] = await db.query("SELECT id FROM kpi_indicators WHERE TRIM(kpi_indicators_id) = ? AND id <> ? LIMIT 1", [String(rid), l.id]);
            if (dup.length) { skipped.push({ id: l.id, reason: `รหัส ${rid} ใช้โดยตัวชี้วัด #${dup[0].id} แล้ว` }); continue; }
            await db.query('UPDATE kpi_indicators SET kpi_indicators_id = ?, khd_report_id = ?, data_source = ? WHERE id = ?',
                [String(rid), rid, m.khd.data_source || null, l.id]);
            updated.push({ id: l.id, name: l.kpi_indicators_name, match_by: m.by,
                before: { kpi_indicators_id: l.kpi_indicators_id, khd_report_id: l.khd_report_id, data_source: l.data_source },
                after: { kpi_indicators_id: String(rid), khd_report_id: rid, data_source: m.khd.data_source || null } });
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'APPLY_KHD_REF', 'kpi_indicators', JSON.stringify({ year_bh: yearBh, updated, skipped }).slice(0, 60000), req.ip]);
        res.json({ success: true, message: `ตั้งรหัสอ้างอิงตาม KHD ${updated.length} ตัวชี้วัด` + (skipped.length ? ` (ข้าม ${skipped.length})` : ''), updated, skipped, year_bh: yearBh });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/set-fiscal-year { ids, years, mode } — ตั้งปีงบประมาณของตัวชี้วัดเอง (เช่น ตัวที่ "ไม่ระบุปีงบ" / ไม่มีใน KHD) — 9 พ.ย. 2569
// years = ['2570', …] (ว่าง = ล้าง) | mode 'replace' (ค่าตั้งต้น) = แทนที่, 'add' = เพิ่มต่อจากปีเดิม
apiRouter.post('/indicators/set-fiscal-year', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    if (ids.length > 1000) return res.status(400).json({ success: false, message: 'เลือกได้ไม่เกิน 1000 ตัวชี้วัดต่อครั้ง' });
    const years = req.body?.years;
    if (!Array.isArray(years)) return res.status(400).json({ success: false, message: 'กรุณาระบุปีงบประมาณ' });
    const bad = invalidFiscalYears(years);
    if (bad.length) return res.status(400).json({ success: false, message: 'ปีงบประมาณไม่ถูกต้อง: ' + bad.join(', ') + ' (ใช้ปี พ.ศ. 4 หลัก)' });
    const mode = req.body?.mode === 'add' ? 'add' : 'replace';
    if (mode === 'add' && normalizeFiscalYears(years) === null) return res.status(400).json({ success: false, message: 'กรุณาเลือกปีงบประมาณที่จะเพิ่ม' });
    try {
        const [locals] = await db.query('SELECT id, kpi_indicators_name, khd_fiscal_year FROM kpi_indicators WHERE id IN (?)', [ids]);
        const updated = [];
        for (const l of locals) {
            const after = normalizeFiscalYears(mode === 'add' ? [...String(l.khd_fiscal_year || '').split(','), ...years] : years);
            if ((normalizeFiscalYears(l.khd_fiscal_year) || null) === after) continue;
            await db.query('UPDATE kpi_indicators SET khd_fiscal_year = ? WHERE id = ?', [after, l.id]);
            updated.push({ id: l.id, name: l.kpi_indicators_name, before: l.khd_fiscal_year, after });
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'SET_FISCAL_YEAR', 'kpi_indicators', JSON.stringify({ mode, years, updated }).slice(0, 60000), req.ip]);
        res.json({ success: true, message: `ตั้งปีงบประมาณ ${updated.length} ตัวชี้วัด` + (locals.length - updated.length ? ` (ไม่เปลี่ยน ${locals.length - updated.length})` : ''), updated });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /indicators/apply-khd-table-process { id, khd_report_id } — ใช้ table_process ของรายงาน KHD ที่จับคู่ด้วยรหัสอ้างอิงแล้ว (9 พ.ย. 2569, ปรับ 26 พ.ย. 2569)
// server อ่าน KHD ใหม่และตรวจซ้ำ: รหัสอ้างอิงของตัวชี้วัด = report_id (REF_MISMATCH), table_process ใหม่ถูกรูปแบบ — **ใช้ร่วมกับตัวชี้วัดอื่นได้**
// (ตารางส่งออกเดียวกัน) | ตารางชื่อเดิม (<tp>, <tp>_items, form_<tp>) ที่ไม่มีตัวชี้วัดอื่นใช้แล้ว = ปฏิเสธ (OLD_TABLES_EXIST — ข้อมูลในตารางเดิมจะไม่ถูกใช้ต่อ)
apiRouter.post('/indicators/apply-khd-table-process', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const id = Number(req.body?.id), rid = Number(req.body?.khd_report_id);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(rid) || rid <= 0) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' });
    try {
        const [[local]] = await db.query('SELECT id, kpi_indicators_name, kpi_indicators_id, table_process FROM kpi_indicators WHERE id = ?', [id]);
        if (!local) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัด' });
        const [[khd]] = await remoteDb.query(
            `SELECT report_id, report_name, report_code, table_process, data_source FROM reports WHERE report_id = ? AND data_source = 'excel'`, [rid]);
        if (!khd) return res.status(404).json({ success: false, message: 'ไม่พบรายการนี้ใน KHD' });
        if (refOf(local) !== Number(khd.report_id)) {
            return res.status(400).json({ success: false, code: 'REF_MISMATCH', message: `รหัสอ้างอิงของตัวชี้วัด (${local.kpi_indicators_id || 'ว่าง'}) ไม่ตรงกับรายงาน KHD #${khd.report_id} — ตั้งรหัสอ้างอิงก่อน (ใช้รหัส KHD)` });
        }
        const oldTp = String(local.table_process || '').trim();
        const newTp = String(khd.table_process || '').trim();
        if (!isValidIdentifier(newTp)) return res.status(400).json({ success: false, message: `table_process ของ KHD ไม่ถูกรูปแบบ (${newTp || 'ว่าง'})` });
        if (newTp === oldTp) return res.status(400).json({ success: false, message: 'table_process ตรงกันอยู่แล้ว' });
        // ตัวชี้วัดอื่นยังใช้ table_process เดิม = ตารางเดิมยังถูกใช้อยู่ → ไม่ต้องตรวจ
        const [stillUsed] = oldTp ? await db.query('SELECT id FROM kpi_indicators WHERE table_process = ? AND id <> ? LIMIT 1', [oldTp, id]) : [[]];
        if (oldTp && !stillUsed.length) {
            const [tabs] = await db.query(
                'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)',
                [[oldTp, oldTp + '_items', 'form_' + oldTp]]);
            if (tabs.length) {
                return res.status(409).json({ success: false, code: 'OLD_TABLES_EXIST', tables: tabs.map(r => r.t),
                    message: `ยังมีตารางที่ใช้ชื่อเดิม: ${tabs.map(r => r.t).join(', ')} — เปลี่ยนแล้วข้อมูลในตารางเหล่านี้จะไม่ถูกใช้ต่อ กรุณาย้าย/เปลี่ยนชื่อตารางก่อน` });
            }
        }
        await db.query('UPDATE kpi_indicators SET table_process = ?, kpi_indicators_code = ?, khd_report_id = ?, data_source = ? WHERE id = ?',
            [newTp, khd.report_code || null, khd.report_id, khd.data_source || null, id]);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, old_value, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'APPLY_KHD_TABLE_PROCESS', 'kpi_indicators', JSON.stringify({ id, table_process: oldTp }),
             JSON.stringify({ id, table_process: newTp, khd_report_id: khd.report_id }), req.ip]);
        res.json({ success: true, message: `เปลี่ยน table_process เป็น "${newTp}" แล้ว (เชื่อมกับ KHD #${khd.report_id})`, id, before: oldTp, after: newTp });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.post('/indicators/bulk-upload-excel', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(x => Number(x)).filter(Number.isFinite) : [];
        const v = req.body?.upload_excel;
        const val = (v === 1 || v === '1' || v === true) ? 1 : 0;
        if (ids.length === 0) return res.status(400).json({ success: false, message: 'ต้องระบุ ids' });
        const placeholders = ids.map(() => '?').join(',');
        const [r] = await db.query(`UPDATE kpi_indicators SET upload_excel = ? WHERE id IN (${placeholders})`, [val, ...ids]);
        // LINE notify
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `📦 Bulk เปลี่ยน upload_excel\n` +
                `👤 ${actor}\n` +
                `🔢 จำนวน: ${r.affectedRows} ตัวชี้วัด\n` +
                `📋 → ${val ? '1 = ข้าม export' : '0 = ส่งออกอัตโนมัติ'}`
            );
        } catch (_) {}
        res.json({ success: true, affected: r.affectedRows, upload_excel: val });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /report-compare/sync — Sync reports จาก KHD เข้า kpi_indicators (Local)
apiRouter.post('/report-compare/sync', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { khd_report_ids } = req.body;
    if (!Array.isArray(khd_report_ids) || khd_report_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกรายการที่ต้องการ Sync' });
    }
    try {
        const [khdRows] = await remoteDb.query(
            `SELECT report_id, report_name, dept, main_yut, report_code, table_process, data_source FROM reports WHERE report_id IN (?)`,
            [khd_report_ids]
        );
        let inserted = 0, updated = 0, skipped = 0;
        for (const khd of khdRows) {
            // ตัวชี้วัดของรายงานนี้ = รหัสอ้างอิง (kpi_indicators_id) = report_id (26 พ.ย. 2569 — เดิมค้นด้วย table_process ซึ่งใช้ร่วมกันได้)
            const [existing] = await db.query('SELECT id FROM kpi_indicators WHERE TRIM(kpi_indicators_id) = ? ORDER BY id LIMIT 1', [String(khd.report_id)]);
            if (existing.length > 0) {
                // อัปเดตชื่อ + report_code + data_source + khd_report_id (ไม่แตะ table_process/เกณฑ์ — local อาจตั้งค่าเองไว้)
                await db.query(
                    'UPDATE kpi_indicators SET kpi_indicators_name = ?, kpi_indicators_code = ?, data_source = ?, khd_report_id = ? WHERE id = ?',
                    [khd.report_name, khd.report_code || null, khd.data_source || null, khd.report_id, existing[0].id]
                );
                updated++;
            } else {
                if (!khd.table_process) { skipped++; continue; }
                // สร้างใหม่ (รหัสอ้างอิง = report_id)
                await db.query(
                    'INSERT INTO kpi_indicators (kpi_indicators_name, kpi_indicators_id, table_process, kpi_indicators_code, data_source, khd_report_id) VALUES (?, ?, ?, ?, ?, ?)',
                    [khd.report_name, String(khd.report_id), khd.table_process, khd.report_code || null, khd.data_source || null, khd.report_id]
                );
                inserted++;
            }
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'SYNC_REPORTS', 'kpi_indicators',
             JSON.stringify({ khd_ids: khd_report_ids, inserted, updated, skipped }), req.ip]
        );
        res.json({ success: true, message: `Sync สำเร็จ — เพิ่มใหม่ ${inserted} รายการ, อัปเดตชื่อ ${updated} รายการ${skipped > 0 ? ', ข้าม ' + skipped + ' รายการ' : ''}`, inserted, updated, skipped });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

const KHD_REPORT_ADD_COLS = 'report_id, report_name, report_code, table_process, data_source, target_percentage, target_condition, dept, main_yut, main_indicator, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types';

apiRouter.post('/report-compare/add-from-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { khd_report_id, dept_id, main_indicator_id, year_bh } = req.body;
    if (!khd_report_id) return res.status(400).json({ success: false, message: 'กรุณาระบุ khd_report_id' });
    try {
        const [khdRows] = await remoteDb.query(`SELECT ${KHD_REPORT_ADD_COLS} FROM reports WHERE report_id = ?`, [khd_report_id]);
        if (!khdRows.length) return res.status(404).json({ success: false, message: 'ไม่พบรายการนี้ใน KHD' });
        const khd = khdRows[0];
        if (!khd.table_process) return res.status(400).json({ success: false, message: 'รายการ KHD นี้ไม่มี table_process' });
        const [existing] = await db.query('SELECT id FROM kpi_indicators WHERE TRIM(kpi_indicators_id) = ? LIMIT 1', [String(khd.report_id)]);
        if (existing.length) return res.status(409).json({ success: false, message: `มีตัวชี้วัดนี้ในระบบแล้ว (รหัสอ้างอิง ${khd.report_id} — ตัวชี้วัด #${existing[0].id})` });
        const resolver = await loadKhdResolver(db);
        const { id, resolved } = await insertIndicatorFromKhd(remoteDb, resolver, khd, { dept_id, main_indicator_id }, year_bh);
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'kpi_indicators', id,
             JSON.stringify({ khd_report_id, table_process: khd.table_process, dept_id: resolved.dept_id, main_indicator_id: resolved.main_indicator_id, main_yut: resolved.main_yut, unmatched: resolved.unmatched, year_bh: year_bh || null }), req.ip]
        );
        res.json({ success: true, message: `เพิ่ม "${khd.report_name}" เข้าระบบเรียบร้อย`, id, resolved });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /report-compare/bulk-add-from-khd — เพิ่มตัวชี้วัดจาก KHD หลายตัวพร้อมกัน (checkbox เลือกจากตาราง "ยังไม่มีในระบบ")
// dept_id/main_indicator_id/year_bh ใช้ค่าเดียวกันกับทุกตัวที่เลือก (แก้แยกทีละตัวได้ภายหลังเหมือนเดิม)
apiRouter.post('/report-compare/bulk-add-from-khd', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { khd_report_ids, dept_id, main_indicator_id, year_bh } = req.body;
    if (!Array.isArray(khd_report_ids) || khd_report_ids.length === 0) {
        return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัดที่ต้องการเพิ่มอย่างน้อย 1 รายการ' });
    }
    try {
        const [khdRows] = await remoteDb.query(`SELECT ${KHD_REPORT_ADD_COLS} FROM reports WHERE report_id IN (?)`, [khd_report_ids]);
        const resolver = await loadKhdResolver(db);
        let inserted = 0, skipped = 0;
        const skippedNames = [];
        const unmatchedNames = [];   // เพิ่มแล้ว แต่ค่าบางช่องใน KHD ยังจับคู่ไม่ได้ (ช่องนั้นใช้ค่าที่เลือกในหน้าต่าง/ว่าง)
        for (const khd of khdRows) {
            if (!khd.table_process) { skipped++; skippedNames.push(khd.report_name + ' (ไม่มี table_process)'); continue; }
            const [existing] = await db.query('SELECT id FROM kpi_indicators WHERE TRIM(kpi_indicators_id) = ? LIMIT 1', [String(khd.report_id)]);
            if (existing.length) { skipped++; skippedNames.push(khd.report_name + ' (มีอยู่แล้ว — รหัสอ้างอิง ' + khd.report_id + ')'); continue; }
            const { resolved } = await insertIndicatorFromKhd(remoteDb, resolver, khd, { dept_id, main_indicator_id }, year_bh);
            if (resolved.unmatched.length) unmatchedNames.push(khd.report_name);
            inserted++;
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'BULK_ADD_FROM_KHD', 'kpi_indicators',
             JSON.stringify({ requested: khd_report_ids.length, inserted, skipped, dept_id: dept_id || null, main_indicator_id: main_indicator_id || null, year_bh: year_bh || null }), req.ip]
        );
        res.json({
            success: true,
            message: `เพิ่มสำเร็จ ${inserted} รายการ${skipped > 0 ? `, ข้าม ${skipped} รายการ` : ''}`,
            inserted, skipped, skippedNames, unmatchedNames
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /report-compare/sync-khd-link — Backfill ถาวร: link kpi_indicators.khd_report_id + data_source + khd_fiscal_year จาก KHD
// จับคู่ด้วยรหัสอ้างอิง (kpi_indicators_id) = reports.report_id (26 พ.ย. 2569 — เดิม table_process ซึ่งใช้ร่วมกันได้) ทุกปีงบ ทั้ง hdc และ excel
// (ต้องการ data_source จริงของทุกตัวชี้วัดสำหรับป้าย key_in/hdc/local-only) — ไม่มีรหัสอ้างอิง/ไม่พบใน KHD = local-only
// khd_fiscal_year = comma-list ของทุกปีงบใน report_fiscal_year_config ของ report_id นั้น (KHD ไม่มีปีงบ = คงค่าเดิม)
apiRouter.post('/report-compare/sync-khd-link', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [khdRows] = await remoteDb.query('SELECT report_id, data_source FROM reports ORDER BY report_id');
        const khdMap = new Map();
        khdRows.forEach(r => { khdMap.set(Number(r.report_id), r); });

        const [fyRows] = await remoteDb.query(`SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config ORDER BY report_id, fiscal_year`);
        const fyMap = new Map(); // report_id -> "2569,2570"
        fyRows.forEach(r => {
            const list = fyMap.get(r.report_id) || [];
            list.push(String(r.fiscal_year));
            fyMap.set(r.report_id, list);
        });

        const [localRows] = await db.query('SELECT id, kpi_indicators_id FROM kpi_indicators');
        let matched = 0, localOnly = 0, withFiscalYear = 0;
        const dsCounts = {};
        for (const local of localRows) {
            const ref = refOf(local);
            const khd = ref !== null ? khdMap.get(ref) : null;
            if (khd) {
                const fyList = fyMap.get(khd.report_id) || null;
                const khdFiscalYear = fyList ? normalizeFiscalYears(fyList) : null;
                if (khdFiscalYear) withFiscalYear++;
                // KHD ไม่มีปีงบของรายงานนี้ = คงปีงบเดิม (อาจตั้งเองไว้ — 9 พ.ย. 2569)
                await db.query('UPDATE kpi_indicators SET khd_report_id = ?, data_source = ?, khd_fiscal_year = COALESCE(?, khd_fiscal_year) WHERE id = ?', [khd.report_id, khd.data_source, khdFiscalYear, local.id]);
                matched++;
                dsCounts[khd.data_source] = (dsCounts[khd.data_source] || 0) + 1;
            } else {
                // ไม่มีรหัสอ้างอิง/ไม่พบใน KHD — reset ให้ตรงความจริง (local-only) กันลิงก์เก่าค้าง
                // ปีงบ (khd_fiscal_year) ไม่ล้าง — ตัวชี้วัดที่ไม่มีใน KHD ตั้งปีงบเองได้ (9 พ.ย. 2569)
                await db.query('UPDATE kpi_indicators SET khd_report_id = NULL, data_source = NULL WHERE id = ?', [local.id]);
                localOnly++;
            }
        }
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'SYNC_KHD_LINK', 'kpi_indicators', JSON.stringify({ matched, localOnly, withFiscalYear, dsCounts }), req.ip]
        );
        res.json({ success: true, message: `เชื่อมโยง KHD สำเร็จ — จับคู่ได้ ${matched} ตัวชี้วัด (key_in ${dsCounts.excel || 0}, hdc ${dsCounts.hdc || 0}, มีปีงบ ${withFiscalYear} ตัว), local-only ${localOnly} ตัวชี้วัด`, matched, localOnly, withFiscalYear, dsCounts });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== จับคู่ข้อมูล KHD ↔ Local (หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์) — 19 ต.ค. 2569 ==========
// GET /khd-mappings?kind=dept|main|yut — ค่าที่พบใน KHD reports (data_source='excel') + ผลการจับคู่ปัจจุบัน + รายการของ Local ให้เลือก
apiRouter.get('/khd-mappings', authenticateToken, isSuperAdmin, async (req, res) => {
    const kind = String(req.query.kind || '');
    if (!khdMapping.KHD_MAP_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'kind ต้องเป็น dept, main หรือ yut' });
    try {
        res.json({ success: true, ...(await listKhdMappings(kind)) });
    } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
});

// PUT /khd-mappings — { kind, khd_value, local_id }: local_id = จับคู่, ignore = true → ไม่ต้องจับคู่ (เว้นว่าง), ทั้งคู่ไม่ส่ง = ลบการจับคู่ (กลับไปใช้อัตโนมัติ)
apiRouter.put('/khd-mappings', authenticateToken, isSuperAdmin, async (req, res) => {
    const { kind, khd_value, local_id, ignore } = req.body || {};
    if (!khdMapping.KHD_MAP_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'kind ต้องเป็น dept, main หรือ yut' });
    if (!khdMapping.normKhd(khd_value)) return res.status(400).json({ success: false, message: 'กรุณาระบุค่าจาก KHD' });
    try {
        const key = khdMapping.khdKey(khd_value);
        const id = Number(local_id);
        if (Number.isInteger(id) && id > 0) {
            const table = { dept: 'departments', main: 'kpi_main_indicators', yut: 'main_yut' }[kind];
            const [[row]] = await db.query(`SELECT id FROM ${table} WHERE id = ?`, [id]);
            if (!row) return res.status(400).json({ success: false, message: 'ไม่พบรายการปลายทางในระบบ' });
        }
        const target = (Number.isInteger(id) && id > 0) ? id : null;
        if (target === null && !ignore) {
            await db.query('DELETE FROM khd_value_mappings WHERE kind = ? AND khd_key = ?', [kind, key]);
        } else {
            await db.query(
                `INSERT INTO khd_value_mappings (kind, khd_key, khd_value, local_id, updated_by) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE khd_value = VALUES(khd_value), local_id = VALUES(local_id), updated_by = VALUES(updated_by)`,
                [kind, key, String(khd_value).trim().slice(0, 1000), target, req.user.userId]
            );
        }
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'KHD_MAPPING_UPDATE', 'khd_value_mappings', JSON.stringify({ kind, khd_value, local_id: target, ignore: !!ignore }), req.ip]);
        const resolver = await loadKhdResolver(db);
        res.json({ success: true, message: 'บันทึกการจับคู่เรียบร้อย', resolved: resolver.resolve(kind, khd_value) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== Report Compare — Tabs (Strategies / Departments / Main-Indicators / Hospitals) ==========

// GET /report-compare/strategies — เปรียบเทียบ main_yut (Local) กับ distinct main_yut text ใน KHD reports
apiRouter.get('/report-compare/strategies', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [khdRows] = await remoteDb.query(
            `SELECT DISTINCT TRIM(main_yut) AS khd_yut FROM reports WHERE data_source='excel' AND main_yut IS NOT NULL AND TRIM(main_yut) != ''`
        );
        const [localRows] = await db.query('SELECT id, yut_name FROM main_yut ORDER BY yut_name');
        const resolver = await loadKhdResolver(db);
        const usedLocal = new Set();
        const items = [];
        let match = 0, missing_local = 0, missing_remote = 0;
        khdRows.forEach(r => {
            const m = resolver.resolve('yut', r.khd_yut);
            if (m.local_id) { usedLocal.add(m.local_id); items.push({ status: 'match', khd_yut_name: r.khd_yut, local_id: m.local_id, local_yut_name: m.local_name, match_source: m.status }); match++; }
            else { items.push({ status: 'missing_local', khd_yut_name: r.khd_yut, local_id: null, local_yut_name: null, match_source: m.status }); missing_local++; }
        });
        localRows.forEach(r => {
            if (!usedLocal.has(Number(r.id))) { items.push({ status: 'missing_remote', khd_yut_name: null, local_id: r.id, local_yut_name: r.yut_name }); missing_remote++; }
        });
        res.json({ success: true, summary: { total: items.length, match, missing_local, missing_remote }, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-strategy — เพิ่ม yut_name ใหม่จาก KHD text
apiRouter.post('/report-compare/add-strategy', authenticateToken, isSuperAdmin, async (req, res) => {
    const { yut_name } = req.body;
    if (!yut_name?.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อยุทธศาสตร์' });
    try {
        const [existing] = await db.query('SELECT id FROM main_yut WHERE TRIM(LOWER(yut_name)) = TRIM(LOWER(?))', [yut_name]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มียุทธศาสตร์ชื่อนี้ในระบบแล้ว' });
        const [ins] = await db.query('INSERT INTO main_yut (yut_name) VALUES (?)', [yut_name.trim()]);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'main_yut', ins.insertId, JSON.stringify({ yut_name: yut_name.trim() }), req.ip]);
        res.json({ success: true, message: `เพิ่มยุทธศาสตร์ "${yut_name.trim()}" เรียบร้อย`, id: ins.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /report-compare/departments — เปรียบเทียบ departments (Local) กับ distinct dept text ใน KHD reports
apiRouter.get('/report-compare/departments', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [khdRows] = await remoteDb.query(
            `SELECT DISTINCT TRIM(dept) AS khd_dept FROM reports WHERE data_source='excel' AND dept IS NOT NULL AND TRIM(dept) != ''`
        );
        const [localRows] = await db.query('SELECT id, dept_name, dept_code FROM departments ORDER BY dept_name');
        const resolver = await loadKhdResolver(db);
        const byId = new Map(localRows.map(r => [Number(r.id), r]));
        const usedLocal = new Set();
        const items = [];
        let match = 0, missing_local = 0, missing_remote = 0;
        khdRows.forEach(r => {
            const m = resolver.resolve('dept', r.khd_dept);
            const local = m.local_id ? byId.get(m.local_id) : null;
            if (local) { usedLocal.add(m.local_id); items.push({ status: 'match', khd_dept_name: r.khd_dept, local_id: local.id, local_dept_name: local.dept_name, local_dept_code: local.dept_code, match_source: m.status }); match++; }
            else { items.push({ status: 'missing_local', khd_dept_name: r.khd_dept, local_id: null, local_dept_name: null, match_source: m.status }); missing_local++; }
        });
        localRows.forEach(r => {
            if (!usedLocal.has(Number(r.id))) { items.push({ status: 'missing_remote', khd_dept_name: null, local_id: r.id, local_dept_name: r.dept_name, local_dept_code: r.dept_code }); missing_remote++; }
        });
        res.json({ success: true, summary: { total: items.length, match, missing_local, missing_remote }, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-department — เพิ่ม dept_name ใหม่จาก KHD text
apiRouter.post('/report-compare/add-department', authenticateToken, isSuperAdmin, async (req, res) => {
    const { dept_name, dept_code } = req.body;
    if (!dept_name?.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหน่วยงาน' });
    try {
        const [existing] = await db.query('SELECT id FROM departments WHERE TRIM(LOWER(dept_name)) = TRIM(LOWER(?))', [dept_name]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มีหน่วยงานชื่อนี้ในระบบแล้ว' });
        const [ins] = await db.query('INSERT INTO departments (dept_name, dept_code) VALUES (?, ?)', [dept_name.trim(), (dept_code || '').trim()]);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'departments', ins.insertId, JSON.stringify({ dept_name: dept_name.trim(), dept_code }), req.ip]);
        res.json({ success: true, message: `เพิ่มหน่วยงาน "${dept_name.trim()}" เรียบร้อย`, id: ins.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /report-compare/main-indicators — เปรียบเทียบ kpi_main_indicators: KHD table (ถ้ามี) หรือ Coverage fallback
apiRouter.get('/report-compare/main-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [localMainRows] = await db.query('SELECT id, main_indicator_name FROM kpi_main_indicators ORDER BY main_indicator_name');
        // ลองดึง kpi_main_indicators จาก KHD ก่อน
        let khdMainRows = null;
        try { [khdMainRows] = await remoteDb.query('SELECT id, main_indicator_name FROM kpi_main_indicators'); } catch (e) { khdMainRows = null; }

        if (khdMainRows) {
            // KHD มีตาราง kpi_main_indicators — เทียบชื่อตรงๆ
            const khdNames = new Map(khdMainRows.map(r => [r.main_indicator_name.trim().toLowerCase(), r]));
            const localNames = new Map(localMainRows.map(r => [r.main_indicator_name.trim().toLowerCase(), r]));
            const items = [];
            let match = 0, missing_local = 0, missing_remote = 0;
            khdMainRows.forEach(khd => {
                const key = khd.main_indicator_name.trim().toLowerCase();
                const local = localNames.get(key);
                if (!local) { items.push({ status: 'missing_local', khd_name: khd.main_indicator_name.trim(), local_id: null, local_name: null }); missing_local++; }
                else { items.push({ status: 'match', khd_name: khd.main_indicator_name.trim(), local_id: local.id, local_name: local.main_indicator_name }); match++; }
            });
            localMainRows.forEach(local => {
                if (!khdNames.has(local.main_indicator_name.trim().toLowerCase())) {
                    items.push({ status: 'missing_remote', khd_name: null, local_id: local.id, local_name: local.main_indicator_name }); missing_remote++;
                }
            });
            return res.json({ success: true, source: 'khd_table', summary: { total: items.length, match, missing_local, missing_remote }, items });
        }

        // Fallback: coverage จาก table_process ใน KHD reports
        const [khdTpRows] = await remoteDb.query(
            `SELECT DISTINCT TRIM(table_process) AS tp FROM reports WHERE data_source='excel' AND table_process IS NOT NULL AND TRIM(table_process) != ''`
        );
        const khdTpSet = new Set(khdTpRows.map(r => r.tp));
        const [localIndRows] = await db.query('SELECT id, main_indicator_id, table_process FROM kpi_indicators WHERE is_active = 1');
        const coverageItems = [];
        let has_khd = 0, local_only = 0;
        for (const mi of localMainRows) {
            const linked = localIndRows.filter(i => i.main_indicator_id == mi.id);
            const khdLinked = linked.filter(i => i.table_process && khdTpSet.has(i.table_process.trim()));
            const status = khdLinked.length > 0 ? 'has_khd' : 'local_only';
            if (status === 'has_khd') has_khd++; else local_only++;
            coverageItems.push({ status, local_id: mi.id, local_name: mi.main_indicator_name, total_indicators: linked.length, khd_linked_count: khdLinked.length });
        }
        res.json({ success: true, source: 'coverage_fallback', summary: { total: coverageItems.length, has_khd, local_only }, items: coverageItems });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-main-indicator — เพิ่มหมวดหมู่หลักจาก KHD เข้า Local
apiRouter.post('/report-compare/add-main-indicator', authenticateToken, isSuperAdmin, async (req, res) => {
    const { khd_name, yut_id } = req.body;
    if (!khd_name?.trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหมวดหมู่หลัก' });
    try {
        const [existing] = await db.query('SELECT id FROM kpi_main_indicators WHERE LOWER(TRIM(main_indicator_name)) = LOWER(TRIM(?))', [khd_name]);
        if (existing.length) return res.status(409).json({ success: false, message: `มี "${khd_name.trim()}" ในระบบแล้ว` });
        const [ins] = await db.query('INSERT INTO kpi_main_indicators (main_indicator_name, yut_id) VALUES (?, ?)', [khd_name.trim(), yut_id || null]);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'kpi_main_indicators', ins.insertId, JSON.stringify({ khd_name: khd_name.trim(), yut_id }), req.ip]);
        res.json({ success: true, message: `เพิ่ม "${khd_name.trim()}" เรียบร้อย`, id: ins.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /report-compare/hospitals — เปรียบเทียบ chospital Local กับ KHD chospital (ถ้ามี)
apiRouter.get('/report-compare/hospitals', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        let khdRows;
        try { [khdRows] = await remoteDb.query('SELECT hoscode, hosname, hostype, distid FROM chospital'); }
        catch (e) { return res.status(400).json({ success: false, message: 'ไม่พบตาราง chospital ใน KHD: ' + e.message }); }
        const [localRows] = await db.query('SELECT hoscode, hosname, hostype, distid FROM chospital');
        const localMap = new Map(localRows.map(r => [String(r.hoscode).trim(), r]));
        const khdMap = new Map(khdRows.map(r => [String(r.hoscode).trim(), r]));
        const items = [];
        let match = 0, different = 0, missing_local = 0, missing_remote = 0;
        khdRows.forEach(khd => {
            const key = String(khd.hoscode).trim();
            const local = localMap.get(key);
            if (!local) { items.push({ status: 'missing_local', hoscode: key, khd_hosname: khd.hosname, khd_hostype: khd.hostype, khd_distid: khd.distid, local_hosname: null }); missing_local++; }
            else if ((local.hosname || '').trim() !== (khd.hosname || '').trim()) { items.push({ status: 'different', hoscode: key, khd_hosname: khd.hosname, local_hosname: local.hosname, khd_hostype: khd.hostype, khd_distid: khd.distid }); different++; }
            else { items.push({ status: 'match', hoscode: key, khd_hosname: khd.hosname, local_hosname: local.hosname, khd_hostype: khd.hostype }); match++; }
        });
        localRows.forEach(local => {
            if (!khdMap.has(String(local.hoscode).trim())) { items.push({ status: 'missing_remote', hoscode: String(local.hoscode).trim(), local_hosname: local.hosname, khd_hosname: null, khd_hostype: null }); missing_remote++; }
        });
        res.json({ success: true, summary: { total: items.length, match, different, missing_local, missing_remote }, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /report-compare/add-hospital — เพิ่ม hoscode จาก KHD chospital เข้า Local
apiRouter.post('/report-compare/add-hospital', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const { hoscode } = req.body;
    if (!hoscode) return res.status(400).json({ success: false, message: 'กรุณาระบุ hoscode' });
    try {
        const [khdRows] = await remoteDb.query(
            'SELECT hoscode, hosname, hostype, distid, provcode, distcode FROM chospital WHERE hoscode = ?', [hoscode]
        );
        if (!khdRows.length) return res.status(404).json({ success: false, message: 'ไม่พบ hoscode นี้ใน KHD' });
        const khd = khdRows[0];
        const [existing] = await db.query('SELECT hoscode FROM chospital WHERE hoscode = ?', [hoscode]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มี hoscode นี้ในระบบแล้ว' });
        await db.query(
            'INSERT INTO chospital (hoscode, hosname, hostype, distid, provcode, distcode) VALUES (?, ?, ?, ?, ?, ?)',
            [khd.hoscode, khd.hosname, khd.hostype || null, khd.distid || null, khd.provcode || null, khd.distcode || null]
        );
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.userId, 'ADD_FROM_KHD', 'chospital', hoscode, JSON.stringify({ hoscode, hosname: khd.hosname }), req.ip]);
        res.json({ success: true, message: `เพิ่ม "${khd.hosname}" (${hoscode}) เรียบร้อย` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = { KHD_REPORT_ADD_COLS, KHD_MAP_COLUMN };
