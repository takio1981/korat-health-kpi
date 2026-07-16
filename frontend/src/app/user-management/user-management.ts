import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../services/auth';
import { ToastService } from '../services/toast.service';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-management.html'
})
export class UserManagementComponent implements OnInit {
  private authService = inject(AuthService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private cdr = inject(ChangeDetectorRef);

  users: any[] = [];
  filteredUsers: any[] = [];

  showFilters: boolean = true;
  searchTerm: string = '';
  selectedRole: string = '';
  selectedDept: string = '';
  selectedHospcode: string = '';

  currentPage: number = 1;
  pageSize: number = 10;
  totalPages: number = 0;

  departments: any[] = [];
  hospitals: any[] = [];
  districts: any[] = [];
  filteredHospitals: any[] = [];
  selectedDistrictId: string = '';

  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  loggedInUser: any = null;

  showModal: boolean = false;
  isEditMode: boolean = false;
  currentUser: any = { id: null, username: '', password: '', role: 'user', dept_id: '', firstname: '', lastname: '', hospcode: '', phone: '', email: '', cid: '' };
  editNewCid: string = '';  // เลขบัตรฯ ใหม่ในโหมด edit (raw 13 หลัก; ว่าง = ไม่เปลี่ยน)

  // === จัดการสิทธิ์ราย user ===
  showPermModal: boolean = false;
  permUser: any = null;
  permForm: any = { can_edit_actual: true, can_edit_target: true };
  permSaving: boolean = false;

  // === จัดการ LINE userId (super_admin) ===
  showLineModal: boolean = false;
  lineUser: any = null;
  lineForm: { line_user_id: string; notif_line_enabled: boolean } = { line_user_id: '', notif_line_enabled: true };
  lineInbox: any[] = [];
  lineInboxLoading: boolean = false;

  selectedStatus: string = '';
  pendingCount: number = 0;
  maintenanceMode: boolean = false;
  maintenanceMessage: string = 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน';

  // Password & validation
  confirmPassword: string = '';
  showPassword: boolean = false;
  showConfirmPassword: boolean = false;

  // === Tab: รายชื่อ / สถิติ ===
  activeTab: 'list' | 'stats' = 'stats';
  statsLoading: boolean = false;
  stats: {
    summary: { total: number; active: number; pending: number; rejected: number; disabled: number; approved: number };
    byRole: { role: string; count: number }[];
    byDistrict: { distid: string; distname: string; count: number }[];
    byHospital: { hospcode: string; hosname: string; hostype: string; distname: string; count: number }[];
    byDept: { dept_id: number; dept_name: string; count: number }[];
  } | null = null;

  // === Drill-down filter จาก stats tab ===
  drillLabel: string = '';
  selectedDistrictFilter: string = '';
  activeDrillType: string = '';
  activeDrillValue: string = '';

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj', 'super_admin'].includes(role);
    this.isSuperAdmin = role === 'super_admin';
    this.loggedInUser = this.authService.getUser();

    // อ่าน query param ?status=pending จาก URL (เช่น navigate มาจากหน้าแจ้งเตือน)
    this.route.queryParams.subscribe(params => {
      if (params['status']) {
        this.selectedStatus = params['status'];
      }
    });

    this.loadUsers();
    this.loadDepartments();
    this.loadHospitals();
    this.loadDistricts();
    this.loadStats();
    if (this.isSuperAdmin) this.loadMaintenanceStatus();
  }

  switchTab(tab: 'list' | 'stats') {
    this.activeTab = tab;
    if (tab === 'stats' && !this.stats) this.loadStats();
  }

  drillDown(type: string, value: string, label: string) {
    console.log('[DrillDown]', type, value, '— users loaded:', this.users.length);
    this.searchTerm = '';
    this.selectedRole = '';
    this.selectedDept = '';
    this.selectedHospcode = '';
    this.selectedStatus = '';
    this.selectedDistrictFilter = '';
    switch (type) {
      case 'role':     this.selectedRole = value; break;
      case 'dept':     this.selectedDept = value; break;
      case 'hospcode': this.selectedHospcode = value; break;
      case 'district': this.selectedDistrictFilter = value; break;
      case 'status':   this.selectedStatus = value; break;
    }
    this.drillLabel = label;
    this.activeDrillType = type;
    this.activeDrillValue = value;
    this.applyFilters();
    console.log('[DrillDown] drillUsers:', this.drillUsers.length, 'drillPct:', this.drillPct);
    this.cdr.detectChanges();
  }

  clearDrillFilter() {
    this.drillLabel = '';
    this.activeDrillType = '';
    this.activeDrillValue = '';
    this.searchTerm = '';
    this.selectedRole = '';
    this.selectedDept = '';
    this.selectedHospcode = '';
    this.selectedStatus = '';
    this.selectedDistrictFilter = '';
    this.applyFilters();
    this.cdr.detectChanges();
  }

  // getter — computed ทุก render cycle ไม่มี timing issue
  get drillUsers(): any[] {
    if (!this.activeDrillType || !this.activeDrillValue) return [];
    return this.users.filter(user => {
      switch (this.activeDrillType) {
        case 'role':     return user.role === this.activeDrillValue;
        case 'dept':     return String(user.dept_id ?? '') === this.activeDrillValue;
        case 'hospcode': return user.hospcode === this.activeDrillValue;
        case 'district': {
          const h = this.hospitals.find((h: any) => h.hoscode === user.hospcode);
          return h?.distid === this.activeDrillValue;
        }
        case 'status': return this.matchStatusFilter(user, this.activeDrillValue);
        default: return false;
      }
    }).sort((a, b) => ((a.firstname || '') + (a.lastname || '')).localeCompare((b.firstname || '') + (b.lastname || ''), 'th'));
  }

  get drillPct(): number {
    const total = this.stats?.summary?.total ?? 0;
    return total > 0 ? Math.round((this.drillUsers.length / total) * 100) : 0;
  }

  matchStatusFilter(user: any, status: string): boolean {
    switch (status) {
      case 'pending':  return Number(user.is_approved) === 0;
      case 'approved': return Number(user.is_approved) === 1;
      case 'rejected': return Number(user.is_approved) === -1;
      case 'active':   return Number(user.is_active) === 1 && Number(user.is_approved) === 1;
      case 'disabled': return Number(user.is_active) === 0;
      default: return true;
    }
  }

  isActiveDrill(type: string, value: string): boolean {
    return this.activeDrillType === type && this.activeDrillValue === value;
  }

  trackByUserId(index: number, u: any): any {
    return u.id ?? index;
  }

  getDrillColor(): string {
    const colorMap: Record<string, string> = {
      role: '#6366f1', dept: '#0d9488', district: '#a855f7', hospcode: '#f97316',
    };
    const statusColorMap: Record<string, string> = {
      active: '#10b981', pending: '#f59e0b', approved: '#0ea5e9',
      rejected: '#ef4444', disabled: '#9ca3af'
    };
    return colorMap[this.activeDrillType] || statusColorMap[this.activeDrillValue] || '#6b7280';
  }

  getDrillCategoryLabel(): string {
    const map: Record<string, string> = {
      role: 'สิทธิ์การใช้งาน', dept: 'กลุ่มงาน / หน่วยงาน',
      district: 'อำเภอ', hospcode: 'หน่วยบริการ', status: 'สถานะบัญชี'
    };
    return map[this.activeDrillType] || '';
  }

  getUserStatusBadge(user: any): { text: string; cls: string } {
    if (Number(user.is_active) === 0) return { text: 'ปิดใช้งาน', cls: 'bg-gray-100 text-gray-500' };
    if (Number(user.is_approved) === 0) return { text: 'รออนุมัติ', cls: 'bg-amber-100 text-amber-700' };
    if (Number(user.is_approved) === -1) return { text: 'ปฏิเสธ', cls: 'bg-red-100 text-red-700' };
    return { text: 'ใช้งานได้', cls: 'bg-emerald-100 text-emerald-700' };
  }

  getDrillActiveCount(): number {
    return this.drillUsers.filter(u => Number(u.is_active) === 1 && Number(u.is_approved) === 1).length;
  }

  getDrillPendingCount(): number {
    return this.drillUsers.filter(u => Number(u.is_approved) === 0).length;
  }

  getDonutStyle(): { [key: string]: string } {
    const c = this.getDrillColor();
    const p = this.drillPct;
    return { background: `conic-gradient(${c} 0% ${p}%, #f1f5f9 ${p}% 100%)` };
  }

  getDrillColorRgba(alpha: number): string {
    const hex = this.getDrillColor().replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  goManageUser(user: any) {
    this.selectedRole = '';
    this.selectedDept = '';
    this.selectedHospcode = '';
    this.selectedStatus = '';
    this.selectedDistrictFilter = '';
    this.drillLabel = '';
    this.activeDrillType = '';
    this.activeDrillValue = '';
    this.searchTerm = user.username;
    this.applyFilters();
    this.activeTab = 'list';
    this.cdr.detectChanges();
  }

  loadStats() {
    this.statsLoading = true;
    this.authService.getUserStats().subscribe({
      next: (res) => {
        if (res.success) { this.stats = res; }
        this.statsLoading = false;
        this.cdr.detectChanges();
      },
      error: () => { this.statsLoading = false; this.cdr.detectChanges(); }
    });
  }

  getRoleLabel(role: string): string {
    const map: Record<string, string> = {
      super_admin: 'Super Admin', admin_ssj: 'Admin SSJ', admin_cup: 'Admin CUP',
      admin_hos: 'Admin รพ.', admin_sso: 'Admin รพ.สต.',
      user_cup: 'User CUP', user_hos: 'User รพ.', user_sso: 'User รพ.สต.', user_ssj: 'User SSJ'
    };
    return map[role] || role;
  }

  getRoleBadgeClass(role: string): string {
    if (role.startsWith('super')) return 'bg-purple-100 text-purple-700';
    if (role.startsWith('admin')) return 'bg-blue-100 text-blue-700';
    return 'bg-green-100 text-green-700';
  }

  getHostypeLabel(hostype: string): string {
    const map: Record<string, string> = {
      '05': 'รพ.ศูนย์', '06': 'รพ.ทั่วไป', '07': 'รพช.', '08': 'รพ.ทหาร',
      '11': 'รพ.เอกชน', '17': 'สสอ.', '18': 'รพ.สต.', '73': 'ศสม.'
    };
    return map[hostype] || hostype;
  }

  getBarWidth(count: number, max: number): string {
    return max > 0 ? Math.round((count / max) * 100) + '%' : '0%';
  }

  loadUsers() {
    this.authService.getUsers().subscribe({
      next: (res) => {
        if (res.success) {
          this.users = res.data;
          this.pendingCount = this.users.filter(u => u.is_approved === 0).length;
          // sync badge เมนู sidebar ให้ตรงกับสถานะล่าสุด (หลัง approve/reject/delete)
          this.authService.setPendingUsers(this.pendingCount);
          this.applyFilters();
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadDepartments() {
    this.authService.getDepartments().subscribe({
      next: (res) => {
        if (res.success) { this.departments = res.data; this.cdr.detectChanges(); }
      }
    });
  }

  loadHospitals() {
    this.authService.getHospitals().subscribe({
      next: (res) => {
        if (res.success) { this.hospitals = res.data; this.cdr.detectChanges(); }
      }
    });
  }

  loadDistricts() {
    this.authService.getDistricts().subscribe({
      next: (res) => {
        if (res.success) { this.districts = res.data; this.cdr.detectChanges(); }
      }
    });
  }

  onDistrictChange() {
    this.filteredHospitals = this.hospitals.filter(h => h.distid === this.selectedDistrictId);
    this.currentUser.hospcode = '';
    this.cdr.detectChanges();
  }

  applyFilters() {
    this.filteredUsers = this.users.filter(user => {
      const search = this.searchTerm.toLowerCase();
      const fullname = ((user.firstname || '') + ' ' + (user.lastname || '')).toLowerCase();
      const matchSearch = !search ||
                          (user.username && user.username.toLowerCase().includes(search)) ||
                          fullname.includes(search) ||
                          (user.role && user.role.toLowerCase().includes(search)) ||
                          (user.dept_name && user.dept_name.toLowerCase().includes(search)) ||
                          (user.hosname && user.hosname.toLowerCase().includes(search)) ||
                          (user.hospcode && user.hospcode.includes(search)) ||
                          (user.phone && user.phone.includes(search)) ||
                          (user.email && user.email.toLowerCase().includes(search));

      const matchRole = this.selectedRole === '' || user.role === this.selectedRole;
      const matchDept = this.selectedDept === '' || (user.dept_id && user.dept_id.toString() === this.selectedDept);
      const matchHosp = this.selectedHospcode === '' || user.hospcode === this.selectedHospcode;
      const matchStatus = this.selectedStatus === '' ||
                          (this.selectedStatus === 'pending' && user.is_approved === 0) ||
                          (this.selectedStatus === 'approved' && user.is_approved === 1) ||
                          (this.selectedStatus === 'rejected' && user.is_approved === -1) ||
                          (this.selectedStatus === 'active' && user.is_active === 1) ||
                          (this.selectedStatus === 'disabled' && user.is_active === 0);
      const matchDistrict = this.selectedDistrictFilter === '' || (() => {
        const h = this.hospitals.find((h: any) => h.hoscode === user.hospcode);
        return h?.distid === this.selectedDistrictFilter;
      })();

      return matchSearch && matchRole && matchDept && matchHosp && matchStatus && matchDistrict;
    });

    this.totalPages = Math.ceil(this.filteredUsers.length / this.pageSize);
    this.currentPage = 1;
  }

  get pagedUsers() {
    return this.filteredUsers;
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  openModal(user: any = null) {
    this.showModal = true;
    this.confirmPassword = '';
    this.showPassword = false;
    this.showConfirmPassword = false;
    if (user) {
      this.isEditMode = true;
      this.currentUser = { ...user, password: '' };
      this.editNewCid = '';  // reset ทุกครั้งที่เปิด edit modal

      const currentHospital = this.hospitals.find(h => h.hoscode === user.hospcode);
      if (currentHospital) {
        this.selectedDistrictId = currentHospital.distid;
        this.filteredHospitals = this.hospitals.filter(h => h.distid === this.selectedDistrictId);
      } else {
        this.selectedDistrictId = '';
        this.filteredHospitals = this.hospitals;
      }
    } else {
      this.isEditMode = false;
      this.currentUser = {
        id: null, username: '', password: '', role: 'user',
        dept_id: this.isAdmin ? '' : (this.loggedInUser?.dept_id || ''),
        firstname: '', lastname: '', hospcode: '', phone: '', email: '', cid: ''
      };
      this.selectedDistrictId = '';
      this.filteredHospitals = [];
    }
  }

  closeModal() {
    this.showModal = false;
  }

  // === National ID formatting & validation ===
  onNationalIdInput(event: any) {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 13) value = value.substring(0, 13);
    this.currentUser.cid = value;
    event.target.value = this.formatNationalIdDisplay(value);
  }

  onEditCidInput(event: any) {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 13) value = value.substring(0, 13);
    this.editNewCid = value;
    event.target.value = this.formatNationalIdDisplay(value);
  }

  formatNationalIdDisplay(id: string): string {
    if (!id) return '';
    const d = id.replace(/\D/g, '');
    if (d.length <= 1) return d;
    if (d.length <= 5) return d.substring(0, 1) + '-' + d.substring(1);
    if (d.length <= 10) return d.substring(0, 1) + '-' + d.substring(1, 5) + '-' + d.substring(5);
    if (d.length <= 12) return d.substring(0, 1) + '-' + d.substring(1, 5) + '-' + d.substring(5, 10) + '-' + d.substring(10);
    return d.substring(0, 1) + '-' + d.substring(1, 5) + '-' + d.substring(5, 10) + '-' + d.substring(10, 12) + '-' + d.substring(12);
  }

  validateNationalId(id: string): boolean {
    if (!/^\d{13}$/.test(id)) return false;
    const digits = id.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < 12; i++) { sum += digits[i] * (13 - i); }
    return (11 - (sum % 11)) % 10 === digits[12];
  }

  // === Username validation ===
  validateUsername(name: string): string | null {
    if (!name) return null;
    if (name.length < 6) return 'ชื่อผู้ใช้งานต้องมีอย่างน้อย 6 ตัวอักษร';
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(name)) {
      return 'ชื่อผู้ใช้งานต้องเป็น a-z, A-Z, 0-9 หรืออักขระพิเศษเท่านั้น';
    }
    return null;
  }

  // === Password strength ===
  getPasswordStrength(pw: string): { level: number; text: string; color: string } {
    if (!pw) return { level: 0, text: '', color: '' };
    let score = 0;
    if (pw.length >= 6) score++;
    if (/[a-z]/.test(pw)) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) score++;
    if (pw.length >= 10) score++;
    if (score <= 2) return { level: score, text: 'อ่อน', color: 'bg-red-500' };
    if (score <= 4) return { level: score, text: 'ปานกลาง', color: 'bg-yellow-500' };
    return { level: score, text: 'แข็งแรง', color: 'bg-green-500' };
  }

  // === Phone formatting ===
  onPhoneInput(event: any) {
    let value = event.target.value.replace(/\D/g, '');
    if (value.length > 10) value = value.substring(0, 10);
    this.currentUser.phone = value;
    event.target.value = this.formatPhoneDisplay(value);
  }

  formatPhoneDisplay(phone: string): string {
    if (!phone) return '';
    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 2) return digits;
    if (digits.length <= 6) return digits.substring(0, 2) + '-' + digits.substring(2);
    return digits.substring(0, 2) + '-' + digits.substring(2, 6) + '-' + digits.substring(6, 10);
  }

  // === Password validation (เหมือน register) ===
  validatePassword(pw: string): string | null {
    if (!pw) return null;
    if (pw.length < 6) return 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร';
    if (!/[a-z]/.test(pw)) return 'รหัสผ่านต้องมีตัวอักษรพิมพ์เล็ก (a-z) อย่างน้อย 1 ตัว';
    if (!/[A-Z]/.test(pw)) return 'รหัสผ่านต้องมีตัวอักษรพิมพ์ใหญ่ (A-Z) อย่างน้อย 1 ตัว';
    if (!/[0-9]/.test(pw)) return 'รหัสผ่านต้องมีตัวเลข (0-9) อย่างน้อย 1 ตัว';
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) return 'รหัสผ่านต้องมีอักขระพิเศษอย่างน้อย 1 ตัว';
    if (!/^[a-zA-Z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]+$/.test(pw)) {
      return 'รหัสผ่านมีอักขระที่ไม่อนุญาต';
    }
    return null;
  }

  // === Phone validation ===
  validatePhone(phone: string): boolean {
    if (!phone) return false;
    const digits = phone.replace(/\D/g, '');
    return digits.length === 10;
  }

  saveUser() {
    // ตรวจสอบข้อมูลครบถ้วน
    if (!this.currentUser.username ||
        !this.currentUser.firstname ||
        !this.currentUser.lastname ||
        !this.currentUser.phone ||
        !this.currentUser.hospcode ||
        (!this.isEditMode && !this.currentUser.cid) ||
        !this.currentUser.dept_id ||
        !this.currentUser.role) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง (รวมเลขบัตรประชาชน, หน่วยบริการ, หน่วยงาน)', 'warning');
      return;
    }

    // ตรวจสอบ username (เหมือน register)
    const usernameError = this.validateUsername(this.currentUser.username);
    if (usernameError) {
      Swal.fire('แจ้งเตือน', usernameError, 'warning');
      return;
    }

    // ตรวจสอบเลขบัตรประชาชน (เฉพาะเพิ่มใหม่)
    if (!this.isEditMode && !this.validateNationalId(this.currentUser.cid)) {
      Swal.fire('แจ้งเตือน', 'เลขบัตรประชาชนไม่ถูกต้อง (ตรวจสอบ 13 หลักและ Check Digit แล้ว)', 'warning');
      return;
    }
    // ตรวจสอบเลขบัตรฯ ใหม่ในโหมด edit (ถ้ากรอก)
    if (this.isEditMode && this.editNewCid && !this.validateNationalId(this.editNewCid)) {
      Swal.fire('แจ้งเตือน', 'เลขบัตรประชาชนใหม่ไม่ถูกต้อง (Check Digit ไม่ผ่าน)', 'warning');
      return;
    }

    // ตรวจสอบ email (ถ้ากรอก)
    if (this.currentUser.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.currentUser.email)) {
      Swal.fire('แจ้งเตือน', 'รูปแบบอีเมลไม่ถูกต้อง', 'warning');
      return;
    }

    // ตรวจสอบเบอร์โทร 10 หลัก
    if (!this.validatePhone(this.currentUser.phone)) {
      Swal.fire('แจ้งเตือน', 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก', 'warning');
      return;
    }

    // ตรวจสอบ password สำหรับสร้างใหม่
    if (!this.isEditMode) {
      if (!this.currentUser.password) {
        Swal.fire('แจ้งเตือน', 'กรุณากรอกรหัสผ่าน', 'warning');
        return;
      }
      const pwError = this.validatePassword(this.currentUser.password);
      if (pwError) {
        Swal.fire('แจ้งเตือน', pwError, 'warning');
        return;
      }
      if (this.currentUser.password !== this.confirmPassword) {
        Swal.fire('แจ้งเตือน', 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน', 'warning');
        return;
      }
    }

    // ตรวจสอบ password สำหรับแก้ไข (ถ้ากรอก)
    if (this.isEditMode && this.currentUser.password) {
      const pwError = this.validatePassword(this.currentUser.password);
      if (pwError) {
        Swal.fire('แจ้งเตือน', pwError, 'warning');
        return;
      }
      if (this.currentUser.password !== this.confirmPassword) {
        Swal.fire('แจ้งเตือน', 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน', 'warning');
        return;
      }
    }

    // Strip dashes from phone before saving
    const userData = { ...this.currentUser, phone: this.currentUser.phone.replace(/\D/g, '') };

    if (this.isEditMode) {
      // ลบ cid (hash เก่า) ออก — backend จะไม่อัปเดต cid ถ้าไม่ส่งมา
      // ถ้า admin กรอก editNewCid ใหม่ → ส่ง raw 13 หลักไปให้ backend hash ใหม่
      delete userData.cid;
      if (this.editNewCid && this.editNewCid.length === 13) {
        userData.cid = this.editNewCid;
      }
      this.authService.updateUser(userData.id, userData).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire('สำเร็จ', 'แก้ไขข้อมูลผู้ใช้งานเรียบร้อย', 'success').then(() => {
              this.loadUsers();
              this.closeModal();
            });
          }
        },
        error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถแก้ไขข้อมูลได้', 'error')
      });
    } else {
      this.authService.createUser(userData).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire('สำเร็จ', 'สร้างผู้ใช้งานใหม่เรียบร้อย', 'success').then(() => {
              this.loadUsers();
              this.closeModal();
            });
          }
        },
        error: (err) => Swal.fire('ผิดพลาด', err.error.message || 'ไม่สามารถสร้างผู้ใช้งานได้', 'error')
      });
    }
  }

  deleteUser(id: number) {
    Swal.fire({
      title: 'ยืนยันการลบ',
      text: "คุณต้องการลบผู้ใช้งานนี้ใช่หรือไม่?",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      confirmButtonText: 'ลบผู้ใช้งาน',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.deleteUser(id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('ลบสำเร็จ', 'ผู้ใช้งานถูกลบออกจากระบบแล้ว', 'success');
              this.loadUsers();
            }
          },
          error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถลบผู้ใช้งานได้', 'error')
        });
      }
    });
  }

  approveUser(user: any) {
    Swal.fire({
      title: 'อนุมัติการลงทะเบียน',
      html: `<p>ยืนยันอนุมัติผู้ใช้งาน <b>${user.firstname} ${user.lastname}</b> (${user.username})</p>
             <p class="text-sm text-gray-500 mt-1">สิทธิ์: ${user.role} | หน่วยบริการ: ${user.hosname || user.hospcode}</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#16a34a',
      confirmButtonText: 'อนุมัติ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.approveUser(user.id).subscribe({
          next: (res) => {
            if (res.success) {
              this.toast.success('อนุมัติแล้ว', `${user.firstname || user.username} เข้าใช้งานได้แล้ว`);
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถอนุมัติได้', 'error')
        });
      }
    });
  }

  rejectUser(user: any) {
    Swal.fire({
      title: 'ปฏิเสธการลงทะเบียน',
      html: `<p>ปฏิเสธผู้ใช้งาน <b>${user.firstname} ${user.lastname}</b> (${user.username})</p>
             <p class="text-sm text-gray-500 mt-1">${user.email ? 'จะส่ง Email แจ้งไปที่ ' + user.email : '<span class="text-amber-500">ไม่มี Email — ไม่สามารถแจ้งผลทาง Email ได้</span>'}</p>`,
      input: 'textarea',
      inputLabel: 'เหตุผลในการปฏิเสธ (จะส่งให้ผู้สมัครทาง Email)',
      inputPlaceholder: 'ระบุเหตุผล เช่น ข้อมูลไม่ครบถ้วน, ไม่มีสิทธิ์ใช้งาน...',
      inputAttributes: { 'aria-label': 'เหตุผลในการปฏิเสธ' },
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: '<i class="fas fa-times mr-1"></i> ปฏิเสธ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        const reason = result.value || '';
        this.authService.rejectUser(user.id, reason).subscribe({
          next: (res) => {
            if (res.success) {
              this.toast.success('ปฏิเสธแล้ว', user.email ? 'ส่ง Email แจ้งผลเรียบร้อย' : '');
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถปฏิเสธได้', 'error')
        });
      }
    });
  }

  approveAllPending() {
    const pendingUsers = this.users.filter(u => u.is_approved === 0);
    if (pendingUsers.length === 0) return;
    Swal.fire({
      title: 'อนุมัติทั้งหมด',
      html: `<p>ยืนยันอนุมัติผู้ใช้งานที่รออนุมัติทั้งหมด <b>${pendingUsers.length}</b> คน?</p>
             <div class="mt-2 max-h-40 overflow-y-auto text-left text-xs text-gray-600">
               ${pendingUsers.map(u => `<div class="py-0.5">• ${u.firstname} ${u.lastname} (${u.username})</div>`).join('')}
             </div>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#16a34a',
      confirmButtonText: `<i class="fas fa-check-double mr-1"></i> อนุมัติ ${pendingUsers.length} คน`,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        let done = 0, fail = 0;
        const total = pendingUsers.length;
        Swal.fire({ title: 'กำลังอนุมัติ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        pendingUsers.forEach(u => {
          this.authService.approveUser(u.id).subscribe({
            next: () => { done++; if (done + fail === total) this.onBatchComplete(done, fail); },
            error: () => { fail++; if (done + fail === total) this.onBatchComplete(done, fail); }
          });
        });
      }
    });
  }

  rejectAllPending() {
    const pendingUsers = this.users.filter(u => u.is_approved === 0);
    if (pendingUsers.length === 0) return;
    Swal.fire({
      title: 'ปฏิเสธทั้งหมด',
      html: `<p class="text-red-600">ยืนยันปฏิเสธผู้ใช้งานที่รออนุมัติทั้งหมด <b>${pendingUsers.length}</b> คน?</p>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      confirmButtonText: `<i class="fas fa-times-circle mr-1"></i> ปฏิเสธ ${pendingUsers.length} คน`,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        let done = 0, fail = 0;
        const total = pendingUsers.length;
        Swal.fire({ title: 'กำลังปฏิเสธ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        pendingUsers.forEach(u => {
          this.authService.rejectUser(u.id).subscribe({
            next: () => { done++; if (done + fail === total) this.onBatchComplete(done, fail, 'ปฏิเสธ'); },
            error: () => { fail++; if (done + fail === total) this.onBatchComplete(done, fail, 'ปฏิเสธ'); }
          });
        });
      }
    });
  }

  private onBatchComplete(done: number, fail: number, action: string = 'อนุมัติ') {
    this.loadUsers();
    if (fail === 0) {
      Swal.fire({ icon: 'success', title: `${action}ทั้งหมดสำเร็จ`, text: `${action}แล้ว ${done} คน`, timer: 2000, showConfirmButton: false });
    } else {
      Swal.fire({ icon: 'warning', title: `${action}เสร็จสิ้น`, text: `สำเร็จ ${done} คน, ล้มเหลว ${fail} คน` });
    }
  }

  allowReRegister(user: any) {
    Swal.fire({
      title: 'เปิดให้สมัครใหม่',
      html: `<p>ลบ account ที่ถูกปฏิเสธของ <b>${user.firstname} ${user.lastname}</b> (${user.username})</p>
             <p class="text-sm text-gray-500 mt-2">ผู้ใช้จะสามารถลงทะเบียนด้วยเลขบัตรประชาชนเดิมได้อีกครั้ง</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#3b82f6',
      confirmButtonText: '<i class="fas fa-user-plus mr-1"></i> ยืนยัน ลบและเปิดให้สมัครใหม่',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.deleteUser(user.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'เปิดให้สมัครใหม่แล้ว', text: 'ผู้ใช้สามารถลงทะเบียนใหม่ได้', timer: 2000, showConfirmButton: false });
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
        });
      }
    });
  }

  toggleActive(user: any) {
    const willActivate = user.is_active === 0;
    const actionText = willActivate ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
    Swal.fire({
      title: `${actionText}บัญชีผู้ใช้`,
      html: `<p>ยืนยัน<b>${actionText}</b>บัญชี <b>${user.firstname} ${user.lastname}</b> (${user.username})?</p>
             ${!willActivate ? '<p class="text-sm text-orange-500 mt-1">ผู้ใช้งานนี้จะไม่สามารถเข้าสู่ระบบได้</p>' : ''}`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: willActivate ? '#16a34a' : '#d97706',
      confirmButtonText: actionText,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.toggleUserActive(user.id, willActivate).subscribe({
          next: (res) => {
            if (res.success) {
              user.is_active = willActivate ? 1 : 0;
              Swal.fire({ icon: 'success', title: res.message, timer: 1500, showConfirmButton: false });
              this.cdr.detectChanges();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเปลี่ยนสถานะได้', 'error')
        });
      }
    });
  }

  loadMaintenanceStatus() {
    this.authService.getMaintenanceStatus().subscribe({
      next: (res: any) => {
        this.maintenanceMode = res.maintenance;
        this.maintenanceMessage = res.message || 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน';
        this.cdr.detectChanges();
      }
    });
  }

  toggleMaintenanceMode() {
    const willEnable = !this.maintenanceMode;
    if (willEnable) {
      Swal.fire({
        title: 'เปิดโหมดปิดปรับปรุงระบบ',
        html: '<p class="text-sm text-gray-600 mb-2">ผู้ใช้งานทั้งหมด (ยกเว้น super_admin) จะเห็นหน้าแจ้งเตือนและไม่สามารถใช้งานได้</p>',
        input: 'textarea',
        inputLabel: 'ข้อความแจ้งเตือน',
        inputValue: this.maintenanceMessage,
        inputPlaceholder: 'ระบบปิดให้บริการชั่วคราวเพื่อประมวลผลงาน',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#dc2626',
        confirmButtonText: '<i class="fas fa-lock mr-1"></i> เปิดโหมดปิดปรับปรุง',
        cancelButtonText: 'ยกเลิก'
      }).then((result) => {
        if (result.isConfirmed) {
          const msg = result.value || this.maintenanceMessage;
          this.authService.setMaintenanceMode(true, msg).subscribe({
            next: (res) => {
              if (res.success) {
                this.maintenanceMode = true;
                this.maintenanceMessage = msg;
                Swal.fire({ icon: 'success', title: res.message, timer: 2000, showConfirmButton: false });
                this.cdr.detectChanges();
              }
            },
            error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
          });
        }
      });
    } else {
      Swal.fire({
        title: 'ปิดโหมดปิดปรับปรุง',
        text: 'เปิดให้ผู้ใช้งานทุกคนกลับเข้าใช้ระบบได้ตามปกติ',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#16a34a',
        confirmButtonText: '<i class="fas fa-unlock mr-1"></i> เปิดระบบ',
        cancelButtonText: 'ยกเลิก'
      }).then((result) => {
        if (result.isConfirmed) {
          this.authService.setMaintenanceMode(false, this.maintenanceMessage).subscribe({
            next: (res) => {
              if (res.success) {
                this.maintenanceMode = false;
                Swal.fire({ icon: 'success', title: res.message, timer: 2000, showConfirmButton: false });
                this.cdr.detectChanges();
              }
            },
            error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
          });
        }
      });
    }
  }

  bulkToggleActive(activate: boolean) {
    const actionText = activate ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
    const nonSuperCount = this.users.filter(u => u.role !== 'super_admin').length;
    Swal.fire({
      title: `${actionText}ผู้ใช้งานทั้งหมด`,
      html: `<p>ยืนยัน<b>${actionText}</b>ผู้ใช้งานทั้งหมด <b>${nonSuperCount}</b> คน?</p>
             <p class="text-xs text-gray-500 mt-1">(ยกเว้น super_admin)</p>
             ${!activate ? '<p class="text-sm text-red-500 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>ผู้ใช้งานทุกคนจะไม่สามารถเข้าสู่ระบบได้</p>' : ''}`,
      icon: activate ? 'question' : 'warning',
      showCancelButton: true,
      confirmButtonColor: activate ? '#16a34a' : '#dc2626',
      confirmButtonText: `<i class="fas ${activate ? 'fa-toggle-on' : 'fa-toggle-off'} mr-1"></i> ${actionText}ทั้งหมด`,
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'กำลังดำเนินการ...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
        this.authService.bulkToggleActive(activate).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
              this.loadUsers();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
        });
      }
    });
  }

  // บังคับ logout user (super_admin) — เคลียร์ active_session_id ใน DB
  forceLogoutUser(user: any) {
    const sessionInfo = user.active_session_id
      ? `<div class="text-xs text-gray-500 mt-1">ใช้งานล่าสุด: ${user.last_seen_at ? new Date(user.last_seen_at).toLocaleString('th-TH') : '-'}</div>`
      : '<div class="text-xs text-gray-400 mt-1">ผู้ใช้นี้ไม่ได้ login อยู่</div>';
    Swal.fire({
      title: 'บังคับออกจากระบบ',
      html: `<p>ต้องการบังคับ logout <b>${user.username}</b> ใช่หรือไม่?</p>${sessionInfo}<p class="text-xs text-amber-600 mt-2"><i class="fas fa-info-circle mr-1"></i>ผู้ใช้จะถูก logout อัตโนมัติภายใน ~30 วินาที</p>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#6b7280',
      confirmButtonText: '<i class="fas fa-sign-out-alt mr-1"></i>บังคับ Logout',
      cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.forceLogoutUser(user.id).subscribe({
        next: (res: any) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'สำเร็จ', text: res.message, timer: 2000, showConfirmButton: false });
            this.loadUsers();
          }
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถบังคับ logout ได้', 'error')
      });
    });
  }

  resetPassword(user: any) {
    Swal.fire({
      title: 'รีเซ็ตรหัสผ่าน',
      text: `คุณต้องการรีเซ็ตรหัสผ่านของ ${user.username} เป็น "password123" ใช่หรือไม่?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#f59e0b',
      cancelButtonColor: '#d33',
      confirmButtonText: 'ใช่, รีเซ็ตเลย',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.resetPassword(user.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', res.message, 'success');
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถรีเซ็ตรหัสผ่านได้', 'error')
        });
      }
    });
  }

  // === Data Synchronization — Users ↔ HDC ===
  showSyncModal: boolean = false;
  syncLoading: boolean = false;
  syncExecuting: boolean = false;
  syncResult: any = null;
  syncListFiltered: any[] = [];
  syncFilter: string = '';
  syncSelected: Set<string> = new Set<string>();
  private _syncAllList: any[] = [];

  openUserSyncModal() {
    this.showSyncModal = true;
    this.syncLoading = true;
    this.syncResult = null;
    this.syncSelected.clear();
    this.authService.usersSyncCompare().subscribe({
      next: (res: any) => {
        this.syncLoading = false;
        if (res.success) {
          this.syncResult = res;
          // รวม list พร้อม status
          this._syncAllList = [
            ...(res.matched || []).map((u: any) => ({ ...u, _syncStatus: 'matched' })),
            ...(res.different || []).map((u: any) => ({ ...u, _syncStatus: 'different' })),
            ...(res.local_only || []).map((u: any) => ({ ...u, _syncStatus: 'local_only' })),
            ...(res.hdc_only || []).map((u: any) => ({ ...u, _syncStatus: 'hdc_only' }))
          ];
          // default เลือก different + local_only
          for (const u of this._syncAllList) {
            if (u._syncStatus === 'different' || u._syncStatus === 'local_only') this.syncSelected.add(u.username);
          }
          this.buildSyncList();
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.syncLoading = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถเปรียบเทียบได้', 'error');
      }
    });
  }

  closeSyncModal() {
    this.showSyncModal = false;
    this.syncResult = null;
    this.syncSelected.clear();
  }

  // === จัดการสิทธิ์ราย user ===
  openPermModal(user: any) {
    this.permUser = user;
    this.permForm = {
      // default = true ถ้า column ยังไม่มีค่า (1/null/undefined)
      can_edit_actual: user.can_edit_actual === undefined || user.can_edit_actual === null ? true : (user.can_edit_actual == 1),
      can_edit_target: user.can_edit_target === undefined || user.can_edit_target === null ? true : (user.can_edit_target == 1)
    };
    this.showPermModal = true;
  }

  closePermModal() {
    this.showPermModal = false;
    this.permUser = null;
  }

  permPresetActualOnly() { this.permForm.can_edit_actual = true; this.permForm.can_edit_target = false; }
  permPresetBoth() { this.permForm.can_edit_actual = true; this.permForm.can_edit_target = true; }
  permPresetReadonly() { this.permForm.can_edit_actual = false; this.permForm.can_edit_target = false; }

  savePermissions() {
    if (!this.permUser) return;
    this.permSaving = true;
    this.authService.updateUserPermissions(this.permUser.id, this.permForm.can_edit_actual, this.permForm.can_edit_target).subscribe({
      next: (res) => {
        this.permSaving = false;
        if (res.success) {
          // อัปเดตค่าใน list ทันที
          this.permUser.can_edit_actual = this.permForm.can_edit_actual ? 1 : 0;
          this.permUser.can_edit_target = this.permForm.can_edit_target ? 1 : 0;
          this.toast.success('บันทึกสิทธิ์สำเร็จ', 'มีผลทันที (ผู้ใช้ refresh หน้าจะเห็นผล)');
          this.showPermModal = false;
        }
      },
      error: (err) => {
        this.permSaving = false;
        Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่สำเร็จ', 'error');
      }
    });
  }

  // ============================================================
  // จัดการ LINE userId ของแต่ละ user (super_admin)
  // ============================================================
  openLineModal(user: any) {
    this.lineUser = user;
    this.lineForm = {
      line_user_id: user.line_user_id || '',
      notif_line_enabled: Number(user.notif_line_enabled) !== 0
    };
    this.showLineModal = true;
    this.loadLineInbox();
  }

  closeLineModal() {
    this.showLineModal = false;
    this.lineUser = null;
    this.lineInbox = [];
  }

  loadLineInbox() {
    this.lineInboxLoading = true;
    this.authService.getLineInbox(false).subscribe({
      next: (res: any) => {
        this.lineInboxLoading = false;
        if (res.success) this.lineInbox = res.data || [];
        this.cdr.detectChanges();
      },
      error: () => { this.lineInboxLoading = false; }
    });
  }

  pickFromInbox(item: any) {
    this.lineForm.line_user_id = item.line_user_id;
  }

  saveUserLine() {
    if (!this.lineUser) return;
    const id = (this.lineForm.line_user_id || '').trim();
    if (id && !/^U[a-f0-9]{32}$/i.test(id)) {
      Swal.fire('แจ้งเตือน', 'LINE userId ต้องเป็นรูปแบบ U + 32 hex chars', 'warning');
      return;
    }
    this.authService.adminSetUserLine(this.lineUser.id, id, this.lineForm.notif_line_enabled).subscribe({
      next: (res: any) => {
        if (res.success) {
          this.lineUser.line_user_id = id || null;
          this.lineUser.notif_line_enabled = this.lineForm.notif_line_enabled ? 1 : 0;
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', timer: 1500, showConfirmButton: false });
          this.cdr.detectChanges();
        }
      },
      error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'บันทึกไม่ได้', 'error')
    });
  }

  testUserLine() {
    if (!this.lineUser) return;
    if (!this.lineForm.line_user_id) {
      Swal.fire('แจ้งเตือน', 'กรอก LINE userId แล้วกดบันทึกก่อนทดสอบ', 'warning');
      return;
    }
    Swal.fire({ title: 'กำลังส่ง...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.adminTestUserLine(this.lineUser.id).subscribe({
      next: (res: any) => {
        if (res.success) Swal.fire({ icon: 'success', title: 'สำเร็จ', text: `ส่ง LINE ทดสอบให้ ${this.lineUser.username} แล้ว`, timer: 2500, showConfirmButton: false });
        else Swal.fire('ผิดพลาด', res.message || 'ส่งไม่สำเร็จ', 'error');
      },
      error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ส่งไม่ได้', 'error')
    });
  }

  assignInboxToUser(inboxItem: any) {
    if (!this.lineUser) return;
    Swal.fire({
      title: 'ผูก LINE userId นี้กับ user',
      html: `<div class="text-left text-sm">
        <p>ผูก userId นี้:</p>
        <code class="block bg-emerald-50 border border-emerald-200 rounded p-1.5 my-1 text-xs">${inboxItem.line_user_id}</code>
        <p class="mt-2">ให้กับ user: <b>${this.lineUser.username}</b></p>
      </div>`,
      icon: 'question', showCancelButton: true, confirmButtonColor: '#10b981',
      confirmButtonText: 'ยืนยัน', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.authService.assignLineInbox(inboxItem.id, this.lineUser.id).subscribe({
        next: (res: any) => {
          if (res.success) {
            this.lineUser.line_user_id = inboxItem.line_user_id;
            this.lineForm.line_user_id = inboxItem.line_user_id;
            inboxItem.linked_user_id = this.lineUser.id;
            inboxItem.username = this.lineUser.username;
            Swal.fire({ icon: 'success', title: 'ผูกสำเร็จ', timer: 1500, showConfirmButton: false });
            this.cdr.detectChanges();
          }
        },
        error: (err: any) => Swal.fire('ผิดพลาด', err.error?.message || 'ผูกไม่ได้', 'error')
      });
    });
  }

  archiveInbox(item: any) {
    this.authService.archiveLineInbox(item.id, true).subscribe({
      next: (res: any) => {
        if (res.success) {
          this.lineInbox = this.lineInbox.filter(i => i.id !== item.id);
          this.cdr.detectChanges();
        }
      }
    });
  }

  toggleSyncFilter(filter: string) {
    this.syncFilter = this.syncFilter === filter ? '' : filter;
    this.buildSyncList();
  }

  buildSyncList() {
    this.syncListFiltered = this.syncFilter
      ? this._syncAllList.filter(u => u._syncStatus === this.syncFilter)
      : this._syncAllList;
    this.cdr.detectChanges();
  }

  toggleSyncUser(username: string) {
    if (this.syncSelected.has(username)) this.syncSelected.delete(username);
    else this.syncSelected.add(username);
  }

  isSyncAllSelected(): boolean {
    const syncable = this.syncListFiltered.filter(u => u._syncStatus !== 'hdc_only');
    return syncable.length > 0 && syncable.every(u => this.syncSelected.has(u.username));
  }

  toggleSyncAll() {
    const syncable = this.syncListFiltered.filter(u => u._syncStatus !== 'hdc_only');
    if (this.isSyncAllSelected()) syncable.forEach(u => this.syncSelected.delete(u.username));
    else syncable.forEach(u => this.syncSelected.add(u.username));
  }

  executeSyncUsers() {
    const usernames = [...this.syncSelected];
    if (usernames.length === 0) return;
    Swal.fire({
      title: 'ยืนยัน Sync → HDC',
      html: `<p>ส่งข้อมูล users <b>${usernames.length}</b> คนไปยัง HDC</p>
             <p class="text-xs text-red-500 mt-2"><i class="fas fa-exclamation-triangle mr-1"></i>ส่งทุกคอลัมน์รวม password_hash, cid</p>`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#2563eb',
      confirmButtonText: '<i class="fas fa-cloud-upload-alt mr-1"></i> Sync → HDC',
      cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (!r.isConfirmed) return;
      this.syncExecuting = true;
      Swal.fire({ title: 'กำลัง Sync...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
      this.authService.usersSyncToHDC(usernames).subscribe({
        next: (res: any) => {
          this.syncExecuting = false;
          const synced = res.synced || 0;
          const total = res.total || usernames.length;
          const failed = res.failed || 0;
          const partial = res.partial;
          const added = (res.added_columns || []).join(', ');
          const skipped = (res.skipped_columns || []).join(', ');
          const errSamples = (res.errors || []).slice(0, 3).map((e: any) =>
            `<li class="text-left"><b>Batch ${e.batch_start}</b> (${e.batch_size} rows) — ${e.error}</li>`
          ).join('');
          let html = `<div class="text-left">
            <p><b>ส่งสำเร็จ:</b> <span class="text-green-600">${synced}</span> / ${total} คน</p>
            ${failed > 0 ? `<p class="text-red-600"><b>ล้มเหลว:</b> ${failed} คน</p>` : ''}
            ${added ? `<p class="text-xs text-emerald-600 mt-2"><i class="fas fa-plus-circle mr-1"></i>เพิ่ม column ใหม่ใน HDC: <code class="bg-emerald-50 px-1 rounded">${added}</code></p>` : ''}
            ${skipped ? `<p class="text-xs text-amber-600 mt-1"><i class="fas fa-exclamation-triangle mr-1"></i>ข้าม column ที่ HDC ไม่มี: <code class="bg-amber-50 px-1 rounded">${skipped}</code></p>` : ''}
            ${errSamples ? `<div class="text-xs text-red-700 mt-2 bg-red-50 border border-red-200 rounded p-2"><b>รายละเอียดข้อผิดพลาด (สูงสุด 3):</b><ul class="ml-4 mt-1 list-disc">${errSamples}</ul></div>` : ''}
          </div>`;
          if (partial) {
            Swal.fire({ icon: 'warning', title: 'Sync บางส่วน', html, confirmButtonText: 'ตกลง' });
          } else {
            Swal.fire({ icon: 'success', title: 'Sync สำเร็จ', html, confirmButtonText: 'ตกลง' });
          }
          // refresh compare data
          this.syncSelected.clear();
          this.openUserSyncModal();
        },
        error: (err) => {
          this.syncExecuting = false;
          const body = err.error || {};
          const errSamples = (body.errors || []).slice(0, 3).map((e: any) =>
            `<li class="text-left"><b>Batch ${e.batch_start}</b> — ${e.error} ${e.code ? `<code class="bg-red-100 px-1 rounded text-[10px]">${e.code}</code>` : ''}</li>`
          ).join('');
          const html = `<div class="text-left">
            <p class="text-red-700 mb-2"><b>${body.message || err.message || 'ไม่สามารถ sync ได้'}</b></p>
            ${errSamples ? `<div class="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2"><b>รายละเอียด:</b><ul class="ml-4 mt-1 list-disc">${errSamples}</ul></div>` : ''}
          </div>`;
          Swal.fire({ icon: 'error', title: 'Sync ล้มเหลว', html, confirmButtonText: 'ตกลง' });
        }
      });
    });
  }
}
