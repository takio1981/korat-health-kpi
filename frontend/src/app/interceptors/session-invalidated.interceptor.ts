import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import Swal from 'sweetalert2';

let isHandlingInvalidated = false;

/** แปลง User-Agent → ชื่อ browser/OS แบบสั้น (เช่น "Chrome on Windows") */
function parseUA(ua: string): string {
  if (!ua) return 'อุปกรณ์ไม่ทราบ';
  let os = 'OS ไม่ทราบ';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iOS/i.test(ua)) os = 'iOS';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  return `${browser} บน ${os}`;
}

/**
 * HTTP interceptor — ดักจับ 401 พร้อม code SESSION_INVALIDATED
 * → แสดง modal แบบ friendly (มี IP/เวลา/อุปกรณ์ที่ login + countdown) + redirect /login
 * ใช้ flag กันแสดง alert ซ้ำเมื่อหลาย request fail พร้อมกัน
 */
export const sessionInvalidatedInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      const code = err?.error?.code;
      if (err.status === 401 && code === 'SESSION_INVALIDATED' && !isHandlingInvalidated) {
        isHandlingInvalidated = true;

        // ข้อมูล "ใครเตะ"
        const ip = err.error?.kicked_by_ip || '-';
        const ua = err.error?.kicked_by_ua || '';
        const at = err.error?.kicked_at
          ? new Date(err.error.kicked_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
          : '-';
        const deviceLabel = ua ? parseUA(ua) : 'อุปกรณ์อื่น';

        // เคลียร์ token ทันทีที่ backend invalidated แล้ว
        localStorage.removeItem('kpi_token');
        localStorage.removeItem('kpi_user');

        Swal.fire({
          icon: 'info',
          title: 'มีการเข้าใช้บัญชีของคุณจากอุปกรณ์อื่น',
          html: `<div style="text-align:left;font-size:13px">
            <p class="mb-2 text-gray-600">ระบบจำกัด 1 บัญชี = 1 อุปกรณ์ — เพื่อรักษาความปลอดภัย<br>คุณจะถูกออกจากระบบโดยอัตโนมัติ</p>
            <div class="p-3 bg-amber-50 rounded-lg border border-amber-200 text-xs space-y-1">
              <div><b><i class="fas fa-laptop mr-1 text-amber-600"></i>อุปกรณ์ใหม่:</b> ${deviceLabel}</div>
              <div><b><i class="fas fa-globe mr-1 text-amber-600"></i>IP:</b> <code>${ip}</code></div>
              <div><b><i class="fas fa-clock mr-1 text-amber-600"></i>เวลา:</b> ${at}</div>
            </div>
            <p class="mt-3 text-xs text-gray-500">
              <i class="fas fa-shield-halved mr-1 text-emerald-600"></i>
              <b>ไม่ใช่คุณใช่ไหม?</b> เปลี่ยนรหัสผ่านทันทีหลัง login ใหม่ + แจ้งผู้ดูแลระบบ
            </p>
            <p class="mt-2 text-[11px] text-gray-400 text-center" id="kick-countdown">ระบบจะพาไปหน้า Login ใน <b>10</b> วินาที...</p>
          </div>`,
          confirmButtonText: '<i class="fas fa-sign-in-alt mr-1"></i> ไป Login ทันที',
          confirmButtonColor: '#10b981',
          timer: 10000,
          timerProgressBar: true,
          allowOutsideClick: false,
          didOpen: () => {
            // countdown text
            let remain = 10;
            const el = document.getElementById('kick-countdown');
            const interval = setInterval(() => {
              remain--;
              if (el) el.innerHTML = `ระบบจะพาไปหน้า Login ใน <b>${remain}</b> วินาที...`;
              if (remain <= 0) clearInterval(interval);
            }, 1000);
          }
        }).then(() => {
          isHandlingInvalidated = false;
          router.navigate(['/login']);
        });
      }
      return throwError(() => err);
    })
  );
};
