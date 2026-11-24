/**
 * ลายน้ำพื้นหลังตามเทศกาล (24 พ.ย. 2569 — ผู้ใช้สั่ง: เปลี่ยน theme ตามวันเทศกาลที่น้องคิดดีเปลี่ยนชุด)
 * ฟังก์ชันล้วน: เทศกาล (FESTIVALS ใน shared/mascot/mascot-festival.ts) → ลวดลาย SVG ซ้ำ (data URI) + สีจาง ๆ
 * — วาดด้วยรูปทรงง่าย ๆ ในโค้ด (ไม่มีไฟล์ภาพ/ฟอนต์ภายนอก) | ห้ามใช้อีโมจิ (บางเครื่องแสดงเป็นกล่อง)
 */
export type MotifKind = 'lotus' | 'candle' | 'lantern' | 'coin' | 'moon' | 'flag' | 'krathong' | 'flower' | 'star'
  | 'firework' | 'heart' | 'drop' | 'pumpkin' | 'snowflake' | 'tree' | 'balloon' | 'egg' | 'jasmine';

export interface BackdropTheme {
  /** ลวดลายที่วางสลับกันในแผ่นลาย (2–3 แบบ) */
  motifs: MotifKind[];
  /** สีของลวดลาย */
  color: string;
  /** สีอ่อนที่ไล่จากมุมบน (เข้ากับธีม) */
  tint: string;
}

// แต่ละเทศกาลใน FESTIVALS ต้องมีลาย (spec ตรวจครบทุก id)
export const FESTIVAL_BACKDROPS: Record<string, BackdropTheme> = {
  makha:       { motifs: ['lotus', 'candle'], color: '#b45309', tint: '#fde68a' },
  visakha:     { motifs: ['lotus', 'candle', 'star'], color: '#b45309', tint: '#fde68a' },
  asalha:      { motifs: ['lotus', 'candle'], color: '#b45309', tint: '#fde68a' },
  khaophansa:  { motifs: ['candle', 'lotus'], color: '#c2410c', tint: '#fed7aa' },
  okphansa:    { motifs: ['lotus', 'lantern', 'star'], color: '#b45309', tint: '#fde68a' },
  cny:         { motifs: ['lantern', 'coin'], color: '#dc2626', tint: '#fecaca' },
  midautumn:   { motifs: ['moon', 'lantern'], color: '#d97706', tint: '#fde68a' },
  vegetarian:  { motifs: ['flag', 'lotus'], color: '#ca8a04', tint: '#fef08a' },
  loykrathong: { motifs: ['krathong', 'moon', 'star'], color: '#0369a1', tint: '#bae6fd' },
  yamo:        { motifs: ['flower', 'star'], color: '#a16207', tint: '#fef3c7' },
  newyear:     { motifs: ['firework', 'star'], color: '#7c3aed', tint: '#ddd6fe' },
  valentine:   { motifs: ['heart', 'flower'], color: '#db2777', tint: '#fbcfe8' },
  songkran:    { motifs: ['drop', 'flower'], color: '#0284c7', tint: '#bae6fd' },
  motherday:   { motifs: ['jasmine', 'heart'], color: '#1d4ed8', tint: '#bfdbfe' },
  halloween:   { motifs: ['pumpkin', 'star', 'moon'], color: '#ea580c', tint: '#fed7aa' },
  fatherday:   { motifs: ['flower', 'heart'], color: '#ca8a04', tint: '#fef08a' },
  christmas:   { motifs: ['snowflake', 'tree', 'star'], color: '#15803d', tint: '#bbf7d0' },
  childrenday: { motifs: ['balloon', 'star'], color: '#d97706', tint: '#fde68a' },
  easter:      { motifs: ['egg', 'flower'], color: '#9333ea', tint: '#e9d5ff' },
};

/** ลวดลาย 1 ชิ้นในกรอบ 40×40 (ใช้สี c) */
export function motifSvg(kind: MotifKind, c: string): string {
  switch (kind) {
    case 'lotus': return `<path d="M20 32c-6-3-9-9-8-15 4 2 7 6 8 11 1-5 4-9 8-11 1 6-2 12-8 15z" fill="${c}"/><path d="M20 30c-3-5-3-11 0-16 3 5 3 11 0 16z" fill="${c}"/><path d="M8 33h24" stroke="${c}" stroke-width="2" stroke-linecap="round"/>`;
    case 'candle': return `<rect x="16" y="16" width="8" height="18" rx="1.5" fill="${c}"/><path d="M20 6c3 4 3 6 0 8-3-2-3-4 0-8z" fill="${c}"/>`;
    case 'lantern': return `<path d="M20 6v4" stroke="${c}" stroke-width="2"/><ellipse cx="20" cy="20" rx="10" ry="10" fill="${c}"/><rect x="15" y="9" width="10" height="3" rx="1" fill="${c}"/><rect x="15" y="28" width="10" height="3" rx="1" fill="${c}"/><path d="M20 31v5" stroke="${c}" stroke-width="2"/>`;
    case 'coin': return `<circle cx="20" cy="20" r="11" fill="none" stroke="${c}" stroke-width="3"/><rect x="16.5" y="16.5" width="7" height="7" fill="${c}"/>`;
    case 'moon': return `<path d="M26 8a12 12 0 1 0 6 20A10 10 0 0 1 26 8z" fill="${c}"/>`;
    case 'flag': return `<path d="M11 6v28" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/><path d="M12 7h18l-4 6 4 6H12z" fill="${c}"/>`;
    case 'krathong': return `<path d="M6 26h28l-4 7H10z" fill="${c}"/><path d="M10 26c2-7 5-10 10-12 5 2 8 5 10 12z" fill="${c}" opacity=".7"/><path d="M20 8v6" stroke="${c}" stroke-width="2"/><path d="M20 4c2 2 2 3 0 4-2-1-2-2 0-4z" fill="${c}"/>`;
    case 'flower': return `<g fill="${c}"><circle cx="20" cy="11" r="5"/><circle cx="28.5" cy="17" r="5"/><circle cx="25.3" cy="27" r="5"/><circle cx="14.7" cy="27" r="5"/><circle cx="11.5" cy="17" r="5"/></g><circle cx="20" cy="20" r="4" fill="#fff" opacity=".8"/>`;
    case 'star': return `<path d="M20 6l3.5 9.2 9.8.6-7.6 6.2 2.5 9.6L20 26.2l-8.2 5.4 2.5-9.6-7.6-6.2 9.8-.6z" fill="${c}"/>`;
    case 'firework': return `<g stroke="${c}" stroke-width="2" stroke-linecap="round"><path d="M20 4v8M20 28v8M4 20h8M28 20h8M8.7 8.7l5.6 5.6M25.7 25.7l5.6 5.6M8.7 31.3l5.6-5.6M25.7 14.3l5.6-5.6"/></g><circle cx="20" cy="20" r="3" fill="${c}"/>`;
    case 'heart': return `<path d="M20 33S6 24 6 15a7 7 0 0 1 14-2 7 7 0 0 1 14 2c0 9-14 18-14 18z" fill="${c}"/>`;
    case 'drop': return `<path d="M20 5c6 9 10 14 10 20a10 10 0 0 1-20 0c0-6 4-11 10-20z" fill="${c}"/>`;
    case 'pumpkin': return `<ellipse cx="14" cy="23" rx="7" ry="10" fill="${c}"/><ellipse cx="26" cy="23" rx="7" ry="10" fill="${c}"/><ellipse cx="20" cy="23" rx="6" ry="11" fill="${c}"/><path d="M20 12c0-3 2-5 4-6" stroke="${c}" stroke-width="2.5" fill="none"/>`;
    case 'snowflake': return `<g stroke="${c}" stroke-width="2" stroke-linecap="round" fill="none"><path d="M20 5v30M7 12.5l26 15M7 27.5l26-15"/><path d="M16 8l4 3 4-3M16 32l4-3 4 3"/></g>`;
    case 'tree': return `<path d="M20 4l9 12h-5l7 9h-6l6 8H9l6-8H9l7-9h-5z" fill="${c}"/><rect x="18" y="33" width="4" height="4" fill="${c}"/>`;
    case 'balloon': return `<ellipse cx="20" cy="16" rx="9" ry="11" fill="${c}"/><path d="M20 27l-2 3h4z" fill="${c}"/><path d="M20 30c-2 3 2 5 0 8" stroke="${c}" stroke-width="1.5" fill="none"/>`;
    case 'egg': return `<path d="M20 5c7 0 11 11 11 18a11 11 0 0 1-22 0C9 16 13 5 20 5z" fill="${c}"/><path d="M10 22l4-3 4 3 4-3 4 3 4-3" stroke="#fff" stroke-width="2" fill="none" opacity=".8"/>`;
    case 'jasmine': return `<g fill="${c}"><circle cx="20" cy="14" r="4.5"/><circle cx="25.5" cy="20" r="4.5"/><circle cx="20" cy="26" r="4.5"/><circle cx="14.5" cy="20" r="4.5"/></g><circle cx="20" cy="20" r="3" fill="#fff" opacity=".8"/><path d="M20 30v7" stroke="${c}" stroke-width="2"/>`;
  }
}

/** แผ่นลาย 160×160: วางลวดลายสลับ 4 ตำแหน่ง (หมุน/ย่อเล็กน้อยให้ดูเป็นธรรมชาติ) */
export function backdropTileSvg(theme: BackdropTheme): string {
  const spots = [
    { x: 10, y: 12, r: -12, s: 1 }, { x: 92, y: 30, r: 10, s: 0.8 },
    { x: 40, y: 92, r: 6, s: 0.85 }, { x: 112, y: 108, r: -8, s: 1 },
  ];
  const parts = spots.map((p, i) => {
    const m = theme.motifs[i % theme.motifs.length];
    return `<g transform="translate(${p.x} ${p.y}) rotate(${p.r} 20 20) scale(${p.s})">${motifSvg(m, theme.color)}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">${parts}</svg>`;
}

/** ค่าสำหรับ style ของชั้นลายน้ำ — null = ไม่มีลาย (ไม่มีเทศกาล / ไม่รู้จัก id) */
export function backdropStyle(festivalId: string | null | undefined): { [k: string]: string } | null {
  const t = festivalId ? FESTIVAL_BACKDROPS[festivalId] : null;
  if (!t) return null;
  const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(backdropTileSvg(t));
  return {
    'background-image': `url("${uri}"), radial-gradient(ellipse at 85% 0%, ${t.tint} 0%, transparent 60%)`,
    'background-size': '160px 160px, 100% 100%',
    'background-repeat': 'repeat, no-repeat',
  };
}
