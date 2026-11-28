/**
 * ความพร้อมของตัวชี้วัด (ระยะ 5 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
 *   - evaluateReadiness (ฟังก์ชันล้วน): block/warn/info ตามกฎ + ช่องที่ต้องแก้
 *   - GET /indicators/readiness: ตามขอบเขต (admin_ssj เฉพาะกลุ่มงานตัวเอง), ผู้ไม่มีสิทธิ์หน้าจัดการตัวชี้วัด = 403, นับ "ยังไม่ได้เพิ่มให้หน่วยบริการ" ตามปีงบ
 *   - /bulk-add-kpi ข้ามตัวชี้วัดที่ยังไม่ตั้งประเภทหน่วยบริการ (เดิม = 4 ประเภทหลัก) และแจ้งจำนวน skipped_unset
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { evaluateReadiness } = require('../services/indicator-readiness');

const api = (p) => '/khupskpi/api' + p;
const YEAR = '2502';
let app, db, T = {}, ids = {}, deptA, deptB, saId, HT;

const base = {
    kpi_indicators_name: 'x', table_process: 'kpi_x_001', evaluation_mode: 'all_required', required_off_types: null,
    target_percentage: '80', criterion: '80', dept_id: 1, main_indicator_id: 1, khd_report_id: 5, upload_excel: 0, khd_fiscal_year: null,
};
const codes = (ind, ctx) => evaluateReadiness({ ...base, ...ind }, { year_bh: '2570', assigned: 3, ...ctx }).issues.map(i => i.code);

describe('evaluateReadiness', () => {
    test('ตั้งค่าครบ = ok', () => {
        expect(evaluateReadiness(base, { year_bh: '2570', assigned: 3 })).toEqual({ level: 'ok', issues: [] });
    });
    test('block: ไม่มีชื่อ / ยังไม่ตั้งประเภท / ตารางส่งออกผิด / สูตรผิด', () => {
        expect(codes({ kpi_indicators_name: ' ' })).toEqual(['no_name']);
        expect(codes({ evaluation_mode: 'any_one', required_off_types: '[]' })).toEqual(['hostype_unset']);
        expect(codes({ evaluation_mode: null })).toEqual(['hostype_unset']);
        expect(codes({ table_process: '' })).toEqual(['no_table']);
        expect(codes({ table_process: '1abc' })).toEqual(['bad_table']);
        expect(codes({ table_process: 'kpi-main-2568-1901' })).toEqual([]); // ขีดกลางแปลงเป็นขีดล่างตอนส่งออก (ข้อมูลเดิม)
        expect(codes({ result_formula: 'SUM(' })).toEqual(['bad_formula']);
        expect(codes({ result_formula: 'SUM(ALL)' })).toEqual([]);
        expect(evaluateReadiness({ ...base, evaluation_mode: null }).level).toBe('block');
    });
    test('warn/info: เป้าหมาย/เกณฑ์/กลุ่มงาน/หมวดหมู่/ยังไม่เพิ่มให้หน่วยบริการ/ปีงบไม่ตรง/ปิดส่งออก/ไม่เชื่อม KHD', () => {
        expect(codes({ target_percentage: '', criterion: null, dept_id: null, main_indicator_id: null })).toEqual(['no_target', 'no_criterion', 'no_dept', 'no_main']);
        expect(codes({ target_percentage: '', target_monthly: 'latest' })).toEqual([]); // เป้าหมายรายเดือน
        expect(codes({}, { assigned: 0 })).toEqual(['not_assigned']);
        expect(codes({ khd_fiscal_year: '2568,2569' })).toEqual(['year_mismatch']);
        expect(codes({ khd_fiscal_year: '2569,2570' })).toEqual([]);
        expect(codes({ upload_excel: 1 })).toEqual(['khd_off']);
        expect(codes({ khd_report_id: null })).toEqual(['no_khd_link']);
        expect(evaluateReadiness({ ...base, khd_report_id: null }).level).toBe('info');
        const r = evaluateReadiness({ ...base, criterion: '' });
        expect(r).toMatchObject({ level: 'warn', issues: [{ code: 'no_criterion', field: 'indicator-criterion' }] });
    });
});

describe('GET /indicators/readiness + /bulk-add-kpi', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        db = require('../db');
        await migrationsReady;
        await cleanupTestUsers(db, 'test\\_rdy\\_');
        // กลุ่มงานทดสอบแยก — /bulk-add-kpi เพิ่มให้ทุกตัวชี้วัดของกลุ่มงานนั้น (ไม่ให้แตะตัวชี้วัดอื่นในฐานทดสอบ)
        deptA = (await db.query("INSERT INTO departments (dept_name, dept_code) VALUES ('test_rdy_dept', 'trdy')"))[0].insertId;
        const [[other]] = await db.query('SELECT id FROM departments WHERE id <> ? ORDER BY id LIMIT 1', [deptA]);
        deptB = other.id;
        const mk = async (name, role, extra = {}) => {
            const u = await ensureTestUser(db, { username: name, role, ...extra });
            return { id: u.id, tok: makeToken({ userId: u.id, username: name, role, deptId: extra.dept_id ?? null, hospcode: extra.hospcode ?? null }) };
        };
        const sa = await mk('test_rdy_sa', 'super_admin');
        saId = sa.id; T.sa = sa.tok;
        T.ssjB = (await mk('test_rdy_ssjb', 'admin_ssj', { dept_id: deptB })).tok;
        T.user = (await mk('test_rdy_user', 'user_hos', { dept_id: deptA })).tok;
        const ins = async (name, extra) => (await db.query(
            `INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, target_percentage, criterion, evaluation_mode, required_off_types)
             VALUES (?, ?, 1, ?, '80', '80', ?, ?)`, [name, deptA, extra.tp, extra.mode, extra.types]))[0].insertId;
        // ประเภทหน่วยบริการที่มีน้อยที่สุดในกลุ่มที่ /bulk-add-kpi ใช้ (เพิ่มเร็ว) — เรียงรองด้วยรหัส (ผลคงที่)
        [[{ hostype: HT }]] = await db.query("SELECT hostype FROM chospital WHERE hostype IN ('05','06','07','18') GROUP BY hostype ORDER BY COUNT(*), hostype LIMIT 1");
        ids.ready = await ins('test_rdy_ready', { tp: 'test_rdy_ready', mode: 'any_one', types: JSON.stringify([HT]) });
        ids.unset = await ins('test_rdy_unset', { tp: 'test_rdy_unset', mode: null, types: null });
        const [[h]] = await db.query("SELECT hoscode FROM chospital WHERE hostype = ? ORDER BY hoscode LIMIT 1", [HT]);
        await db.query(`INSERT INTO kpi_results (indicator_id, year_bh, month_bh, target_value, user_id, status, hospcode) VALUES (?, ?, 10, '80', ?, 'Pending', ?)`,
            [ids.ready, YEAR, saId, h.hoscode]);
    }, 60000);

    afterAll(async () => {
        await db.query('DELETE FROM kpi_results WHERE year_bh = ?', [YEAR]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [Object.values(ids)]);
        await db.query("DELETE FROM system_logs WHERE action_type = 'BULK_ADD_KPI' AND new_value LIKE ?", [`%"year_bh":"${YEAR}"%`]);
        await db.query('DELETE FROM departments WHERE id = ?', [deptA]);
        await cleanupTestUsers(db, 'test\\_rdy\\_');
    });

    const get = (tok, q = `?year_bh=${YEAR}`) => request(app).get(api('/indicators/readiness' + q)).set('Authorization', `Bearer ${tok}`);

    test('super_admin เห็นทุกตัว: ตัวที่ยังไม่ตั้งประเภท = block, ตัวที่เพิ่มให้หน่วยบริการแล้ว = ไม่มี not_assigned', async () => {
        const res = await get(T.sa);
        expect(res.status).toBe(200);
        const by = Object.fromEntries(res.body.data.items.map(i => [i.id, i]));
        expect(by[ids.unset].level).toBe('block');
        expect(by[ids.unset].issues.map(i => i.code)).toEqual(expect.arrayContaining(['hostype_unset', 'not_assigned']));
        expect(by[ids.ready].issues.map(i => i.code)).not.toContain('not_assigned');
        expect(by[ids.ready].assigned).toBe(1);
        expect(res.body.data.by_code.hostype_unset).toBeGreaterThanOrEqual(1);
    });

    test('admin_ssj กลุ่มงานอื่นไม่เห็น / ผู้ไม่มีสิทธิ์หน้าจัดการตัวชี้วัด = 403 / ปีผิด = 400', async () => {
        const res = await get(T.ssjB);
        expect(res.status).toBe(200);
        expect(res.body.data.items.some(i => i.id === ids.unset || i.id === ids.ready)).toBe(false);
        expect((await get(T.user)).status).toBe(403);
        expect((await get(T.sa, '?year_bh=25x2')).status).toBe(400);
    });

    test('/bulk-add-kpi ข้ามตัวชี้วัดที่ยังไม่ตั้งประเภท (เดิมเพิ่มให้ 4 ประเภทหลัก)', async () => {
        const pre = await request(app).get(api(`/bulk-add-kpi/preview?year=${YEAR}&dept_id=${deptA}`)).set('Authorization', `Bearer ${T.sa}`);
        expect(pre.status).toBe(200);
        expect(pre.body.skipped_unset).toBeGreaterThanOrEqual(1);
        const res = await request(app).post(api('/bulk-add-kpi')).set('Authorization', `Bearer ${T.sa}`).send({ year_bh: YEAR, dept_id: deptA });
        expect(res.status).toBe(200);
        expect(res.body.skipped_unset).toBeGreaterThanOrEqual(1);
        const [[n]] = await db.query('SELECT COUNT(*) n FROM kpi_results WHERE indicator_id = ? AND year_bh = ?', [ids.unset, YEAR]);
        expect(Number(n.n)).toBe(0);
        const [[m]] = await db.query('SELECT COUNT(DISTINCT hospcode) n FROM kpi_results WHERE indicator_id = ? AND year_bh = ?', [ids.ready, YEAR]);
        const [[c05]] = await db.query("SELECT COUNT(*) n FROM chospital WHERE hostype = ?", [HT]);
        expect(Number(m.n)).toBe(Number(c05.n)); // ตัวที่ตั้งประเภทแล้วยังเพิ่มได้ตามเดิม (ทุกแห่งของประเภทนั้น)
    });
});
