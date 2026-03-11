import { Injectable, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { fromEvent, merge, Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import Swal from 'sweetalert2';
import { AuthService } from './auth';

@Injectable({
  providedIn: 'root'
})
export class IdleTimeoutService {
  private activity$: Subject<void> = new Subject();
  private destroy$ = new Subject<void>();

  private idleTimeoutMs = 15 * 60 * 1000; // Default 15 นาที
  private promptTimeoutS = 10; // Default 10 วินาที

  constructor(private ngZone: NgZone, private router: Router, private authService: AuthService) {}

  public start(): void {
    this.stop(); // Stop any existing timers
    
    // ดึงค่า Config จาก Server ก่อนเริ่มจับเวลา
    this.authService.getSettings().subscribe({
      next: (res) => {
        if (res.success && res.data) {
          const minutesSetting = res.data.find((s: any) => s.setting_key === 'idle_timeout_minutes');
          const secondsSetting = res.data.find((s: any) => s.setting_key === 'idle_timeout_seconds');
          const countdownSetting = res.data.find((s: any) => s.setting_key === 'idle_countdown_seconds');

          let totalMs = 0;
          if (minutesSetting) totalMs += parseInt(minutesSetting.setting_value, 10) * 60 * 1000;
          if (secondsSetting) totalMs += parseInt(secondsSetting.setting_value, 10) * 1000;

          if (totalMs > 0) {
            this.idleTimeoutMs = totalMs;
          }
          if (countdownSetting) {
            this.promptTimeoutS = parseInt(countdownSetting.setting_value, 10);
          }
        }
        this.initializeTimer();
      },
      error: () => {
        this.initializeTimer(); // ใช้ค่า Default ถ้าดึงไม่ได้
      }
    });
  }

  private initializeTimer(): void {
    this.ngZone.runOutsideAngular(() => {
      // Listen for user activity
      merge(
        fromEvent(window, 'mousemove'),
        fromEvent(window, 'keydown'),
        fromEvent(window, 'click'),
        fromEvent(window, 'scroll')
      ).pipe(takeUntil(this.destroy$)).subscribe(() => this.activity$.next());

      // Start the idle timer
      this.activity$.pipe(
        debounceTime(this.idleTimeoutMs),
        takeUntil(this.destroy$)
      ).subscribe(() => {
        this.ngZone.run(() => {
          this.showTimeoutPrompt();
        });
      });
    });
    // Initial activity signal
    this.activity$.next();
  }

  public stop(): void {
    this.destroy$.next();
    Swal.close();
  }

  private showTimeoutPrompt(): void {
    // ตรวจสอบว่าล็อกอินอยู่หรือไม่ ถ้าไม่ล็อกอินก็ไม่ต้องแจ้งเตือน
    if (!this.authService.isLoggedIn()) {
      return;
    }

    // คำนวณเวลาที่จะแสดงในข้อความ
    const totalSeconds = Math.floor(this.idleTimeoutMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    let timeDisplay = '';
    if (minutes > 0) {
      timeDisplay += `${minutes} นาที`;
    }
    if (seconds > 0) {
      if (timeDisplay) timeDisplay += ' ';
      timeDisplay += `${seconds} วินาที`;
    }
    if (!timeDisplay) timeDisplay = '0 วินาที';

    let timerInterval: any;

    Swal.fire({
      title: 'แจ้งเตือน',
      icon: 'warning',
      html: `
        <p>ไม่มีการใช้งานระบบนานเกิน ${timeDisplay} ต้องการออกจากระบบหรือไม่</p>
        <br>
        <p>จะออกจากระบบอัตโนมัติใน <b></b> วินาที</p>
      `,
      timer: this.promptTimeoutS * 1000,
      timerProgressBar: true,
      showConfirmButton: true,
      confirmButtonText: 'ยืนยัน',
      showCancelButton: true,
      cancelButtonText: 'ยกเลิก',
      confirmButtonColor: '#d33',
      cancelButtonColor: '#3085d6',
      allowOutsideClick: false,
      allowEscapeKey: false,
      didOpen: () => {
        this.playAlertSound();
        const timerEl = Swal.getHtmlContainer()?.querySelector('b');
        if (timerEl) {
            timerInterval = setInterval(() => {
                const timeLeft = Math.ceil(Swal.getTimerLeft()! / 1000);
                timerEl.textContent = timeLeft.toString();
            }, 100);
        }
      },
      willClose: () => {
        clearInterval(timerInterval);
      }
    }).then((result) => {
      if (result.isConfirmed || result.dismiss === Swal.DismissReason.timer) {
        this.logout();
      } else if (result.isDismissed) {
        this.activity$.next(); // Reset timer on cancel
      }
    });
  }

  private playAlertSound(): void {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;

      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.5);

      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      console.error('Audio play failed', e);
    }
  }

  private logout(): void {
    this.stop();
    this.authService.logout(); // ใช้ AuthService เพื่อเคลียร์ Token ให้ถูกต้อง
    this.router.navigate(['/login']);
  }
}