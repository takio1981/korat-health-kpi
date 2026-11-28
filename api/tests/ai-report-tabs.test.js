/**
 * AI วิเคราะห์และสรุปรายงานสรุปผลรายแถบ — POST /report/ai-tab-summary (15 พ.ย. 2569) — database ทดสอบ + โมเดลจำลอง (callLlm mock)
 *   - server คำนวณรายงานของแถบใหม่ด้วยตัวคำนวณเดียวกับหน้าจอ (ตัวเลขใน prompt = GET /report/<แถบ> ของผู้ใช้คนนั้น)
 *   - ไม่ส่งรหัส/ชื่อหน่วยบริการรายแห่งเข้า prompt (แถบรายหน่วยบริการ/สถานะการบันทึกรายหน่วยบริการ = สรุปตามอำเภอ/ประเภท)
 *   - ขอบเขตตามสิทธิ์ (user_hos = หน่วยบริการตัวเอง), แถบไม่รู้จัก/ไม่มีปีงบ/ไม่มีข้อมูล = 400, แคชต่อชุดข้อมูล
 *   - เส้นทางรายงานเดิมยังคืนผลรูปแบบเดิมหลังแยกตัวคำนวณเป็นฟังก์ชัน
 */
jest.mock('../services/ai', () => {
    const actual = jest.requireActual('../services/ai');
    return { ...actual, callLlm: jest.fn(async () => ({ text: '■ ภาพรวม\n• ทดสอบ', model: 'mock-model', provider: 'openai', ms: 1 })) };
});
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { callLlm } = require('../services/ai');
const tabs = require('../services/ai-report-tabs');

const YEAR = '2503';
let app, db, saToken, sa2Token, hosToken, deptId, hospA, hospB, hosA, hosB, saId;
const created = { indicators: [] };
const api = (p) => '/khupskpi/api' + p;
const promptOf = (call) => call[0].prompt;
const inputOf = (call) => JSON.parse(promptOf(call).match(/\{[\s\S]*\}/)[0]);

async function addIndicator(name) {
    const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?,?,1)', [name, deptId]);
    created.indicators.push(r.insertId);
    return r.insertId;
}
async function addPair(indicatorId, h, target, last) {
    await db.query(
        `INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [indicatorId, YEAR, h.hoscode, deptId, 'test_aitab_dept', h.hosname, h.distid, 'test_aitab_dist_' + h.distid, h.hostype, target, last, last]);
    await db.query("INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, user_id) VALUES (?,?,?,10,?,?, 'Pending', ?)",
        [indicatorId, YEAR, h.hoscode, target, last, saId]);
}

let ind1, ind2;
beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    const [[d]] = await db.query('SELECT id FROM departments WHERE is_active = 1 ORDER BY id LIMIT 1');
    deptId = d.id;
    // 2 หน่วยบริการต่างประเภท (ชื่อ/รหัสต้องไม่หลุดเข้า prompt)
    const [[a]] = await db.query("SELECT hoscode, hosname, distid, hostype FROM chospital WHERE hostype = '07' AND distid IS NOT NULL ORDER BY hoscode LIMIT 1");
    const [[b]] = await db.query("SELECT hoscode, hosname, distid, hostype FROM chospital WHERE hostype = '18' AND distid IS NOT NULL ORDER BY hoscode LIMIT 1");
    hosA = a; hosB = b; hospA = a.hoscode; hospB = b.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_aitab_sa', role: 'super_admin', session_id: 'sess-aitab-sa' });
    saId = sa.id;
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-aitab-sa' });
    // aiLimiter 10 ครั้ง/นาที/ผู้ใช้ — แยกบัญชีที่สองให้ชุดทดสอบหลังๆ
    const sa2 = await ensureTestUser(db, { username: 'test_aitab_sa2', role: 'super_admin', session_id: 'sess-aitab-sa2' });
    sa2Token = makeToken({ userId: sa2.id, username: sa2.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-aitab-sa2' });
    const u = await ensureTestUser(db, { username: 'test_aitab_hos', role: 'user_hos', dept_id: deptId, hospcode: hospA, session_id: 'sess-aitab-hos' });
    hosToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hospA, sessionId: 'sess-aitab-hos' });

    ind1 = await addIndicator('test_aitab_ind1');
    ind2 = await addIndicator('test_aitab_ind2');
    await addPair(ind1, hosA, '80', '90');   // ผ่าน
    await addPair(ind1, hosB, '80', '50');   // ไม่ผ่าน
    await addPair(ind2, hosA, '10', '5');    // ไม่ผ่าน
    await addPair(ind2, hosB, '10', '');     // ยังไม่บันทึก
});

afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    if (created.indicators.length) {
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [created.indicators]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created.indicators]);
    }
    await cleanupTestUsers(db);
});

beforeEach(() => callLlm.mockClear());

const tabSummary = (token, body) => request(app).post(api('/report/ai-tab-summary')).set('Authorization', `Bearer ${token}`).send({ year_bh: YEAR, dept_id: deptId, refresh: true, ...body });
const report = (token, path, qs = '') => request(app).get(api(path + `?year_bh=${YEAR}&dept_id=${deptId}${qs}`)).set('Authorization', `Bearer ${token}`);

describe('POST /report/ai-tab-summary', () => {
    test('แถบไม่รู้จัก / ไม่มีปีงบ = 400 ไม่เรียก AI', async () => {
        expect((await tabSummary(saToken, { tab: 'nope' })).status).toBe(400);
        expect((await tabSummary(saToken, { tab: 'by-indicator', year_bh: '' })).status).toBe(400);
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('รายตัวชี้วัด: ตัวเลขใน prompt ตรงกับ GET /report/by-indicator', async () => {
        const res = await tabSummary(saToken, { tab: 'by-indicator' });
        expect(res.status).toBe(200);
        expect(res.body.summary).toContain('ภาพรวม');
        expect(res.body.report).toBe('รายตัวชี้วัด');
        const rows = (await report(saToken, '/report/by-indicator')).body.data;
        const input = inputOf(callLlm.mock.calls[0]);
        expect(input.overall.indicators).toBe(rows.length);
        // 28 พ.ย. 2569: เน้นการบันทึก — คู่ที่ต้องกรอก/บันทึกแล้ว (ไม่ใช่ผ่านเกณฑ์)
        expect(input.overall.pairs_total).toBe(rows.reduce((s, r) => s + Number(r.hospital_count), 0));
        expect(input.overall.pairs_recorded).toBe(rows.reduce((s, r) => s + Number(r.recorded_hospitals), 0));
        expect(input.overall.pairs_total).toBe(4);
        expect(input.overall.pairs_recorded).toBe(3);
        expect(input.overall.pass_pct).toBeUndefined();
        expect(input.year_bh).toBe(YEAR);
        expect(callLlm.mock.calls[0][0].system).toContain('รายตัวชี้วัด');
    });

    test('รายหน่วยบริการ: ไม่มีรหัส/ชื่อหน่วยบริการใน prompt — สรุปตามประเภท/อำเภอแทน', async () => {
        const res = await tabSummary(saToken, { tab: 'by-hospital' });
        expect(res.status).toBe(200);
        const p = promptOf(callLlm.mock.calls[0]);
        for (const v of [hospA, hospB, hosA.hosname, hosB.hosname]) expect(p).not.toContain(v);
        const input = inputOf(callLlm.mock.calls[0]);
        expect(input.overall.hospitals).toBe(2);
        expect(input.overall.pairs_total).toBe(4);
        expect(input.overall.pairs_recorded).toBe(3);
        expect(input.hospital_types.count).toBe(2);
        expect(input.hospital_types.top.map(t => t.name).join('|')).not.toMatch(/^ประเภท /);   // ใช้ชื่อประเภทจาก chostype
    });

    test('รายอำเภอ / รายปีงบ / สรุปรายกลุ่มงาน', async () => {
        const dist = await tabSummary(saToken, { tab: 'by-district' });
        expect(dist.status).toBe(200);
        const di = inputOf(callLlm.mock.calls[0]);
        expect(di.districts.map(x => x.name).sort()).toEqual([...new Set(['test_aitab_dist_' + hosA.distid, 'test_aitab_dist_' + hosB.distid])].sort());

        const yr = await tabSummary(saToken, { tab: 'by-year' });
        expect(yr.status).toBe(200);
        const yi = inputOf(callLlm.mock.calls[1]);
        expect(yi.years.map(y => y.year_bh)).toContain(YEAR);
        expect(yi.year_bh).toBeUndefined();
        expect(yi.current_fiscal_year).toMatch(/^\d{4}$/);

        const dp = await tabSummary(saToken, { tab: 'by-dept' });
        expect(dp.status).toBe(200);
        const dpi = inputOf(callLlm.mock.calls[2]);
        expect(dpi.overall.departments).toBeGreaterThan(0);
        expect(dpi.departments[0]).toEqual(expect.objectContaining({ name: expect.any(String), coverage_pct: expect.any(Number) }));
    });

    test('สถานะการบันทึก: รายตัวชี้วัด (ชื่อตัวชี้วัดได้) / รายหน่วยบริการ (ไม่มีชื่อหน่วยบริการ)', async () => {
        const a = await tabSummary(sa2Token, { tab: 'recording-status', view: 'by-indicator' });
        expect(a.status).toBe(200);
        const ai = inputOf(callLlm.mock.calls[0]);
        expect(ai.report).toContain('รายตัวชี้วัด');
        expect(ai.overall.pairs).toBe(4);
        expect(ai.overall.pairs_recorded).toBe(3);
        const b = await tabSummary(sa2Token, { tab: 'recording-status', view: 'by-hospital' });
        expect(b.status).toBe(200);
        const p = promptOf(callLlm.mock.calls[1]);
        for (const v of [hospA, hospB, hosA.hosname, hosB.hosname]) expect(p).not.toContain(v);
        expect(inputOf(callLlm.mock.calls[1]).overall.hospitals).toBe(2);
    });

    test('ขอบเขตสิทธิ์: user_hos = เฉพาะหน่วยบริการตัวเอง', async () => {
        const res = await tabSummary(hosToken, { tab: 'by-indicator' });
        expect(res.status).toBe(200);
        const input = inputOf(callLlm.mock.calls[0]);
        expect(input.overall.pairs_total).toBe(2);   // ind1 + ind2 ของ hospA
        expect(input.overall.pairs_recorded).toBe(2);
    });

    test('ไม่มีข้อมูลตามตัวกรอง = 400 ไม่เรียก AI | แคชต่อชุดข้อมูล', async () => {
        const none = await tabSummary(sa2Token, { tab: 'by-district', year_bh: '2401' });
        expect(none.status).toBe(400);
        expect(callLlm).not.toHaveBeenCalled();
        await tabSummary(sa2Token, { tab: 'by-district' });
        const again = await tabSummary(sa2Token, { tab: 'by-district', refresh: false });
        expect(again.body.cached).toBe(true);
        expect(callLlm).toHaveBeenCalledTimes(1);
    });
});

describe('เส้นทางรายงานเดิมหลังแยกตัวคำนวณเป็นฟังก์ชัน', () => {
    test('ผลรูปแบบเดิม + by-hospital คืนประเภทหน่วยบริการ', async () => {
        const byInd = await report(saToken, '/report/by-indicator');
        expect(byInd.status).toBe(200);
        expect(byInd.body.data.find(r => Number(r.indicator_id) === ind1)).toEqual(expect.objectContaining({ recorded_hospitals: 2, hospital_count: 2, achievement_pct: expect.anything() }));
        const byHos = await report(saToken, '/report/by-hospital');
        expect(byHos.body.data.find(r => r.hospcode === hospA).hostype).toBe('07');
        const rec = await report(saToken, '/report/recording-status');
        expect(rec.body.summary.total_indicators).toBe(2);
        expect((await request(app).get(api('/report/recording-status')).set('Authorization', `Bearer ${saToken}`)).status).toBe(400);
        const dept = await request(app).get(api('/report/by-dept-summary')).set('Authorization', `Bearer ${saToken}`);
        expect(dept.body).toEqual({ success: true, summary: { total_depts: 0, fully_covered: 0, not_entered: 0, avg_coverage_pct: 0 }, data: [] });
    });
});

describe('services/ai-report-tabs (ฟังก์ชันล้วน)', () => {
    test('อันดับบน/ล่างไม่ซ้ำกัน และรายการน้อยไม่มีกลุ่มล่าง', () => {
        const items = Array.from({ length: 7 }, (_, i) => ({ name: 'x' + i, pct: i * 10 }));
        const tb = tabs.topBottom(items);
        expect(tb.top.map(x => x.pct)).toEqual([60, 50, 40, 30, 20]);
        expect(tb.bottom.map(x => x.pct)).toEqual([0, 10]);
        expect(tabs.topBottom(items.slice(0, 4)).bottom).toEqual([]);
    });
    test('การกระจายร้อยละ + ค่ากลาง', () => {
        expect(tabs.distribution([0, 30, 60, 90, 100, 120]).map(d => d.count)).toEqual([1, 1, 1, 1, 2]);
        expect(tabs.median([3, 1, 2, 4])).toBe(2.5);
    });
    test('tabKey: สถานะการบันทึกแยกมุมมอง, แถบไม่รู้จัก = null', () => {
        expect(tabs.tabKey('recording-status', 'by-hospital')).toBe('recording-status:by-hospital');
        expect(tabs.tabKey('recording-status', '')).toBe('recording-status:by-indicator');
        expect(tabs.tabKey('by-year')).toBe('by-year');
        expect(tabs.tabKey('__proto__')).toBeNull();
    });
    test('prompt ทุกแถบบังคับใช้ตัวเลขที่ให้มา + ใช้คำว่า "คู่" + หัวข้อ ■', () => {
        for (const k of Object.keys(tabs.TAB_SPECS)) {
            const s = tabs.tabSystemPrompt(k);
            expect(s).toContain('ใช้เฉพาะตัวเลขที่ให้มาเท่านั้น');
            expect(s).toContain('"คู่"');
            expect(s).toContain('■');
        }
        expect(tabs.tabSystemPrompt('by-hospital')).toContain('ห้ามระบุชื่อหน่วยบริการ');
        // ทดลองผู้ให้บริการจริง (15 พ.ย. 2569): AI ปัด 40016 เป็น 40,000, เรียกช่องผลงานรอตรวจสอบว่า 'คู่', คัดลอก '(2–3 ข้อ)' เป็นหัวข้อ, ใช้ 'เปอร์เซ็นต์' ตามป้ายช่วง %
        expect(tabs.tabSystemPrompt('by-year')).toContain('ห้ามปัดเศษ');
        expect(tabs.tabSystemPrompt('by-year')).toContain('ไม่ใช่คู่');
        for (const k of Object.keys(tabs.TAB_SPECS)) expect(tabs.TAB_SPECS[k].sections).not.toContain('(');
        expect(tabs.distribution([1]).map(d => d.range).join('')).not.toContain('%');
        expect(tabs.byYear([{ year_bh: '2569', pending_count: 9 }], {}).years[0].pending_review_months).toBe(9);
    });
});
