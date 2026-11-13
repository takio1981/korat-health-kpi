// งานตามเวลา: อนุมัติผู้สมัครใหม่อัตโนมัติ (ตรวจทุก 30 วินาที) + ส่งผู้ใช้ใหม่ขึ้น KHD รายวันตามเวลาที่ตั้ง (13 พ.ย. 2569)
// ตรรกะอยู่ใน services/user-approval.js — process เดียวกับ server (เหมือน scheduler อื่น)
const { getUserApprovalSettings, runAutoApprove, runScheduledKhdSync, saveLastRun } = require('../services/user-approval');

/** ถึงเวลาส่งรายวันหรือยัง (เวลาไทย ช่วง 2 นาที ไม่ส่งซ้ำวันเดียวกัน) */
function isSyncDue(cfg, now, lastDateKey) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const get = (t) => parts.find(p => p.type === t)?.value;
    const hh = get('hour') === '24' ? '00' : get('hour');
    const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
    if (!cfg.syncSchedule || dateKey === lastDateKey) return { due: false, dateKey };
    const [th, tm] = cfg.syncTime.split(':').map(Number);
    const mins = Number(hh) * 60 + Number(get('minute'));
    return { due: mins >= th * 60 + tm && mins <= th * 60 + tm + 1, dateKey };
}

function startUserApprovalScheduler() {
    let busy = false;
    let lastSyncDate = '';
    const check = async () => {
        if (busy) return;
        busy = true;
        try {
            const cfg = await getUserApprovalSettings();
            if (cfg.autoApprove) {
                const r = await runAutoApprove();
                if (r.approved.length) {
                    console.log(`[UserApproval] ✅ auto-approved ${r.approved.length}: ${r.approved.join(', ')}`);
                    await saveLastRun({ task: 'approve', approved: r.approved.length });
                }
            }
            const { due, dateKey } = isSyncDue(cfg, new Date(), lastSyncDate);
            if (due) {
                lastSyncDate = dateKey;
                const s = await runScheduledKhdSync();
                console.log(`[UserApproval] KHD sync ${dateKey}: synced=${s.synced} failed=${s.failed}`);
                await saveLastRun({ task: 'sync', synced: s.synced, failed: s.failed });
            }
        } catch (e) {
            console.error('[UserApproval] check failed:', e.message);
        } finally { busy = false; }
    };
    setInterval(check, 30000);
    console.log('[UserApproval] scheduler started — check every 30s');
}

module.exports = { startUserApprovalScheduler, isSyncDue };
