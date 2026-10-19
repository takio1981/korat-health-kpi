// จับคู่ค่าข้อความจาก KHD (reports.dept / reports.main_indicator / reports.main_yut) กับข้อมูลอ้างอิงของระบบ (Local)
// ใช้ตอน "เพิ่มตัวชี้วัดจาก KHD" และหน้าต่างจับคู่ข้อมูล KHD (19 ต.ค. 2569)
//   ลำดับ: การจับคู่ที่ผู้ดูแลตั้งไว้ (ตาราง khd_value_mappings) → จับคู่อัตโนมัติจากชื่อ/รหัสที่ตรงกัน → ไม่พบ
//   หน่วยงาน: KHD เก็บ "รหัสหน่วยงาน" (เช่น ยสต., NCD) → ตรงกับ departments.dept_code ก่อน แล้วจึงเทียบชื่อ
//   ยุทธศาสตร์: ข้อความใน KHD มีหลายรูปแบบ → เทียบชื่อ แล้วจึงเทียบแบบตัดจำนวนท้ายชื่อ "(37)" ออก (ต้องได้ผลเดียว)
const crypto = require('crypto');

const KHD_MAP_KINDS = ['dept', 'main', 'yut'];

// ช่องว่าง/แท็บ/อักขระแบ่งคำที่มองไม่เห็นหลายตัว = ช่องว่างเดียว, ตัดหัวท้าย, ตัวพิมพ์เล็ก
const normKhd = (v) => String(v ?? '').replace(/[\s​ ]+/g, ' ').trim().toLowerCase();
const stripCount = (s) => s.replace(/\s*\(\d+\)\s*$/, '').trim();
const khdKey = (v) => crypto.createHash('sha256').update(normKhd(v)).digest('hex');

function indexBy(rows, getKey) {
    const m = new Map();
    for (const r of rows || []) {
        const k = getKey(r);
        if (!k) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
    }
    return m;
}
const unique = (list) => (list && list.length === 1 ? list[0] : null);

/**
 * @param {{ departments: any[], strategies: any[], mainIndicators: any[], mappings: any[] }} data
 *   mappings: แถวของ khd_value_mappings { kind, khd_key, khd_value, local_id }
 */
function buildKhdResolver({ departments = [], strategies = [], mainIndicators = [], mappings = [] }) {
    const local = {
        dept: { rows: departments, name: (r) => r.dept_name },
        yut: { rows: strategies, name: (r) => r.yut_name },
        main: { rows: mainIndicators, name: (r) => r.main_indicator_name },
    };
    const byId = {};
    for (const k of KHD_MAP_KINDS) byId[k] = new Map(local[k].rows.map(r => [Number(r.id), r]));
    const auto = {
        dept: [indexBy(departments, r => normKhd(r.dept_code)), indexBy(departments, r => normKhd(r.dept_name))],
        yut: [indexBy(strategies, r => normKhd(r.yut_name)), indexBy(strategies, r => stripCount(normKhd(r.yut_name)))],
        main: [indexBy(mainIndicators, r => normKhd(r.main_indicator_name))],
    };
    const mapped = {};
    for (const k of KHD_MAP_KINDS) mapped[k] = new Map();
    for (const m of mappings) if (mapped[m.kind]) mapped[m.kind].set(m.khd_key, m);

    const result = (kind, status, row) => ({
        status, local_id: row ? Number(row.id) : null, local_name: row ? local[kind].name(row) : null,
        ...(kind === 'main' ? { yut_id: row && row.yut_id != null ? Number(row.yut_id) : null } : {}),
    });

    /** status: 'mapped' | 'auto' | 'ignored' (ตั้งไว้ว่าไม่ต้องจับคู่) | 'unmatched' | 'empty' */
    function resolve(kind, value) {
        const n = normKhd(value);
        if (!n) return result(kind, 'empty', null);
        const m = mapped[kind].get(khdKey(value));
        if (m) {
            if (m.local_id == null) return result(kind, 'ignored', null);
            const row = byId[kind].get(Number(m.local_id));
            if (row) return result(kind, 'mapped', row);
            // จับคู่ไว้กับรายการที่ถูกลบไปแล้ว → ลองจับคู่อัตโนมัติแทน
        }
        const keys = kind === 'yut' ? [n, stripCount(n)] : [n, n];
        for (let i = 0; i < auto[kind].length; i++) {
            const row = unique(auto[kind][i].get(keys[i]));
            if (row) return result(kind, 'auto', row);
        }
        return result(kind, 'unmatched', null);
    }

    /** ค่าที่จะบันทึกลงตัวชี้วัดใหม่จากแถว reports ของ KHD — fallback = ค่าที่เลือกในหน้าต่าง (ใช้เมื่อ KHD ไม่มีค่าหรือยังจับคู่ไม่ได้) */
    function resolveIndicator(khd, fallback = {}) {
        const dept = resolve('dept', khd.dept);
        const main = resolve('main', khd.main_indicator);
        const yut = resolve('yut', khd.main_yut);
        const fbDept = fallback.dept_id ? Number(fallback.dept_id) : null;
        const fbMain = fallback.main_indicator_id ? Number(fallback.main_indicator_id) : null;
        return {
            dept_id: dept.local_id ?? fbDept,
            main_indicator_id: main.local_id ?? fbMain,
            main_yut: yut.local_id ?? main.yut_id ?? null,
            detail: { dept, main, yut },
            // ค่าใน KHD ที่ยังจับคู่ไม่ได้ (ต้องไปตั้งในหน้าต่างจับคู่ข้อมูล KHD)
            unmatched: [['dept', dept], ['main', main], ['yut', yut]].filter(([, r]) => r.status === 'unmatched').map(([k]) => k),
        };
    }

    return { resolve, resolveIndicator };
}

module.exports = { KHD_MAP_KINDS, normKhd, khdKey, buildKhdResolver };
