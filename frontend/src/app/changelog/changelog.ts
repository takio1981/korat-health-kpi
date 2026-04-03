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
