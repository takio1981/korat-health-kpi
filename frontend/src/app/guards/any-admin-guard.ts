import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth';

export const anyAdminGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (!authService.isLoggedIn()) {
    router.navigate(['/login']);
    return false;
  }

  const role = authService.getUserRole();
  if (['admin_hos', 'admin_sso', 'admin_cup', 'admin_ssj', 'super_admin'].includes(role)) {
    return true;
  }

  router.navigate(['/dashboard']);
  return false;
};
