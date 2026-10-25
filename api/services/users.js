// ผู้ใช้งาน: ตรวจผลงานที่ผู้ใช้เป็นเจ้าของก่อนลบบัญชี — ใช้ร่วมระหว่าง routes/users (ลบผู้ใช้) กับ routes/auth (ลงทะเบียนซ้ำหลังถูกปฏิเสธ)
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');

// ห้ามลบผู้ใช้ที่เป็นเจ้าของผลงาน (kpi_results.user_id) — การลบผู้ใช้ต้องไม่ทำให้ผลงานหาย (11 ต.ค. 2569)
// เดิม FK เป็น ON DELETE CASCADE: ลบผู้ใช้ = ลบผลงานทุกแถวของผู้ใช้นั้นแบบเงียบๆ → เปลี่ยนเป็น RESTRICT ใน auto-migration แล้ว
// และตรวจที่นี่ก่อนเพื่อให้ได้ข้อความที่เข้าใจได้ (ไม่ใช่ข้อผิดพลาดจากฐานข้อมูล) — ให้ "ปิดการใช้งาน" บัญชีแทนการลบ
async function countUserKpiResults(userId) {
    const [[r]] = await db.query('SELECT COUNT(*) AS n FROM kpi_results WHERE user_id = ?', [userId]);
    return Number(r.n) || 0;
}

const userHasResultsMessage = (n) =>
    `ลบไม่ได้: ผู้ใช้นี้เป็นเจ้าของผลงานที่บันทึกไว้ ${Number(n).toLocaleString('en-US')} ระเบียน — การลบบัญชีจะทำให้ผลงานหาย กรุณา "ปิดการใช้งาน" บัญชีแทน`;

module.exports = { countUserKpiResults, userHasResultsMessage };
