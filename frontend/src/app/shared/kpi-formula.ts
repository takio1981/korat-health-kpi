/**
 * สูตรคำนวณผลงานเฉพาะตัวชี้วัด (kpi_indicators.result_formula) — สำเนา TypeScript ของ api/kpi-formula.js
 *
 * ⚠️ ตรรกะต้องตรงกับ api/kpi-formula.js ทุกบรรทัด — แก้ที่หนึ่งต้องแก้อีกที่ และ fixture ร่วม
 *    kpi-formula.cases.json (สำเนาของ api/tests/fixtures/formula-cases.json — มี jest test บังคับให้ตรงกัน)
 * ห้ามใช้ eval / new Function เด็ดขาด (สูตรมาจากผู้ใช้)
 */

export const FISCAL_MONTH_VARS = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];
export const PREV_MONTH_VARS = FISCAL_MONTH_VARS.map(m => 'prev_' + m);
const PREV_SCALARS = ['prev_target', 'prev_result'];
/** ข้อมูลปีงบที่แล้วของคู่ตัวชี้วัด×หน่วยบริการเดียวกัน (GET /kpi-results ส่งมาเป็น row.prev_year) */
export interface PrevYearData { months?: Record<string, any> | null; target?: any; result?: any; }
const MONTH_NAME_TO_VAR: Record<string, string> = {
  oct: 'm10', nov: 'm11', dece: 'm12', dec: 'm12', jan: 'm01', feb: 'm02', mar: 'm03',
  apr: 'm04', may: 'm05', jun: 'm06', jul: 'm07', aug: 'm08', sep: 'm09'
};
export const FORMULA_FUNCTIONS = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'LAST'];
export const MAX_FORMULA_LENGTH = 500;

// ===== ตัวชี้วัดวัดผลรายไตรมาส (kpi_indicators.quarter_mode — 10 พ.ย. 2569) =====
// ไตรมาส 1 = ต.ค.–ธ.ค. … ไตรมาส 4 = ก.ค.–ก.ย. | ค่าของไตรมาสที่บันทึกรายไตรมาสเก็บที่เดือนสุดท้ายของไตรมาส (ธ.ค./มี.ค./มิ.ย./ก.ย.)
// quarter_mode: 'quarter' = บันทึกรายไตรมาส | 'month_sum' / 'month_last' / 'month_avg' = บันทึกรายเดือน ค่าไตรมาส = รวม / เดือนสุดท้าย / เฉลี่ย 3 เดือน
// ฟังก์ชันสูตร LASTQ(SUM|AVG|LAST) = ค่าของไตรมาสล่าสุดที่มีข้อมูล (ผลงานของตัวชี้วัดรายไตรมาสที่บันทึกรายเดือน)
export const QUARTER_MONTH_VARS = [['m10', 'm11', 'm12'], ['m01', 'm02', 'm03'], ['m04', 'm05', 'm06'], ['m07', 'm08', 'm09']];
export const QUARTER_END_VARS = ['m12', 'm03', 'm06', 'm09'];
const QUARTER_AGGS = ['SUM', 'AVG', 'LAST'];
export const QUARTER_MODES = ['quarter', 'month_sum', 'month_last', 'month_avg'];

// ===== ตัวแปรที่ตั้งชื่อเอง (ค่าเพิ่มเติมรายหน่วยบริการ เช่น base, pop) — 25 ต.ค. 2569 =====
// ชื่อ: a-z ตามด้วย a-z 0-9 _ ไม่เกิน 20 ตัว ห้ามชนชื่อในตัว (เดือน/target/result/prev_*/ฟังก์ชัน/ALL) และชื่อของ Object.prototype
export const RESERVED_VAR_NAMES = ['target', 'result', 'all', 'prev_all', 'lastq', ...FORMULA_FUNCTIONS.map(f => f.toLowerCase())];
const DEFAULT_CUSTOM_VARS = ['base'];   // base ใช้ได้เสมอ (ค่าฐาน)
export function isValidVarKey(key: any): boolean {
  const k = String(key == null ? '' : key);
  if (!/^[a-z][a-z0-9_]{0,19}$/.test(k)) return false;
  if (RESERVED_VAR_NAMES.includes(k) || k.startsWith('prev_') || /^m\d+$/.test(k)) return false;
  return !(k in Object.prototype);
}
/** รายชื่อตัวแปรที่สูตรใช้ได้ = base + ค่าที่ตั้งชื่อเอง (+ extra เช่น 'result' สำหรับสูตรร้อยละ) */
export function allowedVars(customKeys?: any[] | null, extra?: string[] | null): string[] {
  const out = [...DEFAULT_CUSTOM_VARS];
  for (const k of (customKeys || [])) { const v = String(k).toLowerCase(); if (isValidVarKey(v) && !out.includes(v)) out.push(v); }
  for (const k of (extra || [])) if (!out.includes(k)) out.push(k);
  return out;
}

type Token = { type: string; value?: any; pos: number };
type Node =
  | { type: 'num'; value: number }
  | { type: 'var'; name: string }
  | { type: 'neg'; arg: Node }
  | { type: 'bin'; op: string; left: Node; right: Node }
  | { type: 'fn'; name: string; months: string[]; agg?: string };

class FormulaError extends Error {}

function formulaError(message: string, pos?: number): FormulaError {
  return new FormulaError(pos === undefined ? message : `${message} (ตำแหน่งที่ ${pos + 1})`);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      if (!/^(\d+(\.\d+)?|\.\d+)$/.test(text)) throw formulaError(`ตัวเลขไม่ถูกต้อง "${text}"`, i);
      tokens.push({ type: 'num', value: parseFloat(text), pos: i });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ type: 'name', value: src.slice(i, j), pos: i });
      i = j; continue;
    }
    if ('+-*/(),'.includes(ch)) { tokens.push({ type: ch, pos: i }); i++; continue; }
    throw formulaError(`ใช้อักขระ "${ch}" ในสูตรไม่ได้`, i);
  }
  tokens.push({ type: 'end', pos: src.length });
  return tokens;
}

// custom = รายชื่อตัวแปรที่ตั้งชื่อเองที่อนุญาต (ค่าตั้งต้น ['base']) หรือ '*' = รับทุกชื่อ (ใช้ตอนคำนวณ — ตรวจชื่อแล้วตอนบันทึกตัวชี้วัด)
function normalizeVar(name: string, custom: string[] | '*' = DEFAULT_CUSTOM_VARS): string | null {
  const n = name.toLowerCase();
  if (n === 'target' || PREV_SCALARS.includes(n)) return n;
  if (FISCAL_MONTH_VARS.includes(n) || PREV_MONTH_VARS.includes(n)) return n;
  if (/^m[1-9]$/.test(n)) return 'm0' + n[1];
  if (/^prev_m[1-9]$/.test(n)) return 'prev_m0' + n[6];
  if (custom === '*') return /^[a-z][a-z0-9_]*$/.test(n) && !n.startsWith('prev_') && !/^m\d+$/.test(n) && n !== 'all' ? n : null;
  return Array.isArray(custom) && custom.includes(n) ? n : null;
}
const isMonthVar = (v: string) => FISCAL_MONTH_VARS.includes(v) || PREV_MONTH_VARS.includes(v);

export function parseFormula(src: string, custom: string[] | '*' = DEFAULT_CUSTOM_VARS): Node {
  if (typeof src !== 'string' || !src.trim()) throw formulaError('สูตรว่าง');
  if (src.length > MAX_FORMULA_LENGTH) throw formulaError(`สูตรยาวเกิน ${MAX_FORMULA_LENGTH} ตัวอักษร`);
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const expect = (type: string, msg: string) => {
    const t = next();
    if (t.type !== type) throw formulaError(msg, t.pos);
    return t;
  };

  function parseExpr(): Node {
    let node = parseTerm();
    while (peek().type === '+' || peek().type === '-') {
      const op = next().type;
      node = { type: 'bin', op, left: node, right: parseTerm() };
    }
    return node;
  }
  function parseTerm(): Node {
    let node = parseUnary();
    while (peek().type === '*' || peek().type === '/') {
      const op = next().type;
      node = { type: 'bin', op, left: node, right: parseUnary() };
    }
    return node;
  }
  function parseUnary(): Node {
    if (peek().type === '-') { next(); return { type: 'neg', arg: parseUnary() }; }
    if (peek().type === '+') { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary(): Node {
    const t = next();
    if (t.type === 'num') return { type: 'num', value: t.value };
    if (t.type === '(') {
      const node = parseExpr();
      expect(')', 'ขาดวงเล็บปิด ")"');
      return node;
    }
    if (t.type === 'name') {
      const upper = String(t.value).toUpperCase();
      if (upper === 'LASTQ') {
        expect('(', 'ฟังก์ชัน LASTQ ต้องตามด้วยวงเล็บ เช่น LASTQ(SUM)');
        const a = next();
        const agg = a.type === 'name' ? String(a.value).toUpperCase() : '';
        if (!QUARTER_AGGS.includes(agg)) throw formulaError('อาร์กิวเมนต์ของ LASTQ ต้องเป็น SUM, AVG หรือ LAST', a.pos);
        expect(')', 'ขาดวงเล็บปิดของ LASTQ');
        return { type: 'fn', name: 'LASTQ', agg, months: [...FISCAL_MONTH_VARS] };
      }
      if (FORMULA_FUNCTIONS.includes(upper)) {
        expect('(', `ฟังก์ชัน ${upper} ต้องตามด้วยวงเล็บ เช่น ${upper}(ALL)`);
        const months: string[] = [];
        const allKw = peek().type === 'name' ? String(peek().value).toUpperCase() : '';
        if (allKw === 'ALL' || allKw === 'PREV_ALL') {
          next();
          months.push(...(allKw === 'ALL' ? FISCAL_MONTH_VARS : PREV_MONTH_VARS));
        } else {
          do {
            const a = next();
            const v = a.type === 'name' ? normalizeVar(a.value) : null;
            if (!v || !isMonthVar(v)) {
              throw formulaError(`อาร์กิวเมนต์ของ ${upper} ต้องเป็นเดือน (m10–m09, prev_m10–prev_m09) หรือ ALL / PREV_ALL`, a.pos);
            }
            months.push(v);
          } while (peek().type === ',' && next());
        }
        expect(')', `ขาดวงเล็บปิดของ ${upper}`);
        return { type: 'fn', name: upper, months };
      }
      if (upper === 'ALL' || upper === 'PREV_ALL') throw formulaError(`${upper} ใช้ได้เฉพาะในฟังก์ชัน เช่น SUM(${upper})`, t.pos);
      const v = normalizeVar(t.value, custom);
      if (!v) throw formulaError(`ไม่รู้จัก "${t.value}" (ใช้ได้: m10–m09, target, ${Array.isArray(custom) ? custom.join(', ') + ', ' : ''}prev_m10–prev_m09, prev_target, prev_result, ${FORMULA_FUNCTIONS.join('/')})`, t.pos);
      return { type: 'var', name: v };
    }
    if (t.type === 'end') throw formulaError('สูตรไม่สมบูรณ์', t.pos);
    throw formulaError(`ไม่คาดว่าจะพบ "${t.type}"`, t.pos);
  }

  const ast = parseExpr();
  if (peek().type !== 'end') throw formulaError('มีส่วนเกินท้ายสูตร', peek().pos);
  return ast;
}

function toNumber(v: any): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;
  return parseFloat(s);
}

type EvalCtx = { months: Record<string, number | null>; target: number | null; prevTarget: number | null; prevResult: number | null; vars: Record<string, number | null> };

function evalNode(node: Node, ctx: EvalCtx): number | null {
  switch (node.type) {
    case 'num': return node.value;
    case 'var':
      if (node.name === 'target') return ctx.target;
      if (node.name === 'prev_target') return ctx.prevTarget;
      if (node.name === 'prev_result') return ctx.prevResult;
      if (Object.prototype.hasOwnProperty.call(ctx.months, node.name)) return ctx.months[node.name];
      // ตัวแปรที่ตั้งชื่อเอง (base, pop, result …) — อ่านเฉพาะ own property (กันชื่อของ Object.prototype)
      return Object.prototype.hasOwnProperty.call(ctx.vars, node.name) ? ctx.vars[node.name] : null;
    case 'neg': { const v = evalNode(node.arg, ctx); return v === null ? null : -v; }
    case 'bin': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      if (a === null || b === null) return null;
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      return b === 0 ? null : a / b;
    }
    case 'fn': {
      if (node.name === 'LASTQ') return lastQuarterValue(node.agg || 'LAST', ctx.months);
      const vals = node.months.map(m => ctx.months[m]).filter((v): v is number => v !== null);
      if (node.name === 'COUNT') return vals.length;
      if (vals.length === 0) return null;
      if (node.name === 'SUM') return vals.reduce((s, v) => s + v, 0);
      if (node.name === 'AVG') return vals.reduce((s, v) => s + v, 0) / vals.length;
      if (node.name === 'MAX') return Math.max(...vals);
      if (node.name === 'MIN') return Math.min(...vals);
      return vals[vals.length - 1];
    }
  }
  return null;
}

/** รวมค่า 3 เดือนของไตรมาส (เรียงตามเดือน) — ไม่มีค่าเลย = null */
function aggQuarter(agg: string, vals: (number | null | undefined)[]): number | null {
  const v = vals.filter((x): x is number => x !== null && x !== undefined);
  if (v.length === 0) return null;
  if (agg === 'SUM') return v.reduce((s, x) => s + x, 0);
  if (agg === 'AVG') return v.reduce((s, x) => s + x, 0) / v.length;
  return v[v.length - 1];
}
/** ค่าของไตรมาสล่าสุด (ไตรมาส 4 → 1) ที่มีข้อมูล */
function lastQuarterValue(agg: string, months: Record<string, number | null>): number | null {
  for (let q = 3; q >= 0; q--) {
    const r = aggQuarter(agg, QUARTER_MONTH_VARS[q].map(m => months[m] ?? null));
    if (r !== null) return r;
  }
  return null;
}

export function normalizeMonths(input: Record<string, any> | null | undefined, prefix = ''): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const v of FISCAL_MONTH_VARS) out[prefix + v] = null;
  if (!input) return out;
  for (const [k, val] of Object.entries(input)) {
    const key = MONTH_NAME_TO_VAR[k] || normalizeVar(k);
    if (key && FISCAL_MONTH_VARS.includes(key)) out[prefix + key] = toNumber(val);
  }
  return out;
}

function formatResult(n: number | null): string | null {
  if (n === null || !isFinite(n)) return null;
  const r = Math.round(n * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

const astCache = new Map<string, Node>();
function getAst(formula: string): Node {
  let ast = astCache.get(formula);
  if (!ast) {
    ast = parseFormula(formula, '*');
    if (astCache.size > 500) astCache.clear();
    astCache.set(formula, ast);
  }
  return ast;
}

/** คำนวณผลงานตามสูตร — คืน string หรือ null (คำนวณไม่ได้) — สูตรผิดจะ throw
 *  prev (ไม่บังคับ) = ข้อมูลปีงบที่แล้ว { months, target, result } — ไม่มี → ตัวแปร prev_* เป็น "ไม่มีค่า"
 *  vars (ไม่บังคับ) = ค่าเพิ่มเติมของคู่ตัวชี้วัด×หน่วยบริการ×ปีงบ { base, pop, … } — ส่งค่าเดียว = base (แบบเดิม) | สูตรร้อยละส่ง { …, result } */
function normalizeVars(vars: any): Record<string, number | null> {
  if (vars === null || vars === undefined) return {};
  if (typeof vars !== 'object') return { base: toNumber(vars) };
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(vars)) out[String(k).toLowerCase()] = toNumber(v);
  return out;
}
export function evaluateFormula(formula: string, months: Record<string, any> | null | undefined, target: any,
                                prev?: PrevYearData | null, vars?: any): string | null {
  const ast = getAst(formula);
  return formatResult(evalNode(ast, {
    months: { ...normalizeMonths(months), ...normalizeMonths(prev?.months, 'prev_') },
    target: toNumber(target),
    prevTarget: toNumber(prev?.target),
    prevResult: toNumber(prev?.result),
    vars: normalizeVars(vars),
  }));
}

/** สูตรอ้างข้อมูลปีงบที่แล้ว (prev_* / PREV_ALL) หรือไม่ */
export function usesPrevYear(formula: string): boolean {
  let ast: Node;
  try { ast = getAst(formula); } catch { return false; }
  const walk = (n: Node): boolean => {
    if (n.type === 'var') return n.name.startsWith('prev_');
    if (n.type === 'fn') return n.months.some(m => m.startsWith('prev_'));
    if (n.type === 'neg') return walk(n.arg);
    if (n.type === 'bin') return walk(n.left) || walk(n.right);
    return false;
  };
  return walk(ast);
}

/** สูตรอ้างค่าฐาน (base) หรือไม่ — ใช้ตัดสินว่าต้องโหลด/แสดงค่าฐานหรือเปล่า */
export function usesBase(formula: string): boolean {
  let ast: Node;
  try { ast = getAst(formula); } catch { return false; }
  const walk = (n: Node): boolean => {
    if (n.type === 'var') return n.name === 'base';
    if (n.type === 'neg') return walk(n.arg);
    if (n.type === 'bin') return walk(n.left) || walk(n.right);
    return false;
  };
  return walk(ast);
}

/** ชื่อตัวแปรที่ตั้งชื่อเองที่สูตรใช้ (ไม่รวมเดือน/target/prev_*) */
export function formulaVarNames(formula: string): string[] {
  let ast: Node;
  try { ast = getAst(formula); } catch { return []; }
  const out = new Set<string>();
  const walk = (n: Node): void => {
    if (n.type === 'var' && n.name !== 'target' && !PREV_SCALARS.includes(n.name) && !isMonthVar(n.name)) out.add(n.name);
    if (n.type === 'neg') walk(n.arg);
    if (n.type === 'bin') { walk(n.left); walk(n.right); }
  };
  walk(ast);
  return [...out];
}

/** ตรวจสูตร — คืน null ถ้าถูกต้อง หรือข้อความผิดพลาดภาษาไทย
 *  customKeys = ชื่อค่าเพิ่มเติมของตัวชี้วัด (custom_vars) — base ใช้ได้เสมอ | extra เช่น ['result'] สำหรับสูตรร้อยละ */
export function validateFormula(formula: string, customKeys?: any[] | null, extra?: string[] | null): string | null {
  try { parseFormula(formula, allowedVars(customKeys, extra)); return null; } catch (e: any) { return e.message; }
}

export function normalizeQuarterMode(v: any): string {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return QUARTER_MODES.includes(s) ? s : '';
}
/** ค่าแต่ละไตรมาส [ไตรมาส 1..4] (string ปัด 2 ตำแหน่ง | null) — 'quarter' = ค่าที่เดือนสุดท้ายของไตรมาส, ไม่ใช่ตัวชี้วัดรายไตรมาส = null ทั้งหมด */
export function quarterValues(mode: any, months: Record<string, any> | null | undefined): (string | null)[] {
  const m = normalizeQuarterMode(mode);
  if (!m) return [null, null, null, null];
  const mv = normalizeMonths(months);
  const agg = m === 'month_sum' ? 'SUM' : m === 'month_avg' ? 'AVG' : 'LAST';
  return QUARTER_MONTH_VARS.map((qm, q) => formatResult(m === 'quarter' ? mv[QUARTER_END_VARS[q]] : aggQuarter(agg, qm.map(k => mv[k]))));
}
/** สูตรผลงาน "ค่าไตรมาสล่าสุด" ของโหมดบันทึกรายเดือน (รวม/เฉลี่ย) — โหมดอื่น = null (ผลงานล่าสุดแบบเดิมให้ค่าเดียวกันอยู่แล้ว) */
export function quarterResultFormula(mode: any): string | null {
  const m = normalizeQuarterMode(mode);
  return m === 'month_sum' ? 'LASTQ(SUM)' : m === 'month_avg' ? 'LASTQ(AVG)' : null;
}
/** เดือนนี้บันทึกผลงานได้หรือไม่ — โหมด 'quarter' ได้เฉพาะเดือนสุดท้ายของไตรมาส (รับ oct/dece/m12/12 ได้) */
export function isQuarterEntryMonth(mode: any, month: any): boolean {
  if (normalizeQuarterMode(mode) !== 'quarter') return true;
  const k = String(month == null ? '' : month).trim().toLowerCase();
  const v = MONTH_NAME_TO_VAR[k] || (/^\d{1,2}$/.test(k) ? 'm' + String(Number(k)).padStart(2, '0') : normalizeVar(k));
  return QUARTER_END_VARS.includes(String(v));
}

/** ค่า result_formula ที่ใช้งานได้ (trim แล้ว) หรือ null ถ้าไม่ได้ตั้ง */
export function activeFormula(indicator: any): string | null {
  const f = indicator && indicator.result_formula;
  return typeof f === 'string' && f.trim() ? f.trim() : null;
}
