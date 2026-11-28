/**
 * เริ่ม backend ชุดที่ 2 สำหรับถ่ายวิดีโอ: พอร์ต 3710 ชี้ฐานทดสอบ (api/.env.test) + บล็อกการเชื่อมต่อออกนอกเครื่อง
 * (ฐานทดสอบมีโทเคน LINE/Telegram/SMTP จริง) — node start-backend.js
 */
const path = require('path');
const { spawn } = require('child_process');
const API = path.resolve(__dirname, '../../api');
const env = { ...process.env };
const parsed = require(path.join(API, 'node_modules/dotenv')).parse(require('fs').readFileSync(path.join(API, '.env.test')));
Object.assign(env, parsed, { PORT: '3710', NODE_ENV: 'development' });
// ปิดช่องทางออกนอกเครื่องตั้งแต่ค่าตั้งต้น: ไม่มี SMTP / แจ้งเตือน / ฐาน KHD จริงระหว่างถ่าย (ซ้อนกับ block-net.js)
Object.assign(env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'none', SMTP_PASS: 'none', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', ADMIN_EMAILS: '', KHD_DB_HOST: '127.0.0.1', KHD_DB_PORT: '1', KHD_DB_USER: '', KHD_DB_PASSWORD: '' });
if (!/test/.test(env.DB_NAME || '')) { console.error('ปฏิเสธ: .env.test ไม่ใช่ฐานทดสอบ'); process.exit(1); }
// VG_KHD_MOCK_DB=<ชื่อฐานที่มีคำว่า test> (28 พ.ย. 2569) = KHD จำลองบนเซิร์ฟเวอร์ฐานทดสอบเดียวกัน — ใช้ทดสอบหน้าจอส่งข้อมูลเข้า KHD (e2e-khd-sync.js)
if (process.env.VG_KHD_MOCK_DB) {
    if (!/test/.test(process.env.VG_KHD_MOCK_DB)) { console.error('ปฏิเสธ: VG_KHD_MOCK_DB ต้องเป็นฐานที่มีคำว่า test'); process.exit(1); }
    Object.assign(env, { KHD_DB_HOST: env.DB_HOST, KHD_DB_PORT: env.DB_PORT || '3306', KHD_DB_USER: env.DB_USER, KHD_DB_PASSWORD: env.DB_PASSWORD, KHD_DB_NAME: process.env.VG_KHD_MOCK_DB });
}
env.NODE_OPTIONS = `--require "${path.join(__dirname, 'block-net.js').replace(/\\/g, '/')}"`;
const p = spawn(process.execPath, ['server.js'], { cwd: API, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code || 0));
