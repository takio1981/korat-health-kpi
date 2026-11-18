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
if (!/test/.test(env.DB_NAME || '')) { console.error('ปฏิเสธ: .env.test ไม่ใช่ฐานทดสอบ'); process.exit(1); }
env.NODE_OPTIONS = `--require "${path.join(__dirname, 'block-net.js').replace(/\\/g, '/')}"`;
const p = spawn(process.execPath, ['server.js'], { cwd: API, env, stdio: 'inherit' });
p.on('exit', (code) => process.exit(code || 0));
