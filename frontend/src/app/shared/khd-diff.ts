// รายละเอียดความแตกต่างหลัง "เทียบกับ KHD" (9 พ.ย. 2569) — ฟังก์ชันล้วน สร้างแถวเทียบคู่ ระบบ ↔ KHD จากผลของ GET /report-compare
// 1 แถว = 1 หัวข้อที่ต่างกันของตัวชี้วัด 1 ตัว (ชื่อ / เกณฑ์ / ประเภทตัวชี้วัด / ประเภทหน่วยบริการ / กลุ่มงาน / หมวดหมู่หลัก / สถานะใน KHD)
import { KHD_TYPE_KEYS, KHD_TYPE_LABEL, typesText, hostypeText } from './khd-types';

export type KhdDiffKind = 'ref' | 'name' | 'table_process' | 'criteria' | 'types' | 'hostype' | 'fiscal_year' | 'dept' | 'main' | 'status';
export const KHD_DIFF_KIND_LABEL: Record<KhdDiffKind, string> = {
  ref: 'รหัสอ้างอิง', name: 'ชื่อตัวชี้วัด', table_process: 'table_process', criteria: 'เกณฑ์', types: 'ประเภทตัวชี้วัด', hostype: 'ประเภทหน่วยบริการ', fiscal_year: 'ปีงบประมาณ',
  dept: 'กลุ่มงาน', main: 'หมวดหมู่หลัก', status: 'สถานะใน KHD',
};

export interface KhdDiffRow {
  id: number; name: string; table_process: string;
  kind: KhdDiffKind; local: string; khd: string;
  /** รายละเอียดเพิ่ม เช่น "R9: มี → ไม่มี" หรือ "เพิ่ม: 05 · เอาออก: 18" */
  detail: string;
  /** false = ไม่มีค่าให้ใช้ในระบบ (ต้องแก้ที่ KHD / ตรวจสอบเอง) — ไม่แสดงปุ่ม "ใช้ค่า KHD" */
  applicable?: boolean;
  /** ข้อความแทนปุ่มเมื่อ applicable = false */
  note?: string;
}

/**
 * รหัสอ้างอิงตรงกับ KHD แต่ table_process ต่างกัน (11 พ.ย. 2569, ปรับ 26 พ.ย. 2569) — คู่มาจากรหัสอ้างอิง = report_id เสมอ
 * table_process ใช้ร่วมกับตัวชี้วัด/รายงานอื่นได้ (ตารางส่งออกเดียวกัน) จึงใช้ table_process ของ KHD ได้ทุกคู่ ('apply')
 */
export type KhdTpKind = 'apply';
export function khdTpKind(k: any): KhdTpKind | null {
  return k && k.status === 'tp_different' && k.khd_report_id ? 'apply' : null;
}
/** ข้อความอธิบายคู่ที่ table_process ต่าง (หน้าต่างรายละเอียด / ป้ายในแถว) */
export function khdTpDetail(k: any): string {
  if (!khdTpKind(k)) return '';
  const parts = ['รหัสอ้างอิงตรงกับ KHD #' + k.khd_report_id + (k.report_code ? ' (รหัสรายงาน ' + k.report_code + ')' : '')];
  if (k.khd_code_matches_tp) parts.push('รหัสรายงาน KHD ตรงกับ table_process ของระบบ');
  if (k.khd_tp_shared > 1) parts.push('KHD ใช้ table_process นี้ร่วมกัน ' + k.khd_tp_shared + ' รายงาน');
  if (k.khd_tp_used_by) parts.push('ตัวชี้วัดอื่นของระบบใช้ table_process นี้อยู่แล้ว ' + (k.khd_tp_used_by.count || 1) + ' ตัว (#' + k.khd_tp_used_by.id + ') — ใช้ตารางส่งออกร่วมกันได้');
  return parts.join(' · ');
}

/** ป้ายวิธีจับคู่/ที่มาของรหัสที่แนะนำ (services/khd-match.js) */
export function khdMatchByDetail(by: any): string {
  return by === 'kpi_indicators_id' ? 'จับคู่ด้วยรหัสอ้างอิง' : by === 'khd_report_id' ? 'แนะนำจากลิงก์ KHD (khd_report_id)'
    : by === 'name' ? 'แนะนำจากชื่อตัวชี้วัดที่ตรงกัน' : '';
}
/** ข้อความสำหรับใส่ใน HTML ของกล่องยืนยัน */
export function escapeHtmlText(t: any): string {
  return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
}

export interface KhdDiffContext {
  getKhd: (item: any) => any;
  criteriaText: (item: any) => string;
  khdCriteriaText: (khd: any) => string;
  hosNames?: Record<string, string>;
  /** ชื่อกลุ่มงาน / หมวดหมู่หลักของระบบจาก id (ค่าปัจจุบันของตัวชี้วัด) */
  deptName?: (id: any) => string;
  mainName?: (id: any) => string;
}

// ===== กลุ่มงาน / หมวดหมู่หลัก (11 พ.ย. 2569) — backend แปลงค่าข้อความของ KHD เป็น id ของระบบ (khd_dept_id / khd_main_id + สถานะการจับคู่) =====
export type KhdOrgPart = 'dept' | 'main';
const ORG_LOCAL_COL: Record<KhdOrgPart, string> = { dept: 'dept_id', main: 'main_indicator_id' };
/** เทียบค่าปัจจุบันของตัวชี้วัดกับ KHD — null = เทียบไม่ได้ (ยังไม่เทียบ / ไม่มีคู่ใน KHD / KHD ไม่ระบุ / ยังจับคู่ค่าใน KHD ไม่ได้) */
export function khdOrgMatch(item: any, khd: any, part: KhdOrgPart): boolean | null {
  if (!khd || khd.status === 'missing_remote' || khd.status === 'missing_local') return null;
  const st = khd['khd_' + part + '_status'];
  if (st !== 'mapped' && st !== 'auto') return null;
  const local = item?.[ORG_LOCAL_COL[part]];
  const localId = local === null || local === undefined || local === '' ? null : Number(local);
  return localId === Number(khd['khd_' + part + '_id']);
}
/** ค่าใน KHD ยังจับคู่กับระบบไม่ได้ (ต้องตั้งที่ "จับคู่ข้อมูล KHD") */
export function khdOrgUnmatched(khd: any, part: KhdOrgPart): boolean {
  return !!khd && khd.status !== 'missing_remote' && khd.status !== 'missing_local' && khd['khd_' + part + '_status'] === 'unmatched';
}
export function khdOrgDetail(khd: any, part: KhdOrgPart): string {
  const v = khd?.['khd_' + part + '_value'];
  const how = khd?.['khd_' + part + '_status'] === 'mapped' ? 'จับคู่ที่ตั้งไว้' : 'จับคู่อัตโนมัติ';
  return v ? `ค่าใน KHD: "${v}" (${how})` : '';
}

const on = (v: any) => v !== null && v !== undefined && String(v).trim() !== '' && String(v).trim() !== '0';

/** ประเภทตัวชี้วัดที่ต่างกันทีละตัว: "R9: มี → ไม่มี, MOPH: ไม่มี → มี" */
export function typesChangeText(local: any, khd: any): string {
  return KHD_TYPE_KEYS.filter(k => on(local?.[k]) !== on(khd?.[k]))
    .map(k => `${KHD_TYPE_LABEL[k]}: ${on(local?.[k]) ? 'มี' : 'ไม่มี'} → ${on(khd?.[k]) ? 'มี' : 'ไม่มี'}`).join(', ');
}

const codesOf = (v: any): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } }
  return [];
};

/** ประเภทหน่วยบริการที่ต่าง: เปลี่ยนโหมด หรือรายการที่เพิ่ม/เอาออก */
export function hostypeChangeText(localMode: any, localCodes: any, khdMode: any, khdCodes: any, names?: Record<string, string>): string {
  const label = (c: string) => names?.[c] ? `${names[c]} (${c})` : c;
  if ((localMode || '') !== (khdMode || '')) {
    const m = (x: any) => x === 'all_required' ? 'ทุกประเภท' : x === 'any_one' ? 'เฉพาะบางประเภท' : 'ยังไม่ตั้ง';
    return `โหมด: ${m(localMode)} → ${m(khdMode)}`;
  }
  const a = new Set(codesOf(localCodes)), b = new Set(codesOf(khdCodes));
  const add = [...b].filter(c => !a.has(c)).sort().map(label);
  const del = [...a].filter(c => !b.has(c)).sort().map(label);
  return [add.length ? 'เพิ่ม: ' + add.join(', ') : '', del.length ? 'เอาออก: ' + del.join(', ') : ''].filter(Boolean).join(' · ');
}

/** ปีงบประมาณ (comma-list "2569,2570" หรือ array) → ['2569','2570'] ไม่ซ้ำ เรียง — ตรงกับ api/services/fiscal-years.js */
export function fiscalYearList(v: any): string[] {
  const raw: any[] = Array.isArray(v) ? v : String(v ?? '').split(',');
  return [...new Set(raw.map(x => String(x ?? '').trim()).filter(x => /^2[5-6]\d\d$/.test(x)))].sort();
}

/** ปีงบของตัวชี้วัด (khd_fiscal_year) ต่างจาก KHD ไหม — KHD ไม่มีปีงบ = null (ไม่นับต่าง ไม่มีค่าให้ใช้) */
export function fiscalYearMatch(localValue: any, khdYears: any): boolean | null {
  const khd = fiscalYearList(khdYears);
  if (!khd.length) return null;
  return fiscalYearList(localValue).join(',') === khd.join(',');
}

/** ตัวเลือกปีงบสำหรับตั้งเอง: ปีงบปัจจุบัน −2 … +2 รวมปีที่มีอยู่แล้ว (เรียงปีล่าสุดก่อน) */
export function fiscalYearChoices(currentFy: number, existing: any[] = []): string[] {
  const set = new Set<string>();
  for (let y = currentFy - 2; y <= currentFy + 2; y++) set.add(String(y));
  for (const v of existing) for (const y of fiscalYearList(v)) set.add(y);
  return [...set].sort((a, b) => Number(b) - Number(a));
}

/** "เพิ่ม: 2569 · เอาออก: 2568" */
export function fiscalYearChangeText(localValue: any, khdYears: any): string {
  const a = fiscalYearList(localValue), b = fiscalYearList(khdYears);
  const add = b.filter(y => !a.includes(y)), del = a.filter(y => !b.includes(y));
  return [add.length ? 'เพิ่ม: ' + add.join(', ') : '', del.length ? 'เอาออก: ' + del.join(', ') : ''].filter(Boolean).join(' · ');
}

export function buildKhdDiffRows(indicators: any[], ctx: KhdDiffContext): KhdDiffRow[] {
  const rows: KhdDiffRow[] = [];
  for (const it of indicators || []) {
    const k = ctx.getKhd(it);
    if (!k || k.status === 'missing_local') continue;
    const base = { id: it.id, name: it.kpi_indicators_name, table_process: it.table_process || '' };
    const ref = String(it.kpi_indicators_id ?? '').trim();
    // ยังไม่จับคู่ (รหัสอ้างอิงไม่ตรงรายงานใดของปีงบ) แต่มีรหัสที่แนะนำ — แถว ref เท่านั้น (หัวข้ออื่นเทียบหลังตั้งรหัสแล้ว — 26 พ.ย. 2569)
    if (k.status === 'missing_remote') {
      if (k.ref_suggest && ref !== String(k.ref_suggest.report_id)) {
        rows.push({ ...base, kind: 'ref', local: ref || 'ว่าง', khd: String(k.ref_suggest.report_id),
          detail: khdMatchByDetail(k.ref_suggest.by) + (k.ref_suggest.report_name ? ' · ' + k.ref_suggest.report_name : '') });
      }
      continue;
    }
    // คู่ (รหัสอ้างอิง = report_id): รหัสถูกแก้หลังเทียบ หรือลิงก์ khd_report_id ชี้รายงานอื่น
    if (k.khd_report_id && ref !== String(k.khd_report_id)) {
      rows.push({ ...base, kind: 'ref', local: ref || 'ว่าง', khd: String(k.khd_report_id), detail: khdMatchByDetail(k.match_by) });
    } else if (k.ref_conflict && it.khd_report_id != null && String(it.khd_report_id) !== String(k.khd_report_id)) {
      rows.push({ ...base, kind: 'ref', local: 'ลิงก์ KHD ' + it.khd_report_id, khd: String(k.khd_report_id),
        detail: 'ลิงก์ KHD (khd_report_id) ชี้รายงานอื่น — ใช้รหัส KHD เพื่อแก้ลิงก์ให้ตรงกับรหัสอ้างอิง' });
    }
    if (k.status === 'different') {
      rows.push({ ...base, kind: 'name', local: it.kpi_indicators_name || '-', khd: k.khd_name || '-', detail: 'table_process เดียวกัน: ' + (it.table_process || '-') });
    }
    // ชื่อและ table_process ต่างกันทั้งคู่ — "ใช้ชื่อ KHD" ค้นตัวชี้วัดด้วยรหัสอ้างอิง (26 พ.ย. 2569) จึงปรับได้
    if (k.status === 'tp_different' && k.name_match === false) {
      rows.push({ ...base, kind: 'name', local: it.kpi_indicators_name || '-', khd: k.khd_name || '-', detail: 'table_process ต่างกันด้วย' });
    }
    if (k.status === 'tp_different') {
      rows.push({ ...base, kind: 'table_process', local: it.table_process || '-', khd: k.khd_table_process || '-', detail: khdTpDetail(k) });
    }
    if (k.criteria_match === false) {
      rows.push({ ...base, kind: 'criteria', local: ctx.criteriaText(it), khd: ctx.khdCriteriaText(k), detail: '' });
    }
    if (k.types_match === false) {
      rows.push({ ...base, kind: 'types', local: typesText(it), khd: typesText(k.khd_types),
        detail: typesChangeText(it, k.khd_types) + (k.khd_types_source === 'fiscal_year_config' ? ' (KHD: ค่าของปีงบ)' : '') });
    }
    if (k.hostype_match === false) {
      rows.push({ ...base, kind: 'hostype',
        local: hostypeText(it.evaluation_mode, it.required_off_types, ctx.hosNames),
        khd: hostypeText(k.khd_eval_mode, k.khd_off_types, ctx.hosNames),
        detail: hostypeChangeText(it.evaluation_mode, it.required_off_types, k.khd_eval_mode, k.khd_off_types, ctx.hosNames) });
    }
    // ปีงบประมาณ: เทียบจากค่าปัจจุบันของตัวชี้วัด (ตั้งเอง/ใช้ค่า KHD แล้วเห็นผลทันทีโดยไม่ต้องเทียบใหม่)
    if (fiscalYearMatch(it.khd_fiscal_year, k.khd_fiscal_years) === false) {
      rows.push({ ...base, kind: 'fiscal_year', local: fiscalYearList(it.khd_fiscal_year).join(', ') || 'ไม่ระบุปีงบ',
        khd: fiscalYearList(k.khd_fiscal_years).join(', '), detail: fiscalYearChangeText(it.khd_fiscal_year, k.khd_fiscal_years) });
    }
    for (const part of ['dept', 'main'] as KhdOrgPart[]) {
      if (khdOrgMatch(it, k, part) !== false) continue;
      const nameOf = part === 'dept' ? ctx.deptName : ctx.mainName;
      const localId = it?.[ORG_LOCAL_COL[part]];
      rows.push({ ...base, kind: part,
        local: (localId ? (nameOf?.(localId) || '#' + localId) : '') || 'ไม่ระบุ',
        khd: k['khd_' + part + '_name'] || '-', detail: khdOrgDetail(k, part) });
    }
    if (k.khd_is_active === 0 || k.khd_is_active === '0') {
      const exporting = !(it.upload_excel === 1 || it.upload_excel === '1');
      rows.push({ ...base, kind: 'status', local: exporting ? 'ส่งออก KHD อยู่' : 'ปิดส่งออก KHD แล้ว', khd: 'ปิดใช้งาน (inactive)',
        detail: exporting ? 'แนะนำปิดส่งออก KHD' : '', ...(exporting ? {} : { applicable: false, note: 'ปิดส่งออกแล้ว' }) });
    }
  }
  return rows;
}

/**
 * แถวที่ "ใช้ค่า KHD" ได้ของหัวข้อหนึ่ง (16 พ.ย. 2569 — ปุ่ม "ใช้ค่า KHD ทั้งหมด" รายหัวข้อ):
 * ตัดแถวที่ applicable = false (ต้องแก้ที่ KHD / ตรวจสอบเอง / ปิดส่งออกแล้ว) และให้ 1 แถวต่อตัวชี้วัด
 */
export function khdApplicableRows(rows: KhdDiffRow[], kind: KhdDiffKind): KhdDiffRow[] {
  const seen = new Set<number>();
  return (rows || []).filter(r => {
    if (r.kind !== kind || r.applicable === false || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/** ข้อมูลตารางสำหรับดาวน์โหลด Excel */
export function khdDiffAoa(rows: KhdDiffRow[], year: string): any[][] {
  return [
    ['รหัส', 'ตัวชี้วัด', 'ชื่อตาราง', 'หัวข้อ', 'ในระบบ (KHUPS KPI)', `ใน KHD (ปีงบ ${year})`, 'รายละเอียด'],
    ...rows.map(r => [r.id, r.name, r.table_process, KHD_DIFF_KIND_LABEL[r.kind], r.local, r.khd, r.detail]),
  ];
}
