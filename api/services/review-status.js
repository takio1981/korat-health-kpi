/**
 * ตรวจสถานะผลงานก่อนอนุมัติ/ส่งคืน (22 พ.ย. 2569) — ใช้ร่วม approve-kpi (routes/approval.js) และ reject-kpi (routes/review.js)
 * เดิมทั้ง 2 เส้นทาง UPDATE โดยไม่ดูสถานะเดิม: อนุมัติทับรายการที่อยู่ระหว่างอุทธรณ์ได้ และส่งคืนรายการที่อนุมัติแล้ว = ปลดล็อค
 * โดยไม่ผ่านสิทธิ์ปลดล็อคของ super_admin
 */

/** เงื่อนไข WHERE ของรายการ (ตัวชี้วัด × ปีงบ × หน่วยบริการ) — กติกาเดิมของทั้ง 2 เส้นทาง: ไม่ระบุ hospcode และไม่ใช่ super_admin = หน่วยบริการของผู้ดูแลเอง */
function reviewItemWhere(user, item) {
    let where = 'indicator_id = ? AND year_bh = ?';
    const params = [item.indicator_id, item.year_bh];
    let hospcode = null;
    if (item.hospcode) hospcode = item.hospcode;
    else if (user.role !== 'super_admin') hospcode = user.hospcode;
    if (hospcode) { where += ' AND hospcode = ?'; params.push(hospcode); }
    return { where, params, hospcode };
}

/**
 * คืน null = ผ่าน | { code, message } = ขัดกับสถานะปัจจุบัน
 * - มีเดือนที่อยู่ระหว่างอุทธรณ์ (Appeal) → APPEAL_PENDING
 * - allowLocked = false และมีเดือนที่ล็อค/อนุมัติแล้ว → ALREADY_APPROVED
 */
async function reviewStatusConflicts(conn, user, items, { allowLocked = false } = {}) {
    for (const item of items) {
        const { where, params } = reviewItemWhere(user, item);
        const [[r]] = await conn.query(
            `SELECT SUM(status = 'Appeal') AS appeal, SUM(is_locked = 1 OR status = 'Approved') AS locked FROM kpi_results WHERE ${where}`,
            params
        );
        if (r && Number(r.appeal) > 0) {
            return { code: 'APPEAL_PENDING', message: `ตัวชี้วัด ID ${item.indicator_id} อยู่ระหว่างอุทธรณ์ — กรุณาพิจารณาผ่าน "รับ/ไม่รับอุทธรณ์"` };
        }
        if (!allowLocked && r && Number(r.locked) > 0) {
            return { code: 'ALREADY_APPROVED', message: `ตัวชี้วัด ID ${item.indicator_id} อนุมัติแล้ว — การส่งคืนรายการที่อนุมัติแล้ว (ปลดล็อค) ทำได้เฉพาะผู้ดูแลระบบสูงสุด` };
        }
    }
    return null;
}

module.exports = { reviewItemWhere, reviewStatusConflicts };
