import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { UserDeptAdminComponent, desiredDeptIds, canHaveExtraDepts } from './user-dept-admin';
import { MyDepartmentsComponent, ROLE_MULTI_DEPT } from './my-departments';

describe('กลุ่มงานเพิ่มเติม — ฟังก์ชันล้วน', () => {
  it('รายการที่ส่ง = อนุมัติอยู่นอกตัวเลือกของผู้ดูแล (คงเดิม) + ที่ติ๊ก − กลุ่มงานหลัก', () => {
    // admin_ssj กลุ่มงาน 5: ผู้ใช้มี 3 (นอกขอบเขต) + 5 อยู่แล้ว → เอา 5 ออก = เหลือ 3
    expect(desiredDeptIds([3, 5], new Set(), [5], 1)).toEqual([3]);
    // super_admin ติ๊ก 2, 4 (ตัวเลือกทั้งหมด) จาก 3 เดิม → 2, 4
    expect(desiredDeptIds([3], new Set([2, 4]), [2, 3, 4], 1)).toEqual([2, 4]);
    expect(desiredDeptIds([], new Set([1, 2]), [1, 2], 1)).toEqual([2]);
  });
  it('สิทธิ์ที่มีกลุ่มงานเพิ่มเติมได้ = ผู้ใช้ทั่วไป (ตรงกับ backend ROLE_MULTI_DEPT)', () => {
    expect(ROLE_MULTI_DEPT).toEqual(['user_ssj', 'user_hos', 'user_sso', 'user_cup', 'user']);
    expect(canHaveExtraDepts('user_hos')).toBe(true);
    expect(canHaveExtraDepts('admin_ssj')).toBe(false);
    expect(canHaveExtraDepts('super_admin')).toBe(false);
  });
});

describe('UserDeptAdminComponent', () => {
  it('โหลดคำขอ → ส่งจำนวนรออนุมัติให้หน้าแม่ / กำหนดกลุ่มงานให้ผู้ใช้ส่งรายการที่ติ๊ก', async () => {
    await TestBed.configureTestingModule({ imports: [UserDeptAdminComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(UserDeptAdminComponent);
    const c = f.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    let pending = -1;
    c.pendingChange.subscribe(n => pending = n);
    c.loadRequests();
    http.expectOne(r => r.url.includes('/user-dept-requests')).flush({ success: true, data: {
      requests: [{ id: 9, user_id: 3, dept_id: 5, dept_name: 'กลุ่มงาน ข' }], members: [] } });
    expect(pending).toBe(1);

    c.openForUser({ id: 3, username: 'u3' });
    http.expectOne(r => r.url.endsWith('/departments') && !r.url.includes('/users/')).flush({ success: true, data: [
      { id: 1, dept_name: 'ก' }, { id: 5, dept_name: 'ข' }, { id: 7, dept_name: 'ค' }] });
    http.expectOne(r => r.url.includes('/users/3/departments')).flush({ success: true, data: {
      primary: { dept_id: 1, dept_name: 'ก' }, grantable: null,
      extras: [{ dept_id: 7, status: 'approved' }, { dept_id: 5, status: 'pending' }] } });
    expect(c.editOptions.map(o => o.id)).toEqual([5, 7]);       // ไม่มีกลุ่มงานหลัก
    expect([...c.checked]).toEqual([7]);
    expect(c.statusOf(5)).toBe('pending');
    c.toggle(5);
    c.saveUser();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.includes('/users/3/departments'));
    expect(put.request.body).toEqual({ dept_ids: [5, 7] });
  });
});

describe('MyDepartmentsComponent', () => {
  it('เปิดแล้วโหลด /my-departments และส่งคำขอพร้อมเหตุผล', async () => {
    await TestBed.configureTestingModule({ imports: [MyDepartmentsComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(MyDepartmentsComponent);
    const c = f.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    c.open();
    http.expectOne(r => r.url.includes('/my-departments')).flush({ success: true, data: {
      eligible: true, primary: { dept_id: 1, dept_name: 'ก' }, extras: [{ dept_id: 5, dept_name: 'ข', status: 'pending' }], available: [{ id: 7, dept_name: 'ค' }] } });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#my-departments-modal')?.textContent).toContain('รออนุมัติ');
    c.reqDept = 7; c.reqNote = 'ดูแลตัวชี้วัด ค';
    c.request();
    const req = http.expectOne(r => r.url.includes('/my-departments/request'));
    expect(req.request.body).toEqual({ dept_id: 7, note: 'ดูแลตัวชี้วัด ค' });
  });
});
