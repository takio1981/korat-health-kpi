// ระบบเตือนล่วงหน้า ระยะที่ 4 (ข้อเสนอแนวคิดฉบับ AI — 8 พ.ย. 2569): ให้ AI เรียบเรียงคำอธิบายรายการตัวชี้วัดเสี่ยงเป็นภาษาไทย
// ระดับความเสี่ยงยังคำนวณด้วยแบบจำลองเชิงสถิติที่ตรวจสอบได้ (kpi-forecast.js) — AI อธิบาย/เสนอแนะเท่านั้น ไม่เปลี่ยนระดับ
// ข้อมูลที่ส่ง: จำนวนตามระดับ ชื่อตัวชี้วัด/หน่วยงาน/อำเภอ (ระดับกลุ่ม) และร้อยละที่คาด — ไม่มีรหัส/ชื่อหน่วยบริการรายแถว ไม่มีข้อมูลบุคคล
const crypto = require('crypto');
const { summarizeByIndicator, summarizeByDistrict } = require('./forecast');
const { callLlm, createAiCache, getAiSettings, AiError } = require('./ai');

const _cache = createAiCache();
const TOP_IND = 10;
const TOP_DIST = 8;
const EXAMPLES = 15;
const CONF = { high: 'สูง', medium: 'ปานกลาง', low: 'ต่ำ', actual: 'ผลจริง' };
const STATUS_TH = { high: 'เสี่ยงสูง', watch: 'เฝ้าระวัง', no_report: 'ขาดการรายงาน' };

/** กรองรายการตามตัวกรองของหน้าจอ (ความหมายเดียวกับ filterRiskItems ฝั่ง frontend — ไม่รวมคำค้น) */
function applyRiskFilters(items, f = {}) {
    return (items || []).filter(it =>
        (!f.status || it.status === f.status)
        && (!f.yut || String(it.yut_id ?? '0') === String(f.yut))
        && (!f.dept || String(it.dept_id ?? '') === String(f.dept))
        && (!f.zone || String(it.zone ?? '') === String(f.zone))
        && (!f.district || String(it.distid ?? '') === String(f.district)));
}

function buildForecastInput(fc, items, filters = {}) {
    const count = (s) => items.filter(i => i.status === s).length;
    const byMethodConf = {};
    for (const it of items) if (it.confidence) byMethodConf[CONF[it.confidence]] = (byMethodConf[CONF[it.confidence]] || 0) + 1;
    // ตัวอย่างคู่เสี่ยงสูงที่ห่างเป้ามากที่สุด — ระดับอำเภอ ไม่ระบุหน่วยบริการ
    const examples = items.filter(i => i.status === 'high').slice(0, EXAMPLES).map(i => ({
        ตัวชี้วัด: i.indicator_name, อำเภอ: i.distname || null, ร้อยละที่คาดว่าจะได้เทียบเป้าหมาย: i.pct, ความเชื่อมั่น: CONF[i.confidence] || null, ผลงานล่าสุดเดือน: i.last_month,
    }));
    return {
        ปีงบประมาณ: fc.year_bh,
        ใช้ข้อมูลถึงเดือน: fc.through_label,
        เกณฑ์: `เฝ้าระวัง = คาดว่าต่ำกว่าเป้าหมายไม่เกิน ${fc.watch_pct}%, เสี่ยงสูง = ต่ำกว่าเกินนั้น, ขาดการรายงาน = ว่างล่าสุดตั้งแต่ 2 เดือน`,
        ตัวกรอง: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== '')),
        ทั้งขอบเขต: { คู่ทั้งหมด: fc.pairs, คาดการณ์ได้: fc.forecastable, ปกติ: fc.counts.normal, ข้อมูลไม่พอ: fc.counts.insufficient, ร้อยละที่มีแนวโน้มไม่บรรลุ: fc.risk_pct },
        ตามตัวกรอง: { เสี่ยงสูง: count('high'), เฝ้าระวัง: count('watch'), ขาดการรายงาน: count('no_report'), ความเชื่อมั่นของการคาดการณ์: byMethodConf },
        ตัวชี้วัดที่มีคู่เสี่ยงมากที่สุด: summarizeByIndicator(items, TOP_IND).map(x => ({ ชื่อ: x.name, หน่วยงาน: x.dept_name, เสี่ยงสูง: x.high, เฝ้าระวัง: x.watch, ขาดการรายงาน: x.no_report })),
        อำเภอที่มีคู่เสี่ยงมากที่สุด: summarizeByDistrict(items, TOP_DIST).map(x => ({ อำเภอ: x.name, เสี่ยงสูง: x.high, เฝ้าระวัง: x.watch, ขาดการรายงาน: x.no_report })),
        ตัวอย่างคู่เสี่ยงสูง: examples,
    };
}

const FORECAST_SYSTEM_PROMPT = [
    'คุณเป็นนักวิเคราะห์ของสำนักงานสาธารณสุขจังหวัดนครราชสีมา เขียนคำอธิบายผลระบบเตือนล่วงหน้าตัวชี้วัดด้านสุขภาพให้ผู้บริหารและผู้รับผิดชอบตัวชี้วัดอ่าน',
    'ข้อมูลเป็นผลการคาดการณ์ด้วยวิธีทางสถิติ (แนวโน้มเชิงเส้น/อัตราเฉลี่ยต่อเดือน) ของผลงาน ณ สิ้นปีงบ "คู่" = ตัวชี้วัด 1 ตัว × หน่วยบริการ 1 แห่ง',
    'กติกา: ใช้เฉพาะตัวเลขและชื่อที่ให้มา ห้ามสร้างตัวเลขเพิ่ม | เป็นการคาดการณ์ ให้ใช้คำว่า "มีแนวโน้ม" หรือ "คาดว่า" ไม่ใช่ผลที่เกิดแล้ว',
    'ห้ามระบุสาเหตุที่ข้อมูลไม่ได้บอก ให้เขียนว่า "ควรตรวจสอบสาเหตุร่วมกับหน่วยงาน/พื้นที่" | ถ้าความเชื่อมั่นส่วนใหญ่ต่ำ ให้บอกว่าข้อมูลยังน้อยและควรติดตามต่อ',
    'ระบุชื่อตัวชี้วัด/อำเภอ/หน่วยงานตามข้อมูลทุกตัวอักษร | การขาดการรายงานไม่ใช่ผลงานต่ำ ให้แยกอธิบาย',
    'จำนวนทุกค่าเป็นจำนวน "คู่" (ตัวชี้วัด × หน่วยบริการ) ให้เขียนว่า "N คู่" ห้ามเรียกเป็นจำนวนหน่วยงานหรือหน่วยบริการ (ทดลองจริง: แบบจำลองเขียน "หน่วยงาน 411 รายการ")',
    'ร้อยละที่มีแนวโน้มไม่บรรลุ คิดจากคู่ที่คาดการณ์ได้ ให้ระบุเช่นนั้น',
    'รูปแบบ: ภาษาไทยทางการ ข้อความล้วน ไม่ใช้ Markdown ไม่ใช้ตาราง ไม่ใช้ตัวหนา ความยาวไม่เกิน 250 คำ แบ่งเป็นหัวข้อตามลำดับนี้ (บรรทัดหัวข้อขึ้นต้นด้วย ■):',
    '■ ภาพรวม (1–2 ประโยค) ■ ตัวชี้วัดที่ควรเร่งรัด ■ พื้นที่ที่ควรติดตาม ■ การรายงานข้อมูล ■ ข้อเสนอแนะ (2–3 ข้อ)',
    'รายการย่อยขึ้นต้นด้วย "• " บรรทัดละ 1 ประเด็น — หัวข้อที่ไม่มีข้อมูลให้เขียนสั้นๆ ว่าไม่พบ',
].join('\n');
const forecastPrompt = (input) => 'ผลระบบเตือนล่วงหน้า (JSON):\n' + JSON.stringify(input) + '\n\nเขียนคำอธิบายตามรูปแบบที่กำหนด';

/** สรุป/อธิบายรายการเสี่ยง — ไม่มีรายการเสี่ยงตามตัวกรอง = ไม่เรียก AI */
async function explainForecast(fc, { userId = null, filters = {}, refresh = false, feature = 'forecast_explain' } = {}) {
    const s = await getAiSettings();
    if (!s.enabled) throw new AiError(503, 'ผู้ช่วย AI ยังไม่เปิดใช้งาน — ติดต่อผู้ดูแลระบบ', 'AI_DISABLED');
    const items = applyRiskFilters(fc.items, filters);
    if (!items.length) return { summary: '', no_risk: true, year_bh: fc.year_bh };
    const input = buildForecastInput(fc, items, filters);
    const key = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (!refresh) {
        const hit = _cache.get(key);
        if (hit) return { ...hit, cached: true };
    }
    const out = await callLlm({ feature, userId, system: FORECAST_SYSTEM_PROMPT, prompt: forecastPrompt(input), maxTokens: 2500 });
    const result = { summary: out.text, model: out.model, generated_at: new Date().toISOString(), year_bh: fc.year_bh, through_label: fc.through_label };
    _cache.set(key, result);
    return { ...result, cached: false };
}

/** ฟังก์ชันสรุปสำหรับสรุปรายสัปดาห์ (jobs/forecast-digest.js) — คืนข้อความ หรือ throw (ผู้เรียกส่งต่อโดยไม่มีสรุป AI) */
function forecastAiSummarizer(userId = null) {
    return async (fc) => (await explainForecast({ ...fc, items: fc.items.filter(i => i.status === 'high' || i.status === 'no_report' || i.status === 'watch') },
        { userId, feature: 'forecast_digest' })).summary;
}

module.exports = { explainForecast, forecastAiSummarizer, buildForecastInput, applyRiskFilters, FORECAST_SYSTEM_PROMPT, _cache, STATUS_TH };
