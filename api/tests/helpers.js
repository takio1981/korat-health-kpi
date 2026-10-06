/**
 * Test helpers — สร้าง user/JWT/cleanup สำหรับ tests
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function makeToken(payload = {}) {
    const secret = process.env.SECRET_KEY || 'test-secret-key-for-jest';
    return jwt.sign({
        userId: 1,
        username: 'test_user',
        role: 'user',
        deptId: 1,
        hospcode: '11000',
        sessionId: 'test-session-' + Date.now(),
        ...payload
    }, secret, { expiresIn: '8h' });
}

async function ensureTestUser(db, opts = {}) {
    const username = opts.username || 'test_user_' + Date.now();
    const hash = await bcrypt.hash(opts.password || 'TestPass123!', 10);
    const cidHash = crypto.createHash('sha256').update(opts.cid || '1234567890123').digest('hex');
    const [r] = await db.query(
        `INSERT INTO users (username, password_hash, cid, role, dept_id, hospcode, firstname, lastname, email, is_approved, is_active, active_session_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [username, hash, cidHash,
         opts.role || 'user',
         opts.dept_id || 1,
         opts.hospcode || '11000',
         opts.firstname || 'Test',
         opts.lastname || 'User',
         opts.email || (username + '@test.local'),
         opts.is_approved === undefined ? 1 : opts.is_approved,
         opts.is_active === undefined ? 1 : opts.is_active,
         opts.session_id || null]
    );
    return { id: r.insertId, username, password: opts.password || 'TestPass123!' };
}

// ลบผู้ใช้ทดสอบทุกตัวที่ขึ้นต้นด้วย test_ (เทสแต่ละไฟล์ตั้งชื่อต่างกัน เช่น test_admin_cup_perm, test_sa_errlog)
// — เดิมลบแค่ test_user_% ทำให้ผู้ใช้ที่ค้างจากรอบก่อนชน UNIQUE username ในรอบถัดไป
// ปลอดภัยเพราะ setup.js บังคับให้รันบน database ทดสอบเท่านั้น
async function cleanupTestUsers(db, prefix = 'test\\_') {   // \\_ = ขีดล่างตัวอักษรจริงใน LIKE (ไม่ใช่ wildcard)
    await db.query('DELETE FROM users WHERE username LIKE ?', [prefix + '%']);
}

async function cleanupErrorLogs(db) {
    await db.query("DELETE FROM error_logs WHERE source IN ('backend','frontend','http')");
}

module.exports = {
    makeToken,
    ensureTestUser,
    cleanupTestUsers,
    cleanupErrorLogs
};
