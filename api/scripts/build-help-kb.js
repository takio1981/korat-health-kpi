/**
 * สร้างฐานความรู้ของผู้ช่วยคู่มือ (ผู้ช่วย AI ระยะที่ 4 — 8 พ.ย. 2569) จากหน้าคู่มือของระบบ
 *   ต้นทาง: frontend/src/app/help/help.html (เนื้อหา) + help.ts (สิทธิ์ของแต่ละหัวข้อ — sections[].roles)
 *   ปลายทาง: api/data/help-kb.json (backend โหลดตอนตอบคำถาม — ไม่อ่านไฟล์ frontend ตอนรัน)
 * แบ่งเป็นชิ้นตามหัวข้อ (h2) / หัวข้อย่อย (h3/h4) และตามเงื่อนไขการแสดงผล (*ngIf) — แต่ละชิ้นมี audience = role ที่เห็นชิ้นนั้น
 * (+ 'public' = ผู้ที่เปิดคู่มือโดยไม่เข้าสู่ระบบ) คำนวณด้วยกติกาเดียวกับ HelpComponent.canSeeSection()
 * ⚠️ แก้ help.html/help.ts แล้วต้องรัน `node scripts/build-help-kb.js` ใหม่ — tests/help-kb.test.js ตรวจว่าไฟล์ตรงกับคู่มือปัจจุบัน
 * ไม่ใช้ไลบรารีภายนอก (ชุดทดสอบของ api ใน CI ไม่ได้ติดตั้งแพ็กเกจของ frontend)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HELP_HTML = path.join(ROOT, 'frontend', 'src', 'app', 'help', 'help.html');
const HELP_TS = path.join(ROOT, 'frontend', 'src', 'app', 'help', 'help.ts');
const OUT = path.join(__dirname, '..', 'data', 'help-kb.json');

const ROLES = ['super_admin', 'admin_ssj', 'admin_cup', 'admin_hos', 'admin_sso', 'user_cup', 'user_hos', 'user_sso', 'user_ssj'];
const AUDIENCES = [...ROLES, 'public'];
const MAX_CHUNK = 1400;
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source', 'wbr', 'col', 'area']);
const BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'thead', 'tbody', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'pre', 'details', 'summary']);
const CELL = new Set(['td', 'th']);

// sections[] ใน help.ts → { id: { label, roles: 'all' | string[] } }
function parseSections(ts) {
    const consts = {};
    for (const m of ts.matchAll(/static readonly (\w+)\s*=\s*\[([^\]]*)\]/g)) {
        consts[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1]);
    }
    const out = {};
    for (const m of ts.matchAll(/\{\s*id:\s*'([^']+)',[^}]*?label:\s*'([^']+)',\s*roles:\s*([^}]+?)\s*\}/g)) {
        const raw = m[3].trim();
        let roles;
        if (raw === "'all'") roles = 'all';
        else {
            const c = raw.match(/^HelpComponent\.(\w+)$/);
            if (!c || !consts[c[1]]) throw new Error(`help.ts: ไม่รู้จักสิทธิ์ของหัวข้อ ${m[1]}: ${raw}`);
            roles = consts[c[1]];
        }
        out[m[1]] = { label: m[2], roles };
    }
    if (!Object.keys(out).length) throw new Error('help.ts: ไม่พบ sections');
    return out;
}

// ผู้ชม 1 กลุ่มเห็นหัวข้อ id ไหม — ตรงกับ HelpComponent.canSeeSection()
function canSee(sections, audience, id) {
    const s = sections[id];
    if (!s) return false;
    if (s.roles === 'all') return true;
    if (audience === 'public') return false;
    return s.roles.includes(audience);
}

// เงื่อนไข *ngIf ที่คู่มือใช้: canSeeSection('x') เชื่อมด้วย || / && , isPublicView, !isPublicView — แบบอื่น = แจ้งให้ปรับสคริปต์นี้
function evalCondition(sections, cond, audience) {
    const ors = cond.split('||').map(s => s.trim());
    return ors.some(orPart => orPart.split('&&').map(s => s.trim()).every(term => {
        let m;
        if ((m = term.match(/^canSeeSection\('([^']+)'\)$/))) return canSee(sections, audience, m[1]);
        if (term === 'isPublicView') return audience === 'public';
        if (term === '!isPublicView') return audience !== 'public';
        throw new Error(`help.html: เงื่อนไข *ngIf ที่สคริปต์ยังไม่รองรับ: "${cond}" — ปรับ evalCondition() ใน scripts/build-help-kb.js`);
    }));
}

const decode = (s) => s
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const cleanText = (s) => s.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');

function splitLong(text) {
    if (text.length <= MAX_CHUNK) return [text];
    const parts = [];
    let cur = '';
    for (const line of text.split('\n')) {
        if (cur && cur.length + line.length + 1 > MAX_CHUNK) { parts.push(cur); cur = ''; }
        cur = cur ? cur + '\n' + line : line;
    }
    if (cur) parts.push(cur);
    return parts;
}

function buildHelpKb({ html = fs.readFileSync(HELP_HTML, 'utf8'), ts = fs.readFileSync(HELP_TS, 'utf8') } = {}) {
    html = html.replace(/\r\n/g, '\n');
    const sections = parseSections(ts);
    const all = new Set(AUDIENCES);
    const chunks = [];
    const stack = [];
    let cur = null;      // ชิ้นที่กำลังเก็บข้อความ
    let ctx = null;      // { anchor, section } ของหัวข้อหลักที่อยู่
    let heading = null;  // หัวข้อย่อยล่าสุด
    let capture = null;  // { level, text } ขณะอยู่ใน h2/h3/h4

    const audienceOf = () => (stack.length ? stack[stack.length - 1].aud : all);
    const flush = () => {
        if (cur) {
            const text = cleanText(cur.parts.join(''));
            if (text && cur.aud.size) chunks.push({ anchor: cur.anchor, section: cur.section, heading: cur.heading, text, audience: AUDIENCES.filter(a => cur.aud.has(a)) });
        }
        cur = null;
    };
    const start = () => { flush(); if (ctx) cur = { anchor: ctx.anchor, section: ctx.section, heading, aud: audienceOf(), parts: [] }; };
    const emit = (s) => { if (capture) capture.text += s; if (cur) cur.parts.push(s); };

    const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
        if (m[4] !== undefined) { if (stack.some(e => e.inSection)) emit(decode(m[4])); continue; }
        if (!m[2]) continue; // comment
        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        const attrs = m[3] || '';
        if (!closing) {
            const selfClose = VOID.has(tag) || /\/\s*$/.test(attrs);
            const ngIf = attrs.match(/\*ngIf="([^"]*)"/);
            const idm = attrs.match(/\bid="section-([^"]+)"/);
            const parentAud = audienceOf();
            let aud = parentAud;
            // นอกเนื้อหาคู่มือ (ส่วนหัว/เมนู) ไม่ต้องประเมินเงื่อนไข
            if (ngIf && (stack.some(e => e.inSection) || (tag === 'section' && idm))) aud = new Set([...parentAud].filter(a => evalCondition(sections, ngIf[1], a)));
            const isSection = tag === 'section' && idm && !stack.some(e => e.inSection);
            if (tag === 'section' && !idm && !stack.some(e => e.inSection) && html.indexOf('id="section-', 0) < m.index) {
                throw new Error('help.html: <section> ระดับบนสุดต้องมี id="section-…" (ใช้เป็นจุดอ้างอิงคำตอบ)');
            }
            if (BLOCK.has(tag)) emit('\n'); else if (CELL.has(tag)) emit(' | ');
            if (selfClose) continue;
            const entry = { tag, aud, inSection: isSection || stack.some(e => e.inSection), section: isSection, headingAtOpen: heading };
            stack.push(entry);
            if (isSection) { ctx = { anchor: idm[1], section: (sections[idm[1]] && sections[idm[1]].label) || null }; heading = null; start(); }
            else if (aud.size !== parentAud.size && entry.inSection) start();
            if (entry.inSection && /^h[2-4]$/.test(tag)) capture = { level: tag, text: '' };
        } else {
            // ปิดแท็ก: ไล่ stack ถึงแท็กชื่อเดียวกัน (กัน HTML ที่ปิดไม่ครบ)
            let i = stack.length - 1;
            while (i >= 0 && stack[i].tag !== tag) i--;
            if (i < 0) continue;
            const [entry] = stack.splice(i);
            if (capture && entry.tag === capture.level) {
                const t = cleanText(capture.text).replace(/\n/g, ' ');
                if (capture.level === 'h2') { ctx.section = t; heading = null; if (cur) { cur.section = t; cur.heading = null; } }
                else { // หัวข้อย่อยใหม่ = ชิ้นใหม่ (ข้อความหัวข้อย่อยอยู่ต้นชิ้น)
                    const before = cur ? cur.parts.join('') : '';
                    const idx = before.lastIndexOf(capture.text);
                    if (cur && idx >= 0) cur.parts = [before.slice(0, idx)];
                    heading = t;
                    start();
                    emit(t);
                }
                capture = null;
            }
            if (BLOCK.has(tag)) emit('\n');
            if (entry.section) { flush(); ctx = null; heading = null; }
            else if (entry.inSection && entry.aud.size !== audienceOf().size) { heading = entry.headingAtOpen; start(); }
        }
    }
    flush();
    // แบ่งชิ้นที่ยาวเกิน + ตั้งรหัสชิ้น (หัวข้อ-ลำดับ)
    const out = [];
    const seq = {};
    for (const c of chunks) {
        for (const text of splitLong(c.text)) {
            seq[c.anchor] = (seq[c.anchor] || 0) + 1;
            out.push({ id: `${c.anchor}-${seq[c.anchor]}`, anchor: c.anchor, section: c.section, heading: c.heading, text, audience: c.audience });
        }
    }
    return { version: 1, source: 'frontend/src/app/help/help.html', audiences: AUDIENCES, chunks: out };
}

// 1 ชิ้นต่อ 1 บรรทัด — อ่าน diff ใน git ได้ และไฟล์เล็กกว่าแบบย่อหน้า
const serialize = (kb) => {
    const { chunks, ...head } = kb;
    return JSON.stringify(head).slice(0, -1) + ',"chunks":[\n' + chunks.map(c => JSON.stringify(c)).join(',\n') + '\n]}\n';
};

module.exports = { buildHelpKb, serialize, evalCondition, parseSections, OUT, AUDIENCES };

if (require.main === module) {
    const kb = buildHelpKb();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, serialize(kb));
    const chars = kb.chunks.reduce((s, c) => s + c.text.length, 0);
    console.log(`help-kb.json: ${kb.chunks.length} ชิ้น ${chars} ตัวอักษร`);
}
