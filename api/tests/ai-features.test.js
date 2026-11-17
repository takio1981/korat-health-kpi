/**
 * เปิด-ปิดผู้ช่วย AI รายหน้า (17 พ.ย. 2569) — database ทดสอบ + ผู้ให้บริการจำลอง (stub fetch — ไม่เรียกผู้ให้บริการจริง)
 *   - ค่าตั้งต้น = เปิดทุกส่วน (พฤติกรรมเดิม), ปิดรวมยังมาก่อนเสมอ
 *   - PUT /ai/settings รับ features บางส่วน = รวมกับค่าเดิม, key ไม่รู้จัก/ค่าไม่ใช่ boolean = 400
 *   - ส่วนที่ปิด = 503 AI_FEATURE_DISABLED ทั้งที่ callLlm และก่อนอ่านแคช/ค้นคู่มือ, ส่วนอื่นยังใช้ได้
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken, userToken, saId, savedSettings = [];
const api = (p) => '/khupskpi/api' + p;
const as = (r, t = saToken) => r.set('Authorization', `Bearer ${t}`);
const realFetch = global.fetch;
const okFetch = () => jest.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ model: 'test-model', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
}));
const putSettings = (body, t) => as(request(app).put(api('/ai/settings')), t).send({
    enabled: true, provider: 'openai', base_url: 'http://ai.test.local/v1', model: 'test-model', daily_limit: 500, api_key: 'sk-test-ai-features', ...body,
});

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    [savedSettings] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'ai\\_%'");
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'ai\\_%'");
    const sa = await ensureTestUser(db, { username: 'test_aifeat_sa', role: 'super_admin', session_id: 'sess-aifeat-sa' });
    saId = sa.id;
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-aifeat-sa' });
    const u = await ensureTestUser(db, { username: 'test_aifeat_hos', role: 'user_hos', session_id: 'sess-aifeat-hos' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId: 1, hospcode: '11000', sessionId: 'sess-aifeat-hos' });
});

afterEach(() => { global.fetch = realFetch; });

afterAll(async () => {
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'ai\\_%'");
    for (const r of savedSettings) await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
    await db.query('DELETE FROM ai_usage_logs WHERE user_id = ?', [saId]);
    await cleanupTestUsers(db);
});

describe('เปิด-ปิด AI รายหน้า', () => {
    test('ค่าตั้งต้น = เปิดทุกส่วน, ปิดรวม = ทุกส่วนปิดใน /ai/status', async () => {
        expect((await putSettings({ enabled: false })).status).toBe(200);
        let st = (await as(request(app).get(api('/ai/status')), userToken)).body;
        expect(st.enabled).toBe(false);
        expect(Object.values(st.features).every(v => v === false)).toBe(true);

        expect((await putSettings({})).status).toBe(200);
        st = (await as(request(app).get(api('/ai/status')), userToken)).body;
        expect(st.features).toMatchObject({ chart_summary: true, report_tab: true, forecast: true, anomaly: true, formula: true, khd_mapping: true, help: true, data_quality: true });

        const g = (await as(request(app).get(api('/ai/settings')))).body.data;
        expect(g.areas.map(a => a.key)).toEqual(Object.keys(st.features));
        expect(g.areas.every(a => a.label && a.page)).toBe(true);
    });

    test('ข้อมูลไม่ถูกต้อง = 400 และไม่เปลี่ยนค่า', async () => {
        expect((await putSettings({ features: { nope: false } })).status).toBe(400);
        expect((await putSettings({ features: { help: 'false' } })).status).toBe(400);
        expect((await putSettings({ features: ['help'] })).status).toBe(400);
        expect((await putSettings({ features: { __proto__: false } })).status).toBe(200); // JSON ไม่มี own key = ไม่เปลี่ยนอะไร
        const st = (await as(request(app).get(api('/ai/status')), userToken)).body;
        expect(st.features.help).toBe(true);
    });

    test('ส่งบางส่วน = รวมกับค่าเดิม, ไม่ส่ง features = คงค่าเดิม + บันทึก log', async () => {
        expect((await putSettings({ features: { help: false } })).status).toBe(200);
        expect((await putSettings({ features: { formula: false } })).status).toBe(200);
        const [[log]] = await db.query("SELECT details FROM login_logs WHERE action = 'AI_SETTINGS_UPDATE' ORDER BY id DESC LIMIT 1");
        expect(String(log.details)).toContain('ปิดรายหน้า: จัดการตัวชี้วัด — ช่วยเขียนสูตร');
        expect((await putSettings({ model: 'test-model' })).status).toBe(200);
        const st = (await as(request(app).get(api('/ai/status')), userToken)).body;
        expect(st.features).toMatchObject({ help: false, formula: false, chart_summary: true });
    });

    test('ส่วนที่ปิด = 503 AI_FEATURE_DISABLED (ไม่เรียกผู้ให้บริการ), ส่วนอื่นยังใช้ได้', async () => {
        global.fetch = okFetch();
        await putSettings({ features: { help: false, formula: false, chart_summary: true, report_tab: false } });

        const h = await as(request(app).post(api('/ai/help-ask')), userToken).send({ question: 'วิธีบันทึกผลงานตัวชี้วัด' });
        expect(h.status).toBe(503);
        expect(h.body.code).toBe('AI_FEATURE_DISABLED');

        const f = await as(request(app).post(api('/ai/formula-suggest'))).send({ description: 'ผลรวมทุกเดือน', kind: 'result' });
        expect(f.status).toBe(503);
        expect(f.body.code).toBe('AI_FEATURE_DISABLED');

        const t = await as(request(app).post(api('/report/ai-tab-summary'))).send({ tab: 'by-indicator', year_bh: '2569' });
        expect(t.status).toBe(503);
        expect(global.fetch).not.toHaveBeenCalled();

        // ส่วนที่เปิด: ไปถึงตัวตรวจข้อมูล/ผู้ให้บริการตามปกติ (ไม่ใช่ 503)
        const s = await as(request(app).post(api('/report/ai-summary'))).send({ year_bh: '2569' });
        expect(s.status).not.toBe(503);
    });

    test('การทดสอบการเชื่อมต่อไม่ถูกปิดรายหน้า', async () => {
        global.fetch = okFetch();
        await putSettings({ features: { help: false, formula: false, chart_summary: false, report_tab: false, forecast: false, anomaly: false, khd_mapping: false, data_quality: false } });
        const r = await as(request(app).post(api('/ai/test'))).send({});
        expect(r.status).toBe(200);
    });
});
