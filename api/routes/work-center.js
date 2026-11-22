// เส้นทาง: ศูนย์งานผู้ดูแล (ระยะ 4 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
// หน้าเดียวบอกผู้ดูแลว่า "อะไรรออนุมัติ / ใครยังไม่ส่งเดือนนี้ / อะไรผิดปกติ / ส่ง KHD ล่าสุดเมื่อไร" ตามขอบเขตสิทธิ์
// PAGE_ACCESS_RULES prefix /work-center/ → pageKey work-center (ค่าตั้งต้น: ผู้ดูแลทุกระดับ) — การอนุมัติ/ส่งกลับใช้ /approve-kpi, /reject-kpi เดิม (ด่านเดิม)
// ตั้งค่า/สั่งส่งเตือน + คุณภาพข้อมูล + สถานะ KHD = super_admin แบบเข้ม (ไม่ขยายผ่านสิทธิ์หน้า)

const db = require('../db');
const { apiRouter } = require('../core/router');
const { authenticateToken, requireSuperAdminStrict } = require('../core/auth');
const { ROLE_ADMIN_CENTRAL } = require('../core/access');
const wc = require('../services/work-center');
const { chartScopeClauses } = require('../services/report-scope');
const { scanDataQuality } = require('../services/data-quality');
const { getKhdSendPolicy } = require('../services/khd-policy');
const { listRuns, khdSyncBusyInfo } = require('../services/khd-sync');
const { runResultReminders, saveLastRun } = require('../jobs/result-reminder');
const { findLockedFutureMonths, summarizeLockedFuture, unlockFutureMonths } = require('../services/unlock-future');
const { scheduleSummaryRefresh } = require('../services/summary');

/** ปีงบ/เดือนจาก query — ไม่ส่ง = เดือนที่ควรส่งผลงานแล้ว (เดือนก่อนหน้า) */
function periodOf(q) {
    const def = wc.defaultTargetMonth();
    const year = q.year_bh === undefined || q.year_bh === '' ? def.year_bh : String(q.year_bh);
    const month = q.month_bh === undefined || q.month_bh === '' ? def.month_bh : Number(q.month_bh);
    if (!/^\d{4}$/.test(year)) return { error: 'ปีงบประมาณต้องเป็นตัวเลข 4 หลัก' };
    if (!Number.isInteger(month) || month < 1 || month > 12) return { error: 'เดือนต้องเป็น 1–12' };
    return { year, month };
}

apiRouter.get('/work-center/summary', authenticateToken, async (req, res) => {
    const per = periodOf(req.query);
    if (per.error) return res.status(400).json({ success: false, message: per.error });
    try {
        const user = req.user;
        const cfg = await wc.getReminderSettings();
        const due = wc.dueDateOf(per.year, per.month, cfg.reminder_due_day);
        const scope = await chartScopeClauses(user);
        const [review, missing] = await Promise.all([
            wc.reviewCounts(user, per.year, scope),
            wc.findMissingPairs(user, per.year, per.month),
        ]);
        const data = {
            year_bh: per.year, month_bh: per.month, month_label: wc.monthLabel(per.year, per.month),
            due_date: due, due_text: wc.thaiDateText(due), days_left: wc.daysUntil(due),
            can_review: ROLE_ADMIN_CENTRAL.includes(user.role), is_super_admin: user.role === 'super_admin',
            review,
            missing: {
                pairs: missing.pairs.length,
                hospitals: new Set(missing.pairs.map(p => p.hospcode)).size,
                indicators: new Set(missing.pairs.map(p => p.indicator_id)).size,
            },
            reminder: { enabled: cfg.reminder_enabled, due_day: cfg.reminder_due_day, last_run: cfg.last_run },
            khd: null,
        };
        if (user.role === 'super_admin') {
            const [last] = await listRuns(1);
            data.khd = { policy: await getKhdSendPolicy(), last_run: last || null, busy: khdSyncBusyInfo() };
        }
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/work-center/review-queue', authenticateToken, async (req, res) => {
    const per = periodOf({ year_bh: req.query.year_bh });
    if (per.error) return res.status(400).json({ success: false, message: per.error });
    try {
        const out = await wc.reviewQueue(per.year, await chartScopeClauses(req.user));
        res.json({ success: true, year_bh: per.year, ...out });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

apiRouter.get('/work-center/missing', authenticateToken, async (req, res) => {
    const per = periodOf(req.query);
    if (per.error) return res.status(400).json({ success: false, message: per.error });
    const group = req.query.group === 'indicator' ? 'indicator' : 'hospital';
    try {
        res.json({ success: true, data: await wc.missingReport(req.user, per.year, per.month, group) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// คุณภาพข้อมูล (ตรวจแบบกฎ ไม่ใช้ AI — ตัวเดียวกับหน้าจัดการข้อมูลผลงาน) แคช 10 นาทีต่อปีงบ
const _dqCache = new Map();
apiRouter.get('/work-center/data-quality', authenticateToken, requireSuperAdminStrict, async (req, res) => {
    const per = periodOf({ year_bh: req.query.year_bh });
    if (per.error) return res.status(400).json({ success: false, message: per.error });
    try {
        const hit = _dqCache.get(per.year);
        if (hit && Date.now() - hit.at < 600000 && req.query.refresh !== '1') return res.json({ success: true, data: hit.data, cached: true });
        const r = await scanDataQuality(per.year);
        const data = { year_bh: r.year_bh, scanned: r.scanned, counts: r.counts, total: r.total, by_indicator: r.by_indicator, issues: r.issues.slice(0, 20) };
        _dqCache.set(per.year, { at: Date.now(), data });
        res.json({ success: true, data });
    } catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
});

apiRouter.get('/work-center/reminder-settings', authenticateToken, async (req, res) => {
    try { res.json({ success: true, data: await wc.getReminderSettings() }); } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
apiRouter.put('/work-center/reminder-settings', authenticateToken, requireSuperAdminStrict, async (req, res) => {
    const v = wc.validateReminderSettings(req.body);
    if (v.error) return res.status(400).json({ success: false, message: v.error });
    try {
        await wc.saveSettings(v.values);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'RESULT_REMINDER_SETTINGS', 'system_settings', JSON.stringify(v.values), req.ip]).catch(() => {});
        res.json({ success: true, data: await wc.getReminderSettings(), message: 'บันทึกการตั้งค่าแจ้งเตือนแล้ว' });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ดูตัวอย่าง / ส่งเตือนทันที (สั่งเอง = ครั้งเดียวต่อวันต่อเดือนผลงาน — กันกดซ้ำ)
const reminderHandler = (preview) => async (req, res) => {
    const per = periodOf(req.body || {});
    if (per.error) return res.status(400).json({ success: false, message: per.error });
    try {
        const out = await runResultReminders({ yearBh: per.year, monthBh: per.month, preview });
        if (!preview) {
            await saveLastRun(out, true);
            await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
                [req.user.userId, 'RESULT_REMINDER_SEND', 'notifications', JSON.stringify({ ...out, sample: undefined }), req.ip]).catch(() => {});
        }
        res.json({ success: true, data: out });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
};
apiRouter.post('/work-center/reminders/preview', authenticateToken, requireSuperAdminStrict, reminderHandler(true));
apiRouter.post('/work-center/reminders/send-now', authenticateToken, requireSuperAdminStrict, reminderHandler(false));

// ปลดล็อคเดือนที่ยังไม่มีผลงานหลังเดือนล่าสุด (คู่ที่อนุมัติทั้งปีตามระบบเดิม — ก่อนมีการอนุมัติรายเดือน)
// ดูตัวอย่างก่อนเสมอ แล้วพิมพ์ปีงบยืนยัน — server คำนวณรายการใหม่เองตอนปลดล็อค (ไม่รับรายการจาก client)
apiRouter.get('/work-center/locked-future', authenticateToken, requireSuperAdminStrict, async (req, res) => {
    const per = periodOf({ year_bh: req.query.year_bh });
    if (per.error) return res.status(400).json({ success: false, message: per.error });
    try {
        const pairs = await findLockedFutureMonths(per.year);
        res.json({ success: true, data: await summarizeLockedFuture(per.year, pairs) });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
apiRouter.post('/work-center/unlock-future-months', authenticateToken, requireSuperAdminStrict, async (req, res) => {
    const per = periodOf({ year_bh: req.body && req.body.year_bh });
    if (per.error) return res.status(400).json({ success: false, message: per.error });
    if (String((req.body && req.body.confirm) || '').trim() !== per.year) {
        return res.status(400).json({ success: false, code: 'CONFIRM_REQUIRED', message: `กรุณาพิมพ์ปีงบ ${per.year} เพื่อยืนยัน` });
    }
    try {
        const out = await unlockFutureMonths(per.year);
        await db.query('INSERT INTO system_logs (user_id, action_type, table_name, new_value, ip_address) VALUES (?, ?, ?, ?, ?)',
            [req.user.userId, 'UNLOCK_FUTURE_MONTHS', 'kpi_results', JSON.stringify({ year_bh: per.year, pairs: out.pairs, months: out.months, hospitals: out.hospitals }), req.ip]).catch(() => {});
        if (out.indicator_years.length) scheduleSummaryRefresh(out.indicator_years);
        res.json({ success: true, data: { year_bh: per.year, pairs: out.pairs, months: out.months, hospitals: out.hospitals },
            message: `ปลดล็อค ${out.months} เดือน ของ ${out.pairs} คู่ (${out.hospitals} หน่วยบริการ) — หน่วยบริการบันทึกเดือนเหล่านี้ได้แล้ว` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
