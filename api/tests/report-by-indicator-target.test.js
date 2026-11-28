/**
 * รายงานสรุปผล แถบรายข้อตัวชี้วัด (27 พ.ย. 2569 — ผู้ใช้สั่ง): ช่อง "เป้าหมาย" = ยอดรวมเป้าหมายของทุกหน่วยบริการในขอบเขต
 * (เดิม MAX = เป้าหมายของหน่วยบริการเดียว) + ลำดับคอลัมน์ เป้าหมาย → ผลงานรวม → %สำเร็จ → รพ. (ลำดับในไฟล์ Excel)
 * เป้าหมายที่เป็นข้อความไม่นับรวม | target_max = ค่าเดิม
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2501';
let app, db, ind, token;

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_rbit\\_');
    ind = (await db.query(
        "INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, target_condition) VALUES ('test_rbit_ind', (SELECT id FROM departments ORDER BY id LIMIT 1), 1, '', 'GTE')"))[0].insertId;
    const [hs] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 3');
    // หน่วยบริการ 3 แห่ง: เป้าหมาย 20 / 15 / "ไม่ระบุ" (ข้อความ) — ผลงาน 25 (ผ่าน) / 5 (ไม่ผ่าน) / 3
    const rows = [[hs[0].hoscode, '20', '25'], [hs[1].hoscode, '15', '5'], [hs[2].hoscode, 'ไม่ระบุ', '3']];
    for (const [h, t, a] of rows) {
        await db.query('INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, kpi_indicators_name, target_value, last_actual, oct) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [ind, YEAR, h, 'test_rbit_ind', t, a, a]);
    }
    const sa = await ensureTestUser(db, { username: 'test_rbit_sa', role: 'super_admin', session_id: 's-rbit' });
    token = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-rbit' });
}, 60000);

afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [ind]);
    await db.query('DELETE FROM kpi_indicators WHERE id = ?', [ind]);
    await cleanupTestUsers(db, 'test\\_rbit\\_');
});

test('เป้าหมาย = ผลรวมเป้าหมายตัวเลขของทุกหน่วยบริการ (ข้อความไม่นับ) + ผลงานรวม/%สำเร็จ/รพ. ต่อจากเป้าหมาย', async () => {
    const r = await request(app).get('/khupskpi/api/report/by-indicator').set('Authorization', `Bearer ${token}`).query({ year_bh: YEAR });
    expect(r.status).toBe(200);
    const row = r.body.data.find(x => x.indicator_id === ind);
    expect(row).toBeTruthy();
    expect(Number(row.target_value)).toBe(35);          // 20 + 15 (เดิม MAX = 20)
    expect(Number(row.target_max)).toBe(20);
    expect(Number(row.total_actual)).toBe(33);          // 25 + 5 + 3
    expect(Number(row.hospital_count)).toBe(3);
    expect(Number(row.hospitals_passed)).toBe(1);
    expect(Number(row.achievement_pct)).toBe(94.29);    // ร้อยละ = ผลงานรวม 33 ÷ เป้าหมายรวม 35 (28 พ.ย. 2569 — เดิม = ผ่าน 1 จาก 2 แห่ง)
    expect(Number(row.recorded_hospitals)).toBe(3);
    // ลำดับคอลัมน์ (= ลำดับในไฟล์ Excel)
    const keys = Object.keys(row);
    const at = (k) => keys.indexOf(k);
    expect(at('total_actual')).toBe(at('target_value') + 1);
    expect(at('achievement_pct')).toBe(at('target_value') + 2);
    expect(at('hospital_count')).toBe(at('target_value') + 3);
    expect(at('oct')).toBeGreaterThan(at('hospital_count'));
});
