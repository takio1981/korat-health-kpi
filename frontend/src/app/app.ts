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
    // เคลียร์ session เก่าทุกครั้งที่เปิดแอปใหม่ (เปิด tab/หน้าต่างใหม่)
    // ใช้ sessionStorage เป็น flag: ถ้ายังไม่มี = เพิ่งเปิดใหม่ → ล้างทั้งหมด
    if (!sessionStorage.getItem('kpi_session_active')) {
      localStorage.removeItem('kpi_token');
      localStorage.removeItem('kpi_user');
      sessionStorage.setItem('kpi_session_active', '1');
    }

    this.idleTimeoutService.start();
  }

  ngOnDestroy() {
    this.idleTimeoutService.stop();
  }
}
