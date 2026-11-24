/**
 * โมเดล 3 มิติของน้องคิดดี ปั้นด้วยโค้ด (three.js) ตามภาพต้นแบบหลายมุม (public/mascot/korat-d-3.jpg):
 * หัวเป็นจอสี่เหลี่ยมมุมมน กรอบขาว จอดำ (ใบหน้าเป็น texture จาก mascot-face) หูฟังสีเขียวน้ำทะเลสองข้าง หัวใจบนหัว (มีเส้นคลื่นหัวใจ)
 * ลำตัวขาวมีปกคอ ปุ่มเปิดเครื่องที่อก ตราสำนักงานที่ท้อง ผ้าคลุมสีเขียวน้ำทะเล แขน-ขามีข้อต่อ (หมุนได้ทุกท่า) รองเท้าพื้นสีเขียว
 * หน่วย: สูงประมาณ 2 (เท้าที่ y = 0) — โหลด three.js แบบแยกไฟล์ (dynamic import) เฉพาะเมื่อแสดงตัวละคร
 */
import type * as THREE_NS from 'three';
import { Joints } from './mascot-pose';

export interface ThreeLib {
  THREE: typeof THREE_NS;
  RoundedBoxGeometry: any;
  RoomEnvironment: any;
}

export async function loadThree(): Promise<ThreeLib> {
  const [THREE, rb, re] = await Promise.all([
    import('three'),
    import('three/addons/geometries/RoundedBoxGeometry.js'),
    import('three/addons/environments/RoomEnvironment.js'),
  ]);
  return { THREE, RoundedBoxGeometry: (rb as any).RoundedBoxGeometry, RoomEnvironment: (re as any).RoomEnvironment };
}

interface ArmRig { shoulder: THREE_NS.Group; elbow: THREE_NS.Group; side: number; }
interface LegRig { hip: THREE_NS.Group; knee: THREE_NS.Group; side: number; }

export interface MascotRig {
  root: THREE_NS.Group;
  body: THREE_NS.Group;
  neck: THREE_NS.Group;
  armR: ArmRig; armL: ArmRig;
  legR: LegRig; legL: LegRig;
  fingers: THREE_NS.Object3D[];
  /** ไอพ่นใต้รองเท้า (ซ้าย/ขวา) — scale.y = แรงไอพ่น, ซ่อนเมื่อยืน/เดิน/นั่ง/นอน */
  jets: THREE_NS.Group[];
  heart: THREE_NS.Group;
  /** หัว (ใส่หมวก/ผ้าคาดหัว) และมือ [ขวา, ซ้าย] (ถือของ) — ชุดเทศกาล mascot-outfit.ts */
  head: THREE_NS.Group;
  hands: THREE_NS.Group[];
  cape: THREE_NS.Mesh;
  capeMat: THREE_NS.MeshPhysicalMaterial;
  capeColor: number;
  capeBase: Float32Array;
  faceTexture: THREE_NS.CanvasTexture;
  dispose(): void;
}

function roundedRect(THREE: typeof THREE_NS, w: number, h: number, r: number) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** UV ของ ShapeGeometry = พิกัดรูปทรง → แปลงเป็น 0..1 ให้ texture เต็มจอ */
function normalizeUv(geo: THREE_NS.BufferGeometry, w: number, h: number) {
  const pos = geo.attributes['position'], uv = geo.attributes['uv'];
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  uv.needsUpdate = true;
}

function heartShape(THREE: typeof THREE_NS, size: number) {
  const s = new THREE.Shape(), k = size / 2;
  s.moveTo(0, -k * 0.9);
  s.bezierCurveTo(-k * 0.2, -k * 0.62, -k * 1.05, -k * 0.2, -k * 1.0, k * 0.28);
  s.bezierCurveTo(-k * 0.95, k * 0.82, -k * 0.25, k * 0.92, 0, k * 0.45);
  s.bezierCurveTo(k * 0.25, k * 0.92, k * 0.95, k * 0.82, k * 1.0, k * 0.28);
  s.bezierCurveTo(k * 1.05, -k * 0.2, k * 0.2, -k * 0.62, 0, -k * 0.9);
  return s;
}

function canvasTex(THREE: typeof THREE_NS, w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d'); if (c) draw(c);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export function buildMascot(L: ThreeLib, faceCanvas: HTMLCanvasElement, sealImage?: HTMLImageElement | null): MascotRig {
  const { THREE, RoundedBoxGeometry } = L;
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };

  const white = keep(new THREE.MeshPhysicalMaterial({ color: 0xf2f6f7, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.22 }));
  const teal = keep(new THREE.MeshPhysicalMaterial({ color: 0x109f8e, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.3 }));
  const tealSoft = keep(new THREE.MeshPhysicalMaterial({ color: 0x12988a, roughness: 0.5, sheen: 0.35, sheenColor: new THREE.Color(0x7fe6d8), side: THREE.DoubleSide }));
  const grey = keep(new THREE.MeshPhysicalMaterial({ color: 0xdfe7ea, roughness: 0.4, clearcoat: 0.4 }));

  const faceTexture = keep(new THREE.CanvasTexture(faceCanvas));
  faceTexture.colorSpace = THREE.SRGBColorSpace; faceTexture.anisotropy = 4;
  const screenMat = keep(new THREE.MeshPhysicalMaterial({
    color: 0x050607, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05,
    emissive: 0xffffff, emissiveMap: faceTexture, emissiveIntensity: 1.05,
  }));

  const mesh = (geo: THREE_NS.BufferGeometry, mat: THREE_NS.Material | THREE_NS.Material[]) => {
    keep(geo); const m = new THREE.Mesh(geo, mat); return m;
  };

  const root = new THREE.Group(); root.name = 'korat-d';
  const body = new THREE.Group(); body.position.y = 0.42; root.add(body); // จุดหมุนที่สะโพก

  // ===== ลำตัว =====
  const torso = mesh(new THREE.CapsuleGeometry(0.27, 0.06, 10, 28), white);
  torso.scale.set(1.05, 0.95, 0.9); torso.position.y = 0.25; body.add(torso);
  const hipBand = mesh(new THREE.TorusGeometry(0.245, 0.03, 12, 40), teal);
  hipBand.rotation.x = Math.PI / 2; hipBand.scale.set(1.05, 0.92, 1); hipBand.position.y = 0.07; body.add(hipBand);
  const collar = mesh(new THREE.TorusGeometry(0.135, 0.04, 14, 36), teal);
  collar.rotation.x = Math.PI / 2; collar.position.y = 0.49; body.add(collar);
  // แถบข้างลำตัว
  for (const side of [-1, 1]) {
    const stripe = mesh(new THREE.CapsuleGeometry(0.03, 0.2, 6, 12), teal);
    stripe.position.set(side * 0.27, 0.25, 0.06); stripe.rotation.z = side * 0.1; body.add(stripe);
  }
  // ปุ่มเปิดเครื่องที่อก
  const powerTex = keep(canvasTex(THREE, 128, 128, c => {
    c.fillStyle = '#2fc4b3'; c.beginPath(); c.arc(64, 64, 62, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#e9fffb'; c.lineWidth = 11; c.lineCap = 'round';
    c.beginPath(); c.arc(64, 68, 30, -Math.PI * 0.32, Math.PI * 1.32); c.stroke();
    c.beginPath(); c.moveTo(64, 28); c.lineTo(64, 62); c.stroke();
  }));
  const powerMat = keep(new THREE.MeshPhysicalMaterial({ map: powerTex, roughness: 0.25, clearcoat: 1, emissive: 0x1aa898, emissiveIntensity: 0.25 }));
  const power = mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.02, 32), [teal, powerMat, teal]);
  power.rotation.x = Math.PI / 2 - 0.5; power.position.set(0, 0.42, 0.19); body.add(power);
  // ตราสำนักงานที่ท้อง
  if (sealImage) {
    const sealTex = keep(new THREE.Texture(sealImage)); sealTex.colorSpace = THREE.SRGBColorSpace; sealTex.needsUpdate = true;
    const sealMat = keep(new THREE.MeshPhysicalMaterial({ map: sealTex, roughness: 0.35, clearcoat: 0.8 }));
    const seal = mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.012, 40), [white, sealMat, white]);
    seal.rotation.x = Math.PI / 2; seal.position.set(0, 0.2, 0.245); body.add(seal);
  }

  // ===== หัว =====
  const neck = new THREE.Group(); neck.position.y = 0.5; body.add(neck);
  const head = new THREE.Group(); head.position.y = 0.47; neck.add(head);
  const W = 1.14, H = 0.86, D = 0.8;
  head.add(mesh(new RoundedBoxGeometry(W, H, D, 6, 0.25), white));
  // ขอบจอสีเขียว + จอ
  const sw = 0.95, sh = 0.66;
  const ringShape = roundedRect(THREE, sw + 0.04, sh + 0.04, 0.16);
  ringShape.holes.push(roundedRect(THREE, sw, sh, 0.14));
  const ring = mesh(new THREE.ShapeGeometry(ringShape, 10), teal); ring.position.z = D / 2 + 0.002; head.add(ring);
  const screenGeo = new THREE.ShapeGeometry(roundedRect(THREE, sw, sh, 0.14), 10); normalizeUv(screenGeo, sw, sh);
  const screen = mesh(screenGeo, screenMat); screen.position.z = D / 2 + 0.003; head.add(screen);
  // หูฟัง
  for (const side of [-1, 1]) {
    const cup = mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.1, 40), teal);
    cup.rotation.z = Math.PI / 2; cup.position.set(side * (W / 2 + 0.02), -0.02, -0.02); head.add(cup);
    const pad = mesh(new THREE.CylinderGeometry(0.115, 0.125, 0.05, 36), grey);
    pad.rotation.z = Math.PI / 2; pad.position.set(side * (W / 2 + 0.085), -0.02, -0.02); head.add(pad);
    const dot = mesh(new THREE.TorusGeometry(0.06, 0.014, 8, 28), teal);
    dot.rotation.y = Math.PI / 2; dot.position.set(side * (W / 2 + 0.112), -0.02, -0.02); head.add(dot);
  }
  // หัวใจบนหัว + เส้นคลื่นหัวใจ
  const heart = new THREE.Group(); heart.position.y = H / 2 - 0.02; head.add(heart);
  const stem = mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.12, 16), teal); stem.position.y = 0.06; heart.add(stem);
  const hGeo = new THREE.ExtrudeGeometry(heartShape(THREE, 0.27), { depth: 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 4, curveSegments: 18 });
  hGeo.center();
  const hMesh = mesh(hGeo, teal); hMesh.position.y = 0.2; heart.add(hMesh);
  const ecgTex = keep(canvasTex(THREE, 256, 128, c => {
    c.strokeStyle = '#ffffff'; c.lineWidth = 12; c.lineJoin = 'round'; c.lineCap = 'round';
    c.beginPath(); c.moveTo(18, 70); c.lineTo(88, 70); c.lineTo(108, 40); c.lineTo(132, 102); c.lineTo(152, 22); c.lineTo(172, 70); c.lineTo(238, 70); c.stroke();
  }));
  const ecg = mesh(new THREE.PlaneGeometry(0.19, 0.095), keep(new THREE.MeshBasicMaterial({ map: ecgTex, transparent: true, depthWrite: false })));
  ecg.position.set(0, 0.2, 0.066); heart.add(ecg);

  // ===== แขน =====
  const makeArm = (side: number): ArmRig => {
    const shoulder = new THREE.Group(); shoulder.position.set(side * 0.29, 0.4, 0); shoulder.rotation.order = 'ZXY'; body.add(shoulder);
    const ball = mesh(new THREE.SphereGeometry(0.08, 20, 16), white); shoulder.add(ball);
    const upper = mesh(new THREE.CapsuleGeometry(0.068, 0.06, 8, 16), white); upper.position.y = -0.08; shoulder.add(upper);
    const elbow = new THREE.Group(); elbow.position.y = -0.16; shoulder.add(elbow);
    const fore = mesh(new THREE.CapsuleGeometry(0.066, 0.05, 8, 16), white); fore.position.y = -0.06; elbow.add(fore);
    const cuff = mesh(new THREE.CylinderGeometry(0.077, 0.077, 0.045, 24), teal); cuff.position.y = -0.115; elbow.add(cuff);
    const hand = new THREE.Group(); hand.position.y = -0.2; elbow.add(hand);
    const palm = mesh(new THREE.SphereGeometry(0.095, 22, 18), white); palm.scale.set(1, 1.05, 0.85); hand.add(palm);
    const thumb = mesh(new THREE.CapsuleGeometry(0.028, 0.04, 6, 10), white);
    thumb.position.set(-side * 0.065, 0.0, 0.035); thumb.rotation.z = side * 0.6; hand.add(thumb);
    return { shoulder, elbow, side };
  };
  // ขวาของตัวละคร = ซ้ายของผู้ชม (x ติดลบ) — แขนที่ชี้/โบกมือ
  const armR = makeArm(-1), armL = makeArm(1);
  // นิ้วชี้ (แสดงเฉพาะท่าชี้) — hand = ลูกลำดับที่ 3 ของข้อศอก (fore, cuff, hand)
  const fingers = [armR, armL].map(a => {
    const fg = mesh(new THREE.CapsuleGeometry(0.026, 0.085, 6, 10), white);
    fg.position.set(0, -0.115, 0.01); a.elbow.children[2].add(fg); fg.visible = false;
    return fg;
  });

  // ===== ขา =====
  const makeLeg = (side: number): LegRig => {
    const hip = new THREE.Group(); hip.position.set(side * 0.13, 0.0, 0); body.add(hip);
    const thigh = mesh(new THREE.CapsuleGeometry(0.105, 0.03, 8, 16), white); thigh.position.y = -0.06; hip.add(thigh);
    const knee = new THREE.Group(); knee.position.y = -0.13; hip.add(knee);
    const band = mesh(new THREE.TorusGeometry(0.1, 0.025, 10, 28), teal); band.rotation.x = Math.PI / 2; knee.add(band);
    const shin = mesh(new THREE.CapsuleGeometry(0.1, 0.03, 8, 16), white); shin.position.y = -0.07; knee.add(shin);
    const foot = mesh(new RoundedBoxGeometry(0.22, 0.13, 0.3, 4, 0.06), white); foot.position.set(0, -0.19, 0.04); knee.add(foot);
    const sole = mesh(new RoundedBoxGeometry(0.23, 0.05, 0.31, 3, 0.02), teal); sole.position.set(0, -0.255, 0.04); knee.add(sole);
    return { hip, knee, side };
  };
  const legR = makeLeg(-1), legL = makeLeg(1);

  // ===== ไอพ่นใต้เท้า ===== (กรวยเรืองแสง 2 ชั้น: นอกส้ม-ฟ้า ในขาว — additive ไม่บังตัวละคร)
  // สีทึบพอมองเห็นบนพื้นหลังสว่าง (additive บน canvas โปร่งใสจางเกินไป — ทดสอบภาพ 20 พ.ย. 2569)
  const flameOuter = keep(new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.78, depthWrite: false, toneMapped: false }));
  const flameMid = keep(new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
  const flameCore = keep(new THREE.MeshBasicMaterial({ color: 0xfffbe6, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }));
  const nozzle = keep(new THREE.MeshPhysicalMaterial({ color: 0x5b6b70, roughness: 0.35, metalness: 0.6 }));
  const jets = [legR, legL].map(l => {
    const g = new THREE.Group(); g.position.set(0, -0.285, 0.04); l.knee.add(g);
    const noz = mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.04, 20), nozzle); noz.position.y = -0.005; l.knee.add(noz); noz.position.set(0, -0.29, 0.04);
    const mk = (r: number, h: number, m: THREE_NS.Material) => { const c = mesh(new THREE.ConeGeometry(r, h, 20, 1, true), m); c.rotation.x = Math.PI; c.position.y = -h / 2; return c; };
    const o = mk(0.105, 0.6, flameOuter), md = mk(0.075, 0.42, flameMid), c = mk(0.04, 0.24, flameCore);
    o.renderOrder = 1; md.renderOrder = 2; c.renderOrder = 3;
    g.add(o, md, c);
    g.scale.set(1, 0.001, 1); g.visible = false;
    return g;
  });

  // ===== ผ้าคลุม ===== (ปลายแคบที่ไหล่ ผายออกด้านล่าง — ขยับตามความเร็วใน updateCape)
  const capeGeo = new THREE.PlaneGeometry(0.66, 0.68, 8, 12);
  const cp = capeGeo.attributes['position'];
  for (let i = 0; i < cp.count; i++) {
    const t = (0.34 - cp.getY(i)) / 0.68; // 0 = บน, 1 = ล่าง
    cp.setX(i, cp.getX(i) * (0.7 + 0.45 * t));
  }
  const capeBase = new Float32Array(cp.array as ArrayLike<number>);
  const cape = mesh(capeGeo, tealSoft); cape.position.set(0, 0.16, -0.235); body.add(cape);

  return {
    root, body, neck, armR, armL, legR, legL, fingers, jets, heart, cape, capeBase, faceTexture,
    head, hands: [armR, armL].map(a => a.elbow.children[2] as THREE_NS.Group), capeMat: tealSoft, capeColor: 0x12988a,
    dispose: () => { for (const d of disposables) d.dispose(); },
  };
}

/** วางข้อต่อตามค่าท่าทาง */
export function applyJoints(rig: MascotRig, j: Joints) {
  rig.root.position.y = j.rootY;
  rig.root.position.x = j.rootX;
  rig.body.rotation.set(j.bodyPitch, 0, j.bodyRoll);
  rig.neck.rotation.set(j.headPitch, j.headYaw, j.headRoll);
  const arm = (a: ArmRig, raise: number, fwd: number, elbow: number, side: number) => {
    // ZXY: กางแขนออกด้านข้าง (Z) แล้วยกไปข้างหน้า (X)
    a.shoulder.rotation.set(-fwd, 0, a.side * raise);
    a.elbow.rotation.set(-elbow, 0, -a.side * side); // side ติดลบ = พับปลายแขนขึ้น
  };
  arm(rig.armR, j.armRRaise, j.armRFwd, j.armRElbow, j.armRBend);
  arm(rig.armL, j.armLRaise, j.armLFwd, j.armLElbow, j.armLBend);
  rig.legR.hip.rotation.set(-j.legRFwd, 0, rig.legR.side * j.legSpread);
  rig.legL.hip.rotation.set(-j.legLFwd, 0, rig.legL.side * j.legSpread);
  rig.legR.knee.rotation.x = j.legRKnee;
  rig.legL.knee.rotation.x = j.legLKnee;
  // นิ้วออกเฉพาะมือที่ยกขึ้น (ชี้)
  rig.fingers[0].visible = j.finger > 0.5 && j.armRRaise + j.armRFwd > 0.9;
  rig.fingers[1].visible = j.finger > 0.5 && j.armLRaise + j.armLFwd > 0.9;
}

/** ผ้าคลุมพลิ้ว: flow 0 = ห้อยลง, 1 = ปลิวไปด้านหลังเต็มที่ */
export function updateCape(rig: MascotRig, flow: number, t: number) {
  const pos = rig.cape.geometry.attributes['position'], b = rig.capeBase;
  for (let i = 0; i < pos.count; i++) {
    const x = b[i * 3], y = b[i * 3 + 1];
    const k = (0.34 - y) / 0.68;
    const wave = Math.sin(t * (4 + flow * 6) + k * 5 + x * 4) * (0.02 + 0.05 * flow) * k;
    pos.setXYZ(i, x, y + k * k * flow * 0.3, -k * (0.04 + flow * 0.42) + wave);
  }
  pos.needsUpdate = true;
  rig.cape.geometry.computeVertexNormals();
}

/** แรงไอพ่น 0–1 (0 = ซ่อน) + เปลวไฟสั่นตามเวลา */
export function updateJets(rig: MascotRig, level: number, t: number) {
  rig.jets.forEach((g, i) => {
    const on = level > 0.03;
    g.visible = on;
    if (!on) return;
    const flick = 0.82 + 0.18 * Math.sin(t * 38 + i * 1.7) * Math.sin(t * 23 + i);
    g.scale.set(0.8 + 0.25 * level, Math.max(0.05, level * flick * 1.15), 0.8 + 0.25 * level);
  });
}
