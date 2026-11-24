import { TestBed } from '@angular/core/testing';
import { FESTIVALS } from './mascot/mascot-festival';
import { FESTIVAL_BACKDROPS, backdropStyle, backdropTileSvg, motifSvg, MotifKind } from './festival-backdrop-theme';
import { FestivalBackdropComponent } from './festival-backdrop';
import { MascotService } from './mascot/mascot.service';

describe('festival-backdrop-theme', () => {
  it('ทุกเทศกาลของชุดน้องคิดดีมีลายพื้นหลัง และไม่มีลายของเทศกาลที่ไม่มีจริง', () => {
    for (const f of FESTIVALS) expect(FESTIVAL_BACKDROPS[f.id], f.id).toBeTruthy();
    const ids = new Set(FESTIVALS.map(f => f.id));
    expect(Object.keys(FESTIVAL_BACKDROPS).filter(k => !ids.has(k))).toEqual([]);
  });

  it('แผ่นลายทุกเทศกาลเป็น SVG ที่ถูกต้อง (ไม่มีอีโมจิ/ข้อความ)', () => {
    const parser = new DOMParser();
    for (const [id, t] of Object.entries(FESTIVAL_BACKDROPS)) {
      const svg = backdropTileSvg(t);
      const doc = parser.parseFromString(svg, 'image/svg+xml');
      expect(doc.getElementsByTagName('parsererror').length, id).toBe(0);
      expect(doc.querySelectorAll('g[transform]').length).toBe(4);
      expect(svg).not.toMatch(/<text/);
      expect(/^#[0-9a-f]{6}$/.test(t.color) && /^#[0-9a-f]{6}$/.test(t.tint)).toBe(true);
    }
    const kinds: MotifKind[] = ['lotus', 'candle', 'lantern', 'coin', 'moon', 'flag', 'krathong', 'flower', 'star', 'firework', 'heart', 'drop', 'pumpkin', 'snowflake', 'tree', 'balloon', 'egg', 'jasmine'];
    for (const k of kinds) expect(motifSvg(k, '#000000').length, k).toBeGreaterThan(20);
  });

  it('backdropStyle: เทศกาลที่รู้จัก = ลายซ้ำ + สีไล่, ไม่มี/ไม่รู้จัก = null', () => {
    const s = backdropStyle('cny')!;
    expect(s['background-image']).toContain('data:image/svg+xml');
    expect(s['background-image']).toContain('#fecaca');
    expect(s['background-repeat']).toBe('repeat, no-repeat');
    expect(backdropStyle(null)).toBeNull();
    expect(backdropStyle('nope')).toBeNull();
  });
});

describe('FestivalBackdropComponent', () => {
  const setup = () => {
    TestBed.configureTestingModule({ imports: [FestivalBackdropComponent] });
    const f = TestBed.createComponent(FestivalBackdropComponent);
    const svc = TestBed.inject(MascotService);
    f.detectChanges();
    return { f, svc, el: f.nativeElement as HTMLElement };
  };
  afterEach(() => TestBed.inject(MascotService).outfitPreview$.next(null));

  it('ตามเทศกาลของชุด: ลองชุด = เห็นลายทันที, ไม่เปลี่ยนชุด = ไม่มีลาย, ปิดสวิตช์ = ไม่มีลาย', () => {
    const { f, svc, el } = setup();
    svc.setOutfitConfig('christmas', {});
    f.detectChanges();
    expect(el.querySelector('.fb-layer')?.getAttribute('data-festival')).toBe('christmas');
    svc.outfitPreview$.next('loykrathong');
    f.detectChanges();
    expect(el.querySelector('.fb-layer')?.getAttribute('data-festival')).toBe('loykrathong');
    svc.outfitPreview$.next('none');
    f.detectChanges();
    expect(el.querySelector('.fb-layer')).toBeNull();
    svc.outfitPreview$.next(null);
    svc.setBackdropEnabled(false);
    f.detectChanges();
    expect(el.querySelector('.fb-layer')).toBeNull();
    svc.setBackdropEnabled(undefined);   // ไม่มีค่า = เปิด
    f.detectChanges();
    expect(el.querySelector('.fb-layer')?.getAttribute('data-festival')).toBe('christmas');
    expect(f.nativeElement.getAttribute('aria-hidden')).toBe('true');
    f.destroy();
  });
});
