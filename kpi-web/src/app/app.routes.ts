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
import { authGuard } from './guards/auth-guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'dashboard', component: DashboardComponent, canActivate: [authGuard] }, // ป้องกันหน้า Dashboard ด้วย Auth Guard
  { path: 'charts', component: ChartComponent, canActivate: [authGuard] }, // หน้ากราฟใหม่
  { path: 'reports', component: ReportComponent, canActivate: [authGuard] }, // หน้ารายงานสรุปผล
  { path: 'users', component: UserManagementComponent, canActivate: [authGuard] }, // หน้าจัดการผู้ใช้
  { path: 'audit-logs', component: AuditLogComponent, canActivate: [authGuard] }, // หน้า Audit Log
  { path: 'kpi-setup', component: KpiSetupComponent, canActivate: [authGuard] }, // หน้า Setup KPI
  { path: 'kpi-manage', component: KpiManageComponent, canActivate: [authGuard] }, // หน้าจัดการตัวชี้วัด
  { path: 'settings', component: SettingsComponent, canActivate: [authGuard] }, // หน้าตั้งค่าระบบ
  { path: '', redirectTo: '/login', pathMatch: 'full' } // ถ้าเข้าเว็บมาตรงๆ ให้เด้งไปหน้า login ก่อนเลย
];