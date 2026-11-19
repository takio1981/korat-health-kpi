import { TestBed } from '@angular/core/testing';
import { assistantMenu, pageKeyOf, stepChoices } from './mascot-assistant';
import { PAGE_GUIDES, guideFor, guideRole, introOf } from './mascot-guides';
import { MascotService } from './mascot.service';
import { routes } from '../../app.routes';

describe('mascot-assistant (ระยะที่ 2)', () => {
  it('pageKeyOf: ใช้ data.pageKey ของ route ลึกสุด ไม่มี = ส่วนท้ายของ path', () => {
    const snap: any = { data: {}, firstChild: { data: { pageKey: 'charts' }, firstChild: { data: {}, firstChild: null } } };
    expect(pageKeyOf(snap, '/charts?tab=1')).toBe('charts');
    expect(pageKeyOf({ data: {}, firstChild: null } as any, '/role-page-access#x')).toBe('role-page-access');
  });

  it('ทุกหน้าใน app.routes ที่มี pageKey มีคำแนะนำของผู้ช่วย', () => {
    const keys: string[] = [];
    const walk = (rs: any[]) => rs.forEach(r => { if (r.data?.pageKey) keys.push(r.data.pageKey); if (r.children) walk(r.children); });
    walk(routes as any[]);
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(guideFor(k), k).toBeTruthy();
  });

  it('guideFor ไม่รับชื่อของ Object.prototype', () => {
    expect(guideFor('toString')).toBeNull();
    expect(guideFor('')).toBeNull();
  });

  it('คำแนะนำทุกหน้ามีชื่อ คำแนะนำ และขั้นตอนที่มีข้อความ (ไม่มีอีโมจิ)', () => {
    for (const role of ['super_admin', 'admin_ssj', 'admin_cup', 'user_hos', 'user_ssj']) {
      const r = guideRole(role);
      for (const [k, g] of Object.entries(PAGE_GUIDES)) {
        expect(g.title, k).toBeTruthy();
        expect(introOf(g, r).length, k).toBeGreaterThan(10);
        for (const st of g.steps?.(r) || []) {
          expect(st.text.length).toBeGreaterThan(5);
          expect(/\p{Extended_Pictographic}/u.test(st.text)).toBe(false);
        }
      }
    }
  });

  it('หน้าบันทึกผลงาน: ผู้ดูแลส่วนกลางได้ขั้นตรวจสอบ/ค้นหา ผู้ใช้ทั่วไปได้ขั้นแก้ไข', () => {
    const central = PAGE_GUIDES['dashboard'].steps!(guideRole('admin_ssj')).map(s => s.text).join(' ');
    const user = PAGE_GUIDES['dashboard'].steps!(guideRole('user_hos')).map(s => s.text).join(' ');
    expect(central).toContain('ตรวจสอบ');
    expect(user).toContain('แก้ไข');
    expect(user).not.toContain('อนุมัติหรือตีกลับ');
  });

  it('assistantMenu: มีตัวเลือกตามความพร้อม (ขั้นตอน/วิดีโอ/คู่มือ)', () => {
    const full = assistantMenu({ hasSteps: true, hasVideo: true, page: 'dashboard', quiet: false }).map(c => c.action || c.next);
    expect(full).toEqual(['tour:start', 'video', 'nav:/help', 'quiet', 'hide', 'bye']);
    const bare = assistantMenu({ hasSteps: false, hasVideo: false, page: 'help', quiet: true });
    expect(bare.map(c => c.action || c.next)).toEqual(['quiet', 'hide', 'bye']);
    expect(bare[0].label).toContain('ทักทาย');
  });

  it('stepChoices: ขั้นแรกไม่มีย้อนกลับ ขั้นสุดท้ายมีจบการแนะนำ', () => {
    expect(stepChoices(0, 3).map(c => c.action)).toEqual(['tour:next', 'tour:end']);
    expect(stepChoices(1, 3).map(c => c.action)).toEqual(['tour:prev', 'tour:next', 'tour:end']);
    expect(stepChoices(2, 3).map(c => c.action)).toEqual(['tour:prev', 'tour:end']);
  });
});

describe('MascotService (สถานะผู้ช่วยในเครื่อง แยกตามบัญชี)', () => {
  beforeEach(() => localStorage.clear());
  it('ซ่อน/แสดง และหน้าที่ทักแล้ว จำแยกตามบัญชี', () => {
    const s = TestBed.inject(MascotService);
    s.bindUser(7);
    expect(s.assistantHidden$.value).toBe(false);
    s.toggleAssistant();
    expect(s.assistantHidden$.value).toBe(true);
    s.markSeen('dashboard'); s.setQuiet(true);
    expect(s.seen('dashboard')).toBe(true);
    s.bindUser(8);
    expect(s.assistantHidden$.value).toBe(false);
    expect(s.seen('dashboard')).toBe(false);
    expect(s.quiet).toBe(false);
    s.bindUser(7);
    expect(s.assistantHidden$.value).toBe(true);
    expect(s.quiet).toBe(true);
  });
  it('ข้อมูลในเครื่องเสีย = ถือว่ายังไม่เคยทัก', () => {
    const s = TestBed.inject(MascotService);
    s.bindUser(1);
    localStorage.setItem('kpi_mascot_seen_pages_1', '{bad');
    expect(s.seen('x')).toBe(false);
  });
});

import { answerNode } from './mascot-assistant';
import { MascotCue } from './mascot.service';

describe('ระยะที่ 3: น้องโคราชดีเป็นตัวแทนผู้ช่วย AI', () => {
  it('เมนูมี "ถามน้องโคราชดี (AI)" เฉพาะเมื่อเปิดผู้ช่วยคู่มือ', () => {
    const on = assistantMenu({ hasSteps: false, hasVideo: false, page: 'dashboard', quiet: false, hasAi: true });
    const off = assistantMenu({ hasSteps: false, hasVideo: false, page: 'dashboard', quiet: false, hasAi: false });
    expect(on.some(c => c.action === 'ask')).toBe(true);
    expect(off.some(c => c.action === 'ask')).toBe(false);
  });

  it('answerNode: ข้อความล้วน + ป้ายข้อความจาก AI + ปุ่มหัวข้อคู่มือ (ตัด anchor ที่ไม่ปลอดภัย/ซ้ำ, ≤ 3)', () => {
    const n = answerNode({
      found: true, answer: '**ขั้นตอน** 1. เปิดหน้า 2. กดแก้ไข', model: 'm1',
      sources: [{ anchor: 'dashboard', section: 'บันทึกผลงาน', heading: 'ไตรมาส' }, { anchor: 'dashboard', section: 'x', heading: null },
        { anchor: 'javascript:alert(1)', section: 'x', heading: null }, { anchor: 'charts', section: 'รายงาน', heading: null },
        { anchor: 'users', section: 'ผู้ใช้', heading: null }, { anchor: 'sop', section: 'SOP', heading: null }],
    });
    expect(n.text).not.toContain('**');
    expect(n.text).toContain('\n');
    expect(n.note).toContain('ข้อความจาก AI');
    expect(n.note).toContain('m1');
    const topics = n.choices.filter(c => c.action?.startsWith('help:')).map(c => c.action);
    expect(topics).toEqual(['help:dashboard', 'help:charts', 'help:users']);
    expect(n.choices.some(c => c.action === 'ask')).toBe(true);
    expect(n.auto).toBeNull();
  });

  it('answerNode: ไม่พบคำตอบ = ใช้หัวข้อที่เกี่ยวข้อง และตัดคำตอบยาวเกิน', () => {
    const n = answerNode({ found: false, answer: 'ก'.repeat(900), sources: [{ anchor: 'a1', section: 's', heading: null }], related: [{ anchor: 'help', section: 'คู่มือ', heading: null }] });
    expect(n.mood).toBe('think');
    expect(n.text.length).toBeLessThan(460);
    expect(n.text).toContain('อ่านต่อในคู่มือ');
    expect(n.choices.filter(c => c.action?.startsWith('help:')).map(c => c.action)).toEqual(['help:help']);
    expect(answerNode({}).text).toContain('ยังไม่พบคำตอบ');
  });

  it('MascotService: aiThinking/aiDone/aiFailed ส่งคำสั่งพูด (นอกจอ = ไม่ชี้)', () => {
    const s = TestBed.inject(MascotService);
    const got: MascotCue[] = [];
    const sub = s.cues.subscribe(c => got.push(c));
    s.aiThinking(); s.aiDone('เสร็จแล้ว', document.createElement('div')); s.aiFailed();
    sub.unsubscribe();
    expect(got.map(c => c.kind || 'speech')).toEqual(['think', 'speech', 'shout']);
    expect(got[1].text).toBe('เสร็จแล้ว');
    expect(got[1].pointEl).toBeNull();
  });
});
