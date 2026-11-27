import { Component, OnInit, AfterViewInit, inject, ChangeDetectorRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../services/auth';
import { FormBuilderComponent } from '../form-builder/form-builder';
import { ExportKpiComponent } from '../export-kpi/export-kpi';
import Swal from 'sweetalert2';

// 27 พ.ย. 2569 (ผู้ใช้สั่ง): รวม "ส่งออกข้อมูล KPI ↔ KHD" (เทียบโครงสร้าง) กับ "Export ลงตารางรายตัวชี้วัด" เป็นหน้าเดียว ตารางเดียว
// — เดิมเป็น wizard 2 ขั้น และปุ่ม "สร้างตาราง" ของขั้นที่ 1 คัดลอกโครงสร้างจากอีกฝั่งเท่านั้น (ตารางที่ยังไม่มีทั้งสองฝั่งสร้างไม่ได้)
// ตอนนี้การส่งออกสร้างตารางในระบบให้เอง และตารางใน KHD สร้าง/เพิ่มคอลัมน์จากตารางเดียวกัน (export-kpi)
@Component({
  selector: 'app-kpi-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, FormBuilderComponent, ExportKpiComponent],
  templateUrl: './kpi-manager.html'
})
export class KpiManagerComponent implements OnInit, AfterViewInit {
  private authService = inject(AuthService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  @ViewChild(ExportKpiComponent) exportCmp?: ExportKpiComponent;

  showWorkflowGuide: boolean = false;

  // ข้อมูล KHD สำหรับส่งเข้า Form Builder (embedded)
  khdColumnsForForm: any[] = [];
  khdTableName: string = '';
  khdIndicatorName: string = '';
  khdTrigger: number = 0;

  ngOnInit() {
    // ใช้ canAccessPage() ให้ตรงกับ pageAccessGuard (ระบบ Role × Page Access) — ไม่เช็ค role ตรง
    if (!this.authService.canAccessPage('kpi-manager')) {
      Swal.fire('Access Denied', 'ไม่มีสิทธิ์เข้าถึงหน้านี้', 'error');
      this.router.navigate(['/dashboard']);
    }
  }

  ngAfterViewInit() {
    // ใช้คำแนะนำรวมของหน้านี้แทนคำแนะนำภายในคอมโพเนนต์ส่งออก
    setTimeout(() => {
      if (this.exportCmp) { this.exportCmp.showGuide = false; this.exportCmp.showSyncGuide = false; }
      this.cdr.detectChanges();
    }, 0);
  }

  // === ตาราง KHD → Form Builder (embedded) ===
  onCreateFormFromKhd(data: { table: string, name: string, columns: any[] }) {
    this.khdTableName = data.table;
    this.khdIndicatorName = data.name;
    this.khdColumnsForForm = data.columns;
    this.khdTrigger++;
    this.cdr.detectChanges();
  }

  clearKhdColumns() {
    this.khdColumnsForForm = [];
    this.khdTableName = '';
    this.khdIndicatorName = '';
  }
}
