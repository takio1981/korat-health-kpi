import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth';

// ตรวจสิทธิ์การเข้าถึงหน้าแบบไดนามิก (ตั้งค่าได้จากหน้า "สิทธิ์การเข้าถึงหน้า" — super_admin เท่านั้น)
// ใช้ route.data['pageKey'] เทียบกับ authService.canAccessPage() แทนการเช็ค role ตายตัวแบบเดิม
export const pageAccessGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isLoggedIn()) {
    router.navigate(['/login']);
    return false;
  }

  const pageKey = route.data?.['pageKey'];
  if (pageKey && !authService.canAccessPage(pageKey)) {
    router.navigate(['/dashboard']);
    return false;
  }

  return true;
};
