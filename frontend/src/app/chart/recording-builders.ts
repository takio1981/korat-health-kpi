// สร้าง options ของ ApexCharts สำหรับแถบ "กราฟและสถิติ" แบบรายงานการบันทึกผลงาน (28 พ.ย. 2569 — ผู้ใช้สั่ง แทนกราฟผ่าน/ไม่ผ่านเกณฑ์)
// ผลจาก GET /report/recording-stats — หน่วยนับ "คู่" ตัวชี้วัด × หน่วยบริการที่ต้องกรอก | ฟังก์ชันล้วน ทดสอบได้
import { wrapLabel, barHeight, shortLabel, pctColor } from './chart-builders';

export interface RecRow {
  gkey: any; gname: string;
  pairs: number; recorded_pairs: number; not_recorded_pairs: number; recording_pct: number;
  due_cells: number; filled_due_cells: number; completeness_pct: number | null;
  filled_cells: number; timed_cells: number; ontime_cells: number; timeliness_pct: number | null;
  approved_cells: number; pending_cells: number; returned_cells: number; approved_pct: number | null;
  anomaly_cells: number; indicator_count: number; hospital_count: number;
  [k: string]: any;
}
export interface RecMonth { month: string; label: string; is_due: boolean; due_pairs: number; filled_due_pairs: number; filled_pairs: number; completeness_pct: number | null; filled_cells: number; timed_cells: number; ontime_cells: number; timeliness_pct: number | null; }

const FONT = 'Sarabun, sans-serif';
export const C_REC = '#10b981';     // บันทึกแล้ว
export const C_NOREC = '#ef4444';   // ยังไม่บันทึก
export const C_COMPLETE = '#3b82f6'; // ครบถ้วน
export const C_TIMELY = '#8b5cf6';   // ทันเวลา
export const C_PENDING = '#f59e0b';  // รอตรวจสอบ
export const C_RETURNED = '#f97316'; // ส่งกลับแก้ไข
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const pctTxt = (v: number | null | undefined) => (v == null ? '–' : `${v}%`);

function selectEvent(rows: any[], onSelect?: (row: any) => void) {
  if (!onSelect) return {};
  return { events: { dataPointSelection: (_e: any, _c: any, cfg: any) => { const r = rows[cfg?.dataPointIndex]; if (r) onSelect(r); } } };
}

/** แถบแนวนอน 3 ชุดต่อกลุ่ม: ร้อยละที่บันทึก / ความครบถ้วนรายเดือน / ความทันเวลา */
export function buildQualityBars(rows: RecRow[], title: string, onSelect?: (row: RecRow) => void): any {
  const data = (rows || []).filter(r => r.pairs > 0);
  if (!data.length) return { series: [] };
  const cats = data.map(r => wrapLabel(r.gname));
  return {
    series: [
      { name: 'ร้อยละหน่วยบริการที่บันทึก', data: data.map(r => r.recording_pct) },
      { name: 'ความครบถ้วนรายเดือน', data: data.map(r => r.completeness_pct) },
      { name: 'ความทันเวลา', data: data.map(r => r.timeliness_pct) },
    ],
    chart: { type: 'bar', height: barHeight(data.length, 54, 280, cats), fontFamily: FONT, toolbar: { show: true }, ...selectEvent(data, onSelect) },
    plotOptions: { bar: { horizontal: true, barHeight: '78%', borderRadius: 3 } },
    colors: [C_REC, C_COMPLETE, C_TIMELY],
    dataLabels: { enabled: true, formatter: (v: number | null) => (v == null ? '' : `${v}%`), style: { fontSize: '10px', colors: ['#334155'] }, offsetX: 18 },
    xaxis: { categories: cats, min: 0, max: 100, tickAmount: 5, labels: { formatter: (v: any) => `${Math.round(v)}%` } },
    yaxis: { labels: { maxWidth: 340, style: { fontSize: '11px' } } },
    legend: { position: 'top', horizontalAlign: 'left' },
    grid: { borderColor: '#e2e8f0' },
    title: { text: title, align: 'left', style: { fontSize: '15px' } },
    tooltip: {
      custom: ({ dataPointIndex }: any) => {
        const r = data[dataPointIndex];
        return `<div style="padding:8px 12px;max-width:380px;white-space:normal"><b>${esc(r.gname)}</b><br>` +
          `บันทึกแล้ว <b>${r.recorded_pairs}</b> / ต้องกรอก ${r.pairs} คู่ = <b>${r.recording_pct}%</b><br>` +
          `ครบถ้วนรายเดือน ${r.filled_due_cells} / ${r.due_cells} ช่อง = <b>${pctTxt(r.completeness_pct)}</b><br>` +
          `ทันเวลา ${r.ontime_cells} / ${r.timed_cells} ช่อง = <b>${pctTxt(r.timeliness_pct)}</b><br>` +
          `อนุมัติ ${r.approved_cells} · รอตรวจ ${r.pending_cells} · ส่งกลับ ${r.returned_cells}` +
          (r.anomaly_cells ? ` · <span style="color:#dc2626">ค่าอาจผิดปกติ ${r.anomaly_cells}</span>` : '') +
          (onSelect ? '<br><i style="color:#64748b">คลิกเพื่อกรองดูเฉพาะรายการนี้</i>' : '') + '</div>';
      }
    }
  };
}

/** แถบซ้อน: คู่ที่บันทึกแล้ว / ยังไม่บันทึก ต่อกลุ่ม */
export function buildRecordStack(rows: RecRow[], title: string, onSelect?: (row: RecRow) => void): any {
  const data = (rows || []).filter(r => r.pairs > 0);
  if (!data.length) return { series: [] };
  const cats = data.map(r => wrapLabel(r.gname));
  return {
    series: [
      { name: 'บันทึกแล้ว', data: data.map(r => r.recorded_pairs) },
      { name: 'ยังไม่บันทึก', data: data.map(r => r.not_recorded_pairs) },
    ],
    chart: { type: 'bar', stacked: true, height: barHeight(data.length, 34, 260, cats), fontFamily: FONT, toolbar: { show: true }, ...selectEvent(data, onSelect) },
    plotOptions: { bar: { horizontal: true, barHeight: '70%', borderRadius: 3 } },
    colors: [C_REC, C_NOREC],
    dataLabels: { enabled: true, formatter: (v: number) => (v ? v : ''), style: { fontSize: '10px' } },
    xaxis: { categories: cats, title: { text: 'จำนวนคู่ (ตัวชี้วัด × หน่วยบริการที่ต้องกรอก)' } },
    yaxis: { labels: { maxWidth: 340, style: { fontSize: '11px' } } },
    legend: { position: 'top', horizontalAlign: 'left' },
    title: { text: title, align: 'left', style: { fontSize: '15px' } },
    tooltip: { shared: true, intersect: false, y: { formatter: (v: number) => `${v} คู่` } },
  };
}

/** โดนัท: คู่ที่บันทึกแล้ว / ยังไม่บันทึก */
export function buildRecordDonut(o: RecRow | null): any {
  if (!o || !o.pairs) return { series: [] };
  return {
    series: [o.recorded_pairs, o.not_recorded_pairs],
    labels: ['บันทึกแล้ว', 'ยังไม่บันทึก'],
    colors: [C_REC, C_NOREC],
    chart: { type: 'donut', height: 320, fontFamily: FONT },
    plotOptions: { pie: { donut: { size: '62%', labels: { show: true, total: { show: true, label: 'คู่ที่ต้องกรอก', formatter: () => String(o.pairs) } } } } },
    dataLabels: { enabled: true, formatter: (v: number) => `${v.toFixed(1)}%` },
    legend: { position: 'bottom' },
    title: { text: 'การบันทึกผลงาน (ปริมาณ)', align: 'left', style: { fontSize: '15px' } },
    tooltip: { y: { formatter: (v: number) => `${v} คู่` } },
  };
}

/** วงแหวนคุณภาพ: บันทึก / ครบถ้วน / ทันเวลา / อนุมัติแล้ว */
export function buildQualityRadial(o: RecRow | null): any {
  if (!o || !o.pairs) return { series: [] };
  const items = [
    ['บันทึกแล้ว', o.recording_pct, C_REC], ['ครบถ้วนรายเดือน', o.completeness_pct, C_COMPLETE],
    ['ทันเวลา', o.timeliness_pct, C_TIMELY], ['อนุมัติแล้ว', o.approved_pct, '#0ea5e9'],
  ].filter(x => x[1] != null) as [string, number, string][];
  return {
    series: items.map(x => x[1]),
    labels: items.map(x => x[0]),
    colors: items.map(x => x[2]),
    chart: { type: 'radialBar', height: 320, fontFamily: FONT },
    plotOptions: { radialBar: { hollow: { size: '30%' }, dataLabels: { name: { fontSize: '12px' }, value: { fontSize: '18px', formatter: (v: number) => `${v}%` }, total: { show: true, label: 'บันทึกแล้ว', formatter: () => `${o.recording_pct}%` } } } },
    legend: { show: true, position: 'bottom' },
    title: { text: 'คุณภาพการบันทึก', align: 'left', style: { fontSize: '15px' } },
  };
}

/** โดนัทสถานะการตรวจสอบของช่องผลงาน */
export function buildReviewDonut(o: RecRow | null): any {
  if (!o || !o.filled_cells) return { series: [] };
  return {
    series: [o.approved_cells, o.pending_cells, o.returned_cells],
    labels: ['อนุมัติแล้ว', 'รอตรวจสอบ', 'ส่งกลับแก้ไข'],
    colors: ['#0ea5e9', C_PENDING, C_RETURNED],
    chart: { type: 'donut', height: 320, fontFamily: FONT },
    plotOptions: { pie: { donut: { size: '62%', labels: { show: true, total: { show: true, label: 'ช่องผลงาน', formatter: () => String(o.filled_cells) } } } } },
    dataLabels: { enabled: true, formatter: (v: number) => `${v.toFixed(1)}%` },
    legend: { position: 'bottom' },
    title: { text: 'สถานะการตรวจสอบผลงาน', align: 'left', style: { fontSize: '15px' } },
    tooltip: { y: { formatter: (v: number) => `${v} ช่อง` } },
  };
}

/** รายเดือน: แท่ง = คู่ที่มีผลงานในเดือนนั้น, เส้น = ความครบถ้วน (เดือนที่ถึงกำหนด) + ความทันเวลา */
export function buildMonthlyRecording(months: RecMonth[]): any {
  if (!months?.some(m => m.filled_pairs > 0 || m.due_pairs > 0)) return { series: [] };
  return {
    series: [
      { name: 'คู่ที่มีผลงานในเดือน', type: 'column', data: months.map(m => m.filled_pairs) },
      { name: 'ความครบถ้วน (%)', type: 'line', data: months.map(m => m.completeness_pct) },
      { name: 'ความทันเวลา (%)', type: 'line', data: months.map(m => m.timeliness_pct) },
    ],
    chart: { type: 'line', height: 380, fontFamily: FONT, toolbar: { show: true } },
    stroke: { width: [0, 3, 3], curve: 'smooth' },
    markers: { size: [0, 5, 5] },
    colors: ['#a7f3d0', C_COMPLETE, C_TIMELY],
    labels: months.map(m => m.label),
    dataLabels: { enabled: true, enabledOnSeries: [1, 2], formatter: (v: number) => (v == null ? '' : `${v}%`) },
    yaxis: [
      { title: { text: 'จำนวนคู่' }, labels: { formatter: (v: number) => String(Math.round(v)) } },
      { opposite: true, min: 0, max: 100, title: { text: 'ร้อยละ' }, labels: { formatter: (v: number) => `${Math.round(v)}%` } },
      { show: false, min: 0, max: 100 },
    ],
    legend: { position: 'top', horizontalAlign: 'left' },
    title: { text: 'การบันทึกรายเดือน (ต.ค. – ก.ย.)', align: 'left', style: { fontSize: '15px' } },
    tooltip: {
      shared: true, intersect: false,
      custom: ({ dataPointIndex }: any) => {
        const m = months[dataPointIndex];
        return `<div style="padding:8px 12px"><b>${m.label}</b>${m.is_due ? '' : ' <span style="color:#64748b">(ยังไม่ถึงกำหนดส่ง)</span>'}<br>` +
          `มีผลงาน ${m.filled_pairs} คู่<br>` +
          (m.due_pairs ? `ครบถ้วน ${m.filled_due_pairs} / ${m.due_pairs} คู่ = <b>${pctTxt(m.completeness_pct)}</b><br>` : '') +
          (m.timed_cells ? `ทันเวลา ${m.ontime_cells} / ${m.timed_cells} ช่อง = <b>${pctTxt(m.timeliness_pct)}</b>` : '') + '</div>';
      }
    },
  };
}

/** แผนที่ความร้อน กลุ่ม × เดือน = ความครบถ้วน (เดือนที่ยังไม่ถึงกำหนด/ไม่มีคู่ = เทา) */
export function buildCompletenessHeatmap(rows: { gname: string; months: { label: string; due: number; filled: number; pct: number | null }[] }[], title: string): any {
  const valid = (rows || []).filter(r => r.months.some(m => m.due > 0));
  if (!valid.length) return { series: [] };
  return {
    series: [...valid].reverse().map(r => ({ name: shortLabel(r.gname, 40), data: r.months.map(m => ({ x: m.label, y: m.pct == null ? -1 : m.pct })) })),
    chart: { type: 'heatmap', height: Math.max(260, valid.length * 30 + 90), fontFamily: FONT, toolbar: { show: true } },
    plotOptions: { heatmap: { enableShades: false, radius: 2, colorScale: { ranges: [
      { from: -1, to: -0.5, color: '#e2e8f0', name: 'ยังไม่ถึงกำหนด/ไม่มีคู่' },
      { from: 0, to: 49.99, color: C_NOREC, name: '< 50%' },
      { from: 50, to: 79.99, color: C_PENDING, name: '50–79%' },
      { from: 80, to: 100, color: C_REC, name: '≥ 80%' },
    ] } } },
    dataLabels: { enabled: true, formatter: (v: number) => (v < 0 ? '–' : `${Math.round(v)}`), style: { fontSize: '10px', colors: ['#fff'] } },
    xaxis: { type: 'category' },
    yaxis: { labels: { maxWidth: 300, style: { fontSize: '11px' } } },
    legend: { position: 'top', horizontalAlign: 'left' },
    title: { text: title, align: 'left', style: { fontSize: '15px' } },
    tooltip: { y: { formatter: (v: number) => (v < 0 ? 'ยังไม่ถึงกำหนด/ไม่มีคู่' : `${v}%`) } },
  };
}

/** การกระจายของหน่วยบริการตามร้อยละการบันทึก */
export function buildHospitalDistribution(buckets: { key: string; label: string; count: number }[]): any {
  if (!buckets?.some(b => b.count > 0)) return { series: [] };
  return {
    series: [{ name: 'จำนวนหน่วยบริการ', data: buckets.map(b => b.count) }],
    chart: { type: 'bar', height: 320, fontFamily: FONT, toolbar: { show: true } },
    plotOptions: { bar: { distributed: true, columnWidth: '55%', borderRadius: 4 } },
    colors: [C_NOREC, '#fb923c', C_PENDING, '#34d399', '#059669'],
    dataLabels: { enabled: true },
    xaxis: { categories: buckets.map(b => b.label), title: { text: 'ร้อยละตัวชี้วัดที่หน่วยบริการบันทึกแล้ว' } },
    yaxis: { title: { text: 'จำนวนหน่วยบริการ' }, labels: { formatter: (v: number) => String(Math.round(v)) } },
    legend: { show: false },
    title: { text: 'การกระจายของหน่วยบริการตามการบันทึก', align: 'left', style: { fontSize: '15px' } },
    tooltip: { y: { formatter: (v: number) => `${v} แห่ง` } },
  };
}

export { pctColor };
