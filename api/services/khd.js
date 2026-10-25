// ฐานข้อมูลกลาง KHD: ส่งตาราง export ไป KHD (UPSERT), เกณฑ์ต่อปีงบ, ตัวแปลงหน่วยงาน/หมวดหมู่/ยุทธศาสตร์, เพิ่มตัวชี้วัดจาก KHD, เทียบโครงสร้างตาราง
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const khdMapping = require('../khd-mapping');
const { getRemotePool } = require('../db-remote');

// Core: sync export tables to KHD — ใช้ร่วมกัน (HTTP + scheduler auto_sync_khd)
async function performSyncToKhd(tables, userId) {
    const remoteDb = getRemotePool();
    if (!remoteDb) return { success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)', results: [] };
    if (!Array.isArray(tables) || tables.length === 0) return { success: false, message: 'ไม่มีตารางที่จะ sync', results: [] };
    const results = [];
    for (const t of tables) {
        const tp = t.table;
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tp)) { results.push({ table: tp, status: 'skipped', reason: 'ชื่อตารางไม่ถูกต้อง' }); continue; }
        let cols = t.sync_columns;
        if (!cols || cols.length === 0) {
            // auto-detect common columns ถ้าไม่ส่งมา (scheduler)
            try {
                const [localCols] = await db.query(`SHOW COLUMNS FROM \`${tp}\``);
                const [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tp}\``);
                const local = localCols.map(c => c.Field);
                const remote = remoteCols.map(c => c.Field);
                cols = local.filter(c => remote.includes(c));
            } catch (e) { results.push({ table: tp, status: 'skipped', reason: 'ตาราง KHD ยังไม่มี' }); continue; }
            if (cols.length === 0) { results.push({ table: tp, status: 'skipped', reason: 'ไม่มีคอลัมน์ที่ตรงกัน' }); continue; }
        }
        try {
            const colList = cols.map(c => `\`${c}\``).join(', ');
            const [localRows] = await db.query(`SELECT ${colList} FROM \`${tp}\``);
            if (localRows.length === 0) { results.push({ table: tp, status: 'skipped', reason: 'ไม่มีข้อมูลใน local', rows: 0 }); continue; }
            const placeholders = cols.map(() => '?').join(', ');
            const updateCols = cols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
            let upserted = 0;
            for (const row of localRows) {
                const vals = cols.map(c => row[c] !== undefined ? row[c] : null);
                await remoteDb.query(`INSERT INTO \`${tp}\` (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updateCols}`, vals);
                upserted++;
            }
            results.push({ table: tp, status: 'success', rows: upserted });
        } catch (e) {
            results.push({ table: tp, status: 'error', reason: e.message });
        }
    }
    try {
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [userId || null, 'SYNC_TO_KHD', 'multiple', JSON.stringify({ tables: results.length, success: results.filter(r => r.status === 'success').length }), null]
        );
    } catch (_) {}
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const totalRows = results.filter(r => r.status === 'success').reduce((s, r) => s + r.rows, 0);
    return {
        success: errorCount === 0,
        message: `ส่งข้อมูลสำเร็จ ${successCount}/${results.length} ตาราง (${totalRows} rows)`,
        results,
        summary: { total: results.length, success: successCount, error: errorCount, skipped: results.length - successCount - errorCount, rows: totalRows }
    };
}

// POST /report-compare/add-from-khd — เพิ่มตัวชี้วัดจาก KHD เข้า Local พร้อม dept_id + main_indicator_id
// Helper: ดึงเกณฑ์ effective (target_percentage/target_condition) ของ report_id หนึ่งตัว สำหรับปีงบที่ระบุ
// ใช้ report_fiscal_year_config ของปีนั้นก่อนเสมอถ้ามี ไม่งั้น fallback ไปที่ reports (ค่า default) — ตรรกะเดียวกับ
// getEffectiveKhdCriteria ใน GET /report-compare (คนละจุดเพราะ endpoint นี้ดึงทีละ/หลาย report_id ไม่ใช่ทั้งหมด)
async function getKhdEffectiveCriteriaFor(remoteDb, reportId, targetPercentage, targetCondition, yearBh) {
    if (!yearBh) return { target_percentage: targetPercentage, target_condition: targetCondition, khd_fiscal_year: null };
    const [fyRows] = await remoteDb.query(
        'SELECT target_percentage, target_condition FROM report_fiscal_year_config WHERE report_id = ? AND fiscal_year = ?',
        [reportId, yearBh]
    );
    if (fyRows.length && fyRows[0].target_percentage != null) {
        return { target_percentage: fyRows[0].target_percentage, target_condition: fyRows[0].target_condition, khd_fiscal_year: yearBh };
    }
    return { target_percentage: targetPercentage, target_condition: targetCondition, khd_fiscal_year: null };
}

// ตัวจับคู่ค่าข้อความของ KHD → Local (หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์) — การจับคู่ที่ตั้งไว้ก่อน แล้วจึงจับคู่อัตโนมัติ (api/khd-mapping.js)
async function loadKhdResolver(conn) {
    const [[departments], [strategies], [mainIndicators], [mappings]] = await Promise.all([
        conn.query('SELECT id, dept_code, dept_name FROM departments'),
        conn.query('SELECT id, yut_name FROM main_yut'),
        conn.query('SELECT id, main_indicator_name, yut_id FROM kpi_main_indicators'),
        conn.query('SELECT kind, khd_key, khd_value, local_id FROM khd_value_mappings'),
    ]);
    return khdMapping.buildKhdResolver({ departments, strategies, mainIndicators, mappings });
}

// เพิ่มตัวชี้วัด 1 ตัวจากแถว reports ของ KHD — หน่วยงาน/หมวดหมู่หลัก/ยุทธศาสตร์ มาจาก KHD (ผ่านการจับคู่) ก่อนเสมอ
// ค่าที่เลือกในหน้าต่าง (fallback) ใช้เฉพาะเมื่อ KHD ไม่มีค่า หรือยังจับคู่ไม่ได้ — ผู้ใช้เลือกแบบนี้ (19 ต.ค. 2569)
async function insertIndicatorFromKhd(remoteDb, resolver, khd, fallback, yearBh) {
    const effective = await getKhdEffectiveCriteriaFor(remoteDb, khd.report_id, khd.target_percentage, khd.target_condition, yearBh);
    const r = resolver.resolveIndicator(khd, fallback);
    const [ins] = await db.query(
        `INSERT INTO kpi_indicators (kpi_indicators_name, table_process, kpi_indicators_code, dept_id, main_indicator_id, main_yut, is_active,
            data_source, khd_report_id, criterion, target_condition, khd_fiscal_year)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [khd.report_name, khd.table_process, khd.report_code || null, r.dept_id, r.main_indicator_id, r.main_yut,
         khd.data_source || null, khd.report_id, effective.target_percentage || null, effective.target_condition || null, effective.khd_fiscal_year]
    );
    return { id: ins.insertId, resolved: r };
}

// Shared: เทียบ column ระหว่าง local vs remote (ใช้ร่วมกันทั้ง /db-compare และ /users/structure-compare)
function diffTableColumns(localColumns, remoteColumns) {
    const diff = [];
    const localFields = new Map(localColumns.map(c => [c.field, c]));
    const remoteFields = new Map(remoteColumns.map(c => [c.field, c]));
    for (const [name, col] of remoteFields) {
        if (!localFields.has(name)) { diff.push({ field: name, issue: 'missing_in_local', remote_type: col.type }); }
        else if (localFields.get(name).type !== col.type) { diff.push({ field: name, issue: 'type_mismatch', local_type: localFields.get(name).type, remote_type: col.type }); }
    }
    for (const [name] of localFields) {
        if (!remoteFields.has(name)) { diff.push({ field: name, issue: 'missing_in_remote' }); }
    }
    return diff;
}

module.exports = { performSyncToKhd, getKhdEffectiveCriteriaFor, loadKhdResolver, insertIndicatorFromKhd, diffTableColumns };
