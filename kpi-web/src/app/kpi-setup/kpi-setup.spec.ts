import { ComponentFixture, TestBed } from '@angular/core/testing';

import { KpiSetup } from './kpi-setup';

describe('KpiSetup', () => {
  let component: KpiSetup;
  let fixture: ComponentFixture<KpiSetup>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KpiSetup]
    })
    .compileComponents();

    fixture = TestBed.createComponent(KpiSetup);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
