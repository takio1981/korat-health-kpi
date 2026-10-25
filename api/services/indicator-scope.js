// ขอบเขตประเภทหน่วยบริการของตัวชี้วัด (evaluation_mode/required_off_types) — กฎเดียวกับ frontend shared/indicator-scope.ts (2 สำเนาต้องตรงกัน)
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

// Helper: หน่วยบริการ (hostype) ที่ใช้ได้กับตัวชี้วัด — อ้างอิง evaluation_mode/required_off_types
// 'any_one' + required_off_types มีค่า → เฉพาะประเภทที่ระบุ, กรณีอื่น (all_required/ว่าง/parse ไม่ได้) → ชุดเดิมทั้งหมด (backward compat)
const ALL_BULK_HOSTYPES = ['05', '06', '07', '18'];

// การตั้งค่า "ประเภทหน่วยบริการ" ของตัวชี้วัด (evaluation_mode/required_off_types) — ใช้กับการ "เพิ่มตัวชี้วัดให้หน่วยบริการ"
// (GET /kpi-template, /update-kpi โหมด setup_insert_new) — ต้องตรงกับ frontend/src/app/shared/indicator-scope.ts
//   'types' = any_one + มีรายการประเภท → เฉพาะประเภทที่ระบุ
//   'all'   = all_required → ทุกประเภท (เพิ่มอัตโนมัติหลายแห่ง = 4 ประเภทหลัก ALL_BULK_HOSTYPES)
//   'unset' = ยังไม่ได้ตั้ง (evaluation_mode ว่าง / any_one ไม่มีรายการ / JSON เสีย) → เพิ่มให้หน่วยบริการไม่ได้ ต้องตั้งค่าก่อน (19 ต.ค. 2569)
const indicatorOffTypeCodes = (ind) => {
    if (!ind || !ind.required_off_types) return null;
    let codes = ind.required_off_types;
    if (typeof codes === 'string') { try { codes = JSON.parse(codes); } catch (_) { return null; } }
    return (Array.isArray(codes) && codes.length > 0) ? codes.map(String) : null;
};

const indicatorTypeSetting = (ind) => {
    if (ind && ind.evaluation_mode === 'all_required') return 'all';
    if (ind && ind.evaluation_mode === 'any_one' && indicatorOffTypeCodes(ind)) return 'types';
    return 'unset';
};

const indicatorAllowsHostype = (ind, hostype) => {
    const setting = indicatorTypeSetting(ind);
    if (setting === 'unset') return false;
    if (setting === 'all') return true;
    return indicatorOffTypeCodes(ind).includes(String(hostype));
};

const resolveIndicatorHostypes = (ind) => {
    if (ind.evaluation_mode === 'any_one' && ind.required_off_types) {
        try {
            const codes = JSON.parse(ind.required_off_types);
            if (Array.isArray(codes) && codes.length > 0) return new Set(codes.map(String));
        } catch (_) {}
    }
    return new Set(ALL_BULK_HOSTYPES);
};

module.exports = { ALL_BULK_HOSTYPES, indicatorOffTypeCodes, indicatorTypeSetting, indicatorAllowsHostype, resolveIndicatorHostypes };
