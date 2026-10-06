import { ComponentFixture, TestBed } from '@angular/core/testing';
import { KpiManageComponent } from './kpi-manage';
import { testProviders } from '../testing/test-providers';

describe('KpiManageComponent', () => {
  let component: KpiManageComponent;
  let fixture: ComponentFixture<KpiManageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [KpiManageComponent],
      providers: testProviders,
    }).compileComponents();

    fixture = TestBed.createComponent(KpiManageComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
