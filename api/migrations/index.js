// Migration ตอนเริ่มระบบ: สร้าง/ปรับตาราง (CREATE TABLE IF NOT EXISTS, ALTER แบบ try/catch) + seed สิทธิ์เริ่มต้น
// ย้ายจาก server.js (ระยะ 2 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// - require('./migrations') = เริ่มทำงานทันที (เหมือนเดิมที่รันตอนโหลด server.js) — migrationsReady = promise ของบล็อกหลัก (tests รอก่อนเริ่ม)
// - migration ใหม่: เพิ่มในบล็อกหลัก (หรือบล็อกของโมดูลที่เป็นเจ้าของตาราง) ตามรูปแบบ try { await db.query('ALTER TABLE …') } catch (e) {}
const db = require('../db');
const {
    PAGE_ACCESS_ROLES, PAGE_ACCESS_PAGES, PAGE_ACCESS_DEFAULT_ENABLED, loadRolePageAccessCache,
    ACTION_ACCESS_ROLES, ACTION_ACCESS_PAGES, ACTION_TYPES, ACTION_ACCESS_DEFAULT_ENABLED, loadRoleActionAccessCache,
} = require('../core/access');

// ========== Auto-create tables for Approval & Notification system ==========
// เก็บ promise ไว้ (export เป็น migrationsReady) — tests ต้องรอให้ migration ชุดหลักเสร็จก่อนเริ่ม ไม่งั้น ALTER TABLE ที่ยัง
// รันอยู่ชนกับ transaction ของ test เป็น MDL deadlock แบบสุ่ม ("Deadlock found when trying to get lock" — พบ 8 ต.ค. 2569)
const migrationsReady = (async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS login_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(100) NULL,
                action VARCHAR(100) NULL,
                details TEXT NULL,
                ip_address VARCHAR(45) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_created_at (created_at)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                dept_id INT NULL,
                action_type ENUM('INSERT','UPDATE','DELETE') NULL,
                table_name VARCHAR(50) NULL,
                record_id INT NULL,
                old_value LONGTEXT NULL,
                new_value LONGTEXT NULL,
                ip_address VARCHAR(45) NULL,
                user_agent TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_created_at (created_at)
            )
        `);
        // Error logs — รวบ error จากทั้ง backend + frontend ไว้ที่เดียว
        await db.query(`
            CREATE TABLE IF NOT EXISTS error_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                source ENUM('backend','frontend','http') NOT NULL,
                severity ENUM('error','warning','fatal') DEFAULT 'error',
                fingerprint VARCHAR(64) NULL,
                message TEXT NOT NULL,
                stack TEXT NULL,
                url VARCHAR(500) NULL,
                user_id INT NULL,
                username VARCHAR(100) NULL,
                user_agent TEXT NULL,
                ip_address VARCHAR(64) NULL,
                extra TEXT NULL,
                count INT DEFAULT 1,
                first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_seen DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                resolved TINYINT(1) DEFAULT 0,
                resolved_by INT NULL,
                resolved_at DATETIME NULL,
                UNIQUE KEY uk_fingerprint (fingerprint),
                INDEX idx_source_severity (source, severity),
                INDEX idx_last_seen (last_seen),
                INDEX idx_resolved (resolved)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // idempotent migration: ถ้า table เก่ามี idx_fingerprint แบบไม่ unique → DROP + ADD unique
        try { await db.query('ALTER TABLE error_logs DROP INDEX idx_fingerprint'); } catch (e) {}
        try { await db.query('ALTER TABLE error_logs ADD UNIQUE KEY uk_fingerprint (fingerprint)'); } catch (e) {}
        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NULL,
                hospcode VARCHAR(10) NULL,
                type ENUM('approve','reject','info') NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT,
                indicator_id INT NULL,
                year_bh VARCHAR(10) NULL,
                is_read TINYINT(1) DEFAULT 0,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_hospcode (hospcode),
                INDEX idx_read (is_read)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_rejection_comments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                indicator_id INT NOT NULL,
                year_bh VARCHAR(10) NOT NULL,
                hospcode VARCHAR(10) NOT NULL,
                comment TEXT NOT NULL,
                reject_months VARCHAR(255) NULL,
                type ENUM('reject','reply') DEFAULT 'reject',
                rejected_by INT NULL,
                replied_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_kpi (indicator_id, year_bh, hospcode)
            )
        `);
        // Add columns if not exist (for existing tables)
        try {
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS reject_months VARCHAR(255) NULL AFTER comment`);
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS type ENUM('reject','reply') DEFAULT 'reject' AFTER reject_months`);
            await db.query(`ALTER TABLE kpi_rejection_comments ADD COLUMN IF NOT EXISTS replied_by INT NULL AFTER rejected_by`);
        } catch (e) {
            // columns may already exist
        }
        // เพิ่ม is_active ให้ตาราง master data ที่ยังไม่มี
        try {
            await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1`);
            await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1`);
            await db.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS is_active TINYINT(1) DEFAULT 1`);
        } catch (e) {
            // columns may already exist
        }
        // ========== Appeal system migration ==========
        // เพิ่ม type สำหรับอุทธรณ์ใน kpi_rejection_comments
        try {
            await db.query(`ALTER TABLE kpi_rejection_comments MODIFY type ENUM('reject','reply','appeal','appeal_approve','appeal_reject') DEFAULT 'reject'`);
            await db.query(`ALTER TABLE kpi_rejection_comments MODIFY rejected_by INT NULL DEFAULT NULL`);
            await db.query(`ALTER TABLE kpi_rejection_comments MODIFY replied_by INT NULL DEFAULT NULL`);
        } catch (e) { /* may already be correct */ }

        // เพิ่ม data entry lock settings
        const entryLockDefaults = [
            ['data_entry_locked', 'false', 'ล็อคการคีย์ข้อมูล (เปิด/ปิดด้วยมือ)'],
            ['data_entry_lock_start', '', 'วันที่เริ่มล็อคการคีย์ (YYYY-MM-DD)'],
            ['data_entry_lock_end', '', 'วันที่สิ้นสุดล็อค (YYYY-MM-DD)'],
            ['data_entry_lock_days', '0', 'จำนวนวันที่ล็อค (นับจากวันเริ่ม, 0=ใช้วันสิ้นสุดแทน)']
        ];
        for (const [key, val, desc] of entryLockDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม maintenance mode settings
        await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)',
            ['maintenance_mode', 'false', 'โหมดปิดปรับปรุงระบบ (true/false)']);
        await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)',
            ['maintenance_message', 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน', 'ข้อความแจ้งเตือนเมื่อปิดปรับปรุง']);

        // เพิ่ม notification toggle settings
        const notifToggleDefaults = [
            ['notif_telegram_enabled', 'true', 'เปิด/ปิดแจ้งเตือนผู้สมัครใหม่ทาง Telegram'],
            ['notif_email_enabled', 'true', 'เปิด/ปิดแจ้งเตือนผู้สมัครใหม่ทาง Email'],
            ['notif_system_enabled', 'true', 'เปิด/ปิดแจ้งเตือนผู้สมัครใหม่ในระบบ']
        ];
        for (const [key, val, desc] of notifToggleDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม target edit lock setting
        await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)',
            ['target_edit_locked', 'false', 'ล็อคการแก้ไขเป้าหมาย (เฉพาะ admin_ssj และ super_admin)']);

        // ========== User Permissions (super_admin กำหนดสิทธิ์ราย user) ==========
        // เพิ่มคอลัมน์สิทธิ์ในตาราง users (default = แก้ได้ทั้งคู่)
        try { await db.query('ALTER TABLE users ADD COLUMN can_edit_actual TINYINT(1) DEFAULT 1'); } catch (e) {}
        try { await db.query('ALTER TABLE users ADD COLUMN can_edit_target TINYINT(1) DEFAULT 1'); } catch (e) {}
        // === Personal LINE notification (per-user opt-in) ===
        // line_user_id = LINE userId (Uxxxxx...) — ได้จาก bot webhook event หรือ LINE Login
        // notif_line_enabled = master toggle ของ user (default 1 = เปิด ส่งได้ ถ้ามี line_user_id)
        try { await db.query("ALTER TABLE users ADD COLUMN line_user_id VARCHAR(64) NULL COMMENT 'LINE userId — Uxxxxx... จาก LINE Login หรือ webhook'"); } catch (e) {}
        try { await db.query('ALTER TABLE users ADD COLUMN notif_line_enabled TINYINT(1) DEFAULT 1'); } catch (e) {}
        try { await db.query('ALTER TABLE users ADD UNIQUE INDEX uniq_line_user_id (line_user_id)'); } catch (e) {}
        // line_inbox: เก็บ userId ที่ทักเข้า bot — super_admin ใช้ link เข้า users
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS line_inbox (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    line_user_id VARCHAR(64) NOT NULL UNIQUE,
                    display_name VARCHAR(255) NULL,
                    picture_url VARCHAR(500) NULL,
                    last_message TEXT NULL,
                    message_count INT DEFAULT 1,
                    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    linked_user_id INT NULL,
                    linked_at DATETIME NULL,
                    is_archived TINYINT(1) DEFAULT 0,
                    INDEX idx_received_at (received_at),
                    INDEX idx_linked_user (linked_user_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (e) {}

        // ========== Concurrent login — เก็บข้อมูล "ใครเตะ session ออก" ==========
        // (idempotent — ถ้า column มีแล้ว skip)
        try { await db.query('ALTER TABLE users ADD COLUMN kicked_by_ip VARCHAR(64) NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE users ADD COLUMN kicked_by_ua VARCHAR(255) NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE users ADD COLUMN kicked_at DATETIME NULL'); } catch (e) {}

        // เพิ่ม appeal settings defaults
        const appealDefaults = [
            ['appeal_enabled', 'false', 'เปิด/ปิดระบบอุทธรณ์'],
            ['appeal_start_date', '', 'วันที่เริ่มเปิดรับอุทธรณ์ (YYYY-MM-DD)'],
            ['appeal_end_date', '', 'วันที่ปิดรับอุทธรณ์ (YYYY-MM-DD)'],
            ['appeal_days_after_approve', '0', 'จำนวนวันหลัง approve ที่ยื่นอุทธรณ์ได้ (0=ไม่จำกัด)']
        ];
        for (const [key, val, desc] of appealDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม toggle settings สำหรับ Auto Logout, Countdown, Max Login Attempts
        const toggleDefaults = [
            ['login_attempts_enabled', 'true', 'เปิด/ปิดระบบนับจำนวนครั้ง Login ผิดพลาด'],
            ['auto_logout_enabled', 'true', 'เปิด/ปิดระบบ Auto Logout เมื่อไม่มีการใช้งาน'],
            ['idle_countdown_enabled', 'true', 'เปิด/ปิดเวลานับถอยหลังแจ้งเตือนก่อน Auto Logout']
        ];
        for (const [key, val, desc] of toggleDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // เพิ่ม notification settings defaults
        const notifDefaults = [
            ['telegram_bot_token', '', 'Telegram Bot Token สำหรับแจ้งเตือนผู้สมัครใหม่'],
            ['telegram_chat_id', '', 'Telegram Chat ID (Group) สำหรับแจ้งเตือน'],
            ['admin_emails', '', 'Email Admin สำหรับแจ้งเตือนผู้สมัครใหม่ (คั่นด้วย comma)'],
            ['line_channel_token', '', 'LINE Messaging API — Channel Access Token (long-lived) จาก LINE Developers Console'],
            ['line_channel_secret', '', 'LINE Messaging API — Channel Secret (ใช้ verify webhook signature)'],
            ['line_group_id', '', 'LINE Group ID ที่จะส่งแจ้งเตือน (คั่นด้วย comma สำหรับหลาย group)'],
            ['notif_line_enabled', 'true', 'เปิด/ปิด LINE Group แจ้งเตือนทั่วระบบ (master switch)'],
            ['notif_line_admin_login', 'true', 'แจ้ง LINE เมื่อ super_admin/admin_ssj login'],
            ['notif_line_backup', 'true', 'แจ้ง LINE ผลการ backup (manual + scheduled)'],
            ['notif_line_restore', 'true', 'แจ้ง LINE ผลการ restore'],
            ['notif_line_settings_change', 'true', 'แจ้ง LINE เมื่อแก้ไข settings'],
            ['notif_line_indicator_change', 'true', 'แจ้ง LINE เมื่อ CRUD ตัวชี้วัด (kpi_indicators)']
        ];
        for (const [key, val, desc] of notifDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // ========== Users Data Sync — Field Mapping / Exclude Config ==========
        // Widen ครั้งเดียว (ปลอดภัย เป็นแค่ widen VARCHAR→TEXT ไม่เสียข้อมูลเดิม) กัน JSON mapping/exclude list ยาวเกิน 255
        try { await db.query('ALTER TABLE system_settings MODIFY COLUMN setting_value TEXT NULL'); } catch (e) {}
        const usersSyncDefaults = [
            ['users_sync_exclude_columns', JSON.stringify([
                'last_seen_at', 'last_seen_ip', 'last_seen_ua',
                'active_session_id', 'session_started_at',
                'kicked_by_ip', 'kicked_by_ua', 'kicked_at',
                'temp_password', 'temp_password_expiry', 'must_change_password'
            ]), 'คอลัมน์ users ที่ไม่ต้อง sync/เทียบกับ KHD (JSON array ชื่อคอลัมน์ local)'],
            ['users_sync_field_mapping', '{}', 'Mapping ชื่อคอลัมน์ users local → KHD ที่ไม่ตรงกัน (JSON object {local_field:khd_field}) — ว่าง = identity ทั้งหมด']
        ];
        for (const [key, val, desc] of usersSyncDefaults) {
            await db.query('INSERT IGNORE INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?)', [key, val, desc]);
        }

        // Auto-generate relay auth key สำหรับ Cloudflare Worker (random 32 chars) ถ้ายังไม่มี
        try {
            const [existing] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'line_relay_auth_key' LIMIT 1");
            if (!existing[0] || !existing[0].setting_value) {
                const newKey = crypto.randomBytes(24).toString('hex'); // 48 chars hex
                await db.query('INSERT INTO system_settings (setting_key, setting_value, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
                    ['line_relay_auth_key', newKey, 'Auth key สำหรับ Cloudflare Worker forward LINE webhook → KHUPS (ใส่เป็น env RELAY_AUTH_KEY ใน Worker)']);
                console.log('[INIT] Auto-generated line_relay_auth_key for Cloudflare Worker integration');
            }
        } catch (e) { console.warn('[INIT] line_relay_auth_key:', e.message); }

        // เพิ่ม type 'appeal' ใน notifications
        try {
            await db.query(`ALTER TABLE notifications MODIFY type ENUM('approve','reject','info','appeal') NOT NULL`);
        } catch (e) { /* may already be correct */ }

        // เพิ่ม cid และ is_approved ใน users table
        try {
            await db.query(`ALTER TABLE users ADD COLUMN cid VARCHAR(13) NULL`);
        } catch (e) { /* already exists */ }
        // rename national_id → cid ถ้ายังใช้ชื่อเก่าอยู่
        try {
            const [cols] = await db.query(`SHOW COLUMNS FROM users LIKE 'national_id'`);
            if (cols.length > 0) {
                await db.query(`ALTER TABLE users CHANGE national_id cid VARCHAR(13) NULL`);
            }
        } catch (e) { /* ignore */ }
        // ขยาย cid เป็น VARCHAR(64) เพื่อรองรับ SHA-256 hash
        try {
            await db.query(`ALTER TABLE users MODIFY cid VARCHAR(64) NULL`);
        } catch (e) { /* ignore */ }
        // เพิ่ม email column
        try {
            await db.query(`ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL`);
        } catch (e) { /* already exists */ }
        // เพิ่ม forgot-password columns
        try { await db.query(`ALTER TABLE users ADD COLUMN temp_password VARCHAR(255) NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN temp_password_expiry DATETIME NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN last_seen_ip VARCHAR(64) NULL`); } catch (e) {}
        try { await db.query(`ALTER TABLE users ADD COLUMN last_seen_ua VARCHAR(255) NULL`); } catch (e) {}

        // === Single-session enforcement (กัน login ซ้อนจากหลายเครื่อง) ===
        // ตรวจสอบก่อนว่ามีคอลัมน์อยู่หรือยัง — ถ้าไม่มี ค่อย ALTER (พร้อม log ชัดเจน)
        try {
            const [colCheck] = await db.query(`
                SELECT COLUMN_NAME FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
                  AND COLUMN_NAME IN ('active_session_id','session_started_at')
            `);
            const cols = colCheck.map(c => c.COLUMN_NAME || c.column_name);
            const hasSessionId = cols.includes('active_session_id');
            const hasSessionStarted = cols.includes('session_started_at');
            if (!hasSessionId) {
                try {
                    await db.query(`ALTER TABLE users ADD COLUMN active_session_id VARCHAR(64) NULL`);
                    console.log('✅ [Single Session] เพิ่มคอลัมน์ active_session_id สำเร็จ');
                } catch (e) {
                    console.error('❌ [Single Session] ไม่สามารถเพิ่มคอลัมน์ active_session_id —', e.message);
                    console.error('   👉 กรุณา run manual SQL บน DB:');
                    console.error('      ALTER TABLE users ADD COLUMN active_session_id VARCHAR(64) NULL;');
                    console.error('      ALTER TABLE users ADD COLUMN session_started_at DATETIME NULL;');
                    console.error('      ALTER TABLE users ADD INDEX idx_active_session (active_session_id);');
                }
            } else {
                console.log('✓ [Single Session] คอลัมน์ active_session_id พร้อมใช้งาน');
            }
            if (!hasSessionStarted) {
                try { await db.query(`ALTER TABLE users ADD COLUMN session_started_at DATETIME NULL`); } catch (e) {
                    console.error('❌ [Single Session] ไม่สามารถเพิ่ม session_started_at —', e.message);
                }
            }
            try { await db.query(`ALTER TABLE users ADD INDEX idx_active_session (active_session_id)`); } catch (e) {}
        } catch (e) {
            console.error('❌ [Single Session] ตรวจสอบ schema ล้มเหลว —', e.message);
        }
        try { await db.query(`CREATE INDEX idx_last_seen_at ON users(last_seen_at)`); } catch (e) {}
        // สร้างตาราง chostype (ประเภทสถานบริการ)
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS chostype (
                    hostypecode CHAR(2) NOT NULL PRIMARY KEY,
                    hostypename VARCHAR(255)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            const [cnt] = await db.query('SELECT COUNT(*) AS c FROM chostype');
            if (cnt[0].c === 0) {
                await db.query(`INSERT INTO chostype (hostypecode, hostypename) VALUES
                    ('01','สำนักงานสาธารณสุขจังหวัด'),('02','สำนักงานสาธารณสุขอำเภอ'),
                    ('03','สถานีอนามัย'),('04','สถานบริการสาธารณสุขชุมชน'),
                    ('05','โรงพยาบาลศูนย์'),('06','โรงพยาบาลทั่วไป'),
                    ('07','โรงพยาบาลชุมชน'),('08','ศูนย์สุขภาพชุมชน ของ รพ.'),
                    ('09','ศูนย์สุขภาพชุมชน สธ.'),('10','ศูนย์วิชาการ'),
                    ('11','โรงพยาบาล นอก สป.สธ.'),('12','โรงพยาบาล นอก สธ.'),
                    ('13','ศูนย์บริการสาธารณสุข'),('14','ศูนย์สุขภาพชุมชน นอก สธ.'),
                    ('15','โรงพยาบาลเอกชน'),('16','คลินิกเอกชน'),
                    ('17','โรงพยาบาล/ศูนย์บริการสาธารณสุข สาขา'),('18','โรงพยาบาลส่งเสริมสุขภาพตำบล')`);
            }
        } catch (e) {}

        // เพิ่ม distid column ใน chospital (performance: ลด CONCAT runtime)
        try {
            await db.query('ALTER TABLE chospital ADD COLUMN distid VARCHAR(10)');
            console.log('[Migration] Added chospital.distid column');
        } catch (e) { /* already exists */ }
        try {
            await db.query('UPDATE chospital SET distid = CONCAT(provcode, distcode) WHERE distid IS NULL');
            await db.query('CREATE INDEX idx_chospital_distid ON chospital (distid)');
        } catch (e) { /* already done */ }

        // เพิ่ม kpi_summary table
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_summary (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    indicator_id INT NOT NULL,
                    year_bh VARCHAR(10) NOT NULL,
                    hospcode VARCHAR(20) NOT NULL,
                    main_indicator_name VARCHAR(500),
                    kpi_indicators_name TEXT,
                    dept_id INT,
                    dept_name VARCHAR(255),
                    hosname VARCHAR(255),
                    distid VARCHAR(20),
                    distname VARCHAR(255),
                    table_process VARCHAR(100),
                    target_value VARCHAR(100),
                    oct VARCHAR(100), nov VARCHAR(100), dece VARCHAR(100),
                    jan VARCHAR(100), feb VARCHAR(100), mar VARCHAR(100),
                    apr VARCHAR(100), may VARCHAR(100), jun VARCHAR(100),
                    jul VARCHAR(100), aug VARCHAR(100), sep VARCHAR(100),
                    last_actual VARCHAR(100),
                    pending_count INT DEFAULT 0,
                    indicator_status VARCHAR(20),
                    is_locked TINYINT DEFAULT 0,
                    has_form_schema TINYINT DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_ind_year_hos (indicator_id, year_bh, hospcode),
                    INDEX idx_year (year_bh),
                    INDEX idx_hospcode (hospcode),
                    INDEX idx_dept (dept_name),
                    INDEX idx_dept_id (dept_id),
                    INDEX idx_distid (distid),
                    INDEX idx_district (distname)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (e) { /* already exists */ }

        // แก้ collation ของ kpi_summary ให้ตรงกับตารางอื่น
        try { await db.query('ALTER TABLE kpi_summary CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); } catch(e) {}

        // เพิ่ม dept_id, distid ใน kpi_summary สำหรับ role-based filtering
        try { await db.query('ALTER TABLE kpi_summary ADD COLUMN dept_id INT AFTER kpi_indicators_name'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD COLUMN distid VARCHAR(20) AFTER hosname'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD COLUMN hostype VARCHAR(5) AFTER distid'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD INDEX idx_hostype (hostype)'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD INDEX idx_dept_id (dept_id)'); } catch(e) {}
        try { await db.query('ALTER TABLE kpi_summary ADD INDEX idx_distid (distid)'); } catch(e) {}

        // ========== kpi_sub_indicators + kpi_sub_results ==========
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_sub_indicators (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    indicator_id INT NOT NULL,
                    sub_indicator_name VARCHAR(500) NOT NULL,
                    sub_indicator_code VARCHAR(100),
                    target_percentage VARCHAR(100),
                    weight DECIMAL(5,2) DEFAULT 1.00,
                    description TEXT,
                    sort_order INT DEFAULT 0,
                    is_active TINYINT(1) DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_indicator (indicator_id),
                    INDEX idx_active (is_active)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try { await db.query('ALTER TABLE kpi_sub_indicators ADD CONSTRAINT fk_sub_indicator FOREIGN KEY (indicator_id) REFERENCES kpi_indicators(id) ON DELETE CASCADE'); } catch(e) {}
        } catch (e) {}

        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_sub_results (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    sub_indicator_id INT NOT NULL,
                    year_bh VARCHAR(10) NOT NULL,
                    hospcode VARCHAR(20) NOT NULL,
                    month_bh INT NOT NULL,
                    target_value VARCHAR(100),
                    actual_value VARCHAR(100),
                    status VARCHAR(20) DEFAULT 'Pending',
                    user_id INT,
                    is_locked TINYINT(1) DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_sub_year_hos_month (sub_indicator_id, year_bh, hospcode, month_bh),
                    INDEX idx_sub (sub_indicator_id),
                    INDEX idx_year_hos (year_bh, hospcode)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try { await db.query('ALTER TABLE kpi_sub_results ADD CONSTRAINT fk_sub_result FOREIGN KEY (sub_indicator_id) REFERENCES kpi_sub_indicators(id) ON DELETE CASCADE'); } catch(e) {}
        } catch (e) {}

        // ========== ตัวชี้วัด 3 ระดับ (18 ต.ค. 2569): กิจกรรมใต้ตัวชี้วัดย่อย + โหมดคำนวณจากระดับล่าง ==========
        // ค่าตั้งต้นทุกคอลัมน์ = พฤติกรรมเดิม: ข้อย่อยกรอกเอง (manual), ตัวชี้วัดหลักคำนวณจากข้อย่อย (auto)
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_sub_activities (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    sub_indicator_id INT NOT NULL,
                    activity_name VARCHAR(500) NOT NULL,
                    activity_code VARCHAR(100),
                    item_no VARCHAR(20),
                    value_type ENUM('number','check') DEFAULT 'number',
                    target_percentage VARCHAR(100),
                    sort_order INT DEFAULT 0,
                    is_active TINYINT(1) DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_sub (sub_indicator_id),
                    CONSTRAINT fk_activity_sub FOREIGN KEY (sub_indicator_id) REFERENCES kpi_sub_indicators(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            // จับคู่ค่าข้อความของ KHD (reports.dept / main_indicator / main_yut) กับ Local — local_id NULL = ตั้งไว้ว่าไม่ต้องจับคู่ (19 ต.ค. 2569)
            await db.query(`
                CREATE TABLE IF NOT EXISTS khd_value_mappings (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    kind ENUM('dept','main','yut') NOT NULL,
                    khd_key CHAR(64) NOT NULL,
                    khd_value VARCHAR(1000) NOT NULL,
                    local_id INT NULL,
                    updated_by INT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_kind_key (kind, khd_key)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_activity_results (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    activity_id INT NOT NULL,
                    year_bh VARCHAR(10) NOT NULL,
                    hospcode VARCHAR(20) NOT NULL,
                    month_bh INT NOT NULL,
                    target_value VARCHAR(100),
                    actual_value VARCHAR(100),
                    status VARCHAR(20) DEFAULT 'Pending',
                    user_id INT,
                    is_locked TINYINT(1) DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_act_year_hos_month (activity_id, year_bh, hospcode, month_bh),
                    INDEX idx_year_hos (year_bh, hospcode),
                    CONSTRAINT fk_activity_result FOREIGN KEY (activity_id) REFERENCES kpi_sub_activities(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (e) { console.error('❌ kpi_sub_activities/kpi_activity_results:', e.message); }
        // ค่าฐาน (base) ของคู่ตัวชี้วัด × หน่วยบริการ × ปีงบ (24 ต.ค. 2569) — ตัวแปร base ในสูตรคำนวณผลงาน เช่น ค่าเฉลี่ย 5 ปีของการเสียชีวิตจากการจมน้ำ
        // 1 ค่าต่อคู่ (ไม่ซ้ำ 12 เดือนเหมือน target_value ใน kpi_results) — บันทึกผ่าน /update-kpi เท่านั้น (สิทธิ์/ล็อคเดียวกับเป้าหมาย)
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS kpi_base_values (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    indicator_id INT NOT NULL,
                    year_bh VARCHAR(10) NOT NULL,
                    hospcode VARCHAR(20) NOT NULL,
                    var_key VARCHAR(20) NOT NULL DEFAULT 'base',
                    base_value VARCHAR(100) NULL,
                    updated_by INT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_base_ind_year_hos_var (indicator_id, year_bh, hospcode, var_key),
                    CONSTRAINT fk_base_indicator FOREIGN KEY (indicator_id) REFERENCES kpi_indicators(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
        } catch (e) { console.error('❌ kpi_base_values:', e.message); }
        // ค่าเพิ่มเติมหลายค่าต่อคู่ (25 ต.ค. 2569): ตารางเดิม (24 ต.ค.) ไม่มี var_key → เพิ่มคอลัมน์ (ค่าเดิมทั้งหมด = base) แล้วเปลี่ยน UNIQUE
        // เพิ่ม index ใหม่ก่อนลบตัวเดิมในคำสั่งเดียว (index นำหน้าด้วย indicator_id ยังรองรับ FK fk_base_indicator)
        try {
            const [cols] = await db.query("SHOW COLUMNS FROM kpi_base_values LIKE 'var_key'");
            if (!cols.length) {
                await db.query("ALTER TABLE kpi_base_values ADD COLUMN var_key VARCHAR(20) NOT NULL DEFAULT 'base' AFTER hospcode");
            }
            const [idx] = await db.query("SHOW INDEX FROM kpi_base_values WHERE Key_name = 'uk_base_ind_year_hos'");
            if (idx.length) {
                await db.query('ALTER TABLE kpi_base_values ADD UNIQUE KEY uk_base_ind_year_hos_var (indicator_id, year_bh, hospcode, var_key), DROP INDEX uk_base_ind_year_hos');
            }
        } catch (e) { console.error('❌ kpi_base_values var_key:', e.message); }
        // ค่าเพิ่มเติมที่ตั้งชื่อเอง [{key,label}] + สูตรร้อยละ ของตัวชี้วัด (25 ต.ค. 2569)
        try { await db.query('ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS custom_vars TEXT NULL'); } catch (e) {}
        try { await db.query('ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS pct_formula VARCHAR(500) NULL'); } catch (e) {}
        // ผลงานล่าสุด / ร้อยละ แบบกรอกเอง (29 ต.ค. 2569) — ค่าที่กรอกเก็บใน kpi_base_values var_key '__result' / '__pct' (services/manual-result.js)
        try { await db.query('ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS result_manual TINYINT(1) NOT NULL DEFAULT 0'); } catch (e) {}
        try { await db.query('ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS pct_manual TINYINT(1) NOT NULL DEFAULT 0'); } catch (e) {}
        // ร้อยละที่กรอกเองในตารางสรุป: NULL = คำนวณตามเงื่อนไขเป้าหมาย, '' = กรอกเองแต่ยังไม่กรอก (core/sql.js targetHasSql/targetPassSql)
        try { await db.query('ALTER TABLE kpi_summary ADD COLUMN IF NOT EXISTS manual_pct VARCHAR(30) NULL'); } catch (e) {}
        try { await db.query("ALTER TABLE kpi_sub_indicators ADD COLUMN rollup_mode VARCHAR(10) NOT NULL DEFAULT 'manual'"); } catch (e) {}
        // ตัวชี้วัดหลายระดับ (19 ต.ค. 2569): ข้อย่อยมีข้อแม่เป็นข้อย่อยได้ — NULL = ข้อย่อยระดับบนสุด (ข้อมูลเดิมทั้งหมด)
        try { await db.query('ALTER TABLE kpi_sub_indicators ADD COLUMN parent_sub_id INT NULL AFTER indicator_id'); } catch (e) {}
        try { await db.query('ALTER TABLE kpi_sub_indicators ADD INDEX idx_parent_sub (parent_sub_id)'); } catch (e) {}
        try { await db.query('ALTER TABLE kpi_sub_indicators ADD CONSTRAINT fk_sub_parent FOREIGN KEY (parent_sub_id) REFERENCES kpi_sub_indicators(id) ON DELETE CASCADE'); } catch (e) {}
        try { await db.query('ALTER TABLE kpi_sub_indicators ADD COLUMN item_no VARCHAR(20) NULL'); } catch (e) {}
        try { await db.query("ALTER TABLE kpi_indicators ADD COLUMN sub_rollup_mode VARCHAR(10) NOT NULL DEFAULT 'auto'"); } catch (e) {}
        try { await db.query('ALTER TABLE kpi_indicators ADD COLUMN item_no VARCHAR(20) NULL'); } catch (e) {}
        // ส่งออกรายละเอียดข้อย่อย/กิจกรรมเป็นตาราง <table_process>_items (ค่าตั้งต้นปิด)
        try { await db.query('ALTER TABLE kpi_indicators ADD COLUMN export_items TINYINT(1) NOT NULL DEFAULT 0'); } catch (e) {}

        // แก้ kpi_indicators.dept_id + main_indicator_id จาก VARCHAR → INT (ถ้ายังเป็น VARCHAR)
        try {
            const [cols] = await db.query("SHOW COLUMNS FROM kpi_indicators WHERE Field = 'dept_id'");
            if (cols[0] && cols[0].Type.includes('varchar')) {
                await db.query("UPDATE kpi_indicators SET dept_id = NULL WHERE dept_id = '' OR dept_id = '0'");
                await db.query("UPDATE kpi_indicators SET main_indicator_id = NULL WHERE main_indicator_id = '' OR main_indicator_id = '0'");
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX dept_id'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX main_indicator_id'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX idx_kpi_indicators_dept'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators DROP INDEX idx_kpi_indicators_main'); } catch(e) {}
                await db.query('ALTER TABLE kpi_indicators MODIFY dept_id INT NULL');
                await db.query('ALTER TABLE kpi_indicators MODIFY main_indicator_id INT NULL');
                try { await db.query('ALTER TABLE kpi_indicators ADD CONSTRAINT fk_indicators_dept FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE SET NULL'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators ADD CONSTRAINT fk_indicators_main FOREIGN KEY (main_indicator_id) REFERENCES kpi_main_indicators(id) ON DELETE SET NULL'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators ADD INDEX idx_dept (dept_id)'); } catch(e) {}
                try { await db.query('ALTER TABLE kpi_indicators ADD INDEX idx_main (main_indicator_id)'); } catch(e) {}
                console.log('[Migration] Fixed kpi_indicators FK columns VARCHAR→INT');
            }
        } catch (e) { console.log('[Migration] kpi_indicators FK check:', e.message); }

        // เพิ่ม performance indexes บน kpi_results
        try { await db.query('CREATE INDEX idx_kpi_results_year ON kpi_results (year_bh)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_indicator ON kpi_results (indicator_id)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_hospcode ON kpi_results (hospcode)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_composite ON kpi_results (indicator_id, year_bh, hospcode)'); } catch (e) {}

        // เพิ่ม approved_by column
        try { await db.query(`ALTER TABLE users ADD COLUMN approved_by INT NULL`); } catch (e) {}
        // เพิ่ม indexes สำหรับ kpi_results (เร่งความเร็ว dashboard)
        try { await db.query('CREATE INDEX idx_kpi_results_year ON kpi_results (year_bh)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_indicator ON kpi_results (indicator_id)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_hospcode ON kpi_results (hospcode)'); } catch (e) {}
        try { await db.query('CREATE INDEX idx_kpi_results_composite ON kpi_results (indicator_id, year_bh, hospcode)'); } catch (e) {}

        // เพิ่ม is_active ใน users table
        try {
            await db.query(`ALTER TABLE users ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1`);
            await db.query(`UPDATE users SET is_active = 1 WHERE is_active != 1`);
        } catch (e) { /* already exists */ }
        // เปลี่ยน actual_value เป็น VARCHAR เพื่อรองรับข้อความ
        try {
            await db.query(`ALTER TABLE kpi_results MODIFY actual_value VARCHAR(100) NULL`);
        } catch (e) { /* ignore */ }
        // เปลี่ยน target_value เป็น VARCHAR เพื่อรองรับข้อความ
        try {
            await db.query(`ALTER TABLE kpi_results MODIFY target_value VARCHAR(100) NULL`);
        } catch (e) { /* ignore */ }
        try {
            await db.query(`ALTER TABLE users ADD COLUMN is_approved TINYINT(1) NOT NULL DEFAULT 1`);
            // ผู้ใช้เดิมทั้งหมดถือว่า approved
            await db.query(`UPDATE users SET is_approved = 1 WHERE is_approved != 1`);
        } catch (e) { /* already exists */ }

        // สร้างตาราง target_edit_requests
        await db.query(`
            CREATE TABLE IF NOT EXISTS target_edit_requests (
                id INT AUTO_INCREMENT PRIMARY KEY,
                indicator_id INT NOT NULL,
                year_bh VARCHAR(10) NOT NULL,
                hospcode VARCHAR(10) NOT NULL,
                requested_by INT NOT NULL,
                requested_by_name VARCHAR(255) NULL,
                status ENUM('pending','approved','rejected','completed') DEFAULT 'pending',
                approved_by INT NULL,
                reject_reason VARCHAR(500) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        // เพิ่ม type 'target_request' ใน notifications
        try {
            await db.query(`ALTER TABLE notifications MODIFY type ENUM('approve','reject','info','appeal','target_request') NOT NULL`);
        } catch (e) { /* may already be correct */ }

        // ========== Feedback Board ==========
        await db.query(`
            CREATE TABLE IF NOT EXISTS feedback_posts (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                category ENUM('suggestion','question','bug','other') DEFAULT 'suggestion',
                title VARCHAR(255) NOT NULL,
                message TEXT NOT NULL,
                status ENUM('open','in_progress','resolved','closed') DEFAULT 'open',
                reply_count INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_status (status)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS feedback_replies (
                id INT AUTO_INCREMENT PRIMARY KEY,
                post_id INT NOT NULL,
                user_id INT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (post_id) REFERENCES feedback_posts(id) ON DELETE CASCADE,
                INDEX idx_post (post_id)
            )
        `);

        // ========== Form Builder migration ==========
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_form_schemas (
                id INT AUTO_INCREMENT PRIMARY KEY,
                indicator_id INT NOT NULL,
                form_title VARCHAR(200) NOT NULL,
                form_description TEXT NULL,
                created_by INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                is_active TINYINT(1) DEFAULT 1,
                INDEX idx_indicator (indicator_id)
            )
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS kpi_form_fields (
                id INT AUTO_INCREMENT PRIMARY KEY,
                schema_id INT NOT NULL,
                field_name VARCHAR(100) NOT NULL,
                field_label VARCHAR(200) NOT NULL,
                field_type ENUM('text','number','textarea','select','date','checkbox','score_option') DEFAULT 'text',
                field_options TEXT NULL,
                is_required TINYINT(1) DEFAULT 0,
                sort_order INT DEFAULT 0,
                FOREIGN KEY (schema_id) REFERENCES kpi_form_schemas(id) ON DELETE CASCADE
            )
        `);
        // ขยาย ENUM field_type ให้รองรับ score_option (สำหรับ table เก่า)
        try {
            await db.query(`ALTER TABLE kpi_form_fields MODIFY COLUMN field_type ENUM('text','number','textarea','select','date','checkbox','score_option') DEFAULT 'text'`);
        } catch (e) { /* may already match */ }
        // เพิ่ม table_process ใน kpi_indicators ถ้ายังไม่มี
        try {
            await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS table_process VARCHAR(100) NULL`);
        } catch (e) { /* may already exist */ }
        // เพิ่มฟิลด์ที่ขาดใน kpi_indicators
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS kpi_indicators_id VARCHAR(50) NULL COMMENT 'รหัสอ้างอิง'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS target_condition VARCHAR(10) NULL COMMENT 'GTE/LTE/EQ'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS r9 TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS moph TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS ssj TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS rmw TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS other TINYINT(1) DEFAULT 0`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS evaluation_mode VARCHAR(20) NULL COMMENT 'any_one | all_required'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS required_off_types TEXT NULL COMMENT 'JSON array of hostypecode เช่น ["05","06","07"]'`); } catch(e) {}
        // upload_excel: 0 = ส่งออกอัตโนมัติได้ (default), 1 = ข้าม (อัปโหลด Excel มือเอง — เช่น KHD report ถูก deactivate)
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS upload_excel TINYINT(1) DEFAULT 0 COMMENT '0=auto export, 1=skip (manual Excel upload)'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD INDEX idx_upload_excel (upload_excel)`); } catch(e) {}
        // data_source: จาก hdc.reports.data_source ('hdc'|'excel' — ค่าจริงจากฐานข้อมูล KHD ภายนอก) — เก็บไว้อ้างอิง/กรองในอนาคต
        // ใช้ VARCHAR ไม่ใช่ ENUM — กัน KHD เพิ่มค่าใหม่แล้ว local ตามไม่ทัน (evaluation_mode/target_condition ก็ใช้ VARCHAR ด้วยเหตุผลเดียวกัน)
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS data_source VARCHAR(10) NULL COMMENT 'จาก hdc.reports.data_source: hdc|excel'`); } catch(e) {}
        // khd_report_id: link ถาวรไปยัง KHD reports.report_id (แยกจาก kpi_indicators_id เดิมซึ่งเป็น "รหัสอ้างอิง" ที่ admin กรอกเอง ไม่เกี่ยวกับ KHD)
        // match ผ่าน table_process (heuristic เดียวกับ /report-compare) — เก็บไว้กันต้องเทียบใหม่ทุกครั้ง + ใช้เป็น source of truth ของ data_source
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS khd_report_id INT NULL COMMENT 'FK ไปยัง KHD reports.report_id (persistent link ผ่าน table_process)'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD INDEX idx_khd_report_id (khd_report_id)`); } catch(e) {}
        // khd_fiscal_year: ปีงบฯ (พ.ศ.) ที่ค่า target_percentage/target_condition ปัจจุบันอ้างอิงมาจาก KHD ล่าสุด — audit only ไม่ใช่ FK
        // เดิมชื่อ hdc_fiscal_year (ส่วนหนึ่งของการเปลี่ยนชื่อการเชื่อมต่อ HDC → KHD ทั้งระบบ) — rename คอลัมน์เดิมก่อนกันข้อมูลหาย
        try { await db.query(`ALTER TABLE kpi_indicators CHANGE COLUMN hdc_fiscal_year khd_fiscal_year VARCHAR(10) NULL COMMENT 'ปีงบฯ ที่ใช้อ้างอิง target_percentage/target_condition ล่าสุดจาก KHD (audit only)'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS khd_fiscal_year VARCHAR(10) NULL COMMENT 'ปีงบฯ ที่ใช้อ้างอิง target_percentage/target_condition ล่าสุดจาก KHD (audit only)'`); } catch(e) {}
        // ขยายจาก VARCHAR(10) — ใช้เก็บ comma-list ของทุกปีงบที่พบใน KHD report_fiscal_year_config ของ report_id นี้
        // (เช่น "2569,2570") ไม่ใช่แค่ปีเดียวอีกต่อไป เพื่อรองรับ filter+badge ปีงบประมาณในหน้าจัดการตัวชี้วัด
        try { await db.query(`ALTER TABLE kpi_indicators MODIFY COLUMN khd_fiscal_year VARCHAR(50) NULL COMMENT 'Comma-list ปีงบฯ ที่พบใน KHD report_fiscal_year_config (เช่น 2569,2570)'`); } catch(e) {}
        // Migrate ข้อมูล override เดิมใน system_settings (env_HDC_DB_* -> env_KHD_DB_*) ที่ admin เคยตั้งค่าผ่านหน้า Environment Config
        // กันการเชื่อมต่อ KHD ที่ใช้งานจริงอยู่ขาดหาย — idempotent เพราะรันซ้ำแล้วไม่มีแถว env_HDC% เหลือให้ match
        try { await db.query(`UPDATE system_settings SET setting_key = REPLACE(setting_key, 'HDC', 'KHD') WHERE setting_key LIKE 'env_HDC%'`); } catch(e) {}
        // is_cumulative: 1 = ผลงานสะสมทุกเดือนในปีงบ (SUM) แทนค่าเดือนล่าสุด — ใช้กับตัวชี้วัดนับสะสม เช่น จำนวนราย/ครั้งสะสม
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS is_cumulative TINYINT(1) DEFAULT 0 COMMENT 'สะสมทุกเดือนในปีงบ (SUM) แทนค่าเดือนล่าสุด'`); } catch(e) {}
        // result_formula: สูตรคำนวณผลงานเฉพาะตัวชี้วัด (api/kpi-formula.js) — มีค่าแล้วใช้แทน is_cumulative/ค่าเดือนล่าสุด
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS result_formula VARCHAR(500) NULL COMMENT 'สูตรคำนวณผลงาน เช่น AVG(ALL) — ว่าง = วิธีเดิม'`); } catch(e) {}
        // criterion: "เกณฑ์" แยกออกจาก target_percentage ("เป้าหมาย") — เดิมทั้งสองความหมายใช้ target_percentage
        // ตัวเดียวปนกัน (เกณฑ์เทียบ KHD vs ค่าเริ่มต้นที่ copy เข้า kpi_results.target_value) ทำให้แก้ไขอย่างใดอย่างหนึ่ง
        // กระทบอีกอย่างโดยไม่ตั้งใจ — แยกเป็นคอลัมน์ใหม่ ก๊อปปี้ค่าที่เคย "เป็นเกณฑ์" อยู่แล้วมาไว้ที่นี่ครั้งเดียว (backfill)
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS criterion VARCHAR(50) NULL COMMENT 'เกณฑ์ % (จับคู่กับ target_condition) — แยกจาก target_percentage (เป้าหมาย)'`); } catch(e) {}
        // Backfill ครั้งเดียว: idempotent ด้วย WHERE criterion IS NULL — รันซ้ำได้ทุก restart โดยไม่ทับค่าที่ admin ตั้งไว้แล้ว
        try { await db.query(`UPDATE kpi_indicators SET criterion = target_percentage WHERE criterion IS NULL AND target_percentage IS NOT NULL`); } catch(e) {}
        // ปุ่ม ⏳ ในตารางบันทึกผลงาน: เปลี่ยนคำจาก "รอดำเนินการ" เป็น "กำลังดำเนินการ" (19 ต.ค. 2569) — แปลงข้อมูลเดิม (ตรงตัวเท่านั้น, รันซ้ำได้)
        for (const [t, c] of [['kpi_results', 'actual_value'], ['kpi_sub_results', 'actual_value'], ['kpi_activity_results', 'actual_value'], ['kpi_summary', 'last_actual']]) {
            try { await db.query(`UPDATE ${t} SET ${c} = 'กำลังดำเนินการ' WHERE ${c} = 'รอดำเนินการ'`); } catch (e) {}
        }
        // use_sub_indicator_export: 1 = ตอน export ให้สร้างคอลัมน์ตามตัวชี้วัดย่อยแทนคอลัมน์รายเดือน (m10-m09)
        try { await db.query(`ALTER TABLE kpi_indicators ADD COLUMN IF NOT EXISTS use_sub_indicator_export TINYINT(1) DEFAULT 0 COMMENT 'ส่งออกโดยใช้ผลงานตัวชี้วัดย่อยแทนรายเดือน (1 คอลัมน์ต่อข้อย่อย)'`); } catch(e) {}

        // เพิ่มฟิลด์ใน main_yut (ยุทธศาสตร์)
        try { await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS yut_code VARCHAR(50) NULL COMMENT 'รหัสย่อยุทธศาสตร์'`); } catch(e) {}
        try { await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE main_yut ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`); } catch(e) {}

        // เพิ่มฟิลด์ใน kpi_main_indicators (หมวดหมู่หลัก)
        try { await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS main_indicator_code VARCHAR(50) NULL COMMENT 'รหัสย่อหมวดหมู่'`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE kpi_main_indicators ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`); } catch(e) {}

        // เพิ่มฟิลด์ใน departments
        try { await db.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS description TEXT NULL`); } catch(e) {}
        try { await db.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`); } catch(e) {}

        // ตาราง export_schedules + logs — จัดตารางเวลา export อัตโนมัติ
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS export_schedules (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(255) NOT NULL,
                    is_enabled TINYINT(1) DEFAULT 1,
                    days_of_week VARCHAR(20) DEFAULT '1,2,3,4,5',
                    time_of_day VARCHAR(5) DEFAULT '02:00',
                    year_bh VARCHAR(10),
                    indicator_ids TEXT,
                    notify_email TINYINT(1) DEFAULT 1,
                    email_recipients TEXT,
                    notify_telegram TINYINT(1) DEFAULT 0,
                    telegram_chat_ids TEXT,
                    telegram_bot_token VARCHAR(255),
                    indicator_scope VARCHAR(20) DEFAULT 'all',
                    auto_sync_khd TINYINT(1) DEFAULT 0,
                    last_run_at DATETIME,
                    last_status VARCHAR(20),
                    next_run_at DATETIME,
                    created_by INT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try { await db.query(`ALTER TABLE export_schedules ADD COLUMN indicator_scope VARCHAR(20) DEFAULT 'all'`); } catch (_) {}
            // เดิมชื่อ auto_sync_hdc (ส่วนหนึ่งของการเปลี่ยนชื่อการเชื่อมต่อ HDC → KHD ทั้งระบบ) — rename คอลัมน์เดิมก่อนกันข้อมูลหาย
            try { await db.query(`ALTER TABLE export_schedules CHANGE COLUMN auto_sync_hdc auto_sync_khd TINYINT(1) DEFAULT 0`); } catch (_) {}
            try { await db.query(`ALTER TABLE export_schedules ADD COLUMN auto_sync_khd TINYINT(1) DEFAULT 0`); } catch (_) {}
            // LINE Group notification
            try { await db.query(`ALTER TABLE export_schedules ADD COLUMN notify_line TINYINT(1) DEFAULT 0`); } catch (_) {}
        } catch (e) {}
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS export_schedule_logs (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    schedule_id INT NOT NULL,
                    run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    status VARCHAR(20),
                    inserted INT DEFAULT 0,
                    updated_count INT DEFAULT 0,
                    unchanged INT DEFAULT 0,
                    no_data INT DEFAULT 0,
                    tables_count INT DEFAULT 0,
                    skipped_count INT DEFAULT 0,
                    duration_ms INT DEFAULT 0,
                    notified_email TINYINT(1) DEFAULT 0,
                    notified_telegram TINYINT(1) DEFAULT 0,
                    notified_line TINYINT(1) DEFAULT 0,
                    error_msg TEXT,
                    INDEX idx_schedule (schedule_id),
                    INDEX idx_run_at (run_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            try { await db.query(`ALTER TABLE export_schedule_logs ADD COLUMN notified_line TINYINT(1) DEFAULT 0`); } catch (_) {}
        } catch (e) {}

        // ตาราง system_announcements — ประกาศระบบ
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS system_announcements (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    title VARCHAR(255) DEFAULT '',
                    content_html TEXT NOT NULL,
                    content_text VARCHAR(500),
                    bg_color VARCHAR(20) DEFAULT '#dc2626',
                    text_color VARCHAR(20) DEFAULT '#ffffff',
                    blink_enabled TINYINT(1) DEFAULT 1,
                    show_on_header TINYINT(1) DEFAULT 1,
                    show_on_login TINYINT(1) DEFAULT 1,
                    is_active TINYINT(1) DEFAULT 0,
                    created_by INT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_active (is_active)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            // seed ข้อความเริ่มต้น ถ้ายังไม่มีเลย
            const [existing] = await db.query('SELECT COUNT(*) AS c FROM system_announcements');
            if (existing[0].c === 0) {
                await db.query(`INSERT INTO system_announcements (title, content_html, content_text, is_active) VALUES (?, ?, ?, 1)`, [
                    'ประกาศระบบ',
                    '<i class="fas fa-chart-line"></i> <b>เริ่มใช้งาน 1 เม.ย. 2569</b> — รวบรวมผลงานตรวจราชการรอบที่ 2 *** ประมวลผลทุกวันที่ 20 ของเดือน <i class="fas fa-chart-line"></i>',
                    'เริ่มใช้งาน 1 เม.ย. 2569 — รวบรวมผลงานตรวจราชการรอบที่ 2 *** ประมวลผลทุกวันที่ 20 ของเดือน'
                ]);
            }
        } catch (e) {}
        // เพิ่ม actual_value_field ใน kpi_form_schemas
        try {
            await db.query(`ALTER TABLE kpi_form_schemas ADD COLUMN IF NOT EXISTS actual_value_field VARCHAR(100) NULL COMMENT 'ชื่อฟิลด์ที่ใช้ sync ไปยัง kpi_results.actual_value'`);
        } catch (e) { /* may already exist */ }

        // === Performance Indexes สำหรับ 500 concurrent users ===
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_composite ON kpi_results (indicator_id, year_bh, hospcode)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_status ON kpi_results (status)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_year ON kpi_results (year_bh)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_month ON kpi_results (month_bh)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_hospcode ON kpi_results (hospcode)',
            // รองรับหน้า "จัดการข้อมูลผลงานตัวชี้วัด" ที่กรอง/เรียงตามวันที่บันทึกจริง — kpi_results มีเกือบ
            // 5 แสนแถว ถ้าไม่มี index นี้ ORDER BY created_at DESC จะต้อง filesort ทั้งตาราง (วัดจริงช้ากว่า 10s)
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_created_at ON kpi_results (created_at)',
            // คอมโพสิต — ให้กรอง year_bh + เรียง created_at ในคิวรีเดียวไม่ต้อง filesort (วัดจริง: ไม่มี index นี้
            // ยังช้าอยู่แม้กรอง year_bh แล้ว เพราะ optimizer เลือกไม่ใช้ index เดี่ยวข้างบนเมื่อมี WHERE ร่วมด้วย)
            'CREATE INDEX IF NOT EXISTS idx_kpi_results_year_created ON kpi_results (year_bh, created_at)',
            'CREATE INDEX IF NOT EXISTS idx_users_role ON users (role)',
            'CREATE INDEX IF NOT EXISTS idx_users_approved ON users (is_approved)',
            'CREATE INDEX IF NOT EXISTS idx_users_hospcode ON users (hospcode)',
            'CREATE INDEX IF NOT EXISTS idx_users_dept ON users (dept_id)',
            'CREATE INDEX IF NOT EXISTS idx_users_cid ON users (cid)',
            'CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications (user_id, is_read)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_indicators_dept ON kpi_indicators (dept_id)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_indicators_main ON kpi_indicators (main_indicator_id)',
            'CREATE INDEX IF NOT EXISTS idx_kpi_indicators_active ON kpi_indicators (is_active)',
            'CREATE INDEX IF NOT EXISTS idx_login_logs_username ON login_logs (username)',
            'CREATE INDEX IF NOT EXISTS idx_system_logs_user ON system_logs (user_id)'
        ];
        for (const idx of indexes) {
            try { await db.query(idx); } catch (e) { /* index อาจมีอยู่แล้ว */ }
        }

        // ลบผู้ใช้ต้องไม่ลบผลงาน: FK kpi_results.user_id → users เปลี่ยนจาก ON DELETE CASCADE เป็น RESTRICT (11 ต.ค. 2569)
        // เหตุการณ์จริง: ลบบัญชีผู้ใช้แล้วผลงาน ~17,400 แถวที่ user_id ตรงกันถูกลบตามโดยไม่มี log — ดู docs/fix-log.md และ CLAUDE.md หัวข้อ 9.4
        // (ฐานข้อมูลต้องไม่มีแถวที่ user_id ไม่มีใน users ก่อน — ถ้ามี ALTER จะล้มเหลวและคง FK เดิมไว้ พร้อมแจ้งใน log)
        try {
            const [cascadeFks] = await db.query(
                `SELECT CONSTRAINT_NAME AS name FROM information_schema.REFERENTIAL_CONSTRAINTS
                 WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'kpi_results' AND REFERENCED_TABLE_NAME = 'users'
                   AND DELETE_RULE IN ('CASCADE', 'SET NULL')`);
            for (const fk of cascadeFks) {
                await db.query(`ALTER TABLE kpi_results DROP FOREIGN KEY \`${fk.name}\`,
                                ADD CONSTRAINT fk_kpi_results_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT`);
                console.log(`✅ kpi_results.${fk.name}: ON DELETE CASCADE → RESTRICT (fk_kpi_results_user) — ลบผู้ใช้ไม่ลบผลงานอีกต่อไป`);
            }
        } catch (e) {
            console.error('⚠️ เปลี่ยน FK kpi_results.user_id เป็น RESTRICT ไม่สำเร็จ (ยังเป็น CASCADE — ห้ามลบผู้ใช้จนกว่าจะแก้):', e.message);
        }

        console.log('✅ login_logs, system_logs, notifications, rejection & appeal tables + indexes ready');
    } catch (err) {
        console.error('⚠️ Auto-create tables error:', err.message);
    }
})();

// ========== Auto-create + seed role_page_access (Role × Page Access) ==========
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS role_page_access (
                id INT AUTO_INCREMENT PRIMARY KEY,
                role VARCHAR(20) NOT NULL,
                page_key VARCHAR(40) NOT NULL,
                is_enabled TINYINT(1) NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_role_page (role, page_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        // seed เฉพาะคู่ (role, page_key) ที่ยังไม่มี row — กันทับค่าที่ Super Admin แก้ไขไว้แล้วตอน restart
        const [existingRows] = await db.query('SELECT role, page_key FROM role_page_access');
        const existingSet = new Set(existingRows.map(r => `${r.role}::${r.page_key}`));
        const toInsert = [];
        for (const page of PAGE_ACCESS_PAGES) {
            const enabledRoles = new Set(PAGE_ACCESS_DEFAULT_ENABLED[page.key] || []);
            for (const role of PAGE_ACCESS_ROLES) {
                const k = `${role}::${page.key}`;
                if (existingSet.has(k)) continue;
                toInsert.push([role, page.key, enabledRoles.has(role) ? 1 : 0]);
            }
        }
        if (toInsert.length > 0) {
            await db.query('INSERT INTO role_page_access (role, page_key, is_enabled) VALUES ?', [toInsert]);
            console.log(`✅ role_page_access: seeded ${toInsert.length} แถวเริ่มต้น`);
        }
        await loadRolePageAccessCache();
        console.log('✅ role_page_access cache พร้อมใช้งาน');
    } catch (err) {
        console.error('⚠️ role_page_access setup error:', err.message);
    }
})();

// ========== Auto-create + seed role_action_access (สิทธิ์ "เพิ่ม"/"แก้ไข" แยกจากสิทธิ์เข้าหน้า) ==========
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS role_action_access (
                id INT AUTO_INCREMENT PRIMARY KEY,
                role VARCHAR(20) NOT NULL,
                page_key VARCHAR(40) NOT NULL,
                action ENUM('add','edit') NOT NULL,
                is_enabled TINYINT(1) NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uk_role_page_action (role, page_key, action)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        const [existingRows] = await db.query('SELECT role, page_key, action FROM role_action_access');
        const existingSet = new Set(existingRows.map(r => `${r.role}::${r.page_key}::${r.action}`));
        const toInsert = [];
        for (const page of ACTION_ACCESS_PAGES) {
            for (const action of ACTION_TYPES) {
                const enabledRoles = new Set(ACTION_ACCESS_DEFAULT_ENABLED[`${page.key}:${action}`] || []);
                for (const role of ACTION_ACCESS_ROLES) {
                    const k = `${role}::${page.key}::${action}`;
                    if (existingSet.has(k)) continue;
                    toInsert.push([role, page.key, action, enabledRoles.has(role) ? 1 : 0]);
                }
            }
        }
        if (toInsert.length > 0) {
            await db.query('INSERT INTO role_action_access (role, page_key, action, is_enabled) VALUES ?', [toInsert]);
            console.log(`✅ role_action_access: seeded ${toInsert.length} แถวเริ่มต้น`);
        }
        await loadRoleActionAccessCache();
        console.log('✅ role_action_access cache พร้อมใช้งาน');
    } catch (err) {
        console.error('⚠️ role_action_access setup error:', err.message);
    }
})();

// ========== Auto-create SSO Audit tables ==========
(async () => {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS sso_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                provider VARCHAR(20) NOT NULL COMMENT 'thaid | providerid',
                flow VARCHAR(20) NOT NULL COMMENT 'login | register',
                cid_hash VARCHAR(64) NULL COMMENT 'SHA-256 ของ CID ไม่เก็บ CID จริง',
                user_id INT NULL COMMENT 'FK users.id ถ้า match สำเร็จ',
                username VARCHAR(100) NULL,
                outcome VARCHAR(30) NOT NULL COMMENT 'success | no_match | register_redirect | blocked | error',
                raw_payload JSON NULL COMMENT 'full JSON จาก JWT/userinfo endpoint',
                extracted_fields JSON NULL COMMENT 'ฟิลด์สำคัญ: firstname_th, lastname_th, birthdate',
                ip VARCHAR(64) NULL,
                error_msg TEXT NULL,
                created_at DATETIME DEFAULT NOW(),
                INDEX idx_sso_logs_provider_created (provider, created_at),
                INDEX idx_sso_logs_user_id (user_id),
                INDEX idx_sso_logs_cid_hash (cid_hash),
                INDEX idx_sso_logs_outcome (outcome, created_at)
            ) COMMENT 'บันทึกทุก SSO callback attempt (ThaiD + ProviderID)'
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS sso_profiles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL COMMENT 'FK users.id',
                provider VARCHAR(20) NOT NULL COMMENT 'thaid | providerid',
                cid_hash VARCHAR(64) NULL,
                firstname_th VARCHAR(100) NULL,
                lastname_th VARCHAR(100) NULL,
                birthdate VARCHAR(20) NULL,
                name_th VARCHAR(200) NULL COMMENT 'ชื่อเต็มภาษาไทยจาก provider',
                pid_partial VARCHAR(10) NULL COMMENT 'เลขบัตร 4 ตัวหลัง (แสดงผลเท่านั้น)',
                extra_fields JSON NULL COMMENT 'ฟิลด์อื่นๆ เช่น title, gender, sub, hash_cid',
                raw_payload JSON NULL COMMENT 'full payload ล่าสุด',
                linked_at DATETIME NULL COMMENT 'ครั้งแรกที่ SSO สำเร็จ',
                last_seen_at DATETIME NULL COMMENT 'ครั้งล่าสุดที่ SSO สำเร็จ',
                login_count INT DEFAULT 0 COMMENT 'จำนวนครั้ง SSO สำเร็จ',
                UNIQUE KEY uk_sso_profiles_user_provider (user_id, provider),
                INDEX idx_sso_profiles_cid_hash (cid_hash)
            ) COMMENT 'โปรไฟล์ SSO ล่าสุดต่อ user — อัปเดตทุกครั้งที่ login/register สำเร็จ'
        `);
        console.log('✅ sso_logs + sso_profiles tables ready');
    } catch (err) {
        console.error('⚠️ SSO audit tables error:', err.message);
    }
})();

module.exports = { migrationsReady };
