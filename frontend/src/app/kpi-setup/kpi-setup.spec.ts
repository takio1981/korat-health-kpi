import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KpiSetupComponent, buildSetupBatches } from './kpi-setup';
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

  it('เลือกหลายหน่วยบริการ: ค้นหา/เลือกทั้งหมดที่แสดง/คงที่เลือกเมื่อเปลี่ยนอำเภอ (22 พ.ย. 2569)', () => {
    component.hospitals = [
      { hoscode: '10669', hosname: 'รพ.ก', distid: '3001' }, { hoscode: '10670', hosname: 'รพ.ข', distid: '3001' },
      { hoscode: '20001', hosname: 'รพ.สต.ค', distid: '3002' }];
    component.selectedDistrict = '3001';
    component.onDistrictChange();
    expect(component.pickerList.map(h => h.hoscode)).toEqual(['10669', '10670']);
    component.selectAllShown();
    expect(component.hosPickerText).toBe('เลือกแล้ว 2 แห่ง');
    component.selectedDistrict = '3002';
    component.onDistrictChange();
    component.toggleHos('20001');
    expect(component.selectedHospitalList).toEqual(['10669', '10670', '20001']);
    component.hosSearch = 'สต';
    component.refreshPicker();
    expect(component.pickerList.map(h => h.hoscode)).toEqual(['20001']);
    component.toggleHos('10669'); component.toggleHos('10670');
    expect(component.hosPickerText).toBe('20001: รพ.สต.ค');
    component.clearHospitals();
    expect(component.hosPickerText).toBe('-- เลือกหน่วยบริการ --');
  });

  it('แบ่งคำขอชุดละ ≤ 30 หน่วยบริการ แถวระบุ hospcode', () => {
    const rows = [{ indicator_id: 1 }, { indicator_id: 2 }];
    const hcs = Array.from({ length: 65 }, (_, i) => String(10000 + i));
    const b = buildSetupBatches(rows, [...hcs, '10000']);
    expect(b.map(x => x.hospcodes.length)).toEqual([30, 30, 5]);
    expect(b[0].rows.length).toBe(60);
    expect(b[0].rows[0]).toEqual({ indicator_id: 1, hospcode: '10000' });
    expect(b[2].rows.at(-1)).toEqual({ indicator_id: 2, hospcode: '10064' });
  });
});
