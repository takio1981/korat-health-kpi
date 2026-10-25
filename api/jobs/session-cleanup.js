// งานเบื้องหลัง: ล้าง session ที่หมดอายุ — เริ่มจาก server.js เฉพาะตอนรันจริง (require.main)
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');

// === Session Cleanup Job — เคลียร์ active_session_id ที่ค้างเกิน 8h (= JWT lifetime) ===
// ป้องกันกรณีปิด browser โดยไม่ logout → session ค้างใน DB ตลอดไป
function startSessionCleanupJob() {
    const JWT_LIFETIME_HOURS = 8;
    const runCleanup = async () => {
        try {
            const [result] = await db.query(`
                UPDATE users
                SET active_session_id = NULL, session_started_at = NULL
                WHERE active_session_id IS NOT NULL
                  AND last_seen_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
            `, [JWT_LIFETIME_HOURS]);
            if (result.affectedRows > 0) {
                console.log(`🧹 [SessionCleanup] เคลียร์ stale session ${result.affectedRows} user(s) (last_seen > ${JWT_LIFETIME_HOURS}h ago)`);
            }
        } catch (e) {
            console.error('❌ [SessionCleanup] error:', e.message);
        }
    };
    runCleanup(); // รันทันทีตอน startup (เผื่อ restart กลางคัน)
    setInterval(runCleanup, 30 * 60 * 1000); // ทุก 30 นาที
    console.log(`⏱️  [SessionCleanup] เริ่ม job — เคลียร์ session ที่ไม่ active > ${JWT_LIFETIME_HOURS}h ทุก 30 นาที`);
}

module.exports = { startSessionCleanupJob };
