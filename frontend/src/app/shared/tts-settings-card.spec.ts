import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { TtsSettingsCardComponent, keySourceText, voiceLabel } from './tts-settings-card';

// การ์ดตั้งค่าเสียงพูดน้องคิดดี Gemini TTS (26 พ.ย. 2569)
const data = {
  enabled: true, key_source: 'ai', has_api_key: false, model: 'gemini-3.8-flash-tts', voice: 'Puck', style: 'สดใส', daily_limit: 500,
  default_model: 'gemini-3.8-flash-tts', default_voice: 'Puck', default_style: 'ค่าตั้งต้น', max_chars: 600,
  voices: [{ name: 'Puck', trait: 'Upbeat', gender: 'm' }, { name: 'Kore', trait: 'Firm', gender: 'f' }],
};

describe('tts-settings-card', () => {
  it('voiceLabel / keySourceText', () => {
    expect(voiceLabel({ name: 'Puck', trait: 'Upbeat', gender: 'm' })).toBe('Puck — สดใส (ชาย)');
    expect(voiceLabel({ name: 'Kore', trait: 'Firm', gender: 'f' })).toBe('Kore — หนักแน่น (หญิง)');
    expect(keySourceText('ai')).toContain('ผู้ช่วย AI');
    expect(keySourceText('none')).toContain('ยังไม่มีคีย์');
  });

  let http: HttpTestingController;
  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [TtsSettingsCardComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  it('โหลดค่า → ตัวเลือกเสียงภาษาไทย → บันทึกไม่ส่งคีย์ว่าง, ส่งคีย์ใหม่เมื่อกรอก, ลบคีย์เมื่อติ๊ก', () => {
    const f = TestBed.createComponent(TtsSettingsCardComponent);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/tts/settings')).flush({ success: true, data });
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('#tts-key-source')!.textContent).toContain('ผู้ช่วย AI');
    expect([...el.querySelectorAll('#tts-voice option')].map(o => o.textContent!.trim())).toEqual(['Puck — สดใส (ชาย)', 'Kore — หนักแน่น (หญิง)']);
    const c = f.componentInstance;
    expect(c.payload()).toEqual({ enabled: true, voice: 'Puck', model: 'gemini-3.8-flash-tts', style: 'สดใส', daily_limit: 500 });
    c.apiKey = '  AIza-new-key  ';
    expect(c.payload().api_key).toBe('AIza-new-key');
    c.clearKey = true;
    expect(c.payload().clear_api_key).toBe(true);
    expect(c.payload().api_key).toBeUndefined();
    c.clearKey = false; c.apiKey = '';
    c.s.model = '  '; c.s.daily_limit = '20';
    c.save();
    const put = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/tts/settings'));
    expect(put.request.body).toMatchObject({ model: 'gemini-3.8-flash-tts', daily_limit: 20 });
    expect(put.request.body.api_key).toBeUndefined();
  });
});
