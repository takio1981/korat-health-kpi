/**
 * ผู้ช่วย AI — ส่วนกลาง (7 พ.ย. 2569) — database ทดสอบ + ผู้ให้บริการจำลอง (ไม่เรียก Claude/OpenAI จริง)
 *   - ตั้งค่าผู้ให้บริการได้เฉพาะ super_admin, API key เข้ารหัสในฐานข้อมูลและไม่หลุดออกทาง GET /settings หรือ GET /ai/settings
 *   - adapter แบบ OpenAI-compatible (Ollama/Groq/OpenRouter/Gemini) และ Claude (SDK) สร้างคำขอถูกต้อง
 *   - ข้อผิดพลาดจากผู้ให้บริการไม่ส่งกลับเป็น 401 (หน้าจอจะถือว่าหมดสิทธิ์เข้าสู่ระบบ), AI ปฏิเสธ = 422
 *   - ปิดอยู่ = 503, ใช้ครบโควตารายวัน = 429, ทุกการเรียกบันทึก ai_usage_logs
 */
const mockAnthropic = { calls: [], next: null, models: [], listCalls: 0 };
jest.mock('@anthropic-ai/sdk', () => {
    class APIError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
    class AuthenticationError extends APIError {}
    class PermissionDeniedError extends APIError {}
    class NotFoundError extends APIError {}
    class RateLimitError extends APIError {}
    class APIConnectionError extends APIError {}
    class Anthropic {
        constructor(opts) {
            this.opts = opts;
            this.beta = { messages: { create: async (body) => { mockAnthropic.calls.push({ opts, body }); return mockAnthropic.next(body); } } };
            this.models = { list: () => { mockAnthropic.listCalls++; return (async function* () { for (const m of mockAnthropic.models) yield m; })(); } };
        }
    }
    Object.assign(Anthropic, { APIError, AuthenticationError, PermissionDeniedError, NotFoundError, RateLimitError, APIConnectionError });
    return Anthropic;
});

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken, userToken, saId, savedSettings = [];
const api = (p) => '/khupskpi/api' + p;
const as = (r, t = saToken) => r.set('Authorization', `Bearer ${t}`);
const KEY = 'sk-test-ai-core-123456';
const realFetch = global.fetch;

const okFetch = (content = 'ผู้ช่วย AI พร้อมใช้งาน') => jest.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ model: 'test-model', choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
}));
const putSettings = (body, t) => as(request(app).put(api('/ai/settings')), t).send({
    enabled: true, provider: 'openai', base_url: 'http://ai.test.local/v1', model: 'test-model', daily_limit: 50, ...body,
});

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    [savedSettings] = await db.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE 'ai\\_%'");
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'ai\\_%'");
    const sa = await ensureTestUser(db, { username: 'test_aicore_sa', role: 'super_admin', session_id: 'sess-aicore-sa' });
    saId = sa.id;
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-aicore-sa' });
    const u = await ensureTestUser(db, { username: 'test_aicore_hos', role: 'user_hos', session_id: 'sess-aicore-hos' });
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId: 1, hospcode: '11000', sessionId: 'sess-aicore-hos' });
});

afterEach(() => { global.fetch = realFetch; });

afterAll(async () => {
    await db.query("DELETE FROM system_settings WHERE setting_key LIKE 'ai\\_%'");
    for (const r of savedSettings) await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
    await db.query('DELETE FROM ai_usage_logs WHERE user_id = ?', [saId]);
    await cleanupTestUsers(db);
});

describe('ตั้งค่าผู้ช่วย AI', () => {
    test('ยังไม่ตั้งค่า = ปิดอยู่ (ทุก role เห็นสถานะ)', async () => {
        const res = await as(request(app).get(api('/ai/status')), userToken);
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);
    });

    test('ผู้ใช้ทั่วไปอ่าน/แก้การตั้งค่าและทดสอบไม่ได้', async () => {
        expect((await as(request(app).get(api('/ai/settings')), userToken)).status).toBe(403);
        expect((await putSettings({}, userToken)).status).toBe(403);
        expect((await as(request(app).post(api('/ai/test')), userToken)).status).toBe(403);
    });

    test('ข้อมูลไม่ถูกต้อง = 400', async () => {
        expect((await putSettings({ provider: 'other' })).status).toBe(400);
        expect((await putSettings({ base_url: 'ftp://x' })).status).toBe(400);
        expect((await putSettings({ model: '' })).status).toBe(400);
        expect((await putSettings({ daily_limit: 0 })).status).toBe(400);
        expect((await putSettings({ enabled: undefined })).status).toBe(400);
    });

    test('API key เข้ารหัสในฐานข้อมูล และไม่หลุดออกทาง GET /settings หรือ GET /ai/settings', async () => {
        const res = await putSettings({ api_key: KEY });
        expect(res.status).toBe(200);
        const [[row]] = await db.query("SELECT setting_value FROM system_settings WHERE setting_key = 'ai_api_key_enc'");
        expect(row.setting_value).toBeTruthy();
        expect(row.setting_value).not.toContain(KEY);

        const g = await as(request(app).get(api('/ai/settings')));
        expect(g.body.data).toMatchObject({ enabled: true, provider: 'openai', model: 'test-model', daily_limit: 50, has_api_key: true });
        expect(JSON.stringify(g.body)).not.toContain(KEY);

        const all = await as(request(app).get(api('/settings')), userToken);
        expect(all.status).toBe(200);
        expect(all.body.data.some(r => r.setting_key === 'ai_api_key_enc')).toBe(false);
        expect(JSON.stringify(all.body)).not.toContain(KEY);

        expect((await as(request(app).get(api('/ai/status')), userToken)).body.enabled).toBe(true);
    });

    test('ส่ง api_key ว่าง = คงค่าเดิม, clear_api_key = ลบ', async () => {
        await putSettings({ api_key: '' });
        expect((await as(request(app).get(api('/ai/settings')))).body.data.has_api_key).toBe(true);
        await putSettings({ clear_api_key: true });
        expect((await as(request(app).get(api('/ai/settings')))).body.data.has_api_key).toBe(false);
        await putSettings({ api_key: KEY });
    });
});

describe('ผู้ให้บริการแบบ OpenAI-compatible', () => {
    test('ทดสอบการเชื่อมต่อ: เรียก /chat/completions พร้อม key และรุ่นที่ตั้งไว้ + บันทึก ai_usage_logs', async () => {
        global.fetch = okFetch();
        const res = await as(request(app).post(api('/ai/test')));
        expect(res.status).toBe(200);
        expect(res.body.text).toBe('ผู้ช่วย AI พร้อมใช้งาน');
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('http://ai.test.local/v1/chat/completions');
        expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
        const body = JSON.parse(init.body);
        expect(body.model).toBe('test-model');
        expect(body.messages[0].role).toBe('system');
        const [[log]] = await db.query("SELECT * FROM ai_usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1", [saId]);
        expect(log).toMatchObject({ feature: 'test', provider: 'openai', ok: 1, input_tokens: 12, output_tokens: 7 });
    });

    test('ผู้ให้บริการตอบ 401 → ส่งกลับ 502 (ไม่ใช่ 401) พร้อมข้อความไทย และบันทึกว่าล้มเหลว', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'bad key' }) }));
        const res = await as(request(app).post(api('/ai/test')));
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('AI_AUTH');
        const [[log]] = await db.query("SELECT ok, error_msg FROM ai_usage_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1", [saId]);
        expect(log.ok).toBe(0);
    });

    test('ไม่มี key (เช่น Ollama ในเครื่อง) = ไม่ส่ง Authorization', async () => {
        await putSettings({ clear_api_key: true, base_url: 'http://127.0.0.1:11434/v1/' });
        global.fetch = okFetch();
        await as(request(app).post(api('/ai/test')));
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
        expect(init.headers.Authorization).toBeUndefined();
        await putSettings({ api_key: KEY });
    });
});

describe('ผู้ให้บริการ Claude (SDK)', () => {
    beforeAll(async () => { await putSettings({ provider: 'anthropic', base_url: '', model: 'claude-opus-5-5' }); });
    afterAll(async () => { await putSettings({}); });

    test('ส่งรุ่น/คำสั่งระบบ/effort และเปิด fallback ของรุ่นที่รองรับ', async () => {
        mockAnthropic.calls = [];
        mockAnthropic.next = () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'พร้อมใช้งาน' }], usage: { input_tokens: 20, output_tokens: 4 } });
        const res = await as(request(app).post(api('/ai/test')));
        expect(res.status).toBe(200);
        expect(res.body.text).toBe('พร้อมใช้งาน');
        const { opts, body } = mockAnthropic.calls[0];
        expect(opts.apiKey).toBe(KEY);
        expect(body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low' }, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
        expect(typeof body.system).toBe('string');
        expect(body.temperature).toBeUndefined();
    });

    test('รุ่นเก่าที่ไม่รองรับ effort/fallback ไม่ส่งพารามิเตอร์เหล่านั้น', async () => {
        await putSettings({ provider: 'anthropic', base_url: '', model: 'claude-haiku-4-5' });
        mockAnthropic.calls = [];
        await as(request(app).post(api('/ai/test')));
        const { body } = mockAnthropic.calls[0];
        expect(body.output_config).toBeUndefined();
        expect(body.fallbacks).toBeUndefined();
        await putSettings({ provider: 'anthropic', base_url: '', model: 'claude-opus-5-5' });
    });

    test('AI ปฏิเสธคำขอ (stop_reason refusal) = 422', async () => {
        mockAnthropic.next = () => ({ model: 'claude-opus-5-5', stop_reason: 'refusal', content: [], usage: {} });
        const res = await as(request(app).post(api('/ai/test')));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('AI_REFUSAL');
    });

    test('key ไม่ถูกต้อง (AuthenticationError) = 502', async () => {
        const Anthropic = require('@anthropic-ai/sdk');
        mockAnthropic.next = () => { throw new Anthropic.AuthenticationError(401, 'invalid x-api-key'); };
        const res = await as(request(app).post(api('/ai/test')));
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('AI_AUTH');
    });
});

describe('ปิดใช้งาน / โควตารายวัน (ผ่านฟีเจอร์สรุปรายงาน)', () => {
    test('ปิดอยู่ = 503 AI_DISABLED (ไม่เรียกผู้ให้บริการ)', async () => {
        await putSettings({ enabled: false });
        global.fetch = okFetch();
        const res = await as(request(app).post(api('/report/ai-summary'))).send({ year_bh: '2569' });
        // ไม่มีข้อมูลผลงานในปีนี้อาจได้ 400 ก่อน — ตรวจที่ callLlm โดยตรงแทน
        const { callLlm } = require('../services/ai');
        await expect(callLlm({ feature: 'report_summary', userId: saId, system: 's', prompt: 'p' })).rejects.toMatchObject({ status: 503, code: 'AI_DISABLED' });
        expect(global.fetch).not.toHaveBeenCalled();
        expect([400, 503]).toContain(res.status);
    });

    test('ใช้ครบโควตาวันนี้ = 429 AI_QUOTA (การทดสอบโดยผู้ดูแลไม่นับโควตา)', async () => {
        await putSettings({ enabled: true, daily_limit: 1 });
        await db.query("INSERT INTO ai_usage_logs (user_id, feature, provider, model) VALUES (?, 'report_summary', 'openai', 'test-model')", [saId]);
        global.fetch = okFetch();
        const { callLlm } = require('../services/ai');
        await expect(callLlm({ feature: 'report_summary', userId: saId, system: 's', prompt: 'p' })).rejects.toMatchObject({ status: 429, code: 'AI_QUOTA' });
        expect((await as(request(app).post(api('/ai/test')))).status).toBe(200);
        await putSettings({ daily_limit: 50 });
    });
});

describe('รายชื่อรุ่นโมเดลจากผู้ให้บริการ (POST /ai/models)', () => {
    // บัญชีแยก: aiLimiter จำกัด 10 ครั้ง/นาที/ผู้ใช้ — บัญชีหลักใช้ไปกับการทดสอบด้านบนแล้ว
    let sa2Token;
    beforeAll(async () => {
        const sa2 = await ensureTestUser(db, { username: 'test_aicore_sa2', role: 'super_admin', session_id: 'sess-aicore-sa2' });
        sa2Token = makeToken({ userId: sa2.id, username: sa2.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-aicore-sa2' });
    });
    const models = (body, t) => as(request(app).post(api('/ai/models')), t || sa2Token).send(body);

    test('ผู้ใช้ทั่วไปเรียกไม่ได้', async () => {
        expect((await models({ provider: 'openai', base_url: 'http://x.local/v1' }, userToken)).status).toBe(403);
    });

    test('OpenAI-compatible: ดึงครบทุกรุ่นจาก GET /models, ตัด prefix models/, ซ่อนรุ่นที่ไม่ใช่โมเดลสนทนา, ทำเครื่องหมายรุ่นฟรี', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [
            { id: 'models/gemini-x-pro' }, { id: 'zeta-chat:free' }, { id: 'alpha-chat', pricing: { prompt: '0.000001', completion: '0.000002' } },
            { id: 'text-embedding-9' }, { id: 'whisper-large' }, { id: 'alpha-chat' },
        ] }) }));
        const res = await models({ provider: 'openai', base_url: 'http://models.test.local/v1/', refresh: true });
        expect(res.status).toBe(200);
        expect(global.fetch.mock.calls[0][0]).toBe('http://models.test.local/v1/models');
        expect(res.body.models.map(m => m.id)).toEqual(['alpha-chat', 'gemini-x-pro', 'zeta-chat:free']);
        expect(res.body.models.find(m => m.id === 'zeta-chat:free').free).toBe(true);
        expect(res.body.models.find(m => m.id === 'alpha-chat').free).toBeUndefined();
        expect(res.body.hidden).toBe(2);
        expect(res.body.cached).toBe(false);
    });

    test('ผลถูกเก็บไว้ — เรียกซ้ำไม่ดึงจากผู้ให้บริการ, refresh = ดึงใหม่ (เห็นรุ่นใหม่ที่ผู้ให้บริการเพิ่ม)', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'alpha-chat' }, { id: 'brand-new-model' }] }) }));
        const again = await models({ provider: 'openai', base_url: 'http://models.test.local/v1' });
        expect(again.body.cached).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
        const fresh = await models({ provider: 'openai', base_url: 'http://models.test.local/v1', refresh: true });
        expect(fresh.body.models.map(m => m.id)).toContain('brand-new-model');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const all = await as(request(app).get(api('/settings')), userToken);
        expect(all.body.data.some(r => r.setting_key === 'ai_models_cache')).toBe(false);
    });

    test('ใช้ key ที่บันทึกไว้เฉพาะผู้ให้บริการ/Base URL เดียวกัน (ไม่ส่ง key ไปผู้ให้บริการอื่น)', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
        await models({ provider: 'openai', base_url: 'http://ai.test.local/v1', refresh: true });
        expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${KEY}`);
        global.fetch.mockClear();
        await models({ provider: 'openai', base_url: 'http://other.test.local/v1', refresh: true });
        expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
        global.fetch.mockClear();
        await models({ provider: 'openai', base_url: 'http://other.test.local/v1', api_key: 'sk-typed', refresh: true });
        expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-typed');
    });

    test('ผู้ให้บริการตอบ 401 = 502 (ไม่ใช่ 401)', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
        const res = await models({ provider: 'openai', base_url: 'http://bad.test.local/v1', refresh: true });
        expect(res.status).toBe(502);
    });

    test('Claude: ใช้ Models API ของ SDK — ใหม่ → เก่า, ระบุรุ่นที่เลิกใช้แล้ว', async () => {
        mockAnthropic.models = [
            { id: 'claude-old-1', display_name: 'Claude Old', created_at: '2025-01-01T00:00:00Z', deprecated_at: '2026-01-01T00:00:00Z' },
            { id: 'claude-new-9', display_name: 'Claude New', created_at: '2026-10-01T00:00:00Z', deprecated_at: null },
        ];
        const res = await models({ provider: 'anthropic', api_key: 'sk-ant-typed', refresh: true });
        expect(res.status).toBe(200);
        expect(res.body.models.map(m => m.id)).toEqual(['claude-new-9', 'claude-old-1']);
        expect(res.body.models[1]).toMatchObject({ name: 'Claude Old', deprecated: true });
        expect(mockAnthropic.listCalls).toBe(1);
    });
});

describe('extractJson', () => {
    const { extractJson } = require('../services/ai');
    test('อ่าน JSON ที่ห่อด้วย ``` หรือมีข้อความนำหน้า', () => {
        expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(extractJson('ผลลัพธ์: [{"x":"ก"}] จบ')).toEqual([{ x: 'ก' }]);
        expect(extractJson('ไม่มี JSON')).toBeNull();
        expect(extractJson('{เสีย')).toBeNull();
    });
});
