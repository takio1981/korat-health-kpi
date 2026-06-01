import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * Empty State — แทนข้อความว่างๆ ด้วย UI ที่บอกผู้ใช้ว่าควรทำอะไรต่อ
 *
 * <app-empty-state
 *   icon="fa-inbox"
 *   title="ยังไม่มีข้อมูล"
 *   description="เลือกตัวกรองเพื่อแสดงข้อมูล"
 *   actionLabel="เพิ่มตัวชี้วัด"
 *   (action)="onAddClick()"
 *   variant="primary">
 * </app-empty-state>
 */
@Component({
  selector: 'app-empty-state',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col items-center justify-center text-center px-6 py-12 sm:py-16">
      <div [ngClass]="iconWrapperClass" class="w-20 h-20 rounded-2xl flex items-center justify-center mb-4 shadow-sm">
        <i class="fas {{ icon }} text-3xl" [ngClass]="iconColorClass"></i>
      </div>
      <h3 class="text-lg font-bold text-gray-700 mb-2">{{ title }}</h3>
      <p *ngIf="description" class="text-sm text-gray-500 mb-5 max-w-md whitespace-pre-line">{{ description }}</p>
      <button *ngIf="actionLabel"
              (click)="action.emit()"
              [ngClass]="buttonClass"
              class="px-5 py-2.5 rounded-xl text-white text-sm font-bold shadow-md hover:shadow-lg transition-all flex items-center gap-2">
        <i *ngIf="actionIcon" class="fas {{ actionIcon }}"></i>
        {{ actionLabel }}
      </button>
      <button *ngIf="secondaryActionLabel"
              (click)="secondaryAction.emit()"
              class="mt-2 px-4 py-2 text-sm text-gray-500 hover:text-gray-700 hover:underline">
        {{ secondaryActionLabel }}
      </button>
    </div>
  `
})
export class EmptyStateComponent {
  @Input() icon: string = 'fa-inbox';
  @Input() title: string = 'ยังไม่มีข้อมูล';
  @Input() description: string = '';
  @Input() actionLabel: string = '';
  @Input() actionIcon: string = '';
  @Input() secondaryActionLabel: string = '';
  /** variant: primary (green), info (blue), warning (amber), neutral (gray) */
  @Input() variant: 'primary' | 'info' | 'warning' | 'neutral' = 'neutral';
  @Output() action = new EventEmitter<void>();
  @Output() secondaryAction = new EventEmitter<void>();

  get iconWrapperClass(): string {
    switch (this.variant) {
      case 'primary': return 'bg-green-100';
      case 'info':    return 'bg-blue-100';
      case 'warning': return 'bg-amber-100';
      default:        return 'bg-gray-100';
    }
  }
  get iconColorClass(): string {
    switch (this.variant) {
      case 'primary': return 'text-green-600';
      case 'info':    return 'text-blue-600';
      case 'warning': return 'text-amber-600';
      default:        return 'text-gray-400';
    }
  }
  get buttonClass(): string {
    switch (this.variant) {
      case 'primary': return 'bg-green-600 hover:bg-green-700';
      case 'info':    return 'bg-blue-600 hover:bg-blue-700';
      case 'warning': return 'bg-amber-500 hover:bg-amber-600';
      default:        return 'bg-gray-600 hover:bg-gray-700';
    }
  }
}
