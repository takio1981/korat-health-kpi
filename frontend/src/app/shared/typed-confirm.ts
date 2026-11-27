// ยืนยันปุ่มเสี่ยงด้วยการพิมพ์ (22 พ.ย. 2569) — ย้ายจาก db-compare/db-compare.ts เมื่อรวมหน้าจัดการข้อมูล KPI เป็นหน้าเดียว (27 พ.ย. 2569)
/** ข้อความที่ต้องพิมพ์ยืนยันปุ่มเสี่ยง (ตรงกับ api core/validate.js typedConfirmText): 1 ตาราง = ชื่อตาราง | หลายตาราง = "<จำนวน> ตาราง" */
export function confirmTextFor(tables: string[]): string {
  return tables.length === 1 ? String(tables[0]) : `${tables.length} ตาราง`;
}
/** ส่วนเพิ่มของ Swal: ช่องพิมพ์ยืนยัน (server ตรวจซ้ำ) */
export function typedConfirmSwal(tables: string[]) {
  const expected = confirmTextFor(tables);
  const esc = expected.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
  return {
    expected,
    footerHtml: `<p class="text-xs text-gray-600 mt-3">พิมพ์ <b>${esc}</b> เพื่อยืนยัน</p>`,
    input: 'text' as const,
    inputPlaceholder: expected,
    inputValidator: (v: string) => (String(v || '').trim() === expected ? null : `กรุณาพิมพ์ "${expected}" ให้ตรง`),
  };
}
