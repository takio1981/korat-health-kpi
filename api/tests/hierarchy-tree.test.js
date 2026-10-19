/**
 * Integration tests (database ทดสอบ): ตัวชี้วัดหลายระดับแบบต้นไม้ — 19 ต.ค. 2569
 *   หลัก 5 → ย่อย 5.1 (auto) → ย่อยระดับ 2 5.1.1 (auto) → กิจกรรม 5.1.1.1 / 5.1.1.2  และ 5.1.2 (กรอกเอง), 5.2 (กรอกเอง)
 *   - ค่าคำนวณขึ้นสองชั้นถึงตัวชี้วัดหลัก (ใช้เฉพาะข้อย่อยระดับบนสุดในการคำนวณหลัก)
 *   - จำกัดจำนวนระดับ (system_settings.kpi_hierarchy_max_levels ค่าตั้งต้น 4) / ข้อแม่ต้องอยู่ตัวชี้วัดเดียวกัน
 *   - ห้ามกรอกข้อที่คำนวณจากระดับล่าง (เดิม: ข้อที่มีแค่ข้อลูก ไม่มีกิจกรรม กรอกได้)
 *   - ปิดข้อแม่ = ซ่อนทั้งสาย / ลบข้อที่มีผลงานใต้ลงไปไม่ได้ (เดิม: ลบเงียบๆ พร้อมผลงาน)
 *   - ส่งออก <table_process>_items: item_level ตามความลึก + item_kind, ตารางรูปแบบเดิมย้ายคีย์ได้
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2505';
const TP = 'test_tree_kpi';
let app, db, saToken, userToken, deptId, hosp, indId, savedMaxSetting;
const S = {}, A = {};
const api = (p) => '/khupskpi/api' + p;
const as = (tok, r) => r.set('Authorization', `Bearer ${tok}`);
const addSub = (body) => as(saToken, request(app).post(api('/sub-indicators'))).send({ indicator_id: indId, ...body });
const save = (tok, body) => as(tok, request(app).post(api('/hierarchy-results/save'))).send({ year_bh: YEAR, hospcode: hosp, ...body });
async function mainSummary() {
    const res = await as(saToken, request(app).get(api(`/sub-results/summary?year_bh=${YEAR}&hospcode=${hosp}`)));
    return res.body.data.find(r => Number(r.indicator_id) === indId);
}
const setMax = (v) => db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('kpi_hierarchy_max_levels', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [String(v)]);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_tree\\_%'");
    for (const t of [TP, `${TP}_items`]) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
    const [[old]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'kpi_hierarchy_max_levels'");
    savedMaxSetting = old ? old.setting_value : null;
    await db.query("DELETE FROM system_settings WHERE setting_key = 'kpi_hierarchy_max_levels'");

    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    deptId = d.id; hosp = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_tree_sa', role: 'super_admin', session_id: 'sess-tree-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-tree-sa' });
    const u = await ensureTestUser(db, { username: 'test_tree_user', role: 'user_hos', dept_id: deptId, hospcode: hosp, session_id: 'sess-tree-u' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hosp, sessionId: 'sess-tree-u' });
    const [i] = await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, item_no, table_process, export_items) VALUES ('test_tree_ind', ?, 1, '5', ?, 1)", [deptId, TP]);
    indId = i.insertId;
});

afterAll(async () => {
    await new Promise(r => setTimeout(r, 1500)); // refresh summary แบบ fire-and-forget
    await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [indId]);
    await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [indId]);
    await db.query('DELETE FROM kpi_sub_indicators WHERE indicator_id = ? AND parent_sub_id IS NOT NULL', [indId]);
    await db.query('DELETE FROM kpi_sub_indicators WHERE indicator_id = ?', [indId]);
    await db.query('DELETE FROM kpi_indicators WHERE id = ?', [indId]);
    for (const t of [TP, `${TP}_items`]) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
    if (savedMaxSetting === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'kpi_hierarchy_max_levels'");
    else await setMax(savedMaxSetting);
    await cleanupTestUsers(db);
});

describe('โครงสร้างต้นไม้', () => {
    test('✅ เพิ่มข้อย่อยลูกด้วย parent_sub_id — GET คืนระดับ จำนวนข้อลูก และจำนวนระดับสูงสุด', async () => {
        S.s1 = (await addSub({ sub_indicator_name: 'test_tree S1', rollup_mode: 'auto', sort_order: 1 })).body.id;
        S.s2 = (await addSub({ sub_indicator_name: 'test_tree S2', sort_order: 2 })).body.id;
        let r = await addSub({ parent_sub_id: S.s1, sub_indicator_name: 'test_tree S11', rollup_mode: 'auto', sort_order: 1 });
        expect(r.status).toBe(200); S.s11 = r.body.id;
        S.s12 = (await addSub({ parent_sub_id: S.s1, sub_indicator_name: 'test_tree S12', sort_order: 2 })).body.id;
        r = await as(saToken, request(app).get(api(`/sub-indicators?indicator_id=${indId}`)));
        const by = Object.fromEntries(r.body.data.map(x => [x.id, x]));
        expect([by[S.s1].level, by[S.s11].level, by[S.s2].level]).toEqual([2, 3, 2]);
        expect(Number(by[S.s1].child_count)).toBe(2);
        expect(Number(by[S.s11].parent_sub_id)).toBe(S.s1);
        expect(r.body.max_levels).toBe(4);
    });

    test('🛡️ เกินจำนวนระดับ / ข้อแม่คนละตัวชี้วัด → 400 (เดิม: ไม่รองรับ parent และเพิ่มได้ทุกกรณี)', async () => {
        let r = await addSub({ parent_sub_id: S.s11, sub_indicator_name: 'test_tree too deep' });
        expect(r.status).toBe(400);
        r = await as(saToken, request(app).post(api('/sub-indicators'))).send({ indicator_id: indId + 999999, parent_sub_id: S.s1, sub_indicator_name: 'test_tree wrong ind' });
        expect(r.status).toBe(400);
    });

    test('✅ กิจกรรมใต้ข้อย่อยระดับ 3 ได้ (ระดับ 4) — ปรับจำนวนระดับสูงสุดเป็น 5 แล้วเพิ่มข้อย่อยระดับ 4 ได้', async () => {
        let r = await as(saToken, request(app).post(api('/sub-activities'))).send({ sub_indicator_id: S.s11, activity_name: 'test_tree A1', value_type: 'number', sort_order: 1 });
        expect(r.status).toBe(200); A.a1 = r.body.id;
        A.a2 = (await as(saToken, request(app).post(api('/sub-activities'))).send({ sub_indicator_id: S.s11, activity_name: 'test_tree A2', value_type: 'check', sort_order: 2 })).body.id;
        await setMax(5);
        r = await addSub({ parent_sub_id: S.s11, sub_indicator_name: 'test_tree S111 (ชั่วคราว)' });
        expect(r.status).toBe(200);
        S.tmp = r.body.id;
        await db.query("DELETE FROM system_settings WHERE setting_key = 'kpi_hierarchy_max_levels'");
        // ข้อชั่วคราวยังไม่มีผลงาน → ลบได้
        expect((await as(saToken, request(app).delete(api(`/sub-indicators/${S.tmp}`)))).status).toBe(200);
    });
});

describe('คำนวณขึ้นสองชั้น', () => {
    test('✅ บันทึกกิจกรรม + ข้อกรอกเอง → ย่อยระดับ 2 → ย่อย → หลัก (ใช้เฉพาะข้อระดับบนสุด)', async () => {
        const r = await save(userToken, {
            activity: [{ activity_id: A.a1, month_bh: 10, actual_value: '80' }, { activity_id: A.a2, month_bh: 10, actual_value: '1' }, { activity_id: A.a2, month_bh: 11, actual_value: '0' }],
            sub: [{ sub_indicator_id: S.s12, month_bh: 10, actual_value: '60' }, { sub_indicator_id: S.s2, month_bh: 10, actual_value: '50' }],
        });
        expect(r.status).toBe(200);
        // S11 = (80 + 100) / 2 = 90, พ.ย. (80 + 0) / 2 = 40 | S1 = (90 + 60) / 2 = 75, พ.ย. (40 + 60) / 2 = 50 | หลัก = (75 + 50) / 2 = 62.5, พ.ย. (50 + 50) / 2 = 50
        const m = await mainSummary();
        expect(m).toEqual(expect.objectContaining({ sub_count: 2, m10: 62.5, m11: 50, m12: null }));
    });

    test('🛡️ ห้ามกรอกข้อที่คำนวณจากระดับล่าง — รวมข้อที่มีแค่ข้อลูก ไม่มีกิจกรรม (เดิม: กรอกได้)', async () => {
        let r = await save(userToken, { sub: [{ sub_indicator_id: S.s1, month_bh: 10, actual_value: '99' }] });
        expect(r.status).toBe(400);
        r = await save(userToken, { sub: [{ sub_indicator_id: S.s11, month_bh: 10, actual_value: '99' }] });
        expect(r.status).toBe(400);
        r = await as(saToken, request(app).post(api('/sub-results/upsert'))).send({ sub_indicator_id: S.s1, year_bh: YEAR, hospcode: hosp, month_bh: 10, actual_value: '99' });
        expect(r.status).toBe(400);
    });

    test('✅ GET /hierarchy-results คืน parent_sub_id และจำนวนระดับสูงสุด', async () => {
        const r = await as(userToken, request(app).get(api(`/hierarchy-results?indicator_id=${indId}&year_bh=${YEAR}&hospcode=${hosp}`)));
        expect(r.status).toBe(200);
        const subs = Object.fromEntries(r.body.data.subs.map(s => [s.id, s]));
        expect(Number(subs[S.s11].parent_sub_id)).toBe(S.s1);
        expect(subs[S.s1].parent_sub_id).toBeNull();
        expect(r.body.data.activities.map(a => a.id).sort()).toEqual([A.a1, A.a2].sort());
        expect(r.body.data.max_levels).toBe(4);
    });

    test('✅ ปิดข้อแม่ระดับ 2 = ซ่อนทั้งสาย ข้อแม่ด้านบนคำนวณจากข้อที่เหลือ', async () => {
        await as(saToken, request(app).put(api(`/sub-indicators/${S.s11}/toggle-active`))).send({ is_active: 0 });
        // S1 = S12 = 60 → หลัก = (60 + 50) / 2 = 55
        expect(await mainSummary()).toEqual(expect.objectContaining({ m10: 55 }));
        const r = await as(userToken, request(app).get(api(`/hierarchy-results?indicator_id=${indId}&year_bh=${YEAR}&hospcode=${hosp}`)));
        expect(r.body.data.subs.map(s => s.id)).not.toContain(S.s11);
        expect(r.body.data.activities).toEqual([]);
        await as(saToken, request(app).put(api(`/sub-indicators/${S.s11}/toggle-active`))).send({ is_active: 1 });
    });

    test('🛡️ ลบข้อย่อยที่มีผลงานใต้ลงไปไม่ได้ (เดิม: ลบพร้อมผลงานทั้งสาย)', async () => {
        const r = await as(saToken, request(app).delete(api(`/sub-indicators/${S.s1}`)));
        expect(r.status).toBe(400);
        const [[c]] = await db.query('SELECT COUNT(*) AS n FROM kpi_activity_results WHERE activity_id IN (?)', [[A.a1, A.a2]]);
        expect(c.n).toBeGreaterThan(0);
    });
});

describe('ส่งออกตารางรายละเอียด', () => {
    test('✅ item_level ตามความลึก + item_kind + เลขข้อตามสายข้อแม่ — ตารางรูปแบบเดิมถูกย้ายคีย์', async () => {
        // ตาราง _items รูปแบบเดิม (คีย์ item_level, item_id) ที่มีอยู่ก่อนรองรับหลายระดับ
        await db.query(`CREATE TABLE \`${TP}_items\` (hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, item_level TINYINT NOT NULL, item_id INT NOT NULL,
            item_no VARCHAR(20), parent_no VARCHAR(20), item_name VARCHAR(500), value_type VARCHAR(10), calc_mode VARCHAR(10), target VARCHAR(100), result VARCHAR(100),
            m10 VARCHAR(100), m11 VARCHAR(100), m12 VARCHAR(100), m01 VARCHAR(100), m02 VARCHAR(100), m03 VARCHAR(100), m04 VARCHAR(100), m05 VARCHAR(100),
            m06 VARCHAR(100), m07 VARCHAR(100), m08 VARCHAR(100), m09 VARCHAR(100), create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (hospcode, byear, item_level, item_id))`);
        await db.query(`INSERT INTO \`${TP}_items\` (hospcode, byear, item_level, item_id, item_no) VALUES (?, ?, 3, 999999, 'old')`, [hosp, YEAR]);
        const res = await as(saToken, request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: [indId] });
        expect(res.status).toBe(200);
        const [rows] = await db.query(`SELECT item_kind, item_id, item_level, item_no, parent_no, calc_mode, m10, m11 FROM \`${TP}_items\` WHERE byear = ? AND hospcode = ? ORDER BY item_no`, [YEAR, hosp]);
        const by = Object.fromEntries(rows.map(r => [r.item_no, r]));
        expect(Object.keys(by).sort()).toEqual(['5.1', '5.1.1', '5.1.1.1', '5.1.1.2', '5.1.2', '5.2']);
        expect(by['5.1.1']).toEqual(expect.objectContaining({ item_kind: 'sub', item_level: 3, parent_no: '5.1', calc_mode: 'auto', m10: '90', m11: '40' }));
        expect(by['5.1.1.2']).toEqual(expect.objectContaining({ item_kind: 'activity', item_level: 4, parent_no: '5.1.1', m10: '100', m11: '0' }));
        expect(by['5.1']).toEqual(expect.objectContaining({ item_level: 2, calc_mode: 'auto', m10: '75' }));
        expect(by.old).toBeUndefined();   // แถวที่ไม่มีอยู่แล้วถูกลบ
        const [[pk]] = await db.query(`SHOW KEYS FROM \`${TP}_items\` WHERE Key_name = 'PRIMARY' AND Column_name = 'item_kind'`);
        expect(pk).toBeTruthy();
    });
});
