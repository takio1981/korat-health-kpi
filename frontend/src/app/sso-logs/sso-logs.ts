import { Component, inject, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-sso-logs',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './sso-logs.html'
})
export class SsoLogsComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  // Filters
  filterProvider = '';
  filterFlow     = '';
  filterOutcome  = '';
  filterFrom     = '';
  filterTo       = '';

  // Table
  logs: any[]    = [];
  total          = 0;
  page           = 1;
  pageSize       = 50;
  pages          = 0;
  loading        = false;

  // Stats
  stats: any     = null;
  statsLoading   = false;

  // Modal
  selectedLog: any = null;
  showModal       = false;

  // Active tab: 'logs' | 'profiles' | 'stats'
  activeTab = 'logs';

  // Profiles
  profiles: any[]  = [];
  profilesTotal    = 0;
  profilesPage     = 1;
  profilesLoading  = false;

  readonly OUTCOMES = [
    { value: 'success',           label: 'สำเร็จ',           color: 'green' },
    { value: 'no_match',          label: 'ไม่พบ User',       color: 'yellow' },
    { value: 'register_redirect', label: 'Register',         color: 'blue' },
    { value: 'blocked',           label: 'ถูกบล็อก',         color: 'red' },
    { value: 'error',             label: 'ข้อผิดพลาด',      color: 'gray' }
  ];

  ngOnInit() {
    this.loadStats();
    this.loadLogs();
  }

  loadStats() {
    this.statsLoading = true;
    this.authService.apiGet('/admin/sso-stats').subscribe({
      next: (res: any) => {
        this.statsLoading = false;
        if (res.success) this.stats = res;
        this.cdr.detectChanges();
      },
      error: () => { this.statsLoading = false; this.cdr.detectChanges(); }
    });
  }

  loadLogs(resetPage = false) {
    if (resetPage) this.page = 1;
    this.loading = true;
    const params: any = { page: this.page, limit: this.pageSize };
    if (this.filterProvider) params.provider = this.filterProvider;
    if (this.filterFlow)     params.flow     = this.filterFlow;
    if (this.filterOutcome)  params.outcome  = this.filterOutcome;
    if (this.filterFrom)     params.from     = this.filterFrom;
    if (this.filterTo)       params.to       = this.filterTo;

    this.authService.apiGet('/admin/sso-logs', params).subscribe({
      next: (res: any) => {
        this.loading = false;
        if (res.success) {
          this.logs  = res.data;
          this.total = res.total;
          this.pages = res.pages;
        }
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.loading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'โหลดข้อมูลไม่สำเร็จ', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  loadProfiles(resetPage = false) {
    if (resetPage) this.profilesPage = 1;
    this.profilesLoading = true;
    const params: any = { page: this.profilesPage, limit: 50 };
    if (this.filterProvider) params.provider = this.filterProvider;

    this.authService.apiGet('/admin/sso-profiles', params).subscribe({
      next: (res: any) => {
        this.profilesLoading = false;
        if (res.success) {
          this.profiles      = res.data;
          this.profilesTotal = res.total;
        }
        this.cdr.detectChanges();
      },
      error: () => { this.profilesLoading = false; this.cdr.detectChanges(); }
    });
  }

  switchTab(tab: string) {
    this.activeTab = tab;
    if (tab === 'logs' && this.logs.length === 0)          this.loadLogs();
    if (tab === 'profiles' && this.profiles.length === 0)  this.loadProfiles();
    if (tab === 'stats' && !this.stats)                    this.loadStats();
  }

  applyFilters() { this.loadLogs(true); }

  clearFilters() {
    this.filterProvider = '';
    this.filterFlow     = '';
    this.filterOutcome  = '';
    this.filterFrom     = '';
    this.filterTo       = '';
    this.loadLogs(true);
  }

  goPage(p: number) {
    if (p < 1 || p > this.pages) return;
    this.page = p;
    this.loadLogs();
  }

  openDetail(log: any) {
    this.loading = true;
    this.authService.apiGet(`/admin/sso-logs/${log.id}`).subscribe({
      next: (res: any) => {
        this.loading = false;
        if (res.success) { this.selectedLog = res.data; this.showModal = true; }
        this.cdr.detectChanges();
      },
      error: () => { this.loading = false; this.cdr.detectChanges(); }
    });
  }

  closeModal() { this.showModal = false; this.selectedLog = null; }

  formatJson(val: any): string {
    if (!val) return '–';
    try {
      const obj = typeof val === 'string' ? JSON.parse(val) : val;
      return JSON.stringify(obj, null, 2);
    } catch { return String(val); }
  }

  outcomeColor(outcome: string): string {
    const map: Record<string, string> = {
      success:           'bg-green-100 text-green-800',
      no_match:          'bg-yellow-100 text-yellow-800',
      register_redirect: 'bg-blue-100 text-blue-800',
      blocked:           'bg-red-100 text-red-800',
      error:             'bg-gray-100 text-gray-700'
    };
    return map[outcome] || 'bg-gray-100 text-gray-700';
  }

  outcomeLabel(outcome: string): string {
    return this.OUTCOMES.find(o => o.value === outcome)?.label || outcome;
  }

  providerBadge(provider: string): string {
    return provider === 'thaid'
      ? 'bg-blue-100 text-blue-800'
      : 'bg-cyan-100 text-cyan-800';
  }

  providerLabel(provider: string): string {
    return provider === 'thaid' ? 'ThaID' : 'ProviderID';
  }

  // นับ outcome จาก stats
  statCount(provider: string, outcome: string): number {
    if (!this.stats?.by_outcome) return 0;
    const row = this.stats.by_outcome.find((r: any) => r.provider === provider && r.outcome === outcome);
    return row?.cnt || 0;
  }

  statProfileCount(provider: string): number {
    if (!this.stats?.profiles) return 0;
    const row = this.stats.profiles.find((r: any) => r.provider === provider);
    return row?.cnt || 0;
  }

  statTotalLogins(provider: string): number {
    if (!this.stats?.profiles) return 0;
    const row = this.stats.profiles.find((r: any) => r.provider === provider);
    return row?.total_logins || 0;
  }

  pagesArray(): number[] {
    const total = this.pages;
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const p = this.page;
    const arr: number[] = [1];
    if (p > 3) arr.push(-1);
    for (let i = Math.max(2, p - 1); i <= Math.min(total - 1, p + 1); i++) arr.push(i);
    if (p < total - 2) arr.push(-1);
    arr.push(total);
    return arr;
  }
}
