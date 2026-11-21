/**
 * ส่งข้อมูลเข้า KHD อย่างปลอดภัยและเบา + ประวัติ/ย้อนกลับ + ส่งขั้นเดียว (ระยะ 3 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 *
 * หลักการ (ไม่กระทบ KHD):
 *   - ไม่มี DDL / DELETE ใน KHD — กติกาการวางแผนคงเดิมทุกข้อ (planKhdTableSync: คีย์ hospcode+byear, ใหม่กว่าชนะ, ค่าว่างไม่ทับ)
 *   - ครั้งละงานเดียวทั้งระบบ (withKhdSyncLock: ตัวแปรใน process + GET_LOCK ของฐานเรา) ชนกัน = KHD_SYNC_BUSY
 *   - เขียนเป็นชุด (khd_sync_batch_size) พักระหว่างชุด (khd_sync_pause_ms), เพดานแถว/เวลาต่อรอบ (เกิน = partial รอบหน้าทำต่อ),
 *     timeout ต่อคำสั่งฝั่ง KHD (khd_query_timeout_ms)
 *   - ทุกช่องที่เขียนบันทึกค่าก่อน-หลังใน khd_sync_audit (ก่อนเขียนจริง) → ย้อนกลับได้เฉพาะช่องที่ KHD ยังเป็นค่าที่เราเขียน
 *     และเวลาเป็นเวลาที่เราตั้ง (มีผู้แก้ต่อ = ข้าม) — แถวที่เพิ่มใหม่ไม่ลบ (รายงานเท่านั้น)
 */
const crypto = require('crypto');
const db = require('../db');
const { getRemotePool } = require('../db-remote');
const khd = require('./khd');
const { getKhdSyncSettings } = require('./khd-policy');

const LOCK_NAME = 'khupskpi_khd_sync';
const AUDIT_CHUNK = 500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- ค่า → ข้อความสำหรับบันทึก (Date = เวลาท้องถิ่นแบบ MySQL) ----------
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function valText(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : fmtDate(v);
    if (Buffer.isBuffer(v)) return v.toString('utf8');
    return String(v);
}

// ---------- ล็อค: ครั้งละงานเดียว ----------
let _busy = null;
function busyError(info) {
    const e = new Error('มีงานส่งข้อมูลเข้า KHD กำลังทำงานอยู่ กรุณารอให้เสร็จก่อน');
    e.code = 'KHD_SYNC_BUSY';
    e.busy = info || null;
    return e;
}
function khdSyncBusyInfo() { return _busy ? { ..._busy } : null; }

async function withKhdSyncLock(meta, fn) {
    if (_busy) throw busyError(_busy);
    _busy = { trigger: meta && meta.trigger, user_id: meta && meta.userId, started_at: new Date() };
    let conn = null;
    try {
        conn = await db.getConnection();
        const [[r]] = await conn.query('SELECT GET_LOCK(?, 0) AS ok', [LOCK_NAME]);
        if (Number(r && r.ok) !== 1) throw busyError(null); // อีก process (เช่น container อื่น) ถือล็อคอยู่
        try {
            return await fn();
        } finally {
            await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
        }
    } finally {
        if (conn) conn.release();
        _busy = null;
    }
}

// คำสั่งฝั่ง KHD พร้อมเพดานเวลา (ไม่ให้งานค้างเมื่อ KHD ช้า/ค้าง)
function timedRemote(remoteDb, ms) {
    return {
        query(sql, params) {
            let t;
            const timer = new Promise((_, rej) => {
                t = setTimeout(() => rej(Object.assign(new Error(`KHD ไม่ตอบสนองภายใน ${Math.round(ms / 1000)} วินาที`), { code: 'KHD_TIMEOUT' })), ms);
            });
            return Promise.race([remoteDb.query(sql, params), timer]).finally(() => clearTimeout(t));
        },
    };
}

// ---------- รอบการส่ง ----------
async function createRun({ trigger, userId, yearBh, policy, rollbackOf }) {
    const [r] = await db.query(
        'INSERT INTO khd_sync_runs (trigger_type, user_id, year_bh, policy, status, rollback_of) VALUES (?, ?, ?, ?, ?, ?)',
        [trigger || 'manual', userId || null, yearBh || null, policy || null, 'running', rollbackOf || null]);
    return r.insertId;
}
async function finishRun(runId, fields) {
    const sets = Object.keys(fields).map(k => `\`${k}\` = ?`);
    await db.query(`UPDATE khd_sync_runs SET ${sets.join(', ')}, finished_at = NOW(), duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW()) DIV 1000 WHERE id = ?`,
        [...Object.values(fields), runId]);
}
async function cleanupOldAudit(keepDays) {
    try {
        await db.query(
            `DELETE a FROM khd_sync_audit a JOIN khd_sync_runs r ON r.id = a.run_id WHERE r.started_at < NOW() - INTERVAL ? DAY`, [keepDays]);
    } catch (_) { /* ไม่ให้การล้างบันทึกเก่าทำให้การส่งล้ม */ }
}
async function insertAudit(rows) {
    const cols = ['run_id', 'table_name', 'hospcode', 'byear', 'op', 'col_name', 'before_value', 'after_value', 'ts_col', 'before_ts', 'after_ts', 'applied'];
    for (let i = 0; i < rows.length; i += AUDIT_CHUNK) {
        const chunk = rows.slice(i, i + AUDIT_CHUNK);
        await db.query(`INSERT INTO khd_sync_audit (${cols.join(', ')}) VALUES ?`, [chunk.map(r => cols.map(c => (r[c] === undefined ? null : r[c])))]);
    }
}
async function saveTableStatus(tp, runId, res, watermark) {
    const ok = res.status === 'success';
    let wmJson = null;
    if (ok && watermark && Object.keys(watermark).length) {
        const [[cur]] = await db.query('SELECT synced_watermark FROM khd_table_sync_status WHERE table_name = ?', [tp]);
        let prev = {};
        try { prev = cur && cur.synced_watermark ? JSON.parse(cur.synced_watermark) : {}; } catch (_) { prev = {}; }
        wmJson = JSON.stringify({ ...prev, ...watermark });
    }
    await db.query(
        `INSERT INTO khd_table_sync_status (table_name, last_run_id, last_attempt_at, last_success_at, last_status, last_inserted, last_updated, last_error, synced_watermark)
         VALUES (?, ?, NOW(), ${ok ? 'NOW()' : 'NULL'}, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE last_run_id = VALUES(last_run_id), last_attempt_at = NOW(),
           last_success_at = ${ok ? 'NOW()' : 'last_success_at'}, last_status = VALUES(last_status),
           last_inserted = VALUES(last_inserted), last_updated = VALUES(last_updated), last_error = VALUES(last_error),
           synced_watermark = ${wmJson ? 'VALUES(synced_watermark)' : 'synced_watermark'}`,
        [tp, runId, res.status, res.inserted || 0, res.updated || 0, res.status === 'error' ? String(res.reason || '').slice(0, 1000) : null, wmJson]);
}

/**
 * เขียนตามแผน 1 ตารางพร้อมบันทึกค่าก่อน-หลัง — ctx = { runId, cfg, budget: { rows, deadline } }
 * คืน { inserted, updated, cells, partial }
 */
async function applyAudited(remote, tp, plan, ctx) {
    const { runId, cfg, budget } = ctx;
    const size = cfg.khd_sync_batch_size;
    const ts = plan.remoteTs;
    const insCols = plan.cols.concat(plan.hasTs ? [ts] : []);
    const valOf = (row, c) => (plan.hasTs && c === ts ? row.update_date : (row[c] === undefined ? null : row[c]));
    const colList = insCols.map(c => `\`${c}\``).join(', ');
    let inserted = 0, updated = 0, cells = 0, partial = false;
    const overBudget = () => budget.rows >= cfg.khd_sync_max_rows || Date.now() > budget.deadline;

    for (let i = 0; i < plan.inserts.length; i += size) {
        if (overBudget()) { partial = true; break; }
        const batch = plan.inserts.slice(i, i + size);
        const [r] = await remote.query(
            `INSERT INTO \`${tp}\` (${colList}) VALUES ${batch.map(() => `(${insCols.map(() => '?').join(', ')})`).join(', ')}
             ON DUPLICATE KEY UPDATE \`hospcode\` = \`hospcode\``,
            batch.flatMap(row => insCols.map(c => valOf(row, c))));
        const n = r.affectedRows || 0;
        inserted += n; budget.rows += batch.length;
        // แถวที่เพิ่ม: เก็บค่าที่เขียน (JSON) — ย้อนกลับไม่ลบแถว รายงานเท่านั้น
        await insertAudit(batch.map(row => ({
            run_id: runId, table_name: tp, hospcode: String(row.hospcode).trim(), byear: String(row.byear).trim(), op: 'insert',
            after_value: JSON.stringify(Object.fromEntries(insCols.map(c => [c, valText(valOf(row, c))]))),
            ts_col: plan.hasTs ? ts : null, after_ts: plan.hasTs ? valText(row.update_date) : null, applied: 1,
        })));
        if (cfg.khd_sync_pause_ms) await sleep(cfg.khd_sync_pause_ms);
    }

    for (let i = 0; !partial && i < plan.updates.length; i += size) {
        if (overBudget()) { partial = true; break; }
        const batch = plan.updates.slice(i, i + size);
        // บันทึกค่าก่อน-หลังก่อนเขียนจริง (applied = 0 → 1 เมื่อ KHD รับการแก้ไข)
        await insertAudit(batch.flatMap(u => u.cols.map(c => ({
            run_id: runId, table_name: tp, hospcode: String(u.row.hospcode).trim(), byear: String(u.row.byear).trim(), op: 'update',
            col_name: c, before_value: valText(u.before ? u.before[c] : null), after_value: valText(u.row[c]),
            ts_col: ts, before_ts: valText(u.before ? u.before[ts] : null), after_ts: valText(u.row.update_date), applied: 0,
        }))));
        const done = [];
        for (const u of batch) {
            const tcol = `\`${ts}\``;
            const sets = u.cols.map(c => `\`${c}\` = ?`).concat(`${tcol} = ?`).join(', ');
            const [r] = await remote.query(
                `UPDATE \`${tp}\` SET ${sets} WHERE \`hospcode\` = ? AND \`byear\` = ? AND (${tcol} IS NULL OR ${tcol} < ?)`,
                [...u.cols.map(c => u.row[c]), u.row.update_date, u.row.hospcode, u.row.byear, u.row.update_date]);
            budget.rows++;
            if (r.affectedRows) { updated++; cells += u.cols.length; done.push(`${String(u.row.hospcode).trim()}|${String(u.row.byear).trim()}`); }
        }
        if (done.length) {
            await db.query(
                `UPDATE khd_sync_audit SET applied = 1 WHERE run_id = ? AND table_name = ? AND op = 'update' AND CONCAT(hospcode, '|', byear) IN (?)`,
                [runId, tp, done]);
        }
        if (cfg.khd_sync_pause_ms) await sleep(cfg.khd_sync_pause_ms);
    }
    return { inserted, updated, cells, partial };
}

/**
 * ส่งตาราง export เข้า KHD (ตัวหลักของ performSyncToKhd) — tables = [{ table, sync_columns? }]
 * opts = { trigger, yearBh, plans?: Map(table → plan ที่วางไว้แล้ว — ส่งขั้นเดียว), policy?, lockHeld? }
 */
async function runKhdSync(tables, userId, opts = {}) {
    const remoteDb = getRemotePool();
    if (!remoteDb) return { success: false, message: 'ไม่ได้ตั้งค่า Remote DB (KHD)', results: [] };
    if (!Array.isArray(tables) || tables.length === 0) return { success: false, message: 'ไม่มีตารางที่จะ sync', results: [] };
    const work = () => runKhdSyncLocked(remoteDb, tables, userId, opts);
    if (opts.lockHeld) return work();
    try {
        return await withKhdSyncLock({ trigger: opts.trigger || 'manual', userId }, work);
    } catch (e) {
        if (e.code === 'KHD_SYNC_BUSY') return { success: false, code: e.code, message: e.message, busy: e.busy, results: [] };
        throw e;
    }
}

async function runKhdSyncLocked(remoteDb, tables, userId, opts) {
    const cfg = await getKhdSyncSettings();
    const remote = timedRemote(remoteDb, cfg.khd_query_timeout_ms);
    await cleanupOldAudit(cfg.khd_sync_audit_keep_days);
    const runId = await createRun({ trigger: opts.trigger, userId, yearBh: opts.yearBh, policy: opts.policy || cfg.khd_send_policy });
    const budget = { rows: 0, deadline: Date.now() + cfg.khd_sync_max_seconds * 1000 };
    const results = [];
    let stopped = false;
    try {
        const allowed = await khd.khdExportableTables(tables.map(t => t && t.table).filter(n => typeof n === 'string' && khd.KHD_IDENT.test(n)));
        for (const t of tables) {
            const tp = t && t.table;
            if (typeof tp !== 'string' || !khd.KHD_IDENT.test(tp)) { results.push({ table: tp, status: 'skipped', reason: 'ชื่อตารางไม่ถูกต้อง' }); continue; }
            if (!allowed.has(tp)) { results.push({ table: tp, status: 'skipped', reason: 'ไม่ใช่ตารางของตัวชี้วัดที่เปิดส่งออก KHD' }); continue; }
            if (stopped) { results.push({ table: tp, status: 'skipped', deferred: true, reason: 'ครบเพดานต่อรอบ — รอบถัดไปส่งต่อ' }); continue; }
            let res;
            try {
                const plan = (opts.plans && opts.plans.get(tp)) || await khd.planKhdTableSync(remote, tp, t.sync_columns, { byear: opts.yearBh });
                if (plan.skip) { results.push({ table: tp, status: 'skipped', reason: plan.skip }); continue; }
                if (plan.counts.local_rows === 0) { results.push({ table: tp, status: 'skipped', reason: 'ไม่มีข้อมูลใน local', rows: 0 }); continue; }
                const out = await applyAudited(remote, tp, plan, { runId, cfg, budget });
                res = { table: tp, status: out.partial ? 'partial' : 'success', rows: out.inserted + out.updated, inserted: out.inserted, updated: out.updated, cells: out.cells, ...plan.counts };
                if (out.partial) stopped = true;
                await saveTableStatus(tp, runId, res, plan.watermark);
            } catch (e) {
                res = { table: tp, status: 'error', reason: e.message };
                await saveTableStatus(tp, runId, res, null).catch(() => {});
            }
            results.push(res);
        }
    } catch (e) {
        await finishRun(runId, { status: 'failed', error_msg: e.message }).catch(() => {});
        throw e;
    }

    const ok = results.filter(r => r.status === 'success' || r.status === 'partial');
    const errorCount = results.filter(r => r.status === 'error').length;
    const totalRows = ok.reduce((s, r) => s + (r.rows || 0), 0);
    const summary = {
        total: results.length, success: ok.length, error: errorCount, skipped: results.length - ok.length - errorCount, rows: totalRows,
        inserted: ok.reduce((s, r) => s + (r.inserted || 0), 0), updated: ok.reduce((s, r) => s + (r.updated || 0), 0),
        cells: ok.reduce((s, r) => s + (r.cells || 0), 0), partial: stopped,
    };
    const status = errorCount && !ok.length ? 'failed' : (stopped || errorCount ? 'partial' : 'success');
    await finishRun(runId, {
        status, tables_total: summary.total, tables_success: summary.success, tables_skipped: summary.skipped, tables_error: errorCount,
        rows_inserted: summary.inserted, rows_updated: summary.updated, cells_updated: summary.cells,
        summary_json: JSON.stringify(results.slice(0, 300)),
        error_msg: errorCount ? results.filter(r => r.status === 'error').slice(0, 5).map(r => `${r.table}: ${r.reason}`).join(' | ') : null,
    });
    try {
        await db.query(
            'INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
            [userId || null, 'SYNC_TO_KHD', 'multiple', JSON.stringify({ run_id: runId, trigger: opts.trigger || 'manual', tables: results.length, success: ok.length, rows: totalRows }), null]);
    } catch (_) {}
    return {
        success: errorCount === 0,
        run_id: runId,
        status,
        message: `ส่งข้อมูลสำเร็จ ${ok.length}/${results.length} ตาราง (${totalRows} rows)` + (stopped ? ' — ครบเพดานต่อรอบ ส่วนที่เหลือส่งในรอบถัดไป' : ''),
        results,
        summary,
    };
}

// ---------- ย้อนกลับรอบการส่ง ----------
function httpError(status, code, message, extra) {
    return Object.assign(new Error(message), { status, code, extra });
}

/** ย้อนกลับรอบ runId — ได้เฉพาะรอบล่าสุดของทุกตารางที่รอบนั้นแตะ, คืนเฉพาะช่องที่ KHD ยังเป็นค่าที่เราเขียน */
async function rollbackRun(runId, userId) {
    const remoteDb = getRemotePool();
    if (!remoteDb) throw httpError(400, 'NO_REMOTE', 'ไม่ได้ตั้งค่า Remote DB (KHD)');
    return withKhdSyncLock({ trigger: 'rollback', userId }, async () => {
        const [[run]] = await db.query('SELECT * FROM khd_sync_runs WHERE id = ?', [runId]);
        if (!run) throw httpError(404, 'NOT_FOUND', 'ไม่พบรอบการส่ง');
        if (run.trigger_type === 'rollback') throw httpError(409, 'IS_ROLLBACK', 'รอบนี้เป็นการย้อนกลับ ย้อนกลับซ้ำไม่ได้');
        if (!['success', 'partial'].includes(run.status)) throw httpError(409, 'NOT_REVERTIBLE', `รอบนี้ย้อนกลับไม่ได้ (สถานะ ${run.status})`);
        const [tablesRows] = await db.query('SELECT DISTINCT table_name FROM khd_sync_audit WHERE run_id = ?', [runId]);
        const touched = tablesRows.map(r => r.table_name);
        if (!touched.length) throw httpError(409, 'NOTHING', 'รอบนี้ไม่ได้เขียนข้อมูลลง KHD (หรือบันทึกถูกล้างตามอายุแล้ว)');
        const [later] = await db.query(
            `SELECT DISTINCT a.table_name, a.run_id FROM khd_sync_audit a JOIN khd_sync_runs r ON r.id = a.run_id
             WHERE a.table_name IN (?) AND a.run_id > ? AND r.trigger_type <> 'rollback'`, [touched, runId]);
        if (later.length) {
            throw httpError(409, 'NOT_LATEST', 'มีการส่งรอบหลังที่แตะตารางเดียวกัน — ย้อนกลับได้เฉพาะรอบล่าสุดของทุกตาราง',
                { later: later.slice(0, 20) });
        }
        const cfg = await getKhdSyncSettings();
        const remote = timedRemote(remoteDb, cfg.khd_query_timeout_ms);
        const rbId = await createRun({ trigger: 'rollback', userId, yearBh: run.year_bh, policy: run.policy, rollbackOf: runId });
        const stats = { reverted_rows: 0, reverted_cells: 0, skipped_changed: 0, kept_inserts: 0, errors: 0 };
        const perTable = [];
        for (const tp of touched) {
            const t = { table: tp, reverted_rows: 0, skipped_changed: 0, kept_inserts: 0 };
            const [[ins]] = await db.query("SELECT COUNT(*) AS n FROM khd_sync_audit WHERE run_id = ? AND table_name = ? AND op = 'insert'", [runId, tp]);
            t.kept_inserts = Number(ins.n) || 0;
            if (t.kept_inserts) await db.query("UPDATE khd_sync_audit SET revert_status = 'kept_insert' WHERE run_id = ? AND table_name = ? AND op = 'insert'", [runId, tp]);
            const [ups] = await db.query("SELECT * FROM khd_sync_audit WHERE run_id = ? AND table_name = ? AND op = 'update' ORDER BY id", [runId, tp]);
            // จัดกลุ่มรายแถว (hospcode|byear)
            const byRow = new Map();
            for (const a of ups) {
                const k = `${a.hospcode}|${a.byear}`;
                if (!byRow.has(k)) byRow.set(k, { hospcode: a.hospcode, byear: a.byear, ts: a.ts_col, items: [] });
                byRow.get(k).items.push(a);
            }
            const rows = [...byRow.values()];
            const tsCol = rows.length ? rows[0].ts : null;
            const cols = [...new Set(ups.map(a => a.col_name))].filter(c => khd.KHD_IDENT.test(c));
            if (!tsCol || !khd.KHD_IDENT.test(tsCol)) { perTable.push(t); continue; }
            // อ่านค่าปัจจุบันใน KHD ทีละปีงบ ทีละชุดหน่วยบริการ
            const current = new Map();
            const years = [...new Set(rows.map(r => r.byear))];
            for (const y of years) {
                const hcs = rows.filter(r => r.byear === y).map(r => r.hospcode);
                for (let i = 0; i < hcs.length; i += 500) {
                    const [cur] = await remote.query(
                        `SELECT \`hospcode\`, \`byear\`, ${cols.map(c => `\`${c}\``).join(', ')}, \`${tsCol}\` FROM \`${tp}\` WHERE \`byear\` = ? AND \`hospcode\` IN (?)`,
                        [y, hcs.slice(i, i + 500)]);
                    for (const c of cur) current.set(khd.khdRowKey(c), c);
                }
            }
            for (const row of rows) {
                const cur = current.get(`${row.hospcode}|${row.byear}`);
                const afterTs = row.items[0].after_ts;
                const stillOurs = cur
                    && khd.timeOf(cur[tsCol]) !== null && khd.timeOf(cur[tsCol]) === khd.timeOf(afterTs)
                    && row.items.every(a => khd.sameKhdVal(cur[a.col_name], a.after_value));
                const ids = row.items.map(a => a.id);
                if (!stillOurs) {
                    t.skipped_changed++;
                    await db.query("UPDATE khd_sync_audit SET revert_status = 'skipped_changed' WHERE id IN (?)", [ids]);
                    continue;
                }
                try {
                    const sets = row.items.map(a => `\`${a.col_name}\` = ?`).concat(`\`${tsCol}\` = ?`).join(', ');
                    const [r] = await remote.query(
                        `UPDATE \`${tp}\` SET ${sets} WHERE \`hospcode\` = ? AND \`byear\` = ? AND \`${tsCol}\` = ?`,
                        [...row.items.map(a => a.before_value), row.items[0].before_ts, row.hospcode, row.byear, cur[tsCol]]);
                    if (r.affectedRows) {
                        t.reverted_rows++; stats.reverted_cells += row.items.length;
                        await db.query("UPDATE khd_sync_audit SET revert_status = 'reverted' WHERE id IN (?)", [ids]);
                    } else {
                        t.skipped_changed++;
                        await db.query("UPDATE khd_sync_audit SET revert_status = 'skipped_changed' WHERE id IN (?)", [ids]);
                    }
                } catch (e) {
                    stats.errors++;
                    t.error = e.message;
                }
                if (cfg.khd_sync_pause_ms && t.reverted_rows % cfg.khd_sync_batch_size === 0) await sleep(cfg.khd_sync_pause_ms);
            }
            // ตารางนี้ต้องวางแผนใหม่ในรอบถัดไป (ไม่ข้ามด้วยจุดอ้างอิงเดิม)
            await db.query('UPDATE khd_table_sync_status SET synced_watermark = NULL WHERE table_name = ?', [tp]).catch(() => {});
            stats.reverted_rows += t.reverted_rows; stats.skipped_changed += t.skipped_changed; stats.kept_inserts += t.kept_inserts;
            perTable.push(t);
        }
        const full = stats.skipped_changed === 0 && stats.errors === 0;
        await db.query('UPDATE khd_sync_runs SET status = ?, rolled_back_by = ?, rolled_back_at = NOW() WHERE id = ?',
            [full ? 'rolled_back' : 'partially_rolled_back', userId || null, runId]);
        await finishRun(rbId, {
            status: stats.errors ? 'partial' : 'success', tables_total: touched.length, tables_success: perTable.filter(t => !t.error).length,
            tables_error: perTable.filter(t => t.error).length, rows_updated: stats.reverted_rows, cells_updated: stats.reverted_cells,
            summary_json: JSON.stringify(perTable.slice(0, 300)),
        });
        try {
            await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?,?,?,?,?)',
                [userId || null, 'KHD_SYNC_ROLLBACK', 'khd_sync_runs', JSON.stringify({ run_id: runId, rollback_run_id: rbId, ...stats }), null]);
        } catch (_) {}
        return { run_id: runId, rollback_run_id: rbId, status: full ? 'rolled_back' : 'partially_rolled_back', ...stats, tables: perTable };
    });
}

// ---------- ส่งขั้นเดียว ----------
const _planTokens = new Map(); // token → { year, userId, at }
const PLAN_TOKEN_TTL = 10 * 60 * 1000;
function cleanupTokens() {
    const now = Date.now();
    for (const [k, v] of _planTokens) if (now - v.at > PLAN_TOKEN_TTL) _planTokens.delete(k);
}

/** ตารางที่ส่งได้ทั้งหมด (ตัวชี้วัดเปิดใช้งาน + เปิดส่งออก KHD) */
async function exportableTableNames() {
    const [rows] = await db.query(
        `SELECT DISTINCT TRIM(table_process) AS tp FROM kpi_indicators
         WHERE is_active = 1 AND (upload_excel IS NULL OR upload_excel = 0) AND table_process IS NOT NULL AND TRIM(table_process) <> ''`);
    return rows.map(r => r.tp).filter(t => khd.KHD_IDENT.test(t));
}

/** ตารางที่อาจมีสิ่งต้องส่งของปีงบ — update_date สูงสุดของ local ปีนั้นใหม่กว่าจุดที่ส่งครบล่าสุด (หรือยังไม่เคยส่งครบ) */
async function tablesNeedingSync(names, yearBh) {
    if (!names.length) return { need: [], upToDate: [], missing: [] };
    const [st] = await db.query('SELECT table_name, synced_watermark, last_status FROM khd_table_sync_status WHERE table_name IN (?)', [names]);
    const stMap = new Map(st.map(r => [r.table_name, r]));
    const need = [], upToDate = [], missing = [];
    for (const tp of names) {
        let maxTs;
        try {
            const [[m]] = await db.query(`SELECT MAX(update_date) AS t, COUNT(*) AS n FROM \`${tp}\` WHERE \`byear\` = ?`, [yearBh]);
            if (!m || Number(m.n) === 0) { missing.push(tp); continue; }
            maxTs = khd.timeOf(m.t);
        } catch (_) { missing.push(tp); continue; } // ยังไม่มีตาราง / ไม่มีคอลัมน์ update_date
        const s = stMap.get(tp);
        let wm = null;
        try { wm = s && s.synced_watermark ? JSON.parse(s.synced_watermark)[yearBh] : null; } catch (_) { wm = null; }
        if (s && s.last_status === 'success' && wm != null && maxTs !== null && maxTs <= wm) upToDate.push(tp);
        else need.push(tp);
    }
    return { need, upToDate, missing };
}

function planSignature(yearBh, plans) {
    const parts = [...plans.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([tp, p]) => {
        if (p.skip) return `${tp}:skip`;
        const ins = p.inserts.map(r => khd.khdRowKey(r)).sort().join(',');
        const ups = p.updates.map(u => `${khd.khdRowKey(u.row)}=${u.cols.map(c => `${c}:${valText(u.row[c])}`).join(';')}`).sort().join(',');
        return `${tp}|${ins}|${ups}`;
    });
    return crypto.createHash('sha256').update(`${yearBh}\n${parts.join('\n')}`).digest('hex').slice(0, 32);
}

/**
 * ส่งเข้า KHD ขั้นเดียว: เตรียมตารางส่งออกในระบบ (เฉพาะตัวชี้วัดที่เปลี่ยน — ไม่แตะ KHD) → วางแผนเฉพาะตารางที่อาจเปลี่ยน
 * dryRun = แสดงสิ่งที่จะส่ง + plan_token (10 นาที) | ส่งจริงต้องแนบ plan_token และแผนต้องตรงกับที่แสดง (เปลี่ยน = PLAN_CHANGED)
 */
async function quickSend({ yearBh, dryRun, planToken, userId, ip }) {
    if (!/^\d{4}$/.test(String(yearBh || ''))) throw httpError(400, 'BAD_YEAR', 'กรุณาระบุปีงบประมาณ 4 หลัก');
    const remoteDb = getRemotePool();
    if (!remoteDb) throw httpError(400, 'NO_REMOTE', 'ไม่ได้ตั้งค่า Remote DB (KHD)');
    cleanupTokens();
    if (!dryRun) {
        const tk = planToken && _planTokens.get(planToken);
        if (!tk || tk.year !== String(yearBh) || tk.userId !== userId) {
            throw httpError(409, 'PLAN_TOKEN_INVALID', 'ไม่พบผลตรวจสอบก่อนส่ง (หรือหมดอายุ 10 นาที) — กรุณาตรวจสอบสิ่งที่จะส่งใหม่');
        }
    }
    try {
        return await withKhdSyncLock({ trigger: 'quick', userId }, async () => {
            const cfg = await getKhdSyncSettings();
            const remote = timedRemote(remoteDb, cfg.khd_query_timeout_ms);
            const exp = require('./export');
            // 1) ตารางส่งออกในระบบให้เป็นปัจจุบัน (เฉพาะตัวชี้วัดที่ข้อมูลเปลี่ยน — ตามกติกาการส่งที่ตั้งไว้)
            const chk = await exp.checkKpiChanges(String(yearBh), 'all');
            if (!chk.success) throw httpError(500, 'CHECK_FAILED', chk.message || 'ตรวจการเปลี่ยนแปลงไม่สำเร็จ');
            const changedIds = (chk.details || []).filter(d => d.status === 'has_changes').map(d => d.id);
            let exportOut = null;
            if (changedIds.length) {
                exportOut = await exp.performKpiExport(String(yearBh), changedIds, userId, { ip: ip || null });
                if (!exportOut.success) throw httpError(500, 'EXPORT_FAILED', exportOut.message || 'เตรียมตารางส่งออกไม่สำเร็จ');
            }
            // 2) วางแผนเฉพาะตารางที่อาจมีสิ่งต้องส่ง
            const names = await exportableTableNames();
            const sel = await tablesNeedingSync(names, String(yearBh));
            const plans = new Map();
            const preview = [];
            for (const tp of sel.need) {
                let plan;
                try { plan = await khd.planKhdTableSync(remote, tp, null, { byear: String(yearBh) }); } catch (e) { plan = { skip: e.message }; }
                plans.set(tp, plan);
                if (plan.skip) preview.push({ table: tp, status: 'blocked', reason: plan.skip });
                else if (plan.inserts.length || plan.updates.length) preview.push({ table: tp, status: 'ready', ...plan.counts });
                else preview.push({ table: tp, status: 'nothing', ...plan.counts });
            }
            const sendable = preview.filter(p => p.status === 'ready');
            const totals = {
                tables_checked: sel.need.length, tables_up_to_date: sel.upToDate.length, tables_no_data: sel.missing.length,
                tables_to_send: sendable.length, tables_blocked: preview.filter(p => p.status === 'blocked').length,
                insert: sendable.reduce((s, p) => s + p.insert, 0), update: sendable.reduce((s, p) => s + p.update, 0),
                kept_blank: sendable.reduce((s, p) => s + p.kept_blank, 0), khd_newer: preview.reduce((s, p) => s + (p.khd_newer || 0), 0),
            };
            const signature = planSignature(String(yearBh), new Map([...plans].filter(([tp]) => sendable.some(p => p.table === tp))));
            const base = {
                year_bh: String(yearBh), policy: cfg.khd_send_policy,
                export: { indicators_changed: changedIds.length, ...(exportOut ? exportOut.summary : {}) },
                totals, tables: preview.filter(p => p.status !== 'nothing'),
            };
            if (dryRun) {
                const token = crypto.randomBytes(16).toString('hex');
                _planTokens.set(token, { year: String(yearBh), userId, at: Date.now(), signature });
                return { ...base, dry_run: true, plan_token: sendable.length ? token : null };
            }
            const tk = _planTokens.get(planToken);
            if (tk.signature !== signature) {
                const token = crypto.randomBytes(16).toString('hex');
                _planTokens.set(token, { year: String(yearBh), userId, at: Date.now(), signature });
                _planTokens.delete(planToken);
                throw httpError(409, 'PLAN_CHANGED', 'ข้อมูลเปลี่ยนไปหลังตรวจสอบ — กรุณาตรวจสิ่งที่จะส่งอีกครั้ง',
                    { preview: { ...base, dry_run: true, plan_token: sendable.length ? token : null } });
            }
            _planTokens.delete(planToken);
            // ตารางที่วางแผนแล้วไม่มีอะไรต้องส่ง = ถือว่าส่งครบ ณ ข้อมูลชุดนี้ (รอบหน้าข้ามจนกว่าข้อมูลในระบบจะเปลี่ยน)
            for (const p of preview) {
                if (p.status === 'nothing') await saveTableStatus(p.table, null, { status: 'success' }, plans.get(p.table).watermark).catch(() => {});
            }
            if (!sendable.length) return { ...base, dry_run: false, run_id: null, message: 'ไม่มีข้อมูลที่ต้องส่ง' };
            const out = await runKhdSync(sendable.map(p => ({ table: p.table })), userId,
                { trigger: 'quick', yearBh: String(yearBh), plans, policy: cfg.khd_send_policy, lockHeld: true });
            return { ...base, dry_run: false, ...out };
        });
    } catch (e) {
        if (e.code === 'KHD_SYNC_BUSY') throw httpError(409, e.code, e.message, { busy: e.busy });
        throw e;
    }
}

// ---------- อ่านประวัติ ----------
async function listRuns(limit = 50) {
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const [rows] = await db.query(
        `SELECT r.id, r.trigger_type, r.user_id, u.username, r.year_bh, r.policy, r.status, r.tables_total, r.tables_success, r.tables_skipped,
                r.tables_error, r.rows_inserted, r.rows_updated, r.cells_updated, r.error_msg, r.started_at, r.finished_at, r.duration_ms,
                r.rollback_of, r.rolled_back_by, r.rolled_back_at
         FROM khd_sync_runs r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?`, [n]);
    return rows;
}
async function getRun(runId) {
    const [[run]] = await db.query('SELECT * FROM khd_sync_runs WHERE id = ?', [runId]);
    if (!run) return null;
    let results = [];
    try { results = run.summary_json ? JSON.parse(run.summary_json) : []; } catch (_) { results = []; }
    delete run.summary_json;
    const [byTable] = await db.query(
        `SELECT table_name, SUM(op = 'insert') AS inserts, COUNT(DISTINCT CASE WHEN op = 'update' THEN CONCAT(hospcode, '|', byear) END) AS updated_rows,
                SUM(op = 'update') AS cells, SUM(revert_status = 'reverted') AS reverted_cells, SUM(revert_status = 'skipped_changed') AS skipped_cells
         FROM khd_sync_audit WHERE run_id = ? GROUP BY table_name ORDER BY table_name`, [runId]);
    const [sample] = await db.query(
        `SELECT table_name, hospcode, byear, op, col_name, before_value, after_value, applied, revert_status FROM khd_sync_audit
         WHERE run_id = ? AND op = 'update' ORDER BY id LIMIT 500`, [runId]);
    return { run, results, audit_by_table: byTable, audit_sample: sample };
}
async function listTableStatus() {
    const [rows] = await db.query('SELECT * FROM khd_table_sync_status ORDER BY table_name');
    return rows;
}

module.exports = {
    runKhdSync, withKhdSyncLock, khdSyncBusyInfo, rollbackRun, quickSend, listRuns, getRun, listTableStatus,
    tablesNeedingSync, planSignature, valText,
};
