/**
 * แถบ "กราฟและสถิติ" = รายงานการบันทึกผลงาน เชิงปริมาณ + คุณภาพ (28 พ.ย. 2569 — ผู้ใช้สั่ง แทนกราฟผ่าน/ไม่ผ่านเกณฑ์)
 * ปริมาณ = คู่ที่บันทึกแล้ว ÷ คู่ที่ต้องกรอก | ครบถ้วน = เดือนที่ถึงกำหนดที่มีผลงาน | ทันเวลา = บันทึกไม่เกินวันกำหนดส่ง
 * ตรวจสอบ = อนุมัติ/รอตรวจ/ส่งกลับ | ผิดปกติ = ตัวตรวจคุณภาพข้อมูลแบบกฎ
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');
const { pairStats, computeRecordingStats, dueTimestamps } = require('../services/recording-stats');

// ---------- ฟังก์ชันล้วน ----------
const DUE = dueTimestamps('2570', 10);   // ต.ค. 2569 ส่งภายใน 10 พ.ย. 2569 → 20261110235959
const ctx = { through: 2, dueTs: DUE };  // ถึงกำหนดแล้ว ต.ค.–ธ.ค.
const cell = (m, f, st = 'Pending', lk = false, ts = 20261105100000) => ({ m, f, st, lk, ts });

describe('pairStats', () => {
    test('วันกำหนดส่ง = วันที่ 10 ของเดือนถัดไป (สิ้นวัน)', () => {
        expect(DUE[0]).toBe(20261110235959);   // ต.ค.
        expect(DUE[2]).toBe(20270110235959);   // ธ.ค. → 10 ม.ค.
        expect(DUE[11]).toBe(20271010235959);  // ก.ย. → 10 ต.ค.
    });
    test('ครบถ้วน/ทันเวลา/สถานะ: 3 เดือนที่ถึงกำหนด บันทึก ต.ค. (ทัน) + พ.ย. (ช้า อนุมัติแล้ว) ธ.ค. ว่าง + ม.ค. (ยังไม่ถึงกำหนด)', () => {
        const s = pairStats({ cells: [cell(0, true), cell(1, true, 'Approved', true, 20261215000000), cell(2, false), cell(3, true, 'Resubmit')], months: null, last: null }, ctx);
        expect(s.recorded).toBe(true);
        expect([s.due, s.dueFilled]).toEqual([3, 2]);
        expect([s.timed, s.onTime]).toEqual([2, 1]);       // ม.ค. ยังไม่ถึงกำหนด ไม่นับทันเวลา
        expect([s.cellsFilled, s.approved, s.pending, s.returned]).toEqual([3, 1, 1, 1]);
    });
    test('ผลงานจากข้อย่อย (kpi_summary) นับว่าบันทึก + ครบถ้วน แม้แถวหลักว่าง', () => {
        const s = pairStats({ cells: [cell(0, false)], months: { oct: '5', nov: '', dece: '7' }, last: '7' }, ctx);
        expect(s.recorded).toBe(true);
        expect([s.due, s.dueFilled]).toEqual([3, 2]);
        expect(s.cellsFilled).toBe(0);
    });
    test('ตัวชี้วัดรายไตรมาส: นับเฉพาะเดือนสุดท้ายของไตรมาส | ผลงานกรอกเอง: ไม่นับความครบถ้วน', () => {
        expect(pairStats({ quarter: true, cells: [cell(2, true)], months: null }, ctx)).toMatchObject({ due: 1, dueFilled: 1 });
        expect(pairStats({ manual: true, cells: [], months: null, last: '40' }, ctx)).toMatchObject({ recorded: true, due: 0 });
    });
    test('ยังไม่บันทึก = ไม่นับว่าบันทึก ทุกช่องที่ถึงกำหนดว่าง', () => {
        expect(pairStats({ cells: [cell(0, false), cell(1, false)], months: null }, ctx)).toMatchObject({ recorded: false, due: 3, dueFilled: 0, cellsFilled: 0 });
    });
});

describe('computeRecordingStats', () => {
    const base = { ind_name: 'ตัวชี้วัด', dept_name: 'กลุ่มงาน', itypes: [], months: null };
    const pairs = [
        { ...base, indicator_id: 1, hospcode: 'H1', dept_id: 1, dept_name: 'ก', distid: 'D1', distname: 'อ.1', zone: '1', hostype: '07', itypes: ['r9'], cells: [cell(0, true), cell(1, true)] },
        { ...base, indicator_id: 1, hospcode: 'H2', dept_id: 1, dept_name: 'ก', distid: 'D2', distname: 'อ.2', zone: '2', hostype: '18', itypes: ['r9'], cells: [cell(0, false)] },
        { ...base, indicator_id: 2, hospcode: 'H1', dept_id: 2, dept_name: 'ข', distid: 'D1', distname: 'อ.1', zone: '1', hostype: '07', cells: [cell(0, true, 'Pending', false, 20261201000000)], anomalies: 1 },
    ];
    const out = computeRecordingStats(pairs, ctx);
    test('ภาพรวม', () => {
        expect(out.overall).toMatchObject({ pairs: 3, recorded_pairs: 2, not_recorded_pairs: 1, hospital_count: 2, indicator_count: 2, due_cells: 9, filled_due_cells: 3, anomaly_cells: 1 });
        expect(out.overall.recording_pct).toBe(66.67);
        expect(out.overall.completeness_pct).toBe(33.33);
        expect(out.overall.timeliness_pct).toBe(66.67);    // 3 ช่อง ทัน 2 (ข้อ 2 บันทึก 1 ธ.ค. — เลย 10 พ.ย.)
    });
    test('แยกตามกลุ่มงาน/อำเภอ/ประเภทตัวชี้วัด/หน่วยบริการ เรียงร้อยละการบันทึกน้อย → มาก', () => {
        const d = Object.fromEntries(out.by_dept.map(r => [r.gname, r]));
        expect([d['ก'].pairs, d['ก'].recorded_pairs, d['ก'].recording_pct]).toEqual([2, 1, 50]);
        expect([d['ข'].recording_pct]).toEqual([100]);
        expect(out.by_dept[0].gname).toBe('ก');
        expect(out.by_district.find(r => r.gkey === 'D2').recording_pct).toBe(0);
        expect(out.by_itype.find(r => r.gkey === 'r9').pairs).toBe(2);
        expect(out.by_itype.find(r => r.gkey === 'none').pairs).toBe(1);
        expect(out.by_itype.find(r => r.gkey === 'moph').pairs).toBe(0);   // ครบทุกประเภท
        expect(out.by_hospital[0].hospcode).toBe('H2');
        expect(out.hospital_distribution.find(b => b.key === '0').count).toBe(1);
    });
    test('รายเดือน + แผนที่ความร้อนกลุ่มงาน × เดือน', () => {
        expect(out.months[0]).toMatchObject({ due_pairs: 3, filled_due_pairs: 2, completeness_pct: 66.67, is_due: true });
        expect(out.months[3]).toMatchObject({ is_due: false, due_pairs: 0, completeness_pct: null });
        const k = out.heatmap_dept.find(r => r.gname === 'ก');
        expect(k.months[0]).toMatchObject({ due: 2, filled: 1, pct: 50 });
    });
});

// ---------- เส้นทาง API ----------
const Y = '2471';
let app, db, token, userToken, userId, deptA, deptB, indA, indB, hs;
async function cleanup() {
    const [inds] = await db.query("SELECT id FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_rstat\\_%'");
    const ids = inds.map(r => r.id);
    if (ids.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [ids]);
    }
}

describe('GET /report/recording-stats', () => {
    beforeAll(async () => {
        let migrationsReady;
        ({ app, migrationsReady } = require('../server'));
        db = require('../db');
        await migrationsReady;
        await cleanupTestUsers(db, 'test\\_rstat\\_');
        await cleanup();
        const [ds] = await db.query('SELECT id FROM departments ORDER BY id LIMIT 2');
        [deptA, deptB] = ds.map(d => d.id);
        [hs] = await db.query('SELECT hoscode, distid, hostype FROM chospital WHERE distid IS NOT NULL ORDER BY hoscode LIMIT 2');
        const sa = await ensureTestUser(db, { username: 'test_rstat_sa', role: 'super_admin', session_id: 's-rstat' });
        userId = sa.id;
        token = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-rstat' });
        const u = await ensureTestUser(db, { username: 'test_rstat_ssj', role: 'user_ssj', dept_id: deptA, hospcode: hs[0].hoscode, session_id: 's-rstat2' });
        userToken = makeToken({ userId: u.id, username: u.username, role: 'user_ssj', deptId: deptA, hospcode: hs[0].hoscode, sessionId: 's-rstat2' });
        indA = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, r9) VALUES ('test_rstat_A', ?, 1, '', 1)", [deptA]))[0].insertId;
        indB = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process) VALUES ('test_rstat_B', ?, 1, '')", [deptB]))[0].insertId;
        const res = (ind, h, m, a, st = 'Pending', lk = 0) => db.query('INSERT INTO kpi_results (indicator_id, year_bh, month_bh, user_id, status, hospcode, target_value, actual_value, is_locked) VALUES (?, ?, ?, ?, ?, ?, \'10\', ?, ?)', [ind, Y, m, userId, st, h.hoscode, a, lk]);
        // A × h0: ต.ค. 5 (อนุมัติ), พ.ย. 6 | A × h1: ยังไม่บันทึก | B × h0: ต.ค. ข้อความ "รอ"
        await res(indA, hs[0], '10', '5', 'Approved', 1); await res(indA, hs[0], '11', '6');
        await res(indA, hs[1], '10', null);
        await res(indB, hs[0], '10', 'รอ');
    }, 60000);
    afterAll(async () => { await cleanup(); await cleanupTestUsers(db, 'test\\_rstat\\_'); });

    const get = (t, q = {}) => request(app).get('/khupskpi/api/report/recording-stats').set('Authorization', `Bearer ${t}`).query({ year_bh: Y, ...q });

    test('super_admin: คู่ที่ต้องกรอก/บันทึกแล้ว + สถานะตรวจสอบ + ตัวเลือกตัวกรอง (ปีงบที่ผ่านมาแล้ว = ทุกเดือนถึงกำหนด)', async () => {
        const r = await get(token, { dept_id: deptA });
        expect(r.status).toBe(200);
        expect(r.body.through).toBe(11);
        const a = r.body.by_indicator.find(x => x.gkey === indA);
        expect([a.pairs, a.recorded_pairs, a.recording_pct]).toEqual([2, 1, 50]);
        expect([a.filled_cells, a.approved_cells, a.pending_cells]).toEqual([2, 1, 1]);
        expect([a.due_cells, a.filled_due_cells]).toEqual([24, 2]);
        expect(r.body.by_indicator.find(x => x.gkey === indB)).toBeUndefined();   // ตัวกรองกลุ่มงาน
        expect(r.body.options.depts.map(d => Number(d.id))).toEqual(expect.arrayContaining([deptA, deptB]));
        expect(r.body.options.years).toContain(Y);
    });
    test('ตัวกรองประเภทตัวชี้วัด / หน่วยบริการ / อำเภอ', async () => {
        const it = await get(token, { itype: 'r9' });
        expect(it.body.by_indicator.map(x => x.gkey)).toContain(indA);
        expect(it.body.by_indicator.map(x => x.gkey)).not.toContain(indB);
        const none = await get(token, { itype: 'none' });
        expect(none.body.by_indicator.map(x => x.gkey)).toContain(indB);
        const hos = await get(token, { distid: hs[1].distid, dept_id: deptA });
        expect(hos.body.overall.pairs).toBe(hs.filter(h => h.distid === hs[1].distid).length);
        const ht = await get(token, { hostype: hs[0].hostype });
        expect(ht.body.by_hospital.every(h => hs.some(x => x.hoscode === h.hospcode && x.hostype === hs[0].hostype))).toBe(true);
    });
    test('ขอบเขต user_ssj = เฉพาะกลุ่มงานตัวเอง', async () => {
        const r = await get(userToken);
        expect(r.status).toBe(200);
        expect(r.body.by_indicator.map(x => x.gkey)).toContain(indA);
        expect(r.body.by_indicator.map(x => x.gkey)).not.toContain(indB);
    });
    test('ไม่มี token = 401', async () => {
        expect((await request(app).get('/khupskpi/api/report/recording-stats')).status).toBe(401);
    });
});
