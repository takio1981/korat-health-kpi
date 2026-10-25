// งานเบื้องหลัง: สรุปการบันทึก KPI ส่งแจ้งเตือนตามรอบ (runKpiAuditDigest) + ตัวตั้งเวลา — เริ่มจาก server.js เฉพาะตอนรันจริง (require.main)
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const { bangkokTimestamp } = require('../services/backup');
const { getAuditSettings, invalidateAuditSettingsCache } = require('../services/kpi-audit');
const { getNotifSettings, sendLineMulticast, sendMail, sendTelegramDirect } = require('../core/notify');

// ===== Daily digest function =====
async function runKpiAuditDigest(manual = false) {
    const cfg = await getAuditSettings();
    if (!manual && !cfg.digestEnabled) return { skipped: true, reason: 'digest_disabled' };

    // ดึงรายการที่ยัง notified_at IS NULL
    const [records] = await db.query(`
        SELECT * FROM kpi_save_audit
        WHERE notified_at IS NULL
        ORDER BY created_at ASC
    `);
    if (records.length < cfg.minRecords) {
        return { skipped: true, reason: 'below_minimum', records_count: records.length, min: cfg.minRecords };
    }

    // Group by user
    const byUser = new Map();
    for (const r of records) {
        const key = r.user_id || 'unknown';
        if (!byUser.has(key)) {
            byUser.set(key, {
                user_id: r.user_id,
                full_name: r.full_name || r.username || 'Unknown',
                dept_name: r.dept_name || '-',
                hospname: r.hospname || '-',
                kpi_count: 0, sub_count: 0, dynamic_count: 0,
                indicators: new Map(),
                first_at: r.created_at, last_at: r.created_at
            });
        }
        const u = byUser.get(key);
        if (r.action_type === 'kpi_results') u.kpi_count += r.row_count || 1;
        else if (r.action_type === 'sub_results' || r.action_type === 'hierarchy_results') u.sub_count += r.row_count || 1;
        else if (r.action_type === 'dynamic_form') u.dynamic_count += r.row_count || 1;
        if (r.indicator_name) {
            const k = r.indicator_name;
            u.indicators.set(k, (u.indicators.get(k) || 0) + (r.row_count || 1));
        }
        if (new Date(r.created_at) > new Date(u.last_at)) u.last_at = r.created_at;
        if (new Date(r.created_at) < new Date(u.first_at)) u.first_at = r.created_at;
    }

    const usersList = Array.from(byUser.values()).sort((a, b) =>
        (b.kpi_count + b.sub_count + b.dynamic_count) - (a.kpi_count + a.sub_count + a.dynamic_count)
    );
    const totalSaves = records.length;
    const totalUsers = usersList.length;

    // Build messages
    const dateStr = bangkokTimestamp(new Date(), 'log').split(' ')[0];
    const subject = `📊 สรุปการบันทึกข้อมูล KPI ประจำวัน (${dateStr})`;

    // HTML email
    let html = `<h2>📊 สรุปการบันทึกข้อมูล KPI ประจำวัน</h2>`;
    html += `<p><b>วันที่:</b> ${dateStr}</p>`;
    html += `<p><b>ผู้ใช้งานที่บันทึก:</b> ${totalUsers} คน · <b>รายการบันทึกทั้งหมด:</b> ${totalSaves.toLocaleString()} รายการ</p>`;
    html += `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">`;
    html += `<thead style="background:#10b981;color:#fff"><tr>
        <th>#</th><th>ผู้ใช้</th><th>หน่วยงาน</th><th>หน่วยบริการ</th>
        <th>KPI หลัก</th><th>Sub</th><th>Dynamic Form</th><th>รวม</th>
    </tr></thead><tbody>`;
    usersList.forEach((u, i) => {
        const total = u.kpi_count + u.sub_count + u.dynamic_count;
        html += `<tr>
            <td>${i+1}</td>
            <td><b>${u.full_name}</b></td>
            <td>${u.dept_name}</td>
            <td>${u.hospname}</td>
            <td align="right">${u.kpi_count.toLocaleString()}</td>
            <td align="right">${u.sub_count.toLocaleString()}</td>
            <td align="right">${u.dynamic_count.toLocaleString()}</td>
            <td align="right"><b>${total.toLocaleString()}</b></td>
        </tr>`;
    });
    html += `</tbody></table>`;
    // Top indicators
    const allIndicators = new Map();
    for (const u of usersList) {
        for (const [ind, cnt] of u.indicators) {
            allIndicators.set(ind, (allIndicators.get(ind) || 0) + cnt);
        }
    }
    const topInd = Array.from(allIndicators.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (topInd.length > 0) {
        html += `<h3 style="margin-top:20px">🔝 ตัวชี้วัดที่ถูกบันทึกมากสุด (10 อันดับ)</h3>`;
        html += `<ol style="font-size:13px">`;
        for (const [ind, cnt] of topInd) html += `<li>${ind} — <b>${cnt.toLocaleString()}</b> ครั้ง</li>`;
        html += `</ol>`;
    }
    html += `<div style="margin-top:24px;padding:14px;background:#fef3c7;border-left:4px solid #f59e0b;color:#92400e;font-size:13px">
        💡 <b>แนะนำสำหรับ super_admin:</b> มีการบันทึกข้อมูลใหม่ ควรอัพเดทตาราง Export
        (เข้าหน้า "จัดการข้อมูล KPI" → Export Tables → กด "เริ่มสร้าง/อัพเดต")
    </div>`;

    // Telegram text
    let tg = `📊 <b>สรุปการบันทึก KPI ประจำวัน</b>\n📅 ${dateStr}\n\n`;
    tg += `👥 ผู้บันทึก: <b>${totalUsers}</b> คน\n📝 รายการ: <b>${totalSaves.toLocaleString()}</b> รายการ\n\n`;
    tg += `<b>Top ผู้บันทึก:</b>\n`;
    usersList.slice(0, 10).forEach((u, i) => {
        const total = u.kpi_count + u.sub_count + u.dynamic_count;
        tg += `${i+1}. ${u.full_name} (${u.hospname}) — <b>${total}</b>`;
        const parts = [];
        if (u.kpi_count) parts.push(`KPI:${u.kpi_count}`);
        if (u.sub_count) parts.push(`Sub:${u.sub_count}`);
        if (u.dynamic_count) parts.push(`Form:${u.dynamic_count}`);
        if (parts.length) tg += ` (${parts.join(', ')})`;
        tg += `\n`;
    });
    if (usersList.length > 10) tg += `... และอีก ${usersList.length - 10} คน\n`;
    if (topInd.length > 0) {
        tg += `\n<b>🔝 KPI ที่บันทึกมากสุด:</b>\n`;
        topInd.slice(0, 5).forEach(([ind, cnt], i) => { tg += `${i+1}. ${ind} (${cnt})\n`; });
    }
    tg += `\n💡 แนะนำ: อัพเดทตาราง Export`;

    // Send
    const ns = await getNotifSettings();
    let sentEmail = false, sentTelegram = false, sentLine = false;
    if (cfg.digestEmail && ns.adminEmails) {
        const emails = ns.adminEmails.split(',').map(e => e.trim()).filter(Boolean);
        for (const email of emails) {
            try { await sendMail(email, subject, html); sentEmail = true; } catch (e) {}
        }
    }
    if (cfg.digestTelegram && ns.tgToken && ns.tgChatId) {
        try { sentTelegram = await sendTelegramDirect(ns.tgToken, ns.tgChatId, tg); } catch (e) {}
    }
    if (cfg.digestLine && ns.lineToken && ns.lineGroupId) {
        try { const r = await sendLineMulticast(ns.lineToken, ns.lineGroupId, tg); sentLine = r.sent > 0; } catch (e) {}
    }

    // Mark records as notified
    const recordIds = records.map(r => r.id);
    if (recordIds.length > 0) {
        await db.query(`UPDATE kpi_save_audit SET notified_at = NOW() WHERE id IN (${recordIds.map(() => '?').join(',')})`, recordIds);
    }

    const summary = {
        total_users: totalUsers, total_saves: totalSaves,
        sent_email: sentEmail, sent_telegram: sentTelegram, sent_line: sentLine,
        date: dateStr, ran_at: new Date().toISOString(), manual
    };
    // บันทึก last digest
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('kpi_audit_last_digest_at', ?) ON DUPLICATE KEY UPDATE setting_value=?",
        [new Date().toISOString(), new Date().toISOString()]);
    await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('kpi_audit_last_digest_result', ?) ON DUPLICATE KEY UPDATE setting_value=?",
        [JSON.stringify(summary), JSON.stringify(summary)]);
    invalidateAuditSettingsCache(); // invalidate cache

    console.log(`[KPI Audit] digest sent — ${totalSaves} records / ${totalUsers} users (email:${sentEmail} tg:${sentTelegram})`);
    return summary;
}

// Scheduler — ตรวจทุก 30 วินาทีเหมือน backup scheduler
function startKpiAuditScheduler() {
    const pad2 = (n) => String(n).padStart(2, '0');
    const bkkFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const getHHMM = (date) => {
        const p = bkkFormatter.formatToParts(date);
        const h = p.find(x => x.type === 'hour')?.value;
        const m = p.find(x => x.type === 'minute')?.value;
        return `${h === '24' ? '00' : h}:${m}`;
    };
    let _lastDigestDateKey = null;
    const check = async () => {
        try {
            const cfg = await getAuditSettings();
            if (!cfg.digestEnabled) return;
            const now = new Date();
            const hhmm = getHHMM(now);
            const prev = getHHMM(new Date(now.getTime() - 60 * 1000));
            const todayKey = bangkokTimestamp(now, 'log').split(' ')[0];
            // match 2-min window
            if (hhmm !== cfg.digestTime && prev !== cfg.digestTime) return;
            if (_lastDigestDateKey === todayKey) return; // กัน double-run ใน 1 วัน
            _lastDigestDateKey = todayKey;
            console.log(`[KPI Audit] 🚀 daily digest triggered — ${todayKey} ${hhmm}`);
            runKpiAuditDigest(false).catch(e => console.error('[KPI Audit] digest error:', e.message));
        } catch (e) { console.error('[KPI Audit] check failed:', e.message); }
    };
    check().catch(() => {});
    setInterval(check, 30000);
    console.log(`[KPI Audit] scheduler started — daily digest check every 30s`);
}

module.exports = { runKpiAuditDigest, startKpiAuditScheduler };
