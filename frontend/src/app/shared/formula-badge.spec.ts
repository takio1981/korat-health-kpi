import { TestBed } from '@angular/core/testing';
import { FormulaBadgeComponent } from './formula-badge';

describe('FormulaBadgeComponent', () => {
  function render(formula: any): HTMLElement {
    const fixture = TestBed.createComponent(FormulaBadgeComponent);
    fixture.componentRef.setInput('formula', formula);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [FormulaBadgeComponent] }).compileComponents();
  });

  it('มีสูตร → แสดงไอคอนเครื่องคิดเลข + ตัวสูตร (tooltip = สูตรเต็ม)', () => {
    const el = render('  SUM(ALL) / target * 100 ');
    expect(el.querySelector('i.fa-calculator')).toBeTruthy();
    expect(el.textContent).toContain('SUM(ALL) / target * 100');
    expect(el.querySelector('span')?.getAttribute('title')).toBe('ผลงานคำนวณตามสูตร: SUM(ALL) / target * 100');
  });

  it('ไม่มีสูตร (null / ว่าง / undefined) → ไม่แสดงอะไรเลย', () => {
    for (const v of [null, undefined, '', '   ']) {
      const el = render(v);
      expect(el.querySelector('span')).toBeNull();
      expect((el.textContent || '').trim()).toBe('');
    }
  });
});
