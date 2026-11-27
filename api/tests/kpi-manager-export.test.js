/**
 * หน้าจัดการข้อมูล KPI รวมเป็นตารางเดียว (27 พ.ย. 2569 — ผู้ใช้รายงาน: ขั้น "ส่งออกข้อมูล KPI ↔ KHD" กดสร้างตารางแล้วไม่สร้าง,
 * ขั้น Export สร้างตารางได้แต่ target/result ว่างทั้งที่มีผลงานใน kpi_results)
 *   - ค่าตั้งต้นกติกาการส่ง = all → ตารางส่งออกได้เป้าหมาย/ผลงาน/รายเดือนตรงกับ kpi_results ทุกค่า (ยังไม่อนุมัติก็ส่ง)
 *   - ตารางที่ยังไม่มี (ทั้งในระบบและ KHD) → ส่งออกสร้างให้เอง
 *   - ส่งออกซ้ำ = ไม่เปลี่ยน, แก้ผลงาน 1 เดือน = อัปเดต 1 แถว
 *   - GET /db-compare?year_bh= นับแถวของปีงบ + แยก "เชื่อม KHD ไม่ได้" ออกจาก "ไม่มีตารางใน KHD" + คีย์ KHD
 * KHD จำลองด้วย jest.mock('../db-remote') — ห้ามเชื่อม KHD จริง
 */
require('./setup');
jest.setTimeout(60000); // GET /db-compare + ส่งออกไล่ทุกตารางของฐานทดสอบ — เกิน 5 วินาทีเมื่อฐานทดสอบมีข้อมูลมาก
let mockRemoteMode = 'down'; // 'down' = ไม่ได้ตั้งค่า | 'up' = KHD จำลองที่ยังไม่มีตารางนี้ | 'bad_key' = มีตารางแต่คีย์ไม่ใช่ hospcode+byear
const mockRemoteTables = new Map();
jest.mock('../db-remote', () => ({
    getRemotePool: () => (mockRemoteMode === 'down' ? null : {
        query: async (sql) => {
            if (/^SELECT 1$/.test(sql)) return [[{ 1: 1 }]];
            const m = /FROM `([a-z0-9_]+)`/i.exec(sql);
            const t = m && mockRemoteTables.get(m[1]);
            if (!t) { const e = new Error("Table doesn't exist"); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
            if (/^SHOW COLUMNS/.test(sql)) return [t.columns.map(c => ({ Field: c, Type: 'varchar(100)', Null: 'YES', Key: '', Default: null }))];
            if (/^SHOW KEYS/.test(sql)) return [t.keys.map((k, i) => ({ Key_name: 'PRIMARY', Non_unique: 0, Column_name: k, Seq_in_index: i + 1 }))];
            if (/COUNT\(\*\)/.test(sql)) return [[{ cnt: 0 }]];
            return [[]];
        },
    }),
}));
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const api = (p) => `/khupskpi/api${p}`;
const YEAR = '2570';
let app, db, policySvc, ind, tp, hosA, hosB, saToken, prevPolicy;
const as = (r) => r.set('Authorization', `Bearer ${saToken}`);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    policySvc = require('../services/khd-policy');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_kme\\_');
    const [[p]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'khd_send_policy'");
    prevPolicy = p ? p.setting_value : null;
    await db.query("DELETE FROM system_settings WHERE setting_key = 'khd_send_policy'"); // ค่าตั้งต้น
    policySvc.invalidateKhdSyncSettings();
    const [hs] = await db.query("SELECT hoscode, hostype FROM chospital WHERE hostype = (SELECT hostype FROM chospital WHERE hostype IS NOT NULL GROUP BY hostype ORDER BY COUNT(*) DESC, hostype LIMIT 1) ORDER BY hoscode LIMIT 2");
    [hosA, hosB] = [hs[0].hoscode, hs[1].hoscode];
    tp = 'test_kme_' + Date.now();
    ind = (await db.query(
        `INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, upload_excel, evaluation_mode, required_off_types, target_percentage)
         VALUES ('test_kme_ind', (SELECT id FROM departments ORDER BY id LIMIT 1), 1, ?, 0, 'any_one', ?, '20')`, [tp, JSON.stringify([hs[0].hostype])]))[0].insertId;
    const sa = await ensureTestUser(db, { username: 'test_kme_sa', role: 'super_admin', session_id: 's-kme-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-kme-sa' });
    // หน่วยบริการ A: ผลงาน ต.ค.–ธ.ค. (ยังไม่อนุมัติ — เหมือนข้อมูลจริงที่ผู้ใช้ทดสอบ) | B: มีแต่เป้าหมาย
    const rows = [];
    for (const m of [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const actual = { 10: '5', 11: '7', 12: '9' }[m] ?? null;
        rows.push([ind, YEAR, m, actual, '20', sa.id, 'Pending', hosA, 0]);
        rows.push([ind, YEAR, m, null, '15', sa.id, 'Pending', hosB, 0]);
    }
    await db.query('INSERT INTO kpi_results (indicator_id, year_bh, month_bh, actual_value, target_value, user_id, status, hospcode, is_locked) VALUES ?', [rows]);
}, 60000);

afterAll(async () => {
    if (prevPolicy === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'khd_send_policy'");
    else await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('khd_send_policy', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [prevPolicy]);
    policySvc.invalidateKhdSyncSettings();
    await db.query(`DROP TABLE IF EXISTS \`${tp}\``).catch(() => {});
    if (ind) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [ind]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [ind]);
    }
    await cleanupTestUsers(db, 'test\\_kme\\_');
});

const structOf = async () => {
    const r = await as(request(app).get(api('/db-compare'))).query({ year_bh: YEAR });
    expect(r.status).toBe(200);
    return { body: r.body, item: r.body.tables.find(t => t.table === tp) };
};
const exportedRows = async () => (await db.query(`SELECT * FROM \`${tp}\` WHERE byear = ? ORDER BY hospcode`, [YEAR]))[0];

test('ก่อนส่งออก: ยังไม่มีตารางในระบบ + เชื่อม KHD ไม่ได้ = ยังคืนข้อมูลฝั่งระบบ (เดิม 400)', async () => {
    mockRemoteMode = 'down';
    const { body, item } = await structOf();
    expect(body.khd_available).toBe(false);
    expect(body.khd_error).toMatch(/Remote DB|KHD/);
    expect(item.local.exists).toBe(false);
    expect(item.remote).toBeNull();   // ไม่ใช่ "ไม่มีใน KHD"
});

test('ส่งออก (ค่าตั้งต้น all): สร้างตารางให้เอง + เป้าหมาย/ผลงาน/รายเดือนตรงกับ kpi_results (ยังไม่อนุมัติก็ส่ง)', async () => {
    const r = await as(request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: [ind] });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.policy).toBe('all');
    expect(r.body.created_tables.map(t => t.table)).toContain(tp);
    const rows = await exportedRows();
    const a = rows.find(x => x.hospcode === hosA);
    expect(a).toBeTruthy();
    expect(num(a.target)).toBe(20);
    expect(num(a.result)).toBe(9);                  // ผลงานล่าสุด = ธ.ค.
    expect([num(a.m10), num(a.m11), num(a.m12)]).toEqual([5, 7, 9]);
    expect([a.m01, a.m02, a.m09].map(num)).toEqual([null, null, null]);
    const b = rows.find(x => x.hospcode === hosB);
    if (b) { expect(num(b.target)).toBe(15); expect(num(b.result)).toBeNull(); } // มีแต่เป้าหมาย: ถ้ามีแถวต้องไม่มีผลงานปลอม
});

test('สถานะตารางหลังส่งออก: มีในระบบ นับแถวของปีงบ + แถวที่มีข้อมูล', async () => {
    const { item } = await structOf();
    expect(item.local.exists).toBe(true);
    expect(item.local.year_rows).toBeGreaterThanOrEqual(1);
    expect(item.local.year_filled).toBeGreaterThanOrEqual(1);
    expect(item.status).toBe('khd_unknown');
});

test('KHD จำลอง: ไม่มีตาราง = missing_remote, คีย์ไม่ใช่ hospcode+byear = key_ok false, คอลัมน์ต่าง = different', async () => {
    mockRemoteMode = 'up';
    mockRemoteTables.clear();
    let { body, item } = await structOf();
    expect(body.khd_available).toBe(true);
    expect(item.remote.exists).toBe(false);
    expect(item.status).toBe('missing_remote');
    mockRemoteTables.set(tp, { columns: ['hospcode', 'byear', 'target'], keys: ['hospcode'] });
    ({ item } = await structOf());
    expect(item.remote.key_ok).toBe(false);
    expect(item.status).toBe('different');
    expect(item.diff.some(d => d.field === 'result' && d.issue === 'missing_in_remote')).toBe(true);
    mockRemoteMode = 'down';
});

test('ส่งออกซ้ำ = ไม่เปลี่ยน / แก้ผลงาน 1 เดือน = อัปเดตแถวนั้น + ผลงานล่าสุดเปลี่ยนตาม', async () => {
    let r = await as(request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: [ind] });
    const t1 = r.body.created_tables.find(t => t.table === tp);
    expect(t1.inserted + t1.updated).toBe(0);
    await db.query('UPDATE kpi_results SET actual_value = ? WHERE indicator_id = ? AND hospcode = ? AND month_bh = 12', ['11', ind, hosA]);
    const chk = await as(request(app).post(api('/check-kpi-export'))).send({ year_bh: YEAR, indicator_ids: [ind] });
    expect(chk.body.details.find(d => d.id === ind).status).toBe('has_changes');
    r = await as(request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: [ind] });
    const t2 = r.body.created_tables.find(t => t.table === tp);
    expect(t2.updated).toBe(1);
    const a = (await exportedRows()).find(x => x.hospcode === hosA);
    expect(num(a.m12)).toBe(11);
    expect(num(a.result)).toBe(11);
});
