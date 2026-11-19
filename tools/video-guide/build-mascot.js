/**
 * ตัด "น้องโคราชดี" จาก frontend/public/korat-d.png เป็นชิ้นส่วนสำหรับทำภาพเคลื่อนไหว → cache/mascot/*.webp
 * ภาพต้นฉบับเป็นภาพแบนพื้นหลังทึบ และตัวสีขาวกลืนกับพื้นหลัง จึงลากเส้นขอบด้วยพิกัด (พิกัด = พิกเซลของภาพต้นฉบับ)
 * ผลลัพธ์อยู่ใน cache (ไม่เข้า git) — run.js เรียกไฟล์นี้ให้เองเมื่อยังไม่มี
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC = path.resolve(__dirname, '../../frontend/public/korat-d.png');
const OUT = path.join(__dirname, 'cache', 'mascot');
const BOX = { left: 212, top: 2, width: 281, height: 407 };
const S = 2;

// พิกัดจากภาพขยาย: C = ภาพรวม ×3 เริ่ม (215,5) | F = เท้า ×6 เริ่ม (270,315)
const C = (x, y) => [215 + x / 3, 5 + y / 3];
const F = (x, y) => [270 + x / 6, 315 + y / 6];
const list = (fn, a) => a.map(([x, y]) => fn(x, y));

const HEART = list(C, [[423, 78], [432, 50], [455, 33], [485, 30], [512, 42], [528, 55], [548, 44], [572, 46], [592, 65], [600, 92], [590, 122], [570, 143]]);
const HEAD_RIGHT = list(C, [[600, 165], [650, 185], [700, 212], [740, 250], [765, 295], [782, 350], [793, 415], [797, 436], [806, 460], [813, 500], [810, 550], [795, 595], [770, 625], [740, 638], [712, 636], [698, 640]]);
const HEAD_BOTTOM = list(C, [[680, 668], [640, 690], [590, 705], [530, 709], [470, 704], [400, 693], [340, 684], [285, 671]]);
const HEAD_LEFT = list(C, [[220, 646], [165, 616], [120, 576], [97, 535], [86, 497], [72, 488], [58, 450], [54, 400], [65, 350], [85, 322], [108, 313], [130, 250], [165, 190], [210, 150], [260, 127], [330, 121], [390, 129], [423, 138]]);
const CAPE = list(C, [[530, 712], [590, 742], [650, 780], [720, 815], [780, 840], [816, 871], [812, 883], [780, 886], [745, 890], [715, 906], [697, 925]]);
const R_HAND = list(C, [[709, 955], [705, 990], [680, 1012], [645, 1021], [615, 1013], [595, 991], [585, 960], [589, 936], [568, 932], [552, 905], [540, 905], [536, 932]]);
const R_LEG = list(F, [[745, 40], [790, 190], [830, 310], [852, 430], [846, 470], [800, 505], [700, 523], [590, 516], [545, 496], [534, 456], [540, 440], [520, 340], [490, 190], [472, 150], [420, 142], [365, 146]]);
const L_LEG = list(F, [[362, 160], [375, 230], [385, 320], [386, 405], [384, 455], [350, 471], [260, 484], [130, 486], [70, 471], [49, 440], [60, 400], [85, 340], [100, 270], [100, 130], [105, 60], [114, 26]]);
const BODY_LEFT = list(C, [[216, 890], [225, 830], [232, 800]]);
const ARM = list(C, [[250, 697], [244, 730], [226, 770], [207, 797], [170, 798], [130, 776], [100, 751], [65, 736], [50, 721], [28, 690], [21, 650], [34, 620], [55, 600], [45, 570], [31, 535], [38, 511], [58, 509], [78, 535], [95, 575], [105, 590], [125, 574], [150, 574], [168, 595], [161, 630], [149, 655], [175, 649], [183, 680], [207, 699]]);

const HEAD = [...HEART, ...HEAD_RIGHT, ...HEAD_BOTTOM, ...HEAD_LEFT];
// ลำตัว: ล้ำเข้าใต้ศีรษะเล็กน้อย กันช่องว่างตอนศีรษะเอียง
const BODY = [...list(C, [[285, 650], [420, 660], [530, 680]]), ...CAPE, ...R_HAND, ...R_LEG, ...L_LEG, ...BODY_LEFT, ...list(C, [[240, 770], [250, 700]])];
// ส่วนศีรษะที่มือบังในภาพต้นฉบับ — เติมสีเปลือกให้เต็มเมื่อแขนขยับออก
const HEAD_UNDER = list(C, [[86, 497], [97, 535], [120, 576], [165, 616], [220, 646], [240, 600], [200, 500], [120, 470]]);
const NECK_UNDER = list(C, [[270, 640], [440, 650], [470, 720], [330, 730], [280, 700]]);

const toV = ([x, y]) => [(x - BOX.left) * S, (y - BOX.top) * S];
function smooth(points) { // Catmull-Rom ปิดรูป → เส้นโค้ง Bezier
    const p = points.map(toV), n = p.length, f = (v) => v.toFixed(1);
    let d = `M${f(p[0][0])} ${f(p[0][1])}`;
    for (let i = 0; i < n; i++) {
        const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n], e = p[(i + 2) % n];
        d += `C${f(b[0] + (c[0] - a[0]) / 6)} ${f(b[1] + (c[1] - a[1]) / 6)} ${f(c[0] - (e[0] - b[0]) / 6)} ${f(c[1] - (e[1] - b[1]) / 6)} ${f(c[0])} ${f(c[1])}`;
    }
    return d + 'Z';
}
const W = BOX.width * S, H = BOX.height * S;
const svg = (body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`);
const pathOf = (pts, attrs = 'fill="#fff"') => `<path d="${smooth(pts)}" ${attrs}/>`;
const v = (cx, cy) => toV(C(cx, cy));

async function cut(src, maskBody, under = '') {
    const m = await sharp(svg(maskBody)).ensureAlpha().extractChannel('alpha').blur(0.9).raw().toBuffer();
    const rgb = await sharp(src).removeAlpha().raw().toBuffer();
    const out = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { out[i * 4] = rgb[i * 3]; out[i * 4 + 1] = rgb[i * 3 + 1]; out[i * 4 + 2] = rgb[i * 3 + 2]; out[i * 4 + 3] = m[i]; }
    let img = sharp(out, { raw: { width: W, height: H, channels: 4 } }).png();
    if (under) img = sharp(svg(under)).composite([{ input: await img.toBuffer() }]);
    return img.png().toBuffer();
}

async function build() {
    fs.mkdirSync(OUT, { recursive: true });
    const srcPng = await sharp(SRC).removeAlpha().extract(BOX).resize(W, H, { kernel: 'lanczos3' }).png().toBuffer();
    // ลบปากเดิมบนจอ (วาดใหม่ตามเสียงพูด) — ใช้สีจอจริงรอบปาก
    const [mx, my] = v(370, 522);
    const face = await sharp(svg(`<ellipse cx="${mx}" cy="${my}" rx="${(62 / 3) * S}" ry="${(44 / 3) * S}" transform="rotate(8 ${mx} ${my})" fill="#292c2e"/>`)).blur(3).png().toBuffer();
    const faceSrc = await sharp(srcPng).composite([{ input: face }]).png().toBuffer();

    const head = await cut(faceSrc, pathOf(HEAD), pathOf(HEAD_UNDER, 'fill="#eef3f5"'));
    const arm = await cut(srcPng, pathOf(ARM));
    const body = await cut(srcPng, pathOf(BODY), pathOf(NECK_UNDER, 'fill="#1fa39a"'));
    const [sx, sy] = v(325, 870);
    const seal = await cut(srcPng, `<circle cx="${sx}" cy="${sy}" r="${(57 / 3) * S}" fill="#fff"/>`);
    const parts = { body, head, arm, seal };
    for (const [k, b] of Object.entries(parts)) await sharp(b).webp({ quality: 88, alphaQuality: 95 }).toFile(path.join(OUT, k + '.webp'));

    // ภาพตรวจบนพื้นสีชมพู
    await sharp({ create: { width: W, height: H, channels: 4, background: '#ff00ff' } })
        .composite([{ input: body }, { input: arm }, { input: head }]).png().toFile(path.join(OUT, 'preview.png'));
    console.log('mascot ok', Object.keys(parts).map(k => `${k}=${Math.round(fs.statSync(path.join(OUT, k + '.webp')).size / 1024)}KB`).join(' '));
}

/** ชิ้นส่วนเป็น data URI + จุดหมุน (สัดส่วนของกรอบภาพ) สำหรับฉีดเข้าหน้าเว็บ */
async function loadMascot() {
    if (!['body', 'head', 'arm', 'seal'].every(k => fs.existsSync(path.join(OUT, k + '.webp')))) await build();
    const parts = {};
    for (const k of ['body', 'head', 'arm', 'seal']) parts[k] = 'data:image/webp;base64,' + fs.readFileSync(path.join(OUT, k + '.webp')).toString('base64');
    const pct = (cx, cy) => { const [x, y] = C(cx, cy); return [((x - BOX.left) / BOX.width) * 100, ((y - BOX.top) / BOX.height) * 100]; };
    return { parts, ratio: BOX.width / BOX.height, pivots: { head: pct(360, 680), arm: pct(240, 745), seal: pct(325, 870) }, mouth: pct(370, 522), eyes: [pct(262, 405), pct(516, 462)] };
}

module.exports = { build, loadMascot };
if (require.main === module) build().catch(e => { console.error(e); process.exit(1); });
