// ฐานข้อมูลกลาง KHD: ส่งตาราง export ไป KHD (UPSERT), เกณฑ์ต่อปีงบ, ตัวแปลงหน่วยงาน/หมวดหมู่/ยุทธศาสตร์, เพิ่มตัวชี้วัดจาก KHD, เทียบโครงสร้างตาราง
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const khdMapping = require('../khd-mapping');
const { getRemotePool } = require('../db-remote');

// ===== ส่งตาราง export เข้า KHD อย่างปลอดภัย (6 พ.ย. 2569 — เดิม UPSERT ทุกแถวทุกคอลัมน์โดยอาศัยคีย์ของ KHD เพียงอย่างเดียว) =====
// กติกา (ผู้ใช้เลือก):
//   1) ตารางใน KHD ต้องมีคีย์ unique เพียงชุดเดียว = PRIMARY KEY (hospcode, byear) — ไม่ใช่ = ข้ามทั้งตาราง (กันทับข้ามหน่วยบริการ/ปี)
//   2) แถวที่ยังไม่มีใน KHD = เพิ่ม | แถวที่มีแล้ว = เทียบ update_date: ข้อมูลไหนใหม่กว่าใช้ข้อมูลนั้น (เท่ากัน = คงค่า KHD)
//      — เวลาฝั่ง KHD อ่านจาก update_date / update_datetime / updated_at (ตารางใน KHD ใช้ชื่อต่างกัน) ฝั่ง local = update_date
//      — ตารางฝั่งใดไม่มีคอลัมน์เวลา หรือแถว local ไม่มีเวลา = ไม่ทับแถวที่มีแล้ว
//   3) local ใหม่กว่า: ค่าว่างใน local ไม่ทับค่าใน KHD (ทับเฉพาะช่องที่มีค่าและต่างกัน) และตั้ง update_date ของ KHD = ของ local
//   4) ส่งได้เฉพาะตารางของตัวชี้วัดที่เปิด "ส่งออก KHD" (upload_excel = 0) อย่างน้อย 1 ตัว
const KHD_IDENT = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const KHD_KEY_COLS = ['hospcode', 'byear'];
const KHD_TIME_COLS = ['update_date', 'update_datetime', 'updated_at'];
const isBlankVal = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const sameKhdVal = (a, b) => {
    if (isBlankVal(a) || isBlankVal(b)) return isBlankVal(a) && isBlankVal(b);
    if (a instanceof Date || b instanceof Date) return timeOf(a) === timeOf(b);
    const fa = Number(a), fb = Number(b);
    if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
    return String(a).trim() === String(b).trim();
};
function timeOf(v) {
    if (isBlankVal(v)) return null;
    const t = (v instanceof Date ? v : new Date(String(v).replace(' ', 'T'))).getTime();
    return isNaN(t) ? null : t;
}
const khdRowKey = (r) => `${String(r.hospcode ?? '').trim()}|${String(r.byear ?? '').trim()}`;

// คีย์ unique ของตาราง (จาก SHOW KEYS) → { ชื่อคีย์: [คอลัมน์ตามลำดับ] }
function uniqueKeysOf(keyRows) {
    const keys = {};
    for (const k of keyRows || []) {
        if (Number(k.Non_unique) !== 0) continue;
        (keys[k.Key_name] = keys[k.Key_name] || [])[Number(k.Seq_in_index) - 1] = k.Column_name;
    }
    return keys;
}
function hasHospYearKeyOnly(keyRows) {
    const keys = uniqueKeysOf(keyRows);
    const names = Object.keys(keys);
    const pk = keys.PRIMARY;
    return names.length === 1 && !!pk && pk.length === 2 && KHD_KEY_COLS.every(c => pk.includes(c));
}
const keySignature = (keyRows) => Object.entries(uniqueKeysOf(keyRows)).map(([n, c]) => `${n === 'PRIMARY' ? 'PK' : n}(${c.join(', ')})`).join(', ') || 'ไม่มีคีย์';

// ตารางที่ส่งได้ = มีตัวชี้วัด (ใช้ table_process นี้) ที่เปิดส่งออก KHD อย่างน้อย 1 ตัว
async function khdExportableTables(names) {
    if (!names.length) return new Set();
    const [rows] = await db.query(
        `SELECT DISTINCT TRIM(table_process) AS tp FROM kpi_indicators
         WHERE TRIM(table_process) IN (?) AND (upload_excel IS NULL OR upload_excel = 0)`, [names]);
    return new Set(rows.map(r => r.tp));
}

// วางแผนการส่ง 1 ตาราง (อ่านอย่างเดียว) — ใช้ทั้งหน้าตัวอย่าง (preview) และตอนส่งจริง
// คืน { skip: 'เหตุผล' } หรือ { cols, hasTs, inserts: [row], updates: [{ row, cols }], counts }
async function planKhdTableSync(remoteDb, tp, requestedCols) {
    let localCols, remoteCols, keyRows;
    try { [localCols] = await db.query(`SHOW COLUMNS FROM \`${tp}\``); } catch (e) { return { skip: 'ไม่มีตารางใน local' }; }
    try { [remoteCols] = await remoteDb.query(`SHOW COLUMNS FROM \`${tp}\``); } catch (e) { return { skip: 'ตาราง KHD ยังไม่มี' }; }
    try { [keyRows] = await remoteDb.query(`SHOW KEYS FROM \`${tp}\``); } catch (e) { return { skip: 'อ่านคีย์ของตาราง KHD ไม่ได้' }; }
    if (!hasHospYearKeyOnly(keyRows)) return { skip: `คีย์ของตาราง KHD ไม่ใช่ hospcode + byear (${keySignature(keyRows)})` };
    const lset = new Set(localCols.map(c => c.Field)), rset = new Set(remoteCols.map(c => c.Field));
    if (!KHD_KEY_COLS.every(c => lset.has(c))) return { skip: 'ตารางใน local ไม่มีคอลัมน์ hospcode/byear' };
    const common = [...lset].filter(c => rset.has(c));
    let cols = Array.isArray(requestedCols) && requestedCols.length
        ? requestedCols.filter(c => typeof c === 'string' && KHD_IDENT.test(c) && common.includes(c))
        : common;
    cols = [...new Set([...KHD_KEY_COLS, ...cols])];
    const remoteTs = KHD_TIME_COLS.find(c => rset.has(c)) || null;
    const hasTs = lset.has('update_date') && !!remoteTs;
    cols = cols.filter(c => !KHD_TIME_COLS.includes(c));
    const dataCols = cols.filter(c => !KHD_KEY_COLS.includes(c) && c !== 'create_date');
    const counts = { local_rows: 0, insert: 0, update: 0, unchanged: 0, khd_newer: 0, kept_blank: 0, no_time: 0, bad_key: 0 };

    const selLocal = [...new Set([...cols, ...(hasTs ? ['update_date'] : [])])];
    const [localRows] = await db.query(`SELECT ${selLocal.map(c => `\`${c}\``).join(', ')} FROM \`${tp}\``);
    counts.local_rows = localRows.length;
    const years = [...new Set(localRows.map(r => String(r.byear ?? '').trim()).filter(Boolean))];
    const remoteMap = new Map();
    if (years.length) {
        const selRemote = [...new Set([...KHD_KEY_COLS, ...dataCols, ...(hasTs ? [remoteTs] : [])])];
        const [remoteRows] = await remoteDb.query(`SELECT ${selRemote.map(c => `\`${c}\``).join(', ')} FROM \`${tp}\` WHERE byear IN (?)`, [years]);
        for (const r of remoteRows) remoteMap.set(khdRowKey(r), r);
    }
    const inserts = [], updates = [];
    for (const l of localRows) {
        if (isBlankVal(l.hospcode) || isBlankVal(l.byear)) { counts.bad_key++; continue; }
        const r = remoteMap.get(khdRowKey(l));
        if (!r) { inserts.push(l); counts.insert++; continue; }
        const lt = hasTs ? timeOf(l.update_date) : null;
        if (lt === null) { counts.no_time++; continue; }
        const rt = timeOf(r[remoteTs]);
        if (rt !== null && lt <= rt) { counts.khd_newer++; continue; }
        const changed = dataCols.filter(c => !isBlankVal(l[c]) && !sameKhdVal(l[c], r[c]));
        if (dataCols.some(c => isBlankVal(l[c]) && !isBlankVal(r[c]))) counts.kept_blank++;
        if (changed.length) { updates.push({ row: l, cols: changed }); counts.update++; } else counts.unchanged++;
    }
    return { cols, hasTs, remoteTs, inserts, updates, counts };
}

// เขียนตามแผน — UPDATE ตรวจเวลาซ้ำใน WHERE กันกรณี KHD ถูกแก้ระหว่างวางแผนกับเขียน
async function applyKhdTableSync(remoteDb, tp, plan) {
    let inserted = 0, updated = 0;
    // คอลัมน์เวลาของ KHD รับค่า update_date ของ local
    const insCols = plan.cols.concat(plan.hasTs ? [plan.remoteTs] : []);
    const valOf = (row, c) => (plan.hasTs && c === plan.remoteTs ? row.update_date : (row[c] === undefined ? null : row[c]));
    const colList = insCols.map(c => `\`${c}\``).join(', ');
    for (let i = 0; i < plan.inserts.length; i += 100) {
        const batch = plan.inserts.slice(i, i + 100);
        const [r] = await remoteDb.query(
            `INSERT INTO \`${tp}\` (${colList}) VALUES ${batch.map(() => `(${insCols.map(() => '?').join(', ')})`).join(', ')}
             ON DUPLICATE KEY UPDATE \`hospcode\` = \`hospcode\``,
            batch.flatMap(row => insCols.map(c => valOf(row, c))));
        inserted += r.affectedRows || 0;
    }
    for (const u of plan.updates) {
        const ts = `\`${plan.remoteTs}\``;
        const sets = u.cols.map(c => `\`${c}\` = ?`).concat(`${ts} = ?`).join(', ');
        const [r] = await remoteDb.query(
            `UPDATE \`${tp}\` SET ${sets} WHERE \`hospcode\` = ? AND \`byear\` = ? AND (${ts} IS NULL OR ${ts} < ?)`,
            [...u.cols.map(c => u.row[c]), u.row.update_date, u.row.hospcode, u.row.byear, u.row.update_date]);
        updated += r.affectedRows ? 1 : 0;
    }
    return { inserted, updated };
}

// Core: sync export tables to KHD — ใช้ร่วมกัน (HTTP + scheduler auto_sync_khd + DB Compare)
async function performSyncToKhd(tables, userId) {
    const remoteDb = getRemotePool();
    if (!remoteDb) return { success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)', results: [] };
    if (!Array.isArray(tables) || tables.length === 0) return { success: false, message: 'ไม่มีตารางที่จะ sync', results: [] };
    const results = [];
    const allowed = await khdExportableTables(tables.map(t => t && t.table).filter(n => typeof n === 'string' && KHD_IDENT.test(n)));
    for (const t of tables) {
        const tp = t && t.table;
        if (typeof tp !== 'string' || !KHD_IDENT.test(tp)) { results.push({ table: tp, status: 'skipped', reason: 'ชื่อตารางไม่ถูกต้อง' }); continue; }
        if (!allowed.has(tp)) { results.push({ table: tp, status: 'skipped', reason: 'ไม่ใช่ตารางของตัวชี้วัดที่เปิดส่งออก KHD' }); continue; }
        try {
            const plan = await planKhdTableSync(remoteDb, tp, t.sync_columns);
            if (plan.skip) { results.push({ table: tp, status: 'skipped', reason: plan.skip }); continue; }
            if (plan.counts.local_rows === 0) { results.push({ table: tp, status: 'skipped', reason: 'ไม่มีข้อมูลใน local', rows: 0 }); continue; }
            const { inserted, updated } = await applyKhdTableSync(remoteDb, tp, plan);
            results.push({ table: tp, status: 'success', rows: inserted + updated, inserted, updated, ...plan.counts });
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

module.exports = { performSyncToKhd, planKhdTableSync, khdExportableTables, hasHospYearKeyOnly, getKhdEffectiveCriteriaFor, loadKhdResolver, insertIndicatorFromKhd, diffTableColumns };
