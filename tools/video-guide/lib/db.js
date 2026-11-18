// การเชื่อมต่อฐานทดสอบ (ปฏิเสธถ้าไม่ใช่ฐานทดสอบ)
const path = require('path');
const API = path.resolve(__dirname, '../../../api');
require(path.join(API, 'node_modules/dotenv')).config({ path: path.join(API, '.env.test'), override: true, quiet: true });
const mysql = require(path.join(API, 'node_modules/mysql2/promise'));

async function withDb(fn) {
    if (!/test/.test(process.env.DB_NAME || '')) throw new Error('ปฏิเสธ: ไม่ใช่ฐานทดสอบ');
    const c = await mysql.createConnection({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
    try { return await fn(c); } finally { await c.end(); }
}
/** ล้าง session ค้าง — ระบุชื่อผู้ใช้ = เฉพาะบัญชีนั้น (ใช้ใน probe ระหว่างถ่ายได้โดยไม่ตัด session ของบัญชีอื่น) */
const resetSessions = (username) => withDb(c => (username
    ? c.query('UPDATE users SET active_session_id = NULL WHERE username = ?', [username])
    : c.query("UPDATE users SET active_session_id = NULL WHERE username LIKE 'test\\_vg\\_%'")));
module.exports = { withDb, resetSessions };
