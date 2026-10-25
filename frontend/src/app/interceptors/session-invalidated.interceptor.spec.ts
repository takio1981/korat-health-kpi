// ตัวดักคำขอ: 401 SESSION_ENDED / ACCOUNT_DISABLED (เพิ่ม 25 ต.ค. 2569 — backend ปฏิเสธ token หลัง logout/บังคับ logout/ปิดใช้งานบัญชี)
// ต้องล้าง token ในเครื่องเสมอ และแจ้งเตือนเฉพาะเมื่อยังมี token อยู่ (ผู้ใช้ไม่ได้กดออกจากระบบเอง)
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import Swal from 'sweetalert2';
import { sessionInvalidatedInterceptor } from './session-invalidated.interceptor';

describe('sessionInvalidatedInterceptor — SESSION_ENDED / ACCOUNT_DISABLED', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let fire: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([sessionInvalidatedInterceptor])), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    // jsdom ไม่มี window.matchMedia — Swal.fire แบบมี icon ใช้ไม่ได้ จึงแทนด้วย mock
    fire = vi.spyOn(Swal, 'fire').mockImplementation((() => new Promise(() => {})) as any);
    localStorage.clear();
  });
  afterEach(() => { fire.mockRestore(); localStorage.clear(); });

  const respond401 = (code: string) => {
    http.get('/x').subscribe({ error: () => {} });
    ctrl.expectOne('/x').flush({ success: false, code }, { status: 401, statusText: 'Unauthorized' });
  };

  // หมายเหตุ: ตัวแปรสถานะ "กำลังแจ้ง" ของตัวดักคำขอคงอยู่ตลอดไฟล์ (กล่องที่ mock ไม่ถูกปิด) — ลำดับเคสจึงสำคัญ
  it('บัญชีถูกปิดใช้งานขณะใช้งาน (มี token) → ล้าง token + แจ้ง "บัญชีถูกปิดใช้งาน"', () => {
    localStorage.setItem('kpi_token', 't'); localStorage.setItem('kpi_user', '{}');
    respond401('ACCOUNT_DISABLED');
    expect(localStorage.getItem('kpi_token')).toBeNull();
    expect(localStorage.getItem('kpi_user')).toBeNull();
    expect(fire).toHaveBeenCalledTimes(1);
    expect((fire.mock.calls[0][0] as any).title).toContain('ปิดใช้งาน');
  });

  it('ผู้ใช้ออกจากระบบเองแล้ว (ไม่มี token) → ไม่แจ้งซ้ำ', () => {
    respond401('SESSION_ENDED');
    expect(fire).not.toHaveBeenCalled();
  });

  it('ระหว่างกล่องแจ้งเตือนก่อนหน้ายังเปิดอยู่ คำขอถัดไปยังล้าง token (แต่ไม่แจ้งซ้ำ)', () => {
    // กล่องจากเคสแรกยังไม่ปิด (mock ไม่ resolve) — ตัวแปรสถานะของตัวดักคำขอยังเป็น "กำลังแจ้ง"
    localStorage.setItem('kpi_token', 't');
    respond401('SESSION_ENDED');
    expect(localStorage.getItem('kpi_token')).toBeNull();
    expect(fire).not.toHaveBeenCalled();
  });
});
