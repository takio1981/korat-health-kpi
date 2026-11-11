// เทียบ "หน่วยงาน" และ "หมวดหมู่หลัก" ของตัวชี้วัดกับ KHD (11 พ.ย. 2569 — ผู้ใช้สั่ง) — ฟังก์ชันล้วน
// KHD เก็บเป็นข้อความ (reports.dept = รหัสหน่วยงาน เช่น NCD, reports.main_indicator = ชื่อหมวดหมู่) → แปลงเป็น id ของระบบด้วยตัวจับคู่เดียวกับ
// "เพิ่มตัวชี้วัดจาก KHD" (khd-mapping.js buildKhdResolver: การจับคู่ที่ผู้ดูแลตั้งไว้ก่อน แล้วจึงจับคู่อัตโนมัติ)
// ผลการเทียบ: true = ตรง | false = ต่าง | null = เทียบไม่ได้ (KHD ไม่ได้ระบุ / ตั้งว่าไม่ต้องจับคู่ / ยังจับคู่ไม่ได้ — ไม่นับว่าต่าง)

const RESOLVED = ['mapped', 'auto'];
const PARTS = {
    dept: { khdCol: 'dept', localCol: 'dept_id', kind: 'dept' },
    main: { khdCol: 'main_indicator', localCol: 'main_indicator_id', kind: 'main' },
};

function comparePart(resolver, khd, local, part) {
    const p = PARTS[part];
    const r = resolver.resolve(p.kind, khd ? khd[p.khdCol] : null);
    const value = khd && khd[p.khdCol] != null ? String(khd[p.khdCol]).replace(/[\s​ ]+/g, ' ').trim() : '';
    const localId = local && local[p.localCol] != null ? Number(local[p.localCol]) : null;
    const match = RESOLVED.includes(r.status) ? localId === r.local_id : null;
    return { value, status: r.status, id: r.local_id, name: r.local_name, match };
}

/** ฟิลด์ที่แนบในแถวผลเทียบ GET /report-compare */
function compareKhdOrg(resolver, khd, local) {
    const d = comparePart(resolver, khd, local, 'dept');
    const m = comparePart(resolver, khd, local, 'main');
    return {
        khd_dept_value: d.value || null, khd_dept_status: d.status, khd_dept_id: d.id, khd_dept_name: d.name, dept_match: d.match,
        khd_main_value: m.value || null, khd_main_status: m.status, khd_main_id: m.id, khd_main_name: m.name, main_match: m.match,
    };
}

/** ค่าที่จะปรับ (parts: 'dept' | 'main') — คืน { set, reason } ; set ว่าง = ข้าม (reason บอกเหตุผล) */
function khdOrgUpdate(resolver, khd, local, parts) {
    const set = {};
    const reasons = [];
    for (const part of parts) {
        const c = comparePart(resolver, khd, local, part);
        const label = part === 'dept' ? 'หน่วยงาน' : 'หมวดหมู่หลัก';
        if (c.match === true) { reasons.push(label + 'ตรงกันอยู่แล้ว'); continue; }
        if (c.match === null) {
            reasons.push(c.status === 'unmatched' ? `${label}ใน KHD "${c.value}" ยังจับคู่กับระบบไม่ได้ (ตั้งที่ "จับคู่ข้อมูล KHD")`
                : c.status === 'ignored' ? `${label}ใน KHD ตั้งไว้ว่าไม่ต้องจับคู่` : `KHD ไม่ได้ระบุ${label}`);
            continue;
        }
        set[PARTS[part].localCol] = c.id;
    }
    return { set, reason: reasons.join(', ') };
}

module.exports = { compareKhdOrg, khdOrgUpdate, KHD_ORG_PARTS: Object.keys(PARTS) };
