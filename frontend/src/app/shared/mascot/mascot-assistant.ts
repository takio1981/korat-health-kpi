import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRouteSnapshot, NavigationEnd, Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { AuthService } from '../../services/auth';
import { HelpVideoService, findHelpVideo } from '../help-video';
import { HelpSource, answerLines, sourceLabel } from '../ai-help-box';
import { aiErrorText, aiFeatureOn } from '../ai-feature';
import { MascotStageComponent } from './mascot-stage';
import { DialogChoice, DialogScript, ResolvedNode } from './mascot-dialog';
import { GuideRole, GuideStep, PageGuide, findTarget, guideFor, guideRole, introOf } from './mascot-guides';
import { MascotService } from './mascot.service';

const TARGET_ATTR = 'data-mascot-target';

/** pageKey ของหน้าปัจจุบัน (route data) — ไม่มี = ส่วนท้ายของ path */
export function pageKeyOf(root: ActivatedRouteSnapshot | null, url: string): string {
  let key = '';
  for (let r = root; r; r = r.firstChild) if (r.data?.['pageKey']) key = r.data['pageKey'];
  if (key) return key;
  const seg = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  return seg;
}

/** ตัวเลือกในเมนูหลักของผู้ช่วย (ฟังก์ชันล้วน — ทดสอบได้) */
export function assistantMenu(o: { hasSteps: boolean; hasVideo: boolean; page: string; quiet: boolean; hasAi?: boolean }): DialogChoice[] {
  return [
    ...(o.hasSteps ? [{ label: 'แนะนำหน้านี้ทีละขั้น', action: 'tour:start' }] : []),
    ...(o.hasAi ? [{ label: 'ถามน้องโคราชดี (AI)', action: 'ask' }] : []),
    ...(o.hasVideo ? [{ label: 'ดูวิดีโอคู่มือหน้านี้', action: 'video' }] : []),
    ...(o.page !== 'help' ? [{ label: 'เปิดคู่มือการใช้งาน', action: 'nav:/help' }] : []),
    { label: o.quiet ? 'ทักทายเมื่อเข้าหน้าใหม่' : 'ไม่ต้องทักเมื่อเข้าหน้าใหม่', action: 'quiet' },
    { label: 'ซ่อนน้องโคราชดี', action: 'hide' },
    { label: 'ปิด', next: 'bye' },
  ];
}

/** ตัวเลือกของขั้นที่ i จากทั้งหมด n ขั้น */
export function stepChoices(i: number, n: number): DialogChoice[] {
  const last = i >= n - 1;
  return [
    ...(i > 0 ? [{ label: 'ย้อนกลับ', action: 'tour:prev' }] : []),
    last ? { label: 'จบการแนะนำ', action: 'tour:end' } : { label: 'ถัดไป', action: 'tour:next' },
    ...(!last ? [{ label: 'พอแล้ว', action: 'tour:end' }] : []),
  ];
}

const ANSWER_MAX = 420;

/**
 * คำตอบจากผู้ช่วยคู่มือ (POST /ai/help-ask) เป็นกล่องคำพูด (ฟังก์ชันล้วน): ข้อความล้วน ตัดความยาว + ป้ายข้อความจาก AI
 * + ปุ่มไปหัวข้อคู่มือที่อ้างอิง (ไม่พบ = หัวข้อที่เกี่ยวข้อง) ≤ 3 + ถามต่อ + ปิด
 */
export function answerNode(res: any): ResolvedNode {
  const found = !!res?.found;
  let text = answerLines(res?.answer || '').join('\n');
  if (!text) text = 'ผมยังไม่พบคำตอบในคู่มือครับ ลองถามด้วยคำอื่นดูนะครับ';
  if (text.length > ANSWER_MAX) text = text.slice(0, ANSWER_MAX).trimEnd() + '… (อ่านต่อในคู่มือ)';
  const src: HelpSource[] = (found ? res?.sources : res?.related) || [];
  const seen = new Set<string>();
  const topics = src.filter(s => s && typeof s.anchor === 'string' && /^[a-z0-9-]{1,40}$/.test(s.anchor) && !seen.has(s.anchor) && seen.add(s.anchor)).slice(0, 3);
  const short = (t: string) => (t.length > 34 ? t.slice(0, 33) + '…' : t);
  return {
    id: 'answer', text, kind: 'speech', pose: found ? 'talk' : 'think', mood: found ? 'happy' : 'think',
    choices: [
      ...topics.map(s => ({ label: 'คู่มือ: ' + short(sourceLabel(s)), action: 'help:' + s.anchor })),
      { label: 'ถามต่อ', action: 'ask' },
      { label: 'ปิด', next: 'bye' },
    ],
    auto: null, pointAt: null,
    note: 'ข้อความจาก AI — โปรดตรวจสอบกับเนื้อหาคู่มือก่อนดำเนินการ' + (res?.model ? ' · รุ่น ' + res.model : ''),
  };
}

/**
 * ผู้ช่วยน้องโคราชดีทุกหน้าหลังเข้าสู่ระบบ (19 พ.ย. 2569 — ระยะที่ 2)
 * จอดมุมขวาล่าง คลิกเพื่อเปิดเมนู: แนะนำหน้านี้ทีละขั้น (บินไปชี้ + วงไฮไลต์), วิดีโอคู่มือของหน้านี้ตามสิทธิ์, คู่มือ, ซ่อน
 * ทักครั้งแรกเมื่อเข้าหน้าใหม่ (จำแยกตามบัญชีในเครื่อง ปิดได้) — ระบบปิดได้ที่ตั้งค่าระบบ (mascot_assistant_enabled)
 */
@Component({
  selector: 'app-mascot-assistant',
  standalone: true,
  imports: [CommonModule, MascotStageComponent],
  template: `<app-mascot-stage *ngIf="show" [dock]="true" [script]="script" (action)="onAction($event)"></app-mascot-stage>`,
})
export class MascotAssistantComponent implements OnInit, OnDestroy {
  @ViewChild(MascotStageComponent) stage?: MascotStageComponent;
  private router = inject(Router);
  private auth = inject(AuthService);
  private mascot = inject(MascotService);
  private videos = inject(HelpVideoService);
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  show = false;
  script: DialogScript = {};
  private systemOn = false;
  private hidden = false;
  private role!: GuideRole;
  private page = '';
  private guide: PageGuide | null = null;
  private videoUrl: string | null = null;
  private aiHelpOn = false;
  private asking = false;
  private steps: GuideStep[] = [];
  private stepIdx = -1;
  private subs: Subscription[] = [];
  private greetTimer: any = null;
  private stepTimer: any = null;

  ngOnInit() {
    this.role = guideRole(this.auth.getUserRole() || '');
    this.mascot.bindUser(this.auth.getUser()?.id);
    this.subs.push(this.mascot.assistantHidden$.subscribe(h => { this.hidden = h; this.updateShow(); }));
    this.subs.push(this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => this.onPage()));
    // ระยะที่ 3: ถามคู่มือผ่าน AI — เฉพาะเมื่อผู้ดูแลเปิดส่วน "ผู้ช่วยคู่มือ"
    this.auth.getAiStatus().subscribe({ next: (res: any) => { this.aiHelpOn = aiFeatureOn(res, 'help'); this.buildScript(); }, error: () => { /* ไม่มี AI */ } });
    this.auth.getMaintenanceStatus().subscribe({
      next: (res: any) => { this.systemOn = res?.mascot_assistant_enabled !== false; this.updateShow(); this.onPage(); },
      error: () => { this.systemOn = true; this.updateShow(); this.onPage(); },
    });
  }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
    clearTimeout(this.greetTimer); clearTimeout(this.stepTimer);
    this.clearTarget();
  }

  private updateShow() {
    const v = this.systemOn && !this.hidden;
    if (v !== this.show) { this.show = v; this.cdr.detectChanges(); }
  }

  private onPage() {
    const page = pageKeyOf(this.router.routerState.snapshot.root, this.router.url);
    if (page === this.page && Object.keys(this.script).length) return;
    this.page = page;
    this.guide = guideFor(page);
    this.videoUrl = null;
    this.steps = [];
    this.stepIdx = -1;
    this.clearTarget();
    clearTimeout(this.greetTimer);
    this.buildScript();
    this.stage?.close();
    const g = this.guide;
    if (g?.video) {
      const want = page;
      this.videos.manifest().subscribe({
        next: m => {
          if (this.page !== want) return;
          const v = findHelpVideo(m, this.role.role, g.video!);
          this.videoUrl = v ? this.videos.url(v) : null;
          this.buildScript();
        },
        error: () => { /* ไม่มีวิดีโอ = ไม่มีตัวเลือก */ },
      });
    }
    if (this.show && g && !this.mascot.quiet && !this.mascot.seen(page)) {
      this.greetTimer = setTimeout(() => {
        if (this.page !== page || !this.stage || this.stage.node) return;
        this.mascot.markSeen(page);
        this.stage.open('first');
      }, 1800);
    }
  }

  private buildScript() {
    const g = this.guide, r = this.role;
    const hasSteps = !!g?.steps && g.steps(r).length > 0;
    const menu = assistantMenu({ hasSteps, hasVideo: !!this.videoUrl, page: this.page, quiet: this.mascot.quiet, hasAi: this.aiHelpOn });
    const intro = g ? introOf(g, r) : 'ผมน้องโคราชดี ผู้ช่วยประจำระบบครับ';
    this.script = {
      start: { text: `${intro} มีอะไรให้ผมช่วยไหมครับ?`, pose: 'wave', mood: 'happy', choices: menu },
      first: {
        text: g ? `หน้า${g.title} — ${intro} ให้ผมแนะนำการใช้งานไหมครับ?` : intro,
        kind: 'think', pose: 'wave', mood: 'happy',
        choices: [
          ...(hasSteps ? [{ label: 'แนะนำเลย', action: 'tour:start' }] : []),
          ...(this.videoUrl ? [{ label: 'ดูวิดีโอคู่มือ', action: 'video' }] : []),
          { label: 'ไว้ทีหลัง', next: 'later' },
          { label: 'ไม่ต้องทักอีก', action: 'quiet:on' },
        ],
      },
      later: { text: 'ได้เลยครับ คลิกที่ตัวผมเมื่อต้องการให้ช่วยนะครับ', pose: 'wave', auto: 3200 },
      bye: { text: 'ได้เลยครับ ผมอยู่ตรงนี้ คลิกที่ตัวผมได้ทุกเมื่อครับ', pose: 'wave', mood: 'happy', auto: 3000 },
      tourEnd: { text: 'จบการแนะนำแล้วครับ! สงสัยตรงไหนคลิกที่ตัวผมได้เลย', kind: 'shout', pose: 'cheer', mood: 'happy', auto: 3500 },
      noStep: { text: 'ตอนนี้ยังไม่เห็นปุ่มที่จะแนะนำในหน้านี้ ลองเลือกข้อมูลหรือรอให้หน้าโหลดเสร็จก่อนนะครับ', pose: 'think', mood: 'think', auto: 5000 },
      quietOn: { text: 'รับทราบครับ ผมจะไม่ทักเมื่อเข้าหน้าใหม่ แต่ยังอยู่ตรงนี้ถ้าต้องการให้ช่วย', pose: 'idle', auto: 4000 },
      quietOff: { text: 'ได้ครับ เข้าหน้าใหม่เมื่อไหร่ผมจะทักทายนะครับ', pose: 'wave', mood: 'happy', auto: 3500 },
      hide: { text: 'ไปพักก่อนนะครับ เรียกผมกลับได้ที่เมนูโปรไฟล์มุมขวาบนครับ', pose: 'wave', mood: 'happy', auto: 2600 },
      step: { text: '', choices: [] },
      ask: {
        text: 'อยากรู้เรื่องไหน พิมพ์ถามได้เลยครับ ผมจะค้นจากคู่มือการใช้งานตามสิทธิ์ของท่าน',
        pose: 'talk', mood: 'happy', input: { placeholder: 'เช่น บันทึกผลงานรายไตรมาสอย่างไร' },
        choices: [{ label: 'ปิด', next: 'bye' }],
      },
    };
  }

  onAction(a: string) {
    const stage = this.stage;
    if (!stage) return;
    if (a.startsWith('ask:')) { this.askAi(a.slice(4)); return; }
    if (a.startsWith('help:')) {
      const sec = a.slice(5);
      stage.close();
      if (/^[a-z0-9-]{1,40}$/.test(sec)) {
        this.router.navigate(['/help'], { queryParams: { section: sec } });
        setTimeout(() => document.getElementById('section-' + sec)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 600);
      }
      return;
    }
    switch (a) {
      case 'ask': stage.open('ask'); break;
      case 'tour:start':
        // ตัดขั้นที่เป้าหมายไม่มีในหน้าตอนนี้ (สิทธิ์นี้ไม่มีปุ่ม/ต้องเข้าโหมดอื่นก่อน) — ตัวนับ n/N จึงตรงกับที่จะแนะนำจริง
        this.steps = (this.guide?.steps?.(this.role) || []).filter(st => !st.target || !!findTarget(st.target));
        this.stepIdx = -1;
        this.goStep(1);
        break;
      case 'tour:next': this.goStep(1); break;
      case 'tour:prev': this.goStep(-1); break;
      case 'tour:end': this.clearTarget(); stage.open('tourEnd'); break;
      case 'video':
        if (this.videoUrl) window.open(this.videoUrl, '_blank', 'noopener');
        stage.close();
        break;
      case 'quiet': {
        const q = !this.mascot.quiet; this.mascot.setQuiet(q); this.buildScript(); stage.open(q ? 'quietOn' : 'quietOff'); break;
      }
      case 'quiet:on': this.mascot.setQuiet(true); this.buildScript(); stage.open('quietOn'); break;
      case 'hide':
        stage.open('hide');
        setTimeout(() => this.zone.run(() => this.mascot.setAssistantHidden(true)), 2700);
        break;
    }
  }

  /** ไปขั้นถัดไป/ก่อนหน้าที่หาเป้าหมายเจอ (ขั้นที่ไม่มีเป้าหมาย = พูดอย่างเดียว) */
  private goStep(dir: 1 | -1) {
    const stage = this.stage;
    if (!stage) return;
    let i = this.stepIdx + dir, el: HTMLElement | null = null;
    while (i >= 0 && i < this.steps.length) {
      const st = this.steps[i];
      el = st.target ? findTarget(st.target) : null;
      if (!st.target || el) break;
      i += dir;
    }
    if (i < 0 || i >= this.steps.length) {
      this.clearTarget();
      stage.open(this.stepIdx < 0 ? 'noStep' : 'tourEnd');
      return;
    }
    this.stepIdx = i;
    this.clearTarget();
    const st = this.steps[i];
    if (el) {
      el.setAttribute(TARGET_ATTR, '1');
      try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
    }
    this.script['step'] = {
      text: `(${i + 1}/${this.steps.length}) ${st.text}`,
      pose: st.pose || (el ? 'point' : 'talk'),
      pointAt: el ? `[${TARGET_ATTR}="1"]` : undefined,
      choices: stepChoices(i, this.steps.length),
    };
    clearTimeout(this.stepTimer);
    this.stepTimer = setTimeout(() => stage.open('step'), el ? 450 : 0);
  }

  /** ถามคู่มือผ่าน AI (POST /ai/help-ask — server ค้นเฉพาะหัวข้อที่สิทธิ์ผู้ถามเห็น) แล้วตอบเป็นกล่องคำพูด */
  private askAi(q: string) {
    const stage = this.stage;
    if (!stage || this.asking) return;
    this.asking = true;
    stage.openResolved({ id: 'thinking', text: 'ขอค้นคู่มือแป๊บนะครับ…', kind: 'think', pose: 'think', mood: 'think', choices: [], auto: 60000, pointAt: null });
    this.auth.askAiHelp(q.slice(0, 300)).subscribe({
      next: (res: any) => { this.asking = false; this.stage?.openResolved(answerNode(res)); },
      error: (err: any) => {
        this.asking = false;
        this.stage?.openResolved({
          id: 'askError', text: 'ขอโทษครับ ' + aiErrorText(err, 'ตอนนี้ผู้ช่วย AI ตอบไม่ได้'), kind: 'shout', pose: 'think', mood: 'sad',
          choices: [{ label: 'ลองอีกครั้ง', action: 'ask' }, { label: 'ปิด', next: 'bye' }], auto: null, pointAt: null,
        });
      },
    });
  }

  private clearTarget() {
    document.querySelectorAll(`[${TARGET_ATTR}]`).forEach(e => e.removeAttribute(TARGET_ATTR));
  }
}
