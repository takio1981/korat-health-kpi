/**
 * น้องโคราชดีแจ้งข่าว (22 พ.ย. 2569 — ผู้ใช้สั่ง): ข่าวอัปเดตการพัฒนาระบบ (ประวัติการอัปเดต) + ประกาศที่ผู้ดูแลเลือก "ให้น้องโคราชดีแจ้งข่าว"
 * ฟังก์ชันล้วน — ผู้ช่วย (mascot-assistant.ts) เรียกตอนเข้าระบบ/เปลี่ยนหน้า และตรวจประกาศใหม่เป็นระยะ
 * แจ้งครั้งเดียวต่อข่าวต่อบัญชีในเครื่อง ("ไว้ทีหลัง" = แจ้งอีกครั้งรอบถัดไป) — เสียงพูดเฉพาะประโยคเปิด (มีไฟล์เสียง) เนื้อหาแสดงในกล่องคำพูด
 */
import type { ResolvedNode } from './mascot-dialog';
import type { ChangelogEntry } from '../../changelog/changelog-data';

/** ประโยคที่พูดออกเสียง (มีไฟล์เสียง — แก้แล้วรัน build-mascot-voice.js) */
export const NEWS_SAY = {
  update: 'มีข่าวอัปเดตการพัฒนาระบบครับ',
  announce: 'มีประกาศจากผู้ดูแลระบบครับ',
  none: 'ตอนนี้ยังไม่มีข่าวใหม่ครับ ดูประวัติการอัปเดตทั้งหมดได้นะครับ',
};
export const NEWS_MENU_LABEL = 'ข่าวอัปเดตและประกาศ';
/** แจ้งข่าวอัปเดตเฉพาะรุ่นที่ออกไม่เกินกี่วัน (บัญชีใหม่ไม่ต้องฟังข่าวเก่า) */
export const UPDATE_NEWS_DAYS = 30;
const MAX_ITEMS = 3;

const TYPE_LABEL: Record<string, string> = { feature: 'ใหม่', improve: 'ปรับปรุง', fix: 'แก้ไข' };

/** รุ่น 'YYYY(พ.ศ.).MM.DD' (+ '.a' / '-2' ได้ — หลายรุ่นในวันเดียว) → วันที่ (UTC) | null */
export function versionDate(v: string): Date | null {
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[.-][a-z0-9]+)?$/i.exec(String(v || '').trim());
  if (!m) return null;
  const y = Number(m[1]) - 543, mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return isNaN(dt.getTime()) || dt.getUTCMonth() !== mo - 1 ? null : dt;
}
export function isRecentUpdate(entry: ChangelogEntry | null | undefined, now: Date = new Date(), days = UPDATE_NEWS_DAYS): boolean {
  const d = entry ? versionDate(entry.version) : null;
  return !!d && now.getTime() - d.getTime() <= days * 86400000 && now.getTime() >= d.getTime() - 86400000;
}

/** หัวข้อสั้นของรายการอัปเดต: ส่วนก่อน ":" / " — " / "(" แรก ตัดไม่เกิน max ตัวอักษร */
export function shortChange(text: string, max = 70): string {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  const cut = t.search(/[:(]| — | · /);
  if (cut > 8) t = t.slice(0, cut).trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** ข้อความล้วนจาก HTML ของประกาศ (ไม่ใช้ innerHTML) */
export function plainText(html: string): string {
  return String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

export const updateKey = (e: ChangelogEntry) => 'u:' + e.version;
/** ประกาศเดียวกันที่ถูกแก้ไข = ข่าวใหม่ (แจ้งอีกครั้ง) */
export const announcementKey = (a: any) => `a:${a?.id}:${a?.updated_at || ''}`;
/** ประกาศที่ให้น้องโคราชดีแจ้ง: เปิดใช้งาน + ผู้ดูแลติ๊กตัวเลือก */
export const mascotAnnounces = (a: any) => !!a && Number(a.is_active) === 1 && Number(a.mascot_announce) === 1;

export function updateNewsNode(e: ChangelogEntry, opts: { more?: number } = {}): ResolvedNode {
  const items = (e.changes || []).slice(0, MAX_ITEMS).map(c => `• ${TYPE_LABEL[c.type] ? TYPE_LABEL[c.type] + ': ' : ''}${shortChange(c.text)}`);
  const rest = (e.changes || []).length - items.length;
  const lines = [`${NEWS_SAY.update} (${e.date})`, ...items, ...(rest > 0 ? [`และอีก ${rest} รายการ`] : []), ...(opts.more ? [`(มีอัปเดตก่อนหน้านี้อีก ${opts.more} ครั้ง)`] : [])];
  return {
    id: 'news-update', text: lines.join('\n'), voice: [NEWS_SAY.update], kind: 'shout', pose: 'cheer', mood: 'happy',
    choices: [{ label: 'ดูรายละเอียด', action: 'news:changelog' }, { label: 'รับทราบ', action: 'news:ack' }, { label: 'ไว้ทีหลัง', action: 'news:later' }],
    auto: null, pointAt: null,
  };
}

export function announcementNode(a: any): ResolvedNode {
  let body = String(a?.mascot_text || '').trim() || String(a?.content_text || '').trim() || plainText(a?.content_html || '');
  if (body.length > 300) body = body.slice(0, 299).trimEnd() + '…';
  const title = String(a?.title || '').trim();
  return {
    id: 'news-announce', text: `${NEWS_SAY.announce}${title ? ` — ${title}` : ''}\n${body}`, voice: [NEWS_SAY.announce], kind: 'shout', pose: 'wave', mood: 'happy',
    choices: [{ label: 'ดูประกาศ', action: 'news:announce' }, { label: 'รับทราบ', action: 'news:ack' }, { label: 'ไว้ทีหลัง', action: 'news:later' }],
    auto: null, pointAt: null,
  };
}

export function noNewsNode(): ResolvedNode {
  return {
    id: 'news-none', text: NEWS_SAY.none, kind: 'speech', pose: 'talk', mood: 'happy',
    choices: [{ label: 'ดูประวัติการอัปเดต', action: 'news:changelog' }, { label: 'ปิด', next: 'bye' }], auto: null, pointAt: null,
  };
}

/** คิวข่าวที่ต้องแจ้ง (ประกาศก่อน แล้วข่าวอัปเดต) — force = เปิดจากเมนู (แสดงแม้เคยแจ้งแล้ว) */
export function newsQueue(o: { announcement: any; changelog: ChangelogEntry[]; seen: (k: string) => boolean; now?: Date; force?: boolean; updatesOn?: boolean }):
  { key: string; node: ResolvedNode }[] {
  const out: { key: string; node: ResolvedNode }[] = [];
  const a = o.announcement;
  if (mascotAnnounces(a) && (o.force || !o.seen(announcementKey(a)))) out.push({ key: announcementKey(a), node: announcementNode(a) });
  const latest = (o.changelog || [])[0];
  if (latest && o.updatesOn !== false && (o.force || (isRecentUpdate(latest, o.now) && !o.seen(updateKey(latest))))) {
    // รุ่นก่อนหน้าที่ยังไม่เคยแจ้งและออกในช่วงเดียวกัน — นับรวมไว้ ไม่แจ้งแยก
    const more = o.force ? 0 : o.changelog.slice(1).filter(e => isRecentUpdate(e, o.now) && !o.seen(updateKey(e))).length;
    out.push({ key: updateKey(latest), node: updateNewsNode(latest, { more }) });
  }
  return out;
}
