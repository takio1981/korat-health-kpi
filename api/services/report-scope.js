// ขอบเขตข้อมูลตาม role ที่ใช้ร่วมหลายเส้นทาง (ระยะ 4 ของแผน lean งานผู้ดูแล — 22 พ.ย. 2569)
// chartScopeClauses ย้ายจาก routes/reports.js แบบคำต่อคำ (ไฟล์ routes ห้าม require กันเอง — ศูนย์งานผู้ดูแลใช้ร่วม)
// resultScopeFor = ขอบเขตเดียวกันบน kpi_results r + kpi_indicators i (รายชื่อหน่วยบริการของอำเภอดึงแยก — ไม่ JOIN chospital: คนละ collation)

const db = require('../db');
const { getDistrictId, ROLE_SCOPE_ALL_HOSPCODE_OWN_DEPT } = require('../core/access');

// ขอบเขตตาม role บน kpi_summary (เหมือน /report/by-indicator ทุกประการ)
async function chartScopeClauses(user) {
    const c = [], p = [];
    if (user.role === 'super_admin') {
        // เห็นทั้งหมด
    } else if (ROLE_SCOPE_ALL_HOSPCODE_OWN_DEPT.includes(user.role)) {
        if (user.deptId != null) { c.push('s.dept_id = ?'); p.push(user.deptId); }
    } else if (user.role === 'admin_cup') {
        const d = await getDistrictId(user.hospcode);
        if (d) { c.push('s.distid = ?'); p.push(d); } else if (user.hospcode) { c.push('s.hospcode = ?'); p.push(user.hospcode); }
    } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
        if (user.hospcode) { c.push('s.hospcode = ?'); p.push(user.hospcode); }
    } else if (user.role === 'user_cup') {
        const d = await getDistrictId(user.hospcode);
        if (d) { c.push('s.distid = ?'); p.push(d); }
        if (user.deptId != null) { c.push('s.dept_id = ?'); p.push(user.deptId); }
    } else {
        if (user.hospcode) { c.push('s.hospcode = ?'); p.push(user.hospcode); }
        if (user.deptId != null) { c.push('s.dept_id = ?'); p.push(user.deptId); }
    }
    c.push('i.is_active = 1'); // เฉพาะตัวชี้วัดที่เปิดใช้งาน
    return { c, p };
}

async function districtHospcodes(distid) {
    const [rows] = await db.query('SELECT hoscode FROM chospital WHERE distid = ?', [distid]);
    return rows.map(r => String(r.hoscode).trim());
}

/** ขอบเขตเดียวกับ chartScopeClauses บน kpi_results r / kpi_indicators i — user = null = ทั้งจังหวัด (งานเบื้องหลัง) */
async function resultScopeFor(user) {
    const c = [], p = [];
    const inHos = async (distid) => {
        const list = distid ? await districtHospcodes(distid) : [];
        if (list.length) { c.push('r.hospcode IN (?)'); p.push(list); return true; }
        return false;
    };
    if (!user || user.role === 'super_admin') {
        // ทั้งหมด
    } else if (ROLE_SCOPE_ALL_HOSPCODE_OWN_DEPT.includes(user.role)) {
        if (user.deptId != null) { c.push('i.dept_id = ?'); p.push(user.deptId); }
    } else if (user.role === 'admin_cup') {
        const ok = await inHos(await getDistrictId(user.hospcode));
        if (!ok) { c.push('r.hospcode = ?'); p.push(user.hospcode || ''); }
    } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
        c.push('r.hospcode = ?'); p.push(user.hospcode || '');
    } else if (user.role === 'user_cup') {
        const ok = await inHos(await getDistrictId(user.hospcode));
        if (!ok) { c.push('r.hospcode = ?'); p.push(user.hospcode || ''); }
        if (user.deptId != null) { c.push('i.dept_id = ?'); p.push(user.deptId); }
    } else {
        c.push('r.hospcode = ?'); p.push(user.hospcode || '');
        if (user.deptId != null) { c.push('i.dept_id = ?'); p.push(user.deptId); }
    }
    c.push('i.is_active = 1');
    return { c, p };
}

module.exports = { chartScopeClauses, resultScopeFor, districtHospcodes };
