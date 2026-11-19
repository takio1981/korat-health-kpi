// 4. บันทึกผลงานตัวชี้วัด
// เลือกช่องผลงานรายเดือนที่ว่างและกรอกได้ — ต้องมองเห็นจริง ไม่อยู่ใต้คอลัมน์ที่ตรึงไว้ด้านซ้ายของตาราง
// (เดิมเลือกตามพิกัด x > 600 ทำให้บางสิทธิ์ได้ช่องที่ถูกคอลัมน์หน่วยบริการบัง แล้วกรอบเน้นไปอยู่หลังคอลัมน์)
const markEmptyCell = async (h) => h.page.evaluate(() => {
    document.querySelectorAll('[data-vg-cell]').forEach(e => e.removeAttribute('data-vg-cell'));
    const frozen = [...document.querySelectorAll('table td.frozen, table th.frozen, table td[class*="col-4"], table th[class*="col-4"]')]
        .map(e => e.getBoundingClientRect()).filter(r => r.width > 0);
    const edge = frozen.length ? Math.max(...frozen.map(r => r.right)) : 600;
    const ins = [...document.querySelectorAll('table tbody input')]
        .filter(i => !i.disabled && !i.readOnly && i.offsetParent && i.getBoundingClientRect().width > 0 && i.closest('td') && !i.closest('td.frozen'));
    ins.sort((a, b) => (a.value === '' ? 0 : 1) - (b.value === '' ? 0 : 1)); // ช่องว่างก่อน ไม่มีจึงใช้ช่องที่มีค่า (พิมพ์ทับ)
    const visible = (i) => { const r = i.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.left >= edge + 2 && r.right <= window.innerWidth - 4 && (t === i || i.contains(t)); };
    let pick = ins.find(i => i.value === '' && visible(i));
    // ไม่มีช่องที่มองเห็นอยู่แล้ว: เลื่อนหาช่องที่กรอกได้ (แนวตั้งให้อยู่กลางจอ แนวนอนให้พ้นคอลัมน์ที่ตรึงไว้)
    const wrapOf = (n) => { while (n && n !== document.body) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowX) && n.scrollWidth > n.clientWidth) return n; n = n.parentElement; } return null; };
    for (const i of ins.slice(0, 12)) {
        if (pick) break;
        i.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const wrap = wrapOf(i);
        if (wrap) wrap.scrollLeft += i.getBoundingClientRect().left - (edge + 40);
        if (visible(i)) pick = i;
    }
    if (!pick) pick = ins.find(visible);
    if (pick) { pick.setAttribute('data-vg-cell', '1'); return true; }
    return false;
});

module.exports = {
    id: 'dashboard',
    title: 'บันทึกผลงานตัวชี้วัด',
    roles: 'all',
    start: '/dashboard',
    steps: (r, rk) => [
        { say: `วิดีโอนี้แนะนำการใช้หน้าบันทึกผลงานตัวชี้วัด สำหรับ${r.short} ซึ่งเป็นหน้าแรกหลังเข้าสู่ระบบ` },
        { say: `ขอบเขตข้อมูลของสิทธิ์นี้ คือ ${r.scope}`, do: h => h.point('button:has-text("ประเภท รพ.")', 2500) },
        { say: 'ด้านบนเป็นตัวกรองข้อมูล เลือกโซน อำเภอ ประเภทหน่วยบริการ หน่วยบริการ และปีงบประมาณ ได้ตามต้องการ', do: async h => { if (await h.exists('button:has-text("หน่วยบริการ:")')) await h.point('button:has-text("หน่วยบริการ:")', 1200); await h.point('select[title="ปีงบประมาณ"], select', 1500); } },
        { say: 'แถวถัดมาใช้กรองตามกลุ่มงาน หมวดหมู่หลัก ตัวชี้วัด และประเภทตัวชี้วัด' + (r.deptLock ? ' สำหรับสิทธิ์นี้ ระบบล็อกกลุ่มงานไว้ที่กลุ่มงานของท่านโดยอัตโนมัติ' : ''), do: h => h.point('select:has-text("หมวดหมู่")', 2500) },
        r.central
            ? { say: 'สิทธิ์ของท่านมีข้อมูลจำนวนมาก ระบบจึงยังไม่แสดงข้อมูลทันที ต้องเลือกตัวกรองอย่างน้อยหนึ่งอย่าง เช่น อำเภอ หรือกลุ่มงาน แล้วกดปุ่มค้นหา', do: h => h.point('button:text-is("ค้นหา")', 2500) }
            : { say: 'สำหรับสิทธิ์นี้ ระบบแสดงข้อมูลตามขอบเขตของท่านให้อัตโนมัติ เมื่อเปลี่ยนตัวกรองให้กดปุ่มค้นหาอีกครั้ง', do: h => h.point('button:text-is("ค้นหา")', 2000) },
        { say: 'หรือพิมพ์คำค้นในช่องค้นหา เช่น ชื่อตัวชี้วัด แล้วกด Enter ระบบจะค้นภายในขอบเขตสิทธิ์ของท่านเท่านั้น', do: async h => { await h.type('#dashboard-search', 'มะเร็ง'); await h.key('Enter', 2500); await h.swal(); } },
        { say: 'ตารางแสดงตัวชี้วัด หน่วยบริการ เป้าหมาย ผลงานล่าสุด ร้อยละ และผลงานรายเดือน ตั้งแต่ตุลาคมถึงกันยายน', do: async h => { await h.scroll(250); await h.point('thead', 2500); } },
        { say: 'กดปุ่มดูแนวโน้ม เพื่อดูกราฟผลงานรายเดือนของตัวชี้วัดนั้น', do: async h => { await h.click('table button[title="ดูแนวโน้ม"] >> visible=true', 2500); await h.closeModal(); } },
        ...(r.central ? [
        // ผู้ดูแลส่วนกลาง (super_admin / admin_ssj): ตรวจสอบ อนุมัติ ส่งคืนแก้ไข ปลดล็อก (ไม่มีปุ่มแก้ไขผลงานทั้งตาราง)
        { say: 'สำหรับผู้ดูแลส่วนกลาง คอลัมน์จัดการมีปุ่มรับรองข้อมูล ส่งคืนแก้ไข และแก้ไขเป้าหมาย ของแต่ละแถว', do: async h => { await h.scroll(-600); await h.point('button[title="รับรองข้อมูล"]', 1300); await h.point('button[title="ส่งคืนแก้ไข"]', 1300); } },
        { say: 'กดปุ่มตรวจสอบ เพื่อเข้าโหมดตรวจสอบหลายรายการพร้อมกัน ตัวเลขบนปุ่มคือจำนวนผลงานที่รอตรวจสอบ', do: h => h.click('button:has-text("ตรวจสอบ")', 2500) },
        { say: 'ติ๊กเลือกแถวที่ตรวจสอบแล้ว จากนั้นกดอนุมัติที่เลือก หรือตีกลับที่เลือก พร้อมระบุเหตุผลให้หน่วยบริการแก้ไข', do: async h => { await h.click('input[title="เลือกเพื่อตรวจสอบ"] >> nth=0', 600); await h.click('input[title="เลือกเพื่อตรวจสอบ"] >> nth=1', 600); await h.point('button:has-text("อนุมัติที่เลือก")', 1500); } },
        { say: 'กดอนุมัติที่เลือก แล้วยืนยัน ผลงานที่อนุมัติแล้วจะถูกล็อก และหน่วยบริการจะได้รับแจ้งเตือน', do: async h => { await h.click('button:has-text("อนุมัติที่เลือก")', 2000); } },
        { keepSwal: true, say: rk === 'super_admin' ? 'หากต้องการให้แก้ไขผลงานที่อนุมัติแล้ว ใช้ปุ่มปลดล็อกในแถว หรือปลดล็อกทั้งหมด การทำงานทุกครั้งถูกบันทึกในประวัติการใช้งาน' : 'หากต้องการให้แก้ไขผลงานที่อนุมัติแล้ว ใช้ปุ่มปลดล็อกในแถวนั้น การทำงานทุกครั้งถูกบันทึกในประวัติการใช้งาน', do: async h => { await h.swalConfirm(2500); await h.swal(); if (await h.exists('button:has-text("ปลดล็อคทั้งหมด")')) await h.point('button:has-text("ปลดล็อคทั้งหมด")', 1500); } },
        { say: 'เมนูจัดการตัวชี้วัดบนหน้านี้ ใช้เพิ่มตัวชี้วัดให้หน่วยบริการตามประเภทที่ตั้งไว้ โดยไม่ต้องเลือกหน่วยบริการทีละแห่ง', do: async h => { if (await h.exists('button:has-text("ยกเลิก")')) await h.click('button:has-text("ยกเลิก")', 1000); await h.point('button:has-text("จัดการตัวชี้วัด")', 1800); } },
        ] : [
            { say: 'เมื่อต้องการบันทึกผลงาน ให้กดปุ่มแก้ไข ระบบจะซ่อนเมนูด้านข้างเพื่อให้มีพื้นที่ตารางมากขึ้น', do: async h => { await h.scroll(-600); await h.click('button:has-text("แก้ไข")', 2000); } },
            {
                say: 'ช่องที่แก้ไขได้จะเป็นช่องกรอก พิมพ์ผลงานลงในเดือนที่ต้องการ ช่องที่ล็อกแล้วหรือเป็นของหน่วยบริการอื่นจะแก้ไขไม่ได้',
                do: async h => { await h.swal(); await h.wait(700); if (await markEmptyCell(h)) { const cur = await h.page.locator('[data-vg-cell]').inputValue().catch(() => ''); await h.type('[data-vg-cell]', cur === '61.5' ? '72.5' : '61.5', 800); } else h.page && await h.point('table tbody', 1500); },
            },
            { say: 'สามารถดาวน์โหลดแบบฟอร์ม Excel ไปกรอก แล้วนำเข้ากลับมาได้ ระบบจะเติมค่าให้ตรวจสอบก่อน โดยยังไม่บันทึกจนกว่าจะกดบันทึก', do: async h => { await h.point('button:has-text("แบบฟอร์ม Excel")', 1500); await h.point('button:has-text("นำเข้า Excel")', 1500); } },
            { say: 'ตรวจสอบค่าที่เปลี่ยนแล้วกดปุ่มบันทึก ระบบจะแสดงรายการที่เปลี่ยนให้ยืนยันอีกครั้ง หากค่าใดผิดปกติจะมีคำเตือนสีแดง', do: async h => { await h.click('button:has-text("บันทึก")', 2200); } },
            { keepSwal: true, say: 'กดยืนยันเพื่อบันทึก ผลงานจะมีสถานะรอตรวจสอบ จนกว่าผู้ดูแลจะอนุมัติ', do: async h => { await h.swalConfirm(2500); await h.swal(); } },
            { say: 'ผลงานที่ผ่านการอนุมัติจะถูกล็อก หากต้องการแก้ไข ให้ติดต่อผู้ดูแลเพื่อปลดล็อก หรือยื่นอุทธรณ์ผ่านระบบ' },
        ]),
        { say: 'เท่านี้ก็สามารถบันทึกและติดตามผลงานตัวชี้วัดได้แล้ว หากมีข้อสงสัย ดูเพิ่มเติมได้ที่คู่มือการใช้งาน หรือกระดานข้อเสนอแนะ' },
    ],
};
