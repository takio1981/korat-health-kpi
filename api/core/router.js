// Router ของ API (/khupskpi/api) — ใช้ร่วมกันระหว่าง server.js และไฟล์เส้นทางใน routes/ (แยก 25 ต.ค. 2569 ระยะ 4)
// ไฟล์ใน routes/ ลงทะเบียนเส้นทางกับ router นี้ตอนถูก require — ลำดับเส้นทาง = ลำดับที่ server.js require (Express จับตามลำดับประกาศ)
// server.js mount ด้วย app.use('/khupskpi/api', apiRouter) หลังลงทะเบียนครบ
const express = require('express');

const apiRouter = express.Router();

module.exports = { apiRouter };
