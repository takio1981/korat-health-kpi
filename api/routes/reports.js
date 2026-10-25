// เส้นทาง: รายงานและกราฟ (kpi-summary, /report/*)
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { activeIndicatorSql, targetCondOf, targetHasSql, targetPassSql } = require('../core/sql');
const { apiRouter } = require('../core/router');
const { authenticateToken } = require('../core/auth');
const { getDistrictId } = require('../core/access');

// GET /kpi-summary — ดึงข้อมูลจาก summary table (เร็วมาก ไม่ต้อง JOIN)
// ผลงานรายเดือนของปีงบที่แล้ว (year_bh - 1) จาก kpi_summary ตามขอบเขตสิทธิ์เดียวกับรายงาน (chartScopeClauses)
// ใช้เป็นค่าอ้างอิง "เตือนค่าที่อาจผิดปกติ" ตอนบันทึกผลงานในหน้า dashboard (frontend/src/app/shared/anomaly.ts) — อ่านอย่างเดียว
// hospcodes (ไม่บังคับ, คั่นด้วยจุลภาค ≤ 300) = จำกัดเฉพาะหน่วยบริการที่แสดงอยู่ในตาราง
apiRouter.get('/kpi-summary/prev-year-months', authenticateToken, async (req, res) => {
    try {
        const year = String(req.query.year_bh || '').trim();
        if (!/^\d{4}$/.test(year)) return res.status(400).json({ success: false, message: 'กรุณาระบุปีงบประมาณ (year_bh) เป็นตัวเลข 4 หลัก' });
        const prevYear = String(Number(year) - 1);
        const scope = await chartScopeClauses(req.user);
        const c = [...scope.c, 's.year_bh = ?'], p = [...scope.p, prevYear];
        const hospcodes = String(req.query.hospcodes || '').split(',').map(h => h.trim()).filter(h => /^[0-9A-Za-z]{1,20}$/.test(h)).slice(0, 300);
        if (hospcodes.length > 0) { c.push('s.hospcode IN (?)'); p.push(hospcodes); }
        const [rows] = await db.query(
            `SELECT s.indicator_id, s.hospcode, s.oct, s.nov, s.dece, s.jan, s.feb, s.mar, s.apr, s.may, s.jun, s.jul, s.aug, s.sep
             FROM kpi_summary s JOIN kpi_indicators i ON i.id = s.indicator_id
             WHERE ${c.join(' AND ')} LIMIT 20000`, p);
        res.json({ success: true, year_bh: prevYear, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

apiRouter.get('/kpi-summary', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const conditions = [];
        const params = [];

        if (req.query.year && req.query.year !== '') { conditions.push('s.year_bh = ?'); params.push(req.query.year); }
        if (req.query.hospcode) { conditions.push('s.hospcode = ?'); params.push(req.query.hospcode); }
        if (req.query.dept) { conditions.push('s.dept_name = ?'); params.push(req.query.dept); }
        if (req.query.district) { conditions.push('s.distname = ?'); params.push(req.query.district); }
        if (req.query.indicator) { conditions.push('s.kpi_indicators_name = ?'); params.push(req.query.indicator); }
        if (req.query.main) { conditions.push('s.main_indicator_name = ?'); params.push(req.query.main); }
        conditions.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        // Role-based filter
        if (user.role === 'admin_ssj' && user.deptId != null) {
            conditions.push('s.dept_name = (SELECT dept_name FROM departments WHERE id = ?)');
            params.push(user.deptId);
        } else if (!['super_admin', 'admin_ssj'].includes(user.role) && user.hospcode) {
            conditions.push('s.hospcode = ?');
            params.push(user.hospcode);
        }

        const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
        const [rows] = await db.query(`SELECT * FROM kpi_summary s ${where} ORDER BY s.year_bh DESC, s.main_indicator_name, s.kpi_indicators_name LIMIT 500`, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ========== Report Summary APIs ==========

// รายงานสรุป: รายข้อตัวชี้วัด
apiRouter.get('/report/by-indicator', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('s.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('s.distid = ?'); params.push(distid); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.indicator_id,
                MAX(s.kpi_indicators_name) AS kpi_indicators_name,
                MAX(s.main_indicator_name) AS main_indicator_name,
                MAX(s.dept_name) AS dept_name,
                MAX(i.criterion) AS ind_criterion,
                MAX(i.result_formula) AS result_formula,
                MAX(i.target_condition) AS ind_target_condition,
                s.year_bh,
                MAX(CAST(s.target_value AS DECIMAL(20,4))) AS target_value,
                SUM(CAST(s.oct AS DECIMAL(20,4))) AS oct,
                SUM(CAST(s.nov AS DECIMAL(20,4))) AS nov,
                SUM(CAST(s.dece AS DECIMAL(20,4))) AS dece,
                SUM(CAST(s.jan AS DECIMAL(20,4))) AS jan,
                SUM(CAST(s.feb AS DECIMAL(20,4))) AS feb,
                SUM(CAST(s.mar AS DECIMAL(20,4))) AS mar,
                SUM(CAST(s.apr AS DECIMAL(20,4))) AS apr,
                SUM(CAST(s.may AS DECIMAL(20,4))) AS may_val,
                SUM(CAST(s.jun AS DECIMAL(20,4))) AS jun,
                SUM(CAST(s.jul AS DECIMAL(20,4))) AS jul,
                SUM(CAST(s.aug AS DECIMAL(20,4))) AS aug,
                SUM(CAST(s.sep AS DECIMAL(20,4))) AS sep,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                COUNT(DISTINCT s.hospcode) AS hospital_count,
                -- จำนวน hospcode ที่มี target — ใช้เทียบความสำเร็จ
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS hospitals_with_target,
                -- จำนวน hospcode ที่ผ่านเกณฑ์ (ตามเงื่อนไขเป้าหมาย ≥ > ≤ < = — targetPassSql)
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS hospitals_passed,
                -- % สำเร็จ = passed / with_target × 100
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct
            FROM kpi_summary s
            LEFT JOIN kpi_indicators i ON i.id = s.indicator_id
            ${whereStr}
            GROUP BY s.indicator_id, s.year_bh
            ORDER BY achievement_pct DESC, MAX(s.main_indicator_name), MAX(s.kpi_indicators_name)
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-indicator error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายหน่วยบริการ
apiRouter.get('/report/by-hospital', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('s.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('s.distid = ?'); params.push(distid); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.hospcode,
                MAX(s.hosname) AS hosname,
                MAX(s.distid) AS distid,
                MAX(s.distname) AS distname,
                s.year_bh,
                COUNT(DISTINCT s.indicator_id) AS indicator_count,
                SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) AS total_target,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                -- จำนวนตัวชี้วัดที่มี target (ใช้เป็นตัวหารของ % สำเร็จ)
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS indicators_with_target,
                -- จำนวนตัวชี้วัดที่ผ่านเกณฑ์ (ตามเงื่อนไขเป้าหมาย ≥ > ≤ < = — targetPassSql)
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS indicators_passed,
                -- % สำเร็จ = passed / with_target × 100 (ไม่ใช่ SUM(actual)/SUM(target))
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct,
                SUM(CASE WHEN s.indicator_status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(s.pending_count) AS pending_count
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.hospcode, s.year_bh
            ORDER BY achievement_pct DESC, MAX(s.distname), MAX(s.hosname)
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-hospital error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายอำเภอ
apiRouter.get('/report/by-district', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (year_bh) { whereClauses.push('s.year_bh = ?'); params.push(year_bh); }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.distid,
                MAX(s.distname) AS distname,
                s.year_bh,
                COUNT(DISTINCT s.hospcode) AS hospital_count,
                COUNT(DISTINCT s.indicator_id) AS indicator_count,
                SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) AS total_target,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                -- count-based achievement (ไม่ใช่ SUM ratio)
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS pairs_with_target,
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS pairs_passed,
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.distid, s.year_bh
            ORDER BY achievement_pct DESC, MAX(s.distname)
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-district error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// รายงานสรุป: รายปีงบประมาณ
apiRouter.get('/report/by-year', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { dept_id, distid, hostype } = req.query;
        let whereClauses = [];
        let params = [];

        // === Role-based filtering (ใช้ kpi_summary) ===
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            else if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('s.distid = ?'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('s.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('s.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { whereClauses.push('s.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('s.distid = ?'); params.push(distid); }
        if (hostype) { whereClauses.push('s.hostype = ?'); params.push(hostype); }
        whereClauses.push(activeIndicatorSql('s.indicator_id')); // เฉพาะตัวชี้วัดที่เปิดใช้งาน

        const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        const sql = `
            SELECT
                s.year_bh,
                COUNT(DISTINCT s.indicator_id) AS indicator_count,
                COUNT(DISTINCT s.hospcode) AS hospital_count,
                SUM(CAST(COALESCE(s.target_value, 0) AS DECIMAL(20,4))) AS total_target,
                SUM(CAST(COALESCE(s.last_actual, 0) AS DECIMAL(20,4))) AS total_actual,
                -- count-based achievement (ไม่ใช่ SUM ratio)
                SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) AS pairs_with_target,
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                         THEN 1 ELSE 0 END) AS pairs_passed,
                CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) = 0 THEN 0
                     ELSE ROUND(
                        SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', targetCondOf('s'))}
                                 THEN 1 ELSE 0 END)
                        / SUM(CASE WHEN ${targetHasSql('s.target_value', targetCondOf('s'))} THEN 1 ELSE 0 END) * 100, 2)
                END AS achievement_pct,
                SUM(CASE WHEN s.indicator_status = 'Approved' THEN 1 ELSE 0 END) AS approved_count,
                SUM(s.pending_count) AS pending_count
            FROM kpi_summary s
            ${whereStr}
            GROUP BY s.year_bh
            ORDER BY achievement_pct DESC, s.year_bh DESC
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-year error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
    }
});

// ========== กราฟและสถิติ (หน้า /charts แท็บกราฟ) ==========
// รวมผลทุกมิติใน SQL จาก kpi_summary ทั้งหมด (ไม่จำกัด 500 แถวแบบ /kpi-summary เดิม) — ใช้เกณฑ์ "ผ่าน" เดียวกับการ์ดสถิติ
// และรายงาน 4 แถบ: คู่ (ตัวชี้วัด × หน่วยบริการ) ที่มีเป้าหมาย > 0 และผลงานล่าสุด (last_actual) ≥ เป้าหมาย
// ร้อยละ = ผ่าน ÷ มีเป้าหมาย × 100 (นับเป็นคู่ ไม่ SUM ค่าดิบข้ามตัวชี้วัด เพราะหน่วยนับต่างกัน)
const CHART_MONTHS = [
    ['oct', 'ต.ค.'], ['nov', 'พ.ย.'], ['dece', 'ธ.ค.'], ['jan', 'ม.ค.'], ['feb', 'ก.พ.'], ['mar', 'มี.ค.'],
    ['apr', 'เม.ย.'], ['may', 'พ.ค.'], ['jun', 'มิ.ย.'], ['jul', 'ก.ค.'], ['aug', 'ส.ค.'], ['sep', 'ก.ย.']
];

// มีเป้าหมาย/ผ่าน ตามเงื่อนไขเป้าหมายของตัวชี้วัด (i.target_condition — CHART_FROM_SQL JOIN kpi_indicators อยู่แล้ว) ตรงกับการ์ด /dashboard-stats
const _cHas = targetHasSql('s.target_value', 'i.target_condition');

// ห้ามใช้ "?" ใน regex — mysql2 ตีความ ? ทุกตัวเป็น placeholder แม้อยู่ใน string literal ของ SQL
const _cNum = (col) => `TRIM(${col}) REGEXP '^-{0,1}[0-9]+([.][0-9]+){0,1}$'`;

const CHART_METRICS_SQL = `
    COUNT(*) AS pairs,
    COUNT(DISTINCT s.indicator_id) AS indicator_count,
    COUNT(DISTINCT s.hospcode) AS hospital_count,
    SUM(CASE WHEN ${_cHas} THEN 1 ELSE 0 END) AS with_target,
    SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', 'i.target_condition')} THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN NULLIF(TRIM(s.last_actual),'') IS NOT NULL THEN 1 ELSE 0 END) AS recorded,
    SUM(CASE WHEN COALESCE(s.pending_count,0) > 0 THEN 1 ELSE 0 END) AS pending_pairs`;

// รายเดือน: recorded = มีค่าในเดือนนั้น | eligible/passed = เทียบค่าเดือนนั้นกับเป้าหมาย เฉพาะตัวชี้วัดแบบปกติ
// (ไม่รวมตัวชี้วัดสะสม/มีสูตร เพราะค่ารายเดือนของตัวชี้วัดเหล่านั้นไม่ใช่ "ผลงาน ณ เดือนนั้น")
const _cNormal = "(COALESCE(i.is_cumulative,0) = 0 AND (i.result_formula IS NULL OR TRIM(i.result_formula) = ''))";

const CHART_MONTHLY_SQL = CHART_MONTHS.map(([m]) => `
    SUM(CASE WHEN NULLIF(TRIM(s.${m}),'') IS NOT NULL THEN 1 ELSE 0 END) AS rec_${m},
    SUM(CASE WHEN ${_cNormal} AND ${_cHas} AND ${_cNum('s.' + m)} THEN 1 ELSE 0 END) AS elig_${m},
    SUM(CASE WHEN ${_cNormal} AND ${_cNum('s.' + m)} AND ${targetPassSql('s.' + m, 's.target_value', 'i.target_condition')} THEN 1 ELSE 0 END) AS pass_${m}`).join(',');

function chartPct(n, d) { return Number(d) > 0 ? Math.round(Number(n) / Number(d) * 10000) / 100 : 0; }

function chartRow(r) {
    const o = { ...r };
    for (const k of ['pairs', 'indicator_count', 'hospital_count', 'with_target', 'passed', 'recorded', 'pending_pairs']) o[k] = Number(r[k] || 0);
    o.not_passed = o.with_target - o.passed;
    o.no_target = o.pairs - o.with_target;
    o.achievement_pct = chartPct(o.passed, o.with_target);
    o.recording_pct = chartPct(o.recorded, o.pairs);
    return o;
}

function chartMonthly(r) {
    return CHART_MONTHS.map(([m, label]) => {
        const rec = Number(r[`rec_${m}`] || 0), elig = Number(r[`elig_${m}`] || 0), pass = Number(r[`pass_${m}`] || 0);
        return { month: m, label, recorded: rec, eligible: elig, passed: pass, pass_pct: chartPct(pass, elig), recording_pct: chartPct(rec, Number(r.pairs || 0)) };
    });
}

// ขอบเขตตาม role บน kpi_summary (เหมือน /report/by-indicator ทุกประการ)
async function chartScopeClauses(user) {
    const c = [], p = [];
    if (user.role === 'super_admin') {
        // เห็นทั้งหมด
    } else if (user.role === 'admin_ssj') {
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

const CHART_FROM_SQL = `
    FROM kpi_summary s
    JOIN kpi_indicators i ON i.id = s.indicator_id
    LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
    LEFT JOIN main_yut y ON y.id = COALESCE(mi.yut_id, i.main_yut)`;  // ยุทธศาสตร์: จากหมวดหมู่หลัก ถ้าไม่มีหมวดหมู่ใช้ kpi_indicators.main_yut

apiRouter.get('/report/chart-stats', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, yut_id, main_id, dept_id, indicator_id, distid, hostype } = req.query;
        const scope = await chartScopeClauses(user);

        // ปีงบที่มีข้อมูล (ตามขอบเขต role) — ใช้เป็นตัวเลือกปี
        const [yearRows] = await db.query(
            `SELECT DISTINCT s.year_bh ${CHART_FROM_SQL} WHERE ${scope.c.join(' AND ')} ORDER BY s.year_bh DESC`, scope.p);
        const years = yearRows.map(r => String(r.year_bh));
        const year = year_bh ? String(year_bh) : (years[0] || '');

        // ตัวเลือก dropdown — ขอบเขต role + ปี (ไม่ขึ้นกับตัวกรองอื่น)
        const baseC = [...scope.c, 's.year_bh = ?'], baseP = [...scope.p, year];
        const [optRows] = await db.query(`
            SELECT DISTINCT y.id AS yut_id, y.yut_name, mi.id AS main_id, mi.main_indicator_name,
                   s.dept_id, s.dept_name, s.indicator_id, i.kpi_indicators_name, s.distid, s.distname, s.hostype
            ${CHART_FROM_SQL} WHERE ${baseC.join(' AND ')}`, baseP);

        // ตัวกรองที่ผู้ใช้เลือก
        const c = [...baseC], p = [...baseP];
        const eqFilter = (col, v, num) => {
            if (v === undefined || v === null || v === '') return;
            if (num && !/^\d+$/.test(String(v))) { c.push('1 = 0'); return; } // id ไม่ใช่ตัวเลข → ไม่มีข้อมูล
            c.push(`${col} = ?`); p.push(num ? Number(v) : String(v));
        };
        if (yut_id === '0') c.push('y.id IS NULL'); else eqFilter('y.id', yut_id, true);
        if (main_id === '0') c.push('mi.id IS NULL'); else eqFilter('mi.id', main_id, true);
        if (dept_id === '0') c.push('s.dept_id IS NULL'); else eqFilter('s.dept_id', dept_id, true);
        eqFilter('s.indicator_id', indicator_id, true);
        eqFilter('s.distid', distid, false);
        eqFilter('s.hostype', hostype, false);
        const where = 'WHERE ' + c.join(' AND ');

        const groupQuery = (keySql, nameSql, extra = '') => db.query(`
            SELECT ${keySql} AS gkey, ${nameSql} AS gname ${extra}, ${CHART_METRICS_SQL}
            ${CHART_FROM_SQL} ${where} GROUP BY ${keySql}`, p);

        const [[overallRows], [yutRows], [mainRows], [deptRows], [indRows], [distRows], [hostypeRows], [mainMonthRows], [deptMonthRows], [hostypeNames]] = await Promise.all([
            db.query(`SELECT ${CHART_METRICS_SQL}, ${CHART_MONTHLY_SQL} ${CHART_FROM_SQL} ${where}`, p),
            groupQuery('COALESCE(y.id, 0)', "COALESCE(MAX(y.yut_name), 'ไม่ระบุยุทธศาสตร์')"),
            groupQuery('COALESCE(mi.id, 0)', "COALESCE(MAX(mi.main_indicator_name), 'ไม่ระบุหมวดหมู่')", ", MAX(y.yut_name) AS yut_name"),
            groupQuery('COALESCE(s.dept_id, 0)', "COALESCE(MAX(s.dept_name), 'ไม่ระบุหน่วยงาน')"),
            groupQuery('s.indicator_id', 'MAX(i.kpi_indicators_name)',
                ", MAX(mi.main_indicator_name) AS main_indicator_name, MAX(s.dept_name) AS dept_name, MAX(i.criterion) AS criterion, MAX(i.target_condition) AS target_condition, MAX(i.result_formula) AS result_formula"),
            groupQuery("COALESCE(s.distid, '')", "COALESCE(MAX(s.distname), 'ไม่ระบุอำเภอ')"),
            groupQuery("COALESCE(s.hostype, '')", "MAX(s.hostype)"),
            db.query(`SELECT COALESCE(mi.id, 0) AS gkey, COALESCE(MAX(mi.main_indicator_name), 'ไม่ระบุหมวดหมู่') AS gname, COUNT(*) AS pairs, ${CHART_MONTHLY_SQL}
                      ${CHART_FROM_SQL} ${where} GROUP BY COALESCE(mi.id, 0)`, p),
            db.query(`SELECT COALESCE(s.dept_id, 0) AS gkey, COALESCE(MAX(s.dept_name), 'ไม่ระบุหน่วยงาน') AS gname, COUNT(*) AS pairs, ${CHART_MONTHLY_SQL}
                      ${CHART_FROM_SQL} ${where} GROUP BY COALESCE(s.dept_id, 0)`, p),
            // ชื่อประเภทหน่วยบริการแยก query (chostype คนละ collation กับ kpi_summary — ไม่ JOIN ตรง)
            db.query('SELECT hostypecode, hostypename FROM chostype'),
        ]);

        const typeName = new Map(hostypeNames.map(h => [String(h.hostypecode), h.hostypename]));
        const byPct = (a, b) => b.achievement_pct - a.achievement_pct || b.with_target - a.with_target || String(a.gname).localeCompare(String(b.gname), 'th');
        const mapGroup = (rows) => rows.map(chartRow).sort(byPct);
        const overall = chartRow(overallRows[0] || {});

        // การกระจายของตัวชี้วัดตามช่วงร้อยละผ่านเกณฑ์ (เฉพาะตัวที่มีเป้าหมาย)
        const byIndicator = mapGroup(indRows);
        const buckets = [
            { key: 'b0', label: '0–49%', min: 0, max: 50 }, { key: 'b50', label: '50–79%', min: 50, max: 80 },
            { key: 'b80', label: '80–99%', min: 80, max: 100 }, { key: 'b100', label: '100%', min: 100, max: Infinity }
        ].map(b => ({ ...b, count: byIndicator.filter(r => r.with_target > 0 && r.achievement_pct >= b.min && r.achievement_pct < b.max).length }));
        buckets.forEach(b => { delete b.min; delete b.max; });

        const uniq = (arr, key) => [...new Map(arr.filter(r => r[key] != null).map(r => [r[key], r])).values()];
        res.json({
            success: true,
            year_bh: year,
            options: {
                years,
                yuts: uniq(optRows, 'yut_id').map(r => ({ id: r.yut_id, name: r.yut_name })).sort((a, b) => a.id - b.id),
                mains: uniq(optRows, 'main_id').map(r => ({ id: r.main_id, name: r.main_indicator_name, yut_id: r.yut_id })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                depts: uniq(optRows, 'dept_id').map(r => ({ id: r.dept_id, name: r.dept_name })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                indicators: uniq(optRows, 'indicator_id').map(r => ({ id: r.indicator_id, name: r.kpi_indicators_name, main_id: r.main_id, dept_id: r.dept_id })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                districts: uniq(optRows, 'distid').map(r => ({ id: r.distid, name: r.distname })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th')),
                hostypes: uniq(optRows, 'hostype').map(r => ({ id: r.hostype, name: typeName.get(String(r.hostype)) || r.hostype })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
            },
            overall,
            monthly: chartMonthly(overallRows[0] || {}),
            by_yut: mapGroup(yutRows),
            by_main: mapGroup(mainRows),
            by_dept: mapGroup(deptRows),
            by_indicator: byIndicator,
            by_district: mapGroup(distRows),
            by_hostype: mapGroup(hostypeRows).map(r => ({ ...r, gname: typeName.get(String(r.gkey)) || (r.gkey ? `ประเภท ${r.gkey}` : 'ไม่ระบุประเภท') })),
            heatmap_main: mainMonthRows.map(r => ({ gkey: r.gkey, gname: r.gname, months: chartMonthly(r) })),
            heatmap_dept: deptMonthRows.map(r => ({ gkey: r.gkey, gname: r.gname, months: chartMonthly(r) })),
            distribution: buckets,
        });
    } catch (error) {
        console.error('Report chart-stats error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลกราฟได้' });
    }
});

// รายงาน: สถานะการบันทึก (Monitor) — ดูว่าตัวชี้วัดใดมีการบันทึก/ไม่ได้บันทึก คิดเป็น %
//   - total_hospitals  = จำนวน hospcode ที่อยู่ใน kpi_results (มี target หรือ actual ใดๆ) ของตัวชี้วัดนั้น
//   - recorded_hospitals = จำนวน hospcode ที่มี actual_value ในเดือนใดๆ (ไม่ว่า target จะตั้งหรือไม่)
//   - recording_pct    = recorded / total × 100
apiRouter.get('/report/recording-status', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        if (!year_bh) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณ' });
        }

        let indicatorWhere = ['r.year_bh = ?', 'i.is_active = 1'];
        let params = [year_bh];

        // Role-based scope (เทียบกับ kpi_indicators i, kpi_results r)
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { indicatorWhere.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { indicatorWhere.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
            if (user.deptId != null) { indicatorWhere.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { indicatorWhere.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { indicatorWhere.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { indicatorWhere.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid); }
        if (hostype) { indicatorWhere.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE hostype = ?)'); params.push(hostype); }

        const whereStr = 'WHERE ' + indicatorWhere.join(' AND ');

        // Per-indicator recording stats
        const sql = `
            WITH hospital_records AS (
                SELECT
                    r.indicator_id,
                    r.year_bh,
                    r.hospcode,
                    MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded,
                    MAX(CASE WHEN NULLIF(TRIM(r.target_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_target
                FROM kpi_results r
                JOIN kpi_indicators i ON i.id = r.indicator_id
                ${whereStr}
                GROUP BY r.indicator_id, r.year_bh, r.hospcode
            )
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                i.criterion,
                i.target_condition,
                i.result_formula,
                mi.main_indicator_name,
                d.dept_name,
                hr.year_bh,
                COUNT(*) AS total_hospitals,
                SUM(hr.has_recorded) AS recorded_hospitals,
                SUM(hr.has_target) AS target_hospitals,
                COUNT(*) - SUM(hr.has_recorded) AS missing_hospitals,
                CASE WHEN COUNT(*) = 0 THEN 0
                     ELSE ROUND(SUM(hr.has_recorded) / COUNT(*) * 100, 2)
                END AS recording_pct
            FROM hospital_records hr
            JOIN kpi_indicators i ON i.id = hr.indicator_id
            LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
            LEFT JOIN departments d ON d.id = i.dept_id
            GROUP BY i.id, hr.year_bh
            ORDER BY recording_pct DESC, mi.main_indicator_name, i.kpi_indicators_name
            LIMIT 1000
        `;
        const [rows] = await db.query(sql, params);

        // Summary (overall)
        const totalIndicators = rows.length;
        const fullyRecorded = rows.filter(r => Number(r.recording_pct) >= 100).length;
        const notRecorded = rows.filter(r => Number(r.recording_pct) === 0).length;
        const partiallyRecorded = totalIndicators - fullyRecorded - notRecorded;
        const avgPct = totalIndicators === 0 ? 0 :
            Math.round(rows.reduce((s, r) => s + Number(r.recording_pct || 0), 0) / totalIndicators * 100) / 100;

        res.json({
            success: true,
            summary: {
                total_indicators: totalIndicators,
                fully_recorded: fullyRecorded,
                partially_recorded: partiallyRecorded,
                not_recorded: notRecorded,
                avg_recording_pct: avgPct
            },
            data: rows
        });
    } catch (error) {
        console.error('Report recording-status error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลสถานะการบันทึกได้' });
    }
});

// รายงาน: สถานะการบันทึก รายหน่วยบริการ (Monitor — Per Hospital)
//   - total_indicators   = จำนวนตัวชี้วัดที่ รพ. นั้นต้องบันทึก (มีใน kpi_results ของปีนั้น)
//   - recorded_indicators = จำนวนตัวชี้วัดที่ รพ. มี actual_value ในเดือนใดๆ
//   - missing_indicators = total - recorded (ตัวที่ยังค้าง)
//   - recording_pct      = recorded / total × 100
//   เรียงจาก recording_pct ASC (ค้างมากสุดขึ้นก่อน) เพื่อให้ admin จับตา รพ. ที่ล่าช้าได้ง่าย
apiRouter.get('/report/recording-status/by-hospital', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, distid, hostype } = req.query;
        if (!year_bh) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณ' });
        }

        let whereClauses = ['r.year_bh = ?', 'i.is_active = 1'];
        let params = [year_bh];

        // Role-based scope (เดียวกับ /report/recording-status)
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (user.role === 'admin_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
        } else if (user.role === 'user_cup') {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else {
            if (user.hospcode) { whereClauses.push('r.hospcode = ?'); params.push(user.hospcode); }
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }
        if (distid) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid); }
        if (hostype) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE hostype = ?)'); params.push(hostype); }

        const whereStr = 'WHERE ' + whereClauses.join(' AND ');

        const sql = `
            WITH hospital_indicators AS (
                SELECT
                    r.hospcode,
                    r.year_bh,
                    r.indicator_id,
                    MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded
                FROM kpi_results r
                JOIN kpi_indicators i ON i.id = r.indicator_id
                ${whereStr}
                GROUP BY r.hospcode, r.year_bh, r.indicator_id
            )
            SELECT
                hi.hospcode,
                MAX(h.hosname) AS hosname,
                MAX(h.distid) AS distid,
                MAX(cd.distname) AS distname,
                MAX(h.hostype) AS hostype,
                MAX(ct.hostypename) AS hostypename,
                hi.year_bh,
                COUNT(*) AS total_indicators,
                SUM(hi.has_recorded) AS recorded_indicators,
                COUNT(*) - SUM(hi.has_recorded) AS missing_indicators,
                CASE WHEN COUNT(*) = 0 THEN 0
                     ELSE ROUND(SUM(hi.has_recorded) / COUNT(*) * 100, 2)
                END AS recording_pct
            FROM hospital_indicators hi
            LEFT JOIN chospital h ON h.hoscode = hi.hospcode
            LEFT JOIN co_district cd ON cd.distid = h.distid
            LEFT JOIN chostype ct ON ct.hostypecode = h.hostype
            GROUP BY hi.hospcode, hi.year_bh
            ORDER BY recording_pct ASC, hi.hospcode
            LIMIT 1000
        `;
        const [rows] = await db.query(sql, params);

        // Summary (overall)
        const totalHospitals = rows.length;
        const fullyRecorded = rows.filter(r => Number(r.recording_pct) >= 100).length;
        const notRecorded = rows.filter(r => Number(r.recording_pct) === 0).length;
        const partiallyRecorded = totalHospitals - fullyRecorded - notRecorded;
        const avgPct = totalHospitals === 0 ? 0 :
            Math.round(rows.reduce((s, r) => s + Number(r.recording_pct || 0), 0) / totalHospitals * 100) / 100;

        res.json({
            success: true,
            summary: {
                total_hospitals: totalHospitals,
                fully_recorded: fullyRecorded,
                partially_recorded: partiallyRecorded,
                not_recorded: notRecorded,
                avg_recording_pct: avgPct
            },
            data: rows
        });
    } catch (error) {
        console.error('Report recording-status/by-hospital error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลสถานะการบันทึก (รายหน่วยบริการ) ได้' });
    }
});

// รายงาน: ตัวชี้วัดที่ค้างบันทึกของหน่วยบริการ (drill-down)
//   ใช้ดูว่า รพ. นั้นค้างตัวชี้วัดไหนบ้าง (สำหรับปุ่ม "ดูรายละเอียด" ในแถว by-hospital)
apiRouter.get('/report/recording-missing/by-hospital/:hospcode', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id } = req.query;
        const { hospcode } = req.params;
        if (!year_bh || !hospcode) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณ + hospcode' });
        }

        let whereClauses = ['r.year_bh = ?', 'r.hospcode = ?', 'i.is_active = 1'];
        let params = [year_bh, hospcode];

        // Role-based scope — ผู้ใช้ที่ไม่ใช่ super_admin/admin_ssj ต้องดูเฉพาะ hospcode ตัวเอง
        if (user.role === 'super_admin') {
            // ผ่าน
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        } else if (['admin_hos', 'admin_sso', 'user_hos', 'user_sso'].includes(user.role)) {
            if (user.hospcode && user.hospcode !== hospcode) {
                return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูหน่วยบริการอื่น' });
            }
        } else if (['admin_cup', 'user_cup'].includes(user.role)) {
            const distid_auto = await getDistrictId(user.hospcode);
            if (distid_auto) { whereClauses.push('r.hospcode IN (SELECT hoscode FROM chospital WHERE distid = ?)'); params.push(distid_auto); }
            if (user.role === 'user_cup' && user.deptId != null) { whereClauses.push('i.dept_id = ?'); params.push(user.deptId); }
        }
        if (dept_id) { whereClauses.push('i.dept_id = ?'); params.push(dept_id); }

        const whereStr = 'WHERE ' + whereClauses.join(' AND ');

        const sql = `
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                i.criterion,
                i.target_condition,
                i.result_formula,
                mi.main_indicator_name,
                d.dept_name,
                r.target_value,
                MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded
            FROM kpi_results r
            JOIN kpi_indicators i ON i.id = r.indicator_id
            LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
            LEFT JOIN departments d ON d.id = i.dept_id
            ${whereStr}
            GROUP BY i.id, r.target_value
            HAVING has_recorded = 0
            ORDER BY mi.main_indicator_name, i.kpi_indicators_name
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, hospcode, year_bh, data: rows });
    } catch (error) {
        console.error('Report recording-missing/by-hospital error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลตัวชี้วัดที่ค้างบันทึกได้' });
    }
});

// รายงาน: สรุปรายหน่วยงาน (Dept Summary)
//   - แต่ละหน่วยงาน: ตัวชี้วัดทั้งหมด / คีย์แล้ว (มีอย่างน้อย 1 รพ.บันทึก actual) / ยังไม่คีย์
//   - avg_coverage_pct = % รพ.ที่บันทึกเฉลี่ยข้ามทุกตัวชี้วัดของ dept
//   สิทธิ์: super_admin ดูทุก dept, admin_ssj ดูเฉพาะ dept ตัวเอง
apiRouter.get('/report/by-dept-summary', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, hostype } = req.query;
        if (!year_bh) {
            return res.json({ success: true, summary: { total_depts: 0, fully_covered: 0, not_entered: 0, avg_coverage_pct: 0 }, data: [] });
        }

        let cteWhere = ['r.year_bh = ?'];
        let cteParams = [year_bh];
        let deptFilter = '';
        let deptFilterParam = null;

        // Role-based scope
        if (user.role === 'super_admin') {
            // เห็นทุก dept
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { deptFilter = 'AND i.dept_id = ?'; deptFilterParam = user.deptId; }
        } else {
            // role อื่นไม่ควรเห็น dept summary แต่ให้กรองตาม dept ตัวเองไว้
            if (user.deptId != null) { deptFilter = 'AND i.dept_id = ?'; deptFilterParam = user.deptId; }
        }

        let hostypeJoin = '';
        if (hostype) {
            hostypeJoin = 'JOIN chospital ch ON ch.hoscode = r.hospcode';
            cteWhere.push('ch.hostype = ?');
            cteParams.push(hostype);
        }

        const cteWhereStr = cteWhere.join(' AND ');

        // params สำหรับ query หลัก
        const queryParams = [...cteParams];
        if (deptFilterParam != null) queryParams.push(deptFilterParam);

        const sql = `
            WITH ind_stats AS (
                SELECT
                    r.indicator_id,
                    COUNT(DISTINCT r.hospcode) AS total_hosp,
                    COUNT(DISTINCT CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN r.hospcode END) AS recorded_hosp
                FROM kpi_results r
                ${hostypeJoin}
                WHERE ${cteWhereStr}
                GROUP BY r.indicator_id
            )
            SELECT
                d.id AS dept_id,
                d.dept_name,
                COUNT(DISTINCT i.id) AS total_indicators,
                COUNT(DISTINCT CASE WHEN IFNULL(ist.recorded_hosp, 0) > 0 THEN i.id END) AS entered_indicators,
                COUNT(DISTINCT CASE WHEN IFNULL(ist.recorded_hosp, 0) = 0 THEN i.id END) AS not_entered_indicators,
                IFNULL(ROUND(
                    100.0 * SUM(IFNULL(ist.recorded_hosp, 0)) / NULLIF(SUM(IFNULL(ist.total_hosp, 0)), 0)
                , 1), 0) AS avg_coverage_pct
            FROM departments d
            JOIN kpi_indicators i ON i.dept_id = d.id AND i.is_active = 1
            LEFT JOIN ind_stats ist ON ist.indicator_id = i.id
            WHERE 1=1 ${deptFilter}
            GROUP BY d.id, d.dept_name
            ORDER BY d.dept_name
        `;
        const [rows] = await db.query(sql, queryParams);

        const totalDepts = rows.length;
        const fullyCovered = rows.filter(r => Number(r.entered_indicators) === Number(r.total_indicators) && Number(r.total_indicators) > 0).length;
        const notEntered = rows.filter(r => Number(r.entered_indicators) === 0).length;
        const avgPct = totalDepts === 0 ? 0 :
            Math.round(rows.reduce((s, r) => s + Number(r.avg_coverage_pct || 0), 0) / totalDepts * 10) / 10;

        res.json({
            success: true,
            summary: { total_depts: totalDepts, fully_covered: fullyCovered, not_entered: notEntered, avg_coverage_pct: avgPct },
            data: rows
        });
    } catch (error) {
        console.error('Report by-dept-summary error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลสรุปรายหน่วยงานได้' });
    }
});

// รายงาน: drill-down รายชื่อหน่วยบริการของตัวชี้วัด (by-dept-summary/hospitals)
//   - filter=recorded → รพ.ที่มี actual_value แล้ว
//   - filter=missing  → รพ.ที่ยังไม่มี actual_value (แต่มี record ใน kpi_results)
//   - filter ไม่ส่ง   → ทั้งหมด
apiRouter.get('/report/by-dept-summary/hospitals', authenticateToken, async (req, res) => {
    try {
        const { year_bh, indicator_id, filter, hostype } = req.query;
        if (!year_bh || !indicator_id) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณและตัวชี้วัด' });
        }

        let whereClauses = ['r.indicator_id = ?', 'r.year_bh = ?'];
        let params = [indicator_id, year_bh];

        if (hostype) { whereClauses.push('h.hostype = ?'); params.push(hostype); }

        let having = '';
        if (filter === 'recorded') having = 'HAVING has_recorded = 1';
        else if (filter === 'missing') having = 'HAVING has_recorded = 0';

        const sql = `
            SELECT
                r.hospcode,
                MAX(COALESCE(h.hosname, r.hospcode)) AS hosname,
                MAX(h.hostype) AS hostype,
                MAX(ct.hostypename) AS hostypename,
                MAX(cd.distname) AS distname,
                MAX(CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN 1 ELSE 0 END) AS has_recorded
            FROM kpi_results r
            LEFT JOIN chospital h ON h.hoscode = r.hospcode
            LEFT JOIN co_district cd ON cd.distid = h.distid
            LEFT JOIN chostype ct ON ct.hostypecode = h.hostype
            WHERE ${whereClauses.join(' AND ')}
            GROUP BY r.hospcode
            ${having}
            ORDER BY cd.distname, h.hosname
            LIMIT 500
        `;
        const [rows] = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-dept-summary/hospitals error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงรายชื่อหน่วยบริการได้' });
    }
});

// รายงาน: drill-down ตัวชี้วัดของหน่วยงาน (by-dept-summary/indicators)
//   - ดูว่าแต่ละตัวชี้วัดใน dept นั้น มีกี่ รพ. คีย์แล้ว / ยังไม่คีย์
apiRouter.get('/report/by-dept-summary/indicators', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { year_bh, dept_id, hostype } = req.query;
        if (!year_bh || !dept_id) {
            return res.status(400).json({ success: false, message: 'ต้องระบุปีงบประมาณและหน่วยงาน' });
        }

        // Role check: admin_ssj ดูได้เฉพาะ dept ตัวเอง
        if (user.role === 'admin_ssj' && user.deptId != null && String(user.deptId) !== String(dept_id)) {
            return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูหน่วยงานอื่น' });
        }

        let cteWhere = ['r.year_bh = ?'];
        let cteParams = [year_bh];
        let hostypeJoin = '';
        if (hostype) {
            hostypeJoin = 'JOIN chospital ch ON ch.hoscode = r.hospcode';
            cteWhere.push('ch.hostype = ?');
            cteParams.push(hostype);
        }
        const cteWhereStr = cteWhere.join(' AND ');

        const sql = `
            WITH ind_stats AS (
                SELECT
                    r.indicator_id,
                    COUNT(DISTINCT r.hospcode) AS total_hosp,
                    COUNT(DISTINCT CASE WHEN NULLIF(TRIM(r.actual_value), '') IS NOT NULL THEN r.hospcode END) AS recorded_hosp
                FROM kpi_results r
                ${hostypeJoin}
                WHERE ${cteWhereStr}
                GROUP BY r.indicator_id
            )
            SELECT
                i.id AS indicator_id,
                i.kpi_indicators_name,
                i.result_formula,
                mi.main_indicator_name,
                IFNULL(ist.total_hosp, 0) AS total_hospitals,
                IFNULL(ist.recorded_hosp, 0) AS recorded_hospitals,
                IFNULL(ist.total_hosp, 0) - IFNULL(ist.recorded_hosp, 0) AS missing_hospitals,
                CASE WHEN IFNULL(ist.total_hosp, 0) = 0 THEN 0
                     ELSE ROUND(IFNULL(ist.recorded_hosp, 0) / ist.total_hosp * 100, 1)
                END AS recording_pct
            FROM kpi_indicators i
            LEFT JOIN ind_stats ist ON ist.indicator_id = i.id
            LEFT JOIN kpi_main_indicators mi ON mi.id = i.main_indicator_id
            WHERE i.dept_id = ? AND i.is_active = 1
            ORDER BY recording_pct DESC, mi.main_indicator_name, i.kpi_indicators_name
        `;
        const queryParams = [...cteParams, dept_id];
        const [rows] = await db.query(sql, queryParams);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Report by-dept-summary/indicators error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลตัวชี้วัดของหน่วยงานได้' });
    }
});

module.exports = { CHART_MONTHS, _cHas, _cNum, CHART_METRICS_SQL, _cNormal, CHART_MONTHLY_SQL, chartPct, chartRow, chartMonthly, chartScopeClauses, CHART_FROM_SQL };
