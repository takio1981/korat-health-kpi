import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http'; // Import HttpClient และ HttpHeaders
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})

export class AuthService {
  private http = inject(HttpClient); // ใช้ inject แทน Constructor
  private apiUrl = 'http://localhost:3000/api'; // URL ของ Node.js ที่เราสร้างไว้
  
  constructor() { }

  // ฟังก์ชันยิง API ไปที่ Backend เพื่อ Login
  login(credentials: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/login`, credentials);
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
  updateKpiResults(data: any[], targetHospcode: string = ''): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });
    
    // ถ้ามี targetHospcode ให้ห่อข้อมูลใส่ property 'updates'
    let payload;
    if (targetHospcode) {
        payload = { updates: data, targetHospcode };
    } else {
        payload = data; // กรณีปกติส่งเป็น Array ตรงๆ
    }
    
    return this.http.post(`${this.apiUrl}/update-kpi`, payload, { headers });
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

  changePassword(data: { currentPassword: string; newPassword: string }): Observable<any> {
    const token = localStorage.getItem('kpi_token');
    const headers = new HttpHeaders({ 'Authorization': `Bearer ${token}` });
    return this.http.put(`${this.apiUrl}/users/change-password`, data, { headers });
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

  // --- Report Summary APIs ---
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
}