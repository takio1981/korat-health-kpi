import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';

@Component({
  selector: 'app-help',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './help.html'
})
export class HelpComponent {
  private authService = inject(AuthService);
  private router = inject(Router);
  activeSection: string = 'overview';
  currentRole: string = '';
  showMobileTopics: boolean = false;
  isPublicView: boolean = false;

  ngOnInit() {
    this.currentRole = this.authService.getUserRole();
    // ตรวจว่าเปิดผ่าน /help-public (ไม่ login)
    this.isPublicView = this.router.url.includes('/help-public') || !this.authService.isLoggedIn();
  }

  collapsedSections: { [key: string]: boolean } = {};

  // กลุ่มสิทธิ์ — ใช้ filter sections ตาม role ที่ login
  //   'all'         = ทุก role + public view เห็นได้
  //   'authenticated' = ต้อง login (ไม่ต้องสน role)
  //   อื่นๆ = ระบุ role array
  private static readonly ALL_ROLES = ['super_admin','admin_ssj','admin_cup','admin_hos','admin_sso','user_cup','user_hos','user_sso','user_ssj'];
  private static readonly ADMIN_CENTRAL = ['super_admin','admin_ssj'];                                     // ตรงกับ isAdmin ใน layout.ts
  private static readonly ANY_ADMIN = ['super_admin','admin_ssj','admin_cup','admin_hos','admin_sso'];     // ตรงกับ isAnyAdmin ใน layout.ts
  private static readonly SUPER_ONLY = ['super_admin'];

  // section.roles: 'all' = แสดงทุกคน (รวม public), array = แสดงเฉพาะ role ที่ระบุ
  // ลำดับ + roles gate ต้องตรงกับเมนู sidebar จริงใน layout.html เสมอ (isAdmin/isAnyAdmin/isSuperAdmin)
  sections: { id: string; icon: string; label: string; roles: 'all' | string[] }[] = [
    { id: 'overview',       icon: 'fa-home',             label: '1. ภาพรวมระบบ',                    roles: 'all' },
    { id: 'register',       icon: 'fa-user-plus',        label: '2. การลงทะเบียน',                   roles: 'all' },
    { id: 'login',          icon: 'fa-sign-in-alt',      label: '3. การเข้าสู่ระบบ',                  roles: 'all' },
    { id: 'dashboard',      icon: 'fa-th-large',         label: '4. บันทึกผลงานตัวชี้วัด',             roles: 'all' },
    { id: 'charts',         icon: 'fa-chart-bar',        label: '5. รายงานสถิติ',                    roles: 'all' },
    { id: 'sop',            icon: 'fa-sitemap',          label: '6. ผังกระบวนการ SOP',                roles: 'all' },
    { id: 'notifications',  icon: 'fa-bell',             label: '7. แจ้งเตือน',                      roles: 'all' },
    { id: 'users',          icon: 'fa-users-cog',        label: '8. จัดการผู้ใช้งาน',                 roles: HelpComponent.ANY_ADMIN },
    { id: 'kpi-manage',     icon: 'fa-tasks',            label: '9. จัดการตัวชี้วัด',                 roles: HelpComponent.ADMIN_CENTRAL },
    { id: 'settings',       icon: 'fa-sliders-h',        label: '10. ตั้งค่าระบบ',                    roles: HelpComponent.SUPER_ONLY },
    { id: 'roles',          icon: 'fa-shield-alt',       label: '11. สิทธิ์การใช้งาน',                roles: 'all' },
    { id: 'audit-logs',     icon: 'fa-history',          label: '12. ประวัติการใช้งาน',               roles: HelpComponent.SUPER_ONLY },
    { id: 'kpi-manager',    icon: 'fa-layer-group',      label: '13. จัดการข้อมูล KPI',               roles: HelpComponent.SUPER_ONLY },
    { id: 'online-users',   icon: 'fa-users',            label: '14. ผู้ใช้งานออนไลน์',               roles: HelpComponent.SUPER_ONLY },
    { id: 'kpi-setup',      icon: 'fa-plus-circle',      label: '15. KPI ปีงบประมาณใหม่',             roles: HelpComponent.SUPER_ONLY },
    { id: 'backup',         icon: 'fa-database',         label: '16. สำรอง & กู้คืนข้อมูล',           roles: HelpComponent.SUPER_ONLY },
    { id: 'audit-digest',   icon: 'fa-bullhorn',         label: '17. แจ้งเตือนการบันทึก KPI',         roles: HelpComponent.SUPER_ONLY },
    { id: 'announcements',  icon: 'fa-bullhorn',         label: '18. ประกาศระบบ',                    roles: HelpComponent.SUPER_ONLY },
    { id: 'error-logs',     icon: 'fa-bug',              label: '19. Error Logs',                   roles: HelpComponent.SUPER_ONLY },
    { id: 'maintenance',    icon: 'fa-tools',            label: '20. โหมดปิดปรับปรุงระบบ',            roles: HelpComponent.SUPER_ONLY },
    { id: 'feedback',       icon: 'fa-comments',         label: '21. กระดานข้อเสนอแนะ',               roles: 'all' },
    { id: 'faq',            icon: 'fa-question-circle',  label: '22. คำถามที่พบบ่อย',                 roles: 'all' }
  ];

  /** sections ที่ user role ปัจจุบันเห็น (sidebar/menu ใช้ตัวนี้) */
  get visibleSections() {
    return this.sections.filter(s => this.canSeeSection(s.id));
  }

  /** ตรวจว่า role ปัจจุบันเห็น section นั้นได้หรือไม่ */
  canSeeSection(id: string): boolean {
    const s = this.sections.find(x => x.id === id);
    if (!s) return false;
    if (s.roles === 'all') return true;
    // ถ้าเป็น public view (ไม่ login) → เห็นเฉพาะ section ที่ 'all'
    if (this.isPublicView) return false;
    return s.roles.includes(this.currentRole);
  }

  /** ป้ายชื่อ role แบบอ่านง่าย */
  get roleLabel(): string {
    const labels: { [k: string]: string } = {
      super_admin: 'ผู้ดูแลระบบสูงสุด (Super Admin)',
      admin_ssj:   'ผู้ดูแล สสจ. (Admin SSJ)',
      admin_cup:   'ผู้ดูแล CUP (Admin CUP)',
      admin_hos:   'ผู้ดูแลโรงพยาบาล (Admin HOS)',
      admin_sso:   'ผู้ดูแล สสอ. (Admin SSO)',
      user_cup:    'ผู้ใช้ CUP',
      user_hos:    'ผู้ใช้โรงพยาบาล',
      user_sso:    'ผู้ใช้ สสอ.',
      user_ssj:    'ผู้ใช้ สสจ.'
    };
    return labels[this.currentRole] || this.currentRole || 'ไม่ได้ระบุ';
  }

  toggleCollapse(id: string) {
    this.collapsedSections[id] = !this.collapsedSections[id];
  }

  isCollapsed(id: string): boolean {
    return !!this.collapsedSections[id];
  }

  scrollTo(id: string) {
    this.activeSection = id;
    const el = document.getElementById('section-' + id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
