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
      version: '2569.04.17-13',
      date: '17 เมษายน 2569',
      changes: [
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
