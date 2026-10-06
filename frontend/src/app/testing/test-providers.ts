// Providers มาตรฐานสำหรับ unit test (ใช้เฉพาะไฟล์ *.spec.ts — ไม่ถูก import จากโค้ดจริง จึงไม่เข้า production bundle)
// HttpClientTesting: ไม่ยิง request จริง — ทุก request ค้างรอใน HttpTestingController จนกว่า test จะ flush เอง
// provideToastr: ToastService (services/toast.service.ts) ใช้ ngx-toastr — ต้องมีเหมือนใน app.config.ts
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideToastr } from 'ngx-toastr';

export const testProviders = [
  provideHttpClient(),
  provideHttpClientTesting(),
  provideRouter([]),
  provideNoopAnimations(),
  provideToastr(),
];
