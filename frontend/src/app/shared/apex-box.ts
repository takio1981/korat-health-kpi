import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgApexchartsModule } from 'ng-apexcharts';

// แสดงกราฟ ApexCharts จาก options object เดียว (ไม่ต้อง bind ทีละ property ซ้ำทุกกราฟ)
@Component({
  selector: 'app-apex-box',
  standalone: true,
  imports: [CommonModule, NgApexchartsModule],
  template: `
    <apx-chart *ngIf="options?.series?.length; else empty"
      [series]="options.series" [chart]="options.chart" [xaxis]="options.xaxis" [yaxis]="options.yaxis"
      [labels]="options.labels" [colors]="options.colors" [dataLabels]="options.dataLabels"
      [plotOptions]="options.plotOptions" [legend]="options.legend" [stroke]="options.stroke"
      [fill]="options.fill" [tooltip]="options.tooltip" [title]="options.title" [subtitle]="options.subtitle"
      [annotations]="options.annotations" [grid]="options.grid" [markers]="options.markers"
      [states]="options.states" [responsive]="options.responsive ?? []"></apx-chart>
    <ng-template #empty>
      <div class="flex flex-col items-center justify-center py-12 text-gray-400">
        <i class="fas fa-chart-simple text-3xl mb-2"></i>
        <p class="text-sm font-bold">{{ emptyText }}</p>
      </div>
    </ng-template>
  `
})
export class ApexBoxComponent {
  @Input() options: any;
  @Input() emptyText = 'ไม่มีข้อมูลสำหรับตัวกรองที่เลือก';
}
