import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { testProviders } from '../testing/test-providers';
import Swal from 'sweetalert2';
import { WorkCenterComponent, daysLeftText, fiscalYearChoices, dashboardQuery, monthsText, chunk, buildApprovePayload, buildRejectPayload, reviewKey, reminderProgressText } from './work-center';

describe('ศูนย์งานผู้ดูแล — ความคืบหน้าการส่งเตือน (งานเบื้องหลัง)', () => {
  it('reminderProgressText: ยังไม่มีรายการ / หน่วยบริการ / ข้อความ LINE-อีเมล', () => {
    expect(reminderProgressText(null)).toBe('กำลังเตรียมรายการ...');
    expect(reminderProgressText({ progress: { recipients_done: 3, recipients_total: 10, messages_done: 0, messages_total: 0 } })).toBe('ผู้รับ 3 / 10 คน');
    expect(reminderProgressText({ progress: { recipients_done: 10, recipients_total: 10, messages_done: 4, messages_total: 20 } }))
      .toBe('ผู้รับ 10 / 10 คน<br>LINE/อีเมล 4 / 20 ข้อความ');
  });
});

describe('ศูนย์งานผู้ดูแล — อนุมัติ/ส่งคืนจากคิว (ฟังก์ชันล้วน)', () => {
  it('รายการอนุมัติ: ไม่เลือกเดือน = ไม่ส่ง through_month (server ใช้เดือนล่าสุดที่มีผลงาน)', () => {
    const items = [{ indicator_id: '5', hospcode: '10669', pending_count: 2 }];
    expect(buildApprovePayload(items, '2570', '')).toEqual([{ indicator_id: 5, year_bh: '2570', hospcode: '10669' }]);
    expect(buildApprovePayload(items, '2570', 11)).toEqual([{ indicator_id: 5, year_bh: '2570', hospcode: '10669', through_month: 11 }]);
  });
  it('รายการส่งคืน: เหตุผลตัดช่องว่าง ไม่ระบุเดือน (= เฉพาะเดือนที่ยังไม่อนุมัติ)', () => {
    expect(buildRejectPayload([{ indicator_id: 5, hospcode: '10669' }], '2570', '  แก้ค่า ต.ค. ')).toEqual([
      { indicator_id: 5, year_bh: '2570', hospcode: '10669', comment: 'แก้ค่า ต.ค.' }]);
  });
  it('แบ่งชุด / ชื่อเดือน / คีย์รายการ', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(monthsText([10, 11, 1])).toBe('ต.ค., พ.ย., ม.ค.');
    expect(monthsText(null)).toBe('');
    expect(reviewKey({ indicator_id: '5', hospcode: '10669' })).toBe('5|10669');
  });
});

describe('ศูนย์งานผู้ดูแล — ฟังก์ชันล้วน', () => {
  it('ข้อความวันถึงกำหนดส่ง', () => {
    expect(daysLeftText(3)).toBe('อีก 3 วัน');
    expect(daysLeftText(0)).toBe('ครบกำหนดวันนี้');
    expect(daysLeftText(-2)).toBe('เลยกำหนด 2 วัน');
    expect(daysLeftText(null)).toBe('');
  });
  it('ปีงบที่เลือกได้ใช้ getCurrentFiscalYear (ต.ค. = ปีงบถัดไป)', () => {
    expect(fiscalYearChoices(new Date(2026, 10, 21))).toEqual(['2570', '2569', '2568']);
    expect(fiscalYearChoices(new Date(2026, 8, 30))).toEqual(['2569', '2568', '2567']);
  });
  it('ลิงก์หน้าบันทึกผลงาน: รหัสหน่วยบริการ + ชื่อตัวชี้วัด (ตัดยาว/ช่องว่างซ้ำ)', () => {
    expect(dashboardQuery('10669', 'ร้อยละ  ผู้ป่วย', '2570')).toEqual({ q: '10669 ร้อยละ ผู้ป่วย', year: '2570' });
    expect(dashboardQuery(null, 'x'.repeat(100), '2570').q.length).toBe(60);
    expect(dashboardQuery('10669', null, '2570').q).toBe('10669');
  });
});

describe('WorkCenterComponent', () => {
  const setup = async () => {
    localStorage.setItem('kpi_user', JSON.stringify({ role: 'admin_ssj' }));
    await TestBed.configureTestingModule({ imports: [WorkCenterComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(WorkCenterComponent);
    return { f, http: TestBed.inject(HttpTestingController), router: TestBed.inject(Router) };
  };
  afterEach(() => localStorage.removeItem('kpi_user'));

  it('ส่งเตือนได้เฉพาะปีงบประมาณปัจจุบัน (ปีอื่น = ไม่เรียก preview)', async () => {
    const { f, http } = await setup();
    const c = f.componentInstance;
    const cur = fiscalYearChoices()[0];
    c.year = cur;
    expect(c.canRemindYear).toBe(true);
    c.year = String(Number(cur) - 1);
    expect(c.canRemindYear).toBe(false);
    const sw = vi.spyOn(Swal, 'fire').mockResolvedValue({} as any);
    c.sendReminderNow();
    expect(sw).toHaveBeenCalled();
    sw.mockRestore();
    http.expectNone(r => r.url.includes('/work-center/reminders/preview'));
  });

  it('โหลดภาพรวม → การ์ด + รายการยังไม่ส่ง และเปิดหน้าบันทึกผลงานที่กรองให้', async () => {
    const { f, http, router } = await setup();
    f.detectChanges();
    http.expectOne(r => r.url.includes('/work-center/summary')).flush({ success: true, data: {
      year_bh: '2570', month_bh: 10, month_label: 'ต.ค. 2569', due_date: '2026-11-10', due_text: '10 พ.ย. 2569', days_left: 3,
      can_review: true, is_super_admin: false, review: { pending_pairs: 4, pending_months: 9, appeal_pairs: 1 },
      missing: { pairs: 5, hospitals: 2, indicators: 3 }, reminder: { enabled: false, due_day: 10, last_run: null }, khd: null,
    } });
    const miss = http.expectOne(r => r.url.includes('/work-center/missing'));
    expect(miss.request.params.get('month_bh') ?? miss.request.url).toContain('10');
    miss.flush({ success: true, data: { month_label: 'ต.ค. 2569', items: [{ hospcode: '10669', hosname: 'รพ.ทดสอบ', count: 2 }], excluded_periodic_indicators: 0 } });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#wc-pending')?.textContent).toContain('4');
    expect(el.querySelector('#wc-missing')?.textContent).toContain('2');
    expect(el.querySelector('#wc-missing-list')?.textContent).toContain('รพ.ทดสอบ');
    expect(el.querySelector('#btn-wc-remind')).toBeNull(); // ไม่ใช่ super_admin
    const nav = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    f.componentInstance.openDashboard('10669', null);
    expect(nav).toHaveBeenCalledWith(['/dashboard'], { queryParams: { q: '10669', year: '2570' } });
  });

  it('แท็บรอตรวจสอบโหลด /work-center/review-queue', async () => {
    const { f, http } = await setup();
    f.detectChanges();
    http.expectOne(r => r.url.includes('/work-center/summary')).flush({ success: true, data: null });
    http.match(r => r.url.includes('/work-center/missing')).forEach(r => r.flush({ success: true, data: null }));
    f.componentInstance.year = '2570';
    f.componentInstance.setTab('review');
    http.expectOne(r => r.url.includes('/work-center/review-queue')).flush({ success: true, items: [{ indicator_id: 1, hospcode: '10669', kpi_indicators_name: 'KPI ก', pending_count: 2 }] });
    expect(f.componentInstance.review.items.length).toBe(1);
  });

  it('เลือกรายการในคิว + ส่งอนุมัติเป็นชุดผ่าน /approve-kpi เดิม แล้วรวมผล', async () => {
    const { f, http } = await setup();
    const c = f.componentInstance;
    c.review = { items: [{ indicator_id: 1, hospcode: '10669' }, { indicator_id: 2, hospcode: '10670' }] };
    c.toggleAll();
    expect(c.allSelected).toBe(true);
    c.toggleSel(c.review.items[1]);
    expect(c.selectedItems.map((r: any) => r.indicator_id)).toEqual([1]);
    let agg: any = null;
    c.runBatches('/approve-kpi', [buildApprovePayload(c.selectedItems, '2570', ''), [{ indicator_id: 9 }]], (a) => agg = a);
    const r1 = http.expectOne(r => r.url.includes('/approve-kpi'));
    expect(r1.request.body).toEqual([{ indicator_id: 1, year_bh: '2570', hospcode: '10669' }]);
    r1.flush({ success: true, approved: 1, skipped: 0, months: 3 });
    http.expectOne(r => r.url.includes('/approve-kpi')).flush({ success: false, message: 'ไม่มีสิทธิ์' }, { status: 403, statusText: 'Forbidden' });
    expect(agg).toMatchObject({ ok: 1, months: 3, failed: 1, errors: ['ไม่มีสิทธิ์'] });
  });
});
