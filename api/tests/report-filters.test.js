/**
 * ตัวกรองหน้ารายงานสรุปผล ทุกแถบ × ทุกตัวกรอง (28 พ.ย. 2569 — ผู้ใช้แจ้ง: เลือกตัวกรองแล้วข้อมูลในตารางไม่เปลี่ยนตาม)
 * แถบ: รายข้อตัวชี้วัด / รายหน่วยบริการ / รายอำเภอ / รายปีงบประมาณ / สรุปตัวชี้วัดของกลุ่มงาน / สถานะการบันทึก (2 มุมมอง) / สรุปรายกลุ่มงาน
 * ตัวกรอง: ปีงบประมาณ กลุ่มงาน โซน อำเภอ ประเภทตัวชี้วัด ประเภทหน่วยบริการ (+ ผสมกัน)
 * วิธี: ชุดข้อมูลที่รู้คำตอบ (2 กลุ่มงานทดสอบ × 2 ตัวชี้วัด × 2 หน่วยบริการต่างอำเภอ/โซน/ประเภท × 2 ปีงบ)
 *       คำตอบที่คาดคำนวณจากรายการคู่ด้วยกติกาเดียวกับตัวกรอง แล้วเทียบกับผลของทุกเส้นทาง
 * ⚠️ เดิมไม่ผ่าน: รายอำเภอไม่ใช้ตัวกรองอำเภอ, สรุปรายกลุ่มงานไม่ใช้กลุ่มงาน/อำเภอ, หน้าเจาะลึกไม่ใช้อำเภอ
 */
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

const Y = '2491', Y2 = '2492';   // ปีงบที่ไม่มีข้อมูลอื่นในฐานทดสอบ
let app, db, token, userId;
let deptA, deptB, indA, indB, h1, h2;
let pairs = [];

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_rflt\\_');
    await cleanup();
    deptA = (await db.query("INSERT INTO departments (dept_code, dept_name, is_active) VALUES ('tfa', 'test_rflt_กลุ่มงานA', 1)"))[0].insertId;
    deptB = (await db.query("INSERT INTO departments (dept_code, dept_name, is_active) VALUES ('tfb', 'test_rflt_กลุ่มงานB', 1)"))[0].insertId;
    indA = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, target_condition, r9, moph) VALUES ('test_rflt_A', ?, 1, '', 'GTE', 1, 0)", [deptA]))[0].insertId;
    indB = (await db.query("INSERT INTO kpi_indicators (kpi_indicators_name, dept_id, is_active, table_process, target_condition, r9, moph) VALUES ('test_rflt_B', ?, 1, '', 'GTE', 0, 1)", [deptB]))[0].insertId;
    // หน่วยบริการ 2 แห่ง: อำเภอ โซน ประเภท ต่างกันทั้งหมด
    const [hs] = await db.query("SELECT h.hoscode, h.hosname, h.distid, h.zone, h.hostype, d.distname FROM chospital h LEFT JOIN co_district d ON d.distid = h.distid WHERE h.zone IS NOT NULL AND h.zone <> '' AND h.hostype IS NOT NULL ORDER BY h.hoscode LIMIT 500");
    h1 = hs[0];
    h2 = hs.find(x => x.zone !== h1.zone && x.hostype !== h1.hostype && x.distid !== h1.distid);
    if (!h2) throw new Error('ฐานทดสอบไม่มีหน่วยบริการ 2 แห่งที่อำเภอ/โซน/ประเภทต่างกัน');
    const sa = await ensureTestUser(db, { username: 'test_rflt_sa', role: 'super_admin', session_id: 's-rflt' });
    userId = sa.id;
    token = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null, sessionId: 's-rflt' });

    const I = { [indA]: { dept: deptA, itypes: ['r9'] }, [indB]: { dept: deptB, itypes: ['moph'] } };
    const H = { [h1.hoscode]: h1, [h2.hoscode]: h2 };
    // คู่: (ตัวชี้วัด, หน่วยบริการ, ปีงบ, บันทึกผลงานแล้ว)
    const raw = [[indA, h1, Y, true], [indA, h2, Y, false], [indB, h2, Y, true], [indA, h1, Y2, true]];
    pairs = raw.map(([ind, h, year, recorded]) => ({ ind, hos: h.hoscode, dist: h.distid, zone: String(h.zone), hostype: h.hostype, year, recorded, ...I[ind] }));
    for (const p of pairs) {
        const h = H[p.hos];
        const name = p.ind === indA ? 'test_rflt_A' : 'test_rflt_B';
        await db.query(`INSERT INTO kpi_summary (indicator_id, year_bh, hospcode, kpi_indicators_name, dept_id, dept_name, hosname, distid, distname, hostype, target_value, last_actual, oct)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '10', '12', '12')`,
            [p.ind, p.year, p.hos, name, p.dept, p.dept === deptA ? 'test_rflt_กลุ่มงานA' : 'test_rflt_กลุ่มงานB', h.hosname, h.distid, h.distname, h.hostype]);
        await db.query(`INSERT INTO kpi_results (indicator_id, year_bh, month_bh, user_id, status, hospcode, target_value, actual_value) VALUES (?, ?, '10', ?, 'Pending', ?, '10', ?)`,
            [p.ind, p.year, userId, p.hos, p.recorded ? '12' : null]);
    }
}, 90000);

async function cleanup() {
    const [inds] = await db.query("SELECT id FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_rflt\\_%'");
    const ids = inds.map(r => r.id);
    if (ids.length) {
        await db.query('DELETE FROM kpi_summary WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_results WHERE indicator_id IN (?)', [ids]);
        await db.query('DELETE FROM kpi_indicators WHERE id IN (?)', [ids]);
    }
    await db.query("DELETE FROM departments WHERE dept_name LIKE 'test\\_rflt\\_%'");
}

afterAll(async () => {
    await cleanup();
    await cleanupTestUsers(db, 'test\\_rflt\\_');
});

// ---------- คำตอบที่คาด ----------
const FILTERS = () => [
    {}, { dept_id: deptA }, { dept_id: deptB }, { zone: h1.zone }, { zone: h2.zone },
    { distid: h1.distid }, { distid: h2.distid }, { itype: 'r9' }, { itype: 'moph' },
    { hostype: h1.hostype }, { hostype: h2.hostype }, { dept_id: deptA, hostype: h2.hostype }, { itype: 'r9', distid: h2.distid },
];
const match = (p, f) => (!f.dept_id || p.dept === f.dept_id) && (!f.zone || p.zone === String(f.zone)) && (!f.distid || p.dist === f.distid)
    && (!f.itype || p.itypes.includes(f.itype)) && (!f.hostype || p.hostype === f.hostype);
const sel = (f, year = Y) => pairs.filter(p => (year == null || p.year === year) && match(p, f));
const countBy = (list, key, val) => {
    const m = {};
    for (const p of list) { const k = String(p[key]); m[k] = m[k] || new Set(); m[k].add(val(p)); }
    return Object.fromEntries(Object.entries(m).map(([k, s]) => [k, s.size]));
};
const pick = (rows, keyField, valField, keys) => Object.fromEntries((rows || [])
    .filter(r => keys.includes(String(r[keyField]))).map(r => [String(r[keyField]), Number(r[valField])]).filter(([, v]) => v > 0));
const get = (path, q) => request(app).get('/khupskpi/api' + path).set('Authorization', `Bearer ${token}`).query(q);
const label = (f) => JSON.stringify(f);

describe('ทุกแถบ × ทุกตัวกรอง', () => {
    const indKeys = () => [String(indA), String(indB)];
    const hosKeys = () => [h1.hoscode, h2.hoscode];
    const distKeys = () => [h1.distid, h2.distid];

    test('รายข้อตัวชี้วัด: จำนวนหน่วยบริการของแต่ละตัวชี้วัด', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/by-indicator', { year_bh: Y, ...f });
            expect(r.status).toBe(200);
            expect([label(f), pick(r.body.data, 'indicator_id', 'hospital_count', indKeys())]).toEqual([label(f), countBy(sel(f), 'ind', p => p.hos)]);
        }
    });

    test('รายหน่วยบริการ: จำนวนตัวชี้วัดของแต่ละหน่วยบริการ', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/by-hospital', { year_bh: Y, ...f });
            expect(r.status).toBe(200);
            expect([label(f), pick(r.body.data, 'hospcode', 'indicator_count', hosKeys())]).toEqual([label(f), countBy(sel(f), 'hos', p => p.ind)]);
        }
    });

    test('รายอำเภอ: จำนวนหน่วยบริการ/ตัวชี้วัดของแต่ละอำเภอ (รวมตัวกรองอำเภอ)', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/by-district', { year_bh: Y, ...f });
            expect(r.status).toBe(200);
            expect([label(f), pick(r.body.data, 'distid', 'hospital_count', distKeys())]).toEqual([label(f), countBy(sel(f), 'dist', p => p.hos)]);
            expect([label(f), pick(r.body.data, 'distid', 'indicator_count', distKeys())]).toEqual([label(f), countBy(sel(f), 'dist', p => p.ind)]);
        }
    });

    test('รายปีงบประมาณ: ทุกปีงบ (ไม่ใช้ตัวกรองปีงบ) + ตัวกรองอื่นทุกตัว', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/by-year', { year_bh: Y, ...f });   // ส่งปีงบมาด้วยก็ยังแสดงทุกปี
            expect(r.status).toBe(200);
            expect([label(f), pick(r.body.data, 'year_bh', 'hospital_count', [Y, Y2])]).toEqual([label(f), countBy(sel(f, null), 'year', p => p.hos)]);
        }
    });

    test('สรุปตัวชี้วัดของกลุ่มงาน: จำนวนตัวชี้วัดของแต่ละกลุ่มงาน', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/by-dept-kpi', { year_bh: Y, ...f });
            expect(r.status).toBe(200);
            expect([label(f), pick(r.body.data, 'dept_id', 'total_indicators', [String(deptA), String(deptB)])]).toEqual([label(f), countBy(sel(f), 'dept', p => p.ind)]);
        }
    });

    test('สถานะการบันทึก รายตัวชี้วัด: หน่วยบริการทั้งหมด/บันทึกแล้ว', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/recording-status', { year_bh: Y, ...f });
            expect(r.status).toBe(200);
            expect([label(f), pick(r.body.data, 'indicator_id', 'total_hospitals', indKeys())]).toEqual([label(f), countBy(sel(f), 'ind', p => p.hos)]);
            expect([label(f), pick(r.body.data, 'indicator_id', 'recorded_hospitals', indKeys())]).toEqual([label(f), countBy(sel(f).filter(p => p.recorded), 'ind', p => p.hos)]);
        }
    });

    test('สถานะการบันทึก รายหน่วยบริการ: ตัวชี้วัดทั้งหมด/บันทึกแล้ว', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/recording-status/by-hospital', { year_bh: Y, ...f });
            expect(r.status).toBe(200);
            expect([label(f), pick(r.body.data, 'hospcode', 'total_indicators', hosKeys())]).toEqual([label(f), countBy(sel(f), 'hos', p => p.ind)]);
            expect([label(f), pick(r.body.data, 'hospcode', 'recorded_indicators', hosKeys())]).toEqual([label(f), countBy(sel(f).filter(p => p.recorded), 'hos', p => p.ind)]);
        }
    });

    test('สรุปรายกลุ่มงาน: แถวตามตัวกรองกลุ่มงาน/ประเภทตัวชี้วัด + ตัวชี้วัดที่บันทึกแล้วตามตัวกรองพื้นที่/ประเภทหน่วยบริการ', async () => {
        for (const f of FILTERS()) {
            const r = await get('/report/by-dept-summary', { year_bh: Y, ...f });
            expect(r.status).toBe(200);
            const ours = r.body.data.filter(d => [deptA, deptB].includes(d.dept_id));
            // แถวกลุ่มงาน = กลุ่มงานที่ตรงตัวกรองกลุ่มงาน และมีตัวชี้วัดตามประเภทที่เลือก
            const expDepts = [deptA, deptB].filter(d => (!f.dept_id || f.dept_id === d) && (!f.itype || pairs.some(p => p.dept === d && p.itypes.includes(f.itype))));
            expect([label(f), ours.map(d => d.dept_id).sort()]).toEqual([label(f), expDepts.sort()]);
            expect([label(f), pick(ours, 'dept_id', 'entered_indicators', [String(deptA), String(deptB)])]).toEqual([label(f), countBy(sel(f).filter(p => p.recorded), 'dept', p => p.ind)]);
        }
    });
});

describe('หน้าเจาะลึกของสรุปรายกลุ่มงานใช้ตัวกรองอำเภอ', () => {
    test('ตัวชี้วัดของกลุ่มงาน: อำเภอ h2 = หน่วยบริการ 1 แห่ง ยังไม่บันทึก', async () => {
        const r = await get('/report/by-dept-summary/indicators', { year_bh: Y, dept_id: deptA, distid: h2.distid });
        expect(r.status).toBe(200);
        const row = r.body.data.find(x => x.indicator_id === indA);
        expect(Number(row.total_hospitals)).toBe(1);
        expect(Number(row.recorded_hospitals)).toBe(0);
        const all = await get('/report/by-dept-summary/indicators', { year_bh: Y, dept_id: deptA });
        expect(Number(all.body.data.find(x => x.indicator_id === indA).total_hospitals)).toBe(2);
    });
    test('รายชื่อหน่วยบริการ: อำเภอ h1 = เฉพาะ h1', async () => {
        const r = await get('/report/by-dept-summary/hospitals', { year_bh: Y, indicator_id: indA, distid: h1.distid });
        expect(r.status).toBe(200);
        expect(r.body.data.map(x => x.hospcode)).toEqual([h1.hoscode]);
    });
    test('รายชื่อหน่วยบริการ: role กลุ่มงานดูตัวชี้วัดของกลุ่มงานอื่นไม่ได้', async () => {
        const u = await ensureTestUser(db, { username: 'test_rflt_ssj', role: 'admin_ssj', dept_id: deptA, session_id: 's-rflt2' });
        const t = makeToken({ userId: u.id, username: u.username, role: 'admin_ssj', deptId: deptA, hospcode: null, sessionId: 's-rflt2' });
        const r = await request(app).get('/khupskpi/api/report/by-dept-summary/hospitals').set('Authorization', `Bearer ${t}`).query({ year_bh: Y, indicator_id: indB });
        expect(r.status).toBe(403);
        const ok = await request(app).get('/khupskpi/api/report/by-dept-summary/hospitals').set('Authorization', `Bearer ${t}`).query({ year_bh: Y, indicator_id: indA });
        expect(ok.status).toBe(200);
    });
});
