import { Component, OnInit, inject, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-announcements',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './announcements.html'
})
export class AnnouncementsComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild('editor') editor!: ElementRef<HTMLDivElement>;

  list: any[] = [];
  showModal: boolean = false;
  isEdit: boolean = false;
  current: any = {
    title: 'ประกาศระบบ',
    content_html: '',
    bg_color: '#dc2626',
    text_color: '#ffffff',
    blink_enabled: true,
    show_on_header: true,
    show_on_login: true,
    is_active: false
  };
  charCount: number = 0;
  readonly MAX_CHARS = 200;

  // === Email modal ===
  showEmailModal: boolean = false;
  emailAnnouncement: any = null;
  emailScope: 'all' | 'dept' | 'users' = 'all';
  emailDeptIds: Set<number> = new Set();
  emailUserIds: Set<number> = new Set();
  allUsers: any[] = [];
  allDepartments: any[] = [];
  emailUserSearch: string = '';
  emailSending: boolean = false;

  quickEmojis = ['📢', '📊', '🎯', '⚠️', '✅', '❌', '⏰', '📅', '🔔', '💡', '🚀', '📈', '📉', '🏥', '💊'];
  fontSizes = [{ v: '2', label: 'เล็ก' }, { v: '3', label: 'ปกติ' }, { v: '5', label: 'ใหญ่' }, { v: '6', label: 'ใหญ่มาก' }];
  bgColors = ['#dc2626', '#ea580c', '#d97706', '#16a34a', '#2563eb', '#7c3aed', '#0f172a'];
  textColors = ['#ffffff', '#fde68a', '#000000', '#fef3c7'];

  ngOnInit() {
    const role = this.authService.getUserRole();
    if (role !== 'super_admin') {
      Swal.fire('Access Denied', 'เฉพาะ super_admin', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadList();
  }

  loadList() {
    this.authService.getAnnouncements().subscribe({
      next: (res: any) => {
        if (res.success) {
          this.list = res.data;
          this.cdr.detectChanges();
        }
      }
    });
  }

  openCreate() {
    this.isEdit = false;
    this.current = {
      title: 'ประกาศระบบ',
      content_html: '',
      bg_color: '#dc2626',
      text_color: '#ffffff',
      blink_enabled: true,
      show_on_header: true,
      show_on_login: true,
      is_active: false
    };
    this.charCount = 0;
    this.showModal = true;
    setTimeout(() => this.editor?.nativeElement && (this.editor.nativeElement.innerHTML = ''), 50);
  }

  openEdit(item: any) {
    this.isEdit = true;
    this.current = {
      ...item,
      blink_enabled: Number(item.blink_enabled) === 1,
      show_on_header: Number(item.show_on_header) === 1,
      show_on_login: Number(item.show_on_login) === 1,
      is_active: Number(item.is_active) === 1
    };
    this.charCount = (item.content_text || '').length;
    this.showModal = true;
    setTimeout(() => this.editor?.nativeElement && (this.editor.nativeElement.innerHTML = item.content_html || ''), 50);
  }

  closeModal() {
    this.showModal = false;
  }

  // === Editor toolbar commands ===
  exec(cmd: string, arg?: string) {
    document.execCommand(cmd, false, arg);
    this.editor.nativeElement.focus();
    this.onEditorInput();
  }

  setFontSize(size: string) { this.exec('fontSize', size); }
  setForeColor(color: string) { this.exec('foreColor', color); }
  setBackColor(color: string) { this.exec('hiliteColor', color); }

  insertEmoji(emoji: string) {
    this.editor.nativeElement.focus();
    document.execCommand('insertText', false, emoji);
    this.onEditorInput();
  }

  insertImageUrl() {
    Swal.fire({
      title: 'แทรกรูปภาพ',
      input: 'url',
      inputPlaceholder: 'https://example.com/image.png',
      showCancelButton: true,
      confirmButtonText: 'แทรก',
      cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed && r.value) {
        this.editor.nativeElement.focus();
        document.execCommand('insertHTML', false, `<img src="${r.value}" style="display:inline-block;max-height:24px;vertical-align:middle;margin:0 4px">`);
        this.onEditorInput();
      }
    });
  }

  insertIcon(iconClass: string) {
    this.editor.nativeElement.focus();
    document.execCommand('insertHTML', false, `<i class="${iconClass}"></i>&nbsp;`);
    this.onEditorInput();
  }

  onEditorInput() {
    const el = this.editor.nativeElement;
    this.current.content_html = el.innerHTML;
    // Strip HTML → get plain text length
    const text = (el.textContent || el.innerText || '').trim();
    this.charCount = text.length;
    if (this.charCount > this.MAX_CHARS) {
      // จำกัดโดย trim ส่วนเกิน
      const truncated = text.substring(0, this.MAX_CHARS);
      el.innerText = truncated;
      this.current.content_html = el.innerHTML;
      this.charCount = truncated.length;
    }
    this.cdr.detectChanges();
  }

  save() {
    if (!this.current.content_html || this.charCount === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกเนื้อหาประกาศ', 'warning');
      return;
    }
    // content_text = stripped HTML
    const tmp = document.createElement('div');
    tmp.innerHTML = this.current.content_html;
    this.current.content_text = (tmp.textContent || tmp.innerText || '').substring(0, 500);

    const obs = this.isEdit
      ? this.authService.updateAnnouncement(this.current.id, this.current)
      : this.authService.createAnnouncement(this.current);
    obs.subscribe({
      next: (res: any) => {
        Swal.fire({ icon: 'success', title: res.message, timer: 1500, showConfirmButton: false });
        this.closeModal();
        this.loadList();
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e.error?.message || 'ไม่สามารถบันทึกได้', 'error')
    });
  }

  activate(item: any) {
    this.authService.activateAnnouncement(item.id).subscribe({
      next: () => { Swal.fire({ icon: 'success', title: 'เปิดใช้งานประกาศสำเร็จ', timer: 1500, showConfirmButton: false }); this.loadList(); }
    });
  }

  // === Email sending ===
  openEmailModal(a: any) {
    this.emailAnnouncement = a;
    this.emailScope = 'all';
    this.emailDeptIds.clear();
    this.emailUserIds.clear();
    this.emailUserSearch = '';
    this.showEmailModal = true;
    // load users + departments
    if (this.allUsers.length === 0) {
      this.authService.getUsers().subscribe((res: any) => {
        if (res.success) {
          this.allUsers = (res.data || []).filter((u: any) => u.email && u.is_active);
          this.cdr.detectChanges();
        }
      });
    }
    if (this.allDepartments.length === 0) {
      this.authService.getDepartments().subscribe((res: any) => {
        if (res.success) { this.allDepartments = res.data; this.cdr.detectChanges(); }
      });
    }
  }

  closeEmailModal() {
    this.showEmailModal = false;
    this.emailAnnouncement = null;
  }

  toggleDept(id: number) {
    if (this.emailDeptIds.has(id)) this.emailDeptIds.delete(id);
    else this.emailDeptIds.add(id);
  }

  toggleUser(id: number) {
    if (this.emailUserIds.has(id)) this.emailUserIds.delete(id);
    else this.emailUserIds.add(id);
  }

  selectAllUsers() {
    const visible = this.filteredUsers();
    const allSelected = visible.every((u: any) => this.emailUserIds.has(u.id));
    if (allSelected) visible.forEach((u: any) => this.emailUserIds.delete(u.id));
    else visible.forEach((u: any) => this.emailUserIds.add(u.id));
  }

  filteredUsers() {
    const s = this.emailUserSearch.toLowerCase().trim();
    if (!s) return this.allUsers;
    return this.allUsers.filter((u: any) =>
      (u.username || '').toLowerCase().includes(s) ||
      (u.firstname + ' ' + u.lastname).toLowerCase().includes(s) ||
      (u.dept_name || '').toLowerCase().includes(s) ||
      (u.email || '').toLowerCase().includes(s)
    );
  }

  getRecipientCount(): number {
    if (this.emailScope === 'all') return this.allUsers.length;
    if (this.emailScope === 'dept') {
      return this.allUsers.filter((u: any) => this.emailDeptIds.has(Number(u.dept_id))).length;
    }
    if (this.emailScope === 'users') return this.emailUserIds.size;
    return 0;
  }

  sendEmail() {
    if (!this.emailAnnouncement) return;
    const count = this.getRecipientCount();
    if (count === 0) {
      Swal.fire('แจ้งเตือน', 'ไม่มีผู้รับ กรุณาเลือกอย่างน้อย 1 คน', 'warning');
      return;
    }
    const payload: any = { scope: this.emailScope };
    if (this.emailScope === 'dept') payload.dept_ids = [...this.emailDeptIds];
    if (this.emailScope === 'users') payload.user_ids = [...this.emailUserIds];

    Swal.fire({
      title: 'ยืนยันส่งอีเมล',
      html: `<p>ส่งประกาศ "<b>${this.emailAnnouncement.title}</b>" ไปยัง <b>${count}</b> คน</p>
             <p class="text-xs text-amber-600 mt-2"><i class="fas fa-clock mr-1"></i>อาจใช้เวลาหลายนาที ขึ้นกับจำนวนผู้รับ</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#16a34a',
      confirmButtonText: '<i class="fas fa-paper-plane mr-1"></i> ส่งอีเมล',
      cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.emailSending = true;
      Swal.fire({ title: `กำลังส่งอีเมล...`, html: `<p class="text-sm">กำลังส่งไปยัง ${count} คน</p>`, allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.sendAnnouncementEmail(this.emailAnnouncement.id, payload).subscribe({
        next: (res: any) => {
          this.emailSending = false;
          Swal.fire({
            icon: 'success',
            title: 'ส่งสำเร็จ',
            html: `<p><b>${res.sent}</b> / ${res.total} คน</p>${res.failed > 0 ? `<p class="text-xs text-red-500">ล้มเหลว ${res.failed} คน</p>` : ''}`,
            timer: 3000
          });
          this.closeEmailModal();
        },
        error: (e: any) => {
          this.emailSending = false;
          Swal.fire('ผิดพลาด', e.error?.message || 'ไม่สามารถส่งอีเมลได้', 'error');
        }
      });
    });
  }

  remove(item: any) {
    Swal.fire({
      title: 'ยืนยันการลบ', icon: 'warning', showCancelButton: true,
      confirmButtonColor: '#d33', confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.authService.deleteAnnouncement(item.id).subscribe({
          next: () => { Swal.fire({ icon: 'success', title: 'ลบสำเร็จ', timer: 1500, showConfirmButton: false }); this.loadList(); }
        });
      }
    });
  }
}
