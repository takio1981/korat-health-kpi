// เส้นทาง: Form Builder (form-schemas) + ข้อมูลแบบฟอร์มไดนามิก (dynamic-data)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { ROLE_ADMIN_ALL, requireAction } = require('../core/access');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { getUserAuditInfo, logKpiSaveAudit } = require('../services/kpi-audit');
const { isValidIdentifier } = require('../core/sql');
const { scheduleSummaryRefresh } = require('../services/summary');

// ============================================================
// === Form Builder APIs (สร้างแบบฟอร์มบันทึกข้อมูล KPI) ===
// ============================================================


// GET /form-schemas — รายการ schema ทั้งหมด (super_admin ดูทั้งหมด, อื่น ๆ ดูเฉพาะที่มี schema)
apiRouter.get('/form-schemas', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT fs.*, i.kpi_indicators_name, i.table_process, d.dept_name,
                   u.username AS created_by_name,
                   (SELECT COUNT(*) FROM kpi_form_fields ff WHERE ff.schema_id = fs.id) AS field_count
            FROM kpi_form_schemas fs
            LEFT JOIN kpi_indicators i ON fs.indicator_id = i.id
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN users u ON fs.created_by = u.id
            ORDER BY fs.updated_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /form-schemas/indicator/:indicator_id — schema ของ indicator นั้น ๆ พร้อม fields
apiRouter.get('/form-schemas/indicator/:indicator_id', authenticateToken, async (req, res) => {
    try {
        const [schemas] = await db.query(
            `SELECT fs.*, i.kpi_indicators_name, i.table_process FROM kpi_form_schemas fs
             LEFT JOIN kpi_indicators i ON fs.indicator_id = i.id
             WHERE fs.indicator_id = ? AND fs.is_active = 1 LIMIT 1`,
            [req.params.indicator_id]
        );
        if (schemas.length === 0) return res.json({ success: true, data: null });
        const schema = schemas[0];
        const [fields] = await db.query(
            'SELECT * FROM kpi_form_fields WHERE schema_id = ? ORDER BY sort_order, id',
            [schema.id]
        );
        schema.fields = fields;
        res.json({ success: true, data: schema });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /form-schemas/all-indicators — รายการ indicators ทั้งหมดพร้อมสถานะ schema
apiRouter.get('/form-schemas/all-indicators', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT i.id, i.kpi_indicators_name, i.table_process, i.criterion, i.target_condition, i.result_formula, d.dept_name,
                   fs.id AS schema_id, fs.form_title, fs.is_active AS schema_active,
                   (SELECT COUNT(*) FROM kpi_form_fields ff WHERE ff.schema_id = fs.id) AS field_count
            FROM kpi_indicators i
            LEFT JOIN departments d ON i.dept_id = d.id
            LEFT JOIN kpi_form_schemas fs ON fs.indicator_id = i.id AND fs.is_active = 1
            WHERE i.is_active = 1
            ORDER BY d.dept_name, i.kpi_indicators_name
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /form-schemas — สร้าง/อัปเดต schema + CREATE TABLE ในฐานข้อมูล
apiRouter.post('/form-schemas', authenticateToken, requireAction('kpi-manage', 'add'), async (req, res) => {
    const { indicator_id, form_title, form_description, fields, schema_id, actual_value_field, include_default_fields } = req.body;
    const withDefaults = include_default_fields !== false; // default true
    if (!indicator_id || !form_title || !Array.isArray(fields) || fields.length === 0) {
        return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }
    // ตรวจสอบชื่อ field ทุกตัว
    for (const f of fields) {
        if (!f.field_name || !isValidIdentifier(f.field_name)) {
            return res.status(400).json({ success: false, message: `ชื่อคอลัมน์ "${f.field_name}" ไม่ถูกต้อง (ใช้ตัวอักษร a-z, A-Z, 0-9, _ เท่านั้น, ขึ้นต้นด้วยตัวอักษร)` });
        }
    }
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        // ดึง table_process จาก kpi_indicators
        const [indRows] = await connection.query('SELECT table_process, kpi_indicators_name FROM kpi_indicators WHERE id = ?', [indicator_id]);
        if (indRows.length === 0) throw new Error('ไม่พบตัวชี้วัด');
        const tableProcess = indRows[0].table_process;
        if (!tableProcess || !isValidIdentifier(tableProcess)) {
            throw new Error('ตัวชี้วัดนี้ยังไม่ได้กำหนดชื่อตาราง (table_process) กรุณาแก้ไขในหน้าจัดการตัวชี้วัดก่อน');
        }
        const avField = actual_value_field || null;
        let currentSchemaId = schema_id;
        if (currentSchemaId) {
            // อัปเดต schema เดิม
            await connection.query(
                'UPDATE kpi_form_schemas SET form_title=?, form_description=?, actual_value_field=?, updated_at=NOW() WHERE id=?',
                [form_title, form_description || null, avField, currentSchemaId]
            );
            await connection.query('DELETE FROM kpi_form_fields WHERE schema_id = ?', [currentSchemaId]);
        } else {
            // ปิด schema เก่า (ถ้ามี) แล้วสร้างใหม่
            await connection.query('UPDATE kpi_form_schemas SET is_active = 0 WHERE indicator_id = ?', [indicator_id]);
            const [ins] = await connection.query(
                'INSERT INTO kpi_form_schemas (indicator_id, form_title, form_description, actual_value_field, created_by) VALUES (?, ?, ?, ?, ?)',
                [indicator_id, form_title, form_description || null, avField, req.user.userId]
            );
            currentSchemaId = ins.insertId;
        }
        // บันทึก fields
        for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            await connection.query(
                'INSERT INTO kpi_form_fields (schema_id, field_name, field_label, field_type, field_options, is_required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [currentSchemaId, f.field_name, f.field_label, f.field_type || 'text', f.field_options ? JSON.stringify(f.field_options) : null, f.is_required ? 1 : 0, i]
            );
        }
        // สร้าง / อัปเดตตาราง Dynamic (ใช้ prefix form_ เพื่อไม่ซ้ำกับตาราง export)
        const formTableName = 'form_' + tableProcess;
        const reservedFields = withDefaults ? ['id','hospcode','year_bh','month_bh','created_by','created_at','updated_at'] : ['id','created_at','updated_at'];
        const customCols = fields.filter(f => !reservedFields.includes(f.field_name));
        // map field_type → SQL type
        const sqlTypeOf = (ft) => ft === 'number' ? 'DECIMAL(15,4) NULL'
                                : ft === 'score_option' ? 'VARCHAR(255) NULL'
                                : 'TEXT NULL';
        let colDefs = customCols.map(f => `\`${f.field_name}\` ${sqlTypeOf(f.field_type)}`).join(', ');
        // เพิ่มคอลัมน์ <field>_pct สำหรับ field_type='score_option' (เก็บ % คะแนนของตัวเลือกที่ผู้ใช้เลือก)
        const pctCols = customCols.filter(f => f.field_type === 'score_option');
        if (pctCols.length > 0) {
            const pctDefs = pctCols.map(f => `\`${f.field_name}_pct\` DECIMAL(10,2) NULL`).join(', ');
            colDefs = colDefs ? `${colDefs}, ${pctDefs}` : pctDefs;
        }
        if (colDefs) colDefs = ', ' + colDefs;

        if (withDefaults) {
            // สร้างตารางพร้อมฟิลด์เริ่มต้น (id, hospcode, year_bh, month_bh, created_by, created_at)
            await connection.query(`
                CREATE TABLE IF NOT EXISTS \`${formTableName}\` (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    hospcode VARCHAR(20) NOT NULL,
                    year_bh INT NOT NULL,
                    month_bh INT NULL,
                    indicator_id INT NULL${colDefs},
                    created_by INT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_hym (hospcode, year_bh, month_bh)
                )
            `);
        } else {
            // สร้างตารางโดยไม่มีฟิลด์เริ่มต้น — ใช้เฉพาะฟิลด์ที่กำหนดเอง
            await connection.query(`
                CREATE TABLE IF NOT EXISTS \`${formTableName}\` (
                    id INT AUTO_INCREMENT PRIMARY KEY${colDefs},
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);
        }

        // เพิ่มคอลัมน์ใหม่ที่ยังไม่มี (ALTER TABLE ADD COLUMN IF NOT EXISTS)
        for (const f of customCols) {
            try {
                await connection.query(`ALTER TABLE \`${formTableName}\` ADD COLUMN IF NOT EXISTS \`${f.field_name}\` ${sqlTypeOf(f.field_type)}`);
            } catch (e) { /* ignore */ }
            // ALTER เพิ่ม <field>_pct สำหรับ score_option
            if (f.field_type === 'score_option') {
                try {
                    await connection.query(`ALTER TABLE \`${formTableName}\` ADD COLUMN IF NOT EXISTS \`${f.field_name}_pct\` DECIMAL(10,2) NULL`);
                } catch (e) { /* ignore */ }
            }
        }
        await connection.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'INSERT', 'kpi_form_schemas', JSON.stringify({ indicator_id, form_title, table: tableProcess }), req.ip]
        );
        await connection.commit();
        res.json({ success: true, message: `สร้างแบบฟอร์มและตาราง "${tableProcess}" เรียบร้อยแล้ว`, schema_id: currentSchemaId });
    } catch (e) {
        await connection.rollback();
        res.status(500).json({ success: false, message: e.message });
    } finally { connection.release(); }
});

// DELETE /form-schemas/:id — ลบ schema (super_admin)
apiRouter.delete('/form-schemas/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('UPDATE kpi_form_schemas SET is_active = 0 WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบแบบฟอร์มเรียบร้อยแล้ว (ตารางข้อมูลยังคงอยู่)' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /dynamic-data/:table_name — ดึงข้อมูลจากตาราง dynamic (form_ prefix)
apiRouter.get('/dynamic-data/:table_name', authenticateToken, async (req, res) => {
    const { table_name } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    const formTable = 'form_' + table_name;
    try {
        // ตรวจสอบ columns ที่มีจริงในตาราง form (กัน ER_BAD_FIELD_ERROR ถ้าตารางไม่มี hospcode/year_bh)
        const [colInfo] = await db.query(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
            [formTable]
        );
        if (colInfo.length === 0) {
            return res.json({ success: true, data: [], reason: 'ตาราง form ยังไม่ถูกสร้าง' });
        }
        const tableCols = new Set(colInfo.map(c => c.COLUMN_NAME || c.column_name));

        const { hospcode, year_bh, month_bh, indicator_id } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        // filter เฉพาะ column ที่มีอยู่จริง
        if (hospcode && tableCols.has('hospcode')) { where += ' AND t.hospcode = ?'; params.push(hospcode); }
        if (year_bh && tableCols.has('year_bh')) { where += ' AND t.year_bh = ?'; params.push(year_bh); }
        if (month_bh && tableCols.has('month_bh')) { where += ' AND t.month_bh = ?'; params.push(month_bh); }
        if (indicator_id && tableCols.has('indicator_id')) {
            where += ' AND (t.indicator_id = ? OR t.indicator_id IS NULL)';
            params.push(indicator_id);
        }

        // ORDER BY: ใช้ฟิลด์ที่มี (year_bh + month_bh + created_at)
        const orderParts = [];
        if (tableCols.has('year_bh')) orderParts.push('t.year_bh DESC');
        if (tableCols.has('month_bh')) orderParts.push('t.month_bh DESC');
        orderParts.push('t.created_at DESC');
        const orderClause = 'ORDER BY ' + orderParts.join(', ');

        const [rows] = await db.query(`SELECT t.*, u.username AS created_by_name FROM \`${formTable}\` t LEFT JOIN users u ON t.created_by = u.id ${where} ${orderClause}`, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error(`❌ [dynamic-data GET] ${formTable}:`, e.code || '', e.message);
        res.json({ success: true, data: [], error: e.message });
    }
});

// GET /dynamic-data-months/:table_name — ดึงเดือนที่มีข้อมูลจาก dynamic table (สำหรับแสดงไอคอนใน dashboard)
apiRouter.get('/dynamic-data-months/:table_name', authenticateToken, async (req, res) => {
    const { table_name } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    try {
        const { hospcode, year_bh } = req.query;
        let where = 'WHERE 1=1';
        const params = [];
        if (hospcode) { where += ' AND hospcode = ?'; params.push(hospcode); }
        if (year_bh) { where += ' AND year_bh = ?'; params.push(year_bh); }
        const formTable = 'form_' + table_name;
        // ตรวจสอบว่าตารางมีอยู่จริงก่อน query
        const [tableCheck] = await db.query("SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?", [formTable]);
        if (!tableCheck[0]?.cnt) {
            return res.json({ success: true, data: [] });
        }
        const [rows] = await db.query(`SELECT DISTINCT month_bh FROM \`${formTable}\` ${where} AND month_bh IS NOT NULL ORDER BY month_bh`, params);
        res.json({ success: true, data: rows.map(r => r.month_bh) });
    } catch (e) { res.json({ success: true, data: [] }); }
});

// POST /dynamic-data-months/batch — batch ดึงเดือนจากหลาย table+hospcode พร้อมกัน (ลด N requests → M)
// Body: { year_bh, items: [{ table_process, hospcode }, ...] }
// Response: { success: true, data: { "table|hospcode": [10, 11, ...], ... } }
apiRouter.post('/dynamic-data-months/batch', authenticateToken, async (req, res) => {
    try {
        const { year_bh, items } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            return res.json({ success: true, data: {} });
        }
        // Group hospcodes by table_process
        const grouped = new Map(); // table_process → Set<hospcode>
        for (const it of items) {
            const tp = it && it.table_process;
            const hos = it && it.hospcode;
            if (!tp || !hos || !isValidIdentifier(tp)) continue;
            if (!grouped.has(tp)) grouped.set(tp, new Set());
            grouped.get(tp).add(String(hos));
        }
        if (grouped.size === 0) return res.json({ success: true, data: {} });

        // Pre-check ตารางไหนที่ form_* มีอยู่จริง (1 query)
        const tableNames = Array.from(grouped.keys()).map(t => 'form_' + t);
        const [existRows] = await db.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN (?)`,
            [tableNames]
        );
        const existSet = new Set(existRows.map(r => r.table_name || r.TABLE_NAME));

        const result = {};
        // Query แต่ละตารางครั้งเดียว (IN hospcodes)
        for (const [tp, hosSet] of grouped.entries()) {
            const formTable = 'form_' + tp;
            if (!existSet.has(formTable)) {
                for (const h of hosSet) result[`${tp}|${h}`] = [];
                continue;
            }
            const hosList = Array.from(hosSet);
            const params = [hosList];
            let where = 'WHERE hospcode IN (?) AND month_bh IS NOT NULL';
            if (year_bh) { where += ' AND year_bh = ?'; params.push(year_bh); }
            try {
                const [rows] = await db.query(
                    `SELECT DISTINCT hospcode, month_bh FROM \`${formTable}\` ${where}`, params
                );
                // init keys (รวมที่ไม่มีข้อมูล)
                for (const h of hosSet) result[`${tp}|${h}`] = [];
                for (const r of rows) {
                    const k = `${tp}|${r.hospcode}`;
                    if (!result[k]) result[k] = [];
                    result[k].push(r.month_bh);
                }
            } catch (_) {
                for (const h of hosSet) result[`${tp}|${h}`] = [];
            }
        }
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /dynamic-data/:table_name — บันทึกข้อมูลลงตาราง dynamic (form_ prefix) + sync kpi_results
apiRouter.post('/dynamic-data/:table_name', authenticateToken, async (req, res) => {
    const { table_name } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    const formTable = 'form_' + table_name;
    const isUpdate = !!(req.body.id && Number(req.body.id) > 0);
    const rowId = isUpdate ? Number(req.body.id) : null;
    const data = { ...req.body };
    delete data.id; delete data.created_at; delete data.updated_at; delete data.created_by_name;
    data.created_by = req.user.userId;
    if (!data.hospcode) data.hospcode = req.user.hospcode;
    if (!ROLE_ADMIN_ALL.includes(req.user.role)) data.hospcode = req.user.hospcode;

    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        // === Validate: ดึง columns จริงของตาราง form แล้วกรองเฉพาะ field ที่มีอยู่ ===
        // กัน "Unknown column" error เมื่อ frontend ส่ง field ที่ schema เพิ่งเพิ่มแต่ตารางยังไม่ ALTER
        const [colInfo] = await connection.query(
            "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
            [formTable]
        );
        if (colInfo.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: `ไม่พบตาราง ${formTable} — กรุณาสร้างแบบฟอร์มก่อน` });
        }
        const tableCols = new Map(colInfo.map(c => [(c.COLUMN_NAME || c.column_name), (c.DATA_TYPE || c.data_type || '').toLowerCase()]));

        // === Auto-compute <field>_pct สำหรับ score_option ===
        // อ่าน schema fields ของ indicator เพื่อหาว่า field ไหนเป็น score_option
        if (data.indicator_id) {
            const [scOptionFields] = await connection.query(
                `SELECT ff.field_name, ff.field_options
                 FROM kpi_form_fields ff
                 JOIN kpi_form_schemas fs ON ff.schema_id = fs.id
                 WHERE fs.indicator_id = ? AND ff.field_type = 'score_option'
                 ORDER BY fs.is_active DESC, fs.id DESC`,
                [data.indicator_id]
            );
            for (const f of scOptionFields) {
                const fname = f.field_name;
                const pctCol = fname + '_pct';
                if (!tableCols.has(pctCol)) continue;  // ตารางยังไม่มีคอลัมน์ _pct → ข้าม
                const selectedLabel = data[fname];
                if (selectedLabel == null || selectedLabel === '') continue;
                let opts = [];
                try { opts = JSON.parse(f.field_options || '[]'); } catch (_) { opts = []; }
                // หา option ที่ตรงกับ label ที่ผู้ใช้เลือก → set _pct
                const match = opts.find(o => (o.label != null ? String(o.label) : String(o)) === String(selectedLabel));
                if (match) {
                    const pct = match.percentage != null ? Number(match.percentage) : null;
                    if (pct !== null && !isNaN(pct)) data[pctCol] = pct;
                }
            }
        }

        // กรอง: เฉพาะ key ที่ valid + เป็นคอลัมน์จริงในตาราง + ไม่ใช่ id (auto-increment)
        const cols = Object.keys(data).filter(k => isValidIdentifier(k) && tableCols.has(k) && k !== 'id');
        // แปลง '' → null สำหรับคอลัมน์ตัวเลข (DECIMAL/INT/FLOAT/DOUBLE) กัน MySQL error
        const numericTypes = new Set(['decimal', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint', 'float', 'double']);
        const vals = cols.map(k => {
            const v = data[k];
            const dt = tableCols.get(k);
            if ((v === '' || v === undefined) && numericTypes.has(dt)) return null;
            return v === undefined ? null : v;
        });
        let insertedId = rowId;

        if (cols.length === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: 'ไม่มีข้อมูลที่บันทึกได้ (ฟิลด์ที่ส่งมาไม่ตรงกับโครงสร้างตาราง)' });
        }

        if (isUpdate) {
            const setClauses = cols.map(c => `\`${c}\` = ?`).join(', ');
            await connection.query(`UPDATE \`${formTable}\` SET ${setClauses} WHERE id = ?`, [...vals, rowId]);
        } else {
            const placeholders = cols.map(() => '?').join(', ');
            const [result] = await connection.query(`INSERT INTO \`${formTable}\` (\`${cols.join('`, `')}\`) VALUES (${placeholders})`, vals);
            insertedId = result.insertId;
        }

        // === Sync ไปยัง kpi_results ถ้า schema มี actual_value_field ===
        const indicatorId = data.indicator_id;
        const yearBh = data.year_bh;
        const monthBh = data.month_bh;
        const hospcode = data.hospcode;

        if (indicatorId && yearBh && monthBh) {
            const [schemaRows] = await connection.query(
                `SELECT fs.actual_value_field, ff.field_type
                   FROM kpi_form_schemas fs
                   LEFT JOIN kpi_form_fields ff ON ff.schema_id = fs.id AND ff.field_name = fs.actual_value_field
                  WHERE fs.indicator_id = ? AND fs.is_active = 1 LIMIT 1`,
                [indicatorId]
            );
            if (schemaRows.length > 0 && schemaRows[0].actual_value_field) {
                const avField = schemaRows[0].actual_value_field;
                const avType = schemaRows[0].field_type || null;
                // ถ้า field เป็น score_option → sync เป็นค่า % (จาก <field>_pct) แทน label เพื่อให้ kpi_results เก็บเป็นเปอร์เซ็นต์
                let actualValue;
                if (avType === 'score_option') {
                    const pctVal = data[avField + '_pct'];
                    actualValue = (pctVal !== undefined && pctVal !== null && pctVal !== '') ? String(pctVal) : null;
                } else {
                    actualValue = data[avField] !== undefined && data[avField] !== null && data[avField] !== '' ? String(data[avField]) : null;
                }
                if (actualValue !== null) {
                    // ดึง target_value เดิมก่อน DELETE (เก็บจากเดือน 10 แต่ใช้ร่วมทุกเดือน)
                    const [tRows] = await connection.query(
                        'SELECT MAX(target_value) AS tv FROM kpi_results WHERE indicator_id=? AND year_bh=? AND hospcode=?',
                        [indicatorId, yearBh, hospcode]
                    );
                    const targetValue = tRows[0]?.tv != null ? String(tRows[0].tv) : '';
                    // DELETE แถวเดิมของ month นั้น แล้ว INSERT ใหม่
                    await connection.query(
                        'DELETE FROM kpi_results WHERE indicator_id=? AND year_bh=? AND month_bh=? AND hospcode=?',
                        [indicatorId, yearBh, monthBh, hospcode]
                    );
                    await connection.query(
                        'INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
                        [indicatorId, yearBh, monthBh, actualValue, targetValue, req.user.userId, 'Pending', hospcode]
                    );
                }
            }
        }

        await connection.commit();

        // === KPI Save Audit (fire-and-forget) ===
        (async () => {
            try {
                const userInfo = await getUserAuditInfo(req.user.userId);
                let indName = null;
                if (data.indicator_id) {
                    const [rs] = await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [data.indicator_id]);
                    indName = rs[0]?.kpi_indicators_name || null;
                }
                await logKpiSaveAudit({
                    ...(userInfo || { user_id: req.user.userId, username: req.user.username }),
                    hospcode: data.hospcode || userInfo?.hospcode,
                    action_type: 'dynamic_form',
                    indicator_id: data.indicator_id || null,
                    indicator_name: indName,
                    year_bh: data.year_bh || null,
                    month_bh: data.month_bh || null,
                    table_name: formTable,
                    row_count: 1,
                    summary: isUpdate ? 'อัปเดต record' : 'เพิ่ม record',
                    ip_address: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64)
                });
            } catch (e) { console.warn('[KPI Audit] dynamic-data log error:', e.message); }
        })();

        scheduleSummaryRefresh([{ indicator_id: data.indicator_id, year_bh: data.year_bh }]); // อัปเดต kpi_summary ทันที (สถานะ/ล็อค/ผลงานในรายงาน)
        res.json({ success: true, message: isUpdate ? 'อัปเดตข้อมูลเรียบร้อยแล้ว' : 'บันทึกข้อมูลเรียบร้อยแล้ว', id: insertedId });
    } catch (e) {
        await connection.rollback();
        console.error(`❌ [dynamic-data] ${formTable} POST error:`, e.code || '', e.message);
        // map MySQL error → ข้อความเข้าใจง่าย
        let userMsg = e.message;
        if (e.code === 'ER_BAD_FIELD_ERROR') userMsg = 'มีฟิลด์ที่ไม่ตรงกับโครงสร้างตาราง — กรุณาแจ้ง admin ให้ปรับแบบฟอร์ม';
        else if (e.code === 'ER_TRUNCATED_WRONG_VALUE' || e.code === 'ER_DATA_TOO_LONG') userMsg = 'ข้อมูลที่กรอกไม่ถูกต้องหรือยาวเกินกำหนด — กรุณาตรวจสอบ';
        else if (e.code === 'ER_BAD_NULL_ERROR') userMsg = 'มีฟิลด์ที่จำเป็นต้องกรอก — กรุณาตรวจสอบ';
        else if (e.code === 'ER_NO_SUCH_TABLE') userMsg = 'ไม่พบตารางในฐานข้อมูล — กรุณาสร้างแบบฟอร์มก่อน';
        res.status(500).json({ success: false, message: userMsg, code: e.code });
    } finally { connection.release(); }
});

// DELETE /dynamic-data/:table_name/:record_id — ลบรายการ
apiRouter.delete('/dynamic-data/:table_name/:record_id', authenticateToken, async (req, res) => {
    const { table_name, record_id } = req.params;
    if (!isValidIdentifier(table_name)) return res.status(400).json({ success: false, message: 'ชื่อตารางไม่ถูกต้อง' });
    try {
        const formTable = 'form_' + table_name;
        await db.query(`DELETE FROM \`${formTable}\` WHERE id = ?`, [record_id]);
        res.json({ success: true, message: 'ลบข้อมูลเรียบร้อยแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
