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

// ===== ขอบเขตของผู้ดูแลเมื่อเพิ่ม/แก้ไขผู้ใช้ (25 ต.ค. 2569 — พบจากการทดสอบทั้งระบบ) =====
// role ทั้งหมดของระบบ (super_admin กำหนดได้ทุกค่า) — รวม 'user' รุ่นเดิมที่ยังมีในข้อมูลบางบัญชี (ROLE_SCOPE_* ยังรองรับ)
const ALL_ROLES = ['super_admin', 'admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso', 'user_cup', 'user_hos', 'user_sso', 'user_ssj', 'user'];
// role ที่ผู้ดูแลที่ไม่ใช่ super_admin กำหนดให้ผู้ใช้ได้ — ตรงกับตัวเลือกในหน้าจัดการผู้ใช้ (ไม่มี super_admin)
// เดิม admin_ssj ส่ง role = super_admin ผ่าน PUT /users/:id ได้และมีผลทันที (ยกระดับสิทธิ์โดยไม่ผ่านการอนุมัติ)
const ASSIGNABLE_ROLES = ['user_hos', 'user_sso', 'user_cup', 'user_ssj', 'admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj'];

// hospcode ปลายทางของผู้ใช้อยู่ในขอบเขตของผู้ดูแลระดับพื้นที่หรือไม่ — admin_hos/admin_sso = หน่วยบริการตัวเอง, admin_cup = อำเภอตัวเอง
// ผู้ดูแลระดับอื่น (super_admin, admin_ssj) = ทุกหน่วยบริการ | ค่าว่าง = ไม่ได้ย้ายไปหน่วยบริการอื่น (ผ่าน)
// เดิมตรวจเฉพาะ hospcode "เดิม" ของผู้ใช้ — ผู้ดูแลระดับพื้นที่ย้ายผู้ใช้ (ที่อนุมัติแล้ว) ไปหน่วยบริการ/อำเภออื่นได้
async function hospcodeInAdminScope(user, hospcode) {
    if (!hospcode) return true;
    if (['admin_hos', 'admin_sso'].includes(user.role)) return String(hospcode) === String(user.hospcode);
    if (user.role === 'admin_cup') {
        const [rows] = await db.query('SELECT hoscode, distid FROM chospital WHERE hoscode IN (?, ?)', [hospcode, user.hospcode || '']);
        const dist = (hc) => rows.find(r => String(r.hoscode) === String(hc))?.distid;
        return !!dist(user.hospcode) && dist(hospcode) === dist(user.hospcode);
    }
    return true;
}

module.exports = { countUserKpiResults, userHasResultsMessage, ALL_ROLES, ASSIGNABLE_ROLES, hospcodeInAdminScope };
