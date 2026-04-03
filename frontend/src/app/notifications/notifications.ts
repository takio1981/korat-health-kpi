import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, ActivatedRoute } from '@angular/router';
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
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  notifications: any[] = [];
  filteredNotifications: any[] = [];
  activeFilter: string = 'all';
  isLoading: boolean = false;
  approveCount: number = 0;
  rejectCount: number = 0;
  appealCount: number = 0;
  replyCount: number = 0;
  mineCount: number = 0;
  unreadNotifCount: number = 0;
  isAdmin: boolean = false;
  appealSettings: any = { is_open: false };

  // Reply tab data
  replies: any[] = [];
  isLoadingReplies: boolean = false;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin_ssj', 'super_admin'].includes(role);
    // อ่าน query parameter สำหรับ filter (เช่น ?filter=reject)
    this.route.queryParams.subscribe(params => {
      if (params['filter']) {
        this.activeFilter = params['filter'];
      }
    });
    this.loadNotifications();
    this.loadAppealSettings();
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

  loadReplies() {
    this.isLoadingReplies = true;
    this.authService.getKpiReplies().subscribe({
      next: (res) => {
        this.isLoadingReplies = false;
        if (res.success) {
          this.replies = res.data;
          this.replyCount = this.replies.length;
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.isLoadingReplies = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadAppealSettings() {
    this.authService.getAppealSettings().subscribe({
      next: (res) => {
        if (res.success) this.appealSettings = res.data;
        this.cdr.detectChanges();
      }
    });
  }

  applyFilter() {
    const mainNotifs = this.notifications;
    this.approveCount = mainNotifs.filter(n => n.type === 'approve').length;
    this.rejectCount = mainNotifs.filter(n => n.type === 'reject').length;
    this.appealCount = mainNotifs.filter(n => n.type === 'appeal').length;
    const myHospcode = this.authService.getUser()?.hospcode;
    this.mineCount = mainNotifs.filter(n => n.hospcode && n.hospcode === myHospcode).length;
    if (this.activeFilter === 'all') {
      this.filteredNotifications = mainNotifs;
    } else if (this.activeFilter === 'unread') {
      this.filteredNotifications = mainNotifs.filter(n => !n.is_read);
    } else if (this.activeFilter === 'approve') {
      this.filteredNotifications = mainNotifs.filter(n => n.type === 'approve');
    } else if (this.activeFilter === 'reject') {
      this.filteredNotifications = mainNotifs.filter(n => n.type === 'reject');
    } else if (this.activeFilter === 'appeal') {
      this.filteredNotifications = mainNotifs.filter(n => n.type === 'appeal');
    } else if (this.activeFilter === 'mine') {
      this.filteredNotifications = mainNotifs.filter(n => n.hospcode && n.hospcode === myHospcode);
    } else if (this.activeFilter === 'reply') {
      this.filteredNotifications = [];
    }
  }

  setFilter(filter: string) {
    this.activeFilter = filter;
    this.applyFilter();
    if (filter === 'reply') {
      this.loadReplies();
    }
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

  replyNotification(notif: any) {
    // โหลดเหตุผลตีกลับล่าสุด
    this.authService.getRejectionComments(notif.indicator_id, notif.year_bh, notif.hospcode).subscribe({
      next: (res) => {
        const monthNames: any = {
          oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
          apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
        };
        let rejectionInfo = '';
        if (res.success && res.data.length > 0) {
          const latest = res.data.find((h: any) => h.type === 'reject') || res.data[0];
          const monthsDisplay = latest.reject_months
            ? latest.reject_months.split(',').map((m: string) => monthNames[m.trim()] || m.trim()).join(', ')
            : '';
          rejectionInfo = `<div class="bg-red-50 border border-red-200 rounded-lg p-3 mb-3 text-left">
            <div class="text-xs font-bold text-red-600 mb-1"><i class="fas fa-exclamation-triangle mr-1"></i>เหตุผลที่ถูกตีกลับ:</div>
            <p class="text-sm text-gray-700">${latest.comment}</p>
            ${monthsDisplay ? `<div class="mt-1"><span class="text-xs font-bold text-red-500">เดือนที่ต้องแก้ไข: </span><span class="text-xs text-gray-600">${monthsDisplay}</span></div>` : ''}
            <div class="text-xs text-gray-400 mt-1">ตีกลับโดย: ${latest.firstname || ''} ${latest.lastname || ''}</div>
          </div>`;
        }

        Swal.fire({
          title: 'ตอบกลับการตีกลับ',
          html: `<div class="text-left">
            <p class="text-sm text-gray-600 mb-3">${notif.title}</p>
            ${rejectionInfo}
            <label class="block text-sm font-medium text-gray-700 mb-1">ข้อความตอบกลับ <span class="text-gray-400 text-xs">(ไม่บังคับ)</span></label>
            <textarea id="swal-reply-msg" rows="3" placeholder="ระบุรายละเอียดการแก้ไข... (หากไม่ระบุ ระบบจะใช้ข้อความเริ่มต้น)"
              style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;"></textarea>
          </div>`,
          showCancelButton: true,
          confirmButtonColor: '#3b82f6',
          confirmButtonText: '<i class="fas fa-paper-plane mr-1"></i>ส่งตอบกลับ',
          cancelButtonText: 'ยกเลิก',
          width: 500,
          preConfirm: () => {
            return (document.getElementById('swal-reply-msg') as HTMLTextAreaElement)?.value || '';
          }
        }).then((result) => {
          if (result.isConfirmed) {
            Swal.fire({ title: 'กำลังส่งตอบกลับ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            const data = {
              indicator_id: notif.indicator_id,
              year_bh: notif.year_bh,
              hospcode: notif.hospcode,
              message: result.value
            };
            this.authService.replyKpi(data).subscribe({
              next: (res2: any) => {
                if (res2.success) {
                  Swal.fire('สำเร็จ', 'ส่งตอบกลับเรียบร้อยแล้ว สถานะเปลี่ยนเป็น "รอตรวจสอบ"', 'success');
                  this.loadNotifications();
                }
              },
              error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถส่งตอบกลับได้', 'error')
            });
          }
        });
      },
      error: () => {
        Swal.fire({
          title: 'ตอบกลับการตีกลับ',
          html: `<div class="text-left">
            <p class="text-sm text-gray-600 mb-3">${notif.title}</p>
            <label class="block text-sm font-medium text-gray-700 mb-1">ข้อความตอบกลับ <span class="text-gray-400 text-xs">(ไม่บังคับ)</span></label>
            <textarea id="swal-reply-msg" rows="3" placeholder="ระบุรายละเอียดการแก้ไข..."
              style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;"></textarea>
          </div>`,
          showCancelButton: true,
          confirmButtonColor: '#3b82f6',
          confirmButtonText: '<i class="fas fa-paper-plane mr-1"></i>ส่งตอบกลับ',
          cancelButtonText: 'ยกเลิก',
          preConfirm: () => {
            return (document.getElementById('swal-reply-msg') as HTMLTextAreaElement)?.value || '';
          }
        }).then((result) => {
          if (result.isConfirmed) {
            Swal.fire({ title: 'กำลังส่งตอบกลับ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
            const data = {
              indicator_id: notif.indicator_id,
              year_bh: notif.year_bh,
              hospcode: notif.hospcode,
              message: result.value
            };
            this.authService.replyKpi(data).subscribe({
              next: (res2: any) => {
                if (res2.success) {
                  Swal.fire('สำเร็จ', 'ส่งตอบกลับเรียบร้อยแล้ว', 'success');
                  this.loadNotifications();
                }
              },
              error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถส่งตอบกลับได้', 'error')
            });
          }
        });
      }
    });
  }

  // === อุทธรณ์ ===

  openAppealFromNotif(notif: any) {
    Swal.fire({
      title: 'ยื่นอุทธรณ์ขอแก้ไขคะแนน',
      html: `<p class="text-sm text-gray-600 mb-3">${notif.title}</p>`,
      input: 'textarea',
      inputLabel: 'เหตุผลในการยื่นอุทธรณ์',
      inputPlaceholder: 'ระบุเหตุผลที่ต้องการขอแก้ไขคะแนน...',
      inputValidator: (value) => !value ? 'กรุณาระบุเหตุผล' : null,
      showCancelButton: true,
      confirmButtonText: 'ยื่นอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#7c3aed'
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        this.authService.appealKpi({
          indicator_id: notif.indicator_id,
          year_bh: notif.year_bh,
          hospcode: notif.hospcode,
          reason: result.value
        }).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'ยื่นอุทธรณ์เรียบร้อยแล้ว รอ Admin พิจารณา', 'success');
              this.loadNotifications();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถยื่นอุทธรณ์ได้', 'error')
        });
      }
    });
  }

  approveAppealFromNotif(notif: any) {
    Swal.fire({
      title: 'อนุมัติอุทธรณ์',
      html: `<p class="text-sm">${notif.title}<br>ข้อมูลจะถูกปลดล็อคให้หน่วยบริการแก้ไขได้</p>`,
      input: 'textarea',
      inputLabel: 'ความเห็น (ไม่บังคับ)',
      showCancelButton: true,
      confirmButtonText: 'อนุมัติอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#16a34a'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.approveAppeal({
          indicator_id: notif.indicator_id,
          year_bh: notif.year_bh,
          hospcode: notif.hospcode,
          comment: result.value || ''
        }).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'อนุมัติอุทธรณ์เรียบร้อย ข้อมูลถูกปลดล็อคแล้ว', 'success');
              this.loadNotifications();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถอนุมัติอุทธรณ์ได้', 'error')
        });
      }
    });
  }

  rejectAppealFromNotif(notif: any) {
    Swal.fire({
      title: 'ปฏิเสธอุทธรณ์',
      html: `<p class="text-sm">${notif.title}<br>ข้อมูลจะยังคงถูกล็อคไว้</p>`,
      input: 'textarea',
      inputLabel: 'เหตุผลในการปฏิเสธ',
      inputValidator: (value) => !value ? 'กรุณาระบุเหตุผล' : null,
      showCancelButton: true,
      confirmButtonText: 'ปฏิเสธอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626'
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        this.authService.rejectAppeal({
          indicator_id: notif.indicator_id,
          year_bh: notif.year_bh,
          hospcode: notif.hospcode,
          comment: result.value
        }).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'ปฏิเสธอุทธรณ์เรียบร้อย', 'success');
              this.loadNotifications();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปฏิเสธอุทธรณ์ได้', 'error')
        });
      }
    });
  }

  viewPendingUserDetail(notif: any) {
    if (!notif.created_by) {
      Swal.fire('แจ้งเตือน', 'ไม่พบข้อมูลผู้สมัคร', 'warning');
      return;
    }
    this.authService.getUserById(notif.created_by).subscribe({
      next: (res) => {
        if (res.success) {
          const u = res.data;
          const roleLabel: any = { user_hos: 'User รพ.', user_sso: 'User รพ.สต.', user_cup: 'User CUP', user_ssj: 'User SSJ', admin_hos: 'Admin รพ.', admin_sso: 'Admin รพ.สต.', admin_cup: 'Admin CUP', admin_ssj: 'Admin SSJ', super_admin: 'Super Admin' };
          const statusBadge = u.is_approved === 0
            ? '<span style="background:#fef3c7;color:#92400e;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:bold;">รอการอนุมัติ</span>'
            : u.is_approved === 1
            ? '<span style="background:#d1fae5;color:#065f46;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:bold;">อนุมัติแล้ว</span>'
            : '<span style="background:#fee2e2;color:#991b1b;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:bold;">ถูกปฏิเสธ</span>';
          const cidFormatted = u.cid
            ? `${u.cid.slice(0,1)}-${u.cid.slice(1,5)}-${u.cid.slice(5,10)}-${u.cid.slice(10,12)}-${u.cid.slice(12)}`
            : '-';
          Swal.fire({
            title: 'ข้อมูลผู้สมัครใช้งานใหม่',
            html: `
              <div style="text-align:left;font-size:14px;line-height:2">
                <div style="text-align:center;margin-bottom:12px">${statusBadge}</div>
                <table style="width:100%;border-collapse:collapse">
                  <tr><td style="color:#6b7280;width:40%">ชื่อ-นามสกุล</td><td style="font-weight:600">${u.firstname} ${u.lastname}</td></tr>
                  <tr><td style="color:#6b7280">ชื่อผู้ใช้งาน</td><td style="font-weight:600">${u.username}</td></tr>
                  <tr><td style="color:#6b7280">สิทธิ์ที่ขอ</td><td style="font-weight:600">${roleLabel[u.role] || u.role}</td></tr>
                  <tr><td style="color:#6b7280">หน่วยบริการ</td><td style="font-weight:600">${u.hosname || u.hospcode || '-'}</td></tr>
                  <tr><td style="color:#6b7280">เลขบัตรประชาชน</td><td style="font-weight:600;font-family:monospace">${cidFormatted}</td></tr>
                  <tr><td style="color:#6b7280">หน่วยงาน</td><td style="font-weight:600">${u.dept_name || '-'}</td></tr>
                </table>
              </div>`,
            icon: 'info',
            showCancelButton: true,
            confirmButtonColor: '#16a34a',
            cancelButtonColor: '#6b7280',
            confirmButtonText: '<i class="fas fa-user-check mr-1"></i>ไปอนุมัติ',
            cancelButtonText: 'ปิด'
          }).then((result) => {
            if (result.isConfirmed) {
              this.router.navigate(['/users'], { queryParams: { status: 'pending' } });
            }
          });
        }
      },
      error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลผู้สมัครได้', 'error')
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
