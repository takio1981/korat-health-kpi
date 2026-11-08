/**
 * ผู้ช่วย AI ระยะที่ 4 — ผู้ช่วยตอบคำถามจากคู่มือ POST /ai/help-ask (8 พ.ย. 2569) — โมเดลจำลอง (callLlm mock) ไม่เรียกผู้ให้บริการจริง
 *   - ฐานความรู้ data/help-kb.json ต้องตรงกับ help.html/help.ts ปัจจุบัน (ลืมสร้างใหม่หลังแก้คู่มือ = ล้ม)
 *   - ค้นเฉพาะหัวข้อที่ role ของผู้ถามเห็นในหน้าคู่มือ (เช่น ผู้ใช้ทั่วไปไม่ได้เนื้อหาสำรอง/กู้คืนฐานข้อมูลของ super_admin)
 *   - ไม่พบเนื้อหาที่เกี่ยวข้อง = ตอบว่าไม่พบโดยไม่เรียก AI | แหล่งอ้างอิงที่ AI ระบุนอกช่วง = ตัดทิ้ง | ปิดผู้ช่วย AI = 503
 *   - ปิดตัวเลขยาว/อีเมลในคำถามก่อนส่งออก
 */
jest.mock('../services/ai', () => {
    const actual = jest.requireActual('../services/ai');
    return { ...actual, callLlm: jest.fn(), getAiSettings: jest.fn() };
});
require('./setup');
const fs = require('fs');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { callLlm, getAiSettings } = require('../services/ai');
const { buildHelpKb, serialize, evalCondition, parseSections, OUT } = require('../scripts/build-help-kb');
const help = require('../services/ai-help');

let app, db, saToken, hosToken, ssjToken, hos2Token; // hos2 = บัญชีแยก (aiLimiter 10 ครั้ง/นาที/ผู้ใช้ — hosToken ใช้ครบในชุดก่อนหน้า)
const api = (p) => '/khupskpi/api' + p;
const reply = (obj) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj), model: 'mock-model', provider: 'openai', ms: 1 });
const ask = (question, t = hosToken) => request(app).post(api('/ai/help-ask')).set('Authorization', `Bearer ${t}`).send({ question });

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
    saToken = await mk('test_aihelp_sa', 'super_admin', 'sess-aihelp-sa');
    ssjToken = await mk('test_aihelp_ssj', 'admin_ssj', 'sess-aihelp-ssj');
    hosToken = await mk('test_aihelp_hos', 'user_hos', 'sess-aihelp-hos');
    hos2Token = await mk('test_aihelp_hos2', 'user_hos', 'sess-aihelp-hos2');
});
afterAll(async () => { await cleanupTestUsers(db); });
beforeEach(() => {
    callLlm.mockReset();
    getAiSettings.mockReset();
    getAiSettings.mockResolvedValue({ enabled: true });
    help._cache.clear();
});

describe('ฐานความรู้ (scripts/build-help-kb.js → data/help-kb.json)', () => {
    test('ไฟล์ตรงกับคู่มือปัจจุบัน — แก้ help.html/help.ts แล้วต้องรัน `node scripts/build-help-kb.js`', () => {
        expect(fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n')).toBe(serialize(buildHelpKb()));
    });

    test('ทุกชิ้นมีหัวข้อที่กดไปได้ และสิทธิ์ตรงกับหน้าคู่มือ', () => {
        const kb = buildHelpKb();
        expect(kb.chunks.length).toBeGreaterThan(50);
        for (const c of kb.chunks) {
            expect(c.anchor).toMatch(/^[a-z0-9-]+$/);
            expect(c.text.length).toBeGreaterThan(0);
            expect(c.audience.length).toBeGreaterThan(0);
        }
        const of = (anchor) => kb.chunks.filter(c => c.anchor === anchor);
        // หัวข้อ 16 สำรอง & กู้คืน = super_admin เท่านั้น
        expect(of('backup').every(c => c.audience.join() === 'super_admin')).toBe(true);
        // หัวข้อ 9 จัดการตัวชี้วัด = super_admin + admin_ssj (ADMIN_CENTRAL)
        expect(of('kpi-manage').every(c => c.audience.join() === 'super_admin,admin_ssj')).toBe(true);
        // หัวข้อ 4 บันทึกผลงาน = ทุกคน รวมผู้เปิดคู่มือแบบไม่เข้าสู่ระบบ
        expect(of('dashboard')[0].audience).toEqual(expect.arrayContaining(['user_hos', 'public']));
        // กล่องย่อยที่มีเงื่อนไขในหัวข้อที่ทุกคนเห็น (Tab "สถานะการบันทึก" = users || kpi-manager) ไม่หลุดให้ผู้ใช้ทั่วไป
        const monitor = kb.chunks.find(c => c.anchor === 'charts' && /สถานะการบันทึก/.test(c.heading || ''));
        expect(monitor).toBeTruthy();
        expect(monitor.audience).not.toContain('user_hos');
        expect(monitor.audience).toContain('admin_cup'); // ANY_ADMIN เห็นหัวข้อ users
    });

    test('<section> ระดับบนสุดที่ไม่มี id = ล้ม (ต้องมีจุดอ้างอิงคำตอบ)', () => {
        const ts = "static readonly SUPER_ONLY = ['super_admin'];\nsections = [ { id: 'a', icon: 'x', label: 'ก', roles: 'all' } ];";
        expect(() => buildHelpKb({ html: '<section id="section-a"><h2>ก</h2><p>ข้อความ</p></section><section><h2>ข</h2></section>', ts }))
            .toThrow(/ต้องมี id/);
    });

    test('เงื่อนไข *ngIf ที่ไม่รู้จัก = ล้ม (กันเนื้อหาที่จำกัดสิทธิ์หลุดไปทุก role)', () => {
        const sections = parseSections("sections = [ { id: 'a', icon: 'x', label: 'ก', roles: 'all' } ];");
        expect(evalCondition(sections, "canSeeSection('a')", 'user_hos')).toBe(true);
        expect(() => evalCondition(sections, "currentRole === 'super_admin'", 'user_hos')).toThrow(/ยังไม่รองรับ/);
    });
});

describe('การค้น (searchHelp)', () => {
    test('ตัดคำไทยได้ (Intl.Segmenter) + คู่คำติดกัน', () => {
        const t = help.tokenize('บันทึกผลงานตัวชี้วัด');
        expect(t).toEqual(expect.arrayContaining(['บันทึก', 'ตัว', 'ชี้|วัด']));
    });

    test('ลืมรหัสผ่าน → หัวข้อ "ลืมรหัสผ่าน?" อันดับ 1', () => {
        const hits = help.searchHelp('ลืมรหัสผ่านทำอย่างไร', 'user_hos');
        expect(hits[0]).toMatchObject({ anchor: 'login', heading: 'ลืมรหัสผ่าน?' });
    });

    test('ผู้ใช้ทั่วไปไม่ได้เนื้อหาของ super_admin (หัวข้อ 16 สำรอง & กู้คืน)', () => {
        expect(help.searchHelp('Backup Manager กู้คืน restore', 'super_admin').some(h => h.anchor === 'backup')).toBe(true);
        expect(help.searchHelp('Backup Manager กู้คืน restore', 'user_hos').some(h => h.anchor === 'backup')).toBe(false);
        // role ที่ไม่รู้จัก = เท่ากับผู้ไม่เข้าสู่ระบบ
        expect(help.audienceOf('weird')).toBe('public');
    });

    test('คำถามนอกเรื่อง = ไม่พบ', () => {
        expect(help.searchHelp('พิซซ่าหน้าอะไรอร่อย', 'user_hos')).toEqual([]);
        expect(help.searchHelp('ฟุตบอลคืนนี้', 'user_hos')).toEqual([]);
    });

    test('คำถามคำเดียวที่พบในหลายหัวข้อยังค้นได้ (KHD)', () => {
        expect(help.searchHelp('KHD', 'super_admin').length).toBeGreaterThan(0);
    });

    test('ปิดตัวเลขยาว/อีเมลในคำถาม', () => {
        expect(help.maskQuestion('เลขบัตร 1234567890123 โทร 081-234-5678 a.b@x.go.th')).toBe('เลขบัตร [ตัวเลข] โทร [ตัวเลข] [อีเมล]');
        expect(help.maskQuestion('ปีงบ 2570 เดือน 10')).toBe('ปีงบ 2570 เดือน 10');
    });
});

describe('POST /ai/help-ask', () => {
    test('ตอบจากคู่มือ + แหล่งอ้างอิง (เลขนอกช่วงถูกตัดทิ้ง) + หัวข้อที่เกี่ยวข้อง', async () => {
        callLlm.mockResolvedValueOnce(reply({ found: true, answer: '1. กด "ลืมรหัสผ่าน?" ที่หน้าเข้าสู่ระบบ', sources: [1, 1, 99] }));
        const res = await ask('ลืมรหัสผ่านทำอย่างไร');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ found: true, answer: '1. กด "ลืมรหัสผ่าน?" ที่หน้าเข้าสู่ระบบ', cached: false });
        expect(res.body.sources).toEqual([{ anchor: 'login', section: '3. การเข้าสู่ระบบ', heading: 'ลืมรหัสผ่าน?' }]);
        expect(res.body.related.length).toBeGreaterThan(0);
        const call = callLlm.mock.calls[0][0];
        expect(call.feature).toBe('help_ask');
        expect(call.prompt).toContain('ผู้ใช้ระดับโรงพยาบาล');
        // เลขข้อของคู่มือถูกตัดออกใน prompt (กัน AI เรียกเมนูว่า "เมนู 3. …") แต่แหล่งอ้างอิงที่คืนยังเป็นชื่อหัวข้อเต็ม
        expect(call.prompt).toContain('[1] หัวข้อ: การเข้าสู่ระบบ › ลืมรหัสผ่าน?');
        expect(call.prompt).not.toContain('หัวข้อ: 3. ');
        expect(call.system).toContain('ใช้เนื้อหาคู่มือที่ให้มาเท่านั้น');
        expect(call.prompt).not.toMatch(/test_aihelp|11000/); // ไม่มีชื่อผู้ใช้/รหัสหน่วยบริการ
    });

    test('ผู้ใช้ทั่วไปถามเรื่องของ super_admin → prompt ไม่มีเนื้อหาหัวข้อนั้น', async () => {
        callLlm.mockResolvedValue(reply({ found: false, answer: 'ไม่พบในคู่มือ', sources: [] }));
        await ask('ตั้งค่า Google Drive สำหรับ Backup Manager');
        const prompts = callLlm.mock.calls.map(c => c[0].prompt).join('\n');
        expect(prompts).not.toContain('16. สำรอง');
        await ask('ตั้งค่า Google Drive สำหรับ Backup Manager', saToken);
        expect(callLlm.mock.calls[callLlm.mock.calls.length - 1][0].prompt).toContain('16. สำรอง');
    });

    test('ไม่พบเนื้อหาที่เกี่ยวข้อง = ตอบว่าไม่พบ ไม่เรียก AI', async () => {
        const res = await ask('พิซซ่าหน้าอะไรอร่อย');
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ found: false, answer: help.NOT_FOUND, sources: [], related: [] });
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('คำถามเดิมซ้ำ = ใช้คำตอบเดิม (แคช แยกตาม role)', async () => {
        callLlm.mockResolvedValue(reply({ found: true, answer: 'ตอบ', sources: [1] }));
        await ask('ลืมรหัสผ่านทำอย่างไร');
        const again = await ask('  ลืมรหัสผ่านทำอย่างไร ');
        expect(again.body.cached).toBe(true);
        expect(callLlm).toHaveBeenCalledTimes(1);
        await ask('ลืมรหัสผ่านทำอย่างไร', ssjToken);
        expect(callLlm).toHaveBeenCalledTimes(2);
    });

    test('ผู้ให้บริการไม่ตอบ JSON = ใช้ข้อความตรงๆ (ไม่มีแหล่งอ้างอิงจาก AI แต่ยังมีหัวข้อที่เกี่ยวข้อง)', async () => {
        callLlm.mockResolvedValueOnce(reply('กดปุ่มลืมรหัสผ่านที่หน้าเข้าสู่ระบบ'));
        const res = await ask('ลืมรหัสผ่าน');
        expect(res.body).toMatchObject({ found: true, answer: 'กดปุ่มลืมรหัสผ่านที่หน้าเข้าสู่ระบบ', sources: [] });
        expect(res.body.related[0].anchor).toBe('login');
    });

    test('AI ตอบว่าไม่พบแต่ส่งเลขอ้างอิงมา = ไม่แสดงแหล่งอ้างอิง (พบจริงกับ Gemini)', async () => {
        callLlm.mockResolvedValueOnce(reply({ found: false, answer: 'ไม่พบในคู่มือ', sources: [1, 2] }));
        const res = await ask('ลืมรหัสผ่านทำอย่างไร');
        expect(res.body).toMatchObject({ found: false, answer: 'ไม่พบในคู่มือ', sources: [] });
    });

    test('คำถามสั้น/ยาวเกิน = 400 ไม่เรียก AI', async () => {
        expect((await ask('ก', hos2Token)).status).toBe(400);
        expect((await ask('ก'.repeat(501), hos2Token)).status).toBe(400);
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('ปิดผู้ช่วย AI = 503 (รวมคำถามที่ไม่พบ ซึ่งไม่ได้เรียก AI)', async () => {
        getAiSettings.mockResolvedValue({ enabled: false });
        expect((await ask('ลืมรหัสผ่าน', hos2Token)).status).toBe(503);
        expect((await ask('พิซซ่าหน้าอะไรอร่อย', hos2Token)).status).toBe(503);
        expect(callLlm).not.toHaveBeenCalled();
    });

    test('ต้องเข้าสู่ระบบ', async () => {
        const res = await request(app).post(api('/ai/help-ask')).send({ question: 'ลืมรหัสผ่าน' });
        expect(res.status).toBe(401);
    });
});
