import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KpiSetupComponent } from './kpi-setup';
import { testProviders } from '../testing/test-providers';

describe('KpiSetupComponent', () => {
  let component: KpiSetupComponent;
  let fixture: ComponentFixture<KpiSetupComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KpiSetupComponent],
      providers: testProviders,
    }).compileComponents();

    fixture = TestBed.createComponent(KpiSetupComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
