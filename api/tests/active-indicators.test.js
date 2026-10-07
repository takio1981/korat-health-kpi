/**
 * Integration tests: แสดงเฉพาะตัวชี้วัดที่เปิดใช้งาน (kpi_indicators.is_active = 1) — รันบน database ทดสอบ
 *   - ทุกหน้าที่แสดงตัวชี้วัด/ผลงาน (dashboard, กราฟ, รายงาน, สถิติ, แจ้งเตือนรอตรวจ, kpi-setup, export) ไม่เห็นตัวที่ปิด
 *   - หน้าจัดการตัวชี้วัด (GET /indicators?include_inactive=1) และเครื่องมือจัดการข้อมูล (/kpi-results/manage) ยังเห็นทุกตัว
 *   - เปิดกลับ → เห็นข้อมูลเดิมทันที โดยไม่ต้อง "อัปเดต Summary" (กรองตอนอ่าน ไม่ใช่ตอนสร้าง kpi_summary)
 * Regression (7 ต.ค. 2569): ก่อนหน้านี้ตัวชี้วัดที่ปิดใช้งานยังแสดงในตารางบันทึกผลงาน กราฟ รายงาน และสถิติทุกหน้า
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

// ปีงบปัจจุบัน (ต.ค.-ธ.ค. = ปีงบถัดไป) — /notifications/pending-kpi นับเฉพาะปีงบปัจจุบัน
const now = new Date();
const YEAR = String(now.getFullYear() + 543 + (now.getMonth() >= 9 ? 1 : 0));

let app, db, saToken, userToken, userId, deptId, hospcode;
let activeId, inactiveId;
const createdIndicators = [];
const api = (p) => '/khupskpi/api' + p;

const asSa = (req) => req.set('Authorization', `Bearer ${saToken}`);
const asUser = (req) => req.set('Authorization', `Bearer ${userToken}`);
const ids = (rows) => (rows || []).map(r => Number(r.indicator_id ?? r.id));
const setActive = (id, v) => db.query('UPDATE kpi_indicators SET is_active = ? WHERE id = ?', [v, id]);

async function createIndicator(suffix) {
    const res = await asSa(request(app).post(api('/indicators'))).send({
        kpi_indicators_name: `test_active_${suffix}_${Date.now()}`, dept_id: deptId, is_active: 1,
        table_process: `test_act_${suffix}_${Date.now()}`
    });
    expect(res.status).toBe(200);
    createdIndicators.push(res.body.id);
    return res.body.id;
}

beforeAll(async () => {
    ({ app } = require('../server'));
    db = require('../db');
    await cleanupTestUsers(db);
    const [[d]] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 1');
    const [[h]] = await db.query('SELECT hoscode FROM chospital ORDER BY hoscode LIMIT 1');
    deptId = d.id; hospcode = h.hoscode;
    const sa = await ensureTestUser(db, { username: 'test_active_sa', role: 'super_admin', session_id: 'sess-a-sa' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 'sess-a-sa' });
    const user = await ensureTestUser(db, { username: 'test_active_hos', role: 'user_hos', dept_id: deptId, hospcode, session_id: 'sess-a-hos' });
    userId = user.id;
    userToken = makeToken({ userId: user.id, username: user.username, role: 'user_hos', deptId, hospcode, sessionId: 'sess-a-hos' });

    activeId = await createIndicator('on');
    inactiveId = await createIndicator('off');
    // บันทึกผลงาน (สถานะ Pending) ให้ทั้ง 2 ตัวขณะยังเปิดอยู่ แล้วสร้าง kpi_summary
    // ตัวที่เปิด = ผ่านเกณฑ์ (90 ≥ 80), ตัวที่ปิด = ไม่ผ่าน (50 < 80) → ร้อยละสำเร็จต่างกันแน่นอนเมื่อสลับเปิด/ปิด
    for (const [id, oct] of [[activeId, '90'], [inactiveId, '50']]) {
        const r = await asUser(request(app).post(api('/update-kpi')))
            .send({ updates: [{ indicator_id: id, year_bh: YEAR, hospcode, target_value: '80', oct }] });
        expect(r.status).toBe(200);
    }
    for (const [p, body] of [['/refresh-summary/batch', { indicator_ids: [activeId, inactiveId], year_bh: YEAR }], ['/refresh-summary/finalize', { year_bh: YEAR }]]) {
        expect((await asSa(request(app).post(api(p))).send(body)).status).toBe(200);
    }
    // ปิดใช้งานโดยตรง (ไม่ refresh summary) — ข้อมูลยังอยู่ใน kpi_results/kpi_summary ครบ
    await setActive(inactiveId, 0);
});

afterAll(async () => {
    if (createdIndicators.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [createdIndicators]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [createdIndicators]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [createdIndicators]);
    }
    await cleanupTestUsers(db);
});

describe('หน้าที่แสดงรายการตัวชี้วัด — ไม่เห็นตัวที่ปิดใช้งาน', () => {
    test.each([
        ['GET /indicators (dropdown ทั่วระบบ)', () => asUser(request(app).get(api('/indicators')))],
        ['GET /kpi-results (ตารางบันทึกผลงาน)', () => asUser(request(app).get(api(`/kpi-results?year=${YEAR}`)))],
        ['GET /kpi-summary (กราฟ)', () => asUser(request(app).get(api(`/kpi-summary?year=${YEAR}`)))],
        ['GET /report/by-indicator', () => asUser(request(app).get(api(`/report/by-indicator?year_bh=${YEAR}`)))],
        ['GET /report/recording-status', () => asUser(request(app).get(api(`/report/recording-status?year_bh=${YEAR}`)))],
        ['GET /exportable-indicators (Export)', () => asSa(request(app).get(api('/exportable-indicators')))],
    ])('%s', async (_name, call) => {
        const res = await call();
        expect(res.status).toBe(200);
        const list = ids(res.body.data);
        expect(list).toContain(activeId);
        expect(list).not.toContain(inactiveId);
    });

    test('GET /report/recording-missing/by-hospital (ตัวชี้วัดค้างบันทึก)', async () => {
        // endpoint นี้แสดงเฉพาะตัวที่ "ยังไม่บันทึกผลงาน" → ใช้ปีแยก (2500) ที่มีแค่เป้าหมาย ไม่กระทบตัวเลขในปีหลัก
        const Y = '2500';
        for (const id of [activeId, inactiveId]) {
            await db.query('INSERT INTO kpi_results (indicator_id, year_bh, hospcode, month_bh, target_value, status, user_id) VALUES (?,?,?,10,?,?,?)',
                [id, Y, hospcode, '80', 'Pending', userId]);
        }
        const res = await asUser(request(app).get(api(`/report/recording-missing/by-hospital/${hospcode}?year_bh=${Y}`)));
        expect(res.status).toBe(200);
        const list = ids(res.body.data);
        expect(list).toContain(activeId);
        expect(list).not.toContain(inactiveId);
    });

    test('POST /check-kpi-export ไม่ตรวจตัวที่ปิด (ตรงกับ performKpiExport)', async () => {
        const res = await asSa(request(app).post(api('/check-kpi-export'))).send({ year_bh: YEAR, indicator_ids: [activeId, inactiveId] });
        expect(res.status).toBe(200);
        const list = ids(res.body.details);
        expect(list).toContain(activeId);
        expect(list).not.toContain(inactiveId);
    });
});

describe('ตัวเลขสรุป/นับ — ไม่นับตัวที่ปิด และเปิดกลับแล้วนับทันที (ไม่ต้อง refresh summary)', () => {
    // อ่านค่าตัวเลขตอนปิด → เปิดกลับ → อ่านใหม่ ต้องเพิ่มขึ้นพอดี (ตัวที่ปิดมีข้อมูล 1 หน่วยบริการ × 1 ตัวชี้วัด)
    const metrics = {
        'kpi-setup-check totalExisting': async () => (await asSa(request(app).get(api(`/kpi-setup-check?hospcode=${hospcode}&year_bh=${YEAR}`)))).body.data.totalExisting,
        'dashboard-stats pendingCount': async () => {
            return Number((await asUser(request(app).get(api(`/dashboard-stats?year=${YEAR}`)))).body.data.pendingCount);
        },
        'notifications/pending-kpi indicatorCount': async () => Number((await asSa(request(app).get(api('/notifications/pending-kpi')))).body.data.indicatorCount),
        'report/by-hospital indicator_count': async () => {
            const rows = (await asUser(request(app).get(api(`/report/by-hospital?year_bh=${YEAR}`)))).body.data;
            return Number(rows.find(r => r.hospcode === hospcode)?.indicator_count || 0);
        },
        'report/by-district indicator_count': async () => Number((await asUser(request(app).get(api(`/report/by-district?year_bh=${YEAR}`)))).body.data[0]?.indicator_count || 0),
        'report/by-year indicator_count': async () => Number((await asUser(request(app).get(api('/report/by-year')))).body.data.find(r => String(r.year_bh) === YEAR)?.indicator_count || 0),
        'recording-status/by-hospital total_indicators': async () => {
            const rows = (await asUser(request(app).get(api(`/report/recording-status/by-hospital?year_bh=${YEAR}`)))).body.data;
            return Number(rows.find(r => r.hospcode === hospcode)?.total_indicators || 0);
        },
    };

    test('ทุกตัวเลขเพิ่มขึ้น 1 เมื่อเปิดตัวชี้วัดกลับ', async () => {
        const off = {};
        for (const [k, fn] of Object.entries(metrics)) off[k] = await fn();
        await setActive(inactiveId, 1);
        try {
            const diff = {};
            for (const [k, fn] of Object.entries(metrics)) diff[k] = (await fn()) - off[k];
            expect(diff).toEqual(Object.fromEntries(Object.keys(metrics).map(k => [k, 1])));
            // และกลับมาอยู่ในรายการทันที
            const list = ids((await asUser(request(app).get(api(`/kpi-results?year=${YEAR}`)))).body.data);
            expect(list).toContain(inactiveId);
        } finally {
            await setActive(inactiveId, 0);
        }
    });

    test('dashboard-stats ร้อยละสำเร็จไม่นับตัวที่ปิด', async () => {
        // user_hos เห็นเฉพาะหน่วยบริการ+หน่วยงานตัวเอง → ตัวที่ปิดเป็นตัวเดียวที่ไม่ผ่านในขอบเขตนี้ (test DB)
        const rate = async () => Number((await asUser(request(app).get(api(`/dashboard-stats?year=${YEAR}`)))).body.data.successRate);
        const off = await rate();
        await setActive(inactiveId, 1);
        try { expect(await rate()).toBeLessThan(off); } finally { await setActive(inactiveId, 0); }
    });
});

describe('ข้อยกเว้น — ยังเห็นทุกตัว', () => {
    test('หน้าจัดการตัวชี้วัด: GET /indicators?include_inactive=1 (super_admin)', async () => {
        const res = await asSa(request(app).get(api('/indicators?include_inactive=1')));
        expect(res.status).toBe(200);
        expect(ids(res.body.data)).toEqual(expect.arrayContaining([activeId, inactiveId]));
    });

    test('role ที่เข้าหน้าจัดการตัวชี้วัดไม่ได้ ส่ง include_inactive มาก็ไม่เห็นตัวที่ปิด', async () => {
        const res = await asUser(request(app).get(api('/indicators?include_inactive=1')));
        expect(res.status).toBe(200);
        expect(ids(res.body.data)).not.toContain(inactiveId);
    });

    test('จัดการข้อมูลผลงาน: GET /kpi-results/manage', async () => {
        const res = await asSa(request(app).get(api(`/kpi-results/manage?year_bh=${YEAR}&indicator_id=${inactiveId}`)));
        expect(res.status).toBe(200);
        expect(ids(res.body.data)).toContain(inactiveId);
    });
});
