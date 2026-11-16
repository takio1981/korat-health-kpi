import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import Swal from 'sweetalert2';
import { BackupManagerComponent } from './backup-manager';
import { testProviders } from '../testing/test-providers';

// กู้คืนจากไฟล์บน Google Drive (16 พ.ย. 2569)
describe('BackupManagerComponent — กู้คืนจาก Google Drive', () => {
  let component: BackupManagerComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [BackupManagerComponent], providers: testProviders }).compileComponents();
    component = TestBed.createComponent(BackupManagerComponent).componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  const openWith = (data: any[]) => {
    component.openDrivePicker();
    http.expectOne(r => r.method === 'GET' && r.url.endsWith('/backup/cloud/files'))
      .flush({ success: true, data, connections: [{ id: 3, name: 'KHD KPI DB', db_name: 'khups_kpi_db' }] });
  };

  it('โหลดรายการ: ตั้งการเชื่อมต่อจากที่ server เดาให้ และค้นหาชื่อไฟล์ได้', () => {
    openWith([
      { id: 'a1', name: 'khups_kpi_db_KHD_2026.sql.gz', size: 10, connection_id: 3, local_exists: false, known_connection: false },
      { id: 'b2', name: 'other.sql', size: 5, connection_id: null, local_exists: false, known_connection: false },
    ]);
    expect(component.showDrivePicker).toBe(true);
    expect(component.filteredDriveFiles.map(f => [f.id, f._conn])).toEqual([['a1', 3], ['b2', null]]);
    component.driveSearch = 'OTHER';
    component.refreshDriveFilter();
    expect(component.filteredDriveFiles.map(f => f.id)).toEqual(['b2']);
    expect(component.connectionLabel(3)).toBe('KHD KPI DB (khups_kpi_db)');
  });

  it('ยังไม่เลือกการเชื่อมต่อ = เตือน ไม่เรียก API', () => {
    openWith([{ id: 'b2', name: 'other.sql', size: 5, connection_id: null, local_exists: false }]);
    const swal = vi.spyOn(Swal, 'fire').mockResolvedValue({} as any);
    component.restoreFromDrive(component.filteredDriveFiles[0]);
    expect(swal).toHaveBeenCalledWith('เลือกการเชื่อมต่อ', expect.any(String), 'warning');
    http.expectNone(r => r.url.includes('/fetch'));
    swal.mockRestore();
  });

  it('มีไฟล์ในเซิร์ฟเวอร์แล้ว: เตรียมไฟล์โดยไม่ส่งการเชื่อมต่อ แล้วเปิดแท็บกู้คืนด้วยไฟล์นั้น', () => {
    openWith([{ id: 'a1', name: 'x.sql.gz', size: 10, connection_id: 3, local_exists: true, known_connection: true }]);
    const swal = vi.spyOn(Swal, 'fire').mockResolvedValue({} as any);
    component.restoreFromDrive(component.filteredDriveFiles[0]);
    const req = http.expectOne(r => r.method === 'POST' && r.url.endsWith('/backup/cloud/files/a1/fetch'));
    expect(req.request.body).toEqual({});
    req.flush({ success: true, downloaded: false, file: { id: 77, file_name: 'x.sql.gz', db_name: 'khups_kpi_db', size_bytes: 10 } });
    expect(component.activeTab).toBe('restore');
    expect(component.selectedFileForRestore.id).toBe(77);
    expect(component.restoreMode).toBe('new_db');
    expect(component.showDrivePicker).toBe(false);
    swal.mockRestore();
  });

  it('ป้ายการเก็บไฟล์ + ฟอร์มตารางเวลาโหลด keep_last / cleanup_cloud / อายุ 0 (16 พ.ย. 2569)', () => {
    expect(component.retentionLabel({ retention_days: 30, keep_last: 7 })).toBe('30 วัน · ล่าสุด 7 ไฟล์');
    expect(component.retentionLabel({ retention_days: 0, keep_last: 5 })).toBe('ล่าสุด 5 ไฟล์');
    expect(component.retentionLabel({ retention_days: 0, keep_last: 0 })).toBe('ไม่ลบอัตโนมัติ');
    component.openScheduleModal({ id: 1, name: 'x', connection_id: 3, days_of_week: '1,2', time_of_day: '02:00', retention_days: 0, keep_last: 7, cleanup_cloud: 1 });
    expect(component.scheduleForm).toEqual(expect.objectContaining({ retention_days: 0, keep_last: 7, cleanup_cloud: true }));
  });

  it('ล้างไฟล์เก่าตอนนี้: ดูรายการก่อน (preview) แล้วยืนยันจึงลบ', async () => {
    const swal = vi.spyOn(Swal, 'fire').mockResolvedValue({ isConfirmed: true } as any);
    component.cleanupScheduleNow({ id: 9, name: 'รายวัน', retention_days: 0, keep_last: 3 });
    const p = http.expectOne(r => r.url.endsWith('/backup/schedules/9/cleanup'));
    expect(p.request.body).toEqual({ preview: true });
    p.flush({ success: true, preview: true, files: 1, bytes: 10, kept: 3, cloud: 0, cleanup_cloud: false, list: [{ id: 5, file_name: 'a.sql.gz', size_bytes: 10, created_at: '2026-11-01', on_cloud: true }] });
    expect((swal.mock.calls[0][0] as any).html).toContain('(Drive เก็บไว้)');
    await Promise.resolve();
    const run = http.expectOne(r => r.url.endsWith('/backup/schedules/9/cleanup'));
    expect(run.request.body).toEqual({ preview: false });
    run.flush({ success: true, files: 1, message: 'ลบแล้ว 1 ไฟล์' });
    http.match(r => r.url.endsWith('/backup/files'));
    swal.mockRestore();
  });

  it('ต้องดาวน์โหลด: ยืนยันก่อน แล้วส่ง connection_id ที่เลือก', async () => {
    openWith([{ id: 'b2', name: 'other.sql', size: 5, connection_id: null, local_exists: false }]);
    component.filteredDriveFiles[0]._conn = 3;
    const swal = vi.spyOn(Swal, 'fire').mockResolvedValue({ isConfirmed: true } as any);
    component.restoreFromDrive(component.filteredDriveFiles[0]);
    await Promise.resolve();
    await Promise.resolve();
    const req = http.expectOne(r => r.url.endsWith('/backup/cloud/files/b2/fetch'));
    expect(req.request.body).toEqual({ connection_id: 3 });
    req.flush({ success: true, downloaded: true, file: { id: 78, file_name: 'other.sql', db_name: 'khups_kpi_db', size_bytes: 5 } });
    expect(component.selectedFileForRestore.id).toBe(78);
    swal.mockRestore();
  });
});
