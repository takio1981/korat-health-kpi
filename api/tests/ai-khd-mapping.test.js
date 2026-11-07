/**
 * ผู้ช่วย AI ระยะที่ 3 — POST /ai/khd-mapping-suggest (7 พ.ย. 2569) — KHD จำลอง + โมเดลจำลอง (ไม่เชื่อมต่อ KHD/ผู้ให้บริการจริง)
 *   - เสนอเฉพาะค่าที่ยังจับคู่ไม่ได้ (หรือค่าที่ระบุ) — id ที่ AI ตอบต้องอยู่ในรายการของระบบ ไม่อยู่ = ตัดทิ้ง
 *   - ไม่บันทึกการจับคู่เอง (khd_value_mappings ไม่เปลี่ยน) — ผู้ดูแลกด "จับคู่" ผ่าน PUT /khd-mappings เดิม
 *   - super_admin เท่านั้น (เหมือน /khd-mappings), kind ผิด = 400 โดยไม่เรียกโมเดล, ไม่มีค่าที่ต้องจับคู่ = ไม่เรียกโมเดล
 */
const mockReports = [
    { dept: 'TKAI1', main_yut: 'test_aikhd ยุทธศาสตร์ ก (12)', main_indicator: '', table_process: 'test_aikhd_tp1' },
    { dept: 'TKAIX', main_yut: 'test_aikhd ยุทธ์ชื่อแปลก', main_indicator: '', table_process: 'test_aikhd_tp2' },
    { dept: 'TKAIY', main_yut: 'test_aikhd ยุทธ์ชื่อแปลก', main_indicator: '', table_process: 'test_aikhd_tp3' },
];
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: async (sql) => {
            const s = sql.replace(/\s+/g, ' ');
            if (/FROM departments/.test(s)) return [[{ dept_code: 'TKAIX', dept_name: 'test_aikhd กลุ่มงานควบคุมโรคใน KHD' }]];
            const m = s.match(/SELECT (\w+) AS v, table_process FROM reports/);
            if (m) return [mockReports.filter(r => r[m[1]]).map(r => ({ v: r[m[1]], table_process: r.table_process }))];
            throw new Error('KHD จำลองไม่รองรับคำสั่ง: ' + s.slice(0, 120));
        },
    }),
}));
jest.mock('../services/ai', () => {
    const actual = jest.requireActual('../services/ai');
    return { ...actual, callLlm: jest.fn() };
});
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { callLlm } = require('../services/ai');
const { parseSuggestions } = require('../services/ai-khd');

let app, db, saToken, ssjToken;
const L = {};
const api = (p) => '/khupskpi/api' + p;
const reply = (obj) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj), model: 'mock-model', provider: 'openai', ms: 1 });
const suggest = (body, t = saToken) => request(app).post(api('/ai/khd-mapping-suggest')).set('Authorization', `Bearer ${t}`).send(body);
const mapCount = async () => (await db.query("SELECT COUNT(*) AS n FROM khd_value_mappings"))[0][0].n;

async function cleanup() {
    await db.query("DELETE FROM khd_value_mappings WHERE khd_value LIKE 'test\\_aikhd%' OR khd_value IN ('TKAI1','TKAIX','TKAIY')");
    await db.query("DELETE FROM main_yut WHERE yut_name LIKE 'test\\_aikhd%'");
    await db.query("DELETE FROM departments WHERE dept_name LIKE 'test\\_aikhd%'");
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    await cleanup();
    const mk = async (username, role, sid) => {
        const u = await ensureTestUser(db, { username, role, session_id: sid });
        return makeToken({ userId: u.id, username, role, deptId: null, hospcode: null, sessionId: sid });
    };
    saToken = await mk('test_aikhd_sa', 'super_admin', 'sess-aikhd-sa');
    ssjToken = await mk('test_aikhd_ssj', 'admin_ssj', 'sess-aikhd-ssj');
    const ins = async (sql) => (await db.query(sql))[0].insertId;
    L.d1 = await ins("INSERT INTO departments (dept_name, dept_code) VALUES ('test_aikhd กลุ่มงาน 1', 'tkai1')");
    L.d2 = await ins("INSERT INTO departments (dept_name, dept_code) VALUES ('test_aikhd กลุ่มงานควบคุมโรคติดต่อ', 'tkai2')");
    L.y1 = await ins("INSERT INTO main_yut (yut_name) VALUES ('test_aikhd ยุทธศาสตร์ ก')");
});
afterAll(async () => { await cleanup(); await cleanupTestUsers(db); });
beforeEach(() => callLlm.mockReset());

describe('POST /ai/khd-mapping-suggest', () => {
    test('เสนอเฉพาะค่าที่ยังจับคู่ไม่ได้ — prompt มีค่าใน KHD + ชื่อใน KHD + รายการของระบบ (ไม่ส่งค่าที่ตรงกันอัตโนมัติแล้ว)', async () => {
        callLlm.mockResolvedValueOnce(reply({ suggestions: [
            { i: 0, id: L.d2, confidence: 150, reason: 'ชื่อใน KHD ตรงกับกลุ่มงานควบคุมโรค' },
            { i: 1, id: null, confidence: 20, reason: 'ไม่พบรายการที่ตรง' },
        ] }));
        const before = await mapCount();
        const res = await suggest({ kind: 'dept' });
        expect(res.status).toBe(200);
        expect(callLlm).toHaveBeenCalledTimes(1);
        const { prompt, system, feature } = callLlm.mock.calls[0][0];
        expect(feature).toBe('khd_mapping');
        expect(system).toContain('ห้ามสร้าง id ใหม่');
        expect(prompt).toContain('0: TKAIX (ชื่อใน KHD: test_aikhd กลุ่มงานควบคุมโรคใน KHD)');
        expect(prompt).toContain('1: TKAIY');
        expect(prompt).not.toContain('TKAI1');                       // ตรงกันอัตโนมัติแล้ว (รหัส tkai1)
        expect(prompt).toContain(`${L.d2}: test_aikhd กลุ่มงานควบคุมโรคติดต่อ (tkai2)`);
        const by = Object.fromEntries(res.body.suggestions.map(s => [s.khd_value, s]));
        expect(by.TKAIX).toEqual(expect.objectContaining({ local_id: L.d2, local_name: 'test_aikhd กลุ่มงานควบคุมโรคติดต่อ', confidence: 100 }));
        expect(by.TKAIY).toEqual(expect.objectContaining({ local_id: null, confidence: 0 }));
        expect(res.body).toEqual(expect.objectContaining({ total: 2, truncated: false, calls: 1 }));
        expect(await mapCount()).toBe(before);                       // ไม่บันทึกการจับคู่เอง
    });

    test('🛡️ id ที่ไม่อยู่ในรายการของระบบ = ตัดทิ้ง (AI สร้างรายการเองไม่ได้)', async () => {
        callLlm.mockResolvedValueOnce(reply({ suggestions: [{ i: 0, id: 99999999, confidence: 95, reason: 'เดา' }] }));
        const res = await suggest({ kind: 'dept', khd_values: ['TKAIX'] });
        expect(res.status).toBe(200);
        expect(res.body.suggestions).toEqual([expect.objectContaining({ khd_value: 'TKAIX', local_id: null, confidence: 0 })]);
    });

    test('ระบุ khd_values = เสนอเฉพาะค่านั้น (รวมค่าที่จับคู่แล้วได้)', async () => {
        callLlm.mockResolvedValueOnce(reply('```json\n{"suggestions":[{"i":0,"id":' + L.y1 + ',"confidence":88,"reason":"ชื่อเดียวกันตัดจำนวนท้าย"}]}\n```'));
        const res = await suggest({ kind: 'yut', khd_values: ['test_aikhd ยุทธศาสตร์ ก (12)'] });
        expect(res.status).toBe(200);
        expect(callLlm.mock.calls[0][0].prompt).toContain('0: test_aikhd ยุทธศาสตร์ ก (12)');
        expect(res.body.suggestions[0]).toEqual(expect.objectContaining({ local_id: L.y1, confidence: 88 }));
    });

    test('ไม่มีค่าที่ต้องจับคู่ = ไม่เรียกโมเดล', async () => {
        const res = await suggest({ kind: 'dept', khd_values: ['ไม่มีค่านี้ใน KHD'] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({ suggestions: [], total: 0, calls: 0 }));
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('🛡️ super_admin เท่านั้น, kind ผิด = 400 โดยไม่เรียกโมเดล', async () => {
        expect((await suggest({ kind: 'dept' }, ssjToken)).status).toBe(403);
        expect((await suggest({ kind: 'bad' })).status).toBe(400);
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('คำตอบที่ไม่ใช่ JSON = ไม่มีข้อเสนอ (ไม่ล้ม)', async () => {
        callLlm.mockResolvedValueOnce(reply('ขออภัย ไม่สามารถจับคู่ได้'));
        const res = await suggest({ kind: 'dept', khd_values: ['TKAIX'] });
        expect(res.status).toBe(200);
        expect(res.body.suggestions[0]).toEqual(expect.objectContaining({ local_id: null, confidence: 0 }));
    });
});

describe('systemPrompt — กติกาที่พบจากการทดลองกับผู้ให้บริการจริง (7 พ.ย. 2569)', () => {
    test('ชื่อตรงกันทุกตัวอักษรต้องมาก่อนชื่อคล้าย — เดิม AI เลือก "…เป็นเลิศ (37)" ทั้งที่มี "…เป็นเลิศ (PP&P Excellence)" ตรงทุกตัวอักษร', () => {
        const { systemPrompt } = require('../services/ai-khd');
        expect(systemPrompt('yut')).toContain('ชื่อตรงกับค่าใน KHD ทุกตัวอักษร');
    });
});

describe('parseSuggestions — ตรวจคำตอบของ AI', () => {
    const opts = new Map([[5, { id: 5, name: 'ก' }], [7, { id: 7, name: 'ข' }]]);
    test('รับรูปแบบ array ตรง + id เป็นข้อความ + ตัดลำดับซ้ำ/เกินชุด + confidence ไม่ใช่ตัวเลข = 0', () => {
        const m = parseSuggestions(JSON.stringify([
            { i: 0, id: '5', confidence: 'สูง', reason: 'x' }, { i: 0, id: 7, confidence: 90 }, { i: 3, id: 7, confidence: 90 }, { i: 1, id: 7, confidence: -5 },
        ]), 2, opts);
        expect(m.get(0)).toEqual({ local_id: 5, local_name: 'ก', confidence: 0, reason: 'x' });
        expect(m.get(1)).toEqual(expect.objectContaining({ local_id: 7, confidence: 0 }));
        expect(m.has(3)).toBe(false);
        expect(m.size).toBe(2);
    });
});
