import { TestBed } from '@angular/core/testing';
import Swal from 'sweetalert2';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { MyRoleRequestComponent, roleRequestLabel, approverHint } from './my-role-request';
import { RoleRequestAdminComponent, ROLE_ON_BEHALF } from './role-request-admin';

describe('คำขอเปลี่ยนสิทธิ์ — ฟังก์ชันล้วน', () => {
  it('ชื่อสิทธิ์ + ผู้อนุมัติที่เป็นไปได้ตามระดับสิทธิ์ที่ขอ', () => {
    expect(roleRequestLabel('admin_cup')).toContain('ผู้ดูแลอำเภอ');
    expect(roleRequestLabel('xyz')).toBe('xyz');
    expect(approverHint('user_ssj')).toContain('ผู้ดูแล รพ./สสอ.');
    expect(approverHint('admin_hos')).not.toContain('ผู้ดูแล รพ./สสอ.');
    expect(approverHint('admin_hos')).toContain('ผู้ดูแลอำเภอ');
    expect(approverHint('admin_ssj')).toBe('ผู้ดูแลระบบสูงสุด');
    expect(ROLE_ON_BEHALF).toEqual(['admin_hos', 'admin_sso', 'admin_cup']);
  });
});

describe('MyRoleRequestComponent', () => {
  beforeEach(() => { vi.spyOn(Swal, 'fire').mockResolvedValue({ isConfirmed: false } as any); });
  afterEach(() => vi.restoreAllMocks());
  it('โหลดสถานะ → ส่งคำขอพร้อมเหตุผล / มีคำขอรออนุมัติ = ซ่อนฟอร์มและยกเลิกได้', async () => {
    await TestBed.configureTestingModule({ imports: [MyRoleRequestComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(MyRoleRequestComponent);
    const c = f.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    c.open();
    http.expectOne(r => r.url.includes('/my-role-request')).flush({ success: true, data: {
      role: 'user_hos', eligible: true, requestable: ['user_cup', 'admin_hos'], pending: null,
      requests: [{ id: 1, from_role: 'user_hos', to_role: 'user_ssj', status: 'rejected', decision_note: 'ยังไม่ได้รับมอบหมาย' }] } });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#my-role-form')).toBeTruthy();
    expect(el.querySelectorAll('.role-req-history').length).toBe(1);
    c.reqRole = 'admin_hos'; c.reqNote = '  ได้รับมอบหมาย ';
    c.request();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/my-role-request'));
    expect(req.request.body).toEqual({ role: 'admin_hos', note: 'ได้รับมอบหมาย' });
    req.flush({ success: true, message: 'ok' });
    http.expectOne(r => r.url.includes('/my-role-request')).flush({ success: true, data: {
      role: 'user_hos', eligible: true, requestable: [], pending: { id: 2, from_role: 'user_hos', to_role: 'admin_hos', request_note: 'x', status: 'pending' }, requests: [] } });
    f.detectChanges();
    expect(el.querySelector('#my-role-form')).toBeNull();
    expect(el.querySelector('#my-role-pending')?.textContent).toContain('ผู้ดูแลอำเภอ');
    c.cancel(c.data.pending);
    expect(http.expectOne(r => r.url.includes('/role-requests/2/cancel')).request.method).toBe('POST');
  });
});

describe('RoleRequestAdminComponent', () => {
  it('โหลดคำขอ → จำนวนรอพิจารณา / ยื่นแทนผู้ใช้ไม่มีสิทธิ์เดิมในตัวเลือก', async () => {
    await TestBed.configureTestingModule({ imports: [RoleRequestAdminComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(RoleRequestAdminComponent);
    const c = f.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    let pending = -1;
    c.pendingChange.subscribe(n => pending = n);
    c.load();
    http.expectOne(r => r.url.includes('/role-requests')).flush({ success: true, data: {
      requests: [{ id: 5, user_id: 3, from_role: 'user_hos', to_role: 'admin_hos', requested_by: 3 }], filed: [], can_file: true,
      requestable: ['user_hos', 'user_cup', 'admin_hos'] } });
    expect(pending).toBe(1);
    expect(c.canFile).toBe(true);
    c.openFile({ id: 8, username: 'u8', role: 'user_hos' });
    expect(c.fileOptions).toEqual(['user_cup', 'admin_hos']);
    c.fileRole = 'user_cup'; c.fileNote = 'ย้ายงาน';
    c.submitFile();
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/role-requests'));
    expect(req.request.body).toEqual({ user_id: 8, role: 'user_cup', note: 'ย้ายงาน' });
  });
});
