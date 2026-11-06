/**
 * ส่งตาราง export เข้า KHD อย่างปลอดภัย (6 พ.ย. 2569) — KHD จำลองด้วยตาราง `<ชื่อ>__khd` ในฐานข้อมูลทดสอบ (ไม่เชื่อมต่อ KHD จริง)
 *   - ตาราง KHD ที่คีย์ไม่ใช่ PRIMARY KEY (hospcode, byear) = ข้ามทั้งตาราง (เดิมส่งโดยอาศัยคีย์ใดก็ได้ของ KHD)
 *   - แถวที่มีแล้ว: update_date ใหม่กว่าฝั่งไหนใช้ฝั่งนั้น (เท่ากัน = คงค่า KHD) / ค่าว่างใน local ไม่ทับค่าใน KHD
 *   - ตาราง KHD ที่ไม่มีคอลัมน์เวลา = ไม่ทับแถวที่มีแล้ว (เพิ่มเฉพาะแถวใหม่) | เวลาฝั่ง KHD ชื่อ update_datetime / updated_at ก็เทียบได้
 *   - ตัวชี้วัดที่ปิดส่งออก KHD (upload_excel = 1) ส่งไม่ได้ | ชื่อคอลัมน์จากผู้เรียกที่ไม่ถูกต้องถูกตัดทิ้ง
 *   - หน้าตัวอย่าง (preview) แสดงแผนรายแถว + DB Compare ใช้กติกาเดียวกัน
 */
// KHD จำลอง: ชี้ตารางทดสอบ test_khdsync_* ไปที่ test_khdsync_*__khd ในฐานข้อมูลทดสอบเดียวกัน
jest.mock('../db-remote', () => ({
    getRemotePool: () => ({
        query: (sql, params) => require('../db').query(String(sql).replace(/`(test_khdsync_[a-z])`/g, '`$1__khd`'), params),
    }),
}));

require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db, saToken;
const api = (p) => '/khupskpi/api' + p;
const as = (r) => r.set('Authorization', `Bearer ${saToken}`);
const T = { a: 'test_khdsync_a', b: 'test_khdsync_b', c: 'test_khdsync_c', d: 'test_khdsync_d', e: 'test_khdsync_e' };
const OLD = '2026-10-01 08:00:00', NEW = '2026-10-10 08:00:00';
const exportCols = `hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) NULL, result VARCHAR(100) NULL,
    m10 VARCHAR(100) NULL, create_date DATETIME DEFAULT CURRENT_TIMESTAMP, update_date DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`;
const khd = (t) => `${t}__khd`;
const rowOf = async (t, hc, y) => (await db.query(`SELECT * FROM \`${t}\` WHERE hospcode = ? AND byear = ?`, [hc, y]))[0][0];
const fmt = (d) => d && new Date(d).toISOString();

async function dropAll() {
    for (const t of Object.values(T)) {
        await db.query(`DROP TABLE IF EXISTS \`${t}\``);
        await db.query(`DROP TABLE IF EXISTS \`${khd(t)}\``);
    }
    await db.query("DELETE FROM kpi_indicators WHERE table_process LIKE 'test\\_khdsync\\_%'");
}

beforeAll(async () => {
    let migrationsReady;
    ({ app, migrationsReady } = require('../server'));
    db = require('../db');
    await migrationsReady;
    await cleanupTestUsers(db);
    const sa = await ensureTestUser(db, { username: 'test_khdsync_sa', role: 'super_admin' });
    saToken = makeToken({ userId: sa.id, username: sa.username, role: 'super_admin', deptId: null, hospcode: null });
});

beforeEach(async () => {
    await dropAll();
    // ตัวชี้วัด: a, b, d เปิดส่งออก KHD / c ปิดส่งออก (upload_excel = 1)
    for (const [t, off] of [[T.a, 0], [T.b, 0], [T.c, 1], [T.d, 0], [T.e, 0]]) {
        await db.query('INSERT INTO kpi_indicators (kpi_indicators_name, table_process, is_active, upload_excel) VALUES (?,?,1,?)', [`test_khdsync ${t}`, t, off]);
    }
    // a: คีย์ถูกต้องทั้ง 2 ฝั่ง
    await db.query(`CREATE TABLE \`${T.a}\` (${exportCols}, PRIMARY KEY (hospcode, byear))`);
    await db.query(`CREATE TABLE \`${khd(T.a)}\` (${exportCols}, PRIMARY KEY (hospcode, byear))`);
    const ins = (t, rows) => db.query(`INSERT INTO \`${t}\` (hospcode, byear, target, result, m10, update_date) VALUES ?`, [rows]);
    await ins(T.a, [
        ['10001', '2569', '70', null, '5', NEW],    // local ใหม่กว่า: target ทับ, result ว่างไม่ทับ
        ['10002', '2569', '99', '99', '99', OLD],   // KHD ใหม่กว่า: ไม่ทับ
        ['10003', '2569', '50', '40', '40', OLD],   // มีเฉพาะ local: เพิ่ม
        ['10004', '2569', '1', '1', '1', OLD],      // เวลาเท่ากัน ค่าไม่เท่ากัน: คงค่า KHD
        ['10005', '2569', '80', '80', '80', NEW],   // local ใหม่กว่าแต่ค่าเท่าเดิม: ไม่เปลี่ยน
    ]);
    await ins(khd(T.a), [
        ['10001', '2569', '12', '16', '16', OLD],
        ['10002', '2569', '100', '100', '100', NEW],
        ['10004', '2569', '2', '2', '2', OLD],
        ['10005', '2569', '80', '80', '80', OLD],
        ['10001', '2568', '7', '7', '7', OLD],      // ปีอื่น: ไม่แตะ
        ['10009', '2569', '9', '9', '9', OLD],      // หน่วยบริการอื่น: ไม่แตะ
    ]);
    // b: KHD คีย์เป็น id อย่างเดียว (คีย์ไม่ใช่ hospcode + byear) → ข้ามทั้งตาราง
    await db.query(`CREATE TABLE \`${T.b}\` (${exportCols}, PRIMARY KEY (hospcode, byear))`);
    await db.query(`CREATE TABLE \`${khd(T.b)}\` (id INT AUTO_INCREMENT PRIMARY KEY, ${exportCols})`);
    await ins(T.b, [['10001', '2569', '70', '70', '70', NEW]]);
    await ins(khd(T.b), [['10001', '2569', '12', '16', '16', OLD]]);
    // c: ตัวชี้วัดปิดส่งออก KHD
    await db.query(`CREATE TABLE \`${T.c}\` (${exportCols}, PRIMARY KEY (hospcode, byear))`);
    await db.query(`CREATE TABLE \`${khd(T.c)}\` (${exportCols}, PRIMARY KEY (hospcode, byear))`);
    await ins(T.c, [['10001', '2569', '70', '70', '70', NEW]]);
    await ins(khd(T.c), [['10001', '2569', '12', '16', '16', OLD]]);
    // d: KHD ไม่มีคอลัมน์ update_date → ไม่ทับแถวที่มีแล้ว เพิ่มเฉพาะแถวใหม่
    await db.query(`CREATE TABLE \`${T.d}\` (${exportCols}, PRIMARY KEY (hospcode, byear))`);
    await db.query(`CREATE TABLE \`${khd(T.d)}\` (hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) NULL, result VARCHAR(100) NULL, PRIMARY KEY (hospcode, byear))`);
    await ins(T.d, [['10001', '2569', '70', '70', '70', NEW], ['10002', '2569', '60', '60', '60', NEW]]);
    await db.query(`INSERT INTO \`${khd(T.d)}\` VALUES ('10001', '2569', '12', '16')`);
    // e: KHD ใช้ชื่อคอลัมน์เวลา update_datetime (พบจริงใน KHD 32 ตาราง)
    await db.query(`CREATE TABLE \`${T.e}\` (${exportCols}, PRIMARY KEY (hospcode, byear))`);
    await db.query(`CREATE TABLE \`${khd(T.e)}\` (hospcode VARCHAR(5) NOT NULL, byear VARCHAR(4) NOT NULL, target VARCHAR(100) NULL, result VARCHAR(100) NULL,
        create_datetime TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, update_datetime TIMESTAMP NULL DEFAULT NULL, PRIMARY KEY (hospcode, byear))`);
    await ins(T.e, [['10001', '2569', '70', null, '1', NEW], ['10002', '2569', '60', '60', '1', OLD], ['10003', '2569', '50', '50', '1', NEW]]);
    await db.query(`INSERT INTO \`${khd(T.e)}\` (hospcode, byear, target, result, update_datetime) VALUES ('10001','2569','12','16',?), ('10002','2569','100','100',?)`, [OLD, NEW]);
});

afterAll(async () => {
    await dropAll();
    await cleanupTestUsers(db);
});

describe('POST /sync-to-khd/execute', () => {
    test('ตารางคีย์ถูกต้อง: เพิ่มแถวใหม่, update_date ใหม่กว่าชนะ, ค่าว่างไม่ทับ, ไม่แตะหน่วยบริการ/ปีอื่น', async () => {
        const res = await as(request(app).post(api('/sync-to-khd/execute'))).send({ tables: [{ table: T.a }] });
        expect(res.status).toBe(200);
        const r = res.body.results[0];
        expect(r).toMatchObject({ status: 'success', inserted: 1, updated: 1, khd_newer: 2, unchanged: 1, kept_blank: 1 });

        const h1 = await rowOf(khd(T.a), '10001', '2569');
        expect([h1.target, h1.result, h1.m10]).toEqual(['70', '16', '5']);   // result ว่างใน local → คงค่า KHD
        expect(fmt(h1.update_date)).toBe(fmt(NEW));                        // เวลาเป็นของ local
        const h2 = await rowOf(khd(T.a), '10002', '2569');
        expect([h2.target, h2.result]).toEqual(['100', '100']);             // KHD ใหม่กว่า
        expect((await rowOf(khd(T.a), '10003', '2569')).target).toBe('50');
        expect((await rowOf(khd(T.a), '10004', '2569')).target).toBe('2');  // เวลาเท่ากัน → คงค่า KHD
        expect((await rowOf(khd(T.a), '10001', '2568')).target).toBe('7');
        expect((await rowOf(khd(T.a), '10009', '2569')).target).toBe('9');
    });

    test('ส่งซ้ำรอบสอง: ไม่มีอะไรเปลี่ยน (เวลาเท่ากันแล้ว)', async () => {
        await as(request(app).post(api('/sync-to-khd/execute'))).send({ tables: [{ table: T.a }] });
        const res = await as(request(app).post(api('/sync-to-khd/execute'))).send({ tables: [{ table: T.a }] });
        expect(res.body.results[0]).toMatchObject({ status: 'success', inserted: 0, updated: 0 });
    });

    test('คีย์ KHD ไม่ใช่ hospcode + byear / ปิดส่งออก KHD → ข้ามทั้งตาราง ข้อมูล KHD ไม่เปลี่ยน', async () => {
        const res = await as(request(app).post(api('/sync-to-khd/execute'))).send({ tables: [{ table: T.b }, { table: T.c }] });
        expect(res.status).toBe(200);
        const [b, c] = res.body.results;
        expect(b.status).toBe('skipped');
        expect(b.reason).toMatch(/hospcode \+ byear/);
        expect(c.status).toBe('skipped');
        expect(c.reason).toMatch(/ส่งออก KHD/);
        const [[bRows]] = await db.query(`SELECT COUNT(*) n, MAX(target) t FROM \`${khd(T.b)}\``);
        expect([Number(bRows.n), bRows.t]).toEqual([1, '12']);
        expect((await rowOf(khd(T.c), '10001', '2569')).target).toBe('12');
    });

    test('KHD ไม่มี update_date: ไม่ทับแถวที่มีแล้ว เพิ่มเฉพาะแถวใหม่', async () => {
        const res = await as(request(app).post(api('/sync-to-khd/execute'))).send({ tables: [{ table: T.d }] });
        expect(res.body.results[0]).toMatchObject({ status: 'success', inserted: 1, updated: 0, no_time: 1 });
        expect((await rowOf(khd(T.d), '10001', '2569')).target).toBe('12');
        expect((await rowOf(khd(T.d), '10002', '2569')).target).toBe('60');
    });

    test('KHD ใช้คอลัมน์เวลา update_datetime: เทียบเวลาได้ และตั้งเวลา KHD = ของ local', async () => {
        const res = await as(request(app).post(api('/sync-to-khd/execute'))).send({ tables: [{ table: T.e }] });
        expect(res.body.results[0]).toMatchObject({ status: 'success', inserted: 1, updated: 1, khd_newer: 1, kept_blank: 1 });
        const h1 = await rowOf(khd(T.e), '10001', '2569');
        expect([h1.target, h1.result]).toEqual(['70', '16']);
        expect(fmt(h1.update_datetime)).toBe(fmt(NEW));
        expect((await rowOf(khd(T.e), '10002', '2569')).target).toBe('100');
        expect(fmt((await rowOf(khd(T.e), '10003', '2569')).update_datetime)).toBe(fmt(NEW));
    });

    test('sync_columns จากผู้เรียก: ชื่อผิดถูกตัดทิ้ง และเพิ่ม hospcode/byear ให้เสมอ', async () => {
        const res = await as(request(app).post(api('/sync-to-khd/execute')))
            .send({ tables: [{ table: T.a, sync_columns: ['target', 'x`; DROP TABLE users; --', 'update_date'] }] });
        expect(res.body.results[0]).toMatchObject({ status: 'success', inserted: 1, updated: 1 });
        const h1 = await rowOf(khd(T.a), '10001', '2569');
        expect([h1.target, h1.m10]).toEqual(['70', '16']); // ส่งเฉพาะ target — m10 ไม่อยู่ในรายการ
    });
});

describe('POST /sync-to-khd/preview + DB Compare', () => {
    test('preview แสดงแผนรายแถว, ตารางคีย์ผิด = blocked, ตัวชี้วัดปิดส่งออกไม่อยู่ในรายการ — ไม่เขียนข้อมูล', async () => {
        const res = await as(request(app).post(api('/sync-to-khd/preview'))).send({});
        expect(res.status).toBe(200);
        const by = Object.fromEntries(res.body.tables.map(t => [t.table, t]));
        expect(by[T.a].status).toBe('ready');
        expect(by[T.a].plan).toMatchObject({ insert: 1, update: 1, khd_newer: 2, unchanged: 1, kept_blank: 1 });
        expect(by[T.b]).toMatchObject({ status: 'blocked' });
        expect(by[T.c]).toBeUndefined();
        expect((await rowOf(khd(T.a), '10001', '2569')).target).toBe('12');
    });

    test('POST /db-compare/sync-to-khd ใช้กติกาเดียวกัน', async () => {
        const res = await as(request(app).post(api('/db-compare/sync-to-khd'))).send({ tables: [T.a, T.b] });
        expect(res.status).toBe(200);
        expect(res.body.synced.map(s => s.table)).toEqual([T.a]);
        expect(res.body.errors[0].table).toBe(T.b);
        expect((await rowOf(khd(T.a), '10002', '2569')).target).toBe('100');
        expect((await rowOf(khd(T.a), '10001', '2569')).result).toBe('16');
    });
});
