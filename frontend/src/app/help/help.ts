import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth';

@Component({
  selector: 'app-help',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './help.html'
})
export class HelpComponent {
  private authService = inject(AuthService);
  activeSection: string = 'overview';
  currentRole: string = '';

  ngOnInit() {
    this.currentRole = this.authService.getUserRole();
  }

  collapsedSections: { [key: string]: boolean } = {};

  sections = [
    { id: 'overview', icon: 'fa-home', label: 'ภาพรวมระบบ' },
    { id: 'register', icon: 'fa-user-plus', label: 'การลงทะเบียน' },
    { id: 'login', icon: 'fa-sign-in-alt', label: 'การเข้าสู่ระบบ' },
    { id: 'dashboard', icon: 'fa-th-large', label: 'Dashboard' },
    { id: 'charts', icon: 'fa-chart-bar', label: 'กราฟและสถิติ' },
    { id: 'notifications', icon: 'fa-bell', label: 'แจ้งเตือน' },
    { id: 'users', icon: 'fa-users-cog', label: 'จัดการผู้ใช้งาน' },
    { id: 'kpi-manager', icon: 'fa-layer-group', label: 'จัดการข้อมูล KPI' },
    { id: 'maintenance', icon: 'fa-tools', label: 'Maintenance Mode' },
    { id: 'feedback', icon: 'fa-comments', label: 'กระดานข้อเสนอแนะ' },
    { id: 'settings', icon: 'fa-sliders-h', label: 'ตั้งค่าระบบ' },
    { id: 'roles', icon: 'fa-shield-alt', label: 'สิทธิ์การใช้งาน' },
    { id: 'faq', icon: 'fa-question-circle', label: 'คำถามที่พบบ่อย' }
  ];

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
