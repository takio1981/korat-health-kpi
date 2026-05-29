-- ============================================================
--  GRANT สิทธิ์ Restore Database สำหรับ Backup Manager
--  รันด้วย user root (หรือ user ที่มีสิทธิ์ GRANT)
-- ============================================================
--  แก้ปัญหา:
--   - ERROR 1044 Access denied ... to database 'khups_kpi_db_restore_...'  (ขาด CREATE)
--   - ERROR 1142 ALTER command denied ...                                  (ขาด ALTER)
--   - ERROR 1142 INDEX/LOCK/INSERT command denied ...                      (ขาดสิทธิ์อื่น)
--
--  สาเหตุ: ไฟล์ backup ของ mysqldump มีคำสั่งหลายชนิด (CREATE/DROP/ALTER/
--          INDEX/INSERT/LOCK TABLES/CREATE ROUTINE/TRIGGER) → ต้องให้สิทธิ์ครบ
--          วิธีที่ถูกต้องคือ GRANT ALL PRIVILEGES บน database ปลายทาง
-- ============================================================
--  !! สำคัญ !! เปลี่ยน 'takio1981' เป็น username ที่ใช้ใน Connection
--  และตรวจ host ให้ตรง — จาก error เห็น user เชื่อมจาก '172.19.0.2'
--  (docker bridge network) ซึ่ง '%' ครอบคลุมอยู่แล้ว
--  เช็ค host จริง: SELECT user, host FROM mysql.user WHERE user='takio1981';
-- ============================================================

-- ✅ วิธีที่ถูกต้อง: ALL PRIVILEGES บน database pattern khups_kpi_db%
--    ครอบคลุม: khups_kpi_db, khups_kpi_db_restore_xxxxx, khups_kpi_db_xxx
--    ได้ทุกสิทธิ์ที่ restore ต้องใช้ (CREATE/DROP/ALTER/INDEX/INSERT/LOCK/...)
GRANT ALL PRIVILEGES ON `khups\_kpi\_db%`.* TO 'takio1981'@'%';

-- ถ้า user เชื่อมจาก host เฉพาะ (ไม่ใช่ %) เพิ่มบรรทัดนี้ด้วย (แก้ host ตามจริง):
-- GRANT ALL PRIVILEGES ON `khups\_kpi\_db%`.* TO 'takio1981'@'172.19.0.%';

FLUSH PRIVILEGES;

-- ตรวจสอบผลลัพธ์ — ควรเห็น GRANT ALL PRIVILEGES ON `khups\_kpi\_db%`.*
SHOW GRANTS FOR 'takio1981'@'%';

-- ============================================================
--  ทางเลือก (ถ้าต้องการ restore เป็นชื่อ database อะไรก็ได้):
--  GRANT ALL PRIVILEGES ON *.* TO 'takio1981'@'%';   -- กว้างสุด (ระวังความปลอดภัย)
-- ============================================================
