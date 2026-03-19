import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings.html'
})
export class SettingsComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  settings: any[] = [];
  idleTimeoutMinutes: number = 15;
  idleTimeoutSeconds: number = 0;
  idleCountdownSeconds: number = 10;
  maxLoginAttempts: number = 10;
  logRetentionDays: number = 90;
  autoBackupEnabled: boolean = false;
  systemVersion: string = 'v1.0.0';

  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;

  // Export KPI Tables
  exportYear: string = '';
  exportLoading: boolean = false;
  exportResult: any = null;
  exportIndicators: any[] = [];
  filteredExportIndicators: any[] = [];
  selectedIndicatorIds: Set<number> = new Set();
  selectAll: boolean = true;
  exportSearch: string = '';

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';

    if (!this.isSuperAdmin) {
      Swal.fire('Access Denied', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }

    // คำนวณปีงบประมาณไทยปัจจุบัน
    const now = new Date();
    const thaiYear = now.getFullYear() + 543;
    this.exportYear = (now.getMonth() >= 9 ? thaiYear + 1 : thaiYear).toString();

    this.loadSettings();
    this.loadExportableIndicators();
  }

  loadSettings() {
    this.authService.getSettings().subscribe({
      next: (res) => {
        if (res.success) {
          this.settings = res.data;
          const minSetting = this.settings.find(s => s.setting_key === 'idle_timeout_minutes');
          const secSetting = this.settings.find(s => s.setting_key === 'idle_timeout_seconds');
          const countdownSetting = this.settings.find(s => s.setting_key === 'idle_countdown_seconds');
          const maxLoginSetting = this.settings.find(s => s.setting_key === 'max_login_attempts');
          const logRetentionSetting = this.settings.find(s => s.setting_key === 'log_retention_days');
          const autoBackupSetting = this.settings.find(s => s.setting_key === 'auto_backup_enabled');
          const versionSetting = this.settings.find(s => s.setting_key === 'system_version');

          if (minSetting) {
            this.idleTimeoutMinutes = parseInt(minSetting.setting_value, 10);
          }
          if (secSetting) {
            this.idleTimeoutSeconds = parseInt(secSetting.setting_value, 10);
          }
          if (countdownSetting) {
            this.idleCountdownSeconds = parseInt(countdownSetting.setting_value, 10);
          }
          if (maxLoginSetting) {
            this.maxLoginAttempts = parseInt(maxLoginSetting.setting_value, 10);
          }
          if (logRetentionSetting) {
            this.logRetentionDays = parseInt(logRetentionSetting.setting_value, 10);
          }
          if (autoBackupSetting) {
            this.autoBackupEnabled = autoBackupSetting.setting_value === 'true';
          }
          if (versionSetting) {
            this.systemVersion = versionSetting.setting_value;
          }
        }
        this.cdr.detectChanges();
      }
    });
  }

  saveSettings() {
    const settingsToSave = [
      { setting_key: 'idle_timeout_minutes', setting_value: this.idleTimeoutMinutes.toString() },
      { setting_key: 'idle_timeout_seconds', setting_value: this.idleTimeoutSeconds.toString() },
      { setting_key: 'idle_countdown_seconds', setting_value: this.idleCountdownSeconds.toString() },
      { setting_key: 'max_login_attempts', setting_value: this.maxLoginAttempts.toString() },
      { setting_key: 'log_retention_days', setting_value: this.logRetentionDays.toString() },
      { setting_key: 'auto_backup_enabled', setting_value: this.autoBackupEnabled.toString() },
      { setting_key: 'system_version', setting_value: this.systemVersion }
    ];

    this.authService.updateSettings(settingsToSave).subscribe({
      next: (res) => {
        Swal.fire({
          title: 'สำเร็จ',
          text: 'บันทึกการตั้งค่าเรียบร้อยแล้ว (มีผลเมื่อรีเฟรชหน้าจอ)',
          icon: 'success',
          confirmButtonColor: '#28a745'
        });
      },
      error: (err) => {
        Swal.fire('ผิดพลาด', 'ไม่สามารถบันทึกการตั้งค่าได้', 'error');
      }
    });
  }

  // === Export KPI Tables ===

  loadExportableIndicators() {
    this.authService.getExportableIndicators().subscribe({
      next: (res) => {
        if (res.success) {
          this.exportIndicators = res.data;
          this.filteredExportIndicators = res.data;
          // เลือกทั้งหมดเป็นค่าเริ่มต้น
          this.selectedIndicatorIds = new Set(res.data.map((i: any) => i.id));
          this.selectAll = true;
        }
        this.cdr.detectChanges();
      }
    });
  }

  filterExportIndicators() {
    const search = this.exportSearch.toLowerCase().trim();
    if (!search) {
      this.filteredExportIndicators = this.exportIndicators;
    } else {
      this.filteredExportIndicators = this.exportIndicators.filter((i: any) =>
        i.kpi_indicators_name.toLowerCase().includes(search) ||
        i.table_process.toLowerCase().includes(search)
      );
    }
  }

  toggleSelectAll() {
    if (this.selectAll) {
      this.selectedIndicatorIds = new Set(this.exportIndicators.map((i: any) => i.id));
    } else {
      this.selectedIndicatorIds.clear();
    }
  }

  toggleIndicator(id: number) {
    if (this.selectedIndicatorIds.has(id)) {
      this.selectedIndicatorIds.delete(id);
    } else {
      this.selectedIndicatorIds.add(id);
    }
    this.selectAll = this.selectedIndicatorIds.size === this.exportIndicators.length;
  }

  isIndicatorSelected(id: number): boolean {
    return this.selectedIndicatorIds.has(id);
  }

  exportKpiTables() {
    if (this.selectedIndicatorIds.size === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกตัวชี้วัดอย่างน้อย 1 รายการ', 'warning');
      return;
    }

    const count = this.selectedIndicatorIds.size;
    const isAll = count === this.exportIndicators.length;

    Swal.fire({
      title: 'ยืนยันการส่งออกข้อมูล',
      html: `จะสร้างตาราง MySQL สำหรับ <b>${isAll ? 'ทุกตัวชี้วัด' : count + ' ตัวชี้วัด'}</b><br>ปีงบประมาณ <b>${this.exportYear}</b><br><br><small class="text-red-500">หากตารางมีอยู่แล้ว ข้อมูลเดิมของปีนี้จะถูกแทนที่</small>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'ส่งออก',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#28a745'
    }).then((result) => {
      if (result.isConfirmed) {
        this.exportLoading = true;
        this.exportResult = null;
        this.cdr.detectChanges();

        const ids = isAll ? 'all' as const : Array.from(this.selectedIndicatorIds);

        this.authService.exportKpiTables(this.exportYear, ids).subscribe({
          next: (res) => {
            this.exportLoading = false;
            this.exportResult = res;
            this.cdr.detectChanges();

            if (res.success) {
              Swal.fire({
                title: 'สำเร็จ',
                html: `สร้างตารางสำเร็จ <b>${res.created_tables.length}</b> ตาราง` +
                  (res.skipped.length > 0 ? `<br>ข้าม <b>${res.skipped.length}</b> รายการ` : '') +
                  `<br>จำนวน hospcode: <b>${res.total_hospitals}</b>`,
                icon: 'success',
                confirmButtonColor: '#28a745'
              });
            } else {
              Swal.fire('ผิดพลาด', res.message, 'error');
            }
          },
          error: (err) => {
            this.exportLoading = false;
            this.cdr.detectChanges();
            Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถส่งออกข้อมูลได้', 'error');
          }
        });
      }
    });
  }
}
