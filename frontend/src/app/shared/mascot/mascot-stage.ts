import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import type * as THREE_NS from 'three';
import { FlyState, stepFly } from './mascot-motion';
import { Joints, PoseName, autoPose, blendJoints, neutralJoints, poseTargets } from './mascot-pose';
import { FACE_H, FACE_W, FaceState, Mood, blinkAt, drawFace, faceChanged, talkMouth } from './mascot-face';
import { DialogChoice, DialogCtx, DialogScript, ResolvedNode, bubblePath, graphemes, resolveNode, thinkDots } from './mascot-dialog';
import { MascotRig, ThreeLib, applyJoints, buildMascot, loadThree, updateCape, updateJets } from './mascot-model';
import { Activity, HOME_KEY, groundYOf, loadHome, planRest, saveHome } from './mascot-activity';
import { MascotService, MascotCue } from './mascot.service';
import { MascotSize, mascotPx, normalizeMascotSize } from './mascot-size';
import { Festival, activeFestival, thaiDateKey } from './mascot-festival';
import type { Outfit } from './mascot-outfit';

/** ตัวสร้างชุดเทศกาลโหลดแยกไฟล์ (เหมือน three.js) — ไม่เพิ่มขนาด initial bundle */
let outfitModule: Promise<typeof import('./mascot-outfit')> | null = null;
const loadOutfitModule = () => (outfitModule ||= import('./mascot-outfit'));

/** คีย์ localStorage: อวยพรเทศกาลไปแล้ว (id|วันที่) */
export const FEST_GREET_KEY = 'kpi_mascot_fest_greeted';
import { VoicePlayer } from './mascot-voice';

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
 * เวทีของน้องคิดดี 3 มิติ (19 พ.ย. 2569): บินไปมา + กล่องคำพูดแบบมังงะ + บทสนทนา
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
    <div class="ms-zzz" aria-hidden="true"><span>Z</span><span>z</span><span>z</span></div>
    <div class="ms-fly" title="น้องคิดดี — คลิกเพื่อคุยกับผม · ลากเพื่อย้ายตำแหน่ง" role="button" tabindex="0" aria-label="คุยกับน้องคิดดี"
         (click)="onMascotClick()" (keydown.enter)="onMascotClick()">
      <img *ngIf="fallback" class="ms-img" src="mascot/korat-d-fly.webp" alt="" draggable="false">
    </div>
    <div class="ms-bubble" [class.ms-open]="!!node" [attr.data-kind]="node?.kind" role="status" aria-live="polite" (click)="onBubbleClick($event)">
      <svg class="ms-svg" aria-hidden="true"><path class="ms-shadow"></path><path class="ms-path"></path><g class="ms-dots"></g></svg>
      <div class="ms-box">
        <div class="ms-name">น้องคิดดี</div>
        <div class="ms-text"></div>
        <div class="ms-note" *ngIf="node?.note">{{ node?.note }}</div>
        <form class="ms-ask" *ngIf="node?.input && showChoices" (submit)="submitAsk($event)">
          <input class="ms-input" type="text" maxlength="300" autocomplete="off" [attr.placeholder]="node?.input?.placeholder" aria-label="พิมพ์คำถาม">
          <button type="submit" class="ms-choice ms-send">ถาม</button>
        </form>
        <div class="ms-choices" *ngIf="node && showChoices && node.choices.length">
          <button type="button" *ngFor="let c of node.choices; let i = index" class="ms-choice" [attr.data-idx]="i" (click)="choose(c, $event)">{{ c.label }}</button>
        </div>
        <button type="button" class="ms-close" aria-label="ปิดกล่องคำพูด" title="ปิด" (click)="close(); $event.stopPropagation()">×</button>
        <button *ngIf="voice" type="button" class="ms-mute" [attr.aria-pressed]="muted" [attr.aria-label]="muted ? 'เปิดเสียงน้องคิดดี' : 'ปิดเสียงน้องคิดดี'"
                [title]="muted ? 'เปิดเสียงพูด' : 'ปิดเสียงพูด'" (click)="toggleMute(); $event.stopPropagation()">
          <i class="fas" [ngClass]="muted ? 'fa-volume-xmark' : 'fa-volume-high'"></i>
        </button>
      </div>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; pointer-events: none; z-index: 40; overflow: hidden; font-family: 'Sarabun', sans-serif; }
    .ms-fly { position: absolute; left: 0; top: 0; width: var(--ms-size, 150px); height: var(--ms-size, 150px); will-change: transform; pointer-events: auto; cursor: grab; outline: none; touch-action: none; user-select: none; }
    .ms-fly.ms-dragging { cursor: grabbing; }
    .ms-zzz { position: absolute; left: 0; top: 0; z-index: 3; opacity: 0; pointer-events: none; font-weight: 900; color: #0f766e; -webkit-text-stroke: 1px #fff; text-shadow: 0 2px 4px rgba(0,0,0,.18); transition: opacity .4s; }
    .ms-zzz.ms-on { opacity: 1; }
    .ms-zzz span { position: absolute; animation: ms-z 2.4s ease-in infinite; opacity: 0; }
    .ms-zzz span:nth-child(1) { font-size: 30px; animation-delay: 0s; }
    .ms-zzz span:nth-child(2) { font-size: 24px; animation-delay: .8s; }
    .ms-zzz span:nth-child(3) { font-size: 18px; animation-delay: 1.6s; }
    @keyframes ms-z { 0% { transform: translate(0, 0) rotate(-8deg); opacity: 0; } 20% { opacity: 1; } 100% { transform: translate(26px, -46px) rotate(12deg); opacity: 0; } }
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
    .ms-text { font-size: 15px; line-height: 1.5; font-weight: 700; min-height: 1.5em; white-space: pre-wrap; max-height: 42vh; overflow-y: auto; }
    [data-kind="shout"] .ms-text { font-size: 16px; font-weight: 800; }
    [data-kind="think"] .ms-text { font-weight: 600; font-style: italic; color: #234; }
    .ms-note { font-size: 11px; color: #555; margin-top: 4px; font-weight: 600; }
    .ms-ask { display: flex; gap: 6px; margin-top: 8px; animation: ms-in .25s ease-out; }
    .ms-input { flex: 1; min-width: 0; font: inherit; font-size: 13px; padding: 4px 10px; border: 2px solid #161616; border-radius: 10px; background: #fff; color: #111; outline: none; }
    .ms-input:focus { box-shadow: 0 0 0 3px #bff3ea; }
    .ms-choices { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; animation: ms-in .25s ease-out; }
    .ms-choice { font: inherit; font-size: 13px; font-weight: 700; padding: 3px 10px; border: 2px solid #161616; border-radius: 999px; background: #e9fbf7;
      color: #0b4f47; cursor: pointer; box-shadow: 2px 2px 0 #161616; transition: transform .08s, box-shadow .08s, background .15s; }
    .ms-choice:hover, .ms-choice:focus-visible { background: #bff3ea; outline: none; transform: translate(-1px, -1px); box-shadow: 3px 3px 0 #161616; }
    .ms-choice:active { transform: translate(2px, 2px); box-shadow: 0 0 0 #161616; }
    .ms-close { position: absolute; top: -10px; right: -10px; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #161616; background: #fff;
      font-size: 15px; line-height: 18px; font-weight: 800; color: #161616; cursor: pointer; box-shadow: 2px 2px 0 #161616; padding: 0; }
    .ms-close:hover { background: #ffe1e1; }
    .ms-mute { position: absolute; top: -10px; right: 20px; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #161616; background: #fff;
      font-size: 10px; line-height: 18px; color: #0f766e; cursor: pointer; box-shadow: 2px 2px 0 #161616; padding: 0; }
    .ms-mute[aria-pressed="true"] { color: #9ca3af; }
    .ms-mute:hover { background: #e9fbf7; }
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
  /** เปิดเสียงพูด (ค่าระบบ mascot_voice_enabled) — ผู้ใช้ปิดเองได้ที่ปุ่มลำโพงในกล่องคำพูด */
  @Input() voice = true;
  muted = false;
  private player: VoicePlayer | null = null;
  private charDelay = 0.034;
  private voiced = false;

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
  private festTimer: any = null;
  private outfit: Outfit | null = null;
  private outfitId = '';
  private nextOutfitCheck = 60;
  private destroyed = false;
  private reduced = false;
  private sub: Subscription | null = null;
  private listeners: [EventTarget, string, EventListener][] = [];

  /** ขนาดตั้งต้นของระบบ (system_settings.mascot_size) — ผู้ใช้เลือกเองได้ในเมนูของน้อง (MascotService.size$ มาก่อน) */
  @Input() sizeDefault: MascotSize = 'medium';
  private userSize: MascotSize | '' = '';
  private renderedSize = 0;
  /** ขนาดจริงตามขนาดที่เลือก × สเกลของจอ (มือถือ/แท็บเล็ตย่อลงแบบต่อเนื่อง) */
  private get size() { return mascotPx(this.userSize || normalizeMascotSize(this.sizeDefault), this.dock, window.innerWidth, window.innerHeight); }
  private nextGestureAt = 25;
  private gesture: PoseName | null = null;
  private gestureUntil = 0;
  /** กิจกรรมปัจจุบัน — ในอากาศ / ลงจอด / ยืน / เดิน / นั่ง / นอน (ระหว่างคุยหรือถูกลากใช้ mode/drag แทน) */
  private act: Activity = 'air';
  private actUntil = 0;
  private plan: Activity[] = [];
  private walkTo = 0;
  private nextRestAt = 20;
  private jetLevel = 0;
  private drag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean; lx: number; ly: number } | null = null;
  private suppressClick = false;
  private customHome: { fx: number; fy: number; ground: boolean } | null = null;
  private get maxV() { return Math.max(90, Math.min(window.innerWidth, window.innerHeight) * 0.22); }

  ngAfterViewInit() {
    const w = window.innerWidth, h = window.innerHeight;
    this.s = { x: w * 0.12, y: h * 0.72, z: 0.6, vx: 0, vy: 0, vz: 0, tx: w * 0.2, ty: h * 0.35, tz: 0.8, hold: 0 };
    if (this.dock) {
      this.customHome = loadHome();
      const hm = this.homePos(); this.s = { ...this.s, x: hm.x, y: hm.y + 40, z: 1 }; this.mode = 'home';
      this.act = this.homeOnGround() ? 'stand' : 'hover';
    }
    this.nextRestAt = (this.dock ? 35 : 18) + Math.random() * 20;
    this.reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.nextTipAt = 40 + Math.random() * 25;
    this.sub = this.mascot.cues.subscribe(c => this.zone.runOutsideAngular(() => this.cue(c)));
    this.sub.add(this.mascot.voiceMuted$.subscribe(m => { this.muted = m; if (m) this.player?.stop(); }));
    this.sub.add(this.mascot.size$.subscribe(v => { this.userSize = v; }));
    // ชุดเทศกาล: ค่าระบบ/ลองชุดเปลี่ยน = ใส่ชุดใหม่ทันที, อวยพรเทศกาลหลังเปิดหน้าสักพัก (วันละครั้งต่อเครื่อง)
    this.sub.add(this.mascot.outfit$.subscribe(() => this.zone.runOutsideAngular(() => this.refreshOutfit())));
    this.sub.add(this.mascot.outfitPreview$.subscribe(() => this.zone.runOutsideAngular(() => this.refreshOutfit())));
    this.zone.runOutsideAngular(() => { this.festTimer = setTimeout(() => this.festivalGreet(), this.dock ? 9000 : 7000); });
    if (this.voice && typeof Audio !== 'undefined') { this.player = new VoicePlayer(); this.player.live = () => this.mascot.liveTts; this.player.load(); }

    this.zone.runOutsideAngular(() => {
      this.listen(window, 'pointermove', (e: Event) => { const p = e as PointerEvent; this.pointer = { x: p.clientX, y: p.clientY }; });
      this.listen(document, 'focusin', (e: Event) => this.onFocus(e.target as Element | null));
      this.listen(document, 'keydown', (e: Event) => { if ((e as KeyboardEvent).key === 'Escape' && this.node) this.close(); });
      // ลากด้วยเมาส์/นิ้ว (ขยับเกิน 6px = ลาก ไม่ใช่คลิก)
      const flyEl = (this.el.nativeElement as HTMLElement).querySelector('.ms-fly') as HTMLElement | null;
      if (flyEl) {
        flyEl.addEventListener('pointerdown', (e: PointerEvent) => this.onDragStart(e, flyEl));
        this.listen(window, 'pointermove', (e: Event) => this.onDragMove(e as PointerEvent));
        this.listen(window, 'pointerup', (e: Event) => this.onDragEnd(e as PointerEvent, flyEl));
        this.listen(window, 'pointercancel', (e: Event) => this.onDragEnd(e as PointerEvent, flyEl));
      }
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
    this.player?.dispose();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.greetTimer);
    clearTimeout(this.festTimer);
    this.sub?.unsubscribe();
    for (const [t, n, f] of this.listeners) t.removeEventListener(n, f);
    this.outfit?.dispose();
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
    this.renderedSize = this.size;
    renderer.setSize(this.renderedSize, this.renderedSize, false);
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
    cam.position.set(0, 0.9, 4.85); cam.lookAt(0, 0.85, 0); // เว้นที่ใต้เท้าให้เห็นเปลวไอพ่น (20 พ.ย. 2569)
    this.renderer = renderer; this.scene = scene; this.camera = cam; this.rig = rig;
    this.refreshOutfit();
    this.startLoop();
  }

  // ===================== ชุดเทศกาล =====================
  /** เทศกาลที่ควรแสดงตอนนี้: ลองชุด (หน้าตั้งค่า) มาก่อน แล้วจึงค่าระบบ (auto = ตามวันที่เวลาไทย) */
  private wantedFestival(): Festival | null {
    const cfg = this.mascot.outfit$.value, pv = this.mascot.outfitPreview$.value;
    return activeFestival(pv ?? cfg.mode, thaiDateKey(), cfg.dates, this.mascot.outfitExtra(cfg));
  }
  /** ใส่/ถอดชุดให้ตรงกับเทศกาลปัจจุบัน (เรียกเมื่อค่าเปลี่ยน + ทุก 1 นาที — ข้ามเที่ยงคืนแล้วเปลี่ยนเอง) */
  private refreshOutfit() {
    if (!this.L || !this.rig) return;
    const f = this.wantedFestival(), id = f?.id || '';
    if (id === this.outfitId) return;
    this.outfit?.dispose(); this.outfit = null; this.outfitId = id;
    if (!f) return;
    loadOutfitModule().then(m => {
      // ระหว่างรอโหลด เทศกาลอาจเปลี่ยนอีก/คอมโพเนนต์ถูกทำลาย = ทิ้ง
      if (this.destroyed || this.outfitId !== id || this.outfit || !this.L || !this.rig) return;
      try { this.outfit = m.dressMascot(this.L, this.rig, f.outfit); } catch { this.outfit = null; }
    }).catch(() => { /* โหลดไม่ได้ = ชุดปกติ */ });
  }
  /** อวยพรเทศกาลวันละครั้งต่อเครื่อง (ไม่ขัดจังหวะบทที่กำลังพูดอยู่ — รอแล้วลองใหม่) */
  private festivalGreet(tries = 0) {
    if (this.destroyed || this.mascot.outfitPreview$.value) return;
    const cfg = this.mascot.outfit$.value;
    const f = activeFestival(cfg.mode, thaiDateKey(), cfg.dates, this.mascot.outfitExtra(cfg));
    if (!f) return;
    const key = `${f.id}|${thaiDateKey()}`;
    let seen = '';
    try { seen = localStorage.getItem(FEST_GREET_KEY) || ''; } catch { /* ไม่มีที่เก็บ */ }
    if (seen === key) return;
    if (this.node || this.drag) { if (tries < 6) this.festTimer = setTimeout(() => this.festivalGreet(tries + 1), 6000); return; }
    try { localStorage.setItem(FEST_GREET_KEY, key); } catch { /* ไม่มีที่เก็บ */ }
    this.wake();
    this.openResolved({ id: 'festival', text: f.greet, voice: [f.greet], kind: 'shout', pose: 'cheer', mood: 'happy', choices: [], auto: 6500, pointAt: null });
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
    const groundY = groundYOf(H, size);
    if (this.drag?.moved) {
      // ถูกลาก: ตามเมาส์ (ความเร็วจากระยะที่ขยับ ใช้เอียงตัว/แกว่งผ้าคลุม)
    } else if (this.mode === 'home' || this.mode === 'roam') {
      this.updateActivity(dt, t, W, H, size, groundY);
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
    const mood: Mood = this.drag?.moved ? 'surprised' : this.isSleeping() ? 'sleep' : this.shyActive() ? 'shy' : (this.node ? this.node.mood : 'normal');
    const typing = !!this.node && this.typed < this.chars.length && this.mode === 'talk';
    const lv = this.player?.playing ? this.player.level() : 0;
    const mouth = lv > 0 ? Math.min(1, lv * 1.25) : lv < 0 || (typing && !this.player?.playing) ? talkMouth(t) : (this.node && mood === 'happy' ? 0.35 : 0);
    const face: FaceState = {
      blink: mood === 'shy' || mood === 'sleep' ? 0 : blinkAt(t), mouth: mood === 'sleep' ? 0 : mouth,
      lookX, lookY, mood,
    };

    // ---- หันตัว: บิน = หันตามทิศ, คุย = หันหาผู้ใช้ (เอียงไปทางกล่องคำพูดเล็กน้อย)
    let yawT = 0;
    if (this.mode === 'talk') yawT = this.pointDir ? this.pointDir * 0.25 : this.bubbleSide() * 0.3;
    else if (this.drag?.moved || this.isSleeping()) yawT = 0;
    else if (this.act === 'walk' && this.isRestMode()) yawT = Math.sign(this.walkTo - s.x || 1) * 1.25;
    else if (this.act === 'sit' && this.isRestMode()) yawT = lookX * 0.2;
    else if (speed > 0.12) yawT = Math.max(-1, Math.min(1, s.vx / this.maxV)) * 1.35;
    else yawT = lookX * 0.35;
    this.yaw += (yawT - this.yaw) * (1 - Math.exp(-dt * 4.5));

    if (this.rig && this.renderer && this.scene && this.camera && this.faceCanvas) {
      if (faceChanged(this.lastFace, face)) {
        const ctx = this.faceCanvas.getContext('2d');
        if (ctx) { drawFace(ctx, face); this.rig.faceTexture.needsUpdate = true; }
        this.lastFace = face;
      }
      const airborne = this.isAirborne(groundY);
      const flying = this.mode !== 'talk' && speed > 0.12 && airborne;
      this.rig.root.rotation.set(flying ? -s.vy / this.maxV * 0.25 : 0, this.yaw, flying ? -s.vx / this.maxV * 0.18 : 0);
      applyJoints(this.rig, this.joints);
      updateCape(this.rig, 0.12 + 0.88 * speed, t);
      // ไอพ่นใต้เท้า: ติดเมื่อลอยอยู่ (แรงตามความเร็ว) ดับเมื่อยืน/เดิน/นั่ง/นอน/ถูกลาก
      const jetT = airborne && !this.drag?.moved ? 0.55 + 0.45 * speed : 0;
      this.jetLevel += (jetT - this.jetLevel) * (1 - Math.exp(-dt * 8));
      updateJets(this.rig, this.jetLevel, t);
      if (t > this.nextOutfitCheck) { this.nextOutfitCheck = t + 60; this.refreshOutfit(); }
      this.outfit?.update(t);
      this.rig.heart.rotation.z = Math.sin(t * 3.1) * 0.12;
      // ขนาดเปลี่ยน (ผู้ใช้เลือกขนาด / หมุนจอ / ปรับขนาดหน้าต่าง) = ปรับความละเอียดของภาพตาม ไม่งั้นภาพแตก
      if (size !== this.renderedSize) { this.renderer.setSize(size, size, false); this.renderedSize = size; }
      this.renderer.render(this.scene, this.camera);
    }

    // ---- ตำแหน่งบนจอ
    const scale = this.mode === 'roam' && this.act === 'air' && !this.drag?.moved ? 0.66 + s.z * 0.38 : 1;
    this.updateZzz(s, size);
    fly.classList.toggle('ms-dragging', !!this.drag?.moved);
    this.updateRing();
    fly.style.setProperty('--ms-size', size + 'px');
    fly.style.transform = `translate(${(s.x - size / 2).toFixed(1)}px, ${(s.y - size * 0.62).toFixed(1)}px) scale(${scale.toFixed(3)})`;
    if (this.fallback) {
      const img = fly.querySelector('.ms-img') as HTMLElement | null;
      if (img) img.style.transform = `rotate(${(Math.max(-1, Math.min(1, s.vx / this.maxV)) * 12).toFixed(1)}deg) translateY(${(Math.sin(t * 2.6) * 5).toFixed(1)}px)`;
    }
    let behind = false;
    if (this.mode === 'roam' && !this.drag?.moved) {
      behind = this.act === 'air' && s.z < 0.28;
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
      const g = (1 - hh * 0.7) * scale * (size / 180);
      ground.style.transform = `translateX(${(s.x - 45).toFixed(1)}px) scale(${g.toFixed(3)}, ${(g * 0.9).toFixed(3)})`;
      ground.style.opacity = (0.25 + (1 - hh) * 0.6).toFixed(2);
    }

    // ---- กล่องคำพูด
    this.updateBubble(t);
    if (!this.node && this.tips.length && this.tipsShown < 4 && t > this.nextTipAt && this.mode === 'roam' && this.act === 'air' && !this.drag && !this.shyActive()) {
      this.tipsShown++; this.nextTipAt = t + 55 + Math.random() * 30;
      const tip = this.tips[Math.floor(Math.random() * this.tips.length)];
      this.openResolved({ id: 'tip', text: tip, kind: 'think', pose: 'hover', mood: 'normal', choices: [], auto: 5200, pointAt: null });
    }
  }

  private currentPose(speed: number, t: number): PoseName {
    if (this.drag?.moved) return 'drag';
    if (this.shyActive()) return 'shy';
    if (this.isRestMode()) {
      if (this.act === 'land') return speed > 0.1 ? 'fly' : 'hover';
      if (this.act === 'walk') return 'walk';
      if (this.act === 'sit') return 'sit';
      if (this.act === 'sleep') return 'sleep';
      if (this.act === 'hover') return speed > 0.15 ? 'fly' : 'hover';
    }
    if (this.mode === 'home') {
      if (speed > 0.15) return 'fly';
      if (this.gesture && t < this.gestureUntil) return this.gesture;
      if (t > this.nextGestureAt && !this.reduced) {
        const g: PoseName[] = ['wave', 'think', 'cheer'];
        this.gesture = g[Math.floor(Math.random() * g.length)];
        this.gestureUntil = t + 2.2;
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
  private homePos() {
    const sz = this.size, W = window.innerWidth, H = window.innerHeight, gy = groundYOf(H, sz);
    const h = this.customHome;
    if (!h) return { x: W - sz * 0.62, y: gy };
    return { x: Math.max(sz * 0.5, Math.min(W - sz * 0.5, h.fx * W)), y: h.ground ? gy : Math.max(sz * 0.7, Math.min(gy, h.fy * H)) };
  }
  private homeOnGround() { return !this.customHome || this.customHome.ground; }
  /** กลับไปจอดมุมขวาล่าง (ล้างตำแหน่งที่ลากไว้) */
  resetHome() { this.customHome = null; saveHome(null); this.act = 'stand'; }

  // ===================== กิจกรรม: บิน → ลงจอด → ยืน/เดิน/นั่ง/นอน → บินต่อ =====================
  private isRestMode() { return this.mode === 'home' || this.mode === 'roam'; }
  private isSleeping() { return this.isRestMode() && this.act === 'sleep' && !this.drag?.moved; }
  private isAirborne(groundY: number) { return this.s.y < groundY - 10 || this.mode === 'goto' || (this.isRestMode() && (this.act === 'air' || this.act === 'land' || this.act === 'hover')); }

  private updateActivity(dt: number, t: number, W: number, H: number, size: number, groundY: number) {
    const s = this.s;
    const startRest = () => { this.plan = planRest(Math.random, this.dock); this.nextAct(t, W, size, groundY); };
    if (this.reduced) {
      if (this.mode === 'roam') this.s = { ...s, x: size * 0.7, y: groundY, vx: 0, vy: 0 };
      else { this.anchor = this.homePos(); this.seek(dt); }
      this.act = this.mode === 'home' && !this.homeOnGround() ? 'hover' : 'stand';
      return;
    }
    switch (this.act) {
      case 'air':
        if (this.mode === 'home') { this.act = this.homeOnGround() ? 'land' : 'hover'; this.anchor = this.homePos(); return; }
        this.s = stepFly(s, dt, W, H, size);
        if (t > this.nextRestAt && !this.node && !this.shyActive()) {
          this.act = 'land';
          this.anchor = { x: this.groundSpotX(W, size), y: groundY };
        }
        return;
      case 'hover': // จอดลอยกลางอากาศตามที่ผู้ใช้ลากไว้ (ไม่มีกิจกรรมบนพื้น)
        this.anchor = this.homePos(); this.seek(dt);
        return;
      case 'land':
        if (this.mode === 'home') this.anchor = this.homePos();
        this.seek(dt);
        if (Math.hypot(this.anchor.x - this.s.x, this.anchor.y - this.s.y) < 8) {
          this.s = { ...this.s, y: this.anchor.y, vx: 0, vy: 0, z: 1 };
          this.act = 'stand'; this.actUntil = t + (this.mode === 'home' ? 0 : 1.2);
          if (this.mode === 'roam') this.plan = [];
        }
        return;
      case 'stand':
        this.s = { ...s, y: s.y + (groundY - s.y) * Math.min(1, dt * 8), vx: 0, vy: 0, z: 1 };
        if (this.mode === 'home') {
          this.s = { ...this.s, x: s.x + (this.homePos().x - s.x) * Math.min(1, dt * 4) };
          if (t > this.nextRestAt && !this.node && !this.shyActive() && this.homeOnGround()) startRest();
        } else if (t > this.actUntil) {
          if (!this.plan.length) startRest(); else this.nextAct(t, W, size, groundY);
        }
        return;
      case 'walk': {
        const dir = Math.sign(this.walkTo - s.x), step = 70 * dt;
        const x = Math.abs(this.walkTo - s.x) <= step ? this.walkTo : s.x + dir * step;
        this.s = { ...s, x, y: groundY, vx: 0, vy: 0, z: 1 };
        if (x === this.walkTo) this.nextAct(t, W, size, groundY);
        return;
      }
      case 'sit': case 'sleep':
        this.s = { ...s, y: groundY, vx: 0, vy: 0, z: 1 };
        if (t > this.actUntil) this.nextAct(t, W, size, groundY);
        return;
    }
  }

  /** ทำกิจกรรมถัดไปตามแผน หมดแผน = บินขึ้น (หน้า login) หรือกลับมายืนที่เดิม (ผู้ช่วย) */
  private nextAct(t: number, W: number, size: number, groundY: number) {
    const a = this.plan.shift();
    if (!a) {
      this.nextRestAt = t + (this.dock ? 40 : 22) + Math.random() * 25;
      if (this.mode === 'roam') { this.act = 'air'; this.s = { ...this.s, vy: -this.maxV, tx: this.s.x, ty: this.s.y - 200, hold: 0 }; }
      else { this.act = 'walk'; this.walkTo = this.homePos().x; this.plan = []; if (Math.abs(this.walkTo - this.s.x) < 4) this.act = 'stand'; }
      return;
    }
    this.act = a;
    if (a === 'walk') {
      const span = this.dock ? 90 + Math.random() * 80 : 120 + Math.random() * 160;
      const base = this.mode === 'home' ? this.homePos().x : this.s.x;
      let to = base + (Math.random() < 0.5 ? -span : span);
      if (this.mode === 'home') to = Math.min(to, base); // ผู้ช่วยเดินออกด้านซ้ายจากมุมจอดแล้วเดินกลับ
      this.walkTo = Math.max(size * 0.5, Math.min(W - size * 0.5, to));
    } else if (a === 'sit') this.actUntil = t + 6 + Math.random() * 6;
    else if (a === 'sleep') this.actUntil = t + (this.dock ? 20 : 10) + Math.random() * 15;
    else if (a === 'stand') this.actUntil = t + 1.2;
  }

  /** จุดลงจอดบนพื้น (หน้า login: หลีกจากใต้กล่องเข้าสู่ระบบถ้ามีที่ว่าง) */
  private groundSpotX(W: number, size: number) {
    const r = this.avoidRect();
    for (let i = 0; i < 6; i++) {
      const x = size * 0.6 + Math.random() * Math.max(1, W - size * 1.2);
      if (!r || x < r.left - size * 0.5 || x > r.right + size * 0.5) return x;
    }
    return size * 0.7;
  }

  /** ปลุก/เลิกพัก เมื่อมีบทพูด ถูกคลิก หรือถูกลาก */
  private wake() {
    if (this.act === 'sit' || this.act === 'sleep' || this.act === 'walk' || this.act === 'land') {
      this.plan = [];
      this.act = this.mode === 'roam' ? 'air' : (this.homeOnGround() ? 'stand' : 'hover');
      this.nextRestAt = this.clock + (this.dock ? 40 : 22) + Math.random() * 20;
    }
  }

  private updateZzz(s: FlyState, size: number) {
    const z = (this.el.nativeElement as HTMLElement).querySelector('.ms-zzz') as HTMLElement | null;
    if (!z) return;
    const on = this.isSleeping() && this.mode !== 'talk';
    z.classList.toggle('ms-on', on);
    if (on) z.style.transform = `translate(${(s.x - size * 0.42).toFixed(1)}px, ${(s.y - size * 0.42).toFixed(1)}px) scale(${Math.max(0.6, Math.min(1.3, size / 170)).toFixed(2)})`;
  }

  // ===================== ลากด้วยเมาส์ =====================
  private onDragStart(e: PointerEvent, el: HTMLElement) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: e.clientX - this.s.x, oy: e.clientY - this.s.y, moved: false, lx: e.clientX, ly: e.clientY };
    try { el.setPointerCapture(e.pointerId); } catch { /* */ }
  }
  private onDragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
    if (!d.moved) { d.moved = true; this.wake(); if (this.node) this.close(); }
    const W = window.innerWidth, H = window.innerHeight, size = this.size;
    const x = Math.max(size * 0.3, Math.min(W - size * 0.3, e.clientX - d.ox));
    const y = Math.max(size * 0.5, Math.min(groundYOf(H, size), e.clientY - d.oy));
    this.s = { ...this.s, x, y, vx: (e.clientX - d.lx) * 30, vy: (e.clientY - d.ly) * 30, z: 1 };
    d.lx = e.clientX; d.ly = e.clientY;
  }
  private onDragEnd(e: PointerEvent, el: HTMLElement) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    try { el.releasePointerCapture(e.pointerId); } catch { /* */ }
    this.drag = null;
    if (!d.moved) return; // คลิกธรรมดา — ให้ click handler ทำงาน
    this.suppressClick = true; setTimeout(() => (this.suppressClick = false), 0);
    const W = window.innerWidth, H = window.innerHeight, size = this.size, gy = groundYOf(H, size);
    const onGround = this.s.y >= gy - size * 0.35;
    this.s = { ...this.s, vx: 0, vy: 0, y: onGround ? gy : this.s.y, tx: this.s.x, ty: this.s.y, hold: onGround ? 0 : 6 };
    if (this.dock) {
      this.customHome = { fx: this.s.x / W, fy: this.s.y / H, ground: onGround };
      saveHome(this.customHome);
      this.act = onGround ? 'stand' : 'hover';
      this.zone.run(() => this.action.emit('moved')); // ผู้ช่วยปรับเมนู (กลับไปมุมขวาล่าง)
    } else {
      this.act = onGround ? 'stand' : 'air';
      this.actUntil = this.clock + 1.5; this.plan = [];
      this.nextRestAt = this.clock + (onGround ? 0 : 18);
    }
  }

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
  private dialogCtx(): DialogCtx { return { hour: new Date().getHours(), ...this.ctx, size: this.userSize }; }

  open(id: string) {
    const n = resolveNode(this.script, id, this.dialogCtx());
    if (n) this.openResolved(n);
  }

  openResolved(n: ResolvedNode) {
    this.wake();
    this.player?.stop();
    this.voiced = false;
    this.charDelay = 0.034;
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
    this.startVoice();
  }

  /** พูดบทปัจจุบัน (ไฟล์เสียงที่สร้างไว้ หรือเสียงเบราว์เซอร์) และปรับความเร็วพิมพ์ให้จบพร้อมเสียง */
  private startVoice() {
    const n = this.node;
    if (!n || this.voiced || !this.player || !this.voice || this.muted) return;
    this.voiced = true;
    const segs = n.voice?.length ? n.voice : [n.text];
    const est = this.player.estimate(segs);
    if (est && this.chars.length) this.charDelay = Math.max(0.025, Math.min(0.12, (est / 1000) / this.chars.length));
    this.player.speak(segs);
  }

  toggleMute() {
    const m = !this.muted;
    this.mascot.setVoiceMuted(m);
    if (!m && this.node && this.mode === 'talk') { this.voiced = false; this.startVoice(); }
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
    this.player?.stop();
    if (!this.node) return;
    this.node = null;
    this.showChoices = false;
    this.mode = this.dock ? 'home' : 'roam';
    if (this.mode === 'roam') this.act = 'air';
    else this.act = this.homeOnGround() ? 'land' : 'hover';
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
    if (c.action?.startsWith('size:')) {
      // ปรับขนาด (ใช้ได้ทุกหน้าที่มีน้อง — จำในเครื่อง)
      const v = c.action.slice(5);
      this.mascot.setSize(v === 'default' ? '' : normalizeMascotSize(v));
      this.open('sizeDone');
      return;
    }
    if (c.action) { const a = c.action; this.zone.run(() => this.action.emit(a)); return; }
    this.close();
  }

  onMascotClick() {
    if (this.suppressClick) return;
    this.wake();
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
    if (!c.text) return;
    // ไม่ขัดจังหวะขณะผู้ใช้กำลังเลือกตัวเลือก/พิมพ์คำถามอยู่ (ยกเว้นข้อความเตือนที่ไม่มีตัวเลือก)
    if (this.node && (this.node.choices.length || this.node.input) && this.mode === 'talk') return;
    document.querySelectorAll('[data-mascot-cue]').forEach(e => e.removeAttribute('data-mascot-cue'));
    let pointAt: string | null = null;
    if (c.pointEl) { c.pointEl.setAttribute('data-mascot-cue', '1'); pointAt = '[data-mascot-cue="1"]'; }
    this.openResolved({ id: 'cue', text: c.text, kind: c.kind || 'speech', pose: c.pose || 'talk', mood: c.mood || 'normal', choices: [], auto: c.auto ?? 6000, pointAt });
  }

  /** ส่งคำถามจากช่องพิมพ์ในกล่องคำพูด */
  submitAsk(e: Event) {
    e.preventDefault(); e.stopPropagation();
    const inp = (this.el.nativeElement as HTMLElement).querySelector('.ms-input') as HTMLInputElement | null;
    const q = (inp?.value || '').trim();
    if (q.length < 3) { inp?.focus(); return; }
    this.zone.run(() => this.action.emit('ask:' + q));
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
    if (!this.node) return;
    const bub = host.querySelector('.ms-bubble') as HTMLElement | null;
    if (!bub || !this.node) return;
    if (this.mode === 'talk') {
      // พิมพ์ทีละตัว (ช้าลงที่เครื่องหมายวรรคตอน)
      while (this.typed < this.chars.length && t >= this.nextCharAt) {
        const ch = this.chars[this.typed++];
        this.nextCharAt += this.voiced ? this.charDelay : /[.!?…]/.test(ch) ? 0.22 : ch === ' ' ? 0.06 : 0.034;
        this.setText(this.chars.slice(0, this.typed).join(''));
      }
      if (this.typed >= this.chars.length) {
        if (!this.showChoices && (this.node.choices.length || this.node.input)) {
          this.showChoices = true; this.cdr.detectChanges();
          if (this.node.input) (host.querySelector('.ms-input') as HTMLInputElement | null)?.focus();
        }
        if (this.node.auto && !this.closeAt) this.closeAt = t + this.node.auto / 1000;
        if (this.closeAt && this.player?.playing) this.closeAt = Math.max(this.closeAt, t + 0.8); // รอพูดจบ
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
