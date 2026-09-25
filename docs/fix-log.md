# บันทึกการแก้ไขปัญหา (Fix Log)

บันทึกสรุปการแก้ไขบั๊ก/ปัญหาที่เกิดขึ้นจริงในระบบ เรียงจากล่าสุดไปเก่าสุด — ใช้เป็นประวัติอ้างอิงประกอบ CLAUDE.md และ changelog.ts

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
