# Integration Tests

Tests สำหรับ critical paths — ป้องกัน regression ตอน refactor/แก้บัก

## วิธีรัน

### 1. เตรียม database สำหรับ test (ครั้งเดียว)
```sql
CREATE DATABASE khups_kpi_test_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON `khups_kpi_test_db`.* TO 'kpi_user'@'%';
FLUSH PRIVILEGES;
```

### 2. สร้าง `api/.env.test` (copy จาก .env.dev แล้วเปลี่ยน DB_NAME)
```env
DB_HOST=localhost
DB_PORT=3306
DB_NAME=khups_kpi_test_db        # ← เปลี่ยน!
DB_USER=kpi_user
DB_PASSWORD=kpi_pass
SECRET_KEY=test-secret-key-for-jest
PORT=3700
NODE_ENV=test

# Windows: ชี้ไป mariadb binary (สำหรับ backup test ถ้ารัน)
MYSQL_BIN=C:\Program Files\MariaDB 10.11\bin\mysql.exe
MYSQLDUMP_BIN=C:\Program Files\MariaDB 10.11\bin\mysqldump.exe
BACKUP_DIR=d:\it-ssjnma-project\korat-health-kpi\backups-test
```

### 3. รันทุก test
```bash
cd api
npm test
```

### รันเฉพาะ file
```bash
npm test -- tests/login.test.js
npm test -- tests/permissions.test.js
npm test -- tests/error-monitoring.test.js
```

### Watch mode (auto rerun ตอนแก้)
```bash
npm run test:watch
```

## โครงสร้าง

```
api/tests/
├── setup.js                      ตั้งค่า env + load .env.test
├── helpers.js                    makeToken / ensureTestUser / cleanup
├── README.md                     ไฟล์นี้
├── login.test.js                 POST /login — 5 cases (success, wrong pass, no user, pending, inactive)
├── permissions.test.js           Permission enforcement — 7 cases (default, super_admin override, readonly, PUT)
└── error-monitoring.test.js      Error monitoring — 4 cases (report, dedup, RBAC, stats)
```

## หลักการ

- ใช้ **`khups_kpi_test_db`** แยกจาก production / dev — ไม่กระทบข้อมูลจริง
- Auto-migration ใน server.js สร้างตารางให้อัตโนมัติตอน import
- `beforeAll` / `afterAll` cleanup user/error_logs ที่ขึ้นต้น `test_` หรือ test source
- `supertest(app)` ใช้ app object ตรงๆ — ไม่เปิด HTTP port จริง
- `require.main === module` ใน server.js → ไม่ start scheduler ตอน import

## เพิ่ม test ใหม่

```js
require('./setup');
const request = require('supertest');
const { ensureTestUser, makeToken, cleanupTestUsers } = require('./helpers');

let app, db;
beforeAll(async () => { ({ app } = require('../server')); db = require('../db'); });
afterAll(async () => { await cleanupTestUsers(db); });

test('description', async () => {
    const u = await ensureTestUser(db, { username: 'test_xxx', role: 'user_hos' });
    const token = makeToken({ userId: u.id, role: 'user_hos' });
    const res = await request(app)
        .post('/khupskpi/api/endpoint')
        .set('Authorization', `Bearer ${token}`)
        .send({ ... });
    expect(res.status).toBe(200);
});
```

## CI/CD ในอนาคต

Add GitHub Actions workflow:
```yaml
- run: cd api && npm ci && npm test
  env:
    DB_NAME: khups_kpi_test_db
    DB_USER: kpi_user
    DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
    SECRET_KEY: ${{ secrets.SECRET_KEY }}
```
