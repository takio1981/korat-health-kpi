# บันทึกการแก้ไขปัญหา (Fix Log)

บันทึกสรุปการแก้ไขบั๊ก/ปัญหาที่เกิดขึ้นจริงในระบบ เรียงจากล่าสุดไปเก่าสุด — ใช้เป็นประวัติอ้างอิงประกอบ CLAUDE.md และ changelog.ts

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
