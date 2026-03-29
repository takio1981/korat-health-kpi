import { Component, OnInit, inject, ChangeDetectorRef, NgZone } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import { LanguageService } from '../services/language.service';
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
  lang = inject(LanguageService);
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
  addKpiDeptList: any[] = [];
  addKpiSelectedDept: string = '';
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
  isAdminCup: boolean = false;
  isLocalAdmin: boolean = false;
  isDistrictScope: boolean = false;
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
  targetEditLocked: boolean = false;

  // Target Edit Requests
  targetEditRequests: any[] = [];

  // แก้ไขเฉพาะข้อ (จากอุทธรณ์ที่ได้รับอนุมัติ)
  editingSingleItem: any = null;

  // (state แก้ไขเป้าหมายรายข้อเก็บไว้บน item._editingTarget ตรงๆ)

  // Appeal (อุทธรณ์)
  appealSettings: any = { is_open: false };
  appealReason: string = '';

  // Dynamic Form Modal
  showDynamicFormModal: boolean = false;
  dynamicFormItem: any = null;
  dynamicFormSchema: any = null;
  dynamicFormTab: 'form' | 'list' = 'form';
  dynamicFormData: any = {};
  dynamicFormUsedMonths: number[] = []; // เดือนที่คีย์ไปแล้ว
  isDynamicFormSaving: boolean = false;
  isDynamicDataLoading: boolean = false;
  dynamicDataList: any[] = [];
  availableYears: string[] = [];

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
    this.isAdmin = ['admin_ssj', 'super_admin'].includes(role);      // admin ส่วนกลาง
    this.isSuperAdmin = role === 'super_admin';
    this.isAdminCup = role === 'admin_cup';                          // admin อำเภอ
    this.isLocalAdmin = ['admin_hos', 'admin_sso', 'admin_cup'].includes(role); // admin พื้นที่ทุกระดับ
    this.isDistrictScope = ['user_cup', 'admin_cup'].includes(role); // เห็นทั้งอำเภอ

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
    if (this.isAdmin || this.isLocalAdmin) this.loadTargetEditRequests();
  }

  loadDataEntryLock() {
    this.authService.getDataEntryLock().subscribe({
      next: (res) => {
        if (res.success) {
          this.dataEntryLock = res.data;
          this.targetEditLocked = res.data.target_edit_locked === true;
        }
      }
    });
  }

  // admin ทุกระดับไม่ถูกล็อค, user ถูกล็อคเมื่อเปิดล็อค
  get isEntryLocked(): boolean {
    if (this.isAdmin || this.isLocalAdmin) return false;
    return this.dataEntryLock.is_locked;
  }

  // ทุกสิทธิ์แก้ไขเป้าหมายได้เมื่อไม่ล็อค; เมื่อล็อคต้องผ่านขั้นตอนขออนุมัติ
  get canEditTarget(): boolean {
    return !this.targetEditLocked;
  }

  // admin_cup / admin_ssj / super_admin เห็นปุ่มขอแก้ไขเป้าหมายเมื่อล็อค
  get canRequestTargetEdit(): boolean {
    return this.targetEditLocked && (this.isAdmin || this.isLocalAdmin);
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
            item.target_value = item.target_value != null ? String(item.target_value) : '';
            item.last_actual = String(item.last_actual ?? '');
            item.total_actual = parseFloat(item.last_actual) || 0;
            item.pending_count = Number(item.pending_count) || 0;
            ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'].forEach(m => item[m] = item[m] != null ? String(item[m]) : '');
          });

          this.filteredData = res.data;
          this.setDefaultYear();
          this.applyFilters();
          this.loadDashboardStats();
          this.extractFilterLists();
          this.loadDynamicFormMonths();
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
                          (this.selectedStatus === 'pass' && this.isTargetMet(item)) ||
                          (this.selectedStatus === 'fail' && !this.isTargetMet(item)) ||
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
      if (String(item.target_value ?? '') !== String(item._original.target_value ?? '')) return true;
      return months.some(m => String(item[m] ?? '') !== String(item._original[m] ?? ''));
    });

    if (changedItems.length === 0) {
      Swal.fire({ icon: 'info', title: 'ไม่มีข้อมูลที่เปลี่ยนแปลง', text: 'ไม่พบรายการที่มีการแก้ไข', confirmButtonText: 'ตกลง' });
      return;
    }

    // ตรวจสอบคะแนนที่น้อยกว่าเดิม
    const decreasedList: string[] = [];
    for (const item of changedItems) {
      for (const m of months) {
        const oldVal = parseFloat(item._original[m]);
        const newVal = parseFloat(item[m]);
        if (!isNaN(oldVal) && oldVal > 0 && !isNaN(newVal) && newVal < oldVal) {
          decreasedList.push(`<b>${item.kpi_indicators_name}</b> ${monthNames[m]}: ${item._original[m]} → ${item[m]}`);
        }
      }
    }
    // ถ้ามีค่าน้อยกว่าเดิม → แจ้งเตือนยืนยัน/ยกเลิก ก่อน
    const proceedToSave = () => {
      // สร้างสรุปรายละเอียดการแก้ไข
      const changeDetails: string[] = [];
      for (const item of changedItems) {
        const changes: string[] = [];
        if (String(item.target_value ?? '') !== String(item._original.target_value ?? '')) {
          changes.push(`เป้าหมาย: ${item._original.target_value} → ${item.target_value}`);
        }
        for (const m of months) {
          if (String(item[m] ?? '') !== String(item._original[m] ?? '')) {
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
    if (this.isAdmin || this.isLocalAdmin) {
      this.addKpiSelectedDistrict = '';
      this.addKpiSelectedHospcode = '';
      this.addKpiSelectedDept = '';
      this.loadAddKpiDistrictsAndHospitals();
    } else {
      this.addKpiSelectedHospcode = this.currentUser?.hospcode || '';
      this.loadAddKpiList();
    }
  }

  loadAddKpiDistrictsAndHospitals() {
    Swal.fire({ title: 'กำลังโหลดข้อมูล...', allowOutsideClick: false, didOpen: () => Swal.showLoading() });
    // โหลด 3 รายการพร้อมกัน: อำเภอ, หน่วยบริการ, หน่วยงาน
    this.authService.getDistricts().subscribe({
      next: (distRes) => {
        if (distRes.success) this.addKpiDistrictList = distRes.data;
        this.authService.getHospitals().subscribe({
          next: (hosRes) => {
            if (hosRes.success) this.addKpiHospitalList = hosRes.data;
            this.authService.getDepartments().subscribe({
              next: (deptRes) => {
                Swal.close();
                if (deptRes.success) this.addKpiDeptList = deptRes.data;

                // Local admin: auto-select ตามขอบเขต
                if (this.isLocalAdmin && this.currentUser?.hospcode) {
                  const myHos = this.addKpiHospitalList.find((h: any) => h.hoscode === this.currentUser.hospcode);
                  if (this.isAdminCup && myHos?.distid) {
                    // admin_cup: ล็อคอำเภอ เลือก hospcode ในอำเภอได้
                    this.addKpiSelectedDistrict = myHos.distid;
                    this.addKpiDistrictList = this.addKpiDistrictList.filter((d: any) => d.distid === myHos.distid);
                    this.addKpiFilteredHospitals = this.addKpiHospitalList.filter((h: any) => h.distid === myHos.distid);
                  } else {
                    // admin_hos / admin_sso: ล็อค hospcode ตัวเอง
                    this.addKpiSelectedHospcode = this.currentUser.hospcode;
                    this.addKpiFilteredHospitals = this.addKpiHospitalList.filter((h: any) => h.hoscode === this.currentUser.hospcode);
                    if (myHos?.distid) {
                      this.addKpiSelectedDistrict = myHos.distid;
                      this.addKpiDistrictList = this.addKpiDistrictList.filter((d: any) => d.distid === myHos.distid);
                    }
                  }
                } else {
                  this.addKpiFilteredHospitals = this.addKpiHospitalList;
                }

                setTimeout(() => {
                  this.showAddModal = true;
                  this.newKpiList = [];
                  // Admin ที่มี hospcode ถูกเลือกแล้ว (auto-select) → โหลดรายการทันที
                  if (this.addKpiSelectedHospcode || (this.isAdmin || this.isLocalAdmin)) {
                    this.loadAddKpiList();
                  }
                  this.cdr.detectChanges();
                }, 150);
              },
              error: () => { Swal.close(); Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดข้อมูลหน่วยงานได้', 'error'); }
            });
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
        (h: any) => h.distid === this.addKpiSelectedDistrict
      );
    } else {
      this.addKpiFilteredHospitals = this.addKpiHospitalList;
    }
    this.addKpiSelectedHospcode = '';
    this.newKpiList = [];
  }

  onAddKpiHospitalChange() {
    if (this.addKpiSelectedHospcode || (this.isAdmin || this.isLocalAdmin)) {
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
    // Admin: ใช้ hospcode ที่เลือก (อาจยังไม่เลือก = ''), User: ใช้ hospcode ตัวเอง
    const targetHospcode = (this.isAdmin || this.isLocalAdmin)
      ? (this.addKpiSelectedHospcode || '')
      : (this.addKpiSelectedHospcode || this.currentUser?.hospcode || '');
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
                if ((this.isAdmin || this.isLocalAdmin) && targetHospcode) {
                  return yearMatch && k.hospcode === targetHospcode;
                }
                return yearMatch; // Non-admin: server already filters by hospcode
              })
              .map(k => Number(k.indicator_id))
          );

          // กรองตัวชี้วัดตามหน่วยงาน
          let allForDept = res.data;
          if ((this.isAdmin || this.isLocalAdmin) && this.addKpiSelectedDept) {
            // admin ที่เลือก dept → กรองตาม dept ที่เลือก
            allForDept = allForDept.filter((item: any) => String(item.dept_id) === String(this.addKpiSelectedDept));
          } else if (!this.isAdmin && !this.isLocalAdmin && this.currentUser?.dept_name) {
            // user ทั่วไป → กรองตาม dept ตัวเอง
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
            target_value: '',
            oct: '', nov: '', dece: '', jan: '', feb: '', mar: '',
            apr: '', may: '', jun: '', jul: '', aug: '', sep: '',
            total_actual: 0,
            last_actual: '',
            _original: { target_value: '', oct: '', nov: '', dece: '', jan: '', feb: '', mar: '', apr: '', may: '', jun: '', jul: '', aug: '', sep: '' }
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
    const targetHospcode = (this.isAdmin || this.isLocalAdmin)
      ? this.addKpiSelectedHospcode
      : (this.addKpiSelectedHospcode || this.currentUser?.hospcode || '');
    if (!targetHospcode) {
      Swal.fire('แจ้งเตือน', 'กรุณาเลือกหน่วยบริการก่อนบันทึก', 'warning');
      return;
    }
    if (this.newKpiList.length === 0) {
      Swal.fire('แจ้งเตือน', 'ไม่มีรายการตัวชี้วัดที่จะบันทึก', 'warning');
      return;
    }

    // นับจำนวนที่มีข้อมูล (เพื่อแสดงสรุป)
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const itemsWithData = this.newKpiList.filter((item: any) => {
      const tv = String(item.target_value ?? '').trim();
      if (tv && tv !== '0') return true;
      return months.some(m => { const v = String(item[m] ?? '').trim(); return v && v !== '0'; });
    });

    Swal.fire({
      title: 'ยืนยันการบันทึก',
      html: `<div class="text-left text-sm">
        <p class="text-gray-600">บันทึกตัวชี้วัดทั้งหมด <b>${this.newKpiList.length}</b> รายการ (มีข้อมูล <b>${itemsWithData.length}</b> รายการ)</p>
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

    const dataToSave = this.newKpiList.map((item: any) => ({
        indicator_id: item.indicator_id,
        year_bh: this.addKpiSelectedYear,
        target_value: String(item.target_value ?? '').trim(),
        oct: String(item.oct ?? '').trim(), nov: String(item.nov ?? '').trim(), dece: String(item.dece ?? '').trim(),
        jan: String(item.jan ?? '').trim(), feb: String(item.feb ?? '').trim(), mar: String(item.mar ?? '').trim(),
        apr: String(item.apr ?? '').trim(), may: String(item.may ?? '').trim(), jun: String(item.jun ?? '').trim(),
        jul: String(item.jul ?? '').trim(), aug: String(item.aug ?? '').trim(), sep: String(item.sep ?? '').trim()
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
    return String(item[field] ?? '') !== String(item._original[field] ?? '');
  }

  isAddKpiRowModified(item: any): boolean {
    if (!item._original) return false;
    const fields = ['target_value', 'oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    return fields.some(f => String(item[f] ?? '') !== String(item._original[f] ?? ''));
  }

  undoAddKpiRow(item: any) {
    if (!item._original) return;
    const fields = ['target_value', 'oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    fields.forEach(f => item[f] = item._original[f]);
    item.last_actual = '';
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
    const months = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    const labels = ['ต.ค.', 'พ.ย.', 'ธ.ค.', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.'];

    // แยกข้อมูลตัวเลข vs ข้อความ
    const rawData = months.map(m => String(item[m] ?? '').trim());
    const numericData = rawData.map(v => { const n = parseFloat(v); return isNaN(n) ? null : n; });
    const hasTextValues = rawData.some(v => v !== '' && isNaN(parseFloat(v)));

    // สร้าง annotations สำหรับเดือนที่เป็นข้อความ (แสดงเป็น label บนกราฟ)
    const pointAnnotations = rawData.map((v, i) => {
      if (v !== '' && isNaN(parseFloat(v))) {
        return { x: labels[i], y: 0, marker: { size: 0 }, label: { text: v, borderColor: '#9333ea', style: { background: '#f3e8ff', color: '#7e22ce', fontSize: '11px', fontWeight: 'bold', padding: { left: 6, right: 6, top: 3, bottom: 3 } } } };
      }
      return null;
    }).filter(a => a !== null);

    // เป้าหมาย: ถ้าเป็นตัวเลข → เส้นปะ, ถ้าเป็นข้อความ → annotation label
    const targetRaw = String(item.target_value ?? '').trim();
    const targetNum = parseFloat(targetRaw);
    const hasNumericTarget = !isNaN(targetNum) && targetNum !== 0;

    // Series: ผลงาน + เส้นเป้าหมาย (ถ้าเป็นตัวเลข)
    const series: any[] = [{ name: 'ผลงาน', data: numericData }];
    const strokeWidth: number[] = [3];
    const strokeDash: number[] = [0];
    const colors: string[] = ['#10B981'];

    if (hasNumericTarget) {
      series.push({ name: 'เป้าหมาย (' + targetRaw + ')', data: Array(12).fill(targetNum) });
      strokeWidth.push(2);
      strokeDash.push(6);
      colors.push('#EF4444');
    }

    // Y-axis annotation สำหรับเป้าหมายที่เป็นข้อความ
    const yAnnotations: any[] = [];
    if (!hasNumericTarget && targetRaw) {
      // เป้าหมายเป็นข้อความ → แสดง label ที่แกน Y
      yAnnotations.push({
        y: 0, borderColor: '#9333ea', strokeDashArray: 4,
        label: { text: 'เป้าหมาย: ' + targetRaw, borderColor: '#9333ea', position: 'front',
          style: { background: '#f3e8ff', color: '#7e22ce', fontSize: '12px', fontWeight: 'bold', padding: { left: 8, right: 8, top: 4, bottom: 4 } }
        }
      });
    }

    this.kpiTrendOptions = {
      series,
      chart: {
        height: 350,
        type: 'line',
        zoom: { enabled: false },
        fontFamily: 'Sarabun, sans-serif',
        toolbar: { show: false }
      },
      dataLabels: {
        enabled: true,
        enabledOnSeries: [0],
        formatter: (val: any) => val !== null && val !== undefined ? val : ''
      },
      stroke: { curve: 'smooth', width: strokeWidth, dashArray: strokeDash },
      title: {
        text: 'แนวโน้มผลงานรายเดือน' + (hasTextValues ? ' (ข้อความแสดงเป็น label)' : ''),
        align: 'left'
      },
      grid: { row: { colors: ['#f3f3f3', 'transparent'], opacity: 0.5 } },
      xaxis: { categories: labels },
      yaxis: { labels: { formatter: (val: any) => val !== null && val !== undefined ? val : '' } },
      colors,
      markers: { size: [5, 0], hover: { size: 7 } },
      legend: { show: series.length > 1, position: 'top' },
      annotations: { points: pointAnnotations, yaxis: yAnnotations },
      tooltip: {
        y: {
          formatter: (val: any, opts: any) => {
            if (opts.seriesIndex === 1) return val;
            const txt = rawData[opts.dataPointIndex];
            if (val === null && txt) return txt;
            return val !== null && val !== undefined ? val : '-';
          }
        }
      }
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
    const fiscalOrder = ['oct', 'nov', 'dece', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
    let lastActual = '';
    for (const m of fiscalOrder) {
      const v = String(item[m] ?? '').trim();
      if (v && v !== '0') lastActual = v;
    }
    item.last_actual = lastActual;
    item.total_actual = parseFloat(lastActual) || 0;
  }

  calcPercent(item: any): number {
    const tv = String(item.target_value ?? '').trim();
    const la = String(item.last_actual ?? '').trim();
    if (!tv) return 0;
    const target = parseFloat(tv);
    const actual = parseFloat(la);
    // ทั้งคู่เป็นตัวเลข → คำนวณปกติ
    if (!isNaN(target) && target !== 0 && !isNaN(actual)) return (actual / target) * 100;
    // เป็นข้อความ → เปรียบเทียบตรงกัน = 100%, ไม่ตรง = 0%
    if (la && tv === la) return 100;
    return 0;
  }

  isTargetMet(item: any): boolean {
    const tv = String(item.target_value ?? '').trim();
    const la = String(item.last_actual ?? '').trim();
    if (!tv) return true; // ไม่มีเป้าหมาย → ไม่แสดงสีแดง
    const target = parseFloat(tv);
    const actual = parseFloat(la);
    // ทั้งคู่เป็นตัวเลข → เปรียบเทียบปกติ
    if (!isNaN(target) && !isNaN(actual)) return actual >= target;
    // เป็นข้อความ → ตรงกัน = ผ่าน
    return la === tv;
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

  // === Target Edit Request Workflow ===

  loadTargetEditRequests() {
    this.authService.getTargetEditRequests().subscribe({
      next: (res) => {
        if (res.success) {
          this.targetEditRequests = res.data;
          this.cdr.detectChanges();
        }
      }
    });
  }

  getTargetEditRequest(item: any): any {
    return this.targetEditRequests.find(r =>
      r.indicator_id == item.indicator_id &&
      r.year_bh == item.year_bh &&
      r.hospcode == item.hospcode
    ) || null;
  }

  requestTargetEdit(item: any) {
    Swal.fire({
      title: 'ขอแก้ไขเป้าหมาย',
      html: `<p class="text-sm font-semibold">${item.kpi_indicators_name}</p><p class="text-xs text-gray-500 mt-1">ปีงบ ${item.year_bh} | ${item.hosname || item.hospcode}</p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'ส่งคำขอ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#f97316'
    }).then((result) => {
      if (!result.isConfirmed) return;
      this.authService.requestTargetEdit({
        indicator_id: item.indicator_id,
        year_bh: item.year_bh,
        hospcode: item.hospcode
      }).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'ส่งคำขอแล้ว', text: 'รอการอนุมัติจาก Admin', timer: 2000, showConfirmButton: false });
            this.loadTargetEditRequests();
            this.authService.refreshUnreadCount();
          } else {
            Swal.fire('ผิดพลาด', res.message, 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถส่งคำขอได้')
      });
    });
  }

  approveTargetRequest(request: any) {
    Swal.fire({
      title: 'อนุมัติคำขอแก้ไขเป้าหมาย?',
      html: `<p class="text-sm">จาก: <b>${request.requested_by_name || request.username || ''}</b></p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'อนุมัติ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#16a34a'
    }).then((result) => {
      if (!result.isConfirmed) return;
      this.authService.approveTargetEditRequest(request.id).subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'อนุมัติแล้ว', timer: 1500, showConfirmButton: false });
            this.loadTargetEditRequests();
            this.authService.refreshUnreadCount();
          } else {
            Swal.fire('ผิดพลาด', res.message, 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถอนุมัติได้')
      });
    });
  }

  rejectTargetRequest(request: any) {
    Swal.fire({
      title: 'ปฏิเสธคำขอแก้ไขเป้าหมาย?',
      input: 'text',
      inputLabel: 'เหตุผลการปฏิเสธ (ถ้ามี)',
      inputPlaceholder: 'ระบุเหตุผล...',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'ปฏิเสธ',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#dc2626'
    }).then((result) => {
      if (!result.isConfirmed) return;
      this.authService.rejectTargetEditRequest(request.id, result.value || '').subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire({ icon: 'success', title: 'ปฏิเสธแล้ว', timer: 1500, showConfirmButton: false });
            this.loadTargetEditRequests();
            this.authService.refreshUnreadCount();
          } else {
            Swal.fire('ผิดพลาด', res.message, 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถปฏิเสธได้')
      });
    });
  }

  // helper: ตรวจสอบว่าควรแสดง input ช่องเป้าหมายหรือไม่
  canShowTargetInput(item: any): boolean {
    if (item.is_locked) return false;
    if (this.isEditing && this.canEditTarget) return true;
    if (this.isSingleEditing(item)) return true;
    if (this.isEditingTarget(item)) return true;
    return false;
  }

  // === แก้ไขเป้าหมายรายข้อ (ทุกสิทธิ์เมื่อไม่ล็อค / ผ่านอนุมัติเมื่อล็อค) ===

  startEditTarget(item: any) {
    item._originalTarget = item.target_value;
    item._editingTarget = true;
    this.cdr.detectChanges();
  }

  isEditingTarget(item: any): boolean {
    return item._editingTarget === true;
  }

  cancelEditTarget(item: any) {
    item.target_value = item._originalTarget;
    item._editingTarget = false;
    this.cdr.detectChanges();
  }

  saveTargetOnly(item: any) {
    if (String(item.target_value ?? '') === String(item._originalTarget ?? '')) {
      Swal.fire({ icon: 'info', title: 'ไม่มีการเปลี่ยนแปลง', text: 'ค่าเป้าหมายไม่ได้รับการแก้ไข', timer: 1500, showConfirmButton: false });
      item._editingTarget = false;
      this.cdr.detectChanges();
      return;
    }
    const oldVal = item._originalTarget;
    const newVal = item.target_value;

    Swal.fire({
      title: 'ยืนยันแก้ไขเป้าหมาย',
      html: `<p class="text-sm"><b>${item.kpi_indicators_name}</b></p><p class="mt-2">เป้าหมาย: <b>${oldVal}</b> → <b class="text-orange-600">${newVal}</b></p>`,
      icon: 'question',
      showCancelButton: true,
      confirmButtonText: 'บันทึก',
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#f97316'
    }).then((result) => {
      if (!result.isConfirmed) return;
      const payload = [{
        indicator_id: item.indicator_id,
        year_bh: item.year_bh,
        hospcode: item.hospcode,
        target_value: item.target_value,
        oct: item.oct, nov: item.nov, dece: item.dece,
        jan: item.jan, feb: item.feb, mar: item.mar,
        apr: item.apr, may: item.may, jun: item.jun,
        jul: item.jul, aug: item.aug, sep: item.sep
      }];
      this.authService.updateKpiResults(payload).subscribe({
        next: (res) => {
          if (res.success) {
            item._originalTarget = item.target_value;
            item._editingTarget = false;
            this.cdr.detectChanges();
            // ปิด request ถ้ามีการอนุมัติไว้
            const request = this.getTargetEditRequest(item);
            if (request && request.status === 'approved') {
              this.authService.completeTargetEditRequest(request.id).subscribe({
                next: () => {
                  this.loadTargetEditRequests();
                  this.authService.refreshUnreadCount();
                }
              });
            }
            Swal.fire({ icon: 'success', title: 'บันทึกเป้าหมายแล้ว', timer: 1500, showConfirmButton: false });
          } else {
            Swal.fire('ผิดพลาด', res.message || 'ไม่สามารถบันทึกได้', 'error');
          }
        },
        error: (err: HttpErrorResponse) => this.handleApiError(err, 'ไม่สามารถบันทึกเป้าหมายได้')
      });
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
    const hasChange = String(item.target_value ?? '') !== String(item._original.target_value ?? '') ||
      months.some(m => String(item[m] ?? '') !== String(item._original[m] ?? ''));

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

  // ============================================================
  // === Dynamic Form Modal (แบบฟอร์มบันทึกข้อมูล KPI) ===
  // ============================================================

  // โหลดเดือนที่มีข้อมูลจาก dynamic form สำหรับแต่ละ item ที่มี form schema
  private monthBhToKey: any = { 10: 'oct', 11: 'nov', 12: 'dece', 1: 'jan', 2: 'feb', 3: 'mar', 4: 'apr', 5: 'may', 6: 'jun', 7: 'jul', 8: 'aug', 9: 'sep' };

  loadDynamicFormMonths() {
    const items = this.kpiData.filter(i => i.table_process && i.has_form_schema);
    for (const item of items) {
      item._formMonths = {}; // { oct: true, jan: true, ... }
      this.authService.getDynamicDataMonths(item.table_process, {
        hospcode: item.hospcode,
        year_bh: item.year_bh
      }).subscribe({
        next: (res) => {
          if (res.success && res.data) {
            for (const mb of res.data) {
              const key = this.monthBhToKey[Number(mb)];
              if (key) item._formMonths[key] = true;
            }
            this.cdr.detectChanges();
          }
        }
      });
    }
  }

  hasFormData(item: any, month: string): boolean {
    return item._formMonths && item._formMonths[month];
  }

  openDynamicForm(item: any) {
    // ตรวจสอบล็อค (user ถูกล็อค + item ถูกล็อค)
    if (this.isEntryLocked) {
      Swal.fire('ล็อคการคีย์', this.dataEntryLock.lock_reason || 'ระบบปิดการคีย์ข้อมูลชั่วคราว', 'warning');
      return;
    }
    if (item.is_locked) {
      Swal.fire('ล็อคข้อมูล', 'ตัวชี้วัดนี้ถูกล็อคแล้ว ไม่สามารถคีย์ข้อมูลได้', 'warning');
      return;
    }

    this.dynamicFormItem = item;
    this.dynamicFormTab = 'form';
    this.dynamicFormData = {};
    this.dynamicDataList = [];
    this.dynamicFormSchema = null;
    this.dynamicFormUsedMonths = [];
    // สร้าง availableYears (ปีงบฯ ± 2 ปีปัจจุบัน)
    const currentYear = new Date().getFullYear() + 543;
    this.availableYears = [
      String(currentYear + 1), String(currentYear), String(currentYear - 1), String(currentYear - 2)
    ];
    this.dynamicFormData.year_bh = item.year_bh || String(currentYear);
    this.dynamicFormData.hospcode = item.hospcode || this.currentUser?.hospcode;
    this.dynamicFormData.indicator_id = item.indicator_id;

    // โหลด schema
    this.authService.getFormSchemaByIndicator(item.indicator_id).subscribe({
      next: (res) => {
        if (res.success && res.data) {
          this.dynamicFormSchema = res.data;
          this.showDynamicFormModal = true;
          // โหลดเดือนที่คีย์ไปแล้ว
          this.loadDynamicFormUsedMonths();
          this.cdr.detectChanges();
        } else {
          Swal.fire('แจ้งเตือน', 'ยังไม่มีแบบฟอร์มสำหรับตัวชี้วัดนี้', 'info');
        }
      },
      error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถโหลดแบบฟอร์มได้', 'error')
    });
  }

  switchDynamicFormTab(tab: 'form' | 'list') {
    this.dynamicFormTab = tab;
    if (tab === 'list') this.loadDynamicDataList();
    this.cdr.detectChanges();
  }

  loadDynamicFormUsedMonths() {
    if (!this.dynamicFormSchema?.table_process) return;
    this.authService.getDynamicDataMonths(this.dynamicFormSchema.table_process, {
      hospcode: this.dynamicFormData.hospcode,
      year_bh: this.dynamicFormData.year_bh
    }).subscribe({
      next: (res) => {
        this.dynamicFormUsedMonths = res.success ? res.data.map((m: any) => Number(m)) : [];
        this.cdr.detectChanges();
      }
    });
  }

  loadDynamicDataList() {
    if (!this.dynamicFormSchema?.table_process) return;
    this.isDynamicDataLoading = true;
    const params: any = {
      hospcode: this.dynamicFormItem.hospcode,
      year_bh: this.dynamicFormData.year_bh
    };
    this.authService.getDynamicData(this.dynamicFormSchema.table_process, params).subscribe({
      next: (res) => {
        this.isDynamicDataLoading = false;
        if (res.success) this.dynamicDataList = res.data;
        this.cdr.detectChanges();
      },
      error: () => { this.isDynamicDataLoading = false; this.cdr.detectChanges(); }
    });
  }

  saveDynamicFormData() {
    if (!this.dynamicFormSchema?.table_process) return;
    // ตรวจสอบฟิลด์บังคับ
    const missingFields = (this.dynamicFormSchema.fields || [])
      .filter((f: any) => f.is_required && !this.dynamicFormData[f.field_name]);
    if (missingFields.length > 0) {
      Swal.fire('ข้อมูลไม่ครบ', `กรุณากรอก: ${missingFields.map((f: any) => f.field_label).join(', ')}`, 'warning');
      return;
    }
    this.isDynamicFormSaving = true;
    const payload = { ...this.dynamicFormData };
    this.authService.saveDynamicData(this.dynamicFormSchema.table_process, payload).subscribe({
      next: (res) => {
        this.isDynamicFormSaving = false;
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'บันทึกสำเร็จ', timer: 1500, showConfirmButton: false });
          this.resetDynamicForm();
          this.loadDynamicFormUsedMonths(); // อัปเดตเดือนที่คีย์แล้ว
          if (this.dynamicFormTab === 'list') this.loadDynamicDataList();
          this.loadKpiData(); // reload dashboard data to reflect synced values
        } else {
          Swal.fire('ผิดพลาด', res.message, 'error');
        }
        this.cdr.detectChanges();
      },
      error: (e: HttpErrorResponse) => {
        this.isDynamicFormSaving = false;
        Swal.fire('ผิดพลาด', e.error?.message || 'เกิดข้อผิดพลาด', 'error');
        this.cdr.detectChanges();
      }
    });
  }

  resetDynamicForm() {
    const year = this.dynamicFormData.year_bh;
    const hospcode = this.dynamicFormData.hospcode;
    const indicator_id = this.dynamicFormData.indicator_id;
    this.dynamicFormData = { year_bh: year, hospcode, indicator_id };
  }

  editDynamicRow(row: any) {
    this.dynamicFormData = { ...row };
    this.dynamicFormTab = 'form';
    this.cdr.detectChanges();
  }

  deleteDynamicRow(row: any) {
    if (!this.dynamicFormSchema?.table_process) return;
    Swal.fire({
      title: 'ลบข้อมูล?',
      text: 'ต้องการลบรายการนี้ใช่หรือไม่?',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      confirmButtonText: 'ลบ',
      cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.authService.deleteDynamicData(this.dynamicFormSchema.table_process, row.id).subscribe({
          next: (res) => {
            if (res.success) {
              Swal.fire({ icon: 'success', title: 'ลบเรียบร้อย', timer: 1200, showConfirmButton: false });
              this.loadDynamicDataList();
            }
          }
        });
      }
    });
  }

  parseFieldOptions(raw: any): string[] {
    if (Array.isArray(raw)) return raw;
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  closeDynamicForm() {
    this.showDynamicFormModal = false;
    this.dynamicFormItem = null;
    this.dynamicFormSchema = null;
    this.dynamicFormData = {};
    this.dynamicDataList = [];
  }
}
