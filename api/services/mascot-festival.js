/**
 * ปรับวันที่ชุดเทศกาลของน้องโคราชดีอัตโนมัติ (22 พ.ย. 2569 — ผู้ใช้สั่ง: ปรับวันที่เปลี่ยนชุดอัตโนมัติเมื่อขึ้นปีใหม่)
 * ดึงปฏิทินวันหยุดราชการไทย (iCalendar สาธารณะ — ค่าตั้งต้น Google "วันหยุดในไทย") แล้วเก็บวันหลักของเทศกาลตามจันทรคติ
 * ที่ปฏิทินมี (มาฆบูชา วิสาขบูชา อาสาฬหบูชา เข้าพรรษา ออกพรรษา ลอยกระทง ตรุษจีน) ลง system_settings.mascot_festival_dates_auto
 * วันที่ปฏิทินไม่มี frontend คำนวณต่อเอง (shared/mascot/mascot-lunar.ts: ลอยกระทง/ออกพรรษาจากอาสาฬหบูชา, เทศกาลจีนทางดาราศาสตร์)
 * ไม่ส่งข้อมูลผู้ใช้/หน่วยงานออกนอกระบบ — เป็นการดาวน์โหลดไฟล์สาธารณะอย่างเดียว
 */
const db = require('../db');

const DEFAULT_ICS_URL = 'https://calendar.google.com/calendar/ical/th.th%23holiday%40group.v.calendar.google.com/public/basic.ics';
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20000;
/** ดึงซ้ำทุก 7 วัน (ราชการประกาศวันหยุดปีถัดไประหว่างปี) + ทันทีเมื่อขึ้นปีใหม่ตามเวลาไทย */
const REFRESH_DAYS = 7;

/** ชื่อเหตุการณ์ → id เทศกาล (ไทยและอังกฤษ) — ข้ามวันหยุดชดเชย/วันที่ 2-3 ของตรุษจีน */
const RULES = [
    ['makha', /มาฆบูชา|makha\s*bucha/i],
    ['visakha', /วิสาขบูชา|visakha\s*bucha|vesak/i],
    ['asalha', /อาสาฬหบูชา|asa(l|n)ha\s*bucha/i],
    // ออกพรรษาก่อนเข้าพรรษา: "End of Buddhist Lent" มีคำว่า Buddhist Lent ด้วย
    ['okphansa', /ออกพรรษา|ok\s*phansa|end\s*of\s*buddhist\s*lent/i],
    ['khaophansa', /เข้าพรรษา|khao\s*phansa|buddhist\s*lent/i],
    ['loykrathong', /ลอยกระทง|loy\s*krathong/i],
    ['cny', /ตรุษจีน|chinese\s*new\s*year|lunar\s*new\s*year/i],
];
const SKIP = /ชดเชย|วันที่\s*[23]|substitut|observed|in\s*lieu|day\s*off|second\s*day|third\s*day|\beve\b|วันก่อน/i;

const thaiNow = (now = new Date()) => new Date(now.getTime() + 7 * 3600000);
const thaiYear = (now = new Date()) => thaiNow(now).getUTCFullYear();

/** แยก VEVENT จากไฟล์ iCalendar → { [ปี ค.ศ.]: { id: 'YYYY-MM-DD' } } (ฟังก์ชันล้วน) */
function parseHolidayIcs(text, { minYear = 2000, maxYear = 2199 } = {}) {
    const unfolded = String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
    const out = {};
    const blocks = unfolded.split('BEGIN:VEVENT').slice(1);
    for (const b of blocks) {
        const body = b.split('END:VEVENT')[0];
        const ds = /^DTSTART[^:\n]*:(\d{4})(\d{2})(\d{2})/m.exec(body);
        const sm = /^SUMMARY[^:\n]*:(.*)$/m.exec(body);
        if (!ds || !sm) continue;
        const summary = sm[1].replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').trim();
        if (!summary || SKIP.test(summary)) continue;
        const y = +ds[1];
        if (y < minYear || y > maxYear) continue;
        const date = `${ds[1]}-${ds[2]}-${ds[3]}`;
        const rule = RULES.find(([, re]) => re.test(summary));
        if (!rule) continue;
        const id = rule[0], ys = String(y);
        const row = out[ys] || (out[ys] = {});
        // หลายรายการชื่อเดียวกันในปีเดียว (เช่น ตรุษจีน) = ใช้วันแรก
        if (!row[id] || date < row[id]) row[id] = date;
    }
    return out;
}

function isValidIcsUrl(u) {
    try {
        const x = new URL(u);
        return x.protocol === 'https:' && !!x.hostname && !x.username && !x.password;
    } catch (e) { return false; }
}

async function getSetting(key) {
    const [[r]] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
    return r ? r.setting_value : null;
}
async function setSetting(key, value) {
    await db.query(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
        [key, value]
    );
}

/** ค่าตั้งค่า + สถานะการดึงล่าสุด */
async function getFestivalAutoState() {
    const enabled = (await getSetting('mascot_festival_auto')) !== 'false';
    const url = (await getSetting('mascot_festival_ics_url')) || DEFAULT_ICS_URL;
    let state = {};
    try { state = JSON.parse((await getSetting('mascot_festival_dates_auto')) || '{}') || {}; } catch (e) { state = {}; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    return { enabled, url, state };
}

/** ถึงเวลาดึงใหม่หรือยัง: ไม่เคยดึง / ขึ้นปีใหม่ (เวลาไทย) / ครบ 7 วัน / ล้มเหลวครั้งล่าสุดเกิน 6 ชั่วโมง */
function isRefreshDue(state, now = new Date()) {
    const okAt = state && state.fetched_at ? new Date(state.fetched_at) : null;
    const tryAt = state && state.last_try ? new Date(state.last_try) : null;
    if (tryAt && state.error && now - tryAt < 6 * 3600000) return false;
    if (!okAt || isNaN(okAt)) return true;
    if (thaiYear(okAt) !== thaiYear(now)) return true;
    return now - okAt >= REFRESH_DAYS * 86400000;
}

/**
 * ดึงปฏิทินแล้วบันทึกผล — force = กดปุ่ม "อัปเดตตอนนี้" (ไม่สนรอบเวลา)
 * คืน { ok, skipped?, count, years, error? } — ล้มเหลว = คงวันที่ชุดเดิมไว้ (บันทึกข้อผิดพลาดอย่างเดียว)
 */
async function refreshFestivalDates({ force = false, now = new Date(), fetchImpl = (typeof fetch === 'function' ? fetch : null) } = {}) {
    const { enabled, url, state } = await getFestivalAutoState();
    if (!enabled && !force) return { ok: false, skipped: 'disabled' };
    if (!force && !isRefreshDue(state, now)) return { ok: true, skipped: 'not_due' };
    const save = s => setSetting('mascot_festival_dates_auto', JSON.stringify(s));
    const fail = async (error) => {
        await save({ ...state, last_try: now.toISOString(), error: String(error).slice(0, 300) });
        return { ok: false, error: String(error) };
    };
    if (!isValidIcsUrl(url)) return fail('ที่อยู่ปฏิทินต้องเป็น https');
    if (!fetchImpl) return fail('ระบบไม่รองรับการดึงข้อมูล');
    let text;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        let res;
        try { res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'text/calendar' } }); } finally { clearTimeout(timer); }
        if (!res.ok) return fail(`ดึงปฏิทินไม่สำเร็จ (HTTP ${res.status})`);
        text = await res.text();
        if (text.length > MAX_BYTES) return fail('ไฟล์ปฏิทินใหญ่เกินไป');
        if (!text.includes('BEGIN:VCALENDAR')) return fail('ไฟล์ที่ได้ไม่ใช่ปฏิทิน (iCalendar)');
    } catch (e) {
        return fail(e && e.name === 'AbortError' ? 'หมดเวลารอปฏิทิน' : `เชื่อมต่อปฏิทินไม่ได้: ${e && e.message}`);
    }
    const y = thaiYear(now);
    const dates = parseHolidayIcs(text, { minYear: y - 1, maxYear: y + 10 });
    const count = Object.values(dates).reduce((n, r) => n + Object.keys(r).length, 0);
    if (!count) return fail('ไม่พบวันเทศกาลในปฏิทิน');
    const next = { dates, fetched_at: now.toISOString(), last_try: now.toISOString(), source: url === DEFAULT_ICS_URL ? 'google-th-holidays' : 'custom', count };
    await save(next);
    return { ok: true, count, years: Object.keys(dates).sort() };
}

/** วันที่สำหรับ maintenance-status (ปิดใช้งาน = ว่าง) */
async function publicAutoDates() {
    const { enabled, state } = await getFestivalAutoState();
    return { enabled, dates: enabled && state.dates && typeof state.dates === 'object' ? state.dates : {} };
}

module.exports = {
    DEFAULT_ICS_URL, REFRESH_DAYS, parseHolidayIcs, isValidIcsUrl, isRefreshDue, refreshFestivalDates,
    getFestivalAutoState, publicAutoDates, thaiYear,
};
