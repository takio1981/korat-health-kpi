import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SettingsComponent, SETTINGS_SECTIONS, activeSectionAt } from './settings';
import { testProviders } from '../testing/test-providers';

describe('SettingsComponent', () => {
  let component: SettingsComponent;
  let fixture: ComponentFixture<SettingsComponent>;

  const setup = async (role: string) => {
    localStorage.setItem('kpi_user', JSON.stringify({ role }));
    localStorage.setItem('kpi_token', 'x.' + btoa(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 })) + '.y');
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: testProviders,
    }).compileComponents();
    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
  };
  afterEach(() => { localStorage.removeItem('kpi_user'); localStorage.removeItem('kpi_token'); });

  it('should create', async () => {
    await setup('super_admin');
    expect(component).toBeTruthy();
  });

  it('เมนูหัวข้อ: ทุกหัวข้อมีส่วนในหน้าจริง (super_admin) และกดแล้วเลื่อนไปหัวข้อนั้น', async () => {
    await setup('super_admin');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const ids = Array.from(el.querySelectorAll('[data-settings-section]')).map(e => e.id.replace('set-', ''));
    expect(ids).toEqual(SETTINGS_SECTIONS.map(s => s.id));   // ลำดับในเมนู = ลำดับในหน้า
    expect(el.querySelectorAll('#settings-nav .settings-nav-item').length).toBe(SETTINGS_SECTIONS.length);
    const target = el.querySelector('#set-appeal') as HTMLElement;
    const spy = vi.fn(); (target as any).scrollIntoView = spy;
    component.scrollToSection('appeal');
    expect(spy).toHaveBeenCalled();
    expect(component.activeSection).toBe('appeal');
    expect(component.activeLabel).toBe('ระบบอุทธรณ์');
  });

  it('ไม่ใช่ super_admin: เมนูไม่มีหัวข้อเฉพาะผู้ดูแลระบบสูงสุด และทุกหัวข้อในเมนูมีในหน้า', async () => {
    await setup('admin_ssj');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(component.visibleSections.some(s => s.id === 'ai')).toBe(false);
    for (const s of component.visibleSections) expect(el.querySelector('#set-' + s.id)).toBeTruthy();
  });

  it('activeSectionAt: หัวข้อสุดท้ายที่ผ่านเส้นบน / เลื่อนสุด = หัวข้อสุดท้าย', () => {
    const box = document.createElement('div');
    const tops: Record<string, number> = { a: 0, b: 100, c: 400 };
    for (const id of Object.keys(tops)) {
      const s = document.createElement('div'); s.id = 'set-' + id;
      (s as any).getBoundingClientRect = () => ({ top: tops[id] });
      box.appendChild(s);
    }
    (box as any).getBoundingClientRect = () => ({ top: 0 });
    Object.defineProperty(box, 'scrollHeight', { value: 2000 });
    Object.defineProperty(box, 'clientHeight', { value: 500 });
    expect(activeSectionAt(box, ['a', 'b', 'c'])).toBe('b');
    Object.defineProperty(box, 'scrollTop', { value: 1500 });
    expect(activeSectionAt(box, ['a', 'b', 'c'])).toBe('c');
    expect(activeSectionAt(box, [])).toBeNull();
  });
});
