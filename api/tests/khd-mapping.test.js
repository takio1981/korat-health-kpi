/**
 * Unit tests: จับคู่ค่าข้อความของ KHD (หน่วยงาน / หมวดหมู่หลัก / ยุทธศาสตร์) กับ Local — api/khd-mapping.js (19 ต.ค. 2569)
 */
const { buildKhdResolver, normKhd, khdKey } = require('../khd-mapping');

const departments = [
    { id: 1, dept_code: 'ยสต.', dept_name: 'กลุ่มงานยาเสพติดและสุขภาพจิต' },
    { id: 6, dept_code: 'NCD', dept_name: 'กลุ่มงานควบคุมโรคไม่ติดต่อและผู้พิการ' },
];
const strategies = [
    { id: 1, yut_name: 'ยุทธศาสตร์ที่ 1. ด้านส่งเสริมสุขภาพ (37)' },
    { id: 2, yut_name: 'ยุทธศาสตร์ที่ 2. พัฒนาระบบบริการที่เป็นเลิศ(Service Excellence) (9)' },
    { id: 7, yut_name: 'รอบรู้ เพื่ออยู่อย่างมีคุณภาพชีวิต' },
];
const mainIndicators = [{ id: 11, main_indicator_name: 'การท่องเที่ยวเชิงสุขภาพ', yut_id: 7 }];
const make = (mappings = []) => buildKhdResolver({ departments, strategies, mainIndicators, mappings });

describe('khd-mapping', () => {
    test('normKhd รวมช่องว่าง/แท็บ ตัดหัวท้าย และไม่สนตัวพิมพ์ — key เดียวกัน', () => {
        expect(normKhd('  เก้าเชิงรุก (Proactive)\t\t ')).toBe('เก้าเชิงรุก (proactive)');
        expect(khdKey('NCD ')).toBe(khdKey('ncd'));
    });

    test('หน่วยงาน: KHD เก็บรหัสหน่วยงาน → ตรงกับ dept_code (เดิมเทียบชื่อ ไม่ตรงเลย)', () => {
        const r = make();
        expect(r.resolve('dept', 'NCD')).toEqual(expect.objectContaining({ status: 'auto', local_id: 6 }));
        expect(r.resolve('dept', 'ยสต.')).toEqual(expect.objectContaining({ status: 'auto', local_id: 1 }));
        expect(r.resolve('dept', 'กลุ่มงานยาเสพติดและสุขภาพจิต').local_id).toBe(1);   // ชื่อเต็มก็ได้
        expect(r.resolve('dept', 'ทต.').status).toBe('unmatched');
        expect(r.resolve('dept', '  ').status).toBe('empty');
    });

    test('ยุทธศาสตร์: ตรงชื่อ หรือตรงเมื่อตัดจำนวนท้ายชื่อ "(n)" — ต้องได้ผลเดียว', () => {
        const r = make();
        expect(r.resolve('yut', 'ยุทธศาสตร์ที่ 1. ด้านส่งเสริมสุขภาพ (37)').local_id).toBe(1);
        expect(r.resolve('yut', 'ยุทธศาสตร์ที่ 2. พัฒนาระบบบริการที่เป็นเลิศ(Service Excellence)').local_id).toBe(2);
        expect(r.resolve('yut', 'ยุทธศาสตร์ที่ 1 ด้านส่งเสริมสุขภาพ (PP&P Excellence) 3 แผนงาน').status).toBe('unmatched');
        const dup = buildKhdResolver({ strategies: [{ id: 1, yut_name: 'ก (1)' }, { id: 2, yut_name: 'ก (2)' }] });
        expect(dup.resolve('yut', 'ก').status).toBe('unmatched');   // ตัดจำนวนแล้วได้ 2 รายการ = ไม่เดา
    });

    test('การจับคู่ที่ตั้งไว้มาก่อนการจับคู่อัตโนมัติ / ตั้งว่าไม่ต้องจับคู่ / จับคู่กับรายการที่ถูกลบ = ใช้อัตโนมัติ', () => {
        const r = make([
            { kind: 'dept', khd_key: khdKey('NCD'), local_id: 1 },
            { kind: 'yut', khd_key: khdKey('Happy เขตแห่งความสุข'), local_id: null },
            { kind: 'dept', khd_key: khdKey('ยสต.'), local_id: 999 },
        ]);
        expect(r.resolve('dept', 'ncd')).toEqual(expect.objectContaining({ status: 'mapped', local_id: 1 }));
        expect(r.resolve('yut', 'Happy  เขตแห่งความสุข').status).toBe('ignored');
        expect(r.resolve('dept', 'ยสต.')).toEqual(expect.objectContaining({ status: 'auto', local_id: 1 }));
    });

    test('resolveIndicator: ค่าจาก KHD มาก่อนค่าที่เลือกในหน้าต่าง / ค่าที่จับคู่ไม่ได้ใช้ค่าที่เลือก / ยุทธศาสตร์จากหมวดหมู่หลักเมื่อ KHD ไม่มี', () => {
        const r = make();
        const a = r.resolveIndicator({ dept: 'NCD', main_yut: 'รอบรู้ เพื่ออยู่อย่างมีคุณภาพชีวิต', main_indicator: '' }, { dept_id: 1, main_indicator_id: 11 });
        expect(a).toEqual(expect.objectContaining({ dept_id: 6, main_indicator_id: 11, main_yut: 7, unmatched: [] }));
        const b = r.resolveIndicator({ dept: 'ทต.', main_yut: null, main_indicator: 'การท่องเที่ยวเชิงสุขภาพ' }, { dept_id: 1 });
        expect(b).toEqual(expect.objectContaining({ dept_id: 1, main_indicator_id: 11, main_yut: 7, unmatched: ['dept'] }));
        const c = r.resolveIndicator({ dept: null, main_yut: 'อื่นๆ', main_indicator: null });
        expect(c).toEqual(expect.objectContaining({ dept_id: null, main_indicator_id: null, main_yut: null, unmatched: ['yut'] }));
    });
});
