import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import Swal from 'sweetalert2';
import { LoginComponent } from './login';
import { AuthService } from '../services/auth';
import { testProviders } from '../testing/test-providers';

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  let auth: AuthService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: testProviders,
    }).compileComponents();

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
    vi.restoreAllMocks();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  // เข้าสู่ระบบอัตโนมัติจาก KHD (9 พ.ย. 2569)
  it('มี ?khd_token= → ล้างออกจาก URL ทันที (คงพารามิเตอร์อื่น) และส่ง token ไปตรวจที่ backend', () => {
    window.history.replaceState({}, '', '/khupskpi/login?khd_token=abc.def.ghi&lang=th');
    vi.spyOn(Swal, 'fire').mockReturnValue(Promise.resolve({} as any));
    vi.spyOn(Swal, 'close').mockImplementation(() => {});
    const spy = vi.spyOn(auth, 'khdLogin').mockReturnValue(of({ success: false }));
    component.handleKhdTokenParam();
    expect(spy).toHaveBeenCalledWith('abc.def.ghi', false);
    expect(window.location.search).toBe('?lang=th');
    expect(window.location.href).not.toContain('khd_token');
  });

  it('ไม่มี khd_token → ไม่เรียก backend (ผู้ใช้กรอกชื่อผู้ใช้/รหัสผ่านเอง)', () => {
    window.history.replaceState({}, '', '/khupskpi/login');
    const spy = vi.spyOn(auth, 'khdLogin');
    component.handleKhdTokenParam();
    expect(spy).not.toHaveBeenCalled();
  });
});

// น้องโคราชดีบินในหน้าเข้าสู่ระบบ (19 พ.ย. 2569)
describe('LoginComponent — น้องโคราชดี', () => {
  let component: LoginComponent;
  let fixture: ComponentFixture<LoginComponent>;
  beforeEach(async () => {
    localStorage.removeItem('kpi_login_mascot');
    await TestBed.configureTestingModule({ imports: [LoginComponent], providers: testProviders }).compileComponents();
    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
  });
  afterEach(() => { localStorage.removeItem('kpi_login_mascot'); vi.restoreAllMocks(); });

  it('ระบบปิด = ไม่แสดงทั้งตัวละครและปุ่ม', () => {
    component.mascotSystemOn = false;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-login-mascot')).toBeNull();
    expect(fixture.nativeElement.querySelector('#btn-login-mascot')).toBeNull();
  });

  it('ระบบเปิด = แสดง, ผู้เข้าชมกดซ่อน → จำค่าในเครื่อง, กดอีกครั้งแสดงกลับ', () => {
    component.mascotSystemOn = true;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-login-mascot')).not.toBeNull();
    fixture.nativeElement.querySelector('#btn-login-mascot').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-login-mascot')).toBeNull();
    expect(localStorage.getItem('kpi_login_mascot')).toBe('off');
    expect(LoginComponent.readMascotHidden()).toBe(true);
    component.toggleMascot();
    expect(component.showMascot).toBe(true);
    expect(localStorage.getItem('kpi_login_mascot')).toBe('on');
  });

  it('รับค่าจาก maintenance-status: login_mascot_enabled false = ปิด, ไม่มีฟิลด์ = เปิด', () => {
    const auth = TestBed.inject(AuthService);
    vi.spyOn(auth, 'getMaintenanceStatus').mockReturnValue(of({ login_mascot_enabled: false }));
    (component as any).checkMaintenance();
    expect(component.mascotSystemOn).toBe(false);
    vi.spyOn(auth, 'getMaintenanceStatus').mockReturnValue(of({}));
    (component as any).checkMaintenance();
    expect(component.mascotSystemOn).toBe(true);
  });
});
