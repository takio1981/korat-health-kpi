import { Routes } from '@angular/router';
import { LoginComponent } from './login/login';
import { DashboardComponent } from './dashboard/dashboard';
import { ChartComponent } from './chart/chart';
import { UserManagementComponent } from './user-management/user-management';
import { AuditLogComponent } from './audit-log/audit-log';
import { KpiSetupComponent } from './kpi-setup/kpi-setup';
import { SettingsComponent } from './settings/settings';
import { KpiManageComponent } from './kpi-manage/kpi-manage';
import { ReportComponent } from './report/report';
import { NotificationsComponent } from './notifications/notifications';
import { authGuard } from './guards/auth-guard';
import { LayoutComponent } from './layout/layout';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: '', redirectTo: '/login', pathMatch: 'full' },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: 'dashboard', component: DashboardComponent, data: { title: 'ภาพรวมตัวชี้วัด' } },
      { path: 'charts', component: ChartComponent, data: { title: 'รายงานสถิติและกราฟ' } },
      { path: 'reports', component: ReportComponent, data: { title: 'รายงานสรุปผล' } },
      { path: 'notifications', component: NotificationsComponent, data: { title: 'การแจ้งเตือน' } },
      { path: 'users', component: UserManagementComponent, data: { title: 'จัดการผู้ใช้งาน' } },
      { path: 'audit-logs', component: AuditLogComponent, data: { title: 'ประวัติการใช้งาน' } },
      { path: 'kpi-setup', component: KpiSetupComponent, data: { title: 'สร้าง KPI ปีงบประมาณใหม่' } },
      { path: 'kpi-manage', component: KpiManageComponent, data: { title: 'จัดการตัวชี้วัด' } },
      { path: 'settings', component: SettingsComponent, data: { title: 'ตั้งค่าระบบ' } },
    ]
  }
];