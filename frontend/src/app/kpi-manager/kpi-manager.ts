import { Component, OnInit, OnDestroy, AfterViewInit, inject, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth';
import { DbCompareComponent } from '../db-compare/db-compare';
import { FormBuilderComponent } from '../form-builder/form-builder';
import { ExportKpiComponent } from '../export-kpi/export-kpi';
import { ReportCompareComponent } from '../report-compare/report-compare';
import Swal from 'sweetalert2';

type WizardStep = 1 | 2 | 3;

@Component({
  selector: 'app-kpi-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, DbCompareComponent, FormBuilderComponent, ExportKpiComponent, ReportCompareComponent],
  templateUrl: './kpi-manager.html'
})
export class KpiManagerComponent implements OnInit, AfterViewInit, OnDestroy {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild(ReportCompareComponent) reportCmp?: ReportCompareComponent;
  @ViewChild(DbCompareComponent) dbCmp?: DbCompareComponent;
  @ViewChild(ExportKpiComponent) exportCmp?: ExportKpiComponent;

  // === Wizard state — 3 ขั้นลำดับชัดเจน (Sequential):
  //   ขั้น 1: เทียบชื่อตัวชี้วัด (Report Compare) — sync ชื่อจาก HDC → Local
  //   ขั้น 2: ส่งออกข้อมูล KPI ↔ HDC (DB Compare) — sync structure 2 ทิศทาง
  //   ขั้น 3: Export ข้อมูล KPI ลงตารางรายตัวชี้วัด — export data + sync HDC + schedule
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
      if (this.reportCmp) this.reportCmp.showGuide = false;
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
  step3Done: boolean = false;
  step1Summary: string = 'ยังไม่ได้เปรียบเทียบ';
  step2Summary: string = 'ยังไม่ได้เปรียบเทียบโครงสร้าง';
  step3Summary: string = 'ยังไม่ได้ส่งออก';

  private summaryPollHandle: any = null;
  private startSummaryPolling() {
    // Poll ทุก 1 วินาที — refresh status จาก sub-components
    if (this.summaryPollHandle) return;
    this.summaryPollHandle = setInterval(() => this.refreshStepStatus(), 1000);
  }
  private refreshStepStatus() {
    // Step 1 — Report Compare (เทียบชื่อ)
    const r = this.reportCmp?.compareResult?.summary;
    const newStep1Done = !!this.reportCmp?.compareResult;
    const newStep1Summary = r ? `ตรงกัน ${r.match} | ต่างกัน ${r.different} | ไม่มีใน Local ${r.missing_local}` : 'ยังไม่ได้เปรียบเทียบ';

    // Step 2 — DB Compare (เทียบโครงสร้างตาราง)
    const dbR = this.dbCmp?.compareResult?.summary;
    const newStep2Done = !!this.dbCmp?.compareResult;
    const newStep2Summary = dbR ? `Schema: ตรง ${dbR.match} | ต่าง ${dbR.different}` : 'ยังไม่ได้เปรียบเทียบโครงสร้าง';

    // Step 3 — Export KPI (ส่งออกตารางรายตัวชี้วัด)
    const expR = this.exportCmp?.exportResult?.summary;
    const newStep3Done = !!this.exportCmp?.exportResult;
    const newStep3Summary = expR ? `Export: เพิ่ม ${expR.inserted} | อัปเดต ${expR.updated}` : 'ยังไม่ได้ส่งออก';

    if (newStep1Done !== this.step1Done || newStep1Summary !== this.step1Summary
      || newStep2Done !== this.step2Done || newStep2Summary !== this.step2Summary
      || newStep3Done !== this.step3Done || newStep3Summary !== this.step3Summary) {
      this.step1Done = newStep1Done;
      this.step1Summary = newStep1Summary;
      this.step2Done = newStep2Done;
      this.step2Summary = newStep2Summary;
      this.step3Done = newStep3Done;
      this.step3Summary = newStep3Summary;
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
    if (this.currentStep < 3) this.goStep((this.currentStep + 1) as WizardStep);
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
