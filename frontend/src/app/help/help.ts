import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { PdfExportService } from '../services/pdf-export.service';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-help',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './help.html'
})
export class HelpComponent {
  private authService = inject(AuthService);
  private router = inject(Router);
  private pdfExport = inject(PdfExportService);
  activeSection: string = 'overview';
  currentRole: string = '';
  showMobileTopics: boolean = false;
  isPublicView: boolean = false;
  exportingPdf: boolean = false;

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
    { id: 'role-page-access', icon: 'fa-user-lock',      label: '22. สิทธิ์การเข้าถึงหน้า',            roles: HelpComponent.SUPER_ONLY },
    { id: 'faq',            icon: 'fa-question-circle',  label: '23. คำถามที่พบบ่อย',                 roles: 'all' }
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

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * ส่งออกคู่มือทั้งหมด (เฉพาะหัวข้อที่สิทธิ์ปัจจุบันเห็น) เป็น PDF — 1 หัวข้อต่อ 1 หน้าขึ้นไป
   * ขยายหัวข้อที่พับไว้ (collapsedSections) ให้ครบก่อน capture แล้วคืนค่าเดิมหลังเสร็จ
   */
  async exportToPdf() {
    if (this.exportingPdf) return;
    this.exportingPdf = true;

    // เก็บสถานะการพับหัวข้อเดิมไว้ก่อน แล้วขยายให้หมด — กันเนื้อหาที่ผู้ใช้พับไว้ก่อนกด export หายไปจาก PDF
    const priorCollapsed = { ...this.collapsedSections };
    this.collapsedSections = {};

    Swal.fire({
      title: 'กำลังสร้าง PDF...',
      html: `<div class="text-left text-sm space-y-2">
        <div class="flex items-center gap-2"><i class="fas fa-spinner fa-spin text-green-500"></i> <span id="help-pdf-step">เตรียมข้อมูล...</span></div>
        <div class="w-full bg-gray-200 rounded-full h-3 mt-2"><div id="help-pdf-progress" class="bg-green-500 h-3 rounded-full transition-all duration-300" style="width: 0%"></div></div>
      </div>`,
      allowOutsideClick: false,
      showConfirmButton: false,
    });
    await this.wait(150); // ให้ Angular re-render หัวข้อที่เพิ่งขยายก่อน capture

    try {
      await this.pdfExport.waitFontsReady();
      const doc = this.pdfExport.createDoc();
      const sections = this.visibleSections;

      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const stepEl = document.getElementById('help-pdf-step');
        const progEl = document.getElementById('help-pdf-progress');
        if (stepEl) stepEl.textContent = `${i + 1}/${sections.length}: ${s.label}`;
        if (progEl) (progEl as HTMLElement).style.width = `${Math.round(((i + 1) / sections.length) * 100)}%`;

        const el = document.getElementById('section-' + s.id);
        if (!el) continue;
        await this.pdfExport.addElementAsPages(doc, el, i === 0);
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      this.pdfExport.save(doc, `คู่มือการใช้งาน_KHUPS-KPI_${dateStr}.pdf`);
      Swal.close();
      Swal.fire({ icon: 'success', title: 'สร้าง PDF สำเร็จ', timer: 1800, showConfirmButton: false });
    } catch (e: any) {
      Swal.close();
      Swal.fire('ผิดพลาด', 'ไม่สามารถสร้าง PDF ได้: ' + (e?.message || e), 'error');
    } finally {
      this.collapsedSections = priorCollapsed;
      this.exportingPdf = false;
    }
  }
}
