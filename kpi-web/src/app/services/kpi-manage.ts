import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../services/auth';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-kpi-manage',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './kpi-manage.html'
})
export class KpiManageComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);

  activeTab: string = 'indicators'; // indicators, main-indicators, strategies, departments
  isSidebarOpen: boolean = true;
  currentUserDisplay: any = null;
  isAdmin: boolean = false;
  isSuperAdmin: boolean = false;
  systemVersion: string = 'v1.0.0';
  pendingKpiCount: number = 0;

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

  // Modal
  showModal: boolean = false;
  isEditMode: boolean = false;
  currentItem: any = {};

  ngOnInit() {
    this.currentUserDisplay = this.authService.getUser();
    const role = this.authService.getUserRole();
    this.isAdmin = role === 'admin' || role === 'super_admin';
    this.isSuperAdmin = role === 'super_admin';

    if (!this.isAdmin) {
      this.router.navigate(['/dashboard']);
      return;
    }
    this.loadSettings();
    this.loadAllData();
    this.loadPendingKpiCount();
  }

  loadSettings() {
    this.authService.getSettings().subscribe({
      next: (res) => {
        if (res.success && res.data) {
          const versionSetting = res.data.find((s: any) => s.setting_key === 'system_version');
          if (versionSetting) this.systemVersion = versionSetting.setting_value;
        }
      }
    });
  }

  loadPendingKpiCount() {
    this.authService.getKpiResults().subscribe({
      next: (res) => {
        if (res.success) {
          this.pendingKpiCount = res.data.filter((item: any) => item.indicator_status === 'pending').length;
        }
      }
    });
  }

  loadAllData() {
    this.authService.getIndicators().subscribe(res => { 
      if(res.success) { 
        this.indicators = res.data; 
        this.filteredIndicators = [...this.indicators]; // แสดงข้อมูลทันที
        if (this.activeTab === 'indicators') this.applyFilter();
      } 
    });
    this.authService.getMainIndicators().subscribe(res => { 
      if(res.success) { 
        this.mainIndicators = res.data; 
        this.filteredMainIndicators = [...this.mainIndicators]; // แสดงข้อมูลทันที
        if (this.activeTab === 'main-indicators') this.applyFilter();
      } 
    });
    this.authService.getMainYut().subscribe(res => { 
      if(res.success) { 
        this.strategies = res.data; 
        this.filteredStrategies = [...this.strategies]; // แสดงข้อมูลทันที
        if (this.activeTab === 'strategies') this.applyFilter();
      } 
    });
    this.authService.getDepartments().subscribe(res => { 
      if(res.success) { 
        this.departments = res.data; 
        this.filteredDepartments = [...this.departments]; // แสดงข้อมูลทันที
        if (this.activeTab === 'departments') this.applyFilter();
      } 
    });
  }

  applyFilter() {
    const search = this.searchTerm.toLowerCase();
    if (this.activeTab === 'indicators') {
      this.filteredIndicators = this.indicators.filter(i => 
        (i.kpi_indicators_name && i.kpi_indicators_name.toLowerCase().includes(search)) ||
        (i.kpi_indicators_code && i.kpi_indicators_code.toLowerCase().includes(search))
      );
    } else if (this.activeTab === 'main-indicators') {
      this.filteredMainIndicators = this.mainIndicators.filter(i => 
        i.main_indicator_name && i.main_indicator_name.toLowerCase().includes(search)
      );
    } else if (this.activeTab === 'strategies') {
      this.filteredStrategies = this.strategies.filter(s => 
        s.yut_name && s.yut_name.toLowerCase().includes(search)
      );
    } else if (this.activeTab === 'departments') {
      this.filteredDepartments = this.departments.filter(d => 
        (d.dept_name && d.dept_name.toLowerCase().includes(search)) ||
        (d.dept_code && d.dept_code.toLowerCase().includes(search))
      );
    }
  }

  switchTab(tab: string) {
    this.activeTab = tab;
    this.searchTerm = '';
    this.loadAllData(); // Reload data to ensure freshness
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
            },
            error: () => Swal.fire('ผิดพลาด', 'ไม่สามารถลบข้อมูลได้ (อาจมีการใช้งานอยู่)', 'error')
          });
        }
      }
    });
  }

  toggleSidebar() { this.isSidebarOpen = !this.isSidebarOpen; }
  logout() { this.authService.logout(); this.router.navigate(['/login']); }
}