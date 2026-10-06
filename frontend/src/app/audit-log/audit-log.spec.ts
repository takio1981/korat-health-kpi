import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AuditLogComponent } from './audit-log';
import { testProviders } from '../testing/test-providers';

describe('AuditLogComponent', () => {
  let component: AuditLogComponent;
  let fixture: ComponentFixture<AuditLogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AuditLogComponent],
      providers: testProviders,
    }).compileComponents();

    fixture = TestBed.createComponent(AuditLogComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
