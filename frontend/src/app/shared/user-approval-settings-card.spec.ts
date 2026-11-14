import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import Swal from 'sweetalert2';
import { testProviders } from '../testing/test-providers';
import { UserApprovalSettingsCardComponent, delayText, userApprovalLastRunText } from './user-approval-settings-card';

// อนุมัติผู้สมัครใหม่อัตโนมัติ + ส่งผู้ใช้ใหม่ขึ้น KHD (13 พ.ย. 2569)
describe('UserApprovalSettingsCardComponent', () => {
  let http: HttpTestingController;
  const DATA = { autoApprove: false, delay: 5, syncOnApprove: false, syncSchedule: false, syncTime: '02:00',
    approveNotify: { inapp: true, email: true, telegram: true, line: true }, syncNotify: { inapp: true, email: false, telegram: false, line: false, failedOnly: true } };

  beforeEach(async () => {
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [UserApprovalSettingsCardComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    vi.spyOn(Swal, 'fire').mockImplementation((() => Promise.resolve({})) as any);
  });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  const make = () => {
    const f = TestBed.createComponent(UserApprovalSettingsCardComponent);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/user-approval/settings') && r.method === 'GET')
      .flush({ success: true, data: DATA, status: { waiting_auto: 2, pending_all: 5, khd_failed: 1, last_run: { task: 'sync', synced: 3, failed: 1, at: '2026-11-13T02:00:00Z' } } });
    f.detectChanges();
    return f;
  };

  it('delayText / ผลครั้งล่าสุด', () => {
    expect(delayText(5)).toBe('5 นาที');
    expect(delayText(1500)).toBe('1 วัน 1 ชั่วโมง');
    expect(userApprovalLastRunText(null)).toBe('ยังไม่เคยทำงาน');
    expect(userApprovalLastRunText({ task: 'approve', approved: 2 })).toContain('อนุมัติอัตโนมัติ 2 บัญชี');
  });

  it('โหลดค่า + สถานะ → บันทึกส่งค่าที่ตั้ง | ระยะเวลาผิด = ไม่ส่ง', () => {
    const f = make();
    const c = f.componentInstance;
    expect(f.nativeElement.querySelector('#ua-status').textContent).toContain('2');
    expect(f.nativeElement.querySelectorAll('#uaApproveCh-channels input').length).toBe(4);
    expect(f.nativeElement.querySelectorAll('#uaSyncCh-channels input').length).toBe(4);
    expect(c.lastRun).toContain('ส่งขึ้น KHD สำเร็จ 3');
    c.s!.delay = 0;
    c.save();
    http.expectNone(r => r.method === 'PUT');
    c.s = { ...DATA, autoApprove: true, delay: 10, syncOnApprove: true, syncSchedule: true, syncTime: '03:15',
      approveNotify: { ...DATA.approveNotify }, syncNotify: { ...DATA.syncNotify } };
    // ช่องทางแจ้งเตือน (14 พ.ย. 2569): ปิด LINE ของการอนุมัติ, เปิด Telegram + แจ้งทุกครั้งของการส่ง KHD
    c.s.approveNotify.line = false;
    c.s.syncNotify.telegram = true;
    c.s.syncNotify.failedOnly = false;
    c.save();
    const req = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/user-approval/settings'));
    expect(req.request.body).toEqual({ autoApprove: true, delay: 10, syncOnApprove: true, syncSchedule: true, syncTime: '03:15',
      approveNotify: { inapp: true, email: true, telegram: true, line: false },
      syncNotify: { inapp: true, email: false, telegram: true, line: false, failedOnly: false } });
  });

  it('ปุ่มตรวจตอนนี้ / ส่งตอนนี้ เรียก /user-approval/run ตามงาน', () => {
    const c = make().componentInstance;
    c.run('sync');
    expect(http.expectOne(r => r.url.endsWith('/user-approval/run')).request.body).toEqual({ task: 'sync' });
  });
});
