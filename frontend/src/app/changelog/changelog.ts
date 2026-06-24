import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth';

@Component({
  selector: 'app-changelog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './changelog.html'
})
export class ChangelogComponent {
  private authService = inject(AuthService);
  currentRole: string = '';

  ngOnInit() {
    this.currentRole = this.authService.getUserRole();
  }

  changelog = [
    {
      version: '2569.06.24',
      date: '24 มิถุนายน 2569',
      changes: [
        { type: 'feature', text: 'จัดการตัวชี้วัด → เทียบกับ HDC: แสดงตาราง "HDC มีแต่ยังไม่มีใน Local" ด้านล่างตารางหลัก พร้อม badge นับจำนวนในแถบสรุป' },
        { type: 'feature', text: 'ปุ่ม "เพิ่มเข้าระบบ" ในตาราง HDC missing — เปิด modal เลือกหน่วยงาน + หมวดหมู่หลัก แล้ว INSERT เข้า kpi_indicators พร้อม is_active=1' },
        { type: 'improve', text: 'หลัง add สำเร็จ — ตารางหลักและ compare data รีโหลดอัตโนมัติ, รายการที่เพิ่มหายออกจาก missing section ทันที' },
        { type: 'feature', text: 'เพิ่มการเปรียบเทียบกับ HDC สำหรับ tab หมวดหมู่หลัก, ยุทธศาสตร์, หน่วยงาน, หน่วยบริการ — แต่ละ tab มีปุ่ม "เทียบกับ HDC" + summary chips + ตาราง missing + ปุ่มเพิ่มเข้าระบบ' },
        { type: 'feature', text: 'Summary chips ผล HDC Compare ทุก tab (หมวดหมู่หลัก/ยุทธศาสตร์/หน่วยงาน/หน่วยบริการ) กลายเป็นปุ่มกรองตาราง — กดเพื่อกรองเฉพาะสถานะนั้น กดซ้ำยกเลิก' },
        { type: 'feature', text: 'หมวดหมู่หลัก HDC Compare: รองรับ 2 โหมด — hdc_table (เทียบชื่อตรง + ส่วน missing local + เพิ่มจาก HDC ได้) และ coverage_fallback (วิเคราะห์จาก table_process)' },
      ]
    },
    {
      version: '2569.06.18',
      date: '18 มิถุนายน 2569',
      changes: [
        { type: 'feature', text: 'ตารางหน้าบันทึกผลงาน: ปรับขนาดคอลัมน์ได้ — ลากขอบขวาของหัวคอลัมน์ (หมวดหมู่หลัก / ชื่อตัวชี้วัด / หน่วยบริการ) เพื่อขยาย-ย่อความกว้าง ระบบจำขนาดไว้ใน localStorage อัตโนมัติ' },
        { type: 'feature', text: 'ตารางหน้าบันทึกผลงาน: เรียงลำดับข้อมูลได้ — คลิกหัวคอลัมน์ (หมวดหมู่หลัก / ชื่อตัวชี้วัด / หน่วยบริการ / เป้าหมาย / ผลงานรวม / %) เพื่อเรียงน้อย→มาก หรือ มาก→น้อย ไอคอน ▲▼ สีเหลืองแสดงคอลัมน์ที่กำลังเรียง' },
        { type: 'improve', text: 'ชื่อตัวชี้วัดในตาราง: แสดง table_process badge สีอำพัน (amber) ต่อจากชื่อ KPI — ช่วยระบุตาราง export ที่เชื่อมโยงได้ทันที' },
      ]
    },
    {
      version: '2569.06.08.c',
      date: '8 มิถุนายน 2569 (build c)',
      changes: [
        { type: 'feature', text: 'เปิดใช้งาน LINE bot auto-reply userId กลับมาใหม่ — user พิมพ์ id/help/start หรือ add bot ครั้งแรก → bot ตอบ userId เป็น message เดี่ยว (คัดลอกง่าย)' },
        { type: 'improve', text: 'เพิ่ม diagnostic log ละเอียด: event type, replyToken (12 chars), hasToken, msgCount, status response, body error 500 chars + stack trace (3 บรรทัด) — ระบุปัญหา reply API ได้แม่นยำ' },
        { type: 'improve', text: '3 scenario: (a) follow event → welcome + userId + 3-step setup (b) ผูกแล้ว + พิมพ์ id → userId เดี่ยว + สถานะ (c) ยังไม่ผูก → userId + วิธีติดต่อ admin' },
      ]
    },
    {
      version: '2569.06.08.b',
      date: '8 มิถุนายน 2569 (build b)',
      changes: [
        { type: 'improve', text: 'ยกเลิก LINE bot reply userId — bot ไม่ตอบกลับเมื่อ user พิมพ์ id/help/start ใน LINE แล้ว (LINE reply API call ไม่เสถียร debug ยาก)' },
        { type: 'improve', text: 'เก็บ webhook + line_inbox ไว้ — super_admin ยังเห็น userId ของผู้ที่ทักเข้า bot ที่ "จัดการผู้ใช้งาน" → ปุ่ม "LINE" → LINE Inbox + ผูกให้ user ได้' },
        { type: 'improve', text: 'แก้คำแนะนำใน modal "ตั้งค่า LINE แจ้งเตือนส่วนตัว" — ระบุว่าต้องติดต่อ super_admin เพื่อขอ userId จาก LINE Inbox' },
        { type: 'improve', text: 'LINE Group + per-user push notifications ยังทำงานปกติ (token + group ID ถูกใช้ง่าน push API)' },
      ]
    },
    {
      version: '2569.06.08',
      date: '8 มิถุนายน 2569',
      changes: [
        { type: 'feature', text: 'เพิ่มปุ่ม "ช่องทางติดต่อ" ใต้ version ที่ sidebar — กดเปิด modal แสดง QR Code LINE Official + ที่อยู่กลุ่มงานสุขภาพดิจิทัล สสจ.นครราชสีมา + เบอร์โทรสาร + รูปน้องโคราชดี (KORAT-D mascot)' },
        { type: 'improve', text: 'Modal contact UI: header gradient emerald→teal→cyan + 2-column layout (mascot ซ้าย, QR+address ขวา) + responsive (1 col บน mobile) + click outside ปิด + max-h 92vh กัน overflow' },
      ]
    },
    {
      version: '2569.06.06.f',
      date: '6 มิถุนายน 2569 (build f)',
      changes: [
        { type: 'improve', text: 'คู่มือการใช้งาน: อัปเดตทั้งระบบให้สอดคล้องกับฟีเจอร์ล่าสุด — เพิ่ม section "ช่องทางการแจ้งเตือน" รวม 4 ช่องทาง (Telegram + Email + LINE Group + ในระบบ) + ขั้นตอนตั้งค่า LINE Messaging API + Webhook URL + per-event toggles' },
        { type: 'improve', text: 'คู่มือ: เพิ่ม section "LINE แจ้งเตือนส่วนตัว (per-user)" — ขั้นตอน 5 steps add bot → คัดลอก userId → ตั้งค่าใน Profile Dropdown + รายการ events ที่ส่งเข้า LINE ส่วนตัว (login/อนุมัติ/ปฏิเสธ/reset password/reply กระทู้)' },
        { type: 'improve', text: 'คู่มือ: เพิ่ม "จัดการ LINE userId + LINE Inbox" ใน section จัดการผู้ใช้งาน (super_admin) — webhook flow + modal 3 ส่วน (userId/Inbox/ปุ่ม assign-archive)' },
        { type: 'improve', text: 'คู่มือ: เพิ่ม section 9.4 "จัดการตัวชี้วัด — เทียบกับ HDC + upload_excel" — Report Compare ย้ายมาที่ kpi-manage tab "ตัวชี้วัด" พร้อม chips กรอง + table_process side-by-side + upload_excel toggle + bulk action' },
        { type: 'improve', text: 'คู่มือ kpi-manager: ปรับ wizard จาก 3 ขั้น → 2 ขั้น (ขั้น 1 DB Compare + ขั้น 2 Export) — note ชี้ทาง Report Compare ย้ายไป kpi-manage' },
        { type: 'improve', text: 'คู่มือ Schedule Export: เพิ่ม LINE Group เป็นช่องทางแจ้งเตือนช่องที่ 3 (เพิ่มจาก Email + Telegram)' },
      ]
    },
    {
      version: '2569.06.06.e',
      date: '6 มิถุนายน 2569 (build e)',
      changes: [
        { type: 'improve', text: 'LINE bot auto-reply: ปรับให้รองรับ 3 scenario — (1) follow event ครั้งแรก → welcome + userId เป็นข้อความเดี่ยว (คัดลอกง่าย) + 5 ขั้นตอนตั้งค่า + ลิงก์ login (2) user ที่ผูกแล้ว → ทักทายสั้นๆ พร้อมสถานะ + พิมพ์ "id" เพื่อดู userId ใหม่ (3) user ที่ยังไม่ผูก → ส่ง userId + คู่มือ + รายการ event ที่จะได้รับแจ้ง' },
        { type: 'improve', text: 'LINE bot รองรับ keyword: userid / id / ไอดี / รหัส / เริ่ม / start / /start / help / ? → ตอบ userId อีกครั้ง (กัน user ลืม)' },
        { type: 'improve', text: 'LINE bot ส่ง userId เป็น text เดี่ยวบรรทัดเดียว → user แตะค้างคัดลอกได้ทันทีในแอป LINE (UX ดีกว่ารวมข้อความ)' },
      ]
    },
    {
      version: '2569.06.06.d',
      date: '6 มิถุนายน 2569 (build d)',
      changes: [
        { type: 'feature', text: 'LINE Webhook: รับ event เมื่อ user ทักเข้า bot — POST /webhook/line (public, verify signature ด้วย channel_secret) → ดึง profile (display name + รูป) → INSERT line_inbox + auto-reply userId กลับให้ user' },
        { type: 'feature', text: 'User Management: ปุ่ม "LINE" (super_admin only) ในคอลัมน์จัดการ — สีเขียวมรกต + dot indicator ถ้าผูกแล้ว — คลิกเปิด modal จัดการ' },
        { type: 'feature', text: 'LINE Modal ใน User Management: แสดง userId ปัจจุบัน + input แก้ + toggle เปิด-ปิดแจ้งเตือน + LINE Inbox รายการล่าสุดจากผู้ทักเข้า bot (รูป/ชื่อ/userId/message/เวลา) + ปุ่ม "วางใส่ช่อง" "ผูกทันที" "ซ่อน" + ปุ่มทดสอบ' },
        { type: 'feature', text: 'Backend endpoints (super_admin only): GET /admin/line-inbox + POST /admin/line-inbox/:id/assign + POST /admin/line-inbox/:id/archive + PUT /admin/users/:id/line + POST /admin/users/:id/line/test' },
        { type: 'feature', text: 'Settings: เพิ่ม Channel Secret (สำหรับ webhook verify) + แสดง Webhook URL พร้อมคัดลอกไปตั้งที่ LINE Developers Console' },
        { type: 'improve', text: 'Auto-migration: line_inbox table + users.line_user_id UNIQUE index (กัน userId ผูกซ้ำกับหลาย user)' },
        { type: 'improve', text: 'GET /users ส่ง line_user_id + notif_line_enabled ด้วย — frontend แสดง dot indicator บนปุ่ม LINE ได้ทันที' },
      ]
    },
    {
      version: '2569.06.06.c',
      date: '6 มิถุนายน 2569 (build c)',
      changes: [
        { type: 'feature', text: 'LINE แจ้งเตือนรายบุคคล: เพิ่ม users.line_user_id + notif_line_enabled per-user — แต่ละคนกรอก LINE userId (Uxxxxx...) + toggle เปิด-ปิดเอง ผ่าน Profile Dropdown → "ตั้งค่า LINE แจ้งเตือนส่วนตัว"' },
        { type: 'feature', text: 'Events ที่ส่ง LINE ส่วนตัวให้ user: 1) Login alert (ทุก role ที่ตั้ง userId) 2) อนุมัติบัญชี 3) ปฏิเสธบัญชี (พร้อมเหตุผล) 4) Reset password (รหัสชั่วคราว) 5) มีคนตอบกระทู้ของตัวเอง' },
        { type: 'feature', text: 'Backend: helper sendLineToUser(userId, msg) — fire-and-forget + check master toggle + per-user opt-in + ใช้ channel access token เดียวกันกับ group + endpoints GET/PUT /me/line + POST /me/line/test' },
        { type: 'improve', text: 'Validation: line_user_id ต้องเป็น U + 32 hex chars (regex /^U[a-f0-9]{32}$/i) — frontend + backend ตรวจสอบ' },
      ]
    },
    {
      version: '2569.06.06.b',
      date: '6 มิถุนายน 2569 (build b)',
      changes: [
        { type: 'improve', text: 'Settings change LINE notify: ส่งเฉพาะ key ที่ค่าเปลี่ยนจริงจากเดิม + แสดง before → after — frontend POST 30+ keys ทุกครั้งที่กด "บันทึก" ก็ส่ง LINE เฉพาะที่ user แก้จริง (กัน LINE Group noise) + ถ้าไม่มีอะไรเปลี่ยน ก็ไม่ส่งเลย' },
      ]
    },
    {
      version: '2569.06.06',
      date: '6 มิถุนายน 2569',
      changes: [
        { type: 'feature', text: 'LINE Group แจ้งเตือนเพิ่มเติม 4 event: 1) Admin login (super_admin / admin_ssj) แสดง username + role + IP + UA + เวลา 2) ผลการ Backup (manual + scheduled — สำเร็จ/ล้มเหลว) 3) ผลการ Restore (สำเร็จ/ล้มเหลว + target_db + tables verified) 4) การแก้ไข Settings (mask sensitive values + คนกระทำ + key ที่เปลี่ยน) 5) การ CRUD ตัวชี้วัด (create/update/delete + upload_excel toggle/bulk) — diff สั้นๆ' },
        { type: 'feature', text: 'Settings UI: เพิ่มกล่อง "เลือก Event ที่จะแจ้ง LINE Group" 5 checkbox per-category (admin_login, backup, restore, settings_change, indicator_change) — default เปิดทุก event ปิดอันที่ไม่ต้องการได้ ไม่กระทบ Email/Telegram' },
        { type: 'improve', text: 'Backend: helper notifyLineAction(category, message) + cache 60s + fire-and-forget — ไม่ block response เมื่อ LINE ช้า + safe (try/catch) ไม่ทำให้ endpoint ล้มเหลวถ้า LINE error' },
        { type: 'feature', text: 'Auto-migration settings keys ใหม่: notif_line_admin_login, notif_line_backup, notif_line_restore, notif_line_settings_change, notif_line_indicator_change (default true)' },
      ]
    },
    {
      version: '2569.06.05.c',
      date: '5 มิถุนายน 2569 (build c)',
      changes: [
        { type: 'feature', text: 'LINE Group ครอบคลุมทุก notification: Backup schedule, Audit-digest (สรุปการบันทึก KPI ประจำวัน), Feedback กระทู้ใหม่ + reply, ผู้สมัครใหม่ — ทุกที่ที่เคยส่ง Telegram + Email ตอนนี้ส่ง LINE ด้วย' },
        { type: 'improve', text: 'Backup schedule UI: เพิ่มกล่อง "LINE Group" + sub-toggle แจ้งเมื่อสำเร็จ/ล้มเหลว แยกอิสระจาก Telegram/Email + badge LINE ในตาราง schedule list' },
        { type: 'improve', text: 'Audit-digest UI: เพิ่ม checkbox "ส่งทาง LINE Group" — bind กับ kpi_audit_digest_line setting' },
        { type: 'feature', text: 'Backend: notify_line + notified_line columns ใน backup_schedules + backup_schedule_logs + new setting kpi_audit_digest_line + auto-migration' },
      ]
    },
    {
      version: '2569.06.05.b',
      date: '5 มิถุนายน 2569 (build b)',
      changes: [
        { type: 'feature', text: 'Notification: เพิ่มช่องทาง LINE Group (LINE Messaging API) — รองรับ Channel Access Token + multi Group ID (คั่นด้วย comma) — ทำงานร่วมกับ Telegram + Email ที่มีอยู่' },
        { type: 'feature', text: 'Settings UI: เพิ่ม toggle "LINE Group" + การ์ดตั้งค่า Channel Access Token + Group ID + ปุ่มทดสอบ + คำแนะนำขั้นตอนสร้าง LINE bot' },
        { type: 'feature', text: 'Export Schedule: เพิ่ม checkbox "ส่ง LINE Group รายงานสรุป" + badge แสดงในตาราง schedule list + เก็บ notified_line ใน export_schedule_logs' },
        { type: 'feature', text: 'Error Monitoring: alert ส่ง LINE Group นอกเหนือจาก Telegram เมื่อพบ error ใหม่/fatal (1 ครั้ง/error/ชม cooldown เหมือนเดิม)' },
        { type: 'feature', text: 'Backend endpoints: POST /test-line สำหรับทดสอบส่งข้อความ + auto-migration ใหม่ — export_schedules.notify_line, export_schedule_logs.notified_line + system_settings keys (line_channel_token, line_group_id, notif_line_enabled)' },
        { type: 'fix', text: 'kpi-manage chips HDC ↔ Local: เลข "ชื่อต่างกัน" ไม่ตรงกับตาราง — เกิดจาก backend นับ HDC-centric (HDC duplicate ใน table_process ทำให้นับซ้ำ) — แก้โดยคำนวณ chips ใหม่ฝั่ง frontend (Local-centric)' },
      ]
    },
    {
      version: '2569.06.05',
      date: '5 มิถุนายน 2569',
      changes: [
        { type: 'improve', text: 'ย้ายระบบ "เทียบชื่อตัวชี้วัด HDC ↔ Local" จากหน้า kpi-manager (Step 1 wizard) → หน้า "จัดการตัวชี้วัด" (kpi-manage) — เป็นส่วนหนึ่งของ tab "ตัวชี้วัด" ใช้งานร่วมกับการ CRUD ปกติได้เลย' },
        { type: 'feature', text: 'kpi-manage: ปุ่ม "เทียบกับ HDC" + summary chips (ตรงกัน/ต่างกัน/ไม่มีใน HDC/HDC inactive) ใช้กรองตาราง + คอลัมน์ใหม่ "HDC ↔ Local" status + คอลัมน์ upload_excel toggle + inline diff ใต้ชื่อตัวชี้วัด (เมื่อชื่อต่าง) + ปุ่ม Sync ราย row + banner "ปิด N ตัว" bulk action สำหรับ HDC inactive' },
        { type: 'improve', text: 'kpi-manager wizard: ลดเหลือ 2 ขั้น (จาก 3) — ขั้น 1: เทียบโครงสร้าง (DB Compare), ขั้น 2: Export ตารางรายตัวชี้วัด — workflow สั้นลง โฟกัสที่ schema + data เท่านั้น' },
        { type: 'feature', text: 'kpi_indicators: เพิ่มคอลัมน์ upload_excel (TINYINT) — 0=ส่งออกอัตโนมัติได้ (default), 1=ข้าม (อัปโหลด Excel มือเอง) ใช้กรณี HDC report ถูก deactivate หรือต้องการ override + index พร้อม auto-migration' },
        { type: 'feature', text: 'Report Compare (Step 1): เพิ่มคอลัมน์ "upload_excel" toggle ในตาราง + แสดงสี HDC inactive (rose) แทน gray + warning banner "พบ HDC report inactive แต่ Local ยังเปิดส่งออก" พร้อมปุ่ม "ปิด N ตัว" bulk action — เสนอตั้ง upload_excel=1 อัตโนมัติ' },
        { type: 'improve', text: 'Export pipeline: performKpiExport + checkKpiChanges กรอง upload_excel=1 ออก — ตัวชี้วัดที่ตั้งเป็น "อัปโหลดเอง" จะไม่ถูก export ทั้งใน Step 3 (manual) และ schedule อัตโนมัติ' },
        { type: 'feature', text: 'Backend endpoints ใหม่ 2 ตัว: PUT /indicators/:id/upload-excel (toggle 1 ตัว) + POST /indicators/bulk-upload-excel (batch — ใช้กับปุ่ม bulk จาก Report Compare)' },
      ]
    },
    {
      version: '2569.06.04',
      date: '4 มิถุนายน 2569',
      changes: [
        { type: 'feature', text: 'Monitor การบันทึก: เพิ่มมุมมอง "รายหน่วยบริการ" (sub-tab ใน "สถานะการบันทึก") — ดูว่า รพ. ใดค้างบันทึกตัวชี้วัดกี่ตัว เรียงจากค้างมากสุดก่อน + drill-down modal ดูรายตัวชี้วัดที่ค้าง พร้อมเป้าหมาย + role-based filter (admin_ssj เห็นเฉพาะ dept ตัวเอง)' },
        { type: 'feature', text: 'Backend endpoints ใหม่ 2 ตัว: `/report/recording-status/by-hospital` (รวม recorded/missing/% ต่อหน่วยบริการ) + `/report/recording-missing/by-hospital/:hospcode` (ดึงรายตัวชี้วัดที่ค้าง) — ใช้ CTE + chospital JOIN ครบ hosname/distname/hostype' },
      ]
    },
    {
      version: '2569.06.02',
      date: '2 มิถุนายน 2569',
      changes: [
        { type: 'improve', text: 'kpi-manager: แยก wizard เป็น 3 ขั้นชัดเจน (เดิม 2 ขั้น) — 1) เทียบชื่อตัวชี้วัด (Report Compare) 2) ส่งออกข้อมูล KPI ↔ HDC (DB Compare schema 2 ทาง) 3) Export ข้อมูล KPI ลงตารางรายตัวชี้วัด (data + sync HDC + scheduler) — workflow เรียงลำดับชัดเจน ไม่ต้องย้อนไปย้อนมา + เปลี่ยนสีปุ่ม Next ตามปลายทาง' },
        { type: 'feature', text: 'Charts/Reports: เพิ่มแท็บ "สถานะการบันทึก" (super_admin + admin_ssj) — monitor ว่าตัวชี้วัดใดมีการบันทึก/ไม่มี คิดเป็น % ของ รพ. ทั้งหมด พร้อมสรุป ครบ/บางส่วน/ยังไม่บันทึก + progress bar + badge status (ครบ/บางส่วน/ยังไม่บันทึก) + Excel export' },
        { type: 'improve', text: 'รายงาน 4 หัวข้อ (รายข้อตัวชี้วัด/หน่วยบริการ/อำเภอ/ปีงบ): เรียงจาก %สำเร็จ มาก→น้อย + แก้คอลัมน์ %สำเร็จของ by-indicator ให้ใช้ achievement_pct (count-based: passed/with_target × 100) แทนการคำนวณจาก total_actual/target_value (sum ratio) — ทั้งใน desktop table และ mobile card' },
        { type: 'feature', text: 'Backend: endpoint ใหม่ `/report/recording-status` คำนวณ % การบันทึกต่อตัวชี้วัด (recorded_hospitals / total_hospitals) พร้อม summary (ครบ/บางส่วน/ยังไม่บันทึก/% เฉลี่ย) + role-based filtering (admin_ssj เห็นเฉพาะ dept ตัวเอง)' },
        { type: 'feature', text: 'คู่มือการใช้งาน: filter หัวข้อตาม role ที่ login — แสดงเฉพาะส่วนที่สิทธิ์ของผู้ใช้ใช้งานได้จริง (super_admin เห็นครบ, admin_ssj เห็น users/kpi-manager/audit-digest, user_* เห็นเฉพาะส่วนทั่วไป) + ป้ายชื่อ role แบบอ่านง่าย + นับจำนวนหัวข้อที่เห็น' },
        { type: 'improve', text: 'คู่มือ kpi-manager: เปลี่ยนป้าย Tab 1/2/3/4 → ขั้น 1/2/3 ให้ตรงกับ wizard ใหม่ + เรียงลำดับใหม่ (Report Compare ขึ้นเป็นขั้น 1)' },
      ]
    },
    {
      version: '2569.06.01',
      date: '1 มิถุนายน 2569',
      changes: [
        { type: 'feature', text: 'Error Monitoring: เพิ่มหน้า "Error Logs" (super_admin) รวบ error จาก backend + frontend + HTTP 5xx ทั้งหมด — มี fingerprint dedup + count + stats + Telegram alert อัตโนมัติ (1 ครั้ง/error/ชม) + แก้แล้วทำ mark resolved' },
        { type: 'feature', text: 'Error capture frontend: GlobalErrorHandler + HTTP interceptor — ส่ง error ทั้ง uncaught template/RxJS และ HTTP 5xx ไปยัง backend อัตโนมัติ (throttle 1 ครั้ง/error/นาที กัน loop)' },
        { type: 'feature', text: 'Integration tests (jest + supertest) — login (5 cases), permissions enforcement (7 cases), error monitoring (4 cases) ครอบคลุม critical paths — ใช้ DB แยก khups_kpi_test_db ไม่กระทบ production' },
        { type: 'improve', text: 'server.js refactor: export app + เปิด port เฉพาะตอน CLI (require.main === module) — รองรับ supertest โดยไม่เปิด HTTP จริง' },
        { type: 'feature', text: 'UX: เพิ่ม Toast notification (ngx-toastr) — บันทึก/อนุมัติ/อัพเดท ไม่บล็อก user ด้วย Swal modal อีก เปลี่ยนเป็นแถบเล็กมุมบนขวาที่หายเอง 3 วินาที' },
        { type: 'feature', text: 'UX: Command Palette (Cmd+K / Ctrl+K) — กดปุ่ม "ค้นหา..." บน header หรือกด Ctrl+K ที่หน้าใดก็ได้ → ค้นหาเมนู + กระโดดทันที (รองรับ ↑↓ + Enter + ESC)' },
        { type: 'feature', text: 'UX: บันทึก View (Filter Preset) — กดปุ่ม "View" ในแถบตัวกรอง dashboard → บันทึก filter ปัจจุบันด้วยชื่อ แล้วเรียกใช้ภายหลังคลิกเดียว (เก็บใน browser, สูงสุด 20 view ต่อ user)' },
        { type: 'feature', text: 'UX: FAB เพิ่มตัวชี้วัด บน mobile dashboard (ปุ่มลอยมุมขวาล่าง) — ใช้งานสะดวกขึ้นบนมือถือ' },
        { type: 'feature', text: 'Shared components: SkeletonTable / EmptyState / CommandPalette ใช้เป็น pattern ขยายไปทุกหน้าได้' },
        { type: 'improve', text: 'ToastService wrapper รอบ ngx-toastr — มี success/info/warning/error/undo (ปุ่มยกเลิก toast) + theme mint ตรงกับระบบ' },
      ]
    },
    {
      version: '2569.05.29',
      date: '29 พฤษภาคม 2569',
      changes: [
        { type: 'feature', text: 'เมนูจัดการผู้ใช้งาน: เพิ่ม badge ตัวเลขสีแดงแสดงจำนวน user ที่ลงทะเบียนใหม่และรออนุมัติ (ตาม scope ของ admin) — อัพเดททันทีหลัง approve/reject' },
        { type: 'improve', text: 'Dashboard: ปิดปุ่ม "โหลดข้อมูลทั้งหมด" — ป้องกันการโหลดข้อมูลทั้งระบบพร้อมกันที่ทำให้ช้า/หน่วง ผู้ใช้ต้องเลือกตัวกรองแล้วกด "ค้นหา" เสมอ' },
        { type: 'improve', text: 'Modal เพิ่มตัวชี้วัด: ตัวกรองหมวดหมู่หลักเปลี่ยนเป็น dropdown multi-select checkbox + "เลือกทั้งหมด" ให้เหมือนตัวกรองอื่น' },
        { type: 'fix', text: 'Restore ค้าง/502 Bad Gateway บน production — backend crash เพราะ stdin EPIPE ไม่มีตัวจับ (mysql จบก่อน) + progressMonitor regex บล็อก event loop: จับ stdin error + นับ bytes อย่างเดียว + เพิ่ม process safety net (unhandledRejection/uncaughtException) กัน backend ล่มจาก background job' },
        { type: 'fix', text: 'Restore สิทธิ์ database — เพิ่ม script database/grant-restore-privileges.sql (GRANT ALL PRIVILEGES บน khups_kpi_db% แก้ ERROR 1044/1142 ตอน CREATE/ALTER database ใหม่)' },
        { type: 'improve', text: 'Modal เพิ่มตัวชี้วัด: แปลง dropdown ทั้ง 4 (อำเภอ/ประเภท/หน่วยบริการ/หน่วยงาน) เป็น multi-select checkbox + "เลือกทั้งหมด" แบบเดียวกับตัวกรองหน้า dashboard — เลือกหน่วยบริการปลายทางหลายแห่ง + กรองหลายหน่วยงานพร้อมกัน บันทึกครั้งเดียวไปทุกหน่วย (ข้ามตัวที่มีอยู่แล้วอัตโนมัติ)' },
        { type: 'feature', text: 'Modal เพิ่มตัวชี้วัด: เพิ่มความยืดหยุ่น — กรองหมวดหมู่แบบ chip หลายหมวด/เลือกทั้งหมด + เพิ่มตัวชี้วัดให้หลายหน่วยบริการพร้อมกันในครั้งเดียว' },
        { type: 'feature', text: 'จัดการสิทธิ์การแก้ไขราย user: super_admin กดปุ่ม "สิทธิ์" ในหน้าจัดการผู้ใช้งาน → กำหนดได้ว่าผู้ใช้แต่ละคนแก้ผลงาน (actual) / เป้าหมาย (target) ได้หรือไม่ — modal พร้อม preset (ผลงานอย่างเดียว / เป้าหมาย+ผลงาน / ดูอย่างเดียว)' },
        { type: 'feature', text: 'Backend enforcement per-user: คอลัมน์ can_edit_actual/can_edit_target ใน users + cache 60s + PUT /users/:id/permissions + GET /my-permissions — /update-kpi preserve ค่าเดิมจาก DB ถ้าผู้ใช้ไม่มีสิทธิ์แก้ field นั้น (super_admin ข้ามเสมอ)' },
        { type: 'fix', text: 'แก้ Illegal mix of collations error — เปลี่ยนจากตาราง role_permissions (JOIN กับ users คนละ collation) เป็นคอลัมน์ใน users โดยตรง ไม่ต้อง JOIN ข้ามตาราง' },
        { type: 'improve', text: 'Dashboard: input เป้าหมาย/ผลงานรายเดือน disable ตามสิทธิ์ user (canEditTarget/canEditActual) — ถ้าไม่มีสิทธิ์แสดงเป็นค่า readonly + ซ่อนปุ่มแก้ไขเป้าหมาย' },
      ]
    },
    {
      version: '2569.05.25',
      date: '25 พฤษภาคม 2569',
      changes: [
        { type: 'fix', text: 'Restore ล้มเหลวบน MariaDB 10.11+ — "mysql exit 1: Deprecated program name" — เพราะ warning ของ MariaDB ถูกเข้าใจผิดเป็น error: เปลี่ยน MYSQL_BIN เป็น auto-detect (mariadb > mysql) + cleanStderr filter benign warnings (deprecated, SSL, password warning) ออกจาก error message' },
        { type: 'fix', text: 'Restore: เพิ่ม --skip-ssl-verify-server-cert ทุก spawn → กัน warning "insecure passwordless login" ของ MariaDB 10.11+' },
        { type: 'fix', text: 'Restore replace mode: แยก DROP DATABASE + CREATE DATABASE เป็น 2 statement แทน multi-statement ใน -e (MariaDB บาง version handle ผิด)' },
        { type: 'improve', text: 'Restore: ถ้าเจอ error 1044/1045 (Access denied) → แสดง hint "user ขาดสิทธิ์ CREATE/DROP DATABASE — ต้องใช้ root หรือ GRANT CREATE,DROP ON *.*"' },
        { type: 'improve', text: 'buildConnectArgs() helper รวม connection args + SSL flag — ใช้ใน listDbTables, countTableRows, verifyBackupPrivileges, test connection, backup, restore เพื่อความ consistent' },
      ]
    },
    {
      version: '2569.05.24',
      date: '24 พฤษภาคม 2569',
      changes: [
        { type: 'fix', text: 'Login fail/blocked เมื่อหลาย users ใช้ผ่าน NAT/proxy IP เดียวกัน — เปลี่ยน loginLimiter keyGenerator เป็น IP+username (counter แยกต่อ user) + skipSuccessfulRequests กัน user ที่จำรหัสได้ติด limit' },
        { type: 'fix', text: 'apiLimiter blocked dashboard เมื่อ 100+ users share IP — เปลี่ยนเป็น per-user (parse JWT userId) แทน per-IP, 600 req/min/user, skip backup/export/sync/monitor endpoints' },
        { type: 'improve', text: 'DB Pool: connectionLimit 50→150, queueLimit 200→500, maxIdle 10→30 — รองรับ 100+ concurrent users + scheduler ทำงานพร้อมกันโดยไม่ติด queue' },
        { type: 'improve', text: 'Session cache TTL 30s→2min + last_seen throttle 1min→3min → ลด DB SELECT/UPDATE 50-80% ในระบบที่มี active users' },
        { type: 'improve', text: 'Performance indexes: เพิ่ม composite indexes บน users(username,cid), chospital(distid), kpi_results(indicator_id,year_bh,hospcode), kpi_summary, notifications(user_id,is_read)' },
        { type: 'improve', text: 'docker-compose: เพิ่ม resource limit (CPU 2→4 cores, RAM 1GB→2.5GB), Node heap 2048MB, env DB_POOL_* configurable, นั่งกัน OOM ตอน peak load' },
        { type: 'improve', text: 'DB pool monitor: log สถานะ pool ทุก 1 นาที เฉพาะเมื่อ usage > 70% หรือมี queue (low overhead) + auto cleanup session/last_seen cache ทุก 5 นาที กัน memory leak' },
        { type: 'improve', text: '.env.example: เพิ่มคำแนะนำ MariaDB tuning (max_connections=250, innodb_buffer_pool_size, wait_timeout) + DB_POOL_* env vars' },
      ]
    },
    {
      version: '2569.05.19',
      date: '19 พฤษภาคม 2569',
      changes: [
        { type: 'feature', text: 'Backup Manager (Phase 1): ระบบสำรอง/กู้คืน MySQL/MariaDB แบบครบวงจร — Connection Manager (multi-DB), Manual Backup (mysqldump + gzip streaming + SHA-256 checksum), Files list/download/restore/delete, Restore 2 modes (new_db/replace + auto-backup ก่อน + confirm "RESTORE")' },
        { type: 'feature', text: 'Backup Manager (Phase 2): Schedule อัตโนมัติ — เลือกวัน+เวลา+retention+compress, Notification Email/Telegram (success/failure แยกได้), Run Now + View Logs + Test Notification, atomic lock กัน double-run' },
        { type: 'feature', text: 'Backup Manager (Phase 3): Cloud Upload (Google Drive OAuth 2.0 ใช้พื้นที่ Gmail 15GB ฟรี) + Monitor Dashboard (DB size, pool status, top tables, slow queries, disk usage, schedules summary, recent errors, auto-refresh 10s)' },
        { type: 'feature', text: 'Backup Logs: เขียน .backup_log.txt + .restore_log.txt ทุกครั้ง — มีรายการตารางครบ + INSERTs count + verification COUNT(*) หลัง restore (เทียบ source vs target)' },
        { type: 'feature', text: 'Privilege Check: ปุ่ม fa-shield-halved ในหน้า Connections — ตรวจ SHOW GRANTS + ทดสอบ SELECT จากตารางจริง ก่อน backup กัน schema-only dump' },
        { type: 'feature', text: 'แจ้งเตือนการบันทึก KPI (Daily Digest): ระบบบันทึก audit ทุกครั้งที่ user save (3 ช่องทาง — update-kpi/dynamic-data/sub-results) → ส่งสรุปประจำวันถึง super_admin (Email+Telegram) เพื่อแจ้งให้อัพเดทตาราง Export' },
        { type: 'feature', text: 'KPI Audit Digest UI: settings (เวลาส่ง/ขั้นต่ำ/channels), stats cards (วันนี้/ยังไม่แจ้ง/ทั้งหมด/ผู้ใช้), Last Digest panel, ตารางรายการบันทึก 300 records (filter เฉพาะที่ยังไม่ได้แจ้ง), ปุ่ม "ส่ง Digest ทันที" (test)' },
        { type: 'fix', text: 'Timezone Asia/Bangkok (UTC+7): scheduler ทั้งหมด (Export + Backup + KPI Audit Digest) ใช้ Intl.DateTimeFormat กับ timeZone:"Asia/Bangkok" — ไม่ขึ้นกับ process timezone (เดิม schedule ตั้ง 02:00 รันที่ 09:00 ไทยใน Docker UTC)' },
        { type: 'fix', text: 'Backup/Restore timestamps: เปลี่ยน new Date().toISOString() → bangkokTimestamp() helper — ชื่อไฟล์, ชื่อ DB target, log timestamps ใช้เวลาไทย UTC+7 จริง' },
        { type: 'fix', text: 'Restore table count: นับซ้ำ (CREATE TABLE + comment "Table structure" = 2x) → ใช้ Set dedupe + verify จาก INFORMATION_SCHEMA.TABLES ของ target DB จริง' },
        { type: 'fix', text: 'Backup mysqldump options: ลบ --column-statistics (MySQL 8 only) + --events (privilege) → MariaDB compatible — เดิมไฟล์ backup ว่างเปล่า exit 0 ผ่าน' },
        { type: 'fix', text: 'Backup log encoding: เปลี่ยน [✓]/[V]/[!]/[✗] → ASCII [OK]/[VW]/[!!]/[XX] — เปิดด้วย Windows Notepad/Editor ไม่เป็น "â"' },
        { type: 'improve', text: 'Backup file naming: เพิ่ม Bangkok timestamp + sanitize — รูปแบบ "<db>_<connName>_2026-05-19T14-09-30.sql.gz"' },
        { type: 'improve', text: 'Realtime progress: backup + restore แสดง progress card (bytes dumped + table count + current table + % bar) — poll ทุก 1 วินาทีจน job เสร็จ' },
        { type: 'improve', text: 'Docker: เพิ่ม mariadb-client + gzip + tzdata + /backups volume mount + TZ=Asia/Bangkok ใน docker-compose + Dockerfile' },
      ]
    },
    {
      version: '2569.05.12',
      date: '12 พฤษภาคม 2569',
      changes: [
        { type: 'feature', text: 'kpi-manage: เพิ่มแถบเมนู "หน่วยบริการ" (5th tab) — CRUD chospital (super_admin) | filter อำเภอ+ประเภท | endpoint POST/PUT/DELETE /hospitals ตรวจ user/results อ้างอิง ก่อนลบ' },
        { type: 'feature', text: 'SSO Login (ProviderID MOPH + ThaID DGA) — OAuth 2.0 Authorization Code flow + form กรอก config OAuth ใน Settings (client_id, secret, auth/token/userinfo URLs, redirect_uri, scope) | match user ด้วย cid SHA-256 | ปฏิเสธ user ใหม่ ต้องลงทะเบียนก่อน' },
        { type: 'fix', text: 'Sync to HDC modal: checkbox "เลือกทั้งหมด" state สลับกัน — เพิ่ม [checked]+[indeterminate] binding จาก getter' },
        { type: 'improve', text: 'Login/Register poll SSO toggle ทุก 3s + force CD ผ่าน NgZone+detectChanges → ตอบสนอง toggle ทันทีโดยไม่ต้องคลิก/refresh' },
        { type: 'feature', text: 'score_option sync เป็น % เข้า kpi_results.actual_value — เลือก "ดีมาก = 100" → ระบบ sync ค่า 100 (ไม่ใช่ label) → dashboard/chart/report คำนวณได้ตรง' },
        { type: 'improve', text: 'Dashboard Dynamic Form Modal — เปลี่ยนเป็น Grid 6 คอลัมน์ × 2 แถว (เห็น 12 เดือนพร้อมกัน) แทนตารางแนวยาว' },
        { type: 'improve', text: 'Modal grid responsive: lg=6cols / md=4cols / sm=3cols / mobile=2cols — card สีเขียวเมื่อมีข้อมูล / เหลืองเมื่อ edit เปลี่ยน' },
        { type: 'fix', text: 'NG0103 Infinite Change Detection: parseFieldOptions JSON.parse new array → cache _parsedOptionsCache Map<string, any[]> ใน dashboard' },
        { type: 'fix', text: 'kpi_form_fields.field_type ENUM ขาด score_option → Data truncated error → เพิ่ม ALTER TABLE MODIFY COLUMN ใน auto-migration' },
        { type: 'fix', text: 'Sticky thead form modal z-index ต่ำเกิน → row ทับ header เวลา scroll → ปรับ z-30/z-40 + bg-purple-700 ทุก th cells' },
      ]
    },
    {
      version: '2569.05.08',
      date: '8 พฤษภาคม 2569',
      changes: [
        { type: 'feature', text: 'Form Builder: เพิ่ม field type "ตัวเลือกพร้อม %" (score_option) — กำหนดป้าย+ค่า% เช่น "ดีมาก = 100" → backend สร้างคอลัมน์ <field>_pct DECIMAL อัตโนมัติ + auto-compute เมื่อบันทึก' },
        { type: 'feature', text: 'Dashboard Dynamic Form Modal redesign — ตาราง 12 เดือน × N ฟิลด์ (เหมือนหน้าตัวชี้วัดย่อย) แทนกรอกทีละเดือน + batch save (ส่งเฉพาะเดือนที่เปลี่ยน)' },
        { type: 'improve', text: 'Form Builder: parse "label = percentage" จาก textarea → JSON array {label, percentage} อัตโนมัติ + แสดง preview chips' },
        { type: 'improve', text: 'Dashboard form modal: โหมดดูอย่างเดียว/แก้ไข + sticky thead + แถวเหลืองเมื่อมีการเปลี่ยนแปลง + check icon เดือนที่มีข้อมูลแล้ว' },
      ]
    },
    {
      version: '2569.05.05',
      date: '5 พฤษภาคม 2569',
      changes: [
        { type: 'fix', text: 'Export KPI: ส่งออกข้อมูลครบขึ้น — รวม sub_results AVG / form table data / รับ indicator_id IS NULL / รองรับค่า "0" / รับ schema inactive + infer fields จาก SHOW COLUMNS' },
        { type: 'fix', text: 'Export merge sub_results: empty string ใน kpi_results.actual_value บล็อก override → fix โดยแปลง "" → null + เพิ่ม cur === "" ใน merge condition' },
        { type: 'fix', text: 'Chart cards (4 cards): สูตรคำนวณใหม่ — ใช้ kpi_summary.last_actual + count-based achievement (ไม่ใช่ SUM ratio)' },
        { type: 'fix', text: 'Report endpoints (by-indicator/hospital/district/year): achievement_pct = passed/with_target × 100 แทน SUM(actual)/SUM(target)' },
        { type: 'fix', text: 'kpi-manager step2Summary: NG0100 ExpressionChangedAfterCheckedError — เปลี่ยน getter → property + setInterval poll 1s' },
        { type: 'fix', text: 'Notifications tab counts: คำนวณ unread + reply + type-based counts จาก array ตรง ๆ + typeOf() trim+lowercase robust' },
        { type: 'feature', text: 'Endpoint /admin/export-debug ?year_bh=&table_process=&hospcode= (super_admin) — diagnose ข้อมูลในแต่ละ source: kpi_results, sub_results, form_*, schemas, export_table' },
        { type: 'feature', text: 'kpi-manager: รวม DB Compare + Export → Wizard 2 ขั้น (Phase A schema / Phase B data) — ลดความสับสน' },
        { type: 'feature', text: 'Step 1 (Report Compare) + Phase A (DB Compare): เพิ่มตัวกรองรายการ (หมวดหมู่หลัก/หน่วยงาน/สถานะ/ล้างตัวกรอง) ให้เหมือน Phase B' },
        { type: 'improve', text: 'help-public: เพิ่มปุ่ม "กลับหน้า Login" + เมนูหัวข้อ collapsible สำหรับ mobile/tablet + ซ่อน sidebar nav ใน mobile' },
        { type: 'improve', text: 'Login page redesign: gradient mint→teal→pink + glassmorphism + ThaID/ProviderID buttons (รอ DGA/MOPH credentials)' },
      ]
    },
    {
      version: '2569.05.01',
      date: '1 พฤษภาคม 2569',
      changes: [
        { type: 'feature', text: 'user-management: ปุ่ม "บังคับ logout user" (fa-sign-out-alt สีม่วง) — super_admin เห็นเฉพาะ user ที่ online — แสดง IP + เวลาใช้งานล่าสุดก่อนยืนยัน' },
        { type: 'feature', text: 'Single Session Enforcement — กัน login ซ้อนจากหลายเครื่อง: 1 user = 1 active session (block ถ้า last_seen ≤ 5 นาที)' },
        { type: 'feature', text: 'POST /logout endpoint + HTTP interceptor ดักจับ 401 SESSION_INVALIDATED → auto logout' },
        { type: 'feature', text: 'super_admin บังคับ logout user ผ่าน POST /admin/force-logout-user/:id (กรณีฉุกเฉิน)' },
        { type: 'feature', text: 'Login + Register: เพิ่มปุ่ม ThaID / ProviderID (รอเปิดใช้งาน) — UI scaffolding รอ DGA/MOPH credentials' },
        { type: 'feature', text: 'Register: แสดง modal เลือก 3 วิธี (ThaID / ProviderID / ลงทะเบียนด้วยตัวเอง) ก่อนเข้าฟอร์ม' },
        { type: 'feature', text: 'kpi-manager: รวม Report Compare / DB Compare / Export เป็น Wizard 3 ขั้น (free navigation)' },
        { type: 'feature', text: 'kpi-manage: ปุ่ม fa-clipboard-list สร้าง/แก้แบบฟอร์ม inline modal — ย้ายจาก kpi-manager แทบ "สร้างแบบฟอร์ม"' },
        { type: 'feature', text: 'Dynamic-data-months batch endpoint — ลด N HTTP requests (1/แถว) → 1 request ต่อปีงบฯ' },
        { type: 'improve', text: 'Layout redesign: glassmorphism (sidebar/header bg-white/65 + backdrop-blur) ตามโทน login page' },
        { type: 'improve', text: 'พื้นหลังทุกหน้าเปลี่ยนเป็น mint อ่อน (#e8f5ee) — global override .bg-white กลมกลืนกับ sidebar' },
        { type: 'improve', text: 'Dashboard + Login: layout-bg-gradient class (mint→teal→pink) + 3-layer SVG waves + sparkle dots' },
        { type: 'improve', text: 'Dark mode: รองรับ glassmorphism + sidebar/header — เปลี่ยน gradient + bg/text variants ตาม .dark' },
        { type: 'improve', text: 'Responsive: ทุกหน้า max-h calc(100vh - Npx) + sticky thead + overflow-auto — modal/SweetAlert ขึ้นกลางจอเสมอ' },
        { type: 'improve', text: 'SweetAlert: z-index 99999 + max-width calc(100vw-2rem) + responsive padding ที่ ≤640px' },
        { type: 'fix', text: 'Layout: เพิ่ม min-w-0 + overflow-hidden บน flex chain — กัน table min-w-[1600px] ดันหน้ากว้างเกินจอ' },
        { type: 'fix', text: 'Dashboard 504 timeout: simplified GROUP BY 18→3 cols + MIN/MAX wrapping → query เร็วขึ้นมาก' },
        { type: 'fix', text: 'Frontend timeout(90s) + 429 batch endpoint — ลด rate-limit hit + แสดง error ชัดเมื่อ timeout' },
        { type: 'fix', text: 'icon "สร้าง/แก้ไขแบบฟอร์ม": fa-wpforms (brands) → fa-clipboard-list (solid)' },
        { type: 'fix', text: 'ลบปุ่ม Light/Dark mode ที่ลอยมุมขวาบนทับ profile — เหลือเฉพาะปุ่มใน header ข้าง bell' },
      ]
    },
    {
      version: '2569.04.24',
      date: '24 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'หน้าใหม่ "ผู้ใช้งานออนไลน์" (super_admin) — ดูผู้ใช้ online realtime พร้อม auto-refresh 15s (เลือกได้ 5-60s)' },
        { type: 'feature', text: 'Track last_seen_at ใน authenticateToken (throttle 1 นาที/user กัน DB overload)' },
        { type: 'feature', text: 'Online users: 4 stats cards / filter role + ช่วงเวลา 2-240 นาที / แสดง IP + OS + Browser + idle time' },
        { type: 'fix', text: 'Export "ตรวจสอบข้อมูล": ใช้ logic ตรงกับ performKpiExport (result = last actual, ไม่ใช่ SUM) + sameValue numeric-aware' },
        { type: 'fix', text: 'Export ข้อมูล: ส่งออกเฉพาะ hospcode ที่มีผลงาน (actual_value) — ไม่ส่ง row ที่มีแต่ target' },
        { type: 'fix', text: 'Scheduler Export: ยิง check() immediate on startup + interval 30s + match 2-minute window + log ชัดเจน' },
        { type: 'fix', text: 'Dashboard mobile/tablet: ล็อคช่องเดือน ต.ค.-ก.ย. เมื่อ is_locked=1 (รับรองแล้ว)' },
        { type: 'improve', text: 'Dashboard mobile card: แสดง 12 เดือน scroll แนวนอน (เริ่มที่ 6 เดือนล่าสุดที่มีข้อมูล)' },
        { type: 'improve', text: 'Dashboard mobile/tablet: ปุ่ม จัดการตัวชี้วัด + ตรวจสอบ แบ่งครึ่งแถวเดียวกัน' },
        { type: 'improve', text: 'Dashboard mobile/tablet: ตรึง (sticky) header + filter + search เมื่อ scroll' },
        { type: 'improve', text: 'Dashboard: ย้าย อำเภอ → cell "หน่วยบริการ" (บรรทัด 2, 📍) + ย้าย หน่วยงาน → cell "ชื่อตัวชี้วัด" (🏢 badge)' },
        { type: 'improve', text: 'Dashboard: คอลัมน์ "จัดการ" frozen ไอคอนแนวตั้ง + chart-line inline ต่อชื่อตัวชี้วัด' },
        { type: 'improve', text: 'Dashboard: SweetAlert สรุปการแก้ไขเป็นตาราง (ค่าเดิม / ค่าใหม่ / ลูกศร ↑↓−)' },
        { type: 'improve', text: 'Focus Mode: ซ่อน sidebar อัตโนมัติเมื่อเข้าโหมด edit/delete + คืนเมื่อออก' },
        { type: 'improve', text: 'ปิด console.log ใน production (เก็บ warn/error)' },
      ]
    },
    {
      version: '2569.04.23-4',
      date: '23 เมษายน 2569',
      changes: [
        { type: 'fix', text: 'Dashboard: แก้ไขผลงาน → Save แจ้ง "ไม่มีการเปลี่ยนแปลง" (ทุก role ยกเว้น super_admin) — ชน sub-summary override' },
        { type: 'fix', text: 'applySubSummaryToKpiData() early-return ถ้า isEditing — กัน re-override ระหว่างแก้ไข' },
        { type: 'fix', text: 'toggleEditMode (เข้าโหมด): คืน raw values จาก _mainOriginal ก่อน snapshot _original → user แก้ raw values จริง ไม่ใช่ AVG' },
        { type: 'fix', text: 'toggleEditMode (ออกโหมด) + Save success: re-apply sub summary AVG + setFocusMode(false) sync sidebar' },
      ]
    },
    {
      version: '2569.04.23-3',
      date: '23 เมษายน 2569',
      changes: [
        { type: 'improve', text: 'Dashboard: ย้าย อำเภอ → cell "หน่วยบริการ" (บรรทัดที่ 2, icon 📍) — ลบคอลัมน์ "อำเภอ" แยก' },
        { type: 'improve', text: 'Dashboard: ย้าย หน่วยงาน → cell "ชื่อตัวชี้วัด" (badge slate + icon 🏢 ก่อน chart icon) — ลบคอลัมน์ "หน่วยงาน" แยก' },
        { type: 'improve', text: 'Dashboard: ตารางกระชับขึ้น พื้นที่ scrollable มากขึ้น สำหรับคอลัมน์เดือน 12 ช่อง' },
      ]
    },
    {
      version: '2569.04.23-2',
      date: '23 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'Dashboard: ตัวกรอง status เพิ่ม "มีเป้า/มีผลงาน" (emerald) — กรองรายการที่มีทั้ง target_value และ last_actual' },
        { type: 'feature', text: 'Dashboard: Focus Mode — เข้าโหมดแก้ไข/ลบ → ซ่อน sidebar อัตโนมัติ + จำค่าเดิม (ออกโหมดแล้วเปิดกลับ)' },
        { type: 'feature', text: 'AuthService: เพิ่ม focusMode$ BehaviorSubject + setFocusMode() — Layout subscribe เพื่อปรับ sidebar' },
        { type: 'improve', text: 'Dashboard: คอลัมน์ใหม่ "จัดการ" (frozen col-3, 64px) — ไอคอนแนวตั้ง แยกออกจาก "ชื่อตัวชี้วัด"' },
        { type: 'improve', text: 'Dashboard: หน่วยบริการ ขยับเป็น col-4 (200-240px) — shadow separator ตามไป' },
        { type: 'improve', text: 'Dashboard: ย้ายไอคอน chart-line (ดูแนวโน้ม) ไปอยู่ inline ต่อท้ายชื่อตัวชี้วัด' },
        { type: 'improve', text: 'Dashboard: ล็อค (freeze) 4 คอลัมน์ซ้าย — หมวดหมู่ / ชื่อตัวชี้วัด / จัดการ / หน่วยบริการ' },
      ]
    },
    {
      version: '2569.04.23',
      date: '23 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'kpi_indicators: เพิ่มฟิวล์ evaluation_mode (any_one/all_required) + required_off_types (JSON array) — กำหนดประเภทหน่วยบริการที่ตัวชี้วัดรับผิดชอบ' },
        { type: 'feature', text: 'kpi-manage: Modal เพิ่ม section "เกณฑ์การประเมิน" — radio โหมด + multi-select hostype (05, 06, 07, 18, ...)' },
        { type: 'feature', text: 'Dashboard: ตัวกรอง "ตัวชี้วัดของ" (cyan) — กรองตัวชี้วัดตาม required_off_types + all_required' },
        { type: 'feature', text: 'Dashboard: Badge "ตัวชี้วัดของ" ในคอลัมน์ชื่อตัวชี้วัด — "ทุกประเภท" (purple) / ชื่อประเภท / "N ประเภท"' },
        { type: 'feature', text: 'Dashboard: เพิ่มคอลัมน์ "ประเภท" (cyan badge) ระหว่าง หน่วยบริการ กับ อำเภอ' },
        { type: 'fix', text: 'Dashboard filter "ประเภท รพ.": JOIN chostype + filter h.hostype ตรงๆ (แก้ LEFT JOIN ไม่เจอข้อมูล)' },
        { type: 'fix', text: 'Dashboard filter dropdown: z-50 + ลบ overflow-hidden ของ card นอก — แก้ dropdown ถูกหัวตารางทับ' },
        { type: 'improve', text: 'Dashboard: mobile/tablet การ์ด KPI แสดง 4 เดือนล่าสุดที่มีข้อมูล (getRecentMonths)' },
        { type: 'improve', text: 'Dashboard: SweetAlert ยืนยันบันทึก → ตารางสรุปการเปลี่ยนแปลง (รายการ / เดือน / ค่าเดิม / ค่าใหม่ / สถานะ ↑↓−)' },
        { type: 'improve', text: 'Responsive: Dashboard + Export KPI + Announcements ปรับให้เข้ากับ mobile/tablet' },
      ]
    },
    {
      version: '2569.04.22-schedule',
      date: '22 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'Export KPI: ระบบตารางเวลา Export อัตโนมัติ — ตั้งวัน จ.-อา. + เวลา HH:MM → scheduler backend รันทุก 1 นาที' },
        { type: 'feature', text: 'Schedule: ขอบเขตตัวชี้วัด 3 โหมด — changes_only (แนะนำ, เฉพาะที่เพิ่ม/แก้ไข) / all / selected' },
        { type: 'feature', text: 'Schedule: เลือกเปิด "ส่งข้อมูลเข้า HDC อัตโนมัติ" หลัง export เสร็จ (UPSERT)' },
        { type: 'feature', text: 'Schedule: ส่งรายงานสรุป (Email/Telegram) — recipients ดึงจากหน้าตั้งค่าระบบ (admin_emails, telegram_chat_id, telegram_bot_token)' },
        { type: 'feature', text: 'Schedule: ปุ่มใน kpi-manager → Modal ตั้งค่า + ปุ่มรันทันที + ประวัติการรัน (logs)' },
        { type: 'feature', text: 'ประกาศระบบ (System Announcements): เพิ่มตาราง + CRUD — จัดการประกาศได้ จาก super_admin' },
        { type: 'feature', text: 'Rich text editor: B/I/U, ขนาด, สี, ไฮไลต์, emoji, ไอคอน, รูปภาพ URL + character limit 200' },
        { type: 'feature', text: 'Dashboard header pill: โหลดแบบไดนามิก + กระพริบช้าๆ (ตามค่า blink_enabled)' },
        { type: 'feature', text: 'SweetAlert ตอน login: ดึงประกาศ active ที่ show_on_login = 1' },
      ]
    },
    {
      version: '2569.04.20-2',
      date: '20 เมษายน 2569',
      changes: [
        { type: 'improve', text: 'Modal บันทึกผลงานย่อย: แสดงตาราง 12 เดือน (ต.ค.-ก.ย.) + คอลัมน์ ผลงาน + % (แทน dropdown เดือน)' },
        { type: 'improve', text: 'Dashboard main row: แสดงค่า AVG ของ sub-indicators (เป้าหมาย, เดือน, ผลงานรวม) หารด้วยจำนวน sub' },
        { type: 'improve', text: 'Format ตัวเลข: จำนวนเต็มไม่มีทศนิยม (70), มีเศษ 2 ตำแหน่ง (70.50)' },
        { type: 'improve', text: 'kpi-manage modal: เพิ่มฟิลด์ครบทุก tab (indicators, main_yut, main_indicators, departments)' },
        { type: 'improve', text: 'Modal indicators: เพิ่ม dropdown ยุทธศาสตร์ + cascade filter หมวดหมู่หลัก' },
      ]
    },
    {
      version: '2569.04.20',
      date: '20 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'ตัวชี้วัดย่อย (Sub-Indicators): เพิ่มตาราง kpi_sub_indicators + kpi_sub_results — บันทึกผลงานย่อย per hospcode รายเดือน' },
        { type: 'feature', text: 'kpi-manage: ปุ่ม "ตัวชี้วัดย่อย (N)" แต่ละแถว indicator → modal CRUD (super_admin)' },
        { type: 'feature', text: 'Dashboard: ปุ่มตัวชี้วัดย่อย → modal บันทึกผลงาน target+actual รายเดือน' },
        { type: 'feature', text: 'Data Synchronization (Users): ปุ่มในหน้า user-management → modal เปรียบเทียบ Local vs HDC → Sync → HDC' },
      ]
    },
    {
      version: '2569.04.17-14',
      date: '17 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'Dashboard: เพิ่มตัวกรอง "ประเภท รพ." (hostype) จากตาราง chostype — กรอง รพ./รพ.สต./สสอ./สสจ. + cascade กับอำเภอ' },
        { type: 'feature', text: 'Dashboard: เพิ่มสัญญลักษณ์ประเภทตัวชี้วัด (R9, MOPH, SSJ, RMW, อื่นๆ) แสดงไว้ด้านหน้าชื่อตัวชี้วัดในตาราง' },
        { type: 'improve', text: 'Dashboard: สัญญลักษณ์ประเภทตัวชี้วัดแสดงด้วยสีที่โดดเด่น (Blue, Red, Green, Yellow, Gray) ทั้งบน Desktop และ Mobile' },
        { type: 'fix', text: 'อัปเดต Summary: batch processing ทีละ 50 indicators — แก้ 504 Gateway Timeout (600K+ rows)' },
        { type: 'fix', text: 'Export ข้อมูล: result ใช้ค่าเดือนล่าสุดที่คีย์ (ไม่รวม SUM) — เหมือน kpi_summary.last_actual' },
        { type: 'fix', text: 'Export ข้อมูล: content-based diff แก้ actual_value ไม่ส่งออก (timestamp skipping)' },
        { type: 'improve', text: 'Export ข้อมูล: ตารางมี m10-m09 เสมอ + form fields + prefilter indicators + dedupe card counters' },
        { type: 'improve', text: 'nginx: proxy_read_timeout เพิ่มเป็น 300s สำหรับ heavy queries' },
      ]
    },
    {
      version: '2569.04.11-10',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'fix', text: 'Export ข้อมูล: เปลี่ยนจาก timestamp-based เป็น content-based diff — แก้ปัญหา actual_value ไม่ส่งออก (เพราะ update_date เก่าของ export ใหม่กว่า kpi_results.created_at)' },
        { type: 'improve', text: 'Export ข้อมูล: เปรียบเทียบค่าทีละคอลัมน์ (target, result, m10-m09, form fields) ด้วย numeric-aware compare' },
      ]
    },
    {
      version: '2569.04.11-9',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'fix', text: 'Export ข้อมูล: ตัวชี้วัดที่มี form schema → export actual_value รายเดือน (m10-m09) ได้ด้วย (เดิมส่งเฉพาะ form fields)' },
        { type: 'improve', text: 'Export ข้อมูล: ตารางมีคอลัมน์เดือน (m10-m09) เสมอ + ALTER เพิ่มให้ตารางเก่าอัตโนมัติ' },
      ]
    },
    {
      version: '2569.04.11-8',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'fix', text: 'Export ข้อมูล: hospcode ที่มีเฉพาะ target_value (ไม่มี actual) ถูกข้าม → แก้ให้ export ถ้ามี target_value หรือ actual_value' },
        { type: 'improve', text: 'Export ข้อมูล: card counters นับตาม unique table_process (หลาย indicator ใช้ table เดียวกันนับเป็น 1)' },
      ]
    },
    {
      version: '2569.04.11-7',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'improve', text: 'Export ข้อมูล: สร้างเฉพาะตารางของตัวชี้วัดที่มีข้อมูลใน kpi_results จริง (target_value หรือ actual_value)' },
        { type: 'feature', text: 'Export ข้อมูล: เพิ่ม card "จำนวนข้อมูลที่เปลี่ยนแปลง" (รวมแถว new+changed)' },
        { type: 'feature', text: 'Export ข้อมูล: rename "มีการเปลี่ยนแปลง" → "ตัวชี้วัดที่เพิ่ม/แก้ไข" (ชัดเจนขึ้น)' },
      ]
    },
    {
      version: '2569.04.11-6',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'improve', text: 'Export ข้อมูล: ส่งออกเฉพาะ hospcode ที่มี actual_value จริง — hospcode ที่มีเฉพาะ target (ไม่คีย์ผลงาน) จะข้าม' },
        { type: 'feature', text: 'Export ข้อมูล: แสดงช่อง "ไม่มีผลงาน (ข้าม)" ในสรุปผล' },
      ]
    },
    {
      version: '2569.04.11-5',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'improve', text: 'Export ข้อมูล: Incremental update — ส่งออกเฉพาะ hospcode ที่มีข้อมูลใหม่/แก้ไข (เทียบ kpi_results.created_at กับ update_date)' },
        { type: 'improve', text: 'Export ข้อมูล: นับ inserted/updated/unchanged ถูกต้อง (เดิมนับ insertedCount รวมหมดทุกแถว)' },
      ]
    },
    {
      version: '2569.04.11-4',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'fix', text: 'Export ข้อมูล: แก้ error "Incorrect decimal value" — แปลง empty string → NULL ก่อน INSERT' },
        { type: 'fix', text: 'Export ข้อมูล: ข้อมูลที่คีย์แก้ไขแล้วใน hospcode เดิมจะอัปเดตได้จริง (เดิม rollback เพราะ DECIMAL error)' },
      ]
    },
    {
      version: '2569.04.11-3',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'DB Compare: เพิ่ม Sync 2 ทิศทาง — สร้างตารางใน HDC + Sync ข้อมูล Local → HDC' },
        { type: 'feature', text: 'เพิ่ม shortcut "เลือก Missing HDC" ใน toolbar DB Compare' },
        { type: 'improve', text: 'แยกปุ่มใน Sticky Action Panel เป็น 2 กลุ่ม: HDC → Local (เดิม) + Local → HDC (ใหม่)' },
      ]
    },
    {
      version: '2569.04.11-2',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'improve', text: 'รายงานสรุปผลทั้ง 4 แถบ ดึงจาก kpi_summary แทน kpi_results — โหลดเร็วขึ้นมาก' },
        { type: 'improve', text: 'kpi_summary เพิ่ม dept_id + distid — รองรับ role-based filtering โดยไม่ต้อง JOIN ตารางอื่น' },
        { type: 'improve', text: 'Summary เก็บเฉพาะข้อมูลที่มีผลงานจริง (HAVING actual_value) — รายงานแม่นยำขึ้น' },
        { type: 'fix', text: 'แก้ collation mismatch kpi_summary (utf8mb4_general_ci → utf8mb4_unicode_ci)' },
        { type: 'fix', text: 'Chart/Report ไม่ส่ง year ว่างเปล่าเป็น parameter (ป้องกัน query ผิดพลาด)' },
      ]
    },
    {
      version: '2569.04.11',
      date: '11 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'รวม Chart + Report เป็นหน้าเดียว (2 tabs)' },
        { type: 'feature', text: 'Profile Dropdown: ย้ายข้อเสนอแนะ/คู่มือ/ประวัติอัปเดตเข้า dropdown' },
        { type: 'feature', text: 'Profile Dropdown: drain animation (ยุบหายเข้า avatar) เมื่อปิด' },
        { type: 'feature', text: 'admin_ssj/user_ssj: ล็อค dropdown หน่วยงานเฉพาะ dept ตัวเอง' },
        { type: 'feature', text: 'admin_ssj: ไม่โหลดข้อมูล dashboard อัตโนมัติ เหมือน super_admin' },
        { type: 'fix', text: 'Modal แก้ไขผู้ใช้: ซ่อน CID (เข้ารหัสแล้ว) ไม่ให้แก้ไข' },
        { type: 'fix', text: 'feedback mark-read: ตรวจ isLoggedIn() ก่อนเรียก API (แก้ 403 ตอน logout)' },
      ]
    },
    {
      version: '2569.04.10',
      date: '10 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'ตัวกรองประเภทตัวชี้วัด (เขต 9 / กระทรวง / สสจ. / ผู้ว่าฯ / อื่นๆ)' },
        { type: 'feature', text: 'kpi_summary (Materialized View) — เร่งความเร็ว Chart + Report' },
        { type: 'feature', text: 'Notification Detail Modal — กดดูรายละเอียด + auto mark-read' },
        { type: 'feature', text: 'เป้าหมายอัตโนมัติจาก kpi_indicators.target_percentage' },
        { type: 'improve', text: 'CONCAT(provcode,distcode) → chospital.distid + index (เร็วขึ้น)' },
        { type: 'improve', text: 'Summary refresh: INSERT...SELECT ใน MySQL ตรงๆ + progress bar' },
        { type: 'fix', text: 'FK kpi_indicators: dept_id + main_indicator_id เปลี่ยน VARCHAR→INT' },
        { type: 'fix', text: 'ปุ่มลบ: แสดงเฉพาะ super_admin ทุก component (form-builder แก้แล้ว)' },
        { type: 'fix', text: 'Port dev: 4500 (frontend) + 3700 (backend) — แก้ Windows excluded range' },
      ]
    },
    {
      version: '2569.04.03',
      date: '3 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'กระดานข้อเสนอแนะ (Feedback Board) — สร้างกระทู้ ตอบกลับ แจ้งเตือน Telegram/Email' },
        { type: 'feature', text: 'สีเฉพาะตัวต่อ username ในกระทู้ — super_admin = เขียวเข้ม' },
        { type: 'feature', text: 'Icon ข้อเสนอแนะ + Badge บน Header ข้างระฆัง' },
        { type: 'feature', text: 'ส่งข้อมูลเข้า HDC (UPSERT) — ไม่ลบข้อมูลเดิม' },
        { type: 'feature', text: 'สำรอง/ล้างข้อมูลผลงาน KPI ในหน้าตั้งค่า' },
        { type: 'feature', text: 'Report Compare — เปรียบเทียบ reports HDC กับ kpi_indicators' },
        { type: 'feature', text: 'คำแนะนำขั้นตอนใน DB Compare, Report Compare, Sync HDC' },
        { type: 'improve', text: 'หน้า Changelog แสดงประวัติการอัปเดต + Auto-version' },
      ]
    },
    {
      version: '2569.04.02',
      date: '2 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'ปุ่มตรวจสอบ (Review Mode) — เลือก checkbox อนุมัติ/ตีกลับทีละรายการ' },
        { type: 'feature', text: 'ปุ่มปลดล็อคทั้งหมด (super_admin)' },
        { type: 'feature', text: 'Cascading Filters — อำเภอ→หน่วยบริการ→หน่วยงาน→ตัวชี้วัด' },
        { type: 'feature', text: 'ปุ่มซ่อน/แสดงตัวกรอง ทุกหน้า' },
        { type: 'feature', text: 'super_admin ไม่โหลดข้อมูลอัตโนมัติใน Dashboard' },
        { type: 'improve', text: 'Chart: Horizontal %bar + Area + Donut ความกว้าง 100%' },
        { type: 'improve', text: 'หน่วยบริการเรียงตาม hostype (รพ.→สสอ.→รพ.สต.)' },
        { type: 'fix', text: 'super_admin ข้ามการตรวจสอบ lock แก้ไขได้ทุกกรณี' },
        { type: 'fix', text: 'DB Compare ตารางซ้ำ — deduplicate ตาม table_process' },
        { type: 'fix', text: 'DB pool reconnect + idleTimeout 5 นาที' },
      ]
    },
    {
      version: '2569.04.01',
      date: '1 เมษายน 2569',
      changes: [
        { type: 'feature', text: 'ยกเลิกตัวแปลภาษา — ใช้ภาษาไทยตลอด' },
        { type: 'feature', text: 'คำนวณอันดับผลงานระดับจังหวัดจริง (% ตัวชี้วัดที่ผ่านเป้า)' },
        { type: 'feature', text: 'Notification dropdown แสดงเฉพาะที่ยังไม่อ่าน + scrollbar' },
        { type: 'feature', text: 'Dashboard กรอง filter อัตโนมัติตาม Role' },
        { type: 'feature', text: 'สวิทช์เปิด-ปิดแจ้งเตือนผู้สมัครใหม่ 3 ช่องทาง' },
        { type: 'fix', text: 'Scrollbar ซ้อนหน้า Settings + Switch scroll jump' },
        { type: 'fix', text: 'Login autocomplete warning' },
      ]
    },
    {
      version: '2569.03.31',
      date: '31 มีนาคม 2569',
      changes: [
        { type: 'feature', text: 'KPI Manager — รวม DB Compare + Form Builder + Export + Report Compare' },
        { type: 'feature', text: 'Maintenance Mode — ปิดระบบชั่วคราว + แจ้งเตือนหน้า Login' },
        { type: 'feature', text: 'แถบ "ทดสอบระบบ" บน Header เต็มจอ' },
        { type: 'feature', text: 'เปิด/ปิดใช้งานผู้ใช้ทั้งหมด (bulk toggle)' },
        { type: 'feature', text: 'Modal เพิ่มผู้ใช้: validation เหมือน register (CID check digit)' },
        { type: 'feature', text: 'คอลัมน์ "ผู้อนุมัติ" ในตารางจัดการผู้ใช้' },
        { type: 'improve', text: 'admin_ssj เห็นเมนูจัดการตัวชี้วัด แต่ไม่เห็นปุ่มลบ' },
        { type: 'improve', text: 'แจ้งเตือน Login ทาง Email ทุกครั้ง' },
      ]
    },
  ];

  getTypeInfo(type: string) {
    switch (type) {
      case 'feature': return { label: 'ฟีเจอร์ใหม่', bg: 'bg-green-100 text-green-700', icon: 'fa-plus-circle text-green-500' };
      case 'improve': return { label: 'ปรับปรุง', bg: 'bg-blue-100 text-blue-700', icon: 'fa-arrow-up text-blue-500' };
      case 'fix': return { label: 'แก้ไข', bg: 'bg-amber-100 text-amber-700', icon: 'fa-wrench text-amber-500' };
      default: return { label: type, bg: 'bg-gray-100 text-gray-600', icon: 'fa-circle text-gray-400' };
    }
  }
}
