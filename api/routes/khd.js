// เส้นทาง: เทียบตัวชี้วัดกับ KHD (report-compare), ใช้เกณฑ์ KHD, จับคู่ข้อมูล KHD
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const khdMapping = require('../khd-mapping');
const { _actorLabel } = require('../services/indicator-fields');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { getKhdEffectiveCriteriaFor, insertIndicatorFromKhd, loadKhdResolver } = require('../services/khd');
const { getRemotePool } = require('../db-remote');
const { notifyLineAction } = require('../core/notify');
const { requireAction } = require('../core/access');

// === Test Telegram (super_admin) ===
// ============================================================
// === Structure Compare: Local DB vs Remote KHD DB ===
// ============================================================

// GET /report-compare — เปรียบเทียบ reports (KHD) กับ kpi_indicators (Local) โดยใช้ table_process เป็น key
apiRouter.get('/report-compare', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        // ปีงบประมาณที่ใช้เทียบเกณฑ์ — จาก query param หรือ default ปีงบปัจจุบัน (ต.ค. ขึ้นปีใหม่)
        const today = new Date();
        let fyYear = today.getFullYear();
        if (today.getMonth() >= 9) fyYear += 1;
        const currentFY = (fyYear + 543).toString();
        const year_bh = req.query.year_bh ? String(req.query.year_bh) : currentFY;

        // ดึง reports จาก KHD
        const [khdRows] = await remoteDb.query(`
            SELECT *
            FROM reports
            WHERE data_source = 'excel'
            AND LENGTH(report_code) = LENGTH(table_process)
            ORDER BY report_id
        `);
        // ดึง override เกณฑ์รายปีงบจาก report_fiscal_year_config (เฉพาะปีที่กำลังเทียบ)
        const [fyRows] = await remoteDb.query(
            `SELECT report_id, fiscal_year, target_percentage, target_condition, is_active
             FROM report_fiscal_year_config WHERE fiscal_year = ?`,
            [year_bh]
        );
        const fyConfigMap = new Map();
        fyRows.forEach(r => fyConfigMap.set(r.report_id, r));

        // ดึง kpi_indicators จาก Local (เพิ่ม dept_id, main_indicator_id, upload_excel, เกณฑ์ + data_source/khd_report_id เพื่อ frontend)
        const [localRows] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process, i.kpi_indicators_code, i.is_active,
                   i.dept_id, i.main_indicator_id, i.upload_excel,
                   i.criterion, i.target_condition, i.data_source, i.khd_report_id,
                   d.dept_name, mi.main_indicator_name
            FROM kpi_indicators i
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            ORDER BY i.id
        `);
        const khdResolver = await loadKhdResolver(db); // จับคู่หน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ของแถวที่ยังไม่มีใน Local
        // สร้าง map โดยใช้ table_process เป็น key
        const khdMap = new Map();
        khdRows.forEach(r => { if (r.table_process) khdMap.set(r.table_process, r); });
        const localMap = new Map();
        localRows.forEach(r => { if (r.table_process) localMap.set(r.table_process, r); });

        const items = [];
        let match = 0, different = 0, missing_local = 0, missing_remote = 0, criteria_different = 0;
        let khd_inactive_count = 0, suggest_disable_count = 0;

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

        // เทียบจาก KHD
        for (const khd of khdRows) {
            const tp = khd.table_process;
            const local = tp ? localMap.get(tp) : null;
            const fyConfig = fyConfigMap.get(khd.report_id) || null;
            const effective = getEffectiveKhdCriteria(khd, fyConfig);
            // effectiveIsActive: ใช้ report_fiscal_year_config.is_active ของปีงบที่กำลังเทียบก่อนเสมอ (ถ้ามี override
            // ปีนั้น) ไม่งั้น fallback ไปที่ reports.is_active (ค่าทั่วไป ไม่ผูกปี) — เดิมโค้ดใช้ khd.is_active (reports)
            // ตรงๆ ทุกจุด ทำให้ badge "HDC inactive"/คำแนะนำปิด upload_excel ผิดพลาดเมื่อ 2 ค่านี้ไม่ตรงกัน (ยืนยันจริงว่า
            // มีเคสแบบนี้อยู่จริงบน remote — ไม่ใช่แค่ทฤษฎี)
            const effectiveIsActive = (fyConfig && fyConfig.is_active != null) ? fyConfig.is_active : khd.is_active;
            if (!local) {
                items.push({
                    status: 'missing_local',
                    khd_report_id: khd.report_id, khd_name: khd.report_name, khd_dept: khd.dept, khd_main_yut: khd.main_yut,
                    khd_main_indicator: khd.main_indicator || null,
                    khd_resolved: khdResolver.resolveIndicator(khd),
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
            } else {
                const nameMatch = (khd.report_name || '').trim() === (local.kpi_indicators_name || '').trim();
                const status = nameMatch ? 'match' : 'different';
                if (status === 'match') match++; else different++;

                // criteria_match: เทียบ criterion (numeric-aware) + target_condition — local.criterion คือ "เกณฑ์" จริง (แยกจาก target_percentage/เป้าหมาย แล้ว)
                const pctMatch = Number(effective.target_percentage) === Number(local.criterion)
                    || (effective.target_percentage == null && local.criterion == null);
                const condMatch = String(effective.target_condition || '') === String(local.target_condition || '');
                const criteria_match = pctMatch && condMatch;
                if (!criteria_match) criteria_different++;

                const suggest = computeSuggest(effectiveIsActive, local.upload_excel);
                if (suggest) suggest_disable_count++;
                if (effectiveIsActive === 0 || effectiveIsActive === '0') khd_inactive_count++;
                items.push({
                    status,
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
                    suggest_disable_upload: suggest
                });
            }
        }
        // เทียบจาก Local ที่ไม่มีใน KHD
        for (const local of localRows) {
            if (local.table_process && !khdMap.has(local.table_process)) {
                items.push({
                    status: 'missing_remote',
                    khd_report_id: null, khd_name: null, khd_dept: null, khd_main_yut: null,
                    report_code: null, table_process: local.table_process, khd_is_active: null,
                    khd_data_source: null, khd_target_percentage: null, khd_target_condition: null,
                    khd_criteria_source: null, khd_fiscal_year: null,
                    local_id: local.id, local_name: local.kpi_indicators_name, local_dept: local.dept_name,
                    local_dept_id: local.dept_id, local_main_indicator_id: local.main_indicator_id, local_is_active: local.is_active,
                    local_upload_excel: local.upload_excel || 0,
                    local_criterion: local.criterion, local_target_condition: local.target_condition,
                    local_data_source: local.data_source,
                    criteria_match: null,
                    suggest_disable_upload: false
                });
                missing_remote++;
            }
        }
        res.json({
            success: true,
            khd_count: khdRows.length, local_count: localRows.length,
            summary: {
                total: items.length, match, different, missing_local, missing_remote,
                khd_inactive: khd_inactive_count, suggest_disable: suggest_disable_count,
                criteria_different, year_bh
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
// (table_process, data_source='excel', LENGTH(report_code)=LENGTH(table_process), report_id มากสุดชนะ) และเกณฑ์ของปีงบที่เลือก
// (report_fiscal_year_config ก่อน แล้วจึง reports) — ไม่แตะ "เป้าหมาย" (target_percentage) และข้ามตัวที่ KHD ไม่มีเกณฑ์ (ไม่ล้างค่าเดิม)
apiRouter.post('/indicators/apply-khd-criteria', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
    if (ids.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตัวชี้วัด' });
    const now = new Date();
    const yearBh = req.body?.year_bh ? String(req.body.year_bh) : String(now.getFullYear() + 543 + (now.getMonth() >= 9 ? 1 : 0)); // ปีงบปัจจุบัน (ต.ค. ขึ้นปีใหม่)
    const fmt = (v) => (v === null || v === undefined || String(v).trim() === '') ? null
        : (Number.isFinite(Number(v)) ? String(Number(v)) : String(v).trim());
    try {
        const [locals] = await db.query('SELECT id, kpi_indicators_name, table_process, criterion, target_condition FROM kpi_indicators WHERE id IN (?)', [ids]);
        const tps = [...new Set(locals.map(l => String(l.table_process || '').trim()).filter(Boolean))];
        const khdByTp = new Map();
        if (tps.length) {
            const [khdRows] = await remoteDb.query(
                `SELECT report_id, table_process, target_percentage, target_condition FROM reports
                 WHERE data_source = 'excel' AND LENGTH(report_code) = LENGTH(table_process) AND table_process IN (?) ORDER BY report_id`, [tps]);
            khdRows.forEach(r => khdByTp.set(String(r.table_process).trim(), r));
        }
        const updated = [], skipped = [];
        for (const l of locals) {
            const khd = khdByTp.get(String(l.table_process || '').trim());
            if (!khd) { skipped.push({ id: l.id, reason: 'ไม่พบใน KHD' }); continue; }
            const eff = await getKhdEffectiveCriteriaFor(remoteDb, khd.report_id, khd.target_percentage, khd.target_condition, yearBh);
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
            if (!khd.table_process) { skipped++; continue; }
            // ตรวจสอบว่ามีอยู่แล้วหรือไม่ (โดย table_process)
            const [existing] = await db.query('SELECT id, kpi_indicators_name FROM kpi_indicators WHERE table_process = ?', [khd.table_process]);
            if (existing.length > 0) {
                // อัปเดตชื่อ + report_code + data_source + khd_report_id (ไม่แตะ target_percentage/target_condition — local อาจตั้งค่าเองไว้)
                await db.query(
                    'UPDATE kpi_indicators SET kpi_indicators_name = ?, kpi_indicators_code = ?, data_source = ?, khd_report_id = ? WHERE table_process = ?',
                    [khd.report_name, khd.report_code || null, khd.data_source || null, khd.report_id, khd.table_process]
                );
                updated++;
            } else {
                // สร้างใหม่
                await db.query(
                    'INSERT INTO kpi_indicators (kpi_indicators_name, table_process, kpi_indicators_code, data_source, khd_report_id) VALUES (?, ?, ?, ?, ?)',
                    [khd.report_name, khd.table_process, khd.report_code || null, khd.data_source || null, khd.report_id]
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

const KHD_REPORT_ADD_COLS = 'report_id, report_name, report_code, table_process, data_source, target_percentage, target_condition, dept, main_yut, main_indicator';

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
        const [existing] = await db.query('SELECT id FROM kpi_indicators WHERE table_process = ?', [khd.table_process]);
        if (existing.length) return res.status(409).json({ success: false, message: 'มีตัวชี้วัดนี้ในระบบแล้ว (table_process ซ้ำ)' });
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
            const [existing] = await db.query('SELECT id FROM kpi_indicators WHERE table_process = ?', [khd.table_process]);
            if (existing.length) { skipped++; skippedNames.push(khd.report_name + ' (มีอยู่แล้ว)'); continue; }
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
// (ทั้ง hdc และ excel ไม่กรองเหมือน /report-compare หลัก เพราะต้องการ data_source จริงของทุกตัวชี้วัด ไม่ใช่แค่ตัวที่จะ sync เข้าระบบ)
// ใช้ heuristic เดียวกับ /report-compare (LENGTH(report_code)=LENGTH(table_process)) กันคู่ table_process ซ้ำที่ report_code สั้นกว่าปกติ (ข้อมูลคุณภาพต่ำใน KHD)
// เรียงตาม report_id ASC แล้วให้ตัวหลังทับตัวก่อนใน map — เมื่อ table_process ชนกันหลายตัว (พบจริง 12/172 แถว เป็น "พี่น้อง" conceptually ใกล้กันแต่ report_id ต่างกัน)
// จะได้ report_id ล่าสุด/มากสุด ซึ่งไม่กระทบความถูกต้องของ badge (data_source ของคู่ที่ชนกันเป็น 'excel' เหมือนกันทุกคู่จากการตรวจสอบจริง)
// khd_fiscal_year เก็บเป็น comma-list ของทุกปีงบที่พบใน report_fiscal_year_config ของ report_id นั้น (ไม่กรอง is_active — แค่บอกว่า
// KHD เคย/กำลังกำหนดค่าปีงบนี้ไว้ให้ตัวชี้วัดนี้ ใช้สำหรับ filter+badge ปีงบประมาณ ไม่ใช่สถานะ active/inactive ซึ่งมี badge แยกอยู่แล้ว)
apiRouter.post('/report-compare/sync-khd-link', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const [khdRows] = await remoteDb.query(`
            SELECT report_id, table_process, data_source
            FROM reports
            WHERE table_process IS NOT NULL AND table_process != ''
            AND LENGTH(report_code) = LENGTH(table_process)
            ORDER BY report_id
        `);
        const khdMap = new Map();
        khdRows.forEach(r => { khdMap.set(r.table_process.trim(), r); });

        const [fyRows] = await remoteDb.query(`SELECT DISTINCT report_id, fiscal_year FROM report_fiscal_year_config ORDER BY report_id, fiscal_year`);
        const fyMap = new Map(); // report_id -> "2569,2570"
        fyRows.forEach(r => {
            const list = fyMap.get(r.report_id) || [];
            list.push(String(r.fiscal_year));
            fyMap.set(r.report_id, list);
        });

        const [localRows] = await db.query('SELECT id, table_process FROM kpi_indicators');
        let matched = 0, localOnly = 0, withFiscalYear = 0;
        const dsCounts = {};
        for (const local of localRows) {
            const key = local.table_process ? local.table_process.trim() : '';
            const khd = key ? khdMap.get(key) : null;
            if (khd) {
                const fyList = fyMap.get(khd.report_id) || null;
                const khdFiscalYear = fyList ? fyList.join(',') : null;
                if (khdFiscalYear) withFiscalYear++;
                await db.query('UPDATE kpi_indicators SET khd_report_id = ?, data_source = ?, khd_fiscal_year = ? WHERE id = ?', [khd.report_id, khd.data_source, khdFiscalYear, local.id]);
                matched++;
                dsCounts[khd.data_source] = (dsCounts[khd.data_source] || 0) + 1;
            } else {
                // ไม่พบเทียบเคียง — reset ให้ตรงความจริง (local-only) กันค่าเก่าค้างจาก sync ครั้งก่อนที่ table_process เปลี่ยนไปแล้ว
                await db.query('UPDATE kpi_indicators SET khd_report_id = NULL, data_source = NULL, khd_fiscal_year = NULL WHERE id = ?', [local.id]);
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
const KHD_MAP_COLUMN = { dept: 'dept', main: 'main_indicator', yut: 'main_yut' };

apiRouter.get('/khd-mappings', authenticateToken, isSuperAdmin, async (req, res) => {
    const kind = String(req.query.kind || '');
    if (!khdMapping.KHD_MAP_KINDS.includes(kind)) return res.status(400).json({ success: false, message: 'kind ต้องเป็น dept, main หรือ yut' });
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        const col = KHD_MAP_COLUMN[kind];
        const [khdRows] = await remoteDb.query(
            `SELECT ${col} AS v, table_process FROM reports
             WHERE data_source = 'excel' AND ${col} IS NOT NULL AND TRIM(${col}) <> ''`
        );
        // ชื่อเต็มของรหัสหน่วยงานจากตาราง departments ของ KHD (ช่วยตัดสินใจ — ไม่บังคับมี)
        let khdLabels = new Map();
        if (kind === 'dept') {
            try {
                const [d] = await remoteDb.query('SELECT dept_code, dept_name FROM departments');
                khdLabels = new Map(d.map(r => [khdMapping.normKhd(r.dept_code), r.dept_name]));
            } catch (_) { /* KHD ไม่มีตาราง departments */ }
        }
        const [localTp] = await db.query("SELECT table_process FROM kpi_indicators WHERE table_process IS NOT NULL AND table_process <> ''");
        const tpSet = new Set(localTp.map(r => String(r.table_process).trim()));
        const groups = new Map();   // normKhd(ค่า) → { khd_value, report_count, missing_count }
        for (const r of khdRows) {
            const n = khdMapping.normKhd(r.v);
            if (!n) continue;
            if (!groups.has(n)) groups.set(n, { khd_value: String(r.v).replace(/[\s\u200b\u00a0]+/g, ' ').trim(), report_count: 0, missing_count: 0 });
            const g = groups.get(n);
            g.report_count++;
            if (r.table_process && !tpSet.has(String(r.table_process).trim())) g.missing_count++;
        }
        const resolver = await loadKhdResolver(db);
        const [maps] = await db.query('SELECT khd_key, local_id, updated_at FROM khd_value_mappings WHERE kind = ?', [kind]);
        const mapByKey = new Map(maps.map(m => [m.khd_key, m]));
        const items = [...groups.values()].map(g => ({
            ...g,
            khd_label: khdLabels.get(khdMapping.normKhd(g.khd_value)) || null,
            resolved: resolver.resolve(kind, g.khd_value),
            mapping: mapByKey.get(khdMapping.khdKey(g.khd_value)) || null,
        })).sort((a, b) => b.missing_count - a.missing_count || b.report_count - a.report_count);
        const optionSql = {
            dept: 'SELECT id, dept_name AS name, dept_code AS code FROM departments ORDER BY dept_name',
            main: 'SELECT mi.id, mi.main_indicator_name AS name, y.yut_name AS code FROM kpi_main_indicators mi LEFT JOIN main_yut y ON y.id = mi.yut_id ORDER BY mi.main_indicator_name',
            yut: 'SELECT id, yut_name AS name, NULL AS code FROM main_yut ORDER BY id',
        }[kind];
        const [options] = await db.query(optionSql);
        const summary = { total: items.length, unmatched: 0, auto: 0, mapped: 0, ignored: 0 };
        items.forEach(i => { summary[i.resolved.status] = (summary[i.resolved.status] || 0) + 1; });
        res.json({ success: true, kind, summary, items, options });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
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
