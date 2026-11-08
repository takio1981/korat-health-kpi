/**
 * ระบบเตือนล่วงหน้า ระยะที่ 1 (8 พ.ย. 2569): แบบจำลองคาดการณ์ผลงาน ณ สิ้นปีงบ + ระดับความเสี่ยง (kpi-forecast.js — ฟังก์ชันล้วน)
 * ตามข้อเสนอแนวคิด: สะสม = run-rate, ค่าล่าสุด = แนวโน้มเชิงเส้น, สูตร = เติมเดือนแล้วคำนวณตามสูตรเดิม
 * ระดับ: ปกติ / เฝ้าระวัง (ต่ำกว่าเป้า ≤ 10%) / เสี่ยงสูง / ขาดการรายงาน (ว่าง ≥ 2 เดือนล่าสุด) / ข้อมูลไม่พอ (< 3 เดือน)
 */
const { forecastPair, backtestPair, evaluateBacktest: evaluate, throughIndex, MONTH_KEYS, DEFAULTS } = require('../kpi-forecast');

const m = (...vals) => Object.fromEntries(MONTH_KEYS.map((k, i) => [k, vals[i] === undefined ? '' : vals[i]]));

describe('throughIndex — เดือนล่าสุดที่ควรรายงานแล้ว (รายงานช้า 1 เดือน)', () => {
    test('ปีงบ 2570 (ต.ค. 2026 – ก.ย. 2027)', () => {
        expect(throughIndex(2570, new Date(2026, 10, 8))).toBe(0);    // 8 พ.ย. 2569 → ต.ค.
        expect(throughIndex(2570, new Date(2026, 9, 15))).toBe(-1);   // ยังอยู่ใน ต.ค. → ยังไม่มีเดือนที่ควรรายงาน
        expect(throughIndex(2570, new Date(2027, 3, 1))).toBe(5);     // เม.ย. → มี.ค.
        expect(throughIndex(2570, new Date(2027, 9, 5))).toBe(11);    // สิ้นปีงบแล้ว
        expect(throughIndex(2569, new Date(2026, 10, 8))).toBe(11);
    });
});

describe('forecastPair — วิธีคาดการณ์ตามประเภทตัวชี้วัด', () => {
    test('ค่าเริ่มต้น = แนวโน้มเชิงเส้น (เลือกจากการทดสอบย้อนหลังข้อมูลจริง)', () => expect(DEFAULTS.method).toBe('linear'));

    test('สะสม: run-rate × 12 เดือน → ผ่านเกณฑ์ = ปกติ', () => {
        const r = forecastPair({ months: m(10, 10, 10, 10, 10, 10), target: 100, cumulative: 1 }, { through: 5 });
        expect(r).toMatchObject({ status: 'normal', method: 'run_rate', projected: '120', points: 6, confidence: 'high' });
    });
    test('ค่าล่าสุด: แนวโน้มขึ้นเป็นเส้นตรง → ค่า ก.ย. = 70 + 10×9', () => {
        const r = forecastPair({ months: m(50, 60, 70), target: 80 }, { through: 2 });
        expect(r).toMatchObject({ status: 'normal', method: 'linear', projected: '160', confidence: 'low' });
    });
    test('แนวโน้มลดลง ค่าคาดการณ์ไม่ติดลบ → เสี่ยงสูง', () => {
        const r = forecastPair({ months: m(90, 80, 70), target: 80 }, { through: 2 });
        expect(r).toMatchObject({ status: 'high', projected: '0', pct: 0, gap_pct: 100 });
    });
    test('ต่ำกว่าเป้าหมายไม่เกิน 10% = เฝ้าระวัง, เกิน = เสี่ยงสูง (ปรับเกณฑ์ได้)', () => {
        expect(forecastPair({ months: m(95, 95, 95), target: 100 }, { through: 2 })).toMatchObject({ status: 'watch', gap_pct: 5 });
        expect(forecastPair({ months: m(85, 85, 85), target: 100 }, { through: 2 })).toMatchObject({ status: 'high', gap_pct: 15 });
        expect(forecastPair({ months: m(85, 85, 85), target: 100 }, { through: 2, watchPct: 20 }).status).toBe('watch');
    });
    test('เงื่อนไข ≤ (ค่ายิ่งน้อยยิ่งดี) ใช้ evaluateTarget ตัวเดียวกับทั้งระบบ', () => {
        expect(forecastPair({ months: m(4, 4, 4), target: 8, condition: 'LTE' }, { through: 2 }).status).toBe('normal');
        const r = forecastPair({ months: m(10, 12, 14), target: 8, condition: 'LTE' }, { through: 2 });
        expect(r.status).toBe('high');            // แนวโน้มเพิ่มขึ้น 32 > 8
        expect(r.projected).toBe('32');
    });
    test('สูตร: เติมเดือนที่เหลือแล้วคำนวณตามสูตรเดิมของตัวชี้วัด', () => {
        const r = forecastPair({ months: m(10, 10, 10), target: 100, formula: 'SUM(ALL)' }, { through: 2 });
        expect(r).toMatchObject({ status: 'normal', method: 'formula:linear', projected: '120' });
    });
    test('ปีงบสิ้นสุดแล้ว = ผลจริง (ค่าล่าสุดที่มีข้อมูล)', () => {
        const r = forecastPair({ months: m(70, 75, 80, 85), target: 80 }, { through: 11, missingRun: 99 });
        expect(r).toMatchObject({ method: 'actual', confidence: 'actual', projected: '85', status: 'normal' });
    });
    test('ข้อความ (เช่น "รอดำเนินการ") ไม่นับเป็นจุดข้อมูล', () => {
        expect(forecastPair({ months: m(80, 'รอดำเนินการ', 80), target: 80 }, { through: 2, missingRun: 99 }).status).toBe('insufficient');
    });
});

describe('forecastPair — สถานะที่ไม่คาดการณ์', () => {
    test('ขาดการรายงาน: เดือนล่าสุดที่ควรรายงานว่างติดต่อกัน ≥ 2 เดือน (แยกจากการคาดการณ์)', () => {
        const r = forecastPair({ months: m(80, 80, 80), target: 80 }, { through: 4 });
        expect(r).toMatchObject({ status: 'no_report', missing_months: 2 });
        expect(forecastPair({ months: m(80, 80, 80), target: 80 }, { through: 3 }).status).toBe('normal'); // ว่าง 1 เดือนยังคาดการณ์
    });
    test('ข้อมูลน้อยกว่า 3 เดือน = ไม่คาดการณ์', () => {
        expect(forecastPair({ months: m(80, 80), target: 80 }, { through: 1 }).status).toBe('insufficient');
    });
    test('ไม่มีเป้าหมาย = no_target (ยังคืนค่าคาดการณ์)', () => {
        expect(forecastPair({ months: m(80, 80, 80), target: '' }, { through: 2 })).toMatchObject({ status: 'no_target', projected: '80' });
    });
    test('ไม่รองรับ: ผลงานกรอกเอง / สูตรอ้างปีงบที่แล้ว / สูตรใช้ค่าฐาน-ค่าเพิ่มเติมโดยไม่มีค่า', () => {
        const p = { months: m(80, 80, 80), target: 80 };
        expect(forecastPair({ ...p, manual: true }, { through: 2 }).status).toBe('unsupported');
        expect(forecastPair({ ...p, formula: 'm10 - prev_m10' }, { through: 2 }).reason).toBe('สูตรอ้างข้อมูลปีงบที่แล้ว');
        expect(forecastPair({ ...p, formula: '(base - SUM(ALL)) / base * 100' }, { through: 2 }).reason).toBe('สูตรใช้ค่าเพิ่มเติมที่ตั้งชื่อเอง');
        // มีค่าฐาน: (2000 − 80×12) / 2000 × 100 = 52 ≥ เป้าหมาย 30
        expect(forecastPair({ ...p, target: 30, formula: '(base - SUM(ALL)) / base * 100', vars: { base: 2000 } }, { through: 2 })).toMatchObject({ status: 'normal', projected: '52' });
    });
    test('เป้าหมายรายเดือนแบบสะสม: รวมเป้าทั้ง 12 เดือน', () => {
        const r = forecastPair({ months: m(10, 10, 10), targets: m(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10), targetMonthly: 'cumulative', cumulative: 1 }, { through: 2 });
        expect(r).toMatchObject({ target: '120', projected: '120', status: 'normal' });
    });
});

describe('ทดสอบย้อนหลัง (backtestPair / evaluate)', () => {
    test('ต้องมีข้อมูลหลังเดือนตัด — ไม่งั้นเทียบไม่ได้ (กันความแม่นยำสูงเกินจริง)', () => {
        expect(backtestPair({ months: m(80, 80, 80, 80), target: 80 }, 3)).toBeNull();
        expect(backtestPair({ months: m(80, 80, 80, 80, 90), target: 80 }, 3)).toMatchObject({ actualPass: true, predPass: true, correct: true });
    });
    test('evaluate นับถูก/เตือนครบ/เตือนแม่น', () => {
        const pairs = [
            { months: m(80, 80, 80, 80, 90), target: 80 },          // ผ่าน คาดผ่าน
            { months: m(50, 50, 50, 50, 50), target: 80 },          // ไม่ผ่าน คาดไม่ผ่าน (เตือนถูก)
            { months: m(60, 65, 70, 75, 95), target: 80 },          // ผ่านจริง คาด 75 + แนวโน้ม → ผ่าน
            { months: m(90, 85, 80, 75, 60), target: 80 },          // ไม่ผ่าน คาดลดลง → เตือน
            { months: m(80, 80), target: 80 },                       // ข้อมูลไม่พอ — ไม่นับ
        ];
        const r = evaluate(pairs, 3, 'linear');
        expect(r).toMatchObject({ compared: 4, correct: 4, accuracy_pct: 100, tp: 2, fn: 0, fp: 0, tn: 2 });
    });
});
