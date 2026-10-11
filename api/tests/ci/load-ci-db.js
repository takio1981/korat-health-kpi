/**
 * เตรียมฐานข้อมูลทดสอบ "จากศูนย์" สำหรับ CI (GitHub Actions) หรือเครื่องใหม่ที่ยังไม่มี khups_kpi_test_db
 *   1) schema.sql — โครงสร้างตารางหลัก (ไม่มีข้อมูล)
 *   2) seed.sql   — ข้อมูลอ้างอิงขั้นต่ำ (อำเภอ, ประเภทสถานบริการ, หน่วยบริการบางส่วน, หน่วยงาน, ตัวชี้วัดตัวอย่าง)
 * ที่เหลือ (คอลัมน์/ตารางใหม่, สิทธิ์เริ่มต้น role_page_access ฯลฯ) ระบบสร้างเองจาก auto-migration ตอนชุดทดสอบ require('../server')
 *
 * ใช้ตัวแปรสภาพแวดล้อมชุดเดียวกับชุดทดสอบ: DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME
 *   node tests/ci/load-ci-db.js
 *
 * ความปลอดภัย: ทำงานเฉพาะฐานข้อมูลที่ชื่อมีคำว่า "test" และ "ยังว่างอยู่" เท่านั้น (กันโหลดทับฐานข้อมูลที่มีข้อมูล)
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
    const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
    if (!DB_NAME || !DB_NAME.includes('test')) {
        throw new Error(`ปฏิเสธการทำงาน: DB_NAME="${DB_NAME || '(unset)'}" ไม่ใช่ฐานข้อมูลทดสอบ`);
    }
    const conn = await mysql.createConnection({
        host: DB_HOST || '127.0.0.1', port: Number(DB_PORT) || 3306, user: DB_USER, password: DB_PASSWORD,
        charset: 'utf8mb4', multipleStatements: true,
    });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${DB_NAME}\``);
    const [[existing]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [DB_NAME]);
    if (existing.n > 0) {
        throw new Error(`ฐานข้อมูล ${DB_NAME} มีตารางอยู่แล้ว ${existing.n} ตาราง — สคริปต์นี้ใช้กับฐานข้อมูลว่างเท่านั้น`);
    }
    for (const file of ['schema.sql', 'seed.sql']) {
        await conn.query(fs.readFileSync(path.join(__dirname, file), 'utf8'));
        console.log('loaded', file);
    }
    const [[t]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [DB_NAME]);
    const [[h]] = await conn.query('SELECT COUNT(*) AS n FROM chospital');
    console.log(`พร้อมใช้งาน: ${DB_NAME} — ${t.n} ตาราง, หน่วยบริการ ${h.n} แห่ง`);
    await conn.end();
})().catch(e => { console.error('load-ci-db ล้มเหลว:', e.message); process.exit(1); });
