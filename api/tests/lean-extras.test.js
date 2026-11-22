/**
 * ส่วนต่อของแผน lean งานผู้ดูแล (22 พ.ย. 2569)
 *   1) ปลดล็อคเดือนที่ยังไม่มีผลงานหลังเดือนล่าสุด (คู่ที่อนุมัติทั้งปีตามระบบเดิม) — ดูตัวอย่าง + พิมพ์ปีงบยืนยัน, ไม่แตะเดือนที่มีผลงาน/ก่อนเดือนล่าสุด/กรอกเอง
 *   2) DB Compare ปุ่มเสี่ยงต้องพิมพ์ยืนยัน (ตรวจที่ server)
 *   3) รายงานค่าใน KHD ของเดือนที่ระบบยังไม่อนุมัติ (อ่าน KHD อย่างเดียว)
 *   4) สำเนาสถานะรายงาน KHD → ความพร้อมของตัวชี้วัด (รายงานปิดใช้งานในปีงบ / ไม่พบรายงาน)
 *   5) คิวรอตรวจคืนเดือนที่รอตรวจ (เลือกอนุมัติถึงเดือนในศูนย์งาน)
 * KHD จำลอง: ตาราง test_khdua_* → test_khdua_*__khd ในฐานทดสอบ, reports/report_fiscal_year_config = ข้อมูลในหน่วยความจำ (ไม่เชื่อม KHD จริง)
 */
const FAKE_REPORTS = [
    { report_id: 990001, report_name: 'test_lx รายงาน A', table_process: 'test_khdua_a', data_source: 'excel', is_active: 1 },
    { report_id: 990003, report_name: 'test_lx รายงาน C', table_process: 'test_khdua_c', data_source: 'excel', is_active: 0 },
];
const FAKE_FY = [
    { report_id: 990001, fiscal_year: 2590, is_active: 0 },
    { report_id: 990003, fiscal_year: 2590, is_active: 1 },
];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: (sql, params) => {
            const s = String(sql);
            if (/FROM reports\b/.test(s)) return Promise.resolve([FAKE_REPORTS]);
            if (/FROM report_fiscal_year_config\b/.test(s)) return Promise.resolve([FAKE_FY]);
            return require('../db').query(s.replace(/`(test_khdua_[a-z])`/g, '`$1__khd`'), params);
        },
    }),
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { typedConfirmText, typedConfirmOk } = require('../core/validate');
const { compareTable } = require('../services/khd-unapproved');
const { isSnapshotDue, effectiveKhdActive } = require('../services/khd-snapshot');
const { evaluateReadiness } = require('../services/indicator-readiness');

const api = (p) => '/khupskpi/api' + p;
const YEAR = '2590';
let app, db, saToken, sa2Token, ssjToken, saId, HC = [], ids = {}, prevSnapStatus = null, prevSnapRows = [];

const months = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
async function addRows(indId, hc, vals, locked) {
    // vals: { month: value } — เดือนที่ไม่ระบุ = ว่าง | locked: true = อนุมัติทั้งปี (ระบบเดิม)
    const rows = months.map(m => [indId, YEAR, hc, m, '10', vals[m] != null ? String(vals[m]) : '', locked ? 'Approved' : 'Pending', locked ? 1 : 0, saId]);
    await db.query('INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, is_locked, user_id) VALUES ?', [rows]);
}
const lockedMonths = async (indId, hc) => (await db.query(
    'SELECT month_bh FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND is_locked = 1 ORDER BY month_bh', [indId, YEAR, hc]))[0].map(r => Number(r.month_bh));

async function cleanupData() {
    const [inds] = await db.query("SELECT id FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_lx %'");
    if (inds.length) {
        const list = inds.map(i => i.id);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [list]);
        await db.query('DELETE FROM kpi_base_values WHERE indicator_id IN (?)', [list]);
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [list]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [list]);
    }
    for (const t of ['test_khdua_a', 'test_khdua_a__khd']) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await require('../server').summaryRefreshIdle();
    await cleanupTestUsers(db, 'test\\_lx\\_');
    await cleanupData();
    const sa = await ensureTestUser(db, { username: 'test_lx_sa', role: 'super_admin' });
    const sa2 = await ensureTestUser(db, { username: 'test_lx_sa2', role: 'super_admin' });
    const ssj = await ensureTestUser(db, { username: 'test_lx_ssj', role: 'admin_ssj', dept_id: 1 });
    saId = sa.id;
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
    sa2Token = makeToken({ userId: sa2.id, username: sa2.username, role: 'super_admin', deptId: null, hospcode: null });
    ssjToken = makeToken({ userId: ssj.id, username: ssj.username, role: 'admin_ssj', deptId: 1, hospcode: null });
    const [hs] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 3');
    HC = hs.map(h => String(h.hoscode));
    const add = async (name, extra = {}) => (await db.query(
        `INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active, upload_excel, evaluation_mode, khd_report_id, dept_id, result_manual)
         VALUES (?, ?, 1, 0, 'all_required', ?, 1, ?)`,
        [name, extra.tp || null, extra.khd || null, extra.manual ? 1 : 0]))[0].insertId;
    ids.a = await add('test_lx A', { tp: 'test_khdua_a', khd: 990001 });
    ids.b = await add('test_lx B (กรอกเอง)', { manual: true });
    ids.c = await add('test_lx C', { khd: 990003 });
    ids.d = await add('test_lx D', { khd: 990099 });
    const [[st]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'khd_reports_snapshot_status'");
    prevSnapStatus = st ? st.setting_value : null;
    [prevSnapRows] = await db.query('SELECT * FROM khd_reports_snapshot');
}, 60000);

afterAll(async () => {
    await require('../server').summaryRefreshIdle();
    await cleanupData();
    await db.query('DELETE FROM khd_reports_snapshot');
    if (prevSnapRows.length) {
        const cols = Object.keys(prevSnapRows[0]);
        await db.query(`INSERT INTO khd_reports_snapshot (${cols.join(', ')}) VALUES ?`, [prevSnapRows.map(r => cols.map(c => r[c]))]);
    }
    if (prevSnapStatus === null) await db.query("DELETE FROM system_settings WHERE setting_key = 'khd_reports_snapshot_status'");
    else await db.query("UPDATE system_settings SET setting_value = ? WHERE setting_key = 'khd_reports_snapshot_status'", [prevSnapStatus]);
    await db.query("DELETE FROM system_logs WHERE action_type IN ('UNLOCK_FUTURE_MONTHS', 'KHD_SNAPSHOT_REFRESH') AND user_id IN (SELECT id FROM users WHERE username LIKE 'test\\_lx\\_%')");
    await cleanupTestUsers(db, 'test\\_lx\\_');
});

describe('ปลดล็อคเดือนที่ยังไม่มีผลงานหลังเดือนล่าสุด', () => {
    beforeAll(async () => {
        await addRows(ids.a, HC[0], { 10: 5, 11: 0, 1: 8 }, true);  // ล่าสุด ม.ค. — ธ.ค. ว่างก่อนเดือนล่าสุด คงล็อค
        await addRows(ids.a, HC[1], {}, true);                       // ไม่มีผลงานเลย → ปลดทั้งปี
        await addRows(ids.b, HC[0], {}, true);                       // ผลงานกรอกเอง (ระดับปี) → ไม่แตะ
        await db.query("INSERT INTO kpi_base_values (indicator_id, year_bh, hospcode, var_key, base_value) VALUES (?, ?, ?, '__result', '50')", [ids.b, YEAR, HC[0]]);
        await addRows(ids.a, HC[2], { 10: 1 }, false);               // ยังไม่ล็อค → ไม่เกี่ยว
    });

    test('ดูตัวอย่าง: นับเฉพาะเดือนหลังเดือนล่าสุดที่ล็อคและว่าง', async () => {
        const res = await request(app).get(api(`/work-center/locked-future?year_bh=${YEAR}`)).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ pairs: 2, months: 8 + 12, indicators: 1, hospitals: 2 });
        expect(res.body.data.by_indicator[0]).toMatchObject({ indicator_id: ids.a, pairs: 2 });
    });

    test('ไม่ใช่ super_admin = 403 / พิมพ์ปีงบไม่ตรง = 400 ไม่แก้ข้อมูล', async () => {
        const r1 = await request(app).get(api(`/work-center/locked-future?year_bh=${YEAR}`)).set('Authorization', `Bearer ${ssjToken}`);
        expect(r1.status).toBe(403);
        const r2 = await request(app).post(api('/work-center/unlock-future-months')).set('Authorization', `Bearer ${saToken}`).send({ year_bh: YEAR, confirm: '2589' });
        expect(r2.status).toBe(400);
        expect(r2.body.code).toBe('CONFIRM_REQUIRED');
        expect(await lockedMonths(ids.a, HC[1])).toHaveLength(12);
    });

    test('ปลดล็อคจริง: เดือนที่มีผลงานและเดือนว่างก่อนเดือนล่าสุดคงล็อค', async () => {
        const res = await request(app).post(api('/work-center/unlock-future-months')).set('Authorization', `Bearer ${saToken}`).send({ year_bh: YEAR, confirm: YEAR });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ pairs: 2, months: 20 });
        expect(await lockedMonths(ids.a, HC[0])).toEqual([1, 10, 11, 12]);   // ต.ค. พ.ย. ธ.ค. ม.ค.
        expect(await lockedMonths(ids.a, HC[1])).toEqual([]);
        expect(await lockedMonths(ids.b, HC[0])).toHaveLength(12);           // กรอกเอง ไม่แตะ
        const [[st]] = await db.query('SELECT status FROM kpi_results WHERE indicator_id = ? AND year_bh = ? AND hospcode = ? AND month_bh = 1', [ids.a, YEAR, HC[0]]);
        expect(st.status).toBe('Approved');                                  // ผลงานที่อนุมัติแล้วไม่เปลี่ยนสถานะ
        const again = await request(app).get(api(`/work-center/locked-future?year_bh=${YEAR}`)).set('Authorization', `Bearer ${saToken}`);
        expect(again.body.data.pairs).toBe(0);
    });
});

describe('DB Compare: ปุ่มเสี่ยงต้องพิมพ์ยืนยัน', () => {
    test('typedConfirmText: 1 ตาราง = ชื่อตาราง / หลายตาราง = "<จำนวน> ตาราง"', () => {
        expect(typedConfirmText(['kpi_a'])).toBe('kpi_a');
        expect(typedConfirmText(['a', 'b', 'c'])).toBe('3 ตาราง');
        expect(typedConfirmOk(['kpi_a'], ' kpi_a ')).toBe(true);
        expect(typedConfirmOk(['kpi_a'], 'kpi_b')).toBe(false);
        expect(typedConfirmOk(['a', 'b'], undefined)).toBe(false);
    });
    test.each(['/db-compare/create-remote', '/db-compare/sync-to-khd', '/db-compare/sync-data'])('%s ไม่พิมพ์/พิมพ์ผิด = 400 CONFIRM_REQUIRED', async (p) => {
        const r1 = await request(app).post(api(p)).set('Authorization', `Bearer ${saToken}`).send({ tables: ['test_khdua_zz'] });
        expect(r1.status).toBe(400);
        expect(r1.body).toMatchObject({ code: 'CONFIRM_REQUIRED', expected: 'test_khdua_zz' });
        const r2 = await request(app).post(api(p)).set('Authorization', `Bearer ${saToken}`).send({ tables: ['test_khdua_zz'], confirm_text: 'test_khdua_yy' });
        expect(r2.status).toBe(400);
    });
});

describe('รายงานค่าใน KHD ที่ยังไม่อนุมัติในระบบ', () => {
    test('compareTable (ฟังก์ชันล้วน): ล็อคแล้วไม่นับ / รอตรวจ / ส่งคืน / ระบบไม่มีค่า', () => {
        const state = new Map([['h1', new Map([
            [10, { locked: true, status: 'Approved', value: '5' }],
            [11, { locked: false, status: 'Pending', value: '7' }],
            [12, { locked: false, status: 'Rejected', value: '4' }],
        ])]]);
        const r = compareTable([{ hospcode: 'h1', byear: '2590', m10: '5', m11: '7', m12: '9', m01: '3', m02: '' }, { hospcode: 'h2', m10: '1' }], state);
        expect(r).toMatchObject({ cells: 4, same_as_local: 1, hospitals: 2, by_kind: { pending: 1, rejected: 1, empty: 2 } });
        expect(r.sample.find(s => s.month_bh === 11)).toMatchObject({ kind: 'pending', same: true });
    });

    test('POST /khd-sync/unapproved-report อ่าน KHD แล้วเทียบกับสถานะในระบบ (ไม่เขียน KHD)', async () => {
        const cols = 'hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, m10 VARCHAR(100) NULL, m11 VARCHAR(100) NULL, m12 VARCHAR(100) NULL, update_date DATETIME NULL';
        await db.query(`CREATE TABLE test_khdua_a__khd (${cols}, PRIMARY KEY (hospcode, byear))`);
        // HC[0]: ต.ค. พ.ย. ธ.ค. ล็อคแล้ว (จากชุดก่อนหน้า) | HC[2]: ต.ค. = 1 ยังไม่อนุมัติ (ค่าเท่ากัน), พ.ย. KHD มีค่าแต่ระบบว่าง
        await db.query('INSERT INTO test_khdua_a__khd (hospcode, byear, m10, m11, m12) VALUES ?', [[
            [HC[0], YEAR, '5', '0', '2'], [HC[2], YEAR, '1', '6', null], [HC[2], '2589', '9', '9', '9'],
        ]]);
        const before = (await db.query('SELECT * FROM test_khdua_a__khd ORDER BY hospcode, byear'))[0];
        const r403 = await request(app).post(api('/khd-sync/unapproved-report')).set('Authorization', `Bearer ${ssjToken}`).send({ year_bh: YEAR });
        expect(r403.status).toBe(403);
        const res = await request(app).post(api('/khd-sync/unapproved-report')).set('Authorization', `Bearer ${saToken}`).send({ year_bh: YEAR, refresh: true });
        expect(res.status).toBe(200);
        const t = res.body.data.tables.find(x => x.table === 'test_khdua_a');
        expect(t).toMatchObject({ cells: 2, same_as_local: 1, hospitals: 1, by_kind: { pending: 1, rejected: 0, empty: 1 } });
        expect(t.indicator_names).toContain('test_lx A');
        expect((await db.query('SELECT * FROM test_khdua_a__khd ORDER BY hospcode, byear'))[0]).toEqual(before);
    }, 120000);
});

describe('สำเนาสถานะรายงาน KHD → ความพร้อมของตัวชี้วัด', () => {
    test('isSnapshotDue / effectiveKhdActive (ฟังก์ชันล้วน)', () => {
        const now = new Date('2026-11-22T10:00:00Z');
        expect(isSnapshotDue(null, now)).toBe(true);
        expect(isSnapshotDue({ refreshed_at: '2026-11-22T01:00:00Z' }, now)).toBe(false);
        expect(isSnapshotDue({ refreshed_at: '2026-11-21T09:00:00Z' }, now)).toBe(true);
        expect(isSnapshotDue({ refreshed_at: '2026-11-20T09:00:00Z', error: 'x', last_try: '2026-11-22T08:00:00Z' }, now)).toBe(false);
        expect(effectiveKhdActive({ is_active: 1, fy_active: { 2590: 0 } }, '2590')).toBe(0);
        expect(effectiveKhdActive({ is_active: 0, fy_active: { 2590: 1 } }, '2591')).toBe(0);
        expect(effectiveKhdActive({ is_active: 1, fy_active: {} }, '2590')).toBe(1);
        const ind = { kpi_indicators_name: 'x', table_process: 'kpi_x_001', evaluation_mode: 'all_required', target_percentage: '1', criterion: '1', dept_id: 1, main_indicator_id: 1, khd_report_id: 7, upload_excel: 0 };
        const map = new Map([[7, { is_active: 1, fy_active: { 2590: 0 } }]]);
        expect(evaluateReadiness(ind, { year_bh: '2590', assigned: 1, khd: map }).issues.map(i => i.code)).toEqual(['khd_inactive']);
        expect(evaluateReadiness({ ...ind, khd_report_id: 8 }, { year_bh: '2590', assigned: 1, khd: map }).issues.map(i => i.code)).toEqual(['khd_report_missing']);
        expect(evaluateReadiness(ind, { year_bh: '2590', assigned: 1, khd: null }).issues).toEqual([]); // ยังไม่มีสำเนา = ไม่ตรวจ
    });

    test('POST /khd-snapshot/refresh (super_admin เท่านั้น) แล้ว GET /indicators/readiness แสดงสถานะรายงาน KHD', async () => {
        const r403 = await request(app).post(api('/khd-snapshot/refresh')).set('Authorization', `Bearer ${ssjToken}`);
        expect(r403.status).toBe(403);
        const res = await request(app).post(api('/khd-snapshot/refresh')).set('Authorization', `Bearer ${sa2Token}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ count: 2, error: null });
        const rd = await request(app).get(api(`/indicators/readiness?year_bh=${YEAR}`)).set('Authorization', `Bearer ${saToken}`);
        expect(rd.status).toBe(200);
        expect(rd.body.data.khd_snapshot).toMatchObject({ available: true, count: 2 });
        const codesOf = (id) => rd.body.data.items.find(i => i.id === id).issues.map(i => i.code);
        expect(codesOf(ids.a)).toContain('khd_inactive');          // ปีงบ 2590 ปิดใน report_fiscal_year_config
        expect(codesOf(ids.c)).not.toContain('khd_inactive');      // reports ปิด แต่ปีงบนี้เปิด
        expect(codesOf(ids.d)).toContain('khd_report_missing');
    });
});

describe('คิวรอตรวจคืนเดือนที่รอตรวจ', () => {
    test('pending_months เรียงตามปีงบ', async () => {
        await addRows(ids.c, HC[1], { 10: 3, 11: 4 }, false);
        await require('../server').scheduleSummaryRefresh([{ indicator_id: ids.c, year_bh: YEAR }]);
        await require('../server').summaryRefreshIdle();
        const res = await request(app).get(api(`/work-center/review-queue?year_bh=${YEAR}`)).set('Authorization', `Bearer ${saToken}`);
        expect(res.status).toBe(200);
        const it = res.body.items.find(i => i.indicator_id === ids.c && i.hospcode === HC[1]);
        expect(it).toBeTruthy();
        expect(it.pending_months).toEqual([10, 11]);
    });
});
