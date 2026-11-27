/**
 * สถานะตารางส่งออกของหน้าจัดการข้อมูล KPI (27 พ.ย. 2569 — รวม "ส่งออกข้อมูล KPI ↔ KHD" กับ "Export ลงตารางรายตัวชี้วัด" เป็นตารางเดียว)
 * ฟังก์ชันล้วน: อ่านผล GET /db-compare?year_bh= (1 รายการต่อ table_process) แล้วสรุปเป็นป้ายของคอลัมน์ "ตารางในระบบ" และ "ตารางใน KHD"
 */
export interface TableStruct {
  table: string;
  status?: string;
  local?: { exists: boolean; row_count?: number; year_rows?: number; year_filled?: number; columns?: any[] } | null;
  remote?: { exists: boolean; row_count?: number; key_ok?: boolean | null; columns?: any[] } | null;
  diff?: any[];
}
export interface StatusBadge { key: string; text: string; cls: string; title: string; }

/** ชื่อตารางตามกติกาเดียวกับ backend (ตัดช่องว่าง + ขีดกลาง → ขีดล่าง) */
export function tpKey(tp: string | null | undefined): string {
  return String(tp || '').trim().replace(/-/g, '_');
}

export function structMapOf(tables: TableStruct[] | null | undefined): Map<string, TableStruct> {
  const m = new Map<string, TableStruct>();
  for (const t of tables || []) m.set(tpKey(t.table), t);
  return m;
}

/** ตารางในระบบ: ยังไม่มี (ส่งออกแล้วสร้างให้) / มีแต่ปีนี้ว่าง / มีข้อมูล */
export function localBadge(s: TableStruct | undefined, year: string): StatusBadge {
  if (!s || !s.local?.exists) {
    return { key: 'none', text: 'ยังไม่มีตาราง', cls: 'bg-gray-100 text-gray-600 border-gray-200', title: 'กด "ส่งออกข้อมูล" ระบบจะสร้างตารางพร้อมใส่ข้อมูลให้เอง' };
  }
  const rows = s.local.year_rows ?? null, filled = s.local.year_filled ?? null;
  if (rows === 0) {
    return { key: 'empty', text: `ปีงบ ${year}: ยังไม่มีแถว`, cls: 'bg-amber-50 text-amber-700 border-amber-200', title: `ตารางมีอยู่แล้ว (${s.local.row_count || 0} แถวทุกปีงบ) แต่ยังไม่ได้ส่งออกปีงบ ${year}` };
  }
  if (rows !== null && filled === 0) {
    return { key: 'blank', text: `ปีงบ ${year}: ${rows} แถว ค่าว่างทั้งหมด`, cls: 'bg-red-50 text-red-700 border-red-200', title: 'ทุกแถวยังไม่มีเป้าหมายและผลงาน — ตรวจกติกาการส่ง (ส่งเฉพาะที่อนุมัติ = เดือนที่ยังไม่อนุมัติเป็นค่าว่าง) หรือยังไม่มีการบันทึก' };
  }
  return {
    key: 'ok',
    text: rows === null ? `${s.local.row_count || 0} แถว` : `ปีงบ ${year}: ${rows} แถว (มีข้อมูล ${filled})`,
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    title: `ทั้งตาราง ${s.local.row_count || 0} แถว`,
  };
}

/** ตารางใน KHD: เชื่อมไม่ได้ / ยังไม่มี / คีย์ไม่ใช่ hospcode+byear / โครงสร้างต่าง / ตรงกัน */
export function khdBadge(s: TableStruct | undefined, khdAvailable: boolean): StatusBadge {
  if (!khdAvailable || !s || !s.remote) {
    return { key: 'unknown', text: 'ตรวจ KHD ไม่ได้', cls: 'bg-gray-100 text-gray-500 border-gray-200', title: 'เชื่อมต่อฐานข้อมูล KHD ไม่ได้ในขณะนี้' };
  }
  if (!s.remote.exists) {
    return { key: 'none', text: 'ยังไม่มีใน KHD', cls: 'bg-purple-50 text-purple-700 border-purple-200', title: 'สร้างตารางใน KHD จากโครงสร้างของระบบได้ (ต้องมีตารางในระบบก่อน — กดส่งออกข้อมูล)' };
  }
  if (s.remote.key_ok === false) {
    return { key: 'bad_key', text: 'คีย์ KHD ไม่ใช่ hospcode + byear', cls: 'bg-red-50 text-red-700 border-red-200', title: 'ส่งข้อมูลเข้า KHD ไม่ได้ — ตาราง KHD ต้องมีคีย์หลักเป็น hospcode + byear เท่านั้น' };
  }
  const n = (s.diff || []).length;
  if (s.local?.exists && n > 0) {
    return { key: 'different', text: `โครงสร้างต่าง ${n} คอลัมน์`, cls: 'bg-amber-50 text-amber-700 border-amber-200', title: (s.diff || []).map(diffText).join('\n') };
  }
  return { key: 'match', text: `มีใน KHD (${s.remote.row_count || 0} แถว)`, cls: 'bg-teal-50 text-teal-700 border-teal-200', title: s.local?.exists ? 'โครงสร้างตรงกับตารางในระบบ' : 'ยังไม่มีตารางในระบบ — กดส่งออกข้อมูลเพื่อสร้าง' };
}

/** ข้อความของความต่างรายคอลัมน์ (จาก diffTableColumns ของ backend) */
export function diffText(d: any): string {
  const f = d?.field ?? '?';
  if (d?.issue === 'missing_in_remote') return `${f}: มีในระบบ ไม่มีใน KHD`;
  if (d?.issue === 'missing_in_local') return `${f}: มีใน KHD ไม่มีในระบบ`;
  if (d?.issue === 'type_mismatch') return `${f}: ชนิดต่างกัน (ระบบ ${d.local_type ?? '-'} / KHD ${d.remote_type ?? '-'})`;
  return `${f}: ${d?.issue || 'ต่างกัน'}`;
}

/** ตารางที่สร้าง/เพิ่มคอลัมน์ใน KHD ได้: มีในระบบแล้ว และ KHD ยังไม่มี หรือ KHD ขาดคอลัมน์ที่ระบบมี */
export function canPushStructure(s: TableStruct | undefined, khdAvailable: boolean): boolean {
  const k = khdBadge(s, khdAvailable).key;
  return !!s?.local?.exists && (k === 'none' || (k === 'different' && (s.diff || []).some(d => d?.issue === 'missing_in_remote')));
}

/** ตารางในระบบที่เพิ่มคอลัมน์ตาม KHD ได้ (KHD มีคอลัมน์ที่ระบบไม่มี เช่น ช่องของแบบฟอร์ม) */
export function canPullStructure(s: TableStruct | undefined, khdAvailable: boolean): boolean {
  return khdBadge(s, khdAvailable).key === 'different' && (s?.diff || []).some(d => d?.issue === 'missing_in_local');
}
