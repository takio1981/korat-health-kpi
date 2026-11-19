/**
 * ข้อมูลตัวอย่างสำหรับถ่ายวิดีโอคู่มือ — ฐานทดสอบ (DB_NAME ต้องมีคำว่า "test") เท่านั้น ห้ามรันกับฐานจริง
 *   node setup-data.js up     สร้างบัญชี test_vg_<สิทธิ์> 9 สิทธิ์ + ผลงานตัวอย่าง (ปีงบ 2569 ทั้งปี + 2570 ต.ค.-พ.ย.) + แจ้งเตือน/กระทู้ตัวอย่าง
 *   node setup-data.js down   ลบข้อมูลที่สร้าง
 *   node setup-data.js reset-sessions   ล้าง session ค้าง (กัน 409 เข้าสู่ระบบซ้อน)
 * ข้อมูลเป็นค่าสังเคราะห์ทั้งหมด (ไม่ใช่ผลงานจริง)
 */
const path = require('path');
const API = path.resolve(__dirname, '../../api');
require(path.join(API, 'node_modules/dotenv')).config({ path: path.join(API, '.env.test'), override: true, quiet: true });
const mysql = require(path.join(API, 'node_modules/mysql2/promise'));
const bcrypt = require(path.join(API, 'node_modules/bcryptjs'));
const crypto = require('crypto');

const PASSWORD = 'Vg-Guide-2570!';
const DEPT = 6; // กลุ่มงานควบคุมโรคไม่ติดต่อฯ
const ACCOUNTS = {
    super_admin: { dept: null, hos: null, fn: 'สมชาย', ln: 'ผู้ดูแลระบบ' },
    admin_ssj: { dept: DEPT, hos: '00018', fn: 'สุนิสา', ln: 'ผู้ดูแล สสจ.' },
    admin_cup: { dept: DEPT, hos: '10666', fn: 'วิชัย', ln: 'ผู้ดูแล CUP' },
    admin_hos: { dept: DEPT, hos: '10666', fn: 'มาลี', ln: 'ผู้ดูแลโรงพยาบาล' },
    admin_sso: { dept: DEPT, hos: '00222', fn: 'ประเสริฐ', ln: 'ผู้ดูแล สสอ.' },
    user_cup: { dept: DEPT, hos: '10666', fn: 'จันทร์เพ็ญ', ln: 'ผู้ใช้ CUP' },
    user_hos: { dept: DEPT, hos: '02536', fn: 'อนุชา', ln: 'ผู้ใช้ รพ.สต.' },
    user_sso: { dept: DEPT, hos: '00222', fn: 'กมลวรรณ', ln: 'ผู้ใช้ สสอ.' },
    user_ssj: { dept: DEPT, hos: '00018', fn: 'ธนพล', ln: 'ผู้ใช้ สสจ.' },
};
const HOSPITALS = ['00018', '00222', '10666', '23839', '02536', '02537', '02538', '02539', '02540'];
const INDICATORS = [72, 112, 113, 114, 115, 148];
const MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const conn = () => mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const rnd = (seed) => { let x = seed; return () => (x = (x * 9301 + 49297) % 233280) / 233280; };

async function up(c) {
    const hash = await bcrypt.hash(PASSWORD, 10);
    const ids = {};
    for (const [role, a] of Object.entries(ACCOUNTS)) {
        const username = 'test_vg_' + role;
        const cid = crypto.createHash('sha256').update('vg-' + role).digest('hex');
        await c.query(`INSERT INTO users (username, password_hash, cid, role, dept_id, hospcode, firstname, lastname, email, is_approved, is_active, can_edit_actual, can_edit_target)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)
            ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role), dept_id = VALUES(dept_id), hospcode = VALUES(hospcode),
              firstname = VALUES(firstname), lastname = VALUES(lastname), is_active = 1, is_approved = 1, active_session_id = NULL, must_change_password = 0`,
            [username, hash, cid, role, a.dept, a.hos, a.fn, a.ln, username + '@example.test']);
        const [[u]] = await c.query('SELECT id FROM users WHERE username = ?', [username]);
        ids[role] = u.id;
    }
    await c.query("UPDATE users SET must_change_password = 0 WHERE username LIKE 'test\\_vg\\_%'").catch(() => {});
    // ผลงานตัวอย่าง — เจ้าของแถว = super_admin ของชุดนี้
    await c.query('DELETE FROM kpi_results WHERE user_id IN (?)', [Object.values(ids)]);
    const r = rnd(2570);
    const rows = [];
    for (const ind of INDICATORS) for (const [hi, hos] of HOSPITALS.entries()) {
        const target = [55, 80, 80, 80, 25, 70][INDICATORS.indexOf(ind)];
        for (const m of MONTHS) { // ปีงบ 2569 ทั้งปี
            const v = Math.round(target * (0.75 + r() * 0.45) * 100) / 100;
            rows.push([ind, '2569', hos, m, target, String(v), 'Approved', 1, ids.super_admin]);
        }
        for (const m of [10, 11]) { // ปีงบ 2570 (ปัจจุบัน) 2 เดือนแรก — บางแห่งยังไม่บันทึก พ.ย.
            const v = (m === 11 && hi % 3 === 0) ? '' : String(Math.round(target * (0.7 + r() * 0.5) * 100) / 100);
            const lock = m === 10 && ['23839', '02537', '02539'].includes(hos);
            rows.push([ind, '2570', hos, m, target, v, lock ? 'Approved' : 'Pending', lock ? 1 : 0, ids.super_admin]);
        }
        for (const m of MONTHS.slice(2)) rows.push([ind, '2570', hos, m, target, '', 'Pending', 0, ids.super_admin]);
    }
    for (let i = 0; i < rows.length; i += 500) {
        await c.query('INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, is_locked, user_id) VALUES ?', [rows.slice(i, i + 500)]);
    }
    // แจ้งเตือน + กระทู้ตัวอย่าง
    await c.query("DELETE FROM notifications WHERE title LIKE '[ตัวอย่าง]%'");
    for (const [role, id] of Object.entries(ids)) {
        await c.query("INSERT INTO notifications (user_id, hospcode, type, title, message, is_read) VALUES (?, ?, 'info', '[ตัวอย่าง] ผลงานเดือน ต.ค. ได้รับการอนุมัติแล้ว', 'ผลงานตัวชี้วัดร้อยละการคัดกรองมะเร็งลำไส้ใหญ่ เดือนตุลาคม ผ่านการตรวจสอบแล้ว', 0)", [id, ACCOUNTS[role].hos]).catch(() => {});
        await c.query("INSERT INTO notifications (user_id, hospcode, type, title, message, is_read) VALUES (?, ?, 'reject', '[ตัวอย่าง] ส่งกลับแก้ไขผลงานเดือน พ.ย.', 'กรุณาตรวจสอบตัวเลขผลงานเดือนพฤศจิกายนอีกครั้ง', 0)", [id, ACCOUNTS[role].hos]).catch(() => {});
    }
    await c.query("DELETE FROM feedback_posts WHERE user_id IN (?)", [Object.values(ids)]);
    await c.query("INSERT INTO feedback_posts (user_id, category, title, message, status) VALUES (?, 'question', 'สอบถามการบันทึกผลงานรายไตรมาส', 'ตัวชี้วัดที่วัดผลรายไตรมาสต้องบันทึกเดือนไหนบ้างครับ', 'open')", [ids.user_hos]);
    await c.query("INSERT INTO feedback_posts (user_id, category, title, message, status) VALUES (?, 'suggestion', 'ขอเพิ่มรายงานสรุปรายโซน', 'อยากให้มีรายงานสรุปผลงานแยกตามโซนค่ะ', 'resolved')", [ids.user_sso]);
    console.log('up: บัญชี', Object.keys(ids).length, 'สิทธิ์ | ผลงาน', rows.length, 'แถว');
}

async function refreshSummary() {
    const BE = 'http://localhost:3710/khupskpi/api';
    const login = await fetch(BE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test_vg_super_admin', password: PASSWORD, force_login: true }) }).then(r => r.json());
    if (!login.token) throw new Error('login: ' + JSON.stringify(login).slice(0, 200));
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
    for (const year_bh of ['2569', '2570']) {
        const p = await fetch(BE + '/refresh-summary/prepare', { method: 'POST', headers: H, body: JSON.stringify({ year_bh }) }).then(r => r.json());
        for (let i = 0; i < p.indicator_ids.length; i += 50) await fetch(BE + '/refresh-summary/batch', { method: 'POST', headers: H, body: JSON.stringify({ year_bh, indicator_ids: p.indicator_ids.slice(i, i + 50) }) });
        await fetch(BE + '/refresh-summary/finalize', { method: 'POST', headers: H, body: JSON.stringify({ year_bh }) });
        console.log('refresh summary', year_bh, p.total, 'ตัวชี้วัด');
    }
    await fetch(BE + '/logout', { method: 'POST', headers: H });
}

async function down(c) {
    const [us] = await c.query("SELECT id FROM users WHERE username LIKE 'test\\_vg\\_%'");
    const ids = us.map(u => u.id);
    if (ids.length) {
        await c.query('DELETE FROM kpi_results WHERE user_id IN (?)', [ids]);
        await c.query('DELETE FROM feedback_posts WHERE user_id IN (?)', [ids]);
        await c.query('DELETE FROM notifications WHERE user_id IN (?)', [ids]);
        await c.query("DELETE FROM kpi_summary WHERE year_bh IN ('2569','2570') AND indicator_id IN (?) AND hospcode IN (?)", [INDICATORS, HOSPITALS]);
        await c.query('DELETE FROM users WHERE id IN (?)', [ids]);
    }
    console.log('down: ลบบัญชี', ids.length);
}

module.exports = { PASSWORD, ACCOUNTS };

if (require.main === module) (async () => {
    if (!/test/.test(process.env.DB_NAME || '')) throw new Error('ปฏิเสธ: DB_NAME ไม่ใช่ฐานทดสอบ (' + process.env.DB_NAME + ')');
    const c = await conn();
    const cmd = process.argv[2];
    if (cmd === 'up') { await up(c); await refreshSummary(); }
    else if (cmd === 'down') await down(c);
    else if (cmd === 'reset-sessions') await c.query("UPDATE users SET active_session_id = NULL WHERE username LIKE 'test\\_vg\\_%'");
    else console.log('ใช้: node setup-data.js up|down|reset-sessions');
    await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
