import { Component, OnInit, OnDestroy, HostListener, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { routes } from '../../app.routes';
import { AuthService } from '../../services/auth';

interface CommandItem {
  label: string;
  icon: string;
  path: string;
  group: string;
  roles?: string[];     // roles ที่เห็นรายการนี้ (ไม่ใส่ = ทุกคน)
  keywords?: string;    // คำค้นเพิ่มเติม (ไม่แสดง)
}

/**
 * Command Palette — กด Ctrl+K (Windows) / Cmd+K (Mac) เปิด
 * ค้นหา + กระโดดไปทุกหน้าได้ใน 1 คลิก
 *
 * ติดตั้งครั้งเดียวใน layout — listen keyboard global
 */
@Component({
  selector: 'app-command-palette',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div *ngIf="open" class="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4 bg-black/50 backdrop-blur-sm"
         (click)="close()">
      <div class="w-full max-w-xl bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
           (click)="$event.stopPropagation()">
        <!-- Search -->
        <div class="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <i class="fas fa-search text-gray-400"></i>
          <input #searchInput
                 type="text"
                 [(ngModel)]="query"
                 (ngModelChange)="onQuery()"
                 (keydown)="onKey($event)"
                 placeholder="ค้นหาเมนู หรือพิมพ์คำสำคัญ..."
                 class="flex-1 bg-transparent outline-none text-sm text-gray-800 placeholder-gray-400">
          <kbd class="hidden sm:inline px-2 py-0.5 text-[10px] bg-gray-100 text-gray-500 rounded border border-gray-200">ESC</kbd>
        </div>

        <!-- Results -->
        <div class="overflow-y-auto flex-1">
          <div *ngIf="filtered.length === 0" class="px-4 py-12 text-center text-sm text-gray-400">
            <i class="fas fa-binoculars text-2xl mb-2 block"></i>
            ไม่พบรายการที่ตรงกับ "{{ query }}"
          </div>
          <ng-container *ngFor="let group of groupedKeys; trackBy: trackGroup">
            <div class="px-4 pt-3 pb-1 text-[10px] uppercase font-bold text-gray-400 tracking-wider">{{ group }}</div>
            <button *ngFor="let item of grouped[group]; let i = index; trackBy: trackItem"
                    type="button"
                    (click)="go(item)"
                    [class.bg-green-50]="isHighlighted(item)"
                    class="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-green-50 text-left transition-colors">
              <div class="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
                <i class="fas {{ item.icon }} text-green-700 text-xs"></i>
              </div>
              <span class="flex-1 text-sm text-gray-700">{{ item.label }}</span>
              <i *ngIf="isHighlighted(item)" class="fas fa-arrow-right text-green-500 text-xs"></i>
            </button>
          </ng-container>
        </div>

        <!-- Footer hint -->
        <div class="px-4 py-2 border-t border-gray-100 bg-gray-50 flex items-center justify-between text-[10px] text-gray-400">
          <span><kbd class="px-1.5 py-0.5 bg-white border rounded">↑</kbd> <kbd class="px-1.5 py-0.5 bg-white border rounded">↓</kbd> เลื่อน</span>
          <span><kbd class="px-1.5 py-0.5 bg-white border rounded">Enter</kbd> เปิด</span>
          <span><kbd class="px-1.5 py-0.5 bg-white border rounded">Esc</kbd> ปิด</span>
        </div>
      </div>
    </div>
  `
})
export class CommandPaletteComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private auth = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  open: boolean = false;
  query: string = '';
  highlightedIndex: number = 0;
  filtered: CommandItem[] = [];
  grouped: { [k: string]: CommandItem[] } = {};
  groupedKeys: string[] = [];

  // รายการคำสั่งหลัก — derive จาก app.routes ได้ แต่ explicit ดีกว่าควบคุม label + icon + group
  private commands: CommandItem[] = [
    { label: 'หน้าหลัก / บันทึกผลงานตัวชี้วัด', icon: 'fa-th-large', path: '/dashboard', group: 'หน้าหลัก', keywords: 'dashboard home kpi' },
    { label: 'กราฟและสถิติ / รายงาน',           icon: 'fa-chart-bar',  path: '/charts',    group: 'หน้าหลัก', keywords: 'chart report กราฟ' },
    { label: 'การแจ้งเตือน',                    icon: 'fa-bell',       path: '/notifications', group: 'หน้าหลัก', keywords: 'notification' },
    { label: 'จัดการผู้ใช้งาน',                 icon: 'fa-users-cog',  path: '/users',     group: 'จัดการ', roles: ['admin_hos','admin_sso','admin_cup','admin_ssj','super_admin'], keywords: 'user' },
    { label: 'จัดการตัวชี้วัด',                  icon: 'fa-tasks',      path: '/kpi-manage', group: 'จัดการ', roles: ['admin_ssj','super_admin'], keywords: 'kpi indicator' },
    { label: 'จัดการข้อมูล KPI',                 icon: 'fa-layer-group', path: '/kpi-manager', group: 'จัดการ', roles: ['super_admin'], keywords: 'kpi data export' },
    { label: '+ KPI ปีงบประมาณใหม่',            icon: 'fa-plus-circle', path: '/kpi-setup', group: 'จัดการ', roles: ['super_admin'], keywords: 'kpi setup year' },
    { label: 'ประวัติการใช้งาน (Audit log)',     icon: 'fa-history',    path: '/audit-logs', group: 'ผู้ดูแลระบบ', roles: ['super_admin'], keywords: 'log audit' },
    { label: 'ผู้ใช้งานออนไลน์',                  icon: 'fa-satellite-dish', path: '/online-users', group: 'ผู้ดูแลระบบ', roles: ['super_admin'], keywords: 'online session' },
    { label: 'ประกาศระบบ',                       icon: 'fa-bullhorn',   path: '/announcements', group: 'ผู้ดูแลระบบ', roles: ['super_admin'], keywords: 'announce' },
    { label: 'สำรอง & กู้คืนฐานข้อมูล',           icon: 'fa-database',   path: '/backup-manager', group: 'ผู้ดูแลระบบ', roles: ['super_admin'], keywords: 'backup restore database' },
    { label: 'แจ้งเตือนการบันทึก KPI',           icon: 'fa-bullhorn',   path: '/kpi-audit-digest', group: 'ผู้ดูแลระบบ', roles: ['super_admin'], keywords: 'audit digest' },
    { label: 'ตั้งค่าระบบ',                       icon: 'fa-sliders-h',  path: '/settings',  group: 'ผู้ดูแลระบบ', roles: ['super_admin'], keywords: 'settings config' },
    { label: 'กระดานข้อเสนอแนะ',                icon: 'fa-comments',   path: '/feedback',  group: 'ทั่วไป', keywords: 'feedback' },
    { label: 'คู่มือการใช้งาน',                   icon: 'fa-book-open',  path: '/help',      group: 'ทั่วไป', keywords: 'help manual' },
    { label: 'ประวัติการอัปเดต (Changelog)',     icon: 'fa-clock-rotate-left', path: '/changelog', group: 'ทั่วไป', keywords: 'changelog version' },
  ];

  ngOnInit() { this.refilter(); }
  ngOnDestroy() {}

  /** เปิด/ปิดจากภายนอก (เผื่อปุ่มใน header) */
  toggle() { this.open ? this.close() : this.show(); }

  show() {
    this.open = true;
    this.query = '';
    this.highlightedIndex = 0;
    this.refilter();
    // focus input หลัง render
    setTimeout(() => {
      const el = document.querySelector('app-command-palette input') as HTMLInputElement;
      el?.focus();
    }, 50);
    this.cdr.detectChanges();
  }

  close() {
    this.open = false;
    this.cdr.detectChanges();
  }

  // === Global keyboard listener ===
  @HostListener('window:keydown', ['$event'])
  onWindowKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      this.toggle();
    } else if (e.key === 'Escape' && this.open) {
      e.preventDefault();
      this.close();
    }
  }

  // === Internal keys (ขณะ palette เปิด) ===
  onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.highlightedIndex = Math.min(this.highlightedIndex + 1, this.filtered.length - 1);
      this.scrollToHighlighted();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.highlightedIndex = Math.max(this.highlightedIndex - 1, 0);
      this.scrollToHighlighted();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this.filtered[this.highlightedIndex];
      if (item) this.go(item);
    }
  }

  onQuery() {
    this.highlightedIndex = 0;
    this.refilter();
  }

  isHighlighted(item: CommandItem): boolean {
    return this.filtered[this.highlightedIndex] === item;
  }

  private refilter() {
    const role = this.auth.getUserRole();
    const q = (this.query || '').toLowerCase().trim();
    const accessible = this.commands.filter(c => !c.roles || c.roles.includes(role));
    this.filtered = q
      ? accessible.filter(c =>
          c.label.toLowerCase().includes(q) ||
          (c.keywords || '').toLowerCase().includes(q) ||
          c.path.toLowerCase().includes(q))
      : accessible;
    // group
    this.grouped = {};
    for (const c of this.filtered) {
      if (!this.grouped[c.group]) this.grouped[c.group] = [];
      this.grouped[c.group].push(c);
    }
    this.groupedKeys = Object.keys(this.grouped);
  }

  private scrollToHighlighted() {
    setTimeout(() => {
      const btns = document.querySelectorAll('app-command-palette button');
      const item = this.filtered[this.highlightedIndex];
      if (!item) return;
      const idx = Array.from(btns).findIndex(b => b.textContent?.includes(item.label));
      if (idx >= 0) (btns[idx] as HTMLElement).scrollIntoView({ block: 'nearest' });
    }, 0);
  }

  go(item: CommandItem) {
    this.router.navigate([item.path]);
    this.close();
  }

  trackGroup = (_i: number, k: string) => k;
  trackItem = (_i: number, it: CommandItem) => it.path;
}
