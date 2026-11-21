/**
 * ชุดเทศกาลของน้องโคราชดี (21 พ.ย. 2569) — ปั้นด้วยโค้ด three.js ต่อเข้ากับโมเดลเดิม (mascot-model.ts) ไม่มีไฟล์โมเดล
 * เสื้อกั๊กเปิดด้านหน้า (ยังเห็นปุ่มเปิดเครื่องและตราสำนักงาน), หมวกเอียงข้างหัว (ไม่บังหัวใจบนหัว), สร้อย/พวงมาลัย, ของถือในมือซ้าย
 * dressMascot() คืน { update(t), dispose() } — dispose ถอดทุกชิ้นและคืนสีผ้าคลุมเดิม
 */
import type * as THREE_NS from 'three';
import type { MascotRig, ThreeLib } from './mascot-model';
import type { HatKind, NeckKind, OutfitSpec, PropKind, ShellKind } from './mascot-festival';

export interface Outfit {
  update(t: number): void;
  dispose(): void;
  /** จำนวนชิ้นที่ใส่ (ใช้ทดสอบ) */
  parts: number;
}

type Obj = THREE_NS.Object3D;

export function dressMascot(L: ThreeLib, rig: MascotRig, spec: OutfitSpec): Outfit {
  const { THREE } = L;
  const trash: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { trash.push(x); return x; };
  const added: [Obj, Obj][] = [];
  const anims: ((t: number) => void)[] = [];
  const attach = (parent: Obj, o: Obj) => { parent.add(o); added.push([parent, o]); return o; };

  const mat = (color: number, o: Partial<THREE_NS.MeshPhysicalMaterialParameters> = {}) =>
    keep(new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, clearcoat: 0.4, ...o }));
  const glow = (color: number) => keep(new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  const mesh = (geo: THREE_NS.BufferGeometry, m: THREE_NS.Material | THREE_NS.Material[]) => new THREE.Mesh(keep(geo), m);
  const group = (...kids: Obj[]) => { const g = new THREE.Group(); if (kids.length) g.add(...kids); return g; };
  const at = <T extends Obj>(o: T, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => { o.position.set(x, y, z); o.rotation.set(rx, ry, rz); return o; };
  const tex = (w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void, repeatU = 1) => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d'); if (c) draw(c, w, h);
    const t = keep(new THREE.CanvasTexture(cv)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    if (repeatU !== 1) { t.wrapS = THREE.RepeatWrapping; t.repeat.set(repeatU, 1); }
    return t;
  };
  /** แท่งระหว่าง 2 จุด (เชือก/ก้าน) */
  const rod = (a: THREE_NS.Vector3, b: THREE_NS.Vector3, r: number, m: THREE_NS.Material) => {
    const len = a.distanceTo(b);
    const o = mesh(new THREE.CylinderGeometry(r, r, len, 8), m);
    o.position.copy(a).add(b).multiplyScalar(0.5);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return o;
  };
  const heartGeo = (size: number, depth: number) => {
    const s = new THREE.Shape(), k = size / 2;
    s.moveTo(0, -k * 0.9);
    s.bezierCurveTo(-k * 0.2, -k * 0.62, -k * 1.05, -k * 0.2, -k, k * 0.28);
    s.bezierCurveTo(-k * 0.95, k * 0.82, -k * 0.25, k * 0.92, 0, k * 0.45);
    s.bezierCurveTo(k * 0.25, k * 0.92, k * 0.95, k * 0.82, k, k * 0.28);
    s.bezierCurveTo(k * 1.05, -k * 0.2, k * 0.2, -k * 0.62, 0, -k * 0.9);
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.4, bevelSize: depth * 0.4, bevelSegments: 3, curveSegments: 14 });
    g.center(); return g;
  };
  const flame = () => {
    const f = group(
      mesh(new THREE.SphereGeometry(0.03, 12, 10), glow(0xffb020)),
      at(mesh(new THREE.ConeGeometry(0.026, 0.07, 12), glow(0xfff3c4)), 0, 0.04, 0),
    );
    anims.push(t => { const k = 0.85 + 0.15 * Math.sin(t * 31) * Math.sin(t * 17); f.scale.set(k, 0.8 + 0.4 * k, k); });
    return f;
  };

  // ===================== ผ้าคลุม =====================
  if (spec.cape != null) rig.capeMat.color.setHex(spec.cape);

  // ===================== เสื้อกั๊ก =====================
  if (spec.shell) attach(rig.body, makeShell(spec.shell));
  function makeShell(kind: ShellKind): Obj {
    // โปรไฟล์ตามลำตัว (capsule r 0.27 ตรงกลางสูง 0.06) + ระยะเผื่อ — กลุ่มย่อ/ขยายเท่าลำตัว
    const pts: THREE_NS.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const dy = -0.17 + (0.37 * i) / 14;
      const e = Math.max(0, Math.abs(dy) - 0.03);
      pts.push(new THREE.Vector2(Math.sqrt(Math.max(0, 0.27 * 0.27 - e * e)) + 0.022, dy));
    }
    const map = tex(512, 256, (c, w, h) => {
      if (kind === 'flower') {
        c.fillStyle = '#18b6c9'; c.fillRect(0, 0, w, h);
        const cols = ['#ff5fa2', '#ffd23f', '#ffffff', '#ff8a3d'];
        for (let i = 0; i < 26; i++) {
          const x = (i * 97) % w, y = (i * 61) % h, r = 16 + (i % 3) * 7, col = cols[i % 4];
          c.fillStyle = col;
          for (let p = 0; p < 5; p++) { const a = (p / 5) * Math.PI * 2 + i; c.beginPath(); c.ellipse(x + Math.cos(a) * r * 0.7, y + Math.sin(a) * r * 0.7, r * 0.55, r * 0.35, a, 0, Math.PI * 2); c.fill(); }
          c.fillStyle = '#7a2b00'; c.beginPath(); c.arc(x, y, r * 0.22, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#1f7a3a'; c.beginPath(); c.ellipse(x + r * 1.1, y + r * 0.6, r * 0.6, r * 0.22, 0.6, 0, Math.PI * 2); c.fill();
        }
      } else if (kind === 'chinese') {
        c.fillStyle = '#c8102e'; c.fillRect(0, 0, w, h);
        c.strokeStyle = '#f5c542'; c.lineWidth = 3;
        for (let x = 20; x < w; x += 64) for (let y = 30; y < h; y += 64) { c.beginPath(); c.arc(x, y, 14, 0, Math.PI * 2); c.stroke(); c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.stroke(); }
        c.fillStyle = '#f5c542'; c.fillRect(0, 0, 18, h); c.fillRect(w - 18, 0, 18, h); c.fillRect(0, h - 16, w, 16); c.fillRect(0, 0, w, 12);
      } else {
        c.fillStyle = '#c62828'; c.fillRect(0, 0, w, h);
        c.fillStyle = '#ffffff'; c.fillRect(0, 0, 30, h); c.fillRect(w - 30, 0, 30, h); c.fillRect(0, 0, w, 34);
        c.fillStyle = '#1c1c1c'; c.fillRect(0, h * 0.62, w, 26);
        c.fillStyle = '#f2c94c'; c.fillRect(w * 0.2, h * 0.62 - 4, 34, 34);
        c.fillStyle = '#1c1c1c'; c.fillRect(w * 0.2 + 9, h * 0.62 + 5, 16, 16);
      }
    });
    const m = mat(0xffffff, { map, side: THREE.DoubleSide, roughness: kind === 'santa' ? 0.75 : 0.5, clearcoat: 0.15 });
    const shell = mesh(new THREE.LatheGeometry(pts, 48, 0.55, Math.PI * 2 - 1.1), m);
    const g = group(shell);
    g.position.y = 0.25; g.scale.set(1.05, 0.95, 0.9);
    if (kind === 'chinese') {
      // กระดุมจีน (ปม) สีทองตามขอบเสื้อ
      const gold = mat(0xf5c542, { metalness: 0.6, roughness: 0.3 });
      for (let i = 0; i < 3; i++) {
        const y = 0.1 - i * 0.09, r = 0.27 + 0.024;
        g.add(at(mesh(new THREE.SphereGeometry(0.018, 10, 8), gold), Math.sin(-0.55) * r, y, Math.cos(-0.55) * r));
      }
    }
    return g;
  }

  // ===================== หมวก (เอียงข้างหัว ฝั่งขวาของผู้ชม — ไม่บังหัวใจบนหัว) =====================
  if (spec.hat) attach(rig.head, makeHat(spec.hat));
  /** หมวกบนมุมหัวด้านขวาของผู้ชม — กล้องเห็นเหนือหัวได้ราว 0.3 หน่วย (หมวกสูงเกินถูกตัดขอบภาพ) จึงเอียงออกข้างและสูงไม่เกิน ~0.3 */
  // กล้องมองเงยขึ้นหาหัว → หมวกที่วางกลางความลึกถูกขอบหน้าจอของหัวบัง จึงเลื่อนมาด้านหน้า (z) — ทดสอบภาพ 21 พ.ย. 2569
  function sideHat(o: Obj, tilt = -0.55) { const g = group(o); g.position.set(0.36, 0.41, 0.14); g.rotation.z = tilt; return g; }
  function makeHat(kind: HatKind): Obj {
    switch (kind) {
      case 'party': {
        const stripes = tex(256, 64, (c, w, h) => { for (let i = 0; i < 8; i++) { c.fillStyle = ['#ff4d8d', '#ffd23f', '#3ec7ff', '#8b5cf6'][i % 4]; c.fillRect((i * w) / 8, 0, w / 8 + 1, h); } });
        const cone = at(mesh(new THREE.ConeGeometry(0.15, 0.3, 32), mat(0xffffff, { map: stripes })), 0, 0.15, 0);
        const pom = at(mesh(new THREE.SphereGeometry(0.045, 16, 12), mat(0xffd23f, { roughness: 0.8 })), 0, 0.31, 0);
        const rim = at(mesh(new THREE.TorusGeometry(0.145, 0.02, 8, 32), mat(0xffd23f)), 0, 0.01, 0, Math.PI / 2);
        return sideHat(group(cone, pom, rim), -0.6);
      }
      case 'propeller': {
        const cols = tex(256, 64, (c, w, h) => { for (let i = 0; i < 4; i++) { c.fillStyle = ['#e53935', '#fdd835', '#1e88e5', '#43a047'][i]; c.fillRect((i * w) / 4, 0, w / 4 + 1, h); } });
        const cap = mesh(new THREE.SphereGeometry(0.16, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffffff, { map: cols }));
        const brim = at(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 24, 1, false, -0.9, 1.8), mat(0x1e88e5)), 0, 0.005, 0.12);
        const stick = at(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.09, 8), mat(0x555555)), 0, 0.2, 0);
        const blades = group(
          at(mesh(new THREE.BoxGeometry(0.3, 0.008, 0.05), mat(0xe53935)), 0, 0, 0, 0.25),
          at(mesh(new THREE.BoxGeometry(0.05, 0.008, 0.3), mat(0xfdd835)), 0, 0, 0, 0, 0, 0.25),
        );
        blades.position.y = 0.25;
        anims.push(t => { blades.rotation.y = t * 9; });
        return sideHat(group(cap, brim, stick, blades), -0.3);
      }
      case 'hearts': {
        const red = mat(0xe8325a, { clearcoat: 0.9, roughness: 0.25 });
        const spring = mat(0x8a8a8a, { metalness: 0.7, roughness: 0.3 });
        const g = group();
        for (const side of [-1, 1]) {
          const b = group(
            at(mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.15, 8), spring), 0, 0.075, 0),
            at(mesh(heartGeo(0.15, 0.035), red), 0, 0.19, 0),
          );
          b.position.set(side * 0.3, 0.4, -0.05); b.rotation.z = -side * 0.55;
          anims.push(t => { b.rotation.z = -side * 0.55 + Math.sin(t * 5 + side) * 0.12; });
          g.add(b);
        }
        return g;
      }
      case 'chinese': {
        const cap = mesh(new THREE.SphereGeometry(0.21, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x9e0b1f, { roughness: 0.6 }));
        cap.scale.y = 0.62;
        const knob = at(mesh(new THREE.SphereGeometry(0.035, 14, 10), mat(0xf5c542, { metalness: 0.6, roughness: 0.3 })), 0, 0.14, 0);
        const band = at(mesh(new THREE.TorusGeometry(0.205, 0.018, 8, 32), mat(0x1c1c1c)), 0, 0.01, 0, Math.PI / 2);
        return sideHat(group(cap, knob, band), -0.3);
      }
      case 'sunglasses': {
        const frame = mat(0xff4d8d, { roughness: 0.3 });
        const lens = mat(0x111418, { roughness: 0.05, clearcoat: 1, metalness: 0.3 });
        const g = group();
        for (const side of [-1, 1]) {
          g.add(at(mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.02, 28), lens), side * 0.15, 0, 0, Math.PI / 2));
          g.add(at(mesh(new THREE.TorusGeometry(0.11, 0.015, 8, 28), frame), side * 0.15, 0, 0.004));
        }
        g.add(at(mesh(new THREE.BoxGeometry(0.08, 0.02, 0.02), frame), 0, 0.03, 0));
        // ดันแว่นขึ้นไปไว้บนหน้าผาก (ไม่บังใบหน้าบนจอ)
        g.position.set(0, 0.43, 0.2); g.rotation.x = -1.2;
        return g;
      }
      case 'witch': {
        const dark = mat(0x2d1450, { roughness: 0.7 });
        const cone = at(mesh(new THREE.ConeGeometry(0.17, 0.32, 32), dark), 0, 0.17, 0);
        const brim = mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.018, 40), dark);
        const band = at(mesh(new THREE.CylinderGeometry(0.152, 0.165, 0.05, 32, 1, true), mat(0xff8c1a, { side: THREE.DoubleSide })), 0, 0.045, 0);
        const tip = at(mesh(new THREE.SphereGeometry(0.025, 10, 8), mat(0xff8c1a)), 0, 0.33, 0);
        return sideHat(group(cone, brim, band, tip), -0.42);
      }
      case 'santa': {
        const red = mat(0xd32f2f, { roughness: 0.8, clearcoat: 0.1 });
        const fur = mat(0xffffff, { roughness: 1, clearcoat: 0 });
        const cone = at(mesh(new THREE.ConeGeometry(0.17, 0.32, 32), red), 0, 0.16, 0);
        const trim = at(mesh(new THREE.TorusGeometry(0.16, 0.045, 12, 36), fur), 0, 0.01, 0, Math.PI / 2);
        const pom = at(mesh(new THREE.SphereGeometry(0.055, 16, 12), fur), 0, 0.33, 0);
        return sideHat(group(cone, trim, pom), -0.8);
      }
      case 'bunny': {
        const white = mat(0xffffff, { roughness: 0.7 });
        const pink = mat(0xffb3c7, { roughness: 0.8 });
        const g = group();
        for (const side of [-1, 1]) {
          const ear = group(
            mesh(new THREE.CapsuleGeometry(0.06, 0.17, 8, 16), white),
            at(mesh(new THREE.CapsuleGeometry(0.035, 0.12, 6, 12), pink), 0, 0, 0.035),
          );
          ear.scale.z = 0.45;
          const pivot = group(at(ear, 0, 0.14, 0));
          pivot.position.set(side * 0.3, 0.4, -0.05); pivot.rotation.z = -side * 0.4;
          anims.push(t => { pivot.rotation.z = -side * 0.4 + Math.sin(t * 2.2 + side * 2) * 0.06; });
          g.add(pivot);
        }
        return g;
      }
    }
  }

  // ===================== ธงเจ (ปักข้างหัว) =====================
  if (spec.flag) {
    const flagTex = tex(256, 192, (c, w, h) => {
      c.fillStyle = '#ffd400'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#d4001a'; c.font = 'bold 120px Sarabun, Tahoma, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('เจ', w / 2, h / 2 + 6);
    });
    const pole = at(mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 8), mat(0x8d6e63)), 0, 0.17, 0);
    const cloth = at(mesh(new THREE.PlaneGeometry(0.26, 0.19), mat(0xffffff, { map: flagTex, side: THREE.DoubleSide, roughness: 0.8, clearcoat: 0 })), 0.13, 0.24, 0);
    anims.push(t => { cloth.rotation.y = Math.sin(t * 3) * 0.25; });
    const g = group(pole, cloth); g.position.set(0.33, 0.36, -0.08); g.rotation.z = -0.45;
    attach(rig.head, g);
  }

  // ===================== สร้อย/พวงมาลัยที่คอ =====================
  if (spec.neck) attach(rig.body, makeNeck(spec.neck));
  function makeNeck(kind: NeckKind): Obj {
    if (kind === 'bowtie') {
      const gold = mat(0xf5c542, { metalness: 0.5, roughness: 0.3 });
      const g = group(
        at(mesh(new THREE.ConeGeometry(0.055, 0.1, 4), gold), -0.055, 0, 0, 0, 0, Math.PI / 2),
        at(mesh(new THREE.ConeGeometry(0.055, 0.1, 4), gold), 0.055, 0, 0, 0, 0, -Math.PI / 2),
        mesh(new THREE.SphereGeometry(0.03, 12, 10), gold),
      );
      g.position.set(0, 0.47, 0.17);
      return g;
    }
    // พวงมาลัย: ลูกปัดดอกไม้รอบคอ (ห้อยต่ำด้านหน้า) + อุบะห้อยหน้าอก
    // มาลัยมะลิแซมดอกบานไม่รู้โรย (ขาวล้วนกลืนกับตัวน้อง) / มาลัยดาวเรือง
    const cols = kind === 'jasmine' ? [0xffffff, 0xfff6d8, 0xffffff, 0xc2185b] : [0xff9800, 0xffc107, 0xff7a00];
    const mats = cols.map(c => mat(c, { roughness: 0.75, clearcoat: 0.1 }));
    const bead = keep(new THREE.SphereGeometry(0.036, 10, 8));
    const ring = group();
    const n = 30;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const b = new THREE.Mesh(bead, mats[i % mats.length]);
      b.position.set(Math.sin(a) * 0.19, 0, Math.cos(a) * 0.17);
      ring.add(b);
    }
    ring.position.y = 0.46; ring.rotation.x = 0.42;
    const accent = mat(kind === 'jasmine' ? 0xd81b60 : 0xc2185b, { roughness: 0.6 });
    const green = mat(0x2e7d32, { roughness: 0.7 });
    const tassel = group(
      at(mesh(new THREE.SphereGeometry(0.035, 12, 10), accent), 0, 0, 0),
      at(mesh(new THREE.ConeGeometry(0.03, 0.06, 8), green), 0, -0.05, 0, Math.PI),
      at(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.1, 6), mats[0]), 0, -0.12, 0),
    );
    tassel.position.set(0, 0.34, 0.27);
    anims.push(t => { tassel.rotation.z = Math.sin(t * 2.4) * 0.12; });
    return group(ring, tassel);
  }

  // ===================== ผ้าขาวม้าพาดไหล่ =====================
  if (spec.sash) {
    const plaid = tex(256, 64, (c, w, h) => {
      c.fillStyle = '#c62828'; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(30, 90, 200, .75)'; for (let x = 0; x < w; x += 32) c.fillRect(x, 0, 12, h);
      c.fillStyle = 'rgba(46, 160, 70, .7)'; for (let y = 0; y < h; y += 24) c.fillRect(0, y, w, 8);
      c.fillStyle = 'rgba(255, 255, 255, .55)'; for (let x = 18; x < w; x += 32) c.fillRect(x, 0, 3, h);
    }, 6);
    const band = mesh(new THREE.TorusGeometry(0.3, 0.03, 10, 64), mat(0xffffff, { map: plaid, roughness: 0.8, clearcoat: 0 }));
    band.scale.set(0.98, 1.3, 1.6); band.rotation.y = Math.PI / 2;
    const g = group(band); g.position.set(0, 0.27, 0); g.rotation.z = 0.62;
    attach(rig.body, g);
  }

  // ===================== ของในมือซ้าย =====================
  // ของถือขยาย 1.35 เท่า (ขนาดจริงเล็กจนดูไม่ออกบนจอ — ทดสอบภาพ 21 พ.ย. 2569)
  if (spec.prop) { const p = makeProp(spec.prop); p.scale.multiplyScalar(1.35); attach(rig.hands[1], p); }
  function makeProp(kind: PropKind): Obj {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const stemMat = () => mat(0x2e7d32, { roughness: 0.7 });
    switch (kind) {
      case 'sparkler': {
        const s = new THREE.Shape();
        for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.035 : 0.08, a = (i / 10) * Math.PI * 2 + Math.PI / 2; i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
        const starGeo = new THREE.ExtrudeGeometry(s, { depth: 0.025, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2 }); starGeo.center();
        const star = mesh(starGeo, mat(0xffd23f, { metalness: 0.5, roughness: 0.25, emissive: 0xffb300, emissiveIntensity: 0.35 }));
        const tip = V(0, 0.3, 0.18);
        star.position.copy(tip);
        const sparks = group();
        const sg = keep(new THREE.SphereGeometry(0.012, 6, 6));
        const sm = glow(0xfff3a0);
        for (let i = 0; i < 8; i++) sparks.add(new THREE.Mesh(sg, sm));
        sparks.position.copy(tip);
        anims.push(t => sparks.children.forEach((p, i) => {
          const a = i * 0.8 + t * 3, r = 0.1 + 0.03 * Math.sin(t * 9 + i);
          p.position.set(Math.cos(a) * r, Math.sin(a * 1.3) * r, Math.sin(a) * 0.04);
          p.visible = Math.sin(t * 13 + i * 2.1) > -0.3;
        }));
        anims.push(t => { star.rotation.z = Math.sin(t * 2) * 0.3; });
        return group(rod(V(0, -0.05, 0.02), tip, 0.008, mat(0x9e9e9e, { metalness: 0.6 })), star, sparks);
      }
      case 'balloon': {
        const top = V(0.12, 0.85, 0.12);
        const ball = mesh(new THREE.SphereGeometry(0.16, 28, 20), mat(0xe53935, { roughness: 0.15, clearcoat: 1 }));
        ball.scale.y = 1.15;
        const knot = at(mesh(new THREE.ConeGeometry(0.025, 0.04, 8), mat(0xe53935)), 0, -0.19, 0);
        const head = group(ball, knot); head.position.copy(top).add(V(0, 0.19, 0));
        const string = rod(V(0, -0.02, 0.02), top, 0.004, mat(0xeeeeee));
        anims.push(t => { head.position.x = top.x + Math.sin(t * 1.3) * 0.03; head.rotation.z = Math.sin(t * 1.3) * 0.08; });
        return group(string, head);
      }
      case 'rose': {
        const red = mat(0xc2185b, { roughness: 0.5 });
        const tip = V(0, 0.2, 0.2);
        const bloom = group(mesh(new THREE.SphereGeometry(0.045, 14, 12), red));
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const p = at(mesh(new THREE.SphereGeometry(0.04, 12, 10), red), Math.cos(a) * 0.035, -0.01, Math.sin(a) * 0.035);
          p.scale.set(1, 0.7, 0.45); p.lookAt(0, 0, 0); bloom.add(p);
        }
        bloom.position.copy(tip);
        const leaf = at(mesh(new THREE.SphereGeometry(0.04, 10, 8), stemMat()), 0.03, 0.1, 0.11); leaf.scale.set(1, 0.25, 0.5);
        return group(rod(V(0, -0.06, 0.03), tip, 0.009, stemMat()), bloom, leaf);
      }
      case 'angpao': {
        const t = tex(128, 176, (c, w, h) => {
          c.fillStyle = '#c8102e'; c.fillRect(0, 0, w, h);
          c.strokeStyle = '#f5c542'; c.lineWidth = 6; c.strokeRect(8, 8, w - 16, h - 16);
          c.fillStyle = '#f5c542'; c.beginPath(); c.arc(w / 2, h * 0.45, 30, 0, Math.PI * 2); c.fill();
          c.fillStyle = '#c8102e'; c.fillRect(w / 2 - 9, h * 0.45 - 9, 18, 18);
        });
        const red = mat(0xc8102e);
        const env = mesh(new THREE.BoxGeometry(0.15, 0.2, 0.012), [red, red, red, red, mat(0xffffff, { map: t }), red]);
        env.position.set(0.02, -0.17, 0.07); env.rotation.set(0, 0, 0.1);
        return env;
      }
      case 'lotus': {
        const pink = mat(0xf48fb1, { roughness: 0.5, sheen: 0.4, sheenColor: new THREE.Color(0xffffff) });
        const tip = V(0, 0.2, 0.18);
        const pts: THREE_NS.Vector2[] = [];
        for (let i = 0; i <= 10; i++) { const v = i / 10; pts.push(new THREE.Vector2(Math.sin(v * Math.PI) * 0.06 * (1 - v * 0.35), v * 0.17)); }
        const bud = group(mesh(new THREE.LatheGeometry(pts, 20), pink));
        for (let i = 0; i < 3; i++) {
          const pet = mesh(new THREE.SphereGeometry(0.05, 12, 10), pink);
          pet.scale.set(0.55, 1.2, 0.2); pet.position.set(Math.cos(i * 2.1) * 0.045, 0.06, Math.sin(i * 2.1) * 0.045); pet.rotation.y = -i * 2.1;
          bud.add(pet);
        }
        bud.position.copy(tip); bud.position.y -= 0.04;
        return group(rod(V(0, -0.06, 0.03), tip, 0.01, stemMat()), bud);
      }
      case 'candle': {
        const wax = mat(0xf2a93b, { roughness: 0.55, clearcoat: 0.3 });
        const body = mesh(new THREE.CylinderGeometry(0.055, 0.062, 0.4, 24), wax);
        const g = group(body);
        for (const y of [-0.12, 0, 0.12]) g.add(at(mesh(new THREE.TorusGeometry(0.06, 0.012, 8, 24), mat(0xe08a1e)), 0, y, 0, Math.PI / 2));
        g.add(at(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.03, 6), mat(0x222222)), 0, 0.215, 0));
        g.add(at(flame(), 0, 0.25, 0));
        g.position.set(0, 0.02, 0.1);
        return g;
      }
      case 'waterGun': {
        const blue = mat(0x1e88e5, { roughness: 0.3, clearcoat: 0.8 });
        const orange = mat(0xff7043, { roughness: 0.3, clearcoat: 0.8 });
        const g = group(
          at(mesh(new THREE.BoxGeometry(0.08, 0.07, 0.26), blue), 0, 0.02, 0.08),
          at(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 12), orange), 0, 0.03, 0.26, Math.PI / 2),
          at(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 18), mat(0x80deea, { transparent: true, opacity: 0.85, roughness: 0.05 })), 0, 0.1, 0.08, Math.PI / 2),
          at(mesh(new THREE.BoxGeometry(0.05, 0.12, 0.05), orange), 0, -0.06, -0.01, 0.3),
        );
        g.position.set(0, -0.08, 0.04);
        return g;
      }
      case 'jasmine': {
        const white = mat(0xffffff, { roughness: 0.75, clearcoat: 0.1 });
        const bead = keep(new THREE.SphereGeometry(0.022, 8, 6));
        const ring = group();
        for (let i = 0; i < 22; i++) { const a = (i / 22) * Math.PI * 2; const b = new THREE.Mesh(bead, white); b.position.set(Math.sin(a) * 0.09, -Math.cos(a) * 0.09, 0); ring.add(b); }
        ring.position.set(0, -0.2, 0.06);
        const accent = at(mesh(new THREE.SphereGeometry(0.03, 10, 8), mat(0xd81b60)), 0, -0.3, 0.06);
        anims.push(t => { ring.rotation.z = Math.sin(t * 1.8) * 0.15; });
        return group(ring, accent);
      }
      case 'lantern': {
        const red = mat(0xd32f2f, { roughness: 0.4, emissive: 0xff3b1f, emissiveIntensity: 0.35 });
        const gold = mat(0xf5c542, { metalness: 0.5, roughness: 0.3 });
        const body = mesh(new THREE.SphereGeometry(0.11, 24, 18), red); body.scale.y = 0.82;
        const lan = group(
          body,
          at(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16), gold), 0, 0.095, 0),
          at(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16), gold), 0, -0.095, 0),
          at(mesh(new THREE.CylinderGeometry(0.008, 0.02, 0.1, 8), gold), 0, -0.16, 0),
        );
        lan.position.y = -0.2;
        const hang = group(rod(V(0, 0, 0), V(0, -0.1, 0), 0.004, gold), lan);
        hang.position.set(0, -0.05, 0.05);
        anims.push(t => { hang.rotation.z = Math.sin(t * 1.6) * 0.12; hang.rotation.x = Math.sin(t * 1.1) * 0.06; });
        return hang;
      }
      case 'pumpkin': {
        const face = tex(256, 128, (c, w, h) => {
          c.fillStyle = '#ff8a1a'; c.fillRect(0, 0, w, h);
          c.strokeStyle = 'rgba(160, 70, 0, .45)'; c.lineWidth = 4;
          for (let x = 0; x < w; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
          c.fillStyle = '#2b1400';
          const cx = w * 0.5;
          c.beginPath(); c.moveTo(cx - 34, 52); c.lineTo(cx - 20, 30); c.lineTo(cx - 6, 52); c.fill();
          c.beginPath(); c.moveTo(cx + 6, 52); c.lineTo(cx + 20, 30); c.lineTo(cx + 34, 52); c.fill();
          c.beginPath(); c.moveTo(cx - 40, 70); c.quadraticCurveTo(cx, 108, cx + 40, 70); c.lineTo(cx + 28, 80); c.lineTo(cx + 16, 72); c.lineTo(cx, 84); c.lineTo(cx - 16, 72); c.lineTo(cx - 28, 80); c.fill();
        });
        const pum = mesh(new THREE.SphereGeometry(0.12, 28, 18), mat(0xffffff, { map: face, roughness: 0.55 }));
        pum.scale.y = 0.82; pum.rotation.y = -Math.PI / 2;
        const handle = at(mesh(new THREE.TorusGeometry(0.1, 0.008, 6, 24, Math.PI), mat(0x333333)), 0, 0.06, 0);
        const g = group(pum, handle); g.position.set(0, -0.26, 0.03);
        anims.push(t => { g.rotation.z = Math.sin(t * 1.7) * 0.08; });
        return g;
      }
      case 'krathong': {
        const leafTex = tex(256, 32, (c, w, h) => { c.fillStyle = '#2e7d32'; c.fillRect(0, 0, w, h); c.fillStyle = '#43a047'; for (let x = 0; x < w; x += 16) { c.beginPath(); c.moveTo(x, h); c.lineTo(x + 8, 0); c.lineTo(x + 16, h); c.fill(); } }, 4);
        const base = mesh(new THREE.CylinderGeometry(0.15, 0.12, 0.06, 32), mat(0xffffff, { map: leafTex, roughness: 0.6 }));
        const g = group(base);
        const petal = keep(new THREE.SphereGeometry(0.04, 10, 8));
        const pm = [mat(0xffffff, { roughness: 0.6 }), mat(0xf48fb1, { roughness: 0.6 }), mat(0xffc107, { roughness: 0.6 })];
        for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; const p = new THREE.Mesh(petal, pm[i % 3]); p.position.set(Math.cos(a) * 0.1, 0.05, Math.sin(a) * 0.1); p.scale.set(0.7, 1.2, 0.7); g.add(p); }
        const cone = at(mesh(new THREE.ConeGeometry(0.07, 0.12, 16), pm[0]), 0, 0.1, 0);
        g.add(cone);
        g.add(at(mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.08, 8), mat(0xfff3c4)), 0, 0.2, 0));
        g.add(at(flame(), 0, 0.25, 0));
        for (const dx of [-0.03, 0, 0.03]) g.add(at(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.18, 6), mat(0x8d4e2a)), 0.05 + dx, 0.15, -0.04, 0, 0, -0.15));
        g.position.set(0, -0.18, 0.12);
        return g;
      }
      case 'canna': {
        const yellow = mat(0xffd000, { roughness: 0.45 });
        const tip = V(0, 0.22, 0.18);
        const bloom = group();
        for (let i = 0; i < 5; i++) {
          const p = mesh(new THREE.SphereGeometry(0.05, 12, 10), yellow);
          p.scale.set(0.45, 1.2, 0.2); const a = (i / 5) * Math.PI * 2;
          p.position.set(Math.cos(a) * 0.035, 0.02, Math.sin(a) * 0.035); p.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
          bloom.add(p);
        }
        bloom.position.copy(tip);
        const leaf = at(mesh(new THREE.SphereGeometry(0.06, 10, 8), stemMat()), 0.04, 0.08, 0.09, 0, 0, -0.6); leaf.scale.set(0.4, 1.4, 0.15);
        return group(rod(V(0, -0.06, 0.03), tip, 0.01, stemMat()), bloom, leaf);
      }
      case 'gift': {
        const red = mat(0xd32f2f, { roughness: 0.4 });
        const gold = mat(0xf5c542, { metalness: 0.5, roughness: 0.3 });
        const g = group(
          mesh(new THREE.BoxGeometry(0.18, 0.16, 0.18), red),
          mesh(new THREE.BoxGeometry(0.035, 0.165, 0.185), gold),
          mesh(new THREE.BoxGeometry(0.185, 0.165, 0.035), gold),
          at(mesh(new THREE.TorusGeometry(0.035, 0.012, 8, 20), gold), -0.03, 0.1, 0, 0, 0, 0.6),
          at(mesh(new THREE.TorusGeometry(0.035, 0.012, 8, 20), gold), 0.03, 0.1, 0, 0, 0, -0.6),
        );
        g.position.set(0, -0.2, 0.06);
        return g;
      }
      case 'egg': {
        const stripes = tex(128, 128, (c, w, h) => {
          c.fillStyle = '#b3e5fc'; c.fillRect(0, 0, w, h);
          [['#f8bbd0', 30], ['#fff59d', 64], ['#c5e1a5', 98]].forEach(([col, y]) => { c.fillStyle = col as string; c.fillRect(0, (y as number) - 8, w, 16); });
          c.fillStyle = '#ffffff'; for (let x = 8; x < w; x += 20) { c.beginPath(); c.arc(x, 47, 4, 0, Math.PI * 2); c.fill(); c.beginPath(); c.arc(x + 10, 81, 4, 0, Math.PI * 2); c.fill(); }
        });
        const egg = mesh(new THREE.SphereGeometry(0.07, 24, 18), mat(0xffffff, { map: stripes, roughness: 0.35 }));
        egg.scale.y = 1.3; egg.position.set(0, -0.1, 0.09);
        return egg;
      }
    }
  }

  return {
    parts: added.length,
    update: (t: number) => { for (const a of anims) a(t); },
    dispose: () => {
      for (const [p, o] of added) p.remove(o);
      rig.capeMat.color.setHex(rig.capeColor);
      for (const d of trash) d.dispose();
    },
  };
}
