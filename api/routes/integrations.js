// เส้นทาง: ตั้งค่า env, ทดสอบการแจ้งเตือน (Telegram/LINE/อีเมล), ข้อมูลผู้ใช้ตัวเอง (/me), LINE webhook, เครื่องมือผู้ดูแล
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const crypto = require('crypto');
const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin } = require('../core/auth');
const { getNotifSettings, sendLineDirect, sendLineMulticast, sendMail, sendTelegramDirect } = require('../core/notify');

// === Environment Config Management ===
// GET /env-config — ดึง config ทั้งหมด (DB override + ENV fallback)
apiRouter.get('/env-config', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const envKeys = [
            { key: 'DB_HOST', group: 'database', label: 'Database Host', sensitive: false },
            { key: 'DB_PORT', group: 'database', label: 'Database Port', sensitive: false },
            { key: 'DB_NAME', group: 'database', label: 'Database Name', sensitive: false },
            { key: 'DB_USER', group: 'database', label: 'Database User', sensitive: false },
            { key: 'DB_PASSWORD', group: 'database', label: 'Database Password', sensitive: true },
            { key: 'SMTP_HOST', group: 'email', label: 'SMTP Host', sensitive: false },
            { key: 'SMTP_PORT', group: 'email', label: 'SMTP Port', sensitive: false },
            { key: 'SMTP_USER', group: 'email', label: 'SMTP Email', sensitive: false },
            { key: 'SMTP_PASS', group: 'email', label: 'SMTP Password (App Password)', sensitive: true },
            { key: 'SMTP_FROM', group: 'email', label: 'SMTP From Name', sensitive: false },
            { key: 'TELEGRAM_BOT_TOKEN', group: 'notification', label: 'Telegram Bot Token', sensitive: true },
            { key: 'TELEGRAM_CHAT_ID', group: 'notification', label: 'Telegram Chat ID', sensitive: false },
            { key: 'ADMIN_EMAILS', group: 'notification', label: 'Admin Emails (comma)', sensitive: false },
            { key: 'APP_URL', group: 'app', label: 'Application URL (Frontend)', sensitive: false },
            { key: 'SECRET_KEY', group: 'app', label: 'JWT Secret Key', sensitive: true },
            { key: 'PORT', group: 'app', label: 'Backend Port', sensitive: false },
            { key: 'KHD_DB_HOST', group: 'khd', label: 'KHD Database Host', sensitive: false },
            { key: 'KHD_DB_PORT', group: 'khd', label: 'KHD Database Port', sensitive: false },
            { key: 'KHD_DB_NAME', group: 'khd', label: 'KHD Database Name', sensitive: false },
            { key: 'KHD_DB_USER', group: 'khd', label: 'KHD Database User', sensitive: false },
            { key: 'KHD_DB_PASSWORD', group: 'khd', label: 'KHD Database Password', sensitive: true },
        ];

        // ดึงค่าจาก system_settings (DB override)
        const settingKeys = envKeys.map(e => 'env_' + e.key);
        const [dbRows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [settingKeys]);
        const dbMap = new Map(dbRows.map(r => [r.setting_key.replace('env_', ''), r.setting_value]));

        const config = envKeys.map(e => ({
            ...e,
            env_value: e.sensitive ? (process.env[e.key] ? '••••••••' : '') : (process.env[e.key] || ''),
            db_value: e.sensitive ? (dbMap.get(e.key) ? '••••••••' : '') : (dbMap.get(e.key) || ''),
            source: dbMap.has(e.key) && dbMap.get(e.key) ? 'db' : (process.env[e.key] ? 'env' : 'none'),
            has_value: !!(dbMap.get(e.key) || process.env[e.key])
        }));

        res.json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST /env-config — บันทึก config ลง DB (override .env)
apiRouter.post('/env-config', authenticateToken, isSuperAdmin, async (req, res) => {
    const { settings } = req.body; // [{ key: 'SMTP_HOST', value: 'smtp.gmail.com' }, ...]
    if (!Array.isArray(settings)) return res.status(400).json({ success: false, message: 'Invalid data' });

    try {
        for (const s of settings) {
            if (!s.key || s.value === undefined) continue;
            const dbKey = 'env_' + s.key;
            await db.query(
                'INSERT INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [dbKey, s.value, `ENV override: ${s.key}`, s.value]
            );
        }

        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'UPDATE', 'env_config', JSON.stringify({ keys: settings.map(s => s.key) }), req.ip]).catch(() => {});

        res.json({ success: true, message: `บันทึก ${settings.length} รายการสำเร็จ (มีผลหลัง restart server)` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

apiRouter.post('/test-telegram', authenticateToken, isSuperAdmin, async (req, res) => {
    const { bot_token, chat_id } = req.body;
    if (!bot_token || !chat_id) return res.status(400).json({ success: false, message: 'กรุณากรอก Bot Token และ Chat ID' });
    const ok = await sendTelegramDirect(bot_token, chat_id, '🔔 ทดสอบการแจ้งเตือน\nจากระบบ KPI สสจ.นครราชสีมา\n✅ การเชื่อมต่อสำเร็จ!');
    res.json({ success: ok, message: ok ? 'ส่ง Telegram สำเร็จ' : 'ส่งไม่สำเร็จ ตรวจสอบ Token และ Chat ID' });
});

// === Test LINE Group Notification (super_admin) ===
apiRouter.post('/test-line', authenticateToken, isSuperAdmin, async (req, res) => {
    const { channel_token, group_id } = req.body;
    if (!channel_token || !group_id) return res.status(400).json({ success: false, message: 'กรุณากรอก Channel Access Token และ Group ID' });
    const groupIds = String(group_id).split(',').map(s => s.trim()).filter(Boolean);
    const msg = '🔔 ทดสอบการแจ้งเตือน\nจากระบบ KPI สสจ.นครราชสีมา\n✅ การเชื่อมต่อ LINE สำเร็จ!';
    const r = await sendLineMulticast(channel_token, groupIds.join(','), msg);
    const ok = r.sent > 0;
    res.json({
        success: ok,
        sent: r.sent, failed: r.failed,
        message: ok ? `ส่ง LINE สำเร็จ ${r.sent}/${groupIds.length} group` : (r.lastError || 'ส่งไม่สำเร็จ ตรวจสอบ Channel Access Token และ Group ID')
    });
});

// === Personal LINE — ของ user ตัวเอง ===
// GET /me/line — ดู LINE settings ของตัวเอง
apiRouter.get('/me/line', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT line_user_id, notif_line_enabled FROM users WHERE id = ? LIMIT 1',
            [req.user.userId]
        );
        if (!rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบ user' });
        // ดึง system line_channel_token เพื่อบอก client ว่าระบบเปิด LINE ใช้งานได้ไหม
        const ns = await getNotifSettings();
        res.json({
            success: true,
            line_user_id: rows[0].line_user_id || '',
            notif_line_enabled: Number(rows[0].notif_line_enabled) === 1,
            system_line_configured: !!ns.lineToken
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /me/line — บันทึก LINE userId + toggle
apiRouter.put('/me/line', authenticateToken, async (req, res) => {
    try {
        let { line_user_id, notif_line_enabled } = req.body || {};
        line_user_id = String(line_user_id || '').trim();
        // validate: ต้องเป็น "U" + 32 hex chars หรือว่าง (clear)
        if (line_user_id && !/^U[a-f0-9]{32}$/i.test(line_user_id)) {
            return res.status(400).json({ success: false, message: 'LINE userId ต้องเป็นรูปแบบ U + 32 hex chars (เช่น Uxxxxxx...)' });
        }
        const enabled = (notif_line_enabled === false || notif_line_enabled === 0 || notif_line_enabled === '0') ? 0 : 1;
        await db.query(
            'UPDATE users SET line_user_id = ?, notif_line_enabled = ? WHERE id = ?',
            [line_user_id || null, enabled, req.user.userId]
        );
        res.json({ success: true, message: 'บันทึก LINE settings สำเร็จ', line_user_id: line_user_id || '', notif_line_enabled: enabled === 1 });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /me/line/test — ทดสอบส่ง LINE ไปที่ user ตัวเอง
apiRouter.post('/me/line/test', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(
            'SELECT firstname, lastname, line_user_id FROM users WHERE id = ? LIMIT 1',
            [req.user.userId]
        );
        if (!rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบ user' });
        if (!rows[0].line_user_id) return res.status(400).json({ success: false, message: 'ยังไม่ได้ตั้ง LINE userId — กรอกและบันทึกก่อนทดสอบ' });
        const ns = await getNotifSettings();
        if (!ns.lineToken) return res.status(400).json({ success: false, message: 'ระบบยังไม่ได้ตั้ง Channel Access Token (super_admin ต้องตั้งที่ Settings)' });
        const msg = `🔔 ทดสอบการแจ้งเตือนส่วนตัว\nสวัสดี คุณ${rows[0].firstname} ${rows[0].lastname}\n✅ การเชื่อมต่อ LINE สำเร็จ! ระบบจะส่งแจ้งเตือนเข้าที่ LINE นี้`;
        const r = await sendLineDirect(ns.lineToken, rows[0].line_user_id, msg);
        res.json({
            success: r.ok,
            message: r.ok ? 'ส่ง LINE ทดสอบสำเร็จ — กรุณาตรวจสอบ LINE' : (r.error || 'ส่งไม่สำเร็จ — ตรวจว่าคุณ Add friend bot แล้วและ userId ถูกต้อง')
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === LINE Profile API: ดึงชื่อ + รูปจาก userId ===
const getLineProfile = async (channelToken, lineUserId) => {
    if (!channelToken || !lineUserId) return null;
    try {
        const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
            headers: { 'Authorization': `Bearer ${channelToken}` }
        });
        if (!res.ok) return null;
        return await res.json();  // { userId, displayName, pictureUrl, statusMessage }
    } catch (e) {
        console.error('[LINE profile] error:', e.message);
        return null;
    }
};

// === LINE Webhook — รับ event จาก LINE Platform เมื่อ user ทักเข้า bot ===
// LINE platform จะ POST ไปที่ webhook URL ที่ตั้งใน Developers Console
// URL ที่ต้องตั้งที่ console: https://<your-domain>/khupskpi/api/webhook/line
// ไม่ใช้ authenticateToken เพราะ LINE ไม่ส่ง JWT — verify ด้วย signature แทน
apiRouter.post('/webhook/line', async (req, res) => {
    try {
        const relayAuth = req.headers['x-relay-auth'];
        console.log(`[LINE webhook] HIT — IP=${req.ip} signature=${req.headers['x-line-signature'] ? 'present' : 'MISSING'} relayAuth=${relayAuth ? 'present' : 'MISSING'} hasRawBody=${!!req.rawBody} events=${(req.body?.events || []).length}`);

        // === Auth: รับ 2 แบบ — (1) LINE signature ตรงๆ (2) X-Relay-Auth จาก Cloudflare Worker ===
        const [secretRow] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'line_channel_secret' LIMIT 1");
        const [relayKeyRow] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'line_relay_auth_key' LIMIT 1");
        const channelSecret = secretRow[0]?.setting_value || '';
        const relayAuthKey = relayKeyRow[0]?.setting_value || '';

        let authMethod = null;
        // ลอง relay auth ก่อน (Cloudflare Worker forward case)
        if (relayAuth && relayAuthKey && relayAuth === relayAuthKey) {
            authMethod = 'relay';
            console.log('[LINE webhook] auth=RELAY OK (from Cloudflare Worker)');
        }
        // ถ้าไม่ใช่ relay → ลอง LINE signature
        else if (channelSecret) {
            const signature = req.headers['x-line-signature'];
            if (!signature) {
                console.warn('[LINE webhook] no x-line-signature header + no valid relay auth');
                return res.status(401).send('Unauthorized: no signature or relay auth');
            }
            if (!req.rawBody) {
                console.warn('[LINE webhook] rawBody missing — global json verify middleware not applied?');
            }
            const body = req.rawBody || Buffer.from(JSON.stringify(req.body), 'utf8');
            const expected = crypto.createHmac('sha256', channelSecret).update(body).digest('base64');
            if (signature !== expected) {
                console.warn(`[LINE webhook] signature mismatch — got=${signature?.slice(0, 12)}... expected=${expected.slice(0, 12)}... bodyLen=${body.length}`);
                return res.status(401).send('Invalid signature');
            }
            authMethod = 'line-signature';
            console.log('[LINE webhook] auth=LINE-SIGNATURE OK');
        } else {
            console.warn('[LINE webhook] no channel_secret + no relay key set — accept all (insecure)');
            authMethod = 'none';
        }

        // === Reply 200 OK ทันที (LINE timeout เร็ว) ===
        res.status(200).send('OK');

        const events = req.body?.events || [];
        if (!Array.isArray(events) || events.length === 0) return;

        const ns = await getNotifSettings();
        for (const ev of events) {
            const lineUserId = ev?.source?.userId;
            if (!lineUserId) continue;
            const messageText = ev?.message?.text || `[event: ${ev.type}]`;
            // ดึง profile (display name + picture)
            const profile = await getLineProfile(ns.lineToken, lineUserId);
            const displayName = profile?.displayName || null;
            const pictureUrl = profile?.pictureUrl || null;

            // INSERT ON DUPLICATE — เก็บล่าสุด + นับ message_count
            await db.query(
                `INSERT INTO line_inbox (line_user_id, display_name, picture_url, last_message, message_count, received_at)
                 VALUES (?, ?, ?, ?, 1, NOW())
                 ON DUPLICATE KEY UPDATE
                     display_name = COALESCE(VALUES(display_name), display_name),
                     picture_url = COALESCE(VALUES(picture_url), picture_url),
                     last_message = VALUES(last_message),
                     message_count = message_count + 1,
                     received_at = NOW(),
                     is_archived = 0`,
                [lineUserId, displayName, pictureUrl, messageText.slice(0, 500)]
            ).catch(e => console.error('[LINE webhook] inbox insert error:', e.message));

            // === Auto-reply userId กลับให้ user ผ่าน LINE bot ===
            // 3 scenario: (1) follow event ครั้งแรก (2) ผูกบัญชีแล้ว (3) ยังไม่ผูก
            const evType = ev.type;
            const replyToken = ev.replyToken;
            console.log(`[LINE webhook] event type=${evType} replyToken=${replyToken ? replyToken.slice(0, 12) + '...' : 'MISSING'} hasToken=${!!ns.lineToken}`);

            if ((evType === 'follow' || evType === 'message') && replyToken && ns.lineToken) {
                try {
                    const [linkedRows] = await db.query(
                        'SELECT id, username, firstname, lastname, notif_line_enabled FROM users WHERE line_user_id = ? LIMIT 1',
                        [lineUserId]
                    );
                    const linkedUser = linkedRows[0];
                    const baseUrl = (process.env.APP_URL || 'https://apikorat.moph.go.th/khupskpi').replace(/\/+$/, '');
                    const lowerText = (messageText || '').toLowerCase().trim();
                    const isQuestionForId = /(\buserid\b|\buser id\b|\buser_id\b|\bid\b|ไอดี|รหัส|เริ่ม|\bstart\b|\/start|\bhelp\b|\?)/i.test(lowerText);

                    let messages = [];
                    if (evType === 'follow') {
                        messages = [
                            { type: 'text', text: `🙏 ยินดีต้อนรับสู่ระบบ KHUPS KPI\n\n📌 LINE userId ของคุณ (แตะค้างข้อความถัดไปเพื่อคัดลอก) ⬇️` },
                            { type: 'text', text: lineUserId },
                            { type: 'text', text: `วิธีใช้งาน:\n1️⃣ คัดลอก userId ด้านบน\n2️⃣ ส่งให้ super_admin (หรือ Login ที่ ${baseUrl}/login → Profile → "ตั้งค่า LINE แจ้งเตือนส่วนตัว")\n3️⃣ พิมพ์ "id" ที่นี่ → ขอ userId ใหม่ได้ทุกเมื่อ` }
                        ];
                    } else if (linkedUser && isQuestionForId) {
                        const userName = `${linkedUser.firstname || ''} ${linkedUser.lastname || ''}`.trim() || linkedUser.username;
                        const status = Number(linkedUser.notif_line_enabled) === 1 ? '🟢 เปิดแจ้งเตือน' : '🔴 ปิดแจ้งเตือน';
                        messages = [
                            { type: 'text', text: `✅ บัญชีนี้ผูกอยู่แล้ว\n\n👤 ${userName} (${linkedUser.username})\n${status}\n\n📌 LINE userId ⬇️` },
                            { type: 'text', text: lineUserId }
                        ];
                    } else if (linkedUser) {
                        // ทักเฉยๆ — ตอบสั้นๆ
                        const userName = `${linkedUser.firstname || ''} ${linkedUser.lastname || ''}`.trim() || linkedUser.username;
                        messages = [{ type: 'text', text: `สวัสดีคุณ${userName} 👋\nระบบจะส่งแจ้งเตือนเข้า LINE นี้\nพิมพ์ "id" → ดู userId` }];
                    } else {
                        // ยังไม่ผูก
                        messages = [
                            { type: 'text', text: `📌 LINE userId ของคุณ (แตะค้างข้อความถัดไปเพื่อคัดลอก) ⬇️` },
                            { type: 'text', text: lineUserId },
                            { type: 'text', text: `วิธีใช้งาน:\n1️⃣ คัดลอก userId ด้านบน\n2️⃣ ส่งให้ super_admin\n3️⃣ Login ${baseUrl}/login → Profile → "ตั้งค่า LINE แจ้งเตือนส่วนตัว" → วาง userId → บันทึก\n\nจะได้รับแจ้งเตือน: login, อนุมัติบัญชี, reset password, มีคนตอบกระทู้` }
                        ];
                    }

                    console.log(`[LINE webhook] sending reply: replyToken=${replyToken.slice(0, 16)}... msgCount=${messages.length} tokenLen=${ns.lineToken.length}`);
                    const replyRes = await fetch('https://api.line.me/v2/bot/message/reply', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${ns.lineToken}`
                        },
                        body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) })
                    });
                    const replyBody = await replyRes.text();
                    if (replyRes.ok) {
                        console.log(`[LINE webhook] ✓ reply SUCCESS status=${replyRes.status}`);
                    } else {
                        console.error(`[LINE webhook] ✗ reply FAILED status=${replyRes.status} body=${replyBody.slice(0, 500)}`);
                    }
                } catch (e) {
                    console.error('[LINE webhook] reply error:', e.message, e.stack?.split('\n').slice(0, 3).join(' | '));
                }
            } else {
                console.log(`[LINE webhook] skip reply: evType=${evType} hasReplyToken=${!!replyToken} hasLineToken=${!!ns.lineToken}`);
            }
        }
    } catch (e) {
        console.error('[LINE webhook] handler error:', e.message);
        // already sent 200 — ไม่ส่งอีก
    }
});

// === Admin: LINE Inbox + จัดการ line_user_id ของ user คนใดก็ได้ (super_admin only) ===
// GET /admin/line-inbox — รายการล่าสุดจาก webhook
apiRouter.get('/admin/line-inbox', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const showArchived = req.query.archived === '1';
        const [rows] = await db.query(`
            SELECT i.*, u.id AS user_id, u.username, u.firstname, u.lastname, u.role
            FROM line_inbox i
            LEFT JOIN users u ON u.id = i.linked_user_id
            ${showArchived ? '' : 'WHERE i.is_archived = 0'}
            ORDER BY i.received_at DESC
            LIMIT 100
        `);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/line-inbox/:id/assign — assign userId ใน inbox ให้กับ system user
apiRouter.post('/admin/line-inbox/:id/assign', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const inboxId = Number(req.params.id);
        const targetUserId = Number(req.body?.user_id);
        if (!targetUserId) return res.status(400).json({ success: false, message: 'ต้องระบุ user_id' });
        const [inboxRow] = await db.query('SELECT line_user_id FROM line_inbox WHERE id = ?', [inboxId]);
        if (!inboxRow[0]) return res.status(404).json({ success: false, message: 'ไม่พบ inbox' });
        const lineUserId = inboxRow[0].line_user_id;
        // เช็คว่า userId นี้มี user คนอื่นเซ็ตอยู่หรือไม่
        const [conflict] = await db.query('SELECT id, username FROM users WHERE line_user_id = ? AND id != ?', [lineUserId, targetUserId]);
        if (conflict.length > 0) {
            return res.status(409).json({ success: false, message: `userId นี้ผูกอยู่กับ user "${conflict[0].username}" แล้ว` });
        }
        await db.query('UPDATE users SET line_user_id = ? WHERE id = ?', [lineUserId, targetUserId]);
        await db.query('UPDATE line_inbox SET linked_user_id = ?, linked_at = NOW() WHERE id = ?', [targetUserId, inboxId]);
        res.json({ success: true, message: 'ผูกสำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/line-inbox/:id/archive — ซ่อน entry ที่ไม่ใช้
apiRouter.post('/admin/line-inbox/:id/archive', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const archived = req.body?.archived === false ? 0 : 1;
        await db.query('UPDATE line_inbox SET is_archived = ? WHERE id = ?', [archived, Number(req.params.id)]);
        res.json({ success: true, archived: archived === 1 });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PUT /admin/users/:id/line — super_admin set/clear line_user_id ของ user คนใดก็ได้
apiRouter.put('/admin/users/:id/line', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        let { line_user_id, notif_line_enabled } = req.body || {};
        line_user_id = String(line_user_id || '').trim();
        if (line_user_id && !/^U[a-f0-9]{32}$/i.test(line_user_id)) {
            return res.status(400).json({ success: false, message: 'LINE userId ต้องเป็นรูปแบบ U + 32 hex chars' });
        }
        // เช็ค conflict (userId ซ้ำกับ user อื่น)
        if (line_user_id) {
            const [conflict] = await db.query('SELECT id, username FROM users WHERE line_user_id = ? AND id != ?', [line_user_id, userId]);
            if (conflict.length > 0) {
                return res.status(409).json({ success: false, message: `userId นี้ผูกอยู่กับ user "${conflict[0].username}" แล้ว` });
            }
        }
        const enabled = (notif_line_enabled === false || notif_line_enabled === 0 || notif_line_enabled === '0') ? 0 : 1;
        await db.query('UPDATE users SET line_user_id = ?, notif_line_enabled = ? WHERE id = ?',
            [line_user_id || null, enabled, userId]);
        // sync linked_user_id ใน inbox (ถ้ามี)
        if (line_user_id) {
            await db.query('UPDATE line_inbox SET linked_user_id = ?, linked_at = NOW() WHERE line_user_id = ?', [userId, line_user_id]);
        } else {
            await db.query('UPDATE line_inbox SET linked_user_id = NULL, linked_at = NULL WHERE linked_user_id = ?', [userId]);
        }
        res.json({ success: true, message: 'บันทึกสำเร็จ' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// POST /admin/users/:id/line/test — super_admin ทดสอบส่ง LINE ให้ user คนใดก็ได้
apiRouter.post('/admin/users/:id/line/test', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT firstname, lastname, line_user_id FROM users WHERE id = ? LIMIT 1', [Number(req.params.id)]);
        if (!rows[0]) return res.status(404).json({ success: false, message: 'ไม่พบ user' });
        if (!rows[0].line_user_id) return res.status(400).json({ success: false, message: 'user ยังไม่ได้ตั้ง LINE userId' });
        const ns = await getNotifSettings();
        if (!ns.lineToken) return res.status(400).json({ success: false, message: 'ระบบยังไม่ตั้ง Channel Access Token' });
        const msg = `🔔 ทดสอบการแจ้งเตือนจาก super_admin\nสวัสดี คุณ${rows[0].firstname} ${rows[0].lastname}\n✅ การเชื่อมต่อ LINE สำเร็จ`;
        const r = await sendLineDirect(ns.lineToken, rows[0].line_user_id, msg);
        res.json({ success: r.ok, message: r.ok ? 'ส่งสำเร็จ' : (r.error || 'ส่งไม่สำเร็จ — userId อาจไม่ได้ Add friend bot') });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// === Test Admin Email (super_admin) ===
apiRouter.post('/test-admin-email', authenticateToken, isSuperAdmin, async (req, res) => {
    const { emails } = req.body;
    if (!emails) return res.status(400).json({ success: false, message: 'กรุณากรอก Email' });
    const list = emails.split(',').map(e => e.trim()).filter(Boolean);
    if (list.length === 0) return res.status(400).json({ success: false, message: 'ไม่มี Email ที่ถูกต้อง' });
    for (const email of list) {
        sendMail(email, '🔔 ทดสอบการแจ้งเตือน — ระบบ KPI สสจ.นครราชสีมา',
            `<div style="font-family:Sarabun,sans-serif;max-width:400px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:#16a34a;padding:16px;text-align:center;color:white"><h3 style="margin:0">🔔 ทดสอบการแจ้งเตือน</h3></div>
                <div style="padding:20px;text-align:center"><p>การเชื่อมต่อ Email สำเร็จ!</p><p style="color:#6b7280;font-size:13px">ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา</p></div>
            </div>`
        );
    }
    res.json({ success: true, message: `ส่ง Email ทดสอบไปที่ ${list.length} ที่อยู่แล้ว` });
});

module.exports = { getLineProfile };
