// เส้นทาง: ส่งออกตาราง KPI, ตารางเวลา Export, Sync to KHD, อัปเดต Summary
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { apiRouter } = require('../core/router');
const { applyFormulaToSummary, mergeSubIntoSummary, withSummaryLock } = require('../services/summary');
const { applyManualToSummary } = require('../services/manual-result');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { checkKpiChanges, performKpiExport } = require('../services/export');
const { getRemotePool } = require('../db-remote');
const { performSyncToKhd } = require('../services/khd');
const { runScheduledExport } = require('../jobs/export-scheduler');

// ========== Export KPI Tables ==========

// ดึงรายการ KPI indicators ที่มี table_process (สำหรับเลือก export) พร้อมชื่อหมวดหมู่และหน่วยงาน
apiRouter.get('/exportable-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        // คืน upload_excel ด้วย — UI export-kpi จะใช้กรอง/แสดง badge
        const [rows] = await db.query(
            `SELECT i.id, i.kpi_indicators_name, i.table_process, i.dept_id, i.main_indicator_id, i.is_active,
                    i.upload_excel, i.criterion, i.target_condition, i.result_formula, i.export_items,
                    d.dept_name, mi.main_indicator_name
             FROM kpi_indicators i
             LEFT JOIN departments d ON i.dept_id = d.id
             LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
             WHERE i.table_process IS NOT NULL AND i.table_process != '' AND i.is_active = 1
             ORDER BY i.id`
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// HTTP wrapper
apiRouter.post('/check-kpi-export', authenticateToken, isSuperAdmin, async (req, res) => {
    const result = await checkKpiChanges(req.body.year_bh, req.body.indicator_ids);
    if (!result.success) return res.status(result.message?.includes('กรุณา') ? 400 : 500).json(result);
    res.json(result);
});

// HTTP endpoint เรียก core function
apiRouter.post('/export-kpi-tables', authenticateToken, isSuperAdmin, async (req, res) => {
    const result = await performKpiExport(req.body.year_bh, req.body.indicator_ids, req.user.id);
    if (!result.success) return res.status(result.message?.includes('กรุณา') ? 400 : 500).json(result);
    res.json(result);
});

// ========== Export Schedules CRUD ==========
apiRouter.get('/export-schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT s.*, u.firstname, u.lastname FROM export_schedules s LEFT JOIN users u ON s.created_by = u.id ORDER BY s.id DESC`);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/export-schedules', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_khd, notify_email, notify_telegram, notify_line } = req.body;
        if (!name || !days_of_week || !time_of_day) return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' });
        const scope = ['all', 'selected', 'changes_only'].includes(indicator_scope) ? indicator_scope : 'all';
        const [r] = await db.query(
            `INSERT INTO export_schedules (name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_khd, notify_email, notify_telegram, notify_line, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name, is_enabled ? 1 : 0, days_of_week, time_of_day, year_bh || null,
             scope === 'selected' && Array.isArray(indicator_ids) ? JSON.stringify(indicator_ids) : null,
             scope, auto_sync_khd ? 1 : 0,
             notify_email ? 1 : 0, notify_telegram ? 1 : 0, notify_line ? 1 : 0, req.user.id]
        );
        res.json({ success: true, id: r.insertId, message: 'สร้าง schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/export-schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { name, is_enabled, days_of_week, time_of_day, year_bh, indicator_ids, indicator_scope, auto_sync_khd, notify_email, notify_telegram, notify_line } = req.body;
        const scope = ['all', 'selected', 'changes_only'].includes(indicator_scope) ? indicator_scope : 'all';
        await db.query(
            `UPDATE export_schedules SET name=?, is_enabled=?, days_of_week=?, time_of_day=?, year_bh=?, indicator_ids=?, indicator_scope=?, auto_sync_khd=?, notify_email=?, notify_telegram=?, notify_line=? WHERE id=?`,
            [name, is_enabled ? 1 : 0, days_of_week, time_of_day, year_bh || null,
             scope === 'selected' && Array.isArray(indicator_ids) ? JSON.stringify(indicator_ids) : null,
             scope, auto_sync_khd ? 1 : 0,
             notify_email ? 1 : 0, notify_telegram ? 1 : 0, notify_line ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'แก้ไข schedule สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/export-schedules/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM export_schedules WHERE id=?', [req.params.id]);
        res.json({ success: true, message: 'ลบสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/export-schedules/:id/run-now', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM export_schedules WHERE id=?', [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบ schedule' });
        const result = await runScheduledExport(rows[0]);
        res.json({ success: true, message: 'รัน schedule สำเร็จ', result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/export-schedules/:id/logs', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT * FROM export_schedule_logs WHERE schedule_id=? ORDER BY run_at DESC LIMIT 50',
            [req.params.id]
        );
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /sync-to-khd/preview — ตรวจสอบข้อมูลก่อนส่ง KHD
apiRouter.post('/sync-to-khd/preview', authenticateToken, isSuperAdmin, async (req, res) => {
    const remoteDb = getRemotePool();
    if (!remoteDb) return res.status(400).json({ success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)' });
    try {
        // ดึงตาราง export ทั้งหมดจาก local (table_process ที่มีข้อมูล) พร้อมหมวดหมู่หลัก + หน่วยงาน สำหรับ filter/แสดงผล
        const [indicators] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process,
                   mi.main_indicator_name, d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d ON i.dept_id = d.id
            WHERE i.is_active = 1 AND i.table_process IS NOT NULL AND i.table_process != ''
        `);
        // deduplicate ตาม table_process (1 ตารางอาจมีหลายตัวชี้วัด/หลายหมวดหมู่/หลายหน่วยงานรวมกันได้)
        const tableMap = new Map();
        for (const ind of indicators) {
            const tp = ind.table_process.trim();
            if (!tableMap.has(tp)) tableMap.set(tp, { table: tp, names: [], ids: [], mainIndicatorNames: new Set(), deptNames: new Set() });
            const entry = tableMap.get(tp);
            entry.names.push(ind.kpi_indicators_name);
            entry.ids.push(ind.id);
            if (ind.main_indicator_name) entry.mainIndicatorNames.add(ind.main_indicator_name);
            if (ind.dept_name) entry.deptNames.add(ind.dept_name);
        }
        const tables = [];
        for (const [tp, info] of tableMap) {
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tp)) continue;
            const item = {
                table: tp, name: info.names.join(' | '),
                main_indicator_name: Array.from(info.mainIndicatorNames).join(' | ') || null,
                dept_name: Array.from(info.deptNames).join(' | ') || null,
                local_rows: 0, remote_rows: 0, local_columns: [], remote_columns: [], status: 'unknown'
            };
            // ตรวจ local table
            try {
                const [localCount] = await db.query(`SELECT COUNT(*) AS cnt FROM \`${tp}\``);
                item.local_rows = localCount[0].cnt;
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tp}\``);
                item.local_columns = localCols.map(c => c.Field);
            } catch (e) { item.status = 'no_local'; continue; }
            // ตรวจ remote table
            try {
                const [remoteCount] = await remoteDb.query(`SELECT COUNT(*) AS cnt FROM \`${tp}\``);
                item.remote_rows = remoteCount[0].cnt;
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tp}\``);
                item.remote_columns = remoteCols.map(c => c.Field);
            } catch (e) { item.status = 'no_remote'; }
            if (item.status === 'unknown') {
                item.status = item.local_rows > 0 ? 'ready' : 'empty';
            }
            // หา common columns
            if (item.local_columns.length > 0 && item.remote_columns.length > 0) {
                item.sync_columns = item.local_columns.filter(c => item.remote_columns.includes(c));
            }
            tables.push(item);
        }
        res.json({ success: true, tables });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /sync-to-khd/execute — ส่งข้อมูลจาก local export tables เข้า KHD
apiRouter.post('/sync-to-khd/execute', authenticateToken, isSuperAdmin, async (req, res) => {
    const { tables } = req.body;
    if (!Array.isArray(tables) || tables.length === 0) return res.status(400).json({ success: false, message: 'กรุณาเลือกตารางที่ต้องการ' });
    const out = await performSyncToKhd(tables, req.user.userId);
    if (!out.success && out.results.length === 0) return res.status(400).json(out);
    res.json(out);
});

// ========== KPI Summary (Materialized View) ==========

// POST /refresh-summary/prepare — ล้างข้อมูลเก่า + ส่ง indicator_ids กลับให้ frontend batch
apiRouter.post('/refresh-summary/prepare', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    try {
        const year = req.body.year_bh || '';
        if (year) await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [year]);
        else await db.query('TRUNCATE TABLE kpi_summary');

        const yearFilter = year ? 'AND year_bh = ?' : '';
        const yearParams = year ? [year] : [];
        const [indRows] = await db.query(
            `SELECT DISTINCT indicator_id FROM kpi_results WHERE 1=1 ${yearFilter}`,
            yearParams
        );
        // ตัวชี้วัดที่มีผลงานเฉพาะข้อย่อย/กิจกรรม (ตัวชี้วัด 3 ระดับ) ต้องอยู่ในรายการ batch ด้วย
        const [subIndRows] = await db.query(
            `SELECT DISTINCT si.indicator_id FROM kpi_sub_results sr JOIN kpi_sub_indicators si ON si.id = sr.sub_indicator_id WHERE 1=1 ${yearFilter.replace('year_bh', 'sr.year_bh')}
             UNION
             SELECT DISTINCT si.indicator_id FROM kpi_activity_results ar JOIN kpi_sub_activities a ON a.id = ar.activity_id
             JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id WHERE 1=1 ${yearFilter.replace('year_bh', 'ar.year_bh')}`,
            [...yearParams, ...yearParams]
        );
        const allIds = [...new Set([...indRows, ...subIndRows].map(r => Number(r.indicator_id)))];
        res.json({ success: true, indicator_ids: allIds, total: allIds.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}));

// POST /refresh-summary/batch — ประมวลผลทีละ batch (frontend ส่ง indicator_ids มา)
apiRouter.post('/refresh-summary/batch', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    try {
        const { indicator_ids, year_bh } = req.body;
        if (!Array.isArray(indicator_ids) || indicator_ids.length === 0) {
            return res.json({ success: true, inserted: 0 });
        }
        const yearFilter = year_bh ? 'AND r.year_bh = ?' : '';
        const yearParams = year_bh ? [year_bh] : [];
        const idPlaceholders = indicator_ids.map(() => '?').join(',');

        // ลบแถวของตัวชี้วัดชุดนี้ก่อน (เดิมพึ่ง /prepare ลบทั้งปีไว้ก่อน — แต่ระหว่าง prepare กับ batch การอัปเดตอัตโนมัติหลังบันทึกผลงาน
        // อาจสร้างแถวกลับมาแล้ว → INSERT ชน uk_ind_year_hos) — ลบซ้ำได้ ไม่มีผลข้างเคียง
        await db.query(`DELETE FROM kpi_summary WHERE indicator_id IN (${idPlaceholders}) ${year_bh ? 'AND year_bh = ?' : ''}`, [...indicator_ids, ...yearParams]);

        const [result] = await db.query(`
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
            WHERE r.indicator_id IN (${idPlaceholders}) ${yearFilter}
            GROUP BY i.id, r.year_bh, r.hospcode
            -- ผลงาน 0 นับเป็นผลงานจริง (เช่น ไม่มีผู้เสียชีวิต = 0 ราย) — เดิมตัดทิ้งทำให้คู่ที่บันทึก 0 ทั้งปีหายจากรายงาน (24 ต.ค. 2569 — ตรงกับ hasActualData ของ Export)
            HAVING MAX(CASE WHEN r.actual_value IS NOT NULL AND TRIM(r.actual_value) != '' THEN 1 ELSE 0 END) = 1
        `, [...indicator_ids, ...yearParams]);
        // ผลงานจากตัวชี้วัดย่อย/กิจกรรม (ตัวชี้วัด 3 ระดับ) — last_actual คำนวณใน /refresh-summary/finalize
        const merged = await mergeSubIntoSummary(db, { indicatorIds: indicator_ids, yearBh: year_bh || undefined });

        res.json({ success: true, inserted: result.affectedRows || 0, merged_from_sub: merged });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}));

// POST /refresh-summary/finalize — อัปเดต last_actual + has_form_schema
apiRouter.post('/refresh-summary/finalize', authenticateToken, isSuperAdmin, async (req, res) => withSummaryLock(async () => { // ไม่รันพร้อมงานอัปเดต kpi_summary อื่น
    try {
        const year = req.body.year_bh || '';
        const yearWhere = year ? `AND s.year_bh = ?` : '';
        const yearParams = year ? [year] : [];

        // ตัวชี้วัดปกติ: last_actual = ค่าเดือนล่าสุดที่มีข้อมูล (เดิม)
        await db.query(`
            UPDATE kpi_summary s
            JOIN kpi_indicators i ON i.id = s.indicator_id AND (i.is_cumulative = 0 OR i.is_cumulative IS NULL)
            SET s.last_actual = COALESCE(
                NULLIF(s.sep,''), NULLIF(s.aug,''), NULLIF(s.jul,''), NULLIF(s.jun,''),
                NULLIF(s.may,''), NULLIF(s.apr,''), NULLIF(s.mar,''), NULLIF(s.feb,''),
                NULLIF(s.jan,''), NULLIF(s.dece,''), NULLIF(s.nov,''), NULLIF(s.oct,'')
            )
            WHERE 1=1 ${yearWhere}
        `, yearParams);

        // ตัวชี้วัดสะสม: last_actual = ผลรวมตัวเลขทุกเดือนในปีงบ (NULL ถ้าไม่มีเดือนไหนมีค่าเลย)
        await db.query(`
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
            WHERE 1=1 ${yearWhere}
        `, yearParams);

        // ตัวชี้วัดที่ตั้งสูตรคำนวณผลงาน: ทับ last_actual ด้วยผลจากสูตร (ต้องอยู่หลัง 2 UPDATE ด้านบนเสมอ)
        await applyFormulaToSummary(db, { yearBh: year || undefined });
        // ผลงานล่าสุด/ร้อยละ ที่กรอกเอง — ทับผลที่คำนวณ (29 ต.ค. 2569)
        await applyManualToSummary(db, { yearBh: year || undefined });

        const [formSchemas] = await db.query('SELECT indicator_id FROM kpi_form_schemas WHERE is_active = 1');
        if (formSchemas.length > 0) {
            const ids = formSchemas.map(f => f.indicator_id);
            await db.query('UPDATE kpi_summary SET has_form_schema = 1 WHERE indicator_id IN (' + ids.join(',') + ')');
        }

        res.json({ success: true, message: 'Finalize สำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}));
