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
  private static readonly ADMIN_CENTRAL = ['super_admin','admin_ssj'];
  private static readonly SUPER_ONLY = ['super_admin'];

  // section.roles: 'all' = แสดงทุกคน (รวม public), array = แสดงเฉพาะ role ที่ระบุ
  sections: { id: string; icon: string; label: string; roles: 'all' | string[] }[] = [
    { id: 'overview',      icon: 'fa-home',             label: 'ภาพรวมระบบ',                  roles: 'all' },
    { id: 'register',      icon: 'fa-user-plus',        label: 'การลงทะเบียน',                 roles: 'all' },
    { id: 'login',         icon: 'fa-sign-in-alt',      label: 'การเข้าสู่ระบบ',                roles: 'all' },
    { id: 'dashboard',     icon: 'fa-th-large',         label: 'Dashboard',                  roles: 'all' },
    { id: 'charts',        icon: 'fa-chart-bar',        label: 'กราฟและสถิติ',                roles: 'all' },
    { id: 'notifications', icon: 'fa-bell',             label: 'แจ้งเตือน',                    roles: 'all' },
    { id: 'users',         icon: 'fa-users-cog',        label: 'จัดการผู้ใช้งาน',              roles: HelpComponent.ADMIN_CENTRAL },
    { id: 'kpi-manager',   icon: 'fa-layer-group',      label: 'จัดการข้อมูล KPI',             roles: HelpComponent.ADMIN_CENTRAL },
    { id: 'online-users',  icon: 'fa-users',            label: 'ผู้ใช้งานออนไลน์',             roles: HelpComponent.SUPER_ONLY },
    { id: 'backup',        icon: 'fa-database',         label: 'สำรอง & กู้คืนข้อมูล',         roles: HelpComponent.SUPER_ONLY },
    { id: 'audit-digest',  icon: 'fa-bullhorn',         label: 'แจ้งเตือนการบันทึก KPI',       roles: HelpComponent.ADMIN_CENTRAL },
    { id: 'maintenance',   icon: 'fa-tools',            label: 'Maintenance Mode',           roles: HelpComponent.SUPER_ONLY },
    { id: 'feedback',      icon: 'fa-comments',         label: 'กระดานข้อเสนอแนะ',             roles: 'all' },
    { id: 'settings',      icon: 'fa-sliders-h',        label: 'ตั้งค่าระบบ',                  roles: HelpComponent.SUPER_ONLY },
    { id: 'roles',         icon: 'fa-shield-alt',       label: 'สิทธิ์การใช้งาน',              roles: 'all' },
    { id: 'faq',           icon: 'fa-question-circle',  label: 'คำถามที่พบบ่อย',               roles: 'all' }
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
