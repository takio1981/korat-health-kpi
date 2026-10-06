import { TestBed } from '@angular/core/testing';
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

  it('canAccessPage อ่านค่าจาก cache เมื่อมี', () => {
    localStorage.setItem('kpi_page_access', JSON.stringify({ dashboard: true, settings: false }));
    expect(service.canAccessPage('dashboard')).toBe(true);
    expect(service.canAccessPage('settings')).toBe(false);
  });
});
