/**
 * ประเภทตัวชี้วัด (20 พ.ย. 2569) — คีย์ตรงกับ api/services/indicator-types.js (ITYPE_ALL) และธง r9/moph/ssj/rmw/other ใน kpi_indicators
 * สีป้ายเดียวกับหน้าบันทึกผลงาน (R9 ฟ้า, MOPH แดง, SSJ เขียว, RMW เหลือง) — ตัวชี้วัดหนึ่งตัวอยู่ได้หลายประเภท
 */
export type ItypeKey = 'r9' | 'moph' | 'ssj' | 'rmw' | 'other' | 'none';

export interface ItypeInfo { key: ItypeKey; short: string; label: string; color: string; badge: string; }

export const ITYPES: ItypeInfo[] = [
  { key: 'r9', short: 'R9', label: 'R9 เขต 9', color: '#2563eb', badge: 'bg-blue-100 text-blue-700 border-blue-200' },
  { key: 'moph', short: 'MOPH', label: 'MOPH กระทรวง', color: '#dc2626', badge: 'bg-red-100 text-red-700 border-red-200' },
  { key: 'ssj', short: 'SSJ', label: 'SSJ สสจ.', color: '#16a34a', badge: 'bg-green-100 text-green-700 border-green-200' },
  { key: 'rmw', short: 'RMW', label: 'RMW ผู้ว่าฯ', color: '#ca8a04', badge: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  { key: 'other', short: 'อื่น ๆ', label: 'อื่น ๆ', color: '#7c3aed', badge: 'bg-violet-100 text-violet-700 border-violet-200' },
  { key: 'none', short: 'ไม่ระบุ', label: 'ไม่ระบุประเภท', color: '#94a3b8', badge: 'bg-gray-100 text-gray-600 border-gray-200' },
];

const BY_KEY = new Map(ITYPES.map(t => [t.key, t]));
export function itypeInfo(key: string): ItypeInfo | undefined { return BY_KEY.get(key as ItypeKey); }

/** ประเภทของตัวชี้วัดจากธง (แถวที่มี r9..other) → ['r9','moph'] หรือ ['none'] */
export function itypesOfRow(row: any): ItypeKey[] {
  const ks = (['r9', 'moph', 'ssj', 'rmw', 'other'] as ItypeKey[]).filter(k => Number(row?.[k]) === 1);
  return ks.length ? ks : ['none'];
}
