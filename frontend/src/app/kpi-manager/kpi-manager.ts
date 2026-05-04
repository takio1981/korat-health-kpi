import { Component, OnInit, AfterViewInit, inject, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { DbCompareComponent } from '../db-compare/db-compare';
import { FormBuilderComponent } from '../form-builder/form-builder';
import { ExportKpiComponent } from '../export-kpi/export-kpi';
import { ReportCompareComponent } from '../report-compare/report-compare';
import Swal from 'sweetalert2';

type WizardStep = 1 | 2;

@Component({
  selector: 'app-kpi-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, DbCompareComponent, FormBuilderComponent, ExportKpiComponent, ReportCompareComponent],
  templateUrl: './kpi-manager.html'
})
export class KpiManagerComponent implements OnInit, AfterViewInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild(ReportCompareComponent) reportCmp?: ReportCompareComponent;
  @ViewChild(DbCompareComponent) dbCmp?: DbCompareComponent;
  @ViewChild(ExportKpiComponent) exportCmp?: ExportKpiComponent;

  // === Wizard state — 2 ขั้น (รวม DB Compare + Export เข้าเป็น "ส่งออกข้อมูล KPI ↔ HDC") ===
  currentStep: WizardStep = 1;
  showWorkflowGuide: boolean = true;

  // ข้อมูล HDC สำหรับส่งจาก DB Compare → Form Builder (embedded)
  hdcColumnsForForm: any[] = [];
  hdcTableName: string = '';
  hdcIndicatorName: string = '';
  hdcTrigger: number = 0;

  ngOnInit() {
    if (this.authService.getUserRole() !== 'super_admin') {
      Swal.fire('Access Denied', 'super_admin เท่านั้น', 'error');
      this.router.navigate(['/dashboard']);
    }
  }

  ngAfterViewInit() {
    // ปิด guide ภายในของ sub-components — ใช้ guide รวมที่ kpi-manager แทน
    setTimeout(() => {
      if (this.reportCmp) this.reportCmp.showGuide = false;
      if (this.dbCmp) this.dbCmp.showGuide = false;
      if (this.exportCmp) {
        this.exportCmp.showGuide = false;
        this.exportCmp.showSyncGuide = false;
      }
      this.cdr.detectChanges();
    }, 0);
  }

  // === Step status (auto-detect จาก state ของ sub-components) ===
  get step1Done(): boolean { return !!this.reportCmp?.compareResult; }
  // step 2 done = ทำ phase A (DB compare) **หรือ** phase B (export) ก็ถือว่าเริ่มแล้ว
  get step2Done(): boolean { return !!this.dbCmp?.compareResult || !!this.exportCmp?.exportResult; }

  get step1Summary(): string {
    const r = this.reportCmp?.compareResult?.summary;
    if (!r) return 'ยังไม่ได้เปรียบเทียบ';
    return `ตรงกัน ${r.match} | ต่างกัน ${r.different} | ไม่มีใน Local ${r.missing_local}`;
  }
  get step2Summary(): string {
    const dbR = this.dbCmp?.compareResult?.summary;
    const expR = this.exportCmp?.exportResult?.summary;
    const parts: string[] = [];
    if (dbR) parts.push(`Schema: ตรง ${dbR.match} | ต่าง ${dbR.different}`);
    if (expR) parts.push(`Export: เพิ่ม ${expR.inserted} | อัปเดต ${expR.updated}`);
    return parts.length === 0 ? 'ยังไม่ได้ดำเนินการ' : parts.join(' • ');
  }

  // === Navigation ===
  goStep(step: WizardStep) {
    this.currentStep = step;
    this.cdr.detectChanges();
    // เลื่อนไป content area เพื่อให้ user เห็นทันที
    setTimeout(() => {
      const el = document.getElementById('wizard-section-content');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  }

  nextStep() {
    if (this.currentStep < 2) this.goStep((this.currentStep + 1) as WizardStep);
  }

  prevStep() {
    if (this.currentStep > 1) this.goStep((this.currentStep - 1) as WizardStep);
  }

  // === DB Compare → Form Builder (embedded) ===
  onCreateFormFromHDC(data: { table: string, name: string, columns: any[] }) {
    this.hdcTableName = data.table;
    this.hdcIndicatorName = data.name;
    this.hdcColumnsForForm = data.columns;
    this.hdcTrigger++;
    this.cdr.detectChanges();
  }

  clearHdcColumns() {
    this.hdcColumnsForForm = [];
    this.hdcTableName = '';
    this.hdcIndicatorName = '';
  }
}
