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

### kpi-manage Hospitals tab
- 5 tabs: ตัวชี้วัด / หมวดหมู่หลัก / ยุทธศาสตร์ / หน่วยงาน / **หน่วยบริการ**
- CRUD endpoints `/hospitals` (super_admin): GET/POST/PUT/DELETE
- DELETE ตรวจ users + kpi_results อ้างอิงก่อน — block ถ้ามี
- Modal fields: hoscode (PK, disabled เมื่อ edit) / hosname / hostype (จาก chostype) / distid (จาก co_district, auto-fill provcode+distcode)
- Filter row: อำเภอ + ประเภท (เพิ่มเติมจาก search + count badge)
- chospital ไม่มี is_active → ซ่อน toggle column สำหรับแท็บนี้

### SSO Login (ProviderID MOPH + ThaID DGA)
- Settings (super_admin): toggle เปิด/ปิด + กรอก OAuth config (client_id, secret, auth_url, token_url, userinfo_url, redirect_uri, scope)
- เก็บใน `system_settings` keys: `<provider>_{enabled,client_id,client_secret,auth_url,token_url,userinfo_url,redirect_uri,scope}`
- Backend endpoints (public, GET): `/auth/{providerid|thaid}/{start|callback}` — OAuth 2.0 Authorization Code flow
  - state CSRF stored in in-memory Map (`_ssoStateMap`, 10 min TTL, cleanup every 60s)
  - `start`: redirect → MOPH/DGA auth URL with state
  - `callback`: exchange code → access_token → userinfo → extract `cid|citizen_id|national_id|pid|sub` → SHA-256 hash → match `users.cid`
  - **ปฏิเสธ user ใหม่**: ถ้าไม่พบ cid hash → redirect กลับ `/login?sso_error=...` ให้ลงทะเบียนก่อน
  - สำเร็จ → issue JWT + active_session_id + log `login_logs` (status: `success_sso_<provider>`) → redirect `/login?sso_token=<jwt>&sso_user=<base64>&sso_provider=<p>`
- Frontend login.ts:
  - `loginWithProviderID()` / `loginWithThaID()` → `window.location.href = ${apiUrl}/auth/<p>/start`
  - `ngOnInit` → `handleSsoCallback()` อ่าน query → save token+user → redirect dashboard | แสดง error
- Frontend Settings: OAuth config form (input type=password สำหรับ client_secret พร้อมปุ่ม show/hide)
- maintenance-status endpoint (public) คืน `thaid_enabled` + `providerid_enabled` — login/register poll ทุก 3s

### Form Builder Field Types
- 7 ประเภท: text / number / textarea / select / score_option / date / checkbox
- **score_option** (ตัวเลือกพร้อม %) — กำหนดป้าย + ค่า% per option:
  - Editor format: `ป้าย = % per บรรทัด` (เช่น `ดีมาก = 100\nดี = 80\nพอใช้ = 60`)
  - Storage: `field_options` JSON `[{label: "ดีมาก", percentage: 100}, ...]`
  - Backend `saveFormSchema`: สร้าง column `<field>_pct DECIMAL(10,2)` เพิ่ม + ALTER TABLE เมื่อแก้ schema
  - Backend `POST /dynamic-data`: อ่าน schema → match selected label → auto-set `<field>_pct` ก่อน INSERT/UPDATE
  - **Sync เข้า kpi_results.actual_value:** ถ้า `actual_value_field` เป็น score_option → sync **%** (จาก `<field>_pct`) ไม่ใช่ label
    - JOIN `kpi_form_fields` ใน sync query เพื่อรู้ field_type
    - dashboard/chart/report ทั้งระบบใช้ตัวเลข % คำนวณได้ตรง
- **select** (legacy) — string array, ไม่มี % column

### Dashboard Dynamic Form Modal (Grid 6×2 — 12 เดือน)
- Modal เปิดจากปุ่ม `fa-clipboard-list` ใน dashboard row → **Grid 6 คอลัมน์ × 2 แถว** เดือนละ 1 card (responsive: lg=6 / md=4 / sm=3 / mobile=2)
- Card header: ชื่อเดือน + check icon (สถานะมีข้อมูล) + fields ภายในใช้ space-y-2
- โหมดดูอย่างเดียว ↔ แก้ไข (ปุ่ม "แก้ไขข้อมูลรายเดือน")
- Batch save: ส่ง POST /dynamic-data เฉพาะเดือนที่เปลี่ยน (snapshot vs current) + แสดง progress N/12
- score_option cell: dropdown แสดง "label (X%)" + badge สีม่วงด้านขวาแสดง `= X%`
- card สีเขียวอ่อน = มีข้อมูล / สีเหลือง+shadow = edit แล้วเปลี่ยน / hover = ขอบม่วง
- modal max-w-5xl (รองรับ 6 cols ใน lg) — ทุกเดือนเห็นพร้อมกันโดยไม่ต้อง scroll
- `parseFieldOptions()` ใช้ `_parsedOptionsCache Map<string, any[]>` กัน NG0103 infinite CD
- Tab "ข้อมูลที่บันทึก" (list view) ยังอยู่เป็น history fallback
- `kpi_form_fields.field_type` ENUM ต้องรวม `'score_option'` (auto ALTER MODIFY COLUMN ใน server startup)

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
- **Prefilter (3 sources):** สร้างเฉพาะ indicator ที่มีข้อมูลใน source ใดsource หนึ่ง:
  1. `kpi_results` (target_value หรือ actual_value)
  2. `kpi_sub_results` (ผ่าน `kpi_sub_indicators.indicator_id` JOIN)
  3. `form_<table_process>` (year_bh ตรง + indicator_id ตรง OR NULL)
- Content-based diff: เปรียบเทียบค่าเดิมในตาราง export ทีละคอลัมน์ (ไม่ใช้ timestamp)
- `result` = **ค่าเดือนล่าสุดที่คีย์** (ไม่ใช่ SUM) — เหมือน `kpi_summary.last_actual`
- ตารางมีคอลัมน์เดือน (m10-m09) เสมอ + form fields ถ้ามี (ไม่แยก hasForm)
- `emptyToNull()` แปลง `''` → `null` ก่อน INSERT (ป้องกัน DECIMAL error)
- **Build dataMap จาก kpi_results — แปลง '' → null ทันที** กัน block merge sub_results (string `''` ไม่ใช่ null/undefined)
- **Merge sub_results AVG เข้า dataMap** — เฉพาะ slot ที่ kpi_results ยังไม่มีค่า (รวมกรณี `''`):
  ```js
  if ((cur === undefined || cur === null || cur === '') && subRow[m] !== null) entry[m] = fmtNum(subRow[m]);
  ```
- **Form schema lookup** — `ORDER BY is_active DESC, id DESC LIMIT 1` (รับ inactive schema ด้วย)
- **Fallback infer fields:** ถ้าไม่มี schema เลย แต่ตาราง form_* มีอยู่ → SHOW COLUMNS แล้ว infer fields (ตัด standard columns)
- **Dynamic data fetch:** `WHERE year_bh = ? AND (indicator_id = ? OR indicator_id IS NULL)` + `ORDER BY hospcode, month_bh ASC` (latest wins)
- Hospcode normalize: `String(hc).trim()` ทุกจุด (กัน whitespace/type mismatch)
- Card counters นับตาม unique `table_process` (dedupe)
- **`hasActualData`**: hospcode ต้องมีเดือนใด ๆ ที่ `actual_value` ไม่ว่าง (รวม `'0'` ถือว่าใช่) หรือมี dynamic form data — target อย่างเดียวไม่พอ
- **`checkKpiChanges` ใช้ logic ตรงกับ `performKpiExport`** — `sameValue()` numeric-aware + result=last actual + hasActualResult filter
  - แก้แล้ว: รวม sub_results AVG, รับ '' → null, รับ '0' valid

### Export Diagnostics
- `GET /admin/export-debug?year_bh=&indicator_id=&hospcode=` (super_admin) — ดู source ทั้งหมด:
  - indicator info, sub_indicators list, orphan_sub_indicators (indicator_id IS NULL)
  - kpi_sub_results_summary group by sub_indicator_id (เห็น belongs_to_table — ตัวชี้วัดที่ sub link)
  - kpi_results rows, kpi_sub_results rows, form_table rows + columns, schemas + active_fields, export_table existing rows
- รับ `?table_process=` แทน indicator_id ได้ (ค้นหา id จาก table_process)

### Online Users Tracking (Realtime)
- ตาราง `users` เพิ่ม 3 คอลัมน์: `last_seen_at` DATETIME + `last_seen_ip` VARCHAR(64) + `last_seen_ua` VARCHAR(255) + index `idx_last_seen_at`
- `authenticateToken` middleware: อัปเดต `last_seen_at = NOW()` + ip + ua ทุก request
  - **Throttle 1 ครั้ง/นาที/user** ผ่าน `_lastSeenCache` Map (กัน DB overload)
- Endpoint `GET /online-users?window=N` (super_admin) — filter `last_seen_at >= NOW() - INTERVAL N MINUTE` (1-1440 นาที)
- UI `/online-users` — auto-refresh 5-60s, filter role + time window, สถานะ dot สีตาม idle_seconds (<60/<300/<900/>900)
- Parse user-agent ฝั่ง frontend (Windows/Android/iOS/macOS/Linux × Edge/Chrome/Firefox/Safari)

### Role × Page Access (Dynamic — Super Admin ตั้งค่าได้)
- หน้า `/role-page-access` (sidebar: "สิทธิ์การเข้าถึงหน้า", super_admin เท่านั้น เสมอ ไม่ผ่านระบบนี้เอง กันปิดสิทธิ์ตัวเอง) —
  Super Admin เปิด/ปิดการเข้าถึงแต่ละหน้าของระบบ แยกตาม role ได้ทั้ง 8 role (ไม่รวม super_admin ซึ่งเข้าได้ทุกหน้าเสมอ)
- ตาราง `role_page_access` (role, page_key, is_enabled) UNIQUE(role, page_key) — auto-seed ตอน startup ให้ตรงกับ
  พฤติกรรม route guard/middleware **เดิม** เป๊ะ (ไม่เปลี่ยนพฤติกรรมจนกว่า super_admin จะแก้เอง)
- `pageKey` ต้องตรงกับ `route.data['pageKey']` ใน `app.routes.ts` เสมอ (19 หน้า: dashboard, charts, notifications, sop,
  feedback, help, changelog, users, kpi-manage, kpi-setup, audit-logs, kpi-manager, settings, announcements,
  online-users, backup-manager, kpi-audit-digest, error-logs, sso-logs)
- **Backend enforcement** (`api/server.js`):
  - `PAGE_ACCESS_RULES` (exact/regex/prefix ผสมกัน) + `resolvePageKeyFromPath(method, path)` → เช็คใน
    `authenticateToken` กลาง (ก่อน session check) + OR เพิ่มใน `isAdmin`/`isAnyAdmin`/`isSuperAdmin` (ให้ role ที่ถูก
    เปิดสิทธิ์เพิ่มผ่านหน้านี้ ผ่าน middleware เดิมได้จริง ไม่ใช่แค่ผ่าน authenticateToken แล้วโดน middleware เดิมเตะออก)
  - **ห้าม map ด้วย prefix กว้างๆ กับ endpoint ที่มี authorization หลายระดับปนกันใต้ path เดียวกัน** (over-grant risk) —
    เช่น `/users` มีทั้ง isAnyAdmin (จัดการทั่วไป) + isAdmin (approve/reject) + isSuperAdmin (permissions/sync-to-hdc)
    ปนกัน, `/indicators`+`/departments`+`/hospitals`+... มีทั้ง GET เปิดให้ทุก role (dropdown ใช้ร่วมทั้งระบบ) และ
    POST/PUT/DELETE ที่ isSuperAdmin — ต้องใช้ exact/regex เฉพาะจุด ดู comment เหนือ `PAGE_ACCESS_RULES` ในโค้ดก่อนเพิ่ม
    endpoint ใหม่เข้ากลุ่มเดิมเสมอ
  - **ข้อจำกัดที่ตั้งใจ (ไม่ครอบคลุมทั้งหน้า):** pageKey `kpi-manage` ผ่าน `PAGE_ACCESS_RULES` ครอบคลุมเฉพาะ
    `/bulk-add-kpi*` (isAdmin เดิม) — endpoint แก้ไข/ลบตัวชี้วัด/หมวดหมู่/หน่วยงาน/หน่วยบริการ **ไม่ได้ map ใน
    `PAGE_ACCESS_RULES` เลย** (`resolvePageKeyFromPath` คืน `null`) แต่ POST/PUT (add/edit) ของกลุ่มนี้ถูกคุมแยกโดย
    `requireAction('kpi-manage', 'add'|'edit')` แทนที่ `isSuperAdmin` เดิมตรงๆ (ดูระบบ Role × Action Access ด้านล่าง
    — เป็นเช็คอิสระ ไม่ผูกกับ hasPageAccess) DELETE ทุกตัวยังคง hardcode `isSuperAdmin` เสมอ, Form Builder
    (`/form-schemas` POST/DELETE, GET all-indicators) ก็ยังคง hardcode `isSuperAdmin` เสมอเช่นกัน (ตรงกับที่
    `kpi-manage.html` ซ่อนปุ่มนี้จาก admin_ssj ด้วย `*ngIf="isSuperAdmin"` อยู่แล้ว) — pageKey `users` ผ่าน
    `PAGE_ACCESS_RULES` ครอบคลุม endpoint GET (list/stats/pending-count) **และ** POST/PUT (add/edit ผู้ใช้ทั่วไป,
    เพราะ prefix rule `/users` กว้างครอบคลุมทุก method) — แต่ POST/PUT เหล่านั้นเปลี่ยนมาใช้
    `requireAction('users','add'|'edit')` แทน `isAnyAdmin` เดิมแล้ว ทำให้ต้องผ่าน **สองชั้น**: มี page access
    `users` (จาก authenticateToken กลาง) **และ** มี action access `add`/`edit` (จาก middleware บน endpoint เอง) —
    approve/reject/toggle-active/basic (isAdmin เดิม) และ bulk-toggle-active/permissions/sync-compare/sync-to-hdc
    (isSuperAdmin เดิม) ไม่รวมอยู่ในระบบ action ใหม่เลย (ยัง hardcode ตามเดิมเสมอ — เป็น action คนละระดับ ไม่ใช่แค่
    "เพิ่ม/แก้ไขข้อมูลทั่วไป") แต่ยังคงต้องมี page access `users` อยู่ดี (ผ่าน prefix rule เดิม)
  - Endpoint ที่เปิดให้ทุก role ใช้ร่วมกันข้ามหน้า (เช่น `/users/change-password`, `/notifications/unread-count`,
    `/notifications/pending-kpi`) ถูก exclude ออกจากระบบนี้โดยเจตนา (`pageKey: null` ใน rule หรือไม่มี rule เลย)
  - `_rolePageAccessCache` (Map, role → Set<pageKey>) โหลดตอน startup + reload ทุกครั้งที่ `PUT /role-page-access`
- **Frontend enforcement**: `guards/page-access-guard.ts` เช็ค `route.data['pageKey']` กับ
  `authService.canAccessPage()` — ใช้แทน `adminGuard`/`anyAdminGuard`/`superAdminGuard` เดิมในทุก route ที่ toggle ได้
  (ไฟล์ guard เดิม 2 ไฟล์นี้ถูกลบแล้ว — เหลือแค่ `auth-guard.ts` + `super-admin-guard.ts` ที่ยัง hardcode จริงๆ
  เช่น `/role-page-access` เอง)
  - `AuthService.canAccessPage(pageKey)` อ่านจาก `localStorage['kpi_page_access']` (cache ที่ set โดย
    `saveUser()` ทุกครั้งหลัง login ผ่าน `GET /my-page-access`) — **fail-open** (คืน `true`) ถ้ายังไม่มี cache/pageKey
    ไม่อยู่ใน map เพราะ backend เป็นด่านตัดสินจริงเสมอ ฝั่งนี้แค่กัน navigate แบบ proactive/ซ่อนเมนู
  - Layout sidebar (ทั้ง desktop expanded/collapsed + mobile + profile dropdown) ใช้ `canAccess('pageKey')`
    (wrapper ใน `layout.ts` เรียก `authService.canAccessPage()`) แทนเช็ค role ตรงๆ ทุกจุด
- API: `GET /my-page-access` (ทุก role, คืน `{pageKey: boolean}` ของ role ตัวเอง), `GET /role-page-access` +
  `PUT /role-page-access` (super_admin เท่านั้น, จัดการทั้งเมทริกซ์)
- **⚠️ ห้าม hardcode เช็ค role ตรงๆ ใน `ngOnInit()` ของ component หน้าใหม่เด็ดขาด** (เช่น
  `if (role !== 'super_admin') { ...; router.navigate(['/dashboard']); }`) — ให้ใช้
  `if (!this.authService.canAccessPage('pageKey')) { ... }` แทนเสมอ ต่อให้ route มี `pageAccessGuard` อยู่แล้วก็ตาม
  (เพราะ sub-component ที่ embed อยู่ในหน้าอื่น เช่น `export-kpi`/`env-config` ไม่ได้ผ่าน route guard ของตัวเอง
  ต้องเช็คเองด้วย `canAccessPage()` ของ pageKey หน้าแม่) — **พบบั๊กนี้จริงจาก 9 component** (`announcements`,
  `settings`, `online-users`, `kpi-manager`, `kpi-setup`, `audit-log`, `kpi-manage`, `export-kpi`, `env-config`)
  ที่เขียนไว้ตั้งแต่ก่อนมีระบบนี้ — ทำให้ต่อให้ Super Admin เปิดสิทธิ์หน้าให้ role อื่นผ่าน `/role-page-access` แล้ว
  ก็ยังโดนเตะออกอยู่ดีเพราะ component เช็ค hardcode ซ้ำอีกชั้น (แก้ไขและทดสอบยืนยันแล้วว่าใช้งานได้จริงทุกจุด)
- เช่นเดียวกัน **ห้าม hardcode ปุ่ม "เพิ่ม"/"แก้ไข" ไว้เป็นปุ่มที่ไม่มี `*ngIf` ใดๆ เลย** ในหน้าที่ผ่าน route guard
  แบบ all-or-nothing มาก่อน (เช่น `announcements.html` เดิมไม่มี `*ngIf` บนปุ่มเพิ่ม/แก้ไข/ลบเลยสักปุ่ม เพราะพึ่งพา
  การบล็อกทั้งหน้าที่ `ngOnInit` อย่างเดียว) — เมื่อเปิดหน้าให้ role อื่นเข้าถึงได้ ต้องเพิ่ม `*ngIf` ที่ระดับปุ่มด้วย
  เสมอ ไม่ใช่แค่ที่ระดับหน้า (ปุ่ม "ลบ" ต้องเป็น `*ngIf="isSuperAdmin"` เสมอ ไม่มีข้อยกเว้น)

### Role × Action Access (Dynamic — สิทธิ์ "เพิ่ม"/"แก้ไข" ข้อมูล แยกจากสิทธิ์เข้าหน้า)
- ส่วนขยายของ Role × Page Access ด้านบน — คนละมิติ คนละตารางฐานข้อมูล ตั้งใจให้เป็น**เช็คอิสระ ไม่ผูกกับ
  hasPageAccess** เพราะ endpoint เดิมหลายจุด bundle อ่าน+เขียนไว้ใต้ pageKey เดียว (เช่น `/users`) การผูกซ้อนกัน
  จะยุ่งยากเกินจำเป็น — ระบบนี้แค่เพิ่มเงื่อนไข "เขียนได้ไหม" อีกชั้นบน endpoint ที่เป็น POST (add) / PUT (edit)
  เท่านั้น — **DELETE ยังคง hardcode `isSuperAdmin` เสมอทุกจุดตามกติกาเดิมของทั้งระบบ ไม่มีข้อยกเว้น**
  (ปุ่มลบ = super_admin เท่านั้นเสมอ)
- ครอบคลุมแค่ 3 หน้าที่มี CRUD จริงและปลอดภัยพอจะแยกระดับ: `kpi-manage` (indicators/main-indicators/main-yut/
  sub-indicators/departments/hospitals/form-schemas — ไม่รวม Form Builder), `users` (add user + PUT
  แก้ไขข้อมูลผู้ใช้ทั่วไป/reset-password — ไม่รวม approve/reject/permissions/sync), `announcements`
  (add/edit/activate — ไม่รวม send-email)
- **ไม่รวม `dashboard`/`kpi-setup`** — endpoint หลัก (`/update-kpi`) ใช้ `authenticateToken` ตรงๆ ไม่ผ่าน
  middleware กลางที่ไหนเลย (route handler ประกาศแบบ `apiRouter.post('/update-kpi', async (req,res)=>{...})`
  ไม่มี `isXxx` middleware ใดๆ ต่อท้าย) และ dashboard มี per-user permission (`can_edit_actual`/`can_edit_target`
  ในตาราง `users`, เช็คผ่าน `getPermsForUser()`) อยู่แล้วซึ่งเป็นกลไกคนละชั้น เสี่ยงเกินไปที่จะแตะในรอบนี้
- ตาราง `role_action_access` (role, page_key, action ENUM('add','edit'), is_enabled) UNIQUE(role, page_key, action)
  — auto-seed ให้ตรงกับ middleware เดิมของแต่ละ endpoint เป๊ะ (ดู `ACTION_ACCESS_DEFAULT_ENABLED` ในโค้ด)
- Backend: `requireAction(pageKey, action)` factory (`role==='super_admin' || hasActionAccess(...)`) ใช้แทนที่
  `isAdmin`/`isAnyAdmin`/`isSuperAdmin` เดิม**ตรงๆ** บน endpoint ที่เลือกไว้ (ไม่ใช่ OR เพิ่มแบบ page access — คือ
  การแทนที่ทั้งหมด) — `_roleActionAccessCache` (Map, role → Map<pageKey, Set<action>>) โหลดตอน startup + reload
  ทุกครั้งที่ `PUT /role-action-access`
- Frontend: `AuthService.canPerformAction(pageKey, action)` อ่านจาก `localStorage['kpi_action_access']` (set โดย
  `saveUser()` ผ่าน `GET /my-action-access`, fail-open เหมือน `canAccessPage()`) — หน้า `kpi-manage`/`users`/
  `announcements` มี `canAddData`/`canEditData` เป็น component property เรียก `canPerformAction()` ใน `ngOnInit`
  ใช้ gate ปุ่ม "เพิ่ม"/"แก้ไข" แทน `isSuperAdmin` เดิม (ปุ่ม "ลบ" ไม่แตะ ยังคง `isSuperAdmin` เสมอ)
- UI จัดการ: ตารางที่ 2 ในหน้า `/role-page-access` เดียวกัน (ไม่แยกหน้า) — แถว = "หน้า — เพิ่ม/แก้ไข" (6 แถว: 3 หน้า
  × 2 action), คอลัมน์ = role — component/service เดียวกัน แค่เพิ่ม method `loadActions()`/`saveActions()` แยกจาก
  `load()`/`save()` เดิม เพราะเป็นคนละ API/ตาราง
- API: `GET /my-action-access` (ทุก role), `GET /role-action-access` + `PUT /role-action-access` (super_admin
  เท่านั้น)

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

# Production — ใช้ build.bat (แนะนำ) หรือทำตามขั้นตอนเดียวกันด้วยมือ
build.bat
```

**⚠️ สำคัญมาก — Docker ไม่ได้ build จาก source โดยตรง:** `api/Dockerfile` copy `api/dist/`
(ไม่ใช่ `api/server.js`) และ `frontend/Dockerfile` copy `frontend/dist/` (ไม่ใช่ผลลัพธ์ดิบจาก
`ng build` ที่อยู่ใน `dist/kpi-web/browser/`) — ทั้งสองเป็นไฟล์ **pre-built ที่ต้องเตรียมเองก่อน**
`docker compose up -d --build` เสมอ ไม่งั้น Docker จะใช้ `dist/` เก่าที่ค้างจากรอบก่อนหน้าเงียบๆ
โดยไม่มี error ใดๆ (container ขึ้น "Healthy" ปกติ แต่โค้ดที่รันจริงเป็นของเก่า):
```bash
# 1) Backend — แค่ copy ไฟล์ (api/package.json "build" script)
cd api && npm run build && cd ..

# 2) Frontend — ng build + flatten dist/kpi-web/browser/* -> dist/ (ต้องใช้ base-href ถูกต้อง)
cd frontend && npm run build -- --base-href /khupskpi/
# Windows: flatten ด้วย xcopy (ดู build.bat) | git-bash: MSYS_NO_PATHCONV=1 กัน path ถูกแปลงเป็น Windows path ผิดๆ
cd ..

# 3) แล้วค่อย build+deploy Docker
docker compose down && docker compose up -d --build
docker builder prune -af
```
ถ้าใช้ Bash tool (git-bash) รัน `ng build -- --base-href /khupskpi/` ตรงๆ **ต้องใส่ `MSYS_NO_PATHCONV=1`**
นำหน้าเสมอ ไม่งั้น MSYS จะแปลง `/khupskpi/` เป็น Windows path (เช่น `C:/Program Files/Git/khupskpi/`)
ทำให้ asset ทั้งหมดโหลดผิด — ตรวจสอบด้วย `grep '<base href' frontend/dist/index.html` ก่อน deploy ทุกครั้ง

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
- ❌ เพิ่ม route ใหม่ใน app.routes.ts โดยไม่ใส่ `data.pageKey` + `pageAccessGuard` (ระบบ Role × Page Access จะไม่ครอบคลุมหน้านั้น)
- ❌ Map endpoint ใหม่เข้า `PAGE_ACCESS_RULES` ด้วย prefix กว้างๆ โดยไม่เช็คก่อนว่า path นั้นมี middleware ระดับต่างกันปนกันหรือไม่ (over-grant) — ดูส่วน "Role × Page Access" ก่อนเสมอ
- ❌ เขียน hardcode เช็ค role ตรงๆ ใน `ngOnInit()` ของ component หน้าใหม่ (เช่น `if (role !== 'super_admin') {...}`) — ใช้ `authService.canAccessPage('pageKey')` เสมอ แม้ route จะมี `pageAccessGuard` แล้วก็ตาม (sub-component ที่ embed ในหน้าอื่นไม่ผ่าน route guard ของตัวเอง)
- ❌ ปล่อยปุ่ม "เพิ่ม"/"แก้ไข" ไว้แบบไม่มี `*ngIf` เลยในหน้าที่เดิมพึ่งพา route guard แบบ all-or-nothing — ต้องเพิ่ม `*ngIf="canPerformAction('pageKey','add'|'edit')"` ที่ระดับปุ่มเองเสมอเมื่อหน้านั้นอาจถูกเปิดให้ role อื่นเข้าถึง

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
| role_page_access | สิทธิ์การเข้าถึงหน้าต่อ role (super_admin ตั้งค่าได้) | id, role, page_key, is_enabled (UNIQUE role+page_key) |
