import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-kpi-manage',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './kpi-manage.html'
})
export class KpiManageComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  activeTab: string = 'indicators';
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;

  // Data Lists
  indicators: any[] = [];
  mainIndicators: any[] = [];
  strategies: any[] = [];
  departments: any[] = [];

  // Filtered Lists
  filteredIndicators: any[] = [];
  filteredMainIndicators: any[] = [];
  filteredStrategies: any[] = [];
  filteredDepartments: any[] = [];
  searchTerm: string = '';
  filterActive: string = ''; // '' = ทั้งหมด, '1' = เปิดใช้งาน, '0' = ปิดใช้งาน

  // Modal
  showModal: boolean = false;
  isEditMode: boolean = false;
  currentItem: any = {};

  // Sub-Indicator Modal
  showSubModal: boolean = false;
  subParentIndicator: any = null;
  subList: any[] = [];
  subCurrent: any = {};
  isSubEdit: boolean = false;
  showSubForm: boolean = false;
  // นับจำนวน sub-indicator ต่อ indicator_id (แสดงบาดจ์บนแถว)
  subCountMap: Map<number, number> = new Map();

  ngOnInit() {
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin_ssj' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';
    if (!this.isAdmin) {
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadAllData();
  }

  loadAllData() {
    this.authService.getIndicators().subscribe(res => {
      if(res.success) {
        this.indicators = res.data;
        this.filteredIndicators = [...this.indicators];
        if (this.activeTab === 'indicators') this.applyFilter();
      }
      this.cdr.detectChanges();
    });
    this.authService.getMainIndicators().subscribe(res => {
      if(res.success) {
        this.mainIndicators = res.data;
        this.filteredMainIndicators = [...this.mainIndicators];
        if (this.activeTab === 'main-indicators') this.applyFilter();
      }
      this.cdr.detectChanges();
    });
    this.authService.getMainYut().subscribe(res => {
      if(res.success) {
        this.strategies = res.data;
        this.filteredStrategies = [...this.strategies];
        if (this.activeTab === 'strategies') this.applyFilter();
      }
      this.cdr.detectChanges();
    });
    this.authService.getDepartments().subscribe(res => {
      if(res.success) {
        this.departments = res.data;
        this.filteredDepartments = [...this.departments];
        if (this.activeTab === 'departments') this.applyFilter();
      }
      this.cdr.detectChanges();
    });
    // โหลด sub-indicator count ทั้งหมด
    this.authService.getSubIndicators().subscribe(res => {
      if (res.success) {
        this.subCountMap.clear();
        for (const s of res.data) {
          this.subCountMap.set(s.indicator_id, (this.subCountMap.get(s.indicator_id) || 0) + 1);
        }
        this.cdr.detectChanges();
      }
    });
  }

  getSubCount(indicatorId: number): number {
    return this.subCountMap.get(indicatorId) || 0;
  }

  // === Sub-Indicator Modal ===
  openSubModal(indicator: any) {
    this.subParentIndicator = indicator;
    this.showSubModal = true;
    this.showSubForm = false;
    this.subCurrent = {};
    this.isSubEdit = false;
    this.loadSubList(indicator.id);
  }

  closeSubModal() {
    this.showSubModal = false;
    this.subParentIndicator = null;
    this.subList = [];
  }

  loadSubList(indicatorId: number) {
    this.authService.getSubIndicators(indicatorId).subscribe(res => {
      if (res.success) {
        this.subList = res.data;
        this.cdr.detectChanges();
      }
    });
  }

  openSubForm(item: any = null) {
    this.isSubEdit = !!item;
    this.subCurrent = item ? { ...item } : { indicator_id: this.subParentIndicator.id, weight: 1 };
    this.showSubForm = true;
  }

  saveSub() {
    if (!this.subCurrent.sub_indicator_name) {
      Swal.fire('ข้อมูลไม่ครบ', 'กรุณากรอกชื่อตัวชี้วัดย่อย', 'warning');
      return;
    }
    const obs = this.isSubEdit
      ? this.authService.updateSubIndicator(this.subCurrent.id, this.subCurrent)
      : this.authService.createSubIndicator(this.subCurrent);
    obs.subscribe({
      next: (res: any) => {
        if (res.success) {
          Swal.fire({ icon: 'success', title: 'สำเร็จ', timer: 1500, showConfirmButton: false });
          this.showSubForm = false;
          this.loadSubList(this.subParentIndicator.id);
          this.loadAllData();
        }
      },
      error: (e: any) => Swal.fire('ผิดพลาด', e.error?.message || 'ไม่สามารถบันทึกได้', 'error')
    });
  }

  deleteSub(id: number) {
    Swal.fire({
      title: 'ยืนยันลบตัวชี้วัดย่อย', icon: 'warning',
      showCancelButton: true, confirmButtonColor: '#d33',
      confirmButtonText: 'ลบ', cancelButtonText: 'ยกเลิก'
    }).then(r => {
      if (r.isConfirmed) {
        this.authService.deleteSubIndicator(id).subscribe({
          next: (res: any) => {
            if (res.success) {
              this.loadSubList(this.subParentIndicator.id);
              this.loadAllData();
            }
          }
        });
      }
    });
  }

  toggleSubActive(item: any) {
    const newStatus = !item.is_active || item.is_active === 0;
    this.authService.toggleSubIndicatorActive(item.id, newStatus).subscribe({
      next: (res: any) => { if (res.success) { item.is_active = newStatus ? 1 : 0; this.cdr.detectChanges(); } }
    });
  }

  applyFilter() {
    const search = this.searchTerm.toLowerCase();
    const activeFilter = this.filterActive;

    const matchActive = (item: any) => {
      if (activeFilter === '') return true;
      const isActive = item.is_active !== undefined ? Number(item.is_active) : 1;
      return activeFilter === '1' ? isActive === 1 : isActive === 0;
    };

    if (this.activeTab === 'indicators') {
      this.filteredIndicators = this.indicators.filter(i =>
        matchActive(i) && (
          (i.kpi_indicators_name && i.kpi_indicators_name.toLowerCase().includes(search)) ||
          (i.kpi_indicators_code && i.kpi_indicators_code.toLowerCase().includes(search))
        )
      );
    } else if (this.activeTab === 'main-indicators') {
      this.filteredMainIndicators = this.mainIndicators.filter(i =>
        matchActive(i) && i.main_indicator_name && i.main_indicator_name.toLowerCase().includes(search)
      );
    } else if (this.activeTab === 'strategies') {
      this.filteredStrategies = this.strategies.filter(s =>
        matchActive(s) && s.yut_name && s.yut_name.toLowerCase().includes(search)
      );
    } else if (this.activeTab === 'departments') {
      this.filteredDepartments = this.departments.filter(d =>
        matchActive(d) && (
          (d.dept_name && d.dept_name.toLowerCase().includes(search)) ||
          (d.dept_code && d.dept_code.toLowerCase().includes(search))
        )
      );
    }
    this.cdr.detectChanges();
  }

  switchTab(tab: string) {
    this.activeTab = tab;
    this.searchTerm = '';
    this.filterActive = '';
    this.applyFilter();
  }

  openModal(item: any = null) {
    this.isEditMode = !!item;
    this.currentItem = item ? { ...item } : {};
    this.showModal = true;
  }

  closeModal() {
    this.showModal = false;
    this.currentItem = {};
  }

  saveItem() {
    let observable;
    const id = this.currentItem.id;

    if (this.activeTab === 'indicators') {
      observable = this.isEditMode ? this.authService.updateIndicator(id, this.currentItem) : this.authService.createIndicator(this.currentItem);
    } else if (this.activeTab === 'main-indicators') {
      observable = this.isEditMode ? this.authService.updateMainIndicator(id, this.currentItem) : this.authService.createMainIndicator(this.currentItem);
    } else if (this.activeTab === 'strategies') {
      observable = this.isEditMode ? this.authService.updateMainYut(id, this.currentItem) : this.authService.createMainYut(this.currentItem);
    } else if (this.activeTab === 'departments') {
      observable = this.isEditMode ? this.authService.updateDepartment(id, this.currentItem) : this.authService.createDepartment(this.currentItem);
    }

    if (observable) {
      observable.subscribe({
        next: (res) => {
          if (res.success) {
            Swal.fire('สำเร็จ', 'บันทึกข้อมูลเรียบร้อย', 'success');
            this.closeModal();
            this.loadAllData();
          }
          this.cdr.detectChanges();
        },
        error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถบันทึกข้อมูลได้', 'error')
      });
    }
  }

  deleteItem(id: number) {
    Swal.fire({
      title: 'ยืนยันการลบ',
      text: "คุณต้องการลบข้อมูลนี้ใช่หรือไม่?",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#d33',
      confirmButtonText: 'ลบ',
      cancelButtonText: 'ยกเลิก'
    }).then((result) => {
      if (result.isConfirmed) {
        let observable;
        if (this.activeTab === 'indicators') observable = this.authService.deleteIndicator(id);
        else if (this.activeTab === 'main-indicators') observable = this.authService.deleteMainIndicator(id);
        else if (this.activeTab === 'strategies') observable = this.authService.deleteMainYut(id);
        else if (this.activeTab === 'departments') observable = this.authService.deleteDepartment(id);

        if (observable) {
          observable.subscribe({
            next: (res) => {
              if (res.success) {
                Swal.fire('ลบสำเร็จ', 'ข้อมูลถูกลบแล้ว', 'success');
                this.loadAllData();
              }
              this.cdr.detectChanges();
            },
            error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถลบข้อมูลได้ (อาจมีการใช้งานอยู่)', 'error')
          });
        }
      }
    });
  }

  toggleActive(item: any) {
    const newStatus = !item.is_active || item.is_active === 0;
    let observable;

    if (this.activeTab === 'indicators') {
      observable = this.authService.toggleIndicatorActive(item.id, newStatus);
    } else if (this.activeTab === 'main-indicators') {
      observable = this.authService.toggleMainIndicatorActive(item.id, newStatus);
    } else if (this.activeTab === 'strategies') {
      observable = this.authService.toggleStrategyActive(item.id, newStatus);
    } else if (this.activeTab === 'departments') {
      observable = this.authService.toggleDepartmentActive(item.id, newStatus);
    }

    if (observable) {
      observable.subscribe({
        next: (res) => {
          if (res.success) {
            item.is_active = newStatus ? 1 : 0;
            this.applyFilter();
          }
        },
        error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถเปลี่ยนสถานะได้', 'error')
      });
    }
  }

  getActiveCount(): number {
    if (this.activeTab === 'indicators') return this.indicators.filter(i => Number(i.is_active) === 1).length;
    if (this.activeTab === 'main-indicators') return this.mainIndicators.filter(i => Number(i.is_active) === 1).length;
    if (this.activeTab === 'strategies') return this.strategies.filter(i => Number(i.is_active) === 1).length;
    if (this.activeTab === 'departments') return this.departments.filter(i => Number(i.is_active) === 1).length;
    return 0;
  }

  getInactiveCount(): number {
    if (this.activeTab === 'indicators') return this.indicators.filter(i => Number(i.is_active) === 0).length;
    if (this.activeTab === 'main-indicators') return this.mainIndicators.filter(i => Number(i.is_active) === 0).length;
    if (this.activeTab === 'strategies') return this.strategies.filter(i => Number(i.is_active) === 0).length;
    if (this.activeTab === 'departments') return this.departments.filter(i => Number(i.is_active) === 0).length;
    return 0;
  }
}
