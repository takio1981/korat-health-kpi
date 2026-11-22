/**
 * รายงาน "KHD มีค่าที่ยังไม่อนุมัติในระบบเรา" (อ่านอย่างเดียว — 22 พ.ย. 2569)
 *
 * เมื่อเปลี่ยนกติกาการส่งเป็น "ส่งเฉพาะที่อนุมัติ" ค่าที่เคยส่งเข้า KHD ไปก่อนหน้า (รวมเดือนที่ยังไม่อนุมัติ) ยังอยู่ใน KHD
 * — ระบบไม่ล้างค่าใน KHD เอง (ไม่ DELETE/ไม่เขียนค่าว่างทับ) รายงานนี้แสดงให้ผู้ดูแลเห็นว่ามีที่ใดบ้าง แล้วไปอนุมัติ/ตรวจในระบบ
 *
 * ต่อตารางส่งออก (ตัวชี้วัดเปิดใช้งาน + เปิดส่งออก KHD): อ่าน KHD `SELECT * FROM <tp> WHERE byear = ?` ทีละตาราง
 * (มีเพดานเวลาต่อคำสั่ง/รวม + พักระหว่างตาราง ตามค่าตั้งค่าการส่ง KHD) เทียบช่อง m10…m09 ที่ KHD มีค่า กับเดือนเดียวกันใน kpi_results
 *   - เดือนนั้นในระบบล็อค (อนุมัติ) แล้ว = ไม่นับ
 *   - ยังไม่อนุมัติ: แยก pending (ระบบมีผลงานรอตรวจ) / rejected (ส่งคืนแก้ไข) / empty (ระบบไม่มีผลงานเดือนนั้น) + ค่าเท่ากับในระบบหรือไม่
 */
const db = require('../db');
const { getRemotePool } = require('../db-remote');
const khd = require('./khd');
const { getKhdSyncSettings } = require('./khd-policy');
const { timedRemote, exportableTableNames } = require('./khd-sync');

const MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const colOf = (m) => 'm' + String(m).padStart(2, '0');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SAMPLE_PER_TABLE = 20;

function httpError(status, code, message) { return Object.assign(new Error(message), { status, code }); }

/** สถานะเดือนในระบบของตาราง tp ปีงบ y → Map(hospcode → Map(month → { locked, status, value })) — หลายตัวชี้วัดใช้ตารางเดียวกัน = รวม (ล็อคตัวใดตัวหนึ่ง = อนุมัติ) */
async function localMonthState(indicatorIds, y) {
    const out = new Map();
    if (!indicatorIds.length) return out;
    const [rows] = await db.query(
        `SELECT hospcode, month_bh, is_locked, status, actual_value FROM kpi_results WHERE year_bh = ? AND indicator_id IN (?)`, [y, indicatorIds]);
    for (const r of rows) {
        const hc = String(r.hospcode || '').trim();
        if (!hc) continue;
        if (!out.has(hc)) out.set(hc, new Map());
        const mm = out.get(hc);
        const m = Number(r.month_bh);
        const prev = mm.get(m);
        const cur = { locked: Number(r.is_locked) === 1, status: r.status || '', value: r.actual_value };
        if (!prev) mm.set(m, cur);
        else mm.set(m, {
            locked: prev.locked || cur.locked,
            status: prev.status || cur.status,
            value: khd.isBlankVal(prev.value) ? cur.value : prev.value,
        });
    }
    return out;
}

/** เทียบแถว KHD ของตารางหนึ่งกับสถานะในระบบ (ฟังก์ชันล้วน) → { cells, by_kind, same_as_local, hospitals, sample } */
function compareTable(khdRows, state) {
    const res = { cells: 0, by_kind: { pending: 0, rejected: 0, empty: 0 }, same_as_local: 0, hospitals: 0, sample: [] };
    const hcs = new Set();
    for (const row of khdRows) {
        const hc = String(row.hospcode || '').trim();
        if (!hc) continue;
        const mm = state.get(hc) || new Map();
        for (const m of MONTHS) {
            const col = colOf(m);
            if (!Object.prototype.hasOwnProperty.call(row, col) || khd.isBlankVal(row[col])) continue;
            const st = mm.get(m);
            if (st && st.locked) continue;
            const hasLocal = st && !khd.isBlankVal(st.value);
            const kind = !hasLocal ? 'empty' : (st.status === 'Rejected' ? 'rejected' : 'pending');
            const same = hasLocal && khd.sameKhdVal(st.value, row[col]);
            res.cells++;
            res.by_kind[kind]++;
            if (same) res.same_as_local++;
            hcs.add(hc);
            if (res.sample.length < SAMPLE_PER_TABLE) {
                res.sample.push({ hospcode: hc, month_bh: m, khd_value: String(row[col]), local_value: hasLocal ? String(st.value) : null, kind, same });
            }
        }
    }
    res.hospitals = hcs.size;
    return res;
}

const _cache = new Map(); // year → { at, data }
const CACHE_MS = 10 * 60 * 1000;

async function khdUnapprovedReport(yearBh, { refresh = false } = {}) {
    const y = String(yearBh || '');
    if (!/^\d{4}$/.test(y)) throw httpError(400, 'BAD_YEAR', 'กรุณาระบุปีงบประมาณ 4 หลัก');
    const hit = _cache.get(y);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return { ...hit.data, cached: true };
    const remoteDb = getRemotePool();
    if (!remoteDb) throw httpError(400, 'NO_REMOTE', 'ไม่ได้ตั้งค่า Remote DB (KHD)');
    const cfg = await getKhdSyncSettings();
    const remote = timedRemote(remoteDb, cfg.khd_query_timeout_ms);
    const names = await exportableTableNames();
    const [inds] = names.length
        ? await db.query(
            `SELECT id, TRIM(table_process) AS tp, kpi_indicators_name FROM kpi_indicators
             WHERE is_active = 1 AND (upload_excel IS NULL OR upload_excel = 0) AND TRIM(table_process) IN (?)`, [names])
        : [[]];
    const byTp = new Map();
    for (const i of inds) {
        if (!byTp.has(i.tp)) byTp.set(i.tp, { ids: [], names: [] });
        byTp.get(i.tp).ids.push(Number(i.id));
        byTp.get(i.tp).names.push(i.kpi_indicators_name);
    }
    const started = Date.now();
    const budget = Math.max(30, Number(cfg.khd_sync_max_seconds) || 300) * 1000;
    const tables = [], errors = [];
    let checked = 0, partial = false;
    for (const tp of names) {
        if (Date.now() - started > budget) { partial = true; break; }
        checked++;
        let rows;
        try {
            [rows] = await remote.query(`SELECT * FROM \`${tp}\` WHERE \`byear\` = ?`, [y]);
        } catch (e) {
            // ไม่มีตารางใน KHD / ไม่มีคอลัมน์ byear = ไม่มีค่าให้ตรวจ (ไม่ใช่ข้อผิดพลาดของระบบ) | หมดเวลา = แจ้ง
            if (e.code === 'KHD_TIMEOUT') errors.push({ table: tp, error: e.message });
            continue;
        }
        if (rows.length) {
            const g = byTp.get(tp) || { ids: [], names: [] };
            const cmp = compareTable(rows, await localMonthState(g.ids, y));
            if (cmp.cells) tables.push({ table: tp, indicator_names: g.names.slice(0, 3), khd_rows: rows.length, ...cmp });
        }
        if (cfg.khd_sync_pause_ms) await sleep(Number(cfg.khd_sync_pause_ms));
    }
    tables.sort((a, b) => b.cells - a.cells);
    const sum = (k) => tables.reduce((s, t) => s + t[k], 0);
    const data = {
        year_bh: y, generated_at: new Date(), partial,
        tables_total: names.length, tables_checked: checked, tables_with_unapproved: tables.length,
        totals: {
            cells: sum('cells'), same_as_local: sum('same_as_local'),
            pending: tables.reduce((s, t) => s + t.by_kind.pending, 0),
            rejected: tables.reduce((s, t) => s + t.by_kind.rejected, 0),
            empty: tables.reduce((s, t) => s + t.by_kind.empty, 0),
        },
        tables: tables.slice(0, 200), errors: errors.slice(0, 20),
    };
    _cache.set(y, { at: Date.now(), data });
    return data;
}

module.exports = { khdUnapprovedReport, compareTable, localMonthState };
