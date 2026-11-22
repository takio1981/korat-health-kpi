import {
  versionDate, isRecentUpdate, shortChange, plainText, updateNewsNode, announcementNode, newsQueue, announcementKey, updateKey, mascotAnnounces, NEWS_SAY,
} from './mascot-news';
import { CHANGELOG } from '../../changelog/changelog-data';

const e = (version: string, n = 2) => ({ version, date: version, changes: Array.from({ length: n }, (_, i) => ({ type: 'feature', text: `รายการ ${i + 1}: รายละเอียดยาว` })) });

describe('น้องโคราชดีแจ้งข่าว — ฟังก์ชันล้วน', () => {
  it('versionDate / isRecentUpdate: รุ่น พ.ศ. → วันที่, แจ้งเฉพาะรุ่นภายใน 30 วัน', () => {
    expect(versionDate('2569.11.22')?.toISOString().slice(0, 10)).toBe('2026-11-22');
    expect(versionDate('2569.10.11.c')?.toISOString().slice(0, 10)).toBe('2026-10-11');
    expect(versionDate('2569.04.22-schedule')?.toISOString().slice(0, 10)).toBe('2026-04-22');
    expect(versionDate('2569.02.30')).toBeNull();
    expect(versionDate('x')).toBeNull();
    const now = new Date('2026-11-25T03:00:00Z');
    expect(isRecentUpdate(e('2569.11.22'), now)).toBe(true);
    expect(isRecentUpdate(e('2569.10.01'), now)).toBe(false);
  });

  it('shortChange / plainText: หัวข้อสั้น + ตัด HTML ของประกาศ', () => {
    expect(shortChange('กลุ่มงานเพิ่มเติมของผู้ใช้ (ดูแลข้ามกลุ่มงาน): รายละเอียด')).toBe('กลุ่มงานเพิ่มเติมของผู้ใช้');
    expect(shortChange('ก'.repeat(100)).length).toBe(70);
    expect(plainText('<b>ปิดระบบ</b> 20&nbsp;พ.ย.<br><img src=x onerror=alert(1)>')).toBe('ปิดระบบ 20 พ.ย.');
  });

  it('กล่องข่าวอัปเดต: ≤ 3 รายการ + จำนวนที่เหลือ, พูดเฉพาะประโยคเปิด', () => {
    const n = updateNewsNode(e('2569.11.22', 5), { more: 2 });
    expect(n.text.split('\n')[0]).toContain(NEWS_SAY.update);
    expect(n.text).toContain('• ใหม่: รายการ 1');
    expect(n.text).toContain('และอีก 2 รายการ');
    expect(n.text).toContain('อีก 2 ครั้ง');
    expect(n.voice).toEqual([NEWS_SAY.update]);
    expect(n.choices.map(c => c.action)).toEqual(['news:changelog', 'news:ack', 'news:later']);
  });

  it('กล่องประกาศ: ข้อความที่ผู้ดูแลตั้งให้น้องพูดมาก่อน แล้วข้อความประกาศ', () => {
    expect(announcementNode({ title: 'ปิดปรับปรุง', mascot_text: 'ปิดระบบคืนนี้', content_text: 'ยาว' }).text).toBe(`${NEWS_SAY.announce} — ปิดปรับปรุง\nปิดระบบคืนนี้`);
    expect(announcementNode({ content_html: '<i>ส่งผลงานภายในวันที่ 10</i>' }).text).toContain('ส่งผลงานภายในวันที่ 10');
  });

  it('newsQueue: ประกาศก่อนข่าวอัปเดต, แจ้งครั้งเดียว, แก้ประกาศ = แจ้งใหม่, ปิดข่าวอัปเดตได้, เมนู = แสดงทุกครั้ง', () => {
    const now = new Date('2026-11-23T03:00:00Z');
    const log = [e('2569.11.22'), e('2569.11.21'), e('2569.09.01')];
    const a = { id: 4, is_active: 1, mascot_announce: 1, updated_at: '2026-11-22T01:00:00Z', title: 'ประกาศ', content_text: 'ข้อความ' };
    const seen = new Set<string>();
    let q = newsQueue({ announcement: a, changelog: log, seen: k => seen.has(k), now });
    expect(q.map(x => x.key)).toEqual([announcementKey(a), updateKey(log[0])]);
    expect(q[1].node.text).toContain('อีก 1 ครั้ง'); // 11.21 ยังไม่เคยแจ้ง (09.01 เก่าเกิน 30 วัน)
    [announcementKey(a), ...log.map(updateKey)].forEach(k => seen.add(k));
    expect(newsQueue({ announcement: a, changelog: log, seen: k => seen.has(k), now })).toEqual([]);
    expect(newsQueue({ announcement: { ...a, updated_at: '2026-11-23T01:00:00Z' }, changelog: log, seen: k => seen.has(k), now }).length).toBe(1);
    expect(newsQueue({ announcement: { ...a, mascot_announce: 0 }, changelog: log, seen: () => false, now, updatesOn: false })).toEqual([]);
    expect(mascotAnnounces({ ...a, is_active: 0 })).toBe(false);
    q = newsQueue({ announcement: null, changelog: log, seen: k => seen.has(k), now, force: true });
    expect(q.map(x => x.key)).toEqual([updateKey(log[0])]);
  });

  it('ข้อมูลประวัติการอัปเดตจริง: รุ่นล่าสุดอยู่บนสุดและรูปแบบรุ่นถูกต้อง', () => {
    expect(CHANGELOG.length).toBeGreaterThan(10);
    expect(CHANGELOG.every(x => !!versionDate(x.version))).toBe(true);
    const ds = CHANGELOG.map(x => versionDate(x.version)!.getTime());
    expect(ds[0]).toBe(Math.max(...ds));
  });
});
