import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-online-users',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './online-users.html'
})
export class OnlineUsersComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  users: any[] = [];
  stats: any = { total: 0, by_role: {}, window_min: 5, server_time: '' };
  windowMin: number = 5;
  windowOptions = [
    { v: 2, label: '2 นาที' },
    { v: 5, label: '5 นาที (แนะนำ)' },
    { v: 15, label: '15 นาที' },
    { v: 30, label: '30 นาที' },
    { v: 60, label: '1 ชั่วโมง' },
    { v: 240, label: '4 ชั่วโมง' },
  ];

  searchTerm: string = '';
  selectedRole: string = '';
  isLoading: boolean = false;
  autoRefresh: boolean = true;
  refreshIntervalSec: number = 15;
  private timer: any = null;
  lastUpdated: Date = new Date();

  roleLabels: { [k: string]: string } = {
    super_admin: 'Super Admin',
    admin_ssj: 'Admin สสจ.',
    admin_cup: 'Admin CUP',
    admin_hos: 'Admin รพ.',
    admin_sso: 'Admin สสอ.',
    user_cup: 'User CUP',
    user_hos: 'User รพ.',
    user_sso: 'User สสอ.',
    user_ssj: 'User สสจ.',
  };

  roleColors: { [k: string]: string } = {
    super_admin: 'bg-red-100 text-red-700',
    admin_ssj: 'bg-purple-100 text-purple-700',
    admin_cup: 'bg-indigo-100 text-indigo-700',
    admin_hos: 'bg-blue-100 text-blue-700',
    admin_sso: 'bg-cyan-100 text-cyan-700',
    user_cup: 'bg-amber-100 text-amber-700',
    user_hos: 'bg-green-100 text-green-700',
    user_sso: 'bg-teal-100 text-teal-700',
    user_ssj: 'bg-gray-100 text-gray-700',
  };

  ngOnInit() {
    const role = this.authService.getUserRole();
    if (role !== 'super_admin') {
      Swal.fire('Access Denied', 'เฉพาะ super_admin เท่านั้น', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }
    this.load();
    this.startAutoRefresh();
  }

  ngOnDestroy() {
    this.stopAutoRefresh();
  }

  load() {
    this.isLoading = true;
    this.authService.getOnlineUsers(this.windowMin).subscribe({
      next: (res: any) => {
        this.isLoading = false;
        if (res?.success) {
          this.users = res.data || [];
          this.stats = res.stats || { total: 0, by_role: {}, window_min: this.windowMin, server_time: '' };
          this.lastUpdated = new Date();
          this.cdr.detectChanges();
        }
      },
      error: () => { this.isLoading = false; this.cdr.detectChanges(); }
    });
  }

  toggleAutoRefresh() {
    this.autoRefresh = !this.autoRefresh;
    if (this.autoRefresh) this.startAutoRefresh();
    else this.stopAutoRefresh();
  }

  private startAutoRefresh() {
    this.stopAutoRefresh();
    if (!this.autoRefresh) return;
    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(() => {
        this.zone.run(() => this.load());
      }, this.refreshIntervalSec * 1000);
    });
  }

  private stopAutoRefresh() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  onWindowChange() {
    this.load();
  }

  onRefreshIntervalChange() {
    this.startAutoRefresh();
  }

  get filteredUsers(): any[] {
    const term = this.searchTerm.trim().toLowerCase();
    return this.users.filter(u => {
      if (this.selectedRole && u.role !== this.selectedRole) return false;
      if (!term) return true;
      const name = `${u.firstname || ''} ${u.lastname || ''}`.toLowerCase();
      return (u.username || '').toLowerCase().includes(term)
        || name.includes(term)
        || (u.dept_name || '').toLowerCase().includes(term)
        || (u.hosname || '').toLowerCase().includes(term)
        || (u.distname || '').toLowerCase().includes(term);
    });
  }

  formatIdle(sec: number): string {
    if (sec == null || sec < 0) return '-';
    if (sec < 60) return `${sec} วินาทีที่แล้ว`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} นาทีที่แล้ว`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ชม. ${m % 60} นาทีที่แล้ว`;
    return `${Math.floor(h / 24)} วันที่แล้ว`;
  }

  idleColor(sec: number): string {
    if (sec == null) return 'text-gray-400';
    if (sec < 60) return 'text-green-600';
    if (sec < 300) return 'text-blue-600';
    if (sec < 900) return 'text-amber-600';
    return 'text-gray-500';
  }

  formatDateTime(s: string): string {
    if (!s) return '-';
    try { return new Date(s).toLocaleString('th-TH'); } catch { return s; }
  }

  roleLabel(r: string): string { return this.roleLabels[r] || r; }
  roleColor(r: string): string { return this.roleColors[r] || 'bg-gray-100 text-gray-700'; }

  parseUA(ua: string): { os: string; browser: string } {
    if (!ua) return { os: '-', browser: '-' };
    let os = 'Unknown', browser = 'Unknown';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
    else if (/Mac/i.test(ua)) os = 'macOS';
    else if (/Linux/i.test(ua)) os = 'Linux';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua)) browser = 'Safari';
    return { os, browser };
  }

  objectKeys(o: any): string[] { return Object.keys(o || {}); }
}
