// AI สรุปรายงานสรุปผลรายแถบ (15 พ.ย. 2569) — หน้ารายงานสถิติ → รายงานสรุปผล: รายตัวชี้วัด / รายหน่วยบริการ / รายอำเภอ / รายปีงบ /
// สถานะการบันทึก (รายตัวชี้วัด | รายหน่วยบริการ) / สรุปรายกลุ่มงาน
// ฟังก์ชันล้วน (ไม่แตะฐานข้อมูล): รับผลของตัวคำนวณรายงานเดียวกับหน้าจอ (routes/reports.js) → ตัวเลขรวม/อันดับสำหรับ prompt
// ⚠️ ไม่ส่งรหัส/ชื่อหน่วยบริการรายแห่งเข้า prompt (หลักการผู้ช่วย AI) — แถบรายหน่วยบริการสรุปเป็นการกระจาย + รายอำเภอ + รายประเภทหน่วยบริการ

const TOP_N = 5;
const MIN_PAIRS = 3;   // อันดับตัวชี้วัด: ตัดตัวที่มีคู่ที่มีเป้าหมายน้อย (ร้อยละแกว่งจากหน่วยเดียว)

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (n, d) => (num(d) > 0 ? Math.round(num(n) / num(d) * 10000) / 100 : 0);
const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 100) / 100;
};

/** ช่วงร้อยละ (ผ่านเกณฑ์/บันทึก) — นับจำนวนรายการในแต่ละช่วง */
const RANGES = [
    ['ร้อยละ 0', (p) => p <= 0],
    ['มากกว่าร้อยละ 0 แต่ต่ำกว่าร้อยละ 50', (p) => p > 0 && p < 50],
    ['ร้อยละ 50–79.99', (p) => p >= 50 && p < 80],
    ['ร้อยละ 80–99.99', (p) => p >= 80 && p < 100],
    ['ร้อยละ 100 ขึ้นไป', (p) => p >= 100],
];
function distribution(values) {
    return RANGES.map(([label, fn]) => ({ range: label, count: values.filter(fn).length }));
}

/** อันดับบน/ล่าง จากรายการ { name, pct, ... } — รายการน้อยกว่า 2 × TOP_N คืนเฉพาะ top (ไม่ซ้ำกับ bottom) */
function topBottom(items, key = 'pct') {
    const sorted = [...items].sort((a, b) => b[key] - a[key] || String(a.name).localeCompare(String(b.name), 'th'));
    const top = sorted.slice(0, TOP_N);
    const bottom = sorted.length > TOP_N ? sorted.slice(Math.max(TOP_N, sorted.length - TOP_N)).reverse() : [];
    return { count: sorted.length, top, bottom };
}

// ---------------- รายแถบ ----------------
// ⚠️ 28 พ.ย. 2569 (ผู้ใช้สั่ง): รายงานสรุปผลนับทุกหน่วยบริการที่ต้องกรอก (มีผลงาน + ยังไม่มีผลงาน) และ achievement_pct = ผลงานรวม ÷ เป้าหมายรวม
// → ข้อมูลเข้า prompt เน้นการบันทึกผลงาน (recording_pct = คู่ที่มีผลงาน ÷ คู่ที่ต้องกรอก) + ร้อยละผลงานต่อเป้าหมาย ไม่ใช้ผ่าน/ไม่ผ่านเกณฑ์
const recPct = (rec, total) => pct(rec, total);
function groupRec(rows, nameOf, recOf, totalOf, ratioOf) {
    const m = new Map();
    for (const r of rows) {
        const name = nameOf(r) || 'ไม่ระบุ';
        const g = m.get(name) || { name, items: 0, recorded: 0, total: 0, ratioSum: 0, ratioN: 0 };
        g.items++; g.recorded += num(recOf(r)); g.total += num(totalOf(r));
        const rt = ratioOf ? ratioOf(r) : null; if (rt != null) { g.ratioSum += rt; g.ratioN++; }
        m.set(name, g);
    }
    return [...m.values()].map(g => ({ name: g.name, items: g.items, recorded: g.recorded, total: g.total, pct: recPct(g.recorded, g.total),
        avg_result_pct: g.ratioN ? Math.round(g.ratioSum / g.ratioN * 100) / 100 : null }));
}
const ratioIf = (r, tCol) => (num(r[tCol]) > 0 ? num(r.achievement_pct) : null);

function byIndicator(rows) {
    const total = rows.reduce((s, r) => s + num(r.hospital_count), 0);
    const rec = rows.reduce((s, r) => s + num(r.recorded_hospitals), 0);
    const ind = rows.filter(r => num(r.hospital_count) >= MIN_PAIRS).map(r => ({
        name: r.kpi_indicators_name, pct: recPct(r.recorded_hospitals, r.hospital_count), recorded: num(r.recorded_hospitals), total: num(r.hospital_count),
        result_pct: ratioIf(r, 'target_value'), main: r.main_indicator_name || '' }));
    const withT = rows.filter(r => num(r.target_value) > 0);
    const depts = groupRec(rows, r => r.dept_name, r => r.recorded_hospitals, r => r.hospital_count, r => ratioIf(r, 'target_value')).filter(g => g.total >= MIN_PAIRS);
    return {
        has_data: rows.length > 0,
        overall: {
            indicators: rows.length,
            pairs_total: total,
            pairs_recorded: rec,
            recording_pct: recPct(rec, total),
            indicators_all_recorded: rows.filter(r => num(r.hospital_count) > 0 && num(r.recorded_hospitals) >= num(r.hospital_count)).length,
            indicators_none_recorded: rows.filter(r => num(r.recorded_hospitals) === 0).length,
            indicators_with_target: withT.length,
        },
        recording_distribution: distribution(rows.filter(r => num(r.hospital_count) > 0).map(r => recPct(r.recorded_hospitals, r.hospital_count))),
        result_pct_distribution: distribution(withT.map(r => num(r.achievement_pct))),
        indicators: topBottom(ind),
        departments: topBottom(depts.map(({ name, pct: p, recorded, total: t, items, avg_result_pct }) => ({ name, pct: p, recorded, total: t, indicators: items, avg_result_pct }))),
    };
}

function byHospital(rows, ctx) {
    const typeName = (c) => (ctx.hostypeNames || {})[c] || (c ? 'ประเภท ' + c : 'ไม่ระบุประเภท');
    const total = rows.reduce((s, r) => s + num(r.indicator_count), 0);
    const rec = rows.reduce((s, r) => s + num(r.recorded_indicators), 0);
    const hosPct = rows.filter(r => num(r.indicator_count) > 0).map(r => recPct(r.recorded_indicators, r.indicator_count));
    const pick = (g) => ({ name: g.name, hospitals: g.items, recorded: g.recorded, total: g.total, pct: g.pct, avg_result_pct: g.avg_result_pct });
    return {
        has_data: rows.length > 0,
        overall: {
            hospitals: rows.length,
            pairs_total: total,
            pairs_recorded: rec,
            recording_pct: recPct(rec, total),
            hospitals_not_recorded: rows.filter(r => num(r.recorded_indicators) === 0).length,
            hospitals_complete: rows.filter(r => num(r.indicator_count) > 0 && num(r.recorded_indicators) >= num(r.indicator_count)).length,
            median_hospital_recording_pct: median(hosPct),
            pending_review_months: rows.reduce((s, r) => s + num(r.pending_count), 0),
        },
        hospital_distribution: distribution(hosPct),
        hospital_types: topBottom(groupRec(rows, r => typeName(r.hostype), r => r.recorded_indicators, r => r.indicator_count, r => ratioIf(r, 'total_target')).map(pick)),
        districts: topBottom(groupRec(rows, r => r.distname, r => r.recorded_indicators, r => r.indicator_count, r => ratioIf(r, 'total_target')).map(pick)),
    };
}

function byDistrict(rows) {
    const total = rows.reduce((s, r) => s + num(r.total_pairs), 0);
    const rec = rows.reduce((s, r) => s + num(r.recorded_pairs), 0);
    const list = rows.map(r => ({ name: r.distname || r.distid, pct: recPct(r.recorded_pairs, r.total_pairs), recorded: num(r.recorded_pairs), total: num(r.total_pairs),
        result_pct: ratioIf(r, 'total_target'), hospitals: num(r.hospital_count), indicators: num(r.indicator_count) }))
        .sort((a, b) => b.pct - a.pct || String(a.name).localeCompare(String(b.name), 'th'));
    const pcts = list.map(d => d.pct);
    return {
        has_data: rows.length > 0,
        overall: {
            districts: rows.length,
            pairs_total: total,
            pairs_recorded: rec,
            recording_pct: recPct(rec, total),
            max_pct: pcts.length ? Math.max(...pcts) : 0,
            min_pct: pcts.length ? Math.min(...pcts) : 0,
            median_pct: median(pcts),
        },
        district_distribution: distribution(pcts),
        districts: list,   // อำเภอมีไม่เกินประมาณ 32 — ส่งครบเรียงจากมากไปน้อย
    };
}

function byYear(rows, ctx) {
    const list = rows.map(r => ({
        year_bh: String(r.year_bh), recording_pct: recPct(r.recorded_pairs, r.total_pairs), recorded: num(r.recorded_pairs), total: num(r.total_pairs),
        result_pct: ratioIf(r, 'total_target'), indicators: num(r.indicator_count), hospitals: num(r.hospital_count), pending_review_months: num(r.pending_count),
    })).sort((a, b) => a.year_bh.localeCompare(b.year_bh));
    return {
        has_data: rows.length > 0,
        current_fiscal_year: ctx.currentFiscalYear || null,   // ปีงบที่ยังไม่สิ้นสุด — ผลงานยังไม่ครบปี
        years: list,
    };
}

function recordingByIndicator(out) {
    const rows = out.data || [];
    const sm = out.summary || {};
    const ind = rows.filter(r => num(r.total_hospitals) >= MIN_PAIRS)
        .map(r => ({ name: r.kpi_indicators_name, pct: num(r.recording_pct), recorded: num(r.recorded_hospitals), total: num(r.total_hospitals), dept: r.dept_name || '' }));
    const depts = new Map();
    for (const r of rows) {
        const name = r.dept_name || 'ไม่ระบุ';
        const g = depts.get(name) || { name, indicators: 0, recorded: 0, total: 0, not_recorded_indicators: 0 };
        g.indicators++; g.recorded += num(r.recorded_hospitals); g.total += num(r.total_hospitals);
        if (num(r.recording_pct) <= 0) g.not_recorded_indicators++;
        depts.set(name, g);
    }
    return {
        has_data: rows.length > 0,
        overall: {
            indicators: num(sm.total_indicators), fully_recorded: num(sm.fully_recorded), partially_recorded: num(sm.partially_recorded),
            not_recorded: num(sm.not_recorded), avg_recording_pct: num(sm.avg_recording_pct),
            pairs: rows.reduce((s, r) => s + num(r.total_hospitals), 0), pairs_recorded: rows.reduce((s, r) => s + num(r.recorded_hospitals), 0),
        },
        indicator_distribution: distribution(rows.map(r => num(r.recording_pct))),
        lowest_indicators: [...ind].sort((a, b) => a.pct - b.pct || b.total - a.total).slice(0, 8),
        departments: topBottom([...depts.values()].map(g => ({ ...g, pct: pct(g.recorded, g.total) }))),
    };
}

function recordingByHospital(out) {
    const rows = out.data || [];
    const sm = out.summary || {};
    const group = (nameOf) => {
        const m = new Map();
        for (const r of rows) {
            const name = nameOf(r) || 'ไม่ระบุ';
            const g = m.get(name) || { name, hospitals: 0, recorded: 0, total: 0, hospitals_not_recorded: 0, hospitals_complete: 0 };
            g.hospitals++; g.recorded += num(r.recorded_indicators); g.total += num(r.total_indicators);
            if (num(r.recording_pct) <= 0) g.hospitals_not_recorded++;
            if (num(r.recording_pct) >= 100) g.hospitals_complete++;
            m.set(name, g);
        }
        return [...m.values()].map(g => ({ ...g, pct: pct(g.recorded, g.total) }));
    };
    return {
        has_data: rows.length > 0,
        overall: {
            hospitals: num(sm.total_hospitals), fully_recorded: num(sm.fully_recorded), partially_recorded: num(sm.partially_recorded),
            not_recorded: num(sm.not_recorded), avg_recording_pct: num(sm.avg_recording_pct),
            median_recording_pct: median(rows.map(r => num(r.recording_pct))),
        },
        hospital_distribution: distribution(rows.map(r => num(r.recording_pct))),
        hospital_types: topBottom(group(r => r.hostypename)),
        districts: topBottom(group(r => r.distname)),
    };
}

function byDept(out) {
    const rows = out.data || [];
    const sm = out.summary || {};
    return {
        has_data: rows.length > 0,
        overall: { departments: num(sm.total_depts), fully_covered: num(sm.fully_covered), not_entered: num(sm.not_entered), avg_coverage_pct: num(sm.avg_coverage_pct) },
        departments: rows.map(r => ({
            name: r.dept_name, indicators: num(r.total_indicators), entered: num(r.entered_indicators),
            not_entered: num(r.not_entered_indicators), coverage_pct: num(r.avg_coverage_pct),
        })).sort((a, b) => b.coverage_pct - a.coverage_pct || a.name.localeCompare(b.name, 'th')),
    };
}

/** สรุปข้อมูลตัวชี้วัดของกลุ่มงาน (28 พ.ย. 2569) — out = summarizeDeptKpi() (เน้นการบันทึก) */
function byDeptKpi(out) {
    const rows = out.data || [];
    const sm = out.summary || {};
    const ind = [];
    for (const g of rows) {
        for (const r of g.indicators || []) {
            if (num(r.hospital_count) >= MIN_PAIRS) ind.push({ name: r.kpi_indicators_name, dept: g.dept_name, pct: recPct(r.recorded_hospitals, r.hospital_count), recorded: num(r.recorded_hospitals), total: num(r.hospital_count) });
        }
    }
    return {
        has_data: rows.length > 0,
        overall: {
            departments: num(sm.total_depts), indicators: num(sm.total_indicators), pairs_total: num(sm.total_pairs), pairs_recorded: num(sm.recorded_pairs),
            recording_pct: num(sm.recording_pct), departments_recording_ge_80: num(sm.depts_ge_80), departments_recording_lt_50: num(sm.depts_lt_50),
        },
        department_distribution: distribution(rows.filter(g => num(g.total_pairs) > 0).map(g => num(g.recording_pct))),
        departments: rows.map(g => ({
            name: g.dept_name, indicators: num(g.total_indicators), pairs_total: num(g.total_pairs), pairs_recorded: num(g.recorded_pairs), recording_pct: num(g.recording_pct),
            indicators_all_recorded: num(g.indicators_all_recorded), indicators_none_recorded: num(g.indicators_none_recorded), avg_result_pct: num(g.avg_indicator_pct),
        })),
        indicators: topBottom(ind),
    };
}

// ---------------- prompt ----------------
const TAB_SPECS = {
    'by-indicator': {
        label: 'รายตัวชี้วัด',
        build: (data) => byIndicator(data),
        focus: 'วิเคราะห์การบันทึกผลงานรายตัวชี้วัด: ตัวชี้วัด/กลุ่มงานที่หน่วยบริการบันทึกครบและยังบันทึกน้อย และสัดส่วนผลงานรวมต่อเป้าหมายรวม — ไม่ประเมินผ่าน/ไม่ผ่านเกณฑ์',
        defs: 'pairs_total/total = คู่ที่ต้องกรอก (หน่วยบริการที่ถูกเพิ่มตัวชี้วัด) | pairs_recorded/recorded = คู่ที่บันทึกผลงานแล้ว | recording_pct (pct) = คู่ที่บันทึกแล้ว ÷ คู่ที่ต้องกรอก × 100 | result_pct/avg_result_pct = ผลงานรวม ÷ เป้าหมายรวม × 100 (ไม่ใช่ผ่านเกณฑ์) | recording_distribution = จำนวนตัวชี้วัดตามช่วงร้อยละการบันทึก',
        sections: '■ ภาพรวมการบันทึก ■ ตัวชี้วัดที่บันทึกครบ ■ ตัวชี้วัดที่ควรเร่งบันทึก ■ ข้อสังเกตรายกลุ่มงาน ■ ข้อเสนอแนะ',
    },
    'by-hospital': {
        label: 'รายหน่วยบริการ',
        build: (data, ctx) => byHospital(data, ctx),
        focus: 'วิเคราะห์การบันทึกผลงานของหน่วยบริการในภาพรวม: การกระจายของร้อยละการบันทึก เปรียบเทียบตามประเภทหน่วยบริการและอำเภอ (ข้อมูลไม่มีชื่อหน่วยบริการรายแห่ง ห้ามระบุชื่อหน่วยบริการ)',
        defs: 'pairs_total/total = คู่ที่ต้องกรอก (หน่วยบริการที่ถูกเพิ่มตัวชี้วัด) | pairs_recorded/recorded = คู่ที่บันทึกผลงานแล้ว | recording_pct (pct) = คู่ที่บันทึกแล้ว ÷ คู่ที่ต้องกรอก × 100 | result_pct/avg_result_pct = ผลงานรวม ÷ เป้าหมายรวม × 100 (ไม่ใช่ผ่านเกณฑ์) | hospitals_not_recorded = หน่วยบริการที่ยังไม่บันทึกเลย | pending_review_months = จำนวนช่องผลงานรายเดือนที่รอตรวจสอบ (นับเป็นช่อง/เดือน ไม่ใช่คู่)',
        sections: '■ ภาพรวมการบันทึก ■ การกระจายของหน่วยบริการ ■ เปรียบเทียบตามประเภทหน่วยบริการ ■ อำเภอที่ควรติดตาม ■ ข้อเสนอแนะ',
    },
    'by-district': {
        label: 'รายอำเภอ',
        build: (data) => byDistrict(data),
        focus: 'วิเคราะห์การบันทึกผลงานรายอำเภอ: อำเภอที่บันทึกครบ/บันทึกน้อย ความแตกต่างระหว่างอำเภอ (ส่วนต่างสูงสุด–ต่ำสุด, ค่ากลาง)',
        defs: 'pairs_total/total = คู่ที่ต้องกรอก (หน่วยบริการที่ถูกเพิ่มตัวชี้วัด) | pairs_recorded/recorded = คู่ที่บันทึกผลงานแล้ว | recording_pct (pct) = คู่ที่บันทึกแล้ว ÷ คู่ที่ต้องกรอก × 100 | result_pct/avg_result_pct = ผลงานรวม ÷ เป้าหมายรวม × 100 (ไม่ใช่ผ่านเกณฑ์) | districts เรียงจากร้อยละการบันทึกมากไปน้อย',
        sections: '■ ภาพรวมการบันทึก ■ อำเภอที่บันทึกครบ ■ อำเภอที่ควรติดตาม ■ ความแตกต่างระหว่างอำเภอ ■ ข้อเสนอแนะ',
    },
    'by-year': {
        label: 'รายปีงบประมาณ',
        build: (data, ctx) => byYear(data, ctx),
        focus: 'วิเคราะห์แนวโน้มการบันทึกผลงานข้ามปีงบประมาณ (เรียงจากปีเก่าไปใหม่) เทียบร้อยละการบันทึก ผลงานรวมต่อเป้าหมายรวม จำนวนตัวชี้วัดและหน่วยบริการ — ปีงบปัจจุบัน (current_fiscal_year) ยังไม่ครบปี ต้องระบุว่าเป็นผลระหว่างปี',
        defs: 'pairs_total/total = คู่ที่ต้องกรอก (หน่วยบริการที่ถูกเพิ่มตัวชี้วัด) | pairs_recorded/recorded = คู่ที่บันทึกผลงานแล้ว | recording_pct (pct) = คู่ที่บันทึกแล้ว ÷ คู่ที่ต้องกรอก × 100 | result_pct/avg_result_pct = ผลงานรวม ÷ เป้าหมายรวม × 100 (ไม่ใช่ผ่านเกณฑ์) | pending_review_months = จำนวนช่องผลงานรายเดือนที่รอตรวจสอบ (นับเป็นช่อง/เดือน ไม่ใช่คู่)',
        sections: '■ ภาพรวม ■ แนวโน้มรายปี ■ จุดที่ควรติดตาม ■ ข้อเสนอแนะ',
    },
    'recording-status:by-indicator': {
        label: 'สถานะการบันทึก (รายตัวชี้วัด)',
        build: (out) => recordingByIndicator(out),
        focus: 'วิเคราะห์ความครบถ้วนของการบันทึกผลงานรายตัวชี้วัด: ตัวชี้วัดที่บันทึกครบ/ยังไม่บันทึก กลุ่มงานที่บันทึกน้อย',
        defs: 'recording_pct (pct) = หน่วยบริการที่บันทึกผลงานแล้ว ÷ หน่วยบริการที่ต้องบันทึก × 100 | lowest_indicators = ตัวชี้วัดที่บันทึกน้อยที่สุด (ต้องบันทึก ≥ 3 แห่ง)',
        sections: '■ ภาพรวมการบันทึก ■ ตัวชี้วัดที่ควรเร่งบันทึก ■ ข้อสังเกตรายกลุ่มงาน ■ ข้อเสนอแนะ',
    },
    'recording-status:by-hospital': {
        label: 'สถานะการบันทึก (รายหน่วยบริการ)',
        build: (out) => recordingByHospital(out),
        focus: 'วิเคราะห์ความครบถ้วนของการบันทึกผลงานของหน่วยบริการในภาพรวม เปรียบเทียบตามประเภทหน่วยบริการและอำเภอ (ข้อมูลไม่มีชื่อหน่วยบริการรายแห่ง ห้ามระบุชื่อหน่วยบริการ)',
        defs: 'recording_pct (pct) = ตัวชี้วัดที่บันทึกผลงานแล้ว ÷ ตัวชี้วัดที่ต้องบันทึก × 100 | hospitals_not_recorded = หน่วยบริการที่ยังไม่บันทึกเลย | hospitals_complete = บันทึกครบ',
        sections: '■ ภาพรวมการบันทึก ■ เปรียบเทียบตามประเภทหน่วยบริการ ■ อำเภอที่ควรติดตาม ■ ข้อเสนอแนะ',
    },
    'by-dept': {
        label: 'สรุปรายกลุ่มงาน',
        build: (out) => byDept(out),
        focus: 'วิเคราะห์ความครอบคลุมการบันทึกผลงานรายกลุ่มงาน: กลุ่มงานที่บันทึกครบ/ยังมีตัวชี้วัดที่ไม่มีการบันทึก',
        defs: 'entered = ตัวชี้วัดที่มีหน่วยบริการบันทึกแล้วอย่างน้อย 1 แห่ง | not_entered = ยังไม่มีการบันทึก | coverage_pct = หน่วยบริการที่บันทึก ÷ หน่วยบริการที่ต้องบันทึก × 100 (รวมทุกตัวชี้วัดของกลุ่มงาน)',
        sections: '■ ภาพรวม ■ กลุ่มงานที่บันทึกครอบคลุม ■ กลุ่มงานที่ควรติดตาม ■ ข้อเสนอแนะ',
    },
    'by-dept-kpi': {
        label: 'สรุปข้อมูลตัวชี้วัดของกลุ่มงาน',
        build: (out) => byDeptKpi(out),
        focus: 'วิเคราะห์การบันทึกผลงานตัวชี้วัดรายกลุ่มงาน: กลุ่มงานที่หน่วยบริการบันทึกครบ/บันทึกน้อย จำนวนตัวชี้วัดที่บันทึกครบทุกแห่ง/ยังไม่มีผู้บันทึก และตัวชี้วัดที่ควรเร่งบันทึก — ไม่ประเมินผ่าน/ไม่ผ่านเกณฑ์',
        defs: 'pairs_total/total = คู่ที่ต้องกรอก (หน่วยบริการที่ถูกเพิ่มตัวชี้วัด) | pairs_recorded/recorded = คู่ที่บันทึกผลงานแล้ว | recording_pct (pct) = คู่ที่บันทึกแล้ว ÷ คู่ที่ต้องกรอก × 100 | result_pct/avg_result_pct = ผลงานรวม ÷ เป้าหมายรวม × 100 (ไม่ใช่ผ่านเกณฑ์) | indicators_all_recorded = ตัวชี้วัดที่ทุกหน่วยบริการบันทึกแล้ว | indicators_none_recorded = ยังไม่มีหน่วยบริการบันทึก | department_distribution = จำนวนกลุ่มงานตามช่วงร้อยละการบันทึก',
        sections: '■ ภาพรวมการบันทึก ■ กลุ่มงานที่บันทึกครบ ■ กลุ่มงานที่ควรติดตาม ■ ตัวชี้วัดที่ควรเร่งบันทึก ■ ข้อเสนอแนะ',
    },
};

/** คีย์ของแถบ (สถานะการบันทึกแยกตามมุมมอง) — null = ไม่รองรับ */
function tabKey(tab, view) {
    if (tab === 'recording-status') return 'recording-status:' + (view === 'by-hospital' ? 'by-hospital' : 'by-indicator');
    return Object.prototype.hasOwnProperty.call(TAB_SPECS, tab) ? tab : null;
}

/** ข้อมูลเข้า prompt ของแถบ — ctx: { year_bh, filters, currentFiscalYear, hostypeNames } */
function buildTabInput(key, data, ctx = {}) {
    const spec = TAB_SPECS[key];
    if (!spec) throw new Error('unknown tab ' + key);
    const body = spec.build(data, ctx);
    return { report: spec.label, year_bh: key === 'by-year' ? undefined : (ctx.year_bh || null), filters: ctx.filters || {}, ...body };
}

function tabSystemPrompt(key) {
    const spec = TAB_SPECS[key];
    return [
        'คุณเป็นนักวิเคราะห์ข้อมูลของสำนักงานสาธารณสุขจังหวัดนครราชสีมา เขียนสรุปและวิเคราะห์รายงานผลการดำเนินงานตัวชี้วัด (KPI) ด้านสุขภาพให้ผู้บริหารอ่าน',
        `รายงานนี้คือ "${spec.label}" — ${spec.focus}`,
        'นิยาม: "คู่" = ตัวชี้วัด 1 ตัว × หน่วยบริการ 1 แห่ง | ' + spec.defs + ' | ช่วงร้อยละ (distribution) = จำนวนรายการในแต่ละช่วง',
        'กติกา: ใช้เฉพาะตัวเลขที่ให้มาเท่านั้น ห้ามเดาหรือสร้างตัวเลขเพิ่ม ห้ามสรุปสาเหตุที่ข้อมูลไม่ได้บอก (ให้เขียนว่า "ควรตรวจสอบ" แทน)',
        'ระบุชื่อตัวชี้วัด/หมวดหมู่/กลุ่มงาน/อำเภอ/ประเภทหน่วยบริการตามข้อมูลทุกตัวอักษร ถ้ากลุ่มใดมีรายการน้อยไม่ต้องจัดอันดับ ถ้ารายการ bottom ว่าง = รายการมีน้อย ไม่ต้องแยกกลุ่มล่าง',
        'ใช้คำว่า "คู่" กับจำนวนคู่ ตัวชี้วัด × หน่วยบริการ (ห้ามเรียกว่า "กลุ่มงาน" "หน่วยงาน" หรือ "รายการ")',
        'เขียนตัวเลขตามข้อมูลทุกหลัก ห้ามปัดเศษหรือประมาณ (เช่น 40016 ห้ามเขียน 40,000) ใช้คำว่า "ร้อยละ" แทน % หรือ เปอร์เซ็นต์',
        `รูปแบบ: ภาษาไทยทางการ ข้อความล้วน ไม่ใช้ Markdown ไม่ใช้ตาราง ไม่ใช้ตัวหนา ความยาวไม่เกิน 300 คำ แบ่งเป็นหัวข้อตามลำดับนี้ (บรรทัดหัวข้อขึ้นต้นด้วย ■):`,
        spec.sections,
        'บรรทัดหัวข้อเขียนเฉพาะชื่อหัวข้อ | หัวข้อข้อเสนอแนะเขียน 2–3 ข้อ | รายการย่อยขึ้นต้นด้วย "• " บรรทัดละ 1 ประเด็น',
    ].join('\n');
}

function tabPrompt(input) {
    return 'ข้อมูลรายงาน (JSON):\n' + JSON.stringify(input) + '\n\nเขียนสรุปและวิเคราะห์ตามรูปแบบที่กำหนด';
}

module.exports = {
    TAB_SPECS, tabKey, buildTabInput, tabSystemPrompt, tabPrompt, distribution, topBottom, median,
    byIndicator, byHospital, byDistrict, byYear, recordingByIndicator, recordingByHospital, byDept, byDeptKpi,
};
