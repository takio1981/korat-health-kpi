/**
 * ตรวจสถานะผลงานก่อนอนุมัติ/ส่งคืน + ตัวช่วยอนุมัติรายเดือน (22 พ.ย. 2569)
 * ใช้ร่วม approve-kpi / unlock-kpi / appeal-* (routes/approval.js) และ reject-kpi (routes/review.js)
 * - เดิมทั้ง 2 เส้นทาง UPDATE โดยไม่ดูสถานะเดิม: อนุมัติทับรายการที่อยู่ระหว่างอุทธรณ์ได้ และส่งคืนรายการที่อนุมัติแล้ว = ปลดล็อค
 *   โดยไม่ผ่านสิทธิ์ปลดล็อคของ super_admin
 * - อนุมัติรายเดือน: 1 แถว kpi_results = 1 เดือน มี status/is_locked ของตัวเอง — อนุมัติ "ถึงเดือน M" ล็อคเฉพาะเดือนที่ลำดับปีงบ ≤ M
 */

/** ลำดับเดือนในปีงบ (ต.ค. = 1 … ก.ย. = 12) ใน SQL */
const FISCAL_ORD_SQL = (col = 'month_bh') => `(CASE WHEN ${col} >= 10 THEN ${col} - 9 ELSE ${col} + 3 END)`;

const MONTH_CODE_NUM = { oct: 10, nov: 11, dece: 12, dec: 12, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9 };
const MONTH_TH = { 10: 'ต.ค.', 11: 'พ.ย.', 12: 'ธ.ค.', 1: 'ม.ค.', 2: 'ก.พ.', 3: 'มี.ค.', 4: 'เม.ย.', 5: 'พ.ค.', 6: 'มิ.ย.', 7: 'ก.ค.', 8: 'ส.ค.', 9: 'ก.ย.' };

/** เดือน (รหัส 'oct' หรือเลข 1–12) → เลขเดือน | null */
function monthNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const k = String(v).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MONTH_CODE_NUM, k)) return MONTH_CODE_NUM[k];
    const n = Number(k);
    return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}
/** รายการเดือน (array หรือข้อความคั่นจุลภาค) → เลขเดือนไม่ซ้ำ | null = ไม่ระบุ */
function monthList(v) {
    if (v === null || v === undefined || v === '') return null;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const out = [...new Set(arr.map(monthNum).filter(n => n !== null))];
    return out.length ? out : null;
}
const fiscalOrd = (m) => (m >= 10 ? m - 9 : m + 3);
/** เลขเดือนทั้งหมดที่ลำดับปีงบ ≤ ord (ord = 1–12) */
const monthsThrough = (ord) => [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(m => fiscalOrd(m) <= ord);

/** เงื่อนไข WHERE ของรายการ (ตัวชี้วัด × ปีงบ × หน่วยบริการ [× เดือน]) — ไม่ระบุ hospcode และไม่ใช่ super_admin = หน่วยบริการของผู้ดูแลเอง (กติกาเดิม) */
function reviewItemWhere(user, item, months = null) {
    let where = 'indicator_id = ? AND year_bh = ?';
    const params = [item.indicator_id, item.year_bh];
    let hospcode = null;
    if (item.hospcode) hospcode = item.hospcode;
    else if (user.role !== 'super_admin') hospcode = user.hospcode;
    if (hospcode) { where += ' AND hospcode = ?'; params.push(hospcode); }
    if (months && months.length) { where += ' AND month_bh IN (?)'; params.push(months); }
    return { where, params, hospcode };
}

const LOCKED_SQL = "(is_locked = 1 OR status = 'Approved')";

/**
 * คืน null = ผ่าน | { code, message } = ขัดกับสถานะปัจจุบัน
 * - มีเดือนที่อยู่ระหว่างอุทธรณ์ (Appeal) → APPEAL_PENDING
 * - allowLocked = false: ระบุเดือนที่อนุมัติแล้ว หรือไม่ระบุเดือนแต่ไม่มีเดือนที่ยังเปิดอยู่เลย → ALREADY_APPROVED
 *   (ส่งคืนแบบไม่ระบุเดือน = ส่งคืนเฉพาะเดือนที่ยังไม่อนุมัติ — อนุมัติรายเดือน)
 */
async function reviewStatusConflicts(conn, user, items, { allowLocked = false, monthsOf = null } = {}) {
    for (const item of items) {
        const months = monthsOf ? monthsOf(item) : null;
        const { where, params } = reviewItemWhere(user, item, months);
        const [[r]] = await conn.query(
            // open = เดือนที่ยังไม่อนุมัติและมีผลงาน (เดือนว่างที่มีแต่เป้าหมายไม่ใช่งานที่จะส่งคืน)
            `SELECT SUM(status = 'Appeal') AS appeal, SUM(${LOCKED_SQL}) AS locked,
                    SUM(NOT ${LOCKED_SQL} AND actual_value IS NOT NULL AND TRIM(actual_value) <> '') AS open
             FROM kpi_results WHERE ${where}`,
            params
        );
        if (r && Number(r.appeal) > 0) {
            return { code: 'APPEAL_PENDING', message: `ตัวชี้วัด ID ${item.indicator_id} อยู่ระหว่างอุทธรณ์ — กรุณาพิจารณาผ่าน "รับ/ไม่รับอุทธรณ์"` };
        }
        if (!allowLocked && r && Number(r.locked) > 0 && (months || Number(r.open) === 0)) {
            return { code: 'ALREADY_APPROVED', message: `ตัวชี้วัด ID ${item.indicator_id} อนุมัติแล้ว — การส่งคืนเดือนที่อนุมัติแล้ว (ปลดล็อค) ทำได้เฉพาะผู้ดูแลระบบสูงสุด` };
        }
    }
    return null;
}

module.exports = { FISCAL_ORD_SQL, MONTH_CODE_NUM, MONTH_TH, LOCKED_SQL, monthNum, monthList, fiscalOrd, monthsThrough, reviewItemWhere, reviewStatusConflicts };
