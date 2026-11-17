// เปิด-ปิดผู้ช่วย AI รายหน้า (17 พ.ย. 2569) — ผลของ GET /ai/status: { enabled, features: { key: boolean } }
// ไม่มี features (backend เดิม) หรือไม่มี key = ใช้ตามสถานะเปิดรวม | key ตรงกับ AI_AREAS ใน api/services/ai.js
export type AiFeatureKey = 'chart_summary' | 'report_tab' | 'forecast' | 'anomaly' | 'formula' | 'khd_mapping' | 'help' | 'data_quality';
export const aiFeatureOn = (res: any, key: AiFeatureKey): boolean => !!res?.enabled && res?.features?.[key] !== false;

/** ข้อความผิดพลาดของคำขอ AI (17 พ.ย. 2569) — ใช้ข้อความจาก server ก่อน; ไม่มีข้อความ (gateway ตัด/หมดเวลา) = อธิบายเป็นภาษาไทย */
export function aiErrorText(err: any, fallback: string): string {
  const msg = err?.error?.message;
  if (typeof msg === 'string' && msg) return msg;
  const st = Number(err?.status);
  if (st === 0) return 'การเชื่อมต่อขาดหรือหมดเวลาระหว่างรอผู้ช่วย AI — กรุณาลองใหม่อีกครั้ง';
  if (st === 502 || st === 503 || st === 504) return `ผู้ให้บริการ AI หรือเซิร์ฟเวอร์ไม่ตอบสนองชั่วคราว (${st}) — กรุณาลองใหม่อีกครั้งภายหลัง`;
  return fallback;
}
