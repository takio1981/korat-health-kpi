import { Routes } from '@angular/router';
import { LoginComponent } from './login/login';
import { RegisterComponent } from './register/register';
import { DashboardComponent } from './dashboard/dashboard';
import { ChartComponent } from './chart/chart';
import { UserManagementComponent } from './user-management/user-management';
import { AuditLogComponent } from './audit-log/audit-log';
import { KpiSetupComponent } from './kpi-setup/kpi-setup';
import { SettingsComponent } from './settings/settings';
import { KpiManageComponent } from './kpi-manage/kpi-manage';
import { ReportComponent } from './report/report';
import { NotificationsComponent } from './notifications/notifications';
import { HelpComponent } from './help/help';
import { FeedbackComponent } from './feedback/feedback';
import { ChangelogComponent } from './changelog/changelog';
import { KpiManagerComponent } from './kpi-manager/kpi-manager';
import { AnnouncementsComponent } from './announcements/announcements';
import { OnlineUsersComponent } from './online-users/online-users';
import { BackupManagerComponent } from './backup-manager/backup-manager';
import { KpiAuditDigestComponent } from './kpi-audit-digest/kpi-audit-digest';
import { ErrorLogsComponent } from './error-logs/error-logs';
import { SsoLogsComponent } from './sso-logs/sso-logs';
import { SsoCallbackComponent } from './sso-callback/sso-callback';
import { SopComponent } from './sop/sop';
import { RolePageAccessComponent } from './role-page-access/role-page-access';
import { authGuard } from './guards/auth-guard';
import { superAdminGuard } from './guards/super-admin-guard';
import { pageAccessGuard } from './guards/page-access-guard';
import { LayoutComponent } from './layout/layout';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'register', component: RegisterComponent },
  { path: 'sso-callback', component: SsoCallbackComponent },
  { path: 'help-public', component: HelpComponent },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: 'dashboard', component: DashboardComponent, canActivate: [pageAccessGuard], data: { title: 'บันทึกผลงานตัวชี้วัด', pageKey: 'dashboard' } },
      { path: 'charts', component: ChartComponent, canActivate: [pageAccessGuard], data: { title: 'รายงานสถิติ', pageKey: 'charts' } },
      { path: 'notifications', component: NotificationsComponent, canActivate: [pageAccessGuard], data: { title: 'การแจ้งเตือน', pageKey: 'notifications' } },
      { path: 'users', component: UserManagementComponent, canActivate: [pageAccessGuard], data: { title: 'จัดการผู้ใช้งาน', pageKey: 'users' } },
      { path: 'kpi-setup', component: KpiSetupComponent, canActivate: [pageAccessGuard], data: { title: 'สร้าง KPI ปีงบประมาณใหม่', pageKey: 'kpi-setup' } },
      { path: 'audit-logs', component: AuditLogComponent, canActivate: [pageAccessGuard], data: { title: 'ประวัติการใช้งาน', pageKey: 'audit-logs' } },
      { path: 'kpi-manage', component: KpiManageComponent, canActivate: [pageAccessGuard], data: { title: 'จัดการตัวชี้วัด', pageKey: 'kpi-manage' } },
      { path: 'kpi-manager', component: KpiManagerComponent, canActivate: [pageAccessGuard], data: { title: 'จัดการข้อมูล KPI', pageKey: 'kpi-manager' } },
      { path: 'settings', component: SettingsComponent, canActivate: [pageAccessGuard], data: { title: 'ตั้งค่าระบบ', pageKey: 'settings' } },
      { path: 'role-page-access', component: RolePageAccessComponent, canActivate: [superAdminGuard], data: { title: 'สิทธิ์การเข้าถึงหน้า' } },
      { path: 'announcements', component: AnnouncementsComponent, canActivate: [pageAccessGuard], data: { title: 'ประกาศระบบ', pageKey: 'announcements' } },
      { path: 'online-users', component: OnlineUsersComponent, canActivate: [pageAccessGuard], data: { title: 'ผู้ใช้งานออนไลน์', pageKey: 'online-users' } },
      { path: 'backup-manager', component: BackupManagerComponent, canActivate: [pageAccessGuard], data: { title: 'สำรอง & กู้คืนฐานข้อมูล', pageKey: 'backup-manager' } },
      { path: 'kpi-audit-digest', component: KpiAuditDigestComponent, canActivate: [pageAccessGuard], data: { title: 'แจ้งเตือนการบันทึก KPI', pageKey: 'kpi-audit-digest' } },
      { path: 'error-logs', component: ErrorLogsComponent, canActivate: [pageAccessGuard], data: { title: 'Error Logs', pageKey: 'error-logs' } },
      { path: 'sso-logs', component: SsoLogsComponent, canActivate: [pageAccessGuard], data: { title: 'SSO Audit Logs', pageKey: 'sso-logs' } },
      { path: 'sop', component: SopComponent, canActivate: [pageAccessGuard], data: { title: 'ผังกระบวนการทำงาน (SOP)', pageKey: 'sop' } },
      { path: 'feedback', component: FeedbackComponent, canActivate: [pageAccessGuard], data: { title: 'กระดานข้อเสนอแนะ', pageKey: 'feedback' } },
      { path: 'changelog', component: ChangelogComponent, canActivate: [pageAccessGuard], data: { title: 'ประวัติการอัปเดต', pageKey: 'changelog' } },
      { path: 'help', component: HelpComponent, canActivate: [pageAccessGuard], data: { title: 'คู่มือการใช้งาน', pageKey: 'help' } },
    ]
  },
  { path: '**', redirectTo: 'login' }
];
