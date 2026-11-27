/**
 * ตัวกรองคุณสมบัติตัวชี้วัดของหน้าจัดการข้อมูล KPI ↔ KHD (27 พ.ย. 2569 — ผู้ใช้สั่ง: ตัวกรองครบทุกหัวข้อเกี่ยวกับตัวชี้วัด)
 * ฟังก์ชันล้วน: ind = แถวจาก /exportable-indicators, meta = แถวเต็มจาก GET /indicators (IndicatorMetaService) — ความหมายตรงกับป้ายใต้ชื่อ
 */
import { itypesOfRow } from '../shared/indicator-types';

export interface AttrFilter {
  itype: string;     // r9|moph|ssj|rmw|other|none
  hostype: string;   // all = ทุกประเภทบังคับ | unset = ยังไม่ตั้ง | t:<code> = รายงานโดยประเภทนั้น
  method: string;    // latest|cumulative|formula|manual|monthly|quarter
  source: string;    // key_in|hdc|local
  khd: string;       // on = ส่งออก KHD | off = ไม่ส่ง
  fy: string;        // ปีงบ | __none = ไม่ระบุปีงบ
  items: string;     // on = ส่งออกรายละเอียดข้อย่อย | off
  criterion: string; // set = ตั้งเกณฑ์แล้ว | unset
}
export const EMPTY_ATTR_FILTER: AttrFilter = { itype: '', hostype: '', method: '', source: '', khd: '', fy: '', items: '', criterion: '' };

export const METHOD_OPTIONS = [
  { value: 'latest', label: 'ค่าเดือนล่าสุด' },
  { value: 'cumulative', label: 'สะสม (รวมทุกเดือน)' },
  { value: 'formula', label: 'สูตรคำนวณ' },
  { value: 'manual', label: 'กรอกผลงาน/ร้อยละเอง' },
  { value: 'monthly', label: 'เป้าหมายรายเดือน' },
  { value: 'quarter', label: 'วัดผลรายไตรมาส' },
];
export const SOURCE_OPTIONS = [
  { value: 'key_in', label: 'key_in (บันทึกในระบบ → KHD)' },
  { value: 'hdc', label: 'hdc (ข้อมูลจาก HDC)' },
  { value: 'local', label: 'local-only (ไม่เชื่อม KHD)' },
];

const offTypes = (m: any): string[] => {
  try { const v = typeof m?.required_off_types === 'string' ? JSON.parse(m.required_off_types) : m?.required_off_types; return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
};
/** ประเภทหน่วยบริการที่ตั้งไว้: all | unset | types (กติกาเดียวกับ shared/indicator-scope) */
export function hostypeSettingOf(m: any): 'all' | 'unset' | 'types' {
  if (m?.evaluation_mode === 'all_required') return 'all';
  return m?.evaluation_mode === 'any_one' && offTypes(m).length ? 'types' : 'unset';
}
/** วิธีคิดผลงาน (ตัวชี้วัดหนึ่งตัวอาจเข้าได้หลายกลุ่ม เช่น สูตร + รายไตรมาส) */
export function methodsOf(m: any): string[] {
  const out: string[] = [];
  if (+m?.result_manual === 1 || +m?.pct_manual === 1) out.push('manual');
  if (m?.result_formula) out.push('formula');
  else if (+m?.is_cumulative === 1) out.push('cumulative');
  if (m?.target_monthly) out.push('monthly');
  if (m?.quarter_mode) out.push('quarter');
  if (!out.includes('manual') && !m?.result_formula && +m?.is_cumulative !== 1) out.push('latest');
  return out;
}
/** แหล่งข้อมูล (เดียวกับป้าย key_in / hdc / local-only) */
export function sourceOf(m: any): 'key_in' | 'hdc' | 'local' {
  if (!m?.khd_report_id) return 'local';
  return m?.data_source === 'hdc' ? 'hdc' : 'key_in';
}
export function fiscalYearsOf(m: any): string[] {
  return String(m?.khd_fiscal_year || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** ตรงกับตัวกรองทุกข้อที่เลือก — ยังไม่มีคุณสมบัติเต็ม (meta ยังไม่โหลด) = ใช้ค่าจากแถวเท่าที่มี */
export function matchAttrFilter(ind: any, meta: any, f: AttrFilter): boolean {
  const m = { ...(ind || {}), ...(meta || {}) };
  if (f.itype && !(itypesOfRow(m) as string[]).includes(f.itype)) return false;
  if (f.hostype) {
    const s = hostypeSettingOf(m);
    if (f.hostype === 'all' || f.hostype === 'unset') { if (s !== f.hostype) return false; }
    else if (f.hostype.startsWith('t:')) { if (!(s === 'all' || (s === 'types' && offTypes(m).includes(f.hostype.slice(2))))) return false; }
  }
  if (f.method && !methodsOf(m).includes(f.method)) return false;
  if (f.source && sourceOf(m) !== f.source) return false;
  if (f.khd && ((+m.upload_excel === 0) !== (f.khd === 'on'))) return false;
  if (f.fy) { const ys = fiscalYearsOf(m); if (f.fy === '__none' ? ys.length > 0 : !ys.includes(f.fy)) return false; }
  if (f.items && ((+m.export_items === 1) !== (f.items === 'on'))) return false;
  if (f.criterion) { const has = m.criterion !== null && m.criterion !== undefined && String(m.criterion).trim() !== ''; if (has !== (f.criterion === 'set')) return false; }
  return true;
}

export function activeAttrCount(f: AttrFilter): number {
  return Object.values(f).filter(v => !!v).length;
}

/** ตัวเลือกปีงบจากข้อมูลที่มีจริง (ใหม่ → เก่า) */
export function fiscalYearOptions(metas: any[]): string[] {
  const set = new Set<string>();
  for (const m of metas) for (const y of fiscalYearsOf(m)) set.add(y);
  return [...set].sort((a, b) => b.localeCompare(a));
}
