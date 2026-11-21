/**
 * ปีงบประมาณ (ฝั่ง backend — 22 พ.ย. 2569) คู่กับ frontend shared/fiscal-year.util.ts
 * ปีงบ = ต.ค. ถึง ก.ย. นับชื่อตามปี พ.ศ. ที่สิ้นสุด (1 ต.ค. 2569 – 30 ก.ย. 2570 = ปีงบ 2570) — คิดตามเวลาประเทศไทย (UTC+7)
 * เดิมหลายจุดคำนวณเองเป็น "ปีปฏิทิน + 543" ซึ่งผิดช่วง ต.ค.–ธ.ค. ของทุกปี — ใช้ฟังก์ชันนี้แทนเสมอ
 */
function thaiNow(now = new Date()) {
    return new Date(now.getTime() + 7 * 3600000);
}

/** ปีงบปัจจุบัน (ปี พ.ศ. เป็นตัวเลข) */
function currentFiscalYear(now = new Date()) {
    const t = thaiNow(now);
    const y = t.getUTCFullYear() + 543;
    return t.getUTCMonth() + 1 >= 10 ? y + 1 : y;
}

/** วันที่วันนี้ตามเวลาไทย YYYY-MM-DD */
function thaiDateKey(now = new Date()) {
    return thaiNow(now).toISOString().slice(0, 10);
}

/** ลำดับเดือนในปีงบ: ต.ค. = 1 … ก.ย. = 12 */
function fiscalMonthOrdinal(m) {
    const n = Number(m);
    return n >= 10 ? n - 9 : n + 3;
}

/** เดือนปฏิทินจากลำดับปีงบ (1 = ต.ค. … 12 = ก.ย.) */
function monthOfFiscalOrdinal(o) {
    const n = Number(o);
    return n <= 3 ? n + 9 : n - 3;
}

module.exports = { thaiNow, thaiDateKey, currentFiscalYear, fiscalMonthOrdinal, monthOfFiscalOrdinal };
