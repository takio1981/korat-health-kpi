# KHUPS KPI — Coding Guidelines for Claude

## 1. Project Overview

- **ชื่อ:** ระบบบันทึกผลงาน KPI ด้านสุขภาพ — สสจ.นครราชสีมา (Korat Health KPI)
- **Stack:** Angular 21 (Standalone) + Express.js 5 + MySQL/MariaDB
- **Backend:** `api/server.js` (single file), Port 8830 (prod), 3700 (dev)
- **Frontend:** `frontend/src/app/`, Port 8881 (prod via nginx), 4500 (dev)
- **API Base Path:** `/khupskpi/api`
- **ปีงบประมาณ:** ต.ค. (เดือน 10) ถึง ก.ย. (เดือน 9)

## 2. Architecture

```
api/
  server.js          — Express 5 API ทั้งหมด (5000+ lines)
  db.js              — MySQL pool (promise-based)
  db-remote.js       — Remote HDC DB pool
  .env.dev           — Dev config (gitignored)

frontend/src/app/
  services/auth.ts   — AuthService (API calls, JWT, shared state)
  guards/            — Route guards (auth, admin, superAdmin, anyAdmin)
  layout/            — Main layout (sidebar, header, notification dropdown)
  dashboard/         — หน้าบันทึกผลงานตัวชี้วัด
  chart/             — กราฟและสถิติ
  report/            — รายงานสรุปผล
  kpi-manage/        — จัดการตัวชี้วัด
  kpi-setup/         — สร้าง KPI ปีงบใหม่
  kpi-manager/       — จัดการข้อมูล KPI (DB Compare, Form Builder, Export, Report Compare)
  user-management/   — จัดการผู้ใช้งาน
  settings/          — ตั้งค่าระบบ
  feedback/          — กระดานข้อเสนอแนะ
  changelog/         — ประวัติการอัปเดต
  help/              — คู่มือการใช้งาน
  
  NOTE: chart + report รวมเป็นหน้าเดียว (2 tabs ใน chart component)
  NOTE: feedback, help, changelog เข้าถึงผ่าน Profile Dropdown (ไม่อยู่ใน sidebar)
```

## 3. Backend Rules

### Express Router Pattern
```javascript
const apiRouter = express.Router();
app.use('/khupskpi/api', apiRouter);

// ทุก endpoint ใช้ apiRouter ไม่ใช่ app
apiRouter.get('/endpoint', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT ...', [params]);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
```

### Middleware ที่ต้องใช้
- `authenticateToken` — ทุก endpoint (ยกเว้น public)
- `isAdmin` — admin_ssj + super_admin
- `isAnyAdmin` — admin ทุกระดับ
- `isSuperAdmin` — super_admin เท่านั้น

### Role Constants (ห้ามสร้างใหม่)
```javascript
const ROLE_ADMIN_ALL = ['admin_hos','admin_sso','admin_cup','admin_ssj','super_admin'];
const ROLE_ADMIN_CENTRAL = ['admin_ssj','super_admin'];
const ROLE_ADMIN_LOCAL = ['admin_hos','admin_sso','admin_cup'];
const ROLE_SCOPE_DISTRICT = ['user_cup','admin_cup'];
```

### API Response Format
```javascript
// สำเร็จ
res.json({ success: true, data: rows });
res.json({ success: true, message: 'สำเร็จ', inserted: 5 });

// ผิดพลาด
res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบ' });
res.status(500).json({ success: false, message: e.message });
```

### Dept Filtering (สำคัญมาก)
ทุก endpoint ที่ดึงข้อมูลตัวชี้วัดต้องกรอง dept_id ตาม role:
```javascript
if (user.role !== 'super_admin' && user.deptId != null) {
    whereClause = 'WHERE i.dept_id = ?';
    params.push(user.deptId);
}
```

### Auto-Migration Pattern
เพิ่ม migration ใน section `✅ Auto-create tables` ของ server.js:
```javascript
try { await db.query('ALTER TABLE x ADD COLUMN y ...'); } catch (e) {}
```

## 4. Frontend Rules

### Component Pattern (Standalone)
```typescript
import { Component, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-example',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './example.html'
})
export class ExampleComponent implements OnInit {
  private authService = inject(AuthService);  // ใช้ inject() ไม่ใช่ constructor
  private cdr = inject(ChangeDetectorRef);

  ngOnInit() {
    this.loadData();
  }
}
```

### Template Directives
- ใช้ `*ngIf` / `*ngFor` (ยังไม่เปลี่ยนเป็น @if/@for)
- ใช้ `[(ngModel)]` สำหรับ two-way binding
- ใช้ `[ngClass]` สำหรับ conditional classes

### API Call Pattern
```typescript
this.authService.getKpiResults(filters).subscribe({
  next: (res) => {
    if (res.success) { /* ... */ }
    this.cdr.detectChanges();
  },
  error: (err) => {
    Swal.fire('ผิดพลาด', err.error?.message || 'เกิดข้อผิดพลาด', 'error');
  }
});
```

### SweetAlert2 Patterns
```typescript
// Loading
Swal.fire({ title: 'กำลังโหลด...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

// Success (auto-close)
Swal.fire({ icon: 'success', title: 'สำเร็จ', text: 'บันทึกเรียบร้อย', timer: 2000, showConfirmButton: false });

// Confirm
Swal.fire({
  title: 'ยืนยัน', icon: 'question',
  showCancelButton: true, confirmButtonColor: '#10b981',
  confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก'
}).then(r => { if (r.isConfirmed) { /* ... */ } });
```

### เพิ่ม Route ใหม่
1. สร้าง component ใน `frontend/src/app/[name]/`
2. เพิ่ม import + route ใน `app.routes.ts`
3. เพิ่มเมนูใน `layout.html` (ทั้ง mobile + desktop sidebar)

## 5. Database Rules

### Table Relationships
```
kpi_indicators.dept_id → departments.id (FK, INT, ON DELETE SET NULL)
kpi_indicators.main_indicator_id → kpi_main_indicators.id (FK, INT, ON DELETE SET NULL)
kpi_main_indicators.yut_id → main_yut.id (FK, ON DELETE SET NULL)
kpi_results.indicator_id → kpi_indicators.id (FK)
kpi_results.user_id → users.id (FK)
users.dept_id → departments.id (FK)
```

### Column Type Rules
- FK columns ต้องเป็น `INT` (ไม่ใช่ VARCHAR)
- hospcode = `VARCHAR(20)`
- year_bh = `VARCHAR(10)` (ปี พ.ศ. เช่น "2569")
- actual_value, target_value = `VARCHAR(100)` (รองรับทั้งตัวเลขและข้อความ)
- is_active = `TINYINT(1)` (0 หรือ 1)

### chospital Table
- ใช้ `h.distid` (pre-computed) แทน `CONCAT(h.provcode, h.distcode)` เสมอ
- hostype: '05'=รพ.ศูนย์, '06'=รพ.ทั่วไป, '07'=รพ.ชุมชน, '18'=รพ.สต. (ดูทั้งหมดในตาราง `chostype`)
- ตาราง `chostype` (hostypecode, hostypename) — ประเภทสถานบริการ, auto-migrate + seed data

### Performance
- ตาราง `kpi_summary` เป็น Materialized View สำหรับ Chart + Report (ทั้ง 4 แถบ)
- อัปเดตด้วย `POST /refresh-summary` — **batch by indicator_id** (ทีละ 50 indicators ป้องกัน timeout)
- เก็บเฉพาะข้อมูลที่มีผลงานจริง (HAVING actual_value)
- ใช้ composite index: `(indicator_id, year_bh, hospcode)`
- มี `dept_id` + `distid` สำหรับ role-based filtering โดยไม่ต้อง JOIN ตารางอื่น
- Report endpoints ทั้ง 4 (`/report/by-indicator`, `/report/by-hospital`, `/report/by-district`, `/report/by-year`) ดึงจาก `kpi_summary` ไม่ใช่ `kpi_results`

### Export KPI Tables
- Endpoint: `POST /export-kpi-tables` — สร้าง/อัปเดตตาราง MySQL แยกรายตัวชี้วัด
- Prefilter: สร้างเฉพาะ indicator ที่มีข้อมูลใน `kpi_results` (target_value หรือ actual_value)
- Content-based diff: เปรียบเทียบค่าเดิมในตาราง export ทีละคอลัมน์ (ไม่ใช้ timestamp)
- `result` = **ค่าเดือนล่าสุดที่คีย์** (ไม่ใช่ SUM) — เหมือน `kpi_summary.last_actual`
- ตารางมีคอลัมน์เดือน (m10-m09) เสมอ + form fields ถ้ามี (ไม่แยก hasForm)
- `emptyToNull()` แปลง `''` → `null` ก่อน INSERT (ป้องกัน DECIMAL error)
- Card counters นับตาม unique `table_process` (dedupe)

## 6. Role System (9 Roles)

| Role | ขอบเขต | เห็นปุ่มลบ | เมนูพิเศษ |
|------|--------|-----------|-----------|
| super_admin | ทั้งหมด | ✅ | ทุกเมนู |
| admin_ssj | dept ตัวเอง, ทุก hospcode (ล็อค dept dropdown) | ❌ | จัดการตัวชี้วัด, kpi-setup |
| admin_cup | อำเภอตัวเอง, ทุก dept | ❌ | kpi-setup |
| admin_hos | hospcode ตัวเอง, ทุก dept | ❌ | - |
| admin_sso | hospcode ตัวเอง, ทุก dept | ❌ | - |
| user_cup | อำเภอตัวเอง, dept ตัวเอง | ❌ | - |
| user_hos | hospcode + dept ตัวเอง | ❌ | - |
| user_sso | hospcode + dept ตัวเอง | ❌ | - |
| user_ssj | hospcode + dept ตัวเอง | ❌ | - |

### UI Rules ตาม Role
- **ปุ่มลบ**: `*ngIf="isSuperAdmin"` ทุก component
- **admin_ssj สร้าง user**: ต้องรอ super_admin อนุมัติ
- **super_admin**: ข้ามการตรวจสอบ lock ได้
- **admin_ssj / user_ssj**: ล็อค dropdown หน่วยงาน เห็นเฉพาะ dept ตัวเอง
- **admin_ssj / super_admin**: ไม่โหลดข้อมูล dashboard อัตโนมัติ ต้องกด "ค้นหา"

### Profile Dropdown
- อยู่ที่ avatar มุมขวาบน Header
- มี: ข้อมูลโปรไฟล์ + ข้อเสนอแนะ + คู่มือ + ประวัติอัปเดต + เปลี่ยนรหัสผ่าน + ออกจากระบบ
- คลิกนอก → ปิดแบบ drain animation (ยุบหายเข้า avatar)
- ข้อเสนอแนะ/คู่มือ/ประวัติอัปเดต ไม่อยู่ใน sidebar แล้ว

### Chart + Report
- รวมเป็นหน้าเดียว (/charts) → 2 tabs: กราฟและสถิติ / รายงานสรุปผล
- ใช้ `[hidden]` เก็บ state ทั้ง 2 view (ไม่ destroy component)

## 7. Naming Conventions

### Files
- Component: `kebab-case/kebab-case.ts` + `.html` (เช่น `kpi-manage/kpi-manage.ts`)
- Service: `services/auth.ts`
- Guard: `guards/admin-guard.ts`

### API Routes
- GET/POST/PUT/DELETE + noun (เช่น `/kpi-results`, `/users/:id`, `/feedback`)
- Nested: `/feedback/:id/replies`
- Action: `/bulk-add-kpi`, `/unlock-kpi-all`, `/refresh-summary`
- DB Compare (2 ทิศทาง): `/db-compare/create-local`, `/db-compare/sync-data` (HDC→Local), `/db-compare/create-remote`, `/db-compare/sync-to-hdc` (Local→HDC)

### Database
- Table: `snake_case` (เช่น `kpi_results`, `kpi_main_indicators`)
- Column: `snake_case` (เช่น `year_bh`, `dept_id`, `is_active`)
- Form table prefix: `form_` (เช่น `form_kpi_tab_001`)

## 8. Styling Rules

### Tailwind CSS
- ใช้ Tailwind utility classes ตรงๆ (ไม่สร้าง custom CSS ยกเว้นจำเป็น)
- สี theme: green (primary), teal (feedback), indigo (kpi-manager), amber (edit), red (danger)
- Rounded: `rounded-xl` (ปุ่ม), `rounded-2xl` (card)
- Shadow: `shadow-sm` (card), `shadow-md` (ปุ่ม)

### Dark Mode
- ใช้ `darkMode: 'class'` ใน tailwind.config.js
- Override ใน `styles.css` `@layer base { .dark ... }`

### Responsive
- Mobile first: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`
- Mobile card view + Desktop table view
- ซ่อน/แสดง sidebar: `lg:hidden` / `hidden lg:block`

### Font
- Thai: Sarabun (`@fontsource/sarabun`)
- Icon: Font Awesome 7 (`@fortawesome/fontawesome-free`)

## 9. Security Rules

### ห้ามทำ
- ❌ API endpoint ไม่มี `authenticateToken` (ยกเว้น public)
- ❌ ปุ่มลบแสดงให้ role อื่นที่ไม่ใช่ super_admin
- ❌ SQL Injection — ใช้ parameterized queries เสมอ `?`
- ❌ เก็บ password เป็น plain text — ใช้ bcrypt.hash
- ❌ เก็บ cid (เลขบัตร) เป็น plain text — ใช้ SHA-256 hash

### ต้องทำ
- ✅ ทุก endpoint ตรวจ role + dept scope
- ✅ Rate limiting: loginLimiter (15 min window), apiLimiter (300/min)
- ✅ Helmet headers ทุก request
- ✅ CORS enabled
- ✅ JWT expiry 8 ชั่วโมง

## 10. Docker & Deploy

### Ports
| Service | Dev | Production |
|---------|-----|------------|
| Frontend | 4500 | 8881 |
| Backend | 3700 | 8830 |
| MySQL | 3306 | 3306 |

### Build & Deploy
```bash
# Dev
./dev.bat

# Production
docker compose build --no-cache
docker compose up -d
```

### Nginx
- Frontend serve static files ที่ `/khupskpi/`
- Proxy API ที่ `/khupskpi/api` → backend:8830
- SPA fallback: `try_files $uri $uri/ /khupskpi/index.html`

## 11. Do's and Don'ts

### DO
- เพิ่ม `cdr.detectChanges()` หลัง async subscribe ที่เปลี่ยนค่า
- ใช้ `h.distid` แทน `CONCAT(h.provcode, h.distcode)` ทุกที่
- เพิ่ม auto-migration ใน server.js สำหรับ column/table ใหม่
- ใช้ `Swal.fire()` สำหรับ dialog ทุกที่ (ไม่ใช่ alert/confirm)
- เพิ่มคำแนะนำขั้นตอน (ซ่อนได้) ในหน้าที่ซับซ้อน
- อัปเดต help.html + changelog.ts ทุกครั้งที่เพิ่มฟีเจอร์

### DON'T
- ❌ สร้าง NgModule — ใช้ standalone component เท่านั้น
- ❌ ใช้ constructor injection — ใช้ `inject()` function
- ❌ สร้าง CSS class ใหม่ — ใช้ Tailwind utility
- ❌ hardcode port/URL — ใช้ environment.ts + .env
- ❌ ใช้ `CONCAT(h.provcode, h.distcode)` — ใช้ `h.distid`
- ❌ ใช้ `any[]` type annotation ใน .js file (JavaScript ไม่ใช่ TypeScript)
- ❌ ใส่ escaped backtick `\`` ใน .js file — ใช้ backtick ตรงๆ
- ❌ DELETE + INSERT สำหรับ sync — ใช้ UPSERT (INSERT...ON DUPLICATE KEY UPDATE)
- ❌ ลืม dept_id filter ใน endpoint ที่ดึงตัวชี้วัด
- ❌ ลืมเพิ่ม route ใน app.routes.ts + เมนูใน layout.html (sidebar หรือ profile dropdown)
- ❌ เพิ่มเมนูใน sidebar สำหรับ feedback/help/changelog (อยู่ใน profile dropdown แล้ว)
- ❌ สร้าง route /reports แยก (รวมกับ /charts เป็น tab แล้ว)
- ❌ เรียก API ใน ngOnDestroy โดยไม่ตรวจ isLoggedIn() ก่อน
- ❌ Report endpoint ดึงจาก `kpi_results` ตรง — ต้องใช้ `kpi_summary` เสมอ (เร็วกว่ามาก)
- ❌ Export `result` ใช้ SUM ของทุกเดือน — ต้องใช้ค่าเดือนล่าสุดที่คีย์ (last actual)
- ❌ Export ใช้ timestamp-based diff (created_at vs update_date) — ต้องใช้ content-based diff
- ❌ Export แยก hasForm path (ไม่ส่ง m10-m09) — ตารางต้องมีเดือนเสมอ + form fields เพิ่มเติม

## 12. Key Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| users | ผู้ใช้งาน | id, username, role, dept_id, hospcode, is_approved, approved_by |
| departments | หน่วยงาน | id, dept_name, dept_code |
| kpi_indicators | ตัวชี้วัด | id, kpi_indicators_name, main_indicator_id, dept_id, table_process, target_percentage, r9, moph, ssj, rmw, other |
| kpi_main_indicators | หมวดหมู่หลัก | id, main_indicator_name, yut_id |
| main_yut | ยุทธศาสตร์ | id, yut_name |
| kpi_results | ผลงาน KPI | id, indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, is_locked |
| kpi_summary | สรุป (Materialized View) สำหรับ Chart + Report ทั้ง 4 แถบ | indicator_id, year_bh, hospcode, dept_id, distid, oct-sep, last_actual |
| chospital | หน่วยบริการ | hoscode, hosname, hostype, distid, provcode, distcode |
| co_district | อำเภอ | distid, distname |
| chostype | ประเภทสถานบริการ | hostypecode, hostypename |
| notifications | แจ้งเตือน | id, user_id, type, title, message |
| feedback_posts | กระทู้ | id, user_id, category, title, message, status |
| feedback_replies | ตอบกลับกระทู้ | id, post_id, user_id, message |
| system_settings | ตั้งค่าระบบ | setting_key, setting_value |
