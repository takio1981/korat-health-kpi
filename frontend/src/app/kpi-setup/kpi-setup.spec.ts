import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KpiSetupComponent } from './kpi-setup';
import { testProviders } from '../testing/test-providers';

describe('KpiSetupComponent', () => {
  let component: KpiSetupComponent;
  let fixture: ComponentFixture<KpiSetupComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KpiSetupComponent],
      providers: testProviders,
    }).compileComponents();

    fixture = TestBed.createComponent(KpiSetupComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('ตัวชี้วัดบันทึกรายไตรมาส: เดือนกลางไตรมาสว่าง/ปิด + แสดงค่าไตรมาส (11 พ.ย. 2569)', () => {
    component.kpiTemplateAll = [
      { indicator_id: 1, dept_id: 1, target_percentage: '10', quarter_mode: 'quarter' },
      { indicator_id: 2, dept_id: 1, target_percentage: '10', quarter_mode: 'month_sum' },
      { indicator_id: 3, dept_id: 1, target_percentage: '10' }];
    component.applyDeptFilter();
    const [q, m, n] = component.kpiTemplate;
    expect(q.nov).toBe('');
    expect(q.dece).toBe(0);
    expect(m.nov).toBe(0);
    expect(['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].filter(k => !component.isQuarterOff(q, k))).toEqual(['dece', 'mar', 'jun', 'sep']);
    expect(component.isQuarterOff(n, 'nov')).toBe(false);
    q.nov = 5;
    component.onValueChange(q, 'nov');
    expect(q.nov).toBe('');
    expect(component.quarterText(q, 'dece')).toBe('ไตรมาส 1');
    m.oct = 1; m.nov = 2; m.dece = 3;
    expect(component.quarterText(m, 'dece')).toBe('ไตรมาส 1: 6');
    expect(component.quarterText(n, 'dece')).toBe('');
    expect(component.quarterBadgeText(q)).toBe('รายไตรมาส');
    expect(component.quarterBadgeText(n)).toBe('');
  });
});
