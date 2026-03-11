import { ComponentFixture, TestBed } from '@angular/core/testing';

import { KpiManage } from './kpi-manage';

describe('KpiManage', () => {
  let component: KpiManage;
  let fixture: ComponentFixture<KpiManage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KpiManage]
    })
    .compileComponents();

    fixture = TestBed.createComponent(KpiManage);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
