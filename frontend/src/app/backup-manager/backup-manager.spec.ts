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
