import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DistrictMapComponent, districtColor, MAP_COLOR_FAIL, MAP_COLOR_MID, MAP_COLOR_NONE, MAP_COLOR_PASS } from './district-map';
import { DISTRICT_MAP_HEIGHT, DISTRICT_MAP_WIDTH, DISTRICT_SHAPES } from './korat-district-shapes';

describe('DistrictMapComponent (แผนที่ผลงานรายอำเภอ)', () => {
  let fixture: ComponentFixture<DistrictMapComponent>;
  let component: DistrictMapComponent;
  const el = () => fixture.nativeElement as HTMLElement;
  const pathOf = (distid: string) => el().querySelector(`g.district[data-distid="${distid}"] path`) as SVGPathElement;
  const DATA = [
    { id: '3001', name: 'เมืองนครราชสีมา', pct: 92.5, passed: 37, total: 40 },
    { id: 3021, name: 'ปากช่อง', pct: 61, passed: 61, total: 100 },         // id เป็นตัวเลขก็จับคู่ได้
    { id: '3015', name: 'พิมาย', pct: 12, passed: 3, total: 25 },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [DistrictMapComponent] }).compileComponents();
    fixture = TestBed.createComponent(DistrictMapComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('data', DATA);
    fixture.detectChanges();
  });

  it('ข้อมูลรูปร่างครบ 32 อำเภอ รหัส 3001–3032 ไม่ซ้ำ และพิกัดอยู่ใน viewBox', () => {
    expect(DISTRICT_SHAPES.length).toBe(32);
    const ids = DISTRICT_SHAPES.map(s => s.distid).sort();
    expect(new Set(ids).size).toBe(32);
    expect(ids[0]).toBe('3001');
    expect(ids[31]).toBe('3032');
    for (const s of DISTRICT_SHAPES) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.d.startsWith('M')).toBe(true);
      expect(s.d.endsWith('Z')).toBe(true);
      expect(s.cx).toBeGreaterThan(0); expect(s.cx).toBeLessThan(DISTRICT_MAP_WIDTH);
      expect(s.cy).toBeGreaterThan(0); expect(s.cy).toBeLessThan(DISTRICT_MAP_HEIGHT);
    }
    expect(DISTRICT_SHAPES.find(s => s.distid === '3001')?.name).toBe('เมืองนครราชสีมา');
    expect(DISTRICT_SHAPES.find(s => s.distid === '3026')?.name).toBe('เทพารักษ์');
    expect(DISTRICT_SHAPES.find(s => s.distid === '3032')?.name).toBe('เฉลิมพระเกียรติ');
  });

  it('เกณฑ์สีเดียวกับกราฟ: ≥80 เขียว, 50–79 เหลือง, <50 แดง, ไม่มีข้อมูล เทา', () => {
    expect(districtColor(80)).toBe(MAP_COLOR_PASS);
    expect(districtColor(79.9)).toBe(MAP_COLOR_MID);
    expect(districtColor(50)).toBe(MAP_COLOR_MID);
    expect(districtColor(49.9)).toBe(MAP_COLOR_FAIL);
    expect(districtColor(0)).toBe(MAP_COLOR_FAIL);
    expect(districtColor(null)).toBe(MAP_COLOR_NONE);
  });

  it('วาดครบ 32 อำเภอ ระบายสีตามร้อยละผ่านเกณฑ์ อำเภอที่ไม่มีข้อมูลเป็นสีเทา', () => {
    expect(el().querySelectorAll('g.district path').length).toBe(32);
    expect(pathOf('3001').getAttribute('fill')).toBe(MAP_COLOR_PASS);
    expect(pathOf('3021').getAttribute('fill')).toBe(MAP_COLOR_MID);
    expect(pathOf('3015').getAttribute('fill')).toBe(MAP_COLOR_FAIL);
    expect(pathOf('3002').getAttribute('fill')).toBe(MAP_COLOR_NONE);
    expect(component.count('pass')).toBe(1);
    expect(component.count('none')).toBe(29);
    expect(el().textContent).toContain('เมืองนครราชสีมา');
    expect(el().textContent).toContain('93%');                       // ป้ายร้อยละบนแผนที่ (ปัดเป็นจำนวนเต็ม)
    expect(el().querySelector('g.district[data-distid="3001"] title')?.textContent).toContain('37/40');
  });

  it('คลิกอำเภอที่มีข้อมูล → ส่งรหัสอำเภอ / อำเภอที่ไม่มีข้อมูลคลิกแล้วไม่เกิดอะไร', () => {
    const picked: string[] = [];
    component.pick.subscribe(v => picked.push(v));
    (el().querySelector('g.district[data-distid="3021"]') as SVGGElement).dispatchEvent(new Event('click'));
    (el().querySelector('g.district[data-distid="3002"]') as SVGGElement).dispatchEvent(new Event('click'));
    expect(picked).toEqual(['3021']);
  });

  it('อำเภอที่กำลังกรองมีเส้นขอบเน้น และแผงข้างแสดงรายละเอียด', () => {
    expect(el().querySelector('path.selected-outline')).toBeNull();
    fixture.componentRef.setInput('selected', '3015');
    fixture.detectChanges();
    const outline = el().querySelector('path.selected-outline');
    expect(outline?.getAttribute('d')).toBe(DISTRICT_SHAPES.find(s => s.distid === '3015')!.d);
    expect(el().textContent).toContain('อ.พิมาย');
    expect(el().textContent).toContain('ยกเลิกการกรอง');
  });

  it('ข้อมูลเปลี่ยน (เช่น เปลี่ยนตัวกรอง) → สีเปลี่ยนตาม', () => {
    fixture.componentRef.setInput('data', [{ id: '3002', name: 'ครบุรี', pct: 85, passed: 17, total: 20 }]);
    fixture.detectChanges();
    expect(pathOf('3002').getAttribute('fill')).toBe(MAP_COLOR_PASS);
    expect(pathOf('3001').getAttribute('fill')).toBe(MAP_COLOR_NONE);
  });
});
