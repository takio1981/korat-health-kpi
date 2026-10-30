// โซนของหน่วยบริการ (chospital.zone '1'–'6' ตามอำเภอ — กำหนด 30 ต.ค. 2569) — ใช้ร่วมทุกหน้าที่มีตัวกรองหน่วยบริการ/อำเภอ
// แถวจาก GET /hospitals และ GET /districts มีฟิลด์ zone (ว่าง = ยังไม่กำหนดโซน)

/** รายการโซนที่พบในข้อมูล (ไม่ซ้ำ เรียงตามเลข) — ใช้สร้างตัวเลือก dropdown ตามขอบเขตที่ backend ส่งมา */
export function zoneOptions(rows: any[]): string[] {
  const set = new Set<string>();
  for (const r of rows || []) {
    const z = String(r?.zone ?? '').trim();
    if (z) set.add(z);
  }
  return Array.from(set).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

export function zoneLabel(zone: any): string {
  const z = String(zone ?? '').trim();
  return z ? `โซน ${z}` : 'ไม่ระบุโซน';
}

/** แถว (หน่วยบริการ/อำเภอ) อยู่ในโซนที่เลือกหรือไม่ — ไม่เลือกโซน (ค่าว่าง / array ว่าง) = ผ่านทุกแถว */
export function inZone(row: any, zones: string | string[] | null | undefined): boolean {
  const list = (Array.isArray(zones) ? zones : [zones]).map(z => String(z ?? '').trim()).filter(Boolean);
  if (list.length === 0) return true;
  return list.includes(String(row?.zone ?? '').trim());
}
