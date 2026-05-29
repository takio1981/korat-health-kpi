-- ============================================================
--  GRANT สิทธิ์ Restore Database สำหรับ Backup Manager
--  รันด้วย user root (หรือ user ที่มีสิทธิ์ GRANT)
--  แก้ปัญหา: ERROR 1044 Access denied ... to database 'khups_kpi_db_restore_...'
-- ============================================================
--  เปลี่ยน 'takio1981' เป็น username ที่ใช้ใน Connection ของ Backup Manager
--  เปลี่ยน '%' เป็น host ที่ user เชื่อมต่อ (เช็คได้ด้วย: SELECT user, host FROM mysql.user;)
-- ============================================================

-- ---------- ตัวเลือก A: Scoped (แนะนำ — ปลอดภัยกว่า) ----------
-- ให้สิทธิ์เฉพาะ database ที่ชื่อขึ้นต้นด้วย khups_kpi_db (รวม restore_*)
-- ครอบคลุม: khups_kpi_db, khups_kpi_db_restore_xxxxx, khups_kpi_db_xxx
GRANT ALL PRIVILEGES ON `khups\_kpi\_db%`.* TO 'takio1981'@'%';

-- ---------- ตัวเลือก B: Global (ง่าย — ให้สิทธิ์ CREATE/DROP ทุก database) ----------
-- ใช้กรณีต้องการ restore เป็นชื่อ database อะไรก็ได้
-- GRANT CREATE, DROP ON *.* TO 'takio1981'@'%';

FLUSH PRIVILEGES;

-- ตรวจสอบผลลัพธ์
SHOW GRANTS FOR 'takio1981'@'%';
