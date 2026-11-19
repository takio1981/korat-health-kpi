import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import type * as THREE_NS from 'three';
import { FlyState, stepFly } from './mascot-motion';
import { Joints, PoseName, autoPose, blendJoints, neutralJoints, poseTargets } from './mascot-pose';
import { FACE_H, FACE_W, FaceState, Mood, blinkAt, drawFace, faceChanged, talkMouth } from './mascot-face';
import { DialogChoice, DialogCtx, DialogScript, ResolvedNode, bubblePath, graphemes, resolveNode, thinkDots } from './mascot-dialog';
import { MascotRig, ThreeLib, applyJoints, buildMascot, loadThree, updateCape } from './mascot-model';
import { MascotService, MascotCue } from './mascot.service';

/** WebGL ใช้ได้หรือไม่ (jsdom/เบราว์เซอร์เก่า/ปิดการเร่งกราฟิก = ใช้ภาพนิ่งแทน) */
export function webglAvailable(): boolean {
  try {
    if (typeof window === 'undefined' || !(window as any).WebGLRenderingContext) return false;
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

type Mode = 'roam' | 'goto' | 'talk' | 'home';

/**
 * เวทีของน้องโคราชดี 3 มิติ (19 พ.ย. 2569): บินไปมา + กล่องคำพูดแบบมังงะ + บทสนทนา
 * — โมเดล three.js (mascot-model) วาดลง canvas เล็กที่เคลื่อนที่ด้วย CSS transform → หันตัวจริงตามทิศที่บิน
 * — ทำงานนอก Angular zone ทั้งหมด (requestAnimationFrame แก้ DOM ตรง) ข้อความพิมพ์ทีละตัวเขียนลง DOM ตรง
 *   เรียก change detection เฉพาะตอนเปิด/ปิดกล่องและแสดงตัวเลือก
 * — ไม่บังฟอร์ม: ทับ `avoid` ขณะบินเล่น = อยู่หลังกล่องและไม่รับคลิก, ตอนพูดจะบินไปอยู่นอกกล่องก่อน
 */
@Component({
  selector: 'app-mascot-stage',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ms-ground" aria-hidden="true"></div>
    <div class="ms-ring" aria-hidden="true"></div>
    <div class="ms-fly" title="น้องโคราชดี — คลิกเพื่อคุยกับผม" role="button" tabindex="0" aria-label="คุยกับน้องโคราชดี"
         (click)="onMascotClick()" (keydown.enter)="onMascotClick()">
      <img *ngIf="fallback" class="ms-img" src="mascot/korat-d-fly.webp" alt="" draggable="false">
    </div>
    <div class="ms-bubble" [class.ms-open]="!!node" [attr.data-kind]="node?.kind" role="status" aria-live="polite" (click)="onBubbleClick($event)">
      <svg class="ms-svg" aria-hidden="true"><path class="ms-shadow"></path><path class="ms-path"></path><g class="ms-dots"></g></svg>
      <div class="ms-box">
        <div class="ms-name">น้องโคราชดี</div>
        <div class="ms-text"></div>
        <div class="ms-choices" *ngIf="node && showChoices && node.choices.length">
          <button type="button" *ngFor="let c of node.choices; let i = index" class="ms-choice" [attr.data-idx]="i" (click)="choose(c, $event)">{{ c.label }}</button>
        </div>
        <button type="button" class="ms-close" aria-label="ปิดกล่องคำพูด" title="ปิด" (click)="close(); $event.stopPropagation()">×</button>
      </div>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; pointer-events: none; z-index: 40; overflow: hidden; font-family: 'Sarabun', sans-serif; }
    .ms-fly { position: absolute; left: 0; top: 0; width: var(--ms-size, 150px); height: var(--ms-size, 150px); will-change: transform; pointer-events: auto; cursor: pointer; outline: none; }
    .ms-fly canvas { width: 100% !important; height: 100% !important; display: block; filter: drop-shadow(0 8px 10px rgba(10, 70, 60, .28)); }
    .ms-img { width: 62%; margin: 8% auto 0; display: block; filter: drop-shadow(0 6px 8px rgba(15, 60, 55, .35)); }
    .ms-ground { position: absolute; left: 0; bottom: 3vh; width: 90px; height: 16px; border-radius: 50%;
      background: radial-gradient(ellipse, rgba(10, 60, 50, .3), transparent 70%); will-change: transform, opacity; }
    .ms-ring { position: absolute; left: 0; top: 0; width: 0; height: 0; border: 3px solid #161616; border-radius: 12px; opacity: 0; pointer-events: none;
      box-shadow: 0 0 0 4px #ffd84d, 0 0 18px 6px rgba(255, 200, 40, .55); transition: opacity .2s; animation: ms-pulse 1.1s ease-in-out infinite; }
    .ms-ring.ms-on { opacity: 1; }
    @keyframes ms-pulse { 0%, 100% { box-shadow: 0 0 0 4px #ffd84d, 0 0 14px 4px rgba(255, 200, 40, .45); } 50% { box-shadow: 0 0 0 7px #ffe680, 0 0 26px 10px rgba(255, 200, 40, .6); } }
    .ms-bubble { position: absolute; left: 0; top: 0; opacity: 0; transform: scale(.4); transform-origin: var(--ms-ox, 0) var(--ms-oy, 100%);
      transition: opacity .18s ease-out, transform .28s cubic-bezier(.2, 1.6, .4, 1); pointer-events: none; will-change: left, top; }
    .ms-bubble.ms-open { opacity: 1; transform: scale(1); pointer-events: auto; }
    .ms-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    .ms-path { fill: #fff; stroke: #161616; stroke-width: 3; stroke-linejoin: round; }
    .ms-shadow { fill: #161616; transform: translate(5px, 5px); }
    .ms-dots circle { fill: #fff; stroke: #161616; stroke-width: 2.5; }
    .ms-box { position: relative; max-width: min(300px, 78vw); min-width: 150px; padding: 12px 16px 12px; color: #111; }
    .ms-name { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: .02em; color: #fff; background: #0f8f80; border: 2px solid #161616;
      border-radius: 6px; padding: 0 7px; margin: -26px 0 4px -6px; transform: rotate(-3deg); box-shadow: 2px 2px 0 #161616; }
    .ms-text { font-size: 15px; line-height: 1.5; font-weight: 700; min-height: 1.5em; white-space: pre-wrap; }
    [data-kind="shout"] .ms-text { font-size: 16px; font-weight: 800; }
    [data-kind="think"] .ms-text { font-weight: 600; font-style: italic; color: #234; }
    .ms-choices { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; animation: ms-in .25s ease-out; }
    .ms-choice { font: inherit; font-size: 13px; font-weight: 700; padding: 3px 10px; border: 2px solid #161616; border-radius: 999px; background: #e9fbf7;
      color: #0b4f47; cursor: pointer; box-shadow: 2px 2px 0 #161616; transition: transform .08s, box-shadow .08s, background .15s; }
    .ms-choice:hover, .ms-choice:focus-visible { background: #bff3ea; outline: none; transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #161616; }
    .ms-choice:active { transform: translate(2px, 2px); box-shadow: 0 0 0 #161616; }
    .ms-close { position: absolute; top: -10px; right: -10px; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #161616; background: #fff;
      font-size: 15px; line-height: 18px; font-weight: 800; color: #161616; cursor: pointer; box-shadow: 2px 2px 0 #161616; padding: 0; }
    .ms-close:hover { background: #ffe1e1; }
    @keyframes ms-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    :host-context(.dark) .ms-ground { background: radial-gradient(ellipse, rgba(0, 0, 0, .45), transparent 70%); }
    @media (prefers-reduced-motion: reduce) { .ms-bubble { transition: none; } }
  `],
})
export class MascotStageComponent implements AfterViewInit, OnDestroy {
  @Input() script: DialogScript = {};
  @Input() tips: string[] = [];
  /** ตัวเลือก CSS ของกล่องที่ห้ามบังขณะบินเล่น */
  @Input() avoid = '';
  /** คีย์ sessionStorage — มีค่า = ทักทาย (บท start) ครั้งเดียวต่อการเปิดเบราว์เซอร์ */
  @Input() greetKey = '';
  @Input() ctx: Partial<DialogCtx> = {};
  /** ตัวเลือกช่องรหัสผ่าน — โฟกัสแล้วน้องยกมือปิดจอ */
  @Input() shyOn = 'input[type="password"]';
  /** โหมดผู้ช่วยในระบบ: จอดมุมขวาล่าง (ไม่บินเล่นทั่วจอ) บินออกไปเฉพาะตอนชี้ */
  @Input() dock = false;
  /** ตัวเลือกที่เป็นคำสั่งอื่นนอกจาก nav: (เช่น tour:next, hide) ส่งออกให้ผู้ใช้คอมโพเนนต์จัดการ */
  @Output() action = new EventEmitter<string>();

  node: ResolvedNode | null = null;
  showChoices = false;
  fallback = false;

  private el = inject(ElementRef<HTMLElement>);
  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private mascot = inject(MascotService);

  private L: ThreeLib | null = null;
  private renderer: THREE_NS.WebGLRenderer | null = null;
  private scene: THREE_NS.Scene | null = null;
  private camera: THREE_NS.PerspectiveCamera | null = null;
  private rig: MascotRig | null = null;
  private envTex: THREE_NS.Texture | null = null;
  private faceCanvas: HTMLCanvasElement | null = null;
  private lastFace: FaceState | null = null;

  private raf = 0;
  private last = 0;
  private clock = 0;
  private s!: FlyState;
  private mode: Mode = 'roam';
  private anchor = { x: 0, y: 0 };
  private joints: Joints = neutralJoints();
  private yaw = 0;
  private pointer = { x: -1, y: -1 };
  private chars: string[] = [];
  private typed = 0;
  private nextCharAt = 0;
  private nodeStart = 0;
  private closeAt = 0;
  /** ทิศของเป้าหมายที่ชี้ (+1 = ขวาของจอ, -1 = ซ้าย, 0 = ไม่มี) */
  private pointDir = 0;
  private shyUntil = 0;
  private shySaid = false;
  private nextTipAt = 0;
  private tipsShown = 0;
  private greetTimer: any = null;
  private destroyed = false;
  private reduced = false;
  private sub: Subscription | null = null;
  private listeners: [EventTarget, string, EventListener][] = [];

  private get size() { return this.dock ? (window.innerWidth < 640 ? 96 : 128) : (window.innerWidth < 640 ? 124 : 176); }
  private nextGestureAt = 25;
  private gesture: PoseName | null = null;
  private gestureUntil = 0;
  private get maxV() { return Math.max(90, Math.min(window.innerWidth, window.innerHeight) * 0.22); }

  ngAfterViewInit() {
    const w = window.innerWidth, h = window.innerHeight;
    this.s = { x: w * 0.12, y: h * 0.72, z: 0.6, vx: 0, vy: 0, vz: 0, tx: w * 0.2, ty: h * 0.35, tz: 0.8, hold: 0 };
    if (this.dock) { const hm = this.homePos(); this.s = { ...this.s, x: hm.x, y: hm.y + 40, z: 1 }; this.mode = 'home'; }
    this.reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.nextTipAt = 40 + Math.random() * 25;
    this.sub = this.mascot.cues.subscribe(c => this.zone.runOutsideAngular(() => this.cue(c)));

    this.zone.runOutsideAngular(() => {
      this.listen(window, 'pointermove', (e: Event) => { const p = e as PointerEvent; this.pointer = { x: p.clientX, y: p.clientY }; });
      this.listen(document, 'focusin', (e: Event) => this.onFocus(e.target as Element | null));
      this.listen(document, 'keydown', (e: Event) => { if ((e as KeyboardEvent).key === 'Escape' && this.node) this.close(); });
      if (this.greetKey && !this.sessionHas(this.greetKey)) {
        this.greetTimer = setTimeout(() => { this.sessionSet(this.greetKey); this.open('start'); }, 1400);
      }
    });

    if (!webglAvailable()) { this.fallback = true; this.cdr.detectChanges(); this.startLoop(); return; }
    loadThree().then(L => {
      if (this.destroyed) return;
      this.zone.runOutsideAngular(() => this.initThree(L));
    }).catch(() => { this.fallback = true; this.cdr.detectChanges(); this.startLoop(); });
  }

  ngOnDestroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.greetTimer);
    this.sub?.unsubscribe();
    for (const [t, n, f] of this.listeners) t.removeEventListener(n, f);
    this.rig?.dispose();
    this.envTex?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
  }

  // ===================== three.js =====================
  private async initThree(L: ThreeLib) {
    const { THREE } = L;
    this.L = L;
    const host = this.el.nativeElement as HTMLElement;
    const fly = host.querySelector('.ms-fly') as HTMLElement;
    this.faceCanvas = document.createElement('canvas');
    this.faceCanvas.width = FACE_W; this.faceCanvas.height = FACE_H;
    const seal = new Image(); seal.src = 'mascot/seal.webp';
    const sealOk = await seal.decode().then(() => true).catch(() => false);
    if (this.destroyed) return;
    let renderer: THREE_NS.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      this.fallback = true; this.cdr.detectChanges(); this.startLoop(); return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(this.size, this.size, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    fly.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(renderer);
    this.envTex = pm.fromScene(new L.RoomEnvironment(), 0.04).texture; pm.dispose();
    scene.environment = this.envTex; scene.environmentIntensity = 0.4;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8fd3c8, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 3, 4); scene.add(key);
    const rim = new THREE.DirectionalLight(0xbff7ef, 1.2); rim.position.set(-3, 2, -3); scene.add(rim);
    const rig = buildMascot(L, this.faceCanvas, sealOk ? seal : null);
    scene.add(rig.root);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    cam.position.set(0, 1.04, 4.1); cam.lookAt(0, 1.0, 0);
    this.renderer = renderer; this.scene = scene; this.camera = cam; this.rig = rig;
    this.startLoop();
  }

  private startLoop() {
    if (this.raf || this.destroyed) return;
    const tick = (t: number) => {
      if (this.destroyed) return;
      const dt = this.last ? Math.min(0.05, (t - this.last) / 1000) : 0.016;
      this.last = t; this.clock += dt;
      this.frame(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // ===================== เฟรม =====================
  private frame(dt: number) {
    const host = this.el.nativeElement as HTMLElement;
    const fly = host.querySelector('.ms-fly') as HTMLElement | null;
    if (!fly) return;
    const W = window.innerWidth, H = window.innerHeight, size = this.size, t = this.clock;

    // ---- การเคลื่อนที่
    if (this.mode === 'home') {
      this.anchor = this.homePos();
      this.seek(dt);
    } else if (this.mode === 'roam') {
      if (this.reduced) { this.s = { ...this.s, x: size * 0.7, y: H - size * 0.5, vx: 0, vy: 0 }; }
      else this.s = stepFly(this.s, dt, W, H, size);
    } else {
      this.seek(dt);
      if (this.mode === 'goto' && Math.hypot(this.anchor.x - this.s.x, this.anchor.y - this.s.y) < 26) this.beginTalk();
    }
    const s = this.s;
    const speed = Math.min(1, Math.hypot(s.vx, s.vy) / this.maxV);

    // ---- ท่าทาง
    const pose = this.currentPose(speed, t);
    let target = poseTargets(pose, t, { speed });
    const lookX = this.pointer.x < 0 ? 0 : Math.max(-1, Math.min(1, (this.pointer.x - s.x) / 420));
    const lookY = this.pointer.y < 0 ? 0 : Math.max(-1, Math.min(1, (this.pointer.y - (s.y - size * 0.45)) / 420));
    if (pose !== 'fly' && pose !== 'shy') target = { ...target, headYaw: target.headYaw + lookX * 0.35, headPitch: target.headPitch + lookY * 0.12 };
    this.joints = blendJoints(this.joints, target, dt);

    // ---- ใบหน้า
    const mood: Mood = this.shyActive() ? 'shy' : (this.node ? this.node.mood : 'normal');
    const typing = !!this.node && this.typed < this.chars.length && this.mode === 'talk';
    const face: FaceState = {
      blink: mood === 'shy' ? 0 : blinkAt(t), mouth: typing ? talkMouth(t) : (this.node && mood === 'happy' ? 0.35 : 0),
      lookX, lookY, mood,
    };

    // ---- หันตัว: บิน = หันตามทิศ, คุย = หันหาผู้ใช้ (เอียงไปทางกล่องคำพูดเล็กน้อย)
    let yawT = 0;
    if (this.mode === 'talk') yawT = this.pointDir ? this.pointDir * 0.25 : this.bubbleSide() * 0.3;
    else if (speed > 0.12) yawT = Math.max(-1, Math.min(1, s.vx / this.maxV)) * 1.35;
    else yawT = lookX * 0.35;
    this.yaw += (yawT - this.yaw) * (1 - Math.exp(-dt * 4.5));

    if (this.rig && this.renderer && this.scene && this.camera && this.faceCanvas) {
      if (faceChanged(this.lastFace, face)) {
        const ctx = this.faceCanvas.getContext('2d');
        if (ctx) { drawFace(ctx, face); this.rig.faceTexture.needsUpdate = true; }
        this.lastFace = face;
      }
      const flying = this.mode !== 'talk' && speed > 0.12;
      this.rig.root.rotation.set(flying ? -s.vy / this.maxV * 0.25 : 0, this.yaw, flying ? -s.vx / this.maxV * 0.18 : 0);
      applyJoints(this.rig, this.joints);
      updateCape(this.rig, 0.12 + 0.88 * speed, t);
      this.rig.heart.rotation.z = Math.sin(t * 3.1) * 0.12;
      this.renderer.render(this.scene, this.camera);
    }

    // ---- ตำแหน่งบนจอ
    const scale = this.mode === 'roam' ? 0.66 + s.z * 0.38 : 1;
    this.updateRing();
    fly.style.setProperty('--ms-size', size + 'px');
    fly.style.transform = `translate(${(s.x - size / 2).toFixed(1)}px, ${(s.y - size * 0.62).toFixed(1)}px) scale(${scale.toFixed(3)})`;
    if (this.fallback) {
      const img = fly.querySelector('.ms-img') as HTMLElement | null;
      if (img) img.style.transform = `rotate(${(Math.max(-1, Math.min(1, s.vx / this.maxV)) * 12).toFixed(1)}deg) translateY(${(Math.sin(t * 2.6) * 5).toFixed(1)}px)`;
    }
    let behind = false;
    if (this.mode === 'roam') {
      behind = s.z < 0.28;
      const r = this.avoidRect();
      if (r) {
        const half = (size * scale) / 2;
        if (s.x + half * 0.6 > r.left && s.x - half * 0.6 < r.right && s.y + half * 0.3 > r.top && s.y - size * scale * 0.6 < r.bottom) behind = true;
      }
    }
    host.style.zIndex = behind ? '5' : '40';
    fly.style.pointerEvents = behind ? 'none' : 'auto';
    fly.style.opacity = behind ? '0.85' : '1';
    const ground = host.querySelector('.ms-ground') as HTMLElement | null;
    if (ground) {
      const hh = Math.max(0, H - s.y) / H;
      const g = (1 - hh * 0.7) * scale;
      ground.style.transform = `translateX(${(s.x - 45).toFixed(1)}px) scale(${g.toFixed(3)}, ${(g * 0.9).toFixed(3)})`;
      ground.style.opacity = (0.25 + (1 - hh) * 0.6).toFixed(2);
    }

    // ---- กล่องคำพูด
    this.updateBubble(t);
    if (!this.node && this.tips.length && this.tipsShown < 4 && t > this.nextTipAt && this.mode === 'roam' && !this.shyActive()) {
      this.tipsShown++; this.nextTipAt = t + 55 + Math.random() * 30;
      const tip = this.tips[Math.floor(Math.random() * this.tips.length)];
      this.openResolved({ id: 'tip', text: tip, kind: 'think', pose: 'hover', mood: 'normal', choices: [], auto: 5200, pointAt: null });
    }
  }

  private currentPose(speed: number, t: number): PoseName {
    if (this.shyActive()) return 'shy';
    if (this.mode === 'home') {
      if (speed > 0.15) return 'fly';
      if (this.gesture && t < this.gestureUntil) return this.gesture;
      if (t > this.nextGestureAt && !this.reduced) {
        const g: PoseName[] = ['wave', 'think', 'cheer', 'sit'];
        this.gesture = g[Math.floor(Math.random() * g.length)];
        this.gestureUntil = t + (this.gesture === 'sit' ? 6 : 2.2);
        this.nextGestureAt = t + 28 + Math.random() * 25;
        return this.gesture;
      }
      return 'idle';
    }
    if (this.mode === 'goto') return speed > 0.1 ? 'fly' : 'hover';
    if (this.mode === 'talk' && this.node) {
      const el = t - this.nodeStart, p = this.node.pose, typing = this.typed < this.chars.length;
      if (p === 'wave') return el < 2.4 ? 'wave' : typing ? 'talk' : 'idle';
      if (p === 'talk') return typing ? 'talk' : 'idle';
      if (p === 'hover') return 'hover';
      if (p === 'point' && this.pointDir) return this.pointDir > 0 ? 'aimRight' : 'aimLeft';
      return p;
    }
    return autoPose(speed, this.s.hold > 0);
  }

  private seek(dt: number) {
    const s = this.s, k = 7, d = 2 * Math.sqrt(k);
    const ax = (this.anchor.x - s.x) * k - s.vx * d, ay = (this.anchor.y - s.y) * k - s.vy * d;
    const vx = s.vx + ax * dt, vy = s.vy + ay * dt;
    const sp = Math.hypot(vx, vy), mv = this.maxV * 2.2, f = sp > mv ? mv / sp : 1;
    this.s = { ...s, vx: vx * f, vy: vy * f, x: s.x + vx * f * dt, y: s.y + vy * f * dt, z: s.z + (1 - s.z) * Math.min(1, dt * 3) };
  }

  /** ตำแหน่งจอดมุมขวาล่าง */
  private homePos() { const sz = this.size; return { x: window.innerWidth - sz * 0.62, y: window.innerHeight - sz * 0.32 }; }

  /** วงไฮไลต์รอบสิ่งที่กำลังชี้ (ตามการเลื่อนหน้าจอทุกเฟรม) */
  private updateRing() {
    const ring = (this.el.nativeElement as HTMLElement).querySelector('.ms-ring') as HTMLElement | null;
    if (!ring) return;
    const sel = this.node?.pointAt;
    const el = sel && this.mode === 'talk' ? document.querySelector(sel) as HTMLElement | null : null;
    if (!el || el.offsetParent === null) { ring.classList.remove('ms-on'); return; }
    const r = el.getBoundingClientRect(), pad = 6;
    ring.style.left = (r.left - pad).toFixed(1) + 'px'; ring.style.top = (r.top - pad).toFixed(1) + 'px';
    ring.style.width = (r.width + pad * 2).toFixed(1) + 'px'; ring.style.height = (r.height + pad * 2).toFixed(1) + 'px';
    ring.classList.add('ms-on');
  }

  private avoidRect(): DOMRect | null {
    if (!this.avoid) return null;
    const el = document.querySelector(this.avoid) as HTMLElement | null;
    return el ? el.getBoundingClientRect() : null;
  }

  /** ฝั่งของกล่องคำพูด (+1 = ขวาของตัวละคร): หันออกจากกล่องที่ห้ามบังถ้ามีที่พอ ไม่งั้นฝั่งที่จอกว้างกว่า */
  private bubbleSide(): number {
    const r = this.avoidRect(), x = this.s.x, room = 300;
    if (r) {
      if (x <= r.left && x - this.size * 0.42 > room) return -1;
      if (x >= r.right && window.innerWidth - x - this.size * 0.42 > room) return 1;
    }
    return x < window.innerWidth / 2 ? 1 : -1;
  }

  // ===================== บทสนทนา =====================
  private dialogCtx(): DialogCtx { return { hour: new Date().getHours(), ...this.ctx }; }

  open(id: string) {
    const n = resolveNode(this.script, id, this.dialogCtx());
    if (n) this.openResolved(n);
  }

  openResolved(n: ResolvedNode) {
    this.node = n;
    this.showChoices = false;
    this.chars = graphemes(n.text);
    this.typed = this.reduced ? this.chars.length : 0;
    this.closeAt = 0;
    this.setText('');
    this.anchor = this.anchorFor(n.pointAt);
    const pt = n.pointAt ? document.querySelector(n.pointAt) as HTMLElement | null : null;
    const pr = pt && pt.offsetParent !== null ? pt.getBoundingClientRect() : null;
    this.pointDir = pr ? (pr.left + pr.width / 2 > this.anchor.x ? 1 : -1) : 0;
    const far = Math.hypot(this.anchor.x - this.s.x, this.anchor.y - this.s.y) > 30;
    this.mode = far && !this.reduced ? 'goto' : 'talk';
    if (this.mode === 'talk') this.beginTalk();
    this.cdr.detectChanges();
  }

  private beginTalk() {
    this.mode = 'talk';
    this.nodeStart = this.clock;
    this.nextCharAt = this.clock + 0.15;
  }

  /** ตำแหน่งยืนพูด: ข้างเป้าหมายที่ชี้ (นอกกล่องที่ห้ามบัง) หรือที่เดิม (ถ้าทับกล่อง = ย้ายออกไปข้างกล่อง) */
  private anchorFor(sel: string | null): { x: number; y: number } {
    const W = window.innerWidth, H = window.innerHeight, size = this.size;
    const clampP = (x: number, y: number) => ({ x: Math.max(size * 0.5, Math.min(W - size * 0.5, x)), y: Math.max(size * 0.75, Math.min(H - size * 0.4, y)) });
    const card = this.avoidRect();
    const target = sel ? document.querySelector(sel) as HTMLElement | null : null;
    const tr = target && target.offsetParent !== null ? target.getBoundingClientRect() : null;
    if (tr) {
      const box = card || tr;
      const y = tr.top + tr.height / 2 + size * 0.1;
      if (box.left > size * 1.1) return clampP(box.left - size * 0.45, y);
      if (W - box.right > size * 1.1) return clampP(box.right + size * 0.45, y);
      return clampP(Math.min(W - size * 0.5, tr.right + size * 0.2), tr.top - size * 0.35);
    }
    let { x, y } = this.s;
    if (card && x > card.left - size * 0.4 && x < card.right + size * 0.4 && y > card.top - size * 0.3 && y < card.bottom + size * 0.4) {
      x = card.left > size * 1.1 ? card.left - size * 0.5 : W - card.right > size * 1.1 ? card.right + size * 0.5 : x;
      if (x === this.s.x) y = Math.max(size * 0.8, card.top - size * 0.4);
    }
    return clampP(x, y);
  }

  close() {
    if (!this.node) return;
    this.node = null;
    this.showChoices = false;
    this.mode = this.dock ? 'home' : 'roam';
    this.s = { ...this.s, hold: 0.8 };
    this.setText('');
    this.cdr.detectChanges();
  }

  choose(c: DialogChoice, e?: Event) {
    e?.stopPropagation();
    if (c.next) { this.open(c.next); return; }
    if (c.action?.startsWith('nav:')) {
      const url = c.action.slice(4);
      this.close();
      this.zone.run(() => this.router.navigateByUrl(url));
      return;
    }
    if (c.action) { const a = c.action; this.zone.run(() => this.action.emit(a)); return; }
    this.close();
  }

  onMascotClick() {
    if (this.node && this.typed < this.chars.length) { this.typed = this.chars.length; return; }
    if (this.node && this.node.choices.length) { this.close(); return; }
    this.open(this.greetKey && this.sessionHas(this.greetKey) && this.script['menu'] ? 'menu' : 'start');
    if (this.greetKey) this.sessionSet(this.greetKey);
  }

  onBubbleClick(e: Event) {
    if ((e.target as HTMLElement).closest('button')) return;
    if (this.node && this.typed < this.chars.length) this.typed = this.chars.length;
    else if (this.node && !this.node.choices.length) this.close();
  }

  private cue(c: MascotCue) {
    if (c.node) { this.open(c.node); return; }
    if (c.text) this.openResolved({ id: 'cue', text: c.text, kind: c.kind || 'speech', pose: c.pose || 'talk', mood: c.mood || 'normal', choices: [], auto: c.auto ?? 6000, pointAt: null });
  }

  private onFocus(el: Element | null) {
    if (!el || !this.shyOn || !(el as HTMLElement).matches?.(this.shyOn)) return;
    this.shyUntil = this.clock + 2.8;
    if (!this.shySaid && (!this.node || !this.node.choices.length)) { this.shySaid = true; this.open('shy'); }
  }

  private shyActive() { return this.clock < this.shyUntil || this.node?.pose === 'shy'; }

  private setText(v: string) {
    const el = (this.el.nativeElement as HTMLElement).querySelector('.ms-text');
    if (el) el.textContent = v;
  }

  private updateBubble(t: number) {
    const host = this.el.nativeElement as HTMLElement;
    const bub = host.querySelector('.ms-bubble') as HTMLElement | null;
    if (!bub || !this.node) return;
    if (this.mode === 'talk') {
      // พิมพ์ทีละตัว (ช้าลงที่เครื่องหมายวรรคตอน)
      while (this.typed < this.chars.length && t >= this.nextCharAt) {
        const ch = this.chars[this.typed++];
        this.nextCharAt += /[.!?…]/.test(ch) ? 0.22 : ch === ' ' ? 0.06 : 0.034;
        this.setText(this.chars.slice(0, this.typed).join(''));
      }
      if (this.typed >= this.chars.length) {
        if (!this.showChoices && this.node.choices.length) { this.showChoices = true; this.cdr.detectChanges(); }
        if (this.node.auto && !this.closeAt) this.closeAt = t + this.node.auto / 1000;
        if (this.closeAt && t >= this.closeAt) { this.close(); return; }
      }
    }
    if (this.mode !== 'talk') { bub.style.visibility = 'hidden'; return; }
    bub.style.visibility = 'visible';
    // วางกล่องข้างตัวละคร (ฝั่งที่กว้างกว่า) ไม่ล้นจอ
    const box = bub.querySelector('.ms-box') as HTMLElement;
    const bw = box.offsetWidth, bh = box.offsetHeight;
    const W = window.innerWidth, H = window.innerHeight, size = this.size, s = this.s;
    const side = this.bubbleSide();
    let left = side > 0 ? s.x + size * 0.42 : s.x - size * 0.42 - bw;
    let top = s.y - size * 0.62 - bh * 0.55;
    left = Math.max(10, Math.min(W - bw - 12, left));
    top = Math.max(30, Math.min(H - bh - 12, top));
    // จอแคบ: กล่องทับสิ่งที่กำลังชี้ → ย้ายไปเหนือ (หรือใต้) เป้าหมาย
    const pt = this.node.pointAt ? document.querySelector(this.node.pointAt) as HTMLElement | null : null;
    if (pt && pt.offsetParent !== null) {
      const r = pt.getBoundingClientRect();
      if (left < r.right && left + bw > r.left && top < r.bottom && top + bh > r.top) {
        top = r.top - bh - 16 >= 10 ? r.top - bh - 16 : Math.min(H - bh - 10, r.bottom + 16);
      }
    }
    bub.style.left = left.toFixed(1) + 'px';
    bub.style.top = top.toFixed(1) + 'px';
    const tail = { x: s.x - side * size * 0.12 - left, y: s.y - size * 0.4 - top };
    bub.style.setProperty('--ms-ox', tail.x.toFixed(0) + 'px');
    bub.style.setProperty('--ms-oy', tail.y.toFixed(0) + 'px');
    const svg = bub.querySelector('.ms-svg') as SVGSVGElement;
    svg.setAttribute('width', String(bw)); svg.setAttribute('height', String(bh));
    const d = bubblePath(this.node.kind, bw, bh, tail);
    (svg.querySelector('.ms-path') as SVGPathElement).setAttribute('d', d);
    (svg.querySelector('.ms-shadow') as SVGPathElement).setAttribute('d', d);
    const g = svg.querySelector('.ms-dots') as SVGGElement;
    if (this.node.kind === 'think') {
      const dots = thinkDots(bw, bh, tail);
      if (g.childElementCount !== dots.length) g.innerHTML = dots.map(() => '<circle></circle>').join('');
      dots.forEach((p, i) => { const c = g.children[i]; c.setAttribute('cx', p.x.toFixed(1)); c.setAttribute('cy', p.y.toFixed(1)); c.setAttribute('r', String(p.r)); });
    } else if (g.childElementCount) g.innerHTML = '';
  }

  // ===================== อื่นๆ =====================
  private listen(t: EventTarget, n: string, f: EventListener) { t.addEventListener(n, f, { passive: true } as any); this.listeners.push([t, n, f]); }
  private sessionHas(k: string) { try { return !!sessionStorage.getItem(k); } catch { return false; } }
  private sessionSet(k: string) { try { sessionStorage.setItem(k, '1'); } catch { /* ไม่มีที่เก็บ */ } }
}
