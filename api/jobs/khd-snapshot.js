/**
 * งานเบื้องหลัง: อ่านสถานะรายงาน KHD เก็บเป็นสำเนา (ความพร้อมของตัวชี้วัด — 22 พ.ย. 2569)
 * ตรวจทุก 1 ชั่วโมง อ่าน KHD เมื่อสำเนาเก่าเกิน 24 ชม. (ล้มเหลว = พัก 6 ชม.) — อ่าน 2 คำสั่งต่อครั้ง ไม่เขียน KHD
 */
const { refreshKhdReportsSnapshot, getSnapshotStatus, isSnapshotDue } = require('../services/khd-snapshot');

let started = false;

async function runKhdSnapshotCheck(now = new Date()) {
    try {
        if (!isSnapshotDue(await getSnapshotStatus(), now)) return { skipped: true };
        const r = await refreshKhdReportsSnapshot();
        if (r.ok) console.log(`[KhdSnapshot] อัปเดตสำเนาสถานะรายงาน KHD ${r.count} รายการ`);
        else console.warn('[KhdSnapshot] อ่าน KHD ไม่สำเร็จ:', r.error);
        return r;
    } catch (e) {
        console.error('[KhdSnapshot] check failed:', e.message);
        return { ok: false, error: e.message };
    }
}

function startKhdSnapshotJob() {
    if (started) return;
    started = true;
    setTimeout(runKhdSnapshotCheck, 120 * 1000);
    setInterval(runKhdSnapshotCheck, 60 * 60 * 1000);
}

module.exports = { startKhdSnapshotJob, runKhdSnapshotCheck };
