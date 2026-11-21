import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { KhdQuickSendComponent, quickPreviewHtml, canRollback, runStatusText, triggerText, escapeHtml } from './khd-quick-send';

describe('ส่งเข้า KHD ขั้นเดียว — ฟังก์ชันล้วน', () => {
  it('สรุปสิ่งที่จะส่ง: ตัวเลขรวม + รายตาราง + ตารางที่ส่งไม่ได้ และกันข้อความ HTML', () => {
    const html = quickPreviewHtml({
      year_bh: '2570', policy: 'approved_only', export: { indicators_changed: 3 },
      totals: { tables_to_send: 1, insert: 2, update: 5, tables_up_to_date: 9, khd_newer: 1 },
      tables: [{ table: 'kpi_a', status: 'ready', insert: 2, update: 5, kept_blank: 1 }, { table: '<b>x</b>', status: 'blocked', reason: 'คีย์ผิด' }],
    });
    expect(html).toContain('ส่งเฉพาะเดือนที่อนุมัติแล้ว');
    expect(html).toContain('<b>3</b> ตัว');
    expect(html).toContain('kpi_a');
    expect(html).toContain('ส่งไม่ได้ 1 ตาราง');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('ปุ่มย้อนกลับ: เฉพาะรอบที่สำเร็จ/สำเร็จบางส่วนและเขียนข้อมูลจริง ไม่ใช่รอบย้อนกลับ', () => {
    expect(canRollback({ trigger_type: 'quick', status: 'success', rows_updated: 2, rows_inserted: 0 })).toBe(true);
    expect(canRollback({ trigger_type: 'manual', status: 'partial', rows_updated: 0, rows_inserted: 1 })).toBe(true);
    expect(canRollback({ trigger_type: 'quick', status: 'success', rows_updated: 0, rows_inserted: 0 })).toBe(false);
    expect(canRollback({ trigger_type: 'quick', status: 'rolled_back', rows_updated: 3 })).toBe(false);
    expect(canRollback({ trigger_type: 'rollback', status: 'success', rows_updated: 3 })).toBe(false);
    expect(canRollback(null)).toBe(false);
  });

  it('ข้อความสถานะ/ที่มา', () => {
    expect(runStatusText('partially_rolled_back')).toBe('ย้อนกลับบางส่วน');
    expect(triggerText('schedule')).toBe('ตารางเวลา');
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});

describe('KhdQuickSendComponent', () => {
  it('โหลดกติกาการส่งจาก /khd-sync/settings และบันทึกผ่าน PUT', async () => {
    await TestBed.configureTestingModule({ imports: [KhdQuickSendComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(KhdQuickSendComponent);
    const http = TestBed.inject(HttpTestingController);
    f.componentInstance.year = '2570';
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/khd-sync/settings') && r.method === 'GET')
      .flush({ success: true, data: { khd_send_policy: 'approved_only', khd_sync_batch_size: 100 }, policies: ['approved_only', 'all'] });
    expect(f.componentInstance.policyLabel).toContain('อนุมัติแล้ว');
    f.componentInstance.s.khd_send_policy = 'all';
    f.componentInstance.saveSettings();
    const put = http.expectOne(r => r.url.endsWith('/khd-sync/settings') && r.method === 'PUT');
    expect(put.request.body.khd_send_policy).toBe('all'); // ไม่ flush — ผลสำเร็จเปิด Swal แบบมี icon (jsdom ไม่มี matchMedia)
  });

  it('ประวัติการส่ง: เปิดแล้วโหลด /khd-sync/runs', async () => {
    await TestBed.configureTestingModule({ imports: [KhdQuickSendComponent], providers: testProviders }).compileComponents();
    const f = TestBed.createComponent(KhdQuickSendComponent);
    const http = TestBed.inject(HttpTestingController);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/khd-sync/settings')).flush({ success: true, data: { khd_send_policy: 'all' } });
    f.componentInstance.toggleHistory();
    http.expectOne(r => r.url.includes('/khd-sync/runs')).flush({ success: true, data: [{ id: 5, trigger_type: 'quick', status: 'success', rows_updated: 1, rows_inserted: 0 }] });
    expect(f.componentInstance.runs.length).toBe(1);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('#khd-sync-history')?.textContent).toContain('ส่งขั้นเดียว');
  });
});
