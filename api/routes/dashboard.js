// เส้นทาง: แม่แบบตัวชี้วัดสำหรับเพิ่มให้หน่วยบริการ, ตรวจตั้งค่าปีงบ, การ์ดสถิติหน้าแรก
// ย้ายจาก server.js (ระยะ 4 ของการแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย
// ลงทะเบียนเส้นทางกับ apiRouter ตอนถูก require — server.js require ไฟล์นี้ที่ตำแหน่งเดิมของเส้นทางชุดนี้ (ลำดับเส้นทางสำคัญ)

const db = require('../db');
const { ROLE_SCOPE_DISTRICT, ROLE_SCOPE_HOSPCODE, ROLE_SCOPE_OWN_DEPT, getDistrictId } = require('../core/access');
const { activeIndicatorSql, targetCondOf, targetHasSql, targetPassSql } = require('../core/sql');
const { apiRouter } = require('../core/router');
const { authenticateToken } = require('../core/auth');
const { indicatorAllowsHostype, indicatorTypeSetting } = require('../services/indicator-scope');

// ===========================
apiRouter.get('/kpi-template', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let deptFilter = '';
        const params = [];
        // กรองตาม dept เฉพาะ role ที่ scope = หน่วยงานตัวเอง (ROLE_SCOPE_OWN_DEPT) — admin_cup/hos/sso เห็นทุกหน่วยงาน
        // แม้บัญชีจะมี dept_id ติดอยู่ก็ตาม (ตาราง Role System ใน CLAUDE.md)
        if (ROLE_SCOPE_OWN_DEPT.includes(user.role) && user.deptId != null) {
            deptFilter = 'AND i.dept_id = ?';
            params.push(user.deptId);
        }
        const sql = `
            SELECT
                if (mi.main_indicator_name is NULL,"ยังไม่กำหนด",mi.main_indicator_name) main_indicator_name,
                i.kpi_indicators_name,
                i.id AS indicator_id,
                i.dept_id,
                i.target_percentage,
                i.target_condition,
                i.criterion,
                i.table_process,
                i.evaluation_mode,
                i.required_off_types,
                i.result_formula,
                i.is_cumulative,
                d.dept_name
            FROM kpi_indicators i
            LEFT JOIN kpi_main_indicators mi ON i.main_indicator_id = mi.id
            LEFT JOIN departments d on d.id = i.dept_id
            WHERE i.is_active = 1
              AND (mi.id IS NULL OR mi.is_active = 1)
              AND (d.id IS NULL OR d.is_active = 1) ${deptFilter}
            ORDER BY mi.main_indicator_name DESC, i.kpi_indicators_name DESC, d.dept_name DESC
        `;
        let [rows] = await db.query(sql, params);
        // hostype_setting: 'types' | 'all' | 'unset' — 'unset' แสดงในรายการแต่เพิ่มไม่ได้ (ต้องตั้งประเภทหน่วยบริการก่อน)
        rows.forEach(r => { r.hostype_setting = indicatorTypeSetting(r); });
        // ผู้ใช้ที่ผูกกับหน่วยบริการเดียว (ROLE_SCOPE_HOSPCODE): ซ่อนตัวชี้วัดที่ตั้งไว้เฉพาะประเภทอื่น (คงตัวที่ยังไม่ได้ตั้งไว้ให้เห็นว่าต้องตั้งค่า)
        if (ROLE_SCOPE_HOSPCODE.includes(user.role) && user.hospcode) {
            const [[h]] = await db.query('SELECT hostype FROM chospital WHERE hoscode = ?', [user.hospcode]);
            if (h && h.hostype) rows = rows.filter(r => r.hostype_setting === 'unset' || indicatorAllowsHostype(r, h.hostype));
        }
        res.json({ success: true, data: rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error fetching template' });
    }
});

// ตรวจสอบข้อมูล KPI ที่มีอยู่แล้วสำหรับ KPI-Setup
apiRouter.get('/kpi-setup-check', authenticateToken, async (req, res) => {
    try {
        const { hospcode, year_bh, dept_id } = req.query;
        if (!hospcode || !year_bh) {
            return res.status(400).json({ success: false, message: 'กรุณาระบุ hospcode และ year_bh' });
        }

        let deptFilter = '';
        let params = [hospcode, year_bh];
        if (dept_id) {
            deptFilter = 'AND i.dept_id = ?';
            params.push(dept_id);
        }

        // นับจำนวนตัวชี้วัดที่มีข้อมูลอยู่แล้ว + ตัวชี้วัดที่มีคะแนนจริง
        const [rows] = await db.query(`
            SELECT
                COUNT(DISTINCT r.indicator_id) AS total_existing,
                COUNT(DISTINCT CASE WHEN r.actual_value > 0 THEN r.indicator_id END) AS scored_indicators,
                SUM(r.actual_value) AS total_score
            FROM kpi_results r
            LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
            WHERE r.hospcode = ? AND r.year_bh = ? AND ${activeIndicatorSql('r.indicator_id')} ${deptFilter}
        `, params);

        const data = rows[0] || { total_existing: 0, scored_indicators: 0, total_score: 0 };
        res.json({
            success: true,
            data: {
                totalExisting: Number(data.total_existing) || 0,
                scoredIndicators: Number(data.scored_indicators) || 0,
                totalScore: Number(data.total_score) || 0
            }
        });
    } catch (error) {
        console.error('KPI Setup Check Error:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถตรวจสอบข้อมูลได้' });
    }
});

apiRouter.get('/dashboard-stats', authenticateToken, async (req, res) => {
    try {
        const user = req.user;

        const year = req.query.year || (new Date().getFullYear() + 543).toString();
        let whereClause = '';
        let filterParams = [];

        // === Role-based stats filtering (same logic as /kpi-results) ===
        const needsHosJoin = ROLE_SCOPE_DISTRICT.includes(user.role);
        if (user.role === 'super_admin') {
            // no filter
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { whereClause = 'AND i.dept_id = ?'; filterParams.push(user.deptId); }
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                whereClause = 'AND h.distid = ?'; filterParams.push(distid);
                if (user.role === 'user_cup' && user.deptId != null) { whereClause += ' AND i.dept_id = ?'; filterParams.push(user.deptId); }
            } else { whereClause = 'AND r.hospcode = ?'; filterParams.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            // ทุก dept แต่เฉพาะ hospcode ตัวเอง
            if (user.hospcode) { whereClause += ' AND r.hospcode = ?'; filterParams.push(user.hospcode); }
        } else {
            if (user.hospcode) { whereClause += ' AND r.hospcode = ?'; filterParams.push(user.hospcode); }
            if (user.deptId != null) { whereClause += ' AND i.dept_id = ?'; filterParams.push(user.deptId); }
        }

        const queryParams = [year, ...filterParams];
        const hosJoin = needsHosJoin ? 'LEFT JOIN chospital h ON r.hospcode = h.hoscode' : '';

        // === Card 1: ร้อยละความสำเร็จ KPI ===
        // ใช้ kpi_summary (มี last_actual = ค่าเดือนล่าสุดที่คีย์) — ไม่ใช่ SUM ทั้งปี
        // นับ % ของ (indicator × hospcode) ที่ "ผ่านเกณฑ์" คือ last_actual >= target_value (target > 0)
        // role-based filter — ใช้ s.* (kpi_summary มี dept_id, distid อยู่แล้ว)
        const summaryWhereClauses = ['s.year_bh = ?', activeIndicatorSql('s.indicator_id')];
        const summaryParams = [year];
        if (user.role === 'super_admin') {
            // เห็นทั้งหมด
        } else if (user.role === 'admin_ssj') {
            if (user.deptId != null) { summaryWhereClauses.push('s.dept_id = ?'); summaryParams.push(user.deptId); }
        } else if (ROLE_SCOPE_DISTRICT.includes(user.role)) {
            const distid = await getDistrictId(user.hospcode);
            if (distid) {
                summaryWhereClauses.push('s.distid = ?'); summaryParams.push(distid);
                if (user.role === 'user_cup' && user.deptId != null) { summaryWhereClauses.push('s.dept_id = ?'); summaryParams.push(user.deptId); }
            } else if (user.hospcode) { summaryWhereClauses.push('s.hospcode = ?'); summaryParams.push(user.hospcode); }
        } else if (['admin_hos', 'admin_sso'].includes(user.role)) {
            if (user.hospcode) { summaryWhereClauses.push('s.hospcode = ?'); summaryParams.push(user.hospcode); }
        } else {
            if (user.hospcode) { summaryWhereClauses.push('s.hospcode = ?'); summaryParams.push(user.hospcode); }
            if (user.deptId != null) { summaryWhereClauses.push('s.dept_id = ?'); summaryParams.push(user.deptId); }
        }
        const summaryWhere = summaryWhereClauses.join(' AND ');

        // ผ่านเกณฑ์ตามเงื่อนไขเป้าหมายของตัวชี้วัด (≥ > ≤ < =) — targetPassSql() (22 ต.ค. 2569)
        const _sc = targetCondOf('s');
        const [successRows] = await db.query(`
            SELECT
                SUM(CASE WHEN ${targetHasSql('s.target_value', _sc, 's.manual_pct')} THEN 1 ELSE 0 END) AS total_with_target,
                SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', _sc, 's.manual_pct')} THEN 1 ELSE 0 END) AS passed
            FROM kpi_summary s
            WHERE ${summaryWhere}
        `, summaryParams);
        const totalWithTarget = Number(successRows[0]?.total_with_target || 0);
        const passedCount = Number(successRows[0]?.passed || 0);
        const successRate = totalWithTarget > 0 ? ((passedCount / totalWithTarget) * 100).toFixed(1) : 0;

        // === Card 2: กลุ่มงานที่บันทึกแล้ว ===
        // นับ dept_id ที่มีผลงานจริง (actual_value ไม่ว่าง) ใน kpi_results หรือ kpi_sub_results
        // เทียบกับ dept ทั้งหมดที่มี indicator active ในปีนี้ (ไม่ใช่ count(*) ทั้งตาราง departments)
        const recordedSql = `
            SELECT COUNT(DISTINCT i.dept_id) as recorded_count
            FROM kpi_results r
            JOIN kpi_indicators i ON r.indicator_id = i.id
            ${hosJoin}
            WHERE r.year_bh = ? AND i.is_active = 1
              AND r.actual_value IS NOT NULL AND r.actual_value != ''
              AND i.dept_id IS NOT NULL
              ${whereClause}
        `;
        const [recordedRows] = await db.query(recordedSql, queryParams);
        // นับ dept ที่มาจาก sub-results ด้วย (กรณีตัวชี้วัดที่บันทึกใน kpi_sub_results)
        const subRecordedSql = `
            SELECT COUNT(DISTINCT i.dept_id) AS recorded_sub
            FROM kpi_sub_results sr
            JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
            JOIN kpi_indicators i ON si.indicator_id = i.id
            ${needsHosJoin ? 'LEFT JOIN chospital h ON sr.hospcode = h.hoscode' : ''}
            WHERE sr.year_bh = ? AND i.is_active = 1
              AND sr.actual_value IS NOT NULL AND sr.actual_value != ''
              AND i.dept_id IS NOT NULL
              ${whereClause.replace(/r\.hospcode/g, 'sr.hospcode')}
        `;
        const [subRecRows] = await db.query(subRecordedSql, queryParams).catch(() => [[{ recorded_sub: 0 }]]);
        // ผลงานกิจกรรม (ตัวชี้วัด 3 ระดับ)
        const [actRecRows] = await db.query(`
            SELECT COUNT(DISTINCT i.dept_id) AS recorded_act
            FROM kpi_activity_results ar
            JOIN kpi_sub_activities a ON a.id = ar.activity_id
            JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
            JOIN kpi_indicators i ON si.indicator_id = i.id
            ${needsHosJoin ? 'LEFT JOIN chospital h ON ar.hospcode = h.hoscode' : ''}
            WHERE ar.year_bh = ? AND i.is_active = 1
              AND ar.actual_value IS NOT NULL AND ar.actual_value != ''
              AND i.dept_id IS NOT NULL
              ${whereClause.replace(/r\.hospcode/g, 'ar.hospcode')}
        `, queryParams).catch(() => [[{ recorded_act: 0 }]]);
        // รวม dept_id จากทุก source — ใช้ Math.max ป้องกันนับซ้ำ (อาจมี dept ที่มีทั้งใน results และ sub_results)
        const recordedCount = Math.max(Number(recordedRows[0]?.recorded_count || 0), Number(subRecRows[0]?.recorded_sub || 0), Number(actRecRows[0]?.recorded_act || 0));

        // totalDepts: นับ dept ที่มี active indicator ในปีนี้ (consistent กับ scope)
        const [totalDeptRows] = await db.query(`
            SELECT COUNT(DISTINCT i.dept_id) AS total
            FROM kpi_indicators i
            WHERE i.is_active = 1 AND i.dept_id IS NOT NULL
        `);

        // === Card 3: รอการตรวจสอบ ===
        // นับ distinct (indicator, hospcode) ที่มี Pending row พร้อม actual_value (มีผลงานจริงรอ approve)
        // + คู่ที่บันทึกผลงานที่ข้อย่อย/กิจกรรม (ตัวชี้วัด 3 ระดับ — แถวผลงานหลักอาจว่าง) — alias ตารางผลงานเป็น r ทุกส่วน ใช้ whereClause ชุดเดียวกัน
        const pendingSql = `
            SELECT COUNT(DISTINCT x.k) AS pending_count FROM (
                SELECT CONCAT(r.indicator_id, '|', r.hospcode) AS k
                FROM kpi_results r
                LEFT JOIN kpi_indicators i ON r.indicator_id = i.id
                ${hosJoin}
                WHERE r.status = 'Pending' AND r.year_bh = ? AND ${activeIndicatorSql('r.indicator_id')}
                  AND r.actual_value IS NOT NULL AND r.actual_value != ''
                  ${whereClause}
                UNION ALL
                SELECT CONCAT(i.id, '|', r.hospcode)
                FROM kpi_sub_results r
                JOIN kpi_sub_indicators si ON si.id = r.sub_indicator_id
                JOIN kpi_indicators i ON i.id = si.indicator_id
                ${hosJoin}
                WHERE r.status = 'Pending' AND r.year_bh = ? AND i.is_active = 1
                  AND r.actual_value IS NOT NULL AND r.actual_value != ''
                  ${whereClause}
                UNION ALL
                SELECT CONCAT(i.id, '|', r.hospcode)
                FROM kpi_activity_results r
                JOIN kpi_sub_activities a ON a.id = r.activity_id
                JOIN kpi_sub_indicators si ON si.id = a.sub_indicator_id
                JOIN kpi_indicators i ON i.id = si.indicator_id
                ${hosJoin}
                WHERE r.status = 'Pending' AND r.year_bh = ? AND i.is_active = 1
                  AND r.actual_value IS NOT NULL AND r.actual_value != ''
                  ${whereClause}
            ) x
        `;
        const [pendingRows] = await db.query(pendingSql, [...queryParams, ...queryParams, ...queryParams]);

        // === Card 4: อันดับผลงานระดับจังหวัด ===
        // ใช้ kpi_summary.last_actual (ค่าเดือนล่าสุด) — ไม่ใช่ raw actual_value ของแต่ละเดือน
        let rank = 0;
        let totalHospitals = 0;
        if (user.hospcode) {
            const [allHosRows] = await db.query(`
                SELECT s.hospcode,
                    SUM(CASE WHEN ${targetHasSql('s.target_value', _sc, 's.manual_pct')} THEN 1 ELSE 0 END) AS total_with_target,
                    SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', _sc, 's.manual_pct')} THEN 1 ELSE 0 END) AS passed,
                    CASE WHEN SUM(CASE WHEN ${targetHasSql('s.target_value', _sc, 's.manual_pct')} THEN 1 ELSE 0 END) = 0 THEN 0
                         ELSE ROUND(
                            SUM(CASE WHEN ${targetPassSql('s.last_actual', 's.target_value', _sc, 's.manual_pct')} THEN 1 ELSE 0 END)
                            / SUM(CASE WHEN ${targetHasSql('s.target_value', _sc, 's.manual_pct')} THEN 1 ELSE 0 END) * 100, 2)
                    END AS success_pct
                FROM kpi_summary s
                WHERE s.year_bh = ? AND ${activeIndicatorSql('s.indicator_id')}
                GROUP BY s.hospcode
                HAVING total_with_target > 0
                ORDER BY success_pct DESC, total_with_target DESC
            `, [year]);
            totalHospitals = allHosRows.length;
            const idx = allHosRows.findIndex(r => r.hospcode === user.hospcode);
            rank = idx >= 0 ? idx + 1 : 0;
        }

        res.json({
            success: true,
            data: {
                successRate,
                recordedCount, // เดิมส่งค่าจาก kpi_results อย่างเดียว ทั้งที่คำนวณรวมข้อย่อย/กิจกรรมไว้แล้ว — แก้ 18 ต.ค. 2569
                totalDepts: totalDeptRows[0].total || 0,
                pendingCount: pendingRows[0].pending_count || 0,
                rank,
                totalHospitals
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Stats Error' });
    }
});
