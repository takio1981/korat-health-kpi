// สูตรของตัวชี้วัด: ตรวจสูตรที่ผู้ใช้กรอก + ค่าเพิ่มเติมรายหน่วยบริการที่ตั้งชื่อเอง (custom_vars)
// ย้ายจาก server.js (การแยกโมดูล — 25 ต.ค. 2569) แบบคำต่อคำ: ห้ามแก้ตรรกะในการย้าย

const kpiFormula = require('../kpi-formula');

// รับค่า result_formula จาก request → { value: string|null, error: string|null }
// ว่าง/ไม่ส่ง = null (ใช้วิธีเดิม) | สูตรผิด = error ภาษาไทยจาก kpi-formula.js (ห้ามบันทึกสูตรที่คำนวณไม่ได้)
// customKeys = ชื่อค่าเพิ่มเติมของตัวชี้วัด (custom_vars) | extra = ['result'] สำหรับสูตรร้อยละ
function parseFormulaInput(raw, customKeys, extra, label = 'สูตรคำนวณผลงาน') {
    if (raw === undefined || raw === null) return { value: null, error: null };
    const s = String(raw).trim();
    if (!s) return { value: null, error: null };
    const err = kpiFormula.validateFormula(s, customKeys, extra);
    return err ? { value: null, error: `${label}ไม่ถูกต้อง: ${err}` } : { value: s, error: null };
}

// ===== ค่าเพิ่มเติมรายหน่วยบริการที่ตั้งชื่อเอง (kpi_indicators.custom_vars) + สูตรร้อยละ (pct_formula) — 25 ต.ค. 2569 =====
// custom_vars = JSON [{ key: 'pop', label: 'ประชากร' }, …] — key ใช้ในสูตร ค่าของแต่ละหน่วยบริการเก็บใน kpi_base_values (var_key)
// base (ค่าฐาน) ใช้ได้เสมอแม้ไม่ประกาศ — ประกาศ base เพื่อเปลี่ยนชื่อที่แสดงได้
const MAX_CUSTOM_VARS = 10;

function normalizeCustomVars(raw) {
    if (raw === undefined || raw === null || raw === '') return { list: [], error: null };
    let arr = raw;
    if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (e) { return { list: [], error: 'รูปแบบค่าเพิ่มเติมไม่ถูกต้อง' }; } }
    if (!Array.isArray(arr)) return { list: [], error: 'รูปแบบค่าเพิ่มเติมไม่ถูกต้อง' };
    const list = [];
    for (const v of arr) {
        const key = String((v && v.key) || '').trim().toLowerCase();
        if (!key && !String((v && v.label) || '').trim()) continue;   // แถวว่าง
        if (!kpiFormula.isValidVarKey(key)) return { list: [], error: `ชื่อค่าเพิ่มเติม "${key}" ไม่ถูกต้อง (a-z ตามด้วย a-z 0-9 _ ไม่เกิน 20 ตัว และห้ามซ้ำชื่อในตัว เช่น target, result, m10, prev_…)` };
        if (list.some(x => x.key === key)) return { list: [], error: `ชื่อค่าเพิ่มเติม "${key}" ซ้ำกัน` };
        list.push({ key, label: String((v && v.label) || '').trim().slice(0, 60) || key });
    }
    if (list.length > MAX_CUSTOM_VARS) return { list: [], error: `ค่าเพิ่มเติมได้ไม่เกิน ${MAX_CUSTOM_VARS} ค่า` };
    return { list, error: null };
}

const customVarsOf = (ind) => normalizeCustomVars(ind && ind.custom_vars).list;   // ข้อมูลเสีย = ไม่มี (ไม่ throw)

const varKeysOf = (ind) => customVarsOf(ind).map(v => v.key);

// สูตรผลงานของตัวชี้วัดใช้งานได้ (มีและถูกต้องตามชื่อค่าเพิ่มเติมที่ประกาศ)
const formulaOk = (ind, formula) => !!formula && !kpiFormula.validateFormula(formula, varKeysOf(ind));

// ต้องโหลดค่าเพิ่มเติมของหน่วยบริการหรือไม่: สูตรผลงาน/สูตรร้อยละอ้างตัวแปรที่ตั้งชื่อเอง หรือประกาศค่าเพิ่มเติมไว้ (ให้หน้าบันทึกผลงานกรอกได้)
function needsCustomValues(ind) {
    const f = kpiFormula.activeFormula(ind);
    if (f && kpiFormula.formulaVarNames(f).length) return true;
    const p = ind && typeof ind.pct_formula === 'string' ? ind.pct_formula.trim() : '';
    if (p && kpiFormula.formulaVarNames(p).some(n => n !== 'result')) return true;
    return customVarsOf(ind).length > 0;
}

module.exports = { parseFormulaInput, MAX_CUSTOM_VARS, normalizeCustomVars, customVarsOf, varKeysOf, formulaOk, needsCustomValues };
