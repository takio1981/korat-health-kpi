import { HttpInterceptorFn, HttpErrorResponse, HttpClient } from '@angular/common/http';
import { inject, NgZone } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';

// throttle 5xx errors (กัน loop / spam)
const lastSent = new Map<string, number>();
const THROTTLE_MS = 60 * 1000;

/**
 * HTTP Interceptor — รายงาน 5xx errors ไปยัง backend
 * (สำหรับ 4xx ปล่อย — เป็น user error ทั่วไป)
 *
 * ติดตั้งใน app.config.ts withInterceptors([..., errorReportInterceptor])
 */
export const errorReportInterceptor: HttpInterceptorFn = (req, next) => {
  const http = inject(HttpClient);
  const zone = inject(NgZone);

  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      // รายงานเฉพาะ server error (5xx) + network error (status 0)
      // ข้าม: /errors/report เอง (กัน loop) และ 4xx (user error)
      const isServerError = err.status >= 500 || err.status === 0;
      const isErrorEndpoint = req.url.includes('/errors/report');
      if (isServerError && !isErrorEndpoint) {
        const fp = `${err.status}|${req.url}`;
        const now = Date.now();
        const last = lastSent.get(fp) || 0;
        if (now - last > THROTTLE_MS) {
          lastSent.set(fp, now);
          zone.runOutsideAngular(() => {
            http.post(`${environment.apiUrl}/errors/report`, {
              source: 'http',
              severity: err.status === 0 ? 'warning' : 'error',
              message: `HTTP ${err.status}: ${err.message || 'Network error'} on ${req.method} ${req.url}`,
              url: req.url,
              extra: { status: err.status, method: req.method, errorBody: err.error }
            }).subscribe({ next: () => {}, error: () => {} });
          });
        }
      }
      return throwError(() => err);
    })
  );
};
