import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-user-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './user-management.html'
})
export class UserManagementComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  users: any[] = [];
  filteredUsers: any[] = [];

  searchTerm: string = '';
  selectedRole: string = '';
  selectedDept: string = '';

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

  showModal: boolean = false;
  isEditMode: boolean = false;
  currentUser: any = { id: null, username: '', password: '', role: 'user', dept_id: '', firstname: '', lastname: '', hospcode: '', phone: '' };

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';

    if (!this.isAdmin) {
      Swal.fire('Access Denied', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadUsers();
    this.loadDepartments();
    this.loadHospitals();
    this.loadDistricts();
  }

  loadUsers() {
    this.authService.getUsers().subscribe({
      next: (res) => {
        if (res.success) {
          this.users = res.data;
          this.applyFilters();
          this.cdr.detectChanges();
        }
      }
    });
  }

  loadDepartments() {
    this.authService.getDepartments().subscribe({
      next: (res) => {
        if (res.success) this.departments = res.data;
      }
    });
  }

  loadHospitals() {
    this.authService.getHospitals().subscribe({
      next: (res) => {
        if (res.success) this.hospitals = res.data;
      }
    });
  }

  loadDistricts() {
    this.authService.getDistricts().subscribe({
      next: (res) => {
        if (res.success) this.districts = res.data;
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
      const matchSearch = (user.username && user.username.toLowerCase().includes(search)) ||
                          (user.dept_name && user.dept_name.toLowerCase().includes(search)) ||
                          (user.firstname && user.firstname.toLowerCase().includes(search)) ||
                          (user.lastname && user.lastname.toLowerCase().includes(search));

      const matchRole = this.selectedRole === '' || user.role === this.selectedRole;
      const matchDept = this.selectedDept === '' || (user.dept_id && user.dept_id.toString() === this.selectedDept);

      return matchSearch && matchRole && matchDept;
    });

    this.totalPages = Math.ceil(this.filteredUsers.length / this.pageSize);
    this.currentPage = 1;
  }

  get pagedUsers() {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredUsers.slice(startIndex, startIndex + this.pageSize);
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  openModal(user: any = null) {
    this.showModal = true;
    if (user) {
      this.isEditMode = true;
      this.currentUser = { ...user, password: '' };

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
      this.currentUser = { id: null, username: '', password: '', role: 'user', dept_id: '', firstname: '', lastname: '', hospcode: '', phone: '' };
      this.selectedDistrictId = '';
      this.filteredHospitals = [];
    }
  }

  closeModal() {
    this.showModal = false;
  }

  saveUser() {
    if (!this.currentUser.username ||
        (!this.isEditMode && !this.currentUser.password) ||
        !this.currentUser.firstname ||
        !this.currentUser.lastname ||
        !this.currentUser.phone ||
        !this.currentUser.role) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลให้ครบถ้วนทุกช่อง', 'warning');
      return;
    }

    if (this.isEditMode) {
      this.authService.updateUser(this.currentUser.id, this.currentUser).subscribe({
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
      this.authService.createUser(this.currentUser).subscribe({
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
}
