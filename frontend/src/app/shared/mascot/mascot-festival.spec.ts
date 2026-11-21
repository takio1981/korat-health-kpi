import {
  FESTIVALS, LUNAR_DATES, activeFestival, childrenDay, easterDate, festivalOn, festivalRange, missingLunar,
  normalizeOutfitMode, sanitizeFestivalDates, thaiDateKey,
} from './mascot-festival';
import { festivalRows, rangeText, thaiDateText } from '../mascot-festival-card';
import { buildMascot, loadThree } from './mascot-model';
import { dressMascot } from './mascot-outfit';
import { collectVoicePhrases, normVoice } from './mascot-voice-phrases';

// ชุดเทศกาลของน้องโคราชดี (21 พ.ย. 2569)
describe('mascot-festival', () => {
  const on = (d: string, dates = {}) => festivalOn(d, dates)?.id ?? null;

  it('ปฏิทินปี 2569 (ค.ศ. 2026): ทุกเทศกาลตรงวัน + ช่วงก่อน/หลัง', () => {
    expect(on('2026-02-16')).toBe('cny'); expect(on('2026-02-19')).toBe('cny'); expect(on('2026-02-20')).toBeNull();
    expect(on('2026-02-14')).toBe('valentine');
    expect(on('2026-03-03')).toBe('makha'); expect(on('2026-03-02')).toBe('makha');
    expect(on('2026-03-23')).toBe('yamo'); expect(on('2026-04-03')).toBe('yamo'); expect(on('2026-04-04')).toBe('easter'); expect(on('2026-04-06')).toBeNull();
    expect(on('2026-04-12')).toBe('songkran'); expect(on('2026-04-16')).toBe('songkran'); expect(on('2026-04-17')).toBeNull();
    expect(on('2026-05-31')).toBe('visakha');
    expect(on('2026-07-29')).toBe('asalha'); expect(on('2026-07-30')).toBe('khaophansa');
    expect(on('2026-08-12')).toBe('motherday'); expect(on('2026-08-13')).toBeNull();
    expect(on('2026-09-25')).toBe('midautumn');
    expect(on('2026-10-10')).toBe('vegetarian'); expect(on('2026-10-18')).toBe('vegetarian'); expect(on('2026-10-19')).toBeNull();
    expect(on('2026-10-26')).toBe('okphansa'); expect(on('2026-10-27')).toBe('okphansa');
    expect(on('2026-10-31')).toBe('halloween');
    expect(on('2026-11-23')).toBe('loykrathong'); expect(on('2026-11-24')).toBe('loykrathong'); expect(on('2026-11-25')).toBeNull();
    expect(on('2026-12-05')).toBe('fatherday');
    expect(on('2026-12-25')).toBe('christmas'); expect(on('2026-12-27')).toBeNull();
    expect(on('2026-12-30')).toBe('newyear'); expect(on('2027-01-02')).toBe('newyear'); expect(on('2027-01-03')).toBeNull();
    expect(on('2026-06-15')).toBeNull();
  });

  it('วันเด็ก = เสาร์ที่ 2 ของ ม.ค. / อีสเตอร์ / ย่าโมมาก่อนอีสเตอร์เมื่อซ้อนกัน', () => {
    expect(childrenDay(2026)).toBe('2026-01-10');
    expect(childrenDay(2027)).toBe('2027-01-09');
    expect(on('2027-01-09')).toBe('childrenday');
    expect(easterDate(2024)).toBe('2024-03-31');
    expect(easterDate(2026)).toBe('2026-04-05');
    expect(easterDate(2027)).toBe('2027-03-28');
    expect(on('2026-04-05')).toBe('easter');
    expect(on('2027-03-28')).toBe('yamo'); // งานย่าโม 23 มี.ค.–3 เม.ย. สำคัญกว่าสำหรับโคราช
  });

  it('ตารางจันทรคติครบปี 2569–2570 / ปีที่ไม่มีวันที่ = ไม่เปลี่ยนชุด จนกว่าผู้ดูแลกรอก', () => {
    expect(missingLunar(2026)).toEqual([]);
    expect(missingLunar(2027)).toEqual([]);
    expect(on('2028-11-02')).toBeNull();
    expect(missingLunar(2028).map(f => f.id)).toContain('loykrathong');
    const dates = { 2028: { loykrathong: '2028-11-02' } };
    expect(on('2028-11-02', dates)).toBe('loykrathong');
    expect(missingLunar(2028, dates).map(f => f.id)).not.toContain('loykrathong');
    // ผู้ดูแลกรอกทับค่าในตารางได้
    expect(on('2026-11-24', { 2026: { loykrathong: '2026-11-10' } })).toBeNull();
    for (const y of Object.keys(LUNAR_DATES)) for (const [id, d] of Object.entries(LUNAR_DATES[y])) {
      expect(d.startsWith(y)).toBe(true);
      expect(FESTIVALS.find(f => f.id === id)?.kind).toBe('lunar');
    }
  });

  it('sanitizeFestivalDates ตัดค่าที่ผิด', () => {
    expect(sanitizeFestivalDates({
      2028: { loykrathong: '2028-11-02', songkran: '2028-04-13', makha: '2028-02-30', visakha: '2029-05-01', toString: '2028-01-01' },
      1999: { makha: '1999-02-01' }, x: 1,
    })).toEqual({ 2028: { loykrathong: '2028-11-02' } });
    expect(sanitizeFestivalDates('{"2029":{"cny":"2029-02-13"}}')).toEqual({ 2029: { cny: '2029-02-13' } });
    expect(sanitizeFestivalDates('ไม่ใช่ json')).toEqual({});
    expect(sanitizeFestivalDates(null)).toEqual({});
  });

  it('เวลาไทย / โหมดชุด', () => {
    expect(thaiDateKey(new Date('2026-11-23T17:30:00Z'))).toBe('2026-11-24');
    expect(thaiDateKey(new Date('2026-11-23T16:59:00Z'))).toBe('2026-11-23');
    expect(normalizeOutfitMode('bogus')).toBe('auto');
    expect(normalizeOutfitMode('none')).toBe('none');
    expect(normalizeOutfitMode('christmas')).toBe('christmas');
    expect(activeFestival('none', '2026-12-25')).toBeNull();
    expect(activeFestival('christmas', '2026-06-01')?.id).toBe('christmas');
    expect(activeFestival('auto', '2026-12-25')?.id).toBe('christmas');
  });

  it('ทุกเทศกาล: มีชุดอย่างน้อย 2 ชิ้น, คำอวยพรไม่มีอีโมจิ และมีไฟล์เสียง (รวมใน collectVoicePhrases)', () => {
    const ids = new Set<string>();
    const phrases = new Set(collectVoicePhrases());
    for (const f of FESTIVALS) {
      expect(ids.has(f.id)).toBe(false); ids.add(f.id);
      expect(Object.keys(f.outfit).length).toBeGreaterThanOrEqual(2);
      expect(/\p{Extended_Pictographic}/u.test(f.greet)).toBe(false);
      expect(phrases.has(normVoice(f.greet))).toBe(true);
      expect(festivalRange(f, 2027)).not.toBeNull();
    }
    expect(FESTIVALS.length).toBeGreaterThanOrEqual(19);
  });

  it('แถวปฏิทินในหน้าตั้งค่า: เรียงตามวันที่ + ทำเครื่องหมายวันนี้', () => {
    const rows = festivalRows(2026, {}, '2026-11-24');
    expect(rows[0].f.id).toBe('newyear');
    expect(rows.find(r => r.today)?.f.id).toBe('loykrathong');
    expect(rows.find(r => r.f.id === 'loykrathong')!.range).toBe('23 พ.ย. 2569 – 24 พ.ย. 2569');
    expect(rows.find(r => r.f.id === 'songkran')!.source).toBe('วันเดิมทุกปี');
    expect(rows.find(r => r.f.id === 'cny')!.source).toBe('ตารางในระบบ');
    const r28 = festivalRows(2028, { 2028: { makha: '2028-02-10' } }, '2026-11-24');
    expect(r28.find(r => r.f.id === 'makha')!.source).toBe('ผู้ดูแลกรอก');
    expect(r28.find(r => r.f.id === 'visakha')!.missing).toBe(true);
    expect(r28[r28.length - 1].missing).toBe(true); // ยังไม่มีวันที่อยู่ท้ายตาราง
    expect(thaiDateText('2026-01-01')).toBe('1 ม.ค. 2569');
    expect(rangeText(['2026-01-01', '2026-01-01'])).toBe('1 ม.ค. 2569');
  });

  it('สร้างชุดทุกเทศกาลบนโมเดลจริงได้ + ถอดแล้วคืนสีผ้าคลุมเดิม', async () => {
    const L = await loadThree();
    const rig = buildMascot(L, document.createElement('canvas'), null);
    const before = { body: rig.body.children.length, head: rig.head.children.length, hand: rig.hands[1].children.length };
    for (const f of FESTIVALS) {
      const o = dressMascot(L, rig, f.outfit);
      expect(o.parts).toBeGreaterThan(0);
      if (f.outfit.cape != null) expect(rig.capeMat.color.getHex()).toBe(f.outfit.cape);
      expect(() => { o.update(1.3); o.update(2.7); }).not.toThrow();
      o.dispose();
      expect(rig.capeMat.color.getHex()).toBe(rig.capeColor);
      expect(rig.body.children.length).toBe(before.body);
      expect(rig.head.children.length).toBe(before.head);
      expect(rig.hands[1].children.length).toBe(before.hand);
    }
    rig.dispose();
  });
});
