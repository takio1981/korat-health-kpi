# บันทึกการแก้ไขปัญหา (Fix Log)

บันทึกสรุปการแก้ไขบั๊ก/ปัญหาที่เกิดขึ้นจริงในระบบ เรียงจากล่าสุดไปเก่าสุด — ใช้เป็นประวัติอ้างอิงประกอบ CLAUDE.md และ changelog.ts

---

## 2569-09-26 — อัปเดตผังกระบวนการ SOP + คู่มือการใช้งานให้ตรงกับระบบปัจจุบัน

### คำขอ
ต้องการให้ช่วย update SOP, help, คู่มือ, การแนะนำต่างๆ ให้เป็นปัจจุบันที่สุด ทุกระบบที่มีการแก้ไขไปแล้ว

### สาเหตุ
ใช้ agent ตรวจสอบ CLAUDE.md (แหล่งข้อมูลจริงล่าสุด) เทียบกับ `sop.ts` (ผังกระบวนการ) และ `help.html` (คู่มือ)
ทีละหัวข้อ พบว่าฟีเจอร์ที่เพิ่มมาในช่วงหลัง (แต่ยังไม่เก่ามาก) หลายจุดไม่ได้อัปเดต 2 ไฟล์นี้ตามไปด้วยตอนที่ทำฟีเจอร์
จริง (commit ที่เกี่ยวข้องแก้แต่ CLAUDE.md/help.html บางไฟล์ ไม่ได้แก้ sop.ts คู่กันเสมอ):
1. **ระบบ Role × Page Access + Role × Action Access** — หน้า "/role-page-access" ทั้งหน้าไม่มีอยู่ใน sop.ts เลย
2. **Users Data Sync 3 แท็บ** — sop.ts ยังแสดงผังแบบ sync ทางเดียวแบบเก่า ทั้งที่ฟีเจอร์จริงมี 3 แท็บมาสักพักแล้ว
   (เปรียบเทียบข้อมูล/ตรวจโครงสร้างตาราง/ตั้งค่า Mapping)
3. **เป้าหมาย vs เกณฑ์ (แยกคอลัมน์)** และ **ตัวชี้วัดสะสม (badge "สะสม")** — ไม่มีทั้งใน sop.ts และ help.html เลย
4. **Online Users Tracking** — มีหน้าอยู่จริงและมีใน CLAUDE.md แต่ไม่มีผังใน sop.ts
5. **kpi-manager Wizard** — sop.ts ยังบอกว่ามี 3 ขั้น (รวม Report Compare) ทั้งที่โค้ดจริงเหลือ 2 ขั้นแล้ว
   (Report Compare ย้ายไปอยู่หน้า "จัดการตัวชี้วัด") — พบว่า **CLAUDE.md เองก็เขียนผิดจุดเดียวกัน** ("Wizard 3 ขั้นตอน")
6. **help.html คำถามที่พบบ่อย (FAQ)** ยังบอกว่า "จัดการข้อมูล KPI" มี 4 Tab ซึ่งขัดแย้งกับเนื้อหาหัวข้อ 13
   ในไฟล์เดียวกันที่บอกถูกต้องว่าเป็น Wizard 2 ขั้นแล้ว (self-contradiction ภายในไฟล์เดียว)

### วิธีแก้
- `sop.ts`: เพิ่มผังใหม่ 2 ระบบ ("ระบบสิทธิ์การเข้าถึง" 2 subflow, "ระบบติดตามผู้ใช้งานออนไลน์") พร้อมการ์ดในหน้า
  ภาพรวม (12 → 14 ระบบ) และแถวในตาราง "การเชื่อมโยงระหว่างระบบ" — ขยายผัง Data Sync ของ `users` system ให้
  แตกแขนงเป็น 3 แท็บจริงผ่าน decision node — แก้ Export wizard จาก 3 ขั้นเหลือ 2 ขั้น (ลบ node Report Compare
  ออก) พร้อมโน้ตอธิบายว่าย้ายไปไหน — เพิ่มโน้ตอธิบายเป้าหมาย/เกณฑ์ และตัวชี้วัดสะสมในระบบ manage/dash
- `help.html`: เพิ่มกล่องอธิบาย "เป้าหมาย vs เกณฑ์" (สีเหลือง) และ "ตัวชี้วัดสะสม" (สีม่วง) ในหัวข้อ 9
  จัดการตัวชี้วัด — แก้คำตอบ FAQ ให้ตรงกับเนื้อหาจริง (Wizard 2 ขั้น ไม่ใช่ 4 Tab)
- `CLAUDE.md`: แก้ "kpi-manager (Wizard 3 ขั้นตอน)" เป็น "Wizard 2 ขั้นตอน" ให้ตรงกับโค้ดจริง (`currentStep: 1|2`)
- ทดสอบผ่าน dev server + Playwright: เปิดทุกผังที่แก้ไข/เพิ่มใหม่ ยืนยันไม่มี console error และ layout ไม่ทับกัน
  ก่อน commit

### ไฟล์ที่แก้ไข
- `frontend/src/app/sop/sop.ts`, `frontend/src/app/help/help.html`, `CLAUDE.md`
- `frontend/src/app/changelog/changelog.ts` (entry ใหม่)

---

## 2569-09-25 — เปลี่ยนชื่อการเชื่อมต่อฐานข้อมูล "HDC" เป็น "KHD" ทั้งระบบ

### คำขอ
ต้องการแก้ไขชื่อการเชื่อมต่อฐานข้อมูล HDC ทั้งหมด ให้ใช้ชื่อ KHD แทน ทุกหน้า ทุกขั้นตอนที่มีในระบบ

### ขอบเขตที่ตรวจสอบก่อนแก้ (2 จุดเสี่ยงกว่าปกติ)
1. **Environment variables** (`HDC_DB_HOST/PORT/NAME/USER/PASSWORD`) — ตรวจพบว่าการเชื่อมต่อ HDC ที่ใช้งานจริง
   ไม่ได้มาจาก `.env` เลย แต่มาจาก 3 แถว override ใน `system_settings` (ตั้งผ่านหน้า Environment Config) —
   ต้อง migrate ข้อมูล 3 แถวนี้ไปพร้อมกัน (`UPDATE system_settings SET setting_key = REPLACE(setting_key, 'HDC',
   'KHD') WHERE setting_key LIKE 'env_HDC%'`) ไม่งั้นการเชื่อมต่อจริงจะขาดหายทันทีที่เปลี่ยนชื่อ env var ในโค้ด
2. **คอลัมน์ฐานข้อมูลถาวร 2 ตัว**: `kpi_indicators.hdc_fiscal_year`, `export_schedules.auto_sync_hdc` — ใช้
   `ALTER TABLE ... CHANGE COLUMN` (ไม่ใช่ ADD COLUMN) เพื่อ rename แบบรักษาข้อมูลเดิมไว้ครบ

### ข้อยกเว้นที่ตั้งใจไม่แก้ (ยังคงคำว่า "HDC" ไว้ตามเดิม)
- `settings.html:249` — ข้อความ "บริการของ MOPH — สำหรับบุคลากรในระบบ HDC" หมายถึงระบบ HDC จริงของกระทรวง
  สาธารณสุข (ข้อเท็จจริงภายนอก ไม่ใช่ชื่อฟีเจอร์ของเรา)
- `help.html` 2 จุด (`hdc.reports`) — ชื่อตารางจริงบนฐานข้อมูลภายนอกที่เราไม่ได้เป็นเจ้าของ
- ค่า fallback literal `'hdc'` ใน `db-remote.js`/`server.js` (ชื่อ schema จริงบนเซิร์ฟเวอร์ 192.168.88.203)
- `changelog.ts` entries เดิมและ fix-log.md เดิม (บันทึกประวัติ ห้ามแก้ย้อนหลัง) + `chospital.hdc_regist`
  (dead column ไม่มีการอ้างอิงในโค้ด) + `table_process` seed values ที่ลงท้าย `_hdc`

### วิธีแก้
Bulk rename `HDC`→`KHD`, `Hdc`→`Khd`, `hdc`→`khd` ทั่วทั้ง backend (`api/server.js` ~403 จุด, `api/db-remote.js`)
และ frontend (19 ไฟล์ ~90 identifier + UI text) พร้อมแก้ camelCase ให้สม่ำเสมอ (`syncToHDC`→`syncToKhd` ฯลฯ) —
เพิ่ม migration `CHANGE COLUMN` สำหรับ 2 คอลัมน์ข้างต้น + migration UPDATE สำหรับ `system_settings` override —
อัปเดต `CLAUDE.md` ให้ตรงกับโค้ดจริง

### ไฟล์ที่แก้ไข
- Backend: `api/server.js`, `api/db-remote.js`, `api/.env.dev`, `api/.env.dev.example`, `.env.example`,
  `docker-compose.yml`
- Frontend: `services/auth.ts`, `kpi-manage.ts`/`.html`, `help.html`, `report-compare.ts`/`.html`,
  `export-kpi.ts`/`.html`, `db-compare.ts`/`.html`, `kpi-manager.ts`/`.html`, `user-management.ts`/`.html`,
  `form-builder.ts`/`.html`, `env-config.ts`, `sop.ts`, `role-page-access.html`, `changelog.ts` (entry ใหม่)
- Docs: `CLAUDE.md`

---

## 2569-09-25 — แยก "เป้าหมาย" ออกจาก "เกณฑ์" ในตัวชี้วัด + เพิ่ม badge "สะสม" แทนข้อความแจ้งเตือน static

### คำขอ
1. ปรับหน้า "จัดการตัวชี้วัด" ปุ่ม "เพิ่มข้อมูล" ให้กำหนด "เป้าหมาย" เริ่มต้นให้ตัวชี้วัดได้ โดยไม่เกี่ยวข้องกับ
   "เกณฑ์" — เสนอให้เพิ่ม field `criterion` เก็บ "เกณฑ์" แทนที่ `target_percentage` ซึ่งควรเก็บ "เป้าหมาย" อยู่แล้ว
2. เอาข้อความ "ข้อมูลผลงานที่คีย์ในแต่ละเดือน คือข้อมูลสะสมตั้งแต่เดือนตุลาคม..." ออกจากหน้า "บันทึกผลงานตัวชี้วัด"
   แล้วเพิ่ม icon "สะสม" สำหรับตัวชี้วัดที่ตั้งค่า "ตัวชี้วัดสะสม" แทน

### สาเหตุที่ยืนยันจากการอ่านโค้ดจริง (2 รอบอ่านซ้ำยืนยันทุกจุด)
**ข้อ 1 — เป้าหมาย/เกณฑ์ปนกัน:** `target_percentage` (คู่กับ `target_condition`) ถูกใช้งานจริง 2 บทบาทที่ต่างกัน
โดยสิ้นเชิงในคอลัมน์เดียว — (ก) "เกณฑ์" สำหรับเทียบ HDC ผ่าน `GET /report-compare` และแสดงผลผ่าน `criteriaText`
pipe ทั่วทั้งระบบ (dashboard, report, form-builder, export-kpi, kpi-setup) (ข) "เป้าหมาย" ค่าเริ่มต้นที่คัดลอก
เข้า `kpi_results.target_value` ตอนตั้งปีงบใหม่/เพิ่ม KPI ให้หน่วยบริการ — modal เพิ่ม/แก้ไขตัวชี้วัดเดิมมีแค่
กล่องเดียวชื่อ "เกณฑ์" ให้กรอก `target_percentage` ไม่มีช่องตั้ง "เป้าหมาย" แยกเลย

**ข้อ 2 — ข้อความ static ไม่ตรงความจริงเสมอไป:** ระบบมีคอลัมน์ `is_cumulative` ที่แยกตัวชี้วัดเป็น 2 แบบจริงอยู่
แล้วครบวงจร (checkbox ตั้งค่าใน kpi-manage, logic คำนวณทั้ง backend/frontend) — ข้อความเดิมที่ขึ้นทุกแถวเสมอ
จึงไม่ถูกต้องสำหรับตัวชี้วัดที่ไม่ใช่สะสม (ส่วนใหญ่ของระบบ)

### วิธีแก้
**ส่วนที่ 1:** เพิ่มคอลัมน์ `criterion VARCHAR(50)` ใหม่ พร้อม backfill ค่าเดิมจาก `target_percentage` ครั้งเดียว
ตอน deploy (กัน HDC-compare ของตัวชี้วัดเดิม ~172+ ตัวพังทันที) แล้วปล่อยให้ `target_percentage` ทำหน้าที่
"เป้าหมาย" อย่างเดียวต่อไป — อัปเดตทุกจุดที่ query/แสดงผล "เกณฑ์" ให้อ่านจาก `criterion` แทน (backend 7 endpoint
+ HDC-diff logic, frontend: `criteria-text.pipe.ts`, `kpi-manage.ts`/`.html`, `dashboard.html`,
`report-compare.html`) เพิ่มกล่อง "เป้าหมาย (ค่าเริ่มต้น)" ใหม่แยกจากกล่อง "เกณฑ์" เดิมใน modal เพิ่ม/แก้ไข
ตัวชี้วัด พร้อม badge "เป้าหมาย" ในรายการหลักและคอลัมน์แยกใน Excel import preview

**ส่วนที่ 2:** ลบข้อความ static ออกจาก `dashboard.html` เพิ่ม `getCumulativeBadge()` แสดง badge "สะสม" (สีม่วง)
ต่อชื่อตัวชี้วัดที่ `is_cumulative=1` เท่านั้น — งานหลัก (backend logic, checkbox ตั้งค่า) มีอยู่แล้วทั้งหมด
เหลือแค่เพิ่ม UI แสดงผลที่ dashboard

### ไฟล์ที่แก้ไข
- `api/server.js` — migration + backfill, CRUD 3 endpoint (`/indicators`, `/indicators` POST, `/indicators/:id`
  PUT, `/indicators/bulk-import`), read-path 7 จุด, HDC-diff logic ใน `/report-compare`
- `frontend/src/app/shared/criteria-text.pipe.ts`
- `frontend/src/app/kpi-manage/kpi-manage.html` + `.ts`
- `frontend/src/app/dashboard/dashboard.html` + `.ts`
- `frontend/src/app/report-compare/report-compare.html`
- `CLAUDE.md`, `frontend/src/app/changelog/changelog.ts` (`2569.09.25.j`)

---

## 2569-09-25 — หน้า "จัดการตัวชี้วัด": ปรับตำแหน่งตัวกรองให้กระชับขึ้น

### อาการที่พบ
หลังเพิ่มตัวกรอง "หมวดหมู่หลัก"/"หน่วยงาน" (งานก่อนหน้า) พบว่า dropdown ทั้ง 2 ตัวล้นไปเป็นแถวแยกต่างหาก
(รวม 3 แถวสำหรับพื้นที่ตัวกรอง) และเหลือพื้นที่ว่างด้านขวาของแต่ละแถวจำนวนมาก ไม่กระชับ ไม่เหมาะกับการใช้งาน

### สาเหตุ
`<select>` ทั้ง 2 ตัวไม่ได้กำหนด `width` ไว้เลย — browser จะ auto-size ความกว้างของ `<select>` ตาม
`<option>` ที่ยาวที่สุดโดย default ซึ่งชื่อ "หมวดหมู่หลัก" บางรายการยาวเป็นประโยคเต็ม (เช่น
"ผู้ป่วยแบบประคับประคองได้รับการดูแลอย่างมีคุณภาพจนถึงวาระสุดท้ายของชีวิต") ทำให้ dropdown ขยายกว้างเกือบเต็ม
พื้นที่เนื้อหา ดันให้ล้นไปเป็นแถวใหม่ (flex-wrap) แทนที่จะอยู่แถวเดียวกับช่องค้นหา

### วิธีแก้
- กำหนดความกว้างคงที่ให้ `<select>` ทั้งหมด (`w-40 sm:w-48` สำหรับหมวดหมู่หลัก/หน่วยงาน/อำเภอ,
  `w-36 sm:w-44` สำหรับประเภทหน่วยบริการ) พร้อม class `truncate` ตัดข้อความยาวด้วย "..."
- ย้ายตัวกรอง "หมวดหมู่หลัก"/"หน่วยงาน" มาอยู่ก่อนปุ่มสถานะเปิด/ปิด ให้ตรงกับลำดับที่ผู้ใช้ระบุ:
  ชื่อตัวชี้วัด → หมวดหมู่หลัก → หน่วยงาน → สถานะ
- ปรับ dropdown "อำเภอ/ประเภท" ในแท็บหน่วยบริการให้ใช้ pattern ความกว้างคงที่แบบเดียวกัน เพื่อความสม่ำเสมอ
  ทั้งหน้า (แม้ยังไม่มีปัญหาล้นแถวเท่าหมวดหมู่หลัก แต่ป้องกันปัญหาเดียวกันในอนาคตถ้าชื่ออำเภอ/ประเภทยาวขึ้น)

ผลลัพธ์: ตัวกรองทั้งหมดอยู่ในแถวเดียวบนจอกว้าง (เดิม 3 แถว) ทดสอบยืนยันด้วย Playwright ที่ทั้งจอกว้าง (1440px)
และจอมือถือ (390px) ว่า layout กระชับ ไม่ล้น และการกรองยังทำงานถูกต้องเหมือนเดิม (172 → 7 แถวตามหมวดหมู่ที่เลือก)

### ไฟล์ที่แก้ไข
- `frontend/src/app/kpi-manage/kpi-manage.html` — กำหนดความกว้าง + จัดลำดับตัวกรองใหม่
- `frontend/src/app/changelog/changelog.ts` — เพิ่ม entry `2569.09.25.i`

---

## 2569-09-25 — หน้า "จัดการตัวชี้วัด": เพิ่มตัวกรองหมวดหมู่หลัก/หน่วยงาน + ข้อความแจ้งเมื่อไม่พบข้อมูล

### คำขอ
ปรับตัวกรองในหน้า "จัดการตัวชี้วัด" (เมนู "ตัวชี้วัด") ให้กรองได้ตาม ชื่อตัวชี้วัด, หมวดหมู่หลัก, หน่วยงาน, สถานะ
พร้อมเพิ่มข้อความแจ้งเมื่อค้นหา/กรองแล้วไม่พบข้อมูล

### รายละเอียด
เดิมแท็บ "ตัวชี้วัด" มีตัวกรองแค่ค้นหาชื่อ/รหัส และสถานะเปิด-ปิดเท่านั้น เพิ่ม dropdown ใหม่ 2 ตัว "หมวดหมู่หลัก"
(`main_indicator_id`) และ "หน่วยงาน" (`dept_id`) โดยดึงตัวเลือกจากรายการที่โหลดไว้อยู่แล้ว (`mainIndicators`,
`departments` — ใช้ร่วมกับ dropdown ใน modal เพิ่ม/แก้ไขตัวชี้วัด) วางคู่กับ dropdown "อำเภอ/ประเภท" ของแท็บ
หน่วยบริการที่มี pattern เดียวกันอยู่แล้ว

เพิ่มข้อความ empty-state 2 แบบแยกกันตามบริบท: **"ไม่พบข้อมูลที่ตรงกับการค้นหา/ตัวกรอง"** (เมื่อมีการค้นหา/กรอง
อยู่แต่ผลลัพธ์ว่าง) กับ **"ยังไม่มีข้อมูล"** (เมื่อ list ว่างจริงๆ ไม่มีตัวกรองใดๆ) — ใช้ได้กับทุกแท็บ (ตัวชี้วัด/
หมวดหมู่หลัก/ยุทธศาสตร์/หน่วยงาน/หน่วยบริการ) ไม่ใช่แค่แท็บตัวชี้วัด เพราะทั้ง 5 แท็บใช้ตารางเดียวกัน

ระหว่างทำ พบว่า binding ของรายการที่แสดงผล (`*ngFor`) เขียนเป็น ternary ซ้อนกัน 3 ชั้นซ้ำอยู่ 2 จุด (มือถือ +
เดสก์ท็อป) — แตกเป็น getter `currentList` ตัวเดียวในคอมโพเนนต์เพื่อไม่ต้องเขียนซ้ำเป็นจุดที่ 3 สำหรับ
empty-state ใหม่

ทดสอบยืนยันด้วย Playwright: เลือกหมวดหมู่หลักที่มีตัวชี้วัด 7 รายการ (จากทั้งหมด 172) ยืนยันว่าตารางกรองเหลือ
7 แถวถูกต้อง และทุกแถวที่แสดงตรงกับหมวดหมู่ที่เลือกจริง พร้อมยืนยันข้อความ "ไม่พบข้อมูลที่ตรงกับการค้นหา/
ตัวกรอง" แสดงถูกต้องเมื่อค้นหาคำที่ไม่มีอยู่จริง

### ไฟล์ที่แก้ไข
- `frontend/src/app/kpi-manage/kpi-manage.ts` — เพิ่ม `filterMainIndicator`/`filterDept`, `currentList` getter,
  `hasActiveFilter()`, ปรับ `applyFilter()`/`switchTab()`
- `frontend/src/app/kpi-manage/kpi-manage.html` — เพิ่ม dropdown ตัวกรอง 2 ตัว + empty-state ทั้งมือถือ/เดสก์ท็อป
- `frontend/src/app/changelog/changelog.ts` — เพิ่ม entry `2569.09.25.h`

---

## 2569-09-25 — console error "GET /settings 401" ขึ้นทุกครั้งที่เปิดแอป (แม้หน้า login)

### อาการที่พบ
```
idle-timeout.service.ts:25  GET http://localhost:3700/khupskpi/api/settings 401 (Unauthorized)
```
ขึ้นซ้ำทุกครั้งที่โหลดแอป รวมถึงตอนอยู่หน้า login เอง (ก่อนหน้านี้เข้าใจว่าเป็นแค่ log ที่เลี่ยงไม่ได้ตาม
ธรรมชาติของ browser ที่ log ทุก request ที่ fail — แต่ครั้งนี้ตรวจสอบพบว่าจริงๆ แล้วแก้ที่ root cause ได้เลย)

### สาเหตุ
`app.ts` (root component ของทั้งแอป) เรียก `idleTimeoutService.start()` ใน `ngOnInit()` โดยไม่มีเงื่อนไขใดๆ —
ฟังก์ชันนี้เรียก `GET /settings` ทันทีเพื่อดึงค่า config (idle_timeout_minutes ฯลฯ) แต่ `app.ts` ทำงานทุกครั้งที่
แอป bootstrap รวมถึงตอนอยู่หน้า login/register (ยังไม่มี token เลย) ทำให้ 401 แน่นอนทุกครั้ง

ตรวจสอบ `app.routes.ts` พบว่าทุกหน้าที่ต้อง login (dashboard, users, settings ฯลฯ) ถูกครอบด้วย
`LayoutComponent` ผ่าน `authGuard` เสมอ ไม่มีหน้าไหนหลุดออกไปนอก layout เลย และ `layout.ts` ก็เรียก
`idleTimeoutService.start()` ซ้ำอยู่แล้วใน `ngOnInit()` ของตัวเอง (มี comment เดิมอธิบายเหตุผลไว้ชัดเจนว่า
เพิ่มมาเพราะจุดใน `app.ts` ทำงานก่อน login) — สรุปคือจุดเรียกใน `app.ts` **ไม่จำเป็นเลย** เพราะ `layout.ts`
รับหน้าที่นี้ไปแล้วอย่างถูกต้อง (รันได้ก็ต่อเมื่อผ่าน `authGuard` แล้วเท่านั้น การันตี login แน่นอน)

### วิธีแก้
ลบการเรียก `idleTimeoutService.start()` (และ `stop()` ใน `ngOnDestroy`) ออกจาก `app.ts` ทั้งหมด รวมถึง import/
inject ที่ไม่ใช้แล้ว — เหลือจุดเรียกเดียวที่ `layout.ts` เท่านั้น อัปเดต comment ใน `layout.ts` ให้ตรงกับเหตุผล
ปัจจุบัน (ไม่ใช่ "เรียกซ้ำ" อีกต่อไป แต่เป็นจุดเดียวที่เรียก)

ทดสอบยืนยันด้วย Playwright: หน้า login โหลดแล้ว **ไม่มี request ไหนขึ้น 401 เลย** และหลัง login (จำลองด้วย token
จริง) เข้าหน้า dashboard แล้ว `GET /settings` ยิงสำเร็จ (200) ตามปกติ ไม่กระทบการทำงานของ Auto Logout เลย

### ไฟล์ที่แก้ไข
- `frontend/src/app/app.ts` — ลบการเรียก `idleTimeoutService` ที่ไม่จำเป็นออกทั้งหมด
- `frontend/src/app/layout/layout.ts` — อัปเดต comment ให้ตรงกับเหตุผลปัจจุบัน
- `frontend/src/app/changelog/changelog.ts` — เพิ่ม entry `2569.09.25.g`

---

## 2569-09-25 — Data Synchronization (Users): แสดง Field Diff รายคน + ตรวจสอบ/ปรับแต่ง Mapping โครงสร้างตาราง Local ↔ HDC

### คำขอ
ปรับหน้าแบบฟอร์ม "Data Synchronization — Users" ให้: (1) แสดงว่าข้อมูล user ที่ "ต่างกัน" ต่างกันตรงไหนบ้าง
(2) เพิ่มปุ่มตรวจสอบว่าโครงสร้างตาราง `users` ระหว่าง khups_kpi กับ HDC ตรงกันไหม พร้อมหน้ารายงานและหน้า
customize ได้ — เพราะข้อมูลที่ sync ไปไม่ถูกต้องจริง โดยเฉพาะ Role และ CID

### สาเหตุที่ยืนยันจากการตรวจสอบ DB จริง (read-only) ทั้ง 2 ฝั่ง
1. **CID ผิดเพราะ map ชื่อคอลัมน์ผิด ไม่ใช่ type ไม่พอ** — HDC.users มีทั้งคอลัมน์ `cid` และ `cid_hash` แยกกัน
   (Local มีแค่ `cid` เก็บค่า hash) ระบบ sync เดิม match ด้วยชื่อคอลัมน์เป๊ะเท่านั้น ทำให้ hash ของ Local ถูก
   เขียนลง `cid` ของ HDC (ผิดคอลัมน์) ส่วน `cid_hash` ที่ HDC เตรียมไว้ไม่เคยถูกแตะเลย
2. **Role ผิดเพราะข้อมูลจริงต่างกัน (ไม่ใช่โครงสร้าง)** — พบตัวอย่างจริง user `hosp00018`/`hosp10877` ที่ Local
   เป็น `user_hos` แต่ HDC เป็น `admin_ssj` — column type ตรงกันทั้ง 2 ฝั่ง เป็นข้อมูล drift ที่ต้องให้ admin
   เห็นแล้วตัดสินใจ sync เองเท่านั้น
3. `GET /users/sync-compare` เดิม `break` ที่ field แรกที่ต่างกัน ไม่เคยเก็บว่าต่างตรงไหน/ค่าอะไร ทำให้ frontend
   เห็นแค่ badge "ต่างกัน" เฉยๆ และ skip-list ไม่ครอบคลุมคอลัมน์ session/tracking (`last_seen_at` ฯลฯ) ทำให้
   user ที่ active เกือบทุกคนขึ้น "ต่างกัน" ปลอมๆ กลบ diff จริงของ role/cid

### วิธีแก้
เพิ่ม 3 แท็บในหน้าต่าง modal เดิม (ไม่สร้างหน้าใหม่):
- **เปรียบเทียบข้อมูล** — แถวที่ "ต่างกัน" ขยายดู field diff ได้ (`role: user_hos → admin_hos`)
- **ตรวจสอบโครงสร้างตาราง** — ปุ่มเทียบ `SHOW COLUMNS` ระหว่าง local/HDC เฉพาะตาราง users (reuse algorithm จาก
  `/db-compare` ที่มีอยู่แล้ว) — รายงานอย่างเดียว ไม่แก้โครงสร้าง HDC อัตโนมัติ (เพราะ HDC.users ใช้ร่วมกับระบบ
  อื่นจริง มี user มากกว่า Local หลายเท่า)
- **ตั้งค่า Mapping** — Super Admin จับคู่คอลัมน์ Local↔HDC เอง (เช่น `cid`→`cid_hash`) + เลือกคอลัมน์ที่ไม่ต้อง
  sync ได้ (default ตัดคอลัมน์ session/tracking ออกให้แล้ว) — บันทึกใน `system_settings` (widen column เป็น
  `TEXT` เพราะ JSON เกือบเต็ม `VARCHAR(255)` เดิม)

**บั๊กที่เจอระหว่างพัฒนา (แก้แล้ว):** วาง `PUT /users/sync-mapping` ไว้หลัง `PUT /users/:id` ทำให้ Express จับ
"sync-mapping" เป็นค่า `:id` แทนเงียบๆ (ได้ 500 ไม่มี error message) — แก้โดยย้ายมาก่อน wildcard route เสมอ

### ข้อจำกัดที่พบระหว่างทดสอบ
เซิร์ฟเวอร์ HDC (192.168.88.203) **unreachable จากเครื่อง dev ปัจจุบันชั่วคราว** (ยืนยันด้วย raw connection
timeout นอก API เลย ไม่เกี่ยวกับโค้ดที่แก้) ทำให้ verification step ที่ต้องการ sync จริงกับ HDC (ทดสอบว่า hash
ไปลง `cid_hash` จริง) ยังไม่สามารถทำจบได้ในรอบนี้ — ทดสอบอย่างอื่นครบแล้ว: การ์ดสรุป/แท็บทั้ง 3 render ถูกต้อง,
แท็บโครงสร้างตรวจพบ `cid_hash` diff จริงตอนที่ HDC ยังเชื่อมได้, mapping CRUD round-trip ถูกต้อง, validation
(ชื่อคอลัมน์ซ้ำ/format ผิด/exclude username-id) ทำงานถูกต้องทุกกรณี

### ไฟล์ที่แก้ไข
- `api/server.js` — endpoint ใหม่ 3 ตัว (`structure-compare`, `sync-mapping` GET/PUT) + แก้ `sync-compare`/
  `sync-to-hdc` เดิม + helper `diffTableColumns()`/`getUsersSyncConfig()` + migration widen `system_settings`
- `frontend/src/app/user-management/user-management.ts` + `.html` — modal 3 แท็บ
- `frontend/src/app/services/auth.ts` — service methods ใหม่
- `CLAUDE.md`, `frontend/src/app/changelog/changelog.ts` (`2569.09.25.f`), `frontend/src/app/help/help.html`

---

## 2569-09-25 — ปุ่ม ThaID/ProviderID: ขยายโลโก้ + ปรับสีให้เข้าธีมโลโก้

### คำขอ
ขยายขนาดโลโก้ในปุ่ม ThaID และ ProviderID ให้ใหญ่ขึ้นพอดีกับความสูงของปุ่ม (เดิมดูเล็กเมื่อเทียบกับพื้นที่ปุ่ม)
พร้อมปรับสีปุ่ม (ขอบ/ตัวอักษร/ไอคอน) ให้เป็นธีมเดียวกับสีของโลโก้แต่ละอัน

### รายละเอียด
ตรวจสอบไฟล์โลโก้จริง (`frontend/public/thaid.png`, `frontend/public/provider-id.png`) พบว่า:
- **ThaID** (1024×1024, วงกลม): พื้นหลังสีน้ำเงินกรมท่า (navy) ลายไทยสีทอง ตัวอักษร "Tha" สีขาว "iD" สีทอง
- **ProviderID** (900×391, wordmark แนวนอน): ไล่สีเขียว→เหลือง ตัวอักษร "PROVIDER" สีเขียว "iD" ไล่เขียว-ฟ้าอมเขียว

ธีมสีปุ่มเดิม (`blue` สำหรับ ThaID, `teal` สำหรับ ProviderID) เป็นสีทั่วไปที่ไม่ตรงกับโทนจริงของโลโก้เท่าที่ควร
เปลี่ยนเป็น:
- ThaID: `blue` → **`indigo`** (border/text/icon) ให้ใกล้เคียงน้ำเงินกรมท่าของโลโก้มากขึ้น
- ProviderID: `teal` → **`emerald`** ให้ใกล้เคียงสีเขียวของตัวอักษร "PROVIDER" มากขึ้น

ขยายขนาดโลโก้จาก `h-6` (24px) → `h-8` (32px) ทั้งสองปุ่ม (รวมถึงไอคอน fallback ของ ProviderID กรณีโหลดรูปไม่สำเร็จ)
พร้อมลด padding แนวตั้งของปุ่ม (`py-2`→`py-1.5`) และระยะห่างรอบข้างเล็กน้อยเพื่อชดเชยความสูงที่เพิ่มขึ้นจากโลโก้ที่ใหญ่ขึ้น
— ตรวจสอบด้วย Playwright ยืนยันว่ากล่อง login ยังคงพอดีไม่ล้นเหมือนเดิม (`scrollHeight`/`clientHeight` เพิ่มขึ้นจาก
586px เป็น 588px เท่านั้น ที่ viewport 1366×650 ซึ่งเป็น worst case ที่ทดสอบไว้)

### ไฟล์ที่แก้ไข
- `frontend/src/app/login/login.html` — ขนาดโลโก้ + สีธีมปุ่ม SSO
- `frontend/src/app/changelog/changelog.ts` — เพิ่ม entry `2569.09.25.e`

---

## 2569-09-25 — ออกแบบกล่อง "เข้าสู่ระบบ" ใหม่ ป้องกันเนื้อหาล้นออกนอกกล่อง

### อาการที่พบ
ผู้ใช้งานแจ้งว่ากล่อง "เข้าสู่ระบบ" หน้า login ไม่พอดี — ช่องกรอกชื่อผู้ใช้งาน/รหัสผ่าน หรือปุ่มต่างๆ ไม่อยู่ในกล่อง
(ล้นออกนอกขอบเขตกล่อง)

### สาเหตุ
กล่อง login (glassmorphism card) ใช้ `max-h-[90vh] overflow-y-scroll` เพื่อจำกัดความสูงบนจอที่มีพื้นที่จำกัด
แต่ระยะห่าง (padding/margin) ภายในกล่องเดิมกว้างเกินไป เมื่อรวมทุกส่วน (หัวข้อ, ปุ่มลงทะเบียน/คู่มือ, ช่องชื่อผู้ใช้งาน,
ช่องรหัสผ่าน, ปุ่มเข้าสู่ระบบ, ปุ่ม ThaID + ProviderID พร้อมสถานะเชื่อมต่อ) ความสูงเนื้อหาจริงรวมแล้วประมาณ **744px**
ในขณะที่หน้าจอแล็ปท็อปทั่วไป (เช่น 1366×768 หักลบพื้นที่แถบเครื่องมือเบราว์เซอร์แล้วเหลือใช้งานจริงประมาณ 650px)
กล่องจะถูกจำกัดไว้ที่ 90vh (~585px) ทำให้ปุ่ม ProviderID และข้อความท้ายกล่องถูกซ่อนเลยขอบล่าง ต้องเลื่อน (scroll)
ภายในกล่องเพื่อดู ซึ่งผู้ใช้จำนวนมากไม่สังเกตว่าเลื่อนได้ (scrollbar บางและจางมาก)

ตรวจสอบด้วย headless browser (Playwright) ยืนยันตัวเลขจริง: ที่ viewport 1366×650 — `scrollHeight: 744px`,
`clientHeight: 585px` (`overflowing: true`)

### วิธีแก้
ปรับลดระยะห่าง/ขนาด (padding, margin, gap) ภายในกล่องทั้งหมดให้กระชับขึ้นแบบเป็นระบบ โดยไม่เปลี่ยนโทนสี/สไตล์เดิม —
ไฟล์ `frontend/src/app/login/login.html`:
- กล่องหลัก: `p-7 sm:p-9` → `p-5 sm:p-6`, เปลี่ยน `overflow-y-scroll` → `overflow-y-auto` (แสดง scrollbar เฉพาะตอนจำเป็นจริงๆ)
- หัวข้อ "เข้าสู่ระบบ": ลด font size + margin (`text-3xl`→`text-2xl`, `mb-7`→`mb-3.5`)
- แถวปุ่มลงทะเบียน/คู่มือ: ลด padding ปุ่ม + margin
- ฟอร์ม: `space-y-5`→`space-y-3`, label `mb-2`→`mb-1`, input `py-3`→`py-2.5`, ปุ่มเข้าสู่ระบบ `py-3`→`py-2.5`
- ส่วน SSO (ThaID/ProviderID): ลด margin หัวข้อคั่น, ปุ่ม `py-3`→`py-2`, ไอคอนโลโก้ `h-7`→`h-6`, ย่อข้อความอธิบายให้สั้นลง
  พร้อมเพิ่ม `truncate` กันข้อความยาวตกบรรทัดบนจอแคบ

ตรวจสอบซ้ำด้วย Playwright ที่ viewport เดิม (1366×650) หลังแก้ไข: `scrollHeight: 586px`, `clientHeight: 586px`
(`overflowing: false`) — พอดีกล่องทั้งหมด **ไม่ต้องเลื่อนอีกต่อไป** แม้เปิดใช้งานทั้ง ThaID และ ProviderID พร้อมกัน
ทดสอบเพิ่มเติมที่ 1440×900, 390×844 (มือถือ), 320×568/760 (จอแคบสุด) ยืนยันว่าองค์ประกอบทั้งหมดยังคงอยู่ในกล่อง
ไม่ล้น ไม่ทับกัน และไม่ดูอัดแน่นจนเกินไป

### ไฟล์ที่แก้ไข
- `frontend/src/app/login/login.html` — ปรับ spacing ทั้งกล่อง login
- `frontend/src/app/changelog/changelog.ts` — เพิ่ม entry `2569.09.25.d`

---

## 2569-09-25 — แจ้งเตือน "ผู้ใช้งานใหม่รอการอนุมัติ" ค้างในระบบ กดแล้วขึ้น 404

### อาการที่พบ
Console แสดง error 2 รายการ:
```
idle-timeout.service.ts:25  GET .../khupskpi/api/settings 401 (Unauthorized)
notifications.ts:381  GET .../khupskpi/api/users/57/basic 404 (Not Found)
```

### สาเหตุ

**1. `/settings` 401 (idle-timeout)** — ไม่ใช่บั๊กใหม่ เป็นผลข้างเคียงที่รู้อยู่แล้วจากการแก้ไขก่อนหน้า (commit `4c095999`)
ที่บังคับให้ `/settings` ต้อง login ก่อนถึงจะเรียกได้ — บราวเซอร์จะ log request ที่ยิงตอนแอปเพิ่งเปิด (ก่อน login)
เป็น network error เสมอไม่ว่าแอปจะออกแบบยังไงก็ตาม ไม่กระทบผู้ใช้งานจริงเพราะระบบดึงค่าซ้ำอีกครั้งหลัง login สำเร็จแล้ว

**2. `/users/57/basic` 404 (สาเหตุหลัก ต้องแก้จริง)** — เมื่อผู้ใช้งานถูกลบออกจากระบบ (3 จุดที่มีการ `DELETE FROM users`
ใน `api/server.js`: ลบ account เก่าตอนสมัครซ้ำด้วย CID เดิม, ลบ account เก่าตอนสมัครซ้ำด้วย username เดิม, และ
`DELETE /users/:id` ที่ admin กดลบเอง) ระบบไม่เคยลบ notification "ผู้ใช้งานใหม่รอการอนุมัติ" ที่อ้างอิงถึงผู้ใช้งาน
คนนั้นไปด้วย (`notifications.created_by = <user id ที่ถูกลบ>`) ทำให้ Super Admin เห็นแจ้งเตือนค้างอยู่ในกระดิ่ง
แจ้งเตือนตลอดไป พอกดเข้าไปดูรายละเอียด frontend เรียก `GET /users/:id/basic` ด้วย id ที่ไม่มีอยู่แล้ว → 404

ตรวจสอบฐานข้อมูล dev พบว่าปัญหานี้สะสมมานานแล้ว มีแจ้งเตือนค้างลักษณะนี้อยู่ **78 รายการ** สำหรับ Super Admin
(user_id = 6) อ้างอิง user id ตั้งแต่ 55 ถึง 140 ที่ถูกลบไปแล้วทั้งหมด

### วิธีแก้

เพิ่มฟังก์ชัน `cleanupPendingApprovalNotifications(deletedUserId)` ใน `api/server.js` (ต่อจาก `sendLineToUser`):

```javascript
async function cleanupPendingApprovalNotifications(deletedUserId) {
    try {
        if (!deletedUserId) return;
        await db.query(
            "DELETE FROM notifications WHERE title = 'ผู้ใช้งานใหม่รอการอนุมัติ' AND created_by = ?",
            [deletedUserId]
        );
    } catch (e) {
        console.error('[cleanupPendingApprovalNotifications] failed:', e.message);
    }
}
```

เรียกใช้ทันทีหลัง `DELETE FROM users` ทั้ง 3 จุด:
1. `/register` — cleanup account เก่าที่ถูกปฏิเสธ (ตรวจซ้ำด้วย cid)
2. `/register` — cleanup account เก่าที่ถูกปฏิเสธ (ตรวจซ้ำด้วย username)
3. `DELETE /users/:id` — admin ลบผู้ใช้งานเอง

**เหตุผลที่ใช้ `title` เจาะจงแทน `created_by` เฉยๆ:** คอลัมน์ `created_by` ในตาราง `notifications` ถูกใช้ร่วมกับ
notification ประเภทอื่นอีกกว่า 15 จุด (KPI approve/reject/appeal, target request ฯลฯ) การลบแบบ blanket ด้วย
`created_by` อย่างเดียวจะทำลายประวัติแจ้งเตือนที่ไม่เกี่ยวข้องไปด้วย จึงต้อง match ด้วย title ที่เจาะจงเฉพาะ
"ผู้ใช้งานใหม่รอการอนุมัติ" เท่านั้น

พร้อมทำ one-off cleanup ลบแจ้งเตือนค้างเก่า 78 รายการที่มีอยู่แล้วในฐานข้อมูล (dev/prod ใช้ DB เดียวกัน
ผ่าน `host.docker.internal`) ยืนยันว่าเหลือ 0 รายการหลังลบ

### ไฟล์ที่แก้ไข
- `api/server.js` — เพิ่ม helper function + เรียกใช้ 3 จุด
- `frontend/src/app/changelog/changelog.ts` — เพิ่ม entry `2569.09.25.c`

### Commit
`e01f103f` — Fix: แจ้งเตือน "ผู้ใช้งานใหม่รอการอนุมัติ" ค้างในระบบหลังผู้ใช้งานถูกลบ ทำให้กดแล้วขึ้น 404

### Deploy
Build + redeploy ทั้ง backend และ frontend Docker container เรียบร้อย (`docker compose build --no-cache` +
`docker compose up -d` ทั้ง 2 service) ยืนยัน healthy ทั้งคู่ก่อน push ขึ้น GitHub
