import { Component, ElementRef, Input, NgZone, OnDestroy, AfterViewInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * น้องโคราชดีตัวเล็กบินไปมาในหน้าเข้าสู่ระบบ (19 พ.ย. 2569 — ผู้ใช้สั่ง: ตัวการ์ตูน 3 มิติ เปิด-ปิดได้)
 * 3 มิติด้วย CSS: ซ้อนภาพหลายชั้นตามแกน Z (ความหนา) + หมุนตามทิศที่บิน + ย่อ/ขยายตามระยะ + เงาบนพื้น + ไอพ่นใต้เท้า
 * — ไม่มีไลบรารีเพิ่ม, ภาพ public/mascot/korat-d-fly.webp (สร้างด้วย tools/video-guide/build-mascot.js --full)
 * ไม่บังฟอร์ม: บินผ่านกล่องเข้าสู่ระบบ (`avoid`) = อยู่หลังกล่อง และตัวละครไม่รับการคลิกขณะทับกล่อง
 * ทำงานนอก Angular zone (requestAnimationFrame แก้ style ตรง ไม่ทำให้เกิด change detection)
 */
export interface FlyState { x: number; y: number; z: number; vx: number; vy: number; vz: number; tx: number; ty: number; tz: number; hold: number; }

/** ขั้นการเคลื่อนที่ 1 เฟรม (ฟังก์ชันล้วน — ทดสอบได้): บังคับเลี้ยวเข้าหาจุดหมาย จำกัดความเร็ว ถึงแล้วลอยค้างชั่วครู่ */
export function stepFly(s: FlyState, dt: number, w: number, h: number, size: number, rnd: () => number = Math.random): FlyState {
  const n = { ...s };
  const maxV = Math.max(90, Math.min(w, h) * 0.22);
  const dx = n.tx - n.x, dy = n.ty - n.y, dist = Math.hypot(dx, dy);
  if (n.hold > 0) {
    n.hold -= dt;
    n.vx *= Math.pow(0.08, dt); n.vy *= Math.pow(0.08, dt);
  } else if (dist < 24) {
    n.hold = rnd() < 0.45 ? 0.8 + rnd() * 1.6 : 0;
    const m = size * 0.7;
    n.tx = m + rnd() * Math.max(1, w - 2 * m);
    n.ty = m + rnd() * Math.max(1, h - 2 * m - size * 0.6);
    n.tz = rnd();
  } else {
    const ax = (dx / dist) * maxV * 1.6, ay = (dy / dist) * maxV * 1.6;
    n.vx += ax * dt; n.vy += ay * dt;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > maxV) { n.vx *= maxV / sp; n.vy *= maxV / sp; }
  }
  n.vz += ((n.tz - n.z) * 1.2 - n.vz) * Math.min(1, dt * 2);
  n.x += n.vx * dt; n.y += n.vy * dt; n.z = Math.min(1, Math.max(0, n.z + n.vz * dt));
  // อยู่ในจอเสมอ (จอถูกย่อ/หมุน)
  n.x = Math.min(Math.max(n.x, size * 0.3), Math.max(size * 0.3, w - size * 0.3));
  n.y = Math.min(Math.max(n.y, size * 0.3), Math.max(size * 0.3, h - size * 0.9));
  return n;
}

/** ท่าทาง 3 มิติจากความเร็ว: หันตามทิศบิน (rotateY) เอียงตอนเลี้ยว (rotateZ) ก้ม-เงยตามแนวตั้ง (rotateX) */
export function poseOf(vx: number, vy: number, maxV: number) {
  const c = (v: number) => Math.max(-1, Math.min(1, v / maxV));
  return { yaw: c(vx) * 38, bank: c(vx) * 14, pitch: -c(vy) * 18 + 6, thrust: Math.min(1, Math.hypot(vx, vy) / maxV) };
}

const LAYERS = 6; // ชั้นความหนา (ด้านหลังภาพ) — หมุนแล้วเห็นขอบเป็นเนื้อ

@Component({
  selector: 'app-login-mascot',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="lm-ground" aria-hidden="true"></div>
    <div class="lm-fly" role="img" aria-label="น้องโคราชดี" title="น้องโคราชดี — คลิกเพื่อทักทาย">
      <div class="lm-bob">
        <div class="lm-body">
          <img *ngFor="let i of layers" class="lm-layer" [src]="src" alt="" draggable="false" [style.transform]="'translateZ(' + (-1.4 * (i + 1)) + 'px)'"
               [style.filter]="'brightness(' + (0.72 - i * 0.05) + ') saturate(0.9)'">
          <img class="lm-front" [src]="src" alt="" draggable="false">
          <span class="lm-jet lm-jet-l"></span><span class="lm-jet lm-jet-r"></span>
        </div>
      </div>
      <div class="lm-bubble">สวัสดีครับ ผมน้องโคราชดี 👋</div>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; pointer-events: none; z-index: 40; overflow: hidden; }
    .lm-fly { position: absolute; left: 0; top: 0; width: var(--lm-size, 78px); will-change: transform; pointer-events: auto; cursor: pointer; perspective: 520px; }
    .lm-bob { animation: lm-bob 2.4s ease-in-out infinite; transform-style: preserve-3d; }
    .lm-body { position: relative; transform-style: preserve-3d; transition: transform .12s linear; }
    .lm-front, .lm-layer { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; }
    .lm-front { position: relative; filter: drop-shadow(0 6px 8px rgba(15, 60, 55, .35)); }
    .lm-layer { position: absolute; inset: 0; }
    .lm-jet { position: absolute; bottom: -17%; width: 13%; height: 19%; border-radius: 50% 50% 50% 50% / 30% 30% 70% 70%;
      background: radial-gradient(ellipse at 50% 20%, #fff 0 18%, #7ff3e3 30%, #1fb5a6 55%, rgba(255, 170, 60, .55) 75%, transparent 78%);
      transform-origin: 50% 0; transform: scaleY(var(--lm-thrust, .4)); animation: lm-flame .11s ease-in-out infinite alternate; filter: blur(.4px); }
    .lm-jet-l { left: 30%; } .lm-jet-r { left: 55%; animation-delay: .05s; }
    .lm-ground { position: absolute; left: 0; bottom: 3vh; width: 70px; height: 14px; border-radius: 50%;
      background: radial-gradient(ellipse, rgba(10, 60, 50, .32), transparent 70%); will-change: transform, opacity; }
    .lm-bubble { position: absolute; bottom: 102%; left: 50%; transform: translateX(-50%) scale(.6); opacity: 0; white-space: nowrap;
      background: #fff; color: #0f766e; font-size: 12px; font-weight: 700; padding: 5px 10px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,.15);
      transition: opacity .25s, transform .25s; pointer-events: none; }
    .lm-bubble::after { content: ''; position: absolute; top: 100%; left: 50%; margin-left: -6px; border: 6px solid transparent; border-top-color: #fff; }
    .lm-fly.lm-hi .lm-bubble { opacity: 1; transform: translateX(-50%) scale(1); }
    .lm-fly.lm-spin .lm-bob { animation: lm-spin .9s cubic-bezier(.4, .1, .3, 1) 1, lm-bob 2.4s ease-in-out infinite; }
    @keyframes lm-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
    @keyframes lm-flame { from { transform: scaleY(calc(var(--lm-thrust, .4) * .8)); } to { transform: scaleY(calc(var(--lm-thrust, .4) * 1.15)); } }
    @keyframes lm-spin { from { transform: rotateY(0); } to { transform: rotateY(360deg); } }
    :host-context(.dark) .lm-bubble { background: #1e3a38; color: #a7f3e7; }
    :host-context(.dark) .lm-bubble::after { border-top-color: #1e3a38; }
    :host-context(.dark) .lm-ground { background: radial-gradient(ellipse, rgba(0, 0, 0, .45), transparent 70%); }
    @media (prefers-reduced-motion: reduce) { .lm-bob, .lm-jet { animation: none; } }
  `],
})
export class LoginMascotComponent implements AfterViewInit, OnDestroy {
  /** ตัวเลือก CSS ของกล่องที่ห้ามบัง — ทับเมื่อไหร่ ตัวละครจะไปอยู่หลังกล่อง */
  @Input() avoid = '[data-login-card]';
  src = 'mascot/korat-d-fly.webp';
  layers = Array.from({ length: LAYERS }, (_, i) => i);

  private el = inject(ElementRef<HTMLElement>);
  private zone = inject(NgZone);
  private raf = 0;
  private last = 0;
  private s!: FlyState;
  private hiTimer: any = null;
  private onClick = () => this.greet();

  ngAfterViewInit() {
    const host = this.el.nativeElement as HTMLElement;
    const fly = host.querySelector('.lm-fly') as HTMLElement;
    fly?.addEventListener('click', this.onClick);
    const w = window.innerWidth, h = window.innerHeight;
    this.s = { x: w * 0.12, y: h * 0.7, z: 0.6, vx: 0, vy: 0, vz: 0, tx: w * 0.2, ty: h * 0.3, tz: 0.8, hold: 0 };
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.zone.runOutsideAngular(() => {
      if (reduced) { this.s.vx = 0; this.render(0); return; } // ลดการเคลื่อนไหว: ลอยนิ่งมุมซ้ายล่าง
      const tick = (t: number) => {
        const dt = this.last ? Math.min(0.05, (t - this.last) / 1000) : 0.016;
        this.last = t;
        this.s = stepFly(this.s, dt, window.innerWidth, window.innerHeight, this.size());
        this.render(t);
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    });
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.hiTimer);
    (this.el.nativeElement as HTMLElement).querySelector('.lm-fly')?.removeEventListener('click', this.onClick);
  }

  private size() { return window.innerWidth < 640 ? 58 : 78; }

  private render(t: number) {
    const host = this.el.nativeElement as HTMLElement;
    const fly = host.querySelector('.lm-fly') as HTMLElement | null;
    const body = host.querySelector('.lm-body') as HTMLElement | null;
    const ground = host.querySelector('.lm-ground') as HTMLElement | null;
    if (!fly || !body) return;
    const size = this.size(), s = this.s;
    const scale = 0.62 + s.z * 0.5; // ไกล = เล็ก ใกล้ = ใหญ่
    const maxV = Math.max(90, Math.min(window.innerWidth, window.innerHeight) * 0.22);
    const p = poseOf(s.vx, s.vy, maxV);
    fly.style.setProperty('--lm-size', size + 'px');
    fly.style.transform = `translate(${s.x - size / 2}px, ${s.y - size * 0.7}px) scale(${scale.toFixed(3)})`;
    body.style.transform = `rotateY(${p.yaw.toFixed(1)}deg) rotateX(${p.pitch.toFixed(1)}deg) rotateZ(${p.bank.toFixed(1)}deg)`;
    body.style.setProperty('--lm-thrust', (0.35 + p.thrust * 0.75).toFixed(2));
    // ทับกล่องเข้าสู่ระบบ → อยู่หลังกล่อง (ระดับต่ำกว่าเนื้อหา z-10) และไม่รับคลิก — ไม่บังช่องกรอก/ปุ่ม
    const card = this.avoid ? document.querySelector(this.avoid) as HTMLElement | null : null;
    let behind = s.z < 0.28;
    if (card) {
      const r = card.getBoundingClientRect(), half = (size * scale) / 2;
      if (s.x + half > r.left && s.x - half < r.right && s.y + half > r.top && s.y - size * scale < r.bottom) behind = true;
    }
    host.style.zIndex = behind ? '5' : '40';
    fly.style.pointerEvents = behind ? 'none' : 'auto';
    fly.style.opacity = behind ? '0.85' : '1';
    if (ground) {
      const h = Math.max(0, window.innerHeight - s.y) / window.innerHeight; // สูงจากพื้น
      const g = (1 - h * 0.7) * scale;
      ground.style.transform = `translateX(${s.x - 35}px) scale(${g.toFixed(3)}, ${(g * 0.9).toFixed(3)})`;
      ground.style.opacity = (0.25 + (1 - h) * 0.6).toFixed(2);
    }
  }

  /** คลิกตัวละคร = หมุนตัว 1 รอบ + ทักทาย */
  greet() {
    const fly = (this.el.nativeElement as HTMLElement).querySelector('.lm-fly') as HTMLElement | null;
    if (!fly) return;
    fly.classList.remove('lm-spin'); void fly.offsetWidth; fly.classList.add('lm-spin', 'lm-hi');
    clearTimeout(this.hiTimer);
    this.hiTimer = setTimeout(() => fly.classList.remove('lm-spin', 'lm-hi'), 2600);
  }
}
