// ขอบเขตการส่งข้อมูลเข้า KHD จากตัวชี้วัดที่เลือกในขั้นที่ 3 (28 พ.ย. 2569 — ผู้ใช้สั่ง: ตารางส่งข้อมูลเข้า KHD = ตัวชี้วัดที่เลือก)
// ฟังก์ชันล้วน — backend (POST /sync-to-khd/preview { indicator_ids }) กรองซ้ำด้วยกติกาเดียวกันเสมอ
import { tpKey } from './kpi-table-status';

export interface KhdSyncScope {
  /** id ตัวชี้วัดที่ส่งให้ backend (เฉพาะที่ส่ง KHD ได้) */
  ids: number[];
  /** ชื่อตาราง (table_process แบบขีดล่าง ไม่ซ้ำ) */
  tables: string[];
  /** ตัวชี้วัดที่เลือกแต่ส่ง KHD ไม่ได้ พร้อมเหตุผล */
  excluded: { id: number; name: string; table: string; reason: string }[];
}

export function khdSyncScope(indicators: any[], selected: Set<number>): KhdSyncScope {
  const ids: number[] = [], tables = new Set<string>(), excluded: KhdSyncScope['excluded'] = [];
  for (const ind of indicators || []) {
    if (!selected.has(ind.id)) continue;
    const table = tpKey(ind.table_process);
    const name = String(ind.kpi_indicators_name || '');
    if (Number(ind.upload_excel) === 1) { excluded.push({ id: ind.id, name, table, reason: 'ปิดส่งออก KHD (เปิดได้ที่หน้าจัดการตัวชี้วัด)' }); continue; }
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(table)) { excluded.push({ id: ind.id, name, table, reason: 'ชื่อตารางไม่ถูกต้อง' }); continue; }
    ids.push(ind.id); tables.add(table);
  }
  return { ids, tables: [...tables], excluded };
}

/** ลายเซ็นของขอบเขต — เปลี่ยนรายการที่เลือกหรือปีงบแล้วต้องตรวจแผนใหม่ก่อนส่ง */
export function syncScopeKey(year: string, selected: Set<number>): string {
  return `${year}|${[...selected].sort((a, b) => a - b).join(',')}`;
}
