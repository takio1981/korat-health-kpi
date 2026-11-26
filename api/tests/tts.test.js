/**
 * เสียงพูด Gemini TTS (26 พ.ย. 2569) — database ทดสอบ + บริการเสียงจำลอง (stub fetch — ไม่เรียก Google จริง)
 *   - lib/gemini-tts: รูปแบบคำขอ Interactions / generateContent, อ่านเสียงได้ทั้ง WAV และ PCM ล้วน, ตัดความเงียบ, ซองความดัง, ข้อผิดพลาด
 *   - คีย์: tts_api_key_enc ก่อน, ไม่มี = คีย์ผู้ช่วย AI เฉพาะเมื่อ base_url เป็น Google, GET /settings ไม่คืนคีย์
 *   - /tts/speak: ปิด/ไม่มีคีย์ = 503, ยาวเกิน = 400, แคช (ไม่เรียกซ้ำ), โควตารายวัน = 429, ไม่ส่งรหัสคีย์กลับ
 *   - /tts/settings + /tts/test เฉพาะ super_admin, ค่าผิด = 400
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const gtts = require('../lib/gemini-tts');

let app, db, saToken, userToken, saId, userId, saved = [];
const api = (p) => '/khupskpi/api' + p;
const as = (r, t = saToken) => r.set('Authorization', `Bearer ${t}`);
const realFetch = global.fetch;

// เสียงจำลอง: คลื่นไซน์ 0.5 วินาที + ความเงียบ 0.5 วินาทีหัว-ท้าย (24 kHz, 16-bit, mono)
function fakePcm(rate = 24000) {
    const n = rate * 1.5, buf = Buffer.alloc(n * 2);
    for (let i = rate / 2; i < rate; i++) buf.writeInt16LE(Math.round(Math.sin(i / 8) * 12000), i * 2);
    return buf;
}
const interactionsReply = (b64) => ({ steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'audio', data: b64 }] }] });
function ttsFetch(make = () => interactionsReply(gtts._internal.wavOf(fakePcm(), 24000).toString('base64'))) {
    return jest.fn(async (url, init) => ({ ok: true, status: 200, json: async () => make(url, init) }));
}
const keysLike = "setting_key LIKE 'tts\\_%' OR setting_key IN ('ai_base_url', 'ai_api_key_enc')";

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    [saved] = await db.query(`SELECT setting_key, setting_value FROM system_settings WHERE ${keysLike}`);
    await db.query(`DELETE FROM system_settings WHERE ${keysLike}`);
    const sa = await ensureTestUser(db, { username: 'test_tts_sa', role: 'super_admin', session_id: 'sess-tts-sa' });
    saId = sa.id;
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-tts-sa' });
    const u = await ensureTestUser(db, { username: 'test_tts_hos', role: 'user_hos', session_id: 'sess-tts-hos' });
    userId = u.id;
    userToken = makeToken({ userId: u.id, username: u.username, role: 'user_hos', deptId: 1, hospcode: '11000', sessionId: 'sess-tts-hos' });
});

beforeEach(async () => {
    await db.query(`DELETE FROM system_settings WHERE ${keysLike}`);
    await db.query("DELETE FROM ai_usage_logs WHERE feature = 'tts' AND user_id IN (?, ?)", [saId, userId]);
    require('../services/tts').invalidateTtsSettings();
    require('../services/tts')._clearAudioCache();
});
afterEach(() => { global.fetch = realFetch; });

afterAll(async () => {
    await db.query(`DELETE FROM system_settings WHERE ${keysLike}`);
    for (const r of saved) await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [r.setting_key, r.setting_value]);
    await db.query("DELETE FROM ai_usage_logs WHERE user_id IN (?, ?)", [saId, userId]);
    await cleanupTestUsers(db);
});

describe('lib/gemini-tts', () => {
    test('Interactions: รูปแบบคำขอ + คีย์อยู่ในหัวคำขอ ไม่อยู่ใน URL + ตัดความเงียบ + ซองความดัง', async () => {
        const f = ttsFetch();
        const r = await gtts.synthesize({ apiKey: 'AIza-test-key-0000000000', text: 'สวัสดีครับ', voice: 'Puck', style: 'สดใส', fetchImpl: f });
        const [url, init] = f.mock.calls[0];
        expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
        expect(url).not.toContain('AIza');
        expect(init.headers['x-goog-api-key']).toBe('AIza-test-key-0000000000');
        const body = JSON.parse(init.body);
        expect(body).toEqual({
            model: gtts.DEFAULT_MODEL,
            input: [{ type: 'user_input', content: [{ type: 'text', text: 'สวัสดีครับ', annotations: [{ type: 'speech_metadata', style: 'สดใส' }] }] }],
            response_format: { type: 'audio' },
            generation_config: { speech_config: [{ voice: 'Puck' }] },
        });
        expect(r.wav.toString('ascii', 0, 4)).toBe('RIFF');
        expect(r.ms).toBeGreaterThan(500);
        expect(r.ms).toBeLessThan(800);           // ความเงียบ 1 วินาทีถูกตัด เหลือ ~0.5 + 0.16
        expect(r.e).toMatch(/^[0-9]+$/);
        expect(Math.abs(r.e.length - r.ms / 40)).toBeLessThan(3);   // 25 ค่าต่อวินาที
        expect(r.e).toMatch(/[5-9]/);
    });

    test('รุ่น *-preview-tts ใช้ generateContent + PCM ล้วน (audio/L16) อ่านอัตราสุ่มจาก mime', async () => {
        const pcm = fakePcm(16000);
        const f = ttsFetch(() => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=16000', data: pcm.toString('base64') } }] } }] }));
        const r = await gtts.synthesize({ apiKey: 'k'.repeat(30), text: 'ทดสอบ', model: 'gemini-2.5-flash-preview-tts', fetchImpl: f });
        const [url, init] = f.mock.calls[0];
        expect(url).toContain('/models/gemini-2.5-flash-preview-tts:generateContent');
        expect(JSON.parse(init.body).generationConfig.responseModalities).toEqual(['AUDIO']);
        expect(r.sampleRate).toBe(16000);
        expect(r.wav.readUInt32LE(24)).toBe(16000);
    });

    test('ข้อผิดพลาด: 429 บอกเวลารอ, 403 = TTS_AUTH, ไม่มีเสียง = TTS_EMPTY_AUDIO, ไม่มีคีย์ = TTS_NO_KEY', async () => {
        const fail = (status, j) => jest.fn(async () => ({ ok: false, status, json: async () => j }));
        await expect(gtts.synthesize({ apiKey: 'k'.repeat(30), text: 'x', fetchImpl: fail(429, { error: { message: 'quota', details: [{ retryDelay: '7s' }] } }) }))
            .rejects.toMatchObject({ code: 'TTS_RATE_LIMIT', status: 429, retryMs: 7000 });
        await expect(gtts.synthesize({ apiKey: 'k'.repeat(30), text: 'x', fetchImpl: fail(403, {}) })).rejects.toMatchObject({ code: 'TTS_AUTH', status: 502 });
        await expect(gtts.synthesize({ apiKey: 'k'.repeat(30), text: 'x', fetchImpl: ttsFetch(() => ({ steps: [] })) })).rejects.toMatchObject({ code: 'TTS_EMPTY_AUDIO' });
        await expect(gtts.synthesize({ apiKey: '', text: 'x' })).rejects.toMatchObject({ code: 'TTS_NO_KEY' });
    });
});

describe('/tts/*', () => {
    test('ไม่มีคีย์ = status ปิด + speak 503 | คีย์ AI ที่ไม่ใช่ Google ไม่ถูกใช้', async () => {
        const { bkEncrypt } = require('../services/backup');
        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('ai_base_url', 'https://api.openai.com/v1'), ('ai_api_key_enc', ?)", [bkEncrypt('sk-openai-not-google-000000')]);
        expect((await as(request(app).get(api('/tts/status')), userToken)).body.enabled).toBe(false);
        const r = await as(request(app).post(api('/tts/speak')), userToken).send({ text: 'สวัสดี' });
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('TTS_NO_KEY');
    });

    test('ใช้คีย์ผู้ช่วย AI ของ Google ได้เมื่อไม่ได้ตั้งคีย์แยก + แคช + บันทึกการใช้ ไม่เก็บข้อความ', async () => {
        const { bkEncrypt } = require('../services/backup');
        await db.query("INSERT INTO system_settings (setting_key, setting_value) VALUES ('ai_base_url', 'https://generativelanguage.googleapis.com/v1beta/openai'), ('ai_api_key_enc', ?)", [bkEncrypt('AIza-google-ai-key-1234567')]);
        global.fetch = ttsFetch();
        expect((await as(request(app).get(api('/tts/status')), userToken)).body.enabled).toBe(true);
        const a = await as(request(app).post(api('/tts/speak')), userToken).send({ text: '  คำตอบจาก   AI  ' });
        expect(a.status).toBe(200);
        expect(a.body).toMatchObject({ success: true, mime: 'audio/wav' });
        expect(Buffer.from(a.body.audio, 'base64').toString('ascii', 0, 4)).toBe('RIFF');
        expect(global.fetch.mock.calls[0][1].headers['x-goog-api-key']).toBe('AIza-google-ai-key-1234567');
        const b = await as(request(app).post(api('/tts/speak')), userToken).send({ text: 'คำตอบจาก AI' });
        expect(b.body.cached).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [logs] = await db.query("SELECT * FROM ai_usage_logs WHERE feature = 'tts' AND user_id = ?", [userId]);
        expect(logs).toHaveLength(1);
        expect(JSON.stringify(logs)).not.toContain('คำตอบจาก');
    });

    test('ปิดใช้งาน = 503, ยาวเกิน = 400, โควตารายวัน = 429', async () => {
        global.fetch = ttsFetch();
        expect((await as(request(app).put(api('/tts/settings'))).send({ api_key: 'AIza-own-tts-key-123456789', daily_limit: 1, enabled: false })).status).toBe(200);
        expect((await as(request(app).post(api('/tts/speak')), userToken).send({ text: 'ก' })).status).toBe(503);
        await as(request(app).put(api('/tts/settings'))).send({ enabled: true });
        expect((await as(request(app).post(api('/tts/speak')), userToken).send({ text: 'ก'.repeat(601) })).status).toBe(400);
        expect((await as(request(app).post(api('/tts/speak')), userToken).send({ text: 'หนึ่ง' })).status).toBe(200);
        const q = await as(request(app).post(api('/tts/speak')), userToken).send({ text: 'สอง' });
        expect(q.status).toBe(429);
        expect(q.body.code).toBe('TTS_QUOTA');
    });

    test('ตั้งค่า: เฉพาะ super_admin, ไม่คืนคีย์, ค่าผิด = 400, GET /settings ตัดคีย์ออก, ทดสอบด้วยเสียงอื่นได้', async () => {
        expect((await as(request(app).get(api('/tts/settings')), userToken)).status).toBe(403);
        expect((await as(request(app).put(api('/tts/settings')), userToken).send({ voice: 'Puck' })).status).toBe(403);
        expect((await as(request(app).put(api('/tts/settings'))).send({ voice: 'NotAVoice' })).status).toBe(400);
        expect((await as(request(app).put(api('/tts/settings'))).send({ model: 'bad model!' })).status).toBe(400);
        expect((await as(request(app).put(api('/tts/settings'))).send({ enabled: 'yes' })).status).toBe(400);
        const p = await as(request(app).put(api('/tts/settings'))).send({ api_key: 'AIza-own-tts-key-123456789', voice: 'Achird', style: 'อบอุ่น' });
        expect(p.status).toBe(200);
        expect(JSON.stringify(p.body)).not.toContain('AIza-own');
        expect(p.body.data).toMatchObject({ voice: 'Achird', style: 'อบอุ่น', key_source: 'own', has_api_key: true });
        const all = await as(request(app).get(api('/settings')));
        expect(JSON.stringify(all.body)).not.toContain('tts_api_key_enc');
        global.fetch = ttsFetch();
        const t = await as(request(app).post(api('/tts/test'))).send({ voice: 'Puck', text: 'ลองเสียง' });
        expect(t.status).toBe(200);
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.generation_config.speech_config[0].voice).toBe('Puck');
        expect(body.input[0].content[0].annotations[0].style).toBe('อบอุ่น');
        expect((await as(request(app).post(api('/tts/test'))).send({ voice: 'Nope' })).status).toBe(400);
    });

    test('ข้อผิดพลาดสิทธิ์จากผู้ให้บริการไม่ส่งเป็น 401 (กันหน้าจอออกจากระบบ)', async () => {
        await as(request(app).put(api('/tts/settings'))).send({ api_key: 'AIza-own-tts-key-123456789' });
        global.fetch = jest.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'API key not valid' } }) }));
        const r = await as(request(app).post(api('/tts/speak')), userToken).send({ text: 'ก' });
        expect(r.status).toBe(502);
        expect(r.body.code).toBe('TTS_AUTH');
    });
});
