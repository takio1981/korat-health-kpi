// อนุมัติผู้สมัครใหม่อัตโนมัติตามเวลา + ส่งผู้ใช้ใหม่ขึ้น KHD อัตโนมัติ (13 พ.ย. 2569 — ผู้ใช้สั่ง)
// - อนุมัติอัตโนมัติ: ผู้ที่ลงทะเบียน/ถูกสร้างแบบรออนุมัติ "หลังเปิดใช้ระบบนี้" (มีแถวใน user_registrations) ทุกบทบาท
//   เมื่อครบเวลาหน่วงหลังลงทะเบียน (เช่น 5 นาที) — ผู้ที่รออยู่ก่อนหน้า (ไม่มีแถว) ยังต้องให้ผู้ดูแลอนุมัติเอง | แจ้ง super_admin ทุกครั้ง
// - ส่งขึ้น KHD: ทันทีหลังอนุมัติ (ทั้งคนกดและอัตโนมัติ) และตามรอบเวลารายวัน (ส่งซ้ำรายการที่ยังไม่สำเร็จ) — ใช้ syncUsersToKhd() ตัวเดียวกับปุ่ม Data Synchronization
const db = require('../db');
const { sendLineToUser, sendMail, notifyAdmins } = require('../core/notify');
const { syncUsersToKhd } = require('./users-khd-sync');

const KEYS = {
    autoApprove: 'user_auto_approve_enabled',
    delay: 'user_auto_approve_delay_min',
    syncOnApprove: 'user_khd_sync_on_approve',
    syncSchedule: 'user_khd_sync_schedule_enabled',
    syncTime: 'user_khd_sync_time',
    lastRun: 'user_approval_last_run',
    approveNotify: 'user_approval_notify',        // JSON {inapp,email,telegram,line} — แจ้ง super_admin เมื่ออนุมัติอัตโนมัติ (14 พ.ย. 2569)
    syncNotify: 'user_khd_sync_notify',           // JSON {inapp,email,telegram,line,failedOnly} — แจ้ง super_admin ผลการส่งขึ้น KHD
};
const CHANNELS = ['inapp', 'email', 'telegram', 'line'];
const DEFAULTS = {
    autoApprove: false, delay: 5, syncOnApprove: false, syncSchedule: false, syncTime: '02:00',
    // ค่าตั้งต้นการอนุมัติ = ทุกช่องทาง (พฤติกรรมเดิม 13 พ.ย. 2569) | การส่ง KHD = แจ้งในระบบเฉพาะเมื่อส่งไม่สำเร็จ
    approveNotify: { inapp: true, email: true, telegram: true, line: true },
    syncNotify: { inapp: true, email: false, telegram: false, line: false, failedOnly: true },
};
/** แปลง JSON ช่องทางแจ้งเตือน → object ครบทุกช่อง (ค่าที่ไม่มี = ค่าตั้งต้น) */
function parseNotify(raw, def) {
    let o = {};
    try { o = raw ? JSON.parse(raw) : {}; } catch (_) { o = {}; }
    const out = {};
    for (const k of Object.keys(def)) out[k] = typeof o[k] === 'boolean' ? o[k] : def[k];
    return out;
}
const MAX_DELAY_MIN = 10080;   // 7 วัน
const MAX_SYNC_ATTEMPTS = 20;  // ส่งซ้ำตามรอบได้ไม่เกินนี้ต่อผู้ใช้ (กันวนส่งรายการที่ผิดถาวร)

let _cache = null, _cacheAt = 0;
async function getUserApprovalSettings(force = false) {
    if (!force && _cache && Date.now() - _cacheAt < 60000) return _cache;
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [Object.values(KEYS)]);
    const m = new Map(rows.map(r => [r.setting_key, r.setting_value]));
    const on = (k, d) => (m.has(k) ? ['1', 'true'].includes(String(m.get(k))) : d);
    const delay = Number(m.get(KEYS.delay));
    const time = String(m.get(KEYS.syncTime) || '');
    _cache = {
        autoApprove: on(KEYS.autoApprove, DEFAULTS.autoApprove),
        delay: Number.isInteger(delay) && delay >= 1 && delay <= MAX_DELAY_MIN ? delay : DEFAULTS.delay,
        syncOnApprove: on(KEYS.syncOnApprove, DEFAULTS.syncOnApprove),
        syncSchedule: on(KEYS.syncSchedule, DEFAULTS.syncSchedule),
        syncTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : DEFAULTS.syncTime,
        approveNotify: parseNotify(m.get(KEYS.approveNotify), DEFAULTS.approveNotify),
        syncNotify: parseNotify(m.get(KEYS.syncNotify), DEFAULTS.syncNotify),
    };
    _cacheAt = Date.now();
    return _cache;
}
function invalidateUserApprovalSettings() { _cache = null; }

/** ตรวจค่าที่ส่งมาจากหน้าตั้งค่า — คืน { values, error } (ค่าที่ไม่ส่ง = คงเดิม) */
function parseSettingsInput(body) {
    const b = body || {};
    const out = {};
    for (const k of ['autoApprove', 'syncOnApprove', 'syncSchedule']) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== 'boolean') return { error: `ค่า ${k} ต้องเป็น true/false` };
        out[k] = b[k];
    }
    if (b.delay !== undefined) {
        const d = Number(b.delay);
        if (!Number.isInteger(d) || d < 1 || d > MAX_DELAY_MIN) return { error: `ระยะเวลาหลังลงทะเบียนต้องเป็นจำนวนเต็ม 1–${MAX_DELAY_MIN} นาที` };
        out.delay = d;
    }
    for (const k of ['approveNotify', 'syncNotify']) {
        if (b[k] === undefined) continue;
        if (!b[k] || typeof b[k] !== 'object' || Array.isArray(b[k])) return { error: `ค่า ${k} ต้องเป็นรายการช่องทาง` };
        const def = DEFAULTS[k], v = {};
        for (const [ck, cv] of Object.entries(b[k])) {
            if (!(ck in def)) return { error: `ช่องทาง ${ck} ไม่ถูกต้อง` };
            if (typeof cv !== 'boolean') return { error: `ค่าช่องทาง ${ck} ต้องเป็น true/false` };
            v[ck] = cv;
        }
        out[k] = v;
    }
    if (b.syncTime !== undefined) {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.syncTime))) return { error: 'เวลาส่งข้อมูลขึ้น KHD ต้องเป็นรูปแบบ HH:MM' };
        out.syncTime = String(b.syncTime);
    }
    return { values: out };
}
async function saveUserApprovalSettings(values) {
    const cur = await getUserApprovalSettings(true);
    for (const [k, v] of Object.entries(values)) {
        // ช่องทางแจ้งเตือน: รวมกับค่าเดิม (ส่งบางช่อง = ช่องที่ไม่ส่งคงเดิม) แล้วเก็บเป็น JSON
        const val = (k === 'approveNotify' || k === 'syncNotify') ? JSON.stringify({ ...cur[k], ...v })
            : typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
        await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [KEYS[k], val]);
    }
    invalidateUserApprovalSettings();
}

/** บันทึกเวลาลงทะเบียน (ผู้ใช้รออนุมัติที่สร้างใหม่) — จุดเริ่มนับเวลาอนุมัติอัตโนมัติ */
async function recordRegistration(userId, source) {
    try {
        await db.query('INSERT IGNORE INTO user_registrations (user_id, registered_at, source) VALUES (?, NOW(), ?)', [userId, String(source || '').slice(0, 20)]);
    } catch (e) { console.error('[UserApproval] recordRegistration failed:', e.message); }
}

/**
 * อนุมัติผู้ใช้ — ย้ายคำต่อคำจาก PUT /users/:id/approve (routes/users.js) ใช้ร่วมกับการอนุมัติอัตโนมัติ
 * approverId = null เมื่ออนุมัติอัตโนมัติ (system_logs action AUTO_APPROVE_USER)
 */
async function approveUser(target, { approverId = null, approverDeptId = null, ip = null, auto = false } = {}) {
    const userId = target.id;
    await db.query('UPDATE users SET is_approved = 1, approved_by = ? WHERE id = ? AND is_approved = 0', [approverId, userId]);

    await db.query(
        'INSERT INTO system_logs (user_id, dept_id, action_type, table_name, record_id, new_value, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [approverId, approverDeptId, auto ? 'AUTO_APPROVE_USER' : 'APPROVE_USER', 'users', userId, JSON.stringify({ username: target.username, approved_by: approverId, auto }), ip]
    );

    // LINE: แจ้งผลอนุมัติให้ผู้สมัคร
    sendLineToUser(userId,
        `✅ บัญชีของคุณได้รับการอนุมัติแล้ว\n` +
        `Username: ${target.username}\n\n` +
        `เข้าใช้งานระบบได้ที่:\nhttps://apikorat.moph.go.th/khupskpi/login`
    );

    // ส่ง Email แจ้งผลอนุมัติ
    if (target.email) {
        sendMail(target.email, '✅ บัญชีของคุณได้รับการอนุมัติแล้ว — ระบบ KPI สสจ.นครราชสีมา',
            `<div style="font-family:Sarabun,sans-serif;max-width:500px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
                <div style="background:linear-gradient(135deg,#16a34a,#22c55e);padding:24px;text-align:center;color:white">
                    <h2 style="margin:0;font-size:20px">✅ อนุมัติเรียบร้อยแล้ว</h2>
                </div>
                <div style="padding:24px">
                    <p>เรียน คุณ${target.firstname} ${target.lastname},</p>
                    <p>คำขอลงทะเบียนใช้งาน <b>ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา</b> ได้รับการ <span style="color:#16a34a;font-weight:bold">อนุมัติ</span> แล้ว</p>
                    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
                        <tr><td style="padding:6px 0;color:#6b7280">ชื่อผู้ใช้</td><td style="font-weight:bold">${target.username}</td></tr>
                        <tr><td style="padding:6px 0;color:#6b7280">สิทธิ์</td><td style="font-weight:bold">${target.role}</td></tr>
                    </table>
                    <p>คุณสามารถเข้าสู่ระบบได้ทันที</p>
                    <p style="color:#9ca3af;font-size:12px;margin-top:24px">อีเมลฉบับนี้ส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับ</p>
                </div>
            </div>`
        );
    }
}

/** ส่งผู้ใช้ขึ้น KHD แล้วบันทึกสถานะรายคน (user_khd_sync) — คืน { synced, failed, message } */
async function syncUsersAndRecord(users, { auto = true, source = 'approve' } = {}) {
    if (!users.length) return { synced: 0, failed: 0, message: 'ไม่มีผู้ใช้ที่ต้องส่ง' };
    const usernames = users.map(u => u.username);
    let r;
    try { r = await syncUsersToKhd({ usernames, auto }); } catch (e) { r = { status: 500, body: { success: false, message: e.message } }; }
    const failedSet = new Set(r.status >= 400 && !(r.failedUsernames || []).length ? usernames : (r.failedUsernames || []));
    const err = String(r.body?.message || 'ส่งไม่สำเร็จ').slice(0, 500);
    for (const u of users) {
        if (failedSet.has(u.username)) {
            await db.query(`INSERT INTO user_khd_sync (user_id, synced_at, last_error, attempts) VALUES (?, NULL, ?, 1)
                ON DUPLICATE KEY UPDATE last_error = VALUES(last_error), attempts = attempts + 1`, [u.id, err]);
        } else {
            await db.query(`INSERT INTO user_khd_sync (user_id, synced_at, last_error, attempts) VALUES (?, NOW(), NULL, 1)
                ON DUPLICATE KEY UPDATE synced_at = NOW(), last_error = NULL, attempts = attempts + 1`, [u.id]);
        }
    }
    const result = { synced: users.length - failedSet.size, failed: failedSet.size, message: r.body?.message || '' };
    result.notified = await notifySyncResult(users, result, failedSet, source).catch(e => { console.error('[UserApproval] sync notify failed:', e.message); return []; });
    return result;
}

/** หลังอนุมัติ (คนกด / สร้างผู้ใช้ที่อนุมัติแล้ว) — ส่งขึ้น KHD ทันทีถ้าเปิดไว้ (fire-and-forget ไม่ทำให้การอนุมัติช้า/ล้ม) */
function syncAfterApprove(userIds) {
    (async () => {
        const cfg = await getUserApprovalSettings();
        if (!cfg.syncOnApprove || !userIds.length) return;
        const [users] = await db.query('SELECT id, username FROM users WHERE id IN (?) AND is_approved = 1', [userIds]);
        await syncUsersAndRecord(users, { source: 'approve' });
    })().catch(e => console.error('[UserApproval] sync after approve failed:', e.message));
}

/**
 * อนุมัติผู้ที่ลงทะเบียนครบเวลาหน่วงแล้ว (ทุกบทบาท) — แจ้ง super_admin + ส่งขึ้น KHD ทันทีถ้าเปิดไว้
 * ปิดการอนุมัติอัตโนมัติอยู่ = ไม่อนุมัติใคร (คืน reason 'disabled') แม้เรียกจากปุ่ม "ตรวจตอนนี้"
 */
async function runAutoApprove() {
    const cfg = await getUserApprovalSettings(true);
    if (!cfg.autoApprove) return { approved: [], reason: 'disabled' };
    const [rows] = await db.query(
        `SELECT u.* FROM users u JOIN user_registrations r ON r.user_id = u.id
         WHERE u.is_approved = 0 AND r.auto_approved_at IS NULL AND r.registered_at <= NOW() - INTERVAL ? MINUTE
         ORDER BY r.registered_at LIMIT 200`, [cfg.delay]);
    const approved = [];
    for (const u of rows) {
        try {
            await approveUser(u, { auto: true });
            await db.query('UPDATE user_registrations SET auto_approved_at = NOW() WHERE user_id = ?', [u.id]);
            approved.push(u);
        } catch (e) { console.error('[UserApproval] auto approve failed:', u.username, e.message); }
    }
    if (approved.length) {
        await notifySuperAdmins(approved, cfg.delay, cfg.approveNotify);
        if (cfg.syncOnApprove) await syncUsersAndRecord(approved, { source: 'approve' }).catch(e => console.error('[UserApproval] sync failed:', e.message));
    }
    return { approved: approved.map(u => u.username) };
}

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * แจ้ง super_admin ตามช่องทางที่ตั้ง (14 พ.ย. 2569): inapp = แจ้งเตือนในระบบทุก super_admin | email/telegram/line = notifyAdmins() (ผู้รับตามหน้าตั้งค่าการแจ้งเตือนเดิม)
 * คืนรายชื่อช่องทางที่ส่ง (ใช้ในชุดทดสอบ/บันทึกผล)
 */
async function notifyChannels(ch, { title, msg, subject, html, text }) {
    const sent = [];
    if (ch.inapp) {
        const [admins] = await db.query("SELECT id FROM users WHERE role = 'super_admin' AND is_approved = 1 AND is_active = 1");
        for (const a of admins) {
            await db.query("INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'info', ?, ?)", [a.id, title, String(msg).slice(0, 1000)]).catch(() => {});
        }
        sent.push('inapp');
    }
    if (ch.email || ch.telegram || ch.line) {
        await notifyAdmins(subject, html, text, { email: !!ch.email, telegram: !!ch.telegram, line: !!ch.line })
            .catch(e => console.error('[UserApproval] notifyAdmins failed:', e.message));
        sent.push(...['email', 'telegram', 'line'].filter(k => ch[k]));
    }
    return sent;
}

async function notifySuperAdmins(users, delay, ch = DEFAULTS.approveNotify) {
    const list = users.map(u => `${u.firstname || ''} ${u.lastname || ''} (${u.username}) — ${u.role}${u.hospcode ? ' / ' + u.hospcode : ''}`.trim());
    return notifyChannels(ch, {
        title: 'อนุมัติผู้ใช้งานใหม่อัตโนมัติ',
        msg: `อนุมัติอัตโนมัติ ${users.length} บัญชี (ครบ ${delay} นาทีหลังลงทะเบียน): ${list.join(', ')}`,
        subject: '✅ อนุมัติผู้ใช้งานใหม่อัตโนมัติ — ระบบ KPI สสจ.นครราชสีมา',
        html: `<div style="font-family:Sarabun,sans-serif"><p>ระบบอนุมัติผู้ใช้งานใหม่อัตโนมัติ ${users.length} บัญชี (ครบ ${delay} นาทีหลังลงทะเบียน)</p><ul>${list.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
         <p style="color:#6b7280;font-size:12px">ตรวจสอบ/ปิดใช้งานบัญชีได้ที่หน้าจัดการผู้ใช้</p></div>`,
        text: `✅ อนุมัติผู้ใช้งานใหม่อัตโนมัติ ${users.length} บัญชี\n` + list.map(l => '• ' + l).join('\n'),
    });
}

const SYNC_SOURCE = { approve: 'หลังอนุมัติ', schedule: 'ตามรอบเวลา', manual: 'กดส่งเอง' };
/** แจ้ง super_admin ผลการส่งผู้ใช้ขึ้น KHD — failedOnly = แจ้งเฉพาะเมื่อมีรายการส่งไม่สำเร็จ */
async function notifySyncResult(users, result, failedSet, source) {
    const cfg = await getUserApprovalSettings();
    const ch = cfg.syncNotify;
    if (!CHANNELS.some(k => ch[k])) return [];
    if (ch.failedOnly && !result.failed) return [];
    const ok = users.filter(u => !failedSet.has(u.username)).map(u => u.username);
    const bad = users.filter(u => failedSet.has(u.username)).map(u => u.username);
    const head = `ส่งผู้ใช้ใหม่ขึ้น KHD (${SYNC_SOURCE[source] || source}): สำเร็จ ${result.synced} · ไม่สำเร็จ ${result.failed}`;
    const detail = [ok.length ? 'สำเร็จ: ' + ok.join(', ') : '', bad.length ? `ไม่สำเร็จ: ${bad.join(', ')} — ${result.message || ''}` : ''].filter(Boolean).join(' | ');
    return notifyChannels(ch, {
        title: result.failed ? 'ส่งผู้ใช้ใหม่ขึ้น KHD ไม่สำเร็จ' : 'ส่งผู้ใช้ใหม่ขึ้น KHD แล้ว',
        msg: `${head} — ${detail}`,
        subject: `${result.failed ? '⚠️' : '☁️'} ${head} — ระบบ KPI สสจ.นครราชสีมา`,
        html: `<div style="font-family:Sarabun,sans-serif"><p>${esc(head)}</p>${ok.length ? `<p>สำเร็จ: ${esc(ok.join(', '))}</p>` : ''}${bad.length ? `<p style="color:#dc2626">ไม่สำเร็จ: ${esc(bad.join(', '))}<br>${esc(result.message || '')}</p><p style="color:#6b7280;font-size:12px">ระบบจะส่งซ้ำตามรอบเวลาที่ตั้งไว้ หรือกด "ส่งผู้ใช้ใหม่ขึ้น KHD ตอนนี้" ในหน้าตั้งค่าระบบ</p>` : ''}</div>`,
        text: `${result.failed ? '⚠️' : '☁️'} ${head}\n${detail}`,
    });
}

/** ส่งขึ้น KHD ตามรอบ: ผู้ใช้ใหม่ที่อนุมัติแล้วแต่ยังส่งไม่สำเร็จ (ลงทะเบียนหลังเปิดระบบนี้ หรือเคยส่งแล้วล้ม) */
async function runScheduledKhdSync(source = 'schedule') {
    const [users] = await db.query(
        `SELECT u.id, u.username FROM users u
         LEFT JOIN user_registrations r ON r.user_id = u.id
         LEFT JOIN user_khd_sync s ON s.user_id = u.id
         WHERE u.is_approved = 1 AND (r.user_id IS NOT NULL OR s.user_id IS NOT NULL)
           AND (s.synced_at IS NULL) AND COALESCE(s.attempts, 0) < ?
         ORDER BY u.id LIMIT 500`, [MAX_SYNC_ATTEMPTS]);
    return syncUsersAndRecord(users, { source });
}

async function saveLastRun(info) {
    await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [KEYS.lastRun, JSON.stringify({ ...info, at: new Date().toISOString() })]).catch(() => {});
}
async function getStatus() {
    const [[pending]] = await db.query(`SELECT
        (SELECT COUNT(*) FROM users u JOIN user_registrations r ON r.user_id = u.id WHERE u.is_approved = 0 AND r.auto_approved_at IS NULL) AS waiting_auto,
        (SELECT COUNT(*) FROM users WHERE is_approved = 0) AS pending_all,
        (SELECT COUNT(*) FROM user_khd_sync WHERE synced_at IS NULL) AS khd_failed`);
    const [[lr]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [KEYS.lastRun]);
    let lastRun = null;
    try { lastRun = lr?.setting_value ? JSON.parse(lr.setting_value) : null; } catch (_) { lastRun = null; }
    return { ...pending, last_run: lastRun };
}

module.exports = {
    getUserApprovalSettings, invalidateUserApprovalSettings, parseSettingsInput, saveUserApprovalSettings,
    recordRegistration, approveUser, syncAfterApprove, syncUsersAndRecord, runAutoApprove, runScheduledKhdSync,
    saveLastRun, getStatus, notifySuperAdmins, notifySyncResult, MAX_DELAY_MIN, MAX_SYNC_ATTEMPTS, KEYS, DEFAULTS,
};
