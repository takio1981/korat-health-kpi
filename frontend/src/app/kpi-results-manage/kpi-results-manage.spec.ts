import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import Swal from 'sweetalert2';
import { KpiResultsManageComponent } from './kpi-results-manage';
import { testProviders } from '../testing/test-providers';

// เลือกทั้งหมดที่ค้นหาได้ทุกหน้า + ลบเป็นชุด (12 พ.ย. 2569)
describe('KpiResultsManageComponent — เลือกทั้งหมดที่ค้นหาได้', () => {
  let component: KpiResultsManageComponent;
  let fixture: ComponentFixture<KpiResultsManageComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [KpiResultsManageComponent], providers: testProviders }).compileComponents();
    fixture = TestBed.createComponent(KpiResultsManageComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    component.yearBh = '2570';
    component.monthFrom = 11; component.monthTo = 1;
    component.hasSearched = true;
    component.total = 5; component.pages = 3; component.page = 1;
    component.data = [{ id: 1 }, { id: 2 }];
  });

  it('ขอรหัสทุกแถวด้วยเงื่อนไขเดียวกับตาราง แล้วเลือกครบทุกหน้า | คลิกอีกครั้ง = ยกเลิกทั้งหมด', () => {
    component.toggleSelectAllMatching();
    const req = http.expectOne(r => r.url.includes('/kpi-results/manage/ids'));
    const q = new URL(req.request.urlWithParams).searchParams;
    expect([q.get('year_bh'), q.get('month_from'), q.get('month_to'), q.has('page')]).toEqual(['2570', '11', '1', false]);
    req.flush({ success: true, ids: [1, 2, 3, 4, 5], truncated: false, max: 20000 });
    expect(component.selectedIds.size).toBe(5);
    expect(component.isAllMatchingSelected).toBe(true);
    expect(component.isPartialMatchingSelected).toBe(false);
    component.toggleSelectAllMatching();
    expect(component.selectedIds.size).toBe(0);
  });

  it('เปลี่ยนหน้าแล้วคงรายการที่เลือก | ค้นหาใหม่ล้างรายการที่เลือก', () => {
    component.selectedIds = new Set([1, 2, 3]);
    component.goPage(2);
    http.expectOne(r => r.url.includes('/kpi-results/manage') && r.url.includes('page=2')).flush({ success: true, data: [{ id: 3 }], total: 5 });
    expect(component.selectedIds.size).toBe(3);
    expect(component.isPartialMatchingSelected).toBe(true);
    component.applyFilters();
    http.expectOne(r => r.url.includes('/kpi-results/manage') && r.url.includes('page=1')).flush({ success: true, data: [], total: 0 });
    expect(component.selectedIds.size).toBe(0);
  });

  it('ลบเป็นชุดละ deleteBatchSize ตามลำดับ แล้วล้างรายการที่เลือก', async () => {
    const swal = vi.spyOn(Swal, 'fire').mockResolvedValue({} as any);
    vi.spyOn(Swal, 'update').mockImplementation(() => {});
    vi.spyOn(Swal, 'showLoading').mockImplementation(() => {});
    const ids = Array.from({ length: 2500 }, (_, i) => i + 1);
    component.selectedIds = new Set(ids);
    const p = component.deleteInBatches(ids);
    for (const n of [1000, 1000, 500]) {
      await Promise.resolve(); await Promise.resolve();
      const req = http.expectOne(r => r.url.includes('/kpi-results/manage/bulk-delete'));
      expect(req.request.body.ids.length).toBe(n);
      req.flush({ success: true, deletedKpi: n, deletedSub: 0 });
    }
    await p;
    expect(swal).toHaveBeenLastCalledWith(expect.objectContaining({ icon: 'success', text: expect.stringContaining('kpi_results 2500') }));
    expect(component.selectedIds.size).toBe(0);
    http.expectOne(r => r.url.includes('/kpi-results/manage') && !r.url.includes('bulk'));
  });
});
