import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type Lang = 'th' | 'en';

const TRANSLATIONS: Record<string, Record<Lang, string>> = {
  // === เมนู ===
  'menu.charts': { th: 'รายงานสถิติ', en: 'Statistics' },
  'menu.reports': { th: 'รายงานสรุปผล', en: 'Reports' },
  'menu.notifications': { th: 'แจ้งเตือน', en: 'Notifications' },
  'menu.dashboard': { th: 'ภาพรวมตัวชี้วัด', en: 'KPI Dashboard' },
  'menu.users': { th: 'จัดการผู้ใช้งาน', en: 'User Management' },
  'menu.kpi_manage': { th: 'จัดการตัวชี้วัด', en: 'KPI Management' },
  'menu.audit_logs': { th: 'ประวัติการใช้งาน', en: 'Audit Logs' },
  'menu.kpi_setup': { th: '+KPI ปีงบประมาณใหม่', en: '+New Fiscal Year' },
  'menu.export': { th: 'Export ข้อมูล KPI', en: 'Export KPI Data' },
  'menu.form_builder': { th: 'สร้างแบบฟอร์ม KPI', en: 'KPI Form Builder' },
  'menu.settings': { th: 'ตั้งค่าระบบ', en: 'System Settings' },
  'menu.help': { th: 'คู่มือการใช้งาน', en: 'User Manual' },
  'menu.change_password': { th: 'เปลี่ยนรหัสผ่าน', en: 'Change Password' },
  'menu.logout': { th: 'ออกจากระบบ', en: 'Logout' },

  // === Login ===
  'login.title': { th: 'เข้าสู่ระบบ', en: 'Sign In' },
  'login.username': { th: 'ชื่อผู้ใช้งาน', en: 'Username' },
  'login.password': { th: 'รหัสผ่าน', en: 'Password' },
  'login.submit': { th: 'เข้าสู่ระบบ', en: 'Sign In' },
  'login.register': { th: 'ลงทะเบียน', en: 'Register' },
  'login.no_account': { th: 'ยังไม่มีบัญชี?', en: "Don't have an account?" },
  'login.forgot': { th: 'ลืมรหัสผ่าน?', en: 'Forgot password?' },
  'login.about': { th: 'เกี่ยวกับระบบและวัตถุประสงค์', en: 'About this system' },
  'login.system_name': { th: 'ระบบบันทึกผลงาน KPI ด้านสุขภาพ', en: 'Health KPI Recording System' },
  'login.org_name': { th: 'สำนักงานสาธารณสุขจังหวัดนครราชสีมา', en: 'Nakhon Ratchasima Provincial Health Office' },
  'login.slogan': { th: 'เชื่อมโยงข้อมูล ยกระดับบริการ เพื่อสุขภาพที่ดีของชาวโคราช', en: 'Connecting data, elevating services for better health in Korat' },

  // === Dashboard ===
  'dashboard.title': { th: 'รายการบันทึกผลตัวชี้วัด', en: 'KPI Entry List' },
  'dashboard.add': { th: 'เพิ่ม', en: 'Add' },
  'dashboard.edit': { th: 'แก้ไข', en: 'Edit' },
  'dashboard.save': { th: 'บันทึก', en: 'Save' },
  'dashboard.cancel': { th: 'ยกเลิก', en: 'Cancel' },
  'dashboard.reset': { th: 'คืนค่า', en: 'Reset' },
  'dashboard.clear_filter': { th: 'ล้างตัวกรอง', en: 'Clear Filters' },
  'dashboard.approve_all': { th: 'อนุมัติทั้งหมด', en: 'Approve All' },
  'dashboard.reject_all': { th: 'ตีกลับทั้งหมด', en: 'Reject All' },
  'dashboard.target': { th: 'เป้าหมาย', en: 'Target' },
  'dashboard.result': { th: 'ผลงานรวม', en: 'Result' },
  'dashboard.locked': { th: 'ระบบปิดการคีย์ข้อมูลชั่วคราว', en: 'Data entry temporarily locked' },

  // === ทั่วไป ===
  'common.loading': { th: 'กำลังโหลดข้อมูล...', en: 'Loading...' },
  'common.success': { th: 'สำเร็จ', en: 'Success' },
  'common.error': { th: 'ผิดพลาด', en: 'Error' },
  'common.confirm': { th: 'ยืนยัน', en: 'Confirm' },
  'common.close': { th: 'ปิด', en: 'Close' },
  'common.search': { th: 'ค้นหา', en: 'Search' },
  'common.all': { th: 'ทั้งหมด', en: 'All' },
  'common.no_data': { th: 'ไม่มีข้อมูล', en: 'No data' },
};

@Injectable({ providedIn: 'root' })
export class LanguageService {
  private lang$ = new BehaviorSubject<Lang>('th');
  currentLang$ = this.lang$.asObservable();

  constructor() {
    const saved = localStorage.getItem('kpi_lang') as Lang;
    if (saved === 'en') this.setLang('en');
  }

  get lang(): Lang { return this.lang$.value; }

  setLang(lang: Lang) {
    this.lang$.next(lang);
    localStorage.setItem('kpi_lang', lang);
    document.documentElement.lang = lang;
  }

  toggle() {
    this.setLang(this.lang === 'th' ? 'en' : 'th');
  }

  t(key: string): string {
    return TRANSLATIONS[key]?.[this.lang] || key;
  }
}
