// ผู้ช่วย AI ระยะที่ 5 (8 พ.ย. 2569): อธิบายค่าที่อาจผิดปกติ — AI อธิบาย/เสนอสิ่งที่ควรตรวจเท่านั้น ไม่แก้ข้อมูล ไม่ห้ามบันทึก
//   explainDataQuality() — สรุปผลตรวจคุณภาพข้อมูลทั้งปีงบ (services/data-quality.js) สำหรับผู้ดูแลระบบ
//   explainAnomalies()   — อธิบายคำเตือนค่าผิดปกติของช่องที่กำลังแก้ในหน้าบันทึกผลงาน (ยังไม่บันทึก)
// ข้อมูลที่ส่งเข้า prompt: ชื่อ/คุณสมบัติตัวชี้วัด + ตัวเลข — ไม่มีชื่อผู้ใช้ รหัส/ชื่อหน่วยบริการ
// คำเตือนที่ AI อธิบายคำนวณใหม่ที่ server ด้วย detectAnomaly() เสมอ (ไม่ใช้ข้อความจาก client — กันข้อความแทรกคำสั่ง)
const crypto = require('crypto');
const db = require('../db');
const { detectAnomaly, toNumber } = require('../kpi-anomaly');
const { MONTHS, KIND_LABEL, KIND_ORDER, anomalyHints, withBasisHint } = require('./data-quality');
const { ROLE_SCOPE_OWN_DEPT } = require('../core/access');
const { callLlm, extractJson, createAiCache, getAiSettings, AiError } = require('./ai');

const MAX_ANOMALY_ITEMS = 20;
const MAX_DQ_EXAMPLES = 30;
const EXAMPLES_PER_INDICATOR = 3;
const DQ_TOP_INDICATORS = 15;
const _cache = createAiCache();

// สาเหตุที่เข้าได้กับแต่ละประเภท — AI เลือกจากรายการของประเภทที่พบเท่านั้น (ทดลองจริง: ให้รายการรวมแล้ว AI คัดลอกทั้งหมด/เลือกสาเหตุที่ข้อมูลไม่สนับสนุน)
const KIND_CAUSES = {
    negative: ['ใส่เครื่องหมายลบโดยไม่ตั้งใจ', 'บันทึกผลต่าง/การปรับลดแทนผลงาน'],
    high: ['พิมพ์เกินหลัก', 'บันทึกยอดสะสมแทนยอดของเดือน (เฉพาะเมื่อมีข้อสังเกตว่าเท่ากับผลรวมของเดือนก่อนหน้า)', 'บันทึกผิดเดือนหรือรวมหลายเดือน', 'เหตุการณ์จริง เช่น การรณรงค์ การระบาด'],
    low: ['พิมพ์ตกหลัก', 'บันทึกเพียงบางส่วนของเดือน/ยังบันทึกไม่ครบ', 'นิยามหรือวิธีนับเปลี่ยนจากปีงบที่แล้ว (เมื่อเทียบกับปีงบที่แล้ว)', 'ผลการดำเนินงานลดลงจริง'],
    text: ['บันทึกคำอธิบาย/สถานะแทนตัวเลข (เมื่อข้อความไม่มีตัวเลข)', 'พิมพ์หน่วยหรือสัญลักษณ์ปนกับตัวเลข (เมื่อข้อความมีตัวเลข)'],
    pct_over: ['บันทึกจำนวนนับแทนร้อยละ', 'พิมพ์เกินหลัก'],
};
const COND_TEXT = { GTE: '≥', GT: '>', LTE: '≤', LT: '<', EQ: '=' };
const condOf = (c) => COND_TEXT[String(c || '').toUpperCase()] || '≥';
const MONTH_KEYS = new Set(MONTHS.map(m => m.key));
const monthLabel = (k) => MONTHS.find(m => m.key === k)?.label || k;
// ค่าในตารางที่ส่งเข้า prompt: ตัวเลขเท่านั้น (ข้อความ = "ข้อความ", ว่าง = null) — กันข้อความแทรกคำสั่ง
const promptValue = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = toNumber(v);
    return n === null ? 'ข้อความ' : n;
};

function indicatorTraits(ind) {
    return {
        เงื่อนไขเป้าหมาย: condOf(ind.target_condition),
        นับสะสม: Number(ind.is_cumulative) === 1,
        มีสูตรคำนวณผลงาน: !!(ind.result_formula && String(ind.result_formula).trim()),
        เป้าหมายรายเดือน: !!ind.target_monthly,
    };
}

async function ensureEnabled() {
    const s = await getAiSettings();
    if (!s.enabled) throw new AiError(503, 'ผู้ช่วย AI ยังไม่เปิดใช้งาน — ติดต่อผู้ดูแลระบบ', 'AI_DISABLED');
}
const cacheKey = (feature, input) => feature + ':' + crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

// ---------------------------------------------------------------------------------------------
// 1) สรุปผลตรวจคุณภาพข้อมูลทั้งปีงบ (ผู้ดูแลระบบ)
// ---------------------------------------------------------------------------------------------
function buildDqInput(scan) {
    const inds = scan._indicators || new Map();
    const top = (scan.by_indicator || []).slice(0, DQ_TOP_INDICATORS).map(e => ({
        ตัวชี้วัด: e.name,
        หน่วยงาน: e.dept_name || null,
        จำนวนช่อง: e.count,
        จำนวนหน่วยบริการ: e.hospitals,
        ประเภท: Object.fromEntries(Object.entries(e.kinds).map(([k, n]) => [KIND_LABEL[k], n])),
        ...indicatorTraits(inds.get(e.indicator_id) || {}),
    }));
    // ตัวอย่าง: ไม่เกิน 3 ช่องต่อตัวชี้วัด เรียงตามลำดับประเภท (ไม่มีรหัส/ชื่อหน่วยบริการ)
    const perInd = new Map();
    const examples = [];
    for (const it of scan.issues || []) {
        if (examples.length >= MAX_DQ_EXAMPLES) break;
        const n = perInd.get(it.indicator_id) || 0;
        if (n >= EXAMPLES_PER_INDICATOR) continue;
        perInd.set(it.indicator_id, n + 1);
        examples.push({ ตัวชี้วัด: it.indicator_name, เดือน: it.month_name, ค่า: it.kind === 'text' ? 'ข้อความ' : it.value, ประเภท: KIND_LABEL[it.kind], กฎ: it.message.replace(/ — .*$/, ''), ...(it.hints && it.hints.length ? { ข้อสังเกตที่ระบบคำนวณ: it.hints } : {}) });
    }
    return {
        ปีงบประมาณ: scan.year_bh,
        ข้อมูลที่ตรวจ: { ตัวชี้วัด: scan.scanned.indicators, คู่ตัวชี้วัดหน่วยบริการ: scan.scanned.pairs, ช่องผลงาน: scan.scanned.cells },
        จำนวนที่พบ: Object.fromEntries(KIND_ORDER.map(k => [KIND_LABEL[k], scan.counts[k] || 0])),
        รวม: scan.total,
        ตัวชี้วัดที่พบมาก: top,
        สาเหตุที่เข้าได้ตามประเภท: Object.fromEntries(KIND_ORDER.filter(k => scan.counts[k]).map(k => [KIND_LABEL[k], KIND_CAUSES[k]])),
        ตัวอย่าง: examples,
    };
}

const DQ_SYSTEM_PROMPT = [
    'คุณเป็นผู้ตรวจคุณภาพข้อมูลของระบบบันทึกผลงานตัวชี้วัดด้านสุขภาพ สำนักงานสาธารณสุขจังหวัดนครราชสีมา เขียนสรุปผลการตรวจให้ผู้ดูแลระบบอ่าน',
    'ข้อมูลที่ได้รับเป็นผลของตัวตรวจแบบกฎ (ไม่ใช่ข้อผิดพลาดที่ยืนยันแล้ว): ค่าติดลบ | สูงผิดปกติ/ต่ำผิดปกติ = ต่างจากเดือนอื่นของหน่วยบริการเดียวกัน (หรือปีงบที่แล้ว/เป้าหมาย) ≥ 5 เท่า |',
    'เป็นข้อความในตัวชี้วัดตัวเลข | ร้อยละเกิน 100 = ตัวชี้วัดร้อยละที่เป้าหมายไม่เกิน 100 แต่ผลงานเกิน 100',
    'กติกา: ใช้เฉพาะตัวเลขและชื่อที่ให้มา ห้ามสร้างตัวเลขเพิ่ม ห้ามสรุปว่าค่าใดผิดแน่นอน ให้ใช้คำว่า "อาจ" และบอกสิ่งที่ควรตรวจสอบ',
    'หัวข้อสาเหตุ: เลือกจาก "สาเหตุที่เข้าได้ตามประเภท" ของประเภทที่พบเท่านั้น ไม่เกิน 3 ข้อ ให้สอดคล้องกับ "ข้อสังเกตที่ระบบคำนวณ" ของตัวอย่าง และบอกว่าเห็นจากข้อมูลส่วนใด — ห้ามคัดลอกทุกข้อ',
    '"ข้อสังเกตที่ระบบคำนวณ" เป็นข้อเท็จจริงที่ระบบคำนวณแล้ว ใช้เป็นหลักฐานลำดับแรก และอ้างถึงได้เฉพาะเมื่อตัวอย่างนั้นมีข้อสังเกตจริง ห้ามสร้างข้อสังเกตเอง',
    'ระบุชื่อตัวชี้วัดตามข้อมูลทุกตัวอักษร',
    'รูปแบบ: ภาษาไทยทางการ ข้อความล้วน ไม่ใช้ Markdown ไม่ใช้ตาราง ไม่ใช้ตัวหนา ความยาวไม่เกิน 300 คำ แบ่งเป็นหัวข้อตามลำดับนี้ (บรรทัดหัวข้อขึ้นต้นด้วย ■):',
    '■ ภาพรวม (1–2 ประโยค) ■ รูปแบบที่พบ ■ สาเหตุที่เป็นไปได้ ■ สิ่งที่ควรตรวจสอบก่อน (เรียงตามความสำคัญ) ■ ข้อเสนอแนะเพื่อป้องกัน (2–3 ข้อ)',
    'รายการย่อยขึ้นต้นด้วย "• " บรรทัดละ 1 ประเด็น',
].join('\n');

const dqPrompt = (input) => 'ผลการตรวจคุณภาพข้อมูล (JSON):\n' + JSON.stringify(input) + '\n\nเขียนสรุปตามรูปแบบที่กำหนด';

async function explainDataQuality(scan, userId, { refresh = false } = {}) {
    await ensureEnabled();
    if (!scan.total) return { summary: '', no_issues: true, year_bh: scan.year_bh };
    const input = buildDqInput(scan);
    const key = cacheKey('dq', input);
    if (!refresh) {
        const hit = _cache.get(key);
        if (hit) return { ...hit, cached: true };
    }
    const out = await callLlm({ feature: 'data_quality', userId, system: DQ_SYSTEM_PROMPT, prompt: dqPrompt(input), maxTokens: 2500 });
    const result = { summary: out.text, model: out.model, generated_at: new Date().toISOString(), year_bh: scan.year_bh, total: scan.total };
    _cache.set(key, result);
    return { ...result, cached: false };
}

// ---------------------------------------------------------------------------------------------
// 2) อธิบายคำเตือนของช่องที่กำลังแก้ (หน้าบันทึกผลงาน — ทุก role ที่บันทึกผลงานได้)
// ---------------------------------------------------------------------------------------------
// item จาก client: { indicator_id, month, months: {oct…sep}, target, prev?: {oct…sep} } — value = months[month]
function normalizeAnomalyItems(items) {
    if (!Array.isArray(items) || items.length === 0) throw new AiError(400, 'ไม่มีรายการค่าที่อาจผิดปกติให้อธิบาย', 'AI_INPUT');
    const out = [];
    items.slice(0, MAX_ANOMALY_ITEMS).forEach((raw, src) => {
        const id = Number(raw && raw.indicator_id);
        const month = String(raw && raw.month || '');
        if (!Number.isInteger(id) || id <= 0 || !MONTH_KEYS.has(month)) return;
        const pick = (obj) => {
            const o = {};
            for (const m of MONTHS) {
                const v = obj && obj[m.key];
                o[m.key] = v === undefined || v === null ? '' : String(v).slice(0, 100);
            }
            return o;
        };
        const months = pick(raw.months || {});
        const prev = raw.prev && typeof raw.prev === 'object' ? pick(raw.prev) : null;
        const target = raw.target === undefined || raw.target === null ? '' : String(raw.target).slice(0, 100);
        out.push({ src, indicator_id: id, month, months, prev, target }); // src = ลำดับในคำขอเดิม (หน้าจอใช้จับคู่คำอธิบาย)
    });
    return out;
}

const ANOMALY_SYSTEM_PROMPT = [
    'คุณช่วยผู้บันทึกผลงานตัวชี้วัดด้านสุขภาพของสำนักงานสาธารณสุขจังหวัดตรวจทานค่าที่ระบบเตือนว่า "อาจผิดปกติ" ก่อนกดบันทึก',
    'ระบบเตือนเมื่อค่าต่างจากเดือนอื่นของแถวเดียวกัน (หรือปีงบที่แล้ว/เป้าหมาย) ≥ 5 เท่า หรือติดลบ — เป็นการเตือนเท่านั้น ค่าอาจถูกต้องก็ได้',
    'สำหรับแต่ละรายการ ให้อธิบายสั้นๆ ว่าทำไมค่านี้อาจผิดปกติ สาเหตุที่เป็นไปได้ และสิ่งที่ผู้บันทึกควรตรวจ โดยพิจารณาจากชื่อและคุณสมบัติของตัวชี้วัด เช่น',
    'พิมพ์เกิน/ตกหลัก (ระบุค่าที่น่าจะตั้งใจพิมพ์ได้ถ้าเห็นชัด เช่น 850 อาจเป็น 85), บันทึกยอดสะสมแทนยอดรายเดือน (หรือกลับกัน), บันทึกจำนวนนับแทนร้อยละ, บันทึกผิดเดือน, หรือเป็นเหตุการณ์จริง',
    '"ข้อสังเกตที่ระบบคำนวณ" เป็นข้อเท็จจริงทางตัวเลขที่ระบบคำนวณแล้ว (เช่น ค่าเท่ากับผลรวมของเดือนก่อนหน้า = อาจเป็นยอดสะสม) ให้ใช้เป็นหลักฐานลำดับแรก ห้ามขัดแย้งกับข้อสังเกตนี้',
    'ห้ามเดาค่าที่ตั้งใจพิมพ์ถ้าไม่มีความสัมพันธ์ทางตัวเลขที่ชัดเจน (เช่น ห้ามบอกว่า 55 อาจตั้งใจเป็น 5 เมื่อเดือนอื่นเป็น 10–13)',
    'กติกา: ใช้เฉพาะตัวเลขที่ให้มา ห้ามยืนยันว่าค่าผิดแน่นอน ใช้คำว่า "อาจ" ภาษาไทยสุภาพ ไม่เกิน 2 ประโยคต่อรายการ ข้อความล้วน ไม่ใช้ Markdown',
    'ตอบเป็น JSON อย่างเดียว รูปแบบ {"explanations":[{"i":<เลขลำดับรายการ>,"text":"<คำอธิบาย>"}]} ครบทุกรายการ',
].join('\n');

function anomalyPrompt(rows) {
    return 'รายการที่ระบบเตือน (JSON):\n' + JSON.stringify(rows.map((r, i) => ({
        i,
        ตัวชี้วัด: r.name,
        ...r.traits,
        เป้าหมาย: promptValue(r.target),
        เดือนที่เตือน: monthLabel(r.month),
        ค่าที่บันทึก: promptValue(r.months[r.month]),
        คำเตือนของระบบ: r.message,
        ...(r.hints.length ? { ข้อสังเกตที่ระบบคำนวณ: r.hints } : {}),
        ผลงานรายเดือนของปีงบนี้: Object.fromEntries(MONTHS.map(m => [m.label, promptValue(r.months[m.key])])),
        ...(r.prev ? { ผลงานรายเดือนของปีงบที่แล้ว: Object.fromEntries(MONTHS.map(m => [m.label, promptValue(r.prev[m.key])])) } : {}),
    }))) + '\n\nอธิบายทุกรายการตามรูปแบบที่กำหนด';
}

function parseExplanations(text, n) {
    const j = extractJson(text);
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.explanations) ? j.explanations : []);
    const out = new Map();
    for (const e of list) {
        const i = Number(e && e.i);
        if (!Number.isInteger(i) || i < 0 || i >= n || out.has(i)) continue;
        const t = String(e.text || '').replace(/\*\*/g, '').trim().slice(0, 500);
        if (t) out.set(i, t);
    }
    return out;
}

async function explainAnomalies(items, user, { refresh = false } = {}) {
    await ensureEnabled();
    const norm = normalizeAnomalyItems(items);
    const ids = [...new Set(norm.map(r => r.indicator_id))];
    let rows = [];
    if (ids.length) {
        const params = [...ids];
        let deptSql = '';
        if (ROLE_SCOPE_OWN_DEPT.includes(user.role) && user.deptId != null) { deptSql = ' AND dept_id = ?'; params.push(user.deptId); }
        const [r] = await db.query(`SELECT id, kpi_indicators_name AS name, target_condition, is_cumulative, result_formula, target_monthly
            FROM kpi_indicators WHERE is_active = 1 AND id IN (${ids.map(() => '?').join(',')})${deptSql}`, params);
        rows = r;
    }
    const indById = new Map(rows.map(r => [Number(r.id), r]));
    // คำนวณคำเตือนใหม่ที่ server (ข้อมูลอ้างอิงเดียวกับหน้าจอ) — ช่องที่ไม่เข้าเกณฑ์/ตัวชี้วัดนอกสิทธิ์ = ไม่อธิบาย
    const keys = MONTHS.map(m => m.key);
    const accepted = [];
    norm.forEach((r) => {
        const ind = indById.get(r.indicator_id);
        if (!ind) return;
        const a = detectAnomaly(r.months[r.month], {
            others: keys.filter(k => k !== r.month).map(k => r.months[k]),
            prevSame: r.prev ? r.prev[r.month] : null,
            prevAll: r.prev ? keys.map(k => r.prev[k]) : [],
            target: r.target,
        });
        if (!a) return;
        accepted.push({ ...r, name: ind.name, traits: indicatorTraits(ind), message: a.message, hints: withBasisHint(anomalyHints(r.months[r.month], r.months, r.month, { pct: /ร้อยละ/.test(String(ind.name || '')) }), a.basis) });
    });
    const skipped = norm.length - accepted.length + Math.max(0, (Array.isArray(items) ? items.length : 0) - norm.length);
    if (!accepted.length) throw new AiError(422, 'ไม่พบรายการที่เข้าเกณฑ์คำเตือนค่าผิดปกติให้อธิบาย', 'AI_NOTHING');

    const prompt = anomalyPrompt(accepted);
    const key = cacheKey('anomaly', prompt);
    let parsed, model, cached = false;
    const hit = refresh ? null : _cache.get(key);
    if (hit) { parsed = new Map(hit.parsed); model = hit.model; cached = true; }
    else {
        const out = await callLlm({ feature: 'anomaly_explain', userId: user.userId, system: ANOMALY_SYSTEM_PROMPT, prompt, maxTokens: 2500 });
        parsed = parseExplanations(out.text, accepted.length);
        model = out.model;
        if (!parsed.size) throw new AiError(502, 'AI ตอบในรูปแบบที่ระบบอ่านไม่ได้ — ลองใหม่อีกครั้ง', 'AI_BAD_RESPONSE');
        _cache.set(key, { parsed: [...parsed], model });
    }
    return {
        explanations: accepted.map((r, i) => ({ index: r.src, indicator_id: r.indicator_id, month: r.month, message: r.message, hints: r.hints, text: parsed.get(i) || '' })),
        skipped,
        model,
        cached,
    };
}

module.exports = {
    KIND_CAUSES, explainDataQuality, explainAnomalies, buildDqInput, normalizeAnomalyItems, anomalyPrompt, parseExplanations,
    DQ_SYSTEM_PROMPT, ANOMALY_SYSTEM_PROMPT, MAX_ANOMALY_ITEMS, MAX_DQ_EXAMPLES, _cache,
};
