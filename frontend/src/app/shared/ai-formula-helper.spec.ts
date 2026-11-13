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

  // สูตรร้อยละ: เสนอจากข้อมูลตัวชี้วัดก่อน ข้อมูลไม่พอค่อยขออธิบายเพิ่ม (13 พ.ย. 2569)
  it('มีข้อมูลตัวชี้วัด: เสนอได้โดยไม่ต้องอธิบาย ส่งเป้าหมาย/เกณฑ์/เงื่อนไข/วิธีคิดผลงาน | AI ขอข้อมูลเพิ่ม → เปิดช่องอธิบาย', () => {
    const ind = { target_percentage: '80', criterion: '90', target_condition: 'LTE', result_formula: '', is_cumulative: 1, result_manual: 0, quarter_mode: '', target_monthly: null, kpi_indicators_name: 'x' };
    const f = make(true, { kind: 'pct', indicator: ind, targetCondition: 'LTE', indicatorName: 'อัตราตาย' });
    const c = f.componentInstance;
    f.nativeElement.querySelector('button').click();   // เปิดกล่องผ่านปุ่ม (zoneless — กำหนดค่าตรงไม่ mark view)
    f.detectChanges();
    expect(c.open).toBe(true);
    expect(c.canSuggest).toBe(true);
    expect(c.contextLines).toEqual(['เป้าหมาย: 80', 'เกณฑ์: ≤ 90', 'วิธีคิดผลงาน: สะสม (รวมทุกเดือน)']);
    expect(c.contextLines).toBe(c.contextLines);   // array เดิมเมื่อค่าไม่เปลี่ยน
    expect(f.nativeElement.querySelector('#ai-formula-context')).toBeTruthy();
    expect(f.nativeElement.querySelector('textarea')).toBeNull();   // ช่องอธิบายซ่อนไว้จนกว่าจะต้องการ
    c.suggest();
    const req = http.expectOne(r => r.url.endsWith('/ai/formula-suggest'));
    expect(req.request.body.description).toBe('');
    expect(req.request.body.indicator).toEqual({ target_percentage: '80', criterion: '90', target_condition: 'LTE', result_formula: '', is_cumulative: 1, result_manual: 0, quarter_mode: '', target_monthly: '' });
    req.flush({ success: true, need_more: true, question: 'ต้องการเทียบกับประชากรหรือเป้าหมาย?' });
    f.detectChanges();
    expect(c.question).toContain('ประชากร');
    expect(c.showDescription).toBe(true);
    expect(f.nativeElement.querySelector('textarea')).toBeTruthy();
    expect(c.formula).toBe('');
    // อธิบายสั้นเกิน (1–4 ตัวอักษร) = กดไม่ได้ | ว่าง = กดได้ (ใช้ข้อมูลตัวชี้วัด)
    c.description = 'ab';
    expect(c.canSuggest).toBe(false);
    c.description = 'เทียบประชากรกลางปี';
    c.suggest();
    http.expectOne(r => r.url.endsWith('/ai/formula-suggest')).flush({ success: true, formula: 'result / target * 100', explanation: 'x' });
    expect(c.formula).toBe('result / target * 100');
    expect(c.question).toBe('');
  });

  it('ไม่มีข้อมูลตัวชี้วัด (สูตรผลงาน) = ต้องอธิบายเหมือนเดิม', () => {
    const c = make(true, { kind: 'result' }).componentInstance;
    expect(c.canSuggest).toBe(false);
    expect(c.contextLines).toEqual([]);
  });
});
