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
