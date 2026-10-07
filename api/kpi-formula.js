/**
 * สูตรคำนวณผลงานเฉพาะตัวชี้วัด (kpi_indicators.result_formula)
 *
 * ภาษาสูตรเล็กๆ ที่ parse เอง — **ห้ามใช้ eval / new Function เด็ดขาด** (สูตรมาจากผู้ใช้)
 *   ตัวแปร:   m10 m11 m12 m01 … m09 (ต.ค.–ก.ย.), target (เป้าหมาย)
 *   ฟังก์ชัน:  SUM AVG MAX MIN COUNT LAST — อาร์กิวเมนต์เป็นรายการเดือน หรือ ALL (12 เดือน)
 *   ตัวดำเนินการ: + - * /  วงเล็บ  ตัวเลข
 * ค่าว่าง/ข้อความ (เช่น "รอดำเนินการ") = ไม่มีค่า: ฟังก์ชันข้ามไป, อ้างตรงในนิพจน์ → ผลเป็น null
 * หารศูนย์ → null | ผลลัพธ์ปัด 2 ตำแหน่ง คืนเป็น string (เหมือน last_actual เดิม) หรือ null ถ้าคำนวณไม่ได้
 *
 * ⚠️ มีสำเนา TypeScript ที่ frontend/src/app/shared/kpi-formula.ts — แก้ตรรกะต้องแก้ทั้ง 2 ไฟล์
 *    และ fixture ร่วม api/tests/fixtures/formula-cases.json (มี test บังคับให้ 2 สำเนา fixture ตรงกัน)
 */

const FISCAL_MONTH_VARS = ['m10', 'm11', 'm12', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09'];
const MONTH_NAME_TO_VAR = {
    oct: 'm10', nov: 'm11', dece: 'm12', dec: 'm12', jan: 'm01', feb: 'm02', mar: 'm03',
    apr: 'm04', may: 'm05', jun: 'm06', jul: 'm07', aug: 'm08', sep: 'm09'
};
const FUNCTIONS = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT', 'LAST'];
const MAX_FORMULA_LENGTH = 500;

function formulaError(message, pos) {
    const e = new Error(pos === undefined ? message : `${message} (ตำแหน่งที่ ${pos + 1})`);
    e.isFormulaError = true;
    return e;
}

function tokenize(src) {
    const tokens = [];
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

/** แปลงชื่อเป็นตัวแปรที่อนุญาต (ไม่สนตัวพิมพ์เล็กใหญ่) — คืน null ถ้าไม่ใช่ตัวแปร */
function normalizeVar(name) {
    const n = name.toLowerCase();
    if (n === 'target') return 'target';
    if (FISCAL_MONTH_VARS.includes(n)) return n;
    if (/^m[1-9]$/.test(n)) return 'm0' + n[1]; // m1..m9 → m01..m09
    return null;
}

/** parse สูตร → AST — throw Error (isFormulaError) พร้อมข้อความภาษาไทยถ้าสูตรผิด */
function parseFormula(src) {
    if (typeof src !== 'string' || !src.trim()) throw formulaError('สูตรว่าง');
    if (src.length > MAX_FORMULA_LENGTH) throw formulaError(`สูตรยาวเกิน ${MAX_FORMULA_LENGTH} ตัวอักษร`);
    const tokens = tokenize(src);
    let p = 0;
    const peek = () => tokens[p];
    const next = () => tokens[p++];
    const expect = (type, msg) => {
        const t = next();
        if (t.type !== type) throw formulaError(msg, t.pos);
        return t;
    };

    function parseExpr() {
        let node = parseTerm();
        while (peek().type === '+' || peek().type === '-') {
            const op = next().type;
            node = { type: 'bin', op, left: node, right: parseTerm() };
        }
        return node;
    }
    function parseTerm() {
        let node = parseUnary();
        while (peek().type === '*' || peek().type === '/') {
            const op = next().type;
            node = { type: 'bin', op, left: node, right: parseUnary() };
        }
        return node;
    }
    function parseUnary() {
        if (peek().type === '-') { next(); return { type: 'neg', arg: parseUnary() }; }
        if (peek().type === '+') { next(); return parseUnary(); }
        return parsePrimary();
    }
    function parsePrimary() {
        const t = next();
        if (t.type === 'num') return { type: 'num', value: t.value };
        if (t.type === '(') {
            const node = parseExpr();
            expect(')', 'ขาดวงเล็บปิด ")"');
            return node;
        }
        if (t.type === 'name') {
            const upper = t.value.toUpperCase();
            if (FUNCTIONS.includes(upper)) {
                expect('(', `ฟังก์ชัน ${upper} ต้องตามด้วยวงเล็บ เช่น ${upper}(ALL)`);
                const months = [];
                if (peek().type === 'name' && peek().value.toUpperCase() === 'ALL') {
                    next();
                    months.push(...FISCAL_MONTH_VARS);
                } else {
                    do {
                        const a = next();
                        const v = a.type === 'name' ? normalizeVar(a.value) : null;
                        if (!v || v === 'target') {
                            throw formulaError(`อาร์กิวเมนต์ของ ${upper} ต้องเป็นเดือน (m10–m09) หรือ ALL`, a.pos);
                        }
                        months.push(v);
                    } while (peek().type === ',' && next());
                }
                expect(')', `ขาดวงเล็บปิดของ ${upper}`);
                return { type: 'fn', name: upper, months };
            }
            if (upper === 'ALL') throw formulaError('ALL ใช้ได้เฉพาะในฟังก์ชัน เช่น SUM(ALL)', t.pos);
            const v = normalizeVar(t.value);
            if (!v) throw formulaError(`ไม่รู้จัก "${t.value}" (ใช้ได้: m10–m09, target, ${FUNCTIONS.join('/')})`, t.pos);
            return { type: 'var', name: v };
        }
        if (t.type === 'end') throw formulaError('สูตรไม่สมบูรณ์', t.pos);
        throw formulaError(`ไม่คาดว่าจะพบ "${t.type}"`, t.pos);
    }

    const ast = parseExpr();
    if (peek().type !== 'end') throw formulaError('มีส่วนเกินท้ายสูตร', peek().pos);
    return ast;
}

/** ค่าที่เป็นตัวเลขเท่านั้นถึงนับว่ามีค่า ("", null, "รอดำเนินการ" = ไม่มีค่า) */
function toNumber(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!/^-?(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;
    return parseFloat(s);
}

function evalNode(node, ctx) {
    switch (node.type) {
        case 'num': return node.value;
        case 'var': return node.name === 'target' ? ctx.target : ctx.months[node.name];
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
            const vals = node.months.map(m => ctx.months[m]).filter(v => v !== null);
            if (node.name === 'COUNT') return vals.length;
            if (vals.length === 0) return null;
            if (node.name === 'SUM') return vals.reduce((s, v) => s + v, 0);
            if (node.name === 'AVG') return vals.reduce((s, v) => s + v, 0) / vals.length;
            if (node.name === 'MAX') return Math.max(...vals);
            if (node.name === 'MIN') return Math.min(...vals);
            return vals[vals.length - 1]; // LAST = เดือนสุดท้ายตามลำดับที่ระบุที่มีค่า
        }
    }
    return null;
}

/** รับเดือนได้หลายรูปแบบ: { oct, nov, dece, … } หรือ { m10, m11, … } → { m10: number|null, … } */
function normalizeMonths(input) {
    const out = {};
    for (const v of FISCAL_MONTH_VARS) out[v] = null;
    if (!input) return out;
    for (const [k, val] of Object.entries(input)) {
        const key = MONTH_NAME_TO_VAR[k] || normalizeVar(k);
        if (key && key !== 'target') out[key] = toNumber(val);
    }
    return out;
}

function formatResult(n) {
    if (n === null || !isFinite(n)) return null;
    const r = Math.round(n * 100) / 100;
    return String(Object.is(r, -0) ? 0 : r);
}

const _astCache = new Map();
/**
 * คำนวณผลงานตามสูตร — คืน string (ผลงาน) หรือ null (คำนวณไม่ได้)
 * สูตรผิดจะ throw (validate ตอนบันทึกตัวชี้วัดแล้ว ปกติจึงไม่เกิด)
 */
function evaluateFormula(formula, months, target) {
    let ast = _astCache.get(formula);
    if (!ast) {
        ast = parseFormula(formula);
        if (_astCache.size > 500) _astCache.clear();
        _astCache.set(formula, ast);
    }
    return formatResult(evalNode(ast, { months: normalizeMonths(months), target: toNumber(target) }));
}

/** ตรวจสูตร — คืน null ถ้าถูกต้อง หรือข้อความผิดพลาดภาษาไทย */
function validateFormula(formula) {
    try { parseFormula(formula); return null; } catch (e) { return e.message; }
}

/** ค่า result_formula ที่ใช้งานได้ (trim แล้ว) หรือ null ถ้าไม่ได้ตั้ง */
function activeFormula(indicator) {
    const f = indicator && indicator.result_formula;
    return typeof f === 'string' && f.trim() ? f.trim() : null;
}

module.exports = {
    FISCAL_MONTH_VARS, FUNCTIONS, MAX_FORMULA_LENGTH,
    parseFormula, evaluateFormula, validateFormula, activeFormula, normalizeMonths
};
