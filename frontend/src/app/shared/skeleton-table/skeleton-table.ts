import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Skeleton loader สำหรับตาราง (และ list)
 *
 * ใช้แทน Swal.fire({ title: 'กำลังโหลด...' }) — แสดง shimmer ใน UI จริง
 * ทำให้ user รู้สึกระบบเร็ว ไม่ต้องรอ modal ปิดก่อนถึงเห็นข้อมูล
 *
 * <app-skeleton-table [rows]="8" [cols]="6"></app-skeleton-table>
 */
@Component({
  selector: 'app-skeleton-table',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="w-full animate-pulse">
      <!-- Header row -->
      <div *ngIf="showHeader" class="flex gap-2 mb-2 px-2 py-3 bg-gray-100/70 rounded-t-lg">
        <div *ngFor="let _ of colArr" class="h-3 bg-gray-300 rounded flex-1"></div>
      </div>
      <!-- Body rows -->
      <div *ngFor="let r of rowArr; let i = index"
           class="flex gap-2 px-2 py-3 border-b border-gray-100"
           [style.opacity]="1 - i * 0.06">
        <div *ngFor="let c of colArr"
             class="h-3 bg-gray-200 rounded flex-1"
             [style.width.%]="50 + ((i + c) * 13) % 50"></div>
      </div>
    </div>
  `
})
export class SkeletonTableComponent {
  @Input() rows: number = 8;
  @Input() cols: number = 5;
  @Input() showHeader: boolean = true;

  get rowArr() { return Array(this.rows).fill(0); }
  get colArr() { return Array(this.cols).fill(0).map((_, i) => i); }
}
