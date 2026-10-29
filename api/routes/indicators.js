// เส้นทาง: ยุทธศาสตร์ หมวดหมู่หลัก ตัวชี้วัด ข้อย่อย กิจกรรม ผลงานหลายระดับ
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const kpiRollup = require('../kpi-rollup');
const { normalizeTargetMonthly } = require('../kpi-target');
const { ROLE_ADMIN_ALL, ROLE_SCOPE_DISTRICT, ROLE_SCOPE_HOSPCODE, ROLE_SCOPE_OWN_DEPT, getDistrictId, getPermsForUser, hasPageAccess, requireAction } = require('../core/access');
const { ROLLED_SUB_MESSAGE, activeSubTree, getHierarchyMaxLevels, loadSubAggregates, rolledSubIds, subLevelIn } = require('../services/hierarchy');
const { _actorLabel, normTargetCondition, normalizeEvalMode, normalizeOffTypes } = require('../services/indicator-fields');
const { apiRouter } = require('../core/router');
const { parseActiveFlag, ACTIVE_FLAG_REQUIRED } = require('../core/validate');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { customVarsOf, normalizeCustomVars, parseFormulaInput } = require('../services/formula-vars');
const { getUserAuditInfo, logKpiSaveAudit } = require('../services/kpi-audit');
const { notifyLineAction } = require('../core/notify');
const { refreshSummaryAfterSubSave, scheduleSummaryRefresh } = require('../services/summary');

// --- CRUD Main Yut (ยุทธศาสตร์) ---
apiRouter.get('/main-yut', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM main_yut ORDER BY id');
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching strategies' });
    }
});

apiRouter.post('/main-yut', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { yut_name, yut_code, description, sort_order } = req.body;
    if (!yut_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อยุทธศาสตร์' });
    try {
        await db.query(
            'INSERT INTO main_yut (yut_name, yut_code, description, sort_order) VALUES (?, ?, ?, ?)',
            [yut_name, yut_code || null, description || null, sort_order || 0]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/main-yut/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { yut_name, yut_code, description, sort_order, is_active } = req.body;
    if (!yut_name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อยุทธศาสตร์' });
    try {
        await db.query(
            'UPDATE main_yut SET yut_name=?, yut_code=?, description=?, sort_order=?, is_active=? WHERE id=?',
            [yut_name, yut_code || null, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.delete('/main-yut/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM main_yut WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting strategy' });
    }
});

// --- CRUD Main Indicators (ตัวชี้วัดหลัก) ---
apiRouter.get('/main-indicators', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT mi.*, my.yut_name 
            FROM kpi_main_indicators mi 
            LEFT JOIN main_yut my ON mi.yut_id = my.id 
            ORDER BY mi.id
        `);
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching main indicators' });
    }
});

apiRouter.post('/main-indicators', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const name = req.body.main_indicator_name || req.body.indicator_name;
    const { yut_id, main_indicator_code, description, sort_order } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหมวดหมู่หลัก' });
    try {
        await db.query(
            'INSERT INTO kpi_main_indicators (main_indicator_name, yut_id, main_indicator_code, description, sort_order) VALUES (?, ?, ?, ?, ?)',
            [name, yut_id || null, main_indicator_code || null, description || null, sort_order || 0]
        );
        res.json({ success: true, message: 'Created successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/main-indicators/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const name = req.body.main_indicator_name || req.body.indicator_name;
    const { yut_id, main_indicator_code, description, sort_order, is_active } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อหมวดหมู่หลัก' });
    try {
        await db.query(
            'UPDATE kpi_main_indicators SET main_indicator_name=?, yut_id=?, main_indicator_code=?, description=?, sort_order=?, is_active=? WHERE id=?',
            [name, yut_id || null, main_indicator_code || null, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.delete('/main-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_main_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting main indicator' });
    }
});

// --- CRUD KPI Indicators (ตัวชี้วัดย่อย) ---
apiRouter.get('/indicators', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let whereClause = '';
        const params = [];
        // กรองตาม dept ของ user — เฉพาะ role ที่ scope คือ "dept ตัวเอง" (ROLE_SCOPE_OWN_DEPT)
        // เดิมกรองด้วย user.deptId != null ตรงๆ ทำให้ admin_cup/admin_hos/admin_sso (scope "ทุก dept") โดนจำกัดผิดๆ
        // เวลาบัญชีของ role เหล่านั้นบังเอิญมี dept_id ติดตัวอยู่ (พบจริงจากข้อมูล — admin_cup 11/20 บัญชีมี dept_id)
        const conds = [];
        if (ROLE_SCOPE_OWN_DEPT.includes(user.role) && user.deptId != null) {
            conds.push('i.dept_id = ?');
            params.push(user.deptId);
        }
        // ค่าเริ่มต้น: เฉพาะตัวชี้วัดที่เปิดใช้งาน (dropdown ทั่วระบบ) — ?include_inactive=1 ให้หน้าจัดการตัวชี้วัดเห็นทุกตัว
        // (เฉพาะ role ที่เข้าหน้า kpi-manage ได้ — role อื่นส่งมาก็ได้แค่ตัวที่เปิดใช้งาน)
        const includeInactive = String(req.query.include_inactive || '') === '1' && hasPageAccess(user.role, 'kpi-manage');
        if (!includeInactive) conds.push('i.is_active = 1');
        if (conds.length) whereClause = 'WHERE ' + conds.join(' AND ');
        const [rows] = await db.query(`
            SELECT i.*, mi.main_indicator_name, COALESCE(mi.yut_id, i.main_yut) AS yut_id, my.yut_name, d.dept_name,
                   COALESCE(rc.cnt, 0) + COALESCE(src.cnt, 0) AS result_count
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN main_yut my ON my.id = COALESCE(mi.yut_id, i.main_yut)
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN (
                SELECT indicator_id, COUNT(*) AS cnt FROM kpi_results
                WHERE actual_value IS NOT NULL AND actual_value != '' GROUP BY indicator_id
            ) rc ON rc.indicator_id = i.id
            LEFT JOIN (
                SELECT si.indicator_id, COUNT(*) AS cnt FROM kpi_sub_results sr
                JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
                WHERE sr.actual_value IS NOT NULL AND sr.actual_value != '' GROUP BY si.indicator_id
            ) src ON src.indicator_id = i.id
            ${whereClause}
            ORDER BY i.id DESC
        `, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Error fetching indicators:', error);
        res.status(500).json({ success: false, message: 'Error fetching indicators' });
    }
});

apiRouter.post('/indicators/bulk-import', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลสำหรับนำเข้า' });
    const results = [];
    for (const row of rows) {
        const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula } = row;
        const formula = parseFormulaInput(result_formula);
        if (formula.error) { results.push({ name: kpi_indicators_name, status: 'error', message: formula.error }); continue; }
        try {
            const [r] = await db.query(
                `INSERT INTO kpi_indicators (kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, normTargetCondition(target_condition), criterion || null, weight || null, kpi_indicators_code || null, table_process || null, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types), is_cumulative ? 1 : 0, use_sub_indicator_export ? 1 : 0, formula.value]
            );
            results.push({ name: kpi_indicators_name, status: 'success', id: r.insertId });
        } catch (e) {
            results.push({ name: kpi_indicators_name, status: 'error', message: e.message });
        }
    }
    const inserted = results.filter(r => r.status === 'success').length;
    const errors = results.filter(r => r.status === 'error');
    try {
        const actor = await _actorLabel(req.user.userId);
        notifyLineAction('indicator_change',
            `📥 นำเข้าตัวชี้วัดจาก Excel\n` +
            `👤 ${actor}\n` +
            `✅ สำเร็จ: ${inserted} รายการ` +
            (errors.length ? `\n❌ ผิดพลาด: ${errors.length} รายการ` : '')
        );
    } catch (_) {}
    res.json({ success: true, inserted, errors, results });
});

// แนะนำรหัสสำหรับตัวชี้วัดใหม่ — ผู้ใช้ไม่ต้องคิดรหัสเอง (11 ต.ค. 2569)
//   ชื่อตาราง (table_process) = kpi_<หน่วยงาน>_<ลำดับ 3 หลัก> เช่น kpi_dh_001 — <หน่วยงาน> = รหัสย่อหน่วยงานถ้าเป็น a-z/0-9 (dh, ncd, ems)
//   ไม่งั้นใช้ d<id 2 หลัก> (เช่น d07) / ไม่เลือกหน่วยงาน = gen — ลำดับ = เลขถัดจากค่าสูงสุดที่มีอยู่ของ prefix เดียวกัน (ไม่ซ้ำ)
//   รหัสตัวชี้วัด (kpi_indicators_code) = ชื่อตารางแบบใช้ขีดกลาง (ตามรูปแบบข้อมูลเดิม เช่น excellence-indicator-1-1)
//   รหัสอ้างอิง (kpi_indicators_id) ไม่สร้างให้ — ในข้อมูลจริงคือเลขรายงานของ KHD ใช้เฉพาะตัวชี้วัดที่มาจาก KHD
async function suggestIndicatorCodes(conn, deptId) {
    let key = 'gen';
    if (deptId) {
        const [dRows] = await conn.query('SELECT id, dept_code FROM departments WHERE id = ?', [deptId]);
        if (dRows[0]) {
            const c = String(dRows[0].dept_code || '').trim().toLowerCase();
            key = /^[a-z][a-z0-9]{0,9}$/.test(c) ? c : 'd' + String(dRows[0].id).padStart(2, '0');
        }
    }
    const prefix = `kpi_${key}_`;
    const [rows] = await conn.query('SELECT table_process FROM kpi_indicators WHERE table_process LIKE ?', [prefix.replace(/_/g, '\\_') + '%']);
    let max = 0;
    for (const r of rows) {
        const m = String(r.table_process).slice(prefix.length).match(/^(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const table_process = prefix + String(max + 1).padStart(3, '0');
    return { table_process, kpi_indicators_code: table_process.replace(/_/g, '-') };
}

apiRouter.get('/indicators/suggest-code', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        const deptId = req.query.dept_id ? Number(req.query.dept_id) : null;
        res.json({ success: true, data: await suggestIndicatorCodes(db, Number.isFinite(deptId) ? deptId : null) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.post('/indicators', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    // ค่าเพิ่มเติมที่ตั้งชื่อเอง + สูตรร้อยละ (ตรวจชื่อตัวแปรในสูตรตามค่าที่ประกาศ)
    const cvars = normalizeCustomVars(req.body.custom_vars);
    if (cvars.error) return res.status(400).json({ success: false, message: cvars.error });
    const cvKeys = cvars.list.map(v => v.key);
    const formula = parseFormulaInput(result_formula, cvKeys);
    if (formula.error) return res.status(400).json({ success: false, message: formula.error });
    const pctF = parseFormulaInput(req.body.pct_formula, cvKeys, ['result'], 'สูตรร้อยละ');
    if (pctF.error) return res.status(400).json({ success: false, message: pctF.error });
    try {
        // ไม่ได้กรอกชื่อตาราง → ระบบสร้างรหัสให้อัตโนมัติ (รหัสตัวชี้วัดสร้างตามถ้าไม่ได้กรอก)
        let tpFinal = table_process && String(table_process).trim() ? String(table_process).trim() : null;
        let codeFinal = kpi_indicators_code && String(kpi_indicators_code).trim() ? String(kpi_indicators_code).trim() : null;
        if (!tpFinal) {
            const sug = await suggestIndicatorCodes(db, dept_id || null);
            tpFinal = sug.table_process;
        }
        if (!codeFinal) codeFinal = tpFinal.replace(/_/g, '-');
        const [r] = await db.query(
            `INSERT INTO kpi_indicators (kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, normTargetCondition(target_condition), criterion || null, weight || null, codeFinal, tpFinal, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types), is_cumulative ? 1 : 0, use_sub_indicator_export ? 1 : 0, formula.value]
        );
        // LINE notify: created
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `➕ สร้างตัวชี้วัดใหม่\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${r.insertId}\n` +
                `📌 ${kpi_indicators_name}` +
                `\n🔑 table_process: ${tpFinal}`
            );
        } catch (_) {}
        await saveHierarchyFields(db, 'kpi_indicators', r.insertId, req.body);
        res.json({ success: true, message: 'Created successfully', id: r.insertId, table_process: tpFinal, kpi_indicators_code: codeFinal });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.put('/indicators/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    const { kpi_indicators_name, kpi_indicators_id, main_indicator_id, dept_id, target_percentage, target_condition, criterion, weight, kpi_indicators_code, is_active, table_process, description, r9, moph, ssj, rmw, other, evaluation_mode, required_off_types, is_cumulative, use_sub_indicator_export, result_formula } = req.body;
    if (table_process && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table_process)) {
        return res.status(400).json({ success: false, message: 'table_process ต้องเป็น a-z, A-Z, 0-9, _ ขึ้นต้นด้วยตัวอักษร' });
    }
    // ค่าเพิ่มเติมที่ตั้งชื่อเอง + สูตรร้อยละ — ไม่ส่ง custom_vars/pct_formula มา = ใช้ค่าเดิม (ผู้เรียกเดิมไม่กระทบ)
    let cvKeys;
    let pctRaw = req.body.pct_formula;
    {
        const [cur] = await db.query('SELECT custom_vars, pct_formula FROM kpi_indicators WHERE id = ?', [req.params.id]).catch(() => [[]]);
        const cvars = req.body.custom_vars !== undefined ? normalizeCustomVars(req.body.custom_vars) : { list: customVarsOf(cur[0]), error: null };
        if (cvars.error) return res.status(400).json({ success: false, message: cvars.error });
        cvKeys = cvars.list.map(v => v.key);
        if (pctRaw === undefined && cur[0]) pctRaw = cur[0].pct_formula;
    }
    const formula = parseFormulaInput(result_formula, cvKeys);
    if (formula.error) return res.status(400).json({ success: false, message: formula.error });
    const pctF = parseFormulaInput(pctRaw, cvKeys, ['result'], 'สูตรร้อยละ');
    if (pctF.error) return res.status(400).json({ success: false, message: pctF.error });
    try {
        // ดึง old row เพื่อหาว่าฟิลด์ไหนเปลี่ยน (diff สั้นๆ)
        let diff = '';
        let calcChanged = false; // สูตร/สะสม เปลี่ยน → ต้องคำนวณ kpi_summary ใหม่
        try {
            const [oldRow] = await db.query('SELECT kpi_indicators_name, is_active, table_process, target_percentage, criterion, is_cumulative, result_formula, result_manual, pct_manual, target_monthly FROM kpi_indicators WHERE id = ?', [req.params.id]);
            if (oldRow[0]) {
                const o = oldRow[0];
                const changes = [];
                if (o.kpi_indicators_name !== kpi_indicators_name) changes.push('ชื่อ');
                if (Number(o.is_active) !== (is_active ? 1 : 0)) changes.push(`สถานะ→${is_active ? 'เปิด' : 'ปิด'}`);
                if ((o.table_process || '') !== (table_process || '')) changes.push('table_process');
                if (String(o.target_percentage || '') !== String(target_percentage || '')) changes.push('เป้าหมาย');
                if (String(o.criterion || '') !== String(criterion || '')) changes.push('เกณฑ์');
                if ((o.result_formula || '') !== (formula.value || '')) {
                    changes.push(formula.value ? `สูตรคำนวณผลงาน→${formula.value}` : 'ยกเลิกสูตรคำนวณผลงาน');
                    calcChanged = true;
                }
                if (Number(o.is_cumulative || 0) !== (is_cumulative ? 1 : 0)) calcChanged = true;
                // เปลี่ยนวิธีได้ผลงานล่าสุด/ร้อยละ (คำนวณ ↔ กรอกเอง) → คำนวณตารางสรุปใหม่ (29 ต.ค. 2569)
                for (const [k, label] of [['result_manual', 'ผลงานล่าสุด'], ['pct_manual', 'ร้อยละ']]) {
                    if (req.body[k] === undefined) continue;
                    const nv = req.body[k] === true || Number(req.body[k]) === 1 ? 1 : 0;
                    if (Number(o[k] || 0) !== nv) { changes.push(`${label}→${nv ? 'กรอกเอง' : 'คำนวณ'}`); calcChanged = true; }
                }
                // เปลี่ยนเป้าหมายรายเดือน (เป้าหมายรวม = ล่าสุด/สะสม) → คำนวณเป้าหมายในตารางสรุปใหม่ (29 ต.ค. 2569)
                if (req.body.target_monthly !== undefined && normalizeTargetMonthly(o.target_monthly) !== normalizeTargetMonthly(req.body.target_monthly)) {
                    const nv = normalizeTargetMonthly(req.body.target_monthly);
                    changes.push(`เป้าหมาย→${nv === 'latest' ? 'รายเดือน (ล่าสุด)' : nv === 'cumulative' ? 'รายเดือน (สะสม)' : 'ค่าเดียวทั้งปี'}`);
                    calcChanged = true;
                }
                if (changes.length > 0) diff = `\n📝 เปลี่ยน: ${changes.join(', ')}`;
            }
        } catch (_) {}

        await db.query(
            `UPDATE kpi_indicators SET kpi_indicators_name=?, kpi_indicators_id=?, main_indicator_id=?, dept_id=?, target_percentage=?, target_condition=?, criterion=?, weight=?, kpi_indicators_code=?, is_active=?, table_process=?, description=?, r9=?, moph=?, ssj=?, rmw=?, other=?, evaluation_mode=?, required_off_types=?, is_cumulative=?, use_sub_indicator_export=?, result_formula=? WHERE id=?`,
            [kpi_indicators_name, kpi_indicators_id || null, main_indicator_id || null, dept_id || null, target_percentage || null, normTargetCondition(target_condition), criterion || null, weight || null, kpi_indicators_code || null, is_active ? 1 : 0, table_process || null, description || null, r9 ? 1 : 0, moph ? 1 : 0, ssj ? 1 : 0, rmw ? 1 : 0, other ? 1 : 0, normalizeEvalMode(evaluation_mode), normalizeOffTypes(required_off_types), is_cumulative ? 1 : 0, use_sub_indicator_export ? 1 : 0, formula.value, req.params.id]
        );
        await saveHierarchyFields(db, 'kpi_indicators', req.params.id, req.body);

        // วิธีคำนวณผลงานเปลี่ยน → คำนวณ kpi_summary ของตัวชี้วัดนี้ใหม่ทุกปีงบทันที ให้กราฟ/รายงานตรงกับหน้าบันทึกผลงาน
        // (ไม่ต้องรอผู้ดูแลกด "อัปเดต Summary") — ทำนอก transaction หลัก ล้มเหลวไม่กระทบการบันทึกตัวชี้วัด
        if (calcChanged) {
            try {
                // ปีงบจาก kpi_results (รวมปีที่ยังไม่มีแถวในตารางสรุป เช่น มีแต่ค่าที่กรอกเอง — 29 ต.ค. 2569)
                const [years] = await db.query('SELECT DISTINCT year_bh FROM kpi_results WHERE indicator_id = ? UNION SELECT DISTINCT year_bh FROM kpi_summary WHERE indicator_id = ?', [req.params.id, req.params.id]);
                if (years.length > 0) {
                    await scheduleSummaryRefresh(years.map(y => ({ indicator_id: Number(req.params.id), year_bh: y.year_bh }))); // ผ่านคิวเดียวกับการบันทึกผลงาน (ไม่รันซ้อนคู่เดียวกัน)
                }
            } catch (e) { console.error('[indicators PUT] refresh kpi_summary failed:', e.message); }
        }
        // LINE notify: updated
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `✏️ แก้ไขตัวชี้วัด\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${req.params.id}\n` +
                `📌 ${kpi_indicators_name}` +
                diff
            );
        } catch (_) {}
        res.json({ success: true, message: 'Updated successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.delete('/indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        // เช็คผลงานที่บันทึกแล้วก่อนลบ — กันข้อมูลสูญหาย (mirror pattern เดียวกับ DELETE /hospitals/:hoscode)
        const [results] = await db.query(
            "SELECT COUNT(*) AS cnt FROM kpi_results WHERE indicator_id = ? AND actual_value IS NOT NULL AND actual_value != ''",
            [id]
        );
        const [subResults] = await db.query(
            `SELECT COUNT(*) AS cnt FROM kpi_sub_results sr
             JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
             WHERE si.indicator_id = ? AND sr.actual_value IS NOT NULL AND sr.actual_value != ''`,
            [id]
        );
        const [actResults] = await db.query(
            `SELECT COUNT(*) AS cnt FROM kpi_activity_results ar
             JOIN kpi_sub_activities a ON ar.activity_id = a.id
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
             WHERE si.indicator_id = ? AND ar.actual_value IS NOT NULL AND ar.actual_value != ''`,
            [id]
        );
        const totalResults = results[0].cnt + subResults[0].cnt + actResults[0].cnt;
        if (totalResults > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: มีผลงานบันทึกแล้ว ${totalResults} รายการ กรุณา "ปิดใช้งาน" แทนการลบ` });
        }
        // ดึงชื่อก่อนลบ
        let oldName = '';
        try {
            const [r] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [id]);
            if (r[0]) oldName = r[0].kpi_indicators_name;
        } catch (_) {}
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
        // LINE notify: deleted
        try {
            const actor = await _actorLabel(req.user.userId);
            notifyLineAction('indicator_change',
                `🗑️ ลบตัวชี้วัด\n` +
                `👤 ${actor}\n` +
                `🆔 ID: ${req.params.id}` +
                (oldName ? `\n📌 ${oldName}` : '')
            );
        } catch (_) {}
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting indicator' });
    }
});

// GET /indicators/:id/result-summary — รายชื่อหน่วยบริการ+ปีที่มีผลงานบันทึกแล้ว (เรียกเมื่อคลิก badge เท่านั้น)
apiRouter.get('/indicators/:id/result-summary', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT r.hospcode, h.hosname, r.year_bh, COUNT(*) AS month_count
            FROM kpi_results r
            LEFT JOIN chospital h ON h.hoscode = r.hospcode
            WHERE r.indicator_id = ? AND r.actual_value IS NOT NULL AND r.actual_value != ''
            GROUP BY r.hospcode, r.year_bh
            ORDER BY r.year_bh DESC, h.hosname
        `, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== KPI Sub-Indicators CRUD ==========
apiRouter.get('/sub-indicators', authenticateToken, async (req, res) => {
    try {
        const { indicator_id } = req.query;
        let sql = `SELECT si.*, i.kpi_indicators_name,
                   (SELECT COUNT(*) FROM kpi_sub_activities a WHERE a.sub_indicator_id = si.id AND a.is_active = 1) AS activity_count,
                   (SELECT COUNT(*) FROM kpi_sub_indicators c WHERE c.parent_sub_id = si.id AND c.is_active = 1) AS child_count
                   FROM kpi_sub_indicators si
                   LEFT JOIN kpi_indicators i ON si.indicator_id = i.id`;
        const params = [];
        if (indicator_id) { sql += ' WHERE si.indicator_id = ?'; params.push(indicator_id); }
        sql += ' ORDER BY si.indicator_id, si.sort_order, si.id';
        const [rows] = await db.query(sql, params);
        const byInd = new Map();
        for (const r of rows) { if (!byInd.has(r.indicator_id)) byInd.set(r.indicator_id, []); byInd.get(r.indicator_id).push(r); }
        for (const r of rows) r.level = subLevelIn(byInd.get(r.indicator_id), r.id);
        res.json({ success: true, data: rows, max_levels: await getHierarchyMaxLevels() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-indicators', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        let { indicator_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order, parent_sub_id } = req.body;
        let parentId = null;
        if (parent_sub_id !== undefined && parent_sub_id !== null && parent_sub_id !== '') {
            parentId = Number(parent_sub_id);
            const [[parent]] = await db.query('SELECT id, indicator_id FROM kpi_sub_indicators WHERE id = ?', [parentId]);
            if (!parent) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดย่อยที่เป็นข้อแม่' });
            if (indicator_id && Number(indicator_id) !== Number(parent.indicator_id)) {
                return res.status(400).json({ success: false, message: 'ข้อแม่ต้องอยู่ในตัวชี้วัดหลักเดียวกัน' });
            }
            indicator_id = parent.indicator_id;
            const [siblings] = await db.query('SELECT id, parent_sub_id FROM kpi_sub_indicators WHERE indicator_id = ?', [indicator_id]);
            const maxLevels = await getHierarchyMaxLevels();
            // ข้อย่อยใหม่ต้องเหลือที่ให้กิจกรรมอีก 1 ระดับ → ระดับของข้อใหม่ ≤ จำนวนระดับสูงสุด − 1
            if (subLevelIn(siblings, parentId) + 1 > maxLevels - 1) {
                return res.status(400).json({ success: false, message: `เพิ่มข้อย่อยได้ไม่เกิน ${maxLevels - 1} ระดับ (รวมตัวชี้วัดหลัก) — ระดับสุดท้ายสงวนไว้สำหรับกิจกรรม` });
            }
        }
        if (!indicator_id || !sub_indicator_name) return res.status(400).json({ success: false, message: 'indicator_id + sub_indicator_name required' });
        const [r] = await db.query(
            `INSERT INTO kpi_sub_indicators (indicator_id, parent_sub_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
            [indicator_id, parentId, sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0]
        );
        await saveHierarchyFields(db, 'kpi_sub_indicators', r.insertId, req.body);
        res.json({ success: true, id: r.insertId, message: 'เพิ่มตัวชี้วัดย่อยสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /sub-indicators/bulk-import — นำเข้าตัวชี้วัดย่อยหลายรายการจาก Excel (scoped ต่อ indicator_id เดียว)
apiRouter.post('/sub-indicators/bulk-import', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { indicator_id, rows } = req.body;
    if (!indicator_id) return res.status(400).json({ success: false, message: 'ไม่พบ indicator_id' });
    if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลสำหรับนำเข้า' });
    const [indRows] = await db.query('SELECT id FROM kpi_indicators WHERE id = ?', [indicator_id]);
    if (indRows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดหลัก' });

    const results = [];
    for (const row of rows) {
        const { sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order } = row;
        try {
            const [r] = await db.query(
                `INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order) VALUES (?,?,?,?,?,?,?)`,
                [indicator_id, sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0]
            );
            results.push({ name: sub_indicator_name, status: 'success', id: r.insertId });
        } catch (e) {
            results.push({ name: sub_indicator_name, status: 'error', message: e.message });
        }
    }
    const inserted = results.filter(r => r.status === 'success').length;
    const errors = results.filter(r => r.status === 'error');
    res.json({ success: true, inserted, errors, results });
});

apiRouter.put('/sub-indicators/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { sub_indicator_name, sub_indicator_code, target_percentage, weight, description, sort_order, is_active } = req.body;
        await db.query(
            `UPDATE kpi_sub_indicators SET sub_indicator_name=?, sub_indicator_code=?, target_percentage=?, weight=?, description=?, sort_order=?, is_active=? WHERE id=?`,
            [sub_indicator_name, sub_indicator_code || null, target_percentage || null, weight || 1, description || null, sort_order || 0, is_active ? 1 : 0, req.params.id]
        );
        await saveHierarchyFields(db, 'kpi_sub_indicators', req.params.id, req.body);
        res.json({ success: true, message: 'แก้ไขสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/sub-indicators/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        // ลบข้อย่อย = ลบข้อลูก กิจกรรม และผลงานทั้งสาย (FK CASCADE) — ต้องไม่มีผลงานบันทึกอยู่ (เดิมไม่ตรวจ ลบผลงานเงียบๆ)
        const [[me]] = await db.query('SELECT id, indicator_id FROM kpi_sub_indicators WHERE id = ?', [req.params.id]);
        if (!me) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดย่อย' });
        const [all] = await db.query('SELECT id, parent_sub_id FROM kpi_sub_indicators WHERE indicator_id = ?', [me.indicator_id]);
        const ids = new Set([Number(me.id)]);
        for (let grew = true; grew;) {
            grew = false;
            for (const s of all) if (s.parent_sub_id != null && ids.has(Number(s.parent_sub_id)) && !ids.has(Number(s.id))) { ids.add(Number(s.id)); grew = true; }
        }
        const idList = [...ids];
        const [[c]] = await db.query(
            `SELECT (SELECT COUNT(*) FROM kpi_sub_results WHERE sub_indicator_id IN (?) AND actual_value IS NOT NULL AND actual_value <> '')
                  + (SELECT COUNT(*) FROM kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id
                     WHERE a.sub_indicator_id IN (?) AND ar.actual_value IS NOT NULL AND ar.actual_value <> '') AS cnt`, [idList, idList]);
        if (Number(c.cnt) > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: ข้อนี้หรือระดับล่างมีผลงานบันทึกแล้ว ${c.cnt} รายการ กรุณา "ปิดใช้งาน" แทนการลบ` });
        }
        await db.query('DELETE FROM kpi_sub_indicators WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-indicators/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        // ต้องระบุ is_active ชัดเจน — เดิมไม่ส่งค่า = ปิดใช้งาน, id ที่ไม่มี = "สำเร็จ" (25 ต.ค. 2569)
        const is_active = parseActiveFlag((req.body || {}).is_active);
        if (is_active === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
        const [upd] = await db.query('UPDATE kpi_sub_indicators SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
        if (!upd.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ========== ตัวชี้วัด 3 ระดับ (18 ต.ค. 2569): หลัก 1 → ย่อย 1.1 → กิจกรรม 1.1.1 ==========
// item_no = เลขข้อที่แสดง (ว่าง = หน้าจอสร้างจากลำดับ), sub_rollup_mode (ตัวชี้วัดหลัก) / rollup_mode (ข้อย่อย) = 'auto' | 'manual'
// อัปเดตเฉพาะฟิลด์ที่ส่งมา — ผู้เรียกเดิม (KHD sync, คัดลอก, นำเข้า) ที่ไม่ส่งฟิลด์เหล่านี้ไม่ถูกเปลี่ยนค่า
async function saveHierarchyFields(conn, table, id, body) {
    const sets = [], params = [];
    if (body && body.item_no !== undefined) {
        sets.push('item_no = ?');
        params.push(String(body.item_no || '').trim().slice(0, 20) || null);
    }
    const modeKey = table === 'kpi_indicators' ? 'sub_rollup_mode' : 'rollup_mode';
    if (body && body[modeKey] !== undefined) {
        sets.push(`${modeKey} = ?`);
        params.push(body[modeKey] === 'auto' ? 'auto' : 'manual');
    }
    if (table === 'kpi_indicators' && body && body.export_items !== undefined) {
        sets.push('export_items = ?');
        params.push(body.export_items === true || Number(body.export_items) === 1 ? 1 : 0);
    }
    if (table === 'kpi_indicators' && body && body.custom_vars !== undefined) {
        const list = normalizeCustomVars(body.custom_vars).list;
        sets.push('custom_vars = ?');
        params.push(list.length ? JSON.stringify(list) : null);
    }
    // ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569)
    for (const k of ['result_manual', 'pct_manual']) {
        if (table === 'kpi_indicators' && body && body[k] !== undefined) {
            sets.push(`${k} = ?`);
            params.push(body[k] === true || Number(body[k]) === 1 ? 1 : 0);
        }
    }
    // เป้าหมายรายเดือน (29 ต.ค. 2569): 'latest' | 'cumulative' | ว่าง = เป้าหมายเดียวทั้งปี
    if (table === 'kpi_indicators' && body && body.target_monthly !== undefined) {
        sets.push('target_monthly = ?');
        params.push(normalizeTargetMonthly(body.target_monthly) || null);
    }
    if (table === 'kpi_indicators' && body && body.pct_formula !== undefined) {
        sets.push('pct_formula = ?');
        params.push(String(body.pct_formula || '').trim().slice(0, 500) || null);
    }
    // ยุทธศาสตร์ของตัวชี้วัดโดยตรง (ใช้แสดงเมื่อไม่มีหมวดหมู่หลัก — 19 ต.ค. 2569)
    if (table === 'kpi_indicators' && body && body.main_yut !== undefined) {
        const y = Number(body.main_yut);
        sets.push('main_yut = ?');
        params.push(Number.isInteger(y) && y > 0 ? y : null);
    }
    if (sets.length === 0) return;
    await conn.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
}

// --- CRUD กิจกรรม (สิทธิ์เดียวกับตัวชี้วัดย่อย: เพิ่ม/แก้ไขตาม requireAction, ลบ = super_admin เท่านั้น) ---
const normalizeActivityType = (t) => (t === 'check' ? 'check' : 'number');

apiRouter.get('/sub-activities', authenticateToken, async (req, res) => {
    try {
        const { sub_indicator_id, indicator_id } = req.query;
        const conds = [], params = [];
        if (sub_indicator_id) { conds.push('a.sub_indicator_id = ?'); params.push(sub_indicator_id); }
        if (indicator_id) { conds.push('si.indicator_id = ?'); params.push(indicator_id); }
        const [rows] = await db.query(
            `SELECT a.*, si.indicator_id, si.sub_indicator_name FROM kpi_sub_activities a
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
             ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
             ORDER BY a.sub_indicator_id, a.sort_order, a.id`, params);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-activities', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    try {
        const { sub_indicator_id, activity_name, activity_code, item_no, value_type, target_percentage, sort_order } = req.body;
        if (!sub_indicator_id || !activity_name || !String(activity_name).trim()) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุตัวชี้วัดย่อยและชื่อกิจกรรม' });
        }
        const [si] = await db.query('SELECT id, indicator_id FROM kpi_sub_indicators WHERE id = ?', [sub_indicator_id]);
        if (si.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัดย่อย' });
        const [tree] = await db.query('SELECT id, parent_sub_id FROM kpi_sub_indicators WHERE indicator_id = ?', [si[0].indicator_id]);
        const maxLevels = await getHierarchyMaxLevels();
        if (subLevelIn(tree, sub_indicator_id) + 1 > maxLevels) {
            return res.status(400).json({ success: false, message: `กิจกรรมต้องอยู่ไม่เกินระดับที่ ${maxLevels}` });
        }
        const [r] = await db.query(
            `INSERT INTO kpi_sub_activities (sub_indicator_id, activity_name, activity_code, item_no, value_type, target_percentage, sort_order)
             VALUES (?,?,?,?,?,?,?)`,
            [sub_indicator_id, String(activity_name).trim(), activity_code || null, String(item_no || '').trim().slice(0, 20) || null,
             normalizeActivityType(value_type), target_percentage || null, Number(sort_order) || 0]);
        res.json({ success: true, id: r.insertId, message: 'เพิ่มกิจกรรมสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-activities/:id', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        const { activity_name, activity_code, item_no, value_type, target_percentage, sort_order, is_active } = req.body;
        if (!activity_name || !String(activity_name).trim()) return res.status(400).json({ success: false, message: 'กรุณาระบุชื่อกิจกรรม' });
        await db.query(
            `UPDATE kpi_sub_activities SET activity_name=?, activity_code=?, item_no=?, value_type=?, target_percentage=?, sort_order=?, is_active=? WHERE id=?`,
            [String(activity_name).trim(), activity_code || null, String(item_no || '').trim().slice(0, 20) || null,
             normalizeActivityType(value_type), target_percentage || null, Number(sort_order) || 0, is_active === undefined || is_active ? 1 : 0, req.params.id]);
        res.json({ success: true, message: 'แก้ไขสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/sub-activities/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        // ต้องระบุ is_active ชัดเจน — เดิมไม่ส่งค่า = ปิดใช้งาน, id ที่ไม่มี = "สำเร็จ" (25 ต.ค. 2569)
        const is_active = parseActiveFlag((req.body || {}).is_active);
        if (is_active === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
        const [upd] = await db.query('UPDATE kpi_sub_activities SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
        if (!upd.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/sub-activities/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [[cnt]] = await db.query("SELECT COUNT(*) AS cnt FROM kpi_activity_results WHERE activity_id = ? AND actual_value IS NOT NULL AND actual_value != ''", [req.params.id]);
        if (cnt.cnt > 0) {
            return res.status(400).json({ success: false, message: `ไม่สามารถลบได้: มีผลงานบันทึกแล้ว ${cnt.cnt} รายการ กรุณา "ปิดใช้งาน" แทนการลบ` });
        }
        await db.query('DELETE FROM kpi_sub_activities WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ขอบเขตหน่วยบริการตามบทบาท (ROLE_SCOPE_HOSPCODE = หน่วยบริการตัวเอง, ROLE_SCOPE_DISTRICT = อำเภอตัวเอง, อื่นๆ = ทุกหน่วย)
async function canAccessHospcode(user, hospcode) {
    if (!hospcode) return false;
    if (ROLE_SCOPE_HOSPCODE.includes(user.role)) return String(user.hospcode || '') === String(hospcode);
    if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
        const [mine, target] = await Promise.all([getDistrictId(user.hospcode), getDistrictId(hospcode)]);
        return !!mine && mine === target;
    }
    return true;
}

// สถานะ "ล็อคการคีย์ข้อมูล" ของระบบ (ตั้งค่าที่หน้า settings) — ใช้ร่วม GET /data-entry-lock และการบันทึกผลงานระดับย่อย/กิจกรรม
async function getDataEntryLockState() {
    const keys = ['data_entry_locked', 'data_entry_lock_start', 'data_entry_lock_end', 'data_entry_lock_days'];
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
    const st = {};
    for (const r of rows) st[r.setting_key] = r.setting_value;
    const manualLock = st.data_entry_locked === 'true';
    const startDate = st.data_entry_lock_start || '';
    let effectiveEnd = st.data_entry_lock_end || '';
    const lockDays = parseInt(st.data_entry_lock_days) || 0;
    if (startDate && lockDays > 0) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + lockDays);
        effectiveEnd = d.toISOString().split('T')[0];
    }
    const today = new Date().toISOString().split('T')[0];
    return manualLock || !!(startDate && effectiveEnd && today >= startDate && today <= effectiveEnd);
}

// GET /hierarchy-results?indicator_id=&year_bh=&hospcode= — โครงสร้างข้อย่อย + กิจกรรม + ผลงานรายเดือนของ 1 แถวในหน้าบันทึกผลงาน
// (โหลดเมื่อผู้ใช้กดขยายแถว) — หน้าจอคำนวณค่าระดับบนเองด้วย shared/kpi-rollup.ts (กติกาเดียวกับ backend)
apiRouter.get('/hierarchy-results', authenticateToken, async (req, res) => {
    try {
        const { indicator_id, year_bh, hospcode } = req.query;
        if (!indicator_id || !year_bh || !hospcode) return res.status(400).json({ success: false, message: 'ต้องระบุ indicator_id, year_bh, hospcode' });
        if (!(await canAccessHospcode(req.user, hospcode))) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูข้อมูลหน่วยบริการนี้' });
        const [[ind]] = await db.query('SELECT id, item_no, sub_rollup_mode FROM kpi_indicators WHERE id = ?', [indicator_id]);
        if (!ind) return res.status(404).json({ success: false, message: 'ไม่พบตัวชี้วัด' });
        const [allSubs] = await db.query(
            `SELECT id, parent_sub_id, is_active, sub_indicator_name, sub_indicator_code, item_no, rollup_mode, target_percentage, sort_order
             FROM kpi_sub_indicators WHERE indicator_id = ? ORDER BY sort_order, id`, [indicator_id]);
        // เฉพาะข้อที่เปิดใช้งานและข้อแม่ทุกชั้นเปิดใช้งาน (ตัวชี้วัดหลายระดับ — 19 ต.ค. 2569)
        const subs = activeSubTree(allSubs).map(({ is_active, ...rest }) => rest);
        const subIds = subs.map(x => x.id);
        let acts = [], subRes = [], actRes = [];
        if (subIds.length > 0) {
            [acts] = await db.query(
                `SELECT id, sub_indicator_id, activity_name, activity_code, item_no, value_type, target_percentage, sort_order
                 FROM kpi_sub_activities WHERE sub_indicator_id IN (?) AND is_active = 1 ORDER BY sort_order, id`, [subIds]);
            [subRes] = await db.query(
                'SELECT sub_indicator_id, month_bh, target_value, actual_value, is_locked FROM kpi_sub_results WHERE sub_indicator_id IN (?) AND year_bh = ? AND hospcode = ?',
                [subIds, year_bh, hospcode]);
            if (acts.length > 0) {
                [actRes] = await db.query(
                    'SELECT activity_id, month_bh, target_value, actual_value, is_locked FROM kpi_activity_results WHERE activity_id IN (?) AND year_bh = ? AND hospcode = ?',
                    [acts.map(a => a.id), year_bh, hospcode]);
            }
        }
        const pack = (rows, idKey) => {
            const m = new Map();
            for (const r of rows) {
                if (!m.has(r[idKey])) m.set(r[idKey], { months: {}, target: null, locked: false });
                const e = m.get(r[idKey]);
                e.months[Number(r.month_bh)] = r.actual_value != null ? String(r.actual_value) : '';
                if (Number(r.month_bh) === 10 && r.target_value != null && r.target_value !== '') e.target = String(r.target_value);
                if (Number(r.is_locked) === 1) e.locked = true;
            }
            return m;
        };
        const subMap = pack(subRes, 'sub_indicator_id'), actMap = pack(actRes, 'activity_id');
        const empty = { months: {}, target: null, locked: false };
        res.json({
            success: true,
            data: {
                indicator_id: ind.id, item_no: ind.item_no, sub_rollup_mode: ind.sub_rollup_mode || 'auto', max_levels: await getHierarchyMaxLevels(),
                subs: subs.map(x => ({ ...x, rollup_mode: x.rollup_mode || 'manual', ...(subMap.get(x.id) || empty) })),
                activities: acts.map(a => ({ ...a, ...(actMap.get(a.id) || empty) })),
            }
        });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /hierarchy-results/save — บันทึกผลงานข้อย่อย + กิจกรรม ของ 1 หน่วยบริการ × 1 ปีงบ ในคราวเดียว (transaction)
// body: { year_bh, hospcode, sub: [{ sub_indicator_id, month_bh, actual_value, target_value? }], activity: [{ activity_id, month_bh, actual_value, target_value? }] }
// ตรวจ: ขอบเขตหน่วยบริการ, ล็อคการคีย์ของระบบ (user ทั่วไป), ล็อคจากการอนุมัติ (super_admin ข้ามได้), สิทธิ์แก้ผลงาน/เป้าหมายรายบุคคล,
//       ห้ามกรอกข้อย่อยที่ "คำนวณจากกิจกรรม" (มีกิจกรรมเปิดใช้งานอยู่) — ค่า 0 เก็บเป็น '0', ค่าว่าง = ลบค่าเดิม (NULL)
apiRouter.post('/hierarchy-results/save', authenticateToken, async (req, res) => {
    const user = req.user;
    const { year_bh, hospcode } = req.body || {};
    const subItems = Array.isArray(req.body?.sub) ? req.body.sub : [];
    const actItems = Array.isArray(req.body?.activity) ? req.body.activity : [];
    if (!year_bh || !hospcode) return res.status(400).json({ success: false, message: 'ต้องระบุ year_bh และ hospcode' });
    if (subItems.length + actItems.length === 0) return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่ต้องบันทึก' });
    const validMonth = (m) => Number.isInteger(Number(m)) && Number(m) >= 1 && Number(m) <= 12;
    const norm = (v) => (v === 0 || (v !== null && v !== undefined && String(v).trim() !== '')) ? String(v).trim() : null;
    for (const it of [...subItems, ...actItems]) {
        if (!validMonth(it.month_bh)) return res.status(400).json({ success: false, message: 'เดือนไม่ถูกต้อง' });
        for (const k of ['actual_value', 'target_value']) {
            const v = norm(it[k]);
            if (v !== null && v.length > 100) return res.status(400).json({ success: false, message: 'ค่าที่บันทึกยาวเกิน 100 ตัวอักษร' });
        }
    }
    try {
        if (!(await canAccessHospcode(user, hospcode))) return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์บันทึกข้อมูลหน่วยบริการนี้' });
        if (!ROLE_ADMIN_ALL.includes(user.role) && await getDataEntryLockState()) {
            return res.status(403).json({ success: false, message: 'ระบบปิดการคีย์ข้อมูลชั่วคราว' });
        }
    } catch (e) { return res.status(500).json({ success: false, message: e.message }); }

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        // ข้อมูลข้อย่อย/กิจกรรมที่อ้างถึง → ตัวชี้วัดหลักที่เกี่ยวข้อง
        const subIds = [...new Set(subItems.map(x => Number(x.sub_indicator_id)))];
        const actIds = [...new Set(actItems.map(x => Number(x.activity_id)))];
        const [subRows] = subIds.length ? await conn.query('SELECT id, indicator_id, rollup_mode FROM kpi_sub_indicators WHERE id IN (?)', [subIds]) : [[]];
        const [actRows] = actIds.length ? await conn.query(
            `SELECT a.id, a.value_type, si.indicator_id, si.id AS sub_indicator_id FROM kpi_sub_activities a
             JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id WHERE a.id IN (?)`, [actIds]) : [[]];
        if (subRows.length !== subIds.length || actRows.length !== actIds.length) throw Object.assign(new Error('ไม่พบตัวชี้วัดย่อยหรือกิจกรรมที่ระบุ'), { status: 404 });
        const subById = new Map(subRows.map(r => [r.id, r]));
        const actById = new Map(actRows.map(r => [r.id, r]));

        // ข้อย่อยที่คำนวณจากระดับล่าง (auto + มีข้อลูก/กิจกรรมเปิดใช้งาน) กรอกเองไม่ได้
        if ((await rolledSubIds(conn, subIds)).size > 0) throw Object.assign(new Error(ROLLED_SUB_MESSAGE), { status: 400 });

        const indicatorIds = [...new Set([...subRows.map(r => r.indicator_id), ...actRows.map(r => r.indicator_id)])];
        // user ทั่วไปบันทึกได้เฉพาะตัวชี้วัดของหน่วยงานตัวเอง (เหมือน /update-kpi)
        if (!ROLE_ADMIN_ALL.includes(user.role)) {
            const [allowed] = await conn.query('SELECT id FROM kpi_indicators WHERE id IN (?) AND dept_id = ?', [indicatorIds, user.deptId]);
            if (allowed.length !== indicatorIds.length) throw Object.assign(new Error('ไม่มีสิทธิ์แก้ไขข้อมูลหน่วยงานอื่น'), { status: 403 });
        }
        // ล็อคจากการอนุมัติ — ตัวชี้วัดหลักที่ล็อคแล้ว ข้อย่อย/กิจกรรมของมันแก้ไม่ได้ (super_admin ข้ามได้)
        if (user.role !== 'super_admin') {
            const [locked] = await conn.query(
                'SELECT DISTINCT indicator_id FROM kpi_results WHERE indicator_id IN (?) AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [indicatorIds, year_bh, hospcode]);
            const [subLocked] = subIds.length ? await conn.query(
                'SELECT COUNT(*) AS cnt FROM kpi_sub_results WHERE sub_indicator_id IN (?) AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [subIds, year_bh, hospcode]) : [[{ cnt: 0 }]];
            const [actLocked] = actIds.length ? await conn.query(
                'SELECT COUNT(*) AS cnt FROM kpi_activity_results WHERE activity_id IN (?) AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [actIds, year_bh, hospcode]) : [[{ cnt: 0 }]];
            if (locked.length || subLocked[0].cnt > 0 || actLocked[0].cnt > 0) {
                throw Object.assign(new Error('ไม่สามารถแก้ไขได้ ตัวชี้วัดนี้ถูกล็อคอยู่ (ได้รับการอนุมัติแล้ว)'), { status: 403 });
            }
        }
        const perms = await getPermsForUser(user.userId, user.role);

        const upsert = async (table, idCol, id, it, valueType) => {
            let actual = norm(it.actual_value);
            if (valueType === 'check' && actual !== null) actual = kpiRollup.activityValue('check', actual) === 100 ? '1' : '0';
            const hasTarget = it.target_value !== undefined;
            const target = norm(it.target_value);
            const [ex] = await conn.query(`SELECT target_value, actual_value FROM ${table} WHERE ${idCol} = ? AND year_bh = ? AND hospcode = ? AND month_bh = ?`,
                [id, year_bh, hospcode, Number(it.month_bh)]);
            const old = ex[0] || {};
            // ไม่มีสิทธิ์แก้ผลงาน/เป้าหมาย → คงค่าเดิม (เหมือน /update-kpi)
            const finalActual = perms.can_edit_actual ? actual : (old.actual_value ?? null);
            const finalTarget = (hasTarget && perms.can_edit_target) ? target : (old.target_value ?? null);
            await conn.query(
                `INSERT INTO ${table} (${idCol}, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id)
                 VALUES (?,?,?,?,?,?, 'Pending', ?)
                 ON DUPLICATE KEY UPDATE target_value = VALUES(target_value), actual_value = VALUES(actual_value), user_id = VALUES(user_id)`,
                [id, year_bh, hospcode, Number(it.month_bh), finalTarget, finalActual, user.userId]);
        };
        for (const it of subItems) await upsert('kpi_sub_results', 'sub_indicator_id', Number(it.sub_indicator_id), it, 'number');
        for (const it of actItems) await upsert('kpi_activity_results', 'activity_id', Number(it.activity_id), it, actById.get(Number(it.activity_id)).value_type);
        await conn.commit();

        (async () => {
            try {
                const userInfo = await getUserAuditInfo(user.userId);
                for (const indId of indicatorIds) {
                    const nSub = subItems.filter(x => subById.get(Number(x.sub_indicator_id)).indicator_id === indId).length;
                    const nAct = actItems.filter(x => actById.get(Number(x.activity_id)).indicator_id === indId).length;
                    await logKpiSaveAudit({
                        ...(userInfo || { user_id: user.userId, username: user.username }),
                        hospcode, action_type: 'hierarchy_results', indicator_id: indId, year_bh,
                        row_count: nSub + nAct, summary: `ข้อย่อย ${nSub} ช่อง, กิจกรรม ${nAct} ช่อง`,
                        ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                    });
                }
            } catch (e) { console.warn('[KPI Audit] hierarchy log error:', e.message); }
        })();
        refreshSummaryAfterSubSave(indicatorIds.map(id => ({ indicator_id: id, year_bh })));
        res.json({ success: true, message: 'บันทึกสำเร็จ', saved: subItems.length + actItems.length });
    } catch (e) {
        await conn.rollback();
        res.status(e.status || 500).json({ success: false, message: e.message });
    } finally {
        conn.release();
    }
});

// ========== KPI Sub-Results (บันทึกผลงานย่อย) ==========
apiRouter.get('/sub-results', authenticateToken, async (req, res) => {
    try {
        const { sub_indicator_id, year_bh, hospcode, indicator_id } = req.query;
        const conditions = []; const params = [];
        if (sub_indicator_id) { conditions.push('sr.sub_indicator_id = ?'); params.push(sub_indicator_id); }
        if (indicator_id) { conditions.push('si.indicator_id = ?'); params.push(indicator_id); }
        if (year_bh) { conditions.push('sr.year_bh = ?'); params.push(year_bh); }
        if (hospcode) { conditions.push('sr.hospcode = ?'); params.push(hospcode); }
        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const [rows] = await db.query(
            `SELECT sr.*, si.sub_indicator_name, si.indicator_id FROM kpi_sub_results sr
             JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
             ${where} ORDER BY sr.sub_indicator_id, sr.hospcode, sr.month_bh`,
            params
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /sub-results/summary — aggregate ต่อ indicator + hospcode (รวม monthly breakdown) — ดู loadSubAggregates()
apiRouter.get('/sub-results/summary', authenticateToken, async (req, res) => {
    try {
        const { year_bh, hospcode } = req.query;
        const rows = await loadSubAggregates(db, { yearBh: year_bh, hospcode });
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/sub-results/upsert', authenticateToken, async (req, res) => {
    try {
        const { sub_indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status } = req.body;
        if (!sub_indicator_id || !year_bh || !hospcode || !month_bh) {
            return res.status(400).json({ success: false, message: 'sub_indicator_id, year_bh, hospcode, month_bh required' });
        }
        // ข้อย่อยที่คำนวณจากระดับล่าง (ข้อลูก/กิจกรรม) กรอกเองไม่ได้ — บันทึกที่ระดับล่างแทน
        if ((await rolledSubIds(db, [sub_indicator_id])).size > 0) return res.status(400).json({ success: false, message: ROLLED_SUB_MESSAGE });
        // ตรวจสอบล็อค (super_admin ข้ามได้) — mirror /update-kpi (ล็อคจะถูก cascade มาจากตัวชี้วัดหลักตอนอนุมัติ)
        if (req.user.role !== 'super_admin') {
            const [lockedRows] = await db.query(
                'SELECT COUNT(*) as cnt FROM kpi_sub_results WHERE sub_indicator_id = ? AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                [sub_indicator_id, year_bh, hospcode]
            );
            if (lockedRows[0].cnt > 0) {
                return res.status(403).json({ success: false, message: 'ไม่สามารถแก้ไขได้ ตัวชี้วัดย่อยนี้ถูกล็อคอยู่ (ตัวชี้วัดหลักได้รับการอนุมัติแล้ว)' });
            }
        }
        await db.query(
            `INSERT INTO kpi_sub_results (sub_indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id)
             VALUES (?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE target_value=VALUES(target_value), actual_value=VALUES(actual_value), status=VALUES(status), user_id=VALUES(user_id)`,
            [sub_indicator_id, year_bh, hospcode, month_bh, target_value || null, (actual_value === 0 || actual_value) ? actual_value : null, status || 'Pending', req.user.userId]
        );

        // === KPI Save Audit (fire-and-forget) ===
        (async () => {
            try {
                const userInfo = await getUserAuditInfo(req.user.userId);
                // ดึง parent indicator
                const [siRows] = await db.query(`
                    SELECT si.indicator_id, si.sub_indicator_name, i.kpi_indicators_name
                    FROM kpi_sub_indicators si
                    LEFT JOIN kpi_indicators i ON si.indicator_id = i.id
                    WHERE si.id = ?
                `, [sub_indicator_id]);
                const parentIndName = siRows[0]?.kpi_indicators_name || null;
                const subName = siRows[0]?.sub_indicator_name || null;
                await logKpiSaveAudit({
                    ...(userInfo || { user_id: req.user.userId, username: req.user.username }),
                    hospcode,
                    action_type: 'sub_results',
                    indicator_id: siRows[0]?.indicator_id || null,
                    indicator_name: parentIndName ? `${parentIndName} / ${subName}` : subName,
                    year_bh, month_bh,
                    row_count: 1,
                    summary: `sub: ${subName || sub_indicator_id}`,
                    ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                });
            } catch (e) { console.warn('[KPI Audit] sub-results log error:', e.message); }
        })();
        db.query('SELECT indicator_id FROM kpi_sub_indicators WHERE id = ?', [sub_indicator_id])
            .then(([r]) => r[0] && refreshSummaryAfterSubSave([{ indicator_id: r[0].indicator_id, year_bh }]))
            .catch(e => console.error('[sub-results] refresh kpi_summary failed:', e.message));

        res.json({ success: true, message: 'บันทึกสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/sub-results/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM kpi_sub_results WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// --- Toggle is_active สำหรับ Master Data ทั้ง 4 ตาราง ---
apiRouter.put('/indicators/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        // ต้องระบุ is_active ชัดเจน — เดิมไม่ส่งค่า = ปิดใช้งาน, id ที่ไม่มี = "สำเร็จ" (25 ต.ค. 2569)
        const is_active = parseActiveFlag((req.body || {}).is_active);
        if (is_active === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
        const [upd] = await db.query('UPDATE kpi_indicators SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
        if (!upd.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling indicator' });
    }
});

apiRouter.put('/main-indicators/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        // ต้องระบุ is_active ชัดเจน — เดิมไม่ส่งค่า = ปิดใช้งาน, id ที่ไม่มี = "สำเร็จ" (25 ต.ค. 2569)
        const is_active = parseActiveFlag((req.body || {}).is_active);
        if (is_active === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
        const [upd] = await db.query('UPDATE kpi_main_indicators SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
        if (!upd.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling main indicator' });
    }
});

apiRouter.put('/main-yut/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        // ต้องระบุ is_active ชัดเจน — เดิมไม่ส่งค่า = ปิดใช้งาน, id ที่ไม่มี = "สำเร็จ" (25 ต.ค. 2569)
        const is_active = parseActiveFlag((req.body || {}).is_active);
        if (is_active === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
        const [upd] = await db.query('UPDATE main_yut SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
        if (!upd.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling strategy' });
    }
});

apiRouter.put('/departments/:id/toggle-active', authenticateToken, requireAction('kpi-manage', 'edit'), async (req, res) => {
    try {
        // ต้องระบุ is_active ชัดเจน — เดิมไม่ส่งค่า = ปิดใช้งาน, id ที่ไม่มี = "สำเร็จ" (25 ต.ค. 2569)
        const is_active = parseActiveFlag((req.body || {}).is_active);
        if (is_active === null) return res.status(400).json({ success: false, message: ACTIVE_FLAG_REQUIRED });
        const [upd] = await db.query('UPDATE departments SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
        if (!upd.affectedRows) return res.status(404).json({ success: false, message: 'ไม่พบข้อมูล' });
        res.json({ success: true, message: is_active ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error toggling department' });
    }
});

module.exports = { suggestIndicatorCodes, saveHierarchyFields, normalizeActivityType, canAccessHospcode, getDataEntryLockState };
