import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-feedback',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './feedback.html'
})
export class FeedbackComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private cdr = inject(ChangeDetectorRef);

  posts: any[] = [];
  filteredPosts: any[] = [];
  isLoading: boolean = false;
  showCreateModal: boolean = false;
  showDetailModal: boolean = false;
  selectedPost: any = null;
  replies: any[] = [];
  searchTerm: string = '';
  filterCategory: string = '';
  filterStatus: string = '';
  currentUser: any = null;
  isSuperAdmin: boolean = false;
  isAdmin: boolean = false;
  showFilters: boolean = false;

  newPost: { category: string; title: string; message: string } = {
    category: 'suggestion',
    title: '',
    message: ''
  };
  newReply: string = '';

  categories = [
    { value: 'suggestion', label: 'ข้อเสนอแนะ', icon: 'fa-lightbulb', color: 'text-amber-500' },
    { value: 'question', label: 'คำถาม', icon: 'fa-question-circle', color: 'text-blue-500' },
    { value: 'bug', label: 'แจ้งปัญหา', icon: 'fa-bug', color: 'text-red-500' },
    { value: 'other', label: 'อื่นๆ', icon: 'fa-comment', color: 'text-gray-500' }
  ];

  statusOptions = [
    { value: 'open', label: 'เปิด', bg: 'bg-blue-100 text-blue-700' },
    { value: 'in_progress', label: 'กำลังดำเนินการ', bg: 'bg-amber-100 text-amber-700' },
    { value: 'resolved', label: 'แก้ไขแล้ว', bg: 'bg-green-100 text-green-700' },
    { value: 'closed', label: 'ปิด', bg: 'bg-gray-100 text-gray-600' }
  ];

  ngOnInit(): void {
    this.currentUser = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isSuperAdmin = role === 'super_admin';
    this.isAdmin = ['admin_ssj', 'super_admin'].includes(role);
    this.markRead();
    this.loadPosts();
  }

  ngOnDestroy(): void {
    this.markRead();
  }

  private markRead(): void {
    this.authService.markFeedbackRead().subscribe();
  }

  loadPosts(): void {
    this.isLoading = true;
    this.authService.getFeedbackPosts().subscribe({
      next: (res: any) => {
        this.posts = (res.data || res || []).map((p: any) => ({
          ...p,
          author_name: p.firstname ? `${p.firstname} ${p.lastname}` : p.username || 'ไม่ระบุ',
          author_username: p.username || '',
          author_role: p.user_role || ''
        }));
        this.applyFilters();
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.posts = [];
        this.filteredPosts = [];
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  applyFilters(): void {
    let result = [...this.posts];

    if (this.searchTerm.trim()) {
      const term = this.searchTerm.trim().toLowerCase();
      result = result.filter(p =>
        (p.title || '').toLowerCase().includes(term) ||
        (p.message || '').toLowerCase().includes(term) ||
        (p.author_name || '').toLowerCase().includes(term)
      );
    }

    if (this.filterCategory) {
      result = result.filter(p => p.category === this.filterCategory);
    }

    if (this.filterStatus) {
      result = result.filter(p => p.status === this.filterStatus);
    }

    this.filteredPosts = result;
  }

  openCreate(): void {
    this.newPost = { category: 'suggestion', title: '', message: '' };
    this.showCreateModal = true;
  }

  createPost(): void {
    if (!this.newPost.title.trim() || !this.newPost.message.trim()) {
      Swal.fire('กรุณากรอกข้อมูล', 'กรุณากรอกหัวข้อและรายละเอียด', 'warning');
      return;
    }

    this.authService.createFeedbackPost(this.newPost).subscribe({
      next: () => {
        Swal.fire('สำเร็จ', 'สร้างกระทู้เรียบร้อยแล้ว', 'success');
        this.showCreateModal = false;
        this.loadPosts();
      },
      error: () => {
        Swal.fire('ผิดพลาด', 'ไม่สามารถสร้างกระทู้ได้', 'error');
      }
    });
  }

  openDetail(post: any): void {
    this.selectedPost = post;
    this.showDetailModal = true;
    this.loadReplies(post.id);
  }

  loadReplies(postId: number): void {
    this.authService.getFeedbackReplies(postId).subscribe({
      next: (res: any) => {
        const adminRoles = ['super_admin', 'admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso'];
        this.replies = (res.data || res || []).map((r: any) => ({
          ...r,
          author_name: r.firstname ? `${r.firstname} ${r.lastname}` : r.username || 'ไม่ระบุ',
          author_username: r.username || '',
          is_admin: adminRoles.includes(r.user_role)
        }));
        this.cdr.detectChanges();
      },
      error: () => {
        this.replies = [];
        this.cdr.detectChanges();
      }
    });
  }

  submitReply(): void {
    if (!this.newReply.trim()) {
      Swal.fire('กรุณากรอกข้อมูล', 'กรุณากรอกข้อความตอบกลับ', 'warning');
      return;
    }

    this.authService.createFeedbackReply(this.selectedPost.id, this.newReply).subscribe({
      next: () => {
        this.newReply = '';
        this.loadReplies(this.selectedPost.id);
      },
      error: () => {
        Swal.fire('ผิดพลาด', 'ไม่สามารถตอบกลับได้', 'error');
      }
    });
  }

  updateStatus(postId: number, status: string): void {
    this.authService.updateFeedbackStatus(postId, status).subscribe({
      next: () => {
        Swal.fire('สำเร็จ', 'อัปเดตสถานะเรียบร้อย', 'success');
        this.loadPosts();
        if (this.selectedPost && this.selectedPost.id === postId) {
          this.selectedPost.status = status;
        }
      },
      error: () => {
        Swal.fire('ผิดพลาด', 'ไม่สามารถอัปเดตสถานะได้', 'error');
      }
    });
  }

  deletePost(postId: number): void {
    Swal.fire({
      title: 'ยืนยันการลบ',
      text: 'คุณต้องการลบกระทู้นี้หรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      cancelButtonColor: '#6b7280',
      confirmButtonText: 'ลบ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.deleteFeedbackPost(postId).subscribe({
          next: () => {
            Swal.fire('ลบแล้ว', 'ลบกระทู้เรียบร้อย', 'success');
            this.loadPosts();
          },
          error: () => {
            Swal.fire('ผิดพลาด', 'ไม่สามารถลบกระทู้ได้', 'error');
          }
        });
      }
    });
  }

  getCategoryInfo(cat: string): any {
    return this.categories.find(c => c.value === cat) || this.categories[3];
  }

  getStatusInfo(status: string): any {
    return this.statusOptions.find(s => s.value === status) || this.statusOptions[0];
  }

  formatDate(d: string): string {
    return new Date(d).toLocaleString('th-TH');
  }

  // สีเฉพาะตัวต่อ username — super_admin = เขียวเข้ม (สงวนไว้), อื่นๆ = สีจาก palette
  private _usernameColorMap = new Map<string, { bg: string; text: string; avatar: string; avatarText: string; border: string }>();
  private _superAdminColor = { bg: 'bg-green-100', text: 'text-green-800', avatar: 'bg-green-600', avatarText: 'text-white', border: 'border-green-300' };
  private _palette = [
    { bg: 'bg-blue-50', text: 'text-blue-700', avatar: 'bg-blue-500', avatarText: 'text-white', border: 'border-blue-200' },
    { bg: 'bg-purple-50', text: 'text-purple-700', avatar: 'bg-purple-500', avatarText: 'text-white', border: 'border-purple-200' },
    { bg: 'bg-pink-50', text: 'text-pink-700', avatar: 'bg-pink-500', avatarText: 'text-white', border: 'border-pink-200' },
    { bg: 'bg-amber-50', text: 'text-amber-700', avatar: 'bg-amber-500', avatarText: 'text-white', border: 'border-amber-200' },
    { bg: 'bg-cyan-50', text: 'text-cyan-700', avatar: 'bg-cyan-500', avatarText: 'text-white', border: 'border-cyan-200' },
    { bg: 'bg-rose-50', text: 'text-rose-700', avatar: 'bg-rose-500', avatarText: 'text-white', border: 'border-rose-200' },
    { bg: 'bg-indigo-50', text: 'text-indigo-700', avatar: 'bg-indigo-500', avatarText: 'text-white', border: 'border-indigo-200' },
    { bg: 'bg-lime-50', text: 'text-lime-700', avatar: 'bg-lime-600', avatarText: 'text-white', border: 'border-lime-200' },
    { bg: 'bg-orange-50', text: 'text-orange-700', avatar: 'bg-orange-500', avatarText: 'text-white', border: 'border-orange-200' },
    { bg: 'bg-sky-50', text: 'text-sky-700', avatar: 'bg-sky-500', avatarText: 'text-white', border: 'border-sky-200' },
  ];
  private _paletteIndex = 0;

  getReplyColor(reply: any) {
    const username = reply.author_username || reply.username || '';
    // super_admin → สีเขียวเข้มเสมอ
    if (reply.is_admin && reply.user_role === 'super_admin') {
      return this._superAdminColor;
    }
    // ตรวจจาก username
    if (!this._usernameColorMap.has(username)) {
      this._usernameColorMap.set(username, this._palette[this._paletteIndex % this._palette.length]);
      this._paletteIndex++;
    }
    return this._usernameColorMap.get(username)!;
  }

  getPostColor(post: any) {
    const username = post.author_username || post.username || '';
    if (post.author_role === 'super_admin') return this._superAdminColor;
    if (!this._usernameColorMap.has(username)) {
      this._usernameColorMap.set(username, this._palette[this._paletteIndex % this._palette.length]);
      this._paletteIndex++;
    }
    return this._usernameColorMap.get(username)!;
  }
}
