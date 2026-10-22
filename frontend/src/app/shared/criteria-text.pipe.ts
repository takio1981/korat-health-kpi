import { Pipe, PipeTransform } from '@angular/core';
import { CONDITION_SYMBOL } from './kpi-target';

/**
 * แปลง target_condition + criterion ("เกณฑ์") ของตัวชี้วัดเป็นข้อความ "เงื่อนไข+เกณฑ์" เดียว เช่น "≥ 80%"
 * รองรับทั้งชื่อฟิลด์ตรง (criterion/target_condition) และชื่อ alias จาก endpoint ที่ join
 * กับ kpi_summary (ind_criterion/ind_target_condition) — คืนค่าว่างถ้าไม่มีข้อมูล
 * หมายเหตุ: criterion คนละฟิลด์กับ target_percentage ("เป้าหมาย") — ดู CLAUDE.md หัวข้อ "เป้าหมาย vs เกณฑ์"
 */
@Pipe({ name: 'criteriaText', standalone: true })
export class CriteriaTextPipe implements PipeTransform {

  transform(item: any): string {
    if (!item) return '';
    const pct = item.criterion ?? item.ind_criterion;
    if (pct == null || pct === '') return '';
    const condition = item.target_condition ?? item.ind_target_condition;
    const sym = (CONDITION_SYMBOL as any)[String(condition || '').trim().toUpperCase()] || ''; // ≥ > ≤ < = (shared/kpi-target.ts)
    return `${sym ? sym + ' ' : ''}${pct}%`;
  }
}
