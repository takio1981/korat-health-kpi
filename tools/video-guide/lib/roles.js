// ป้ายชื่อและขอบเขตของแต่ละสิทธิ์ (ใช้ในคำบรรยาย) — ต้องตรงกับตาราง Role System ใน CLAUDE.md
const ROLES = {
    super_admin: { label: 'ผู้ดูแลระบบสูงสุด (Super Admin)', short: 'ผู้ดูแลระบบสูงสุด', scope: 'เห็นข้อมูลทุกหน่วยงาน ทุกหน่วยบริการ และทุกอำเภอ', admin: true, central: true, deptLock: false, oneHos: false },
    admin_ssj: { label: 'ผู้ดูแล สสจ. (Admin SSJ)', short: 'ผู้ดูแลระดับสำนักงานสาธารณสุขจังหวัด', scope: 'เห็นตัวชี้วัดเฉพาะกลุ่มงานของตนเอง แต่ครอบคลุมทุกหน่วยบริการในจังหวัด', admin: true, central: true, deptLock: true, oneHos: false },
    admin_cup: { label: 'ผู้ดูแล CUP (Admin CUP)', short: 'ผู้ดูแลระดับเครือข่ายบริการ หรือ CUP', scope: 'เห็นทุกหน่วยบริการในอำเภอของตนเอง และตัวชี้วัดของทุกกลุ่มงาน', admin: true, deptLock: false, oneHos: false },
    admin_hos: { label: 'ผู้ดูแลโรงพยาบาล (Admin HOS)', short: 'ผู้ดูแลระดับโรงพยาบาล', scope: 'เห็นเฉพาะหน่วยบริการของตนเอง แต่ครอบคลุมตัวชี้วัดของทุกกลุ่มงาน', admin: true, deptLock: false, oneHos: true },
    admin_sso: { label: 'ผู้ดูแล สสอ. (Admin SSO)', short: 'ผู้ดูแลระดับสำนักงานสาธารณสุขอำเภอ', scope: 'เห็นเฉพาะหน่วยบริการของตนเอง แต่ครอบคลุมตัวชี้วัดของทุกกลุ่มงาน', admin: true, deptLock: false, oneHos: true },
    user_cup: { label: 'ผู้ใช้ CUP', short: 'ผู้ใช้งานระดับเครือข่ายบริการ หรือ CUP', scope: 'เห็นทุกหน่วยบริการในอำเภอของตนเอง เฉพาะตัวชี้วัดของกลุ่มงานตนเอง และบันทึกผลงานได้เฉพาะหน่วยบริการของตนเอง', admin: false, deptLock: true, oneHos: false },
    user_hos: { label: 'ผู้ใช้โรงพยาบาล', short: 'ผู้ใช้งานระดับหน่วยบริการ', scope: 'เห็นและบันทึกผลงานได้เฉพาะหน่วยบริการของตนเอง และเฉพาะตัวชี้วัดของกลุ่มงานตนเอง', admin: false, deptLock: true, oneHos: true },
    user_sso: { label: 'ผู้ใช้ สสอ.', short: 'ผู้ใช้งานระดับสำนักงานสาธารณสุขอำเภอ', scope: 'เห็นและบันทึกผลงานได้เฉพาะหน่วยบริการของตนเอง และเฉพาะตัวชี้วัดของกลุ่มงานตนเอง', admin: false, deptLock: true, oneHos: true },
    user_ssj: { label: 'ผู้ใช้ สสจ.', short: 'ผู้ใช้งานระดับสำนักงานสาธารณสุขจังหวัด', scope: 'เห็นข้อมูลทุกหน่วยบริการทุกอำเภอ เฉพาะตัวชี้วัดของกลุ่มงานตนเอง และบันทึกผลงานได้เฉพาะหน่วยบริการของตนเอง', admin: false, deptLock: true, oneHos: false },
};
const ROLE_KEYS = Object.keys(ROLES);
module.exports = { ROLES, ROLE_KEYS };
