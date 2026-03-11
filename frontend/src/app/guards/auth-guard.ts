import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth';

export const authGuard: CanActivateFn = (route, state) => {
  // เรียกใช้ Service และ Router
  const authService = inject(AuthService);
  const router = inject(Router);

  // ถาม Service ว่าล็อกอินหรือยัง?
  if (authService.isLoggedIn()) {
    return true; // อนุญาตให้ผ่านเข้าหน้า Dashboard ได้
  } else {
    // ถ้ายังไม่ล็อกอิน ให้เตะกลับไปหน้า login
    console.warn('Access Denied: Please login first');
    router.navigate(['/login']);
    return false; // ไม่อนุญาตให้ผ่าน
  }
};