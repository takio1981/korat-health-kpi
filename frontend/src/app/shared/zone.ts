// โซนของหน่วยบริการ (chospital.zone — รหัส 1–99 + ชื่อโซน ตั้งที่แท็บ "โซน" ในหน้าจัดการตัวชี้วัด ตั้งแต่ 9 พ.ย. 2569) — ใช้ร่วมทุกหน้าที่มีตัวกรองหน่วยบริการ/อำเภอ
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

// ชื่อโซน (GET /zones) — HospitalZoneService ตั้งค่าตอนโหลด ใช้ร่วมทุกหน้า (ไม่มีชื่อ = แสดงแค่ "โซน N")
const _zoneNames = new Map<string, string>();
export function setZoneNames(rows: { code: any; name?: any }[]): void {
  _zoneNames.clear();
  for (const r of rows || []) { const n = String(r?.name ?? '').trim(); if (n) _zoneNames.set(String(r.code).trim(), n); }
}
export function zoneName(zone: any): string { return _zoneNames.get(String(zone ?? '').trim()) || ''; }

export function zoneLabel(zone: any): string {
  const z = String(zone ?? '').trim();
  if (!z) return 'ไม่ระบุโซน';
  const n = zoneName(z);
  return n ? `โซน ${z} · ${n}` : `โซน ${z}`;
}

/** แถว (หน่วยบริการ/อำเภอ) อยู่ในโซนที่เลือกหรือไม่ — ไม่เลือกโซน (ค่าว่าง / array ว่าง) = ผ่านทุกแถว */
export function inZone(row: any, zones: string | string[] | null | undefined): boolean {
  const list = (Array.isArray(zones) ? zones : [zones]).map(z => String(z ?? '').trim()).filter(Boolean);
  if (list.length === 0) return true;
  return list.includes(String(row?.zone ?? '').trim());
}
