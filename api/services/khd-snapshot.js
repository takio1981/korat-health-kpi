/**
 * สำเนาสถานะรายงาน KHD สำหรับตรวจความพร้อมของตัวชี้วัด (22 พ.ย. 2569)
 * อ่าน KHD 2 คำสั่ง (reports + report_fiscal_year_config) วันละครั้ง (jobs/khd-snapshot.js) หรือเมื่อ super_admin กดปุ่ม
 * → เก็บในตาราง khd_reports_snapshot ของระบบเรา — การตรวจความพร้อมอ่านจากสำเนานี้ (ไม่อ่าน KHD ทุกคำขอ / ไม่เขียน KHD)
 * is_active ที่มีผล = ค่าของปีงบใน report_fiscal_year_config ก่อน แล้วจึง reports.is_active (กติกาเดียวกับ /report-compare)
 */
const db = require('../db');
const { getRemotePool } = require('../db-remote');
const { getKhdSyncSettings } = require('./khd-policy');
const { timedRemote } = require('./khd-sync');

const STATUS_KEY = 'khd_reports_snapshot_status';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;

async function getSnapshotStatus() {
    const [[r]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [STATUS_KEY]);
    try { return r && r.setting_value ? JSON.parse(r.setting_value) : null; } catch (_) { return null; }
}
async function saveStatus(st) {
    await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [STATUS_KEY, JSON.stringify(st)]);
}

/** ถึงเวลาอ่าน KHD ใหม่ไหม (ฟังก์ชันล้วน): ไม่เคยอ่าน / สำเร็จครั้งล่าสุดเกิน 24 ชม. — ล้มเหลวล่าสุดภายใน 6 ชม. = พักก่อน */
function isSnapshotDue(st, now = new Date()) {
    if (!st) return true;
    const t = now.getTime();
    const tried = st.last_try ? new Date(st.last_try).getTime() : 0;
    if (st.error && tried && t - tried < RETRY_MS) return false;
    const ok = st.refreshed_at ? new Date(st.refreshed_at).getTime() : 0;
    return !ok || t - ok >= DAY_MS;
}

const bit = (v) => (v === null || v === undefined || v === '' ? null : (Number(v) ? 1 : 0));

async function refreshKhdReportsSnapshot() {
    const prev = (await getSnapshotStatus()) || {};
    const remoteDb = getRemotePool();
    if (!remoteDb) {
        const st = { ...prev, last_try: new Date(), error: 'ไม่ได้ตั้งค่า Remote DB (KHD)' };
        await saveStatus(st);
        return { ok: false, error: st.error };
    }
    try {
        const cfg = await getKhdSyncSettings();
        const remote = timedRemote(remoteDb, cfg.khd_query_timeout_ms);
        const [reports] = await remote.query('SELECT report_id, report_name, table_process, data_source, is_active FROM reports');
        let fyRows = [];
        try { [fyRows] = await remote.query('SELECT report_id, fiscal_year, is_active FROM report_fiscal_year_config'); } catch (_) { fyRows = []; }
        const fy = new Map();
        for (const r of fyRows) {
            const id = Number(r.report_id);
            if (!fy.has(id)) fy.set(id, {});
            const v = bit(r.is_active);
            if (v !== null && r.fiscal_year != null) fy.get(id)[String(r.fiscal_year)] = v;
        }
        const values = reports.filter(r => Number.isInteger(Number(r.report_id))).map(r => [
            Number(r.report_id), r.report_name != null ? String(r.report_name).slice(0, 500) : null,
            r.table_process != null ? String(r.table_process).slice(0, 100) : null, r.data_source != null ? String(r.data_source).slice(0, 20) : null,
            bit(r.is_active), fy.has(Number(r.report_id)) ? JSON.stringify(fy.get(Number(r.report_id))) : null,
        ]);
        const conn = await db.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query('DELETE FROM khd_reports_snapshot'); // ตารางสำเนาของระบบเรา (ไม่ใช่ KHD)
            for (let i = 0; i < values.length; i += 500) {
                await conn.query('INSERT INTO khd_reports_snapshot (report_id, report_name, table_process, data_source, is_active, fy_active) VALUES ?', [values.slice(i, i + 500)]);
            }
            await conn.commit();
        } catch (e) {
            await conn.rollback().catch(() => {});
            throw e;
        } finally { conn.release(); }
        const st = { refreshed_at: new Date(), last_try: new Date(), count: values.length, error: null };
        await saveStatus(st);
        return { ok: true, count: values.length };
    } catch (e) {
        await saveStatus({ ...prev, last_try: new Date(), error: e.message }).catch(() => {});
        return { ok: false, error: e.message };
    }
}

/** สำเนาทั้งหมด → Map(report_id → { is_active, fy_active }) | null = ยังไม่มีสำเนา */
async function loadSnapshotMap() {
    const [rows] = await db.query('SELECT report_id, report_name, is_active, fy_active FROM khd_reports_snapshot');
    if (!rows.length) return null;
    const m = new Map();
    for (const r of rows) {
        let fyA = {};
        try { fyA = r.fy_active ? JSON.parse(r.fy_active) : {}; } catch (_) { fyA = {}; }
        m.set(Number(r.report_id), { report_name: r.report_name, is_active: bit(r.is_active), fy_active: fyA });
    }
    return m;
}

/** is_active ที่มีผลของปีงบ (ฟังก์ชันล้วน) → 1 | 0 | null */
function effectiveKhdActive(snap, yearBh) {
    if (!snap) return null;
    const fyV = yearBh && snap.fy_active && Object.prototype.hasOwnProperty.call(snap.fy_active, String(yearBh)) ? snap.fy_active[String(yearBh)] : null;
    return fyV !== null && fyV !== undefined ? fyV : snap.is_active;
}

module.exports = { refreshKhdReportsSnapshot, getSnapshotStatus, loadSnapshotMap, effectiveKhdActive, isSnapshotDue };
