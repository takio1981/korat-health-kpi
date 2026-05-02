import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import Swal from 'sweetalert2';

let isHandlingInvalidated = false;

/**
 * HTTP interceptor — ดักจับ 401 พร้อม code SESSION_INVALIDATED
 * → เคลียร์ localStorage + redirect /login + แจ้ง user
 * ใช้ flag กันแสดง alert ซ้ำเมื่อหลาย request fail พร้อมกัน
 */
export const sessionInvalidatedInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      const code = err?.error?.code;
      if (err.status === 401 && code === 'SESSION_INVALIDATED' && !isHandlingInvalidated) {
        isHandlingInvalidated = true;
        localStorage.removeItem('kpi_token');
        localStorage.removeItem('kpi_user');
        Swal.fire({
          icon: 'warning',
          title: 'บัญชีถูกใช้งานจากที่อื่น',
          text: err.error?.message || 'ระบบ logout อัตโนมัติเนื่องจากบัญชีของคุณถูก login จากอุปกรณ์อื่น',
          confirmButtonText: 'ตกลง',
          confirmButtonColor: '#10b981'
        }).then(() => {
          isHandlingInvalidated = false;
          router.navigate(['/login']);
        });
      }
      return throwError(() => err);
    })
  );
};
