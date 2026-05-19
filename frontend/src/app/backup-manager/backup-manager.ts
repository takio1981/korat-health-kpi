import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import { environment } from '../../environments/environment';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-backup-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './backup-manager.html'
})
export class BackupManagerComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  activeTab: 'connections' | 'backup' | 'files' | 'restore' | 'schedules' | 'cloud' | 'monitor' = 'connections';

  // Cloud (Phase 3 — Google Drive OAuth 2.0)
  cloudSettings: any = {
    enabled: false, client_id: '', has_client_secret: false, has_refresh_token: false,
    user_email: '', redirect_uri: '', folder_id: '', folder_name: '',
    needs_credentials: true, needs_authorization: true
  };
  cloudClientSecretInput = '';
  private _cloudCallbackPoll: any = null;

  // Monitor (Phase 3)
  monitor: any = null;
  monitorLoading = false;
  monitorAutoRefresh = true;
  private monitorTimer: any = null;

  // Schedules (Phase 2)
  schedules: any[] = [];
  showScheduleModal = false;
  editingSchedule: any = null;
  scheduleForm: any = this._emptyScheduleForm();
  scheduleLogs: any[] = [];
  showLogsModal = false;
  logsScheduleName = '';
  dayOptions = [
    { value: 1, label: 'จันทร์' }, { value: 2, label: 'อังคาร' }, { value: 3, label: 'พุธ' },
    { value: 4, label: 'พฤหัส' }, { value: 5, label: 'ศุกร์' }, { value: 6, label: 'เสาร์' }, { value: 7, label: 'อาทิตย์' }
  ];

  // Connections
  connections: any[] = [];
  showConnModal = false;
  editingConn: any = null;
  connForm: any = { name: '', host: '', port: 3306, db_user: '', db_password: '', db_name: '', description: '', is_default: false };
  showConnPw = false;

  // Backup
  selectedBackupConnId: number | null = null;
  backupCompress = true;
  isBackingUp = false;
  lastBackupResult: any = null;
  currentJob: any = null;
  private pollTimer: any = null;

  // Files
  files: any[] = [];
  diskInfo: any = null;
  backupDir = '';
  selectedFileForRestore: any = null;

  // Restore
  restoreMode: 'new_db' | 'replace' = 'new_db';
  restoreTargetDb = '';
  restoreAutoBackup = true;
  isRestoring = false;
  currentRestoreJob: any = null;
  private restorePollTimer: any = null;

  ngOnInit() {
    this.loadConnections();
    this.loadFiles();
    this.loadSchedules();
  }

  setTab(t: typeof this.activeTab) {
    this.activeTab = t;
    if (t === 'connections') this.loadConnections();
    else if (t === 'files' || t === 'restore') this.loadFiles();
    else if (t === 'schedules') this.loadSchedules();
    else if (t === 'cloud') this.loadCloudSettings();
    else if (t === 'monitor') this.startMonitor();
    else this.stopMonitor();

    if (t !== 'monitor') this.stopMonitor();
  }

  // ============== Cloud (Google Drive) ==============
  loadCloudSettings() {
    this.authService.getCloudSettings().subscribe({
      next: (res) => {
        if (res.success) {
          this.cloudSettings = res;
          // auto-fill redirect URI ถ้ายังไม่มี
          if (!this.cloudSettings.redirect_uri) {
            this.cloudSettings.redirect_uri = this.getDefaultRedirectUri();
          }
          this.cdr.detectChanges();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
    });
  }

  saveCloudSettings() {
    const data: any = {
      enabled: this.cloudSettings.enabled,
      client_id: this.cloudSettings.client_id,
      redirect_uri: this.cloudSettings.redirect_uri,
      folder_id: this.cloudSettings.folder_id,
      folder_name: this.cloudSettings.folder_name
    };
    if (this.cloudClientSecretInput && this.cloudClientSecretInput.trim()) {
      data.client_secret = this.cloudClientSecretInput.trim();
    }
    this.authService.saveCloudSettings(data).subscribe({
      next: (res) => {
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', timer: 1500, showConfirmButton: false });
          this.cloudClientSecretInput = '';
          this.loadCloudSettings();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
    });
  }

  connectCloud() {
    // ขั้นแรก: บันทึก settings ก่อน (ถ้าเปลี่ยน)
    if (!this.cloudSettings.client_id || (!this.cloudSettings.has_client_secret && !this.cloudClientSecretInput) || !this.cloudSettings.redirect_uri) {
      Swal.fire('ตั้งค่าไม่ครบ', 'กรุณากรอก Client ID, Client Secret, Redirect URI แล้วกด "บันทึก" ก่อน', 'warning');
      return;
    }
    Swal.fire({ title: 'กำลังเตรียม...', didOpen: () => Swal.showLoading() });
    this.authService.getCloudOAuthUrl().subscribe({
      next: (res) => {
        Swal.close();
        if (!res.success || !res.auth_url) {
          Swal.fire('ผิดพลาด', res.message || 'ไม่ได้ auth URL', 'error');
          return;
        }
        // เปิด popup window สำหรับ OAuth
        const w = 600, h = 700;
        const left = (window.screen.width - w) / 2;
        const top = (window.screen.height - h) / 2;
        const popup = window.open(res.auth_url, 'gdrive_oauth',
          `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=yes`);
        // poll status ทุก 2 วินาทีจน popup ปิด หรือ has_refresh_token = true
        if (this._cloudCallbackPoll) clearInterval(this._cloudCallbackPoll);
        this._cloudCallbackPoll = setInterval(() => {
          this.authService.getCloudSettings().subscribe({
            next: (s) => {
              if (s.success && s.has_refresh_token) {
                clearInterval(this._cloudCallbackPoll);
                this._cloudCallbackPoll = null;
                this.cloudSettings = s;
                try { popup?.close(); } catch (_) {}
                Swal.fire({
                  icon: 'success', title: 'เชื่อมต่อสำเร็จ',
                  html: `<div style="text-align:left">Account: <code>${this.escapeHtmlPublic(s.user_email)}</code></div>`
                });
                this.cdr.detectChanges();
              }
            },
            error: () => {}
          });
          if (popup && popup.closed) {
            clearInterval(this._cloudCallbackPoll);
            this._cloudCallbackPoll = null;
            this.loadCloudSettings();
          }
        }, 2000);
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
    });
  }

  disconnectCloud() {
    Swal.fire({
      title: 'Disconnect Google Drive?',
      text: 'Refresh token จะถูก revoke — ต้อง authorize ใหม่ถ้าจะใช้อีก',
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: 'Disconnect', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.disconnectCloud().subscribe({
        next: () => { Swal.fire({ icon: 'success', title: 'Disconnect แล้ว', timer: 1500, showConfirmButton: false }); this.loadCloudSettings(); },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
      });
    });
  }

  // helper: คำนวณ redirect URI default จาก environment.apiUrl
  getDefaultRedirectUri(): string {
    const apiUrl = environment.apiUrl || '';
    return apiUrl ? `${apiUrl}/backup/cloud/oauth/callback` : '';
  }

  copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      Swal.fire({ icon: 'success', title: 'คัดลอกแล้ว', timer: 1000, showConfirmButton: false, toast: true, position: 'top-end' });
    });
  }

  testCloud() {
    Swal.fire({ title: 'กำลังทดสอบ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.testCloudConnection().subscribe({
      next: (res) => {
        if (res.success) {
          const sampleList = (res.sample_files || []).map((f: any) =>
            `  • ${this.escapeHtmlPublic(f.name)} (${this.formatBytes(Number(f.size) || 0)})`
          ).join('<br>');
          Swal.fire({
            icon: 'success', title: 'เชื่อมต่อ Drive สำเร็จ',
            html: `<div style="text-align:left;font-size:13px">
              Service email: <code>${this.escapeHtmlPublic(res.service_email)}</code><br>
              Folder ID: <code>${this.escapeHtmlPublic(res.folder_id)}</code><br>
              Folder name: <b>${this.escapeHtmlPublic(res.folder_name || '-')}</b><br>
              <div style="margin-top:10px">ไฟล์ใน folder (max 5):<br>${sampleList || '<i>ไม่มีไฟล์</i>'}</div>
            </div>`
          });
        }
      },
      error: (err) => Swal.fire('ทดสอบล้มเหลว', err.error?.message || '', 'error')
    });
  }

  uploadFileToCloud(f: any) {
    Swal.fire({
      title: 'อัพโหลดไป Google Drive?',
      html: `<div style="text-align:left;font-size:13px">ไฟล์: <code>${this.escapeHtmlPublic(f.file_name)}</code><br>ขนาด: <b>${this.formatBytes(f.size_bytes)}</b></div>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#0ea5e9',
      confirmButtonText: 'อัพโหลด', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      Swal.fire({ title: 'กำลังอัพโหลด...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.uploadFileToCloud(f.id).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire({
              icon: 'success', title: 'อัพโหลดสำเร็จ',
              html: `<a href="${res.web_url}" target="_blank" style="color:#0ea5e9;text-decoration:underline">เปิดใน Google Drive</a>`
            });
            this.loadFiles();
          }
        },
        error: (err) => Swal.fire('อัพโหลดล้มเหลว', err.error?.message || '', 'error')
      });
    });
  }

  deleteFromCloud(f: any) {
    Swal.fire({
      title: 'ลบจาก Google Drive?',
      text: 'ไฟล์ใน Drive จะถูกลบ — local file ไม่แตะ',
      icon: 'warning', showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.deleteFileFromCloud(f.id).subscribe({
        next: () => { Swal.fire({ icon: 'success', title: 'ลบจาก cloud สำเร็จ', timer: 1500, showConfirmButton: false }); this.loadFiles(); },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
      });
    });
  }

  // ============== Monitor ==============
  startMonitor() {
    this.fetchMonitor();
    if (this.monitorAutoRefresh) {
      this.stopMonitor();
      this.monitorTimer = setInterval(() => this.fetchMonitor(), 10000);
    }
  }

  stopMonitor() {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
  }

  toggleMonitorAutoRefresh() {
    this.monitorAutoRefresh = !this.monitorAutoRefresh;
    if (this.monitorAutoRefresh) this.startMonitor();
    else this.stopMonitor();
  }

  fetchMonitor() {
    this.monitorLoading = true;
    this.authService.getBackupMonitor().subscribe({
      next: (res) => {
        if (res.success) this.monitor = res.data;
        this.monitorLoading = false;
        this.cdr.detectChanges();
      },
      error: () => { this.monitorLoading = false; }
    });
  }

  formatDuration(seconds: number): string {
    if (!seconds) return '0s';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return [d ? `${d}d` : '', h ? `${h}h` : '', m ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
  }

  // ============== Schedules ==============
  private _emptyScheduleForm() {
    return {
      name: '',
      is_enabled: true,
      connection_id: null,
      days_of_week: [1, 2, 3, 4, 5, 6, 7],
      time_of_day: '02:00',
      compress: true,
      retention_days: 30,
      notify_email: false,
      notify_email_on_success: true,
      notify_email_on_failure: true,
      notify_telegram: false,
      notify_telegram_on_success: true,
      notify_telegram_on_failure: true,
      auto_upload_cloud: false
    };
  }

  loadSchedules() {
    this.authService.getBackupSchedules().subscribe({
      next: (res) => {
        if (res.success) { this.schedules = res.data || []; this.cdr.detectChanges(); }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'โหลด schedules ไม่สำเร็จ', 'error')
    });
  }

  openScheduleModal(s: any = null) {
    this.editingSchedule = s;
    if (s) {
      const days = (s.days_of_week || '').split(',').map((d: string) => parseInt(d, 10)).filter((n: number) => !isNaN(n));
      this.scheduleForm = {
        name: s.name, is_enabled: !!s.is_enabled, connection_id: s.connection_id,
        days_of_week: days.length ? days : [1, 2, 3, 4, 5, 6, 7],
        time_of_day: s.time_of_day,
        compress: !!s.compress, retention_days: s.retention_days || 30,
        notify_email: !!s.notify_email,
        notify_email_on_success: !!s.notify_email_on_success,
        notify_email_on_failure: !!s.notify_email_on_failure,
        notify_telegram: !!s.notify_telegram,
        notify_telegram_on_success: !!s.notify_telegram_on_success,
        notify_telegram_on_failure: !!s.notify_telegram_on_failure,
        auto_upload_cloud: !!s.auto_upload_cloud
      };
    } else {
      this.scheduleForm = this._emptyScheduleForm();
      if (this.connections.length === 1) this.scheduleForm.connection_id = this.connections[0].id;
    }
    this.showScheduleModal = true;
  }

  toggleDay(d: number) {
    const idx = this.scheduleForm.days_of_week.indexOf(d);
    if (idx >= 0) this.scheduleForm.days_of_week.splice(idx, 1);
    else { this.scheduleForm.days_of_week.push(d); this.scheduleForm.days_of_week.sort(); }
  }

  saveSchedule() {
    const f = this.scheduleForm;
    if (!f.name || !f.connection_id || !f.time_of_day || f.days_of_week.length === 0) {
      Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอก name, connection, time, และเลือกอย่างน้อย 1 วัน', 'warning');
      return;
    }
    const data = { ...f, days_of_week: f.days_of_week.join(',') };
    const obs = this.editingSchedule
      ? this.authService.updateBackupSchedule(this.editingSchedule.id, data)
      : this.authService.createBackupSchedule(data);
    obs.subscribe({
      next: (res) => {
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', timer: 1500, showConfirmButton: false });
          this.showScheduleModal = false;
          this.loadSchedules();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error')
    });
  }

  deleteSchedule(s: any) {
    Swal.fire({
      title: `ลบ schedule "${s.name}"?`, icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.deleteBackupSchedule(s.id).subscribe({
        next: () => { Swal.fire({ icon: 'success', title: 'ลบสำเร็จ', timer: 1500, showConfirmButton: false }); this.loadSchedules(); },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ลบไม่สำเร็จ', 'error')
      });
    });
  }

  runScheduleNow(s: any) {
    Swal.fire({
      title: 'รัน schedule ทันที?',
      html: `<div style="text-align:left">Schedule: <b>${s.name}</b><br>Connection: ${s.connection_name}<br>Database: <code>${s.db_name}</code></div>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: 'รันเลย', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.runBackupScheduleNow(s.id).subscribe({
        next: (res) => {
          Swal.fire({ icon: 'success', title: 'เริ่มแล้ว', text: res.message, timer: 2500, showConfirmButton: false });
          setTimeout(() => { this.loadSchedules(); this.loadFiles(); }, 3000);
        },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
      });
    });
  }

  viewScheduleLogs(s: any) {
    this.logsScheduleName = s.name;
    this.authService.getBackupScheduleLogs(s.id).subscribe({
      next: (res) => {
        if (res.success) {
          this.scheduleLogs = res.data || [];
          this.showLogsModal = true;
          this.cdr.detectChanges();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
    });
  }

  testNotification() {
    Swal.fire({
      title: 'ทดสอบ Notification',
      html: 'ส่งข้อความทดสอบไปยังช่องทางที่ตั้งใน System Settings (Email + Telegram)',
      icon: 'question', showCancelButton: true,
      confirmButtonColor: '#10b981', confirmButtonText: 'ส่งทดสอบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.testBackupNotification(true, true).subscribe({
        next: (res) => {
          Swal.fire({
            icon: 'success', title: 'ส่งทดสอบแล้ว',
            html: `<div style="text-align:left;font-size:13px">
              Email: ${res.sent_email ? '<b style="color:#10b981">✓ ส่งแล้ว</b>' : '<span style="color:#f59e0b">— ไม่ส่ง (ไม่มี config)</span>'}<br>
              Telegram: ${res.sent_telegram ? '<b style="color:#10b981">✓ ส่งแล้ว</b>' : '<span style="color:#f59e0b">— ไม่ส่ง (ไม่มี config)</span>'}
            </div>`
          });
        },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || '', 'error')
      });
    });
  }

  daysLabel(s: any): string {
    const days = (s.days_of_week || '').split(',').map((d: string) => parseInt(d, 10)).filter((n: number) => !isNaN(n));
    if (days.length === 7) return 'ทุกวัน';
    if (days.length === 5 && days.every((d: number) => d <= 5)) return 'จ-ศ';
    if (days.length === 2 && days[0] === 6 && days[1] === 7) return 'เสาร์-อาทิตย์';
    return days.map((d: number) => this.dayOptions.find(o => o.value === d)?.label || d).join(',');
  }

  // ===== Connections =====
  loadConnections() {
    this.authService.getBackupConnections().subscribe({
      next: (res) => {
        if (res.success) {
          this.connections = res.data || [];
          if (!this.selectedBackupConnId && this.connections.length) {
            const def = this.connections.find((c: any) => c.is_default) || this.connections[0];
            this.selectedBackupConnId = def.id;
          }
          this.cdr.detectChanges();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'โหลด connections ไม่สำเร็จ', 'error')
    });
  }

  openConnModal(conn: any = null) {
    this.editingConn = conn;
    if (conn) {
      this.connForm = { ...conn, db_password: '' }; // ไม่โชว์ password เดิม
    } else {
      this.connForm = { name: '', host: '', port: 3306, db_user: '', db_password: '', db_name: '', description: '', is_default: false };
    }
    this.showConnPw = false;
    this.showConnModal = true;
  }

  saveConn() {
    if (!this.connForm.name || !this.connForm.host || !this.connForm.db_user || !this.connForm.db_name) {
      Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอก name, host, db_user, db_name', 'warning');
      return;
    }
    const obs = this.editingConn
      ? this.authService.updateBackupConnection(this.editingConn.id, this.connForm)
      : this.authService.createBackupConnection(this.connForm);
    obs.subscribe({
      next: (res) => {
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', timer: 1500, showConfirmButton: false });
          this.showConnModal = false;
          this.loadConnections();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error')
    });
  }

  deleteConn(conn: any) {
    if (conn.is_default) { Swal.fire('ลบไม่ได้', 'ไม่สามารถลบ connection หลักได้', 'warning'); return; }
    Swal.fire({
      title: `ลบ "${conn.name}"?`, icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.deleteBackupConnection(conn.id).subscribe({
        next: () => { Swal.fire({ icon: 'success', title: 'ลบสำเร็จ', timer: 1500, showConfirmButton: false }); this.loadConnections(); },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ลบไม่สำเร็จ', 'error')
      });
    });
  }

  testConn(conn: any) {
    Swal.fire({ title: 'กำลังทดสอบ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.testBackupConnection(conn.id).subscribe({
      next: (res) => {
        if (res.success) Swal.fire({ icon: 'success', title: 'เชื่อมต่อสำเร็จ', html: `<pre style="text-align:left;font-size:11px">${res.output || ''}</pre>` });
        else Swal.fire('ล้มเหลว', res.error || res.message || '', 'error');
      },
      error: (err) => Swal.fire('ล้มเหลว', err.error?.error || err.error?.message || 'ทดสอบไม่สำเร็จ', 'error')
    });
  }

  verifyPrivileges(conn: any) {
    Swal.fire({ title: 'กำลังตรวจสิทธิ์...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.verifyBackupPrivileges(conn.id).subscribe({
      next: (res) => {
        if (!res.ok) {
          Swal.fire({
            icon: 'error', title: 'สิทธิ์ไม่เพียงพอ',
            html: `<div style="text-align:left;font-size:13px">${this.escapeHtmlPublic(res.error || '')}</div>`
          });
          return;
        }
        const grants = (res.grants || []).map((g: string) => this.escapeHtmlPublic(g)).join('\n');
        Swal.fire({
          icon: res.has_full_access ? 'success' : 'warning',
          title: res.has_full_access ? 'สิทธิ์ครบ' : 'สิทธิ์อาจไม่ครบ',
          width: 750,
          html: `<div style="text-align:left;font-size:12px;line-height:1.6">
            <div>Tables ทั้งหมด: <b>${res.tables_count}</b> (BASE TABLE: ${res.base_tables})</div>
            <div>ทดสอบ SELECT จากตาราง: <code>${res.sample_table}</code> <span style="color:#10b981">✓ ผ่าน</span></div>
            <div>Rows ใน sample: <b>${res.rows_in_sample?.toLocaleString() || 0}</b></div>
            <div style="margin-top:10px"><b>SHOW GRANTS:</b></div>
            <pre style="background:#0f172a;color:#a3e635;padding:10px;border-radius:6px;font-size:11px;max-height:200px;overflow:auto">${grants || '(empty)'}</pre>
            ${!res.has_full_access ? '<div style="margin-top:8px;padding:8px;background:#fef3c7;border-left:3px solid #f59e0b;color:#92400e;font-size:12px">⚠️ User นี้ไม่มี ALL PRIVILEGES — ถ้า backup ได้แต่ schema ไม่มีข้อมูล ให้เปลี่ยนเป็น user ที่มี ALL หรือ SELECT,LOCK TABLES,SHOW VIEW,EVENT,TRIGGER บน DB นี้</div>' : ''}
          </div>`
        });
      },
      error: (err) => Swal.fire('ตรวจไม่ได้', err.error?.message || '', 'error')
    });
  }

  // ===== Backup =====
  runBackup() {
    if (!this.selectedBackupConnId) { Swal.fire('ยังไม่เลือก', 'กรุณาเลือก connection', 'warning'); return; }
    const conn = this.connections.find(c => c.id === this.selectedBackupConnId);
    Swal.fire({
      title: 'ยืนยันการ Backup', icon: 'question',
      html: `<div style="text-align:left">Connection: <b>${conn?.name}</b><br>Database: <code>${conn?.db_name}</code><br>Compress: ${this.backupCompress ? '✅ gzip' : '❌ ไม่บีบอัด'}</div>`,
      showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: 'เริ่ม Backup', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this._startBackup(false);
    });
  }

  private _startBackup(skipPrivilegeCheck: boolean) {
    this.isBackingUp = true;
    this.lastBackupResult = null;
    this.currentJob = null;
    this.authService.runBackup(this.selectedBackupConnId!, this.backupCompress, skipPrivilegeCheck).subscribe({
      next: (res) => {
        if (!res.success || !res.job_id) {
          this.isBackingUp = false;
          Swal.fire('ล้มเหลว', res.message || 'ไม่ได้ job_id', 'error');
          return;
        }
        this.startPolling(res.job_id);
      },
      error: (err) => {
        this.isBackingUp = false;
        const errBody = err.error || {};
        if (errBody.code === 'PRIVILEGE_CHECK_FAILED') {
          // เสนอ retry แบบ skip check
          Swal.fire({
            icon: 'warning', title: 'สิทธิ์ไม่เพียงพอ',
            html: `<div style="text-align:left;font-size:13px">
              <div style="margin-bottom:8px;color:#dc2626">${this.escapeHtmlPublic(errBody.message)}</div>
              <div style="padding:8px;background:#fef3c7;border-left:3px solid #f59e0b;color:#92400e;font-size:12px">${this.escapeHtmlPublic(errBody.hint || '')}</div>
            </div>`,
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: 'แก้ไข Connection',
            denyButtonText: 'ข้ามการตรวจ + ลอง backup เลย',
            cancelButtonText: 'ยกเลิก',
            confirmButtonColor: '#10b981',
            denyButtonColor: '#f59e0b'
          }).then(r => {
            if (r.isConfirmed) {
              const conn = this.connections.find(c => c.id === this.selectedBackupConnId);
              if (conn) this.openConnModal(conn);
            } else if (r.isDenied) {
              this._startBackup(true);
            }
          });
        } else {
          Swal.fire('Backup ล้มเหลว', errBody.message || 'เกิดข้อผิดพลาด', 'error');
        }
        this.cdr.detectChanges();
      }
    });
  }

  private startPolling(jobId: number) {
    this.stopPolling();
    const poll = () => {
      this.authService.getBackupJob(jobId).subscribe({
        next: (res) => {
          if (!res.success) return;
          this.currentJob = res.data;
          this.cdr.detectChanges();
          if (res.data.status === 'success') {
            this.stopPolling();
            this.isBackingUp = false;
            this.lastBackupResult = res.data;
            const hasWarn = res.data.error_msg && res.data.error_msg.startsWith('WARNING');
            Swal.fire({
              icon: hasWarn ? 'warning' : 'success',
              title: hasWarn ? 'Backup เสร็จ แต่มีคำเตือน' : 'Backup สำเร็จ',
              html: `<div style="text-align:left;font-size:13px">
                Database: <code>${res.data.db_name}</code><br>
                ขนาด: <b>${this.formatBytes(res.data.size_bytes)}</b><br>
                เวลา: ${(res.data.duration_ms / 1000).toFixed(1)} วินาที<br>
                ${hasWarn ? `<div style="margin-top:8px;padding:8px;background:#fef3c7;border-left:3px solid #f59e0b;color:#92400e;font-size:12px">${this.escapeHtmlPublic(res.data.error_msg)}</div>` : ''}
              </div>`,
              showCancelButton: true,
              confirmButtonText: '<i class="fas fa-list-check mr-1"></i> ดู Log',
              cancelButtonText: 'ปิด',
              confirmButtonColor: hasWarn ? '#f59e0b' : '#10b981'
            }).then(r => {
              if (r.isConfirmed && res.data.file_id) this.viewBackupLog(res.data.file_id);
            });
            this.cdr.detectChanges();
          } else if (res.data.status === 'failed') {
            this.stopPolling();
            this.isBackingUp = false;
            Swal.fire('Backup ล้มเหลว', res.data.error_msg || '', 'error');
            this.cdr.detectChanges();
          }
        },
        error: () => { /* keep polling on transient errors */ }
      });
    };
    poll(); // ครั้งแรกทันที
    this.pollTimer = setInterval(poll, 1000);
  }

  private stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  ngOnDestroy() {
    this.stopPolling();
    this.stopRestorePolling();
    this.stopMonitor();
    if (this._cloudCallbackPoll) clearInterval(this._cloudCallbackPoll);
  }

  // ===== Files =====
  loadFiles() {
    this.authService.getBackupFiles().subscribe({
      next: (res) => {
        if (res.success) {
          this.files = res.data || [];
          this.diskInfo = res.disk;
          this.backupDir = res.backup_dir;
          this.cdr.detectChanges();
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'โหลดไฟล์ไม่สำเร็จ', 'error')
    });
  }

  downloadFile(f: any) {
    this.authService.downloadBackupFile(f.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = f.file_name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },
      error: () => Swal.fire('ผิดพลาด', 'ดาวน์โหลดไม่สำเร็จ', 'error')
    });
  }

  deleteFile(f: any) {
    Swal.fire({
      title: `ลบไฟล์ "${f.file_name}"?`, icon: 'warning',
      text: 'ไฟล์จะถูกลบจากดิสก์ — ไม่สามารถกู้คืน',
      showCancelButton: true, confirmButtonColor: '#dc2626',
      confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.deleteBackupFile(f.id).subscribe({
        next: () => { Swal.fire({ icon: 'success', title: 'ลบสำเร็จ', timer: 1500, showConfirmButton: false }); this.loadFiles(); },
        error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ลบไม่สำเร็จ', 'error')
      });
    });
  }

  // ===== Restore =====
  openRestore(f: any) {
    this.selectedFileForRestore = f;
    this.restoreMode = 'new_db';
    // Bangkok timezone (UTC+7) — 14-digit compact
    this.restoreTargetDb = `${f.db_name}_restore_${this.bangkokCompactTs()}`;
    this.restoreAutoBackup = true;
    this.activeTab = 'restore';
  }

  private bangkokCompactTs(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(new Date());
    const g = (t: string) => parts.find(p => p.type === t)?.value || '';
    const h = g('hour') === '24' ? '00' : g('hour');
    return `${g('year')}${g('month')}${g('day')}${h}${g('minute')}${g('second')}`;
  }

  runRestore() {
    if (!this.selectedFileForRestore) { Swal.fire('ยังไม่เลือกไฟล์', 'กรุณาเลือกไฟล์จากแท็บ Files', 'warning'); return; }
    if (this.restoreMode === 'new_db' && !/^[a-zA-Z0-9_]+$/.test(this.restoreTargetDb)) {
      Swal.fire('ชื่อ DB ไม่ถูกต้อง', 'ใช้ได้เฉพาะ a-z, 0-9, _', 'warning');
      return;
    }
    const f = this.selectedFileForRestore;
    const isReplace = this.restoreMode === 'replace';
    const confirmHtml = isReplace
      ? `<div style="text-align:left;color:#dc2626"><b>⚠️ ทับ Database เดิม</b><br>
          Database: <code>${f.db_name}</code> จะถูก DROP + restore ใหม่<br>
          ${this.restoreAutoBackup ? '✅ จะ auto-backup ก่อน' : '❌ ไม่ backup ก่อน — เสี่ยงสูง'}</div>`
      : `<div style="text-align:left">Restore เข้า DB ใหม่: <code>${this.restoreTargetDb}</code><br>DB เดิมไม่ถูกแตะ</div>`;
    Swal.fire({
      title: 'ยืนยันการ Restore', icon: isReplace ? 'warning' : 'question',
      html: confirmHtml,
      showCancelButton: true,
      confirmButtonColor: isReplace ? '#dc2626' : '#10b981',
      confirmButtonText: 'เริ่ม Restore', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      if (isReplace) {
        // ยืนยันรอบ 2 — replace
        Swal.fire({
          title: 'ยืนยันอีกครั้ง',
          html: `พิมพ์คำว่า <b>RESTORE</b> เพื่อยืนยัน`,
          input: 'text', showCancelButton: true,
          confirmButtonColor: '#dc2626', confirmButtonText: 'ยืนยัน'
        }).then(r2 => {
          if (r2.value === 'RESTORE') this._doRestore();
        });
      } else {
        this._doRestore();
      }
    });
  }

  private _doRestore() {
    this.isRestoring = true;
    this.currentRestoreJob = null;
    this.authService.restoreBackup(
      this.selectedFileForRestore.id, this.restoreMode, this.restoreTargetDb, this.restoreAutoBackup
    ).subscribe({
      next: (res) => {
        if (!res.success || !res.restore_job_id) {
          this.isRestoring = false;
          Swal.fire('ล้มเหลว', res.message || 'ไม่ได้ restore_job_id', 'error');
          return;
        }
        this.startRestorePolling(res.restore_job_id);
      },
      error: (err) => {
        this.isRestoring = false;
        Swal.fire('Restore ล้มเหลว', err.error?.message || '', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  private startRestorePolling(jobId: number) {
    this.stopRestorePolling();
    const poll = () => {
      this.authService.getRestoreJob(jobId).subscribe({
        next: (res) => {
          if (!res.success) return;
          this.currentRestoreJob = res.data;
          this.cdr.detectChanges();
          if (res.data.status === 'success') {
            this.stopRestorePolling();
            this.isRestoring = false;
            const restoreId = res.data.id;
            Swal.fire({
              icon: 'success', title: 'Restore สำเร็จ',
              html: `<div style="text-align:left;font-size:13px">
                Target DB: <code>${res.data.target_db}</code><br>
                Tables: <b>${res.data.tables_count}</b> <span style="color:#64748b">(verified จาก target DB จริง)</span><br>
                Data: <b>${this.formatBytes(res.data.progress_bytes)}</b><br>
                ${res.data.pre_backup_file_id ? `Auto-backup: file_id <b>#${res.data.pre_backup_file_id}</b><br>` : ''}
                เวลา: ${(res.data.duration_ms / 1000).toFixed(1)} วินาที
              </div>`,
              showCancelButton: true,
              confirmButtonText: '<i class="fas fa-list-check mr-1"></i> ดู Log',
              cancelButtonText: 'ปิด',
              confirmButtonColor: '#10b981'
            }).then(r => {
              if (r.isConfirmed) this.viewRestoreLog(restoreId);
            });
            this.cdr.detectChanges();
          } else if (res.data.status === 'failed') {
            this.stopRestorePolling();
            this.isRestoring = false;
            Swal.fire('Restore ล้มเหลว', res.data.error_msg || '', 'error');
            this.cdr.detectChanges();
          }
        },
        error: () => { /* keep polling */ }
      });
    };
    poll();
    this.restorePollTimer = setInterval(poll, 1000);
  }

  private stopRestorePolling() {
    if (this.restorePollTimer) { clearInterval(this.restorePollTimer); this.restorePollTimer = null; }
  }

  // ===== Logs =====
  viewBackupLog(fileId: number) {
    this.authService.getBackupLog(fileId).subscribe({
      next: (res) => {
        if (res.success) this.showLogModal('Backup Log — ' + res.file_name, res.log_content, () => this.downloadLog('backup', fileId));
        else Swal.fire('ผิดพลาด', res.message || '', 'error');
      },
      error: (err) => Swal.fire('ไม่มี Log', err.error?.message || 'ไม่พบ log file', 'warning')
    });
  }

  viewRestoreLog(jobId: number) {
    this.authService.getRestoreLog(jobId).subscribe({
      next: (res) => {
        if (res.success) this.showLogModal('Restore Log — ' + res.target_db, res.log_content, () => this.downloadLog('restore', jobId));
        else Swal.fire('ผิดพลาด', res.message || '', 'error');
      },
      error: (err) => Swal.fire('ไม่มี Log', err.error?.message || 'ไม่พบ log file', 'warning')
    });
  }

  private showLogModal(title: string, content: string, onDownload: () => void) {
    Swal.fire({
      title, width: 950,
      html: `<pre style="text-align:left;font-family:ui-monospace,Consolas,monospace;font-size:11px;background:#0f172a;color:#e2e8f0;padding:14px;border-radius:8px;max-height:62vh;overflow:auto;white-space:pre">${this.escapeHtml(content)}</pre>`,
      showCancelButton: true,
      confirmButtonText: '<i class="fas fa-download mr-1"></i> ดาวน์โหลด .txt',
      cancelButtonText: 'ปิด',
      confirmButtonColor: '#10b981'
    }).then(r => { if (r.isConfirmed) onDownload(); });
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }
  escapeHtmlPublic(s: string): string { return this.escapeHtml(s || ''); }

  private downloadLog(kind: 'backup' | 'restore', id: number) {
    const obs = kind === 'backup' ? this.authService.downloadBackupLog(id) : this.authService.downloadRestoreLog(id);
    obs.subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${kind}_log_${id}.txt`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      },
      error: () => Swal.fire('ผิดพลาด', 'ดาวน์โหลดไม่สำเร็จ', 'error')
    });
  }

  // ===== Helpers =====
  formatBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  formatDate(d: string): string {
    if (!d) return '-';
    const dt = new Date(d);
    return dt.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  }
}
