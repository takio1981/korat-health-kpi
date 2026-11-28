/**
 * ส่งข้อมูลเข้า KHD จากตัวชี้วัดที่เลือก + ปีงบ (28 พ.ย. 2569 — ผู้ใช้สั่ง: ตารางส่งข้อมูลเข้า KHD = ตัวชี้วัดที่เลือกในขั้นที่ 3 หน้าจัดการข้อมูล KPI)
 *   - POST /sync-to-khd/preview { indicator_ids, year_bh } = เฉพาะตารางของตัวชี้วัดที่เลือก, นับ/วางแผนเฉพาะแถว byear ปีงบนั้น
 *     ตัวชี้วัดที่ขอแต่ส่งไม่ได้ (ปิดส่งออก / ยังไม่มีตารางในระบบ) คืนใน excluded | ไม่ส่งพารามิเตอร์ = ทุกตารางแบบเดิม
 *   - POST /sync-to-khd/execute { year_bh } = ส่งเฉพาะแถวปีงบนั้น (แถวปีอื่นในตารางเดียวกันไม่ถูกส่ง)
 *   - table_process ที่มีขีดกลาง: ตารางส่งออกจริงเป็นขีดล่าง — เดิม preview ข้ามเงียบ และ execute ปฏิเสธ "ไม่ใช่ตารางของตัวชี้วัดที่เปิดส่งออก KHD"
 * KHD จำลอง = ตาราง `<ชื่อ>__khd` ในฐานข้อมูลทดสอบ (ไม่เชื่อมต่อ KHD จริง)
 */
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: (sql, params) => require('../db').query(String(sql).replace(/`(test_khdscope_[a-z])`/g, '`$1__khd`'), params),
    }),
}));

require('./setup');
jest.setTimeout(60000);
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken;
const ids = {};
const api = (p) => '/khupskpi/api' + p;
const as = (r) => r.set('Authorization', `Bearer ${saToken}`);
const T = { a: 'test_khdscope_a', b: 'test_khdscope_b', c: 'test_khdscope_c', d: 'test_khdscope_d' };
const cols = `hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) NULL, result VARCHAR(100) NULL,
    create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (hospcode, byear)`;
const NEW = '2026-11-20 08:00:00';

async function dropAll() {
    for (const t of Object.values(T)) {
        await db.query(`DROP TABLE IF EXISTS \`${t}\``);
        await db.query(`DROP TABLE IF EXISTS \`${t}__khd\``);
    }
    await db.query("DELETE FROM kpi_indicators WHERE kpi_indicators_name LIKE 'test\\_khdscope%'");
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db, 'test\\_khdscope\\_');
    const sa = await ensureTestUser(db, { username: 'test_khdscope_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
}, 60000);

beforeEach(async () => {
    await dropAll();
    // a: ปกติ | b: table_process ขีดกลาง (ตารางจริง test_khdscope_b) | c: ปิดส่งออก KHD | d: ไม่ได้เลือก | e: เลือกแต่ยังไม่มีตาราง
    const add = async (key, tp, off) => {
        ids[key] = (await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active, upload_excel) VALUES (?,?,1,?)', [`test_khdscope ${key}`, tp, off]))[0].insertId;
    };
    await add('a', T.a, 0);
    await add('b', 'test-khdscope-b', 0);
    await add('c', T.c, 1);
    await add('d', T.d, 0);
    await add('e', 'test_khdscope_e', 0);
    for (const t of [T.a, T.b, T.c, T.d]) {
        await db.query(`CREATE TABLE \`${t}\` (${cols})`);
        await db.query(`CREATE TABLE \`${t}__khd\` (${cols})`);
        await db.query(`INSERT INTO \`${t}\` (hospcode, byear, target, result, update_date) VALUES ?`, [[
            ['10001', '2570', '80', '70', NEW], ['10002', '2570', '80', '60', NEW], ['10001', '2569', '50', '40', NEW],
        ]]);
    }
});

afterAll(async () => {
    await dropAll();
    await cleanupTestUsers(db, 'test\\_khdscope\\_');
});

test('preview เฉพาะตัวชี้วัดที่เลือก + ปีงบ: ตาราง a และ b (ขีดกลาง) เท่านั้น, นับเฉพาะแถวปีงบ, แจ้งตัวที่ส่งไม่ได้', async () => {
    const r = await as(request(app).post(api('/sync-to-khd/preview'))).send({ indicator_ids: [ids.a, ids.b, ids.c, ids.e], year_bh: '2570' });
    expect(r.status).toBe(200);
    const names = r.body.tables.map(t => t.table).sort();
    expect(names).toEqual([T.a, T.b]);                      // d ไม่ได้เลือก, c ปิดส่งออก, e ยังไม่มีตาราง
    for (const t of r.body.tables) {
        expect(t.status).toBe('ready');
        expect(t.local_rows).toBe(2);                         // แถวปีงบ 2570 เท่านั้น (ตารางมี 3 แถว)
        expect(t.remote_rows).toBe(0);
        expect(t.plan.insert).toBe(2);
    }
    expect(r.body.tables.find(t => t.table === T.b).indicator_ids).toEqual([ids.b]);
    const ex = Object.fromEntries(r.body.excluded.map(e => [e.id, e.reason]));
    expect(ex[ids.c]).toMatch(/ปิดส่งออก KHD/);
    expect(ex[ids.e]).toMatch(/ยังไม่มีตารางในระบบ/);
    expect(r.body.year_bh).toBe('2570');
});

test('preview ไม่ส่งพารามิเตอร์ = ทุกตารางแบบเดิม (รวมตารางที่ไม่ได้เลือก) นับทุกปี', async () => {
    const r = await as(request(app).post(api('/sync-to-khd/preview'))).send({});
    expect(r.status).toBe(200);
    const mine = r.body.tables.filter(t => t.table.startsWith('test_khdscope_'));
    expect(mine.map(t => t.table).sort()).toEqual([T.a, T.b, T.d]);
    expect(mine.every(t => t.local_rows === 3)).toBe(true);
});

test('execute พร้อมปีงบ: ส่งเฉพาะแถวปีงบนั้น ตาราง b (ขีดกลาง) ส่งได้ ตาราง c (ปิดส่งออก) ไม่ส่ง', async () => {
    const r = await as(request(app).post(api('/sync-to-khd/execute'))).send({
        year_bh: '2570', tables: [{ table: T.a }, { table: T.b }, { table: T.c }],
    });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.results.map(x => [x.table, x]));
    expect(by[T.a].status).toBe('success');
    expect(by[T.a].inserted).toBe(2);
    expect(by[T.b].status).toBe('success');                 // เดิม: skipped "ไม่ใช่ตารางของตัวชี้วัดที่เปิดส่งออก KHD"
    expect(by[T.c].status).toBe('skipped');
    for (const t of [T.a, T.b]) {
        const [rows] = await db.query(`SELECT byear, COUNT(*) AS n FROM \`${t}__khd\` GROUP BY byear`);
        expect(rows.map(x => [x.byear, Number(x.n)])).toEqual([['2570', 2]]); // แถวปีงบ 2569 ไม่ถูกส่ง
    }
    const [[c]] = await db.query(`SELECT COUNT(*) AS n FROM \`${T.c}__khd\``);
    expect(Number(c.n)).toBe(0);
});

test('ตรวจค่าที่ส่งมา: ปีงบผิดรูปแบบ / indicator_ids ว่างหรือไม่ใช่รายการ = 400', async () => {
    expect((await as(request(app).post(api('/sync-to-khd/preview'))).send({ year_bh: '70' })).status).toBe(400);
    expect((await as(request(app).post(api('/sync-to-khd/preview'))).send({ indicator_ids: [] })).status).toBe(400);
    expect((await as(request(app).post(api('/sync-to-khd/preview'))).send({ indicator_ids: 'x' })).status).toBe(400);
    expect((await as(request(app).post(api('/sync-to-khd/execute'))).send({ year_bh: '2570x', tables: [{ table: T.a }] })).status).toBe(400);
});
