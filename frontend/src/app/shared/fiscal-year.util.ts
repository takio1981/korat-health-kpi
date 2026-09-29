/**
 * ปีงบประมาณไทย: 1 ต.ค. - 30 ก.ย. ปีถัดไป นับชื่อปีงบตามปี พ.ศ. ที่ปีงบสิ้นสุด (ก.ย.)
 * เช่น 1 ต.ค. 2569 - 30 ก.ย. 2570 = ปีงบประมาณ 2570
 * ใช้จุดเดียวนี้ทั่วทั้งระบบแทนการคำนวณเองในแต่ละหน้า — เคยเป็นบั๊กมาก่อนที่หลายหน้าคำนวณไม่ตรงกัน
 * (บางหน้า hardcode ปีไว้ตรงๆ, บางหน้าคำนวณแบบไม่คำนึงเดือนเลยผิดช่วง ต.ค.-ธ.ค. ของทุกปี)
 */
export function getCurrentFiscalYear(date: Date = new Date()): number {
  const beYear = date.getFullYear() + 543;
  return date.getMonth() >= 9 ? beYear + 1 : beYear; // เดือน ต.ค. = index 9 (0 = ม.ค.)
}

/** ปีงบประมาณถัดไป — ใช้กับหน้าที่ default ไปที่ปีงบใหม่ที่ยังไม่ได้ตั้งค่า เช่น kpi-setup */
export function getNextFiscalYear(date: Date = new Date()): number {
  return getCurrentFiscalYear(date) + 1;
}
