// ค่าของฟิลด์ตัวชี้วัดที่รับจากผู้ใช้ (เงื่อนไขเป้าหมาย, ประเภทหน่วยบริการ, โหมดประเมิน) + ชื่อผู้ดำเนินการในข้อความแจ้งเตือน
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const kpiTarget = require('../kpi-target');

// target_condition ที่บันทึก: GTE/GT/LTE/LT/EQ — ว่าง/ไม่รู้จัก = null (คำนวณแบบ ≥ เหมือนเดิม)
const normTargetCondition = (c) => { const v = String(c == null ? '' : c).trim().toUpperCase(); return kpiTarget.TARGET_CONDITIONS.includes(v) ? v : null; };

// Helper: normalize required_off_types → JSON string หรือ null
const normalizeOffTypes = (v) => {
    if (v == null) return null;
    if (Array.isArray(v)) return v.length > 0 ? JSON.stringify(v.map(x => String(x))) : null;
    if (typeof v === 'string') {
        const trimmed = v.trim();
        if (!trimmed) return null;
        try { const parsed = JSON.parse(trimmed); return Array.isArray(parsed) && parsed.length > 0 ? JSON.stringify(parsed.map(x => String(x))) : null; }
        catch { return null; }
    }
    return null;
};

const normalizeEvalMode = (v) => (v === 'any_one' || v === 'all_required') ? v : null;

// Helper: ดึงชื่อ user สำหรับ message LINE
const _actorLabel = async (userId) => {
    try {
        const [r] = await db.query('SELECT firstname, lastname, username FROM users WHERE id = ?', [userId]);
        return r[0] ? `${r[0].firstname} ${r[0].lastname} (${r[0].username})` : `user_id ${userId}`;
    } catch (_) { return `user_id ${userId}`; }
};

module.exports = { normTargetCondition, normalizeOffTypes, normalizeEvalMode, _actorLabel };
