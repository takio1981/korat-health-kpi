// บันทึกการบันทึกผลงาน (KPI save audit) + ตั้งค่าแจ้งเตือนการบันทึก KPI (แคช 60 วินาที)
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');

// ========================================================================
// ====== KPI Save Audit + Daily Digest Notification (Phase 4 add-on) ======
// ========================================================================

// Cache audit settings (refresh ทุก 60 วินาที กัน query DB ทุก save)
let _auditSettingsCache = null;

let _auditSettingsExpiry = 0;

// ล้างแคชตั้งค่า (เรียกหลังบันทึกตั้งค่า) — แทนการกำหนดค่าตัวแปรตรงๆ ในเส้นทาง เพื่อย้ายส่วนนี้เป็นโมดูลได้
function invalidateAuditSettingsCache() { _auditSettingsExpiry = 0; }

async function getAuditSettings() {
    const now = Date.now();
    if (_auditSettingsCache && _auditSettingsExpiry > now) return _auditSettingsCache;
    try {
        const [rows] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'kpi_audit_%'");
        const s = {};
        for (const r of rows) s[r.setting_key] = r.setting_value;
        _auditSettingsCache = {
            enabled: s.kpi_audit_enabled !== 'false',
            digestEnabled: s.kpi_audit_digest_enabled !== 'false',
            digestTime: s.kpi_audit_digest_time || '17:00',
            digestEmail: s.kpi_audit_digest_email !== 'false',
            digestTelegram: s.kpi_audit_digest_telegram !== 'false',
            digestLine: s.kpi_audit_digest_line !== 'false',
            minRecords: parseInt(s.kpi_audit_digest_min_records) || 1,
            lastDigestAt: s.kpi_audit_last_digest_at || '',
            lastDigestResult: s.kpi_audit_last_digest_result || ''
        };
        _auditSettingsExpiry = now + 60 * 1000;
        return _auditSettingsCache;
    } catch (e) {
        return { enabled: false, digestEnabled: false };
    }
}

// Fire-and-forget audit logger (ไม่ throw, ไม่ block save endpoint)
async function logKpiSaveAudit(meta) {
    try {
        const cfg = await getAuditSettings();
        if (!cfg.enabled) return;
        await db.query(
            `INSERT INTO kpi_save_audit
             (user_id, username, full_name, dept_id, dept_name, hospcode, hospname,
              action_type, indicator_id, indicator_name, year_bh, month_bh, table_name, row_count, summary, ip_address)
             VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`,
            [meta.user_id || null, meta.username || null, meta.full_name || null,
             meta.dept_id || null, meta.dept_name || null, meta.hospcode || null, meta.hospname || null,
             meta.action_type, meta.indicator_id || null, meta.indicator_name || null,
             meta.year_bh || null, meta.month_bh || null, meta.table_name || null,
             meta.row_count || 1, meta.summary || null, meta.ip_address || null]
        );
    } catch (e) {
        // ไม่ throw — audit log ห้ามทำ save endpoint พัง
        console.warn('[KPI Audit] log failed (continuing):', e.message);
    }
}

// Helper: ดึงข้อมูล user แบบเต็ม (full_name, dept_name, hospname) จาก userId
async function getUserAuditInfo(userId) {
    try {
        const [rows] = await db.query(`
            SELECT u.id, u.username, u.firstname, u.lastname, u.dept_id, u.hospcode,
                   d.dept_name, h.hosname
            FROM users u
            LEFT JOIN departments d ON u.dept_id = d.id
            LEFT JOIN chospital h ON u.hospcode = h.hoscode
            WHERE u.id = ?
        `, [userId]);
        if (rows.length === 0) return null;
        const u = rows[0];
        return {
            user_id: u.id,
            username: u.username,
            full_name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username,
            dept_id: u.dept_id,
            dept_name: u.dept_name,
            hospcode: u.hospcode,
            hospname: u.hosname
        };
    } catch (e) { return null; }
}

module.exports = { invalidateAuditSettingsCache, getAuditSettings, logKpiSaveAudit, getUserAuditInfo };
