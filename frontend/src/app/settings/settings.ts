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

  // Toggle switches
  loginAttemptsEnabled: boolean = true;
  autoLogoutEnabled: boolean = true;
  idleCountdownEnabled: boolean = true;

  // Notification settings
  telegramBotToken: string = '';
  telegramChatId: string = '';
  adminEmails: string = '';
  notifTelegramEnabled: boolean = true;
  notifEmailEnabled: boolean = true;
  notifSystemEnabled: boolean = true;

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

          // Toggle switches
          const loginAttemptsEn = this.settings.find(s => s.setting_key === 'login_attempts_enabled');
          const autoLogoutEn = this.settings.find(s => s.setting_key === 'auto_logout_enabled');
          const idleCountdownEn = this.settings.find(s => s.setting_key === 'idle_countdown_enabled');
          if (loginAttemptsEn) this.loginAttemptsEnabled = loginAttemptsEn.setting_value === 'true';
          if (autoLogoutEn) this.autoLogoutEnabled = autoLogoutEn.setting_value === 'true';
          if (idleCountdownEn) this.idleCountdownEnabled = idleCountdownEn.setting_value === 'true';

          // Notification settings
          const tgToken = this.settings.find(s => s.setting_key === 'telegram_bot_token');
          const tgChat = this.settings.find(s => s.setting_key === 'telegram_chat_id');
          const admEmails = this.settings.find(s => s.setting_key === 'admin_emails');
          if (tgToken) this.telegramBotToken = tgToken.setting_value || '';
          if (tgChat) this.telegramChatId = tgChat.setting_value || '';
          if (admEmails) this.adminEmails = admEmails.setting_value || '';
          const ntfTg = this.settings.find(s => s.setting_key === 'notif_telegram_enabled');
          const ntfEm = this.settings.find(s => s.setting_key === 'notif_email_enabled');
          const ntfSys = this.settings.find(s => s.setting_key === 'notif_system_enabled');
          if (ntfTg) this.notifTelegramEnabled = ntfTg.setting_value !== 'false';
          if (ntfEm) this.notifEmailEnabled = ntfEm.setting_value !== 'false';
          if (ntfSys) this.notifSystemEnabled = ntfSys.setting_value !== 'false';

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
    // Auto-version: ปี พ.ศ..เดือน.วัน.ชม.นาที
    const now = new Date();
    const thaiYear = now.getFullYear() + 543;
    const pad = (n: number) => n.toString().padStart(2, '0');
    this.systemVersion = `v${thaiYear}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;

    const settingsToSave = [
      { setting_key: 'idle_timeout_minutes', setting_value: this.idleTimeoutMinutes.toString() },
      { setting_key: 'idle_timeout_seconds', setting_value: this.idleTimeoutSeconds.toString() },
      { setting_key: 'idle_countdown_seconds', setting_value: this.idleCountdownSeconds.toString() },
      { setting_key: 'max_login_attempts', setting_value: this.maxLoginAttempts.toString() },
      { setting_key: 'log_retention_days', setting_value: this.logRetentionDays.toString() },
      { setting_key: 'auto_backup_enabled', setting_value: this.autoBackupEnabled.toString() },
      { setting_key: 'system_version', setting_value: this.systemVersion },
      { setting_key: 'login_attempts_enabled', setting_value: this.loginAttemptsEnabled.toString() },
      { setting_key: 'auto_logout_enabled', setting_value: this.autoLogoutEnabled.toString() },
      { setting_key: 'idle_countdown_enabled', setting_value: this.idleCountdownEnabled.toString() },
      { setting_key: 'telegram_bot_token', setting_value: this.telegramBotToken },
      { setting_key: 'telegram_chat_id', setting_value: this.telegramChatId },
      { setting_key: 'admin_emails', setting_value: this.adminEmails },
      { setting_key: 'notif_telegram_enabled', setting_value: this.notifTelegramEnabled.toString() },
      { setting_key: 'notif_email_enabled', setting_value: this.notifEmailEnabled.toString() },
      { setting_key: 'notif_system_enabled', setting_value: this.notifSystemEnabled.toString() },
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

  keepScroll(event: Event) {
    const main = document.querySelector('main');
    if (main) {
      const top = main.scrollTop;
      requestAnimationFrame(() => { main.scrollTop = top; });
    }
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

  testTelegram() {
    if (!this.telegramBotToken || !this.telegramChatId) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอก Bot Token และ Chat ID ก่อน', 'warning');
      return;
    }
    Swal.fire({ title: 'กำลังส่ง...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.testTelegram(this.telegramBotToken, this.telegramChatId).subscribe({
      next: (res: any) => {
        if (res.success) Swal.fire({ icon: 'success', title: 'ส่ง Telegram สำเร็จ', text: 'ตรวจสอบข้อความใน Group', timer: 2000, showConfirmButton: false });
        else Swal.fire('ผิดพลาด', res.message || 'ส่งไม่สำเร็จ', 'error');
      },
      error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถส่งได้', 'error')
    });
  }

  testAdminEmail() {
    if (!this.adminEmails) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอก Email Admin ก่อน', 'warning');
      return;
    }
    Swal.fire({ title: 'กำลังส่ง...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.testAdminEmail(this.adminEmails).subscribe({
      next: (res: any) => {
        if (res.success) Swal.fire({ icon: 'success', title: 'ส่ง Email สำเร็จ', text: 'ตรวจสอบ Email ของ Admin', timer: 2000, showConfirmButton: false });
        else Swal.fire('ผิดพลาด', res.message || 'ส่งไม่สำเร็จ', 'error');
      },
      error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถส่งได้', 'error')
    });
  }

  backupDatabase() {
    Swal.fire({ title: 'กำลังสำรองข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.backupDatabase().subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `khups_kpi_backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        Swal.fire({ icon: 'success', title: 'สำรองข้อมูลสำเร็จ', timer: 2000, showConfirmButton: false });
      },
      error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถสำรองข้อมูลได้', 'error')
    });
  }

  backupKpiData() {
    Swal.fire({ title: 'กำลังสำรองข้อมูลผลงาน...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.backupKpiData().subscribe({
      next: (blob: Blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kpi_data_backup_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        Swal.fire({ icon: 'success', title: 'สำรองข้อมูลผลงานสำเร็จ', timer: 2000, showConfirmButton: false });
      },
      error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถสำรองข้อมูลได้', 'error')
    });
  }

  clearAllKpiData() {
    Swal.fire({
      title: 'ล้างข้อมูลผลงานทั้งหมด',
      html: `<p class="text-sm text-red-600">คุณต้องการลบข้อมูลผลงานทั้งหมด ใช่หรือไม่?</p>
             <ul class="text-xs text-gray-600 mt-2 text-left list-disc ml-5">
               <li>kpi_results — ข้อมูลผลงานตัวชี้วัดทั้งหมด</li>
               <li>ตาราง form_ — ข้อมูลที่กรอกในแบบฟอร์มทั้งหมด</li>
             </ul>
             <p class="text-xs text-red-500 mt-3 font-bold"><i class="fas fa-exclamation-triangle mr-1"></i>การดำเนินการนี้ไม่สามารถย้อนกลับได้ กรุณาสำรองข้อมูลก่อน!</p>`,
      icon: 'warning',
      input: 'text',
      inputLabel: 'พิมพ์ "ยืนยันลบ" เพื่อดำเนินการ',
      inputPlaceholder: 'ยืนยันลบ',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-trash-alt mr-1"></i> ล้างข้อมูลทั้งหมด',
      cancelButtonText: 'ยกเลิก',
      inputValidator: (value) => value !== 'ยืนยันลบ' ? 'กรุณาพิมพ์ "ยืนยันลบ" ให้ถูกต้อง' : null
    }).then(result => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'กำลังล้างข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.clearAllKpiData().subscribe({
          next: (res: any) => {
            Swal.fire({
              icon: 'success', title: 'ล้างข้อมูลสำเร็จ',
              html: res.message || 'ลบข้อมูลผลงานทั้งหมดเรียบร้อยแล้ว',
              confirmButtonColor: '#10b981'
            });
          },
          error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถล้างข้อมูลได้', 'error')
        });
      }
    });
  }

  refreshSummary() {
    const startTime = Date.now();
    let timerInterval: any;

    Swal.fire({
      title: 'กำลังอัปเดต Summary...',
      html: `<div class="text-left text-sm space-y-2">
        <div class="flex items-center gap-2"><i class="fas fa-spinner fa-spin text-indigo-500"></i> ประมวลผลข้อมูล ~600,000 rows</div>
        <div class="flex items-center gap-2 text-gray-400"><i class="fas fa-clock"></i> เวลาที่ใช้: <b id="swal-timer">0</b> วินาที</div>
        <div class="w-full bg-gray-200 rounded-full h-2 mt-2">
          <div id="swal-progress" class="bg-indigo-500 h-2 rounded-full transition-all" style="width: 0%"></div>
        </div>
        <p class="text-xs text-gray-400 mt-1">ขั้นตอน: ล้างข้อมูลเก่า → GROUP BY → INSERT → คำนวณ last_actual</p>
      </div>`,
      allowOutsideClick: false,
      showConfirmButton: false,
      didOpen: () => {
        let fakeProgress = 0;
        timerInterval = setInterval(() => {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          const timerEl = document.getElementById('swal-timer');
          const progressEl = document.getElementById('swal-progress');
          if (timerEl) timerEl.textContent = String(elapsed);
          // fake progress bar (ช้าลงเมื่อเข้าใกล้ 90%)
          if (fakeProgress < 90) fakeProgress += (90 - fakeProgress) * 0.05;
          if (progressEl) progressEl.style.width = fakeProgress + '%';
        }, 500);
      }
    });

    this.authService.refreshKpiSummary().subscribe({
      next: (res: any) => {
        clearInterval(timerInterval);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        Swal.fire({
          icon: 'success',
          title: 'อัปเดต Summary สำเร็จ',
          html: `<div class="text-left text-sm space-y-1">
            <p><i class="fas fa-database text-indigo-500 mr-2"></i>สร้าง <b>${res.inserted}</b> rows</p>
            <p><i class="fas fa-clock text-green-500 mr-2"></i>ใช้เวลา <b>${elapsed}</b> วินาที</p>
          </div>`,
          confirmButtonColor: '#10b981'
        });
      },
      error: (err: any) => {
        clearInterval(timerInterval);
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถอัปเดตได้', 'error');
      }
    });
  }
}
