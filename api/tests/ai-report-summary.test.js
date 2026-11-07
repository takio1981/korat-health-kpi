/**
 * สรุปรายงานด้วย AI — POST /report/ai-summary (7 พ.ย. 2569) — database ทดสอบ + โมเดลจำลอง (callLlm mock)
 *   - ข้อมูลที่ส่งเข้า prompt = ตัวเลขชุดเดียวกับ GET /report/chart-stats ของผู้ใช้คนนั้น (ขอบเขต role + ตัวกรอง)
 *   - user_hos ส่งได้เฉพาะข้อมูลหน่วยบริการตัวเอง, ไม่มีรหัสหน่วยบริการ/ข้อมูลผู้ใช้ใน prompt
 *   - ผลแคชต่อชุดข้อมูลเดียวกัน (refresh = สร้างใหม่), ไม่มีข้อมูล = 400
 */
jest.mock('../services/ai', () => {
    const actual = jest.requireActual('../services/ai');
    return { ...actual, callLlm: jest.fn(async () => ({ text: '■ ภาพรวม\n• ทดสอบ', model: 'mock-model', provider: 'openai', ms: 1 })) };
});
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { callLlm } = require('../services/ai');
const { buildSummaryInput, rank, TOP_N } = require('../services/ai-report');

const YEAR = '2502';
let app, db, saToken, hosToken, deptId, hospA, hospB;
const created = { indicators: [], mains: [], yuts: [] };
const api = (p) => '/khupskpi/api' + p;
const promptInput = (call) => JSON.parse(call[0].prompt.match(/\{[\s\S]*\}/)[0]);

async function addIndicator(name, mainId) {
    const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, main_indicator_id, dept_id, is_active) VALUES (?,?,?,1)', [name, mainId, deptId]);
    created.indicators.push(r.insertId);
    return r.insertId;
}
async function addSummary(indicatorId, hospcode, target, last) {
    const [[h]] = await db.query('SELECT hosname, distid, hostype FROM chospital WHERE hoscode = ?', [hospcode]);
    await db.query(
        `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [indicatorId, YEAR, hospcode, deptId, 'test_aisum_dept', h.hosname, h.distid, 'test_aisum_dist', h.hostype, target, last, last]);
}

let ind1, ind2;
beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const hs = (await db.query('SELECT hoscode FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 2'))[0];
    deptId = d.id; hospA = hs[0].hoscode; hospB = hs[1].hoscode;
    const sa = await ensureTestUser(db, { username: 'test_aisum_sa', role: 'super_admin', session_id: 'sess-aisum-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-aisum-sa' });
    const u = await ensureTestUser(db, { username: 'test_aisum_hos', role: 'user_hos', dept_id: deptId, hospcode: hospA, session_id: 'sess-aisum-hos' });
    hosToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hospA, sessionId: 'sess-aisum-hos' });

    const [y] = await db.query("INSERT INTO main_yut (yut_name) VALUES ('test_aisum_yut')"); created.yuts.push(y.insertId);
    const [m] = await db.query('INSERT INTO kpi_main_indicators (main_indicator_name, yut_id) VALUES (?,?)', ['test_aisum_main', y.insertId]); created.mains.push(m.insertId);
    ind1 = await addIndicator('test_aisum_ind1', m.insertId);
    ind2 = await addIndicator('test_aisum_ind2', m.insertId);
    await addSummary(ind1, hospA, '80', '90');  // ผ่าน
    await addSummary(ind1, hospB, '80', '50');  // ไม่ผ่าน
    await addSummary(ind2, hospA, '10', '5');   // ไม่ผ่าน
    await addSummary(ind2, hospB, '10', '12');  // ผ่าน
});

afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    if (created.indicators.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created.indicators]);
    if (created.mains.length) await db.query('DELETE FROM kpi_main_indicators WHERE id IN (?)', [created.mains]);
    if (created.yuts.length) await db.query('DELETE FROM main_yut WHERE id IN (?)', [created.yuts]);
    await cleanupTestUsers(db);
});

beforeEach(() => callLlm.mockClear());

const summary = (token, body) => request(app).post(api('/report/ai-summary')).set('Authorization', `Bearer ${token}`).send({ year_bh: YEAR, ...body });
const chartStats = (token, qs = '') => request(app).get(api(`/report/chart-stats?year_bh=${YEAR}${qs}`)).set('Authorization', `Bearer ${token}`);

describe('POST /report/ai-summary', () => {
    test('super_admin: ตัวเลขใน prompt ตรงกับหน้ากราฟ และคืนข้อความสรุป', async () => {
        const res = await summary(saToken, { indicator_id: ind1, refresh: true });
        expect(res.status).toBe(200);
        expect(res.body.summary).toContain('ภาพรวม');
        expect(res.body.cached).toBe(false);
        expect(callLlm).toHaveBeenCalledTimes(1);
        expect(callLlm.mock.calls[0][0].feature).toBe('report_summary');
        const input = promptInput(callLlm.mock.calls[0]);
        const cs = (await chartStats(saToken, `&indicator_id=${ind1}`)).body.overall;
        expect(input.overall).toMatchObject({ pairs: cs.pairs, with_target: cs.with_target, passed: cs.passed, achievement_pct: cs.achievement_pct });
        expect(input.overall).toMatchObject({ pairs: 2, passed: 1, achievement_pct: 50 });
        expect(input.filters['ตัวชี้วัด']).toBe('test_aisum_ind1');
    });

    test('user_hos: ส่งได้เฉพาะข้อมูลหน่วยบริการตัวเอง และไม่มีรหัสหน่วยบริการ/ชื่อผู้ใช้ใน prompt', async () => {
        const res = await summary(hosToken, { refresh: true });
        expect(res.status).toBe(200);
        const input = promptInput(callLlm.mock.calls[0]);
        const cs = (await chartStats(hosToken)).body.overall;
        expect(input.overall.hospitals).toBe(1);
        expect(input.overall).toMatchObject({ pairs: cs.pairs, passed: cs.passed, with_target: cs.with_target });
        const raw = callLlm.mock.calls[0][0].prompt;
        expect(raw).not.toContain(hospA);
        expect(raw).not.toContain(hospB);
        expect(raw).not.toContain('test_aisum_hos');
    });

    test('ชุดข้อมูลเดิมใช้ผลจากแคช, refresh = สร้างใหม่', async () => {
        await summary(saToken, { refresh: true });
        const again = await summary(saToken, {});
        expect(again.body.cached).toBe(true);
        expect(callLlm).toHaveBeenCalledTimes(1);
        await summary(saToken, { refresh: true });
        expect(callLlm).toHaveBeenCalledTimes(2);
    });

    test('ไม่มีข้อมูลตามตัวกรอง = 400 และไม่เรียกโมเดล', async () => {
        const res = await summary(saToken, { year_bh: '2401', refresh: true });
        expect(res.status).toBe(400);
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('ไม่ได้เข้าสู่ระบบ = 401', async () => {
        expect((await request(app).post(api('/report/ai-summary')).send({})).status).toBe(401);
    });
});

describe('buildSummaryInput (ฟังก์ชันล้วน)', () => {
    const row = (gname, passed, with_target) => ({ gname, passed, with_target, achievement_pct: with_target ? passed / with_target * 100 : 0, recording_pct: 100 });
    test('อันดับบน/ล่าง: ไม่ซ้ำกันเมื่อรายการไม่เกิน TOP_N และตัดตัวชี้วัดที่มีเป้าหมายน้อยกว่า 3 คู่', () => {
        expect(rank([row('ก', 1, 2), row('ข', 2, 2)]).bottom).toEqual([]);
        const many = Array.from({ length: TOP_N + 3 }, (_, i) => row('อ' + i, i, 10));
        const r = rank(many);
        expect(r.top[0].name).toBe('อ' + (TOP_N + 2));
        expect(r.bottom[0].name).toBe('อ0');
        const input = buildSummaryInput({ year_bh: '2569', overall: {}, by_indicator: [row('น้อย', 1, 2), row('พอ', 2, 3)] });
        expect(input.indicators.top.map(x => x.name)).toEqual(['พอ']);
    });
    test('รายเดือน: ตัดเดือนที่ยังไม่มีผลงาน และ pass_pct = null เมื่อไม่มีข้อมูลเทียบ', () => {
        const input = buildSummaryInput({ year_bh: '2569', overall: {}, monthly: [
            { label: 'ต.ค.', recorded: 5, eligible: 4, pass_pct: 50 }, { label: 'พ.ย.', recorded: 3, eligible: 0, pass_pct: 0 }, { label: 'ธ.ค.', recorded: 0, eligible: 0, pass_pct: 0 }] });
        expect(input.monthly).toEqual([{ month: 'ต.ค.', recorded: 5, pass_pct: 50 }, { month: 'พ.ย.', recorded: 3, pass_pct: null }]);
    });
});
