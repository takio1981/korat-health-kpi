import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { AuthService } from './auth';
import { testProviders } from '../testing/test-providers';

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: testProviders });
    service = TestBed.inject(AuthService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  // fail-open: ยังไม่มี cache สิทธิ์ (เช่น ก่อน login) ต้องไม่บล็อกหน้า — backend เป็นด่านตัดสินจริง
  it('canAccessPage คืน true เมื่อยังไม่มี cache สิทธิ์ (fail-open)', () => {
    expect(service.canAccessPage('dashboard')).toBe(true);
  });

  // Regression (7 ต.ค. 2569): admin ที่ถูกปิดหน้า users ยังเรียก /users/pending-count → 403 ทุกหน้า
  it('refreshPendingUsers ไม่เรียก API เมื่อ role ไม่มีสิทธิ์หน้า users', () => {
    const http = TestBed.inject(HttpTestingController);
    localStorage.setItem('kpi_page_access', JSON.stringify({ users: false }));
    service.refreshPendingUsers();
    http.expectNone(r => r.url.includes('/users/pending-count'));

    localStorage.setItem('kpi_page_access', JSON.stringify({ users: true }));
    service.refreshPendingUsers();
    http.expectOne(r => r.url.includes('/users/pending-count'));
  });

  // 7 ต.ค. 2569: dropdown ทั่วระบบได้เฉพาะตัวชี้วัดที่เปิดใช้งาน — เฉพาะหน้าจัดการตัวชี้วัดขอทุกตัว
  it('getIndicators ขอทุกตัว (include_inactive=1) เฉพาะเมื่อสั่ง', () => {
    const http = TestBed.inject(HttpTestingController);
    service.getIndicators().subscribe();
    http.expectOne(r => r.url.endsWith('/indicators'));
    service.getIndicators(true).subscribe();
    http.expectOne(r => r.url.endsWith('/indicators?include_inactive=1'));
  });

  it('canAccessPage อ่านค่าจาก cache เมื่อมี', () => {
    localStorage.setItem('kpi_page_access', JSON.stringify({ dashboard: true, settings: false }));
    expect(service.canAccessPage('dashboard')).toBe(true);
    expect(service.canAccessPage('settings')).toBe(false);
  });
});
