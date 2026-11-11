// โหมดมืด (Dark mode) — สร้างกฎ .dark ให้ utility สีของ Tailwind ทั้งชุดอัตโนมัติ (11 พ.ย. 2569)
// เหตุผล: หน้าจอใช้พื้นสีพาสเทล (bg-*-50/100/200), ข้อความสีเข้ม (text-*-700/800/900) และกรอบสีอ่อนจำนวนมาก
// ซึ่งไม่มีคู่ dark: ในเทมเพลต → โหมดมืดเดิมเห็นเป็นกล่องสีขาว/พาสเทลจ้า ข้อความสีเข้มบนพื้นมืดอ่านยาก
// กติกา:
//   • พื้นสีอ่อน (50–300) → สีนั้น (เฉด 500) ผสมบนพื้นการ์ดมืด เป็นสีทึบ (ไม่โปร่งใส — คอลัมน์ตรึงในตารางยังบังเนื้อหาที่เลื่อนผ่าน)
//   • ข้อความ 600–900 → เฉดสว่าง (400–100)   • กรอบ 100–300 → สีนั้นจางบนพื้นมืด
//   • สีกลาง (gray/slate/zinc/neutral/stone) + พื้นขาว → โทนพื้นผิว/ข้อความของโหมดมืด (ตัวแปร --dk-* ใน styles.css)
// ค่าพื้นผิวต้องตรงกับ :root.dark ใน src/styles.css
const colors = require('tailwindcss/colors');
const fs = require('fs');
const path = require('path');

// สร้างกฎเฉพาะคลาสที่ใช้จริงใน src/ (ทั้งชุดราว 430 KB — กรองแล้วเหลือไม่กี่สิบ KB)
// ⚠️ เพิ่มคลาสสีใหม่ระหว่าง ng serve ต้องเริ่ม ng serve ใหม่ (Tailwind โหลด plugin ครั้งเดียวต่อ process) — ng build สร้างใหม่ทุกครั้ง
function usedClasses(dir = path.join(__dirname, 'src')) {
  const out = new Set();
  const re = /(?:hover:)?(?:bg|text|border|from|via|to|divide|ring)-(?:white|[a-z]+-\d{2,3})(?:\/\d{1,3})?/g;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|ts)$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) for (const m of fs.readFileSync(p, 'utf8').match(re) || []) out.add(m);
    }
  };
  walk(dir);
  return out;
}

const SURFACE = '#14232a';
const TINTS = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];
const NEUTRALS = ['gray', 'slate', 'zinc', 'neutral', 'stone'];
const OPACITY = ['', ...Array.from({ length: 19 }, (_, i) => String((i + 1) * 5))];   // /5 … /95

const hexRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (fg, bg, a) => {
  const f = hexRgb(fg), b = hexRgb(bg);
  return '#' + f.map((v, i) => Math.round(v * a + b[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
};
const rgba = (h, a) => `rgba(${hexRgb(h).join(', ')}, ${a})`;
// ชื่อคลาส → selector (escape "/" และ ":")
const cls = (name) => '.' + name.replace(/\//g, '\\/').replace(/:/g, '\\:');
const withOpacity = (base) => OPACITY.map(o => (o ? `${base}/${o}` : base));
let USED = null;   // ชุดคลาสที่ใช้จริง (null = ยังไม่สแกน) — module.exports.allClasses = true เพื่อสร้างทุกคลาส
// พื้นหลัง: ข้ามองค์ประกอบที่มี peer-checked:bg-* / checked:bg-* (สวิตช์เปิด-ปิด) — กฎ !important ของเราจะทับสีตอนเปิด ทำให้สวิตช์ดูเหมือนปิดตลอด
const NOT_CHECKED = ':not([class*="checked:bg-"])';
const dark = (names, suffix = '') => names.filter(n => !USED || USED.has(n))
  .map(n => `.dark ${cls(n)}${/^(hover:)?bg-/.test(n) ? NOT_CHECKED : ''}${suffix}`).join(',\n');

module.exports = function darkThemePlugin({ addBase }) {
  const rules = {};
  if (USED === null && !module.exports.allClasses) USED = usedClasses();
  const put = (selector, decl) => { if (!selector) return; rules[selector] = { ...(rules[selector] || {}), ...decl }; };
  const imp = (v) => `${v} !important`;

  // ===== สีที่มีความหมาย (tint) =====
  const BG_ALPHA = { 50: 0.12, 100: 0.17, 200: 0.24, 300: 0.34 };
  const HOVER_ALPHA = { 50: 0.2, 100: 0.25, 200: 0.32, 300: 0.4 };
  const TEXT_MAP = { 500: 400, 600: 400, 700: 300, 800: 200, 900: 100 };   // 500 → 400: indigo/blue/violet-500 บนพื้นมืดคอนทราสต์ต่ำ
  for (const c of TINTS) {
    const pal = colors[c];
    const base = pal[500];
    for (const [shade, a] of Object.entries(BG_ALPHA)) {
      const v = mix(base, SURFACE, a);
      put(dark(withOpacity(`bg-${c}-${shade}`)), { 'background-color': imp(v) });
      put(dark(withOpacity(`hover:bg-${c}-${shade}`), ':hover'), { 'background-color': imp(mix(base, SURFACE, HOVER_ALPHA[shade])) });
      // ไล่สีพาสเทล (bg-gradient-to-* from-*-50 to-*-100)
      put(dark(withOpacity(`from-${c}-${shade}`)), { '--tw-gradient-from': imp(`${v} var(--tw-gradient-from-position)`),
        '--tw-gradient-to': imp(`${rgba(v, 0)} var(--tw-gradient-to-position)`), '--tw-gradient-stops': imp('var(--tw-gradient-from), var(--tw-gradient-to)') });
    }
    // via/to หลัง from (selector เท่ากัน — อันหลังชนะ)
    for (const [shade, a] of Object.entries(BG_ALPHA)) {
      const v = mix(base, SURFACE, a);
      put(dark(withOpacity(`via-${c}-${shade}`)), { '--tw-gradient-to': imp(`${rgba(v, 0)} var(--tw-gradient-to-position)`),
        '--tw-gradient-stops': imp(`var(--tw-gradient-from), ${v} var(--tw-gradient-via-position), var(--tw-gradient-to)`) });
    }
    for (const [shade, a] of Object.entries(BG_ALPHA)) {
      put(dark(withOpacity(`to-${c}-${shade}`)), { '--tw-gradient-to': imp(`${mix(base, SURFACE, a)} var(--tw-gradient-to-position)`) });
    }
    for (const [from, to] of Object.entries(TEXT_MAP)) {
      put(dark(withOpacity(`text-${c}-${from}`)), { color: imp(pal[to]) });
      put(dark(withOpacity(`hover:text-${c}-${from}`), ':hover'), { color: imp(pal[to]) });
    }
    for (const shade of [100, 200, 300]) {
      const v = rgba(pal[400], shade === 300 ? 0.45 : 0.32);
      put(dark(withOpacity(`border-${c}-${shade}`)), { 'border-color': imp(v) });
      put(dark(withOpacity(`hover:border-${c}-${shade}`), ':hover'), { 'border-color': imp(v) });
      put(dark(withOpacity(`divide-${c}-${shade}`), ' > :not([hidden]) ~ :not([hidden])'), { 'border-color': imp(v) });
      put(dark(withOpacity(`ring-${c}-${shade}`)), { '--tw-ring-color': imp(v) });
    }
  }

  // ===== สีกลาง + พื้นขาว → โทนพื้นผิวโหมดมืด =====
  const NBG = { 50: 'var(--dk-surface-2)', 100: 'var(--dk-surface-2)', 200: 'var(--dk-surface-3)', 300: 'var(--dk-surface-4)' };
  const NHOVER = { 50: 'var(--dk-surface-3)', 100: 'var(--dk-surface-3)', 200: 'var(--dk-surface-4)', 300: 'var(--dk-surface-4)' };
  const NTEXT = { 900: 'var(--dk-text)', 800: 'var(--dk-text)', 700: 'var(--dk-text)', 600: 'var(--dk-text-2)', 500: 'var(--dk-text-2)', 400: 'var(--dk-text-3)', 300: 'var(--dk-text-3)' };
  for (const c of NEUTRALS) {
    for (const [shade, v] of Object.entries(NBG)) {
      put(dark(withOpacity(`bg-${c}-${shade}`)), { 'background-color': imp(v) });
      put(dark(withOpacity(`hover:bg-${c}-${shade}`), ':hover'), { 'background-color': imp(NHOVER[shade]) });
      put(dark(withOpacity(`from-${c}-${shade}`)), { '--tw-gradient-from': imp(`${v} var(--tw-gradient-from-position)`),
        '--tw-gradient-to': imp('transparent var(--tw-gradient-to-position)'), '--tw-gradient-stops': imp('var(--tw-gradient-from), var(--tw-gradient-to)') });
    }
    for (const [shade, v] of Object.entries(NBG)) put(dark(withOpacity(`to-${c}-${shade}`)), { '--tw-gradient-to': imp(`${v} var(--tw-gradient-to-position)`) });
    for (const [shade, v] of Object.entries(NTEXT)) {
      put(dark(withOpacity(`text-${c}-${shade}`)), { color: imp(v) });
      put(dark(withOpacity(`hover:text-${c}-${shade}`), ':hover'), { color: imp(v) });
    }
    for (const shade of [100, 200, 300]) {
      put(dark(withOpacity(`border-${c}-${shade}`)), { 'border-color': imp('var(--dk-border)') });
      put(dark(withOpacity(`divide-${c}-${shade}`), ' > :not([hidden]) ~ :not([hidden])'), { 'border-color': imp('var(--dk-border)') });
    }
  }
  put(dark(['from-white']), { '--tw-gradient-from': imp('var(--dk-surface) var(--tw-gradient-from-position)'),
    '--tw-gradient-to': imp('transparent var(--tw-gradient-to-position)'), '--tw-gradient-stops': imp('var(--tw-gradient-from), var(--tw-gradient-to)') });
  put(dark(['to-white']), { '--tw-gradient-to': imp('var(--dk-surface) var(--tw-gradient-to-position)') });
  put(dark(['hover:bg-white', 'hover:bg-white/50', 'hover:bg-white/60', 'hover:bg-white/70', 'hover:bg-white/80'], ':hover'), { 'background-color': imp('var(--dk-surface-3)') });
  put(dark(withOpacity('border-white')), { 'border-color': imp('var(--dk-border)') });

  addBase(rules);
};

// ส่งออกให้ชุดทดสอบตรวจค่า
module.exports.mix = mix;
module.exports.SURFACE = SURFACE;
