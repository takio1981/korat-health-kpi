/**
 * ระยะ 1 ของแผน lean งานผู้ดูแล (22 พ.ย. 2569) — ข้อบกพร่องด้านความปลอดภัยที่พบจากการสำรวจโค้ด (ทุกข้อ fail กับโค้ดเดิม)
 * 1) /update-kpi ไม่ตรวจ "ปิดการคีย์ข้อมูล" (เรียก API ตรงแล้วบันทึกได้)  2) preserve_status:'Approved' จาก client ได้สถานะอนุมัติ
 * 3) admin_hos/admin_cup เขียนผลงานหน่วยบริการนอกขอบเขต  4) อนุมัติทับรายการอุทธรณ์  5) ส่งคืนรายการที่อนุมัติแล้ว (= ปลดล็อค) โดยไม่ใช่ super_admin
 * 6) pending-kpi กรองหน่วยงานกับทุก role  7) ด่าน super_admin แบบเข้มสำหรับเส้นทางที่เขียน KHD  8) ชื่อตัวชี้วัดว่าง  9) ปีงบปัจจุบัน (เวลาไทย)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { currentFiscalYear } = require('../core/fiscal-year');

const api = (p) => `/khupskpi/api${p}`;
const YEAR = '2570';
let app, db, dept, ind, hA, hB, hOther, T = {}, U = {}, prevLock;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_safe\\_');
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_safe\\_%'");
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    dept = d.id;
    // 2 หน่วยบริการอำเภอเดียวกัน + 1 แห่งต่างอำเภอ
    const [[dist]] = await db.query('SELECT distid FROM chospital WHERE distid IS NOT NULL GROUP BY distid HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC, distid LIMIT 1');
    const [same] = await db.query('SELECT hoscode FROM chospital WHERE distid = ? ORDER BY hoscode LIMIT 2', [dist.distid]);
    [hA, hB] = same.map(r => r.hoscode);
    const [[o]] = await db.query('SELECT hoscode FROM chospital WHERE distid <> ? AND distid IS NOT NULL ORDER BY hoscode LIMIT 1', [dist.distid]);
    hOther = o.hoscode;
    ind = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES ('test_safe_ind', ?, 1)", [dept]))[0].insertId;

    const mk = async (key, role, hospcode) => {
        const u = await ensureTestUser(db, { username: 'test_safe_' + key, role, dept_id: dept, hospcode, session_id: 's-safe-' + key });
        U[key] = u;
        T[key] = makeToken({ userId: u.id, username: u.username, role, deptId: dept, hospcode, sessionId: 's-safe-' + key });
    };
    await mk('user', 'user_hos', hA);
    await mk('hosadm', 'admin_hos', hA);
    await mk('cupadm', 'admin_cup', hA);
    await mk('ssj', 'admin_ssj', hA);
    await mk('sa', 'super_admin', null);
    const [[lk]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'data_entry_locked'");
    prevLock = lk ? lk.setting_value : null;
}, 60000);

afterAll(async () => {
    if (prevLock === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'data_entry_locked'");
    else await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'data_entry_locked'", [prevLock]);
    if (ind) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM notifications WHERE indicator_id = ?', [ind]).catch(() => {});
        await db.query('DELETE FROM kpi_rejection_comments WHERE indicator_id = ?', [ind]).catch(() => {});
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [ind]);
    }
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_safe\\_%' OR kpi_indicators_name = ''").catch(() => {});
    await cleanupTestUsers(db, 'test\\_safe\\_');
});

const post = (t, p, body) => request(app).post(api(p)).set('Authorization', `Bearer ${t}`).send(body);
const row = (hospcode, extra = {}) => ({ indicator_id: ind, year_bh: YEAR, hospcode, target_value: '80', oct: '90', ...extra });
const statusOf = async (hospcode) => {
    const r = (await db.query('SELECT status, is_locked FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? ORDER BY month_bh LIMIT 1', [ind, YEAR, hospcode]))[0][0];
    return r && { status: r.status, is_locked: Number(r.is_locked) }; // is_locked เป็นข้อความในบางฐาน ("1")
};
const setStatus = (hospcode, status, locked) => db.query('UPDATE kpi_results SET status = ?, is_locked = ? WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [status, locked, ind, YEAR, hospcode]);
const setLock = (v) => db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('data_entry_locked', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [v]);

describe('/update-kpi', () => {
    test('🛡️ ปิดการคีย์ข้อมูล: ผู้ใช้ทั่วไปเรียก API ตรง → 403 DATA_ENTRY_LOCKED / ผู้ดูแลบันทึกได้', async () => {
        await setLock('true');
        try {
            const r = await post(T.user, '/update-kpi', { updates: [row(hA)] });
            expect(r.status).toBe(403);
            expect(r.body.code).toBe('DATA_ENTRY_LOCKED');
            expect((await post(T.hosadm, '/update-kpi', { updates: [row(hA)], targetHospcode: hA })).status).toBe(200);
        } finally { await setLock('false'); }
    });

    test('🛡️ preserve_status: "Approved" จาก client → บันทึกเป็น Pending', async () => {
        const r = await post(T.user, '/update-kpi', { updates: [row(hA, { preserve_status: 'Approved' })] });
        expect(r.status).toBe(200);
        expect((await statusOf(hA)).status).toBe('Pending');
    });

    test('✅ preserve_status: "Resubmit" ใช้ได้เฉพาะคู่ที่ถูกส่งคืนแก้ไขจริง', async () => {
        await post(T.user, '/update-kpi', { updates: [row(hA, { preserve_status: 'Resubmit' })] });
        expect((await statusOf(hA)).status).toBe('Pending');           // ไม่ได้ถูกส่งคืน = Pending
        await setStatus(hA, 'Rejected', 0);
        await post(T.user, '/update-kpi', { updates: [row(hA, { oct: '91', preserve_status: 'Resubmit' })] });
        expect((await statusOf(hA)).status).toBe('Resubmit');
        await setStatus(hA, 'Pending', 0);
    });

    test('🛡️ admin_hos บันทึกหน่วยบริการอื่น → 403 (เดิมบันทึกได้)', async () => {
        const r = await post(T.hosadm, '/update-kpi', { updates: [row(hB)], targetHospcode: hB });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('OUT_OF_SCOPE_HOSPCODE');
    });

    test('🛡️ admin_cup: อำเภอตัวเองได้ / ต่างอำเภอ → 403', async () => {
        expect((await post(T.cupadm, '/update-kpi', { updates: [row(hB)], targetHospcode: hB })).status).toBe(200);
        const r = await post(T.cupadm, '/update-kpi', { updates: [row(hOther)], targetHospcode: hOther });
        expect(r.status).toBe(403);
    });
});

describe('อนุมัติ / ส่งคืน ตรวจสถานะ', () => {
    test('🛡️ อนุมัติรายการที่อยู่ระหว่างอุทธรณ์ → 409 (เดิมอนุมัติทับ)', async () => {
        await setStatus(hA, 'Appeal', 1);
        const r = await post(T.ssj, '/approve-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hA }]);
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('APPEAL_PENDING');
        expect((await statusOf(hA)).status).toBe('Appeal');
        await setStatus(hA, 'Pending', 0);
    });

    test('✅ อนุมัติเฉพาะที่รอตรวจสอบ — อนุมัติซ้ำ = ข้าม', async () => {
        let r = await post(T.ssj, '/approve-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hA }]);
        expect(r.status).toBe(200);
        expect(r.body.approved).toBe(1);
        expect((await statusOf(hA))).toMatchObject({ status: 'Approved', is_locked: 1 });
        r = await post(T.ssj, '/approve-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hA }]);
        expect(r.body).toMatchObject({ approved: 0, skipped: 1 });
    });

    test('🛡️ admin_ssj ส่งคืนรายการที่อนุมัติแล้ว → 409 / super_admin ทำได้', async () => {
        const r = await post(T.ssj, '/reject-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hA, comment: 'ทดสอบ' }]);
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('ALREADY_APPROVED');
        expect((await statusOf(hA)).is_locked).toBe(1);
        expect((await post(T.sa, '/reject-kpi', [{ indicator_id: ind, year_bh: YEAR, hospcode: hA, comment: 'ทดสอบ' }])).status).toBe(200);
        expect((await statusOf(hA))).toMatchObject({ status: 'Rejected', is_locked: 0 });
        await setStatus(hA, 'Pending', 0);
    });
});

describe('pending-kpi ตามขอบเขต', () => {
    test('✅ admin_ssj นับทุกหน่วยบริการของหน่วยงานตัวเอง (นับเป็นคู่ + ส่งกลับแก้ไข) — ตัวชี้วัดหน่วยงานอื่นไม่นับ', async () => {
        // เส้นทางนี้ = isAdmin (ผู้มีสิทธิ์อนุมัติ) — ขอบเขต: admin_ssj = หน่วยงานตัวเองทุกหน่วยบริการ
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ? AND hospcode IN (?)', [ind, [hB, hOther]]);
        const count = async () => {
            const r = await request(app).get(api(`/notifications/pending-kpi?year_bh=${YEAR}`)).set('Authorization', `Bearer ${T.ssj}`);
            expect(r.status).toBe(200);
            return r.body.data;
        };
        const before = await count();
        await post(T.sa, '/update-kpi', { updates: [row(hB)], targetHospcode: hB });
        await post(T.sa, '/update-kpi', { updates: [row(hOther)], targetHospcode: hOther });
        await setStatus(hOther, 'Resubmit', 0);
        const after = await count();
        expect(after.pairCount - before.pairCount).toBe(2);           // Resubmit นับเป็นรอตรวจด้วย (เดิมนับเฉพาะ Pending)
        expect(after.resubmitCount - before.resubmitCount).toBe(1);
        expect(after.yearBh).toBe(YEAR);
        const [[d2]] = await db.query('SELECT id FROM departments WHERE id <> ? ORDER BY id LIMIT 1', [dept]);
        await db.query('UPDATE kpi_indicators SET dept_id = ? WHERE id = ?', [d2.id, ind]);
        try {
            expect((await count()).pairCount).toBe(before.pairCount - (await db.query("SELECT COUNT(DISTINCT hospcode) c FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode NOT IN (?) AND status IN ('Pending','Resubmit')", [ind, YEAR, [hB, hOther]]))[0][0].c);
        } finally {
            await db.query('UPDATE kpi_indicators SET dept_id = ? WHERE id = ?', [dept, ind]);
            await setStatus(hOther, 'Pending', 0);
        }
    });
});

describe('ด่าน super_admin แบบเข้ม (เส้นทางที่เขียน KHD)', () => {
    test('🛡️ admin_ssj ที่ได้สิทธิ์หน้า kpi-manager → ส่งเข้า KHD / สร้างตารางใน KHD ไม่ได้ (403)', async () => {
        const { loadRolePageAccessCache } = require('../core/access');
        const [[prev]] = await db.query("SELECT is_enabled FROM role_page_access WHERE role = 'admin_ssj' AND page_key = 'kpi-manager'");
        await db.query("INSERT INTO role_page_access (role, page_key, is_enabled) VALUES ('admin_ssj', 'kpi-manager', 1) ON DUPLICATE KEY UPDATE is_enabled = 1");
        await loadRolePageAccessCache();
        try {
            for (const p of ['/sync-to-khd/execute', '/db-compare/create-remote', '/db-compare/sync-to-khd', '/db-compare/sync-data']) {
                const r = await post(T.ssj, p, { tables: [] });
                expect(r.status).toBe(403);
                expect(r.body.code).toBe('SUPER_ADMIN_ONLY');
            }
        } finally {
            if (prev) await db.query("UPDATE role_page_access SET is_enabled = ? WHERE role = 'admin_ssj' AND page_key = 'kpi-manager'", [prev.is_enabled]);
            else await db.query("DELETE FROM role_page_access WHERE role = 'admin_ssj' AND page_key = 'kpi-manager'");
            await loadRolePageAccessCache();
        }
    });
});

describe('อื่น ๆ', () => {
    test('🛡️ ตัวชี้วัดไม่มีชื่อ → 400 (เพิ่ม/แก้ไข)', async () => {
        expect((await post(T.sa, '/indicators', { kpi_indicators_name: '   ', dept_id: dept })).status).toBe(400);
        const r = await request(app).put(api(`/indicators/${ind}`)).set('Authorization', `Bearer ${T.sa}`).send({ dept_id: dept });
        expect(r.status).toBe(400);
        expect((await db.query('SELECT kpi_indicators_name FROM kpi_indicators WHERE id = ?', [ind]))[0][0].kpi_indicators_name).toBe('test_safe_ind');
    });

    test('✅ ปีงบปัจจุบันตามเวลาไทย (ต.ค. ขึ้นปีงบใหม่, เที่ยงคืนวันที่ 1 ต.ค. เวลาไทย)', () => {
        expect(currentFiscalYear(new Date('2026-09-30T16:59:00Z'))).toBe(2569); // 23:59 น. 30 ก.ย. 2569
        expect(currentFiscalYear(new Date('2026-09-30T17:00:00Z'))).toBe(2570); // 00:00 น. 1 ต.ค. 2569
        expect(currentFiscalYear(new Date('2026-12-31T12:00:00Z'))).toBe(2570);
        expect(currentFiscalYear(new Date('2027-01-01T12:00:00Z'))).toBe(2570);
    });
});
