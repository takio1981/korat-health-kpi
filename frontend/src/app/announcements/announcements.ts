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
