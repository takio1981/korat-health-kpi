// ส่งออกตาราง KPI รายตัวชี้วัด (performKpiExport/checkKpiChanges — ตรรกะต้องตรงกัน) + ตารางรายละเอียด <table_process>_items
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const kpiFormula = require('../kpi-formula');
const kpiRollup = require('../kpi-rollup');
const { SUB_AGG_FISCAL_ORDER, SUB_AGG_MONTH_KEYS, activeSubTree, loadSubAggregates, loadSubExportMonthMap } = require('./hierarchy');
const { baseKey, loadBaseValues, loadPrevYearData } = require('./summary');
const { formulaOk } = require('./formula-vars');
const { isValidIdentifier } = require('../core/sql');
const { isManualResult, loadManualValues, manualKey } = require('./manual-result');
const { resolveIndicatorHostypes } = require('./indicator-scope');
const { normalizeTargetMonthly, aggregateMonthlyTarget } = require('../kpi-target');

// เป้าหมายรายเดือน (29 ต.ค. 2569): เป้าหมายรวม = ล่าสุด/สะสม ถึงเดือนของผลงานล่าสุด (เหมือนหน้าบันทึกผลงาน/ตารางสรุป)
// d._mt = เป้าหมายรายเดือน { m10: …, … } จาก kpi_results — ไม่มี = เป้าหมายเดิม (เดือน ต.ค. / ข้อย่อย)
// ⚠️ ต้องใช้ทั้ง checkKpiChanges และ performKpiExport (ผลต้องตรงกัน)
function exportTargetOf(indicator, d, months) {
    const plain = (d.target === '' || d.target === undefined) ? null : d.target;
    const mode = normalizeTargetMonthly(indicator.target_monthly);
    if (!mode || !d._mt) return plain;
    const v = aggregateMonthlyTarget(mode, months.map(m => d[m]), months.map(m => d._mt[m]));
    return v === null ? plain : v;
}

// ===== Export 3 ระดับ (18 ต.ค. 2569): ตาราง <table_process>_items — 1 แถว = หน่วยบริการ × ปีงบ × ข้อย่อย/กิจกรรม =====
// ตารางหลัก <table_process> ไม่เปลี่ยน (KHD ไม่กระทบ — Sync ส่งเฉพาะตารางชื่อ table_process) ตารางนี้เก็บในระบบเท่านั้น
// ค่าข้อย่อย = loadEffectiveSubMonthly() (ข้อ auto = จากกิจกรรม) | กิจกรรมทำแล้ว/ยังไม่ทำ = 100 / 0 | เลขข้อ = kpiRollup.itemNumber()
// result = กติกาเดียวกับคอลัมน์รายข้อเดิม (is_cumulative ของตัวชี้วัดหลัก → ผลรวม, ปกติ → ค่าเดือนล่าสุดที่บันทึก)
const ITEM_MONTHS = SUB_AGG_FISCAL_ORDER;

const ITEM_DATA_COLS = ['item_level', 'item_no', 'parent_no', 'item_name', 'value_type', 'calc_mode', 'target', 'result', ...ITEM_MONTHS];

const itemsTableName = (tableName) => (tableName.length <= 58 ? `${tableName}_items` : null);

const itemNull = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

function itemSame(a, b) {
    const na = itemNull(a), nb = itemNull(b);
    if (na === null || nb === null) return na === nb;
    const fa = parseFloat(na), fb = parseFloat(nb);
    if (/^-?(\d+(\.\d+)?|\.\d+)$/.test(na) && /^-?(\d+(\.\d+)?|\.\d+)$/.test(nb)) return fa === fb;
    return na === nb;
}

function itemResult(monthVals, isCumulative) {
    if (isCumulative) {
        const nums = monthVals.filter(v => v !== null && !isNaN(parseFloat(v)));
        if (!nums.length) return null;
        const t = nums.reduce((x, v) => x + parseFloat(v), 0);
        return Number.isInteger(t) ? String(t) : String(Math.round(t * 10000) / 10000);
    }
    for (let i = monthVals.length - 1; i >= 0; i--) if (monthVals[i] !== null) return monthVals[i];
    return null;
}

async function ensureItemsTable(conn, name) {
    await conn.query(`CREATE TABLE IF NOT EXISTS \`${name}\` (
        hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, item_kind VARCHAR(10) NOT NULL DEFAULT 'sub', item_id INT NOT NULL, item_level TINYINT NOT NULL,
        item_no VARCHAR(20) DEFAULT NULL, parent_no VARCHAR(20) DEFAULT NULL, item_name VARCHAR(500) DEFAULT NULL,
        value_type VARCHAR(10) DEFAULT NULL, calc_mode VARCHAR(10) DEFAULT NULL, target VARCHAR(100) DEFAULT NULL, result VARCHAR(100) DEFAULT NULL,
        ${ITEM_MONTHS.map(m => `${m} VARCHAR(100) DEFAULT NULL`).join(', ')},
        create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (hospcode, byear, item_kind, item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    // ตารางที่สร้างก่อนรองรับหลายระดับ (คีย์เดิม hospcode, byear, item_level, item_id — ระดับ 2 = ข้อย่อย, 3 = กิจกรรม)
    // → เพิ่ม item_kind แล้วย้ายคีย์ (ข้อย่อยระดับลึกกับกิจกรรมอยู่ระดับเดียวกันได้ และ id มาจากคนละตาราง — 19 ต.ค. 2569)
    const [cols] = await conn.query(`SHOW COLUMNS FROM \`${name}\` LIKE 'item_kind'`);
    if (cols.length === 0) {
        await conn.query(`ALTER TABLE \`${name}\` ADD COLUMN item_kind VARCHAR(10) NOT NULL DEFAULT 'sub' AFTER byear`);
        await conn.query(`UPDATE \`${name}\` SET item_kind = IF(item_level = 3, 'activity', 'sub')`);
        await conn.query(`ALTER TABLE \`${name}\` DROP PRIMARY KEY, ADD PRIMARY KEY (hospcode, byear, item_kind, item_id)`);
    }
}

// แถวที่ควรมีในตาราง items ของตัวชี้วัด × ปีงบ — [{ key, hospcode, item_kind, item_id, item_level, data: {col: value} }]
// เดินต้นไม้แบบ pre-order: ข้อย่อย → ข้อลูกของมัน … → กิจกรรมของข้อนั้น (ตัวชี้วัดหลายระดับ — 19 ต.ค. 2569)
async function buildItemExportRows(conn, indicator, yearBh) {
    const [allSubs] = await conn.query(
        'SELECT id, parent_sub_id, is_active, sub_indicator_name, item_no, rollup_mode, target_percentage FROM kpi_sub_indicators WHERE indicator_id = ? ORDER BY sort_order, id',
        [indicator.id]);
    const subs = activeSubTree(allSubs);
    if (!subs.length) return [];
    const subIds = subs.map(x => x.id);
    const [acts] = await conn.query(
        'SELECT id, sub_indicator_id, activity_name, item_no, value_type, target_percentage FROM kpi_sub_activities WHERE is_active = 1 AND sub_indicator_id IN (?) ORDER BY sort_order, id',
        [subIds]);
    const subMonths = await loadSubExportMonthMap(conn, indicator.id, yearBh, { allLevels: true });
    const [subTargets] = await conn.query(
        'SELECT sub_indicator_id, hospcode, target_value FROM kpi_sub_results WHERE sub_indicator_id IN (?) AND year_bh = ? AND month_bh = 10', [subIds, yearBh]);
    const subTarget = new Map(subTargets.map(r => [`${r.sub_indicator_id}_${String(r.hospcode).trim()}`, itemNull(r.target_value)]));
    const actRes = new Map();
    const hospcodes = new Set();
    if (acts.length) {
        const [rows] = await conn.query(
            'SELECT activity_id, hospcode, month_bh, target_value, actual_value FROM kpi_activity_results WHERE activity_id IN (?) AND year_bh = ?',
            [acts.map(a => a.id), yearBh]);
        for (const r of rows) {
            const hc = String(r.hospcode || '').trim();
            const mk = SUB_AGG_MONTH_KEYS[Number(r.month_bh)];
            if (!hc || !mk) continue;
            hospcodes.add(hc);
            const k = `${r.activity_id}_${hc}`;
            if (!actRes.has(k)) actRes.set(k, { months: {}, target: null });
            const e = actRes.get(k);
            e.months[mk] = r.actual_value;
            if (Number(r.month_bh) === 10) e.target = itemNull(r.target_value);
        }
    }
    for (const k of subMonths.keys()) hospcodes.add(k.slice(k.indexOf('_') + 1));
    for (const k of subTarget.keys()) hospcodes.add(k.slice(k.indexOf('_') + 1));
    const childSubs = (pid) => subs.filter(s => (s.parent_sub_id == null ? null : Number(s.parent_sub_id)) === pid);
    const subActs = (sid) => acts.filter(a => Number(a.sub_indicator_id) === Number(sid));
    const isCum = Number(indicator.is_cumulative) === 1;
    const out = [];
    for (const hc of [...hospcodes].filter(Boolean).sort()) {
        const walk = (parentId, parentNo, level) => {
            childSubs(parentId).forEach((su, si) => {
                const no = kpiRollup.itemNumber(su.item_no, parentNo, si);
                const kids = childSubs(Number(su.id)).length + subActs(su.id).length;
                const m = subMonths.get(`${su.id}_${hc}`) || {};
                const vals = ITEM_MONTHS.map(mk => itemNull(m[mk]));
                const data = { item_level: level, item_no: no, parent_no: itemNull(parentNo), item_name: su.sub_indicator_name, value_type: 'sub',
                    calc_mode: kpiRollup.isRolledNode({ kind: 'sub', auto: su.rollup_mode === 'auto' }, kids) ? 'auto' : 'manual',
                    target: subTarget.get(`${su.id}_${hc}`) ?? itemNull(su.target_percentage), result: itemResult(vals, isCum) };
                ITEM_MONTHS.forEach((mk, i) => { data[mk] = vals[i]; });
                out.push({ key: `${hc}|sub|${su.id}`, hospcode: hc, item_kind: 'sub', item_id: Number(su.id), data });
                walk(Number(su.id), no, level + 1);
                subActs(su.id).forEach((a, ai) => {
                    const isCheck = a.value_type === 'check';
                    const e = actRes.get(`${a.id}_${hc}`) || { months: {}, target: null };
                    const avals = ITEM_MONTHS.map(mk => {
                        if (!isCheck) return itemNull(e.months[mk]);
                        const v = kpiRollup.activityValue('check', e.months[mk]);
                        return v === null ? null : String(v);
                    });
                    // เลขข้อกิจกรรมต่อจากข้อลูก (ข้อย่อยลูกใช้ลำดับ 1..n ก่อน กิจกรรมต่อท้าย) — ตรงกับหน้าจอ
                    const ad = { item_level: level + 1, item_no: kpiRollup.itemNumber(a.item_no, no, childSubs(Number(su.id)).length + ai), parent_no: no,
                        item_name: a.activity_name, value_type: isCheck ? 'check' : 'number', calc_mode: null,
                        target: isCheck ? null : (e.target ?? itemNull(a.target_percentage)), result: itemResult(avals, isCum) };
                    ITEM_MONTHS.forEach((mk, i) => { ad[mk] = avals[i]; });
                    out.push({ key: `${hc}|activity|${a.id}`, hospcode: hc, item_kind: 'activity', item_id: Number(a.id), data: ad });
                });
            });
        };
        walk(null, indicator.item_no, 2);
    }
    return out;
}

// เทียบกับข้อมูลในตาราง items (ปีงบเดียวกัน) แบบเนื้อหา — คืนแถวที่ต้องเขียน/ลบ + จำนวน
async function diffItemsTable(conn, name, yearBh, rows) {
    const existing = new Map();
    try {
        const [ex] = await conn.query(`SELECT * FROM \`${name}\` WHERE byear = ?`, [yearBh]);
        for (const r of ex) existing.set(`${String(r.hospcode).trim()}|${r.item_kind || (Number(r.item_level) === 3 ? 'activity' : 'sub')}|${r.item_id}`, r);
    } catch (e) { if (e.code !== 'ER_NO_SUCH_TABLE') throw e; }
    const upserts = [];
    let inserted = 0, updated = 0, unchanged = 0;
    for (const r of rows) {
        const old = existing.get(r.key);
        if (!old) { inserted++; upserts.push(r); continue; }
        if (ITEM_DATA_COLS.every(c => itemSame(old[c], r.data[c]))) unchanged++;
        else { updated++; upserts.push(r); }
    }
    const keep = new Set(rows.map(r => r.key));
    const removedKeys = [...existing.keys()].filter(k => !keep.has(k));
    return { upserts, removedKeys, inserted, updated, unchanged, removed: removedKeys.length };
}

// เขียนตาราง items ของตัวชี้วัด × ปีงบ (ตารางต้องถูกสร้างก่อนเริ่ม transaction ด้วย ensureItemsTable — DDL ทำให้ transaction commit เอง)
async function writeItemsTable(conn, indicator, yearBh, name) {
    const rows = await buildItemExportRows(conn, indicator, yearBh);
    const d = await diffItemsTable(conn, name, yearBh, rows);
    const cols = ['hospcode', 'byear', 'item_kind', 'item_id', ...ITEM_DATA_COLS];
    const onDup = ITEM_DATA_COLS.map(c => `${c}=VALUES(${c})`).join(', ');
    for (let i = 0; i < d.upserts.length; i += 100) {
        const batch = d.upserts.slice(i, i + 100);
        await conn.query(
            `INSERT INTO \`${name}\` (${cols.join(', ')}) VALUES ${batch.map(() => '(' + cols.map(() => '?').join(',') + ')').join(',')} ON DUPLICATE KEY UPDATE ${onDup}`,
            batch.flatMap(r => [r.hospcode, yearBh, r.item_kind, r.item_id, ...ITEM_DATA_COLS.map(c => r.data[c] ?? null)]));
    }
    for (const k of d.removedKeys) {
        const [hc, kind, id] = k.split('|');
        await conn.query(`DELETE FROM \`${name}\` WHERE hospcode = ? AND byear = ? AND item_kind = ? AND item_id = ?`, [hc, yearBh, kind, Number(id)]);
    }
    return { table: name, rows: rows.length, inserted: d.inserted, updated: d.updated, unchanged: d.unchanged, removed: d.removed };
}

// Core: ตรวจสอบเปรียบเทียบข้อมูล KPI — ใช้ทั้ง HTTP endpoint และ scheduler
async function checkKpiChanges(year_bh, indicator_ids) {
    if (!year_bh || !/^\d{4}$/.test(year_bh)) {
        return { success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' };
    }
    try {
        // กรอง upload_excel != 1 (ตัวที่ตั้งเป็น "อัปโหลด Excel เอง" ข้ามทั้งใน check และ export)
        // ดึง evaluation_mode/required_off_types ด้วย เพื่อคำนวณขอบเขตหน่วยบริการเหมือน performKpiExport
        let indicatorQuery = `SELECT id, table_process, kpi_indicators_name, is_cumulative, result_formula, result_manual, target_monthly, custom_vars, use_sub_indicator_export, evaluation_mode, required_off_types, item_no, export_items FROM kpi_indicators
            WHERE table_process IS NOT NULL AND table_process != '' AND is_active = 1
            AND (upload_excel IS NULL OR upload_excel = 0)`;
        let indicatorParams = [];
        if (indicator_ids && indicator_ids !== 'all' && Array.isArray(indicator_ids) && indicator_ids.length > 0) {
            indicatorQuery += ` AND id IN (${indicator_ids.map(() => '?').join(',')})`;
            indicatorParams = indicator_ids;
        }
        const [indicators] = await db.query(indicatorQuery, indicatorParams);

        // ดึงรายชื่อหน่วยบริการทั้งหมดครั้งเดียว — เหมือน performKpiExport (resolveIndicatorHostypes ต่อตัวชี้วัด)
        const [allHospitals] = await db.query('SELECT hoscode, hostype FROM chospital');

        const months = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];
        const results = [];

        for (const indicator of indicators) {
            let tableName = indicator.table_process.trim().replace(/-/g, '_');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) {
                results.push({ id: indicator.id, status: 'invalid_name', has_data: false, new_count: 0, changed_count: 0, unchanged_count: 0, no_data: true });
                continue;
            }

            // ขอบเขตหน่วยบริการของตัวชี้วัดนี้ — เหมือน performKpiExport ทุกประการ
            const allowedHostypes = resolveIndicatorHostypes(indicator);
            const scopeHospcodes = allHospitals
                .filter(h => allowedHostypes.has(String(h.hostype)))
                .map(h => String(h.hoscode).trim())
                .filter(Boolean);

            // === โหมดส่งออกจากตัวชี้วัดย่อย: ตรวจการเปลี่ยนแปลงจาก kpi_sub_results แทน kpi_results/month columns ===
            if (Number(indicator.use_sub_indicator_export) === 1) {
                const [subInds] = await db.query(
                    'SELECT id, sub_indicator_name, sort_order FROM kpi_sub_indicators WHERE indicator_id = ? AND is_active = 1 ORDER BY sort_order, id',
                    [indicator.id]
                );
                if (subInds.length === 0) {
                    results.push({ id: indicator.id, status: 'no_data', has_data: false, new_count: 0, changed_count: 0, unchanged_count: 0, no_data: true });
                    continue;
                }
                const usedColNames = new Set(['hospcode', 'byear', 'target', 'result', 'create_date', 'update_date']);
                const subCols = subInds.map(si => {
                    const base = sanitizeSubIndicatorColName(si.sub_indicator_name);
                    let name = base, n = 2;
                    while (usedColNames.has(name)) name = `${base} (${n++})`;
                    usedColNames.add(name);
                    return { ...si, colName: name };
                });

                // ค่ารายเดือนที่มีผลของแต่ละข้อ (ข้อย่อยที่คำนวณจากกิจกรรม = ค่าจากกิจกรรม) — ตรงกับ loadSubAggregates() เสมอ
                const bySubHospcode = await loadSubExportMonthMap(db, indicator.id, year_bh);
                const subResultRows = [...bySubHospcode.keys()].map(k => ({ hospcode: k.slice(k.indexOf('_') + 1) }));

                const isCumulativeSub = Number(indicator.is_cumulative) === 1;
                const computeResultValueSub = (monthVals) => {
                    if (isCumulativeSub) {
                        const numericVals = monthVals.filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v)));
                        return numericVals.length > 0 ? numericVals.reduce((s, v) => s + parseFloat(v), 0) : null;
                    }
                    const reverseMonths = [...monthVals].reverse();
                    const lastActual = reverseMonths.find(v => v !== null && v !== undefined);
                    return lastActual !== undefined ? lastActual : null;
                };

                const dataMapSub = new Map();
                const allHospcodesSub = new Set([
                    ...scopeHospcodes,
                    ...subResultRows.map(r => (r.hospcode != null ? String(r.hospcode).trim() : '')).filter(Boolean)
                ]);
                for (const hc of allHospcodesSub) {
                    const entry = {};
                    for (const c of subCols) {
                        const monthEntry = bySubHospcode.get(`${c.id}_${hc}`) || {};
                        const monthVals = months.map(m => (monthEntry[m] !== undefined ? monthEntry[m] : null));
                        entry[c.colName] = computeResultValueSub(monthVals);
                    }
                    dataMapSub.set(hc, entry);
                }

                const fmtSub = (v) => {
                    if (v === null || v === undefined) return null;
                    const n = parseFloat(v);
                    if (isNaN(n)) return null;
                    return Number.isInteger(n) ? String(n) : n.toFixed(2);
                };
                for (const [, entry] of dataMapSub) {
                    const numericVals = subCols.map(c => entry[c.colName]).filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v))).map(v => parseFloat(v));
                    // หารด้วยจำนวนข้อย่อยทั้งหมด (ข้อที่ไม่ได้บันทึก = 0) — ต้องตรงกับ performKpiExport และ loadSubAggregates()
                    entry._avgResult = numericVals.length > 0 ? fmtSub(numericVals.reduce((s, v) => s + v, 0) / subCols.length) : null;
                }
                const subTargetRows = await loadSubAggregates(db, { indicatorId: indicator.id, yearBh: year_bh });
                const targetByHospcodeSub = new Map(subTargetRows.map(r => [String(r.hospcode).trim(), fmtSub(r.avg_target)]));

                const subColNames = subCols.map(c => c.colName);
                let existingSubMap = new Map();
                try {
                    const selectCols = ['hospcode', 'target', 'result', ...subColNames.map(k => `\`${k}\``)].join(', ');
                    const [existingRows] = await db.query(`SELECT ${selectCols} FROM \`${tableName}\` WHERE byear = ?`, [year_bh]);
                    for (const row of existingRows) existingSubMap.set(row.hospcode, row);
                } catch (_) { /* ตารางยังไม่มี — ทุก row เป็น new */ }

                const sameValueSub2 = (a, b) => {
                    const na = a === null || a === undefined || a === '' ? null : a;
                    const nb = b === null || b === undefined || b === '' ? null : b;
                    if (na === null && nb === null) return true;
                    if (na === null || nb === null) return false;
                    const fa = parseFloat(na), fb = parseFloat(nb);
                    if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
                    return String(na) === String(nb);
                };

                let newCountSub = 0, changedCountSub = 0, unchangedCountSub = 0;
                for (const [hc, entry] of dataMapSub) {
                    // ไม่ข้าม hospcode ที่ยังไม่มีผลงานแล้ว — ต้องนับเป็น new/unchanged ด้วยเพื่อให้ scheduler
                    // เห็นว่ามีแถวในขอบเขตที่ยังไม่ถูกสร้าง (mirror performKpiExport)
                    const target = targetByHospcodeSub.get(hc) || null;
                    const resultVal = entry._avgResult;
                    const subValues = subColNames.map(k => entry[k]);
                    const existing = existingSubMap.get(hc);
                    if (!existing) {
                        newCountSub++;
                    } else {
                        const changed =
                            !sameValueSub2(existing.target, target) ||
                            !sameValueSub2(existing.result, resultVal) ||
                            subColNames.some((k, idx) => !sameValueSub2(existing[k], subValues[idx]));
                        if (changed) changedCountSub++;
                        else unchangedCountSub++;
                    }
                }

                results.push({
                    id: indicator.id,
                    status: (newCountSub > 0 || changedCountSub > 0) ? 'has_changes' : 'up_to_date',
                    has_data: true,
                    hospcode_count: dataMapSub.size,
                    new_count: newCountSub,
                    changed_count: changedCountSub,
                    unchanged_count: unchangedCountSub,
                    no_data: false
                });
                continue;
            }

            // ตรวจสอบว่ามีข้อมูลใน kpi_results หรือ kpi_sub_results
            const [kpiRows] = await db.query(
                'SELECT hospcode, month_bh, target_value, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ?',
                [indicator.id, year_bh]
            );

            // Pivot kpi_results — แปลง '' → null ทันที (กัน block merge sub_results)
            const dataMap = new Map();
            // Seed ด้วยขอบเขตหน่วยบริการของตัวชี้วัด — เหมือน performKpiExport
            for (const hc of scopeHospcodes) dataMap.set(hc, {});
            for (const row of kpiRows) {
                if (!dataMap.has(row.hospcode)) dataMap.set(row.hospcode, {});
                const entry = dataMap.get(row.hospcode);
                const mKey = 'm' + String(row.month_bh).padStart(2, '0');
                const actualVal = row.actual_value;
                entry[mKey] = (actualVal != null && actualVal !== '') ? String(actualVal) : null;
                if (normalizeTargetMonthly(indicator.target_monthly)) (entry._mt = entry._mt || {})[mKey] = row.target_value; // เป้าหมายรายเดือน
                if (String(row.month_bh) === '10') {
                    const targetVal = row.target_value;
                    entry.target = (targetVal != null && targetVal !== '') ? String(targetVal) : null;
                }
            }

            // เติมค่า AVG จาก kpi_sub_results (เฉพาะ slot ที่ kpi_results ยังไม่มีข้อมูล)
            try {
                const subAgg = (await loadSubAggregates(db, { indicatorId: indicator.id, yearBh: year_bh })).filter(r => r.sub_rollup_mode !== 'manual'); // หลักแบบกรอกเอง = ไม่นำค่าข้อย่อยมาเติม
                const fmt = (v) => {
                    if (v === null || v === undefined) return null;
                    const n = parseFloat(v);
                    if (isNaN(n)) return null;
                    return Number.isInteger(n) ? String(n) : n.toFixed(2);
                };
                for (const subRow of subAgg) {
                    const hc = subRow.hospcode != null ? String(subRow.hospcode).trim() : '';
                    if (!hc) continue;
                    if (!dataMap.has(hc)) dataMap.set(hc, {});
                    const entry = dataMap.get(hc);
                    for (const m of months) {
                        const cur = entry[m];
                        if ((cur === undefined || cur === null || cur === '') && subRow[m] !== null && subRow[m] !== undefined) {
                            entry[m] = fmt(subRow[m]);
                        }
                    }
                    const curTgt = entry.target;
                    if ((curTgt === undefined || curTgt === null || curTgt === '') && subRow.avg_target !== null && subRow.avg_target !== undefined) {
                        entry.target = fmt(subRow.avg_target);
                    }
                }
            } catch (_) {}

            // ไม่ early-exit เมื่อ dataMap ว่างอีกต่อไป — ปกติจะไม่ว่างเพราะ seed จาก scopeHospcodes ไว้แล้ว
            // (resolveIndicatorHostypes คืนค่า default เสมอ) เหลือแค่กรณี chospital ไม่มีหน่วยบริการที่ hostype ตรงเลยจริงๆ

            // ตรวจสอบตาราง export มีอยู่หรือไม่
            let existingMap = new Map();
            try {
                const [existingRows] = await db.query(
                    `SELECT hospcode, target, result, m10, m11, m12, m01, m02, m03, m04, m05, m06, m07, m08, m09 FROM \`${tableName}\` WHERE byear = ?`,
                    [year_bh]
                );
                for (const row of existingRows) existingMap.set(row.hospcode, row);
            } catch (_) {
                // ตารางยังไม่มี — ทุก row เป็น new
            }

            // Helper เทียบค่า — ใช้เหมือนใน performKpiExport (numeric-aware)
            const emptyToNull = v => (v === '' || v === undefined) ? null : v;
            const sameValue = (a, b) => {
                const na = a === null || a === undefined || a === '' ? null : a;
                const nb = b === null || b === undefined || b === '' ? null : b;
                if (na === null && nb === null) return true;
                if (na === null || nb === null) return false;
                const fa = parseFloat(na), fb = parseFloat(nb);
                if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
                return String(na) === String(nb);
            };
            let newCount = 0, changedCount = 0, unchangedCount = 0;
            // สูตรอ้างข้อมูลปีงบที่แล้ว → โหลดครั้งเดียวต่อตัวชี้วัด (เหมือน performKpiExport)
            const _f = kpiFormula.activeFormula(indicator);
            const prevMap = formulaOk(indicator, _f) && kpiFormula.usesPrevYear(_f)
                ? await loadPrevYearData(db, [indicator.id], year_bh) : null;
            const baseMapX = formulaOk(indicator, _f) && kpiFormula.formulaVarNames(_f).length ? await loadBaseValues(db, [indicator.id], [year_bh]) : null; // ค่าฐาน/ค่าเพิ่มเติม
            // ผลงานล่าสุดแบบกรอกเอง (29 ต.ค. 2569) — ใช้ค่าที่กรอกแทนการคำนวณ (⚠️ ต้องตรงกันทั้ง checkKpiChanges และ performKpiExport)
            const manualMapX = isManualResult(indicator) ? await loadManualValues(db, [indicator.id], [year_bh]) : null;
            for (const [hc, d] of dataMap) {
                // ไม่ข้าม hospcode ที่ยังไม่มีผลงานแล้ว — ต้องนับเป็น new/unchanged ด้วย (mirror performKpiExport)
                const target = exportTargetOf(indicator, d, months);
                const monthValues = months.map(m => emptyToNull(d[m]));
                // result: มีสูตร → ตามสูตร, ตัวชี้วัดสะสม → รวมทุกเดือน, ปกติ → ค่าเดือนล่าสุดที่คีย์ (ก.ย.→ต.ค.) — เหมือน performKpiExport
                let resultVal;
                const formula = kpiFormula.activeFormula(indicator);
                if (formulaOk(indicator, formula)) {
                    resultVal = kpiFormula.evaluateFormula(formula, d, target, prevMap ? prevMap.get(`${indicator.id}|${String(hc).trim()}`) : undefined, baseMapX ? (baseMapX.get(baseKey(indicator.id, year_bh, hc)) || {}) : undefined);
                } else if (Number(indicator.is_cumulative) === 1) {
                    const numericVals = monthValues.filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v)));
                    resultVal = numericVals.length > 0 ? numericVals.reduce((s, v) => s + parseFloat(v), 0) : null;
                } else {
                    const reverseMonths = [...monthValues].reverse();
                    const lastActual = reverseMonths.find(v => v !== null && v !== undefined);
                    resultVal = lastActual !== undefined ? lastActual : null;
                }
                if (manualMapX) resultVal = emptyToNull((manualMapX.get(manualKey(indicator.id, year_bh, hc)) || {}).result);

                const existing = existingMap.get(hc);
                if (!existing) {
                    newCount++;
                } else {
                    const changed =
                        !sameValue(existing.target, target) ||
                        !sameValue(existing.result, resultVal) ||
                        months.some((m, idx) => !sameValue(existing[m], monthValues[idx]));
                    if (changed) changedCount++;
                    else unchangedCount++;
                }
            }

            results.push({
                id: indicator.id,
                status: (newCount > 0 || changedCount > 0) ? 'has_changes' : 'up_to_date',
                has_data: true,
                hospcode_count: dataMap.size,
                new_count: newCount,
                changed_count: changedCount,
                unchanged_count: unchangedCount,
                no_data: false
            });
        }

        // ตารางรายละเอียดข้อย่อย/กิจกรรม (Export 3 ระดับ) — มีการเปลี่ยนแปลงเฉพาะในตารางนี้ก็ถือว่า has_changes
        for (const r of results) {
            const ind = indicators.find(i => i.id === r.id);
            if (!ind || Number(ind.export_items) !== 1 || r.status === 'invalid_name') continue;
            const name = itemsTableName(ind.table_process.trim().replace(/-/g, '_'));
            if (!name) continue;
            const rows = await buildItemExportRows(db, ind, year_bh);
            const d = await diffItemsTable(db, name, year_bh, rows);
            r.items = { table: name, new_count: d.inserted, changed_count: d.updated, unchanged_count: d.unchanged, removed_count: d.removed };
            if (d.inserted + d.updated + d.removed > 0) r.status = 'has_changes';
        }

        const totalWithData = results.filter(r => r.has_data).length;
        const totalChanges = results.filter(r => r.status === 'has_changes').length;
        const totalUpToDate = results.filter(r => r.status === 'up_to_date').length;
        const totalNoData = results.filter(r => r.no_data).length;

        return {
            success: true,
            check_date: new Date().toISOString(),
            year_bh,
            summary: { total: results.length, with_data: totalWithData, has_changes: totalChanges, up_to_date: totalUpToDate, no_data: totalNoData },
            details: results
        };
    } catch (err) {
        return { success: false, message: err.message };
    }
}

// สร้างตาราง MySQL แยกรายตัวชี้วัด พร้อมข้อมูลคะแนนทุก hospcode
// Core function: ใช้ทั้งจาก HTTP endpoint และ scheduler
// Sanitize ชื่อ sub-indicator ให้ใช้เป็น MySQL column identifier ได้ (quote ด้วย backtick, utf8mb4 รองรับ Unicode)
function sanitizeSubIndicatorColName(name) {
    let n = String(name || '').trim().replace(/`/g, '');
    if (n.length > 60) n = n.substring(0, 60).trim(); // trim ซ้ำ — ตัดตรงกลางคำอาจเหลือช่องว่างท้ายชื่อ ซึ่ง MySQL ปฏิเสธชื่อคอลัมน์ที่ลงท้ายด้วยช่องว่าง (ER_WRONG_COLUMN_NAME)
    return n || 'sub_col';
}

async function performKpiExport(year_bh, indicator_ids, userId) {
    if (!year_bh || !/^\d{4}$/.test(year_bh)) {
        return { success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' };
    }
    if (!indicator_ids || (indicator_ids !== 'all' && !Array.isArray(indicator_ids))) {
        return { success: false, message: 'กรุณาระบุ indicator_ids เป็น array หรือ "all"' };
    }
    const conn = await db.getConnection();
    try {
        // 1. Get indicators with valid table_process
        //    — กรอง upload_excel != 1 (ตัวที่ตั้งเป็น "อัปโหลดเอง" ข้ามไป)
        //    — ดึง evaluation_mode/required_off_types ด้วย เพื่อคำนวณขอบเขตหน่วยบริการที่ต้อง export (ดู resolveIndicatorHostypes)
        let indicatorQuery = `SELECT id, table_process, kpi_indicators_name, is_cumulative, result_formula, result_manual, target_monthly, custom_vars, use_sub_indicator_export, evaluation_mode, required_off_types, item_no, export_items FROM kpi_indicators
            WHERE is_active = 1 AND (upload_excel IS NULL OR upload_excel = 0)
            AND table_process IS NOT NULL AND table_process != ''`;
        let indicatorParams = [];

        if (indicator_ids !== 'all' && Array.isArray(indicator_ids) && indicator_ids.length > 0) {
            indicatorQuery += ` AND id IN (${indicator_ids.map(() => '?').join(',')})`;
            indicatorParams = indicator_ids;
        }

        const [allIndicators] = await conn.query(indicatorQuery, indicatorParams);

        const created = [];
        const skipped = [];

        // ทุกตัวชี้วัดที่ active + มี table_process ต้อง export เสมอ (ครบทุกหน่วยบริการตามขอบเขต evaluation_mode/
        // required_off_types) แม้ไม่มีผลงานคีย์ไว้เลยก็ตาม — เดิมมี prefilter ข้ามตัวชี้วัดที่ไม่มีข้อมูลใน
        // kpi_results/kpi_sub_results/form_* ทั้งตัว ตัดออกเพราะขัดกับเป้าหมายนี้โดยตรง
        let indicators = allIndicators;

        // ดึงรายชื่อหน่วยบริการทั้งหมดครั้งเดียว (ไม่ query ซ้ำต่อตัวชี้วัด) — ใช้ resolveIndicatorHostypes()
        // ต่อตัวชี้วัดกรองว่า hostype ไหนอยู่ในขอบเขต แล้วดึงเฉพาะ hoscode ของ hostype นั้น
        const [allHospitals] = await conn.query('SELECT hoscode, hostype FROM chospital');

        // ตารางมีคอลัมน์เดือน (m10-m09) เสมอ + เพิ่ม form fields ถ้ามี
        const baseColsWithMonths = 'hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) DEFAULT NULL, result VARCHAR(100) DEFAULT NULL, m10 VARCHAR(100) DEFAULT NULL, m11 VARCHAR(100) DEFAULT NULL, m12 VARCHAR(100) DEFAULT NULL, m01 VARCHAR(100) DEFAULT NULL, m02 VARCHAR(100) DEFAULT NULL, m03 VARCHAR(100) DEFAULT NULL, m04 VARCHAR(100) DEFAULT NULL, m05 VARCHAR(100) DEFAULT NULL, m06 VARCHAR(100) DEFAULT NULL, m07 VARCHAR(100) DEFAULT NULL, m08 VARCHAR(100) DEFAULT NULL, m09 VARCHAR(100) DEFAULT NULL';

        const tableDDL = (name, extraCols) => {
            let cols = baseColsWithMonths;
            if (extraCols && extraCols.length > 0) {
                cols += ', ' + extraCols.map(f => `\`${f.field_name}\` VARCHAR(500) DEFAULT NULL`).join(', ');
            }
            return `CREATE TABLE IF NOT EXISTS \`${name}\` (${cols}, create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (hospcode, byear)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
        };

        // Helper: ALTER TABLE เพิ่มคอลัมน์ dynamic (form fields) ที่ยังไม่มี
        const ensureDynamicCols = async (conn2, tableName2, extraCols) => {
            for (const f of extraCols) {
                try { await conn2.query(`ALTER TABLE \`${tableName2}\` ADD COLUMN \`${f.field_name}\` VARCHAR(500) DEFAULT NULL`); } catch (e) { /* already exists */ }
            }
        };

        // Helper: ALTER TABLE เพิ่มคอลัมน์เดือน (m10-m09, result) ที่ยังไม่มี — สำหรับตารางเก่าที่สร้างโดยไม่มีเดือน
        const ensureMonthCols = async (conn2, tableName2) => {
            const monthCols = ['m10','m11','m12','m01','m02','m03','m04','m05','m06','m07','m08','m09','result'];
            for (const col of monthCols) {
                try { await conn2.query(`ALTER TABLE \`${tableName2}\` ADD COLUMN \`${col}\` VARCHAR(100) DEFAULT NULL`); } catch (e) { /* already exists */ }
            }
        };

        const months = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];

        for (const indicator of indicators) {
            // Sanitize table name (export ใช้ชื่อ table_process ตรงๆ, form builder ใช้ form_ prefix)
            let tableName = indicator.table_process.trim().replace(/-/g, '_');
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tableName)) {
                skipped.push({ id: indicator.id, name: indicator.kpi_indicators_name, table_process: indicator.table_process, reason: 'ชื่อตารางไม่ถูกต้อง' });
                continue;
            }

            // ขอบเขตหน่วยบริการของตัวชี้วัดนี้ (evaluation_mode/required_off_types) → รายชื่อ hoscode ที่ต้อง
            // export เสมอ ไม่ว่าจะมีผลงานคีย์ไว้หรือไม่ — ใช้ seed dataMap ของทั้ง 2 path ด้านล่าง
            const allowedHostypes = resolveIndicatorHostypes(indicator);
            const scopeHospcodes = allHospitals
                .filter(h => allowedHostypes.has(String(h.hostype)))
                .map(h => String(h.hoscode).trim())
                .filter(Boolean);

            // ตารางรายละเอียดข้อย่อย/กิจกรรม (Export 3 ระดับ) — สร้างก่อนเริ่ม transaction (DDL commit เอง)
            let itemsTable = null, itemsSkip = null;
            if (Number(indicator.export_items) === 1) {
                itemsTable = itemsTableName(tableName);
                if (itemsTable) await ensureItemsTable(conn, itemsTable);
                else itemsSkip = { skipped: 'ชื่อตารางยาวเกิน 58 ตัวอักษร — สร้างตาราง _items ไม่ได้' };
            }

            await conn.beginTransaction();
            try {
                // === โหมดส่งออกจากตัวชี้วัดย่อย: 1 คอลัมน์ต่อข้อย่อย แทนคอลัมน์รายเดือน+form fields ===
                // แยกเด็ดขาดจาก logic เดิมด้านล่าง (form schema / month columns) — ไม่ผสมกัน
                if (Number(indicator.use_sub_indicator_export) === 1) {
                    const [subInds] = await conn.query(
                        'SELECT id, sub_indicator_name, sub_indicator_code, sort_order FROM kpi_sub_indicators WHERE indicator_id = ? AND is_active = 1 ORDER BY sort_order, id',
                        [indicator.id]
                    );
                    if (subInds.length === 0) {
                        await conn.rollback();
                        skipped.push({ id: indicator.id, name: indicator.kpi_indicators_name, table_process: indicator.table_process, reason: 'เปิดใช้ "ส่งออกจากข้อย่อย" แต่ยังไม่มีตัวชี้วัดย่อยที่ active' });
                        continue;
                    }

                    // สร้างชื่อคอลัมน์จากชื่อข้อย่อย (Unicode column name — utf8mb4 รองรับ) กันชื่อซ้ำ/ชนกับคอลัมน์มาตรฐาน
                    const usedColNames = new Set(['hospcode', 'byear', 'target', 'result', 'create_date', 'update_date']);
                    const subCols = subInds.map(si => {
                        const base = sanitizeSubIndicatorColName(si.sub_indicator_name);
                        let name = base, n = 2;
                        while (usedColNames.has(name)) name = `${base} (${n++})`;
                        usedColNames.add(name);
                        return { ...si, colName: name };
                    });

                    // Create/alter export table: hospcode, byear, target, result (AVG ภาพรวม) + 1 คอลัมน์ต่อข้อย่อย
                    const subColsSql = subCols.map(c => `\`${c.colName}\` VARCHAR(500) DEFAULT NULL`).join(', ');
                    await conn.query(
                        `CREATE TABLE IF NOT EXISTS \`${tableName}\` (hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) DEFAULT NULL, result VARCHAR(100) DEFAULT NULL, ${subColsSql}, create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (hospcode, byear)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
                    );
                    for (const c of subCols) {
                        try {
                            await conn.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${c.colName}\` VARCHAR(500) DEFAULT NULL`);
                        } catch (e) {
                            // ยอมรับเฉพาะ "คอลัมน์นี้มีอยู่แล้ว" (ER_DUP_FIELDNAME) — error อื่นต้องไม่ถูกกลืนเงียบๆ
                            // ไม่งั้นคอลัมน์จะไม่ถูกสร้างจริงแต่โค้ดเดินต่อเหมือนสำเร็จ แล้วไป error ตอน INSERT แทน (วินิจฉัยยาก)
                            if (e.code !== 'ER_DUP_FIELDNAME') throw e;
                        }
                    }

                    // ดึงผลงานย่อยทั้งหมดของปีนี้ สำหรับข้อย่อยที่ active
                    // ค่ารายเดือนที่มีผลของแต่ละข้อ (ข้อย่อยที่คำนวณจากกิจกรรม = ค่าจากกิจกรรม) — ตรงกับ loadSubAggregates() เสมอ
                    const bySubHospcode = await loadSubExportMonthMap(conn, indicator.id, year_bh);
                    const subResultRows = [...bySubHospcode.keys()].map(k => ({ hospcode: k.slice(k.indexOf('_') + 1) }));

                    // result ต่อข้อย่อย: is_cumulative ของตัวชี้วัดหลัก → SUM ทุกเดือน, ปกติ → ค่าล่าสุดที่คีย์ (เหมือน logic เดิมบรรทัด ~7265-7274)
                    const isCumulative = Number(indicator.is_cumulative) === 1;
                    const computeResultValue = (monthVals) => {
                        if (isCumulative) {
                            const numericVals = monthVals.filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v)));
                            return numericVals.length > 0 ? numericVals.reduce((s, v) => s + parseFloat(v), 0) : null;
                        }
                        const reverseMonths = [...monthVals].reverse();
                        const lastActual = reverseMonths.find(v => v !== null && v !== undefined);
                        return lastActual !== undefined ? lastActual : null;
                    };

                    // Build dataMap: hospcode -> { [colName]: ค่าต่อข้อย่อย }
                    // รวม scopeHospcodes (ขอบเขตตาม evaluation_mode/required_off_types) เข้ากับ hospcode ที่มีผลงานจริง
                    // — ให้ครบทุกหน่วยบริการในขอบเขตเสมอ แม้ยังไม่มีใครคีย์ผลงานย่อยเลยก็ตาม
                    const dataMap = new Map();
                    const allHospcodes = new Set([
                        ...scopeHospcodes,
                        ...subResultRows.map(r => (r.hospcode != null ? String(r.hospcode).trim() : '')).filter(Boolean)
                    ]);
                    for (const hc of allHospcodes) {
                        const entry = {};
                        for (const c of subCols) {
                            const monthEntry = bySubHospcode.get(`${c.id}_${hc}`) || {};
                            const monthVals = months.map(m => (monthEntry[m] !== undefined ? monthEntry[m] : null));
                            entry[c.colName] = computeResultValue(monthVals);
                        }
                        dataMap.set(hc, entry);
                    }

                    const fmtNum = (v) => {
                        if (v === null || v === undefined) return null;
                        const n = parseFloat(v);
                        if (isNaN(n)) return null;
                        return Number.isInteger(n) ? String(n) : n.toFixed(2);
                    };
                    // target/result ภาพรวม = AVG ข้ามข้อย่อยทั้งหมด ต่อ hospcode (เหมือนหลักการของ /sub-results/summary)
                    for (const [, entry] of dataMap) {
                        const numericVals = subCols
                            .map(c => entry[c.colName])
                            .filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v)))
                            .map(v => parseFloat(v));
                        // หารด้วยจำนวนข้อย่อยทั้งหมด (ข้อที่ไม่ได้บันทึก = 0) — ⚠️ ต้องตรงกับ checkKpiChanges และ loadSubAggregates()
                        entry._avgResult = numericVals.length > 0 ? fmtNum(numericVals.reduce((s, v) => s + v, 0) / subCols.length) : null;
                    }
                    const subTargetRows = await loadSubAggregates(conn, { indicatorId: indicator.id, yearBh: year_bh });
                    const targetByHospcode = new Map(subTargetRows.map(r => [String(r.hospcode).trim(), fmtNum(r.avg_target)]));

                    const hasActualDataSub = (entry) => subCols.some(c => entry[c.colName] !== null && entry[c.colName] !== undefined && entry[c.colName] !== '');
                    const sameValueSub = (a, b) => {
                        const na = a === null || a === undefined || a === '' ? null : a;
                        const nb = b === null || b === undefined || b === '' ? null : b;
                        if (na === null && nb === null) return true;
                        if (na === null || nb === null) return false;
                        const fa = parseFloat(na), fb = parseFloat(nb);
                        if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
                        return String(na) === String(nb);
                    };

                    const subColNames = subCols.map(c => c.colName);
                    const existingDataMap = new Map();
                    try {
                        const selectCols = ['hospcode', 'target', 'result', ...subColNames.map(k => `\`${k}\``)].join(', ');
                        const [existingRows] = await conn.query(`SELECT ${selectCols} FROM \`${tableName}\` WHERE byear = ?`, [year_bh]);
                        for (const r of existingRows) existingDataMap.set(r.hospcode, r);
                    } catch (e) { /* ตารางเพิ่งสร้าง */ }

                    const upsertRows = [];
                    let updatedCount = 0, insertedCount = 0, unchangedCount = 0, noDataCount = 0;
                    for (const [hc, entry] of dataMap) {
                        // ไม่ข้ามแถวที่ยังไม่มีผลงานแล้ว (ต้อง export ครบทุกหน่วยบริการในขอบเขต) — นับไว้รายงานเฉยๆ
                        if (!hasActualDataSub(entry)) noDataCount++;
                        const target = targetByHospcode.get(hc) || null;
                        const resultVal = entry._avgResult;
                        const subValues = subColNames.map(k => entry[k]);

                        const existing = existingDataMap.get(hc);
                        if (existing) {
                            const changed =
                                !sameValueSub(existing.target, target) ||
                                !sameValueSub(existing.result, resultVal) ||
                                subColNames.some((k, idx) => !sameValueSub(existing[k], subValues[idx]));
                            if (!changed) { unchangedCount++; continue; }
                            updatedCount++;
                        } else {
                            insertedCount++;
                        }
                        upsertRows.push([hc, year_bh, target, resultVal, ...subValues]);
                    }

                    if (upsertRows.length > 0) {
                        const colsList = ['hospcode', 'byear', 'target', 'result', ...subColNames.map(k => `\`${k}\``)];
                        const onDupParts = ['target=VALUES(target)', 'result=VALUES(result)', ...subColNames.map(k => `\`${k}\`=VALUES(\`${k}\`)`)];
                        const cols = colsList.join(', ');
                        const onDup = onDupParts.join(', ');
                        const singlePlaceholder = '(' + Array(colsList.length).fill('?').join(',') + ')';
                        for (let i = 0; i < upsertRows.length; i += 100) {
                            const batch = upsertRows.slice(i, i + 100);
                            const placeholders = batch.map(() => singlePlaceholder).join(',');
                            const flatValues = batch.flat();
                            await conn.query(`INSERT INTO \`${tableName}\` (${cols}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${onDup}`, flatValues);
                        }
                    }

                    const itemsStat = itemsTable ? await writeItemsTable(conn, indicator, year_bh, itemsTable) : itemsSkip;
                    await conn.commit();
                    created.push({
                        table: tableName,
                        name: indicator.kpi_indicators_name,
                        total_hospcode: dataMap.size,
                        inserted: insertedCount,
                        updated: updatedCount,
                        unchanged: unchangedCount,
                        no_data: noDataCount,
                        sub_columns: subColNames,
                        ...(itemsStat ? { items: itemsStat } : {})
                    });
                    continue;
                }

                // ดึง form schema + fields สำหรับ indicator นี้
                // Priority: active schema ก่อน → ถ้าไม่มีลอง inactive schema → ถ้าไม่มี schema เลย → infer จาก columns
                const [schemaRows] = await conn.query(
                    `SELECT fs.id, fs.actual_value_field FROM kpi_form_schemas fs WHERE fs.indicator_id = ? ORDER BY fs.is_active DESC, fs.id DESC LIMIT 1`,
                    [indicator.id]
                );
                let formFields = [];
                let dynamicTableName = null;
                const dynTableCandidate = 'form_' + tableName;

                if (schemaRows.length > 0) {
                    const [fields] = await conn.query(
                        'SELECT field_name, field_label, field_type FROM kpi_form_fields WHERE schema_id = ? ORDER BY sort_order',
                        [schemaRows[0].id]
                    );
                    formFields = fields.filter(f => isValidIdentifier(f.field_name));
                }

                // ตรวจว่า dynamic table มีอยู่จริง
                try {
                    await conn.query(`SELECT 1 FROM \`${dynTableCandidate}\` LIMIT 0`);
                    dynamicTableName = dynTableCandidate;
                } catch (e) { /* table ไม่มี — ไม่มี dynamic data */ }

                // Fallback: ถ้าไม่มี schema แต่ตาราง form_* มีอยู่ → infer fields จาก columns ของตาราง
                // (กรณี schema ถูกลบหรือไม่ได้สร้างผ่าน Form Builder แต่มี form table ค้างอยู่)
                if (dynamicTableName && formFields.length === 0) {
                    try {
                        const [cols] = await conn.query(`SHOW COLUMNS FROM \`${dynamicTableName}\``);
                        const standardCols = new Set(['id', 'hospcode', 'year_bh', 'month_bh', 'indicator_id', 'created_by', 'created_at', 'updated_at']);
                        formFields = cols
                            .map(c => c.Field || c.field)
                            .filter(name => name && !standardCols.has(name) && isValidIdentifier(name))
                            .map(name => ({ field_name: name, field_label: name, field_type: 'text' }));
                        if (formFields.length > 0) {
                            console.log(`ℹ️ [Export] indicator_id=${indicator.id} (${dynamicTableName}) — ไม่มี schema → infer ${formFields.length} fields จาก columns`);
                        }
                    } catch (e) { /* infer ล้มเหลว — ไม่ส่งออก dynamic data */ }
                }

                const hasForm = formFields.length > 0;
                // Create export table: มีคอลัมน์เดือนเสมอ + เพิ่ม form fields ถ้ามี
                await conn.query(tableDDL(tableName, formFields));
                // ตารางเก่าที่ไม่มีคอลัมน์เดือน → ALTER เพิ่ม
                await ensureMonthCols(conn, tableName);
                if (hasForm) await ensureDynamicCols(conn, tableName, formFields);

                // Fetch kpi_results for this indicator + year
                const [results] = await conn.query(
                    'SELECT hospcode, month_bh, target_value, actual_value FROM kpi_results WHERE indicator_id = ? AND year_bh = ?',
                    [indicator.id, year_bh]
                );
                // Build hospcode -> month data map
                // ⚠️ แปลง '' → null ทันที — ป้องกันบล็อก merge sub_results ภายหลัง (string '' ไม่ใช่ null/undefined)
                const dataMap = new Map();
                // Seed ด้วยขอบเขตหน่วยบริการของตัวชี้วัด (evaluation_mode/required_off_types) ก่อน — ให้ทุกหน่วยบริการ
                // ในขอบเขตมีแถวว่างรอไว้เสมอ แม้ยังไม่มีผลงานคีย์ไว้เลย (merge ด้านล่างจะเติมค่าจริงทับให้ภายหลัง)
                for (const hc of scopeHospcodes) dataMap.set(hc, {});
                for (const row of results) {
                    const hc = row.hospcode != null ? String(row.hospcode).trim() : '';
                    if (!hc) continue;
                    if (!dataMap.has(hc)) dataMap.set(hc, {});
                    const entry = dataMap.get(hc);
                    const mKey = 'm' + String(row.month_bh).padStart(2, '0');
                    const actualVal = row.actual_value;
                    entry[mKey] = (actualVal != null && actualVal !== '') ? String(actualVal) : null;
                    if (normalizeTargetMonthly(indicator.target_monthly)) (entry._mt = entry._mt || {})[mKey] = row.target_value; // เป้าหมายรายเดือน
                    if (String(row.month_bh) === '10') {
                        const targetVal = row.target_value;
                        entry.target = (targetVal != null && targetVal !== '') ? String(targetVal) : null;
                    }
                }

                // === เพิ่ม: ดึงค่า AVG จาก kpi_sub_results มาเติม (กรณีที่ตัวชี้วัดมีตัวชี้วัดย่อย) ===
                // หลักการเดียวกับ /sub-results/summary — AVG actual_value ของ sub แต่ละเดือน + AVG target ของเดือน 10
                // ถ้า kpi_results มีค่าอยู่แล้ว → ไม่ override (kpi_results มี priority สูงกว่า)
                try {
                    const subAgg = (await loadSubAggregates(conn, { indicatorId: indicator.id, yearBh: year_bh })).filter(r => r.sub_rollup_mode !== 'manual'); // หลักแบบกรอกเอง = ไม่นำค่าข้อย่อยมาเติม

                    const fmtNum = (v) => {
                        if (v === null || v === undefined) return null;
                        const n = parseFloat(v);
                        if (isNaN(n)) return null;
                        // จำนวนเต็มไม่มีทศนิยม / มีเศษ 2 ตำแหน่ง — ตรงกับ formatNum() ที่ frontend ใช้
                        return Number.isInteger(n) ? String(n) : n.toFixed(2);
                    };

                    for (const subRow of subAgg) {
                        const hc = subRow.hospcode != null ? String(subRow.hospcode).trim() : '';
                        if (!hc) continue;
                        if (!dataMap.has(hc)) dataMap.set(hc, {});
                        const entry = dataMap.get(hc);
                        // เติม monthly values เฉพาะที่ kpi_results ยังไม่มีข้อมูล (รวมกรณี '' ด้วย)
                        for (const m of ['m10','m11','m12','m01','m02','m03','m04','m05','m06','m07','m08','m09']) {
                            const cur = entry[m];
                            if ((cur === undefined || cur === null || cur === '') && subRow[m] !== null && subRow[m] !== undefined) {
                                entry[m] = fmtNum(subRow[m]);
                            }
                        }
                        // เติม target ถ้ายังไม่มี (รวมกรณี '' ด้วย)
                        const curTgt = entry.target;
                        if ((curTgt === undefined || curTgt === null || curTgt === '') && subRow.avg_target !== null && subRow.avg_target !== undefined) {
                            entry.target = fmtNum(subRow.avg_target);
                        }
                    }
                } catch (e) {
                    console.error(`⚠️ [Export] อ่าน kpi_sub_results ของ indicator_id=${indicator.id} ล้มเหลว:`, e.message);
                }

                // ดึง dynamic form data (ถ้ามี) → merge เข้า dataMap
                // ORDER BY month_bh ASC → ค่าจากเดือนล่าสุดจะ overwrite ค่าก่อนหน้า (latest wins)
                if (dynamicTableName && formFields.length > 0) {
                    const dynFieldNames = formFields.map(f => `\`${f.field_name}\``).join(', ');
                    try {
                        // ตรวจว่ามีคอลัมน์ month_bh + indicator_id ไหม
                        const [colCheck] = await conn.query(
                            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN ('month_bh','indicator_id')",
                            [dynamicTableName]
                        );
                        const presentCols = colCheck.map(c => c.COLUMN_NAME || c.column_name);
                        const hasMonth = presentCols.includes('month_bh');
                        const hasIndId = presentCols.includes('indicator_id');
                        const orderClause = hasMonth ? 'ORDER BY hospcode, month_bh ASC' : '';
                        const monthSelect = hasMonth ? ', month_bh' : '';
                        // indicator_id filter — รับ NULL ด้วย (กรณี dynamic-data save ไม่ส่ง indicator_id)
                        // ถ้าตารางไม่มี indicator_id column ก็ไม่ filter เลย (ถือว่าเป็นข้อมูลของ indicator นี้ทั้งหมด)
                        const indFilter = hasIndId ? 'AND (indicator_id = ? OR indicator_id IS NULL)' : '';
                        const params = hasIndId ? [year_bh, indicator.id] : [year_bh];
                        const sql = `SELECT hospcode${monthSelect}, ${dynFieldNames} FROM \`${dynamicTableName}\` WHERE year_bh = ? ${indFilter} ${orderClause}`;
                        const [dynRows] = await conn.query(sql, params);
                        for (const row of dynRows) {
                            const hc = row.hospcode != null ? String(row.hospcode).trim() : '';
                            if (!hc) continue;
                            if (!dataMap.has(hc)) dataMap.set(hc, {});
                            const entry = dataMap.get(hc);
                            for (const f of formFields) {
                                // ค่าล่าสุดต่อ hospcode (เดือนใหญ่สุด overwrite เพราะ ORDER BY ASC)
                                if (row[f.field_name] !== undefined && row[f.field_name] !== null && row[f.field_name] !== '') {
                                    entry['_dyn_' + f.field_name] = String(row[f.field_name]);
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`⚠️ [Export] ดึง dynamic data ของ ${dynamicTableName} ล้มเหลว:`, e.message);
                    }
                }

                // Build upsert rows
                const upsertRows = [];
                let updatedCount = 0;
                let insertedCount = 0;
                let unchangedCount = 0;
                const dynFieldKeys = formFields.map(f => f.field_name);

                // แปลง '' → null (MySQL reject empty string ถ้า column เป็น DECIMAL/INT)
                const emptyToNull = v => (v === '' || v === undefined) ? null : v;

                // ดึงข้อมูลเดิมจากตาราง export (เปรียบเทียบค่า ไม่ใช่เวลา) — content-based diff
                const existingDataMap = new Map();
                try {
                    const selectCols = ['hospcode', 'target', 'result', ...months, ...dynFieldKeys.map(k => `\`${k}\``)].join(', ');
                    const [existingRows] = await conn.query(
                        `SELECT ${selectCols} FROM \`${tableName}\` WHERE byear = ?`,
                        [year_bh]
                    );
                    for (const r of existingRows) existingDataMap.set(r.hospcode, r);
                } catch (e) { /* table เพิ่งสร้าง/ไม่มีคอลัมน์ครบ — ถือว่าไม่มี row เดิม */ }

                // ข้าม hospcode ที่ไม่มี "ผลงาน" จริง — ต้องมีเดือนใดเดือนหนึ่งที่ actual_value ไม่ว่าง
                // (ยอมรับ "0" เป็นค่าที่ถูกต้อง — เช่น "0 ราย" ในตัวชี้วัดผลข้างเคียง)
                // หรือมี dynamic form data (กรณีตัวชี้วัดใช้ฟอร์ม) — target อย่างเดียวไม่พอ
                const hasActualData = (d) => {
                    for (const m of months) {
                        const v = d[m];
                        if (v !== null && v !== undefined && v !== '') return true;
                    }
                    for (const k of dynFieldKeys) {
                        const v = d['_dyn_' + k];
                        if (v !== null && v !== undefined && v !== '') return true;
                    }
                    return false;
                };

                // เปรียบเทียบค่า 2 ตัว ยอมให้ null/'' ถือว่าเท่ากัน + ตัวเลขเทียบแบบ numeric
                const sameValue = (a, b) => {
                    const na = a === null || a === undefined || a === '' ? null : a;
                    const nb = b === null || b === undefined || b === '' ? null : b;
                    if (na === null && nb === null) return true;
                    if (na === null || nb === null) return false;
                    // ลอง numeric compare ก่อน (กัน "80" vs 80 vs "80.00")
                    const fa = parseFloat(na), fb = parseFloat(nb);
                    if (!isNaN(fa) && !isNaN(fb)) return fa === fb;
                    return String(na) === String(nb);
                };

                let noDataCount = 0;
                // สูตรอ้างข้อมูลปีงบที่แล้ว → โหลดครั้งเดียวต่อตัวชี้วัด (⚠️ ต้องตรงกับ checkKpiChanges)
                const _f = kpiFormula.activeFormula(indicator);
                const prevMap = formulaOk(indicator, _f) && kpiFormula.usesPrevYear(_f)
                    ? await loadPrevYearData(db, [indicator.id], year_bh) : null;
                const baseMapX = formulaOk(indicator, _f) && kpiFormula.formulaVarNames(_f).length ? await loadBaseValues(db, [indicator.id], [year_bh]) : null; // ค่าฐาน/ค่าเพิ่มเติม
                // ผลงานล่าสุดแบบกรอกเอง (29 ต.ค. 2569) — ใช้ค่าที่กรอกแทนการคำนวณ (⚠️ ต้องตรงกันทั้ง checkKpiChanges และ performKpiExport)
                const manualMapX = isManualResult(indicator) ? await loadManualValues(db, [indicator.id], [year_bh]) : null;

                for (const [hc, d] of dataMap) {
                    // ไม่ข้ามแถวที่ยังไม่มีผลงานแล้ว (ต้อง export ครบทุกหน่วยบริการในขอบเขต) — นับไว้รายงานเฉยๆ
                    if (!hasActualData(d)) noDataCount++;

                    const target = exportTargetOf(indicator, d, months);
                    const dynValues = dynFieldKeys.map(k => emptyToNull(d['_dyn_' + k]));
                    const monthValues = months.map(m => emptyToNull(d[m]));
                    // result: มีสูตร → ตามสูตร, ตัวชี้วัดสะสม → รวมทุกเดือน, ปกติ → ค่าล่าสุดที่คีย์ (เดือนท้ายสุดตามปีงบ: ก.ย.→ต.ค.)
                    // ⚠️ ต้องตรงกับ checkKpiChanges เสมอ
                    let resultVal;
                    const formula = kpiFormula.activeFormula(indicator);
                    if (formulaOk(indicator, formula)) {
                        resultVal = kpiFormula.evaluateFormula(formula, d, target, prevMap ? prevMap.get(`${indicator.id}|${String(hc).trim()}`) : undefined, baseMapX ? (baseMapX.get(baseKey(indicator.id, year_bh, hc)) || {}) : undefined);
                    } else if (Number(indicator.is_cumulative) === 1) {
                        const numericVals = monthValues.filter(v => v !== null && v !== undefined && !isNaN(parseFloat(v)));
                        resultVal = numericVals.length > 0 ? numericVals.reduce((s, v) => s + parseFloat(v), 0) : null;
                    } else {
                        const reverseMonths = [...monthValues].reverse();
                        const lastActual = reverseMonths.find(v => v !== null && v !== undefined);
                        resultVal = lastActual !== undefined ? lastActual : null;
                    }
                    if (manualMapX) resultVal = emptyToNull((manualMapX.get(manualKey(indicator.id, year_bh, hc)) || {}).result);

                    // เปรียบเทียบค่าเดิม vs ใหม่ ทีละคอลัมน์
                    const existing = existingDataMap.get(hc);
                    if (existing) {
                        const changed =
                            !sameValue(existing.target, target) ||
                            !sameValue(existing.result, resultVal) ||
                            months.some((m, idx) => !sameValue(existing[m], monthValues[idx])) ||
                            dynFieldKeys.some((k, idx) => !sameValue(existing[k], dynValues[idx]));
                        if (!changed) { unchangedCount++; continue; }
                        updatedCount++;
                    } else {
                        insertedCount++;
                    }

                    upsertRows.push([hc, year_bh, target, resultVal, ...monthValues, ...dynValues]);
                }

                // Batch UPSERT
                if (upsertRows.length > 0) {
                    const colsList = ['hospcode', 'byear', 'target', 'result', ...months, ...dynFieldKeys.map(k => `\`${k}\``)];
                    const onDupParts = ['target=VALUES(target)', 'result=VALUES(result)', ...months.map(m => `${m}=VALUES(${m})`), ...dynFieldKeys.map(k => `\`${k}\`=VALUES(\`${k}\`)`)];
                    const cols = colsList.join(', ');
                    const onDup = onDupParts.join(', ');
                    const singlePlaceholder = '(' + Array(colsList.length).fill('?').join(',') + ')';

                    for (let i = 0; i < upsertRows.length; i += 100) {
                        const batch = upsertRows.slice(i, i + 100);
                        const placeholders = batch.map(() => singlePlaceholder).join(',');
                        const flatValues = batch.flat();
                        await conn.query(`INSERT INTO \`${tableName}\` (${cols}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE ${onDup}`, flatValues);
                    }
                }

                const itemsStat = itemsTable ? await writeItemsTable(conn, indicator, year_bh, itemsTable) : itemsSkip;
                await conn.commit();
                created.push({
                    table: tableName,
                    name: indicator.kpi_indicators_name,
                    total_hospcode: dataMap.size,
                    inserted: insertedCount,
                    updated: updatedCount,
                    unchanged: unchangedCount,
                    no_data: noDataCount,
                    ...(itemsStat ? { items: itemsStat } : {})
                });
            } catch (tableErr) {
                await conn.rollback();
                skipped.push({ id: indicator.id, name: indicator.kpi_indicators_name, table_process: indicator.table_process, reason: tableErr.message });
            }
        }

        conn.release();

        // Log action
        try {
            await db.query(
                'INSERT INTO system_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
                [userId || null, 'export_kpi_tables', `Export ${created.length} tables for year ${year_bh}`, 'scheduler']
            );
        } catch (_) {}

        const totalInserted = created.reduce((s, t) => s + t.inserted, 0);
        const totalUpdated = created.reduce((s, t) => s + t.updated, 0);
        const totalUnchanged = created.reduce((s, t) => s + t.unchanged, 0);
        const totalNoData = created.reduce((s, t) => s + (t.no_data || 0), 0);

        return {
            success: true,
            message: `สร้าง/อัปเดตตารางสำเร็จ ${created.length} ตาราง`,
            created_tables: created,
            skipped,
            summary: { inserted: totalInserted, updated: totalUpdated, unchanged: totalUnchanged, no_data: totalNoData }
        };
    } catch (err) {
        try { conn.release(); } catch(_) {}
        return { success: false, message: err.message };
    }
}

module.exports = { ITEM_MONTHS, ITEM_DATA_COLS, itemsTableName, itemNull, itemSame, itemResult, ensureItemsTable, buildItemExportRows, diffItemsTable, writeItemsTable, checkKpiChanges, sanitizeSubIndicatorColName, performKpiExport };
