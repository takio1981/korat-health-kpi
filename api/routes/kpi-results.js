// เส้นทาง: ผลงานตัวชี้วัด (kpi-results), เพิ่ม KPI จำนวนมาก, บันทึกผลงาน (update-kpi)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const kpiFormula = require('../kpi-formula');
const { ROLE_ADMIN_ALL, ROLE_SCOPE_DISTRICT, ROLE_SCOPE_HOSPCODE, getDistrictId, getPermsForUser } = require('../core/access');
const { apiRouter } = require('../core/router');
const { authenticateToken, isAdmin, isSuperAdmin } = require('../core/auth');
const { baseKey, loadBaseValues, loadPrevYearData, refreshKpiSummaryForIndicatorYears, scheduleSummaryRefresh, withSummaryLock } = require('../services/summary');
const { formulaOk, needsCustomValues, varKeysOf } = require('../services/formula-vars');
const { getUserAuditInfo, logKpiSaveAudit } = require('../services/kpi-audit');
const { indicatorAllowsHostype, indicatorTypeSetting, resolveIndicatorHostypes } = require('../services/indicator-scope');

apiRouter.get('/kpi-results', authenticateToken, async (req, res) => {
    try {
        const user = req.user;

        let whereClause = '';
        let params = [];

        // === Role-based KPI visibility ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            // เห็นทุก hospcode แต่เฉพาะหน่วยงานตัวเอง
            if (user.deptId != null) { whereClause = 'WHERE i.dept_id = ?'; params.push(user.deptId); }
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
            // admin_cup / user_cup: ทุกตัวชี้วัด ทุก hospcode ในอำเภอ
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                whereClause = 'WHERE h.distid = ?';
                params.push(distid);
                // user_cup เห็นเฉพาะ dept ตัวเอง, admin_cup เห็นทุก dept
                if (user.role === 'user_cup' && user.deptId != null) {
                    whereClause += ' AND i.dept_id = ?'; params.push(user.deptId);
                }
            } else {
                whereClause = 'WHERE r.hospcode = ?'; params.push(user.hospcode);
            }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            // admin_hos / admin_sso: ทุก dept แต่เฉพาะ hospcode ตัวเอง
            if (user.hospcode) { whereClause = 'WHERE r.hospcode = ?'; params.push(user.hospcode); }
        } else {
            // user_hos / user_sso / user_ssj: hospcode + dept ตัวเอง
            const conditions = [];
            if (user.hospcode) { conditions.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { conditions.push('i.dept_id = ?'); params.push(user.deptId); }
            if (conditions.length > 0) whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        // === กรอง year + ตัวกรองเพิ่มเติมจาก query params ===
        // รองรับ comma-separated (multi) ใช้ IN (...)
        const extraConditions = [];
        const addMultiFilter = (column, value) => {
            if (!value) return;
            const list = String(value).split(',').map(v => v.trim()).filter(Boolean);
            if (list.length === 0) return;
            if (list.length === 1) { extraConditions.push(`${column} = ?`); params.push(list[0]); }
            else { extraConditions.push(`${column} IN (${list.map(() => '?').join(',')})`); params.push(...list); }
        };
        extraConditions.push('i.is_active = 1'); // แสดงเฉพาะตัวชี้วัดที่เปิดใช้งาน
        if (req.query.year) { extraConditions.push('r.year_bh = ?'); params.push(req.query.year); }
        addMultiFilter('r.hospcode', req.query.hospcode);
        addMultiFilter('d.dept_name', req.query.dept);
        addMultiFilter('dist.distname', req.query.district);
        if (req.query.indicator) { extraConditions.push('i.kpi_indicators_name = ?'); params.push(req.query.indicator); }
        if (req.query.main) { extraConditions.push('mi.main_indicator_name = ?'); params.push(req.query.main); }
        // Hostype filter: filter h.hostype โดยตรง (LEFT JOIN chospital จาก main query)
        addMultiFilter('h.hostype', req.query.hostype);
        // Indicator off-type filter: กรองตัวชี้วัดตาม required_off_types (JSON array)
        // all_required = ใช้ทุกประเภท จึงแสดงเสมอ
        if (req.query.indicator_off_type) {
            const list = String(req.query.indicator_off_type).split(',').map(v => v.trim()).filter(Boolean);
            if (list.length > 0) {
                const likeConds = list.map(() => 'i.required_off_types LIKE ?').join(' OR ');
                extraConditions.push(`(i.evaluation_mode = 'all_required' OR ${likeConds})`);
                for (const code of list) params.push(`%"${code}"%`);
            }
        }
        let extraWhere = '';
        if (extraConditions.length > 0) {
            extraWhere = (whereClause ? ' AND ' : 'WHERE ') + extraConditions.join(' AND ');
        }

        // === Pre-load form schemas + appeal counts เป็น batch (ลด N+1 subquery) ===
        const [formSchemas] = await db.query('SELECT indicator_id FROM kpi_form_schemas WHERE is_active = 1');
        const formSchemaSet = new Set(formSchemas.map((f) => f.indicator_id));

        // ใช้ MIN()/MAX() wrap คอลัมน์ที่ functionally dependent เพื่อให้ GROUP BY มีแค่ 3 cols
        // (i.id, r.year_bh, r.hospcode) — เร็วกว่า GROUP BY 18 cols เดิมมาก
        const sql = `
            SELECT
                IFNULL(MIN(mi.main_indicator_name), 'ยังไม่กำหนด') AS main_indicator_name,
                MIN(i.kpi_indicators_name) AS kpi_indicators_name,
                r.year_bh,
                i.id AS indicator_id,
                MIN(d.dept_name) AS dept_name,
                MAX(r.target_value) AS target_value,
                MAX(CASE WHEN r.month_bh = 10 THEN r.actual_value END) AS oct,
                MAX(CASE WHEN r.month_bh = 11 THEN r.actual_value END) AS nov,
                MAX(CASE WHEN r.month_bh = 12 THEN r.actual_value END) AS dece,
                MAX(CASE WHEN r.month_bh = 1  THEN r.actual_value END) AS jan,
                MAX(CASE WHEN r.month_bh = 2  THEN r.actual_value END) AS feb,
                MAX(CASE WHEN r.month_bh = 3  THEN r.actual_value END) AS mar,
                MAX(CASE WHEN r.month_bh = 4  THEN r.actual_value END) AS apr,
                MAX(CASE WHEN r.month_bh = 5  THEN r.actual_value END) AS may,
                MAX(CASE WHEN r.month_bh = 6  THEN r.actual_value END) AS jun,
                MAX(CASE WHEN r.month_bh = 7  THEN r.actual_value END) AS jul,
                MAX(CASE WHEN r.month_bh = 8  THEN r.actual_value END) AS aug,
                MAX(CASE WHEN r.month_bh = 9  THEN r.actual_value END) AS sep,
                SUM(CASE WHEN r.status = 'Pending' THEN 1 ELSE 0 END) AS pending_count,
                MAX(r.status) AS indicator_status,
                MAX(CASE WHEN r.is_locked = 1 THEN 1 ELSE 0 END) AS is_locked,
                MIN(i.table_process) AS table_process,
                MIN(i.criterion) AS criterion,
                MIN(i.target_condition) AS target_condition, -- เงื่อนไขเป้าหมาย ≥ > ≤ < = (ร้อยละ/ผ่านเกณฑ์ในหน้าบันทึกผลงาน) — เดิมไม่ได้ส่งมา 22 ต.ค. 2569
                MIN(i.data_source) AS data_source,
                MIN(i.khd_report_id) AS khd_report_id,
                MIN(i.item_no) AS item_no,
                MIN(i.sub_rollup_mode) AS sub_rollup_mode,
                MAX(i.r9) AS r9, MAX(i.moph) AS moph, MAX(i.ssj) AS ssj, MAX(i.rmw) AS rmw, MAX(i.other) AS other,
                MIN(i.evaluation_mode) AS evaluation_mode,
                MIN(i.required_off_types) AS required_off_types,
                MAX(i.is_cumulative) AS is_cumulative,
                MIN(i.result_formula) AS result_formula,
                MIN(i.custom_vars) AS custom_vars, -- ค่าเพิ่มเติมที่ตั้งชื่อเอง [{key,label}] (25 ต.ค. 2569)
                MIN(i.pct_formula) AS pct_formula, -- สูตรร้อยละ (ว่าง = ตามเงื่อนไขเป้าหมาย)
                r.hospcode,
                MIN(h.hosname) AS hosname,
                MIN(h.hostype) AS hostype,
                MIN(ht.hostypename) AS hostypename,
                MIN(dist.distname) AS distname
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON d.id = i.dept_id
            LEFT JOIN chospital h ON r.hospcode = h.hoscode
            LEFT JOIN chostype ht ON h.hostype = ht.hostypecode
            LEFT JOIN co_district dist ON dist.distid = h.distid
            ${whereClause}${extraWhere}
            GROUP BY i.id, r.year_bh, r.hospcode
            ORDER BY r.year_bh DESC, MIN(mi.main_indicator_name), MIN(i.kpi_indicators_name), r.hospcode
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);

        // === ข้อมูลปีงบที่แล้ว เฉพาะแถวที่สูตรอ้าง prev_* (โหลดเป็นชุดต่อปีงบ ไม่ใช่ทีละแถว) ===
        const prevRowsByYear = new Map();
        for (const row of rows) {
            const f = kpiFormula.activeFormula(row);
            if (!f || !formulaOk(row, f) || !kpiFormula.usesPrevYear(f)) continue;
            if (!prevRowsByYear.has(row.year_bh)) prevRowsByYear.set(row.year_bh, []);
            prevRowsByYear.get(row.year_bh).push(row);
        }
        const prevByYear = new Map();
        for (const [yb, list] of prevRowsByYear) {
            prevByYear.set(yb, await loadPrevYearData(db, list.map(r => r.indicator_id), yb, list.map(r => r.hospcode)));
        }
        // === ค่าฐาน/ค่าเพิ่มเติม เฉพาะตัวชี้วัดที่ใช้ — แนบ row.cv_<key> (+ base_value) ให้หน้าบันทึกผลงานแสดง/แก้ไข/คำนวณร้อยละ ===
        const baseRows = rows.filter(needsCustomValues);
        const baseMap = baseRows.length ? await loadBaseValues(db, baseRows.map(r => r.indicator_id), baseRows.map(r => r.year_bh)) : new Map();

        // === คำนวณ last_actual + appeal + has_form ฝั่ง JS (เร็วกว่า subquery) ===
        const monthOrder = [10,11,12,1,2,3,4,5,6,7,8,9];
        const monthKeys = ['oct','nov','dece','jan','feb','mar','apr','may','jun','jul','aug','sep'];
        for (const row of rows) {
            const isCumulative = Number(row.is_cumulative) === 1;
            const formula = kpiFormula.activeFormula(row);
            let lastVal = null;
            // ค่าเพิ่มเติมของคู่นี้ (base + ที่ประกาศไว้ + ที่สูตรอ้าง) — แนบทุกแถวของตัวชี้วัดที่ใช้ เพื่อให้กรอกได้แม้ยังไม่มีค่า
            let cvals;
            if (needsCustomValues(row)) {
                cvals = baseMap.get(baseKey(row.indicator_id, row.year_bh, row.hospcode)) || {};
                const keys = new Set(['base', ...varKeysOf(row), ...(formula ? kpiFormula.formulaVarNames(formula) : [])]);
                for (const k of keys) row['cv_' + k] = cvals[k] ?? null;
                row.base_value = cvals.base ?? null;
            }
            if (formula && formulaOk(row, formula)) {
                // ตัวชี้วัดที่ตั้งสูตรคำนวณผลงาน — ใช้สูตรแทน is_cumulative / ค่าเดือนล่าสุด
                // สูตรอ้างปีที่แล้ว → แนบ prev_year ให้ frontend คำนวณซ้ำได้ตรงกันตอนแก้ไขค่า (โหมดแก้ไข)
                const pm = prevByYear.get(row.year_bh);
                const prev = pm ? (pm.get(`${row.indicator_id}|${String(row.hospcode).trim()}`) || { year_bh: String(parseInt(row.year_bh, 10) - 1), months: null, target: null, result: null }) : undefined;
                if (prev) row.prev_year = prev;
                lastVal = kpiFormula.evaluateFormula(formula, row, row.target_value, prev, cvals);
            } else if (isCumulative) {
                // ตัวชี้วัดสะสม: รวมค่าตัวเลขทุกเดือนที่มีข้อมูล (ไม่ sum ถ้าไม่มีเดือนไหนมีค่าเลย → คง null)
                const numericVals = monthKeys.map(k => row[k]).filter(v => v != null && String(v).trim() !== '' && !isNaN(parseFloat(v)));
                lastVal = numericVals.length > 0 ? String(numericVals.reduce((s, v) => s + parseFloat(v), 0)) : null;
            } else {
                // last_actual: หาเดือนล่าสุดที่มีค่า
                for (let m = monthKeys.length - 1; m >= 0; m--) {
                    const v = row[monthKeys[m]];
                    if (v != null && String(v).trim() !== '' && String(v).trim() !== '0') { lastVal = v; break; }
                }
            }
            row.last_actual = lastVal;
            row.has_form_schema = formSchemaSet.has(row.indicator_id) ? 1 : 0;
            row.appeal_approved = 0; // จะ load แยกถ้าจำเป็น
        }

        res.json({ success: true, data: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูล KPI ได้' });
    }
});

// GET /bulk-add-kpi/preview — ตรวจสอบก่อนเพิ่ม KPI ทั้งหมด
apiRouter.get('/bulk-add-kpi/preview', authenticateToken, isAdmin, async (req, res) => {
    const year_bh = req.query.year;
    const dept_id = req.query.dept_id;
    if (!year_bh) return res.status(400).json({ success: false, message: 'กรุณาเลือกปีงบประมาณ' });
    try {
        let indWhere = 'WHERE is_active = 1';
        const indParams = [];
        const filterDeptId = req.user.role === 'admin_ssj' ? req.user.deptId : (dept_id || null);
        if (filterDeptId) { indWhere += ' AND dept_id = ?'; indParams.push(filterDeptId); }
        const [indicators] = await db.query(`SELECT id, evaluation_mode, required_off_types FROM kpi_indicators ${indWhere}`, indParams);
        const [hospitals] = await db.query("SELECT hoscode, hostype FROM chospital WHERE hostype IN ('05','06','07','18')");
        const [existing] = await db.query('SELECT indicator_id, hospcode FROM kpi_results WHERE year_bh = ? GROUP BY indicator_id, hospcode', [year_bh]);
        const existSet = new Set(existing.map(r => `${r.indicator_id}_${r.hospcode}`));

        // นับ totalPossible/toAdd จริงต่อตัวชี้วัด (กรองตาม hostype ที่ใช้ได้ของแต่ละตัว) ให้ตรงกับที่จะ insert จริง
        let totalPossible = 0, toAdd = 0;
        for (const ind of indicators) {
            const allowedTypes = resolveIndicatorHostypes(ind);
            for (const hos of hospitals) {
                if (!allowedTypes.has(String(hos.hostype))) continue;
                totalPossible++;
                if (!existSet.has(`${ind.id}_${hos.hoscode}`)) toAdd++;
            }
        }
        res.json({
            success: true,
            indicatorCount: indicators.length,
            hospitalCount: hospitals.length,
            existingCount: existing.length,
            totalPossible,
            toAdd,
            year_bh
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /bulk-add-kpi — super_admin/admin_ssj เพิ่ม KPI ทุกหน่วยบริการทีเดียว
apiRouter.post('/bulk-add-kpi', authenticateToken, isAdmin, async (req, res) => {
    const { year_bh, dept_id } = req.body;
    if (!year_bh) return res.status(400).json({ success: false, message: 'กรุณาเลือกปีงบประมาณ' });
    try {
        // admin_ssj → กรองเฉพาะ dept ตัวเอง, super_admin → ทั้งหมดหรือตาม dept_id
        let indWhere = 'WHERE is_active = 1';
        const indParams = [];
        const filterDeptId = req.user.role === 'admin_ssj' ? req.user.deptId : (dept_id || null);
        if (filterDeptId) { indWhere += ' AND dept_id = ?'; indParams.push(filterDeptId); }
        const [indicators] = await db.query(`SELECT id, target_percentage, evaluation_mode, required_off_types FROM kpi_indicators ${indWhere}`, indParams);
        // ดึงเฉพาะ รพ., สสอ., รพ.สต. (hostype 05,06,07,18) — กรองแคบลงต่อตัวชี้วัดด้วย resolveIndicatorHostypes() ด้านล่าง
        const [hospitals] = await db.query("SELECT hoscode, hostype FROM chospital WHERE hostype IN ('05','06','07','18')");
        if (indicators.length === 0) return res.json({ success: true, message: 'ไม่มีตัวชี้วัดที่ active', inserted: 0, skipped: 0 });
        if (hospitals.length === 0) return res.json({ success: true, message: 'ไม่มีหน่วยบริการในระบบ', inserted: 0, skipped: 0 });

        // ดึง kpi_results ที่มีอยู่แล้วสำหรับปีนี้ → สร้าง Set เพื่อเช็คซ้ำเร็ว
        const [existing] = await db.query('SELECT indicator_id, hospcode FROM kpi_results WHERE year_bh = ? GROUP BY indicator_id, hospcode', [year_bh]);
        const existSet = new Set(existing.map(r => `${r.indicator_id}_${r.hospcode}`));

        let inserted = 0, skipped = 0;
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            for (const ind of indicators) {
                const allowedTypes = resolveIndicatorHostypes(ind);
                const hospsForThisIndicator = hospitals.filter(h => allowedTypes.has(String(h.hostype)));
                for (const hos of hospsForThisIndicator) {
                    const key = `${ind.id}_${hos.hoscode}`;
                    if (existSet.has(key)) { skipped++; continue; }
                    // สร้าง 12 records (เดือน 10-9)
                    const months = [10,11,12,1,2,3,4,5,6,7,8,9];
                    const targetVal = ind.target_percentage != null ? String(ind.target_percentage) : null;
                    for (const month of months) {
                        await connection.query(
                            'INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id) VALUES (?,?,?,?,?,NULL,?,?)',
                            [ind.id, year_bh, hos.hoscode, month, targetVal, 'Pending', req.user.userId]
                        );
                    }
                    inserted++;
                }
            }
            await connection.query(
                'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
                [req.user.userId, 'BULK_ADD_KPI', 'kpi_results', JSON.stringify({ year_bh, indicators: indicators.length, hospitals: hospitals.length, inserted, skipped }), req.ip]
            );
            await connection.commit();
        } catch (e) { await connection.rollback(); throw e; }
        finally { connection.release(); }

        res.json({
            success: true,
            message: `เพิ่ม KPI สำเร็จ`,
            inserted, skipped,
            totalRecords: inserted * 12,
            indicatorCount: indicators.length,
            hospitalCount: hospitals.length,
            year_bh
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /kpi-results/bulk-delete — ลบ kpi_results + kpi_sub_results ตาม triplet
// body: { items: [{ indicator_id, year_bh, hospcode }, ...] }
apiRouter.post('/kpi-results/bulk-delete', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีรายการที่จะลบ' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        let deletedKpi = 0, deletedSub = 0;
        for (const it of items) {
            const { indicator_id, year_bh, hospcode } = it;
            if (!indicator_id || !year_bh || !hospcode) continue;
            // ลบ kpi_sub_results ที่ sub_indicator อยู่ใน kpi_indicators นี้
            const [subRes] = await connection.query(
                `DELETE sr FROM kpi_sub_results sr
                 JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode = ?`,
                [indicator_id, year_bh, hospcode]
            );
            deletedSub += subRes.affectedRows || 0;
            const [actRes] = await connection.query(
                `DELETE ar FROM kpi_activity_results ar
                 JOIN kpi_sub_activities a ON ar.activity_id = a.id
                 JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode = ?`,
                [indicator_id, year_bh, hospcode]
            );
            deletedSub += actRes.affectedRows || 0;
            // ลบ kpi_results
            const [kpiRes] = await connection.query(
                'DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                [indicator_id, year_bh, hospcode]
            );
            deletedKpi += kpiRes.affectedRows || 0;
            // ลบ kpi_summary ด้วย (ถ้ามี)
            try {
                await connection.query(
                    'DELETE FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                    [indicator_id, year_bh, hospcode]
                );
            } catch (_) {}
        }
        await connection.commit();
        // log
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'BULK_DELETE_KPI', 'kpi_results,kpi_sub_results', JSON.stringify({ count: items.length, deletedKpi, deletedSub }), req.ip]
        ).catch(() => {});
        res.json({ success: true, message: `ลบสำเร็จ — kpi_results ${deletedKpi}, kpi_sub_results ${deletedSub}`, deletedKpi, deletedSub });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally { connection.release(); }
}));

// ========== จัดการข้อมูลผลงานตัวชี้วัด (super_admin) — View + Bulk Delete รายระเบียน ==========
// คนละ endpoint กับ /kpi-results/bulk-delete เดิม (ซึ่งลบทั้งปีของ indicator+hospcode เดียว) — หน้านี้
// ต้องการลบละเอียดถึงระดับ "รายการเดียว" (1 แถว = 1 เดือนจริง) จึงลบด้วย kpi_results.id ตรงๆ

// month_bh encoding ที่ระบบใช้จริงทั้งระบบ: 10,11,12,1,2,...,9 (เลขเดือนปฏิทินจริง, ปีงบเริ่ม ต.ค.=10)
// แปลงเป็นลำดับปีงบ (ต.ค.=1 ... ก.ย.=12) เพื่อใช้เทียบช่วงเดือนที่ผู้ใช้เลือกแบบข้ามปีปฏิทินได้ถูกต้อง
function fiscalMonthOrdinal(monthBh) {
    const m = Number(monthBh);
    return m >= 10 ? m - 9 : m + 3;
}

// คืนรายการ month_bh ทั้งหมดที่อยู่ในช่วงปีงบ [monthFrom, monthTo] (รับค่าเป็น month_bh ปฏิทินทั้งคู่)
function monthBhRangeList(monthFrom, monthTo) {
    const allMonths = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const fromOrd = fiscalMonthOrdinal(monthFrom);
    const toOrd = fiscalMonthOrdinal(monthTo);
    return allMonths.filter(m => {
        const ord = fiscalMonthOrdinal(m);
        return ord >= fromOrd && ord <= toOrd;
    });
}

// GET /kpi-results/manage — list + filter (date_from/date_to บน created_at, year_bh+month_from/month_to บนปีงบ)
// หมายเหตุ perf (สำคัญ): kpi_results มีจริง ~494,066 แถว — คิวรีนี้ "ห้าม JOIN chospital ตรงๆ" เพราะ
// kpi_results.hospcode (varchar utf8mb4_unicode_ci) กับ chospital.hoscode (char utf8mb3_general_ci) ชนิด/
// charset/collation ไม่ตรงกันทั้ง 3 อย่าง (บั๊ก schema เดิมที่มีอยู่ก่อนงานนี้ ไม่ได้เกิดจากโค้ดใหม่) ทำให้ MySQL
// ใช้ index ของ chospital ไม่ได้เลย (แม้ hoscode เป็น PRIMARY KEY) กลายเป็น full scan วัดจริงช้ากว่า 30s —
// แก้โดย query ชื่อหน่วยบริการแยกเฉพาะ hoscode ที่อยู่ในหน้านั้นๆ (≤ limit ต่อหน้า) มา merge ใน JS แทน
apiRouter.get('/kpi-results/manage', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { date_from, date_to, year_bh, month_from, month_to, indicator_id, hospcode, dept_id } = req.query;
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const offset = (page - 1) * limit;

        // บังคับต้องมีอย่างน้อย 1 filter เสมอ — กัน query ทั้งตาราง 494K แถวโดยไม่มีเงื่อนไข (ORDER BY + LIMIT
        // ไม่มี WHERE ทำให้ MySQL optimizer เลือก full scan เองไม่ว่าจะเพิ่ม index อะไรก็ตาม — เป็นข้อจำกัดโดย
        // ธรรมชาติของ query แบบนี้ ไม่ใช่แค่เรื่อง index)
        if (!date_from && !date_to && !year_bh) {
            return res.status(400).json({ success: false, message: 'กรุณาเลือกช่วงวันที่หรือปีงบก่อนค้นหา' });
        }

        // แยก WHERE 2 ชุด — ชุดที่ join กับ kpi_indicators (ต้องใช้เมื่อกรอง dept_id) กับชุดที่ไม่ต้อง join
        // (กรอง r.* ล้วนๆ) กัน COUNT(*) ช้าโดยไม่จำเป็นเมื่อไม่ได้กรอง dept_id
        const where = [];
        const params = [];
        if (date_from) { where.push('r.created_at >= ?'); params.push(date_from + ' 00:00:00'); }
        if (date_to) { where.push('r.created_at <= ?'); params.push(date_to + ' 23:59:59'); }
        if (year_bh) { where.push('r.year_bh = ?'); params.push(String(year_bh)); }
        if (month_from && month_to) {
            const months = monthBhRangeList(month_from, month_to);
            where.push(`r.month_bh IN (${months.map(() => '?').join(',')})`);
            params.push(...months);
        }
        if (indicator_id) { where.push('r.indicator_id = ?'); params.push(Number(indicator_id)); }
        if (hospcode) { where.push('r.hospcode = ?'); params.push(String(hospcode)); }
        const needsIndicatorJoin = !!dept_id;
        if (dept_id) { where.push('i.dept_id = ?'); params.push(Number(dept_id)); }
        const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const [countRows] = await db.query(`
            SELECT COUNT(*) AS total
            FROM kpi_results r
            ${needsIndicatorJoin ? 'JOIN kpi_indicators i ON r.indicator_id = i.id' : ''}
            ${whereSql}
        `, params);

        const [rows] = await db.query(`
            SELECT r.id, r.indicator_id, r.year_bh, r.month_bh, r.hospcode, r.target_value, r.actual_value,
                   r.status, r.is_locked, r.created_at,
                   i.kpi_indicators_name, i.result_formula, i.dept_id, d.dept_name
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            LEFT JOIN departments d ON d.id = i.dept_id
            ${whereSql}
            ORDER BY r.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        // เติมชื่อหน่วยบริการแยกต่างหาก (ดู comment ด้านบน) — เฉพาะ hoscode ที่ปรากฏในหน้านี้เท่านั้น
        const hoscodes = [...new Set(rows.map(r => r.hospcode).filter(Boolean))];
        let hosMap = new Map();
        if (hoscodes.length > 0) {
            const [hosRows] = await db.query(
                `SELECT hoscode, hosname FROM chospital WHERE hoscode IN (${hoscodes.map(() => '?').join(',')})`,
                hoscodes
            );
            hosMap = new Map(hosRows.map(h => [String(h.hoscode).trim(), h.hosname]));
        }
        const data = rows.map(r => ({ ...r, hosname: hosMap.get(String(r.hospcode).trim()) || null }));

        res.json({ success: true, data, total: countRows[0].total, page, limit });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /kpi-results/manage/bulk-delete — ลบตาม kpi_results.id ตรงๆ (ละเอียดระดับ 1 เดือน/1 แถว)
// hardcode isSuperAdmin ตรงๆ เสมอ (ไม่เข้า PAGE_ACCESS_RULES) ตามกฎ DELETE ทุกตัวของระบบ
apiRouter.post('/kpi-results/manage/bulk-delete', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีรายการที่จะลบ' });
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const idPlaceholders = ids.map(() => '?').join(',');
        // ดึงข้อมูลแถวที่จะลบไว้ก่อน — ต้องใช้ (indicator_id, year_bh, hospcode, month_bh) ไปลบ kpi_sub_results
        // ที่ตรงกันเป๊ะ และ (indicator_id, year_bh) ไปสั่ง refresh kpi_summary หลังลบเสร็จ
        const [targetRows] = await connection.query(
            `SELECT id, indicator_id, year_bh, hospcode, month_bh FROM kpi_results WHERE id IN (${idPlaceholders})`,
            ids
        );
        if (targetRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: 'ไม่พบรายการที่ระบุ' });
        }

        let deletedSub = 0;
        for (const t of targetRows) {
            const [subRes] = await connection.query(
                `DELETE sr FROM kpi_sub_results sr
                 JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND sr.year_bh = ? AND sr.hospcode = ? AND sr.month_bh = ?`,
                [t.indicator_id, t.year_bh, t.hospcode, t.month_bh]
            );
            deletedSub += subRes.affectedRows || 0;
            const [actRes] = await connection.query(
                `DELETE ar FROM kpi_activity_results ar
                 JOIN kpi_sub_activities a ON ar.activity_id = a.id
                 JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
                 WHERE si.indicator_id = ? AND ar.year_bh = ? AND ar.hospcode = ? AND ar.month_bh = ?`,
                [t.indicator_id, t.year_bh, t.hospcode, t.month_bh]
            );
            deletedSub += actRes.affectedRows || 0;
        }

        const [kpiRes] = await connection.query(
            `DELETE FROM kpi_results WHERE id IN (${idPlaceholders})`,
            ids
        );

        // recompute kpi_summary เฉพาะ (indicator_id, year_bh) ที่ได้รับผลกระทบ (unique pairs)
        const pairSet = new Map();
        for (const t of targetRows) pairSet.set(`${t.indicator_id}_${t.year_bh}`, { indicator_id: t.indicator_id, year_bh: t.year_bh });
        await refreshKpiSummaryForIndicatorYears(connection, [...pairSet.values()]);

        await connection.commit();
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'BULK_DELETE_KPI_MANAGE', 'kpi_results,kpi_sub_results', JSON.stringify({ count: ids.length, deletedKpi: kpiRes.affectedRows || 0, deletedSub }), req.ip]
        ).catch(() => {});
        res.json({ success: true, message: `ลบสำเร็จ — kpi_results ${kpiRes.affectedRows || 0}, kpi_sub_results ${deletedSub}`, deletedKpi: kpiRes.affectedRows || 0, deletedSub });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally {
        connection.release();
    }
}));

// authenticateToken: เดิม route นี้ verify JWT เองอย่างเดียว ข้ามการตรวจ single session — ผู้ใช้ที่ถูกบังคับ logout
// หรือ login ซ้อนจากเครื่องอื่นแล้ว ยังบันทึกผลงานด้วย token เก่าได้จนหมดอายุ (8 ชม.) — ต้องผ่าน middleware กลางเสมอ
apiRouter.post('/update-kpi', authenticateToken, async (req, res) => {
    let updates = req.body;
    if (req.body && req.body.updates && Array.isArray(req.body.updates)) {
        updates = req.body.updates;
    }
    const targetHospcode = req.body.targetHospcode;
    // mode: 'setup_overwrite' = KPI-Setup เพิ่มทั้งหมด (เขียนทับ, บันทึก 0 ได้)
    //        'setup_insert_new' = KPI-Setup เพิ่มเฉพาะที่ยังไม่มี (บันทึก 0 ได้)
    //        undefined/default = Dashboard ปกติ (ข้าม row ที่ค่า 0 ทั้งหมด)
    const saveMode = req.body.mode || 'default';

    const user = req.user; // ผ่าน authenticateToken แล้ว (JWT + single session)

    const hospcodeToSave = (ROLE_ADMIN_ALL.includes(user.role) && targetHospcode) ? targetHospcode : user.hospcode;

    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ success: false, message: 'ไม่มีข้อมูล' });
    }

    // ผู้ดูแลที่ระบุหน่วยบริการรายแถวครบทุกแถว (เพิ่มตัวชี้วัดให้หลายหน่วยบริการในคำขอเดียว) ไม่ต้องมี targetHospcode
    const everyRowHasHospcode = ROLE_ADMIN_ALL.includes(user.role) && updates.every(r => r && r.hospcode);
    if (!hospcodeToSave && !everyRowHasHospcode) {
        return res.status(400).json({ success: false, message: 'ไม่พบรหัสหน่วยบริการ กรุณาเลือกหน่วยบริการ' });
    }

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // Admin ทุกระดับเพิ่มตัวชี้วัดทุก dept ได้, User ต้องเป็น dept ตัวเอง
        if (!ROLE_ADMIN_ALL.includes(user.role)) {
            const indicatorIds = [...new Set(updates.map(u => u.indicator_id))];
            if (indicatorIds.length > 0) {
                const [allowed] = await connection.query(
                    'SELECT id FROM kpi_indicators WHERE id IN (?) AND dept_id = ?',
                    [indicatorIds, user.deptId]
                );
                const allowedIds = allowed.map(a => a.id);
                const unauthorizedIds = indicatorIds.filter(id => !allowedIds.includes(id));
                if (unauthorizedIds.length > 0) throw new Error('ไม่มีสิทธิ์แก้ไขข้อมูลหน่วยงานอื่น');
            }
        }

        const months = [
            { col: 'oct', val: 10 }, { col: 'nov', val: 11 }, { col: 'dece', val: 12 },
            { col: 'jan', val: 1 }, { col: 'feb', val: 2 }, { col: 'mar', val: 3 },
            { col: 'apr', val: 4 }, { col: 'may', val: 5 }, { col: 'jun', val: 6 },
            { col: 'jul', val: 7 }, { col: 'aug', val: 8 }, { col: 'sep', val: 9 }
        ];

        // สร้าง uniqueKeys สำหรับใช้ทั้ง lock check + insert/update
        const uniqueKeys = [...new Set(updates.map(row => {
            const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
            return `${row.indicator_id}_${row.year_bh}_${hc}`;
        }))];

        // --- Mode: setup_insert_new → เพิ่มเฉพาะคู่ (ตัวชี้วัด × หน่วยบริการ × ปีงบ) ที่ยังไม่มี ---
        // ทำก่อนลูปตรวจล็อค/คงค่าเดิมรายคู่ด้านล่าง: โหมดนี้ไม่แตะแถวที่มีอยู่ (รวมแถวที่ล็อค = ข้ามเฉยๆ ไม่ทำให้ทั้งคำขอล้ม)
        // และรองรับหลายหน่วยบริการในคำขอเดียว (หน้าต่างเพิ่มตัวชี้วัดหาปลายทางอัตโนมัติจากประเภทหน่วยบริการ — 19 ต.ค. 2569)
        if (saveMode === 'setup_insert_new') {
            const rowHc = (row) => String((ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave).trim();
            const hcs = [...new Set(updates.map(rowHc).filter(Boolean))];
            const indIds = [...new Set(updates.map(r => Number(r.indicator_id)).filter(Boolean))];
            const years = [...new Set(updates.map(r => String(r.year_bh || '')).filter(Boolean))];
            if (indIds.length === 0 || years.length === 0) throw new Error('ข้อมูลไม่ครบ');
            const [hosRows] = hcs.length ? await connection.query('SELECT hoscode, hostype, distid FROM chospital WHERE hoscode IN (?)', [hcs]) : [[]];
            const hosMap = new Map(hosRows.map(h => [String(h.hoscode).trim(), h]));

            // ขอบเขตหน่วยบริการปลายทางตามบทบาท (เดิมไม่ตรวจ — admin_cup ส่งรหัสหน่วยบริการอำเภออื่นได้)
            let outOfScope = [];
            if (ROLE_SCOPE_HOSPCODE.includes(user.role)) {
                outOfScope = hcs.filter(hc => hc !== String(user.hospcode || '').trim());
            } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
                const myDist = await getDistrictId(user.hospcode);
                outOfScope = hcs.filter(hc => !myDist || String(hosMap.get(hc)?.distid || '') !== String(myDist));
            }
            if (outOfScope.length > 0) {
                await connection.rollback();
                return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์เพิ่มตัวชี้วัดให้หน่วยบริการนอกขอบเขตของท่าน: ' + outOfScope.slice(0, 5).join(', ') });
            }

            // คู่ที่มีอยู่แล้ว — query เดียว (เดิม 1 query ต่อคู่)
            const [existRows] = await connection.query(
                'SELECT DISTINCT indicator_id, year_bh, hospcode FROM kpi_results WHERE indicator_id IN (?) AND year_bh IN (?) AND hospcode IN (?)',
                [indIds, years, hcs.length ? hcs : ['']]
            );
            const existingKeys = new Set(existRows.map(r => r.indicator_id + '_' + r.year_bh + '_' + String(r.hospcode).trim()));
            const [indRows] = await connection.query('SELECT id, evaluation_mode, required_off_types FROM kpi_indicators WHERE id IN (?)', [indIds]);
            const indMap = new Map(indRows.map(i => [Number(i.id), i]));

            const seen = new Set();
            const newUpdates = [];
            let skipped = 0, skippedType = 0, skippedUnset = 0;
            for (const row of updates) {
                const hc = rowHc(row);
                const key = Number(row.indicator_id) + '_' + row.year_bh + '_' + hc;
                if (existingKeys.has(key) || seen.has(key)) { skipped++; continue; }
                const ind = indMap.get(Number(row.indicator_id));
                // ยังไม่ได้ตั้งประเภทหน่วยบริการ → เพิ่มไม่ได้ ต้องตั้งค่าที่หน้าจัดการตัวชี้วัดก่อน
                if (indicatorTypeSetting(ind) === 'unset') { skippedUnset++; continue; }
                const ht = hosMap.get(hc)?.hostype;
                if (ht && !indicatorAllowsHostype(ind, ht)) { skippedType++; continue; }
                seen.add(key);
                newUpdates.push({ ...row, _hc: hc });
            }

            if (newUpdates.length === 0) {
                await connection.commit();
                const why = [skipped ? 'มีอยู่แล้ว ' + skipped : '', skippedType ? 'ไม่ตรงประเภทหน่วยบริการ ' + skippedType : '', skippedUnset ? 'ตัวชี้วัดยังไม่ได้ตั้งประเภทหน่วยบริการ ' + skippedUnset : ''].filter(Boolean).join(', ');
                return res.json({ success: true, message: 'ไม่มีตัวชี้วัดใหม่ที่ต้องเพิ่ม' + (why ? ' (' + why + ')' : ''), inserted: 0, skipped, skipped_type: skippedType, skipped_unset: skippedUnset });
            }

            // INSERT เฉพาะคู่ใหม่ ครบ 12 เดือน (บันทึก 0 ได้) — แบ่งชุดกันคำสั่งยาวเกิน
            const insertRows = [];
            for (const row of newUpdates) {
                const rawTarget = row.target_value;
                const targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? String(rawTarget).trim() : '';
                for (const m of months) {
                    const rawActual = row[m.col];
                    const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? String(rawActual).trim() : '';
                    insertRows.push([row.indicator_id, row.year_bh, m.val, actualValue, targetValue, user.userId, 'Pending', row._hc, 0]);
                }
            }
            for (let i = 0; i < insertRows.length; i += 2400) {
                await connection.query(
                    'INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked) VALUES ?',
                    [insertRows.slice(i, i + 2400)]
                );
            }

            await connection.query(
                'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
                [user.userId, user.deptId || 0, 'INSERT', 'kpi_results',
                 JSON.stringify({ message: 'เพิ่มตัวชี้วัดให้หน่วยบริการ ' + newUpdates.length + ' คู่ (' + hcs.length + ' หน่วยบริการ) ข้ามที่มีอยู่แล้ว ' + skipped + ' ไม่ตรงประเภท ' + skippedType + ' ยังไม่ตั้งประเภท ' + skippedUnset }),
                 req.ip]
            );

            await connection.commit();
            scheduleSummaryRefresh(updates); // อัปเดต kpi_summary ของคู่ (ตัวชี้วัด × ปีงบ) ที่บันทึก ทันที (fire-and-forget)
            return res.json({
                success: true,
                message: 'เพิ่มตัวชี้วัดใหม่ ' + newUpdates.length + ' รายการ (ข้าม ' + (skipped + skippedType + skippedUnset) + ' รายการ)',
                inserted: newUpdates.length,
                skipped,
                skipped_type: skippedType,
                skipped_unset: skippedUnset
            });
        }

        // ตรวจสอบล็อค (super_admin ข้ามได้)
        if (user.role !== 'super_admin') {
            for (const key of uniqueKeys) {
                const [indId, ybh, hc] = key.split('_');
                const [lockedRows] = await connection.query(
                    'SELECT COUNT(*) as cnt FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND is_locked = 1',
                    [indId, ybh, hc]
                );
                if (lockedRows[0].cnt > 0) {
                    throw new Error(`ไม่สามารถแก้ไขได้ ข้อมูลตัวชี้วัด ID ${indId} ถูกล็อคอยู่`);
                }
            }
        }

        // === Permission Enforcement (super_admin ข้าม) ===
        // ถ้า user แก้เป้าหมาย/ผลงานไม่ได้ → preserve ค่าเดิมจาก DB (ไม่ให้ค่าที่ส่งมา override)
        if (user.role !== 'super_admin') {
            const perms = await getPermsForUser(user.userId, user.role);
            if (!perms.can_edit_target || !perms.can_edit_actual) {
                // โหลดค่าเดิมจาก DB ทำ preserveMap: key → { target, months: {monthVal: actual} }
                const preserveMap = {};
                for (const key of uniqueKeys) {
                    const [indId, ybh, hc] = key.split('_');
                    const [existing] = await connection.query(
                        'SELECT month_bh, actual_value, target_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                        [indId, ybh, hc]
                    );
                    const entry = { target: null, months: {} };
                    for (const r of existing) {
                        if (entry.target === null && r.target_value != null && r.target_value !== '') entry.target = r.target_value;
                        entry.months[r.month_bh] = r.actual_value;
                    }
                    preserveMap[key] = entry;
                }
                // apply preserve ลงใน updates แต่ละ row
                for (const row of updates) {
                    const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
                    const key = `${row.indicator_id}_${row.year_bh}_${hc}`;
                    const saved = preserveMap[key];
                    if (!saved) continue;
                    // ถ้าแก้เป้าหมายไม่ได้ → คืนค่า target เดิม
                    if (!perms.can_edit_target) {
                        row.target_value = saved.target != null ? saved.target : (row.target_value || '');
                    }
                    // ถ้าแก้ผลงานไม่ได้ → คืนค่า actual เดิมรายเดือน
                    if (!perms.can_edit_actual) {
                        for (const m of months) {
                            const old = saved.months[m.val];
                            row[m.col] = (old != null) ? old : (row[m.col] ?? '');
                        }
                    }
                }
            }
        }

        // --- Mode: setup_overwrite → เพิ่มทั้งหมด เขียนทับ (บันทึก 0 ได้) ---
        if (saveMode === 'setup_overwrite') {
            // DELETE ข้อมูลเก่าทั้งหมด
            for (const key of uniqueKeys) {
                const [indId, ybh, hc] = key.split('_');
                await connection.query(
                    'DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                    [indId, ybh, hc]
                );
            }

            // INSERT ทั้งหมด (รวม 0 ด้วย)
            const insertValues = [];
            const insertParams = [];
            for (const row of updates) {
                const { indicator_id, year_bh } = row;
                const rowHospcode = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;

                for (const m of months) {
                    const rawActual = row[m.col];
                    const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? String(rawActual).trim() : '';
                    const rawTarget = row.target_value;
                    const targetValue = (rawTarget !== undefined && rawTarget !== null && rawTarget !== '') ? String(rawTarget).trim() : '';
                    insertValues.push('(?, ?, ?, ?, ?, ?, ?, ?, 0)');
                    insertParams.push(indicator_id, year_bh, m.val, actualValue, targetValue, user.userId, 'Pending', rowHospcode);
                }
            }

            if (insertValues.length > 0) {
                await connection.query(
                    `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked)
                     VALUES ${insertValues.join(', ')}`,
                    insertParams
                );
            }

            await connection.query(
                'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
                [user.userId, user.deptId || 0, 'INSERT', 'kpi_results',
                 JSON.stringify({ message: `KPI-Setup: เขียนทับทั้งหมด ${updates.length} ตัวชี้วัด` }),
                 req.ip]
            );

            await connection.commit();
            scheduleSummaryRefresh(updates); // อัปเดต kpi_summary ของคู่ (ตัวชี้วัด × ปีงบ) ที่บันทึก ทันที (fire-and-forget)
            return res.json({
                success: true,
                message: `บันทึกตัวชี้วัดทั้งหมด ${updates.length} รายการเรียบร้อยแล้ว (เขียนทับ)`,
                inserted: updates.length
            });
        }

        // --- Mode: default → Dashboard ปกติ (DELETE + INSERT เฉพาะ row ที่มีค่า) ---
        // Batch DELETE: ลบข้อมูลเก่าทั้งหมดของแต่ละ indicator/year/hospcode
        for (const key of uniqueKeys) {
            const [indId, ybh, hc] = key.split('_');
            await connection.query(
                'DELETE FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?',
                [indId, ybh, hc]
            );
        }

        // Batch INSERT: รวมข้อมูลทั้งหมดแล้ว INSERT ทีเดียว (ข้าม row ที่ค่า 0 ทั้งหมด)
        const insertValues = [];
        const insertParams = [];
        for (const row of updates) {
            const { indicator_id, year_bh } = row;
            const rowHospcode = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
            const rowStatus = row.preserve_status || 'Pending';

            const rawTarget3 = row.target_value;
            const targetValue3 = (rawTarget3 !== undefined && rawTarget3 !== null && rawTarget3 !== '') ? String(rawTarget3).trim() : '';
            for (const m of months) {
                const rawActual = row[m.col];
                const actualValue = (rawActual !== undefined && rawActual !== null && rawActual !== '') ? String(rawActual).trim() : null;

                if ((actualValue && actualValue !== '0') || (targetValue3 && targetValue3 !== '0')) {
                    insertValues.push('(?, ?, ?, ?, ?, ?, ?, ?, 0)');
                    insertParams.push(indicator_id, year_bh, m.val, actualValue, targetValue3, user.userId, rowStatus, rowHospcode);
                }
            }
        }

        if (insertValues.length > 0) {
            await connection.query(
                `INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked)
                 VALUES ${insertValues.join(', ')}`,
                insertParams
            );
        }

        await connection.query(
            'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
            [user.userId, user.deptId || 0, 'UPDATE', 'kpi_results', JSON.stringify({ message: `บันทึก KPI ${updates.length} รายการ` }), req.ip]
        );

        // ค่าฐาน + ค่าเพิ่มเติมที่ตั้งชื่อเอง (kpi_base_values.var_key) เฉพาะแถวที่ส่งมา: base_value (= base) และ cv_<key> (24–25 ต.ค. 2569)
        // รับเฉพาะชื่อที่ตัวชี้วัดประกาศไว้ (custom_vars) + base | ล็อคตรวจด้านบนแล้ว | สิทธิ์เดียวกับเป้าหมาย (can_edit_target) — ไม่มีสิทธิ์ = ไม่เปลี่ยนค่าเดิม | ว่าง = ลบ
        const varRowsToSave = updates.filter(r => r && Object.keys(r).some(k => k === 'base_value' || /^cv_[a-z][a-z0-9_]{0,19}$/.test(k)));
        if (varRowsToSave.length) {
            const canEditVars = user.role === 'super_admin' || !!(await getPermsForUser(user.userId, user.role)).can_edit_target;
            if (canEditVars) {
                const indIds = [...new Set(varRowsToSave.map(r => Number(r.indicator_id)).filter(Boolean))];
                const [indRows] = indIds.length ? await connection.query('SELECT id, custom_vars FROM kpi_indicators WHERE id IN (?)', [indIds]) : [[]];
                const allowedByInd = new Map(indRows.map(i => [Number(i.id), new Set(['base', ...varKeysOf(i)])]));
                for (const row of varRowsToSave) {
                    const hc = (ROLE_ADMIN_ALL.includes(user.role) && row.hospcode) ? row.hospcode : hospcodeToSave;
                    const allowed = allowedByInd.get(Number(row.indicator_id)) || new Set(['base']);
                    const entries = [];
                    if (Object.prototype.hasOwnProperty.call(row, 'base_value')) entries.push(['base', row.base_value]);
                    for (const k of Object.keys(row)) {
                        const m = /^cv_([a-z][a-z0-9_]{0,19})$/.exec(k);
                        if (m && !(m[1] === 'base' && Object.prototype.hasOwnProperty.call(row, 'base_value'))) entries.push([m[1], row[k]]);
                    }
                    for (const [key, raw] of entries) {
                        if (!allowed.has(key)) continue;   // ชื่อที่ตัวชี้วัดไม่ได้ประกาศ — ข้าม
                        const v = String(raw ?? '').trim();
                        if (v.length > 100) throw new Error(`ค่า "${key}" ยาวเกิน 100 ตัวอักษร`);
                        if (!v) {
                            await connection.query('DELETE FROM kpi_base_values WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND var_key = ?', [row.indicator_id, row.year_bh, hc, key]);
                        } else {
                            await connection.query(
                                `INSERT INTO kpi_base_values (indicator_id, year_bh, hospcode, var_key, base_value, updated_by) VALUES (?, ?, ?, ?, ?, ?)
                                 ON DUPLICATE KEY UPDATE base_value = VALUES(base_value), updated_by = VALUES(updated_by)`,
                                [row.indicator_id, row.year_bh, hc, key, v, user.userId]);
                        }
                    }
                }
            }
        }

        await connection.commit();
        scheduleSummaryRefresh(updates); // อัปเดต kpi_summary ของคู่ (ตัวชี้วัด × ปีงบ) ที่บันทึก ทันที (fire-and-forget)

        // === KPI Save Audit (fire-and-forget) ===
        (async () => {
            try {
                const userInfo = await getUserAuditInfo(user.userId);
                // Group by indicator_id เพื่อเก็บ row_count ต่อ indicator
                const byInd = new Map();
                for (const u of updates) {
                    const k = u.indicator_id;
                    if (!byInd.has(k)) byInd.set(k, { count: 0, year_bh: u.year_bh, months: new Set() });
                    byInd.get(k).count++;
                    if (u.month_bh) byInd.get(k).months.add(u.month_bh);
                }
                // ดึง indicator names ทีเดียว
                const indIds = [...byInd.keys()].filter(Boolean);
                let indNames = {};
                if (indIds.length > 0) {
                    const [rs] = await db.query(`SELECT id, kpi_indicators_name FROM kpi_indicators WHERE id IN (${indIds.map(() => '?').join(',')})`, indIds);
                    indNames = Object.fromEntries(rs.map(r => [r.id, r.kpi_indicators_name]));
                }
                for (const [indId, info] of byInd) {
                    await logKpiSaveAudit({
                        ...(userInfo || { user_id: user.userId, username: user.username }),
                        hospcode: hospcodeToSave || userInfo?.hospcode,
                        action_type: 'kpi_results',
                        indicator_id: indId,
                        indicator_name: indNames[indId] || null,
                        year_bh: info.year_bh,
                        month_bh: info.months.size ? Array.from(info.months).join(',') : null,
                        row_count: info.count,
                        summary: `${info.count} เดือน`,
                        ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                    });
                }
            } catch (e) { console.warn('[KPI Audit] update-kpi log error:', e.message); }
        })();

        res.json({ success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' });
    } catch (error) {
        await connection.rollback();
        console.error('Update Error:', error);
        res.status(500).json({ success: false, message: error.message || 'เกิดข้อผิดพลาดในการบันทึก' });
    } finally {
        connection.release();
    }
});

module.exports = { fiscalMonthOrdinal, monthBhRangeList };
