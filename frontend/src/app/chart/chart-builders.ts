// สร้าง options ของ ApexCharts สำหรับหน้า "กราฟและสถิติ" จากผล GET /report/chart-stats
// แยกไว้เป็นฟังก์ชันล้วน (ไม่แตะ DOM) เพื่อทดสอบได้ — ทุกกราฟใช้ "ร้อยละผ่านเกณฑ์" แบบนับคู่ (ตัวชี้วัด × หน่วยบริการ)
// เหมือนการ์ดสถิติ/รายงาน ไม่รวมค่าดิบข้ามตัวชี้วัด (หน่วยนับต่างกัน)

export interface ChartGroupRow {
  gkey: any; gname: string;
  pairs: number; with_target: number; passed: number; not_passed: number; no_target: number;
  achievement_pct: number; recording_pct: number;
  indicator_count: number; hospital_count: number; pending_pairs: number;
  [k: string]: any;
}
export interface ChartMonthRow { month: string; label: string; recorded: number; eligible: number; passed: number; pass_pct: number; recording_pct: number; }

const FONT = 'Sarabun, sans-serif';
export const COLOR_PASS = '#10b981';
export const COLOR_FAIL = '#ef4444';
export const COLOR_NOTARGET = '#94a3b8';
export const COLOR_MID = '#f59e0b';

export function pctColor(p: number): string {
  if (p >= 80) return COLOR_PASS;
  if (p >= 50) return COLOR_MID;
  return COLOR_FAIL;
}

export function shortLabel(s: any, max = 48): string {
  const t = String(s ?? '').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ชื่อยาวตัดเป็นหลายบรรทัด (Apex รับ category เป็น string[] = หลายบรรทัด) — ชื่อหมวดหมู่หลายตัวขึ้นต้นเหมือนกันยาวๆ
// ถ้าตัดท้ายทิ้งบรรทัดเดียวจะแยกไม่ออก (พบจริง: "อำเภอที่ผ่านเกณฑ์การใช้ยาอย่างสมเหตุผล (RDU ...)" หลายหมวด)
export function wrapLabel(s: any, width = 44, maxLines = 3): string[] {
  const words = String(s ?? '').trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const push = (w: string) => {
    // คำเดียวยาวเกินบรรทัด (ภาษาไทยไม่เว้นวรรค) → หั่นตามจำนวนตัวอักษร
    while (w.length > width) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, width)); w = w.slice(width); }
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= width) cur += ' ' + w; else { lines.push(cur); cur = w; }
  };
  words.forEach(push);
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].slice(0, width - 1) + '…'; }
  return lines.length ? lines : [''];
}

// ความสูงกราฟแนวนอนตามจำนวนแถวและจำนวนบรรทัดของชื่อ (อ่านชื่อได้ครบไม่ทับกัน)
export function barHeight(n: number, per = 34, min = 260, labels?: string[][]): number {
  const lineRows = labels ? labels.reduce((s, l) => s + Math.max(0, l.length - 1), 0) : 0;
  return Math.max(min, n * per + lineRows * 14 + 90);
}

function selectEvent(rows: any[], onSelect?: (row: any) => void) {
  if (!onSelect) return {};
  return {
    events: {
      dataPointSelection: (_e: any, _ctx: any, cfg: any) => {
        const row = rows[cfg?.dataPointIndex];
        if (row) onSelect(row);
      }
    }
  };
}

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// แถบแนวนอน: ร้อยละผ่านเกณฑ์ต่อกลุ่ม (สีตามระดับ) — เฉพาะกลุ่มที่มีเป้าหมาย
export function buildPctBar(rows: ChartGroupRow[], title: string, onSelect?: (row: ChartGroupRow) => void): any {
  const data = rows.filter(r => r.with_target > 0);
  const cats = data.map(r => wrapLabel(r.gname));
  return {
    series: data.length ? [{ name: 'ร้อยละผ่านเกณฑ์', data: data.map(r => r.achievement_pct) }] : [],
    chart: { type: 'bar', height: barHeight(data.length, 34, 260, cats), fontFamily: FONT, toolbar: { show: true }, ...selectEvent(data, onSelect) },
    plotOptions: { bar: { horizontal: true, distributed: true, barHeight: '70%', borderRadius: 4, dataLabels: { position: 'top' } } },
    colors: data.map(r => pctColor(r.achievement_pct)),
    dataLabels: { enabled: true, formatter: (v: number) => `${v}%`, offsetX: 26, style: { fontSize: '11px', colors: ['#334155'] } },
    xaxis: { categories: cats, min: 0, max: 100, tickAmount: 5, labels: { formatter: (v: any) => `${Math.round(v)}%` } },
    yaxis: { labels: { maxWidth: 340, style: { fontSize: '11px' } } },
    legend: { show: false },
    grid: { borderColor: '#e2e8f0' },
    title: { text: title, align: 'left', style: { fontSize: '15px' } },
    annotations: { xaxis: [{ x: 80, borderColor: COLOR_PASS, strokeDashArray: 4, label: { text: 'เกณฑ์ 80%', style: { color: '#fff', background: COLOR_PASS } } }] },
    tooltip: {
      custom: ({ dataPointIndex }: any) => {
        const r = data[dataPointIndex];
        return `<div style="padding:8px 12px;max-width:360px;white-space:normal"><b>${esc(r.gname)}</b><br>` +
          `ผ่านเกณฑ์ <b>${r.passed}</b> / มีเป้าหมาย ${r.with_target} คู่ = <b>${r.achievement_pct}%</b><br>` +
          `ตัวชี้วัด ${r.indicator_count} · หน่วยบริการ ${r.hospital_count}` +
          (r.no_target ? `<br><span style="color:#64748b">ไม่มีเป้าหมาย ${r.no_target} คู่ (ไม่นับ)</span>` : '') +
          (onSelect ? '<br><i style="color:#64748b">คลิกเพื่อกรองดูเฉพาะรายการนี้</i>' : '') + '</div>';
      }
    }
  };
}

// แถบซ้อน: จำนวนคู่ ผ่าน / ไม่ผ่าน / ไม่มีเป้าหมาย ต่อกลุ่ม
export function buildStatusStack(rows: ChartGroupRow[], title: string, horizontal = true, onSelect?: (row: ChartGroupRow) => void): any {
  const cats = rows.map(r => horizontal ? wrapLabel(r.gname) : wrapLabel(r.gname, 22, 3));
  return {
    series: rows.length ? [
      { name: 'ผ่านเกณฑ์', data: rows.map(r => r.passed) },
      { name: 'ไม่ผ่านเกณฑ์', data: rows.map(r => r.not_passed) },
      { name: 'ไม่มีเป้าหมาย', data: rows.map(r => r.no_target) },
    ] : [],
    chart: { type: 'bar', stacked: true, height: horizontal ? barHeight(rows.length, 34, 260, cats) : 400, fontFamily: FONT, toolbar: { show: true }, ...selectEvent(rows, onSelect) },
    plotOptions: { bar: { horizontal, barHeight: '70%', columnWidth: '55%', borderRadius: 3 } },
    colors: [COLOR_PASS, COLOR_FAIL, COLOR_NOTARGET],
    dataLabels: { enabled: true, formatter: (v: number) => (v ? v : ''), style: { fontSize: '10px' } },
    xaxis: { categories: cats, title: { text: horizontal ? 'จำนวนคู่ (ตัวชี้วัด × หน่วยบริการ)' : '' }, labels: horizontal ? {} : { rotate: 0, style: { fontSize: '10px' } } },
    yaxis: { labels: { maxWidth: 340, style: { fontSize: '11px' } }, title: { text: horizontal ? '' : 'จำนวนคู่' } },
    legend: { position: 'top', horizontalAlign: 'left' },
    title: { text: title, align: 'left', style: { fontSize: '15px' } },
    tooltip: { shared: true, intersect: false, y: { formatter: (v: number) => `${v} คู่` } },
  };
}

// โดนัทภาพรวม: ผ่าน / ไม่ผ่าน / ไม่มีเป้าหมาย
export function buildOverallDonut(o: ChartGroupRow | null): any {
  if (!o || !o.pairs) return { series: [] };
  return {
    series: [o.passed, o.not_passed, o.no_target],
    labels: ['ผ่านเกณฑ์', 'ไม่ผ่านเกณฑ์', 'ไม่มีเป้าหมาย'],
    colors: [COLOR_PASS, COLOR_FAIL, COLOR_NOTARGET],
    chart: { type: 'donut', height: 320, fontFamily: FONT },
    plotOptions: { pie: { donut: { size: '62%', labels: { show: true, total: { show: true, label: 'คู่ทั้งหมด', formatter: () => String(o.pairs) } } } } },
    dataLabels: { enabled: true, formatter: (v: number) => `${v.toFixed(1)}%` },
    legend: { position: 'bottom' },
    title: { text: 'สถานะผลงานภาพรวม', align: 'left', style: { fontSize: '15px' } },
    tooltip: { y: { formatter: (v: number) => `${v} คู่` } },
  };
}

// วงแหวน: ร้อยละผ่านเกณฑ์ + ร้อยละการบันทึก
export function buildOverallRadial(o: ChartGroupRow | null): any {
  if (!o || !o.pairs) return { series: [] };
  return {
    series: [o.achievement_pct, o.recording_pct],
    labels: ['ร้อยละผ่านเกณฑ์', 'ร้อยละมีผลงาน'],
    colors: [pctColor(o.achievement_pct), '#3b82f6'],
    chart: { type: 'radialBar', height: 320, fontFamily: FONT },
    plotOptions: { radialBar: { hollow: { size: '38%' }, dataLabels: { name: { fontSize: '13px' }, value: { fontSize: '20px', formatter: (v: number) => `${v}%` }, total: { show: true, label: 'ผ่านเกณฑ์', formatter: () => `${o.achievement_pct}%` } } } },
    legend: { show: true, position: 'bottom' },
    title: { text: 'ร้อยละภาพรวม', align: 'left', style: { fontSize: '15px' } },
  };
}

// รายเดือน: แท่ง = จำนวนคู่ที่มีผลงานในเดือนนั้น, เส้น = ร้อยละผ่านเกณฑ์รายเดือน (ตัวชี้วัดแบบปกติ)
export function buildMonthlyCombo(months: ChartMonthRow[]): any {
  if (!months?.some(m => m.recorded > 0)) return { series: [] };
  return {
    series: [
      { name: 'จำนวนคู่ที่มีผลงาน', type: 'column', data: months.map(m => m.recorded) },
      { name: 'ร้อยละผ่านเกณฑ์รายเดือน', type: 'line', data: months.map(m => (m.eligible > 0 ? m.pass_pct : null)) },
    ],
    chart: { type: 'line', height: 380, fontFamily: FONT, toolbar: { show: true } },
    stroke: { width: [0, 3], curve: 'smooth' },
    markers: { size: [0, 5] },
    colors: ['#93c5fd', COLOR_PASS],
    labels: months.map(m => m.label),
    dataLabels: { enabled: true, enabledOnSeries: [1], formatter: (v: number) => (v == null ? '' : `${v}%`) },
    yaxis: [
      { title: { text: 'จำนวนคู่' }, labels: { formatter: (v: number) => String(Math.round(v)) } },
      { opposite: true, min: 0, max: 100, title: { text: 'ร้อยละผ่านเกณฑ์' }, labels: { formatter: (v: number) => `${Math.round(v)}%` } },
    ],
    legend: { position: 'top', horizontalAlign: 'left' },
    title: { text: 'แนวโน้มรายเดือน (ต.ค. – ก.ย.)', align: 'left', style: { fontSize: '15px' } },
    tooltip: {
      shared: true, intersect: false,
      custom: ({ dataPointIndex }: any) => {
        const m = months[dataPointIndex];
        return `<div style="padding:8px 12px"><b>${m.label}</b><br>มีผลงาน ${m.recorded} คู่ (${m.recording_pct}%)<br>` +
          (m.eligible ? `ผ่านเกณฑ์ ${m.passed} / ${m.eligible} คู่ = <b>${m.pass_pct}%</b>` : '<span style="color:#64748b">ไม่มีคู่ที่เทียบเกณฑ์รายเดือนได้</span>') + '</div>';
      }
    },
  };
}

// แผนที่ความร้อน กลุ่ม × เดือน — metric: 'pass' = ร้อยละผ่านเกณฑ์รายเดือน | 'record' = ร้อยละมีผลงาน
// ช่องที่ไม่มีข้อมูลให้ค่า -1 (สีเทา) แยกจาก 0% จริง
export function buildHeatmap(rows: { gname: string; months: ChartMonthRow[] }[], title: string, metric: 'pass' | 'record'): any {
  const valid = rows.filter(r => r.months.some(m => m.recorded > 0));
  if (!valid.length) return { series: [] };
  const val = (m: ChartMonthRow) => metric === 'pass' ? (m.eligible > 0 ? m.pass_pct : -1) : (m.recorded > 0 ? m.recording_pct : -1);
  return {
    // Apex วาดแถวจากล่างขึ้นบน — กลับลำดับให้แถวแรกอยู่บนสุด
    series: [...valid].reverse().map(r => ({ name: shortLabel(r.gname, 40), data: r.months.map(m => ({ x: m.label, y: val(m) })) })),
    chart: { type: 'heatmap', height: Math.max(260, valid.length * 30 + 90), fontFamily: FONT, toolbar: { show: true } },
    plotOptions: {
      heatmap: {
        enableShades: false, radius: 2,
        colorScale: { ranges: [
          { from: -1, to: -0.5, color: '#e2e8f0', name: 'ไม่มีข้อมูล' },
          { from: 0, to: 49.99, color: COLOR_FAIL, name: '< 50%' },
          { from: 50, to: 79.99, color: COLOR_MID, name: '50–79%' },
          { from: 80, to: 100, color: COLOR_PASS, name: '≥ 80%' },
        ] }
      }
    },
    dataLabels: { enabled: true, formatter: (v: number) => (v < 0 ? '–' : `${Math.round(v)}`), style: { fontSize: '10px', colors: ['#fff'] } },
    xaxis: { type: 'category' },
    yaxis: { labels: { maxWidth: 300, style: { fontSize: '11px' } } },
    legend: { position: 'top', horizontalAlign: 'left' },
    title: { text: title, align: 'left', style: { fontSize: '15px' } },
    tooltip: { y: { formatter: (v: number) => (v < 0 ? 'ไม่มีข้อมูล' : `${v}%`) } },
  };
}

// การกระจายของตัวชี้วัดตามช่วงร้อยละผ่านเกณฑ์
export function buildDistribution(buckets: { key: string; label: string; count: number }[]): any {
  if (!buckets?.some(b => b.count > 0)) return { series: [] };
  return {
    series: [{ name: 'จำนวนตัวชี้วัด', data: buckets.map(b => b.count) }],
    chart: { type: 'bar', height: 320, fontFamily: FONT, toolbar: { show: true } },
    plotOptions: { bar: { distributed: true, columnWidth: '55%', borderRadius: 4 } },
    colors: [COLOR_FAIL, COLOR_MID, '#34d399', '#059669'],
    dataLabels: { enabled: true },
    xaxis: { categories: buckets.map(b => b.label), title: { text: 'ช่วงร้อยละผ่านเกณฑ์ของตัวชี้วัด' } },
    yaxis: { title: { text: 'จำนวนตัวชี้วัด' }, labels: { formatter: (v: number) => String(Math.round(v)) } },
    legend: { show: false },
    title: { text: 'การกระจายของตัวชี้วัดตามระดับผลสำเร็จ', align: 'left', style: { fontSize: '15px' } },
    tooltip: { y: { formatter: (v: number) => `${v} ตัวชี้วัด` } },
  };
}
