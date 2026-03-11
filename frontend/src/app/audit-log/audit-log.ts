import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './audit-log.html'
})
export class AuditLogComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  logs: any[] = [];
  filteredLogs: any[] = [];
  searchTerm: string = '';
  selectedAction: string = '';
  actionTypes = [
    { value: 'INSERT', label: 'เพิ่มข้อมูล' },
    { value: 'UPDATE', label: 'แก้ไขข้อมูล' },
    { value: 'DELETE', label: 'ลบข้อมูล' },
    { value: 'APPROVE', label: 'อนุมัติ' },
    { value: 'REJECT', label: 'ตีกลับ' },
    { value: 'REPLY', label: 'ตอบกลับ' }
  ];

  // Pagination
  currentPage: number = 1;
  pageSize: number = 20;
  totalPages: number = 0;

  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    if (!this.isSuperAdmin) {
      Swal.fire('Access Denied', 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadLogs();
  }

  loadLogs() {
    this.authService.getSystemLogs().subscribe({
      next: (res) => {
        if (res.success) {
          this.logs = res.data;
          this.applyFilters();
          this.cdr.detectChanges();
        }
      },
      error: (err) => console.error('Error loading logs:', err)
    });
  }

  backupLogs() {
    Swal.fire({
      title: 'สำรองข้อมูล Logs',
      text: 'คุณต้องการสำรองข้อมูล Logs ทั้งหมดเป็นไฟล์ CSV ใช่หรือไม่?',
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#10b981',
      confirmButtonText: 'ใช่, สำรองข้อมูล',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.backupLogs().subscribe({
          next: (blob: Blob) => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `korat_kpi_logs_${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            Swal.fire('สำเร็จ', 'สำรองข้อมูลเรียบร้อยแล้ว', 'success');
          },
          error: (err) => {
            console.error('Backup error:', err);
            Swal.fire('ผิดพลาด', 'ไม่สามารถสำรองข้อมูลได้', 'error');
          }
        });
      }
    });
  }

  clearLogs() {
    Swal.fire({
      title: 'ยืนยันการล้าง Logs',
      text: 'การดำเนินการนี้จะลบประวัติการใช้งานทั้งหมดและไม่สามารถเรียกคืนได้ คุณแน่ใจหรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: 'ใช่, ล้างข้อมูลทั้งหมด',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({
          title: 'ยืนยันอีกครั้ง',
          text: 'กรุณาพิมพ์ "CONFIRM" เพื่อยืนยันการล้างข้อมูล',
          input: 'text',
          inputAttributes: {
            autocapitalize: 'off'
          },
          showCancelButton: true,
          confirmButtonText: 'ยืนยัน',
          cancelButtonText: 'ยกเลิก',
          showLoaderOnConfirm: true,
          preConfirm: (login) => {
            if (login !== 'CONFIRM') {
              Swal.showValidationMessage('คำยืนยันไม่ถูกต้อง');
            }
            return login === 'CONFIRM';
          },
          allowOutsideClick: () => !Swal.isLoading()
        }).then((result) => {
          if (result.isConfirmed) {
            this.authService.clearLogs().subscribe({
              next: (res) => {
                if (res.success) {
                  Swal.fire('สำเร็จ', 'ล้างข้อมูล Logs เรียบร้อยแล้ว', 'success');
                  this.loadLogs();
                }
              },
              error: (err) => {
                console.error('Clear error:', err);
                Swal.fire('ผิดพลาด', 'ไม่สามารถล้างข้อมูลได้', 'error');
              }
            });
          }
        });
      }
    });
  }

  applyFilters() {
    this.filteredLogs = this.logs.filter(log => {
      // กรองตามประเภทการกระทำ
      if (this.selectedAction && log.action_type !== this.selectedAction) return false;

      const search = this.searchTerm.toLowerCase();
      if (!search) return true;

      const username = log.username ? log.username.toLowerCase() : '';
      const action = log.action_type ? log.action_type.toLowerCase() : '';
      const table = log.table_name ? log.table_name.toLowerCase() : '';

      let details = '';
      try {
        details = log.new_value ? JSON.stringify(log.new_value).toLowerCase() : '';
      } catch (e) {
        details = String(log.new_value).toLowerCase();
      }

      return username.includes(search) || action.includes(search) || table.includes(search) || details.includes(search);
    });
    this.totalPages = Math.ceil(this.filteredLogs.length / this.pageSize);
    this.currentPage = 1;
  }

  get pagedLogs() {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredLogs.slice(startIndex, startIndex + this.pageSize);
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  getActionLabel(type: string): string {
    const labels: any = {
      INSERT: 'เพิ่มข้อมูล',
      UPDATE: 'แก้ไขข้อมูล',
      DELETE: 'ลบข้อมูล',
      APPROVE: 'อนุมัติ',
      REJECT: 'ตีกลับ',
      REPLY: 'ตอบกลับ'
    };
    return labels[type] || type;
  }
}
