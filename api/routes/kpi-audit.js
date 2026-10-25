// เส้นทาง: แจ้งเตือนการบันทึก KPI (ตั้งค่า, รายการ, ส่งสรุปทันที)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { getAuditSettings, invalidateAuditSettingsCache } = require('../services/kpi-audit');
const { runKpiAuditDigest } = require('../jobs/kpi-audit');

// ========== Endpoints ==========
apiRouter.get('/kpi-audit/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        invalidateAuditSettingsCache();
        const cfg = await getAuditSettings();
        res.json({ success: true, data: cfg });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/kpi-audit/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const updates = [
            ['kpi_audit_enabled', b.enabled === false ? 'false' : 'true'],
            ['kpi_audit_digest_enabled', b.digestEnabled === false ? 'false' : 'true'],
            ['kpi_audit_digest_time', b.digestTime || '17:00'],
            ['kpi_audit_digest_email', b.digestEmail === false ? 'false' : 'true'],
            ['kpi_audit_digest_telegram', b.digestTelegram === false ? 'false' : 'true'],
            ['kpi_audit_digest_line', b.digestLine === false ? 'false' : 'true'],
            ['kpi_audit_digest_min_records', String(parseInt(b.minRecords) || 1)]
        ];
        for (const [k, v] of updates) {
            await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=?', [k, v, v]);
        }
        invalidateAuditSettingsCache();
        res.json({ success: true, message: 'บันทึก settings สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /kpi-audit/records — ดู audit log
apiRouter.get('/kpi-audit/records', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const { limit = 200, only_unnotified } = req.query;
        let where = '1=1';
        if (only_unnotified === '1') where += ' AND notified_at IS NULL';
        const [rows] = await db.query(
            `SELECT * FROM kpi_save_audit WHERE ${where} ORDER BY id DESC LIMIT ?`,
            [Math.min(Number(limit) || 200, 1000)]
        );
        const [stat] = await db.query(`
            SELECT
                COUNT(*) AS total,
                COUNT(CASE WHEN notified_at IS NULL THEN 1 END) AS unnotified,
                COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS today,
                COUNT(DISTINCT user_id) AS unique_users
            FROM kpi_save_audit
        `);
        res.json({ success: true, data: rows, stats: stat[0] });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /kpi-audit/run-digest-now — ส่ง digest ทันที (test)
apiRouter.post('/kpi-audit/run-digest-now', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const result = await runKpiAuditDigest(true);
        res.json({ success: true, result });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
