# วิดีโอคู่มือการใช้งาน (แยกตามสิทธิ์)

สร้างวิดีโอแนะนำการใช้งานทุกหัวข้อของหน้าคู่มือ แยกตามสิทธิ์ 9 สิทธิ์ ภาษาไทย พร้อมคำบรรยายใต้ภาพ
— บันทึกหน้าจอจริงด้วย Playwright บน **ฐานทดสอบ** (`khups_kpi_test_db`) + เสียงบรรยาย Microsoft Edge Neural (`th-TH-NiwatNeural`)
แล้วรวมเป็น MP4 (H.264 + AAC) ด้วย ffmpeg

## ผลลัพธ์

```
videos/
  manifest.json              ← หน้าคู่มือ (shared/help-video.ts) อ่านไฟล์นี้ — ไม่มีรายการ = ไม่แสดงปุ่ม
  public/overview.mp4        ← หัวข้อที่ไม่ต้องเข้าสู่ระบบ (ใช้ร่วมทุกสิทธิ์)
  public/register.mp4
  public/login.mp4
  <สิทธิ์>/<หัวข้อ>.mp4       ← เช่น user_hos/dashboard.mp4 — ชื่อหัวข้อ = id ใน help.ts (section-<id>)
```

- โฟลเดอร์ `videos/` **ไม่อยู่ใน git** (ไฟล์ใหญ่ + repo สาธารณะ) — nginx ของ frontend เสิร์ฟจาก volume `./videos:/usr/share/nginx/videos:ro`
  (docker-compose.yml) ที่ `/khupskpi/videos/` → deploy ไปเซิร์ฟเวอร์อื่นให้คัดลอกโฟลเดอร์ `videos/` ไปไว้ข้าง docker-compose.yml
- ตอนพัฒนา `ng serve` (:4500) เสิร์ฟโฟลเดอร์เดียวกันผ่าน configuration `devVideos` ใน `frontend/angular.json` (production build และ `ng test` ไม่รวมวิดีโอ)
- เพิ่ม/แก้วิดีโอไม่ต้อง build frontend ใหม่ (manifest ตรวจซ้ำทุกครั้งด้วย Cache-Control: no-cache)

## ขั้นตอนสร้าง

```bash
cd tools/video-guide
npm ci                                  # msedge-tts, ffmpeg-static, playwright-core
node start-backend.js                   # หน้าต่างที่ 1: backend :3710 → ฐานทดสอบ (api/.env.test) + บล็อกการเชื่อมต่อออกนอกเครื่อง
(cd ../../frontend && npx ng serve --port 4520)   # หน้าต่างที่ 2: frontend (คำขอ :3700 ถูกเปลี่ยนเป็น :3710 ระหว่างถ่าย)
node setup-data.js up                   # บัญชี test_vg_<สิทธิ์> + ผลงานตัวอย่าง (สังเคราะห์) + refresh summary
node run.js                             # ทั้งหมด (~76 เรื่อง) | --role=user_hos,admin_ssj | --only=dashboard,charts | --skip-existing
node setup-data.js down                 # ลบข้อมูลตัวอย่าง (ถ้าต้องการ)
```

- ⚠️ **ห้ามชี้ไปฐานจริง** — `setup-data.js` / `lib/db.js` / `start-backend.js` ปฏิเสธเมื่อ DB_NAME ไม่มีคำว่า "test"
- อย่ารัน `npm test` ของ api ระหว่างถ่าย (`cleanupTestUsers()` ลบผู้ใช้ `test_*` ทุกคนรวม `test_vg_*`) — รัน `setup-data.js up` ใหม่ได้เสมอ
- ช่องกรอกที่มีค่ายาวคล้ายรหัสลับ/โทเคน/อีเมล และช่องรหัสผ่าน ถูกเบลออัตโนมัติ (lib/overlay.js) เพราะฐานทดสอบมีค่าตั้งค่าจริงบางส่วน
- **ซ่อนผู้ช่วยน้องโคราชดีของระบบ** (22 พ.ย. 2569): `lib/engine.js` ตั้ง localStorage `kpi_mascot_assistant_off` (+ `_<รหัสผู้ใช้>`) ก่อนเปิดหน้า — ผู้ช่วยในระบบ (เพิ่ม 20 พ.ย.) ทักทายเมื่อเข้าหน้าใหม่ กล่องคำพูดค้างบังตารางและซ้อนกับผู้นำเสนอของวิดีโอ
- หัวข้อ 24 ศูนย์งานผู้ดูแล (`scripts/work-center.js`) เปิดหน้าต่างยืนยันอนุมัติ/ปลดล็อคแล้ว**กดยกเลิก**เสมอ (ไม่เปลี่ยนข้อมูลตัวอย่าง) — `setup-data.js` มีคู่ที่อนุมัติทั้งปีแบบเดิม 1 คู่ไว้แสดงตัวอย่างปลดล็อคเดือน
- **ผู้นำเสนอ "น้องโคราชดี"** (19 พ.ย. 2569): `build-mascot.js` ตัดตัวละครจาก `frontend/public/korat-d.png` (ภาพแบนพื้นทึบ — ลากเส้นขอบด้วยพิกัด) เป็นชิ้น ลำตัว/ศีรษะ/แขน/ตรา → `cache/mascot/`
  แล้ว `lib/overlay.js` ขยับในหน้าเว็บ: ลอยตัว เอียงศีรษะ แกว่งมือ กะพริบตา ปากขยับตามความดังของเสียง (`lib/tts.js` คำนวณซองความดัง 25 ครั้ง/วินาที)
  — ยืนมุมล่างขวา ย้ายไปอีกฝั่งเมื่อบังเป้าหมาย (กลับด้านภาพแต่ตราสำนักงานไม่กลับ), การ์ดเปิด-ปิดคลิปแสดงตัวใหญ่ | ทักทาย/ขอบคุณอัตโนมัติ (`GREETING`/`OUTRO` ใน lib/engine.js)
- เสียงบรรยาย: `th-TH-NiwatNeural` (เสียงผู้ชาย ไม่แปลง) — ทดลองแปลงเป็นโทนเด็กชายแล้ว ผู้ใช้ฟังแล้วไม่ใช้ (19 พ.ย. 2569) | เสียงหญิงไทยของบริการปฏิเสธคำพื้นฐาน (18 พ.ย. 2569)
- เสียงที่สังเคราะห์แล้วเก็บแคชใน `cache/tts-narrator/` (ตามข้อความ + ค่าเสียง) — แก้คำบรรยายแล้วสร้างใหม่เฉพาะข้อความที่เปลี่ยน
- **กรอบเน้นต้องอยู่บนสุดเสมอ:** ก่อนวาดกรอบทุกครั้ง `reveal()` ใน lib/engine.js ตรวจด้วย elementFromPoint ว่าเป้าหมายมองเห็นจริง — ปิดกล่องข้อความ/หน้าต่างที่ค้างบัง
  เลื่อนพ้นแถบที่ตรึงไว้และแถบคำบรรยาย ไม่สำเร็จ = คำเตือน `⚠ ถูกบัง` (ต้องแก้สคริปต์แล้วถ่ายใหม่) | log `⛉ แก้การบัง` = จุดที่ระบบแก้ให้แล้ว
- ⚠️ **block-net.js:** `net.connect()` ส่งอาร์กิวเมนต์เป็น array — ตัวบล็อกเดิมตรวจแบบเดียว ทำให้ SMTP รั่วออกไปได้ (พบ 19 พ.ย. 2569: อีเมลแจ้งเข้าสู่ระบบของบัญชีทดสอบถึง @example.test)
  — แก้แล้ว + `start-backend.js` ตั้ง SMTP/KHD เป็นค่าปลอม (127.0.0.1) อีกชั้น | ถ่ายเสร็จควรตรวจว่าใน backend.log ไม่มี "[Email] Sent"
- ถ่ายลงโฟลเดอร์อื่นด้วย `VG_OUT=videos-next node run.js` (ไม่กระทบไฟล์ที่ใช้งานอยู่) แล้วค่อยคัดลอกทับ `videos/` หลังตรวจ

## เพิ่ม/แก้หัวข้อ

สคริปต์อยู่ใน `scripts/` (public, dashboard, common, admin, super) — แต่ละหัวข้อ:

```js
{ id: 'charts', title: 'รายงานสถิติ', roles: 'all' | 'public' | ['super_admin'], start: '/charts',
  steps: (r, roleKey) => [ { say: 'คำบรรยาย', do: async h => { await h.click('button:has-text("…")'); } }, … ] }
```

- `r` = ข้อมูลสิทธิ์จาก `lib/roles.js` (label, short, scope, admin, central, deptLock) — ใช้ปรับคำบรรยายตามสิทธิ์
- ตัวช่วย `h`: `go(path)`, `click(t)`, `point(t, ms)` (เลื่อนเคอร์เซอร์ + กรอบเน้น), `type(t, text)`, `select(t, opt)`, `scroll(t|px)`, `wheelIn(t, dy)`, `key(k)`, `swal()`, `swalConfirm()`
  — ข้อความธรรมดา = ปุ่ม/ลิงก์ที่มีข้อความนั้น, ขึ้นต้นด้วย `#`/`.`/`[`/ชื่อแท็ก = CSS selector ของ Playwright
- ขั้นตอนที่ทำไม่สำเร็จ = แจ้งเตือน (⚠) แต่วิดีโอยังสร้างต่อ — ตรวจคำเตือนทุกครั้ง
- `node probe.js <สิทธิ์> <path>` / `node probe-all.js <สิทธิ์> /a,/b` แสดงปุ่ม/ช่องกรอกในหน้า (ใช้ตอนเขียนสคริปต์) — ใน git-bash ใส่ `MSYS_NO_PATHCONV=1`
- id หัวข้อใหม่ต้องมี `<app-help-video section="<id>" [role]="videoRole">` ใน `frontend/src/app/help/help.html`
