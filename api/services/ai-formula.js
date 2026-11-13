// ผู้ช่วย AI ระยะที่ 2: ช่วยเขียนสูตรคำนวณผลงาน/สูตรร้อยละจากคำอธิบายภาษาไทย (7 พ.ย. 2569)
// AI เสนอเท่านั้น — สูตรที่คืนต้องผ่าน parseFormulaInput() (ตัวตรวจเดียวกับตอนบันทึกตัวชี้วัด) ผิดให้ AI แก้ได้อีก 1 รอบ
// ผู้ใช้เห็นผลตรวจและทดลองคำนวณในหน้าจอเดิมก่อนกดบันทึกเอง (ไม่บันทึกให้)
const { parseFormulaInput, normalizeCustomVars } = require('./formula-vars');
const { callLlm, extractJson, AiError } = require('./ai');

const MAX_ATTEMPTS = 2;
const CONDITION_SYMBOL = { GTE: '≥', GT: '>', LTE: '≤', LT: '<', EQ: '=' };
const QUARTER_TEXT = { quarter: 'วัดผลรายไตรมาส บันทึกเฉพาะเดือนสุดท้ายของไตรมาส (ธ.ค./มี.ค./มิ.ย./ก.ย.)', month_sum: 'วัดผลรายไตรมาส บันทึกรายเดือน ค่าไตรมาส = ผลรวม 3 เดือน',
    month_last: 'วัดผลรายไตรมาส บันทึกรายเดือน ค่าไตรมาส = เดือนสุดท้ายของไตรมาส', month_avg: 'วัดผลรายไตรมาส บันทึกรายเดือน ค่าไตรมาส = ค่าเฉลี่ย' };
const clip = (v, n = 100) => String(v ?? '').trim().slice(0, n);

/**
 * ข้อมูลที่ผู้ใช้กรอกไว้แล้วในหน้าต่างตัวชี้วัด (13 พ.ย. 2569 — ผู้ใช้สั่ง: AI เสนอสูตรจากข้อมูลนี้ก่อน ต้องการเพิ่มค่อยให้อธิบาย)
 * เป้าหมาย / เกณฑ์ + เงื่อนไข / วิธีคิดผลงาน (สูตรผลงาน, สะสม, กรอกเอง, รายไตรมาส, เป้าหมายรายเดือน) → บรรทัดข้อความสำหรับ prompt
 * kind = 'result' ไม่ส่งสูตรผลงานเดิม (กำลังเสนอสูตรผลงานใหม่)
 */
function indicatorContextLines(ind, kind) {
    if (!ind || typeof ind !== 'object') return [];
    const out = [];
    const target = clip(ind.target_percentage), crit = clip(ind.criterion);
    const cond = CONDITION_TEXT[ind.target_condition] ? ind.target_condition : 'GTE';
    if (target) out.push(`เป้าหมาย (ค่าตั้งต้นของหน่วยบริการ = target): ${target}`);
    if (crit) out.push(`เกณฑ์: ${CONDITION_SYMBOL[cond]} ${crit}`);
    out.push(`เงื่อนไขเป้าหมาย: ${CONDITION_TEXT[cond]}`);
    const rf = clip(ind.result_formula, 500);
    let method;
    if (ind.result_manual === 1 || ind.result_manual === true || ind.result_manual === '1') method = 'ผู้บันทึกกรอกผลงานล่าสุดเอง (result = ค่าที่กรอก)';
    else if (rf && kind === 'pct') method = `คำนวณตามสูตรผลงาน: ${rf} (result = ผลของสูตรนี้)`;
    else if (ind.is_cumulative === 1 || ind.is_cumulative === true || ind.is_cumulative === '1') method = 'ผลงานสะสม = SUM(ALL) (ผลรวมทุกเดือน)';
    else method = 'ผลงาน = ค่าเดือนล่าสุดที่บันทึก = LAST(ALL)';
    out.push(`วิธีคิดผลงาน: ${method}`);
    if (QUARTER_TEXT[ind.quarter_mode]) out.push(`รอบการวัดผล: ${QUARTER_TEXT[ind.quarter_mode]}`);
    if (ind.target_monthly === 'latest') out.push('เป้าหมายรายเดือน: target = เป้าหมายของเดือนเดียวกับผลงานล่าสุด');
    if (ind.target_monthly === 'cumulative') out.push('เป้าหมายรายเดือน: target = ผลรวมเป้าหมายถึงเดือนของผลงานล่าสุด');
    return out;
}
const CONDITION_TEXT = { GTE: 'มากกว่าหรือเท่ากับเป้าหมาย = ผ่าน', GT: 'มากกว่าเป้าหมาย = ผ่าน', LTE: 'น้อยกว่าหรือเท่ากับเป้าหมาย = ผ่าน (ยิ่งน้อยยิ่งดี)', LT: 'น้อยกว่าเป้าหมาย = ผ่าน (ยิ่งน้อยยิ่งดี)', EQ: 'เท่ากับเป้าหมาย = ผ่าน' };

function systemPrompt(kind, customVars) {
    const vars = customVars.length
        ? customVars.map(v => `${v.key} = ${v.label}`).join(', ')
        : '(ไม่มี)';
    return [
        'คุณช่วยเขียน "สูตรคำนวณ" ของตัวชี้วัดด้านสุขภาพ ในภาษาสูตรเฉพาะของระบบ KHUPS KPI เท่านั้น (ไม่ใช่ Excel ไม่ใช่ JavaScript)',
        'ไวยากรณ์ภาษาสูตร:',
        '- ตัวแปรผลงานรายเดือนของปีงบประมาณ: m10 (ต.ค.) m11 (พ.ย.) m12 (ธ.ค.) m01 (ม.ค.) m02 m03 m04 m05 m06 m07 m08 m09 (ก.ย.)',
        '- target = เป้าหมายของหน่วยบริการ | base = ค่าฐานของหน่วยบริการ (เช่น ค่าเฉลี่ยย้อนหลัง)',
        `- ค่าเพิ่มเติมที่ตัวชี้วัดนี้ประกาศไว้: ${vars}`,
        '- ปีงบที่แล้ว: prev_m10 … prev_m09, prev_target, prev_result (ผลงานปีที่แล้ว)',
        kind === 'pct' ? '- result = ผลงานที่คำนวณได้แล้วของตัวชี้วัด (ใช้ได้เฉพาะสูตรร้อยละ)' : '- ห้ามใช้ result (ใช้ได้เฉพาะสูตรร้อยละ)',
        '- ฟังก์ชัน: SUM AVG MAX MIN COUNT LAST — อาร์กิวเมนต์เป็นรายการเดือนคั่นด้วยจุลภาค เช่น SUM(m10,m11,m12) หรือ ALL (12 เดือนปีนี้) / PREV_ALL (12 เดือนปีที่แล้ว) | LASTQ(SUM|AVG|LAST) = ค่าไตรมาสล่าสุดที่มีข้อมูล (ไตรมาส 1 = m10–m12)',
        '- ตัวดำเนินการ + - * / วงเล็บ และตัวเลข (ห้ามใช้ฟังก์ชัน/ตัวแปรอื่น ห้ามใช้ IF, ROUND, %, ^)',
        '- ค่าว่างถูกข้ามในฟังก์ชัน, หารศูนย์ได้ค่าว่าง, ผลปัด 2 ตำแหน่งอัตโนมัติ (ไม่ต้องปัดเอง)',
        '- ข้อเท็จจริงของข้อมูล: ผู้ใช้บันทึกผลงานรายเดือนเป็น "จำนวนที่เกิดในเดือนนั้น" (ไม่ใช่ยอดสะสม) ดังนั้นยอดสะสม/รวมทั้งปี = SUM(ALL) ' +
            'ส่วน LAST(ALL) = ค่าของเดือนล่าสุดที่มีการบันทึก (ใช้เมื่อคำอธิบายต้องการค่าเดือนล่าสุด เช่น ร้อยละที่วัดใหม่ทุกเดือน)',
        ...(kind === 'pct' ? ['- สูตรร้อยละ: ถ้าคำอธิบายเทียบ "ผลงาน" ของตัวชี้วัด ให้ใช้ result (ผลงานที่ระบบคำนวณแล้วตามวิธีของตัวชี้วัด) ไม่ต้องคำนวณผลงานใหม่จากเดือน เว้นแต่คำอธิบายระบุเดือนเอง'] : []),
        'ตัวอย่าง: SUM(ALL) = ผลรวมทุกเดือน | LAST(ALL) = ค่าเดือนล่าสุด | AVG(ALL) = ค่าเฉลี่ย | (m10+m11+m12)/3 = เฉลี่ยไตรมาส 1 | LASTQ(SUM) / LASTQ(AVG) / LASTQ(LAST) = ค่าของไตรมาสล่าสุดที่มีข้อมูล (รวม/เฉลี่ย/เดือนสุดท้าย) | ' +
            '(base - SUM(ALL)) / base * 100 = ร้อยละการลดลงจากค่าฐาน | (LAST(ALL) - prev_result) / prev_result * 100 = ร้อยละการเปลี่ยนแปลงจากปีที่แล้ว',
        kind === 'pct'
            ? 'งานนี้คือ "สูตรร้อยละ" — ผลลัพธ์เป็นร้อยละที่แสดงในคอลัมน์ร้อยละ'
            : 'งานนี้คือ "สูตรคำนวณผลงาน" — ผลลัพธ์คือผลงานของตัวชี้วัด (ระบบนำไปเทียบกับเป้าหมายเอง ไม่ต้องหารด้วย target เว้นแต่คำอธิบายต้องการ)',
        ...(kind === 'pct' ? ['- ถ้าไม่ตั้งสูตรร้อยละ ระบบคิดร้อยละตามเงื่อนไขเป้าหมายเอง (≥/>: result / target * 100 | ≤/<: ไม่เกินเป้าหมาย = 100 เกิน = target / result * 100 | =: ค่าน้อย ÷ ค่ามาก × 100)'] : []),
        'ผู้ใช้อาจส่งเฉพาะ "ข้อมูลตัวชี้วัด" (เป้าหมาย เกณฑ์ เงื่อนไข วิธีคิดผลงาน) โดยไม่มีคำอธิบาย — ให้เสนอสูตรที่เหมาะสมที่สุดจากข้อมูลนั้นและชื่อตัวชี้วัด ' +
            'ถ้ามีคำอธิบาย ให้ยึดคำอธิบายเป็นหลักและใช้ข้อมูลตัวชี้วัดประกอบ',
        'ตอบเป็น JSON อย่างเดียว รูปแบบ {"formula":"<สูตร>","explanation":"<อธิบายภาษาไทยสั้นๆ 1-2 ประโยคว่าสูตรคำนวณอะไร>"}',
        'ถ้าข้อมูลที่มียังไม่พอจะตัดสินสูตร (เช่น ไม่รู้ว่าต้องเทียบกับอะไร) ให้ตอบ {"formula":"","need_more":true,"question":"<ถามสั้นๆ 1 ประโยคว่าต้องการรู้อะไรเพิ่ม>"}',
        'ถ้าคำอธิบายทำเป็นสูตรในภาษานี้ไม่ได้ ให้ตอบ {"formula":"","explanation":"<เหตุผล>"}',
    ].join('\n');
}

function userPrompt(input, previous) {
    const lines = [input.description ? `คำอธิบายของผู้ใช้: ${input.description}` : 'ผู้ใช้ไม่ได้อธิบายวิธีคำนวณ — เสนอสูตรจากข้อมูลตัวชี้วัดด้านล่าง'];
    if (input.indicator_name) lines.push(`ชื่อตัวชี้วัด: ${input.indicator_name}`);
    if (input.context && input.context.length) lines.push('ข้อมูลตัวชี้วัดที่กรอกไว้แล้ว:', ...input.context.map(l => '- ' + l));
    else if (input.target_condition && CONDITION_TEXT[input.target_condition]) lines.push(`เงื่อนไขเป้าหมาย: ${CONDITION_TEXT[input.target_condition]}`);
    if (previous) lines.push(`ครั้งก่อนเสนอ "${previous.formula}" แต่ระบบตรวจแล้วผิด: ${previous.error} — แก้ให้ถูกไวยากรณ์`);
    return lines.join('\n');
}

// input: { description, kind: 'result'|'pct', custom_vars, target_condition, indicator_name, indicator } → { formula, explanation, attempts } | { need_more, question }
// indicator (ไม่บังคับ) = ข้อมูลที่กรอกไว้ในหน้าต่างตัวชี้วัด — ส่งมาแล้วไม่ต้องมีคำอธิบาย (13 พ.ย. 2569)
async function suggestFormula(input, userId) {
    const kind = input.kind === 'pct' ? 'pct' : 'result';
    const desc = String(input.description || '').trim();
    const context = indicatorContextLines(input.indicator, kind);
    if (desc.length > 500 || (desc.length < 5 && !(desc.length === 0 && context.length))) {
        throw new AiError(400, 'กรุณาอธิบายวิธีคำนวณ 5–500 ตัวอักษร', 'AI_INPUT');
    }
    const cv = normalizeCustomVars(input.custom_vars);
    if (cv.error) throw new AiError(400, cv.error, 'AI_INPUT');
    const keys = cv.list.map(v => v.key);
    const extra = kind === 'pct' ? ['result'] : undefined;
    const ctx = { description: desc, target_condition: input.target_condition, indicator_name: String(input.indicator_name || '').slice(0, 300), context };
    let previous = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const out = await callLlm({ feature: kind === 'pct' ? 'formula_pct' : 'formula', userId, system: systemPrompt(kind, cv.list), prompt: userPrompt(ctx, previous), maxTokens: 1500 });
        const j = extractJson(out.text) || {};
        const formula = String(j.formula || '').trim();
        const explanation = String(j.explanation || '').trim().slice(0, 500);
        // ข้อมูลไม่พอ → ให้ผู้ใช้อธิบายเพิ่ม (ไม่ใช่ข้อผิดพลาด)
        if (!formula && (j.need_more || j.question)) {
            return { need_more: true, question: String(j.question || explanation || 'กรุณาอธิบายวิธีคำนวณเพิ่มเติม').trim().slice(0, 300), model: out.model };
        }
        if (!formula) throw new AiError(422, explanation ? `AI เขียนสูตรไม่ได้: ${explanation}` : 'AI ไม่ได้เสนอสูตร', 'AI_NO_FORMULA');
        const chk = parseFormulaInput(formula, keys, extra);
        if (!chk.error) return { formula: chk.value, explanation, attempts: attempt, model: out.model };
        previous = { formula, error: chk.error };
    }
    throw new AiError(422, `AI เสนอสูตรที่ระบบตรวจแล้วใช้ไม่ได้ (${previous.error}) — ลองอธิบายใหม่ให้ชัดขึ้น หรือเขียนสูตรเอง`, 'AI_BAD_FORMULA');
}

module.exports = { suggestFormula, systemPrompt, userPrompt, indicatorContextLines, MAX_ATTEMPTS };
