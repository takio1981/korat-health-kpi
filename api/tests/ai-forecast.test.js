/**
 * ระบบเตือนล่วงหน้า ระยะที่ 4 (8 พ.ย. 2569): AI อธิบายรายการตัวชี้วัดเสี่ยง — โมเดลจำลอง (callLlm mock) ไม่เรียกผู้ให้บริการจริง
 *   - POST /report/forecast/ai-explain: server คำนวณใหม่ตามขอบเขตผู้เรียก + ตัวกรอง, prompt ไม่มีรหัส/ชื่อหน่วยบริการ, ไม่มีรายการเสี่ยง = ไม่เรียก AI
 *   - สรุปรายสัปดาห์แนบสรุป AI เมื่อตั้งค่า — AI ล้มเหลว = ส่งต่อโดยไม่มีสรุป AI
 */
jest.mock('../services/ai', () => {
    const actual = jest.requireActual('../services/ai');
    return { ...actual, callLlm: jest.fn(), getAiSettings: jest.fn() };
});
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { callLlm, getAiSettings } = require('../services/ai');
const aiForecast = require('../services/ai-forecast');
const { runForecastDigest } = require('../jobs/forecast-digest');

const YEAR = '2525';
const NOW = new Date(1982, 3, 10, 9, 0); // ปีงบ 2525 ข้อมูลถึง มี.ค.
let app, db, saToken, hosToken, deptId, otherDeptId, hosp;
const created = [];
const api = (p) => '/khupskpi/api' + p;
const as = (t, r) => r.set('Authorization', `Bearer ${t}`);
const reply = (text) => ({ text, model: 'mock-model', provider: 'openai', ms: 1 });
const explain = (t, body) => as(t, request(app).post(api('/report/forecast/ai-explain'))).send({ year_bh: YEAR, through: 5, ...body });

async function addRow(name, dept, h, vals) {
    const [r] = await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active) VALUES (?, ?, 1)', [name, dept]);
    created.push(r.insertId);
    await db.query(`INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, dept_id, dept_name, hosname, distid, distname, target_value, last_actual, oct, nov, dece, jan, feb, mar)
        VALUES (?,?,?,?,?,?,?,?,'80',?,?,?,?,?,?,?)`, [r.insertId, YEAR, h.hoscode, dept, 'test_dept', h.hosname, h.distid, 'test_อำเภอ', vals[5], ...vals]);
    return r.insertId;
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    await migrationsReady;
    db = require('../db');
    await cleanupTestUsers(db);
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    const [depts] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
    deptId = depts[0].id; otherDeptId = depts[1].id;
    const [hs] = await db.query("SELECT hoscode, hosname, distid FROM chospital WHERE distid IS NOT NULL AND hosname <> '' ORDER BY hoscode LIMIT 2");
    hosp = hs;
    const sa = await ensureTestUser(db, { username: 'test_aif_sa', role: 'super_admin', session_id: 'sess-aif-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-aif-sa' });
    const u = await ensureTestUser(db, { username: 'test_aif_hos', role: 'user_hos', dept_id: deptId, hospcode: hs[0].hoscode, session_id: 'sess-aif-hos' });
    hosToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId, hospcode: hs[0].hoscode, sessionId: 'sess-aif-hos' });
    await addRow('test_aif_ตัวชี้วัดเสี่ยงสูง', deptId, hs[0], ['10', '10', '10', '10', '10', '10']);
    await addRow('test_aif_ตัวชี้วัดเฝ้าระวัง', deptId, hs[0], ['75', '75', '75', '75', '75', '75']);
    await addRow('test_aif_หน่วยงานอื่นเสี่ยง', otherDeptId, hs[1], ['5', '5', '5', '5', '5', '5']);
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'forecast\\_%'");
});
afterAll(async () => {
    await db.query('DELETE FROM kpi_summary WHERE year_bh = ?', [YEAR]);
    if (created.length) await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [created]);
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'forecast\\_%'");
    await cleanupTestUsers(db);
});
beforeEach(() => {
    callLlm.mockReset();
    getAiSettings.mockReset();
    getAiSettings.mockResolvedValue({ enabled: true });
    aiForecast._cache.clear();
});

describe('POST /report/forecast/ai-explain', () => {
    test('✅ ส่งจำนวน/ชื่อตัวชี้วัด/อำเภอ — ไม่มีรหัส/ชื่อหน่วยบริการ | เรียกซ้ำใช้แคช', async () => {
        callLlm.mockResolvedValue(reply('■ ภาพรวม\nมีแนวโน้มไม่บรรลุ'));
        const res = await explain(saToken, {});
        expect(res.status).toBe(200);
        expect(res.body.summary).toContain('■ ภาพรวม');
        const { prompt, system, feature } = callLlm.mock.calls[0][0];
        expect(feature).toBe('forecast_explain');
        expect(system).toContain('มีแนวโน้ม');
        expect(system).toContain('ห้ามเรียกเป็นจำนวนหน่วยงานหรือหน่วยบริการ');   // ทดลองจริง: แบบจำลองเขียน "หน่วยงาน 411 รายการ" แทน 411 คู่
        expect(prompt).toContain('test_aif_ตัวชี้วัดเสี่ยงสูง');
        expect(prompt).toContain('test_aif_หน่วยงานอื่นเสี่ยง');
        expect(prompt).toContain('test_อำเภอ');
        expect(prompt).not.toContain(hosp[0].hoscode);
        expect(prompt).not.toContain(hosp[0].hosname);
        expect((await explain(saToken, {})).body.cached).toBe(true);
        expect(callLlm).toHaveBeenCalledTimes(1);
    });
    test('ตัวกรอง (เฉพาะเฝ้าระวัง) + ขอบเขต user_hos ไม่เห็นหน่วยงานอื่น', async () => {
        callLlm.mockResolvedValue(reply('ก'));
        await explain(saToken, { status: 'watch' });
        const p1 = callLlm.mock.calls[0][0].prompt;
        expect(p1).toContain('test_aif_ตัวชี้วัดเฝ้าระวัง');
        expect(p1).not.toContain('test_aif_ตัวชี้วัดเสี่ยงสูง');
        await explain(hosToken, {});
        const p2 = callLlm.mock.calls[1][0].prompt;
        expect(p2).toContain('test_aif_ตัวชี้วัดเสี่ยงสูง');
        expect(p2).not.toContain('test_aif_หน่วยงานอื่นเสี่ยง');
    });
    test('ไม่มีรายการตามตัวกรอง = ไม่เรียก AI | ปิดผู้ช่วย = 503 | ไม่เข้าสู่ระบบ = 401', async () => {
        const r = await explain(saToken, { district: 'ไม่มีอำเภอนี้' });
        expect(r.body.no_risk).toBe(true);
        expect(callLlm).not.toHaveBeenCalled();
        getAiSettings.mockResolvedValue({ enabled: false });
        expect((await explain(saToken, {})).status).toBe(503);
        expect((await request(app).post(api('/report/forecast/ai-explain')).send({})).status).toBe(401);
    });
});

describe('สรุปรายสัปดาห์ + สรุปโดย AI', () => {
    test('ตั้งค่าแนบสรุป AI → ข้อความมีส่วน "สรุปโดย AI" | AI ล้มเหลว = ยังสร้างสรุปได้พร้อม ai_error', async () => {
        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('forecast_digest_ai', 'true') ON DUPLICATE KEY UPDATE setting_value = 'true'");
        callLlm.mockResolvedValue(reply('■ ภาพรวม\nคาดว่ามีตัวชี้วัดเสี่ยง'));
        const ok = await runForecastDigest({ manual: true, preview: true, now: NOW, aiSummarize: aiForecast.forecastAiSummarizer(null) });
        expect(ok.text).toContain('— สรุปโดย AI (โปรดตรวจสอบ) —');
        expect(ok.text).toContain('คาดว่ามีตัวชี้วัดเสี่ยง');
        expect(callLlm.mock.calls[0][0].feature).toBe('forecast_digest');
        getAiSettings.mockResolvedValue({ enabled: false });
        const fail = await runForecastDigest({ manual: true, preview: true, now: NOW, aiSummarize: aiForecast.forecastAiSummarizer(null) });
        expect(fail.text).not.toContain('สรุปโดย AI');
        expect(fail.ai_error).toContain('ยังไม่เปิดใช้งาน');
    });
});
