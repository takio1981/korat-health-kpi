import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { vi } from 'vitest';
import Swal from 'sweetalert2';
import { testProviders } from '../testing/test-providers';
import { ZoneManagerComponent, districtZoneChanges, DistrictZoneRow } from './zone-manager';
import { setZoneNames, zoneLabel } from './zone';

// หน้าจัดการโซน (9 พ.ย. 2569) — ชื่อโซน, เพิ่มโซน, ย้ายอำเภอ (หน่วยบริการทั้งอำเภอเปลี่ยนตาม)
const zones = [
  { code: '1', name: 'เมือง', district_count: 5, hospital_count: 60 },
  { code: '7', name: '', district_count: 0, hospital_count: 0 },
];
const districts: DistrictZoneRow[] = [
  { distid: '3001', distname: 'เมืองนครราชสีมา', zone: '1', hospital_count: 30, mismatch_count: 0, hospital_zones: { '1': 30 } },
  { distid: '3019', distname: 'ขามทะเลสอ', zone: '1', hospital_count: 8, mismatch_count: 2, hospital_zones: { '1': 6, '2': 2 } },
];

describe('zone-manager', () => {
  it('districtZoneChanges: เฉพาะอำเภอที่เลือกโซนต่างจากเดิม พร้อมจำนวนหน่วยบริการ', () => {
    expect(districtZoneChanges([{ ...districts[0], _zone: '1' }, { ...districts[1], _zone: '7' }]))
      .toEqual([{ distid: '3019', zone: '7', from: '1', distname: 'ขามทะเลสอ', hospitals: 8 }]);
    expect(districtZoneChanges([])).toEqual([]);
  });

  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [ZoneManagerComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); setZoneNames([]); });

  function create(canEdit = true) {
    const f = TestBed.createComponent(ZoneManagerComponent);
    f.componentInstance.canAdd = canEdit;
    f.componentInstance.canEdit = canEdit;
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/zones') && r.method === 'GET').flush({ success: true, data: zones });
    if (canEdit) http.expectOne(r => r.url.endsWith('/zones/districts')).flush({ success: true, data: districts });
    f.detectChanges();
    return f;
  }

  it('โหลดโซน/อำเภอ → ชื่อโซนใช้ทั่วระบบ → เตือนอำเภอที่หน่วยบริการอยู่คนละโซน → ย้ายอำเภอส่งเฉพาะที่เปลี่ยน', async () => {
    const swal = vi.spyOn(Swal, 'fire').mockReturnValue(Promise.resolve({ isConfirmed: true } as any));
    const f = create();
    const el = f.nativeElement as HTMLElement;
    expect(zoneLabel('1')).toBe('โซน 1 · เมือง');            // HospitalZoneService.applyZoneNames
    expect(el.textContent).toContain('มีหน่วยบริการอยู่โซนอื่น 2 แห่ง');
    const c = f.componentInstance;
    expect(c.changes).toEqual([]);
    c.districts[1]._zone = '7';
    expect(c.confirmHtml()).toContain('อ.ขามทะเลสอ');
    expect(c.confirmHtml()).toContain('(8 แห่ง)');
    c.saveDistricts();
    await Promise.resolve();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/zones/districts'));
    expect(put.request.body).toEqual({ changes: [{ distid: '3019', zone: '7' }] });
    expect(swal).toHaveBeenCalled();
  });

  it('ไม่มีสิทธิ์แก้ไข = ไม่โหลดอำเภอและไม่มีปุ่มเพิ่ม/บันทึก', () => {
    const f = create(false);
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#btn-zone-add')).toBeNull();
    expect(el.querySelector('#btn-zone-save-districts')).toBeNull();
    http.verify();
  });
});
