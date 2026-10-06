/**
 * Integration tests: GET /data-entry-lock
 *   Regression (6 ต.ค. 2569): ถ้าไม่ได้ตั้งวันเริ่มล็อค API คืน is_locked: '' (string ว่าง) แทน false
 *   → หน้าบันทึกผลงานของผู้ใช้ทั่วไปเกิด NG0100 ExpressionChangedAfterItHasBeenCheckedError
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const LOCK_KEYS = ['data_entry_locked', 'data_entry_lock_start', 'data_entry_lock_end', 'data_entry_lock_days', 'target_edit_locked'];
let app, db, saved;

async function setLock(values) {
    for (const k of LOCK_KEYS) {
        await db.query(
            'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            [k, values[k] ?? '']
        );
    }
}

beforeAll(async () => {
    ({ app } = require('../server'));
    db = require('../db');
    await cleanupTestUsers(db);
    [saved] = await db.query('SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN (?)', [LOCK_KEYS]);
});
afterAll(async () => {
    // คืนค่าเดิมของ database ทดสอบ
    await setLock(Object.fromEntries(saved.map(r => [r.setting_key, r.setting_value])));
    await cleanupTestUsers(db);
});

async function getLock() {
    const u = await ensureTestUser(db, { username: 'test_lock_' + Date.now(), role: 'user_hos', session_id: 'sess-lock' });
    const token = makeToken({ userId: u.id, username: u.username, role: 'user_hos', sessionId: 'sess-lock' });
    return request(app).get('/khupskpi/api/data-entry-lock').set('Authorization', `Bearer ${token}`);
}

describe('GET /khupskpi/api/data-entry-lock', () => {
    test('✅ ไม่ได้ล็อคและไม่ตั้งวันที่ → is_locked เป็น false (boolean ไม่ใช่ string ว่าง)', async () => {
        await setLock({ data_entry_locked: 'false' });
        const res = await getLock();
        expect(res.status).toBe(200);
        expect(res.body.data.is_locked).toBe(false);
    });

    test('✅ ล็อคด้วยมือ → is_locked เป็น true', async () => {
        await setLock({ data_entry_locked: 'true' });
        const res = await getLock();
        expect(res.body.data.is_locked).toBe(true);
        expect(res.body.data.lock_reason).toBe('ล็อคโดย Admin');
    });

    test('✅ อยู่ในช่วงวันที่ล็อค → is_locked เป็น true / นอกช่วง → false', async () => {
        const today = new Date().toISOString().split('T')[0];
        await setLock({ data_entry_locked: 'false', data_entry_lock_start: today, data_entry_lock_end: today });
        expect((await getLock()).body.data.is_locked).toBe(true);

        await setLock({ data_entry_locked: 'false', data_entry_lock_start: '2000-01-01', data_entry_lock_end: '2000-01-02' });
        expect((await getLock()).body.data.is_locked).toBe(false);
    });
});
