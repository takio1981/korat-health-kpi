/**
 * ผู้ช่วย AI ระยะที่ 2 — POST /ai/formula-suggest (7 พ.ย. 2569) — โมเดลจำลอง (callLlm mock) ไม่เรียกผู้ให้บริการจริง
 *   - คืนเฉพาะสูตรที่ผ่านตัวตรวจเดียวกับตอนบันทึกตัวชี้วัด (parseFormulaInput) — ผิดให้ AI แก้อีก 1 รอบ พร้อมข้อความข้อผิดพลาด
 *   - ค่าเพิ่มเติม (custom_vars) ที่ประกาศใช้ในสูตรได้ / ไม่ประกาศใช้ไม่ได้, result ใช้ได้เฉพาะสูตรร้อยละ
 *   - สิทธิ์: ต้องมีสิทธิ์เพิ่มหรือแก้ไขในหน้าจัดการตัวชี้วัด, คำอธิบายสั้น/ยาวเกิน = 400 โดยไม่เรียกโมเดล
 */
jest.mock('../services/ai', () => {
    const actual = jest.requireActual('../services/ai');
    return { ...actual, callLlm: jest.fn() };
});
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { callLlm } = require('../services/ai');

let app, db, saToken, sa2Token, ssjToken, hosToken;
const api = (p) => '/khupskpi/api' + p;
const reply = (obj) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj), model: 'mock-model', provider: 'openai', ms: 1 });
const suggest2 = (body) => suggest(body, sa2Token);
const suggest = (body, t = saToken) => request(app).post(api('/ai/formula-suggest')).set('Authorization', `Bearer ${t}`).send(body);

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    const mk = async (username, role, sid) => {
        const u = await ensureTestUser(db, { username, role, session_id: sid });
        return makeToken({ userId: u.id, username, role, deptId: 1, hospcode: '11000', sessionId: sid });
    };
    saToken = await mk('test_aiform_sa', 'super_admin', 'sess-aiform-sa');
    sa2Token = await mk('test_aiform_sa2', 'super_admin', 'sess-aiform-sa2');   // บัญชีแยก — aiLimiter 10 ครั้ง/นาที/ผู้ใช้
    ssjToken = await mk('test_aiform_ssj', 'admin_ssj', 'sess-aiform-ssj');
    hosToken = await mk('test_aiform_hos', 'user_hos', 'sess-aiform-hos');
});
afterAll(async () => { await cleanupTestUsers(db); });
beforeEach(() => callLlm.mockReset());

describe('systemPrompt — ข้อเท็จจริงของข้อมูลที่ AI ต้องรู้ (พบจากการทดลองกับผู้ให้บริการจริง 7 พ.ย. 2569)', () => {
    const { systemPrompt } = require('../services/ai-formula');
    test('บอกว่าค่ารายเดือนเป็นจำนวนของเดือนนั้น (รวมทั้งปี = SUM(ALL)) — เดิม AI ตอบ LAST(ALL) สำหรับ "ผู้ป่วยสะสมทั้งปี"', () => {
        expect(systemPrompt('result', [])).toContain('ยอดสะสม/รวมทั้งปี = SUM(ALL)');
    });
    test('สูตรร้อยละให้ใช้ result — เดิม AI คำนวณผลงานใหม่ด้วย SUM(ALL)', () => {
        expect(systemPrompt('pct', [])).toContain('ให้ใช้ result');
        expect(systemPrompt('result', [])).not.toContain('ให้ใช้ result');
    });
});

describe('POST /ai/formula-suggest', () => {
    test('คืนสูตรที่ผ่านตัวตรวจ + คำอธิบาย (ครั้งเดียว)', async () => {
        callLlm.mockResolvedValueOnce(reply('```json\n{"formula":"SUM(ALL)","explanation":"ผลรวมทุกเดือน"}\n```'));
        const res = await suggest({ description: 'นับรวมจำนวนผู้ป่วยทั้งปี', kind: 'result' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ formula: 'SUM(ALL)', explanation: 'ผลรวมทุกเดือน', attempts: 1 });
        expect(callLlm.mock.calls[0][0].feature).toBe('formula');
    });

    test('ค่าเพิ่มเติมที่ประกาศอยู่ใน prompt และใช้ในสูตรได้', async () => {
        callLlm.mockResolvedValueOnce(reply({ formula: 'SUM(ALL) / pop * 100000', explanation: 'อัตราต่อแสนประชากร' }));
        const res = await suggest({ description: 'อัตราป่วยต่อแสนประชากร', custom_vars: [{ key: 'pop', label: 'ประชากรกลางปี' }] });
        expect(res.status).toBe(200);
        expect(res.body.formula).toBe('SUM(ALL) / pop * 100000');
        expect(callLlm.mock.calls[0][0].system).toContain('pop = ประชากรกลางปี');
    });

    test('สูตรผิด → ส่งข้อผิดพลาดให้ AI แก้อีก 1 รอบ → ได้สูตรที่ถูก', async () => {
        callLlm
            .mockResolvedValueOnce(reply({ formula: 'SUM(ALL) / pop', explanation: 'x' }))       // pop ไม่ได้ประกาศ
            .mockResolvedValueOnce(reply({ formula: 'SUM(ALL) / base', explanation: 'ต่อค่าฐาน' }));
        const res = await suggest({ description: 'ผลรวมหารค่าฐานของหน่วยบริการ' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ formula: 'SUM(ALL) / base', attempts: 2 });
        expect(callLlm.mock.calls[1][0].prompt).toContain('SUM(ALL) / pop');
        expect(callLlm.mock.calls[1][0].prompt).toContain('ผิด');
    });

    test('ผิดทั้ง 2 รอบ = 422 ไม่คืนสูตรที่ใช้ไม่ได้', async () => {
        callLlm.mockResolvedValue(reply({ formula: 'IF(m10>0,1,0)', explanation: 'x' }));
        const res = await suggest({ description: 'ถ้ามีผลงานเดือนตุลาคมให้เป็น 1' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('AI_BAD_FORMULA');
        expect(res.body.formula).toBeUndefined();
        expect(callLlm).toHaveBeenCalledTimes(2);
    });

    test('result ใช้ได้เฉพาะสูตรร้อยละ', async () => {
        callLlm.mockResolvedValue(reply({ formula: 'result / target * 100', explanation: 'ร้อยละของเป้าหมาย' }));
        const pct = await suggest({ description: 'ผลงานเทียบเป้าหมายเป็นร้อยละ', kind: 'pct' });
        expect(pct.status).toBe(200);
        expect(callLlm.mock.calls[0][0].feature).toBe('formula_pct');
        callLlm.mockClear();
        const res = await suggest({ description: 'ผลงานเทียบเป้าหมายเป็นร้อยละ', kind: 'result' });
        expect(res.status).toBe(422);
    });

    test('AI บอกว่าเขียนไม่ได้ (formula ว่าง) = 422 พร้อมเหตุผล', async () => {
        callLlm.mockResolvedValueOnce(reply({ formula: '', explanation: 'ต้องใช้ข้อมูลรายบุคคล' }));
        const res = await suggest({ description: 'อายุเฉลี่ยของผู้ป่วยแต่ละคน' });
        expect(res.status).toBe(422);
        expect(res.body.message).toContain('ต้องใช้ข้อมูลรายบุคคล');
    });

    // สูตรร้อยละจากข้อมูลตัวชี้วัด (13 พ.ย. 2569): ไม่มีคำอธิบายได้เมื่อส่ง indicator — prompt มีเป้าหมาย/เกณฑ์/เงื่อนไข/วิธีคิดผลงาน
    test('ไม่มีคำอธิบาย + มีข้อมูลตัวชี้วัด → เสนอสูตรจากข้อมูล (prompt มีเป้าหมาย เกณฑ์ เงื่อนไข วิธีคิดผลงาน)', async () => {
        callLlm.mockResolvedValueOnce(reply({ formula: 'result / target * 100', explanation: 'ร้อยละของเป้าหมาย' }));
        const res = await suggest2({ description: '', kind: 'pct', indicator_name: 'ร้อยละผู้ป่วยเบาหวานควบคุมได้',
            indicator: { target_percentage: '40', criterion: '40', target_condition: 'GTE', result_formula: 'SUM(ALL) / pop * 100', is_cumulative: 0, quarter_mode: 'month_sum' },
            custom_vars: [{ key: 'pop', label: 'ประชากร' }] });
        expect(res.status).toBe(200);
        expect(res.body.formula).toBe('result / target * 100');
        const p = callLlm.mock.calls[0][0].prompt;
        expect(p).toContain('ผู้ใช้ไม่ได้อธิบายวิธีคำนวณ');
        expect(p).toContain('เป้าหมาย (ค่าตั้งต้นของหน่วยบริการ = target): 40');
        expect(p).toContain('เกณฑ์: ≥ 40');
        expect(p).toContain('คำนวณตามสูตรผลงาน: SUM(ALL) / pop * 100');
        expect(p).toContain('ผลรวม 3 เดือน');
        expect(callLlm.mock.calls[0][0].system).toContain('need_more');
    });

    test('AI ขอข้อมูลเพิ่ม (need_more) = 200 พร้อมคำถาม ไม่ใช่ข้อผิดพลาด', async () => {
        callLlm.mockResolvedValueOnce(reply({ formula: '', need_more: true, question: 'ต้องการเทียบกับอะไร?' }));
        const res = await suggest2({ kind: 'pct', indicator: { target_condition: 'LTE', is_cumulative: 1 } });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ need_more: true, question: 'ต้องการเทียบกับอะไร?' });
        expect(res.body.formula).toBeUndefined();
        expect(callLlm.mock.calls[0][0].prompt).toContain('ผลงานสะสม = SUM(ALL)');
        expect(callLlm.mock.calls[0][0].prompt).toContain('น้อยกว่าหรือเท่ากับเป้าหมาย');
    });

    test('ไม่มีคำอธิบายและไม่มีข้อมูลตัวชี้วัด = 400 โดยไม่เรียกโมเดล', async () => {
        const res = await suggest2({ description: '', kind: 'pct' });
        expect(res.status).toBe(400);
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('คำอธิบายสั้นเกิน = 400 โดยไม่เรียกโมเดล', async () => {
        const res = await suggest({ description: 'ab' });
        expect(res.status).toBe(400);
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('สิทธิ์: ไม่มีสิทธิ์เพิ่มหรือแก้ไขตัวชี้วัด = 403, มีสิทธิ์อย่างใดอย่างหนึ่ง = ใช้ได้', async () => {
        const { loadRoleActionAccessCache } = require('../core/access');
        const [saved] = await db.query("SELECT action, is_enabled FROM role_action_access WHERE role = 'admin_ssj' AND page_key = 'kpi-manage'");
        try {
            expect((await suggest({ description: 'ผลรวมทุกเดือน' }, hosToken)).status).toBe(403);
            await db.query("UPDATE role_action_access SET is_enabled = 0 WHERE role = 'admin_ssj' AND page_key = 'kpi-manage'");
            await loadRoleActionAccessCache();
            expect((await suggest({ description: 'ผลรวมทุกเดือน' }, ssjToken)).status).toBe(403);
            expect(callLlm).not.toHaveBeenCalled();
            await db.query("UPDATE role_action_access SET is_enabled = 1 WHERE role = 'admin_ssj' AND page_key = 'kpi-manage' AND action = 'edit'");
            await loadRoleActionAccessCache();
            callLlm.mockResolvedValueOnce(reply({ formula: 'SUM(ALL)', explanation: 'ผลรวม' }));
            expect((await suggest({ description: 'ผลรวมทุกเดือน' }, ssjToken)).status).toBe(200);
        } finally {
            for (const r of saved) await db.query("UPDATE role_action_access SET is_enabled = ? WHERE role = 'admin_ssj' AND page_key = 'kpi-manage' AND action = ?", [r.is_enabled, r.action]);
            await loadRoleActionAccessCache();
        }
    });
});
