import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { testProviders } from '../testing/test-providers';
import { AiHelpBoxComponent, answerLines, otherRelated, sourceLabel, HelpAnswer } from './ai-help-box';

// กล่องถามผู้ช่วย AI บนหน้าคู่มือ (ระยะที่ 4 — 8 พ.ย. 2569)
describe('ai-help-box helpers', () => {
  it('answerLines ตัด Markdown (** และ #) และบรรทัดว่าง', () => {
    expect(answerLines('# วิธีทำ\n1. กด **ลืมรหัสผ่าน?**\n\n2. ตั้งรหัสใหม่')).toEqual(['วิธีทำ', '1. กด ลืมรหัสผ่าน?', '2. ตั้งรหัสใหม่']);
  });
  it('answerLines แยกขั้นตอนที่เขียนต่อกันในบรรทัดเดียว (พบกับผู้ให้บริการจริง) แต่ไม่แยกทศนิยม/ข้อเดียว', () => {
    expect(answerLines('มีขั้นตอนดังนี้ 1. กดรูป Avatar 2. เลือกเปลี่ยนรหัสผ่าน')).toEqual(['มีขั้นตอนดังนี้', '1. กดรูป Avatar', '2. เลือกเปลี่ยนรหัสผ่าน']);
    expect(answerLines('เป้าหมาย 85.5 ขึ้นไป 1. ข้อเดียว')).toEqual(['เป้าหมาย 85.5 ขึ้นไป 1. ข้อเดียว']);
  });
  it('sourceLabel = หัวข้อหลัก › หัวข้อย่อย', () => {
    expect(sourceLabel({ anchor: 'login', section: '3. การเข้าสู่ระบบ', heading: 'ลืมรหัสผ่าน?' })).toBe('3. การเข้าสู่ระบบ › ลืมรหัสผ่าน?');
    expect(sourceLabel({ anchor: 'faq', section: '24. FAQ', heading: null })).toBe('24. FAQ');
  });
  it('otherRelated ไม่ซ้ำกับแหล่งอ้างอิงที่ AI ระบุ', () => {
    const a = { sources: [{ anchor: 'login', section: 'x', heading: 'h' }], related: [{ anchor: 'login', section: 'x', heading: 'h' }, { anchor: 'faq', section: 'y', heading: null }] } as HelpAnswer;
    expect(otherRelated(a).map(s => s.anchor)).toEqual(['faq']);
  });
});

describe('AiHelpBoxComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('kpi_token', 'test-token');
    await TestBed.configureTestingModule({ imports: [AiHelpBoxComponent], providers: testProviders }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => localStorage.clear());

  const make = (enabled: boolean) => {
    const f = TestBed.createComponent(AiHelpBoxComponent);
    f.detectChanges();
    http.expectOne(r => r.url.endsWith('/ai/status')).flush({ success: true, enabled });
    f.detectChanges();
    return f;
  };

  it('ผู้ช่วย AI ปิดอยู่ = ไม่แสดงกล่อง', () => {
    const f = make(false);
    expect(f.nativeElement.textContent).not.toContain('ถามผู้ช่วย AI');
  });

  it('ถาม → แสดงคำตอบเป็นข้อความล้วน + ป้ายเตือน + กดหัวข้ออ้างอิงแล้วส่ง anchor', () => {
    const f = make(true);
    const c = f.componentInstance;
    const picked: string[] = [];
    c.pick.subscribe((a: string) => picked.push(a));
    c.question = '  ลืมรหัสผ่านทำอย่างไร ';
    c.ask();
    const req = http.expectOne(r => r.url.endsWith('/ai/help-ask'));
    expect(req.request.body).toEqual({ question: 'ลืมรหัสผ่านทำอย่างไร' });
    req.flush({
      success: true, found: true, answer: '1. กด <b>ลืมรหัสผ่าน?</b>', model: 'm', cached: false,
      sources: [{ anchor: 'login', section: '3. การเข้าสู่ระบบ', heading: 'ลืมรหัสผ่าน?' }],
      related: [{ anchor: 'login', section: '3. การเข้าสู่ระบบ', heading: 'ลืมรหัสผ่าน?' }, { anchor: 'faq', section: '24. คำถามที่พบบ่อย (FAQ)', heading: null }],
    });
    f.detectChanges();
    const el: HTMLElement = f.nativeElement;
    expect(el.textContent).toContain('1. กด <b>ลืมรหัสผ่าน?</b>');
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('ข้อความจาก AI — โปรดตรวจสอบ');
    expect(el.textContent).toContain('หัวข้อที่เกี่ยวข้อง:');
    const btn = Array.from(el.querySelectorAll('button')).find(b => b.textContent!.includes('3. การเข้าสู่ระบบ › ลืมรหัสผ่าน?'))!;
    btn.click();
    expect(picked).toEqual(['login']);
    expect(c.question).toBe('');
  });

  it('คำถามสั้นเกิน = ไม่ส่ง, ข้อผิดพลาดแสดงข้อความจากระบบ, เก็บประวัติล่าสุดไม่เกิน 5', () => {
    const f = make(true);
    const c = f.componentInstance;
    c.question = 'ก';
    c.ask();
    http.expectNone(r => r.url.endsWith('/ai/help-ask'));
    c.question = 'ลืมรหัสผ่าน';
    c.ask();
    http.expectOne(r => r.url.endsWith('/ai/help-ask')).flush({ success: false, message: 'ผู้ช่วย AI ยังไม่ได้เปิดใช้งาน' }, { status: 503, statusText: 'x' });
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('ผู้ช่วย AI ยังไม่ได้เปิดใช้งาน');
    for (let i = 0; i < 7; i++) {
      c.question = 'คำถามที่ ' + i;
      c.ask();
      http.expectOne(r => r.url.endsWith('/ai/help-ask')).flush({ success: true, found: false, answer: 'ไม่พบ', sources: [], related: [], model: null });
    }
    expect(c.history.length).toBe(5);
    expect(c.history[0].question).toBe('คำถามที่ 6');
  });
});
