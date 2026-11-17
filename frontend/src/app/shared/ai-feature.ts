// เปิด-ปิดผู้ช่วย AI รายหน้า (17 พ.ย. 2569) — ผลของ GET /ai/status: { enabled, features: { key: boolean } }
// ไม่มี features (backend เดิม) หรือไม่มี key = ใช้ตามสถานะเปิดรวม | key ตรงกับ AI_AREAS ใน api/services/ai.js
export type AiFeatureKey = 'chart_summary' | 'report_tab' | 'forecast' | 'anomaly' | 'formula' | 'khd_mapping' | 'help' | 'data_quality';
export const aiFeatureOn = (res: any, key: AiFeatureKey): boolean => !!res?.enabled && res?.features?.[key] !== false;
