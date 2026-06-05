import { Component, OnInit, OnDestroy, AfterViewInit, inject, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { DbCompareComponent } from '../db-compare/db-compare';
import { FormBuilderComponent } from '../form-builder/form-builder';
import { ExportKpiComponent } from '../export-kpi/export-kpi';
import Swal from 'sweetalert2';

// ขั้น 1: เทียบโครงสร้างตาราง (DB Compare) — เดิมเป็นขั้น 2
// ขั้น 2: Export ข้อมูล KPI ลงตารางรายตัวชี้วัด — เดิมเป็นขั้น 3
// (เทียบชื่อตัวชี้วัด ย้ายไป kpi-manage แล้ว)
type WizardStep = 1 | 2;

@Component({
  selector: 'app-kpi-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, DbCompareComponent, FormBuilderComponent, ExportKpiComponent],
  templateUrl: './kpi-manager.html'
})
export class KpiManagerComponent implements OnInit, AfterViewInit, OnDestroy {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild(DbCompareComponent) dbCmp?: DbCompareComponent;
  @ViewChild(ExportKpiComponent) exportCmp?: ExportKpiComponent;

  // === Wizard state — 2 ขั้น (Report Compare ย้ายไป kpi-manage แล้ว)
  //   ขั้น 1: ส่งออกข้อมูล KPI ↔ HDC (DB Compare) — sync structure 2 ทิศทาง
  //   ขั้น 2: Export ข้อมูล KPI ลงตารางรายตัวชี้วัด — export data + sync HDC + schedule
  currentStep: WizardStep = 1;
  showWorkflowGuide: boolean = false;

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
      if (this.dbCmp) this.dbCmp.showGuide = false;
      if (this.exportCmp) {
        this.exportCmp.showGuide = false;
        this.exportCmp.showSyncGuide = false;
      }
      this.cdr.detectChanges();
    }, 0);
    // เริ่ม polling เพื่อ refresh step summary จาก sub-components
    this.startSummaryPolling();
  }

  // === Step status — เก็บใน property แทน getter เพื่อกัน NG0100 (ExpressionChanged...AfterChecked) ===
  step1Done: boolean = false;
  step2Done: boolean = false;
  step1Summary: string = 'ยังไม่ได้เปรียบเทียบโครงสร้าง';
  step2Summary: string = 'ยังไม่ได้ส่งออก';

  private summaryPollHandle: any = null;
  private startSummaryPolling() {
    if (this.summaryPollHandle) return;
    this.summaryPollHandle = setInterval(() => this.refreshStepStatus(), 1000);
  }
  private refreshStepStatus() {
    // Step 1 — DB Compare (เทียบโครงสร้างตาราง)
    const dbR = this.dbCmp?.compareResult?.summary;
    const newStep1Done = !!this.dbCmp?.compareResult;
    const newStep1Summary = dbR ? `Schema: ตรง ${dbR.match} | ต่าง ${dbR.different}` : 'ยังไม่ได้เปรียบเทียบโครงสร้าง';

    // Step 2 — Export KPI (ส่งออกตารางรายตัวชี้วัด)
    const expR = this.exportCmp?.exportResult?.summary;
    const newStep2Done = !!this.exportCmp?.exportResult;
    const newStep2Summary = expR ? `Export: เพิ่ม ${expR.inserted} | อัปเดต ${expR.updated}` : 'ยังไม่ได้ส่งออก';

    if (newStep1Done !== this.step1Done || newStep1Summary !== this.step1Summary
      || newStep2Done !== this.step2Done || newStep2Summary !== this.step2Summary) {
      this.step1Done = newStep1Done;
      this.step1Summary = newStep1Summary;
      this.step2Done = newStep2Done;
      this.step2Summary = newStep2Summary;
      this.cdr.detectChanges();
    }
  }

  ngOnDestroy() {
    if (this.summaryPollHandle) clearInterval(this.summaryPollHandle);
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
