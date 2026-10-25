// ตรวจค่าที่รับจาก request ที่ใช้ร่วมหลายเส้นทาง (25 ต.ค. 2569)

// ค่าเปิด/ปิดใช้งาน (is_active) ต้องระบุชัดเจน: true/false, 1/0, '1'/'0', 'true'/'false' → 1/0 | อย่างอื่น (ไม่ส่ง/ว่าง) → null
// เดิมเส้นทาง toggle-active ใช้ `is_active ? 1 : 0` — ไม่ส่งค่ามา = ปิดใช้งาน (bulk-toggle-active ที่ข้อมูลว่าง = ปิดผู้ใช้ทุกคน)
function parseActiveFlag(v) {
    if (v === true || v === 1 || v === '1' || v === 'true') return 1;
    if (v === false || v === 0 || v === '0' || v === 'false') return 0;
    return null;
}

const ACTIVE_FLAG_REQUIRED = 'กรุณาระบุสถานะเปิด/ปิดใช้งาน (is_active)';

module.exports = { parseActiveFlag, ACTIVE_FLAG_REQUIRED };
