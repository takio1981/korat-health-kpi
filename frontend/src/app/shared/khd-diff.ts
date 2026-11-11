// รายละเอียดความแตกต่างหลัง "เทียบกับ KHD" (9 พ.ย. 2569) — ฟังก์ชันล้วน สร้างแถวเทียบคู่ ระบบ ↔ KHD จากผลของ GET /report-compare
// 1 แถว = 1 หัวข้อที่ต่างกันของตัวชี้วัด 1 ตัว (ชื่อ / เกณฑ์ / ประเภทตัวชี้วัด / ประเภทหน่วยบริการ / หน่วยงาน / หมวดหมู่หลัก / สถานะใน KHD)
import { KHD_TYPE_KEYS, KHD_TYPE_LABEL, typesText, hostypeText } from './khd-types';

export type KhdDiffKind = 'name' | 'table_process' | 'criteria' | 'types' | 'hostype' | 'fiscal_year' | 'dept' | 'main' | 'status';
export const KHD_DIFF_KIND_LABEL: Record<KhdDiffKind, string> = {
  name: 'ชื่อตัวชี้วัด', table_process: 'table_process', criteria: 'เกณฑ์', types: 'ประเภทตัวชี้วัด', hostype: 'ประเภทหน่วยบริการ', fiscal_year: 'ปีงบประมาณ',
  dept: 'หน่วยงาน', main: 'หมวดหมู่หลัก', status: 'สถานะใน KHD',
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
 * ชื่อเดียวกันแต่ table_process ต่างกัน (11 พ.ย. 2569) — สถานะของคู่จาก GET /report-compare:
 * 'apply' = ใช้ table_process ของ KHD ได้ | 'khd_fix' = table_process ของ KHD ถูกตัวชี้วัดอื่นของระบบใช้แล้ว (KHD ใช้ซ้ำหลายรายงาน → ควรแก้ที่ KHD)
 * | 'ambiguous' = ชื่อตรงกับ KHD หลายรายการ เลือกไม่ได้ | 'linked_other' = ชื่อตรงกับรายงาน KHD ที่เชื่อมกับตัวชี้วัดอื่นแล้ว (อาจเป็นตัวชี้วัดซ้ำ)
 */
export type KhdTpKind = 'apply' | 'khd_fix' | 'ambiguous' | 'linked_other';
export function khdTpKind(k: any): KhdTpKind | null {
  if (!k || k.status !== 'tp_different') return null;
  if (k.tp_note === 'linked_other') return 'linked_other';
  if (k.tp_ambiguous || !k.khd_report_id) return 'ambiguous';
  if (k.khd_tp_used_by) return 'khd_fix';
  return 'apply';
}
const tpCand = (c: any) => '#' + c.report_id + ' ' + (c.table_process || '-') + (c.used_by_id ? ' (ใช้กับตัวชี้วัด #' + c.used_by_id + ' ในระบบ)' : '');
/** ข้อความอธิบายคู่ชื่อเดียวกันแต่ table_process ต่าง (หน้าต่างรายละเอียด / ป้ายในแถว) */
export function khdTpDetail(k: any): string {
  const kind = khdTpKind(k);
  if (!kind) return '';
  if (kind === 'ambiguous') return 'ชื่อตรงกับรายงาน KHD หลายรายการ: ' + (k.tp_candidates || []).map(tpCand).join(', ') + ' — ระบบไม่เลือกให้ (ตรวจสอบว่าเป็นรายการใด)';
  if (kind === 'linked_other') return 'ชื่อตรงกับรายงาน KHD ที่เชื่อมกับตัวชี้วัดอื่นของระบบแล้ว: ' + (k.tp_candidates || []).map(tpCand).join(', ') + ' — อาจเป็นตัวชี้วัดซ้ำในระบบ';
  const parts = ['ชื่อเดียวกัน (KHD #' + k.khd_report_id + (k.report_code ? ' · รหัส ' + k.report_code : '') + ')'];
  if (k.khd_code_matches_tp) parts.push('รหัสรายงาน KHD ตรงกับ table_process ของระบบ');
  if (k.khd_tp_shared > 1) parts.push('KHD ใช้ table_process นี้ร่วมกัน ' + k.khd_tp_shared + ' รายงาน');
  if (k.khd_tp_used_by) parts.push('ตัวชี้วัด #' + k.khd_tp_used_by.id + ' ' + (k.khd_tp_used_by.name || '') + ' ของระบบใช้ table_process นี้แล้ว → ควรแก้ table_process ของรายงานนี้ที่ KHD');
  return parts.join(' · ');
}

export interface KhdDiffContext {
  getKhd: (item: any) => any;
  criteriaText: (item: any) => string;
  khdCriteriaText: (khd: any) => string;
  hosNames?: Record<string, string>;
  /** ชื่อหน่วยงาน / หมวดหมู่หลักของระบบจาก id (ค่าปัจจุบันของตัวชี้วัด) */
  deptName?: (id: any) => string;
  mainName?: (id: any) => string;
}

// ===== หน่วยงาน / หมวดหมู่หลัก (11 พ.ย. 2569) — backend แปลงค่าข้อความของ KHD เป็น id ของระบบ (khd_dept_id / khd_main_id + สถานะการจับคู่) =====
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
    if (!k || k.status === 'missing_remote' || k.status === 'missing_local') continue;
    const base = { id: it.id, name: it.kpi_indicators_name, table_process: it.table_process || '' };
    if (k.status === 'different') {
      rows.push({ ...base, kind: 'name', local: it.kpi_indicators_name || '-', khd: k.khd_name || '-', detail: 'table_process เดียวกัน: ' + (it.table_process || '-') });
    }
    if (k.status === 'tp_different') {
      const tk = khdTpKind(k);
      const khdTp = tk === 'ambiguous' || tk === 'linked_other' ? (k.tp_candidates || []).map((c: any) => c.table_process || '-').join(', ') || '-' : (k.khd_table_process || '-');
      rows.push({ ...base, kind: 'table_process', local: it.table_process || '-', khd: khdTp, detail: khdTpDetail(k),
        ...(tk === 'apply' ? {} : { applicable: false, note: tk === 'khd_fix' ? 'แก้ที่ KHD' : 'ตรวจสอบเอง' }) });
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
        detail: exporting ? 'แนะนำปิดส่งออก KHD' : '' });
    }
  }
  return rows;
}

/** ข้อมูลตารางสำหรับดาวน์โหลด Excel */
export function khdDiffAoa(rows: KhdDiffRow[], year: string): any[][] {
  return [
    ['รหัส', 'ตัวชี้วัด', 'ชื่อตาราง', 'หัวข้อ', 'ในระบบ (KHUPS KPI)', `ใน KHD (ปีงบ ${year})`, 'รายละเอียด'],
    ...rows.map(r => [r.id, r.name, r.table_process, KHD_DIFF_KIND_LABEL[r.kind], r.local, r.khd, r.detail]),
  ];
}
