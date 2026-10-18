/**
 * Integration tests: Export 3 ระดับ — ตาราง <table_process>_items (ผลงานรายข้อย่อย/รายกิจกรรม) — database ทดสอบเท่านั้น
 *   - เปิดเฉพาะตัวชี้วัดที่ตั้ง export_items = 1 (ค่าตั้งต้นปิด) | ตารางหลัก <table_process> ไม่เปลี่ยนคอลัมน์
 *   - ข้อย่อย auto = ค่าจากกิจกรรม, กิจกรรมทำแล้ว/ยังไม่ทำ = 100/0, เลขข้อ 3.1 / 3.1.1, result = ค่าเดือนล่าสุด
 *   - เทียบเนื้อหา: รันซ้ำ = unchanged, แก้ค่า = updated, ปิดกิจกรรม = ลบแถว, check-kpi-export เห็นการเปลี่ยนแปลงเฉพาะตาราง items
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const YEAR = '2504';
const TP = 'test_items_' + Date.now().toString(36);
const TP2 = TP + '_off';
let app, db, saToken, deptId, hospA, indId, ind2Id;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const as = (r) => r.set('Authorization', `Bearer ${saToken}`);
const save = (body) => as(request(app).post(api('/hierarchy-results/save'))).send({ year_bh: YEAR, hospcode: hospA, ...body });
const runExport = async (indicatorIds = [indId]) => {
    const r = await as(request(app).post(api('/export-kpi-tables'))).send({ year_bh: YEAR, indicator_ids: indicatorIds });
    expect(r.status).toBe(200);
    return r.body;
};
const itemsRows = async () => (await db.query(`SELECT * FROM \`${TP}_items\` WHERE byear = ? ORDER BY item_level, item_no`, [YEAR]))[0];
const byNo = (rows, no) => rows.find(r => r.item_no === no);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query("SELECT hoscode FROM chospital WHERE hostype = '05' ORDER BY hoscode LIMIT 1");
    deptId = d.id; hospA = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_items_sa', role: 'super_admin', session_id: 'sess-items-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-items-sa' });
    // ขอบเขตเฉพาะ รพ.ศูนย์ (hostype 05) — ตารางหลักไม่ใหญ่เกินไปในการทดสอบ
    const ins = async (name, tp, exportItems) => (await db.query(
        `INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, item_no, export_items, evaluation_mode, required_off_types)
         VALUES (?,?,1,?,?,?, 'any_one', '["05"]')`, [name, deptId, tp, '3', exportItems]))[0].insertId;
    indId = await ins('test_items_ind', TP, 1);
    ind2Id = await ins('test_items_ind_off', TP2, 0);
    const addSub = async (ind, name, mode, order, target) => (await db.query(
        'INSERT INTO kpi_sub_indicators (indicator_id, sub_indicator_name, rollup_mode, sort_order, target_percentage, is_active) VALUES (?,?,?,?,?,1)',
        [ind, name, mode, order, target]))[0].insertId;
    ids.subAuto = await addSub(indId, 'test_items_sub_auto', 'auto', 1, '100');
    ids.subManual = await addSub(indId, 'test_items_sub_manual', 'manual', 2, '80');
    ids.sub2 = await addSub(ind2Id, 'test_items_sub2', 'manual', 1, null);
    const addAct = async (name, type, order) => (await db.query(
        'INSERT INTO kpi_sub_activities (sub_indicator_id, activity_name, value_type, sort_order) VALUES (?,?,?,?)',
        [ids.subAuto, name, type, order]))[0].insertId;
    ids.actNum = await addAct('test_items_act_num', 'number', 1);
    ids.actChk = await addAct('test_items_act_chk', 'check', 2);

    expect((await save({
        activity: [{ activity_id: ids.actNum, month_bh: 10, actual_value: '80' },
                   { activity_id: ids.actChk, month_bh: 10, actual_value: '1' },
                   { activity_id: ids.actChk, month_bh: 11, actual_value: '0' }],
        sub: [{ sub_indicator_id: ids.subManual, month_bh: 10, actual_value: '60', target_value: '100' }],
    })).status).toBe(200);
    expect((await save({ sub: [{ sub_indicator_id: ids.sub2, month_bh: 10, actual_value: '5' }] })).status).toBe(200);
});

afterAll(async () => {
    await new Promise(r => setTimeout(r, 1500)); // refresh summary แบบ fire-and-forget หลังบันทึก
    for (const t of [TP, `${TP}_items`, TP2, `${TP2}_items`]) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
    for (const id of [indId, ind2Id].filter(Boolean)) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_save_audit WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_sub_indicators WHERE indicator_id = ?', [id]);
        await db.query('DELETE FROM kpi_indicators WHERE id = ?', [id]);
    }
    await cleanupTestUsers(db);
});

describe('Export ตาราง _items (ข้อย่อย/กิจกรรม)', () => {
    test('✅ ส่งออกครั้งแรก: แถวครบ ค่าตามกติกา เลขข้อถูกต้อง', async () => {
        const body = await runExport();
        const t = body.created_tables.find(c => c.table === TP);
        expect(t.items).toEqual(expect.objectContaining({ table: `${TP}_items`, inserted: 4, updated: 0, unchanged: 0, removed: 0 }));
        const rows = await itemsRows();
        expect(rows.map(r => r.item_no)).toEqual(['3.1', '3.2', '3.1.1', '3.1.2']);
        const auto = byNo(rows, '3.1');
        expect(auto).toEqual(expect.objectContaining({ hospcode: hospA, item_level: 2, value_type: 'sub', calc_mode: 'auto', parent_no: '3',
            m10: '90', m11: '40', m12: null, result: '40', target: '100' }));
        expect(byNo(rows, '3.1.1')).toEqual(expect.objectContaining({ item_level: 3, parent_no: '3.1', value_type: 'number', m10: '80', result: '80' }));
        expect(byNo(rows, '3.1.2')).toEqual(expect.objectContaining({ value_type: 'check', m10: '100', m11: '0', result: '0', target: null }));
        expect(byNo(rows, '3.2')).toEqual(expect.objectContaining({ calc_mode: 'manual', m10: '60', target: '100', result: '60' }));
    });

    test('✅ ตารางหลักคงโครงสร้างเดิม (ไม่มีคอลัมน์ใหม่)', async () => {
        const [cols] = await db.query(`SHOW COLUMNS FROM \`${TP}\``);
        expect(cols.map(c => c.Field)).toEqual(['hospcode', 'byear', 'target', 'result',
            'm10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'create_date', 'update_date']);
    });

    test('✅ ส่งออกซ้ำโดยไม่มีการเปลี่ยนแปลง = unchanged ทั้งหมด', async () => {
        const t = (await runExport()).created_tables.find(c => c.table === TP);
        expect(t.items).toEqual(expect.objectContaining({ inserted: 0, updated: 0, unchanged: 4, removed: 0 }));
    });

    test('✅ แก้ผลงานกิจกรรม → check-kpi-export เห็นการเปลี่ยนแปลง และ export ปรับเฉพาะแถวที่เปลี่ยน', async () => {
        expect((await save({ activity: [{ activity_id: ids.actNum, month_bh: 11, actual_value: '50' }] })).status).toBe(200);
        const chk = await as(request(app).post(api('/check-kpi-export'))).send({ year_bh: YEAR, indicator_ids: [indId] });
        expect(chk.status).toBe(200);
        const det = chk.body.details.find(d => d.id === indId);
        expect(det.status).toBe('has_changes');
        expect(det.items).toEqual(expect.objectContaining({ changed_count: 2, new_count: 0 })); // กิจกรรม 3.1.1 + ข้อย่อย 3.1 ที่คำนวณจากกิจกรรม
        const t = (await runExport()).created_tables.find(c => c.table === TP);
        expect(t.items).toEqual(expect.objectContaining({ updated: 2, unchanged: 2 }));
        const rows = await itemsRows();
        expect(byNo(rows, '3.1').m11).toBe('25');      // (50 + 0) / 2
        expect(byNo(rows, '3.1.1').result).toBe('50');
    });

    test('✅ ปิดกิจกรรม → แถวของกิจกรรมถูกลบ และข้อย่อยคำนวณใหม่', async () => {
        await db.query('UPDATE kpi_sub_activities SET is_active = 0 WHERE id = ?', [ids.actChk]);
        const t = (await runExport()).created_tables.find(c => c.table === TP);
        expect(t.items).toEqual(expect.objectContaining({ removed: 1, updated: 1 }));
        const rows = await itemsRows();
        expect(byNo(rows, '3.1.2')).toBeUndefined();
        expect(byNo(rows, '3.1')).toEqual(expect.objectContaining({ m10: '80', m11: '50' }));
    });

    test('✅ ตัวชี้วัดที่ไม่ได้เปิดตัวเลือก ไม่สร้างตาราง _items', async () => {
        const body = await runExport([ind2Id]);
        const t = body.created_tables.find(c => c.table === TP2);
        expect(t).toBeDefined();
        expect(t.items).toBeUndefined();
        const [[x]] = await db.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [`${TP2}_items`]);
        expect(Number(x.n)).toBe(0);
    });

    test('✅ ตาราง _items ไม่อยู่ในรายการ Sync to KHD (เก็บในระบบเท่านั้น)', async () => {
        const r = await as(request(app).get(api('/exportable-indicators')));
        expect(r.status).toBe(200);
        const row = r.body.data.find(x => x.id === indId);
        expect(Number(row.export_items)).toBe(1);
        expect(r.body.data.some(x => String(x.table_process).endsWith('_items'))).toBe(false);
    });

    // Regression (18 ต.ค. 2569): action_type 'hierarchy_results' ไม่อยู่ใน ENUM ของ kpi_save_audit → บันทึกประวัติการบันทึกผลงานข้อย่อย/กิจกรรมไม่ได้
    test('✅ บันทึกผลงานข้อย่อย/กิจกรรมถูกเก็บในประวัติการบันทึก (kpi_save_audit)', async () => {
        let rows = [];
        for (let k = 0; k < 30 && rows.length === 0; k++) {
            [rows] = await db.query("SELECT action_type, row_count FROM kpi_save_audit WHERE indicator_id = ? AND action_type = 'hierarchy_results'", [indId]);
            if (!rows.length) await new Promise(r => setTimeout(r, 100));
        }
        expect(rows.length).toBeGreaterThan(0);
    });
});
