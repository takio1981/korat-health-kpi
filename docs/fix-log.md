# บันทึกการแก้ไขปัญหา (Fix Log)

บันทึกสรุปการแก้ไขบั๊ก/ปัญหาที่เกิดขึ้นจริงในระบบ เรียงจากล่าสุดไปเก่าสุด — ใช้เป็นประวัติอ้างอิงประกอบ CLAUDE.md และ changelog.ts

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
