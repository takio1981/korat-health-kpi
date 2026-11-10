// ผู้ช่วย AI ระยะที่ 2: ช่วยเขียนสูตรคำนวณผลงาน/สูตรร้อยละจากคำอธิบายภาษาไทย (7 พ.ย. 2569)
// AI เสนอเท่านั้น — สูตรที่คืนต้องผ่าน parseFormulaInput() (ตัวตรวจเดียวกับตอนบันทึกตัวชี้วัด) ผิดให้ AI แก้ได้อีก 1 รอบ
// ผู้ใช้เห็นผลตรวจและทดลองคำนวณในหน้าจอเดิมก่อนกดบันทึกเอง (ไม่บันทึกให้)
const { parseFormulaInput, normalizeCustomVars } = require('./formula-vars');
const { callLlm, extractJson, AiError } = require('./ai');

const MAX_ATTEMPTS = 2;
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
        'ตอบเป็น JSON อย่างเดียว รูปแบบ {"formula":"<สูตร>","explanation":"<อธิบายภาษาไทยสั้นๆ 1-2 ประโยคว่าสูตรคำนวณอะไร>"}',
        'ถ้าคำอธิบายทำเป็นสูตรในภาษานี้ไม่ได้ ให้ตอบ {"formula":"","explanation":"<เหตุผล>"}',
    ].join('\n');
}

function userPrompt(input, previous) {
    const lines = [`คำอธิบายของผู้ใช้: ${input.description}`];
    if (input.indicator_name) lines.push(`ชื่อตัวชี้วัด: ${input.indicator_name}`);
    if (input.target_condition && CONDITION_TEXT[input.target_condition]) lines.push(`เงื่อนไขเป้าหมาย: ${CONDITION_TEXT[input.target_condition]}`);
    if (previous) lines.push(`ครั้งก่อนเสนอ "${previous.formula}" แต่ระบบตรวจแล้วผิด: ${previous.error} — แก้ให้ถูกไวยากรณ์`);
    return lines.join('\n');
}

// input: { description, kind: 'result'|'pct', custom_vars, target_condition, indicator_name } → { formula, explanation, attempts }
async function suggestFormula(input, userId) {
    const kind = input.kind === 'pct' ? 'pct' : 'result';
    const desc = String(input.description || '').trim();
    if (desc.length < 5 || desc.length > 500) throw new AiError(400, 'กรุณาอธิบายวิธีคำนวณ 5–500 ตัวอักษร', 'AI_INPUT');
    const cv = normalizeCustomVars(input.custom_vars);
    if (cv.error) throw new AiError(400, cv.error, 'AI_INPUT');
    const keys = cv.list.map(v => v.key);
    const extra = kind === 'pct' ? ['result'] : undefined;
    const ctx = { description: desc, target_condition: input.target_condition, indicator_name: String(input.indicator_name || '').slice(0, 300) };
    let previous = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const out = await callLlm({ feature: kind === 'pct' ? 'formula_pct' : 'formula', userId, system: systemPrompt(kind, cv.list), prompt: userPrompt(ctx, previous), maxTokens: 1500 });
        const j = extractJson(out.text) || {};
        const formula = String(j.formula || '').trim();
        const explanation = String(j.explanation || '').trim().slice(0, 500);
        if (!formula) throw new AiError(422, explanation ? `AI เขียนสูตรไม่ได้: ${explanation}` : 'AI ไม่ได้เสนอสูตร', 'AI_NO_FORMULA');
        const chk = parseFormulaInput(formula, keys, extra);
        if (!chk.error) return { formula: chk.value, explanation, attempts: attempt, model: out.model };
        previous = { formula, error: chk.error };
    }
    throw new AiError(422, `AI เสนอสูตรที่ระบบตรวจแล้วใช้ไม่ได้ (${previous.error}) — ลองอธิบายใหม่ให้ชัดขึ้น หรือเขียนสูตรเอง`, 'AI_BAD_FORMULA');
}

module.exports = { suggestFormula, systemPrompt, userPrompt, MAX_ATTEMPTS };
