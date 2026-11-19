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
- เสียงบรรยาย: ค่าตั้งต้น = เสียงผู้ชายทั้งคลิป — `VG_VOICES=alt node run.js` สลับเสียงหญิง/ชายทีละขั้นตอน
  (ณ 18 พ.ย. 2569 เสียงหญิงไทย `th-TH-PremwadeeNeural` ของบริการปฏิเสธคำพื้นฐานหลายคำ เช่น "ตัวชี้วัด" — เมื่อใช้ได้แล้วสร้างใหม่ด้วยคำสั่งนี้)
- เสียงที่สังเคราะห์แล้วเก็บแคชใน `cache/tts/` (ตามข้อความ) — แก้คำบรรยายแล้วสร้างใหม่เฉพาะข้อความที่เปลี่ยน

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
