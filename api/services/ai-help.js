// ผู้ช่วย AI ระยะที่ 4 (8 พ.ย. 2569) — ตอบคำถามการใช้งานจากคู่มือของระบบ
// ฐานความรู้ = data/help-kb.json (สร้างจาก help.html ด้วย scripts/build-help-kb.js) แต่ละชิ้นมี audience = role ที่เห็นหัวข้อนั้นในหน้าคู่มือ
// ขั้นตอน: กรองชิ้นตามสิทธิ์ของผู้ถาม → ค้นชิ้นที่เกี่ยวข้อง (ตัดคำไทยด้วย Intl.Segmenter + BM25) → ส่งเฉพาะชิ้นเหล่านั้นให้ AI ตอบพร้อมอ้างเลขชิ้น
// ไม่พบชิ้นที่เกี่ยวข้อง = ตอบว่าไม่พบโดยไม่เรียก AI | ไม่ส่งข้อมูลผู้ใช้เข้า prompt (มีแค่บทบาทและคำถาม — ตัวเลขยาว/อีเมลในคำถามถูกปิดไว้)
const path = require('path');
const { callLlm, extractJson, createAiCache, getAiSettings, AiError } = require('./ai');

const KB_FILE = path.join(__dirname, '..', 'data', 'help-kb.json');
const TOP_K = 6;
const MAX_CONTEXT_CHARS = 7000;
const MIN_QUESTION = 3;
const MAX_QUESTION = 500;
const MIN_COVERAGE = 0.5;
const MIN_SCORE = 4; // อันดับ 1 ต่ำกว่านี้ = ตรงกันแค่คำทั่วไป (เช่น คำถามนอกเรื่อง) ถือว่าไม่พบ

const ROLE_LABEL = {
    super_admin: 'ผู้ดูแลระบบสูงสุด (super_admin)',
    admin_ssj: 'ผู้ดูแลระดับ สสจ. (admin_ssj)',
    admin_cup: 'ผู้ดูแลระดับ CUP/อำเภอ (admin_cup)',
    admin_hos: 'ผู้ดูแลระดับโรงพยาบาล (admin_hos)',
    admin_sso: 'ผู้ดูแลระดับ สสอ. (admin_sso)',
    user_cup: 'ผู้ใช้ระดับ CUP/อำเภอ (user_cup)',
    user_hos: 'ผู้ใช้ระดับโรงพยาบาล/รพ.สต. (user_hos)',
    user_sso: 'ผู้ใช้ระดับ สสอ. (user_sso)',
    user_ssj: 'ผู้ใช้ระดับ สสจ. (user_ssj)',
};

// คำที่พบทุกที่ ไม่ช่วยแยกหัวข้อ
const STOPWORDS = new Set([
    'ที่', 'ใน', 'และ', 'การ', 'ของ', 'ได้', 'ให้', 'เป็น', 'มี', 'ไม่', 'จะ', 'หรือ', 'แล้ว', 'กับ', 'ว่า', 'ก็', 'นี้', 'นั้น', 'ทำ', 'อย่างไร',
    'ยังไง', 'ไหม', 'มั้ย', 'คะ', 'ครับ', 'ค่ะ', 'คับ', 'จ้า', 'บ้าง', 'อะไร', 'ต้อง', 'ควร', 'ถ้า', 'เมื่อ', 'จาก', 'โดย', 'เพื่อ', 'แต่', 'ซึ่ง',
    'อยู่', 'ไป', 'มา', 'หน่อย', 'ช่วย', 'อยาก', 'ต้องการ', 'ทำไม', 'เท่าไร', 'ตรง', 'คือ', 'the', 'and', 'of', 'to', 'a', 'in',
]);

let _kb = null;
function loadKb() {
    if (!_kb) {
        const raw = require(KB_FILE);
        const docs = raw.chunks.map(c => ({ ...c, tf: termFreq(tokenize(`${c.section || ''} ${c.heading || ''} ${c.heading || ''} ${c.text}`)) }));
        const df = new Map();
        for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
        const avgLen = docs.reduce((s, d) => s + d.tf.len, 0) / Math.max(docs.length, 1);
        _kb = { docs, df, avgLen, n: docs.length };
    }
    return _kb;
}

let _seg = null;
function segmenter() {
    if (_seg === null) {
        try { _seg = new Intl.Segmenter('th', { granularity: 'word' }); } catch (e) { _seg = false; }
    }
    return _seg;
}

// คำ (ตัดคำไทย) + คู่คำติดกัน — คำไทยถูกตัดเป็นคำสั้น (ตัว|ชี้|วัด) คู่คำช่วยให้วลีตรงกันได้คะแนนมากกว่า
function tokenize(text) {
    const s = String(text || '').toLowerCase();
    const seg = segmenter();
    let words;
    if (seg) words = [...seg.segment(s)].filter(x => x.isWordLike).map(x => x.segment.trim()).filter(Boolean);
    else words = s.split(/[^\p{L}\p{N}_]+/u).filter(Boolean); // ไม่มีข้อมูลตัดคำ: ใช้ช่องว่าง/เครื่องหมาย
    const out = [];
    let prev = null;
    for (const w of words) {
        const keep = !STOPWORDS.has(w) && (w.length > 1 || /[฀-๿]/.test(w));
        if (keep) out.push(w);
        if (prev && keep) out.push(prev + '|' + w);
        prev = keep ? w : null;
    }
    return out;
}

function termFreq(tokens) {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    m.len = tokens.length;
    return m;
}

// ผู้ถามเห็นชิ้นใด — role ที่ไม่รู้จัก = เห็นเฉพาะหัวข้อที่เปิดให้ทุกคน (เท่ากับผู้ไม่เข้าสู่ระบบ)
function audienceOf(role) {
    return ROLE_LABEL[role] ? role : 'public';
}

function searchHelp(question, role, k = TOP_K) {
    const kb = loadKb();
    const aud = audienceOf(role);
    const q = [...new Set(tokenize(question))];
    if (!q.length) return [];
    const words = q.filter(t => !t.includes('|')).length;
    const k1 = 1.2, b = 0.75;
    const scored = [];
    for (const d of kb.docs) {
        if (!d.audience.includes(aud)) continue;
        let score = 0, matched = 0;
        for (const t of q) {
            const f = d.tf.get(t);
            if (!f) continue;
            if (!t.includes('|')) matched++;
            const df = kb.df.get(t) || 0;
            const idf = Math.log(1 + (kb.n - df + 0.5) / (df + 0.5));
            const w = t.includes('|') ? 1.5 : 1; // วลีตรงกันมีน้ำหนักมากกว่า
            score += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.tf.len / kb.avgLen));
        }
        if (score > 0) scored.push({ d, score, coverage: words ? matched / words : 0 });
    }
    scored.sort((x, y) => y.score - x.score || x.d.id.localeCompare(y.d.id));
    // ตัดชิ้นที่คะแนนต่ำมากเทียบกับอันดับ 1 (ตรงกันแค่คำทั่วไป) + จำกัดความยาวรวม
    const top = scored.length ? scored[0].score : 0;
    // คำถามสั้นที่ใช้คำพบบ่อย (เช่น "KHD") คะแนนต่ำแต่ตรงครบ — ผ่านเมื่อชิ้นอันดับ 1 มีคำของคำถามเกินครึ่ง
    if (!scored.length || (top < MIN_SCORE && scored[0].coverage <= MIN_COVERAGE)) return [];
    const out = [];
    let chars = 0;
    for (const s of scored) {
        if (out.length >= k || s.score < top * 0.25) break;
        if (chars + s.d.text.length > MAX_CONTEXT_CHARS && out.length) break;
        chars += s.d.text.length;
        out.push({ id: s.d.id, anchor: s.d.anchor, section: s.d.section, heading: s.d.heading, text: s.d.text, score: Math.round(s.score * 100) / 100 });
    }
    return out;
}

// ปิดข้อมูลที่อาจเป็นข้อมูลบุคคลก่อนส่งออก (เลขบัตรประชาชน/โทรศัพท์/อีเมล) — ผู้ใช้อาจพิมพ์ติดมาในคำถาม
function maskQuestion(q) {
    return String(q)
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[อีเมล]')
        .replace(/\d[\d -]{7,}\d/g, '[ตัวเลข]');
}

const HELP_SYSTEM_PROMPT = [
    'คุณเป็นผู้ช่วยตอบคำถามการใช้งาน "ระบบบันทึกผลงาน KPI ด้านสุขภาพ สสจ.นครราชสีมา" โดยใช้เนื้อหาคู่มือที่ให้มาเท่านั้น',
    'กติกา:',
    '- ตอบจากข้อความคู่มือ [1] [2] … ที่ให้มาเท่านั้น ห้ามเดาเมนู ปุ่ม หรือขั้นตอนที่คู่มือไม่ได้เขียนไว้',
    '- ถ้าคู่มือที่ให้มาไม่มีคำตอบ ให้ตอบ found = false และบอกว่าไม่พบในคู่มือ แนะนำให้สอบถามผู้ดูแลระบบหรือโพสต์ที่กระดานข้อเสนอแนะ',
    '- ตอบตามสิทธิ์ของผู้ถามที่ระบุ ถ้าขั้นตอนต้องใช้สิทธิ์ที่ผู้ถามไม่มี ให้บอกว่าต้องให้ผู้ดูแลระบบดำเนินการ',
    '- ภาษาไทยสุภาพ กระชับ ข้อความล้วน ไม่ใช้ Markdown (ไม่ใช้ **, #, ตาราง) ขั้นตอนให้เขียนเป็นข้อ 1. 2. 3. บรรทัดละข้อ ไม่เกินประมาณ 150 คำ',
    '- บอกชื่อเมนู/ปุ่มในระบบตามที่คู่มือเขียน ไม่ต้องเขียนเลขหัวข้อคู่มือหรือให้ไปอ่านหัวข้อคู่มือในคำตอบ (ระบบแสดงหัวข้ออ้างอิงให้ผู้ใช้กดเองแล้ว)',
    '- ระบุเลขข้อความคู่มือที่ใช้ตอบใน sources',
    'ตอบเป็น JSON อย่างเดียว รูปแบบ {"found":true,"answer":"<คำตอบ>","sources":[1,2]}',
].join('\n');

const stripNo = (t) => String(t || '').replace(/^\d+(\.\d+)*\.?\s+/, '');

function helpPrompt(question, role, hits) {
    // ตัดเลขข้อของคู่มือ ("5. รายงานสถิติ" → "รายงานสถิติ") — มีเลขแล้ว AI เรียกเมนูว่า "เมนู 5. …" (ทดลองกับ Gemini)
    const parts = hits.map((h, i) => `[${i + 1}] หัวข้อ: ${stripNo(h.section)}${h.heading ? ' › ' + h.heading : ''}\n${h.text}`);
    return `สิทธิ์ของผู้ถาม: ${ROLE_LABEL[role] || 'ผู้ใช้งานทั่วไป'}\n\nเนื้อหาคู่มือ:\n${parts.join('\n\n')}\n\nคำถาม: ${question}`;
}

const sourceOf = (h) => ({ anchor: h.anchor, section: h.section, heading: h.heading });
// หัวข้อที่ใช้ค้น (ไม่ซ้ำ) — ให้ผู้ใช้กดไปอ่านเองได้เสมอ แม้ AI ไม่ระบุแหล่งอ้างอิง
function relatedOf(hits) {
    const seen = new Set();
    const out = [];
    for (const h of hits) {
        const key = h.anchor + '|' + (h.heading || '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(sourceOf(h));
    }
    return out;
}

function parseHelpAnswer(text, hits) {
    const j = extractJson(text);
    if (!j || typeof j !== 'object') {
        // ผู้ให้บริการบางรายไม่ตอบ JSON — ใช้ข้อความตรงๆ (ไม่มีแหล่งอ้างอิงที่ AI ระบุ)
        const plain = String(text || '').trim();
        return { found: !!plain, answer: plain.slice(0, 3000), sources: [] };
    }
    const answer = String(j.answer || '').trim().slice(0, 3000);
    const seen = new Set();
    const sources = [];
    for (const n of Array.isArray(j.sources) ? j.sources : []) {
        const i = parseInt(n, 10);
        if (!Number.isInteger(i) || i < 1 || i > hits.length || seen.has(i)) continue; // เลขนอกช่วง = AI สร้างเอง ตัดทิ้ง
        seen.add(i);
        sources.push(sourceOf(hits[i - 1]));
    }
    const found = j.found !== false && !!answer;
    // ตอบว่าไม่พบ = ไม่แสดงแหล่งอ้างอิง (พบจริงกับ Gemini: ตอบไม่พบแต่ยังส่งเลขอ้างอิงมา → หน้าจอแสดงปุ่มอ้างอิงใต้คำตอบที่ไม่พบ)
    return { found, answer, sources: found ? sources : [] };
}

const NOT_FOUND = 'ไม่พบเนื้อหาที่เกี่ยวข้องในคู่มือตามสิทธิ์การใช้งานของคุณ ลองใช้คำอื่น หรือสอบถามผู้ดูแลระบบ/โพสต์ที่กระดานข้อเสนอแนะ';
const _cache = createAiCache();

// → { found, answer, sources[], related[], cached, model }
async function askHelp({ question }, user) {
    const q = String(question || '').replace(/\s+/g, ' ').trim();
    if (q.length < MIN_QUESTION || q.length > MAX_QUESTION) throw new AiError(400, `กรุณาพิมพ์คำถาม ${MIN_QUESTION}–${MAX_QUESTION} ตัวอักษร`, 'AI_INPUT');
    // ปิดอยู่ = 503 เสมอ (รวมกรณีไม่พบ/แคช ที่ไม่ได้เรียก callLlm)
    if (!(await getAiSettings()).enabled) throw new AiError(503, 'ผู้ช่วย AI ยังไม่ได้เปิดใช้งาน (ตั้งค่าโดยผู้ดูแลระบบสูงสุด)', 'AI_DISABLED');
    const role = audienceOf(user && user.role);
    const masked = maskQuestion(q);
    const hits = searchHelp(masked, role);
    const related = relatedOf(hits);
    if (!hits.length) return { found: false, answer: NOT_FOUND, sources: [], related: [], cached: false, model: null };

    const key = role + '|' + masked.toLowerCase();
    const hit = _cache.get(key);
    if (hit) return { ...hit, cached: true };
    const out = await callLlm({ feature: 'help_ask', userId: user && user.userId, system: HELP_SYSTEM_PROMPT, prompt: helpPrompt(masked, role, hits), maxTokens: 1500 });
    const parsed = parseHelpAnswer(out.text, hits);
    const result = { ...parsed, answer: parsed.answer || NOT_FOUND, related, model: out.model || null };
    _cache.set(key, result);
    return { ...result, cached: false };
}

module.exports = {
    askHelp, searchHelp, tokenize, maskQuestion, parseHelpAnswer, helpPrompt, audienceOf, loadKb,
    HELP_SYSTEM_PROMPT, NOT_FOUND, TOP_K, MIN_SCORE, MAX_CONTEXT_CHARS, _cache,
};
