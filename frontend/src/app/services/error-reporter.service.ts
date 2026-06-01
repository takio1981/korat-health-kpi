import { Injectable, ErrorHandler, inject, NgZone } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../../environments/environment';

/**
 * Global ErrorHandler — catch error ที่ uncaught ใน Angular (template, RxJS, etc.)
 * ส่งไปยัง backend `/errors/report` แบบ best-effort
 *
 * ติดตั้งใน app.config.ts:
 *   { provide: ErrorHandler, useClass: GlobalErrorHandler }
 */
@Injectable({ providedIn: 'root' })
export class GlobalErrorHandler implements ErrorHandler {
  private http = inject(HttpClient);
  private zone = inject(NgZone);

  // throttle: ไม่ส่ง error เดียวกันถี่เกิน 1 ครั้ง/นาที (กัน loop)
  private lastSent = new Map<string, number>();
  private THROTTLE_MS = 60 * 1000;

  handleError(error: any): void {
    // log local ก่อน (เพื่อ devtools)
    console.error('[GlobalErrorHandler]', error);

    try {
      const msg = error?.message || String(error);
      const stack = error?.stack || null;
      const fp = (msg || '').slice(0, 100);
      const now = Date.now();
      const last = this.lastSent.get(fp) || 0;
      if (now - last < this.THROTTLE_MS) return;
      this.lastSent.set(fp, now);

      // ส่งนอก zone — กัน loop กับ Angular CD
      this.zone.runOutsideAngular(() => {
        const token = localStorage.getItem('kpi_token');
        const headers = token ? new HttpHeaders({ 'Authorization': `Bearer ${token}` }) : undefined;
        this.http.post(`${environment.apiUrl}/errors/report`, {
          source: 'frontend',
          severity: 'error',
          message: msg,
          stack,
          url: window.location.href,
          extra: { name: error?.name, userAgent: navigator.userAgent }
        }, { headers }).subscribe({ next: () => {}, error: () => {} });
      });
    } catch (_) { /* swallow — error reporter ห้ามพังเอง */ }
  }
}
