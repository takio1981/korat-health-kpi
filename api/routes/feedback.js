// เส้นทาง: กระดานข้อเสนอแนะ
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { notifyAdmins, sendLineToUser } = require('../core/notify');

// ========== Feedback Board API ==========

// POST /feedback/mark-read — เคลียร์ badge เมื่อเข้าหน้า feedback
apiRouter.post('/feedback/mark-read', authenticateToken, async (req, res) => {
    try {
        await db.query(
            "INSERT INTO system_settings (setting_key, setting_value) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE setting_value = NOW()",
            [`feedback_last_read_${req.user.userId}`]
        );
        res.json({ success: true });
    } catch (e) { res.json({ success: true }); }
});

// GET /feedback/unread-count — นับกระทู้/reply ใหม่ตั้งแต่ครั้งล่าสุดที่เข้าดู
apiRouter.get('/feedback/unread-count', authenticateToken, async (req, res) => {
    try {
        const [lastRead] = await db.query(
            "SELECT setting_value FROM system_settings WHERE setting_key = ?",
            [`feedback_last_read_${req.user.userId}`]
        );
        const since = lastRead[0]?.setting_value || '2000-01-01';
        // นับกระทู้ + reply ที่สร้างหลังจาก last_read
        const [posts] = await db.query(
            'SELECT COUNT(*) AS cnt FROM feedback_posts WHERE created_at > ? AND user_id != ?',
            [since, req.user.userId]
        );
        const [replies] = await db.query(
            'SELECT COUNT(*) AS cnt FROM feedback_replies WHERE created_at > ? AND user_id != ?',
            [since, req.user.userId]
        );
        res.json({ success: true, count: (posts[0].cnt || 0) + (replies[0].cnt || 0) });
    } catch (e) { res.json({ success: true, count: 0 }); }
});

// GET /feedback — ดึงกระทู้ทั้งหมด
apiRouter.get('/feedback', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT p.*, u.firstname, u.lastname, u.username, u.role AS user_role,
                   (SELECT COUNT(*) FROM feedback_replies r WHERE r.post_id = p.id) AS reply_count
            FROM feedback_posts p
            LEFT JOIN users u ON p.user_id = u.id
            ORDER BY p.updated_at DESC
        `);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /feedback — สร้างกระทู้ใหม่ + แจ้งเตือน
apiRouter.post('/feedback', authenticateToken, async (req, res) => {
    const { category, title, message } = req.body;
    if (!title || !message) return res.status(400).json({ success: false, message: 'กรุณากรอกหัวข้อและข้อความ' });
    try {
        const [result] = await db.query(
            'INSERT INTO feedback_posts (user_id, category, title, message) VALUES (?,?,?,?)',
            [req.user.userId, category || 'suggestion', title, message]
        );
        // แจ้งเตือน super_admin ทุกคน
        const [superAdmins] = await db.query("SELECT id FROM users WHERE role = 'super_admin' AND is_approved = 1");
        const user = req.user;
        const [userInfo] = await db.query('SELECT firstname, lastname FROM users WHERE id = ?', [user.userId]);
        const authorName = userInfo[0] ? `${userInfo[0].firstname} ${userInfo[0].lastname}` : user.username;
        for (const sa of superAdmins) {
            await db.query(
                "INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)",
                [sa.id, `กระทู้ใหม่: ${title}`, `${authorName} — ${message.substring(0, 100)}`, user.userId]
            );
        }
        // แจ้ง Telegram + Email
        const catLabels = { suggestion: 'ข้อเสนอแนะ', question: 'คำถาม', bug: 'แจ้งปัญหา', other: 'อื่นๆ' };
        const catLabel = catLabels[category] || category;
        notifyAdmins(
            `📝 กระทู้ใหม่: ${title} — ระบบ KPI สสจ.นครราชสีมา`,
            `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:linear-gradient(135deg,#0d9488,#14b8a6);padding:20px;text-align:center;color:white">
                    <h2 style="margin:0;font-size:18px">📝 กระทู้ใหม่</h2>
                </div>
                <div style="padding:20px">
                    <table style="width:100%;font-size:14px;border-collapse:collapse">
                        <tr><td style="padding:6px 0;color:#6b7280">หมวดหมู่</td><td style="font-weight:bold">${catLabel}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">หัวข้อ</td><td style="font-weight:bold">${title}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">ผู้สร้าง</td><td style="font-weight:bold">${authorName}</td></tr>
                    </table>
                    <div style="margin-top:12px;padding:12px;background:#f3f4f6;border-radius:8px;font-size:13px">${message.substring(0, 300)}</div>
                </div>
            </div>`,
            `📝 กระทู้ใหม่\n━━━━━━━━━━━━━━━\n📋 ${catLabel}\n📌 ${title}\n👤 ${authorName}\n━━━━━━━━━━━━━━━\n${message.substring(0, 200)}`
        );
        res.json({ success: true, message: 'สร้างกระทู้สำเร็จ', id: result.insertId });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GET /feedback/:id/replies — ดึง replies ของกระทู้
apiRouter.get('/feedback/:id/replies', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT r.*, u.firstname, u.lastname, u.username, u.role AS user_role
            FROM feedback_replies r
            LEFT JOIN users u ON r.user_id = u.id
            WHERE r.post_id = ?
            ORDER BY r.created_at ASC
        `, [req.params.id]);
        res.json({ success: true, data: rows });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /feedback/:id/replies — ตอบกลับกระทู้ + แจ้งเตือนทุกช่องทาง
apiRouter.post('/feedback/:id/replies', authenticateToken, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'กรุณากรอกข้อความ' });
    try {
        await db.query('INSERT INTO feedback_replies (post_id, user_id, message) VALUES (?,?,?)', [req.params.id, req.user.userId, message]);
        await db.query('UPDATE feedback_posts SET updated_at = NOW() WHERE id = ?', [req.params.id]);
        const [post] = await db.query('SELECT user_id, title FROM feedback_posts WHERE id = ?', [req.params.id]);
        const [replier] = await db.query('SELECT firstname, lastname, role FROM users WHERE id = ?', [req.user.userId]);
        const replierName = replier[0] ? `${replier[0].firstname} ${replier[0].lastname}` : 'ผู้ใช้งาน';
        const replierRole = replier[0]?.role || '';

        // 1. แจ้ง Notification เจ้าของกระทู้ (ถ้าไม่ใช่ตัวเอง)
        if (post[0] && post[0].user_id !== req.user.userId) {
            await db.query(
                "INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)",
                [post[0].user_id, `มีคนตอบกระทู้ของคุณ`, `${replierName} ตอบกลับกระทู้ "${post[0].title}"`, req.user.userId]
            );
            // LINE ส่วนตัวให้เจ้าของกระทู้
            sendLineToUser(post[0].user_id,
                `💬 มีคนตอบกระทู้ของคุณ\n` +
                `📌 ${post[0].title}\n` +
                `👤 ${replierName}\n` +
                `━━━━━━━━━━━\n` +
                `${(message || '').substring(0, 200)}`
            );
        }

        // 2. แจ้ง super_admin ทุกคน (ถ้าคนตอบไม่ใช่ super_admin)
        if (replierRole !== 'super_admin') {
            const [superAdmins] = await db.query("SELECT id FROM users WHERE role = 'super_admin' AND is_approved = 1 AND id != ?", [req.user.userId]);
            for (const sa of superAdmins) {
                await db.query(
                    "INSERT INTO notifications (user_id, type, title, message, created_by) VALUES (?, 'info', ?, ?, ?)",
                    [sa.id, `ตอบกลับกระทู้: ${post[0]?.title}`, `${replierName}: ${message.substring(0, 100)}`, req.user.userId]
                );
            }
        }

        // 3. แจ้ง Telegram ทุกข้อความตอบกลับ
        const title = post[0]?.title || '';
        notifyAdmins(
            `💬 ตอบกลับกระทู้: ${title}`,
            `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:linear-gradient(135deg,#0d9488,#14b8a6);padding:16px;text-align:center;color:white">
                    <h2 style="margin:0;font-size:16px">💬 ตอบกลับกระทู้</h2>
                </div>
                <div style="padding:16px">
                    <p style="font-weight:bold;margin-bottom:4px">📌 ${title}</p>
                    <p style="color:#6b7280;font-size:13px">👤 ${replierName}</p>
                    <div style="margin-top:8px;padding:10px;background:#f3f4f6;border-radius:8px;font-size:13px">${message.substring(0, 300)}</div>
                </div>
            </div>`,
            `💬 ตอบกลับกระทู้\n📌 ${title}\n👤 ${replierName}\n━━━━━━━━━━━━━━━\n${message.substring(0, 200)}`
        );

        res.json({ success: true, message: 'ตอบกลับสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /feedback/:id/status — อัปเดตสถานะ (super_admin)
apiRouter.put('/feedback/:id/status', authenticateToken, isSuperAdmin, async (req, res) => {
    const { status } = req.body;
    try {
        await db.query('UPDATE feedback_posts SET status = ? WHERE id = ?', [status, req.params.id]);
        res.json({ success: true, message: 'อัปเดตสถานะสำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DELETE /feedback/:id — ลบกระทู้ (super_admin)
apiRouter.delete('/feedback/:id', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM feedback_posts WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'ลบกระทู้สำเร็จ' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
