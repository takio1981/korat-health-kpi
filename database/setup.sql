-- ===================================================
--  KHUPS KPI Database Setup Script
--  สร้างฐานข้อมูลและตารางทั้งหมดพร้อม seed data
--
--  วิธีรัน (รันก่อน khups_kpi_db_2.sql เสมอ):
--
--  [Windows CMD]
--    mysql -h HOST -u USER -p < database\setup.sql
--    mysql -h HOST -u USER -p khups_kpi_db < database\khups_kpi_db_2.sql
--
--  [Linux / Git Bash]
--    mysql -h HOST -u USER -p < database/setup.sql
--    mysql -h HOST -u USER -p khups_kpi_db < database/khups_kpi_db_2.sql
--
--  [Navicat / HeidiSQL / DBeaver]
--    1. Run SQL File → setup.sql
--    2. Run SQL File → khups_kpi_db_2.sql
-- ===================================================

-- Step 1: สร้างฐานข้อมูล (ถ้ายังไม่มี)
CREATE DATABASE IF NOT EXISTS `khups_kpi_db`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

USE `khups_kpi_db`;

-- Step 2: สร้าง user สำหรับ application (ปรับ password ตามต้องการ)
-- GRANT ALL PRIVILEGES ON `khups_kpi_db`.* TO 'kpi_user'@'%' IDENTIFIED BY 'your_password';
-- FLUSH PRIVILEGES;

-- ===================================================
--  ตารางทั้งหมดใน khups_kpi_db (13 tables)
-- ===================================================
--
--  Reference / Lookup tables (มี seed data):
--    - chospital          สถานพยาบาลจังหวัดนครราชสีมา
--    - co_district        รายชื่ออำเภอ 32 อำเภอ
--    - departments        กลุ่มงาน 17 กลุ่ม
--    - main_yut           ยุทธศาสตร์หลัก
--    - kpi_main_indicators ตัวชี้วัดหลัก
--    - kpi_indicators     ตัวชี้วัด (~188 รายการ)
--    - system_settings    ค่าตั้งต้นระบบ
--    - users              ผู้ใช้งานเริ่มต้น
--
--  Transactional tables (ไม่มีข้อมูลเริ่มต้น สร้างเองระหว่างใช้งาน):
--    - kpi_results        ผลการบันทึก KPI
--    - login_logs         log การ login
--    - system_logs        log การแก้ไขข้อมูล
--    - notifications      การแจ้งเตือน
--    - kpi_rejection_comments  ความคิดเห็น reject/reply
--
-- ===================================================
--  หลังจาก setup.sql แล้ว ให้รัน khups_kpi_db_2.sql
--  เพื่อสร้างตารางและนำเข้าข้อมูลทั้งหมด
-- ===================================================
