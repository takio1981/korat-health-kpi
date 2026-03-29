import { Component, signal, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IdleTimeoutService } from './services/idle-timeout.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  protected readonly title = signal('Korat Health KPI');
  private idleTimeoutService = inject(IdleTimeoutService);

  ngOnInit() {
    // เคลียร์ session เก่าเมื่อเปิด browser/tab ใหม่
    // sessionStorage จะหายเมื่อปิด tab → flag จะไม่มี → ล้าง token
    // แต่ F5 refresh จะยังคง sessionStorage ไว้ → ไม่ล้าง token
    const sessionKey = 'kpi_session_active';
    if (!sessionStorage.getItem(sessionKey)) {
      // ตรวจสอบว่า token หมดอายุหรือไม่ ก่อนล้าง
      const token = localStorage.getItem('kpi_token');
      if (token) {
        try {
          const payload = JSON.parse(atob(token.split('.')[1]));
          const isExpired = payload.exp * 1000 < Date.now();
          if (isExpired) {
            localStorage.removeItem('kpi_token');
            localStorage.removeItem('kpi_user');
          }
        } catch (e) {
          // token เสียหาย → ล้างออก
          localStorage.removeItem('kpi_token');
          localStorage.removeItem('kpi_user');
        }
      }
      sessionStorage.setItem(sessionKey, '1');
    }

    this.idleTimeoutService.start();
  }

  ngOnDestroy() {
    this.idleTimeoutService.stop();
  }
}
