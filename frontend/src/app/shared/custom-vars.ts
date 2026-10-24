// ค่าเพิ่มเติมที่ตั้งชื่อเอง (kpi_indicators.custom_vars) + สูตรร้อยละ (pct_formula) — 25 ต.ค. 2569
//   custom_vars = [{ key: 'pop', label: 'ประชากร' }] — ค่าของแต่ละหน่วยบริการเก็บที่ kpi_base_values (var_key) และมาในแถวเป็น cv_<key>
//   base (ค่าฐาน) ใช้ได้เสมอแม้ไม่ประกาศ — แสดงช่องกรอกเมื่อสูตรอ้าง base
//   pct_formula = สูตรร้อยละ (ใช้ result = ผลงาน + ตัวแปรเดียวกับสูตรผลงาน) — ว่าง = คิดตามเงื่อนไขเป้าหมายเดิม (shared/kpi-target.ts)
//   การผ่าน/ไม่ผ่านเกณฑ์ไม่เปลี่ยน (ผลงานเทียบเป้าหมายตามเงื่อนไข — ผู้ใช้เลือก)
import { activeFormula, evaluateFormula, formulaVarNames, isValidVarKey } from './kpi-formula';

export interface CustomVarDef { key: string; label: string }

/** custom_vars จาก API (JSON string หรือ array) → รายการที่ชื่อถูกต้อง (ข้อมูลเสีย = ว่าง) */
export function parseCustomVars(raw: any): CustomVarDef[] {
  let arr = raw;
  if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  const out: CustomVarDef[] = [];
  for (const v of arr) {
    const key = String(v?.key ?? '').trim().toLowerCase();
    if (!isValidVarKey(key) || out.some(x => x.key === key)) continue;
    out.push({ key, label: String(v?.label ?? '').trim() || key });
  }
  return out;
}

export function pctFormulaOf(item: any): string | null {
  const p = item?.pct_formula;
  return typeof p === 'string' && p.trim() ? p.trim() : null;
}

/** ช่องค่าเพิ่มเติมที่ต้องแสดง/กรอกของแถวนี้ = ที่ประกาศไว้ + base ถ้าสูตรผลงาน/สูตรร้อยละอ้าง base */
export function customVarDefsFor(item: any): CustomVarDef[] {
  const defs = parseCustomVars(item?.custom_vars);
  const used = new Set<string>();
  const f = activeFormula(item);
  if (f) formulaVarNames(f).forEach(n => used.add(n));
  const p = pctFormulaOf(item);
  if (p) formulaVarNames(p).forEach(n => used.add(n));
  if (used.has('base') && !defs.some(d => d.key === 'base')) defs.unshift({ key: 'base', label: 'ค่าฐาน' });
  return defs;
}

/** ค่าเพิ่มเติมของแถวนี้สำหรับส่งเข้าสูตร { base, pop, … } (อ่านจาก cv_<key>) */
export function customValuesOf(item: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const d of customVarDefsFor(item)) out[d.key] = item?.['cv_' + d.key] ?? null;
  return out;
}

/** ร้อยละตามสูตรร้อยละของตัวชี้วัด — null = ไม่ได้ตั้งสูตร/คำนวณไม่ได้ */
export function evaluatePct(item: any): number | null {
  const p = pctFormulaOf(item);
  if (!p) return null;
  try {
    const v = evaluateFormula(p, item, item?.target_value, item?.prev_year, { ...customValuesOf(item), result: item?.last_actual });
    return v === null ? null : Number(v);
  } catch { return null; }
}
