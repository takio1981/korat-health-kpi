import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { AiSettingsCardComponent, presetOf } from './ai-settings-card';
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
