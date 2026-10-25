// งานเบื้องหลัง: ตารางเวลา Export อัตโนมัติ (ตรวจทุก 30 วินาที) + แจ้งผล — เริ่มจาก server.js เฉพาะตอนรันจริง (require.main)
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const { checkKpiChanges, performKpiExport } = require('../services/export');
const { getNotifSettings, sendLineMulticast, sendMail, sendTelegramDirect } = require('../core/notify');
const { performSyncToKhd } = require('../services/khd');

// ========== Export Scheduler (run automatically) ==========

// ส่ง notification (email + telegram) หลัง export เสร็จ
async function sendExportNotification(schedule, result, durationMs) {
    const summary = result.summary || { inserted: 0, updated: 0, unchanged: 0, no_data: 0 };
    const tablesCount = (result.created_tables || []).length;
    const subject = `[Korat Health KPI] รายงาน Export อัตโนมัติ — ${schedule.name}`;

    const allTables = result.created_tables || [];
    const tablesHtml = allTables.slice(0, 100).map(t => {
        const isUpdated = (t.inserted || 0) > 0 || (t.updated || 0) > 0;
        const statusIcon = isUpdated
            ? '<span style="color:#16a34a">✓ อัปเดต</span>'
            : '<span style="color:#6b7280">= ไม่เปลี่ยน</span>';
        return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px">${t.table}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center;font-size:11px">${statusIcon}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">+${t.inserted || 0}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">~${t.updated || 0}</td>
         <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:center">=${t.unchanged || 0}</td></tr>`;
    }).join('');
    const tablesMore = allTables.length > 100 ? `<p style="color:#6b7280;font-size:11px;margin-top:4px">... และอีก ${allTables.length - 100} ตาราง</p>` : '';

    // Sync-to-KHD summary (ถ้ามี)
    const sync = result.sync;
    const syncHtml = sync ? `
        <div style="margin-top:16px;padding:14px;border-radius:10px;background:${sync.success ? '#ecfdf5' : '#fef2f2'};border-left:4px solid ${sync.success ? '#10b981' : '#ef4444'}">
          <h3 style="margin:0 0 8px;color:${sync.success ? '#065f46' : '#991b1b'};font-size:14px">
            ${sync.success ? '☁️ Sync ไปยัง KHD สำเร็จ' : '⚠️ Sync ไปยัง KHD ผิดพลาดบางส่วน'}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:10px 0">
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#065f46">${sync.summary.success}</div><div style="font-size:10px;color:#065f46">สำเร็จ</div></div>
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#991b1b">${sync.summary.error}</div><div style="font-size:10px;color:#991b1b">ผิดพลาด</div></div>
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#6b7280">${sync.summary.skipped}</div><div style="font-size:10px;color:#6b7280">ข้าม</div></div>
            <div style="background:white;padding:8px;border-radius:6px;text-align:center"><div style="font-size:16px;font-weight:bold;color:#1e40af">${sync.summary.rows}</div><div style="font-size:10px;color:#1e40af">rows</div></div>
          </div>
          ${(sync.results || []).filter(r => r.status === 'error').slice(0, 10).map(r => `<div style="font-size:11px;color:#991b1b;margin-top:4px">✗ <b>${r.table}</b>: ${r.reason}</div>`).join('')}
        </div>` : '';

    const html = `
    <div style="font-family:'Sarabun',Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:linear-gradient(135deg,#065f46,#16a34a);color:white;padding:20px;border-radius:12px 12px 0 0">
        <h2 style="margin:0">📊 รายงาน Export KPI อัตโนมัติ</h2>
        <p style="margin:4px 0 0;opacity:.85;font-size:13px">${schedule.name} — ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}</p>
      </div>
      <div style="background:white;padding:20px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
        <p style="margin:0 0 12px"><b>สถานะ:</b> ${result.success ? '<span style="color:#16a34a">✓ สำเร็จ</span>' : '<span style="color:#dc2626">✗ ผิดพลาด</span>'}</p>
        <p style="margin:0 0 12px"><b>ใช้เวลา:</b> ${(durationMs/1000).toFixed(1)} วินาที</p>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0">
          <div style="background:#dbeafe;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#1e40af">${summary.inserted}</div><div style="font-size:11px;color:#1e40af">เพิ่มใหม่</div></div>
          <div style="background:#fed7aa;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#c2410c">${summary.updated}</div><div style="font-size:11px;color:#c2410c">อัปเดต</div></div>
          <div style="background:#f3f4f6;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#4b5563">${summary.unchanged}</div><div style="font-size:11px;color:#4b5563">ไม่เปลี่ยน</div></div>
          <div style="background:#fef3c7;padding:12px;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:bold;color:#a16207">${tablesCount}</div><div style="font-size:11px;color:#a16207">ตาราง</div></div>
        </div>
        ${tablesHtml ? `<h3 style="margin:16px 0 8px;color:#374151;font-size:14px">📋 รายการตารางที่ส่งออก (${tablesCount}):</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="background:#f9fafb">
          <th style="padding:6px 8px;text-align:left">ตาราง</th>
          <th style="padding:6px 8px;text-align:center">สถานะ</th>
          <th style="padding:6px 8px;text-align:center">เพิ่ม</th>
          <th style="padding:6px 8px;text-align:center">อัปเดต</th>
          <th style="padding:6px 8px;text-align:center">เดิม</th>
        </tr></thead><tbody>${tablesHtml}</tbody></table>${tablesMore}` : ''}
        ${syncHtml}
        <div style="background:#fef9c3;border-left:4px solid #eab308;padding:12px;margin-top:16px;border-radius:4px">
          <p style="margin:0;color:#713f12;font-size:13px">
            ${sync
              ? `📬 ระบบส่งข้อมูลเข้า KHD เรียบร้อยแล้ว — กรุณาตรวจสอบที่ <a href="https://apikorat.moph.go.th/khupskpi/">Korat Health KPI</a>`
              : `⚠️ <b>กรุณาตรวจสอบผลก่อนส่งไปยัง KHD</b> โดยเข้าระบบที่ <a href="https://apikorat.moph.go.th/khupskpi/">Korat Health KPI</a> → จัดการข้อมูล KPI → Tab "Export ข้อมูล"`}
          </p>
        </div>
      </div>
    </div>`;

    // ดึง recipients จาก system_settings (ไม่ใช่จาก schedule)
    const ns = await getNotifSettings();
    let sentEmail = false, sentTelegram = false, sentLine = false;

    if (Number(schedule.notify_email) === 1 && ns.adminEmails) {
        const recipients = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of recipients) {
            try { await sendMail(email, subject, html); sentEmail = true; } catch (e) {}
        }
    }
    if (Number(schedule.notify_telegram) === 1 && ns.tgToken && ns.tgChatId) {
        const chatIds = ns.tgChatId.split(',').map(c => c.trim()).filter(Boolean);
        const syncBlock = sync
          ? `\n☁️ *Sync ไปยัง KHD:*\n` +
            `• ${sync.success ? 'สำเร็จ' : 'มีข้อผิดพลาด'}: *${sync.summary.success}/${sync.summary.total}* ตาราง\n` +
            `• Rows: *${sync.summary.rows}*\n` +
            (sync.summary.error > 0 ? `• ผิดพลาด: *${sync.summary.error}*\n` : '')
          : '';
        // รายการตาราง (top 20 — กัน Telegram message limit 4096 char)
        const topTables = allTables.slice(0, 20);
        const tablesBlock = topTables.length > 0
          ? `\n📋 *รายการตารางที่ส่งออก:*\n` + topTables.map(t => {
              const isUpdated = (t.inserted || 0) > 0 || (t.updated || 0) > 0;
              const icon = isUpdated ? '✓' : '=';
              return `${icon} \`${t.table}\` (+${t.inserted || 0}/~${t.updated || 0}/=${t.unchanged || 0})`;
            }).join('\n') + (allTables.length > 20 ? `\n... และอีก ${allTables.length - 20} ตาราง` : '')
          : '';
        const footer = sync ? '\n\n📬 ข้อมูลถูกส่งเข้า KHD แล้ว' : '\n\n⚠️ กรุณาตรวจสอบก่อนส่ง KHD';
        const tgMsg = `📊 *รายงาน Export KPI — ${schedule.name}*\n\n` +
            `สถานะ: ${result.success ? '✅ สำเร็จ' : '❌ ผิดพลาด'}\n` +
            `⏱ เวลา: ${(durationMs/1000).toFixed(1)} วินาที\n\n` +
            `📋 สรุปผล:\n` +
            `• เพิ่มใหม่: *${summary.inserted}*\n` +
            `• อัปเดต: *${summary.updated}*\n` +
            `• ไม่เปลี่ยน: *${summary.unchanged}*\n` +
            `• ตารางทั้งหมด: *${tablesCount}*\n` +
            syncBlock +
            tablesBlock +
            footer;
        for (const chatId of chatIds) {
            try { await sendTelegramDirect(ns.tgToken, chatId, tgMsg); sentTelegram = true; } catch (e) {}
        }
    }

    // LINE (ใช้ข้อความเดียวกับ Telegram — สั้นกะทัดรัด)
    if (Number(schedule.notify_line) === 1 && ns.lineToken && ns.lineGroupId) {
        try {
            // สร้าง message สั้นๆ (ไม่มี markdown ไม่ใช้)
            const lineMsg = `📊 Export KPI — ${schedule.name}\n` +
                `สถานะ: ${result.success ? '✅ สำเร็จ' : '❌ ผิดพลาด'}\n` +
                `⏱ ${(durationMs/1000).toFixed(1)} วินาที\n\n` +
                `📋 สรุปผล:\n` +
                `• เพิ่มใหม่: ${summary.inserted}\n` +
                `• อัปเดต: ${summary.updated}\n` +
                `• ไม่เปลี่ยน: ${summary.unchanged}\n` +
                `• ตารางทั้งหมด: ${tablesCount}\n` +
                (sync ? `\n☁️ Sync KHD:\n• ${sync.success ? 'สำเร็จ' : 'ผิดพลาด'}: ${sync.summary.success}/${sync.summary.total} ตาราง\n• Rows: ${sync.summary.rows}` : '') +
                (sync ? '\n\n📬 ข้อมูลถูกส่งเข้า KHD แล้ว' : '\n\n⚠️ กรุณาตรวจสอบก่อนส่ง KHD');
            const r = await sendLineMulticast(ns.lineToken, ns.lineGroupId, lineMsg);
            sentLine = r.sent > 0;
        } catch (e) { console.error('[Schedule] LINE send error:', e.message); }
    }

    // Append "สถานะการส่งรายงาน" footer ใน HTML — แต่ส่งหลังจาก email/telegram เสร็จแล้ว
    // (ไม่ส่ง email อีกครั้งเพื่อแจ้ง — เก็บใน return value แทน)
    return { sentEmail, sentTelegram, sentLine };
}

// รันตาม schedule
async function runScheduledExport(schedule) {
    const startTime = Date.now();
    let result, status = 'success', errorMsg = null;
    try {
        const year_bh = schedule.year_bh || String(new Date().getFullYear() + 543);
        const scope = schedule.indicator_scope || 'all';
        let indicator_ids = 'all';

        if (scope === 'changes_only') {
            // ตรวจสอบก่อน — export เฉพาะตัวชี้วัดที่มีข้อมูลเพิ่ม/แก้ไข
            const check = await checkKpiChanges(year_bh, 'all');
            if (!check.success) {
                result = { success: false, message: check.message, summary: { inserted: 0, updated: 0, unchanged: 0, no_data: 0 }, created_tables: [], skipped: [] };
                status = 'failed'; errorMsg = check.message;
            } else {
                const changedIds = (check.details || []).filter(d => d.status === 'has_changes').map(d => d.id);
                if (changedIds.length === 0) {
                    result = { success: true, message: 'ไม่มีตัวชี้วัดที่มีการเปลี่ยนแปลง — ข้าม export', summary: { inserted: 0, updated: 0, unchanged: 0, no_data: 0 }, created_tables: [], skipped: [] };
                } else {
                    indicator_ids = changedIds;
                }
            }
        } else if (scope === 'selected') {
            indicator_ids = schedule.indicator_ids ? JSON.parse(schedule.indicator_ids) : 'all';
        }

        if (!result) {
            result = await performKpiExport(year_bh, indicator_ids, schedule.created_by);
            if (!result.success) { status = 'failed'; errorMsg = result.message; }
        }

        // Auto-sync to KHD ถ้า export สำเร็จและมีตารางและเปิด auto_sync_khd
        if (Number(schedule.auto_sync_khd) === 1 && result.success && (result.created_tables || []).length > 0) {
            try {
                const syncTables = result.created_tables.map(t => ({ table: t.table, sync_columns: null }));
                const syncOut = await performSyncToKhd(syncTables, schedule.created_by);
                result.sync = syncOut;
                if (!syncOut.success) { status = 'partial'; errorMsg = 'Export สำเร็จแต่ sync KHD มีข้อผิดพลาด'; }
            } catch (e) {
                result.sync = { success: false, message: e.message, summary: { total: 0, success: 0, error: 0, skipped: 0, rows: 0 }, results: [] };
                status = 'partial'; errorMsg = `Sync KHD failed: ${e.message}`;
            }
        }
    } catch (e) {
        result = { success: false, message: e.message };
        status = 'failed'; errorMsg = e.message;
    }
    const duration = Date.now() - startTime;

    // ส่ง notification
    let notif = { sentEmail: false, sentTelegram: false, sentLine: false };
    try { notif = await sendExportNotification(schedule, result, duration); } catch (_) {}

    // อัปเดต last_run + log
    await db.query('UPDATE export_schedules SET last_run_at=NOW(), last_status=? WHERE id=?', [status, schedule.id]);
    const summary = result.summary || { inserted: 0, updated: 0, unchanged: 0, no_data: 0 };
    await db.query(
        `INSERT INTO export_schedule_logs (schedule_id, status, inserted, updated_count, unchanged, no_data, tables_count, skipped_count, duration_ms, notified_email, notified_telegram, notified_line, error_msg)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [schedule.id, status, summary.inserted, summary.updated, summary.unchanged, summary.no_data,
         (result.created_tables || []).length, (result.skipped || []).length, duration,
         notif.sentEmail ? 1 : 0, notif.sentTelegram ? 1 : 0, notif.sentLine ? 1 : 0, errorMsg]
    );
    return result;
}

// Scheduler loop: ตรวจทุก 30 วินาที + match 2 นาทีย้อนหลัง กันพลาด (dedup ด้วย last_run_at>120s)
function startExportScheduler() {
    const pad2 = (n) => String(n).padStart(2, '0');
    // ใช้ Intl.DateTimeFormat บังคับเวลา Bangkok ไม่ขึ้นกับ process.env.TZ (กันบาง env ที่ V8 cache TZ ผิด)
    const bkkFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Bangkok',
        hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
    });
    const getBkk = (date) => {
        const parts = bkkFormatter.formatToParts(date);
        const get = (t) => parts.find(p => p.type === t)?.value || '';
        const hour = get('hour') === '24' ? '00' : get('hour');
        const wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
        return { hhmm: `${hour}:${get('minute')}`, dow: wdMap[get('weekday')] || 1 };
    };
    const check = async () => {
        try {
            const now = new Date();
            const bkkNow = getBkk(now);
            const hhmmNow = bkkNow.hhmm;
            const prev = new Date(now.getTime() - 60 * 1000);
            const hhmmPrev = getBkk(prev).hhmm;
            const dow = bkkNow.dow; // 1=จ., 7=อา.

            // ดึง schedules ที่ตรงเวลา (current หรือนาทีก่อน) และยังไม่ได้รันในช่วง 120s
            const [schedules] = await db.query(
                `SELECT * FROM export_schedules WHERE is_enabled=1
                 AND time_of_day IN (?, ?)
                 AND (last_run_at IS NULL OR TIMESTAMPDIFF(SECOND, last_run_at, NOW()) > 120)`,
                [hhmmNow, hhmmPrev]
            );
            if (schedules.length === 0) return;

            for (const s of schedules) {
                const days = (s.days_of_week || '').split(',').map(d => parseInt(d.trim(), 10)).filter(n => !isNaN(n));
                if (!days.includes(dow)) {
                    console.log(`[Scheduler] Skip "${s.name}" — วันนี้ (${dow}) ไม่อยู่ใน days [${days.join(',')}]`);
                    continue;
                }
                console.log(`[Scheduler] 🚀 Running "${s.name}" (time=${s.time_of_day}, now=${hhmmNow}, dow=${dow})`);
                // Lock ทันทีโดย update last_run_at ก่อน execute กัน double-run จาก overlapping ticks
                try {
                    await db.query('UPDATE export_schedules SET last_run_at=NOW() WHERE id=?', [s.id]);
                } catch (e) {}
                runScheduledExport(s).catch(e => console.error(`[Scheduler] "${s.name}" Error:`, e.message));
            }
        } catch (e) {
            console.error('[Scheduler] check() failed:', e.message);
        }
    };

    // รันครั้งแรกทันที (กันกรณี server start ตอนใกล้เวลา schedule)
    check().catch(e => console.error('[Scheduler] initial check failed:', e.message));
    // ตรวจทุก 30 วินาที (1 นาที จะได้ตรวจ 2 ครั้ง → ลดโอกาสพลาด)
    setInterval(check, 30000);
    const initBkk = getBkk(new Date());
    console.log(`[Scheduler] Export scheduler started — Bangkok time: ${initBkk.hhmm} (dow=${initBkk.dow}), check every 30s`);
}

module.exports = { sendExportNotification, runScheduledExport, startExportScheduler };
