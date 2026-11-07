import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { AiSettingsCardComponent, presetOf, modelLabel } from './ai-settings-card';
import Swal from 'sweetalert2';

// การ์ดตั้งค่าผู้ช่วย AI (7 พ.ย. 2569)
describe('AiSettingsCardComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [AiSettingsCardComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    // jsdom ไม่มี window.matchMedia — Swal แบบมี icon ใช้ไม่ได้ใน spec
    vi.spyOn(Swal, 'fire').mockImplementation((() => Promise.resolve({})) as any);
  });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  const make = (data: any) => {
    const f = TestBed.createComponent(AiSettingsCardComponent);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/settings') && r.method === 'GET').flush({ success: true, data });
    f.detectChanges();
    return f;
  };

  // รายชื่อรุ่นจากผู้ให้บริการ (7 พ.ย. 2569 — ครบทุกรุ่น + อัปเดตได้เมื่อมีรุ่นใหม่)
  const modelsReq = () => http.expectOne(r => r.url.endsWith('/ai/models'));
  const LIST = [{ id: 'claude-new-9', name: 'Claude New' }, { id: 'claude-old-1', name: 'Claude Old', deprecated: true }];

  it('โหลดการตั้งค่าแล้วแสดงรายชื่อรุ่นล่าสุดที่เก็บไว้ (ไม่บังคับดึงใหม่)', () => {
    const f = make({ enabled: true, provider: 'anthropic', base_url: '', model: 'claude-new-9', daily_limit: 200, has_api_key: true });
    const req = modelsReq();
    expect(req.request.body).toEqual({ provider: 'anthropic', base_url: '', api_key: '', refresh: false });
    req.flush({ success: true, models: LIST, hidden: 0, fetched_at: '2026-11-07T01:00:00Z', cached: true });
    f.detectChanges();
    const opts = Array.from(f.nativeElement.querySelectorAll('select[name="aiModelPick"] option')).map((o: any) => o.textContent.trim());
    expect(opts).toContain('claude-old-1 — Claude Old (เลิกใช้แล้ว)');
    expect(f.nativeElement.textContent).toContain('พบ 2 รุ่น');
  });

  it('กดอัปเดตรายชื่อรุ่น: ดึงใหม่พร้อม key ที่กรอก, รุ่นที่เลือกไม่อยู่ในรายการ = เตือน, ผิดพลาด = แสดงข้อความ', () => {
    const f = make({ enabled: true, provider: 'openai', base_url: 'https://api.groq.com/openai/v1', model: 'gone-model', daily_limit: 200, has_api_key: false });
    modelsReq().flush({ success: false }, { status: 400, statusText: 'Bad' });
    f.detectChanges();
    const c = f.componentInstance;
    expect(c.modelsError).toBe(''); // ตอนเปิดหน้า ยังไม่มี key = ไม่แสดงเป็นข้อผิดพลาด
    c.apiKey = 'gsk-typed';
    c.loadModels(true);
    const req = modelsReq();
    expect(req.request.body).toEqual({ provider: 'openai', base_url: 'https://api.groq.com/openai/v1', api_key: 'gsk-typed', refresh: true });
    req.flush({ success: true, models: [{ id: 'new-chat-model', name: 'new-chat-model', free: true }], hidden: 3, fetched_at: '2026-11-07T01:00:00Z' });
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('ไม่อยู่ในรายชื่อล่าสุดของผู้ให้บริการ');
    expect(f.nativeElement.textContent).toContain('ซ่อนรุ่นที่ไม่ใช่โมเดลสนทนา 3 รุ่น');
    c.loadModels(true);
    modelsReq().flush({ success: false, message: 'API key ของผู้ให้บริการ AI ไม่ถูกต้อง' }, { status: 502, statusText: 'Bad Gateway' });
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('API key ของผู้ให้บริการ AI ไม่ถูกต้อง');
  });

  it('ค้นหารุ่น + ป้ายรุ่นฟรี', () => {
    const c = make({ enabled: true, provider: 'anthropic', base_url: '', model: '', daily_limit: 200, has_api_key: true }).componentInstance;
    modelsReq().flush({ success: true, models: LIST });
    c.modelFilter = 'old';
    expect(c.filteredModels.map(m => m.id)).toEqual(['claude-old-1']);
    expect(modelLabel({ id: 'x:free', name: 'x:free', free: true })).toBe('x:free (ฟรี)');
  });

  it('presetOf: จับคู่ผู้ให้บริการจาก Base URL (ไม่ตรง = กำหนดเอง)', () => {
    expect(presetOf('anthropic', '')).toBe('claude');
    expect(presetOf('openai', 'http://localhost:11434/v1/')).toBe('ollama');
    expect(presetOf('openai', 'https://api.groq.com/openai/v1')).toBe('groq');
    expect(presetOf('openai', 'http://10.0.0.5:8000/v1')).toBe('custom');
  });

  it('โหลดค่าที่บันทึกไว้ — ไม่มีช่องแสดง key เดิม, เลือก preset ตาม Base URL', () => {
    const f = make({ enabled: true, provider: 'openai', base_url: 'http://localhost:11434/v1', model: 'qwen', daily_limit: 30, has_api_key: false, used_today: 4 });
    const c = f.componentInstance;
    expect(c.presetId).toBe('ollama');
    expect(c.apiKey).toBe('');
    expect(f.nativeElement.textContent).toContain('ใช้วันนี้ 4 / 30 ครั้ง');
  });

  it('เปลี่ยนผู้ให้บริการ: Claude → Groq ล้างชื่อรุ่นของ Claude และตั้ง Base URL ให้', () => {
    const c = make({ enabled: false, provider: 'anthropic', base_url: '', model: 'claude-opus-5-5', daily_limit: 200, has_api_key: true }).componentInstance;
    c.presetId = 'groq';
    c.applyPreset('groq');
    expect(c.provider).toBe('openai');
    expect(c.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(c.model).toBe('');
    c.applyPreset('claude');
    expect(c.model).toBe('claude-opus-5-5');
  });

  it('บันทึก: ส่ง key เฉพาะที่กรอกใหม่ แล้วล้างช่อง key และโหลดค่าใหม่', () => {
    const c = make({ enabled: false, provider: 'anthropic', base_url: '', model: 'claude-opus-5-5', daily_limit: 200, has_api_key: true }).componentInstance;
    c.enabled = true;
    c.apiKey = '  sk-new  ';
    c.save();
    const req = http.expectOne(r => r.url.endsWith('/ai/settings') && r.method === 'PUT');
    expect(req.request.body).toEqual({ enabled: true, provider: 'anthropic', base_url: '', model: 'claude-opus-5-5', daily_limit: 200, api_key: 'sk-new', clear_api_key: false });
    req.flush({ success: true });
    expect(c.apiKey).toBe('');
    http.expectOne(r => r.url.endsWith('/ai/settings') && r.method === 'GET');
  });
});
