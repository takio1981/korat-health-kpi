// KHUPS KPI API — จุดประกอบระบบ (composition root): สร้าง app + middleware, ลงทะเบียนเส้นทางตามลำดับ, mount, error handler, listen + งานเบื้องหลัง
// แยกเป็นโมดูลเมื่อ 25 ต.ค. 2569 (เดิม 17,388 บรรทัดในไฟล์นี้ไฟล์เดียว) — ดู CLAUDE.md หัวข้อ 3 "การแยก server.js เป็นโมดูล"
//   core/       ส่วนแกนกลาง (env, การแจ้งเตือน, error, ความปลอดภัย, สิทธิ์, ยืนยันตัวตน, ชิ้นส่วน SQL, router)
//   migrations/ สร้าง/ปรับตารางตอนเริ่มระบบ
//   services/   ตรรกะที่ใช้ร่วมหลายเส้นทาง
//   routes/     เส้นทาง API — ⚠️ ลำดับ require ด้านล่าง = ลำดับลงทะเบียนเส้นทาง (Express จับตามลำดับ) ตรวจด้วย tests/route-inventory.test.js
//   jobs/       งานเบื้องหลังตามเวลา (เริ่มเฉพาะตอนรันจริง)

// สภาพแวดล้อม (timezone, .env.dev, ตัวดัก error ระดับ process) — ต้องเป็น require แรก ก่อน require('./db')
const { port } = require('./core/env');
require('./db'); // สร้าง connection pool หลังโหลด env (ลำดับเดิม)

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { captureError } = require('./core/errors');
const { apiLimiter } = require('./core/security');
const { apiRouter } = require('./core/router');
const { loadSubAggregates, loadSubExportMonthMap } = require('./services/hierarchy');
const { scheduleSummaryRefresh, summaryRefreshIdle, refreshKpiSummaryForIndicatorYears } = require('./services/summary');
const { startBackupScheduler } = require('./services/backup');
const { startSessionCleanupJob } = require('./jobs/session-cleanup');
const { startExportScheduler } = require('./jobs/export-scheduler');
const { startKpiAuditScheduler } = require('./jobs/kpi-audit');

const app = express();

// Security Middleware
app.set('trust proxy', 1); // จำเป็นเมื่ออยู่หลัง Nginx Proxy เพื่อให้ Rate Limit ทำงานถูกต้องกับ IP จริง
app.use(helmet()); // เพิ่ม HTTP Headers เพื่อความปลอดภัย (XSS, Clickjacking, etc.)
// CORS — จำกัด origin เฉพาะ frontend ที่รู้จัก (กัน cross-origin API abuse)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_BASE_URL || '')
    .split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        // ยอมรับ request ที่ไม่มี origin (curl, server-to-server) และ origin ที่อยู่ใน allowlist
        if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        // อนุญาต localhost ทุก port สำหรับ development
        if (/^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
            return callback(null, true);
        }
        callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true
}));
app.use(express.json({
    limit: '50mb',
    // เก็บ raw body ไว้สำหรับ webhook ที่ต้อง verify signature (เช่น LINE)
    verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ===== เส้นทางก่อน rate limit ทั่วไป: เข้าสู่ระบบ/SSO/ลงทะเบียน/สาธารณะ (มีตัวจำกัดของตัวเอง) =====
const { handleThaidCallback, handleProviderIdCallback } = require('./routes/auth');

// - /authen/thaid/callback (ตรงกับที่ลงทะเบียน DGA: https://apikorat.moph.go.th/authen/thaid/callback)
//   ต้องเพิ่ม nginx: location /authen/ { proxy_pass http://backend:8830; ... }
app.get('/authen/thaid/callback', handleThaidCallback);
app.get('/authen/providerid/callback', handleProviderIdCallback);
app.get('/authen/healthid/callback', handleProviderIdCallback);

// /public/kpi-results และ /public/dashboard-stats ถูกลบแล้ว (7 ต.ค. 2569) — เดิมเปิดให้ดูผลงานทุกหน่วยบริการ
// โดยไม่ต้อง login และไม่ผ่าน rate limit (query ทั้งตาราง kpi_results ทุกครั้ง) — ผู้ใช้ยืนยันว่าไม่ต้องการหน้าสาธารณะ
// ห้ามเพิ่ม endpoint ข้อมูลผลงานแบบไม่ต้อง login กลับมาอีก

// ใช้ apiLimiter กับ Route ที่เหลือทั้งหมด (ป้องกันการยิง API รัวๆ) — เส้นทางที่ require หลังบรรทัดนี้ผ่าน rate limit
apiRouter.use(apiLimiter);

// ===== เส้นทางหลัก (ลำดับเดิมของไฟล์ก่อนแยก) =====
require('./routes/kpi-results');     // ผลงานตัวชี้วัด, เพิ่ม KPI จำนวนมาก, บันทึกผลงาน
require('./routes/forms');           // Form Builder + ข้อมูลแบบฟอร์มไดนามิก
require('./routes/dashboard');       // แม่แบบเพิ่มตัวชี้วัด, ตรวจตั้งค่าปีงบ, การ์ดสถิติ
require('./routes/monitoring');      // บันทึกการใช้งาน, error logs, ผู้ใช้งานออนไลน์
require('./routes/lookups');         // รายการอ้างอิงสำหรับตัวกรอง
require('./routes/users');           // จัดการผู้ใช้งาน (+ SSO/สถานะระบบ)
const { ensureUiPrefsTable } = require('./routes/settings-access'); // ตั้งค่าระบบ, สิทธิ์เข้าหน้า/เพิ่ม-แก้ไข, ค่าการแสดงผลส่วนตัว
require('./routes/indicators');      // ยุทธศาสตร์ หมวดหมู่หลัก ตัวชี้วัด ข้อย่อย กิจกรรม
require('./routes/approval');        // อนุมัติ/ปลดล็อค/อุทธรณ์/ขอแก้ไขเป้าหมาย
require('./routes/announcements');   // ประกาศระบบ
require('./routes/export');          // ส่งออกตาราง KPI, ตารางเวลา Export, Sync to KHD, อัปเดต Summary
require('./routes/reports');         // รายงานและกราฟ

// Migration ตอนเริ่มระบบ (ตารางหลัก + seed สิทธิ์ + SSO audit) — migrations/index.js (แยกจาก server.js 25 ต.ค. 2569 ระยะ 2)
const { migrationsReady } = require('./migrations');

// ========== Auto-create user_ui_prefs (ค่าการแสดงผลส่วนตัวต่อบัญชีผู้ใช้) ==========
ensureUiPrefsTable().catch(err => console.error('⚠️ user_ui_prefs setup error:', err.message));

require('./routes/review');          // ตีกลับ/ตอบกลับผลงาน
require('./routes/khd');             // เทียบตัวชี้วัดกับ KHD, ใช้เกณฑ์ KHD, จับคู่ข้อมูล KHD
require('./routes/feedback');        // กระดานข้อเสนอแนะ
require('./routes/db-sync');         // เทียบ/sync ฐานข้อมูล Local ↔ KHD + sync ผู้ใช้
require('./routes/integrations');    // ตั้งค่า env, ทดสอบการแจ้งเตือน, /me, LINE webhook
require('./routes/backup');          // สำรอง & กู้คืนข้อมูล
require('./routes/kpi-audit');       // แจ้งเตือนการบันทึก KPI

// Mount Router ที่ path /khupskpi/api
app.use('/khupskpi/api', apiRouter);


// Express error middleware — capture 500 errors ที่ไม่ได้ handle ใน route → error_logs + Telegram
// (ต้องอยู่หลัง mount router)
app.use((err, req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    captureError({
        source: 'http',
        severity: 'error',
        message: err?.message || String(err),
        stack: err?.stack || null,
        url: req.originalUrl,
        user_id: req.user?.userId || null,
        username: req.user?.username || null,
        user_agent: req.headers['user-agent'] || null,
        ip_address: ip,
        extra: { method: req.method }
    }).catch(() => {});
    res.status(err.status || 500).json({ success: false, message: err.message || 'Internal Server Error' });
});


// ============= Test mode: export app, ไม่ listen ตอน require =============
// ใช้ใน integration test (supertest) — ไม่เปิด port + ไม่ start scheduler
if (require.main === module) {
    app.listen(port, () => {
        console.log(`🚀 API Server เปิดทำงานแล้วที่พอร์ต ${port} (Path: /khupskpi/api)`);
        try { startExportScheduler(); } catch (e) { console.error('[Scheduler] start failed:', e.message); }
        try { startBackupScheduler(); } catch (e) { console.error('[BackupScheduler] start failed:', e.message); }
        try { startKpiAuditScheduler(); } catch (e) { console.error('[KPI Audit] start failed:', e.message); }
        startSessionCleanupJob();
    });
}
module.exports = { app, apiRouter, captureError, migrationsReady, loadSubAggregates, loadSubExportMonthMap, refreshKpiSummaryForIndicatorYears, scheduleSummaryRefresh, summaryRefreshIdle };
