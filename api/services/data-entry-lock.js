/**
 * สถานะ "ปิดการคีย์ข้อมูล" ของระบบ (ตั้งค่าที่หน้าตั้งค่าระบบ) — ย้ายจาก routes/indicators.js (22 พ.ย. 2569)
 * ใช้ร่วม: บันทึกผลงานหลัก (/update-kpi), ข้อย่อย/กิจกรรม, แบบฟอร์มรายเดือน — ผู้ดูแล (ROLE_ADMIN_ALL) ไม่ถูกปิด
 * เทียบวันที่ตามเวลาไทย (เดิมใช้ UTC — ช่วง 00:00–07:00 น. นับเป็นวันก่อนหน้า)
 */
const db = require('../db');
const { thaiDateKey } = require('../core/fiscal-year');

async function getDataEntryLockState(now = new Date()) {
    const keys = ['data_entry_locked', 'data_entry_lock_start', 'data_entry_lock_end', 'data_entry_lock_days'];
    const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [keys]);
    const st = {};
    for (const r of rows) st[r.setting_key] = r.setting_value;
    const manualLock = st.data_entry_locked === 'true';
    const startDate = st.data_entry_lock_start || '';
    let effectiveEnd = st.data_entry_lock_end || '';
    const lockDays = parseInt(st.data_entry_lock_days) || 0;
    if (startDate && lockDays > 0) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + lockDays);
        effectiveEnd = d.toISOString().split('T')[0];
    }
    const today = thaiDateKey(now);
    return manualLock || !!(startDate && effectiveEnd && today >= startDate && today <= effectiveEnd);
}

const DATA_ENTRY_LOCKED_MESSAGE = 'ระบบปิดการบันทึกข้อมูลชั่วคราว กรุณาติดต่อผู้ดูแลระบบ';

module.exports = { getDataEntryLockState, DATA_ENTRY_LOCKED_MESSAGE };
