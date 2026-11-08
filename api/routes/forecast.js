// ระบบเตือนล่วงหน้า (ข้อเสนอแนวคิด — 8 พ.ย. 2569) ระยะที่ 3: ตั้งค่าเกณฑ์เฝ้าระวัง + สรุปรายสัปดาห์ (หน้าตั้งค่าระบบ — super_admin)
// รายการตัวชี้วัดเสี่ยงอยู่ที่ GET /report/forecast (routes/reports.js) — ไฟล์นี้มีเฉพาะการตั้งค่าและการส่งสรุป
const { apiRouter } = require('../core/router');
const { authenticateToken, isSuperAdmin, saveLog } = require('../core/auth');
const { parseActiveFlag } = require('../core/validate');
const { getForecastSettings, saveForecastSetting } = require('../services/forecast');
const { runForecastDigest, getLastRun } = require('../jobs/forecast-digest');
const { forecastAiSummarizer } = require('../services/ai-forecast');

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
const DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

apiRouter.get('/forecast/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const s = await getForecastSettings(true);
        res.json({ success: true, data: { watch_pct: s.watchPct, digest_enabled: s.digestEnabled, digest_day: s.digestDay, digest_time: s.digestTime,
            digest_inapp: s.digestInapp, digest_email: s.digestEmail, digest_telegram: s.digestTelegram, digest_ai: s.digestAi }, last_run: await getLastRun() });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.put('/forecast/settings', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const b = req.body || {};
        const pct = Number(b.watch_pct);
        if (!Number.isFinite(pct) || pct < 1 || pct > 50) return res.status(400).json({ success: false, message: 'เกณฑ์เฝ้าระวังต้องอยู่ระหว่าง 1–50 (%)' });
        const day = Number(b.digest_day);
        if (!Number.isInteger(day) || day < 0 || day > 6) return res.status(400).json({ success: false, message: 'วันที่ส่งสรุปไม่ถูกต้อง' });
        const time = String(b.digest_time || '');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ success: false, message: 'เวลาที่ส่งสรุปต้องอยู่ในรูปแบบ HH:MM' });
        const flags = {};
        for (const k of ['digest_enabled', 'digest_inapp', 'digest_email', 'digest_telegram', 'digest_ai']) {
            const v = parseActiveFlag(b[k]);
            if (v === null) return res.status(400).json({ success: false, message: `กรุณาระบุค่า ${k}` });
            flags[k] = v;
        }
        await saveForecastSetting('forecast_watch_pct', String(pct));
        await saveForecastSetting('forecast_digest_day', String(day));
        await saveForecastSetting('forecast_digest_time', time);
        for (const [k, v] of Object.entries(flags)) await saveForecastSetting('forecast_' + k, v ? 'true' : 'false');
        await saveLog(req.user.username, 'FORECAST_SETTINGS_UPDATE',
            `ระบบเตือนล่วงหน้า: เฝ้าระวัง ≤ ${pct}% / สรุปรายสัปดาห์ ${flags.digest_enabled ? `เปิด (วัน${DAYS[day]} ${time})` : 'ปิด'}`, clientIp(req));
        res.json({ success: true, message: 'บันทึกการตั้งค่าระบบเตือนล่วงหน้าแล้ว' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ดูตัวอย่าง (preview = true ไม่ส่ง) / ส่งทันที — ไม่ขึ้นกับสวิตช์เปิด/ปิด
apiRouter.post('/forecast/digest/run', authenticateToken, isSuperAdmin, async (req, res) => {
    try {
        const preview = (req.body || {}).preview === true;
        const out = await runForecastDigest({ manual: true, preview, aiSummarize: forecastAiSummarizer(req.user.userId) });
        if (!preview && !out.skipped) await saveLog(req.user.username, 'FORECAST_DIGEST_RUN', `ส่งสรุปตัวชี้วัดเสี่ยง ปีงบ ${out.year_bh} (เสี่ยงสูง ${out.counts.high})`, clientIp(req));
        res.json({ success: true, ...out });
    } catch (e) {
        res.status(e.status || 500).json({ success: false, message: e.message });
    }
});
