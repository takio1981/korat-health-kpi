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

}
