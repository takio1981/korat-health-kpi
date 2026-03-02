import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './notifications.html',
  styleUrl: './notifications.css'
})
export class NotificationsComponent implements OnInit {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  notifications: any[] = [];
  filteredNotifications: any[] = [];
  activeFilter: string = 'all';
  isLoading: boolean = false;
  approveCount: number = 0;
  rejectCount: number = 0;
  unreadNotifCount: number = 0;

  ngOnInit() {
    this.loadNotifications();
    // Subscribe shared unread count
    this.authService.unreadCount$.subscribe(count => {
      this.unreadNotifCount = count;
      this.cdr.detectChanges();
    });
    this.authService.refreshUnreadCount();
  }

  loadNotifications() {
    this.isLoading = true;
    this.authService.getNotifications().subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res.success) {
          this.notifications = res.data;
          this.applyFilter();
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error loading notifications:', err);
      }
    });
  }

  applyFilter() {
    this.approveCount = this.notifications.filter(n => n.type === 'approve').length;
    this.rejectCount = this.notifications.filter(n => n.type === 'reject').length;
    if (this.activeFilter === 'all') {
      this.filteredNotifications = this.notifications;
    } else if (this.activeFilter === 'unread') {
      this.filteredNotifications = this.notifications.filter(n => !n.is_read);
    } else if (this.activeFilter === 'approve') {
      this.filteredNotifications = this.notifications.filter(n => n.type === 'approve');
    } else if (this.activeFilter === 'reject') {
      this.filteredNotifications = this.notifications.filter(n => n.type === 'reject');
    }
  }

  setFilter(filter: string) {
    this.activeFilter = filter;
    this.applyFilter();
  }

  markAsRead(notif: any) {
    if (notif.is_read) return;
    this.authService.markNotificationsRead({ ids: [notif.id] }).subscribe({
      next: () => {
        notif.is_read = 1;
        this.authService.refreshUnreadCount();
        this.applyFilter();
        this.cdr.detectChanges();
      }
    });
  }

  markAllAsRead() {
    this.authService.markNotificationsRead({ all: true }).subscribe({
      next: () => {
        this.notifications.forEach(n => n.is_read = 1);
        this.authService.refreshUnreadCount();
        this.applyFilter();
        this.cdr.detectChanges();
        Swal.fire('สำเร็จ', 'อ่านการแจ้งเตือนทั้งหมดแล้ว', 'success');
      }
    });
  }

  getTimeAgo(dateStr: string): string {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'เมื่อสักครู่';
    if (diffMin < 60) return `${diffMin} นาทีที่แล้ว`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} ชั่วโมงที่แล้ว`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay} วันที่แล้ว`;
    return `${Math.floor(diffDay / 30)} เดือนที่แล้ว`;
  }
}
