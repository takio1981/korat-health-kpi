import { Component, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { DbCompareComponent } from '../db-compare/db-compare';
import { FormBuilderComponent } from '../form-builder/form-builder';
import { ExportKpiComponent } from '../export-kpi/export-kpi';
import { ReportCompareComponent } from '../report-compare/report-compare';
import Swal from 'sweetalert2';

@Component({
  selector: 'app-kpi-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, DbCompareComponent, FormBuilderComponent, ExportKpiComponent, ReportCompareComponent],
  templateUrl: './kpi-manager.html'
})
export class KpiManagerComponent implements OnInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  activeTab: 'db-compare' | 'form-builder' | 'export' | 'report-compare' = 'db-compare';

  // สำหรับส่ง columns จาก DB Compare → Form Builder
  hdcColumnsForForm: any[] = [];
  hdcTableName: string = '';
  hdcIndicatorName: string = '';

  ngOnInit() {
    if (this.authService.getUserRole() !== 'super_admin') {
      Swal.fire('Access Denied', 'super_admin เท่านั้น', 'error');
      this.router.navigate(['/dashboard']);
    }
  }

  // trigger counter เพื่อให้ ngOnChanges ทำงานทุกครั้ง แม้เลือกตารางเดิมซ้ำ
  hdcTrigger: number = 0;

  // เรียกจาก DB Compare → เลือก columns → ส่งไป Form Builder
  onCreateFormFromHDC(data: { table: string, name: string, columns: any[] }) {
    this.hdcTableName = data.table;
    this.hdcIndicatorName = data.name;
    this.hdcColumnsForForm = data.columns;
    this.hdcTrigger++;
    this.activeTab = 'form-builder';
    this.cdr.detectChanges();
  }

  clearHdcColumns() {
    this.hdcColumnsForForm = [];
    this.hdcTableName = '';
    this.hdcIndicatorName = '';
  }
}
