import { Directive, ElementRef, Input, AfterViewInit, OnChanges, SimpleChanges } from '@angular/core';

// ตั้งค่า scrollLeft ของ element หลัง view ready + เมื่อค่า input เปลี่ยน
// ใช้สำหรับเลื่อน scrollbar ไปยังตำแหน่งเริ่มต้น (เช่น เดือนล่าสุดที่มีข้อมูลใน mobile card)
@Directive({
  selector: '[initScrollLeft]',
  standalone: true,
})
export class InitScrollLeftDirective implements AfterViewInit, OnChanges {
  @Input('initScrollLeft') scrollLeft: number = 0;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    this.apply();
  }

  ngOnChanges(_: SimpleChanges): void {
    this.apply();
  }

  private apply(): void {
    queueMicrotask(() => {
      const el = this.el.nativeElement;
      if (el) el.scrollLeft = this.scrollLeft || 0;
    });
  }
}
