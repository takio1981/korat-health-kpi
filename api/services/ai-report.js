// สรุปรายงานด้วย AI (7 พ.ย. 2569) — เตรียมข้อมูลเข้า prompt จากผลของ computeChartStats() (routes/reports.js)
// ฟังก์ชันล้วน (ไม่แตะฐานข้อมูล) ทดสอบได้ — ส่งเฉพาะตัวเลขรวมระดับกลุ่ม/อำเภอ/ตัวชี้วัด ไม่มีข้อมูลบุคคล

const TOP_N = 5;
const MIN_TARGET_PAIRS = 3; // อันดับตัวชี้วัด: ตัดตัวที่มีคู่ที่มีเป้าหมายน้อยเกินไป (ร้อยละแกว่งจากหน่วยเดียว)

const pick = (r) => ({
    name: r.gname,
    pct: r.achievement_pct,
    passed: r.passed,
    with_target: r.with_target,
    recording_pct: r.recording_pct,
});

function rank(rows, minTarget = 1) {
    const eligible = (rows || []).filter(r => r.with_target >= minTarget);
    const sorted = [...eligible].sort((a, b) => b.achievement_pct - a.achievement_pct || b.with_target - a.with_target);
    const top = sorted.slice(0, TOP_N).map(pick);
    const bottom = sorted.length > TOP_N ? sorted.slice(-TOP_N).reverse().map(pick) : [];
    return { count: eligible.length, top, bottom };
}

// ชื่อของตัวกรองที่เลือก (จากตัวเลือกในผลลัพธ์เดียวกัน) — ให้ AI ระบุขอบเขตของสรุปได้ถูก
function describeFilters(stats, q) {
    const o = stats.options || {};
    const nameOf = (list, id) => (list || []).find(x => String(x.id) === String(id))?.name;
    const f = { ปีงบประมาณ: stats.year_bh };
    if (q.yut_id) f['ยุทธศาสตร์'] = nameOf(o.yuts, q.yut_id) || q.yut_id;
    if (q.main_id) f['หมวดหมู่หลัก'] = nameOf(o.mains, q.main_id) || q.main_id;
    if (q.dept_id) f['หน่วยงาน'] = nameOf(o.depts, q.dept_id) || q.dept_id;
    if (q.indicator_id) f['ตัวชี้วัด'] = nameOf(o.indicators, q.indicator_id) || q.indicator_id;
    if (q.zone) f['โซน'] = q.zone;
    if (q.distid) f['อำเภอ'] = nameOf(o.districts, q.distid) || q.distid;
    if (q.hostype) f['ประเภทหน่วยบริการ'] = nameOf(o.hostypes, q.hostype) || q.hostype;
    return f;
}

function buildSummaryInput(stats, q = {}) {
    const ov = stats.overall || {};
    return {
        year_bh: stats.year_bh,
        filters: describeFilters(stats, q),
        overall: {
            pairs: ov.pairs || 0,
            indicators: ov.indicator_count || 0,
            hospitals: ov.hospital_count || 0,
            with_target: ov.with_target || 0,
            passed: ov.passed || 0,
            achievement_pct: ov.achievement_pct || 0,
            recording_pct: ov.recording_pct || 0,
            pending_review: ov.pending_pairs || 0,
        },
        monthly: (stats.monthly || []).filter(m => m.recorded > 0)
            .map(m => ({ month: m.label, recorded: m.recorded, pass_pct: m.eligible > 0 ? m.pass_pct : null })),
        strategies: rank(stats.by_yut),
        departments: rank(stats.by_dept),
        districts: rank(stats.by_district),
        hospital_types: rank(stats.by_hostype),
        indicators: rank(stats.by_indicator, MIN_TARGET_PAIRS),
        distribution: (stats.distribution || []).map(d => ({ range: d.label, indicators: d.count })),
    };
}

const SUMMARY_SYSTEM_PROMPT = [
    'คุณเป็นนักวิเคราะห์ข้อมูลของสำนักงานสาธารณสุขจังหวัดนครราชสีมา เขียนสรุปผลการดำเนินงานตัวชี้วัด (KPI) ด้านสุขภาพให้ผู้บริหารอ่าน',
    'นิยาม: "คู่" = ตัวชี้วัด 1 ตัว × หน่วยบริการ 1 แห่ง | ร้อยละผ่านเกณฑ์ = จำนวนคู่ที่ผลงานผ่านเป้าหมาย ÷ จำนวนคู่ที่มีเป้าหมาย × 100 |',
    'ร้อยละการบันทึก = คู่ที่มีผลงาน ÷ คู่ทั้งหมด × 100 | pass_pct รายเดือนคิดเฉพาะตัวชี้วัดแบบผลงานรายเดือนปกติ (null = ไม่มีข้อมูลเทียบ)',
    'กติกา: ใช้เฉพาะตัวเลขที่ให้มาเท่านั้น ห้ามเดาหรือสร้างตัวเลขเพิ่ม ห้ามสรุปสาเหตุที่ข้อมูลไม่ได้บอก (ให้เขียนว่า "ควรตรวจสอบ" แทน)',
    'ระบุชื่ออำเภอ/ตัวชี้วัด/หน่วยงานตามข้อมูลทุกตัวอักษร ถ้ากลุ่มใดมีรายการน้อยไม่ต้องจัดอันดับ',
    'รูปแบบ: ภาษาไทยทางการ ข้อความล้วน ไม่ใช้ Markdown ไม่ใช้ตาราง ไม่ใช้ตัวหนา ความยาวไม่เกิน 300 คำ แบ่งเป็นหัวข้อตามลำดับนี้ (บรรทัดหัวข้อขึ้นต้นด้วย ■):',
    '■ ภาพรวม (2–3 ประโยค) ■ จุดเด่น ■ จุดที่ควรติดตาม ■ แนวโน้มรายเดือน ■ ข้อเสนอแนะ (2–3 ข้อ)',
    'รายการย่อยขึ้นต้นด้วย "• " บรรทัดละ 1 ประเด็น',
].join('\n');

function summaryPrompt(input) {
    return 'ข้อมูลผลการดำเนินงาน (JSON):\n' + JSON.stringify(input) + '\n\nเขียนสรุปตามรูปแบบที่กำหนด';
}

module.exports = { buildSummaryInput, describeFilters, rank, SUMMARY_SYSTEM_PROMPT, summaryPrompt, TOP_N, MIN_TARGET_PAIRS };
