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
import { ExportKpiComponent } from './export-kpi/export-kpi';
import { FormBuilderComponent } from './form-builder/form-builder';
import { HelpComponent } from './help/help';
import { DbCompareComponent } from './db-compare/db-compare';
import { EnvConfigComponent } from './env-config/env-config';
import { authGuard } from './guards/auth-guard';
import { adminGuard } from './guards/admin-guard';
import { anyAdminGuard } from './guards/any-admin-guard';
import { superAdminGuard } from './guards/super-admin-guard';
import { LayoutComponent } from './layout/layout';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'register', component: RegisterComponent },
  { path: 'help-public', component: HelpComponent },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: 'dashboard', component: DashboardComponent, data: { title: 'ภาพรวมตัวชี้วัด' } },
      { path: 'charts', component: ChartComponent, data: { title: 'รายงานสถิติและกราฟ' } },
      { path: 'reports', component: ReportComponent, data: { title: 'รายงานสรุปผล' } },
      { path: 'notifications', component: NotificationsComponent, data: { title: 'การแจ้งเตือน' } },
      { path: 'users', component: UserManagementComponent, canActivate: [anyAdminGuard], data: { title: 'จัดการผู้ใช้งาน' } },
      { path: 'kpi-setup', component: KpiSetupComponent, canActivate: [adminGuard], data: { title: 'สร้าง KPI ปีงบประมาณใหม่' } },
      { path: 'audit-logs', component: AuditLogComponent, canActivate: [superAdminGuard], data: { title: 'ประวัติการใช้งาน' } },
      { path: 'kpi-manage', component: KpiManageComponent, canActivate: [superAdminGuard], data: { title: 'จัดการตัวชี้วัด' } },
      { path: 'export-kpi', component: ExportKpiComponent, canActivate: [superAdminGuard], data: { title: 'Export ข้อมูล KPI' } },
      { path: 'settings', component: SettingsComponent, canActivate: [superAdminGuard], data: { title: 'ตั้งค่าระบบ' } },
      { path: 'form-builder', component: FormBuilderComponent, canActivate: [superAdminGuard], data: { title: 'สร้างแบบฟอร์ม KPI' } },
      { path: 'help', component: HelpComponent, data: { title: 'คู่มือการใช้งาน' } },
      { path: 'db-compare', component: DbCompareComponent, canActivate: [superAdminGuard], data: { title: 'DB Compare' } },
      { path: 'env-config', component: EnvConfigComponent, canActivate: [superAdminGuard], data: { title: 'Environment Config' } },
    ]
  },
  { path: '**', redirectTo: 'login' }
];