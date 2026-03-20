import { Component, OnInit, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { NgApexchartsModule } from 'ng-apexcharts';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import Swal from 'sweetalert2';
import { HttpErrorResponse } from '@angular/common/http';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, NgApexchartsModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css'
})
export class DashboardComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  private ngZone = inject(NgZone);

  kpiData: any[] = [];
  filteredData: any[] = [];
  searchTerm: string = '';
  selectedMain: string = '';
  selectedIndicator: string = '';
  selectedDept: string = '';
  selectedYear: string = '';
  selectedStatus: string = '';
  selectedHospital: string = '';
  selectedDistrict: string = '';

  mainCategories: string[] = [];
  indicatorNames: string[] = [];
  deptNames: string[] = [];
  filterYears: string[] = [];
  hospitalNames: string[] = [];
  districtNames: string[] = [];
  addKpiYears: string[] = [];
  addKpiSelectedYear: string = '';
  addKpiDistrictList: any[] = [];
  addKpiHospitalList: any[] = [];
  addKpiFilteredHospitals: any[] = [];
  addKpiSelectedDistrict: string = '';
  addKpiSelectedHospcode: string = '';
  addKpiExistingCount: number = 0;
  addKpiTotalTemplateCount: number = 0;

  isEditing: boolean = false;
  showAddModal: boolean = false;
  newKpiList: any[] = [];

  showTrendModal: boolean = false;
  selectedKpiName: string = '';
  kpiTrendOptions: any = {};
  
  isLoading: boolean = false;
  private animationTimer: any;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  currentUser: any = null;

  currentPage: number = 1;
  pageSize: number = 20;
  totalPages: number = 0;

  showRejectModal: boolean = false;
  rejectComment: string = '';
  rejectingItem: any = null;
  rejectSelectedMonths: string[] = [];
  rejectMonthOptions = [
    { key: 'oct', name: 'ต.ค.' }, { key: 'nov', name: 'พ.ย.' }, { key: 'dece', name: 'ธ.ค.' },
    { key: 'jan', name: 'ม.ค.' }, { key: 'feb', name: 'ก.พ.' }, { key: 'mar', name: 'มี.ค.' },
    { key: 'apr', name: 'เม.ย.' }, { key: 'may', name: 'พ.ค.' }, { key: 'jun', name: 'มิ.ย.' },
    { key: 'jul', name: 'ก.ค.' }, { key: 'aug', name: 'ส.ค.' }, { key: 'sep', name: 'ก.ย.' }
  ];
  showRejectionHistoryModal: boolean = false;
  rejectionHistory: any[] = [];
  rejectionHistoryFull: any[] = [];

  showReplyModal: boolean = false;
  replyingItem: any = null;
  replyMessage: string = '';
  replyRejectionInfo: any = null;

  // Data Entry Lock
  dataEntryLock: any = { is_locked: false, lock_reason: '' };

  // แก้ไขเฉพาะข้อ (จากอุทธรณ์ที่ได้รับอนุมัติ)
  editingSingleItem: any = null;

  // Appeal (อุทธรณ์)
  appealSettings: any = { is_open: false };
  appealReason: string = '';

  stats: any = {
    successRate: 0,
    recordedCount: 0,
    totalDepts: 0,
    pendingCount: 0,
    rank: 1
  };

  ngOnInit() {
    this.currentUser = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = ['admin_ssj', 'super_admin'].includes(role);
    this.isSuperAdmin = role === 'super_admin';

    // Fallback: ดึง hospcode/dept_id จาก JWT token กรณี user object ไม่มี (login เก่า)
    if (this.currentUser && !this.currentUser.hospcode) {
      try {
        const token = localStorage.getItem('kpi_token');
        if (token) {
          const payload = JSON.parse(atob(token.split('.')[1]));
          if (payload.hospcode) this.currentUser.hospcode = payload.hospcode;
          if (payload.deptId) this.currentUser.dept_id = payload.deptId;
        }
      } catch (e) { /* ignore */ }
    }

    this.loadKpiData();
    this.loadAppealSettings();
    this.loadDataEntryLock();
  }

  loadDataEntryLock() {
    this.authService.getDataEntryLock().subscribe({
      next: (res) => {
        if (res.success) this.dataEntryLock = res.data;
      }
    });
  }

  // user ทั่วไปถูกล็อคหรือไม่ (admin/super_admin ไม่ถูกล็อค)
  get isEntryLocked(): boolean {
    if (this.isAdmin || this.isSuperAdmin) return false;
    return this.dataEntryLock.is_locked;
  }

  loadAppealSettings() {
    this.authService.getAppealSettings().subscribe({
      next: (res) => {
        if (res.success) this.appealSettings = res.data;
      }
    });
  }

  loadKpiData() {
    this.isLoading = true;
    this.authService.getKpiResults().subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res && res.success) {
          this.kpiData = res.data;
          this.kpiData.forEach(item => {
            item.target_value = Number(item.target_value) || 0;
            item.total_actual = Number(item.total_actual) || 0;
            item.pending_count = Number(item.pending_count) || 0;
            ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].forEach(m => item[m] = Number(item[m]) || 0);
          });

          this.filteredData = res.data;
          this.setDefaultYear();
          this.applyFilters();
          this.loadDashboardStats();
          this.extractFilterLists();
          this.cdr.detectChanges(); 
        }
      },
      error: (err) => {
        this.isLoading = false;
        console.error('Error loading KPI:', err);
      }
    });
  }

  loadDashboardStats() {
    if (!this.selectedYear) return;
    this.authService.getDashboardStats(this.selectedYear).subscribe({
      next: (res) => {
        if (res && res.success) {
          this.animateStats(res.data);
        }
      },
      error: (err) => console.error('Error loading stats:', err)
    });
  }

  animateStats(target: any) {
    if (this.animationTimer) clearInterval(this.animationTimer);
    const duration = 1500;
    const steps = 60;
    const interval = duration / steps;
    const start = { 
      successRate: Number(this.stats.successRate) || 0,
      recordedCount: Number(this.stats.recordedCount) || 0,
      totalDepts: Number(this.stats.totalDepts) || 0,
      pendingCount: Number(this.stats.pendingCount) || 0,
      rank: Number(this.stats.rank) || 1
    };
    const end = target;
    let currentStep = 0;
    this.animationTimer = setInterval(() => {
      currentStep++;
      const progress = currentStep / steps;
      const ease = 1 - Math.pow(1 - progress, 4);
      this.stats.successRate = (start.successRate + (Number(end.successRate) - start.successRate) * ease).toFixed(1);
      this.stats.recordedCount = Math.round(start.recordedCount + (Number(end.recordedCount) - start.recordedCount) * ease);
      this.stats.totalDepts = Math.round(start.totalDepts + (Number(end.totalDepts) - start.totalDepts) * ease);
      this.stats.pendingCount = Math.round(start.pendingCount + (Number(end.pendingCount) - start.pendingCount) * ease);
      this.stats.rank = Math.round(start.rank + (Number(end.rank) - start.rank) * ease);
      if (currentStep >= steps) {
        clearInterval(this.animationTimer);
        this.stats = end;
      }
      this.cdr.detectChanges();
    }, interval);
  }

  get pagedData() {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    const pageItems = this.filteredData.slice(startIndex, startIndex + this.pageSize);
    for (let i = 0; i < pageItems.length; i++) {
      if (i === 0 || pageItems[i].main_indicator_name !== pageItems[i - 1].main_indicator_name) {
        let span = 1;
        for (let j = i + 1; j < pageItems.length; j++) {
          if (pageItems[j].main_indicator_name === pageItems[i].main_indicator_name) {
            span++;
          } else {
            break;
          }
        }
        pageItems[i].rowSpan = span;
      } else {
        pageItems[i].rowSpan = 0;
      }
    }
    return pageItems;
  }

  setDefaultYear() {
    const today = new Date();
    let year = today.getFullYear();
    if (today.getMonth() >= 9) {
      year += 1;
    }
    this.selectedYear = (year + 543).toString();
  }

  extractFilterLists() {
    this.mainCategories = [...new Set(this.kpiData.map(item => item.main_indicator_name))];
    this.indicatorNames = [...new Set(this.kpiData.map(item => item.kpi_indicators_name))];
    this.deptNames = [...new Set(this.kpiData.map(item => item.dept_name))];
    this.hospitalNames = [...new Set(this.kpiData.map(item => item.hosname).filter(Boolean))].sort();
    this.districtNames = [...new Set(this.kpiData.map(item => item.distname).filter(Boolean))].sort();
    this.filterYears = [...new Set(this.kpiData.map(item => item.year_bh))].sort().reverse();
  }

  onYearChange() {
    this.applyFilters();
    this.loadDashboardStats();
  }

  clearFilters() {
    this.searchTerm = '';
    this.selectedMain = '';
    this.selectedIndicator = '';
    this.selectedDept = '';
    this.selectedYear = '';
    this.selectedStatus = '';
    this.selectedHospital = '';
    this.selectedDistrict = '';
    this.applyFilters();
  }

  applyFilters() {
    this.filteredData = this.kpiData.filter(item => {
      const deptName = item.dept_name || '';
      const year = item.year_bh || '';
      const mainindicatorName = item.main_indicator_name || '';
      const indicatorName = item.kpi_indicators_name || '';
      const recorderName = item.recorder_name || '';
      const hosname = item.hosname || '';
      const distname = item.distname || '';
      const search = this.searchTerm.toLowerCase();
      const matchSearch = indicatorName.toLowerCase().includes(search) ||
                        recorderName.toLowerCase().includes(search) ||
                        deptName.toLowerCase().includes(search) ||
                        mainindicatorName.toLowerCase().includes(search) ||
                        hosname.toLowerCase().includes(search) ||
                        distname.toLowerCase().includes(search);
      const matchMain = this.selectedMain === '' || item.main_indicator_name === this.selectedMain;
      const matchIndicator = this.selectedIndicator === '' || item.kpi_indicators_name === this.selectedIndicator;
      const matchdept = this.selectedDept === '' || item.dept_name === this.selectedDept;
      const matchYear = this.selectedYear === '' || item.year_bh === this.selectedYear;
      const matchHospital = this.selectedHospital === '' || item.hosname === this.selectedHospital;
      const matchDistrict = this.selectedDistrict === '' || item.distname === this.selectedDistrict;
      const matchStatus = this.selectedStatus === '' ||
                          (this.selectedStatus === 'pass' && item.total_actual >= item.target_value) ||
                          (this.selectedStatus === 'fail' && item.total_actual < item.target_value) ||
                          (this.selectedStatus === 'pending' && item.pending_count > 0);
      return matchSearch && matchMain && matchIndicator && matchdept && matchYear && matchStatus && matchHospital && matchDistrict;
    });
    this.filteredData.sort((a, b) => {
      if (b.year_bh !== a.year_bh) return b.year_bh.localeCompare(a.year_bh);
      if (a.main_indicator_name < b.main_indicator_name) return -1;
      if (a.main_indicator_name > b.main_indicator_name) return 1;
      return a.kpi_indicators_name.localeCompare(b.kpi_indicators_name);
    });
    this.totalPages = Math.ceil(this.filteredData.length / this.pageSize);
    this.currentPage = 1;
    this.cdr.detectChanges();
  }

  toggleEditMode() {
    if (!this.isEditing) {
      this.filteredData.forEach(item => {
        item._original = { ...item };
      });
      this.isEditing = true;
      Swal.fire({
        icon: 'info',
        title: 'เข้าสู่โหมดแก้ไข',
        text: 'คุณสามารถแก้ไขตัวเลขในตารางได้แล้ว',
        timer: 1500,
        showConfirmButton: false
      });
    } else {
      this.resetData(false);
      this.isEditing = false;
    }
  }

  saveKpiData() {
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const monthNames: any = {
      oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
      apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
    };
    const changedItems = this.filteredData.filter(item => {
      if (!item._original) return false;
      if (Number(item.target_value) !== Number(item._original.target_value)) return true;
      return months.some(m => Number(item[m]) !== Number(item._original[m]));
    });

    if (changedItems.length === 0) {
      Swal.fire({ icon: 'info', title: 'ไม่มีข้อมูลที่เปลี่ยนแปลง', text: 'ไม่พบรายการที่มีการแก้ไข', confirmButtonText: 'ตกลง' });
      return;
    }

    const invalidItems = changedItems.filter(item => Number(item.target_value) === 0);
    if (invalidItems.length > 0) {
      Swal.fire({
        icon: 'warning',
        title: 'พบค่าเป้าหมายเป็น 0',
        text: `มีข้อมูลที่แก้ไข ${invalidItems.length} รายการ ที่ค่าเป้าหมายเป็น 0 ซึ่งจะทำให้คำนวณ % ไม่ได้ กรุณาแก้ไขก่อนบันทึก`,
        confirmButtonText: 'ตกลง, ไปแก้ไข'
      });
      return;
    }

    // ตรวจสอบคะแนนที่น้อยกว่าเดิม
    const decreasedList: string[] = [];
    for (const item of changedItems) {
      for (const m of months) {
        const oldVal = Number(item._original[m]) || 0;
        const newVal = Number(item[m]) || 0;
        if (oldVal > 0 && newVal < oldVal) {
          decreasedList.push(`<b>${item.kpi_indicators_name}</b> ${monthNames[m]}: ${oldVal} → ${newVal}`);
        }
      }
    }
    // ถ้ามีค่าน้อยกว่าเดิม → แจ้งเตือนยืนยัน/ยกเลิก ก่อน
    const proceedToSave = () => {
      // สร้างสรุปรายละเอียดการแก้ไข
      const changeDetails: string[] = [];
      for (const item of changedItems) {
        const changes: string[] = [];
        if (Number(item.target_value) !== Number(item._original.target_value)) {
          changes.push(`เป้าหมาย: ${item._original.target_value} → ${item.target_value}`);
        }
        for (const m of months) {
          if (Number(item[m]) !== Number(item._original[m])) {
            changes.push(`${monthNames[m]}: ${item._original[m]} → ${item[m]}`);
          }
        }
        if (changes.length > 0) {
          changeDetails.push(`<b>${item.kpi_indicators_name}</b><br><span class="text-gray-500 text-xs">${changes.join(', ')}</span>`);
        }
      }

      // Clean data - ส่งเฉพาะ fields ที่ backend ต้องการ ไม่ส่ง _original
      const cleanData = changedItems.map(item => ({
        indicator_id: item.indicator_id,
        year_bh: item.year_bh,
        hospcode: item.hospcode,
        target_value: item.target_value,
        oct: item.oct, nov: item.nov, dece: item.dece,
        jan: item.jan, feb: item.feb, mar: item.mar,
        apr: item.apr, may: item.may, jun: item.jun,
        jul: item.jul, aug: item.aug, sep: item.sep
      }));

      // ตรวจสอบว่ามีรายการที่สถานะ "รอตอบกลับ" (Resubmit) หรือไม่
      const resubmitItems = changedItems.filter(item =>
        item.indicator_status === 'resubmit' || item.indicator_status === 'Resubmit'
      );
      const hasResubmitItems = resubmitItems.length > 0 && !this.isAdmin;

      // สร้าง HTML สำหรับส่วนตอบกลับ (ถ้ามีรายการ Resubmit)
      const replySection = hasResubmitItems
        ? `<div class="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
             <div class="flex items-center gap-2 mb-2">
               <input type="checkbox" id="swal-reply-check" checked style="accent-color:#3b82f6;width:16px;height:16px;">
               <label for="swal-reply-check" class="font-bold text-blue-700 text-sm cursor-pointer">
                 <i class="fas fa-reply mr-1"></i>นำข้อมูลที่แก้ไขไปตอบกลับด้วย (${resubmitItems.length} รายการ)
               </label>
             </div>
             <div id="swal-reply-area">
               <textarea id="swal-reply-message" rows="3" placeholder="ข้อความตอบกลับ (ไม่บังคับ)..."
                 style="width:100%;padding:8px;border:1px solid #93c5fd;border-radius:8px;font-size:13px;margin-top:4px;"></textarea>
             </div>
           </div>`
        : '';

      Swal.fire({
        title: 'ยืนยันการบันทึก',
        html: `<div class="text-left text-sm">
                <p class="mb-2 font-bold text-gray-700">พบข้อมูลที่เปลี่ยนแปลง ${cleanData.length} รายการ:</p>
                <div class="max-h-48 overflow-y-auto border rounded-lg p-3 bg-gray-50 space-y-2">
                  ${changeDetails.join('<hr class="my-2 border-gray-200">')}
                </div>
                ${replySection}
                <p class="mt-3 text-gray-600">ต้องการบันทึกใช่หรือไม่?</p>
               </div>`,
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        confirmButtonText: 'บันทึก',
        cancelButtonText: 'ยกเลิก',
        width: 600,
        didOpen: () => {
          const checkbox = document.getElementById('swal-reply-check') as HTMLInputElement;
          const replyArea = document.getElementById('swal-reply-area');
          if (checkbox && replyArea) {
            checkbox.addEventListener('change', () => {
              replyArea.style.display = checkbox.checked ? 'block' : 'none';
            });
          }
        },
        preConfirm: () => {
          if (hasResubmitItems) {
            const checkbox = document.getElementById('swal-reply-check') as HTMLInputElement;
            const replyMsg = (document.getElementById('swal-reply-message') as HTMLTextAreaElement)?.value || '';
            return { wantReply: checkbox?.checked || false, replyMessage: replyMsg.trim() };
          }
          return { wantReply: false, replyMessage: '' };
        }
      }).then((result) => {
        if (result.isConfirmed) {
          const replyInfo = result.value;
          if (replyInfo && replyInfo.wantReply) {
            this.saveDataWithReply(cleanData, resubmitItems, replyInfo.replyMessage);
          } else {
            if (hasResubmitItems) {
              const resubmitIds = new Set(resubmitItems.map(r => `${r.indicator_id}_${r.year_bh}_${r.hospcode}`));
              cleanData.forEach((item: any) => {
                const key = `${item.indicator_id}_${item.year_bh}_${item.hospcode}`;
                if (resubmitIds.has(key)) {
                  item.preserve_status = 'Resubmit';
                }
              });
            }
            this.saveDataToBackend(cleanData, false);
          }
        }
      });
    };

    if (decreasedList.length > 0) {
      Swal.fire({
        icon: 'warning',
        title: 'พบคะแนนที่น้อยกว่าเดิม',
        html: `<div class="text-left text-sm max-h-60 overflow-y-auto">
                <p class="mb-2 text-gray-600">กรุณาตรวจสอบรายการต่อไปนี้:</p>
                <ul class="list-disc pl-5 space-y-1 text-red-600">${decreasedList.map(d => `<li>${d}</li>`).join('')}</ul>
               </div>`,
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        confirmButtonText: 'ยืนยัน บันทึก',
        cancelButtonColor: '#6b7280',
        cancelButtonText: 'ยกเลิก กลับไปตรวจสอบ'
      }).then((result) => {
        if (result.isConfirmed) {
          proceedToSave();
        }
      });
    } else {
      proceedToSave();
    }
  }

  saveDataWithReply(data: any[], resubmitItems: any[], replyMessage: string) {
    Swal.fire({
      title: 'กำลังบันทึกข้อมูลและตอบกลับ...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    // บันทึกข้อมูลก่อน
    this.authService.updateKpiResults(data).subscribe({
      next: (res) => {
        // หลังบันทึกสำเร็จ → ส่งตอบกลับทีละรายการ
        const replyMsg = replyMessage || 'แก้ไขข้อมูลตามที่แจ้งเรียบร้อยแล้ว';
        const replyObservables = resubmitItems.map(item => {
          const replyData = {
            indicator_id: item.indicator_id,
            year_bh: item.year_bh,
            hospcode: item.hospcode,
            message: replyMsg
          };
          return this.authService.replyKpi(replyData);
        });

        if (replyObservables.length === 0) {
          Swal.fire('สำเร็จ', 'บันทึกข้อมูลเรียบร้อยแล้ว', 'success');
          this.isEditing = false;
          this.loadKpiData();
          this.loadDashboardStats();
          return;
        }

        // ส่งตอบกลับทั้งหมด
        let completed = 0;
        let hasError = false;
        for (const obs of replyObservables) {
          obs.subscribe({
            next: () => {
              completed++;
              if (completed === replyObservables.length && !hasError) {
                Swal.fire('สำเร็จ', `บันทึกข้อมูลและตอบกลับเรียบร้อยแล้ว (${resubmitItems.length} รายการ)`, 'success');
                this.isEditing = false;
                this.loadKpiData();
                this.loadDashboardStats();
              }
            },
            error: (err: any) => {
              hasError = true;
              console.error('Reply error:', err);
              Swal.fire('แจ้งเตือน', 'บันทึกข้อมูลสำเร็จ แต่การตอบกลับบางรายการผิดพลาด', 'warning');
              this.isEditing = false;
              this.loadKpiData();
              this.loadDashboardStats();
            }
          });
        }
      },
      error: (err) => {
        Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถบันทึกข้อมูลได้', 'error');
        console.error(err);
      }
    });
  }

  saveDataToBackend(data: any[], isNew: boolean) {
    Swal.fire({
      title: 'กำลังบันทึกข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });
    this.authService.updateKpiResults(data).subscribe({
      next: (res) => {
        Swal.fire('สำเร็จ', isNew ? 'เพิ่มตัวชี้วัดเรียบร้อยแล้ว' : 'บันทึกผล KPI เรียบร้อยแล้ว', 'success');
        this.isEditing = false;
        this.showAddModal = false;
        this.loadKpiData();
        this.loadDashboardStats();
      },
      error: (err) => {
        Swal.fire('เกิดข้อผิดพลาด', err.error?.message || 'ไม่สามารถบันทึกข้อมูลได้', 'error');
        console.error(err);
      }
    });
  }

  approveKpi(item: any) {
    Swal.fire({
      title: 'ยืนยันการรับรอง',
      text: `คุณต้องการรับรองและล็อคข้อมูลของ ${item.kpi_indicators_name} ใช่หรือไม่?`,
      icon: 'info',
      showCancelButton: true,
      confirmButtonColor: '#10b981',
      confirmButtonText: 'ใช่, รับรองข้อมูล',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.approveKpi(item.indicator_id, item.year_bh, item.hospcode).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'รับรองและล็อคข้อมูลเรียบร้อยแล้ว', 'success');
              this.loadKpiData();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
        });
      }
    });
  }

  approveAll() {
    const pendingItems = this.filteredData.filter(item => item.pending_count > 0);
    if (pendingItems.length === 0) return;
    Swal.fire({
      title: 'ยืนยันการอนุมัติ',
      text: `คุณต้องการอนุมัติรายการที่รอตรวจสอบจำนวน ${pendingItems.length} รายการใช่หรือไม่?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#198754',
      cancelButtonColor: '#d33',
      confirmButtonText: 'ใช่, อนุมัติทั้งหมด',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        const approvals = pendingItems.map(item => ({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode
        }));
        this.authService.approveKpiResults(approvals).subscribe({
          next: (res) => {
            Swal.fire('สำเร็จ', 'อนุมัติข้อมูลเรียบร้อยแล้ว', 'success');
            this.loadKpiData();
            this.loadDashboardStats();
          },
          error: (err) => Swal.fire('เกิดข้อผิดพลาด', 'ไม่สามารถอนุมัติข้อมูลได้', 'error')
        });
      }
    });
  }

  unlockKpi(item: any) {
    Swal.fire({
      title: 'ยืนยันการปลดล็อค',
      text: `คุณต้องการปลดล็อคข้อมูลของ ${item.kpi_indicators_name} เพื่อให้หน่วยงานแก้ไขได้ใช่หรือไม่?`,
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#f59e0b',
      confirmButtonText: 'ใช่, ปลดล็อค',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.unlockKpi(item.indicator_id, item.year_bh, item.hospcode).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'ปลดล็อคข้อมูลเรียบร้อยแล้ว', 'success');
              this.loadKpiData();
            }
          },
          error: (err) => Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถดำเนินการได้', 'error')
        });
      }
    });
  }

  openAddModal() {
    this.calculateAddKpiYears();
    if (this.addKpiYears.includes(this.selectedYear)) {
      this.addKpiSelectedYear = this.selectedYear;
    } else {
      this.addKpiSelectedYear = this.addKpiYears[0];
    }
    if (this.isAdmin) {
      this.addKpiSelectedDistrict = '';
      this.addKpiSelectedHospcode = '';
      this.loadAddKpiDistrictsAndHospitals();
    } else {
      this.addKpiSelectedHospcode = this.currentUser?.hospcode || '';
      this.loadAddKpiList();
    }
  }

  loadAddKpiDistrictsAndHospitals() {
    Swal.fire({ title: 'กำลังโหลดข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    this.authService.getDistricts().subscribe({
      next: (distRes) => {
        if (distRes.success) {
          this.addKpiDistrictList = distRes.data;
        }
        this.authService.getHospitals().subscribe({
          next: (hosRes) => {
            Swal.close();
            if (hosRes.success) {
              this.addKpiHospitalList = hosRes.data;
              this.addKpiFilteredHospitals = hosRes.data;
            }
            setTimeout(() => {
              this.showAddModal = true;
              this.newKpiList = [];
              this.cdr.detectChanges();
            }, 150);
          },
          error: () => { Swal.close(); Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลหน่วยบริการได้', 'error'); }
        });
      },
      error: () => { Swal.close(); Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลอำเภอได้', 'error'); }
    });
  }

  onAddKpiDistrictChange() {
    if (this.addKpiSelectedDistrict) {
      this.addKpiFilteredHospitals = this.addKpiHospitalList.filter(
        (h: any) => {
          const distid = (h.provcode || '') + (h.distcode || '');
          return distid === this.addKpiSelectedDistrict;
        }
      );
    } else {
      this.addKpiFilteredHospitals = this.addKpiHospitalList;
    }
    this.addKpiSelectedHospcode = '';
    this.newKpiList = [];
  }

  onAddKpiHospitalChange() {
    if (this.addKpiSelectedHospcode) {
      this.loadAddKpiList();
    } else {
      this.newKpiList = [];
    }
  }

  calculateAddKpiYears() {
    const today = new Date();
    let year = today.getFullYear();
    if (today.getMonth() >= 9) { 
      year += 1;
    }
    const currentThaiYear = year + 543;
    this.addKpiYears = [];
    for (let i = 0; i < 4; i++) {
      this.addKpiYears.push((currentThaiYear + i).toString());
    }
  }

  loadAddKpiList() {
    const targetHospcode = this.addKpiSelectedHospcode || this.currentUser?.hospcode || '';
    Swal.fire({
      title: 'กำลังโหลดข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });
    this.authService.getKpiTemplate().subscribe({
      next: (res) => {
        if (res.success) {
          // สร้าง existingIds จาก kpiData
          // สำหรับ user ปกติ: kpiData ถูก filter ด้วย hospcode จาก server แล้ว ใช้แค่ปีงบ
          // สำหรับ admin: ต้อง filter ด้วย hospcode + ปีงบ
          const existingIds = new Set(
            this.kpiData
              .filter(k => {
                const yearMatch = String(k.year_bh) === String(this.addKpiSelectedYear);
                if (this.isAdmin && targetHospcode) {
                  return yearMatch && k.hospcode === targetHospcode;
                }
                return yearMatch; // Non-admin: server already filters by hospcode
              })
              .map(k => Number(k.indicator_id))
          );

          // กรองตัวชี้วัดตามหน่วยงาน (user เห็นเฉพาะ dept ตัวเอง)
          let allForDept = res.data;
          if (!this.isAdmin && this.currentUser?.dept_name) {
            allForDept = allForDept.filter((item: any) => item.dept_name === this.currentUser.dept_name);
          }

          // คำนวณจำนวนทั้งหมด vs มีอยู่แล้ว vs ยังไม่มี
          this.addKpiTotalTemplateCount = allForDept.length;
          const available = allForDept.filter((item: any) => !existingIds.has(Number(item.indicator_id)));
          this.addKpiExistingCount = this.addKpiTotalTemplateCount - available.length;

          this.newKpiList = available.map((item: any) => ({
            ...item,
            year_bh: this.addKpiSelectedYear,
            hospcode: targetHospcode,
            target_value: 0,
            oct: 0, nov: 0, dece: 0, jan: 0, feb: 0, mar: 0,
            apr: 0, may: 0, jun: 0, jul: 0, aug: 0, sep: 0,
            total_actual: 0,
            _original: { target_value: 0, oct: 0, nov: 0, dece: 0, jan: 0, feb: 0, mar: 0, apr: 0, may: 0, jun: 0, jul: 0, aug: 0, sep: 0 }
          }));
          Swal.close();
          if (!this.showAddModal) {
            setTimeout(() => {
              this.showAddModal = true;
              this.cdr.detectChanges();
            }, 150);
          } else {
            this.cdr.detectChanges();
          }
        } else {
          Swal.close();
        }
      },
      error: () => {
        Swal.close();
        Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลตัวชี้วัดได้', 'error');
      }
    });
  }

  closeAddModal() {
    this.showAddModal = false;
    this.cdr.detectChanges();
  }

  saveNewKpis() {
    const targetHospcode = this.addKpiSelectedHospcode || this.currentUser?.hospcode || '';
    if (!targetHospcode) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกหน่วยบริการก่อนบันทึก', 'warning');
      return;
    }
    // ตรวจสอบว่ามีข้อมูลที่กรอกแล้วหรือไม่
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const itemsWithData = this.newKpiList.filter((item: any) =>
      item.target_value > 0 || months.some(m => item[m] > 0)
    );
    if (itemsWithData.length === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณากรอกข้อมูลอย่างน้อย 1 รายการ (เป้าหมาย หรือ ผลงาน)', 'warning');
      return;
    }

    Swal.fire({
      title: 'ยืนยันการบันทึก',
      html: `<div class="text-left text-sm">
        <p class="text-gray-600">พบข้อมูลที่กรอก <b>${itemsWithData.length}</b> รายการ จากทั้งหมด <b>${this.newKpiList.length}</b> รายการ</p>
        <p class="text-gray-500 text-xs mt-2">ปีงบประมาณ: <b>${this.addKpiSelectedYear}</b></p>
        <p class="mt-2 text-gray-600">ต้องการบันทึกใช่หรือไม่?</p>
      </div>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#10b981',
      confirmButtonText: '<i class="fas fa-save mr-1"></i> บันทึก',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.executeAddKpiSave(targetHospcode);
      }
    });
  }

  private executeAddKpiSave(hospcode: string) {
    Swal.fire({
      title: 'กำลังบันทึกข้อมูล...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    const dataToSave = this.newKpiList
      .filter((item: any) => item.target_value > 0 || ['oct','nov','dece','jan','feb','mar','apr','may','jun','jul','aug','sep'].some(m => item[m] > 0))
      .map((item: any) => ({
        indicator_id: item.indicator_id,
        year_bh: this.addKpiSelectedYear,
        target_value: item.target_value,
        oct: item.oct, nov: item.nov, dece: item.dece,
        jan: item.jan, feb: item.feb, mar: item.mar,
        apr: item.apr, may: item.may, jun: item.jun,
        jul: item.jul, aug: item.aug, sep: item.sep
      }));

    this.authService.updateKpiResults(dataToSave, hospcode, 'setup_insert_new').subscribe({
      next: (res) => {
        let message = `เพิ่มตัวชี้วัดเรียบร้อยแล้ว ${dataToSave.length} รายการ`;
        if (res.inserted !== undefined) {
          message = `เพิ่มตัวชี้วัดใหม่ ${res.inserted} รายการ` + (res.skipped ? ` (ข้าม ${res.skipped} รายการที่มีอยู่แล้ว)` : '');
        }
        Swal.fire('สำเร็จ', res.message || message, 'success');
        this.showAddModal = false;
        this.loadKpiData();
        this.loadDashboardStats();
      },
      error: (err) => {
        Swal.fire('ผิดพลาด', err.error?.message || 'ไม่สามารถบันทึกข้อมูลได้', 'error');
      }
    });
  }

  // === Add KPI Modal: ตรวจสอบการแก้ไข / Undo / Reset ===
  isAddKpiModified(item: any, field: string): boolean {
    if (!item._original) return false;
    return Number(item[field]) !== Number(item._original[field]);
  }

  isAddKpiRowModified(item: any): boolean {
    if (!item._original) return false;
    const fields = ['target_value', 'oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    return fields.some(f => Number(item[f]) !== Number(item._original[f]));
  }

  undoAddKpiRow(item: any) {
    if (!item._original) return;
    const fields = ['target_value', 'oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    fields.forEach(f => item[f] = item._original[f]);
    item.total_actual = 0;
    this.cdr.detectChanges();
  }

  resetAddKpi() {
    Swal.fire({
      title: 'คืนค่าเริ่มต้น',
      text: 'ต้องการคืนค่าข้อมูลทั้งหมดเป็น 0 ใช่หรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#f59e0b',
      confirmButtonText: '<i class="fas fa-undo mr-1"></i> ใช่, คืนค่า',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        this.newKpiList.forEach((item: any) => this.undoAddKpiRow(item));
        Swal.fire({ icon: 'success', title: 'คืนค่าเรียบร้อยแล้ว', toast: true, position: 'top-end', timer: 2000, showConfirmButton: false });
      }
    });
  }

  openTrendModal(item: any) {
    this.selectedKpiName = item.kpi_indicators_name;
    const data = [
      item.oct, item.nov, item.dece, item.jan, item.feb, item.mar,
      item.apr, item.may, item.jun, item.jul, item.aug, item.sep
    ];
    this.kpiTrendOptions = {
      series: [{
        name: "ผลงาน",
        data: data
      }],
      chart: {
        height: 350,
        type: "line",
        zoom: { enabled: false },
        fontFamily: 'Prompt, sans-serif',
        toolbar: { show: false }
      },
      dataLabels: { enabled: true },
      stroke: { curve: "smooth", width: 3 },
      title: { text: "แนวโน้มผลงานรายเดือน", align: "left" },
      grid: { row: { colors: ["#f3f3f3", "transparent"], opacity: 0.5 } },
      xaxis: {
        categories: ["ต.ค.", "พ.ย.", "ธ.ค.", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย."],
      },
      colors: ['#10B981'],
      markers: { size: 5, hover: { size: 7 } }
    };
    this.showTrendModal = true;
  }

  closeTrendModal() {
    this.showTrendModal = false;
  }

  resetData(confirm: boolean = true) {
    const restore = () => {
      this.filteredData.forEach(item => {
        if (item._original) {
          Object.assign(item, item._original);
        }
      });
      this.cdr.detectChanges();
    };
    if (confirm) {
      Swal.fire({
        title: 'ยืนยันการคืนค่า',
        text: "ข้อมูลที่แก้ไขจะถูกย้อนกลับเป็นค่าเริ่มต้น",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'ใช่, คืนค่า',
        cancelButtonText: 'ยกเลิก'
      }).then((result) => {
        if (result.isConfirmed) {
          restore();
          Swal.fire({ icon: 'success', title: 'คืนค่าข้อมูลเรียบร้อยแล้ว', toast: true, position: 'top-end', timer: 3000, showConfirmButton: false });
        }
      });
    } else {
      restore();
    }
  }

  onValueChange(item: any, month: string) {
    if (item[month] < 0) {
      item[month] = 0;
    }
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    let sum = 0;
    for (const m of months) {
      sum += Number(item[m]) || 0;
    }
    item.total_actual = sum;
  }

  isModified(item: any, month: string): boolean {
    if (!item._original) return false;
    return item[month] != item._original[month];
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages) {
      this.currentPage = page;
    }
  }

  openRejectModal(item: any) {
    this.rejectingItem = item;
    this.rejectComment = '';
    this.rejectSelectedMonths = [];
    this.showRejectModal = true;
  }

  toggleRejectMonth(key: string) {
    const idx = this.rejectSelectedMonths.indexOf(key);
    if (idx >= 0) {
      this.rejectSelectedMonths.splice(idx, 1);
    } else {
      this.rejectSelectedMonths.push(key);
    }
  }

  confirmReject() {
    if (this.rejectSelectedMonths.length === 0) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกเดือนที่ต้องแก้ไขอย่างน้อย 1 เดือน', 'warning');
      return;
    }
    if (!this.rejectComment.trim()) {
      Swal.fire('แจ้งเตือน', 'กรุณาระบุเหตุผลการส่งคืนแก้ไข', 'warning');
      return;
    }
    const data = {
      indicator_id: this.rejectingItem.indicator_id,
      year_bh: this.rejectingItem.year_bh,
      hospcode: this.rejectingItem.hospcode,
      comment: this.rejectComment,
      reject_months: this.rejectSelectedMonths
    };
    this.authService.rejectKpi(data).subscribe({
      next: (res) => {
        if (res.success) {
          this.showRejectModal = false;
          Swal.fire('สำเร็จ', 'ส่งคืนแก้ไขเรียบร้อยแล้ว', 'success');
          this.loadKpiData();
        }
      },
      error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งคืนแก้ไขได้')
    });
  }

  rejectAll() {
    const pendingItems = this.filteredData.filter(item => item.pending_count > 0);
    if (pendingItems.length === 0) return;

    // สร้าง month checkboxes HTML
    const monthOpts = [
      { key: 'oct', name: 'ต.ค.' }, { key: 'nov', name: 'พ.ย.' }, { key: 'dece', name: 'ธ.ค.' },
      { key: 'jan', name: 'ม.ค.' }, { key: 'feb', name: 'ก.พ.' }, { key: 'mar', name: 'มี.ค.' },
      { key: 'apr', name: 'เม.ย.' }, { key: 'may', name: 'พ.ค.' }, { key: 'jun', name: 'มิ.ย.' },
      { key: 'jul', name: 'ก.ค.' }, { key: 'aug', name: 'ส.ค.' }, { key: 'sep', name: 'ก.ย.' }
    ];
    const monthCheckboxes = monthOpts.map(m =>
      `<label style="display:inline-flex;align-items:center;gap:4px;margin:4px 6px;font-size:13px;cursor:pointer;">
        <input type="checkbox" name="reject_month" value="${m.key}" style="accent-color:#ef4444;"> ${m.name}
      </label>`
    ).join('');

    Swal.fire({
      title: 'ส่งคืนแก้ไขทั้งหมด',
      html: `<div class="text-left">
        <p class="text-sm text-gray-600 mb-2">จำนวน ${pendingItems.length} รายการ</p>
        <label class="block text-sm font-bold text-gray-700 mb-1">เดือนที่ต้องแก้ไข <span class="text-red-500">*</span></label>
        <div style="display:flex;flex-wrap:wrap;margin-bottom:12px;">${monthCheckboxes}</div>
        <label class="block text-sm font-bold text-gray-700 mb-1">เหตุผลการส่งคืนแก้ไข <span class="text-red-500">*</span></label>
        <textarea id="swal-reject-comment" rows="3" placeholder="กรุณาระบุเหตุผล..." style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;"></textarea>
      </div>`,
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: `ส่งคืนทั้งหมด (${pendingItems.length})`,
      cancelButtonText: 'ยกเลิก',
      width: 520,
      preConfirm: () => {
        const checkedMonths = Array.from(document.querySelectorAll('input[name="reject_month"]:checked')).map((el: any) => el.value);
        const comment = (document.getElementById('swal-reject-comment') as HTMLTextAreaElement)?.value || '';
        if (checkedMonths.length === 0) { Swal.showValidationMessage('กรุณาเลือกเดือนที่ต้องแก้ไข'); return false; }
        if (!comment.trim()) { Swal.showValidationMessage('กรุณาระบุเหตุผล'); return false; }
        return { months: checkedMonths, comment: comment.trim() };
      }
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        const rejections = pendingItems.map(item => ({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          comment: result.value.comment,
          reject_months: result.value.months
        }));
        this.authService.rejectKpi(rejections).subscribe({
          next: (res) => {
            Swal.fire('สำเร็จ', `ส่งคืนแก้ไขเรียบร้อยแล้ว ${pendingItems.length} รายการ`, 'success');
            this.loadKpiData();
            this.loadDashboardStats();
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งคืนแก้ไขได้')
        });
      }
    });
  }

  private handleApiError(err: HttpErrorResponse, defaultMsg: string) {
    if (err.status === 401 || err.status === 403) {
      Swal.fire({
        icon: 'warning',
        title: 'เซสชันหมดอายุ',
        text: 'กรุณาเข้าสู่ระบบใหม่',
        confirmButtonText: 'เข้าสู่ระบบ'
      }).then(() => {
        this.authService.logout();
        this.router.navigate(['/login']);
      });
    } else {
      Swal.fire('ผิดพลาด', err.error?.message || defaultMsg, 'error');
    }
  }

  viewRejectionHistory(item: any) {
    this.authService.getRejectionComments(item.indicator_id, item.year_bh, item.hospcode).subscribe({
      next: (res) => {
        if (res.success) {
          const monthNames: any = {
            oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
            apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
          };
          const allHistory = res.data.map((h: any) => ({
            ...h,
            reject_months_display: h.reject_months
              ? h.reject_months.split(',').map((m: string) => monthNames[m.trim()] || m.trim()).join(', ')
              : ''
          }));
          // แสดงเฉพาะรายการล่าสุด (1 รายการ)
          this.rejectionHistory = allHistory.slice(0, 1);
          this.rejectionHistoryFull = allHistory;
          this.showRejectionHistoryModal = true;
          this.cdr.detectChanges();

          // หน่วยบริการ: เมื่อดูประวัติตีกลับจากช่องสถานะ ให้ mark notification เป็นอ่านแล้วด้วย
          if (!this.isAdmin) {
            this.markRelatedNotificationsRead(item);
          }
        }
      },
      error: (err) => Swal.fire('ผิดพลาด', 'ไม่สามารถดึงข้อมูลได้', 'error')
    });
  }

  markRelatedNotificationsRead(item: any) {
    // ดึง notifications ที่เกี่ยวข้องกับตัวชี้วัดนี้แล้ว mark as read
    this.authService.getNotifications().subscribe({
      next: (res) => {
        if (res.success) {
          const unreadIds = res.data
            .filter((n: any) => !n.is_read && n.type === 'reject' &&
              n.indicator_id === item.indicator_id &&
              n.year_bh === item.year_bh)
            .map((n: any) => n.id);
          if (unreadIds.length > 0) {
            this.authService.markNotificationsRead({ ids: unreadIds }).subscribe({
              next: () => {
                this.authService.refreshUnreadCount();
                // โหลดข้อมูลใหม่เพื่ออัปเดตสถานะ (Rejected → Resubmit)
                this.loadKpiData();
              }
            });
          }
        }
      }
    });
  }

  goToNotificationsReject() {
    this.showRejectionHistoryModal = false;
    this.router.navigate(['/notifications'], { queryParams: { filter: 'reject' } });
  }

  openReplyModal(item: any) {
    this.replyingItem = item;
    this.replyMessage = '';
    this.replyRejectionInfo = null;
    // โหลดเหตุผลตีกลับล่าสุด
    this.authService.getRejectionComments(item.indicator_id, item.year_bh, item.hospcode).subscribe({
      next: (res) => {
        if (res.success && res.data.length > 0) {
          const latest = res.data.find((h: any) => h.type === 'reject') || res.data[0];
          const monthNames: any = {
            oct: 'ต.ค.', nov: 'พ.ย.', dece: 'ธ.ค.', jan: 'ม.ค.', feb: 'ก.พ.', mar: 'มี.ค.',
            apr: 'เม.ย.', may: 'พ.ค.', jun: 'มิ.ย.', jul: 'ก.ค.', aug: 'ส.ค.', sep: 'ก.ย.'
          };
          this.replyRejectionInfo = {
            ...latest,
            reject_months_display: latest.reject_months
              ? latest.reject_months.split(',').map((m: string) => monthNames[m.trim()] || m.trim()).join(', ')
              : ''
          };
        }
        this.showReplyModal = true;
        this.cdr.detectChanges();
      },
      error: () => {
        this.showReplyModal = true;
        this.cdr.detectChanges();
      }
    });
  }

  confirmReply() {
    const data = {
      indicator_id: this.replyingItem.indicator_id,
      year_bh: this.replyingItem.year_bh,
      hospcode: this.replyingItem.hospcode,
      message: this.replyMessage
    };
    this.authService.replyKpi(data).subscribe({
      next: (res) => {
        if (res.success) {
          this.showReplyModal = false;
          Swal.fire('สำเร็จ', 'ส่งตอบกลับเรียบร้อยแล้ว สถานะเปลี่ยนเป็น "รอตรวจสอบ"', 'success');
          this.loadKpiData();
        }
      },
      error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งตอบกลับได้')
    });
  }

  // === แก้ไขเฉพาะข้อ (จากอุทธรณ์ที่ได้รับอนุมัติ) ===

  startEditSingle(item: any) {
    item._original = { ...item };
    this.editingSingleItem = item;
    Swal.fire({ icon: 'info', title: 'แก้ไขข้อที่อุทธรณ์', text: `กำลังแก้ไข: ${item.kpi_indicators_name}`, timer: 1500, showConfirmButton: false });
  }

  isSingleEditing(item: any): boolean {
    return this.editingSingleItem &&
      this.editingSingleItem.indicator_id === item.indicator_id &&
      this.editingSingleItem.year_bh === item.year_bh &&
      this.editingSingleItem.hospcode === item.hospcode;
  }

  cancelEditSingle() {
    if (this.editingSingleItem && this.editingSingleItem._original) {
      const orig = this.editingSingleItem._original;
      Object.assign(this.editingSingleItem, orig);
    }
    this.editingSingleItem = null;
  }

  saveSingleItem() {
    const item = this.editingSingleItem;
    if (!item || !item._original) return;

    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const hasChange = Number(item.target_value) !== Number(item._original.target_value) ||
      months.some(m => Number(item[m]) !== Number(item._original[m]));

    if (!hasChange) {
      Swal.fire('ไม่มีการเปลี่ยนแปลง', 'ไม่พบข้อมูลที่แก้ไข', 'info');
      return;
    }

    const cleanData = [{
      indicator_id: item.indicator_id,
      year_bh: item.year_bh,
      hospcode: item.hospcode,
      target_value: item.target_value,
      oct: item.oct, nov: item.nov, dece: item.dece,
      jan: item.jan, feb: item.feb, mar: item.mar,
      apr: item.apr, may: item.may, jun: item.jun,
      jul: item.jul, aug: item.aug, sep: item.sep
    }];

    Swal.fire({
      title: 'ยืนยันบันทึกและส่งตรวจสอบ',
      html: `<p class="text-sm">บันทึกข้อมูล <b>${item.kpi_indicators_name}</b> และส่งให้ Admin ตรวจสอบรับรอง</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'บันทึกและส่งตรวจสอบ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#10b981'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });

        this.authService.updateKpiResults(cleanData).subscribe({
          next: (res) => {
            if (res.success) {
              // แจ้ง admin ว่าแก้ไขข้อมูลอุทธรณ์เสร็จแล้ว
              this.authService.notifyAppealEdited({
                indicator_id: item.indicator_id,
                year_bh: item.year_bh,
                hospcode: item.hospcode
              }).subscribe();

              this.editingSingleItem = null;
              Swal.fire('สำเร็จ', 'บันทึกข้อมูลและแจ้ง Admin ให้ตรวจสอบรับรองเรียบร้อยแล้ว', 'success');
              this.loadKpiData();
            } else {
              Swal.fire('ผิดพลาด', res.message, 'error');
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถบันทึกข้อมูลได้')
        });
      }
    });
  }

  // === ระบบอุทธรณ์ ===

  openAppealModal(item: any) {
    this.appealReason = '';
    Swal.fire({
      title: 'ยื่นอุทธรณ์ขอแก้ไขคะแนน',
      html: `<div class="text-left text-sm mb-3">
        <p class="font-bold">${item.kpi_indicators_name}</p>
        <p class="text-gray-500">ปี ${item.year_bh} | ${item.hosname || item.hospcode}</p>
      </div>`,
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
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          reason: result.value
        }).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'ยื่นอุทธรณ์เรียบร้อยแล้ว รอ Admin พิจารณา', 'success');
              this.loadKpiData();
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถยื่นอุทธรณ์ได้')
        });
      }
    });
  }

  approveAppeal(item: any) {
    Swal.fire({
      title: 'อนุมัติอุทธรณ์',
      html: `<p class="text-sm">อนุมัติอุทธรณ์ <b>${item.kpi_indicators_name}</b><br>ข้อมูลจะถูกปลดล็อคให้หน่วยบริการแก้ไขได้</p>`,
      input: 'textarea',
      inputLabel: 'ความเห็น (ไม่บังคับ)',
      inputPlaceholder: 'ระบุความเห็นเพิ่มเติม...',
      showCancelButton: true,
      confirmButtonText: 'อนุมัติอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#16a34a'
    }).then((result) => {
      if (result.isConfirmed) {
        this.authService.approveAppeal({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          comment: result.value || ''
        }).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'อนุมัติอุทธรณ์เรียบร้อย ข้อมูลถูกปลดล็อคแล้ว', 'success');
              this.loadKpiData();
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถอนุมัติอุทธรณ์ได้')
        });
      }
    });
  }

  rejectAppeal(item: any) {
    Swal.fire({
      title: 'ปฏิเสธอุทธรณ์',
      html: `<p class="text-sm">ปฏิเสธอุทธรณ์ <b>${item.kpi_indicators_name}</b><br>ข้อมูลจะยังคงถูกล็อคไว้</p>`,
      input: 'textarea',
      inputLabel: 'เหตุผลในการปฏิเสธ',
      inputPlaceholder: 'ระบุเหตุผลที่ปฏิเสธอุทธรณ์...',
      inputValidator: (value) => !value ? 'กรุณาระบุเหตุผล' : null,
      showCancelButton: true,
      confirmButtonText: 'ปฏิเสธอุทธรณ์',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626'
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        this.authService.rejectAppeal({
          indicator_id: item.indicator_id,
          year_bh: item.year_bh,
          hospcode: item.hospcode,
          comment: result.value
        }).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire('สำเร็จ', 'ปฏิเสธอุทธรณ์เรียบร้อย', 'success');
              this.loadKpiData();
            }
          },
          error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถปฏิเสธอุทธรณ์ได้')
        });
      }
    });
  }
}
