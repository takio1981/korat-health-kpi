/**
 * Integration tests: สูตรคำนวณผลงานที่อ้างข้อมูลปีงบประมาณที่แล้ว (prev_result / prev_m.. / PREV_ALL) — database ทดสอบ
 *   - หน้าบันทึกผลงาน (GET /kpi-results) ใช้ข้อมูลปีที่แล้วของหน่วยบริการเดียวกัน + แนบ prev_year ให้ frontend
 *   - kpi_summary คำนวณตามปีน้อยไปมาก และเมื่อข้อมูลปีที่แล้วเปลี่ยน ผลงานปีถัดไปคำนวณใหม่ตามอัตโนมัติ
 *   - Export (performKpiExport) ได้ผลตรงกับหน้าบันทึกผลงาน
 *   - ไม่มีข้อมูลปีที่แล้ว → ผลงานว่าง (ไม่ใช่ 0 หรือ error)
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const Y1 = '2581', Y2 = '2582'; // ปีแยกเฉพาะ test นี้
const GROWTH = '(LAST(ALL) - prev_result) / prev_result * 100';
let app, db, saToken, userToken, deptId, hospcode;
const created = [];
const exportTables = [];
const api = (p) => '/khupskpi/api' + p;

async function waitForColumn(table, column, timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const [rows] = await db.query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
        if (rows.length) return;
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`migration ไม่ได้สร้าง ${table}.${column}`);
}

async function createIndicator(formula, tableProcess) {
    const res = await request(app).post(api('/indicators')).set('Authorization', `Bearer ${saToken}`)
        .send({ kpi_indicators_name: 'test_prevf_' + Date.now() + Math.random(), dept_id: deptId, is_active: 1,
                result_formula: formula, table_process: tableProcess || null });
    expect(res.status).toBe(200);
    created.push(res.body.id);
    return res.body.id;
}
async function save(id, year, months) {
    const r = await request(app).post(api('/update-kpi')).set('Authorization', `Bearer ${userToken}`)
        .send({ updates: [{ indicator_id: id, year_bh: year, hospcode, target_value: '80', ...months }] });
    expect(r.status).toBe(200);
}
async function dashboardRow(id, year) {
    const res = await request(app).get(api(`/kpi-results?year=${year}`)).set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    return res.body.data.find(r => Number(r.indicator_id) === Number(id) && r.hospcode === hospcode);
}
async function refreshYear(id, year) {
    for (const [p, body] of [['/refresh-summary/batch', { indicator_ids: [id], year_bh: year }], ['/refresh-summary/finalize', { year_bh: year }]]) {
        expect((await request(app).post(api(p)).set('Authorization', `Bearer ${saToken}`).send(body)).status).toBe(200);
    }
}
async function summaryOf(id, year) {
    const [rows] = await db.query('SELECT last_actual FROM kpi_summary WHERE indicator_id = ? AND year_bh = ? AND hospcode = ?', [id, year, hospcode]);
    return rows[0] ? rows[0].last_actual : undefined;
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady; // รอ migration ชุดหลักเสร็จทั้งหมด (กัน MDL deadlock กับ ALTER TABLE ที่ยังรันอยู่)
    await waitForColumn('kpi_indicators', 'result_formula');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    deptId = d.id; hospcode = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_prevf_sa', role: 'super_admin', session_id: 'sess-pf-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-pf-sa' });
    const u = await ensureTestUser(db, { username: 'test_prevf_hos', role: 'user_hos', dept_id: deptId, hospcode, session_id: 'sess-pf-hos' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode, sessionId: 'sess-pf-hos' });
});

afterAll(async () => {
    if (created.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [created]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [created]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created]);
    }
    for (const t of exportTables) await db.query(`DROP TABLE IF EXISTS \`${t}\``).catch(() => {});
    await cleanupTestUsers(db);
});

describe('สูตรอ้างผลงานปีงบประมาณที่แล้ว', () => {
    test('✅ หน้าบันทึกผลงาน: ร้อยละการเปลี่ยนแปลงจากปีที่แล้ว + แนบ prev_year ให้ frontend', async () => {
        const id = await createIndicator(GROWTH);
        await save(id, Y1, { oct: '30', nov: '50' }); // ผลงานปีที่แล้ว = 50 (เดือนล่าสุด)
        await save(id, Y2, { oct: '60' });
        const row = await dashboardRow(id, Y2);
        expect(row.last_actual).toBe('20'); // (60 - 50) / 50 * 100
        expect(row.prev_year).toMatchObject({ year_bh: Y1, result: '50', target: '80' });
        expect(row.prev_year.months.nov).toBe('50');
    });

    test('✅ ไม่มีข้อมูลปีที่แล้ว → ผลงานว่าง (ไม่ error, ไม่เป็น 0)', async () => {
        const id = await createIndicator(GROWTH);
        await save(id, Y2, { oct: '60' });
        const row = await dashboardRow(id, Y2);
        expect(row.last_actual).toBeNull();
        expect(row.prev_year).toMatchObject({ year_bh: Y1, result: null });
    });

    test('✅ ใช้รายเดือนปีที่แล้ว: SUM(ALL) + SUM(PREV_ALL)', async () => {
        const id = await createIndicator('SUM(ALL) + SUM(PREV_ALL)');
        await save(id, Y1, { oct: '10', nov: '5' });
        await save(id, Y2, { oct: '1' });
        expect((await dashboardRow(id, Y2)).last_actual).toBe('16');
    });

    // Regression (8 ต.ค. 2569 ระหว่างพัฒนา): เดิม prev_result อ่าน kpi_summary ปีที่แล้ว (ผลตามสูตรของปีนั้น) — สูตรอัตรา
    // เพิ่มขึ้นของปีที่แล้วต้องใช้ปีก่อนหน้านั้นอีก → ปีแรกว่าง แล้วลามว่างทุกปีถัดไป และหน้าบันทึกผลงานกับ summary ไม่ตรงกัน
    test('✅ prev_result = ผลงานปีที่แล้วแบบพื้นฐาน (ค่าเดือนล่าสุด) เหมือนกันทั้งหน้าบันทึกผลงานและ summary ไม่ลามเป็นทอดๆ', async () => {
        const id = await createIndicator(GROWTH);
        await save(id, Y1, { oct: '10', nov: '40' });
        await save(id, Y2, { oct: '50' });
        await refreshYear(id, Y1);
        await refreshYear(id, Y2);
        expect(await summaryOf(id, Y1)).toBeNull(); // ปีแรกไม่มีปีก่อนหน้า → อัตราเพิ่มขึ้นของปีนั้นคำนวณไม่ได้ (ถูกต้อง)
        expect(await summaryOf(id, Y2)).toBe('25'); // แต่ปีถัดไปยังคำนวณได้: (50 - 40) / 40 * 100
        expect((await dashboardRow(id, Y2)).last_actual).toBe('25');
    });

    test('✅ prev_result ของตัวชี้วัดสะสม = ผลรวมทุกเดือนของปีที่แล้ว', async () => {
        const id = await createIndicator('prev_result');
        await db.query('UPDATE kpi_indicators SET is_cumulative = 1 WHERE id = ?', [id]);
        await save(id, Y1, { oct: '10', nov: '40' });
        await save(id, Y2, { oct: '1' });
        expect((await dashboardRow(id, Y2)).last_actual).toBe('50');
    });

    test('✅ kpi_summary: ปีถัดไปคำนวณตาม และอัปเดตตามอัตโนมัติเมื่อข้อมูลปีที่แล้วเปลี่ยน', async () => {
        const id = await createIndicator(GROWTH);
        await save(id, Y1, { oct: '40', nov: '50' });
        await save(id, Y2, { oct: '60' });
        await refreshYear(id, Y1);
        await refreshYear(id, Y2);
        expect(await summaryOf(id, Y2)).toBe('20');

        // ลบผลงานเดือน พ.ย. ของปีที่แล้ว → ผลงานปีที่แล้วเหลือ 40 → ปี Y2 ต้องคำนวณใหม่เป็น 50 โดยไม่ต้องกดอัปเดต Summary
        const [[nov]] = await db.query('SELECT id FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = 11', [id, Y1, hospcode]);
        const del = await request(app).post(api('/kpi-results/manage/bulk-delete')).set('Authorization', `Bearer ${saToken}`).send({ ids: [nov.id] });
        expect(del.status).toBe(200);
        // ปี Y1 ไม่มีปีก่อนหน้า → อัตราเพิ่มขึ้นของปีนั้นว่าง (ถูกต้อง) แต่ปี Y2 ต้องคำนวณใหม่ทันทีจากผลงานปี Y1 ที่เหลือ 40
        expect(await summaryOf(id, Y1)).toBeNull();
        expect(await summaryOf(id, Y2)).toBe('50'); // (60 - 40) / 40 * 100
        expect((await dashboardRow(id, Y2)).last_actual).toBe('50');
    });

    test('✅ Export: ผลงาน (result) ตามสูตรที่อ้างปีที่แล้ว ตรงกับหน้าบันทึกผลงาน', async () => {
        const tp = 'test_prevf_' + Date.now();
        exportTables.push(tp);
        const id = await createIndicator(GROWTH, tp);
        await save(id, Y1, { oct: '50' });
        await save(id, Y2, { oct: '75' });
        const chk = await request(app).post(api('/check-kpi-export')).set('Authorization', `Bearer ${saToken}`).send({ year_bh: Y2, indicator_ids: [id] });
        expect(chk.status).toBe(200);
        const exp = await request(app).post(api('/export-kpi-tables')).set('Authorization', `Bearer ${saToken}`).send({ year_bh: Y2, indicator_ids: [id] });
        expect(exp.status).toBe(200);
        const [[r]] = await db.query(`SELECT result FROM \`${tp}\` WHERE byear = ? AND hospcode = ?`, [Y2, hospcode]);
        expect(Number(r.result)).toBe(50); // (75 - 50) / 50 * 100
        expect((await dashboardRow(id, Y2)).last_actual).toBe('50');
    });
});
