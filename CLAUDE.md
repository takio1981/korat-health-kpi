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

### Shared State (AuthService BehaviorSubjects)
Layout + Dashboard สื่อสารผ่าน `AuthService` BehaviorSubjects:
- `unreadCount$` — นับแจ้งเตือนที่ยังไม่อ่าน
- `pendingStats$` — นับ KPI ที่รอตรวจสอบ (deptCount, hosCount, indicatorCount)
- `focusMode$` — โหมดเต็มพื้นที่ (true = ซ่อน sidebar อัตโนมัติ)
  - Setter: `authService.setFocusMode(true|false)`
  - Dashboard call ตอนเข้า `toggleEditMode()` / `toggleDeleteMode()` + reset ใน `ngOnDestroy`
  - Layout subscribe → ปิด sidebar + จำค่าเดิมใน `_prevSidebarOpen` → คืนเมื่อออก focus mode

### Dashboard Table Frozen Columns
4 คอลัมน์ซ้ายติด sticky (frozen) — ไม่มีคอลัมน์ "หน่วยงาน" และ "อำเภอ" แยก (รวมเข้า cells อื่น):
- `.col-1` — หมวดหมู่หลัก (180px, left:0)
- `.col-2` — ชื่อตัวชี้วัด (280px, left:180) content:
  - [สถานะ][ปีงบฯ][type badges R9/MOPH/SSJ/RMW][ตัวชี้วัดของ]
  - [ชื่อ KPI][🏢 หน่วยงาน badge slate][📈 ดูแนวโน้ม inline]
- `.col-3` — จัดการ (64px, left:460) — action icons แนวตั้ง (approve/reject/unlock/form/sub-indicator)
- `.col-4` — หน่วยบริการ (220px, left:524) content:
  - บรรทัด 1: [ชื่อ รพ.][ตัวย่อประเภท cyan เช่น รพช./รพ.สต./สสอ.]
  - บรรทัด 2: [📍 อำเภอ สีเทา text-[10px]]
  - มี shadow separator ขอบขวา
CSS: `dashboard.css` — ใช้ `position: sticky; z-index: 20;` สำหรับ td frozen, `z-index: 40` สำหรับ th frozen

### Evaluation Mode & Required Off Types (ขอบเขตหน่วยบริการของตัวชี้วัด)
- 2 คอลัมน์ใน `kpi_indicators`:
  - `evaluation_mode` VARCHAR(20) — `'any_one'` (เฉพาะบางประเภท) | `'all_required'` (ทุกประเภทบังคับ)
  - `required_off_types` TEXT — JSON array ของ hostypecode เช่น `["05","06","07"]`
- CRUD `/indicators` POST/PUT รับ 2 ฟิวล์ + helper `normalizeOffTypes()` / `normalizeEvalMode()` sanitize
- UI: `kpi-manage` modal section "เกณฑ์การประเมิน" — radio โหมด + multi-select hostype
- Dashboard filter `indicator_off_type`: SQL `(i.evaluation_mode='all_required' OR i.required_off_types LIKE '%"CODE"%')`
- Dashboard badge: `evaluation_mode='all_required'` → "ทุกประเภท" (purple) | `'any_one'` + codes → ชื่อประเภท (cyan)

### Sub-Indicators (ตัวชี้วัดย่อย)
- `kpi_sub_indicators` — metadata ของตัวชี้วัดย่อย (FK → kpi_indicators.id, CASCADE delete)
- `kpi_sub_results` — ผลงานย่อย per hospcode×month (UNIQUE: sub+year+hospcode+month)
- CRUD endpoints: `/sub-indicators` (GET/POST/PUT/DELETE/toggle-active)
- Result: `GET /sub-results` / `POST /sub-results/upsert` / `DELETE`
- **Aggregate endpoint**: `GET /sub-results/summary` — **AVG** ต่อ indicator (หารด้วยจำนวน sub)
  - Return: avg_target, m10-m09 (ต่อเดือน), sub_count
- Dashboard main row: merge sub summary → override target_value + monthly + last_actual
  - `_mainOriginal` เก็บ raw values ก่อน override
  - `_fromSubSummary` flag = true เมื่อถูก override
  - **Edit mode ต้องคืน raw values** ก่อน snapshot `_original` — ไม่งั้น save จะเจอ "no changes"
    เพราะ `applySubSummaryToKpiData` override ค่า user's edit กลับเป็น AVG
  - `applySubSummaryToKpiData()` early-return ถ้า `isEditing === true`
  - ออกจากโหมด edit + save success → call `applySubSummaryToKpiData()` ใหม่เพื่อแสดง AVG
- Modal บันทึกผลย่อย: ตาราง 12 เดือน (ไม่ใช้ dropdown) + คอลัมน์ ผลงาน + %
- `formatNum()` helper: จำนวนเต็มไม่มีทศนิยม (70), มีเศษ 2 ตำแหน่ง (70.50)

### Users Data Sync (Local ↔ HDC)
- `GET /users/sync-compare` — เทียบ 4 สถานะ (matched/different/local_only/hdc_only)
- `POST /users/sync-to-hdc` — UPSERT batch 100 rows (สร้างตารางใน HDC อัตโนมัติถ้ายังไม่มี)
- Log: `USERS_SYNC_TO_HDC` ใน system_logs
- UI: ปุ่ม "Data Synchronization" ใน user-management (เฉพาะ super_admin) → modal เทียบ + เลือก + sync

### Export KPI Tables
- Endpoint: `POST /export-kpi-tables` — สร้าง/อัปเดตตาราง MySQL แยกรายตัวชี้วัด
- Core function: `performKpiExport(year_bh, indicator_ids, userId)` — ใช้ร่วมกับ scheduler
- Prefilter: สร้างเฉพาะ indicator ที่มีข้อมูลใน `kpi_results` (target_value หรือ actual_value)
- Content-based diff: เปรียบเทียบค่าเดิมในตาราง export ทีละคอลัมน์ (ไม่ใช้ timestamp)
- `result` = **ค่าเดือนล่าสุดที่คีย์** (ไม่ใช่ SUM) — เหมือน `kpi_summary.last_actual`
- ตารางมีคอลัมน์เดือน (m10-m09) เสมอ + form fields ถ้ามี (ไม่แยก hasForm)
- `emptyToNull()` แปลง `''` → `null` ก่อน INSERT (ป้องกัน DECIMAL error)
- Card counters นับตาม unique `table_process` (dedupe)
- **`hasActualData`**: hospcode ต้องมีเดือนใด ๆ ที่ `actual_value` ไม่ว่าง/≠0 (หรือ dynamic form data) — target อย่างเดียวไม่พอ
- **`checkKpiChanges` ใช้ logic ตรงกับ `performKpiExport`** — `sameValue()` numeric-aware + result=last actual + hasActualResult filter
  - กรณีที่เคยพลาด: check ใช้ SUM → compare กับ export (last actual) → รายงาน "changed" เสมอ

### Online Users Tracking (Realtime)
- ตาราง `users` เพิ่ม 3 คอลัมน์: `last_seen_at` DATETIME + `last_seen_ip` VARCHAR(64) + `last_seen_ua` VARCHAR(255) + index `idx_last_seen_at`
- `authenticateToken` middleware: อัปเดต `last_seen_at = NOW()` + ip + ua ทุก request
  - **Throttle 1 ครั้ง/นาที/user** ผ่าน `_lastSeenCache` Map (กัน DB overload)
- Endpoint `GET /online-users?window=N` (super_admin) — filter `last_seen_at >= NOW() - INTERVAL N MINUTE` (1-1440 นาที)
- UI `/online-users` — auto-refresh 5-60s, filter role + time window, สถานะ dot สีตาม idle_seconds (<60/<300/<900/>900)
- Parse user-agent ฝั่ง frontend (Windows/Android/iOS/macOS/Linux × Edge/Chrome/Firefox/Safari)

### Single Session Enforcement (กัน login ซ้อน)
- ตาราง `users` เพิ่ม 2 คอลัมน์: `active_session_id` VARCHAR(64) + `session_started_at` DATETIME + index `idx_active_session`
- หลักการ: 1 user = 1 active session — login ใหม่ขณะมี session ที่อื่นอยู่จะถูก block (ถ้า last_seen ≤ 5 นาที)
- `POST /login`: ถ้า `active_session_id` + `last_seen_at > NOW() - 5 MIN` → **409 CONCURRENT_LOGIN** + `last_seen_ip` กลับไปแจ้งผู้ใช้
  - ถ้าผ่าน — สร้าง `sessionId = crypto.randomBytes(24).toString('hex')` → บันทึก DB + ใส่ใน JWT payload
- `authenticateToken`: เช็ค JWT.sessionId vs DB.active_session_id (cached 30s ผ่าน `_sessionCache`)
  - ไม่ตรง → **401 SESSION_INVALIDATED** → frontend interceptor force logout + redirect /login
  - JWT เก่าที่ไม่มี sessionId (backward compat) → ปล่อยผ่าน
- `POST /logout`: clear `active_session_id` + delete `_sessionCache.delete(uid)` + log
- `POST /admin/force-logout-user/:userId` (super_admin): บังคับ logout user ใดก็ได้ (กรณีฉุกเฉิน)
- Frontend interceptor: `frontend/src/app/interceptors/session-invalidated.interceptor.ts` — ดักจับ 401 + code SESSION_INVALIDATED → ล้าง localStorage + Swal + redirect
- UI ปุ่ม "บังคับ logout" ใน user-management:
  - `GET /users` SELECT รวม `active_session_id, session_started_at, last_seen_at, last_seen_ip` (ใช้ตัดสินว่าใคร online อยู่)
  - ปุ่ม fa-sign-out-alt สีม่วง (mobile + desktop) — `*ngIf="isSuperAdmin && user.active_session_id"`
  - กดแล้ว confirm dialog แสดง IP + เวลา + เตือน "logout ภายใน ~30 วินาที"
  - log: `admin_force_logout` ใน system_logs

### Sync to HDC
- Core function: `performSyncToHdc(tables, userId)` — UPSERT local export tables → HDC
- ถ้า `sync_columns` ไม่ส่งมา → auto-detect common columns ระหว่าง local กับ remote
- HTTP: `POST /sync-to-hdc/preview` + `/sync-to-hdc/execute`
- ใช้ `INSERT ... ON DUPLICATE KEY UPDATE` (ไม่ลบข้อมูลเดิม)
- Log: `SYNC_TO_HDC` ใน system_logs

### Export Scheduler (ตารางเวลา Export อัตโนมัติ)
- ตาราง `export_schedules` — metadata schedule (name, days_of_week, time_of_day, indicator_scope, auto_sync_hdc, notify_email/telegram)
- ตาราง `export_schedule_logs` — บันทึกการรันแต่ละครั้ง (status, inserted, updated_count, unchanged, duration_ms, error_msg)
- `startExportScheduler()` — ยิง `check()` immediate ตอน startup + `setInterval(30000)` ทุก 30 วินาที
  - **Match 2-minute window** — `time_of_day IN (hhmm_now, hhmm_prev_minute)` กัน drift จาก timing ของ setInterval
  - Dedup: `last_run_at + 120s` + UPDATE `last_run_at` ทันทีก่อน execute (atomic lock กัน overlapping ticks)
  - Log ชัด: `🚀 Running` / `Skip (day mismatch)` / `check() failed` + timezone offset ตอน start
- `indicator_scope` (3 โหมด):
  - `'changes_only'` (default/แนะนำ) — เรียก `checkKpiChanges()` ก่อน → export เฉพาะ `status === 'has_changes'`
  - `'all'` — export ทุกตัวชี้วัด
  - `'selected'` — ใช้ `indicator_ids` ที่เก็บไว้ (JSON array)
- `auto_sync_hdc` — ถ้า `=1` → หลัง export สำเร็จเรียก `performSyncToHdc()` ต่อทันที → รวมผลใน notification
- Notification recipients: ดึงจาก `system_settings` (keys: `admin_emails`, `telegram_chat_id`, `telegram_bot_token`) ผ่าน `getNotifSettings()` helper
- CRUD: `GET/POST/PUT/DELETE /export-schedules` + `/run-now` + `/logs` (super_admin)
- UI: ปุ่ม gradient ม่วง-คราม "ตารางเวลา Export อัตโนมัติ" ใน export-kpi → modal รายการ + modal เพิ่ม/แก้

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

### kpi-manager (Wizard 3 ขั้นตอน)
- รวม Report Compare / DB Compare / Export ในหน้าเดียว — wizard UI 3 ขั้น (free navigation)
- `currentStep: 1 | 2 | 3` + step completion auto-detect จาก ViewChild `compareResult` / `exportResult`
- Sub-components ใช้ `[hidden]="currentStep !== N"` (ไม่ destroy เพื่อ keep state)
- ปิด `showGuide` ภายใน sub-components ผ่าน `AfterViewInit` — ใช้ unified guide ที่ kpi-manager
- Form Builder embed (รับ `createFormEvent` จาก DB Compare) — modal เปิดเมื่อกด "สร้างฟอร์มจาก HDC"

### Form Builder (kpi-manage)
- ปุ่ม `fa-clipboard-list` (สีม่วง) ในคอลัมน์ "จัดการ" ของแต่ละ indicator (super_admin)
- กดแล้วเปิด `<app-form-builder #formBuilder [embedded]="true">` modal
- `embedded` flag ซ่อน UI หลักของ form-builder (header + ตาราง + tips) เหลือเฉพาะ modal
- Public method `openForIndicator(item)` — enrich item ด้วย `schema_id` แล้วเปิด `openCreateForm()`

### Layout (Glassmorphism)
- Outer: `.layout-bg-gradient` class — gradient mint→teal→pink (light) / slate→teal→dark (dark)
- 3-layer SVG waves + sparkle dots (decorative, opacity 70%/22%)
- Sidebar: `bg-white/65 backdrop-blur-xl` + `border-white/60` — text-green-800/900
- Header: เหมือน sidebar — รวม theme toggle + bell + profile + feedback icon
- Main: `flex-1 overflow-hidden min-w-0` → `<div h-full w-full overflow-y-auto overflow-x-hidden card-scroll>`
- **`min-w-0` บน flex chain** สำคัญ — กัน table `min-w-[1600px]` ดันหน้ากว้างเกินจอ
- Mobile menu: `bg-white/85 backdrop-blur-xl` ตรงกลางจอ (top-[84px])
- Dark mode: ใช้ `.dark` overrides ใน styles.css สำหรับ `bg-white/{60,65,70,80,85}` + `bg-green-100/70` + text-green-{700,800,900}

### Page Sizing Pattern (ทุกหน้าต้อง fit จอ + ไม่ scroll body)
- Outer: `<div class="p-6">` (ไม่ใช่ `<ng-container>` ตรงๆ — กัน card ติดขอบ)
- Card: `<div class="bg-white rounded-2xl shadow-sm border border-gray-100">`
- Scrollable area inside: `style="max-height: calc(100vh - Npx)"` + `overflow-auto card-scroll`
  - dashboard: `100vh - 240px` (kpi-table-wrapper) | sticky thead z-20
  - users: `100vh - 320px` mobile / `65vh` desktop | sticky thead
  - audit-logs: `100vh - 320px` table / `100vh - 340px` cards | sticky thead
  - kpi-setup: `100vh - 320px` overflow-auto (sticky thead มีอยู่แล้ว)
  - notifications: `100vh - 230px`
  - online-users: `100vh - 280px` | sticky thead
  - kpi-manage: `100vh - 280px` desktop / `100vh - 320px` mobile
  - announcements: `100vh - 250px`
  - settings: `100vh - 100px`
  - charts: `100vh - 200px` (chart + report views)
- Sticky thead pattern: `<thead class="... sticky top-0 z-20 shadow-md">`

### Background Tone (Mint Theme)
- `styles.css` global override `.bg-white` → `rgba(232, 245, 238, 0.92)` (mint อ่อน #e8f5ee)
- รวมไปถึง `bg-white/65 /70 /80 /85` — ใช้ mint base กับ opacity ต่างกัน
- ทำให้ทุกการ์ด/ตาราง/modal มีโทนเดียวกับ sidebar (ไม่ต้องแก้ component)

### Login / Register UI
- Background: `layout-bg-gradient` mint→teal→pink + 3-layer SVG waves + sparkle dots
- Logo: `bg-white rounded-full p-1` (กรอบบาง ~1mm) + shadow 2 ชั้น (เขียวเรืองรอง + เงาดำ)
- Glassmorphism login card: `bg-white/65 backdrop-blur-xl rounded-3xl border-white/60`
- ปุ่ม ThaID: bg-white + border + img object-contain (h-full w-auto)
- ปุ่ม ProviderID: bg-white + border + img object-contain (h-full w-auto p-2)
- Badge "รอเปิดใช้": ห่อปุ่มด้วย `<div class="relative">` แล้ววาง badge เป็น sibling (ไม่ถูก `overflow-hidden` clip)
- Register: `registerMode: 'choose' | 'manual'` — modal เลือก 3 วิธีก่อนเข้าฟอร์ม

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
| users | ผู้ใช้งาน | id, username, role, dept_id, hospcode, is_approved, approved_by, last_seen_at, last_seen_ip, last_seen_ua, **active_session_id**, **session_started_at** |
| departments | หน่วยงาน | id, dept_name, dept_code |
| kpi_indicators | ตัวชี้วัด | id, kpi_indicators_name, main_indicator_id, dept_id, table_process, target_percentage, r9, moph, ssj, rmw, other, evaluation_mode ('any_one'\|'all_required'), required_off_types (JSON array ของ hostypecode) |
| kpi_main_indicators | หมวดหมู่หลัก | id, main_indicator_name, yut_id |
| main_yut | ยุทธศาสตร์ | id, yut_name |
| kpi_results | ผลงาน KPI | id, indicator_id, year_bh, hospcode, month_bh, target_value, actual_value, status, is_locked |
| kpi_sub_indicators | ตัวชี้วัดย่อย | id, indicator_id, sub_indicator_name, sub_indicator_code, target_percentage, weight, sort_order, is_active |
| kpi_sub_results | ผลงานย่อย | id, sub_indicator_id, year_bh, hospcode, month_bh, target_value, actual_value (UNIQUE: sub_indicator_id+year+hospcode+month) |
| kpi_summary | สรุป (Materialized View) สำหรับ Chart + Report ทั้ง 4 แถบ | indicator_id, year_bh, hospcode, dept_id, distid, oct-sep, last_actual |
| chospital | หน่วยบริการ | hoscode, hosname, hostype, distid, provcode, distcode |
| co_district | อำเภอ | distid, distname |
| chostype | ประเภทสถานบริการ | hostypecode, hostypename |
| notifications | แจ้งเตือน | id, user_id, type, title, message |
| feedback_posts | กระทู้ | id, user_id, category, title, message, status |
| feedback_replies | ตอบกลับกระทู้ | id, post_id, user_id, message |
| system_settings | ตั้งค่าระบบ | setting_key, setting_value |
| system_announcements | ประกาศระบบ | id, title, content_html, bg_color, text_color, blink_enabled, show_on_header, show_on_login, is_active |
| export_schedules | ตารางเวลา Export อัตโนมัติ | id, name, is_enabled, days_of_week, time_of_day, year_bh, indicator_scope, indicator_ids, auto_sync_hdc, notify_email, notify_telegram, last_run_at, last_status |
| export_schedule_logs | ประวัติการรัน schedule | id, schedule_id, run_at, status, inserted, updated_count, unchanged, tables_count, duration_ms, notified_email, notified_telegram, error_msg |
