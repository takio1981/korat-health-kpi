/**
 * งานเบื้องหลัง: ปรับวันที่ชุดเทศกาลของน้องโคราชดีอัตโนมัติ (22 พ.ย. 2569)
 * ตรวจทุก 1 ชั่วโมง — ดึงปฏิทินวันหยุดราชการเมื่อขึ้นปีใหม่ (เวลาไทย) และทุก 7 วัน (services/mascot-festival.js isRefreshDue)
 */
const { refreshFestivalDates } = require('../services/mascot-festival');

let started = false;

async function runMascotFestivalCheck() {
    try {
        const r = await refreshFestivalDates();
        if (r.ok && !r.skipped) console.log(`[MascotFestival] อัปเดตวันที่เทศกาล ${r.count} รายการ (ปี ${r.years.join(', ')})`);
        else if (!r.ok && r.error) console.warn('[MascotFestival] ดึงปฏิทินไม่สำเร็จ:', r.error);
    } catch (e) {
        console.error('[MascotFestival] check failed:', e.message);
    }
}

function startMascotFestivalJob() {
    if (started) return;
    started = true;
    setTimeout(runMascotFestivalCheck, 90 * 1000);
    setInterval(runMascotFestivalCheck, 60 * 60 * 1000);
}

module.exports = { startMascotFestivalJob, runMascotFestivalCheck };
