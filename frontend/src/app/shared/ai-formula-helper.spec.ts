import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { AiFormulaHelperComponent } from './ai-formula-helper';

// "ให้ AI ช่วยเขียนสูตร" (ผู้ช่วย AI ระยะที่ 2 — 7 พ.ย. 2569)
describe('AiFormulaHelperComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [AiFormulaHelperComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  const make = (enabled: boolean, inputs: Record<string, any> = {}) => {
    const f = TestBed.createComponent(AiFormulaHelperComponent);
    Object.entries(inputs).forEach(([k, v]) => f.componentRef.setInput(k, v));
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled });
    f.detectChanges();
    return f;
  };

  it('ผู้ช่วย AI ปิดอยู่ = ไม่แสดงปุ่ม', () => {
    expect(make(false).nativeElement.textContent).not.toContain('ให้ AI ช่วยเขียนสูตร');
  });

  it('ส่งคำอธิบาย + ค่าเพิ่มเติม (ตัดแถวว่าง) + เงื่อนไข → แสดงสูตร → "ใช้สูตรนี้" ส่งสูตรออกและปิดกล่อง', () => {
    const f = make(true, { kind: 'pct', customVars: [{ key: 'pop', label: 'ประชากร' }, { key: '', label: '' }], targetCondition: 'LTE', indicatorName: 'อัตราตาย' });
    const c = f.componentInstance;
    let applied = '';
    c.apply.subscribe((v: string) => applied = v);
    c.open = true;
    c.description = 'อัตราต่อแสนประชากร';
    c.suggest();
    const req = http.expectOne(r => r.url.endsWith('/ai/formula-suggest'));
    expect(req.request.body).toEqual({ description: 'อัตราต่อแสนประชากร', kind: 'pct', custom_vars: [{ key: 'pop', label: 'ประชากร' }], target_condition: 'LTE', indicator_name: 'อัตราตาย' });
    req.flush({ success: true, formula: 'result / pop * 100000', explanation: 'ต่อแสนประชากร', attempts: 1 });
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('result / pop * 100000');
    expect(f.nativeElement.textContent).toContain('ข้อความจาก AI');
    c.use();
    expect(applied).toBe('result / pop * 100000');
    expect(c.open).toBe(false);
  });

  it('AI เสนอสูตรที่ใช้ไม่ได้ = แสดงข้อความจากระบบ ไม่มีปุ่มใช้สูตร', () => {
    const f = make(true);
    const c = f.componentInstance;
    c.open = true;
    c.description = 'ถ้ามีผลงานให้เป็น 1';
    c.suggest();
    http.expectOne(r => r.url.endsWith('/ai/formula-suggest')).flush({ success: false, message: 'AI เสนอสูตรที่ระบบตรวจแล้วใช้ไม่ได้' }, { status: 422, statusText: 'Unprocessable' });
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('AI เสนอสูตรที่ระบบตรวจแล้วใช้ไม่ได้');
    expect(c.formula).toBe('');
  });
});
