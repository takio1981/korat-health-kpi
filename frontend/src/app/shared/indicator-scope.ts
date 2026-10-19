// ขอบเขตประเภทหน่วยบริการของตัวชี้วัด (kpi_indicators.evaluation_mode / required_off_types)
// ต้องตรงกับ indicatorTypeSetting()/indicatorAllowsHostype() ใน api/server.js — ใช้ตอน "เพิ่มตัวชี้วัดให้หน่วยบริการ" (dashboard)

/** ประเภทหลักที่ใช้เมื่อตัวชี้วัดตั้งไว้ "ทุกประเภท" (all_required) แล้วระบบหาหน่วยบริการปลายทางให้อัตโนมัติหลายแห่ง
 *  — ชุดเดียวกับ ALL_BULK_HOSTYPES ของ "เพิ่ม KPI ทุกหน่วยบริการ" (รพ.ศูนย์ / รพ.ทั่วไป / รพ.ชุมชน / รพ.สต.) */
export const AUTO_ALL_HOSTYPES = ['05', '06', '07', '18'];
/** ชื่อประเภทสำรอง (เมื่อรายการประเภทที่โหลดมาตามขอบเขตผู้ใช้ไม่มีรหัสนั้น) */
export const HOSTYPE_NAMES: Record<string, string> = {
  '01': 'สำนักงานสาธารณสุขจังหวัด', '02': 'สำนักงานสาธารณสุขอำเภอ',
  '05': 'โรงพยาบาลศูนย์', '06': 'โรงพยาบาลทั่วไป', '07': 'โรงพยาบาลชุมชน', '18': 'โรงพยาบาลส่งเสริมสุขภาพตำบล',
};

export type HostypeSetting = 'types' | 'all' | 'unset';

/** ประเภทหน่วยบริการ (hostypecode) ที่ตัวชี้วัดแบบ any_one ระบุไว้ — null = ไม่ได้ระบุรายการ */
export function indicatorHostypes(ind: any): string[] | null {
  if (!ind || ind.evaluation_mode !== 'any_one' || !ind.required_off_types) return null;
  let codes: any = ind.required_off_types;
  if (typeof codes === 'string') {
    try { codes = JSON.parse(codes); } catch { return null; }
  }
  if (!Array.isArray(codes) || codes.length === 0) return null;
  return codes.map((c: any) => String(c));
}

/** 'types' = เฉพาะบางประเภท | 'all' = ทุกประเภท | 'unset' = ยังไม่ได้ตั้ง (เพิ่มให้หน่วยบริการไม่ได้ ต้องตั้งค่าก่อน) */
export function indicatorTypeSetting(ind: any): HostypeSetting {
  if (ind && ind.evaluation_mode === 'all_required') return 'all';
  if (indicatorHostypes(ind)) return 'types';
  return 'unset';
}

/** ประเภทหน่วยบริการที่ระบบเพิ่มให้อัตโนมัติ (หลายแห่ง) — null = ยังไม่ได้ตั้ง */
export function autoTargetHostypes(ind: any): string[] | null {
  const setting = indicatorTypeSetting(ind);
  if (setting === 'all') return [...AUTO_ALL_HOSTYPES];
  if (setting === 'types') return indicatorHostypes(ind);
  return null;
}

/** ตัวชี้วัดนี้ใช้กับหน่วยบริการประเภท hostype ได้หรือไม่ — ยังไม่ได้ตั้ง = ไม่ได้, ทุกประเภท = ได้,
 *  ไม่ทราบประเภทของหน่วยบริการ = อนุญาต (backend ตัดสิน) */
export function indicatorAllowsHostype(ind: any, hostype: any): boolean {
  const setting = indicatorTypeSetting(ind);
  if (setting === 'unset') return false;
  if (setting === 'all') return true;
  if (hostype === null || hostype === undefined || hostype === '') return true;
  return indicatorHostypes(ind)!.includes(String(hostype));
}

/** หน่วยบริการปลายทางของตัวชี้วัด 1 ตัว — hospitals = รายการในขอบเขตของผู้ใช้ (backend กรองตามบทบาทแล้ว)
 *  singleUnit = ขอบเขตเป็นหน่วยบริการเดียวของผู้ใช้เอง → ใช้กฎ indicatorAllowsHostype (all_required ได้ทุกประเภท เช่น สสอ.)
 *  หลายแห่ง → เฉพาะหน่วยบริการที่ประเภทอยู่ใน autoTargetHostypes() (all_required = 4 ประเภทหลัก) */
export function resolveAddKpiTargets(ind: any, hospitals: any[], opts: { districts?: string[]; singleUnit?: boolean } = {}): string[] {
  let list = hospitals || [];
  if (opts.districts && opts.districts.length) list = list.filter(h => opts.districts!.includes(String(h.distid)));
  if (opts.singleUnit) return list.filter(h => indicatorAllowsHostype(ind, h.hostype)).map(h => String(h.hoscode));
  const types = autoTargetHostypes(ind);
  if (!types) return [];
  return list.filter(h => types.includes(String(h.hostype))).map(h => String(h.hoscode));
}
