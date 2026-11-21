import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { testProviders } from '../testing/test-providers';
import { WorkCenterComponent, daysLeftText, fiscalYearChoices, dashboardQuery } from './work-center';

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
});
