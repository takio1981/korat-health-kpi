/**
 * Jest test setup — helpers สำหรับ integration tests
 *
 * Requirements:
 *   1. มี database test แยก (เช่น khups_kpi_test_db) — สร้างเองครั้งเดียว:
 *      CREATE DATABASE khups_kpi_test_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
 *      GRANT ALL PRIVILEGES ON khups_kpi_test_db.* TO 'kpi_user'@'%';
 *   2. ตั้ง env ก่อนรัน:
 *      DB_NAME=khups_kpi_test_db DB_HOST=... DB_USER=... DB_PASSWORD=...
 *      หรือใช้ไฟล์ .env.test (สร้างเอง จาก .env.dev)
 *
 * Run: npm test
 */
const fs = require('fs');
const path = require('path');

// Auto-load .env.test ถ้ามี — กัน tests ใช้ DB จริง
const envPath = path.join(__dirname, '..', '.env.test');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
}
// บังคับใช้ database ทดสอบเท่านั้น — tests ลบข้อมูล (users ขึ้นต้น test_, error_logs ทั้งหมด) ห้ามรันบน DB จริงเด็ดขาด
// (เดิมแค่ warn แล้วรันต่อ → ถ้าไม่มี .env.test จะลบ error_logs จริงทั้งหมดทิ้ง)
if (!process.env.DB_NAME || !process.env.DB_NAME.includes('test')) {
    throw new Error(`ปฏิเสธการรัน tests: DB_NAME="${process.env.DB_NAME || '(unset)'}" ไม่ใช่ database ทดสอบ — ` +
        'สร้าง api/.env.test โดยตั้ง DB_NAME=khups_kpi_test_db (ดูวิธีสร้าง DB ด้านบนของไฟล์นี้)');
}
process.env.NODE_ENV = 'test';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'test-secret-key-for-jest';
