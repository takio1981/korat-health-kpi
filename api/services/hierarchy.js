// ตัวชี้วัดหลายระดับ (หลัก → ข้อย่อย → … → กิจกรรม): โครงสร้างต้นไม้ + ผลงานรายเดือนที่มีผลของข้อย่อย + ผลงานรวมของตัวชี้วัดหลัก
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const db = require('../db');
const kpiRollup = require('../kpi-rollup');

// ========== ตัวชี้วัดหลายระดับแบบต้นไม้ (19 ต.ค. 2569) ==========
// ข้อย่อยมีข้อแม่เป็นข้อย่อยได้ (kpi_sub_indicators.parent_sub_id) — ทุกข้อเก็บ indicator_id ของตัวชี้วัดหลักเสมอ จึงใช้ JOIN เดิม
// (อนุมัติ/ล็อค/ลบ/สถิติ/refresh) ได้ทุกระดับ — ระดับ: หลัก = 1, ข้อย่อยบนสุด = 2, ข้อลูก = 3 …, กิจกรรม = ระดับข้อแม่ + 1
// จำนวนระดับสูงสุด (รวมหลักและกิจกรรม) ตั้งที่ system_settings.kpi_hierarchy_max_levels (ค่าตั้งต้น 4, ช่วง 3–6)
const HIERARCHY_DEFAULT_MAX_LEVELS = 4;

async function getHierarchyMaxLevels(conn = db) {
    try {
        const [[r]] = await conn.query("SELECT setting_value FROM system_settings WHERE setting_key = 'kpi_hierarchy_max_levels'");
        const n = parseInt(r && r.setting_value, 10);
        if (n >= 3 && n <= 6) return n;
    } catch (_) { /* ใช้ค่าตั้งต้น */ }
    return HIERARCHY_DEFAULT_MAX_LEVELS;
}

// ระดับของข้อย่อยจากสายข้อแม่ (subRows = ข้อย่อยของตัวชี้วัดเดียวกัน) — กันวนลูป
function subLevelIn(subRows, subId) {
    const byId = new Map(subRows.map(s => [Number(s.id), s]));
    let level = 2, cur = byId.get(Number(subId));
    const seen = new Set();
    while (cur && cur.parent_sub_id != null && !seen.has(Number(cur.id))) {
        seen.add(Number(cur.id));
        cur = byId.get(Number(cur.parent_sub_id));
        if (cur) level++;
    }
    return level;
}

// ข้อย่อยที่ "แสดงผล/นำมาคำนวณ" = เปิดใช้งานและข้อแม่ทุกชั้นเปิดใช้งาน (ปิดข้อแม่ = ซ่อนทั้งสาย)
function activeSubTree(subRows) {
    const byId = new Map(subRows.map(s => [Number(s.id), s]));
    const ok = (s, seen = new Set()) => {
        if (!s || Number(s.is_active) !== 1 || seen.has(Number(s.id))) return false;
        if (s.parent_sub_id == null) return true;
        seen.add(Number(s.id));
        return ok(byId.get(Number(s.parent_sub_id)), seen);
    };
    return subRows.filter(s => ok(s));
}

// ข้อย่อยที่คำนวณจากระดับล่าง (auto + มีข้อลูก/กิจกรรมที่เปิดใช้งาน) ในชุด ids ที่ระบุ — kpiRollup.isRolledNode()
async function rolledSubIds(conn, ids) {
    const list = [...new Set((ids || []).map(Number).filter(Boolean))];
    if (!list.length) return new Set();
    const [subs] = await conn.query('SELECT id, rollup_mode FROM kpi_sub_indicators WHERE id IN (?)', [list]);
    const [kids] = await conn.query(
        `SELECT parent_sub_id AS pid, COUNT(*) AS n FROM kpi_sub_indicators WHERE is_active = 1 AND parent_sub_id IN (?) GROUP BY parent_sub_id
         UNION ALL SELECT sub_indicator_id AS pid, COUNT(*) AS n FROM kpi_sub_activities WHERE is_active = 1 AND sub_indicator_id IN (?) GROUP BY sub_indicator_id`,
        [list, list]);
    const count = new Map();
    for (const k of kids) count.set(Number(k.pid), (count.get(Number(k.pid)) || 0) + Number(k.n));
    return new Set(subs.filter(s => kpiRollup.isRolledNode({ kind: 'sub', auto: s.rollup_mode === 'auto' }, count.get(Number(s.id)) || 0)).map(s => Number(s.id)));
}

const ROLLED_SUB_MESSAGE = 'ตัวชี้วัดย่อยนี้คำนวณผลงานจากระดับล่าง (ข้อย่อย/กิจกรรม) — กรุณาบันทึกที่ระดับล่างแทน';

// ผลงานตัวชี้วัดหลักจากตัวชี้วัดย่อย — ใช้ร่วมทุกจุด (หน้าบันทึกผลงาน, Export, ตรวจการเปลี่ยนแปลงก่อน Export)
// หลักการ (11 ต.ค. 2569): ค่ารายเดือน = ผลรวมผลงานของข้อย่อยในเดือนนั้น ÷ "จำนวนตัวชี้วัดย่อยที่เปิดใช้งานทั้งหมด"
//   → ข้อย่อยที่ไม่ได้บันทึกในเดือนนั้นนับเป็น 0 โดยอัตโนมัติ ผู้ใช้ไม่ต้องบันทึก 0 เอง
//   (เดิมใช้ SQL AVG ซึ่งหารด้วยจำนวนข้อที่ "มีการบันทึก" เท่านั้น ทำให้ผลงานสูงเกินจริงเมื่อบันทึกไม่ครบทุกข้อ)
//   เดือนที่ไม่มีข้อย่อยใดบันทึกเลย = null (ไม่ใช่ 0) เพื่อไม่ให้เดือนในอนาคตกลายเป็น 0 ทั้งหมด
// ยกยอดผลงานล่าสุดของแต่ละข้อ (12 ต.ค. 2569 — ผู้ใช้ขอ): ข้อที่ไม่ได้บันทึกในเดือนนั้นใช้ "ผลงานล่าสุดของข้อนั้นจากเดือนก่อนหน้าในปีงบเดียวกัน"
//   (ยังไม่เคยบันทึกเลย = 0) → ข้อที่ผ่านแล้วไม่ต้องบันทึกซ้ำทุกเดือน บันทึกเฉพาะข้อที่ยังไม่ผ่าน/ค่าเปลี่ยน — ต้องการให้ข้อใดเป็น 0 ต้องบันทึก 0
//   นับ/รวมเฉพาะข้อย่อยที่เปิดใช้งาน (is_active = 1) — ตรงกับรายการที่หน้าต่างบันทึกผลงานย่อยแสดง
// avg_target = เฉลี่ยเป้าหมายของข้อย่อยที่มีเป้าหมาย (เป้าหมายที่บันทึกในเดือน ต.ค. ถ้าไม่มีใช้ค่าตั้งต้นของข้อย่อย — เหมือนที่หน้าต่างแสดง)
const SUB_AGG_MONTH_KEYS = { 10: 'm10', 11: 'm11', 12: 'm12', 1: 'm01', 2: 'm02', 3: 'm03', 4: 'm04', 5: 'm05', 6: 'm06', 7: 'm07', 8: 'm08', 9: 'm09' };

const SUB_AGG_FISCAL_ORDER = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];

function subAggNum(v) {
    if (v === null || v === undefined) return null;
    const t = String(v).trim();
    return /^-?(\d+(\.\d+)?|\.\d+)$/.test(t) ? parseFloat(t) : null;
}

// ค่ารายเดือน "ที่มีผล" ของตัวชี้วัดย่อยแต่ละข้อ × หน่วยบริการ × ปีงบ (ตัวชี้วัด 3 ระดับ — 18 ต.ค. 2569)
//   ข้อย่อยกรอกเอง (rollup_mode='manual' — ค่าตั้งต้น) หรือ 'auto' ที่ยังไม่มีกิจกรรมเปิดใช้งาน = ค่าใน kpi_sub_results (เหมือนเดิม)
//   ข้อย่อย 'auto' ที่มีกิจกรรม = kpiRollup.rollupMonthly() ของกิจกรรม (แบบทำแล้ว/ยังไม่ทำ = 100/0)
// คืน { subs, entries } — entry = { indicator_id, sub_indicator_id, hospcode, year_bh, months: {mk: number|null}, raw: {mk: string|null}, target10 }
//   raw = ค่าที่ใช้ส่งออกรายข้อ (ข้อกรอกเอง = ข้อความเดิมทุกตัวอักษร กัน export เห็นว่า "เปลี่ยน" ทั้งที่ไม่ได้แก้)
// ใช้ร่วม: loadSubAggregates() (ผลงานหลัก), คอลัมน์รายข้อของ performKpiExport/checkKpiChanges (use_sub_indicator_export)
async function loadEffectiveSubMonthly(conn, { indicatorId, yearBh, hospcode } = {}) {
    // ข้อย่อยทุกระดับ (ตัวชี้วัดหลายระดับ — 19 ต.ค. 2569): โหลดทั้งหมดแล้วคัดเฉพาะข้อที่เปิดใช้งานและข้อแม่ทุกชั้นเปิดใช้งาน
    const sw = [], sp = [];
    if (indicatorId) { sw.push('indicator_id = ?'); sp.push(indicatorId); }
    const [allSubs] = await conn.query(
        `SELECT id, indicator_id, parent_sub_id, is_active, target_percentage, rollup_mode FROM kpi_sub_indicators ${sw.length ? 'WHERE ' + sw.join(' AND ') : ''}`, sp);
    const subs = activeSubTree(allSubs);
    if (subs.length === 0) return { subs, entries: [] };
    const subById = new Map(subs.map(su => [Number(su.id), su]));

    // กิจกรรมที่เปิดใช้งานของข้อย่อยที่เปิดใช้งาน (ทุกระดับ)
    const [acts] = await conn.query('SELECT id, sub_indicator_id, value_type FROM kpi_sub_activities WHERE is_active = 1 AND sub_indicator_id IN (?)', [[...subById.keys()]]);
    const actById = new Map(acts.map(a => [Number(a.id), a]));

    // โครงต้นไม้ต่อตัวชี้วัดหลัก (kpiRollup.rollupTree) — key: s<id> / a<id>
    const nodesByInd = new Map();
    const nodeList = (indId) => { if (!nodesByInd.has(indId)) nodesByInd.set(indId, []); return nodesByInd.get(indId); };
    for (const su of subs) nodeList(su.indicator_id).push({ key: 's' + su.id, parentKey: su.parent_sub_id != null ? 's' + su.parent_sub_id : null, kind: 'sub', auto: su.rollup_mode === 'auto' });
    for (const a of acts) nodeList(subById.get(Number(a.sub_indicator_id)).indicator_id).push({ key: 'a' + a.id, parentKey: 's' + a.sub_indicator_id, kind: 'activity', valueType: a.value_type });

    // ค่าดิบรายเดือน แยกตาม ตัวชี้วัด × หน่วยบริการ × ปีงบ
    const groups = new Map();
    const groupOf = (indId, hc, year) => {
        const key = `${indId}|${hc}|${year}`;
        if (!groups.has(key)) groups.set(key, { indicator_id: indId, hospcode: hc, year_bh: year, values: {}, target10: new Map(), hasRows: new Set() });
        return groups.get(key);
    };
    const w = [], p = [];
    w.push('sr.sub_indicator_id IN (?)'); p.push([...subById.keys()]);
    if (yearBh) { w.push('sr.year_bh = ?'); p.push(yearBh); }
    if (hospcode) { w.push('sr.hospcode = ?'); p.push(hospcode); }
    const [rows] = await conn.query(`
        SELECT sr.sub_indicator_id, sr.hospcode, sr.year_bh, sr.month_bh, sr.target_value, sr.actual_value
        FROM kpi_sub_results sr WHERE ${w.join(' AND ')}`, p);
    for (const r of rows) {
        const hc = r.hospcode != null ? String(r.hospcode).trim() : '';
        const mk = SUB_AGG_MONTH_KEYS[Number(r.month_bh)];
        const su = subById.get(Number(r.sub_indicator_id));
        if (!hc || !mk || !su) continue;
        const g = groupOf(su.indicator_id, hc, r.year_bh);
        const k = 's' + su.id;
        g.hasRows.add(k);
        if (Number(r.month_bh) === 10) g.target10.set(Number(su.id), subAggNum(r.target_value));
        (g.values[k] || (g.values[k] = {}))[mk] = r.actual_value;
    }
    if (actById.size > 0) {
        const aw = ['ar.activity_id IN (?)'], ap = [[...actById.keys()]];
        if (yearBh) { aw.push('ar.year_bh = ?'); ap.push(yearBh); }
        if (hospcode) { aw.push('ar.hospcode = ?'); ap.push(hospcode); }
        const [arows] = await conn.query(`SELECT ar.activity_id, ar.hospcode, ar.year_bh, ar.month_bh, ar.actual_value FROM kpi_activity_results ar WHERE ${aw.join(' AND ')}`, ap);
        for (const r of arows) {
            const hc = r.hospcode != null ? String(r.hospcode).trim() : '';
            const mk = SUB_AGG_MONTH_KEYS[Number(r.month_bh)];
            const a = actById.get(Number(r.activity_id));
            if (!hc || !mk || !a) continue;
            const g = groupOf(subById.get(Number(a.sub_indicator_id)).indicator_id, hc, r.year_bh);
            (g.values['a' + a.id] || (g.values['a' + a.id] = {}))[mk] = r.actual_value;
        }
    }

    // คำนวณจากล่างขึ้นบนด้วยกติกาเดียวกับหน้าจอ (shared/kpi-rollup.ts)
    const entries = [];
    for (const g of groups.values()) {
        const tree = kpiRollup.rollupTree(nodesByInd.get(g.indicator_id) || [], g.values);
        for (const su of subs) {
            if (su.indicator_id !== g.indicator_id) continue;
            const k = 's' + su.id;
            const t = tree[k];
            if (!t) continue;
            const hasValue = SUB_AGG_FISCAL_ORDER.some(mk => t.months[mk] !== null);
            if (!g.hasRows.has(k) && !(t.rolled && hasValue)) continue;
            const raw = {};
            for (const mk of SUB_AGG_FISCAL_ORDER) {
                if (t.rolled) raw[mk] = t.months[mk] === null ? null : String(t.months[mk]);
                else {
                    const v = g.values[k] && g.values[k][mk];
                    if (g.values[k] && mk in g.values[k]) raw[mk] = (v != null && v !== '') ? String(v) : null;
                }
            }
            entries.push({ indicator_id: g.indicator_id, sub_indicator_id: Number(su.id), parent_sub_id: su.parent_sub_id != null ? Number(su.parent_sub_id) : null,
                hospcode: g.hospcode, year_bh: g.year_bh, months: t.months, raw, rolled: t.rolled,
                target10: g.target10.has(Number(su.id)) ? g.target10.get(Number(su.id)) : null });
        }
    }
    return { subs, entries };
}

// ผลงานตัวชี้วัดหลักจากข้อย่อย "ระดับบนสุด" (parent_sub_id = NULL) — ข้อลูกมีผลผ่านข้อแม่ที่คำนวณจากระดับล่างเท่านั้น
async function loadSubAggregates(conn, { indicatorId, yearBh, hospcode } = {}) {
    const { subs: allSubs, entries: allEntries } = await loadEffectiveSubMonthly(conn, { indicatorId, yearBh, hospcode });
    const subs = allSubs.filter(su => su.parent_sub_id == null);
    const entries = allEntries.filter(e => e.parent_sub_id == null);
    if (subs.length === 0) return [];
    const subsByInd = new Map();
    for (const su of subs) {
        if (!subsByInd.has(su.indicator_id)) subsByInd.set(su.indicator_id, []);
        subsByInd.get(su.indicator_id).push(su);
    }
    // โหมดของตัวชี้วัดหลัก — 'manual' = กรอกผลงานหลักเอง (ผู้เรียกต้องไม่นำค่าจากข้อย่อยไปทับ)
    const [inds] = await conn.query('SELECT id, sub_rollup_mode FROM kpi_indicators WHERE id IN (?)', [[...subsByInd.keys()]]);
    const modeById = new Map(inds.map(i => [i.id, i.sub_rollup_mode || 'auto']));
    const groups = new Map();
    for (const e of entries) {
        const key = `${e.indicator_id}|${e.hospcode}|${e.year_bh}`;
        if (!groups.has(key)) groups.set(key, { indicator_id: e.indicator_id, hospcode: e.hospcode, year_bh: e.year_bh, vals: {}, target: new Map() });
        const g = groups.get(key);
        for (const mk of SUB_AGG_FISCAL_ORDER) {
            const v = e.months[mk];
            if (v !== null && v !== undefined) (g.vals[mk] || (g.vals[mk] = {}))[e.sub_indicator_id] = v;
        }
        if (e.target10 !== null) g.target.set(e.sub_indicator_id, e.target10);
    }
    const round4 = (n) => Math.round(n * 10000) / 10000;
    const out = [];
    for (const g of groups.values()) {
        const indSubs = subsByInd.get(g.indicator_id) || [];
        const subCount = indSubs.length;
        const row = { indicator_id: g.indicator_id, hospcode: g.hospcode, year_bh: g.year_bh, sub_count: subCount,
            sub_rollup_mode: modeById.get(g.indicator_id) || 'auto', ...kpiRollup.rollupMonthly(subCount, g.vals) };
        const targets = indSubs.map(su => g.target.has(Number(su.id)) ? g.target.get(Number(su.id)) : subAggNum(su.target_percentage)).filter(t => t !== null && t !== 0);
        row.avg_target = targets.length > 0 ? round4(targets.reduce((x, y) => x + y, 0) / targets.length) : null;
        out.push(row);
    }
    return out;
}

// ค่าที่มีผลรายข้อย่อย: Map "<sub_id>_<hospcode>" → { m10: string|null, ... }
//   ค่าตั้งต้น = เฉพาะข้อย่อยระดับบนสุด (คอลัมน์รายข้อของการส่งออกแบบ use_sub_indicator_export — โครงตารางเดิมไม่เปลี่ยน)
//   allLevels = ทุกระดับ (ตารางรายละเอียด <table_process>_items)
async function loadSubExportMonthMap(conn, indicatorId, yearBh, { allLevels = false } = {}) {
    const { entries } = await loadEffectiveSubMonthly(conn, { indicatorId, yearBh });
    const map = new Map();
    for (const e of entries) {
        if (!allLevels && e.parent_sub_id != null) continue;
        const m = {};
        for (const mk of SUB_AGG_FISCAL_ORDER) if (mk in e.raw) m[mk] = e.raw[mk];
        map.set(`${e.sub_indicator_id}_${e.hospcode}`, m);
    }
    return map;
}


// อนุมัติผล KPI และ Lock ข้อมูล (รองรับทั้งรายการเดียวและหลายรายการ)
// Cascade สถานะ/ล็อคจากตัวชี้วัดหลักไปตัวชี้วัดย่อยทั้งหมดของ indicator นั้น (join ผ่าน kpi_sub_indicators)
// ใช้โดย approve/reject/unlock/appeal ทุกจุด — ให้ kpi_sub_results.status/is_locked mirror ค่าที่ตั้งบน kpi_results เสมอ
async function cascadeSubResultsStatus(dbOrConn, indicator_id, year_bh, hospcode, status, is_locked) {
    let sql = `UPDATE kpi_sub_results sr
               JOIN kpi_sub_indicators si ON sr.sub_indicator_id = si.id
               SET sr.status = ?, sr.is_locked = ?
               WHERE si.indicator_id = ? AND sr.year_bh = ?`;
    const params = [status, is_locked, indicator_id, year_bh];
    if (hospcode) { sql += ' AND sr.hospcode = ?'; params.push(hospcode); }
    await dbOrConn.query(sql, params);
    // ระดับกิจกรรม (ตัวชี้วัด 3 ระดับ) — mirror เหมือนข้อย่อย
    let asql = `UPDATE kpi_activity_results ar
               JOIN kpi_sub_activities a ON ar.activity_id = a.id
               JOIN kpi_sub_indicators si ON a.sub_indicator_id = si.id
               SET ar.status = ?, ar.is_locked = ?
               WHERE si.indicator_id = ? AND ar.year_bh = ?`;
    const aparams = [status, is_locked, indicator_id, year_bh];
    if (hospcode) { asql += ' AND ar.hospcode = ?'; aparams.push(hospcode); }
    await dbOrConn.query(asql, aparams);
}

module.exports = { HIERARCHY_DEFAULT_MAX_LEVELS, getHierarchyMaxLevels, subLevelIn, activeSubTree, rolledSubIds, ROLLED_SUB_MESSAGE, SUB_AGG_MONTH_KEYS, SUB_AGG_FISCAL_ORDER, subAggNum, loadEffectiveSubMonthly, loadSubAggregates, loadSubExportMonthMap, cascadeSubResultsStatus };
