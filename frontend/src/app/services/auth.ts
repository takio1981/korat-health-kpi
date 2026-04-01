import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})

export class AuthService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  // Shared realtime notification count
  private _unreadCount$ = new BehaviorSubject<number>(0);
  unreadCount$ = this._unreadCount$.asObservable();

  // Shared realtime pending KPI stats
  private _pendingStats$ = new BehaviorSubject<any>({ deptCount: 0, hosCount: 0, indicatorCount: 0 });
  pendingStats$ = this._pendingStats$.asObservable();

  constructor() { }

  // ฟังก์ชันยิง API ไปที่ Backend เพื่อ Login
  login(credentials: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/login`, credentials);
  }
  // ฟังก์ชันลงทะเบียนผู้ใช้งานใหม่ (Public - ไม่ต้อง login)
  register(userData: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/register`, userData);
  }

  // === Public endpoints สำหรับหน้าลงทะเบียน (ไม่ต้อง login) ===
  getPublicDepartments(): Observable<any> {
    return this.http.get(`${this.apiUrl}/public/departments`);
  }
  getPublicHospitals(): Observable<any> {
    return this.http.get(`${this.apiUrl}/public/hospitals`);
  }
  getPublicDistricts(): Observable<any> {
    return this.http.get(`${this.apiUrl}/public/districts`);
  }
  getPublicKpiResults(): Observable<any> {
    return this.http.get(`${this.apiUrl}/public/kpi-results`);
  }
  getPublicDashboardStats(year: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/public/dashboard-stats?year=${year}`);
  }

  // 1. ฟังก์ชันบันทึก Token เมื่อล็อกอินสำเร็จ
  saveToken(token: string) {
    localStorage.setItem('kpi_token', token);
  }

  // 1.1 ฟังก์ชันบันทึกข้อมูลผู้ใช้
  saveUser(user: any) {
    localStorage.setItem('kpi_user', JSON.stringify(user));
  }

  // 1.2 ฟังก์ชันดึงข้อมูลผู้ใช้ปัจจุบัน
  getUser(): any {
    const userStr = localStorage.getItem('kpi_user');
    return userStr ? JSON.parse(userStr) : null;
  }

  // 2. ฟังก์ชันลบ Token เมื่อออกจากระบบ
  logout() {
    localStorage.removeItem('kpi_token');
    localStorage.removeItem('kpi_user');
  }

  // 3. ฟังก์ชันเช็คว่าล็อกอินอยู่หรือไม่ (เช็คว่ามี Token ไหม)
  isLoggedIn(): boolean {
    const token = localStorage.getItem('kpi_token');
    return !!token; // คืนค่า true ถ้ามีข้อมูล, false ถ้าเป็น null หรือว่าง
  }

  // 4. ฟังก์ชันดึง Role ของผู้ใช้จาก Token
  getUserRole(): string {
    const token = localStorage.getItem('kpi_token');
    if (!token) return '';
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.role || '';
    } catch (e) {
      return '';
    }
  }

  getKpiResults(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.get(`${this.apiUrl}/kpi-results`, { headers });
  }

  // ฟังก์ชันดึงข้อมูลสถิติ Dashboard
  getDashboardStats(year: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.get(`${this.apiUrl}/dashboard-stats?year=${year}`, { headers });
  }

  // ฟังก์ชันสำหรับบันทึกผล KPI ที่แก้ไขแล้ว
  // mode: 'setup_overwrite' = KPI-Setup เพิ่มทั้งหมด (เขียนทับ)
  //        'setup_insert_new' = KPI-Setup เพิ่มเฉพาะที่ยังไม่มี
  //        undefined = Dashboard ปกติ
  updateKpiResults(data: any[], targetHospcode: string = '', mode: string = ''): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });

    let payload: any;
    if (targetHospcode || mode) {
        payload = { updates: data, targetHospcode, mode };
    } else {
        payload = data; // กรณีปกติส่งเป็น Array ตรงๆ
    }

    return this.http.post(`${this.apiUrl}/update-kpi`, payload, { headers });
  }

  // ตรวจสอบข้อมูล KPI ที่มีอยู่สำหรับ KPI-Setup
  checkKpiSetup(hospcode: string, yearBh: string, deptId: string = ''): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    let url = `${this.apiUrl}/kpi-setup-check?hospcode=${hospcode}&year_bh=${yearBh}`;
    if (deptId) url += `&dept_id=${deptId}`;
    return this.http.get(url, { headers });
  }

  // ฟังก์ชันสำหรับอนุมัติผล KPI
  approveKpiResults(data: any[]): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.post(`${this.apiUrl}/approve-kpi`, data, { headers });
  }

  // --- User Management APIs ---
  getUsers(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/users`, { headers });
  }

  getDepartments(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/departments`, { headers });
  }

  getHospitals(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/hospitals`, { headers });
  }

  getDistricts(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/districts`, { headers });
  }

  createUser(userData: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.post(`${this.apiUrl}/users`, userData, { headers });
  }

  updateUser(id: number, userData: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.put(`${this.apiUrl}/users/${id}`, userData, { headers });
  }

  deleteUser(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.delete(`${this.apiUrl}/users/${id}`, { headers });
  }

  resetPassword(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.put(`${this.apiUrl}/users/${id}/reset-password`, {}, { headers });
  }

  approveUser(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/users/${id}/approve`, {}, { headers });
  }

  rejectUser(id: number, reason: string = ''): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/users/${id}/reject`, { reason }, { headers });
  }

  toggleUserActive(id: number, isActive: boolean): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/users/${id}/toggle-active`, { is_active: isActive }, { headers });
  }

  bulkToggleActive(isActive: boolean): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/users/bulk-toggle-active`, { is_active: isActive }, { headers });
  }

  getMaintenanceStatus(): Observable<any> {
    return this.http.get(`${this.apiUrl}/system/maintenance-status`);
  }

  setMaintenanceMode(enabled: boolean, message: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/system/maintenance-mode`, { enabled, message }, { headers });
  }

  getUserById(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/users/${id}/basic`, { headers });
  }

  changePassword(currentPassword: string, newPassword: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/users/change-password`, { currentPassword, newPassword }, { headers });
  }

  forgotPassword(username: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/forgot-password`, { username });
  }

  getSystemLogs(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.get(`${this.apiUrl}/system-logs`, { headers });
  }

  getKpiTemplate(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.get(`${this.apiUrl}/kpi-template`, { headers });
  }

  getSettings(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/settings`, { headers });
  }

  updateSettings(settings: any[]): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.post(`${this.apiUrl}/settings`, settings, { headers });
  }

  // --- Log Management APIs ---
  // === ENV Config ===
  getEnvConfig(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/env-config`, { headers });
  }
  saveEnvConfig(settings: any[]): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/env-config`, { settings }, { headers });
  }

  // === DB Compare (HDC) ===
  dbCompare(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/db-compare`, { headers });
  }
  dbCompareCreateLocal(tables: string[]): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/db-compare/create-local`, { tables }, { headers });
  }
  dbCompareSyncData(tables: string[]): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/db-compare/sync-data`, { tables }, { headers });
  }

  reportCompare(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/report-compare`, { headers });
  }
  reportCompareSync(hdc_report_ids: number[]): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/report-compare/sync`, { hdc_report_ids }, { headers });
  }

  testTelegram(token: string, chatId: string): Observable<any> {
    const authToken = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${authToken}` });
    return this.http.post(`${this.apiUrl}/test-telegram`, { bot_token: token, chat_id: chatId }, { headers });
  }

  testAdminEmail(emails: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/test-admin-email`, { emails }, { headers });
  }

  backupDatabase(): Observable<Blob> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/backup-database`, { headers, responseType: 'blob' });
  }

  backupLogs(): Observable<Blob> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.get(`${this.apiUrl}/logs/backup`, { 
      headers, 
      responseType: 'blob' 
    });
  }

  clearLogs(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    return this.http.delete(`${this.apiUrl}/logs/clear`, { headers });
  }

  // --- KPI Approval & Lock APIs ---
  approveKpi(indicatorId: number, yearBh: string, hospcode?: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/approve-kpi`, { indicator_id: indicatorId, year_bh: yearBh, hospcode }, { headers });
  }

  unlockKpi(indicatorId: number, yearBh: string, hospcode: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/unlock-kpi`, { indicator_id: indicatorId, year_bh: yearBh, hospcode }, { headers });
  }

  getPendingKpiCount(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/notifications/pending-kpi`, { headers });
  }

  // --- KPI Management APIs ---
  // Main Yut
  getMainYut(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/main-yut`, { headers });
  }
  createMainYut(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/main-yut`, data, { headers });
  }
  updateMainYut(id: number, data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/main-yut/${id}`, data, { headers });
  }
  deleteMainYut(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.delete(`${this.apiUrl}/main-yut/${id}`, { headers });
  }

  // Main Indicators
  getMainIndicators(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/main-indicators`, { headers });
  }
  createMainIndicator(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/main-indicators`, data, { headers });
  }
  updateMainIndicator(id: number, data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/main-indicators/${id}`, data, { headers });
  }
  deleteMainIndicator(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.delete(`${this.apiUrl}/main-indicators/${id}`, { headers });
  }

  // KPI Indicators
  getIndicators(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/indicators`, { headers });
  }
  createIndicator(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/indicators`, data, { headers });
  }
  updateIndicator(id: number, data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/indicators/${id}`, data, { headers });
  }
  deleteIndicator(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.delete(`${this.apiUrl}/indicators/${id}`, { headers });
  }

  // Departments (CRUD)
  createDepartment(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/departments`, data, { headers });
  }
  updateDepartment(id: number, data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/departments/${id}`, data, { headers });
  }
  deleteDepartment(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.delete(`${this.apiUrl}/departments/${id}`, { headers });
  }

  // --- Toggle is_active APIs ---
  toggleIndicatorActive(id: number, isActive: boolean): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/indicators/${id}/toggle-active`, { is_active: isActive }, { headers });
  }
  toggleMainIndicatorActive(id: number, isActive: boolean): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/main-indicators/${id}/toggle-active`, { is_active: isActive }, { headers });
  }
  toggleStrategyActive(id: number, isActive: boolean): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/main-yut/${id}/toggle-active`, { is_active: isActive }, { headers });
  }
  toggleDepartmentActive(id: number, isActive: boolean): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/departments/${id}/toggle-active`, { is_active: isActive }, { headers });
  }

  // --- KPI Replies API ---
  getKpiReplies(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/kpi-replies`, { headers });
  }

  // --- Report Summary APIs ---
  // --- Rejection & Notification APIs ---
  rejectKpi(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/reject-kpi`, data, { headers });
  }

  getNotifications(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/notifications`, { headers });
  }

  markNotificationsRead(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/notifications/mark-read`, data, { headers });
  }

  getUnreadNotificationCount(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/notifications/unread-count`, { headers }).pipe(
      tap((res: any) => {
        if (res.success) this._unreadCount$.next(res.count);
      })
    );
  }

  /** เรียกเพื่อ refresh unread count จากทุกที่ (layout, notifications, dashboard) */
  refreshUnreadCount() {
    this.getUnreadNotificationCount().subscribe();
  }

  /** อัพเดท pending stats จากทุกที่ */
  refreshPendingStats() {
    this.getPendingKpiCount().subscribe({
      next: (res: any) => {
        if (res.success) this._pendingStats$.next(res.data);
      }
    });
  }

  getRejectionComments(indicatorId: number, yearBh: string, hospcode: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/rejection-comments/${indicatorId}/${yearBh}/${hospcode}`, { headers });
  }

  replyKpi(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/reply-kpi`, data, { headers });
  }

  getReportByIndicator(params: any = {}): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    const queryStr = new URLSearchParams(params).toString();
    return this.http.get(`${this.apiUrl}/report/by-indicator${queryStr ? '?' + queryStr : ''}`, { headers });
  }

  getReportByHospital(params: any = {}): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    const queryStr = new URLSearchParams(params).toString();
    return this.http.get(`${this.apiUrl}/report/by-hospital${queryStr ? '?' + queryStr : ''}`, { headers });
  }

  getReportByDistrict(params: any = {}): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    const queryStr = new URLSearchParams(params).toString();
    return this.http.get(`${this.apiUrl}/report/by-district${queryStr ? '?' + queryStr : ''}`, { headers });
  }

  getReportByYear(params: any = {}): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    const queryStr = new URLSearchParams(params).toString();
    return this.http.get(`${this.apiUrl}/report/by-year${queryStr ? '?' + queryStr : ''}`, { headers });
  }

  // Export KPI Tables
  getExportableIndicators(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/exportable-indicators`, { headers });
  }

  exportKpiTables(yearBh: string, indicatorIds: number[] | 'all'): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/export-kpi-tables`, { year_bh: yearBh, indicator_ids: indicatorIds }, { headers });
  }

  checkKpiExport(yearBh: string, indicatorIds: number[] | 'all'): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/check-kpi-export`, { year_bh: yearBh, indicator_ids: indicatorIds }, { headers });
  }

  // Data Entry Lock
  getDataEntryLock(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/data-entry-lock`, { headers });
  }

  // Appeal (อุทธรณ์)
  getAppealSettings(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/appeal-settings`, { headers });
  }

  appealKpi(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/appeal-kpi`, data, { headers });
  }

  approveAppeal(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/appeal-approve`, data, { headers });
  }

  notifyAppealEdited(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/appeal-edited`, data, { headers });
  }

  rejectAppeal(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/appeal-reject`, data, { headers });
  }

  // --- Target Edit Request APIs ---
  getTargetEditRequests(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/target-edit-requests`, { headers });
  }

  requestTargetEdit(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/target-edit-request`, data, { headers });
  }

  approveTargetEditRequest(requestId: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/target-edit-approve`, { request_id: requestId }, { headers });
  }

  rejectTargetEditRequest(requestId: number, reason: string): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/target-edit-reject`, { request_id: requestId, reason }, { headers });
  }

  completeTargetEditRequest(requestId: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/target-edit-complete`, { request_id: requestId }, { headers });
  }

  // --- Form Builder APIs ---
  getFormSchemas(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/form-schemas`, { headers });
  }

  getAllIndicatorsWithSchema(): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/form-schemas/all-indicators`, { headers });
  }

  getFormSchemaByIndicator(indicatorId: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.get(`${this.apiUrl}/form-schemas/indicator/${indicatorId}`, { headers });
  }

  saveFormSchema(data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/form-schemas`, data, { headers });
  }

  deleteFormSchema(id: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.delete(`${this.apiUrl}/form-schemas/${id}`, { headers });
  }

  getDynamicData(tableName: string, params: any = {}): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    const queryStr = new URLSearchParams(params).toString();
    return this.http.get(`${this.apiUrl}/dynamic-data/${tableName}${queryStr ? '?' + queryStr : ''}`, { headers });
  }

  saveDynamicData(tableName: string, data: any): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.post(`${this.apiUrl}/dynamic-data/${tableName}`, data, { headers });
  }

  getDynamicDataMonths(tableName: string, params: any = {}): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    const queryStr = new URLSearchParams(params).toString();
    return this.http.get(`${this.apiUrl}/dynamic-data-months/${tableName}${queryStr ? '?' + queryStr : ''}`, { headers });
  }

  deleteDynamicData(tableName: string, recordId: number): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.delete(`${this.apiUrl}/dynamic-data/${tableName}/${recordId}`, { headers });
  }
}