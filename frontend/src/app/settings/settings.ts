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

  // Data Entry Lock
  dataEntryLocked: boolean = false;
  dataEntryLockStart: string = '';
  dataEntryLockEnd: string = '';
  dataEntryLockDays: number = 0;

  // Target Edit Lock
  targetEditLocked: boolean = false;

  // Appeal settings
  appealEnabled: boolean = false;
  appealStartDate: string = '';
  appealEndDate: string = '';
  appealDaysAfterApprove: number = 0;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';

    if (!this.isSuperAdmin) {
      Swal.fire('Access Denied', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }

    this.loadSettings();
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

          // Data Entry Lock settings
          const entryLocked = this.settings.find(s => s.setting_key === 'data_entry_locked');
          const entryLockStart = this.settings.find(s => s.setting_key === 'data_entry_lock_start');
          const entryLockEnd = this.settings.find(s => s.setting_key === 'data_entry_lock_end');
          const entryLockDays = this.settings.find(s => s.setting_key === 'data_entry_lock_days');
          if (entryLocked) this.dataEntryLocked = entryLocked.setting_value === 'true';
          if (entryLockStart) this.dataEntryLockStart = entryLockStart.setting_value || '';
          if (entryLockEnd) this.dataEntryLockEnd = entryLockEnd.setting_value || '';
          if (entryLockDays) this.dataEntryLockDays = parseInt(entryLockDays.setting_value, 10) || 0;
          const targetEditLock = this.settings.find(s => s.setting_key === 'target_edit_locked');
          if (targetEditLock) this.targetEditLocked = targetEditLock.setting_value === 'true';

          // Appeal settings
          const appealEn = this.settings.find(s => s.setting_key === 'appeal_enabled');
          const appealStart = this.settings.find(s => s.setting_key === 'appeal_start_date');
          const appealEnd = this.settings.find(s => s.setting_key === 'appeal_end_date');
          const appealDays = this.settings.find(s => s.setting_key === 'appeal_days_after_approve');
          if (appealEn) this.appealEnabled = appealEn.setting_value === 'true';
          if (appealStart) this.appealStartDate = appealStart.setting_value || '';
          if (appealEnd) this.appealEndDate = appealEnd.setting_value || '';
          if (appealDays) this.appealDaysAfterApprove = parseInt(appealDays.setting_value, 10) || 0;
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
      { setting_key: 'system_version', setting_value: this.systemVersion },
      { setting_key: 'data_entry_locked', setting_value: this.dataEntryLocked.toString() },
      { setting_key: 'data_entry_lock_start', setting_value: this.dataEntryLockStart },
      { setting_key: 'data_entry_lock_end', setting_value: this.dataEntryLockEnd },
      { setting_key: 'data_entry_lock_days', setting_value: this.dataEntryLockDays.toString() },
      { setting_key: 'target_edit_locked', setting_value: this.targetEditLocked.toString() },
      { setting_key: 'appeal_enabled', setting_value: this.appealEnabled.toString() },
      { setting_key: 'appeal_start_date', setting_value: this.appealStartDate },
      { setting_key: 'appeal_end_date', setting_value: this.appealEndDate },
      { setting_key: 'appeal_days_after_approve', setting_value: this.appealDaysAfterApprove.toString() }
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

  resetDataEntryLock() {
    this.dataEntryLocked = false;
    this.dataEntryLockStart = '';
    this.dataEntryLockEnd = '';
    this.dataEntryLockDays = 0;
  }

  resetAppealSettings() {
    this.appealEnabled = false;
    this.appealStartDate = '';
    this.appealEndDate = '';
    this.appealDaysAfterApprove = 0;
  }
}
