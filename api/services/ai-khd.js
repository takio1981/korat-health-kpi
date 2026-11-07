// ผู้ช่วย AI ระยะที่ 3: เสนอการจับคู่ค่าข้อความจาก KHD (หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์) กับรายการในระบบ (7 พ.ย. 2569)
// AI เสนอเท่านั้น — ระบบตรวจว่ารายการที่เสนออยู่ในตัวเลือกจริง (ไม่อยู่ = ตัดทิ้ง) หน้าจอเติมลงช่องเลือก ผู้ดูแลกด "จับคู่" เอง
// (บันทึกผ่าน PUT /khd-mappings เดิม) — ข้อมูลที่ส่ง: ข้อความใน KHD + ชื่อรายการของระบบ (ไม่มีข้อมูลบุคคล/หน่วยบริการ)
const { listKhdMappings } = require('./khd');
const { callLlm, extractJson, AiError } = require('./ai');

const BATCH = 40;        // รายการต่อการเรียก 1 ครั้ง
const MAX_ITEMS = 120;   // ต่อคำขอ (≤ 3 ครั้ง)
const KIND_TEXT = {
    dept: { what: 'หน่วยงาน/กลุ่มงาน', hint: 'ค่าใน KHD มักเป็นรหัสหน่วยงานย่อ (เช่น NCD, ยสต.) อาจมี "ชื่อใน KHD" ประกอบ — รายการในระบบมีชื่อและรหัส (ในวงเล็บ)' },
    main: { what: 'หมวดหมู่หลักของตัวชี้วัด', hint: 'ชื่ออาจสะกด/เว้นวรรค/ใช้คำย่อต่างกัน — รายการในระบบมียุทธศาสตร์ที่สังกัดในวงเล็บ' },
    yut: { what: 'ยุทธศาสตร์', hint: 'ข้อความใน KHD มักมีจำนวนท้ายชื่อ เช่น "(37)" หรือชื่อชุดปีต่างกัน — ให้ดูความหมายของชื่อ' },
};

function systemPrompt(kind) {
    const k = KIND_TEXT[kind];
    return [
        `คุณช่วยจับคู่ "${k.what}" ที่เป็นข้อความจากฐานข้อมูลกลาง KHD กับรายการที่มีอยู่ในระบบ KHUPS KPI ของสำนักงานสาธารณสุขจังหวัด`,
        k.hint,
        '- เลือกได้เฉพาะ id จากรายการในระบบที่ให้มาเท่านั้น ห้ามสร้าง id ใหม่',
        '- ถ้ามีรายการที่ชื่อตรงกับค่าใน KHD ทุกตัวอักษร (ไม่นับช่องว่าง) ให้เลือกรายการนั้นก่อนเสมอ แม้มีรายการอื่นที่ชื่อคล้ายกันหรือต่างกันแค่ข้อความในวงเล็บท้ายชื่อ',
        '- ถ้าไม่มีรายการใดที่หมายถึงสิ่งเดียวกันอย่างสมเหตุสมผล ให้ id เป็น null (ดีกว่าเดา)',
        '- confidence = ความมั่นใจ 0–100 (ชื่อ/รหัสตรงกันชัดเจน ≥ 90, ความหมายใกล้เคียงแต่ไม่แน่ใจ ≤ 60)',
        '- reason = เหตุผลภาษาไทยสั้นๆ ไม่เกิน 1 ประโยค',
        'ตอบเป็น JSON อย่างเดียว รูปแบบ {"suggestions":[{"i":<เลขลำดับของค่าใน KHD>,"id":<id หรือ null>,"confidence":<0-100>,"reason":"<เหตุผล>"}]} ครบทุกค่าที่ให้มา',
    ].join('\n');
}

function userPrompt(batch, options) {
    return [
        'ค่าใน KHD ที่ต้องจับคู่ (เลขลำดับ: ค่า):',
        ...batch.map((it, i) => `${i}: ${it.khd_value}${it.khd_label ? ` (ชื่อใน KHD: ${it.khd_label})` : ''}`),
        '',
        'รายการในระบบ (id: ชื่อ):',
        ...options.map(o => `${o.id}: ${o.name}${o.code ? ` (${o.code})` : ''}`),
    ].join('\n');
}

// ตรวจคำตอบของ AI: id ต้องอยู่ในตัวเลือก, confidence 0–100, เลขลำดับต้องอยู่ในชุด — คืน Map ลำดับ → ข้อเสนอ
function parseSuggestions(text, batchSize, optionById) {
    const j = extractJson(text);
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.suggestions) ? j.suggestions : []);
    const out = new Map();
    for (const s of list) {
        const i = Number(s && s.i);
        if (!Number.isInteger(i) || i < 0 || i >= batchSize || out.has(i)) continue;
        const id = s.id == null || s.id === '' ? null : Number(s.id);
        const opt = id != null ? optionById.get(id) : null;
        if (id != null && !opt) continue;   // id นอกตัวเลือก = ตัดทิ้ง (ไม่ให้ AI สร้างรายการเอง)
        let conf = Math.round(Number(s.confidence));
        if (!Number.isFinite(conf)) conf = 0;
        conf = Math.max(0, Math.min(100, conf));
        out.set(i, { local_id: opt ? Number(opt.id) : null, local_name: opt ? opt.name : null, confidence: opt ? conf : 0, reason: String(s.reason || '').trim().slice(0, 300) });
    }
    return out;
}

// input: { kind, khd_values? } — ไม่ส่ง khd_values = ทุกค่าที่ยังไม่จับคู่ (สถานะ unmatched) ตามลำดับเดียวกับหน้าต่างจับคู่
async function suggestKhdMappings(input, userId) {
    const kind = String(input.kind || '');
    if (!KIND_TEXT[kind]) throw new AiError(400, 'kind ต้องเป็น dept, main หรือ yut', 'AI_INPUT');
    const data = await listKhdMappings(kind);
    const wanted = Array.isArray(input.khd_values) ? new Set(input.khd_values.map(v => String(v))) : null;
    const targets = data.items.filter(it => (wanted ? wanted.has(it.khd_value) : it.resolved && it.resolved.status === 'unmatched'));
    if (!targets.length) return { kind, suggestions: [], total: 0, truncated: false, calls: 0 };
    if (!data.options.length) throw new AiError(422, 'ยังไม่มีรายการในระบบให้จับคู่ — สร้างรายการในระบบก่อน', 'AI_NO_OPTIONS');
    const picked = targets.slice(0, MAX_ITEMS);
    const optionById = new Map(data.options.map(o => [Number(o.id), o]));
    const suggestions = [];
    let calls = 0, model = null;
    for (let s = 0; s < picked.length; s += BATCH) {
        const batch = picked.slice(s, s + BATCH);
        const out = await callLlm({ feature: 'khd_mapping', userId, system: systemPrompt(kind), prompt: userPrompt(batch, data.options), maxTokens: 4000 });
        calls++; model = out.model;
        const parsed = parseSuggestions(out.text, batch.length, optionById);
        batch.forEach((it, i) => {
            const p = parsed.get(i);
            suggestions.push({ khd_value: it.khd_value, ...(p || { local_id: null, local_name: null, confidence: 0, reason: '' }) });
        });
    }
    return { kind, suggestions, total: targets.length, truncated: targets.length > picked.length, calls, model };
}

module.exports = { suggestKhdMappings, systemPrompt, userPrompt, parseSuggestions, BATCH, MAX_ITEMS };
