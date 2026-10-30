import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { ZoneBadgeComponent, HospitalZoneService } from './zone-badge';

// ป้าย "โซน N" ต่อท้ายชื่อหน่วยบริการ — หาโซนจากรหัสหน่วยบริการ (GET /hospital-zones โหลดครั้งเดียวแล้วแชร์)
describe('ZoneBadgeComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [ZoneBadgeComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  const make = (inputs: Record<string, any>) => {
    const f = TestBed.createComponent(ZoneBadgeComponent);
    Object.entries(inputs).forEach(([k, v]) => f.componentRef.setInput(k, v));
    f.detectChanges();
    return f;
  };

  it('หาโซนจากรหัสหน่วยบริการ — โหลดตารางครั้งเดียวแม้มีหลายป้าย', () => {
    const a = make({ hospcode: '10666' });
    const b = make({ hospcode: '10890' });
    const req = http.expectOne(r => r.url.endsWith('/hospital-zones'));
    req.flush({ success: true, data: { '10666': '1', '10890': '6' } });
    a.detectChanges(); b.detectChanges();
    expect(a.nativeElement.textContent.trim()).toBe('โซน 1');
    expect(b.nativeElement.textContent.trim()).toBe('โซน 6');
    make({ hospcode: '10666' });
    http.expectNone(r => r.url.endsWith('/hospital-zones'));
  });

  it('ระบุ zone ตรงๆ = ไม่ต้องโหลด, ไม่มีโซน = ไม่แสดงป้าย', () => {
    const f = make({ zone: '3' });
    expect(f.nativeElement.textContent.trim()).toBe('โซน 3');
    TestBed.inject(HospitalZoneService).zones$.next({ '10666': '1' });
    const none = make({ zone: '', hospcode: '99999' });
    expect(none.nativeElement.querySelector('span')).toBeNull();
  });
});
