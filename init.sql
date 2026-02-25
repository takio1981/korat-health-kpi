-- 1. ตาราง departments (กลุ่มงาน/แผนก เช่น ยสต., พบ., ปก.)
CREATE TABLE departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    dept_code VARCHAR(50) NOT NULL UNIQUE,
    dept_name VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. ตาราง main_yut (ยุทธศาสตร์หลัก)
CREATE TABLE main_yut (
    id INT AUTO_INCREMENT PRIMARY KEY,
    yut_name VARCHAR(500) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. ตาราง kpi_main_indicators (ตัวชี้วัดหลัก)
CREATE TABLE kpi_main_indicators (
    id INT AUTO_INCREMENT PRIMARY KEY,
    indicator_name VARCHAR(500) NOT NULL,
    yut_id INT,
    FOREIGN KEY (yut_id) REFERENCES main_yut(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. ตาราง kpi_indicators (ตัวชี้วัดย่อย จากคอลัมน์ report_name ใน CSV)
CREATE TABLE kpi_indicators (
    id INT AUTO_INCREMENT PRIMARY KEY,
    report_id VARCHAR(50), 
    report_name TEXT NOT NULL,
    report_code VARCHAR(100),
    weight VARCHAR(50),
    target_percentage VARCHAR(50),
    target_condition VARCHAR(50),
    table_process VARCHAR(100),
    is_active INT DEFAULT 1,
    dept_id INT,
    main_indicator_id INT,
    FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE SET NULL,
    FOREIGN KEY (main_indicator_id) REFERENCES kpi_main_indicators(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. ตาราง users (ผู้ใช้งานระบบ)
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, -- เก็บ Password แบบเข้ารหัส
    dept_id INT,
    role VARCHAR(50) DEFAULT 'user',
    FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. ตาราง kpi_results (สำหรับหน้าจอบันทึกผลงานตามรูปภาพที่แนบ)
CREATE TABLE kpi_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    kpi_indicator_id INT NOT NULL,
    user_id INT NOT NULL,
    fiscal_year VARCHAR(4) NOT NULL, -- ปีงบประมาณ เช่น 2569
    result_value DECIMAL(10,2), -- ช่อง Input บันทึกคะแนนผลงาน
    score DECIMAL(10,2), -- คะแนนที่คำนวณได้
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (kpi_indicator_id) REFERENCES kpi_indicators(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. ตาราง system_logs (ระบบจัดเก็บ log ทั้งหมด)
CREATE TABLE system_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;