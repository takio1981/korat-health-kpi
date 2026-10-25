// เส้นทาง: ประกาศระบบ (+ ลบหน่วยงาน DELETE /departments/:id ที่อยู่ช่วงเดียวกันในไฟล์เดิม)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { mailTransporter, sendMail } = require('../core/notify');
const { requireAction } = require('../core/access');

// ========== System Announcements (ประกาศระบบ) ==========
apiRouter.get('/announcement/active', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM system_announcements WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1');
        res.json({ success: true, data: rows[0] || null });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/announcements', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT a.*, u.firstname, u.lastname
            FROM system_announcements a
            LEFT JOIN users u ON a.created_by = u.id
            ORDER BY a.is_active DESC, a.updated_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.post('/announcements', authenticateToken, requireAction('announcements', 'add'), async (req, res) => {
    try {
        const { title, content_html, content_text, bg_color, text_color, blink_enabled, show_on_header, show_on_login, is_active } = req.body;
        if (!content_html) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความ' });
        // Limit content_text ≤ 500 chars
        const textTruncated = (content_text || '').substring(0, 500);
        // ถ้า is_active=1 → ปิด active อื่นๆ ทั้งหมด
        if (is_active) await db.query('UPDATE system_announcements SET is_active = 0');
        const [r] = await db.query(
            `INSERT INTO system_announcements (title, content_html, content_text, bg_color, text_color, blink_enabled, show_on_header, show_on_login, is_active, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [title || 'ประกาศระบบ', content_html, textTruncated, bg_color || '#dc2626', text_color || '#ffffff',
             blink_enabled ? 1 : 0, show_on_header ? 1 : 0, show_on_login ? 1 : 0, is_active ? 1 : 0, req.user.userId]
        );
        res.json({ success: true, id: r.insertId, message: 'สร้างประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/announcements/:id', authenticateToken, requireAction('announcements', 'edit'), async (req, res) => {
    try {
        const { title, content_html, content_text, bg_color, text_color, blink_enabled, show_on_header, show_on_login, is_active } = req.body;
        if (!content_html) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความ' });
        const textTruncated = (content_text || '').substring(0, 500);
        if (is_active) await db.query('UPDATE system_announcements SET is_active = 0 WHERE id != ?', [req.params.id]);
        await db.query(
            `UPDATE system_announcements SET title=?, content_html=?, content_text=?, bg_color=?, text_color=?,
             blink_enabled=?, show_on_header=?, show_on_login=?, is_active=? WHERE id=?`,
            [title || 'ประกาศระบบ', content_html, textTruncated, bg_color || '#dc2626', text_color || '#ffffff',
             blink_enabled ? 1 : 0, show_on_header ? 1 : 0, show_on_login ? 1 : 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: 'แก้ไขประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/announcements/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM system_announcements WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.put('/announcements/:id/activate', authenticateToken, requireAction('announcements', 'edit'), async (req, res) => {
    try {
        await db.query('UPDATE system_announcements SET is_active = 0');
        await db.query('UPDATE system_announcements SET is_active = 1 WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'เปิดใช้งานประกาศสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /announcements/:id/send-email — ส่งประกาศเข้าอีเมล (all / dept / users)
apiRouter.post('/announcements/:id/send-email', authenticateToken, isSuperAdmin, async (req, res) => {
    if (!mailTransporter) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้งค่า SMTP' });
    try {
        const { scope, dept_ids, user_ids } = req.body;
        // ดึงประกาศ
        const [aRows] = await db.query('SELECT * FROM system_announcements WHERE id = ?', [req.params.id]);
        if (aRows.length === 0) return res.status(404).json({ success: false, message: 'ไม่พบประกาศ' });
        const a = aRows[0];

        // หา recipients ตาม scope
        let recipients = [];
        if (scope === 'all') {
            const [rows] = await db.query(`SELECT id, email, firstname, lastname FROM users WHERE email IS NOT NULL AND email != '' AND is_active = 1`);
            recipients = rows;
        } else if (scope === 'dept' && Array.isArray(dept_ids) && dept_ids.length > 0) {
            const [rows] = await db.query(
                `SELECT id, email, firstname, lastname FROM users WHERE email IS NOT NULL AND email != '' AND is_active = 1 AND dept_id IN (${dept_ids.map(() => '?').join(',')})`,
                dept_ids
            );
            recipients = rows;
        } else if (scope === 'users' && Array.isArray(user_ids) && user_ids.length > 0) {
            const [rows] = await db.query(
                `SELECT id, email, firstname, lastname FROM users WHERE email IS NOT NULL AND email != '' AND id IN (${user_ids.map(() => '?').join(',')})`,
                user_ids
            );
            recipients = rows;
        } else {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ scope + ผู้รับ' });
        }

        if (recipients.length === 0) {
            return res.json({ success: true, sent: 0, message: 'ไม่พบผู้รับที่มี email' });
        }

        // template email (ใช้ bg_color/text_color จากประกาศ)
        const htmlTemplate = (name) => `
            <div style="font-family:'Sarabun',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:20px;border-radius:12px">
                <div style="background:linear-gradient(135deg,#065f46,#16a34a);color:white;padding:20px;border-radius:12px 12px 0 0">
                    <h2 style="margin:0">📢 ${a.title || 'ประกาศระบบ'}</h2>
                    <p style="margin:4px 0 0;opacity:.85;font-size:13px">Korat Health KPI — สสจ.นครราชสีมา</p>
                </div>
                <div style="background:white;padding:20px;border-radius:0 0 12px 12px">
                    <p style="margin:0 0 12px;color:#374151">เรียน คุณ${name || 'ผู้ใช้งาน'},</p>
                    <div style="background:${a.bg_color || '#dc2626'};color:${a.text_color || '#ffffff'};padding:14px 20px;border-radius:10px;font-weight:bold;text-align:center">
                        ${a.content_html}
                    </div>
                    <p style="margin:16px 0 0;color:#6b7280;font-size:12px">
                        ส่งจากระบบอัตโนมัติ — กรุณาอย่าตอบกลับอีเมลนี้<br>
                        <a href="https://apikorat.moph.go.th/khupskpi/" style="color:#16a34a">เปิดระบบ Korat Health KPI</a>
                    </p>
                </div>
            </div>
        `;

        // ส่งทีละคน (ไม่ block response — fire and forget สำหรับคนที่เหลือ)
        let sent = 0, failed = 0;
        const subject = `[Korat Health KPI] ${a.title || 'ประกาศระบบ'}`;
        for (const r of recipients) {
            try {
                await sendMail(r.email, subject, htmlTemplate(`${r.firstname} ${r.lastname}`));
                sent++;
            } catch (e) { failed++; }
        }

        // log
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'ANNOUNCEMENT_EMAIL', 'system_announcements', JSON.stringify({ announcement_id: a.id, scope, sent, failed, total: recipients.length }), req.ip]).catch(() => {});

        res.json({ success: true, sent, failed, total: recipients.length, message: `ส่งอีเมลสำเร็จ ${sent}/${recipients.length} คน` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.delete('/departments/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM departments WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error deleting department' });
    }
});
